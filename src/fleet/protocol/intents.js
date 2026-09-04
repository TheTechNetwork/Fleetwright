// The intent protocol — the contract between the coordinator and a fleet host.
//
// §5's principle, and the reason this exists before anything that would use it:
// the coordinator sends INTENTS, never commands. Down the socket goes
//
//     {v: 1, kind: "intent", id: "…", verb: "resume", params: {name: "bigjob", choice: "summary"}}
//
// and never a shell string, never a command line, never a path.
//
// The failure this is designed against is not a bug in the coordinator — it is
// the coordinator being compromised outright (a bad deploy, a leaked API token,
// a dependency) while it is driving root-capable boxes. With a fixed verb set
// the blast radius is bounded BY THE VERB SET; with command strings it is every
// box in the fleet. It costs almost nothing now and cannot be retrofitted once
// something is passing strings, which is why it is the first thing built.
//
// WHAT THAT BOUND ACTUALLY IS, and it is not what this comment said for a year.
// It said "someone started and stopped some sessions", which was true of the
// original eight read-and-lifecycle verbs and stopped being true the moment v2
// added `link`, `unlink`, `connect` and `renew`. Those WRITE CREDENTIALS: a
// compromised coordinator can put a token it controls into somebody's row, and
// every session that person starts afterwards is seeded with it. That is
// exfiltration, not lifecycle, and `start`+`peek` never gave it — those read.
//
// The bound is real and worth having. It is "whatever the verb set permits",
// which is why docs/security.md §6.3 lists the five conditions a new verb must
// meet and requires this paragraph to be updated rather than repeated when one
// of them writes a credential. A fixed vocabulary whose bound nobody re-derives
// is a fixed vocabulary that quietly grows.
//
// WHERE THE AUTHORITY LIVES
//
// One module, two roles, and only one of them is in the trust path.
//
// The COORDINATOR imports it to build well-formed intents and catch its own
// mistakes before they reach the wire. That is a convenience, not a control — a
// compromised coordinator would simply not call it.
//
// The SIDECAR (`src/fleet/host/sidecar.js`) imports it to validate everything that
// arrives, and THAT is the control. It runs on the host, in a different process
// on a different machine from the coordinator, and it re-validates every field
// rather than trusting a flag or a signature over a payload it did not itself
// parse. Sharing a source file across that boundary is fine; sharing trust
// across it is not.
//
// Behind the sidecar there is a second allowlist — agent-hub's own command
// registry — but do not lean on it. `POST /api/command` runs whatever line it
// is handed, `/login` included, and the sidecar holds the token. The verb set
// below is what stands between a compromised coordinator and that endpoint.
//
// `v` is how the two ends stay in step: change the table, bump the version.
//
// See docs/intents.md for the wire format and the reasoning in full.

import { cleanText, TITLE_MAX, BRIEF_MAX } from '../../core/text.js';

// v3, 2 Sep 2026: `start` gained `profile`, and `profiles` was added beside it.
//
// A VERSION BUMP IS A FLAG DAY, and this is the second one. Adding a VERB is
// free — an old host answers `unknown_verb` and the caller learns something
// true. Adding a PARAMETER is not: the version handshake has already agreed by
// the time the params are read, so an old host answers `bad_params` to a
// request the coordinator had every reason to think it understood. A beta
// tester met a host two releases behind that refused `fleet_files`, on this
// fleet, this week; that is what this costs when it goes wrong.
//
// So it is spent deliberately, on the highest-ranked finding in both beta
// reports: a session could not be given anything to do. `brief` was stored and
// never delivered, so the loop this project's own MCP instructions taught —
// start, await, read the log — produced an idle REPL, an empty log, and NO
// ERROR ANYWHERE, which is the worst shape a failure can have.
//
// The alternative was a second verb (`launch`) to dodge the number. It was
// rejected: `start` and `launch` would accumulate separate parameters forever,
// and the only thing the second one buys is not writing down that the protocol
// changed.
//
// Upgrade order is coordinator-last. A v3 host answers `unsupported_version` to
// a v2 coordinator and a v2 host answers it to a v3 one, so the fleet is
// visibly down either way rather than subtly wrong — hosts first, then the
// coordinator, and the window is loud.
export const PROTOCOL_VERSION = 3;

/**
 * Session names, matching agent-hub's charset (`src/core/names.js`).
 *
 * The leading character MUST be alphanumeric, and that is load-bearing rather
 * than cosmetic. agent-hub's command parser treats any whitespace-separated
 * token beginning with `--` as a flag, so a session named `--dangerous` would
 * turn `/stop --dangerous` into a flag with no argument. Anchoring the first
 * character is what makes "a name can never become a flag" true by
 * construction instead of by careful quoting downstream.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

// Text a PERSON wrote is cleaned by src/core/text.js, which agent-hub's HTTP
// API also uses. Two doors into the same storage validating separately is the
// shape of a bug this project has already paid for once.

/** Idempotency keys. Opaque to us — a uuid, a ULID, whatever the coordinator
 * mints — but bounded and charset-checked, because it is used as a map key and
 * echoed back in replies. */
const ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** Actor ids, e.g. "telegram:12345" — or, since sign-in, a verified email
 * address, which is what makes `+` load-bearing: plus-addressing is ordinary
 * (eli+fleet@thetech.network) and without it every intent from that person's
 * phone was refused as a bad envelope. The set stays a deliberate allowlist
 * rather than "anything", because this ends up in a state file and in logs. */
const ACTOR_RE = /^[A-Za-z0-9._:@+-]{1,128}$/;

/**
 * @typedef {object} ParamSpec
 * @property {'name'|'enum'|'int'|'text'|'secret'|'raw'} type
 * @property {boolean} required
 * @property {string[]} [values]  for 'enum'
 * @property {number} [min]       for 'int'
 * @property {number} [max]       for 'int', the character limit for 'text', and
 *   the BYTE limit for 'raw' — a file is measured in bytes, not characters
 * @property {string} [describe]  the parameter's own words, carried into the
 *   generated MCP schema. Without it a caller sees a type and a bound and has
 *   to guess the meaning, which is how `brief` came to be read as the task.
 */

/**
 * @typedef {object} VerbSpec
 * @property {Record<string, ParamSpec>} params
 * @property {boolean} mutating   changes host state → needs an idempotency key honoured
 * @property {string} summary
 */

/**
 * THE FIXED VERB SET.
 *
 * Adding a verb is a deliberate act with a version bump, not a convenience. Two
 * exclusions are deliberate and worth stating outright, because both look like
 * oversights:
 *
 *  - **`connect` / `link` / `unlink`, which used to be "no `login`/`code`".**
 *    The old note said a compromised coordinator could point a box at an
 *    attacker's Claude account. Two things changed. The reasoning was written
 *    for a SHARED account and does not hold for a guest, who brings their own
 *    credential and has no shell on the box — for them "just SSH in" is the
 *    feature missing, not a smaller inconvenience.
 *
 *    THE SECOND HALF OF THIS ONCE READ "the aiming is now impossible by
 *    construction", AND THAT WAS WRONG. Removing every email/account/user/owner
 *    PARAMETER is real and worth keeping — it stops any ordinary caller aiming
 *    a link at somebody else. It does nothing against the adversary this whole
 *    module is designed for. `scope: me` resolves against the ACTOR STRING, and
 *    the actor string is put on the wire by the coordinator; the host does not
 *    verify it, it strips a `fleet:` prefix (src/core/accounts.js). Against a
 *    compromised coordinator the aiming simply moved from a parameter we
 *    refused to a field we trust. docs/trust.md has always said so plainly —
 *    "coordinator → host: trusted absolutely" — and this comment contradicted
 *    it. See docs/security.md SEC-ID-3.
 *
 *    And the page half is bounded less tightly than it claimed: a compromised
 *    coordinator can show a person a different authorization page, which `start`
 *    also allows. But `link` and `renew` WRITE a credential, and no amount of
 *    `start` does that — see the blast-radius note at the top of this file.
 *
 *  - **No path parameter anywhere.** agent-hub's `/new <name> <path>` takes any
 *    path with no validation (a known gap, §1), and a sandboxed session's
 *    working directory is a fixed `/work` mount anyway (§2). Leaving the
 *    parameter out entirely removes the question rather than answering it — the
 *    coordinator has no way to express "start a session in /etc", so no
 *    validator on the host has to be correct about it.
 *
 * @type {Readonly<Record<string, VerbSpec>>}
 */
export const VERBS = Object.freeze({
  list: {
    params: {},
    mutating: false,
    summary:
      'Every session in the fleet, grouped by the host holding it. This is a list of SESSIONS — for the ' +
      'machines themselves and whether they are usable, ask `status` with no name.',
  },
  status: {
    params: { name: { type: 'name', required: false } },
    mutating: false,
    summary:
      'With no name: every host, and whether each is usable — this is how you find out what machines exist. ' +
      'With a name: that session in detail.',
  },
  peek: {
    params: {
      name: { type: 'name', required: true },
      lines: { type: 'int', required: false, min: 1, max: 500 },
    },
    mutating: false,
    summary: "Read the last lines of a session's pane.",
  },
  health: {
    params: {},
    mutating: false,
    summary:
      'Capacity and load for one host: how many sessions are running, how many free, load average, and ' +
      'whether Claude is logged in. Ask `status` with no name for the fleet-wide picture.',
  },
  start: {
    params: {
      name: { type: 'name', required: false },
      mode: { type: 'enum', required: false, values: ['safe', 'dangerous'] },
      // What it is about, for people. The NAME is the identity and never
      // changes; the title is a label and can. Separating them is what makes
      // renaming safe, and a rename that cannot break anything is what stops
      // somebody hesitating over the first one. See docs/naming.md.
      title: {
        type: 'text',
        required: false,
        max: TITLE_MAX,
        describe: 'A label for people reading a list later. Not instructions.',
      },
      // A sentence or two of context, so that opening a list in a week is
      // recognition rather than recall. Not passed to the model and not run.
      //
      // SAID IN THE SCHEMA NOW, not only here. An agent that reads `brief` as
      // "the task" starts a session, waits for a result, and gets a REPL at an
      // empty prompt with nothing having failed anywhere — the worst shape a
      // parameter can have, because silence looks like success.
      brief: {
        type: 'text',
        required: false,
        max: BRIEF_MAX,
        describe:
          'A note for whoever opens this session later. NOT the task: it is stored, never typed into the ' +
          'session and never given to the model. To give a session work, name a `profile`.',
      },
      // THE TASK, AND IT IS A NAME RATHER THAN THE WORDS.
      //
      // docs/wanted.md settled the security half before this was built: the
      // coordinator may NAME a profile; it may never CARRY one. Injected text
      // is instructions to an agent with root in a container, so a coordinator
      // that chose the content would be writing that agent's instructions —
      // the `reply { text }` argument in different clothes, and a much larger
      // capability than the rest of this verb set combined.
      //
      // `name` and not `enum`, because the values are files on a host and this
      // table cannot know them. The HOST refuses an unknown one and lists what
      // it has, which is the same shape the tag refusal already uses well.
      //
      // What this does NOT open: there is still no way to send text into a
      // session, at start or later. The set of things a session can be started
      // with is exactly the set of files on that box, and adding to it needs a
      // shell on it.
      profile: {
        type: 'name',
        required: false,
        describe:
          'A task profile ON THAT HOST, by name — its content becomes the session\'s first message, so the ' +
          'session comes up working instead of idle. Ask `profiles` for the list. Without one the session ' +
          'starts idle and a person has to drive it.',
      },
    },
    mutating: true,
    // SELF-CONTAINED, because this string is now read out of context. The MCP
    // server generates its tool descriptions from these summaries, so an agent
    // sees this sentence and nothing around it — and "see the note above" is a
    // reference to a comment in a file it will never open.
    summary:
      'Start a new session. NAME A `profile` OR IT COMES UP IDLE: a profile is a file on that host whose ' +
      'content becomes the session\'s first message, and `profiles` lists what the host has. Without one ' +
      'the session sits at an empty prompt and a person has to drive it — nothing else here can hand it ' +
      'work, because no verb sends text to a session (`answer` picks a numbered option and nothing else). ' +
      'There is no path parameter: a session works in a fixed directory, so where it runs is a property of ' +
      'the host rather than something to ask for.',
  },
  // FREE TO ADD, unlike the parameter above: an old host answers `unknown_verb`
  // and the caller learns something true. It ships in the same version anyway
  // because `start { profile }` without a way to ask what the profiles ARE is a
  // parameter you can only use by guessing.
  // WHICH RELEASES THIS BOX TAKES, changed from a phone.
  //
  // A NEW VERB, WHICH COSTS NOTHING — an old host answers `unknown_verb` and
  // the caller learns something true. Adding `channel` to an existing verb
  // would have been a flag day for a setting.
  //
  // A BOUNDED ENUM, NOT A SETTING NAME AND A VALUE. A general "set this
  // config key" verb would let a coordinator write arbitrary host
  // configuration, which is the `reply { text }` argument again — the fixed
  // verb set is only a bound if the verbs are specific. This one can express
  // exactly two states.
  //
  // The value lives in the state directory rather than /etc, because the env
  // file is root-owned and the service is not root. See src/core/channel.js —
  // a setting somebody is meant to change from a phone cannot live somewhere
  // only a shell can reach, which is the whole reason this verb exists.
  channel: {
    params: {
      to: { type: 'enum', required: false, values: ['stable', 'rolling'] },
    },
    mutating: true,
    summary:
      'Which releases a host installs. `stable` takes published releases; `prerelease` takes the newest ' +
      'build of main, on every merge. Ask with no `to` to find out which one a host is on. Changing it ' +
      'does not update anything by itself — it decides what the next update is allowed to be.',
  },
  profiles: {
    params: {},
    mutating: false,
    summary:
      'The task profiles this host has, by name, each with the first line of what it says. Feed one to ' +
      '`start { profile }`. The CONTENT never crosses this protocol — it is a file on that box, and adding ' +
      'one needs a shell on it, which is what stops a coordinator from writing a session\'s instructions.',
  },
  resume: {
    params: {
      name: { type: 'name', required: true },
      choice: { type: 'enum', required: false, values: ['summary', 'full'] },
    },
    mutating: true,
    summary: 'Resume a stopped session, optionally answering the resume dialog.',
  },
  stop: {
    params: { name: { type: 'name', required: true } },
    mutating: true,
    summary: 'Stop a running session, keeping its conversation resumable.',
  },
  logs: {
    params: {
      // A SESSION's logs, which are a different question from a service's.
      // `peek` shows the live pane; this is what the session SAID — the
      // container's stderr, which outlives the pane. That difference matters
      // most exactly when it is hardest to get at: a session that died has no
      // pane left, and the reason it died is in the container's output.
      //
      // Mutually exclusive with `service` in practice; the host prefers this
      // one when both arrive, because naming a session is the more specific
      // request.
      name: { type: 'name', required: false },
      // A FIXED SET, not a service name. The host runs `journalctl -u <x>`,
      // and an enum is the difference between naming three units this project
      // installed and handing a remote caller the unit namespace of the box.
      service: { type: 'enum', required: false, values: ['hub', 'coordinator', 'sidecar'] },
      lines: { type: 'int', required: false, min: 1, max: 200 },
    },
    // READ-ONLY, but not a fan-out: logs are per-box by nature and merging
    // three journals into one stream would produce something nobody can read.
    // A caller names the host with the placement preference instead.
    mutating: false,
    // BOTH THINGS IT DOES. With `service` it is a service journal; with `name`
    // it is that SESSION's own output — the container's stderr, which survives
    // a session that has exited and has no pane left to read. The old summary
    // named only the first, so anybody looking for what a job printed had no
    // reason to think this was it.
    summary:
      'Read output. With `name`, a session\'s own console output — this survives after the session ends, ' +
      'unlike its pane. With `service`, a service journal on one host.',
  },
  // --- the workspace ------------------------------------------------------
  //
  // FIVE VERBS RATHER THAN ONE WITH AN `op`. A single `files` verb taking
  // op=list|read|write|delete would be a remote procedure call wearing an
  // intent's clothes: the scheduler could not tell a read from a delete, the
  // MCP server could not withhold the destructive half, and `mutating` would
  // have to be a lie on one side or the other.
  //
  // Every one takes a session `name`, because a workspace belongs to a session
  // — there is no fleet-wide filesystem here and nothing addresses one.
  files: {
    params: {
      name: { type: 'name', required: true },
      path: {
        type: 'text',
        required: false,
        max: 512,
        describe: 'A directory inside the session workspace, relative to its root. Leave empty for the root itself.',
      },
    },
    mutating: false,
    summary:
      "List one directory in a session's workspace. One level, not a tree: a repository is tens of thousands " +
      'of files and the answer to "what is in here" is about here.',
  },
  readfile: {
    params: {
      name: { type: 'name', required: true },
      path: { type: 'text', required: true, max: 512, describe: 'The file to read, relative to the workspace root.' },
    },
    mutating: false,
    summary:
      "Read a text file from a session's workspace. Refuses binary and anything over 256KB rather than " +
      'returning something unreadable.',
  },
  writefile: {
    params: {
      name: { type: 'name', required: true },
      path: { type: 'text', required: true, max: 512, describe: 'The file to write, relative to the workspace root.' },
      // `text`, not `secret`: cleanText would collapse the whitespace of the
      // file being written, and a file is exactly what it is.
      content: { type: 'raw', required: true, max: 256 * 1024, describe: 'The new contents. Replaces the file.' },
    },
    mutating: true,
    summary: "Write a file in a session's workspace, creating it and any missing directories. Replaces what was there.",
  },
  copyfile: {
    params: {
      name: { type: 'name', required: true },
      path: { type: 'text', required: true, max: 512, describe: 'What to copy, relative to the workspace root.' },
      to: { type: 'text', required: true, max: 512, describe: 'Where to put it, relative to the workspace root.' },
    },
    mutating: true,
    summary: "Copy a file or directory within a session's workspace.",
  },
  deletefile: {
    params: {
      name: { type: 'name', required: true },
      path: { type: 'text', required: true, max: 512, describe: 'What to delete, relative to the workspace root.' },
    },
    mutating: true,
    summary:
      "Delete a file or directory from a session's workspace. Not recoverable — `forget` is the recoverable one, " +
      'and it takes the whole workspace rather than part of it.',
  },

  update: {
    params: {
      // Restart after pulling. Default false, and that default is the safe
      // one: an update that does not restart leaves the box running old code
      // and SAYS so, while an unasked-for restart interrupts whatever was
      // happening because somebody typed a word.
      restart: { type: 'enum', required: false, values: ['yes', 'no'] },
    },
    mutating: true,
    summary: 'Pull code on one host, optionally restarting its services.',
  },
  upgrade: {
    params: {
      // Apply, as opposed to report. Reporting is the default because
      // "what is waiting" is the question people ask, and installing packages
      // on somebody else's box is not something to do by omission.
      apply: { type: 'enum', required: false, values: ['yes', 'no'] },
    },
    mutating: true,
    summary: 'What operating-system updates a host has waiting, and optionally install them.',
  },
  reboot: {
    params: {
      // THE SAME THREE CONFIRMATIONS THE CHAT FLOW ASKS FOR, unchanged.
      //
      // Sending `reboot` with neither parameter is step one: the host says
      // what will be lost and issues a six-digit pin. Sending it again with
      // the pin AND the hostname is step two. Two round trips, deliberately —
      // a remote reboot should be HARDER than a local one, not easier, and
      // the guard that survives being remote is the one that asks for
      // something only a person who knows which box can produce.
      //
      // A boolean `confirm: true` would be one tap from a phone in a pocket,
      // and a token the coordinator minted would let a compromised
      // coordinator mint its own. The pin is issued by the HOST.
      //
      // EVERY RUNNING SESSION DIES — a reboot takes the tmux server with it,
      // and the host says so in step one, by name.
      pin: { type: 'name', required: false },
      confirm: { type: 'name', required: false },
    },
    mutating: true,
    summary: 'Reboot one host. Two steps: ask, then send back the pin and the hostname.',
  },
  answer: {
    params: {
      name: { type: 'name', required: true },
      // AN ORDINAL, never text. `send-keys` into a Claude Code pane reaches
      // `!` bash mode, slash commands, and a root shell after one Ctrl-C — so
      // a `reply { text }` verb would be strictly worse than the shell string
      // design.md §5 forbids, because it looks bounded and is not. An ordinal
      // selects an option the host itself published; a compromised
      // coordinator can pick one and can never originate one.
      //
      // 1..9 because the pane numbers them that way, and a dialog with ten
      // options is not a dialog anybody should be answering from a phone.
      option: { type: 'int', required: true, min: 1, max: 9 },
      // WHICH QUESTION this answers. Without it, a notification tapped four
      // minutes late sends "2" to whatever dialog is on screen NOW — the
      // temporal hole. The host recomputes the id from the live pane and
      // refuses if it moved.
      promptId: { type: 'text', required: false, max: 32 },
    },
    mutating: true,
    summary: 'Answer a waiting prompt by selecting one of the options the host published.',
  },
  forget: {
    params: { name: { type: 'name', required: true } },
    mutating: true,
    summary: 'Stop a session and erase its record, so it can no longer be resumed.',
  },
  restore: {
    params: { name: { type: 'name', required: true } },
    mutating: true,
    summary: 'Take a forgotten session back out of the bin, conversation and workspace intact.',
  },
  purge: {
    params: { name: { type: 'name', required: true } },
    // NO CONFIRMATION PARAMETER, deliberately, and this is the one place it
    // would be tempting. `reboot` asks for a pin because a coordinator that
    // could mint one could reboot the fleet — the guard exists because the
    // ACTOR might be the attacker. Here the risk is a person mistyping, and
    // the answer to that is not a second parameter on the same request: it is
    // that `forget` no longer destroys anything, so the destructive verb is a
    // separate word somebody has to reach for on purpose.
    mutating: true,
    summary: 'Delete a session for good. This is what forget used to do.',
  },
  connect: {
    params: {
      // A FIXED SET, and the same argument as `logs.service`: the host runs a
      // provider's flow, and an enum is the difference between naming the
      // providers this project supports and letting a caller nominate a URL
      // for somebody to paste a credential into.
      // Optional, and that is the listing: bare `connect` answers "what could
      // I connect, and what have I connected already" in one round trip, so a
      // picker on a phone is rendered from the HOST's catalogue rather than
      // from a copy of it compiled into two mobile apps.
      provider: { type: 'enum', required: false, values: ['claude', 'github', 'cloudflare'] },
      // WHOSE credential. `me` links the requester's own — and the email is
      // taken from the verified actor, never from a parameter, so this verb
      // cannot be aimed at somebody else's account row. `host` logs THE BOX
      // in, which is the original no-SSH promise and is admin-only.
      scope: { type: 'enum', required: false, values: ['me', 'host'] },
    },
    mutating: true,
    summary: 'Begin connecting a credential. Returns a URL to open — never a secret.',
  },
  link: {
    params: {
      provider: { type: 'enum', required: true, values: ['claude', 'github', 'cloudflare'] },
      // THE ONLY PARAMETER IN THIS PROTOCOL THAT IS A LIVE CREDENTIAL. Typed
      // separately from `text` for three reasons that all have to hold at
      // once: cleanText would mangle it, a refusal must never quote it back,
      // and every log site between here and the pane must know to mask it
      // (src/core/redact.js).
      secret: { type: 'secret', required: true, max: 4096 },
      scope: { type: 'enum', required: false, values: ['me', 'host'] },
    },
    mutating: true,
    summary: 'Finish a connection with the token or code the person pasted back.',
  },
  verify: {
    params: {
      provider: { type: 'enum', required: true, values: ['claude', 'github', 'cloudflare'] },
      scope: { type: 'enum', required: false, values: ['me', 'host'] },
    },
    // READ-ONLY: it asks the provider what a stored token can do and stores
    // nothing. Not mutating, so no idempotency key is honoured — asking twice
    // is asking twice, which is what a "test" button should mean.
    mutating: false,
    summary: 'Check a stored credential with its provider, and report what it can actually do.',
  },
  unlink: {
    params: {
      provider: { type: 'enum', required: true, values: ['claude', 'github', 'cloudflare'] },
      scope: { type: 'enum', required: false, values: ['me', 'host'] },
    },
    mutating: true,
    summary: 'Forget a stored credential on one host. Does not revoke it at the provider.',
  },

  // WHAT A HOST NEEDS TO KEEP A CONNECTION ALIVE BY ITSELF.
  //
  // A GitHub App user token lasts eight hours and is NOT renewed by being used
  // — unlike Claude's, which is why the keepalive on the host does nothing for
  // it. It is renewed by exchanging a refresh token, explicitly, and that
  // exchange needs the App's client secret. Until this verb existed the
  // coordinator received the refresh token at the end of the OAuth flow and
  // threw it away, because there was nowhere for it to live: every GitHub App
  // connection was dead eight hours after it was made.
  //
  // THE MINTING MATERIAL GOES TO THE HOST, which is docs/trust.md's rule
  // rather than a convenience: "spreading minting keys across hosts means a
  // compromised host costs that host's access; centralising them means a
  // compromised coordinator costs everything." A host already holds the access
  // token and already runs that person's sessions. The coordinator is
  // internet-facing and holding every member's renewable GitHub credential
  // there is the outcome that rule exists to refuse.
  //
  // So this is a DEPOSIT, not a request the coordinator repeats: it is sent
  // once, when the connection is made, and the host renews on its own timer
  // from then on. Nothing has to be scheduled anywhere it could be missed.
  //
  // A NEW VERB RATHER THAN TWO PARAMETERS ON `link`, and that is the protocol
  // rule paying for itself again: an old host answers `unknown_verb` and its
  // connections behave exactly as they do today, while adding `refresh` and
  // `client` to `link` would be a flag day — `bad_params` arriving after the
  // handshake had already agreed.
  renew: {
    params: {
      provider: { type: 'enum', required: true, values: ['github'] },
      // WHICH APP THIS WAS ISSUED BY, carried rather than configured. It is
      // public — it is in every authorization URL the person has already seen
      // — but it travels here so that a host needs NO configuration at all to
      // renew. An install question is a thing somebody has to be told, and the
      // standing goal is to have none of them.
      //
      // Typed `secret` despite not being one, because the type is about
      // HANDLING rather than about sensitivity: it is the type that refuses
      // whitespace, quotes and backslashes, which is exactly the property a
      // value needs to survive onto a command line as one token. `text` would
      // run it through cleanText, which is the wrong shape for anything that
      // must arrive byte-identical.
      clientId: { type: 'secret', required: true, max: 256 },
      // A live credential, and `secret` for the three reasons `link.secret` is:
      // cleanText would mangle it, a refusal must never quote it back, and
      // every log site between here and the pane has to know to mask it
      // (src/core/redact.js).
      refresh: { type: 'secret', required: true, max: 4096 },
      // ACCEPTED AND IGNORED, kept only so an older coordinator's deposit is
      // not refused outright. The client secret used to travel here and be
      // written to disk beside the refresh token — which docs/github-app.md
      // has always said does not happen, and which put the FLEET-WIDE secret
      // at rest once per member per host and made rotation silently break
      // every renewal eight hours later. It arrives on the config frame now
      // and stays in memory.
      //
      // Optional rather than removed, deliberately: dropping a parameter a
      // coordinator still sends would make it `bad_params` — a flag day, after
      // the version handshake had already agreed. Accepting and discarding is
      // the compatible direction.
      client: { type: 'secret', required: false, max: 4096 },
    },
    mutating: true,
    summary: 'Give a host what it needs to renew a connection without being asked again.',
  },
});

/** @param {string} verb */
export function isMutating(verb) {
  return VERBS[verb]?.mutating === true;
}

/**
 * @typedef {object} Intent
 * @property {number} v
 * @property {'intent'} kind
 * @property {string} id
 * @property {string} verb
 * @property {Record<string, string|number>} params
 * @property {number} issuedAt
 * @property {string} [actor]
 */

/**
 * @typedef {{ ok: true, intent: Intent }} ValidOk
 * @typedef {{ ok: false, code: string, error: string }} ValidErr
 */

/**
 * The params half of validation, on its own.
 *
 * FACTORED OUT BECAUSE THE COORDINATOR NEEDS IT BEFORE IT HAS AN ENVELOPE.
 * `buildIntent` THROWS on a malformed intent, which is right for a programming
 * error inside the coordinator and wrong for the case that actually happens: a
 * caller posting `params: {session: "x"}` to /api/intent. That threw out of
 * `dispatch`, past every handler, and became a Cloudflare error page — the
 * "error code: 1101" a beta tester hit twice and read as the fleet being down.
 * It was their typo, and retrying could never have worked.
 *
 * @param {string} verb
 * @param {unknown} params
 * @returns {{ ok: true, params: Record<string, string|number> }
 *   | { ok: false, code: string, error: string }}
 */
export function checkParams(verb, params) {
  const spec = VERBS[verb];
  if (!spec) return { ok: false, code: 'unknown_verb', error: `unknown verb ${JSON.stringify(String(verb).slice(0, 40))}` };
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, code: 'bad_params', error: 'params must be a JSON object' };
  }

  /** @type {Record<string, string|number>} */
  const clean = {};
  for (const [key, value] of Object.entries(params)) {
    const ps = spec.params[key];
    if (!ps) {
      // AND WHAT IT DOES TAKE. The old message named the mistake and not the
      // fix, so a caller who guessed `session` was told `status takes no
      // parameter "session"` and had to go and read a schema to learn the word
      // is `name`. Listing the declared parameters costs nothing: whoever sees
      // this already named the verb, so it reveals nothing they did not have.
      //
      // Deliberately unlike the unknown_verb message above, which does NOT list
      // the verb set — that reply can travel to somebody who was guessing.
      const takes = Object.keys(spec.params);
      return {
        ok: false,
        code: 'bad_params',
        error:
          `${verb} takes no parameter "${key.slice(0, 40)}"` +
          (takes.length ? ` — it takes: ${takes.join(', ')}` : ' — it takes none'),
      };
    }
    const checked = checkParam(verb, key, ps, value);
    if (checked.ok === false) return checked;
    clean[key] = checked.value;
  }
  for (const [key, ps] of Object.entries(spec.params)) {
    if (ps.required && clean[key] === undefined) {
      return { ok: false, code: 'bad_params', error: `${verb} requires "${key}"` };
    }
  }
  return { ok: true, params: clean };
}

/**
 * Validate one envelope off the wire.
 *
 * Unknown parameters are REJECTED rather than ignored. Ignoring them is the
 * friendlier default and the wrong one here: a parameter the host silently
 * drops is a coordinator and a host that disagree about what a command means,
 * and the whole point of a fixed verb set is that they cannot.
 *
 * @param {unknown} raw
 * @param {{ now?: number, maxSkewMs?: number }} [opts] maxSkewMs bounds replay;
 *   omit it where the transport already guarantees freshness.
 * @returns {ValidOk | ValidErr}
 */
export function validateIntent(raw, { now = Date.now(), maxSkewMs = 0 } = {}) {
  /** @param {string} code @param {string} error @returns {ValidErr} */
  const bad = (code, error) => ({ ok: false, code, error });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return bad('bad_envelope', 'intent must be a JSON object');
  }
  const env = /** @type {Record<string, unknown>} */ (raw);

  if (env.v !== PROTOCOL_VERSION) {
    return bad('unsupported_version', `unsupported protocol version ${JSON.stringify(env.v)}, this host speaks ${PROTOCOL_VERSION}`);
  }
  if (env.kind !== 'intent') {
    return bad('bad_envelope', `not an intent: kind=${JSON.stringify(env.kind)}`);
  }
  if (typeof env.id !== 'string' || !ID_RE.test(env.id)) {
    return bad('bad_envelope', 'id must be an idempotency key of 8-128 characters from [A-Za-z0-9._:-]');
  }
  if (typeof env.verb !== 'string' || !Object.prototype.hasOwnProperty.call(VERBS, env.verb)) {
    // Deliberately does not list the valid verbs: this reply may travel back to
    // whoever sent it, and the verb set is not a secret but it is not an
    // invitation either.
    return bad('unknown_verb', `unknown verb ${JSON.stringify(String(env.verb).slice(0, 40))}`);
  }
  const spec = VERBS[env.verb];

  if (env.actor !== undefined && (typeof env.actor !== 'string' || !ACTOR_RE.test(env.actor))) {
    return bad('bad_envelope', 'actor must be a short id like "telegram:12345"');
  }

  if (!Number.isSafeInteger(env.issuedAt)) {
    return bad('bad_envelope', 'issuedAt must be an epoch-millisecond integer');
  }
  if (maxSkewMs > 0 && Math.abs(now - /** @type {number} */ (env.issuedAt)) > maxSkewMs) {
    return bad('stale', `issuedAt is more than ${maxSkewMs}ms from now`);
  }

  const params = env.params === undefined ? {} : env.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return bad('bad_params', 'params must be a JSON object');
  }

  const shaped = checkParams(env.verb, params);
  if (shaped.ok === false) return shaped;
  const clean = shaped.params;

  return {
    ok: true,
    intent: {
      v: PROTOCOL_VERSION,
      kind: 'intent',
      id: env.id,
      verb: env.verb,
      params: clean,
      issuedAt: /** @type {number} */ (env.issuedAt),
      ...(env.actor ? { actor: /** @type {string} */ (env.actor) } : {}),
    },
  };
}

/**
 * @param {string} verb @param {string} key @param {ParamSpec} ps @param {unknown} value
 * @returns {{ ok: true, value: string|number } | ValidErr}
 */
function checkParam(verb, key, ps, value) {
  /** @param {string} error @returns {ValidErr} */
  const bad = (error) => ({ ok: false, code: 'bad_params', error });

  if (ps.type === 'name') {
    if (typeof value !== 'string' || !NAME_RE.test(value)) {
      return bad(
        `${verb}.${key} must start with a letter or digit and contain only letters, digits, "-" and "_" (max 40)`,
      );
    }
    return { ok: true, value };
  }
  if (ps.type === 'enum') {
    if (typeof value !== 'string' || !(ps.values || []).includes(value)) {
      return bad(`${verb}.${key} must be one of ${(ps.values || []).join(', ')}`);
    }
    return { ok: true, value };
  }
  if (ps.type === 'text') {
    const r = cleanText(value, { max: ps.max, label: `${verb}.${key}` });
    return r.ok ? { ok: true, value: r.value } : bad(r.error);
  }
  if (ps.type === 'raw') {
    // A FILE IS NOT PROSE. cleanText collapses runs of whitespace and strips
    // control characters, which is right for a title and catastrophic for
    // content: it would reindent somebody's source, join their blank lines, and
    // hand back a file they did not write while reporting success.
    //
    // So this is bounded and otherwise untouched. The one exception is a NUL,
    // which truncates the value for anything written in C — what gets validated
    // and what gets stored would be different strings.
    if (typeof value !== 'string') return bad(`${verb}.${key} must be text`);
    if (Buffer.byteLength(value) > (ps.max ?? 256 * 1024)) {
      return bad(`${verb}.${key} is larger than ${Math.round((ps.max ?? 262144) / 1024)}KB`);
    }
    if (value.includes('\0')) return bad(`${verb}.${key} contains a null byte`);
    return { ok: true, value };
  }
  if (ps.type === 'secret') {
    // NOT cleanText. That collapses whitespace and strips control characters,
    // which would silently hand a MODIFIED credential to a provider and turn
    // "your token is wrong" into a mystery. A credential is either exactly
    // what was minted or it is refused.
    //
    // The refusal never quotes the value — not a prefix, not a length beyond
    // "too long". This error string travels back to the caller and, on the
    // way, past every log line between here and the pane.
    if (typeof value !== 'string' || !value.length) return bad(`${verb}.${key} is required`);
    if (value.length > (ps.max ?? 4096)) return bad(`${verb}.${key} is longer than a credential should be`);
    // Printable ASCII, no whitespace, no quote or backslash — matching
    // src/core/connectors.js. Anything else is a paste that caught half the
    // page, which is what login.js already says about the authorization code.
    if (!/^[\x21-\x7e]+$/.test(value) || /['"\\]/.test(value)) {
      return bad(`${verb}.${key} does not look like a credential — send just the token or code itself`);
    }
    // AND IT MAY NOT BEGIN WITH A DASH. agent-hub's parser reads any token
    // matching `-word` as a FLAG, so a credential starting with one would stop
    // being an argument at all — and, worse, a value like `--host` would be
    // read as the flag that selects the box's shared row. No provider issues a
    // token that starts with a dash; a caller sending one is not pasting a
    // credential.
    if (/^[-\u2013\u2014]/.test(value)) {
      return bad(`${verb}.${key} does not look like a credential — send just the token or code itself`);
    }
    return { ok: true, value };
  }
  // 'int'
  if (!Number.isSafeInteger(value)) return bad(`${verb}.${key} must be an integer`);
  const n = /** @type {number} */ (value);
  if (ps.min !== undefined && n < ps.min) return bad(`${verb}.${key} must be at least ${ps.min}`);
  if (ps.max !== undefined && n > ps.max) return bad(`${verb}.${key} must be at most ${ps.max}`);
  return { ok: true, value: n };
}

/**
 * Build an intent the coordinator can send.
 *
 * `id` is required rather than generated here. An idempotency key that this
 * function mints is a new key on every retry, which makes it decoration: the
 * point is that the RETRY of a `start` carries the key the first attempt did,
 * so the host can recognise it. Whoever owns the retry owns the key.
 *
 * @param {{ id: string, verb: string, params?: Record<string, string|number>, actor?: string, issuedAt?: number }} opts
 * @returns {Intent}
 */
export function buildIntent({ id, verb, params = {}, actor, issuedAt = Date.now() }) {
  const intent = {
    v: PROTOCOL_VERSION,
    kind: /** @type {'intent'} */ ('intent'),
    id,
    verb,
    params,
    issuedAt,
    ...(actor ? { actor } : {}),
  };
  const checked = validateIntent(intent);
  if (checked.ok === false) throw new Error(`refusing to send a malformed intent: ${checked.error}`);
  return checked.intent;
}
