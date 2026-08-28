// The coordinator's view of the fleet.
//
// THE RULE THIS FILE EXISTS TO ENFORCE (design.md §3):
//
//   The coordinator's registry is a CACHE WITH PROVENANCE, never the authority.
//   Each host stays the sole authority on its own tmux.
//
// agent-hub's whole simplification was collapsing a two-plane design — a queue
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

/**
 * @typedef {object} HostHealth
 * @property {string} hostId
 * @property {number} protocol
 * @property {string[]} labels
 * @property {number|null} maxSessions
 * @property {number|null} running
 * @property {number|null} free
 * @property {string[]|null} resumable
 * @property {Array<{name: string, status: string, createdBy?: string|null, cwd?: string|null, startedAt?: number|null, account?: string|null}>|null} [sessions]
 * @property {{ email: string|null, plan: string|null, org: string|null }|null} [account]
 * @property {{ head: string|null, branch: string|null }|null} [version]
 * @property {number[]} loadavg
 * @property {boolean|null} loggedIn
 * @property {{reachable: boolean, reason?: string}} [hub]
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
 */

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
   * @param {{ ephemeral?: boolean }} [opts]
   */
  connect(hostId, send, { ephemeral = false } = {}) {
    const existing = this.hosts.get(hostId);
    // A reconnect from a host we already have replaces the old socket. The box
    // is the authority on itself, so the newest connection from it wins.
    this.hosts.set(hostId, {
      hostId,
      state: 'unknown',
      reason: existing ? 'reconnected, no health report yet' : 'connected, no health report yet',
      health: existing?.health ?? null,
      healthAt: existing?.healthAt ?? null,
      connectedAt: this.now(),
      connected: true,
      // Sticky across reconnects: a runner that drops and comes back is still
      // a runner, and the enrolment is the authority on this rather than
      // whatever the last connect happened to pass.
      ephemeral: ephemeral || existing?.ephemeral || false,
      send,
    });
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

  /** @param {string} hostId @param {HostHealth} health */
  recordHealth(hostId, health) {
    const host = this.hosts.get(hostId);
    if (!host) return;
    host.health = health;
    host.healthAt = this.now();
    // A host whose own agent-hub is unreachable is NOT healthy, even though its
    // socket is fine. It cannot start anything, and saying "healthy" because we
    // can reach the sidecar is exactly the benign-looking lie §3 warns about.
    if (health.hub && health.hub.reachable === false) {
      host.state = 'degraded';
      host.reason = `session manager unreachable: ${health.hub.reason || 'no reason given'}`;
    } else if (health.loggedIn === false) {
      host.state = 'degraded';
      host.reason = 'claude is not logged in on this host';
    } else {
      host.state = 'healthy';
      host.reason = 'reporting normally';
    }
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
    return [...this.hosts.values()].map(({ send, ...entry }) => entry);
  }

  /** @param {string} hostId */
  get(hostId) {
    this.sweep();
    return this.hosts.get(hostId) || null;
  }

  /**
   * Hosts that could accept NEW WORK right now.
   *
   * Healthy, because placing a session on a box whose agent-hub is unreachable
   * or whose claude is logged out is placing it nowhere.
   */
  schedulable() {
    this.sweep();
    return [...this.hosts.values()].filter((h) => h.connected && h.state === 'healthy' && h.health);
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
