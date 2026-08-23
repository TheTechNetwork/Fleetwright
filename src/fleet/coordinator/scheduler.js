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
const PINNED = new Set(['resume', 'stop', 'forget', 'peek', 'status']);

/** Verbs answered by asking every host and merging. */
const FANOUT = new Set(['list']);

/**
 * @typedef {object} Placement
 * @property {'host'|'fanout'|'refused'} kind
 * @property {import('./registry.js').HostEntry & {send: Function}} [host]
 * @property {Array<import('./registry.js').HostEntry & {send: Function}>} [hosts]
 * @property {string} [reason]
 * @property {string} [code]
 */

/**
 * @param {import('./registry.js').HostRegistry} registry
 * @param {{ verb: string, params?: Record<string, any> }} intent
 * @param {{ maxPinAgeMs?: number }} [opts]
 * @returns {Placement}
 */
export function place(registry, intent, { maxPinAgeMs = 120_000 } = {}) {
  const verb = intent.verb;
  const name = intent.params?.name;

  if (FANOUT.has(verb)) {
    const hosts = registry.schedulable();
    return hosts.length
      ? { kind: 'fanout', hosts }
      : { kind: 'refused', code: 'no_hosts', reason: describeWhyNoHosts(registry) };
  }

  // `status` with no name is a fleet-wide question, not a session one.
  if (verb === 'status' && !name) {
    const hosts = registry.schedulable();
    return hosts.length
      ? { kind: 'fanout', hosts }
      : { kind: 'refused', code: 'no_hosts', reason: describeWhyNoHosts(registry) };
  }

  if (PINNED.has(verb)) {
    const found = name ? registry.findSession(name) : null;
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

  // --- new work: filter, rank, tie-break ------------------------------------
  const candidates = registry.schedulable();
  if (!candidates.length) {
    return { kind: 'refused', code: 'no_hosts', reason: describeWhyNoHosts(registry) };
  }

  const required = normaliseLabels(intent.params?.labels);
  const matching = required.length
    ? candidates.filter((h) => required.every((l) => (h.health?.labels || []).includes(l)))
    : candidates;
  if (!matching.length) {
    return {
      kind: 'refused',
      code: 'no_host_matches',
      reason: `No connected host carries every label: ${required.join(', ')}`,
    };
  }

  const withRoom = matching.filter((h) => (h.health?.free ?? 0) > 0);
  if (!withRoom.length) {
    return {
      kind: 'refused',
      code: 'at_capacity',
      reason: matching
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

/** @param {unknown} value */
function normaliseLabels(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
