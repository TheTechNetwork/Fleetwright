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
 * @param {{ maxPinAgeMs?: number, preferHost?: string, requester?: { email?: string|null, admin?: boolean }|null }} [opts]
 * @returns {Placement}
 */
export function place(registry, intent, { maxPinAgeMs = 120_000, preferHost = '', requester = null } = {}) {
  const verb = intent.verb;
  const name = intent.params?.name;

  if (FANOUT.has(verb)) {
    // reachable(), not schedulable(): see the comment on both in registry.js.
    // Asking every connected box what it has is a different question from
    // choosing one to start work on.
    const hosts = registry.reachable();
    return hosts.length
      ? { kind: 'fanout', hosts }
      : { kind: 'refused', code: 'no_hosts', reason: describeWhyNoHosts(registry) };
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
  //
  // connect/link/unlink join them, and for a stronger reason than the others:
  // the two halves of a connection are a PAIR. `connect` starts a login in a
  // pane on one box and `link` types the code into that same pane, so a second
  // step that landed elsewhere would type a live credential into a box that
  // never asked for one. Fanning them out would be worse still — one paste,
  // copied to every host in the fleet.
  if (
    verb === 'logs' ||
    verb === 'update' ||
    verb === 'upgrade' ||
    verb === 'reboot' ||
    verb === 'connect' ||
    verb === 'link' ||
    verb === 'unlink'
  ) {
    const reachable = registry.reachable();
    if (!reachable.length) {
      return { kind: 'refused', code: 'no_hosts', reason: describeWhyNoHosts(registry) };
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
    if (reachable.length === 1) return { kind: 'host', host: reachable[0] };
    return {
      kind: 'refused',
      code: 'ambiguous_host',
      reason: `Which box? ${reachable.map((h) => h.hostId).join(', ')}.`,
    };
  }

  // `status` with no name is a fleet-wide question, not a session one.
  if (verb === 'status' && !name) {
    const hosts = registry.reachable();
    return hosts.length
      ? { kind: 'fanout', hosts }
      : { kind: 'refused', code: 'no_hosts', reason: describeWhyNoHosts(registry) };
  }

  if (PINNED.has(verb)) {
    const claims = name ? registry.findSessions(name) : [];
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
    /** @type {(typeof claims)[number]|null} */
    let found = claims[0] || null;
    // OWNERSHIP, checked before anything is revealed. A member may act only on
    // sessions their verified identity created; unattributed sessions belong
    // to the fleet, exactly as in the visibility filter one layer down.
    //
    // The refusal is BYTE-IDENTICAL to unknown_session, deliberately. A
    // distinct "not yours" answer would confirm to a member that a guessed
    // name exists on somebody else's work — an existence oracle built out of
    // an access control. To a member, a session they cannot touch and a
    // session that does not exist must be the same fact.
    if (found && requester && !requester.admin) {
      const mine = `fleet:${String(requester.email || '').toLowerCase()}`;
      if (String(found.createdBy || '').toLowerCase() !== mine) found = null;
    }
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
      return {
        kind: 'refused',
        code: 'host_unavailable',
        reason: known
          ? `${preferHost} is ${known.state}: ${known.reason}`
          : `${preferHost} is not a host this fleet knows.`,
      };
    }
    if ((chosen.health?.free ?? 0) <= 0) {
      return {
        kind: 'refused',
        code: 'at_capacity',
        reason: `${preferHost} is full: ${chosen.health?.running}/${chosen.health?.maxSessions} sessions.`,
      };
    }
    return { kind: 'host', host: chosen };
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

  // EPHEMERAL HOSTS ARE OPT-IN, NEVER A DEFAULT TARGET.
  //
  // A CI runner is a host that is about to disappear. Placing ordinary work on
  // one by capacity — which it has plenty of, being empty — would start a
  // session on a box that will be gone in minutes, taking the conversation and
  // the workspace with it. The scheduler cannot know that; the enrolment does.
  //
  // Reachable for reads, listable, addressable BY NAME through the placement
  // preference. Just never chosen for you.
  const durable = matching.filter((h) => !h.ephemeral);
  if (!durable.length && matching.length) {
    return {
      kind: 'refused',
      code: 'only_ephemeral_hosts',
      reason:
        `The only hosts that match are temporary: ${matching.map((h) => h.hostId).join(', ')}. ` +
        'Name one explicitly to use it — work started there is lost when it goes.',
    };
  }

  const withRoom = durable.filter((h) => (h.health?.free ?? 0) > 0);
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
