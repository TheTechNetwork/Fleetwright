// Where does an intent go?
//
// design.md §3, in order:
//
//   1. Resume is PINNED. `claude-<name>` is a host-local volume, so anything
//      naming an existing session must land on the box holding it. Round robin
//      applies to placement of NEW sessions only — sending `/resume bigjob` to
//      a box that has never heard of bigjob is not load balancing, it is losing
//      the session.
//   2. Round robin is the wrong default for new work. Hosts differ in capacity
//      and sessions differ wildly in weight. Filter by constraints → rank by
//      free capacity → tie-break round robin.
//
// The other half is refusing to guess. A pinned verb whose host is offline
// produces `unreachable` with a reason, never a redirect to a host that happens
// to be up — that would silently start a second, empty conversation under a
// name someone believes is their long-running one.

/** Verbs that must go to the host already holding the named session. */
// restore and purge are pinned for the same reason resume is, and harder: the
// conversation and the workspace are host-local volumes, so the only box that
// can bring a session back is the one still holding them. A restore that
// landed elsewhere would report success against nothing.
//
// THE FIVE WORKSPACE VERBS ARE PINNED TOO, and they were not. `files`,
// `readfile`, `writefile`, `copyfile` and `deletefile` each take a session
// `name` and act on that session's workspace, which is a host-local volume
// (docs/filesystem.md) — so they are session verbs by every test this file
// applies, and they were falling through to the NEW WORK path at the bottom.
// That path filters on free capacity, which produced two failures at once:
//
//   NOBODY CHECKED WHOSE SESSION IT WAS. The ownership check below is the only
//   one there is, and a verb that never reaches it is a verb with none. A
//   member could read another member's workspace by name, and `writefile`,
//   `copyfile` and `deletefile` are mutating — so it was not only a read.
//   `peek` and `logs <name>` were checked; the five verbs that hand back whole
//   FILES were not.
//
//   AND IT WENT TO THE WRONG BOX. Ranking by free capacity sends `files` to
//   whichever machine is least busy, which is the one machine guaranteed not
//   to be holding a session somebody else is using. On a one-host fleet that
//   is invisible, which is why this survived.
//
// Found by a tester probing their own fleet through MCP: a fabricated session
// name answered "that session has no workspace", and a REAL name belonging to
// somebody else got as far as trying to mount its container and failed on an
// unrelated runtime error. The access control never ran; a mount permission
// was doing its job.
//
// AND `answer`, which types a digit into a session's waiting prompt. It names
// a session as surely as `stop` does and had the same two failures: no
// ownership check, so a member could pick an option on somebody else's
// question by guessing its name, and a box chosen by free capacity rather
// than the one holding the session. The hub answers whatever it is sent and
// asks nobody whose prompt it is, so this check is the only one.
import { runsNoSessions } from './registry.js';
import { mayActFor, administers, runsSessionsFor } from './hosts.js';

const PINNED = new Set([
  'resume', 'stop', 'forget', 'peek', 'status', 'restore', 'purge', 'answer',
  'files', 'readfile', 'writefile', 'copyfile', 'deletefile',
]);

// PROFILES FANS OUT, and for the same reason `connect` does: the interesting
// part is where the hosts DISAGREE. A profile is a file on one box, so asking
// one machine what profiles exist answers with whatever that machine happens to
// have and hides the one a person is looking for. It also decides where work
// can go — `start { profile: 'x' }` is refused by a host without it — so a
// picker built from one host's answer sends people at the wrong machine.
//
// `secrets` fans out for exactly those reasons: a named secret is a file on one
// box, `start { secret: 'x' }` is refused by a host without it, and the picker
// has to know which machine holds which name.
/** Verbs answered by asking every host and merging. */
const FANOUT = new Set(['list', 'profiles', 'secrets']);

/** Why no machine may take an admin's hypervisor probe or setup. */
const NO_OWN_MACHINE =
  'No connected permanent machine is one of the fleet\u2019s own. A box a member enrolled acts only for them, ' +
  'and is sent nobody else\u2019s probe or setup.';

/** Verbs that carry, or act with, one person's credential. See `whose` in place(). */
const CREDENTIAL_VERBS = new Set(['connect', 'link', 'unlink', 'verify', 'setuptoken']);

/**
 * @typedef {object} Placement
 * @property {'host'|'fanout'|'refused'} kind
 * @property {import('./registry.js').HostEntry & {send: Function}} [host]
 * @property {Array<import('./registry.js').HostEntry & {send: Function}>} [hosts]
 * @property {string} [reason]
 * @property {string} [code]
 */

/**
 * The claims on a session name that the requester may act on: every one for
 * an admin or the break-glass token, and for a member only those their
 * verified identity created, as the registry attributes them (hosts.js
 * believedCreator). Asked before anything is counted or named.
 *
 * @param {import('./registry.js').HostRegistry} registry
 * @param {string} name
 * @param {{ email?: string|null, admin?: boolean }|null} requester
 */
function sessionsOf(registry, name, requester) {
  const claims = registry.findSessions(name);
  if (!requester || requester.admin) return claims;
  const mine = `fleet:${String(requester.email || '').toLowerCase()}`;
  return claims.filter((c) => String(c.createdBy || '').toLowerCase() === mine);
}

/**
 * @param {import('./registry.js').HostRegistry} registry
 * @param {{ verb: string, params?: Record<string, any> }} intent
 * @param {{ maxPinAgeMs?: number, preferHost?: string, preferLabels?: string[]|string|null, requester?: { email?: string|null, admin?: boolean }|null }} [opts]
 * @returns {Placement}
 */
export function place(registry, intent, { maxPinAgeMs = 120_000, preferHost = '', preferLabels = null, requester = null } = {}) {
  const verb = intent.verb;
  const name = intent.params?.name;

  // A CREDENTIAL GOES ONLY WHERE ITS PERSON'S CREDENTIALS MAY BE: an
  // operator's box, a box they enrolled, their own temporary machine (hosts.js
  // mayActFor). The fan-outs below went to every connected host, so a member's
  // pasted GitHub token reached a box another member enrolled with a pin they
  // minted, and that member's runner, while this same file refused to put the
  // first member's work there. SEC-HOST-1.
  //
  // Whose it is: the verified caller's. A caller with no identity, the OAuth
  // callback whose spent state proved the person or the break-glass token, is
  // filed under the actor it names, and naming nobody reaches the operator's
  // boxes alone.
  const whose = requester?.email || (typeof /** @type {any} */ (intent).actor === 'string' ? /** @type {any} */ (intent).actor : null);
  const credential = CREDENTIAL_VERBS.has(verb);
  if (credential && preferHost) {
    const named = registry.reachable().find((h) => h.hostId === preferHost);
    if (named && !mayActFor(named, whose)) {
      return {
        kind: 'refused',
        code: 'host_unavailable',
        reason: `${preferHost} does not hold credentials for you. It acts for the person who enrolled it, or asked for it, and nobody else.`,
      };
    }
  }
  /** The connected hosts this person's credentials may reach. */
  const holders = () => registry.reachable().filter((h) => mayActFor(h, whose));

  // `status` with no name is a fleet-wide question, not a session one, so it
  // fans out here, and for a member to the boxes that may act for them, by the
  // rule and for the reason `list` is below: it went to every box, and a box
  // that takes no work from them put its own words into their reply as the
  // fleet's (sixth audit).
  if (FANOUT.has(verb) || (verb === 'status' && !name)) {
    // reachable(), not schedulable(): see the comment on both in registry.js.
    // Asking every connected box what it has is a different question from
    // choosing one to start work on.
    //
    // A MEMBER'S PROFILES AND SECRETS ARE ASKED OF THE BOXES THAT ACT FOR
    // THEM (holders), and they were asked of every box. So a member's
    // question went, with their name on it, to a box another member enrolled,
    // and its profile names, their first lines and its secret names came back
    // merged into their picker: things on a machine that takes no start from
    // them, belonging to the one person it does (fifth Workers audit).
    //
    // AND `list` WITH THEM. It asked everywhere on the strength of dispatch
    // filtering its records and rewriting its prose, and the rewrite ran only
    // on a reply that carried records, so a box another member enrolled could
    // leave them out and write its own text into this member's listing, with
    // their name delivered to it on every ask (sixth audit). Nothing it says
    // could survive the filter anyway: every session it reports is filed under
    // the person it acts for (hosts.js believedCreator), so asking it hands
    // over the name and gets back nothing that is theirs.
    const scoped = Boolean(requester && !requester.admin);
    const hosts = scoped ? holders() : registry.reachable();
    if (!hosts.length) {
      return {
        kind: 'refused',
        code: 'no_hosts',
        reason: scoped && registry.reachable().length
          ? 'No connected machine acts for you. A box another member enrolled, or a temporary machine somebody else asked for, takes work only from them.'
          : describeWhyNoHosts(registry),
      };
    }
    // A BOX'S OWN NAMED SECRETS ARE ITS ADMINISTRATORS', so a member's
    // `secrets` asks only the boxes they administer. Its operator placed them,
    // and a session a member starts on an operator's box is served the
    // member's own vault secret of that name and never the box's (the host's
    // `boxSecrets` start param, set in core.js dispatch), so listing the box's
    // names to them offered a choice that could not be had. Possibly no box at
    // all, which core.js answers as an empty list: none is available to them,
    // and that is an answer rather than a refusal.
    if (verb === 'secrets' && scoped) return { kind: 'fanout', hosts: hosts.filter((h) => administers(h, requester)) };
    return { kind: 'fanout', hosts };
  }

  // LOGS GO TO ONE NAMED BOX.
  //
  // Not a fan-out: three journals merged into one stream is something nobody
  // can read. Not "new work" either, which is where an unhandled verb would
  // fall through — that path filters on free capacity, and a full box can
  // still answer questions about itself.
  //
  // With one host there is no choice to make. With several, asking is
  // ambiguous and picking one silently would be guessing at which box somebody
  // meant — so it refuses and names them, the same way an ambiguous session
  // name is refused rather than resolved by iteration order.
  // logs, update, upgrade and reboot are all questions about ONE BOX. None of
  // them is a fan-out (four journals, four apt runs and four reboots merged
  // into one reply is nobody's idea of an answer), and none belongs in the
  // new-work path, which filters on free capacity — a full box can still be
  // asked about itself, updated, or rebooted.
  // A TOKEN IS THE PERSON'S, NOT THE BOX'S — so linking one goes to EVERY
  // host they can reach, not to whichever box happened to be on screen.
  //
  // The first version pinned all three, and the screen it produced said
  // "Credentials on deb13-staging". That was an honest description of what the
  // code did and the wrong model: a GitHub token belongs to a person, and
  // having to connect it again on every box — and again on each box enrolled
  // later — is bookkeeping the fleet exists to remove.
  //
  // CLAUDE STAYS PINNED, and the difference is not a preference. Claude's flow
  // is an OAuth login the CLI drives in a PANE ON ONE BOX: `connect` starts it
  // there and `link` types the code into that same pane, so a second step
  // landing elsewhere would type a live credential into a box that never asked
  // for one. GitHub and Cloudflare have no such state — the token is minted on
  // the provider's page and the host only stores it — so the same paste is
  // correct on every box at once.
  // BARE `connect` FANS OUT TOO, and my reasoning for pinning it was wrong.
  //
  // I wrote that fanning out a question would mean "N copies of one answer,
  // and the catalogue is identical on every box anyway". The catalogue is. The
  // CONNECTED LIST IS NOT — it is per host, because a token reaches the hosts
  // that were reachable when it was pasted and a host enrolled later has none.
  //
  // So asking one box answers "do I have GitHub" with whatever that box knows,
  // and hides the only interesting case: the machine that is missing it. Which
  // is exactly the question somebody asks after adding a host.
  if (verb === 'connect' && !intent.params?.provider && !preferHost) {
    const hosts = holders();
    return hosts.length
      ? { kind: 'fanout', hosts }
      : { kind: 'refused', code: 'no_hosts', reason: describeWhyNoHolders(registry) };
  }

  // `verify` WITH THEM, for the same reason: the token is the person's, and
  // a Test sent to one arbitrary box answered "No GitHub token is stored
  // here" from the one machine the token never reached, under a row that
  // said "connected". Asked of every box, the answer comes from one that
  // holds it, and the rest say where it is absent.
  if (
    (verb === 'link' || verb === 'unlink' || verb === 'verify') &&
    intent.params?.provider &&
    intent.params.provider !== 'claude' &&
    // An explicitly named host still wins. Fanning out is the DEFAULT, not a
    // rule — somebody who says "this box" means it, and the placement
    // preference is the existing way to say so.
    !preferHost
  ) {
    const hosts = holders();
    return hosts.length
      ? { kind: 'fanout', hosts }
      : { kind: 'refused', code: 'no_hosts', reason: describeWhyNoHolders(registry) };
  }

  // connect/link/unlink join them, and for a stronger reason than the others:
  // the two halves of a connection are a PAIR. `connect` starts a login in a
  // pane on one box and `link` types the code into that same pane, so a second
  // step that landed elsewhere would type a live credential into a box that
  // never asked for one. Fanning them out would be worse still — one paste,
  // copied to every host in the fleet.
  // LOGS NAMING A SESSION IS A SESSION VERB, and has to be checked like one.
  //
  // `peek` is pinned and ownership-checked; `logs <name>` returns the same
  // session's output — the container's stderr, which outlives the pane — and
  // was routed as a plain one-box question, so `place()` never consulted the
  // requester at all. A member could read any other member's session by name,
  // through the verb that exists precisely because it survives the pane dying.
  //
  // The refusal is the SAME `unknown_session` the scheduler gives for a name
  // that does not exist, for the same reason it is byte-identical there: a
  // distinct "not yours" turns an access control into an existence oracle.
  if (verb === 'logs' && name && requester && !requester.admin) {
    if (!sessionsOf(registry, name, requester).length) {
      return {
        kind: 'refused',
        code: 'unknown_session',
        reason:
          `No host reports a session named "${name}". ` +
          'It may exist on a host that is currently offline — this is deliberately not ' +
          'redirected to another box, because a resume that lands on the wrong host starts ' +
          'an empty conversation under a name you believe is your long-running one.',
      };
    }
  }

  // ONE ADDRESSING RULE. `logs` does two jobs — a service journal, which is
  // per-box, and a SESSION's own output, which is not — and it was routed
  // entirely as the first. So `peek`, `stop` and `status` found a session by
  // name while `read_log` answered "Which box?" about the same session, and
  // both beta testers filed it: the product asking somebody to remember on its
  // behalf, when its siblings do not.
  //
  // With a name it is a session and resolves like one. Without a name it is a
  // journal and still needs a box, which is the question actually worth asking.
  if (verb === 'logs' && name) {
    // findSessions returns RECORDS, not hosts — each carries the host it was
    // found on. Reading them as hosts is the mistake the type checker caught.
    // A member's own claims only, as for the pinned verbs below: the refusal
    // names every host it counted.
    const claims = sessionsOf(registry, name, requester);
    if (claims.length === 1) return { kind: 'host', host: claims[0].host };
    if (claims.length > 1) {
      return {
        kind: 'refused',
        code: 'ambiguous_session',
        reason:
          `More than one host has a session called "${name}": ${claims.map((c) => c.host.hostId).join(', ')}. ` +
          'Name the host to say which.',
      };
    }
    // None found: fall through to the per-box path below, which explains why
    // rather than inventing a host — and a session the registry has not heard
    // of yet is a different problem from an ambiguous one.
  }

  // ASKING FOR A RUNNER GOES TO A BOX THAT CAN ASK FOR ONE.
  //
  // `provision` does not run work — it spends the ASKING PERSON'S GitHub token
  // to dispatch a workflow, and that token lives on a host they have connected
  // GitHub on. So this is a one-box question like `logs` or `update`, with two
  // differences that both come from what the box is being asked to do.
  //
  // NEVER A RUNNER. A temporary host has no connections, no renewal timer and
  // minutes to live; asking one to start another is a machine paid for by the
  // minute doing paperwork, and it fails with a message about GitHub not being
  // connected that would send somebody looking in the wrong place. Filtered out
  // rather than refused, because from here a runner is simply not one of the
  // boxes that can answer this.
  //
  // AND IT REFUSES RATHER THAN GUESSES when several could. Picking one would
  // pick whichever host the iterator reached first, and the answer to "why did
  // that say GitHub is not connected" would be "because it asked a different
  // machine from the one you connected it on" — which nobody can see from the
  // refusal. Naming them is what makes the second attempt work.
  //
  // `runnerrepo` is the same question asked before the dispatch rather than
  // during it — is this a repository my GitHub can start machines from — so it
  // goes where `provision` goes, for every reason above. And `linkrepo` is
  // that question for any role of a linked repository, asked with the same
  // connection, so it goes there too.
  // A CLAUDE TOKEN IS MADE ON THE MACHINE YOU PICKED, and both halves go there.
  //
  // `setuptoken` starts `claude setup-token` in a pane and then types the code
  // into THAT pane, so the second half landing on another box would type a
  // code into a machine that never asked for one: pinned, like a Claude
  // `connect`. Not new work either, so a full box can still make one; the
  // capacity filter below is for sessions.
  //
  // ONLY A MACHINE THAT MAY HOLD THE PERSON'S CREDENTIALS, their own runner
  // included. This said any connected machine would do because the token goes
  // back sealed to the phone, and the seal protects it only after it leaves:
  // the token is in the clear in the pane and the hub's memory first, so a box
  // another member enrolled, where that member has root, could make a
  // member's year-long Claude token. It is a credential verb, so the named
  // host is refused at the top of this function like a Claude `connect`.
  if (verb === 'setuptoken') {
    const hosts = holders();
    if (!hosts.length) return { kind: 'refused', code: 'no_hosts', reason: describeWhyNoHolders(registry) };
    if (preferHost) {
      const chosen = hosts.find((h) => h.hostId === preferHost);
      return chosen
        ? { kind: 'host', host: chosen }
        : {
            kind: 'refused',
            code: 'host_unavailable',
            reason: `${preferHost} is not connected. These are: ${hosts.map((h) => h.hostId).join(', ')}.`,
          };
    }
    if (hosts.length === 1) return { kind: 'host', host: hosts[0] };
    return {
      kind: 'refused',
      code: 'ambiguous_host',
      reason:
        `Which machine should make it? ${hosts.map((h) => h.hostId).join(', ')}. ` +
        'The sign-in page comes from one machine and the code goes back to that same one.',
    };
  }

  // CAN YOU REACH IT is asked of every permanent machine, because the answer
  // differs by machine and the point is to find the ones that can. A runner is
  // left out: it is on somebody else's network for a few hours and can reach
  // nothing on yours. docs/hypervisors.md.
  //
  // AND ONLY A MACHINE THAT MAY ACT FOR WHOEVER ASKED (hosts.js mayActFor),
  // which for an admin is the fleet's own, for the probe and for the setup
  // below. A box a member enrolled was sent the admin's probe, answered it in
  // its own words onto the app's list, and was taken for `begin` when named or
  // when it was the only permanent box; the job's `run` then carried the
  // admin's sealed Xen Orchestra sign-in to it, to be opened where that member
  // has root. SEC-HOST-1.
  if (verb === 'xoprobe') {
    const permanent = registry.reachable().filter((h) => !h.ephemeral);
    const durable = permanent.filter((h) => mayActFor(h, whose));
    return durable.length
      ? { kind: 'fanout', hosts: durable }
      : { kind: 'refused', code: 'no_hosts', reason: permanent.length ? NO_OWN_MACHINE : describeWhyNoHosts(registry) };
  }

  // ONBOARDING RUNS ON THE MACHINE THAT WAS CHOSEN, and every phase of one job
  // goes back to it: the key `begin` made lives only in that machine's memory,
  // so a `run` anywhere else would hand a sealed sign-in to a box that cannot
  // open it. core.js fills the preference from the job for every phase after
  // the first, so only `begin` ever needs a person to choose. Not new work, so
  // a full machine can still do it.
  if (verb === 'xosetup') {
    const permanent = registry.reachable().filter((h) => !h.ephemeral);
    const durable = permanent.filter((h) => mayActFor(h, whose));
    if (!durable.length) {
      return { kind: 'refused', code: 'no_hosts', reason: permanent.length ? NO_OWN_MACHINE : describeWhyNoHosts(registry) };
    }
    if (preferHost) {
      const chosen = durable.find((h) => h.hostId === preferHost);
      return chosen
        ? { kind: 'host', host: chosen }
        : {
            kind: 'refused',
            code: 'host_unavailable',
            reason: permanent.some((h) => h.hostId === preferHost)
              ? `${preferHost} acts for the person who enrolled it, and runs nobody else\u2019s setup.`
              : `${preferHost} is not a connected permanent machine. These are: ${durable.map((h) => h.hostId).join(', ')}.`,
          };
    }
    if (durable.length === 1) return { kind: 'host', host: durable[0] };
    return {
      kind: 'refused',
      code: 'ambiguous_host',
      reason:
        `Which machine should run the setup? ${durable.map((h) => h.hostId).join(', ')}. ` +
        'Ask xoprobe first: it says which of them can reach the address.',
    };
  }

  // ONLY BOXES THAT MAY ACT FOR THE PERSON, for all three: each spends their
  // GitHub connection, and `provision` hands the box a ticket that admits a
  // machine as theirs. A box another member enrolled answered a member's
  // runner-repository check with a repository of its own choosing, and was
  // handed the runner ticket for it (core.js #askEachBox).
  if (verb === 'provision' || verb === 'runnerrepo' || verb === 'linkrepo') {
    const permanent = registry.reachable().filter((h) => !h.ephemeral);
    const durable = permanent.filter((h) => mayActFor(h, whose));
    if (!durable.length) {
      return {
        kind: 'refused',
        code: 'no_hosts',
        reason: permanent.length
          ? describeWhyNoHolders(registry)
          : verb === 'linkrepo'
            ? `${describeWhyNoHosts(registry)} A repository is checked with your GitHub connection on a permanent ` +
              'host, and this fleet has none to ask.'
            : `${describeWhyNoHosts(registry)} A runner is dispatched BY a permanent host, using the GitHub ` +
              'connection stored there — so a fleet with no permanent host has nothing to ask.',
      };
    }
    if (preferHost) {
      const chosen = durable.find((h) => h.hostId === preferHost);
      return chosen
        ? { kind: 'host', host: chosen }
        : {
            kind: 'refused',
            code: 'host_unavailable',
            reason: permanent.some((h) => h.hostId === preferHost)
              ? `${preferHost} does not act for you. It acts for the person who enrolled it, and nobody else.`
              : `${preferHost} is not a connected permanent host. These are: ${durable.map((h) => h.hostId).join(', ')}.`,
          };
    }
    if (durable.length === 1) return { kind: 'host', host: durable[0] };
    return {
      kind: 'refused',
      code: 'ambiguous_host',
      reason:
        `Which box should ask for it? ${durable.map((h) => h.hostId).join(', ')}. ` +
        'It is dispatched with your GitHub connection, so name the host you connected GitHub on.',
    };
  }

  // A SETTING IS NOT NEW WORK, and `channel` has been routed as though it were
  // since the day it shipped.
  //
  // These three change what a box IS — which releases it takes, which image its
  // sessions run in, what work aimed at a tag finds here. None of them starts
  // anything, so falling through to the new-work path below was wrong twice
  // over, and both halves were reachable from a phone:
  //
  //   A FULL BOX COULD NOT BE CONFIGURED AT ALL. That path filters on
  //   `schedulable()`, which drops any host with no free capacity — so the
  //   answer to "change this box's channel" on a busy machine was "it is
  //   healthy: undefined", produced by a capacity check that has no business
  //   being consulted about a setting.
  //
  //   AND `tag` SILENTLY PICKED ONE. It ranked the matching hosts by free
  //   capacity and round-robined between them, so `channel { to } + tag: prod`
  //   moved ONE production box and reported success. Nothing said which.
  //
  // So they are grouped with `update`, `upgrade` and `reboot` — questions about
  // one box, answered by a box whether or not it is busy — and `tag` FANS OUT
  // rather than choosing. Fanning out is what makes "every box with this label"
  // expressible, which is the whole reason placement travels beside the intent:
  // `host` says which one, `tag` says which ones, and neither is a parameter
  // any host had to learn.
  //
  // Mutating fan-out is not new here — `link` and `unlink` already do it, and
  // core.js mints per-host idempotency ids for exactly this.
  const setting = verb === 'channel' || verb === 'sandbox' || verb === 'labels';
  if (
    setting ||
    verb === 'logs' ||
    verb === 'update' ||
    verb === 'upgrade' ||
    verb === 'reboot' ||
    verb === 'connect' ||
    verb === 'link' ||
    verb === 'unlink'
  ) {
    // A Claude login is a credential too, and one box is still a choice of box.
    //
    // A SERVICE JOURNAL IS EVERYBODY'S WORK ON THE BOX. The sidecar writes
    // each intent into it with its actor, so it names other members, their
    // sessions, the secret and archive each start used and the files each
    // touched, and any member could read it from any box while `list`, `logs
    // <name>` and nameless `status` were all scoped to them. An admin and the
    // break-glass token read any box's; a member only a box that acts for
    // them alone, which holds nobody's work but theirs (hosts.js mayActFor). A
    // member's `logs <name>` never gets this far: it resolved to their own
    // session above, or was refused there.
    //
    // AND A BOX IS ADMINISTERED BY THE SAME TWO PEOPLE, for the same reason:
    // what it changes is everybody's work on the box. A reboot's first step
    // names every running session on it, whoever's, and its second ends them,
    // which is the stop this file refuses a member on anybody else's session;
    // `sandbox` changes the image everybody's next session runs in, `channel`
    // and `update` what code runs everybody's work, `upgrade` the system under
    // it, and `labels` where other people's tag-placed work lands. Each went to
    // any connected box a member named, the operator's included, and a tag
    // fanned the settings out to every box carrying it (sixth audit). A member
    // still administers a box that acts for them alone, which holds nobody's
    // work but theirs; the admin and the break-glass token, any box. The rule
    // is hosts.js administers, which the snapshot reads too, so a phone draws
    // these controls exactly where this lets them through.
    const journal = verb === 'logs' && Boolean(requester) && !requester?.admin;
    const administer =
      (setting || verb === 'update' || verb === 'upgrade' || verb === 'reboot') && Boolean(requester) && !requester?.admin;
    const ownOnly = journal || administer;
    const reachable = credential
      ? holders()
      : ownOnly
        ? registry.reachable().filter((h) => administers(h, requester))
        : registry.reachable();
    if (ownOnly && registry.reachable().length && (!reachable.length || (preferHost && !reachable.some((h) => h.hostId === preferHost)))) {
      return {
        kind: 'refused',
        code: 'not_admin',
        reason: journal
          ? 'A box\u2019s service journal records everybody\u2019s work on it, so only this fleet\u2019s admin, ' +
            'or the one person a box acts for, can read it.'
          : 'A box\u2019s settings, updates and reboots reach everybody\u2019s work on it, so only this fleet\u2019s admin, ' +
            'or the one person a box acts for, can change, update or reboot it.',
      };
    }
    if (!reachable.length) {
      return { kind: 'refused', code: 'no_hosts', reason: credential ? describeWhyNoHolders(registry) : describeWhyNoHosts(registry) };
    }
    if (preferHost) {
      const chosen = reachable.find((h) => h.hostId === preferHost);
      return chosen
        ? { kind: 'host', host: chosen }
        : {
            kind: 'refused',
            code: 'host_unavailable',
            reason: `${preferHost} is not connected. Reachable: ${reachable.map((h) => h.hostId).join(', ')}.`,
          };
    }
    // EVERY BOX CARRYING THE LABEL, for a setting. A tag on a reboot or an
    // upgrade is deliberately NOT this: "reboot everything labelled prod" is a
    // fleet-wide outage expressible in one line, and the refusal below names
    // the boxes instead so somebody says which one out loud.
    const wanted = setting ? normaliseLabels(preferLabels) : [];
    if (wanted.length) {
      const matching = reachable.filter((h) => wanted.every((l) => (h.health?.labels || []).includes(l)));
      if (!matching.length) {
        const seen = [...new Set(reachable.flatMap((h) => h.health?.labels || []))].sort();
        return {
          kind: 'refused',
          code: 'no_host_matches',
          reason:
            `No connected host carries every tag: ${wanted.join(', ')}. ` +
            (seen.length ? `Tags in this fleet: ${seen.join(', ')}.` : 'No host reports any tags at all.'),
        };
      }
      return { kind: 'fanout', hosts: matching };
    }
    if (reachable.length === 1) return { kind: 'host', host: reachable[0] };
    return {
      kind: 'refused',
      code: 'ambiguous_host',
      reason: `Which box? ${reachable.map((h) => h.hostId).join(', ')}.`,
    };
  }

  if (PINNED.has(verb)) {
    // A MEMBER CHOOSES ONLY AMONG THEIR OWN. Every claim on the name was
    // counted, whoever's, and the ambiguity refusal below ran before the
    // ownership check further down: so any member's peek of a name two other
    // people share was answered with the hosts holding it, and a box a member
    // enrolled claiming the name of somebody's real session made their stop
    // on it ambiguous. Narrowed first, another person's session is not a
    // claim at all, for this as for the unknown_session refusal.
    const claims = name ? sessionsOf(registry, name, requester) : [];
    // MORE THAN ONE BOX CLAIMS IT. Refuse, and name them both.
    //
    // findSession() returned the first match in Map order, so `stop bigjob`
    // picked whichever host the iterator reached first and killed it with no
    // sign a choice had been made. Everything else in this file refuses rather
    // than guesses — a stale placement, an offline host, an unknown name — for
    // the same reason, and this was the one gap in it.
    if (claims.length > 1) {
      return {
        kind: 'refused',
        code: 'ambiguous_session',
        reason:
          `"${name}" exists on ${claims.map((c) => c.host.hostId).join(' and ')}. ` +
          'Refusing rather than picking one: a stop that lands on the wrong box is not ' +
          'recoverable by trying again. Rename one, or stop it from the box itself.',
      };
    }
    // OWNERSHIP, checked before anything is revealed (sessionsOf). A member
    // may act only on sessions their verified identity created; unattributed
    // sessions belong to the fleet, exactly as in the visibility filter one
    // layer down.
    //
    // The refusal is BYTE-IDENTICAL to unknown_session, deliberately. A
    // distinct "not yours" answer would confirm to a member that a guessed
    // name exists on somebody else's work — an existence oracle built out of
    // an access control. To a member, a session they cannot touch and a
    // session that does not exist must be the same fact.
    const found = claims[0] || null;
    if (!found) {
      return {
        kind: 'refused',
        code: 'unknown_session',
        reason:
          `No host reports a session named "${name}". ` +
          'It may exist on a host that is currently offline — this is deliberately not ' +
          'redirected to another box, because a resume that lands on the wrong host starts ' +
          'an empty conversation under a name you believe is your long-running one.',
      };
    }
    const host = /** @type {any} */ (registry.get(found.host.hostId));
    if (!host?.connected) {
      return {
        kind: 'refused',
        code: 'host_unreachable',
        reason: `"${name}" lives on ${found.host.hostId}, which is ${found.host.state}: ${found.host.reason}`,
      };
    }
    // A RESUME RUNS THE SESSION AGAIN, so it is held to the rule a start is:
    // on a box whose sessions are not sandboxed, or that has not said, only
    // someone who administers it (hosts.js runsSessionsFor). The session's
    // owner still reaches it with stop, forget and the rest, which run
    // nothing of theirs there (G8).
    if (verb === 'resume' && !runsSessionsFor(host, requester)) return unsandboxed([host], verb);
    if (found.ageMs > maxPinAgeMs && found.busy) {
      // BUSY, NOT GONE. The box is connected and says its session manager is
      // not answering; the session was there when it last could say. Sending
      // the verb would only wait out the box's silence, and "No host reports"
      // — what this said before — was not true.
      return {
        kind: 'refused',
        code: 'host_busy',
        reason:
          `"${name}" is on ${found.host.hostId}, which is connected but too busy to answer — ` +
          `${found.host.reason}. It last listed its sessions ${Math.round(found.ageMs / 1000)}s ago. ` +
          'The session is most likely still working; ask again in a minute.',
      };
    }
    if (found.ageMs > maxPinAgeMs) {
      // We know where it WAS. Acting on a claim this old is guessing.
      return {
        kind: 'refused',
        code: 'stale_placement',
        reason:
          `The last report placing "${name}" on ${found.host.hostId} is ` +
          `${Math.round(found.ageMs / 1000)}s old, which is too stale to act on.`,
      };
    }
    return { kind: 'host', host };
  }

  // A NEW SESSION UNDER A NAME SOMEBODY ELSE HOLDS IS NOT NEW. `start` is new
  // work and never asked who held its name, and a box refused only a name
  // that was running, binned or starting. So a member could start another
  // member's STOPPED session by name on a box that acts for both: the box
  // reused its workspace and Claude config volumes, keyed by name, on its
  // owner's Claude account, and rewrote its creator to the starter, who then
  // had its pinned verbs while its owner was told it did not exist. A member
  // may not take a name another person's claim holds ON THE BOX THAT WOULD
  // TAKE THE START (an unattributed claim is the fleet's), and the words are
  // the same whatever holds it, so the refusal does not say whose. Their own
  // stopped session is for `resume`, which the box says when asked to start
  // it.
  //
  // ONLY THERE, which is the one place the takeover can happen: the volumes
  // are the box's own. This was asked of every claim on every box before
  // placement chose anything, so a start naming a host that does not exist
  // answered name_unavailable for a name somebody held and host_unavailable
  // for one nobody did, an existence oracle out of the access control the
  // pinned verbs above are careful not to build. And a box a member enrolled,
  // which takes nobody else's start, reserved every name it reported for the
  // whole fleet (fifth Workers audit). Asked below, of the box named and of
  // the boxes that could be chosen.
  const takenOn = (/** @type {import('./registry.js').HostEntry} */ h) => {
    if (verb !== 'start' || !name || !requester || requester.admin) return false;
    const mine = `fleet:${String(requester.email || '').toLowerCase()}`;
    return registry.findSessions(name).some((c) => c.host.hostId === h.hostId && String(c.createdBy || '').toLowerCase() !== mine);
  };
  const nameUnavailable = /** @type {Placement} */ ({
    kind: 'refused',
    code: 'name_unavailable',
    reason: `"${name}" cannot be used for a new session. Pick another name.`,
  });

  // --- new work: filter, rank, tie-break ------------------------------------
  // THE POOL'S OWN MACHINE, named: refused as what it is, before anything
  // about the rest of the fleet (registry.js, runsNoSessions).
  if (preferHost && runsNoSessions(preferHost)) {
    return {
      kind: 'refused',
      code: 'host_unavailable',
      reason: `${preferHost} is a pool's own machine. It holds the pool for the fleet and runs no sessions.`,
    };
  }
  const candidates = registry.schedulable();
  if (!candidates.length) {
    return { kind: 'refused', code: 'no_hosts', reason: describeWhyNoHosts(registry) };
  }

  // NEW WORK GOES ONLY TO A MACHINE THAT ACTS FOR THE PERSON: an operator's
  // box, a box they enrolled, their own runner (hosts.js mayActFor), the same
  // set their credentials reach and by the same `whose`, so an admin is held to
  // it like anybody and the break-glass token reaches the operator's boxes. This
  // ranked every healthy box by the free slots it reported, so a box another
  // member enrolled, reporting the most room, took everybody's unnamed starts:
  // the task, the actor and the archive's name on a machine where that member
  // has root. Naming it worked too. SEC-HOST-1.
  //
  // `health` and `updates` were let through for anybody, as questions about
  // one box that hand it nothing of the asker's. They hand it the asker's
  // email, which members do not see of each other, and the box writes the
  // reply: an unnamed one went to whichever box reported the most free slots,
  // which a member's own box reports for itself, so it answered every other
  // member's question in its own words (seventh audit, the sixth's rule for
  // list and status). An admin and the break-glass token may still ask any box.
  const anyBox = (verb === 'health' || verb === 'updates') && !(requester && !requester.admin);
  const actsForThem = anyBox
    ? () => true
    : (/** @type {import('./registry.js').HostEntry} */ h) => mayActFor(h, whose);

  // A host the caller CHOSE. A preference, not a parameter: it rides beside
  // the intent and never inside it, because `start` deliberately takes no host
  // — the protocol cannot express "run this THERE", only the coordinator can
  // decide it, and this is the caller weighing in on that decision.
  //
  // It applies to new work only. Pinned verbs go where the session lives —
  // a preference cannot move a resume off the box that holds its volume — and
  // fan-out reads go everywhere by definition.
  //
  // Refusals name the actual obstacle. "deb132: claude is not logged in" sends
  // somebody to fix the box; "no host matches" sends them to stare at a picker
  // that looked perfectly healthy when they used it.
  if (preferHost) {
    const chosen = candidates.find((h) => h.hostId === preferHost);
    if (!chosen) {
      const known = registry.list().find((h) => h.hostId === preferHost);
      // A TEMPORARY HOST THAT DROPPED is not unknown: it was here a minute
      // ago, its key is still good, and a runner starved by its own build
      // dials back. "Not a host this fleet knows" sent the caller to look for
      // a typo in a name they had just used.
      const dropped = known ? null : registry.recentlyDropped?.(preferHost);
      return {
        kind: 'refused',
        code: 'host_unavailable',
        reason: known
          ? `${preferHost} is ${known.state}: ${known.reason}`
          : dropped
            ? `${preferHost} dropped its connection ${Math.round(dropped.ageMs / 1000)}s ago (${dropped.reason}) and has not dialled back. ` +
              'A temporary host keeps its key and usually returns; ask again in a minute.'
            : `${preferHost} is not a host this fleet knows.`,
      };
    }
    // SOMEBODY ELSE'S TEMPORARY MACHINE IS NOT YOURS BY NAMING IT. The rule
    // below (`usable`) filtered other people's runners out of placement by
    // capacity and nowhere else, so naming one put work on it: a member who
    // read a runner's id off the host list could start a session on a machine
    // that exists for somebody else's job and bills them. Said as the host
    // being unavailable to them, which is what it is.
    if (chosen.ephemeral && chosen.owner && chosen.owner !== requester?.email) {
      return {
        kind: 'refused',
        code: 'host_unavailable',
        reason: `${preferHost} is a temporary machine somebody else asked for. It takes work only from them.`,
      };
    }
    if (!actsForThem(chosen)) {
      return {
        kind: 'refused',
        code: 'host_unavailable',
        reason: `${preferHost} acts for the person who enrolled it, and takes work only from them.`,
      };
    }
    if (verb === 'start' && !runsSessionsFor(chosen, requester)) return unsandboxed([chosen], verb);
    if (takenOn(chosen)) return nameUnavailable;
    if ((chosen.health?.free ?? 0) <= 0) {
      return {
        kind: 'refused',
        code: 'at_capacity',
        reason: `${preferHost} is full: ${chosen.health?.running}/${chosen.health?.maxSessions} sessions.`,
      };
    }
    return { kind: 'host', host: chosen };
  }

  // TAGS TRAVEL BESIDE THE INTENT, NOT INSIDE IT.
  //
  // This used to read `intent.params.labels` — and no verb declares a `labels`
  // parameter, so validateIntent refused it as `bad_params` and this filter was
  // unreachable. Built, correct, and impossible to call.
  //
  // It cannot become a parameter either: adding one to an existing verb is a
  // FLAG DAY (docs/intents.md — an old host answers bad_params AFTER the
  // version handshake agreed, which is the worst-shaped failure this protocol
  // has). Placement is not part of the intent anyway; `host` has always
  // travelled this way, and a tag is the same kind of thing — a statement about
  // WHERE, not about what to do.
  const required = normaliseLabels(preferLabels);
  const matching = required.length
    ? candidates.filter((h) => required.every((l) => (h.health?.labels || []).includes(l)))
    : candidates;
  if (!matching.length) {
    // Names what IS available. "No host carries macos" leaves somebody
    // guessing whether they typed it wrong or the fleet simply has no Mac.
    const seen = [...new Set(candidates.flatMap((h) => h.health?.labels || []))].sort();
    return {
      kind: 'refused',
      code: 'no_host_matches',
      reason:
        `No connected host carries every tag: ${required.join(', ')}. ` +
        (seen.length
          ? `Tags in this fleet: ${seen.join(', ')}.`
          : 'No host reports any tags at all, so tag routing cannot match anything here — a host gets its ' +
            'tags from FLEETWRIGHT_LABELS in its sidecar config, and none of these have any set.'),
    };
  }

  // EPHEMERAL HOSTS ARE OPT-IN, NEVER A DEFAULT TARGET.
  //
  // A CI runner is a host that is about to disappear. Placing ordinary work on
  // one by capacity — which it has plenty of, being empty — would start a
  // session on a box that will be gone in minutes, taking the conversation and
  // the workspace with it. The scheduler cannot know that; the enrolment does.
  //
  // Reachable for reads, listable, addressable BY NAME through the placement
  // preference. Just never chosen for you.
  // AN EPHEMERAL HOST BELONGS TO ONE PERSON. Several people may want a runner
  // at once, and they are not interchangeable: each one exists because somebody
  // asked for it, for their job, and costs them money while it lives. Somebody
  // else's runner is not spare capacity — it is a machine that will vanish when
  // a job they cannot see finishes.
  //
  // Filtered rather than refused, because from this person's point of view the
  // host is simply not one of theirs. Admins see every host for reads; placing
  // work is still per-owner, because "can see it" and "should have work put on
  // it" are different questions.
  const usable = matching.filter((h) => (!h.ephemeral || !h.owner || h.owner === requester?.email) && actsForThem(h));
  // Matched, but none of them are this person's to use. Without this the next
  // check reports `at_capacity` — which is both wrong and unactionable: the
  // host is empty, and the reason it cannot be used has nothing to do with how
  // full it is.
  if (matching.length && !usable.length) {
    return {
      kind: 'refused',
      code: 'no_hosts',
      reason: matching.every((h) => h.ephemeral)
        ? 'The only hosts that match are temporary ones belonging to somebody else. ' +
          'A runner exists for one person\'s job and disappears when it ends, so it is not spare capacity. ' +
          'Start your own, or use a permanent host.'
        // Not named, for the same reason their sessions are not.
        : 'No machine that acts for you has room for this. A box another member enrolled takes work only ' +
          'from them, and a runner only from the person who asked for it.',
    };
  }
  // A MEMBER'S START GOES ONLY WHERE ITS SESSION IS CONTAINED (hosts.js
  // runsSessionsFor): a box that runs sessions directly is left out for
  // anybody who does not administer it, and so is one that has not said. Left
  // out rather than refused while somewhere else will do, so `tag: linux`
  // finds the sandboxed Linux box instead of landing on the direct one; and
  // when nowhere else will, refused with every box named, because the answer
  // is a setting on those boxes and not a fault in the request (G8).
  const contained = verb === 'start' ? usable.filter((h) => runsSessionsFor(h, requester)) : usable;
  if (usable.length && !contained.length) return unsandboxed(usable, verb);
  // Not a box holding somebody else's claim on the name (takenOn, above), and
  // when every box that acts for them holds one, the name is taken everywhere
  // this start could go.
  const open = contained.filter((h) => !takenOn(h));
  if (!open.length) return nameUnavailable;

  const durable = open.filter((h) => !h.ephemeral);
  if (!durable.length && open.length) {
    // OFFERED, NOT CHOSEN, and the difference is the whole rule. A runner has
    // the most free capacity in the fleet because it is empty and about to
    // disappear; picking it by capacity would put work on a machine that takes
    // the work with it. So it is named, and somebody decides.
    return {
      kind: 'refused',
      code: 'only_ephemeral_hosts',
      reason:
        `${required.length ? `Nothing durable carries ${required.join(', ')}. ` : ''}` +
        `The only hosts that match are temporary: ${open.map((h) => h.hostId).join(', ')}. ` +
        'Name one explicitly to use it — work started there is lost when it goes.',
    };
  }

  const withRoom = durable.filter((h) => (h.health?.free ?? 0) > 0);
  if (!withRoom.length) {
    return {
      kind: 'refused',
      code: 'at_capacity',
      reason: open
        .map((h) => `${h.hostId} ${h.health?.running}/${h.health?.maxSessions}`)
        .join(', '),
    };
  }

  // Most free slots first; then lowest 1-minute load, because two boxes with
  // the same free count are not equally able to take work; then round robin so
  // a genuine tie does not always land on whichever sorted first.
  const ranked = [...withRoom].sort((a, b) => {
    const free = (b.health?.free ?? 0) - (a.health?.free ?? 0);
    if (free !== 0) return free;
    return (a.health?.loadavg?.[0] ?? 0) - (b.health?.loadavg?.[0] ?? 0);
  });
  const best = ranked.filter(
    (h) =>
      (h.health?.free ?? 0) === (ranked[0].health?.free ?? 0) &&
      (h.health?.loadavg?.[0] ?? 0) === (ranked[0].health?.loadavg?.[0] ?? 0),
  );
  return { kind: 'host', host: best[registry.nextCursor() % best.length] };
}

/**
 * Why there was nowhere to send it — with the per-host reason attached, because
 * "no hosts available" on its own tells an operator nothing about whether the
 * box is down, unreachable, or merely not logged in.
 * @param {import('./registry.js').HostRegistry} registry
 */
function describeWhyNoHosts(registry) {
  const all = registry.list();
  if (!all.length) return 'No host has ever connected to this coordinator.';
  return all.map((h) => `${h.hostId}: ${h.state} (${h.reason})`).join('; ');
}

/**
 * Why no host may hold this person's credentials. Connected boxes that act for
 * somebody else are not named, for the same reason their sessions are not.
 * @param {import('./registry.js').HostRegistry} registry
 */
function describeWhyNoHolders(registry) {
  if (!registry.reachable().length) return describeWhyNoHosts(registry);
  return 'No connected host holds credentials for you. A box another member enrolled, or a temporary machine somebody else asked for, acts only for them.';
}

/**
 * Why a box does not contain a session, by the code it sends beside
 * `sandboxed: false` (`sandboxedWhy`, http.js #hostFacts), and what opens it.
 *
 * THE SANDBOX BEING OFF IS ONE REASON OF SEVERAL. A box can have
 * FLEETWRIGHT_SANDBOX=1 and still not contain a session: run as root, its
 * sandbox shares the machine's user namespace (config.js resolveUserns), so
 * root in a session is root on the box. This said "Turning its sandbox on
 * opens it" to that box, which had it on, and gave the member and the
 * operator nothing true to do. So each reason the box can name has its own
 * clause and its own fix, and the sentence says only what the box said.
 *
 * `off` reads as this always did, and so does a box that sends no code at
 * all: a hub from before the code reported false only with the sandbox off
 * or opened by FLEETWRIGHT_SANDBOX_ARGS, and off is by far the commoner. A
 * code this coordinator does not know is not guessed at (C-5): the box said
 * not contained, and that is all that is repeated. The phones carry the same
 * clauses and the same fixes (Fleet.swift and Fleet.kt, `resumeKept`).
 */
const NOT_CONTAINED = {
  off: {
    why: 'runs sessions without the sandbox, as the account that holds everyone\u2019s credentials on it',
    short: 'runs sessions without the sandbox',
    fix: 'Turning its sandbox on (FLEETWRIGHT_SANDBOX=1)',
  },
  unsafe_args: {
    why: 'lets an option in FLEETWRIGHT_SANDBOX_ARGS end its sandbox',
    short: 'lets FLEETWRIGHT_SANDBOX_ARGS end its sandbox',
    fix: 'Taking that option out',
  },
  userns_root: {
    why: 'runs fleetwright as root, and root in a session is root on the machine',
    short: 'runs fleetwright as root',
    fix: 'Running fleetwright as its own user, not root,',
  },
  userns_docker: {
    why: 'runs its sandbox with docker, which does not keep root in a session apart from the account that holds everyone\u2019s credentials',
    short: 'runs its sandbox with docker',
    fix: 'Running its sessions under podman',
  },
  userns_host: {
    why: 'has FLEETWRIGHT_SANDBOX_USERNS=host, which makes root in a session the account that holds everyone\u2019s credentials',
    short: 'has FLEETWRIGHT_SANDBOX_USERNS=host',
    fix: 'Setting that back to nomap',
  },
};

/**
 * What one box said about itself, as `NOT_CONTAINED` reads it: a known
 * reason, or `false` with no code (a hub from before it, read as `off`), or
 * a code this coordinator does not know (null).
 *
 * @param {import('./registry.js').HostEntry} h
 */
function notContained(h) {
  const why = h.health?.sandboxedWhy;
  if (why === undefined || why === null) return NOT_CONTAINED.off;
  return Object.hasOwn(NOT_CONTAINED, String(why)) ? NOT_CONTAINED[/** @type {keyof typeof NOT_CONTAINED} */ (String(why))] : null;
}

/**
 * Why a member's session will not go on these boxes: each does not contain
 * one, or has not said whether it does (hosts.js runsSessionsFor). Every box
 * is named, because they are the fleet's own and acting for anyone is what
 * put them here, and the way on is a setting on them that a person can
 * change, named from what the box said (NOT_CONTAINED).
 *
 * @param {Array<import('./registry.js').HostEntry>} hosts
 * @param {string} verb  `start` or `resume`
 * @returns {Placement}
 */
function unsandboxed(hosts, verb) {
  const doing = verb === 'resume' ? 'resume a session' : 'start work';
  if (hosts.length === 1) {
    const [h] = hosts;
    if (h.health?.sandboxed !== false) {
      return {
        kind: 'refused',
        code: 'unsandboxed',
        reason:
          `${h.hostId} has not said whether its sessions are sandboxed \u2014 it is older than that report \u2014 ` +
          `so it is treated as running them without one, and only this fleet\u2019s admin can ${doing} there ` +
          'until it is updated.',
      };
    }
    const said = notContained(h);
    return {
      kind: 'refused',
      code: 'unsandboxed',
      reason: said
        ? `${h.hostId} ${said.why}, so only this fleet\u2019s admin can ${doing} there. ${said.fix} opens it to everyone it acts for.`
        : `${h.hostId} says its sessions are not contained, so only this fleet\u2019s admin can ${doing} there.`,
    };
  }
  // EVERY BOX IN TODAY'S SENTENCE while that sentence is true of each: off,
  // or not said. Once one names another reason, "turning a box's sandbox on"
  // is no longer the way on for all of them, so each is named with what it
  // said, and naming one gets its own fix (the one-box sentence above).
  const plain = hosts.every((h) => h.health?.sandboxed !== false || notContained(h) === NOT_CONTAINED.off);
  if (plain) {
    return {
      kind: 'refused',
      code: 'unsandboxed',
      reason:
        `Every machine that could take this runs sessions without the sandbox, or has not said whether it does: ` +
        `${hosts.map((h) => h.hostId).join(', ')}. Only this fleet\u2019s admin can ${doing} on those. Turning a ` +
        'box\u2019s sandbox on (FLEETWRIGHT_SANDBOX=1), or updating one that has not said, opens it to everyone it acts for.',
    };
  }
  const each = hosts.map((h) => {
    if (h.health?.sandboxed !== false) return `${h.hostId} has not said whether it is sandboxed`;
    return `${h.hostId} ${notContained(h)?.short ?? 'says its sessions are not contained'}`;
  });
  return {
    kind: 'refused',
    code: 'unsandboxed',
    reason:
      `No machine that could take this would contain a member\u2019s session: ${each.join('; ')}. ` +
      `Only this fleet\u2019s admin can ${doing} on those; naming one says what would open it to everyone it acts for.`,
  };
}

/** @param {unknown} value */
function normaliseLabels(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
