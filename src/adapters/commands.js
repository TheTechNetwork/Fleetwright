// The command registry: one text-in / text-out surface that every adapter
// shares.
//
// This is the portability seam. Telegram, the web UI and the CLI do not
// implement commands — they parse a line, call dispatch(), and render the
// reply. Adding Slack or WhatsApp means writing an adapter that does those two
// things; it does not mean re-implementing "what does /start mean".
//
// Adding a command means adding one entry to COMMANDS below. Deliberately
// launcher-shaped for now — start/resume/stop/list/status — with the pane
// already readable via ctx.sessions.peek() when two-way driving is wanted.

/**
 * @typedef {object} Ctx
 * @property {import('../core/sessions.js').SessionManager} sessions
 * @property {import('../core/login.js').LoginFlow} login
 * @property {import('../config.js').Config} cfg
 * @property {string} actor        stable id of who is asking, e.g. "telegram:12345"
 * @property {string} [actorLabel] human name for logs/records
 * @property {string} [title]      prose a person wrote, carried as a FIELD rather
 *   than parsed out of the command line — see adapters/http.js
 * @property {string} [brief]      a sentence of context for the same reason
 * @property {string} [content]    a file's body, carried as a FIELD for a
 *   stronger version of the same reason: it has newlines and leading whitespace
 *   that matter, and it may be a shell script
 */

/**
 * @typedef {object} Button
 * @property {string} label   what the user sees
 * @property {string} command the command line tapping it runs
 */

/**
 * @typedef {object} Reply
 * @property {string} text                 plain text; adapters may format it
 * @property {import('../core/registry.js').SessionRecord[]} [sessions] structured payload for rich surfaces
 * @property {Button[]} [buttons]          offered choices — Telegram renders these as tappable
 * @property {boolean} [ok]
 * @property {{ catalogue: any[], connected: any[] }} [connections] what a picker needs, and never a token
 * @property {any} [check]                what a stored token can do, when asked
 */

import { describe } from '../core/login.js';
import { Connections, catalogue, isProvider, verifyToken, PROVIDERS } from '../core/connectors.js';
import { readCredentialState, describeCredential } from '../core/claude-credential.js';
import { pickCredentialSource } from '../core/podman.js';
import { runUpdate, updateStatus, updateAvailable, canSelfRestart, restartSelf } from '../core/update.js';
import { applyRelease } from '../core/release-apply.js';
import { PROTOCOL_VERSION } from '../fleet/protocol/intents.js';
import { Accounts, normaliseEmail, emailFromActor, rowForActor, HOST_ROW } from '../core/accounts.js';
import { systemUpdates, describeSystemUpdates, refreshPackageLists, runUpgrade } from '../core/upgrades.js';
import { reboot } from '../core/reboot.js';
import { identity as fleetIdentity, enrol as fleetEnrol } from '../core/fleet-identity.js';
import { readLogs, readSessionLogs, resolveSource, unitInstalled, LOG_SOURCES } from '../core/logs.js';
import { listFiles, readFile, writeFile, copyFile, deleteFile } from '../core/files.js';

/**
 * Split a command line into its verb, positional arguments and flags.
 * Flags may appear anywhere, so `/new api --safe` and `/new --safe api` both
 * work — nobody should have to remember an order.
 *
 * @param {string} line
 * @returns {{ name: string, args: string[], flags: Set<string> }}
 */
export function parse(line) {
  const parts = String(line || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return { name: '', args: [], flags: new Set() };
  // Accept "/start", "start", and Telegram's "/start@mybot" group form.
  const name = parts[0].replace(/^\//, '').split('@')[0].toLowerCase();

  /** @type {string[]} */
  const args = [];
  /** @type {Set<string>} */
  const flags = new Set();
  for (const part of parts.slice(1)) {
    // ONE dash is enough, and so is a dash a phone keyboard has helpfully
    // rewritten. Telegram on iOS turns `--` into an em dash as you type it, so
    // `/update --restart` arrives as `/update —restart` and used to be read as
    // a positional argument — the flag silently did nothing, which is the worst
    // way for a flag to fail. Buttons were unaffected because their payload is
    // never typed, so this broke only for people typing the command.
    // A LETTER after the dash, not \w: otherwise `-5` is a flag called "5"
    // rather than a negative number, and `/logs -5` stops meaning anything.
    const flag = /^(?:--|-|—|–)([a-z][\w-]*)$/i.exec(part);
    if (flag) flags.add(flag[1].toLowerCase());
    else args.push(part);
  }
  return { name, args, flags };
}

/**
 * Resolve the per-session permission override from flags.
 * Returns null when neither was given, meaning "use the global setting".
 * @param {Set<string>} flags
 * @returns {boolean|null}
 */
function permissionOverride(flags) {
  const safe = flags.has('safe') || flags.has('no-skip') || flags.has('prompt');
  const dangerous = flags.has('dangerous') || flags.has('skip') || flags.has('yolo');
  if (safe && dangerous) return null; // contradictory — fall back to the global setting
  if (safe) return false;
  if (dangerous) return true;
  return null;
}

/**
 * Tappable shortcuts for the sessions a command could act on. Capped, because
 * a chat client renders these as a keyboard and forty buttons is not a menu.
 * @param {import('../core/registry.js').SessionRecord[]} sessions
 * @param {(s: import('../core/registry.js').SessionRecord) => string} toCommand
 * @param {(s: import('../core/registry.js').SessionRecord) => string} toLabel
 * @returns {Button[]}
 */
function sessionButtons(sessions, toCommand, toLabel) {
  return sessions.slice(0, 8).map((s) => ({ label: toLabel(s), command: toCommand(s) }));
}

/**
 * How a session should read to a person.
 *
 * The name is the identity — a tmux target, a volume, what you type to resume —
 * and stays exactly as it is. The title is what the session is ABOUT, and is
 * the useful half once a box has six of them.
 * @param {import('../core/registry.js').SessionRecord} s
 */
function label(s) {
  return s.title ? `${s.name} · ${s.title}` : s.name;
}

/**
 * Does this session actually bypass permission checks?
 * @param {Ctx} ctx
 * @param {import('../core/registry.js').SessionRecord} s
 */
function effectiveSkip(ctx, s) {
  return s.skipPermissions === null ? ctx.cfg.skipPermissions : s.skipPermissions;
}

/**
 * Mark only the sessions that DIFFER from the global default, so the common
 * case stays quiet and an unusual one stands out.
 * @param {Ctx} ctx
 * @param {import('../core/registry.js').SessionRecord} s
 */
function modeSuffix(ctx, s) {
  if (s.skipPermissions === null || s.skipPermissions === ctx.cfg.skipPermissions) return '';
  return s.skipPermissions ? '  (permissions bypassed)' : '  (safe mode)';
}

/**
 * @param {string|undefined} word
 * @returns {'summary'|'full'|null}
 */
function parseResumeChoice(word) {
  const w = String(word || '').toLowerCase();
  if (w === 'summary' || w === 'summarised' || w === 'summarized' || w === '1') return 'summary';
  if (w === 'full' || w === 'all' || w === '2') return 'full';
  return null;
}

/**
 * What is connected on this box, for the person asking, plus what could be.
 *
 * ONE PLACE THAT KNOWS ABOUT BOTH KINDS OF CREDENTIAL. Claude is an OAuth
 * login the CLI drives in a pane; GitHub and Cloudflare are tokens a person
 * mints on a page. `src/core/connectors.js` deliberately knows only about the
 * second kind — it is a table of token providers and should stay one — so the
 * merge happens here, where the login flow is also in scope.
 *
 * Never contains a token. The catalogue is public information (a URL and a
 * list of scopes), `connected` is metadata, and `pending` is an authorization
 * URL that has just been handed to the person who asked for it.
 *
 * @param {Ctx} ctx
 * @param {{ url?: string|null }} [pending]  a Claude login waiting for its code
 */
function connectionsPayload(ctx, pending = {}, { host = false } = {}) {
  const email = emailFromActor(ctx.actor);
  // Which row is being ASKED about. `--host` is the box's own; otherwise it is
  // whoever is asking, and `rowForActor` is what keeps "I cannot tell who this
  // is" from resolving to the shared row.
  const row = host ? HOST_ROW : rowForActor(ctx.actor);
  const store = new Connections(ctx.cfg.stateDir);
  const connected = row === null ? [] : store.list(row);

  // Claude's row. For a member it is "have you linked your own account"; for
  // an actor with no email it is the box's own login, which is the same
  // question asked of the same box.
  const claudeAccount = email && !host
    ? (new Accounts(ctx.cfg.stateDir).credentialPathFor(email) ? email : null)
    : (ctx.login.status().loggedIn ? (ctx.login.status().email ?? 'this box') : null);
  if (claudeAccount) {
    connected.unshift({ provider: 'claude', label: 'Claude', account: claudeAccount, updatedAt: 0 });
  }

  return {
    catalogue: [
      {
        provider: 'claude',
        label: 'Claude',
        // No static page to send anybody to: the authorization URL is minted
        // by the CLI, per attempt, in a pane on this box. `pending.url` is
        // that URL once a flow has been started, and null the rest of the
        // time — which is the honest answer, not a missing field.
        url: pending.url ?? null,
        hint: 'Opens a Claude sign-in. The page is generated by this box for this attempt, and the code goes back to the same box.',
        env: [],
      },
      // Named after the PERSON, not the box: a token now goes to every host,
      // so the box is not what identifies it — and identifying it is what
      // makes the old one findable when somebody replaces it.
      ...catalogue(email || ctx.cfg.hostname),
    ],
    connected,
  };
}

/**
 * What a session started right now would actually get, and whether it works.
 *
 * This used to be `describe(ctx.login.status())`, which answers a DIFFERENT
 * QUESTION than the one anybody asks it. `claude auth status` reports on the
 * box's own home directory. A session does not run out of the box's home
 * directory — it runs out of a copy taken at volume creation, possibly of a
 * completely different account, and the report can say "logged in" while every
 * session on the machine comes up logged out.
 *
 * That is the shape this repo keeps hitting: true where it was written,
 * quietly false one layer up. Here it cost an evening of restarting sessions
 * on a box whose status command said it was fine.
 *
 * So all three layers are reported, in the order they fail:
 *
 *   1. the box's own login, which is what a shared-account session inherits
 *   2. the FILE that would be copied, and how long it has left
 *   3. who it belongs to, because a linked account and the shared one fail
 *      independently and only one of them is what `auth status` was reading
 *
 * @param {any} ctx
 * @returns {string}
 */
function verifyClaude(ctx) {
  const auth = ctx.login.status();
  const lines = [describe(auth)];
  // A LOGIN IN FLIGHT IS NOT A LOGGED-OUT BOX, and for a while this surface
  // could not tell you which you were looking at. `status()` used to answer
  // about whichever link flow was in progress, so a member linking their own
  // account made the whole machine report itself signed out — and the registry
  // turned that into "claude is not logged in on this host" and stopped
  // scheduling to it. Saying so is what makes that five seconds to diagnose
  // rather than an afternoon.
  if (ctx.login.isPending?.()) {
    lines.push('A login is in progress on this box right now. That is separate from the status above.');
  }
  const picked = pickCredentialSource(ctx.cfg, ctx.actor);
  const mine = picked.account !== 'shared';
  if (!picked.source) {
    // WHOSE ACCOUNT IS MISSING, in their own words. The box has no Claude
    // account of its own any more (docs/one-account-per-person.md), so this is
    // reached whenever the person asking has not linked one — or, for a local
    // surface, whenever the operator cannot be worked out. Both are one step
    // from fixed and the step differs, so the reason has to travel.
    lines.push('');
    lines.push(`A session you start on ${ctx.cfg.hostname} would not get a Claude account: ${picked.why ?? 'none is linked here'}.`);
    // The MACHINE, not a screen. Claude is linked per machine, so a remedy that
    // does not say which one is one somebody can follow and still be stuck.
    lines.push(`Connect a Claude account for ${ctx.cfg.hostname} from the app, or run \`agent-hub login\` on it.`);
    return lines.join('\n');
  }
  const state = readCredentialState(picked.source);
  // THE CONTRADICTION, NAMED. Two independent readings of the same box: what
  // the CLI says, and what is actually in the file a session gets. When they
  // disagree the interesting fact is the disagreement itself — and which way
  // round it goes says which of the two to go and look at.
  if (auth.loggedIn === false && state.state === 'fresh') {
    lines.push('');
    lines.push(
      'THESE TWO DISAGREE. `claude auth status` reports signed out while the credential file on this box is '
      + 'valid and unexpired. That is a fault in the reporting rather than in the credential — sessions here '
      + 'will work. Restarting agent-hub clears it.',
    );
  }
  lines.push('');
  lines.push(
    mine
      ? `A session you start would run on YOUR linked account (${picked.account}).`
      : 'A session you start would run on the shared account for this box.',
  );
  lines.push(describeCredential(state, mine ? 'your linked account' : "this box's credential"));
  if (state.state === 'expired' && !state.refreshable) {
    lines.push(
      mine
        ? 'Connect Claude again to replace it — until then your sessions come up logged out.'
        : 'Run /login on this box to replace it — until then new sessions come up logged out.',
    );
  }
  // WHEN SOMETHING WILL HAPPEN, which is the question this screen was actually
  // being asked. Reported from a real box: "one of the hosts only has 6 hours
  // left, want to see if it gets bumped to 8 — a test doesn't do it from the
  // app." Nothing was wrong and nothing was going to happen, and the screen
  // gave no way to know that.
  //
  // A CREDENTIAL WITH HOURS LEFT IS NOT A PROBLEM TO BE SOLVED. An OAuth
  // client renews near expiry, not on request, so a token cannot be topped up
  // early by asking harder — and a screen that offers a Test button next to an
  // expiry invites exactly that reading.
  lines.push('');
  lines.push(renewalPlan(ctx, state));
  // The resumed-session case, which is the one that went wrong: a session
  // takes a copy at volume creation and used to keep it forever. It no longer
  // does, and saying so is the difference between trusting a resume and
  // forgetting a week of work to get a fresh one.
  //
  // And a session can never renew the BOX's credential, which is the other
  // half of that report — "starting a new session doesn't renew Claude". It
  // cannot: a sandboxed session works on a copy inside its own volume, so any
  // refresh the CLI does in there updates the copy and never the original.
  lines.push('Resuming a session refreshes its copy from whichever account it began on. A session can never renew '
    + "this box's own credential — it works on a copy in its volume.");
  return lines.join('\n');
}

/**
 * What the box will do about this credential, and when.
 *
 * @param {any} ctx
 * @param {import('../core/claude-credential.js').CredentialState} state
 */
function renewalPlan(ctx, state) {
  const every = ctx.cfg.credentialKeepaliveMs;
  if (!every) return 'Automatic renewal is switched off on this box (AGENT_HUB_CREDENTIAL_KEEPALIVE_MS=0).';
  if (state.state === 'unknown') {
    return 'This box checks hourly, but cannot act on a credential it cannot read.';
  }
  const left = state.expiresAt === null ? null : state.expiresAt - Date.now();
  if (left !== null && left > RENEW_WITHIN_MS) {
    const until = Math.round((left - RENEW_WITHIN_MS) / 60_000);
    return `Nothing to do yet. This box will start trying about ${humaniseMinutes(until)} from now, when there is `
      + 'less than four hours left. A token with hours on it cannot be topped up early — the CLI renews near '
      + 'expiry, not when asked.';
  }
  return 'This box is in the window where it tries to renew, hourly, and will use a one-shot prompt if the free '
    + 'check does not move it.';
}

/** Four hours, matching src/core/keepalive.js. */
const RENEW_WITHIN_MS = 4 * 3_600_000;

/** @param {number} minutes */
function humaniseMinutes(minutes) {
  if (minutes < 60) return `${Math.max(minutes, 1)} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'an hour' : `${hours} hours`;
}

/**
 * The bin, as a person reads it.
 *
 * Leads with WHEN IT GOES, not when it was forgotten: "three days left" is the
 * fact somebody is deciding on, and "forgotten on Tuesday" makes them do the
 * arithmetic themselves.
 *
 * @param {Array<{ name: string, title?: string|null, expiresAt: number }>} bin
 */
function describeBin(bin) {
  const now = Date.now();
  return bin
    .map((rec) => {
      const left = rec.expiresAt - now;
      const days = Math.floor(left / 86_400_000);
      const hours = Math.floor(left / 3_600_000);
      const when = days >= 1 ? `${days} day${days === 1 ? '' : 's'} left` : hours >= 1 ? `${hours}h left` : 'goes within the hour';
      return `  ${rec.name}${rec.title ? ` — ${rec.title}` : ''} (${when})`;
    })
    .join('\n');
}

/**
 * `short` is the one-line description registered with Telegram's setMyCommands,
 * which is what makes the client autocomplete these as you type "/". Telegram
 * caps it at 256 characters and shows it inline, so keep it to a few words —
 * `help` is the longer text for /help.
 *
 * @type {Record<string, { aliases?: string[], usage: string, help: string, short?: string, hidden?: boolean, run: (ctx: Ctx, args: string[], flags: Set<string>) => Promise<Reply>|Reply }>}
 */
export const COMMANDS = {
  help: {
    aliases: ['start_help', 'commands', '?'],
    usage: '/help',
    short: 'List every command',
    help: 'Show this list.',
    run: (ctx) => ({ ok: true, text: helpText(ctx) }),
  },

  new: {
    // `start` is here for the web UI and CLI, where it is the natural word.
    // Telegram reserves a bare /start as the bot-intro command, so its adapter
    // maps that one case to /help — see adapters/telegram.js.
    aliases: ['start', 'launch', 'run'],
    usage: '/new [name] [path] [--safe|--dangerous]',
    short: 'Start a new Claude session',
    help: 'Start a new session. --safe keeps permission prompts on for this one session.',
    run: async (ctx, args, flags) => {
      const [name, cwd] = args;
      const skipPermissions = permissionOverride(flags);
      // title and brief arrive as FIELDS on the context, never parsed out of
      // the command line. A title is prose with spaces in it, and putting prose
      // into a line that is then split is the same mistake `answer` taking an
      // ordinal exists to avoid — it looks bounded and is not.
      const r = await ctx.sessions.start({
        name,
        cwd,
        actor: ctx.actor,
        skipPermissions,
        title: ctx.title ?? null,
        brief: ctx.brief ?? null,
      });
      let text = r.message;
      if (r.ok && skipPermissions === false) text += '\nPermission prompts are ON for this session.';
      if (r.ok && skipPermissions === true && !ctx.cfg.skipPermissions) {
        text += '\nPermission checks are BYPASSED for this session.';
      }
      return { ok: r.ok, text, sessions: r.session ? [r.session] : undefined };
    },
  },

  resume: {
    aliases: ['continue'],
    usage: '/resume <name> [summary|full]',
    short: 'Resume a stopped session',
    help: 'Bring a stopped session back with its conversation intact.',
    run: async (ctx, args) => {
      if (!args[0]) {
        // No name given: offer the ones that can actually be resumed rather
        // than making someone go and read /list first.
        const resumable = ctx.sessions.list().filter((s) => s.status !== 'running' && s.uuid);
        if (!resumable.length) return { ok: false, text: 'Nothing to resume. /list shows what exists.' };
        return {
          ok: false,
          text: 'Which session?',
          buttons: sessionButtons(resumable, (s) => `/resume ${s.name}`, (s) => s.name),
        };
      }
      const choice = parseResumeChoice(args[1]);
      if (args[1] && !choice) {
        return { ok: false, text: `"${args[1]}" is not a resume mode. Use "summary" or "full".` };
      }
      const r = await ctx.sessions.resume({ name: args[0], actor: ctx.actor, choice });
      // When the session parks at the dialog, turn the two options into taps.
      const waiting = ctx.sessions.awaitingChoice.has(args[0]);
      return {
        ok: r.ok,
        text: r.message,
        sessions: r.session ? [r.session] : undefined,
        buttons: waiting
          ? [
              { label: 'Resume from summary', command: `/resume ${args[0]} summary` },
              { label: 'Resume full session', command: `/resume ${args[0]} full` },
            ]
          : undefined,
      };
    },
  },

  stop: {
    aliases: ['kill', 'close'],
    usage: '/stop <name>',
    short: 'Stop a running session',
    help: 'Stop a session. Its conversation is kept so /resume still works.',
    run: (ctx, args) => {
      if (!args[0]) {
        const running = ctx.sessions.running();
        if (!running.length) return { ok: false, text: 'Nothing is running.' };
        return {
          ok: false,
          text: 'Which session?',
          buttons: sessionButtons(running, (s) => `/stop ${s.name}`, (s) => s.name),
        };
      }
      const r = ctx.sessions.stop({ name: args[0], actor: ctx.actor });
      return { ok: r.ok, text: r.message, sessions: r.session ? [r.session] : undefined };
    },
  },

  list: {
    aliases: ['ls', 'sessions', 'ps'],
    usage: '/list',
    short: 'Show all sessions',
    help: 'Show every session — running and resumable.',
    run: (ctx) => {
      const all = ctx.sessions.list();
      if (!all.length) {
        return { ok: true, text: 'No sessions yet. Start one with /new [name].', sessions: [] };
      }
      const running = all.filter((s) => s.status === 'running');
      const rest = all.filter((s) => s.status !== 'running');
      const lines = [`${running.length}/${ctx.cfg.maxSessions} running on ${ctx.cfg.hostname}`, ''];
      for (const s of running) {
        lines.push(`▶ ${label(s)}${modeSuffix(ctx, s)}${s.rcUrl ? `\n   ${s.rcUrl}` : ''}`);
      }
      if (rest.length) {
        lines.push('', 'Resumable:');
        for (const s of rest) {
          lines.push(`◼ ${label(s)}${s.uuid ? '' : '  (no saved conversation)'}`);
        }
      }
      // One tap per session: stop what's running, resume what isn't.
      const buttons = [
        ...sessionButtons(running, (s) => `/stop ${s.name}`, (s) => `Stop ${s.name}`),
        ...sessionButtons(
          rest.filter((s) => s.uuid),
          (s) => `/resume ${s.name}`,
          (s) => `Resume ${s.name}`,
        ),
      ].slice(0, 10);
      return { ok: true, text: lines.join('\n'), sessions: all, buttons };
    },
  },

  status: {
    aliases: ['info'],
    usage: '/status [name]',
    short: 'Hub health, or one session',
    help: 'Hub health, or details for one session.',
    run: (ctx, args) => {
      if (!args[0]) {
        const all = ctx.sessions.list();
        const running = all.filter((s) => s.status === 'running').length;
        const auth = ctx.login.status();
        return {
          ok: true,
          text: [
            `agent-hub on ${ctx.cfg.hostname}`,
            `${running}/${ctx.cfg.maxSessions} sessions running, ${all.length} known`,
            `workdir: ${ctx.cfg.workdir}`,
            `claude: ${auth.loggedIn ? `logged in as ${auth.email || 'unknown'}` : 'NOT LOGGED IN — run /login'}`,
          ].join('\n'),
        };
      }
      const s = ctx.sessions.get(args[0]);
      if (!s) return { ok: false, text: `No session named "${args[0]}".` };
      const lines = [
        `${label(s)} — ${s.status}`,
        `cwd: ${s.cwd}`,
        `permissions: ${effectiveSkip(ctx, s) ? 'bypassed (--dangerously-skip-permissions)' : 'prompts enabled'}` +
          (s.skipPermissions === null ? ' [global default]' : ' [set for this session]'),
        `conversation: ${s.uuid || 'none recorded (cannot be resumed)'}`,
        s.rcUrl ? `remote control: ${s.rcUrl}` : null,
        s.detail ? `last: ${s.detail}` : null,
        s.createdBy ? `started by: ${s.createdBy}` : null,
      ].filter(Boolean);
      return { ok: true, text: /** @type {string[]} */ (lines).join('\n'), sessions: [s] };
    },
  },

  // --- the workspace --------------------------------------------------------
  //
  // Five commands rather than one with a subcommand, matching the five verbs
  // for the same reason: `mutating` has to be true of the destructive ones and
  // false of the others, and a single command cannot be both.
  files: {
    usage: '/files <name> [path]',
    short: "List a directory in a session's workspace",
    help: 'One level of a session workspace. Paths are relative to its root; leave the path off for the root.',
    run: (ctx, args) => {
      if (!args[0]) return { ok: false, text: 'Usage: /files <name> [path]' };
      const r = listFiles(ctx.cfg, args[0], args[1] || '.');
      return { ok: r.ok, text: r.text };
    },
  },

  readfile: {
    usage: '/readfile <name> <path>',
    short: "Read a text file from a session's workspace",
    help: 'Text only, and bounded. A binary file or one over 256KB is refused rather than dumped.',
    run: (ctx, args) => {
      if (!args[0] || !args[1]) return { ok: false, text: 'Usage: /readfile <name> <path>' };
      const r = readFile(ctx.cfg, args[0], args[1]);
      return { ok: r.ok, text: r.text };
    },
  },

  writefile: {
    usage: '/writefile <name> <path>',
    short: "Write a file in a session's workspace",
    help:
      'The content travels as a field beside the command, not as an argument — a file has newlines and ' +
      'leading whitespace that matter. Replaces whatever was there.',
    run: (ctx, args) => {
      if (!args[0] || !args[1]) return { ok: false, text: 'Usage: /writefile <name> <path>' };
      if (typeof ctx.content !== 'string') {
        return { ok: false, text: 'No content was sent. /writefile takes the file body as a field, not an argument.' };
      }
      const r = writeFile(ctx.cfg, args[0], args[1], ctx.content);
      return { ok: r.ok, text: r.text };
    },
  },

  copyfile: {
    usage: '/copyfile <name> <path> <to>',
    short: "Copy a file or directory within a session's workspace",
    help: 'Both ends are confined to the workspace: a copy is a write, and a write that lands outside is the same problem as a read that starts outside.',
    run: (ctx, args) => {
      if (!args[0] || !args[1] || !args[2]) return { ok: false, text: 'Usage: /copyfile <name> <path> <to>' };
      const r = copyFile(ctx.cfg, args[0], args[1], args[2]);
      return { ok: r.ok, text: r.text };
    },
  },

  deletefile: {
    usage: '/deletefile <name> <path>',
    short: "Delete a file or directory from a session's workspace",
    help: 'Not recoverable. /forget takes the whole workspace and keeps it for seven days; this takes part of it and keeps nothing.',
    run: (ctx, args) => {
      if (!args[0] || !args[1]) return { ok: false, text: 'Usage: /deletefile <name> <path>' };
      const r = deleteFile(ctx.cfg, args[0], args[1]);
      return { ok: r.ok, text: r.text };
    },
  },

  answer: {
    usage: '/answer <name> <1-9> [promptId]',
    short: 'Answer a prompt a session is waiting on',
    help: 'Select one of the numbered options the session is showing. Never free text — see docs/plan.md.',
    run: async (ctx, args) => {
      const [name, choice, promptRef] = args;
      if (!name || !choice) return { ok: false, text: 'Usage: /answer <name> <1-9> [promptId]' };
      const option = Number(choice);
      if (!Number.isInteger(option) || option < 1 || option > 9) {
        return { ok: false, text: 'The choice must be a number from 1 to 9 — one of the options shown.' };
      }
      const r = ctx.sessions.answer(name, option, promptRef || null);
      return { ok: r.ok, text: r.message };
    },
  },

  forget: {
    usage: '/forget <name>',
    short: 'Stop a session and put it in the bin',
    help: 'Stop a session and take it out of the list. Recoverable with /restore for seven days, ' +
      'because this used to be the one action here with no undo.',
    run: (ctx, args) => {
      if (!args[0]) return { ok: false, text: 'Which session? Try /forget <name>.' };
      const r = ctx.sessions.forget({ name: args[0] });
      return { ok: r.ok, text: r.message };
    },
  },

  restore: {
    usage: '/restore <name>',
    short: 'Bring a forgotten session back',
    help: 'Take a session out of the bin. Its conversation and workspace were never deleted, so it ' +
      'comes back exactly as it was and can be resumed.',
    run: (ctx, args) => {
      if (!args[0]) {
        // The list IS the answer to "which one?", so give it rather than a
        // usage line somebody then has to go and satisfy.
        const bin = ctx.sessions.binned();
        if (!bin.length) return { ok: false, text: 'The bin is empty.' };
        return { ok: false, text: `Which one?\n${describeBin(bin)}` };
      }
      const r = ctx.sessions.restoreFromBin({ name: args[0] });
      return { ok: r.ok, text: r.message };
    },
  },

  purge: {
    usage: '/purge <name>',
    short: 'Delete a session for good',
    help: 'Delete the conversation and the workspace now, with no recovery. This is what /forget used to do.',
    run: (ctx, args) => {
      if (!args[0]) return { ok: false, text: 'Which session? Try /purge <name>.' };
      const r = ctx.sessions.purge({ name: args[0] });
      return { ok: r.ok, text: r.message };
    },
  },

  bin: {
    aliases: ['trash'],
    usage: '/bin',
    short: 'What is still recoverable',
    help: 'Sessions that have been forgotten but not yet deleted, soonest to expire first.',
    run: (ctx) => {
      const bin = ctx.sessions.binned();
      return bin.length
        ? { ok: true, text: describeBin(bin) }
        : { ok: true, text: 'The bin is empty. /forget puts a session here rather than deleting it.' };
    },
  },

  // --- Claude account ------------------------------------------------------

  accounts: {
    aliases: ['account'],
    usage: '/accounts [remove <email>]',
    short: 'Which people have linked their own Claude account',
    help: 'Linked accounts are seeded into the sessions that person starts; everyone else uses the shared one. Link with /login for <email>.',
    run: async (ctx, args) => {
      const store = new Accounts(ctx.cfg.stateDir);
      if ((args[0] || '').toLowerCase() === 'remove') {
        const email = normaliseEmail(args[1]);
        if (!email) return { ok: false, text: 'Usage: /accounts remove <email>' };
        return store.remove(email)
          // THERE IS NO SHARED ACCOUNT TO FALL BACK TO. This said there was,
          // which was true until docs/one-account-per-person.md and is now the
          // opposite of what happens: unlinking is what STOPS somebody being
          // able to start a session, and a message promising a fallback sends
          // them off to discover that at the worst moment.
          ? {
            ok: true,
            text:
              `Unlinked ${email}. They cannot start sessions on this box until they connect an account again — `
              + 'there is no shared one to fall back to. Sessions already running keep what they were seeded with.',
          }
          : { ok: false, text: `${email} has no linked account.` };
      }
      const linked = store.list();
      return {
        ok: true,
        text: linked.length
          ? `Linked accounts:\n${linked.map((e) => `  ${e}`).join('\n')}\n\nEveryone else uses the shared account.`
          : 'Nobody has linked a personal account \u2014 every session uses the shared one. Link with /login for <email>.',
      };
    },
  },

  login: {
    aliases: ['auth'],
    usage: '/login [console|status|cancel|logout|for <email>]',
    short: 'Log this box into Claude',
    help: 'Log this box into a Claude account without SSH. Bare /login starts the subscription flow. ' +
      '/login for <email> links THAT PERSON\u2019S account instead \u2014 the box stays on its own login, ' +
      'and sessions they start run on theirs.',
    run: async (ctx, args) => {
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'status') return { ok: true, text: describe(ctx.login.status()) };
      if (sub === 'for') {
        // Linking a person, not logging in the box. Same OAuth, same pasted
        // code \u2014 but the credential lands in the accounts store under their
        // email, in an isolated CLAUDE_CONFIG_DIR, and the box login is never
        // touched. docs/accounts.md.
        const email = normaliseEmail(args[1]);
        if (!email) return { ok: false, text: 'Usage: /login for <email> \u2014 the address they sign the FLEET in with.' };
        const r = await ctx.login.start({ actor: ctx.actor, linkFor: email });
        return {
          ok: r.ok,
          text: r.ok ? `Linking a Claude account for ${email}.\n${r.message ?? ''}` : r.message,
          // THE URL AS A FIELD, not only inside the prose. An app that had to
          // find it by scraping the message would break the first time the
          // wording changed — and this particular string is the one a person
          // is about to hand their Claude password to, so it is the last
          // thing that should be recovered by regex.
          connections: connectionsPayload(ctx, { url: r.url ?? null }),
        };
      }
      if (sub === 'cancel') return { ok: true, text: ctx.login.cancel().message };
      if (sub === 'logout') {
        const r = ctx.login.logout();
        return { ok: r.ok, text: r.message };
      }
      const current = ctx.login.status();
      if (current.loggedIn && sub !== 'force' && sub !== 'console') {
        return {
          ok: true,
          text: `${describe(current)}\n\nAlready logged in. /login force to replace it, or /login logout first.`,
        };
      }
      const r = await ctx.login.start({
        actor: ctx.actor,
        mode: sub === 'console' ? 'console' : 'claudeai',
      });
      return { ok: r.ok, text: r.message, connections: connectionsPayload(ctx, { url: r.url ?? null }) };
    },
  },

  // --- Other credentials ---------------------------------------------------

  connect: {
    usage: '/connect [github|cloudflare] [--host]',
    short: 'Connect a GitHub or Cloudflare token',
    help:
      'Opens the provider\u2019s own token page with the right scopes pre-ticked. You create the token, ' +
      'on your account, and paste it back with /link. Nothing of ours sits in the middle of that page, ' +
      'and you can revoke it from the same place at any time.',
    run: async (ctx, args, flags) => {
      const host = ctx.cfg.hostname;
      const which = (args[0] || '').toLowerCase();
      const boxRow = flags?.has('host') === true;
      // THE SAME ANSWER FOR BOTH SURFACES. Chat reads the prose; an app reads
      // `connections` and renders a picker from it — which is why the
      // catalogue travels rather than being hardcoded in two mobile clients.
      // A provider added to the table appears in both apps with no app change,
      // which is the entire reason the verbs are connect/link/unlink and not
      // github/cloudflare.
      const structured = connectionsPayload(ctx, {}, { host: boxRow });
      if (!which) {
        const have = new Map(structured.connected.map((c) => [c.provider, c]));
        return {
          ok: true,
          connections: structured,
          text: catalogue(host)
            .map((c) => {
              const it = have.get(c.provider);
              return `${c.label}: ${it ? `connected${it.account ? ` as ${it.account}` : ''}` : 'not connected'}\n  /connect ${c.provider}`;
            })
            .join('\n'),
        };
      }
      const found = structured.catalogue.find((c) => c.provider === which);
      if (!found) {
        return { ok: false, text: `No provider called "${which}". Try /connect on its own to see the list.` };
      }
      return {
        ok: true,
        connections: structured,
        text:
          `Create a ${found.label} token here:\n${found.url}\n\n${found.hint}\n\n` +
          `Then send it back: /link ${found.provider} <token>\n` +
          `It is checked against ${found.label} before it is stored, and exported to new sessions as ${found.env.join(' and ')}.`,
      };
    },
  },

  link: {
    usage: '/link <provider> <token> [--host]',
    short: 'Store a token from /connect',
    help: 'Verifies the token with the provider before storing it, so a typo fails here rather than four hours into a session. ' +
      '--host stores it as the BOX\u2019s token, which every session on this machine gets; without it the token is yours alone.',
    run: async (ctx, args, flags) => {
      const provider = (args[0] || '').toLowerCase();
      // args[1] and nothing else. A token has no spaces, and joining the rest
      // would silently accept a paste that picked up half the page.
      const secret = (args[1] || '').trim();
      if (!provider || !secret) return { ok: false, text: 'Usage: /link <provider> <token>' };
      if (args.length > 2) {
        return { ok: false, text: 'That looks like more than a token \u2014 paste just the token itself.' };
      }
      if (!isProvider(provider)) {
        return { ok: false, text: `No provider called "${provider}". Try /connect on its own to see the list.` };
      }
      const checked = await verifyToken(provider, secret);
      if (!checked.ok) return { ok: false, text: checked.message };
      const store = new Connections(ctx.cfg.stateDir);
      // WHOSE ROW. `--host` is the box's shared one, which the coordinator
      // gates on admin; anything else is the caller's own, and an actor whose
      // identity cannot be resolved gets a refusal rather than the shared row.
      const boxRow = flags?.has('host') === true;
      const row = boxRow ? HOST_ROW : rowForActor(ctx.actor);
      if (row === null) {
        return { ok: false, text: 'Could not tell whose credential this is, so nothing was stored.' };
      }
      const saved = store.save(row, provider, secret, checked.account ?? null, checked.granted ?? null);
      return {
        ok: saved.ok,
        text: `${checked.message}\n${saved.message}`,
        // §7: one round trip per action. A client that has to ask again to
        // find out whether the thing it just did worked is a client that
        // shows a stale screen for one refresh interval.
        connections: connectionsPayload(ctx, {}, { host: boxRow }),
      };
    },
  },

  verify: {
    aliases: ['test'],
    usage: '/verify <provider> [--host]',
    short: 'Check a stored token still works',
    help:
      'Asks the provider what the stored token can actually do. A token can be revoked, expire, or have '
      + 'its permissions narrowed long after it was stored, and nothing here would know until a session failed.',
    run: async (ctx, args, flags) => {
      const provider = (args[0] || '').toLowerCase();
      if (!provider) return { ok: false, text: 'Usage: /verify <provider>' };
      if (provider === 'claude') return { ok: true, text: verifyClaude(ctx) };
      const row = flags?.has('host') === true ? HOST_ROW : rowForActor(ctx.actor);
      if (row === null) return { ok: false, text: 'Could not tell whose credential to check.' };
      const r = await new Connections(ctx.cfg.stateDir).check(row, provider);
      if (!r.ok) return { ok: false, text: r.message };
      const lines = [r.message];
      if (r.granted?.length) lines.push(`\nIt has: ${r.granted.join(', ')}`);
      if (r.missing?.length) lines.push(`It is missing: ${r.missing.join(', ')}`);
      else if (r.missing) lines.push('Nothing it is asked for is missing.');
      else if (!r.granted) lines.push(`\n${PROVIDERS[provider]?.label ?? provider} does not report what a token was granted.`);
      return { ok: true, text: lines.join('\n'), check: r };
    },
  },

  renew: {
    usage: '/renew <provider> <client-id> <refresh-token>',
    short: 'Let this box keep a connection alive by itself',
    help:
      'A GitHub App token lasts eight hours and is not renewed by being used — it is replaced by an '
      + 'exchange that needs the App client secret. This stores what that exchange needs, in a file no '
      + 'session is given, and the box renews on its own from then on.',
    run: async (ctx, args) => {
      // The fourth argument is the client secret an older coordinator still
      // sends. It is READ AND DISCARDED: it belongs in the sidecar's memory,
      // delivered on the config frame, not in a file on this box.
      const [provider, clientId, refresh] = args;
      if (provider !== 'github' || !clientId || !refresh) {
        return { ok: false, text: 'Usage: /renew github <client-id> <refresh-token>' };
      }
      const row = rowForActor(ctx.actor);
      // Fails closed. There is no row to write to, so nothing is written —
      // rather than falling back to one other people read.
      if (row === null) return { ok: false, text: 'Could not tell whose connection this is, so nothing was stored.' };
      const store = new Connections(ctx.cfg.stateDir);
      const saved = store.saveRenewal(row, provider, { clientId, refresh });
      if (!saved.ok) return { ok: false, text: saved.message };
      // NOT RENEWED HERE. The token that arrived with this connection is
      // minutes old and has its full eight hours; spending an exchange now
      // would rotate the refresh token for nothing. The timer picks it up when
      // there is something to gain.
      return { ok: true, text: saved.message, connections: connectionsPayload(ctx, {}, { host: false }) };
    },
  },

  unlink: {
    usage: '/unlink <provider> [--host]',
    short: 'Forget a stored token',
    help: 'Removes it from this box. It stays live on your account until you revoke it with the provider.',
    run: async (ctx, args, flags) => {
      const provider = (args[0] || '').toLowerCase();
      if (!provider) return { ok: false, text: 'Usage: /unlink <provider>' };
      const boxRow = flags?.has('host') === true;
      const row = boxRow ? HOST_ROW : rowForActor(ctx.actor);
      if (row === null) return { ok: false, text: 'Could not tell whose credential this is, so nothing was removed.' };
      const r = new Connections(ctx.cfg.stateDir).remove(row, provider);
      return { ok: r.ok, text: r.message, connections: connectionsPayload(ctx, {}, { host: boxRow }) };
    },
  },

  code: {
    usage: '/code <value>',
    short: 'Send back the login code',
    help: 'Send back the authorization code from the /login page.',
    run: async (ctx, args) => {
      if (!args[0]) return { ok: false, text: 'Paste the code: /code <value>' };
      // WHO is sending it. Only the actor that started the flow may finish it
      // — otherwise a fleet member can complete the admin's box login with
      // their own authorization code, and every session on this machine
      // afterwards runs on an account they control.
      const r = await ctx.login.submitCode(args.join(''), ctx.actor);
      return { ok: r.ok, text: r.message, connections: connectionsPayload(ctx) };
    },
  },

  logs: {
    aliases: ['log', 'journal'],
    usage: '/logs [hub|coordinator|sidecar|<session>] [lines]',
    short: 'Recent service or session logs',
    help: 'The last lines of a service log, or of a session — /logs <name> shows what that session printed. '
      + 'Defaults to the session manager, 40 lines.',
    run: (ctx, args) => {
      // Either order, because nobody remembers which comes first.
      const words = args.filter(Boolean);
      const lines = words.map(Number).find((n) => Number.isFinite(n) && n > 0) ?? null;
      const source = words.find((w) => resolveSource(w)) ?? null;

      // A SESSION NAME beats a service name, and is checked against the
      // registry rather than guessed at: "is this a service word" already has
      // an answer, so anything else that names a real session is a session.
      const sessionWord = words.find((w) => !resolveSource(w) && !Number.isFinite(Number(w)) && ctx.sessions.get?.(w));
      if (sessionWord) {
        const r = readSessionLogs(ctx.cfg, sessionWord, lines ?? 60);
        return { ok: r.ok, text: r.text };
      }

      const unknown = words.find((w) => !resolveSource(w) && !Number.isFinite(Number(w)));
      if (unknown) {
        return {
          ok: false,
          text: `"${unknown}" is not a service I can read. Try: ${Object.keys(LOG_SOURCES).join(', ')}.`,
          buttons: logButtons(ctx),
        };
      }

      const r = readLogs(ctx.cfg, { source, lines });
      // The other services are one tap away, since "why did that fail" is
      // rarely answered by exactly one of them.
      return { ok: r.ok, text: r.text, buttons: logButtons(ctx, r.source) };
    },
  },

  update: {
    // NOT 'upgrade': that is a command of its own, further down, and having it
    // as an alias here too means the lookup table is decided by declaration
    // order. It happens to resolve the right way today — `upgrade` is defined
    // after `update`, so it overwrites — and if anybody reordered this object,
    // /upgrade would quietly start restarting the service instead of
    // installing system packages.
    aliases: ['pull'],
    usage: '/update [--restart]',
    short: 'Pull the latest code',
    help:
      'Pull the latest code onto this box. --restart applies it immediately ' +
      '(sessions are left running).',
    run: async (ctx, _args, flags) => {
      const status = updateStatus(ctx.cfg);

      // A PACKAGED BOX UPDATES BY MANIFEST, not by pull. Branching here rather
      // than inside runUpdate keeps the git path exactly as it was — the
      // fallback docs/packaging.md relies on to move boxes one at a time is
      // only a fallback if it is untouched.
      if (status.packaged) {
        if (!ctx.cfg.releaseManifest) {
          return {
            ok: false,
            text:
              `${status.dir} is a release.\n\n` +
              'Set AGENT_HUB_RELEASE_MANIFEST to the URL of a release manifest and /update will fetch from it.',
          };
        }
        const r = await applyRelease({
          installDir: ctx.cfg.installDir,
          manifestUrl: ctx.cfg.releaseManifest,
          protocol: PROTOCOL_VERSION,
          dryRun: flags.has('check'),
        });
        // The same two-step as the git path: the code lands, then somebody
        // decides when to restart. A release that restarted the box the moment
        // it downloaded would apply itself while sessions were mid-answer.
        const applied = r.ok && r.changed && (flags.has('restart') || flags.has('apply'));
        if (applied) {
          const restarted = restartSelf();
          return { ok: restarted.ok, text: `${r.message}\n\n${restarted.message}` };
        }
        return {
          ok: r.ok,
          text: r.message,
          buttons: r.ok && r.changed && canSelfRestart() ? [{ label: 'Restart to apply', command: '/update --restart' }] : undefined,
        };
      }

      if (!status.ok) return { ok: false, text: status.message ?? 'Could not read the checkout.' };

      // --check answers "is there anything" without changing the box, which is
      // what a notification wants and what somebody asks before deciding to
      // restart a machine with sessions running on it.
      if (flags.has('check')) {
        const avail = updateAvailable(ctx.cfg, { force: true });
        if (!avail.ok) return { ok: true, text: `${status.dir} (${status.branch})\n\n${avail.message}` };
        return {
          ok: true,
          text:
            `${status.dir} (${status.branch})\n\n` +
            (avail.behind
              ? `${avail.behind} commit${avail.behind === 1 ? '' : 's'} behind ${avail.upstream}. /update to pull.`
              : 'Up to date.'),
          buttons: avail.behind ? [{ label: 'Update now', command: '/update' }] : undefined,
        };
      }

      const restart = flags.has('restart') || flags.has('apply');
      const r = runUpdate(ctx.cfg, { restart, actor: ctx.actor });

      // Offer the restart as a tap rather than making someone remember a flag.
      // Only when there is something to apply and we can actually do it.
      const buttons =
        r.ok && r.changed && !r.restarting && canSelfRestart()
          ? [{ label: 'Restart to apply', command: '/update --restart' }]
          : undefined;

      return { ok: r.ok, text: `${status.dir} (${status.branch})\n\n${r.message}`, buttons };
    },
  },

  upgrade: {
    aliases: ['sysupdate'],
    usage: '/upgrade [--apply]',
    short: 'System packages on this box',
    help:
      'What the operating system has waiting, and — if it has been turned on — ' +
      'apply it. Separate from /update, which is this app rather than the box.',
    run: (ctx, _args, flags) => {
      if (flags.has('apply') || flags.has('yes')) {
        const r = runUpgrade(ctx.cfg, { actor: ctx.actor });
        return { ok: r.ok, text: r.text };
      }
      // Somebody is waiting for this answer, so refresh before giving it —
      // rate-limited inside, and a no-op when it is not permitted.
      refreshPackageLists(ctx.cfg);
      const s = systemUpdates();
      if (!s.supported) return { ok: true, text: `No package information here (${s.reason ?? 'unsupported'}).` };
      const summary = describeSystemUpdates(s);
      if (!summary) return { ok: true, text: 'The box is up to date.' };

      const shown = s.packages.slice(0, 12).join(', ');
      return {
        ok: true,
        text:
          `${summary}\n\n${shown}${s.packages.length > 12 ? `, …and ${s.count - 12} more` : ''}` +
          '\n\n/upgrade --apply to install them.',
        buttons: ctx.cfg.systemUpgrade ? [{ label: 'Install updates', command: '/upgrade --apply' }] : undefined,
      };
    },
  },

  reboot: {
    usage: '/reboot [pin] [hostname]',
    short: 'Reboot this box',
    help:
      'Reboot the machine. Three confirmations, each asking for something ' +
      'different: the command, a one-time PIN, and the hostname typed out. ' +
      'Every running session dies — a reboot takes the tmux server with it.',
    run: async (ctx, args) => {
      const running = (await ctx.sessions.list()).filter((s) => s.status === 'running').map((s) => s.name);
      const r = reboot(ctx.cfg, args, { actor: ctx.actor, sessions: running });
      return { ok: r.ok, text: r.text };
    },
  },

  enroll: {
    aliases: ['enrol', 'join'],
    usage: '/enroll <pin>',
    short: 'Join this box to a fleet',
    help:
      'Join this box to its coordinator with a six-digit pin. Mint the pin in ' +
      'the app; it is good for ten minutes and works once. The pin buys one ' +
      'exchange — this box generates its own key and never sends the private half.',
    run: async (ctx, args) => {
      const r = await fleetEnrol(args[0] || '', { actor: ctx.actor });
      return { ok: r.ok, text: r.text };
    },
  },

  identity: {
    aliases: ['fleet'],
    usage: '/identity',
    short: "Show this box's fleet identity",
    help:
      "Show this box's host id, its key fingerprint, and whether the " +
      'coordinator currently accepts it. The fingerprint is what you compare ' +
      'against the one the app shows for this host.',
    run: async () => {
      const r = await fleetIdentity();
      return { ok: r.ok, text: r.text };
    },
  },

  whoami: {
    usage: '/whoami',
    short: 'Show the id the hub sees you as',
    help: 'Show the id this hub sees you as — what goes in the allowlist.',
    run: (ctx) => ({ ok: true, text: `You are: ${ctx.actor}` }),
  },
};

/**
 * One button per service this box actually has, minus the one being shown.
 * Offering a unit that is not installed is offering a button that answers
 * "no log entries" — which looks like a broken service rather than an absent
 * one.
 * @param {Ctx} ctx
 * @param {string} [current]
 * @returns {Button[]}
 */
function logButtons(ctx, current) {
  return Object.entries(LOG_SOURCES)
    .filter(([key, { unit }]) => key !== current && unitInstalled(ctx.cfg, unit))
    .map(([key, { what }]) => ({ label: `Logs: ${what}`, command: `/logs ${key}` }));
}

/** name or alias → canonical command name */
const LOOKUP = (() => {
  /** @type {Record<string, string>} */
  const m = {};
  for (const [name, def] of Object.entries(COMMANDS)) {
    m[name] = name;
    for (const a of def.aliases || []) m[a] = name;
  }
  return m;
})();

/**
 * The command menu a chat client can register for autocomplete. Derived from
 * COMMANDS rather than written out separately, so a new command shows up in
 * the client's "/" menu without anyone remembering to update a second list.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {Array<{ command: string, description: string }>}
 */
export function commandMenu(cfg) {
  return Object.entries(COMMANDS)
    .filter(([name, def]) => {
      if (def.hidden || !def.short) return false;
      if (!cfg.loginEnabled && (name === 'login' || name === 'code')) return false;
      return true;
    })
    .map(([name, def]) => ({
      // Telegram requires lowercase, 1-32 chars, [a-z0-9_].
      command: name.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32),
      description: String(def.short).slice(0, 256),
    }));
}

/** @param {Ctx} ctx */
export function helpText(ctx) {
  const lines = [`agent-hub on ${ctx.cfg.hostname}`, ''];
  for (const [name, def] of Object.entries(COMMANDS)) {
    if (name === 'help') continue;
    if (!ctx.cfg.loginEnabled && (name === 'login' || name === 'code')) continue;
    lines.push(`${def.usage}\n   ${def.help}`);
  }
  return lines.join('\n');
}

/**
 * Run one command line.
 * @param {Ctx} ctx
 * @param {string} line
 * @returns {Promise<Reply>}
 */
export async function dispatch(ctx, line) {
  const { name, args, flags } = parse(line);
  if (!name) return { ok: false, text: helpText(ctx) };

  const canonical = LOOKUP[name];
  if (!canonical) {
    return { ok: false, text: `Unknown command "${name}". Try /help.` };
  }
  if (!ctx.cfg.loginEnabled && (canonical === 'login' || canonical === 'code')) {
    return { ok: false, text: 'Login from agent-hub is disabled (AGENT_HUB_LOGIN=0).' };
  }

  try {
    return await COMMANDS[canonical].run(ctx, args, flags);
  } catch (e) {
    const err = /** @type {Error} */ (e);
    return { ok: false, text: `${canonical} failed: ${err.message}` };
  }
}
