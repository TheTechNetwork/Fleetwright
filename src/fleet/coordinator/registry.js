
// The coordinator's view of the fleet.
//
// THE RULE THIS FILE EXISTS TO ENFORCE (design.md §3):
//
//   The coordinator's registry is a CACHE WITH PROVENANCE, never the authority.
//   Each host stays the sole authority on its own tmux.
//
// fleetwright's whole simplification was collapsing a two-plane design — a queue
// plus a heartbeat protocol plus a stale-row reaper — into one process that
// asks tmux directly, every time. Multi-host reintroduces that split
// unavoidably. What is avoidable is *believing* the cache: the moment this
// registry is treated as truth, we have rebuilt the exact failure already paid
// for, where the control plane says a session is running and the box disagrees.
//
// So every fact here carries when it was learned and from whom, and anything we
// have not been told recently is `unknown` WITH A REASON — never `healthy` by
// omission, and never a benign-looking zero. A scheduler that sees `free: 0`
// quietly skips a host; one that sees `free: null, state: 'unknown'` can say
// why it skipped it.

import { PROTOCOL_VERSION, PROTOCOL_MIN } from '../protocol/intents.js';
import { HOLDER_ID_RE } from '../protocol/holder-join.js';
import { believedCreator } from './hosts.js';
import { LABEL_RE, oneLine } from '../../core/text.js';

/**
 * A POOL'S OWN MACHINE RUNS NO SESSIONS. It is made to stay up and hold the
 * pool's token for the fleet (docs/hypervisors.md, "A machine of its own"),
 * on 2 vCPUs and 4 GiB, and nobody links a Claude account to it. It is never
 * degraded for having none, never chosen for new work, and refused by name;
 * asked for: "Should the pool's own machine ever run sessions? No".
 *
 * Known by its name, which only the coordinator gives (`holder-` and six hex,
 * core.js #onHolderPin): a box that called itself that would only lose the
 * sessions it could have run.
 *
 * @param {string} hostId
 */
export function runsNoSessions(hostId) {
  return HOLDER_ID_RE.test(String(hostId || ''));
}

/**
 * @typedef {object} HostHealth
 * @property {string} hostId
 * @property {number} protocol
 * @property {number} [protocolMin]  the oldest protocol this host still reads;
 *   absent from a host built before version negotiation, read as equal to
 *   `protocol` (exact match, as before). See PROTOCOL_MIN in intents.js.
 * @property {string[]} labels
 * @property {number|null} maxSessions
 * @property {number|null} running
 * @property {number|null} free
 * @property {string[]|null} resumable
 * @property {Array<{name: string, status: string, createdBy?: string|null, cwd?: string|null, startedAt?: number|null, account?: string|null}>|null} [sessions]
 * @property {{ email: string|null, plan: string|null, org: string|null }|null} [account]
 * @property {{ head: string|null, branch: string|null }|null} [version]
 * @property {number[]} loadavg
 * @property {boolean|null} loggedIn  the box's OWN Claude login. Kept for
 *   display — it is what `claude auth status` says on that machine — and no
 *   longer used to judge health: a box has no Claude account of its own.
 * @property {number|null} [claudeAccounts]  how many people's Claude logins the host holds: from their vaults, or linked on it for its own command line
 * @property {'owner'|'key'|'none'|null} [runnerAuth]  on a runner, what a session
 *   with no linked account runs on: the owner's kept Claude login, the runner
 *   repository's API key, or nothing. Null off a runner and from older hosts.
 *   here. Zero is the fault; null is an older host and is not.
 * @property {{reachable: boolean, reason?: string}} [hub]
 * @property {Array<{ address: string, owner: string, reachable: boolean|null, pools?: Array<{ id: string, name: string }>, images?: Array<{ id: string, name: string, pool?: string|null, poolName?: string|null }>, networks?: Array<{ id: string, name: string, pool?: string|null }>, machines?: Array<Record<string, any>>, edges?: Record<string, any> }>} [xo]
 *   the hypervisors this box holds a token for, from its people's vaults, and
 *   the machine images each pool has (src/fleet/host/xo-pools.js). Absent
 *   from a box that holds none, and from an older one.
 * @property {Array<{name: string, title?: string|null, createdBy?: string|null, deletedAt?: number|null, expiresAt?: number|null}>} [bin]
 * @property {{ state: 'fresh'|'expired'|'unknown', expiresAt: number|null, refreshable: boolean, account: string|null, plan: string|null, summary: string }|null} [credential]
 * @property {boolean|null} [sandboxed]  whether this box runs its sessions in
 *   the sandbox. Absent from an older box, which has not said; only `true`
 *   lets a member's session onto a box they do not administer (hosts.js
 *   runsSessionsFor).
 */

/**
 * @typedef {object} HostEntry
 * @property {string} hostId
 * @property {'healthy'|'degraded'|'unknown'|'offline'} state
 * @property {string} reason            why it is in that state, always populated
 * @property {HostHealth|null} health   last report, or null if we never got one
 * @property {number|null} healthAt     when that report arrived
 * @property {number} connectedAt
 * @property {boolean} connected
 * @property {boolean} [ephemeral]  expected to vanish
 * @property {string|null} [owner]   whose runner this is, for an ephemeral host
 * @property {string|null} [actsFor] the one person this host may act for, or
 *   null for an operator's box, which may act for anyone (hosts.js actsFor)
 */

/**
 * A health report with every session's and bin entry's creator replaced by
 * whom the fleet believes (hosts.js believedCreator). Copied rather than
 * edited in place, because the frame is the caller's. Exported for the one
 * copy of a box's health that reaches a person without being stored first,
 * the `health` verb's reply (core.js dispatch).
 *
 * AND ITS LABELS HELD TO THE HUB'S RULE (text.js LABEL_RE), here because this
 * is the one door both copies come through. A label set from an app is held
 * to it on the box (labels.js); a frame was not, so a box reported any
 * strings it liked, any length, newlines included, and fleet_health printed
 * them to an admin's agent as the box's tags (eighth audit). A label that is
 * not one is dropped rather than repaired, as labels.js drops one, and no
 * more than LABELS_MAX are kept: `tag` can match nothing else.
 *
 * @param {{ actsFor?: string|null }} host
 * @param {HostHealth} health
 * @returns {HostHealth}
 */
export function attributed(host, health) {
  if (!health || typeof health !== 'object') return health;
  /** @param {any} list */
  const each = (list) =>
    Array.isArray(list)
      ? list.map((s) => (s && typeof s === 'object' && 'createdBy' in s ? { ...s, createdBy: believedCreator(host, s.createdBy) } : s))
      : list;
  /** @param {unknown} list */
  const labels = (list) =>
    Array.isArray(list) ? list.filter((l) => typeof l === 'string' && LABEL_RE.test(l)).slice(0, LABELS_MAX) : [];
  return {
    ...health,
    ...('sessions' in health ? { sessions: each(health.sessions) } : {}),
    ...('bin' in health ? { bin: each(health.bin) } : {}),
    ...('labels' in health ? { labels: labels(health.labels) } : {}),
    ...('setLabels' in health ? { setLabels: labels(/** @type {any} */ (health).setLabels) } : {}),
  };
}

/**
 * How many labels a box's report may carry: what may be set from an app
 * (labels.js, 64) and as many again for the machine's own facts and
 * FLEETWRIGHT_LABELS, which no box comes near.
 */
const LABELS_MAX = 128;

/** How stale a health report may be before the host becomes `unknown`. */
export const HEALTH_STALE_MS = 45_000;

export class HostRegistry {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, HostEntry & { send: (msg: object) => void }>} */
    this.hosts = new Map();
    /** Round-robin cursor, used only to break ties between equally free hosts. */
    this.cursor = 0;
  }

  /**
   * Called when an ephemeral host is retired, so its key can be revoked too.
   * @type {((hostId: string, reason: string) => void)|null}
   */
  onRetired = null;

  /**
   * A host has dialled in.
   * @param {string} hostId
   * @param {(msg: object) => void} send
   * @param {{ ephemeral?: boolean, owner?: string|null, actsFor?: string|null }} [opts]
   */
  connect(hostId, send, { ephemeral = false, owner = null, actsFor = undefined } = {}) {
    const existing = this.hosts.get(hostId);
    const person = actsFor === undefined ? existing?.actsFor ?? null : actsFor;
    // A reconnect from a host we already have replaces the old socket. The box
    // is the authority on itself, so the newest connection from it wins.
    this.hosts.set(hostId, {
      hostId,
      state: 'unknown',
      reason: existing ? 'reconnected, no health report yet' : 'connected, no health report yet',
      // The last report is kept until the next one, ATTRIBUTED AGAIN under who
      // this connection may act for: a name re-keyed by a member with a pin
      // bound to it comes back acting for that member, and until its first
      // frame the old report would still have filed the operator box's
      // sessions under their creators, on a machine that member now controls.
      health: existing?.health ? attributed({ actsFor: person }, existing.health) : null,
      healthAt: existing?.healthAt ?? null,
      connectedAt: this.now(),
      connected: true,
      // Sticky across reconnects: a runner that drops and comes back is still
      // a runner, and the enrolment is the authority on this rather than
      // whatever the last connect happened to pass.
      ephemeral: ephemeral || existing?.ephemeral || false,
      // Whose runner this is. Only an ephemeral host has one — see hosts.js.
      owner: owner ?? existing?.owner ?? null,
      // Who it may act for, from the enrolment on every connect. Null is an
      // answer here (an operator's box), so only an absent value keeps the
      // last one.
      actsFor: person,
      send,
    });
  }

  /**
   * Who a host may act for, decided again while it stays connected (core.js
   * #retier), and its last report attributed again under that, as a
   * reconnect's is. Changing only the field left a removed admin's box
   * holding a report that filed members' sessions under them until its next
   * frame, so for those seconds their pinned verbs still reached a machine
   * that no longer acted for them.
   *
   * @param {string} hostId @param {string|null} person
   */
  actFor(hostId, person) {
    const host = this.hosts.get(hostId);
    if (!host) return;
    host.actsFor = person;
    if (host.health) host.health = attributed(host, host.health);
  }

  /**
   * A host that is no longer in the fleet, as opposed to one that dropped.
   *
   * `disconnect` keeps the entry as `offline` because a real box may come back.
   * A REVOKED box may not — its key is refused at the door — so keeping it
   * meant the app listed a host somebody had just removed as "offline" until
   * the coordinator restarted, which reads exactly like the removal not taking.
   * C-5: a screen may not report a state the system knows to be false.
   *
   * @param {string} hostId
   */
  remove(hostId) {
    return this.hosts.delete(hostId);
  }

  /** @param {string} hostId @param {string} reason */
  disconnect(hostId, reason = 'socket closed') {
    const host = this.hosts.get(hostId);
    if (!host) return;
    // Kept rather than deleted: a host that has dropped is a fact worth
    // reporting, and its last known sessions are still the best guess about
    // where a `resume` would have to land once it comes back.
    host.connected = false;
    host.state = 'offline';
    host.reason = reason;

    // AN EPHEMERAL HOST THAT DROPS IS GONE, not offline.
    //
    // The comment above is right for a real box: it may come back, and its
    // last known sessions are the best guess about where a resume would land.
    // A CI runner will not come back — the job ended and the machine was
    // destroyed — and keeping it would fill the registry with corpses, one per
    // build, each of them a name the scheduler still considers and a row in
    // somebody's app.
    //
    // Retired here rather than swept later, because the disconnect IS the
    // event: there is nothing to wait for.
    if (host.ephemeral) {
      this.hosts.delete(hostId);
      this.onRetired?.(hostId, reason);
      return;
    }
    host.send = () => {
      throw new Error(`${hostId} is not connected`);
    };
  }

  /**
   * @param {string} hostId @param {HostHealth} health
   * @returns {{ from: string, to: string, reason: string, fault: string }|null} the state
   *   TRANSITION, when there was one. Returned rather than logged because the
   *   transition is the notifiable thing and only the caller can notify — and
   *   because a state, reported every fifteen seconds, is not an event.
   */
  recordHealth(hostId, health) {
    const host = this.hosts.get(hostId);
    if (!host) return null;
    const before = host.state;
    const beforeReason = host.reason;
    /** @type {string|null} */
    let fault = null;
    // WHOSE EACH SESSION IS, decided here and once (hosts.js believedCreator).
    // Kept as reported, a box a member enrolled could name another member as
    // the creator of its sessions and its bin, and every reader below believed
    // it: their listing, their pinned verbs and their stop on a real session
    // of the same name elsewhere.
    host.health = attributed(host, health);
    host.healthAt = this.now();
    // A host whose own fleetwright is unreachable is NOT healthy, even though its
    // socket is fine. It cannot start anything, and saying "healthy" because we
    // can reach the sidecar is exactly the benign-looking lie §3 warns about.
    // FIRST, BECAUSE IT IS THE ONLY FAULT THAT MAKES THE OTHERS UNSAYABLE.
    //
    // A host on a different protocol version refuses EVERY intent —
    // `validateIntent` compares `env.v` for exact equality before it looks at
    // anything else. So the remedies the rungs below name ("link an account
    // from the app", "sign in again") are themselves undeliverable, and putting
    // this lower would offer somebody a fix that cannot arrive.
    //
    // Until now nothing said so at all: health is not version-gated, so a
    // drifted box reported `healthy`, the scheduler sent it work, and every
    // command came back refused. Finding C5 — "nothing said so until the tester
    // tripped over it".
    //
    // A MISSING PROTOCOL IS NOT A MISMATCHED ONE. A host too old to send the
    // field at all reads as null here, and degrading on that would take out
    // exactly the boxes least able to recover — so the guard is an integer
    // check, not a truthiness one.
    // A RANGE, NOT A POINT — a host is degraded on version only when its range
    // and the fleet's do not OVERLAP. A host reports `protocol` (its max) and,
    // since version negotiation, `protocolMin` (its floor); a host from before
    // that sends only `protocol`, read as a range of one (exact match, as
    // before). If the two ranges touch anywhere, `buildIntent` speaks this box
    // the highest version both understand for EVERY command and omits any param
    // newer than it, so the box keeps working and simply lacks the newest
    // capability until it updates — that is not degraded. See
    // docs/protocol-negotiation.md and PROTOCOL_MIN.
    //
    // A MISSING PROTOCOL IS NOT A MISMATCHED ONE. A host too old to send the
    // field at all reads as null here, and degrading on that would take out
    // exactly the boxes least able to recover — so the guard is an integer
    // check, not a truthiness one.
    const hostMax = Number.isInteger(health.protocol) ? Number(health.protocol) : null;
    // A host from before negotiation sends only `protocol`, read as a range of
    // one; so hostMin is a number whenever hostMax is.
    const hostMin = hostMax === null ? null : Number.isInteger(health.protocolMin) ? Number(health.protocolMin) : hostMax;
    if (hostMax !== null && hostMin !== null && (hostMin > PROTOCOL_VERSION || hostMax < PROTOCOL_MIN)) {
      host.state = 'degraded';
      // BEHIND AND AHEAD ARE NOT THE SAME FAULT. Behind now means below the
      // fleet's FLOOR (PROTOCOL_MIN), not merely below its max — a box within
      // the range is negotiated with, not degraded. Below the floor the rescue
      // `update` still reaches it (the coordinator speaks the box's own version
      // for that one command; see RESCUE_VERB), so the repair arrives. Finding
      // D2 — "a drifted host cannot be fixed from the product" — is this line.
      //
      // Ahead is the ordinary upgrade window rather than a broken box: the
      // documented order is hosts first, then the coordinator, so this is what
      // half a deploy looks like and the remedy is to finish it. Sending
      // somebody to the machine with the installer would have them re-install
      // the half that is already correct.
      const fleet = PROTOCOL_MIN === PROTOCOL_VERSION ? `${PROTOCOL_VERSION}` : `${PROTOCOL_MIN}..${PROTOCOL_VERSION}`;
      host.reason =
        hostMax < PROTOCOL_MIN
          ? `speaks protocol up to ${hostMax} and this fleet speaks ${fleet}, so this box is below the ` +
            'fleet floor and every command sent here is refused before it is read — except Apply update, ' +
            "which the fleet says in this box's own version so a drifted machine can still be repaired from " +
            'here. Try that first. If it comes back on the same version, this box is pinned to a channel with ' +
            'no newer release and it needs the installer re-run on the machine.'
          : `speaks protocol from ${hostMin} and this fleet speaks ${fleet}, so this box is AHEAD of the ` +
            'whole fleet range. That is what half a deploy looks like — hosts upgrade first and the ' +
            'coordinator follows. The fleet cannot fix this one from inside itself: it is waiting for its ' +
            'own coordinator to be deployed.';
      // THE INTEGERS ARE THE BOX'S, so they are not the fault. Left to fall back
      // on the sentence, the fault carried whatever number the box sent, and a
      // box sending a new one in every frame made every frame a new fault: 200
      // frames from a member's box were 200 pushes to the admin's phone (sixth
      // Workers audit), as the hub reason had been before. The fault is the
      // sentence up to the first word the box chose, as the hub's is, because
      // #onHostState finds an announcement in the ring by `startsWith` and a
      // fault that is not the reason's own opening would be re-announced by
      // every deploy.
      fault = hostMax < PROTOCOL_MIN ? 'speaks protocol up to' : 'speaks protocol from';
    } else if (health.hub && health.hub.reachable === false) {
      host.state = 'degraded';
      // The one reason in this file the box writes itself, so it is cut to a
      // line here: it is shown on every phone and was taken whole, any length
      // and any characters, into the record #onHostState writes (third
      // Workers audit). An error message fits in 200 with room to spare.
      //
      // ONE LINE BY THE SAME RULE AS EVERY OTHER WORD A BOX SENDS (text.js
      // oneLine). This took out the C0 controls and kept U+2028, U+2029 and
      // the bidirectional overrides, which break or reorder a line as surely
      // as a newline, in a push and in fleet_events (eighth audit).
      const said = oneLine(health.hub.reason ?? '', 200);
      host.reason = `session manager unreachable: ${said || 'no reason given'}`;
      fault = 'session manager unreachable';
    } else if (host.ephemeral && health.claudeAccounts === 0 && health.runnerAuth == null) {
      // A RUNNER THAT HAS NOT BEEN TOLD YET IS NOT ONE WITH NOTHING TO RUN ON.
      // For its first seconds it has not heard back from the minter about its
      // owner's Claude login, so it reports `runnerAuth: null`: cannot tell.
      // This fell through to the rule below, marked the runner degraded with
      // the permanent box's sentence ("link one from the app, or on the box
      // with fleetwright login"), notified the person who had just started it,
      // and then went healthy seconds later when the answer arrived. Unknown
      // says nothing and notifies nobody (core.js #onHostState), and a
      // runner the minter has no login for still reports `none` and is
      // degraded with the runner's own remedy.
      host.state = 'unknown';
      host.reason = 'a new runner, still fetching the Claude login its sessions will run on';
    } else if (health.claudeAccounts === 0 && health.runnerAuth !== 'owner' && health.runnerAuth !== 'key' && !runsNoSessions(hostId)) {
      // NOBODY CAN START A SESSION HERE, which is a different question from the
      // one this used to ask. It read `loggedIn === false` — the box's own
      // Claude login — and that rule outlived its model: since
      // docs/one-account-per-person.md a machine HAS no Claude account, so
      // every host reports `loggedIn: false` and every host was permanently
      // degraded, permanently unschedulable, and re-announced on every
      // coordinator deploy. A stale rule producing a stream of notifications
      // about a fault that no longer exists.
      //
      // What matters now is whether anybody's account is on the box. None is a
      // real fault with a real remedy; whose is missing is a per-session
      // question and is answered there, by name.
      host.state = 'degraded';
      // THE REMEDY IN THE SAME SENTENCE. This said only what was wrong, and a
      // beta tester's first run ended here: the refusal names no next step,
      // and linking from a shell is documented nowhere they would look.
      //
      // A refusal that names a reason is this protocol's central promise; a
      // reason without a remedy is half of it.
      //
      // A RUNNER IS ASKED A DIFFERENT QUESTION. Nobody links an account on a
      // GitHub job that lives for an hour: a session there runs on its owner's
      // kept Claude login or on the runner repository's API key, and the hub
      // says which (runnerAuth). Counting only linked accounts marked every
      // runner degraded, refused the session it was started for, and told the
      // person to log in on a box they cannot reach.
      host.reason = health.runnerAuth === 'none'
        ? 'this runner has no Claude login for whoever started it and its repository has no ANTHROPIC_API_KEY, ' +
          'so no session started here can do anything. Keep your Claude login for your runners under You › ' +
          'Credentials in the app, or add ANTHROPIC_API_KEY to the runner repository’s Actions secrets'
        : 'nobody’s vault gives this host a Claude login, so no session started here can do anything. ' +
        // TELEGRAM WAS ARCHIVED AND THIS SENTENCE DID NOT NOTICE, and then
        // neither did linking: a person's login is kept in their vault and a
        // host has it once they approve that host (docs/vault.md), so the
        // remedy is those two steps and not a sign-in on the box.
        // SAID AS A PHONE SHOWS IT: this is the line under the machine's name.
        'Keep your Claude login under You › Credentials in the app, and approve this machine from its page.';
    } else if (health.credential?.state === 'expired' && health.credential.refreshable === false) {
      // A DIFFERENT FAILURE FROM `loggedIn === false`, and the one that was
      // invisible. `loggedIn` reports on the box's own home directory; this
      // reports on the credential file a session gets a copy of. A box can be
      // logged in and still hand every new session a dead token, which is
      // what "deb13-staging wouldn't work until I clicked sign in again"
      // was — and nothing here could say so, so the scheduler kept sending
      // work to it.
      //
      // NARROW ON PURPOSE: only when the token has expired AND there is no
      // refresh token to renew it with. An expired-but-refreshable token is
      // the ordinary state of a box nobody has used for an hour, and the CLI
      // inside the session renews it. Degrading on that would take a healthy
      // fleet offline every night, and a warning that fires on the ordinary
      // case is a warning people learn to ignore.
      host.state = 'degraded';
      host.reason = 'the credential a session would be given has expired on this host';
    } else {
      host.state = 'healthy';
      host.reason = 'reporting normally';
    }
    // THE TRANSITION, NOT THE STATE. A host reports health every fifteen
    // seconds; a box that has been degraded since yesterday must produce one
    // notification, not five thousand. Same discipline as the session watcher,
    // and for the same reason — a phone that cries wolf gets its notifications
    // turned off, which costs you the one that mattered.
    //
    // The reason is part of the identity: a host that goes from "not logged in"
    // to "credential expired" changed in a way worth saying, even though both
    // are `degraded`.
    //
    // `fault` is the same without the box's own words, which is what
    // #onHostState keys its quiet hour on (core.js).
    if (host.state === before && host.reason === beforeReason) return null;
    return { from: before, to: host.state, reason: host.reason, fault: fault ?? host.reason };
  }

  /**
   * Age out anything we have not heard from. Call before every read, so a
   * caller can never see a stale entry that still claims to be healthy.
   */
  sweep() {
    const now = this.now();
    for (const host of this.hosts.values()) {
      if (!host.connected) continue;
      if (host.healthAt === null) {
        if (now - host.connectedAt > HEALTH_STALE_MS) {
          host.state = 'unknown';
          host.reason = `connected ${Math.round((now - host.connectedAt) / 1000)}s ago and has never reported health`;
        }
        continue;
      }
      const age = now - host.healthAt;
      if (age > HEALTH_STALE_MS) {
        host.state = 'unknown';
        host.reason = `last health report was ${Math.round(age / 1000)}s ago`;
      }
    }
  }

  /** @returns {HostEntry[]} */
  list() {
    this.sweep();
    // Not `actsFor` either: it is for placement, and a screen that wants who
    // enrolled a box reads the enrolled list, which says so in its own words.
    return [...this.hosts.values()].map(({ send, actsFor, ...entry }) => entry);
  }

  /** @param {string} hostId */
  get(hostId) {
    this.sweep();
    return this.hosts.get(hostId) || null;
  }

  /**
   * Hosts that could accept NEW WORK right now.
   *
   * Healthy, because placing a session on a box whose fleetwright is unreachable
   * or whose claude is logged out is placing it nowhere.
   */
  schedulable() {
    this.sweep();
    return [...this.hosts.values()].filter((h) => h.connected && h.state === 'healthy' && h.health && !runsNoSessions(h.hostId));
  }

  /**
   * Hosts worth ASKING A QUESTION of. A strictly wider set, and the difference
   * matters more than it looks.
   *
   * `list` used to fan out over schedulable(), which meant a box whose claude
   * was merely logged out — degraded, not gone, still holding every one of its
   * running sessions — dropped out of the answer entirely. Not greyed out, not
   * flagged: absent. The phone showed a shorter list and said nothing, and the
   * sessions it stopped showing were exactly the ones on the box that needed
   * attention.
   *
   * Schedulability is a question about writes. A read should reach anything
   * that is on the end of a socket.
   */
  reachable() {
    this.sweep();
    return [...this.hosts.values()].filter((h) => h.connected);
  }

  /**
   * Which host holds a session of this name, as far as we last heard.
   *
   * Deliberately returns the ENTRY rather than a boolean, so a caller can see
   * how stale the claim is and refuse to act on it if it is too old. `resume`
   * is pinned — claude-<name> is a host-local volume, so it must land on the
   * box holding it — and pinning to a guess is worse than refusing.
   *
   * @param {string} name
   * @returns {{ host: HostEntry, status: string, ageMs: number }|null}
   */
  findSession(name) {
    const all = this.findSessions(name);
    return all.length ? all[0] : null;
  }

  /**
   * Fold sessions from a reply into what this host is known to hold.
   *
   * A health frame is the normal source and stays authoritative — this only
   * fills the gap between a host confirming it started something and the frame
   * that says so arriving. Merged by name rather than replacing the list: a
   * single `start` reply describes one session, and treating it as the whole
   * truth would erase every other session on that box until the next frame.
   *
   * @param {string} hostId
   * @param {Array<any>} sessions
   */
  noteSessions(hostId, sessions) {
    const host = this.hosts.get(hostId);
    if (!host?.health || !Array.isArray(sessions)) return;
    const known = Array.isArray(host.health.sessions) ? [...host.health.sessions] : [];
    for (const s of sessions) {
      if (!s || typeof s.name !== 'string') continue;
      const at = known.findIndex((k) => k?.name === s.name);
      // A reply is the box's word as much as a health frame is, so its
      // creator is believed by the same rule (believedCreator).
      const row = { name: s.name, status: String(s.status || 'running'), createdBy: believedCreator(host, s.createdBy) };
      if (at >= 0) known[at] = { ...known[at], ...row };
      else known.push(row);
    }
    host.health.sessions = known;
  }

  /**
   * EVERY host claiming a session of this name.
   *
   * findSession returned the first match in Map order, and this codebase says
   * elsewhere — in dispatch(), in as many words — that two hosts can hold
   * sessions with the same name. So `stop bigjob` picked whichever box the
   * iterator happened to reach first and killed it, silently, with no
   * indication that a choice had been made at all.
   *
   * The scheduler refuses on more than one rather than guessing. A stop that
   * lands on the wrong box is not recoverable by retrying.
   *
   * @param {string} name
   */
  findSessions(name) {
    this.sweep();
    const out = [];
    for (const host of this.hosts.values()) {
      const sessions = host.health?.sessions;
      const found = sessions?.find((s) => s.name === name);
      if (found) {
        out.push({
          host,
          status: found.status,
          // For ownership checks. Older sidecars report no createdBy; null
          // means "unattributed", which the scheduler treats as fleet-owned.
          createdBy: found.createdBy ?? null,
          ageMs: host.healthAt === null ? Infinity : this.now() - host.healthAt,
        });
        continue;
      }
      // THE BIN COUNTS AS A CLAIM. `restore` is pinned for the same reason
      // `resume` is, and harder: the conversation and the workspace are
      // host-local volumes, so the only box that can bring a session back is
      // the one still holding them. Without this the coordinator would refuse
      // every restore with unknown_session — the session is real, it is just
      // not in the live list any more.
      //
      // createdBy travels, so the ownership check one layer up works on a
      // forgotten session exactly as it does on a live one: a member must not
      // restore somebody else's work.
      const binned = host.health?.bin?.find((/** @type {any} */ b) => b.name === name);
      if (binned) {
        out.push({
          host,
          status: 'binned',
          createdBy: binned.createdBy ?? null,
          ageMs: host.healthAt === null ? Infinity : this.now() - host.healthAt,
        });
        continue;
      }
      // Older sidecars report only the resumable names.
      if (host.health?.resumable?.includes(name)) {
        out.push({ host, status: 'stopped', ageMs: host.healthAt === null ? Infinity : this.now() - host.healthAt });
      }
    }
    return out;
  }

  /** Next tie-break index, for the scheduler. */
  nextCursor() {
    return this.cursor++;
  }
}
