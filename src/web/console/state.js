// The state vocabulary, in one place.
//
// Phase 2a of docs/plan.md, and it is a product decision rather than a UI
// cleanup. Five surfaces currently invent their own words for the same thing:
// the registry stores three session statuses, the watcher has a boolean, the
// push sender returns prose, the apps have badge cases for states that can
// never arrive, and nothing reconciles any of it.
//
// Once the vocabulary exists here, the notification body, the badge, the list
// sort, the detail header and the console agree by construction rather than by
// five people remembering.
//
// NEVER COLOUR ALONE (docs/psychology.md §5). Every entry carries a word and a
// glyph; the tint only agrees with what those already say. Colour is
// pre-attentive, which makes it excellent reinforcement and useless as the sole
// carrier of meaning — a colour-blind reader loses it entirely, everybody loses
// it in sunlight, and a person glancing at a screen reads the shape and the
// word before they consciously process a hue.

/**
 * What a session is doing, in the words a person should see.
 *
 * `waiting` is the one that did not exist anywhere before: the registry stores
 * only running/stopped/error, and "a person is needed" lived as a transient
 * boolean on an event nothing persisted. It is the entire reason this product
 * exists, so it is first.
 */
export const SESSION_STATES = {
  waiting: { word: 'Waiting for you', glyph: '!', tone: 'attention', rank: 0 },
  working: { word: 'Working', glyph: '>', tone: 'active', rank: 1 },
  stopped: { word: 'Stopped', glyph: '=', tone: 'idle', rank: 2 },
  finished: { word: 'Finished', glyph: 'o', tone: 'idle', rank: 3 },
  broken: { word: 'Broken', glyph: 'x', tone: 'bad', rank: 4 },
};

/**
 * What a host is, in the words a person should see.
 *
 * FOUR, not three. `offline` is a thing we KNOW — the socket dropped — and
 * `unknown` is what we say when we have not heard recently enough to be sure.
 * Collapsing them reports a box we know is gone as a box we cannot see, which
 * is the more alarming of the two and the less accurate. A designer caught this
 * in registry.js after openapi.json had already shipped with three.
 */
export const HOST_STATES = {
  healthy: { word: 'Healthy', glyph: '+', tone: 'ok', rank: 3 },
  degraded: { word: 'Degraded', glyph: '!', tone: 'attention', rank: 1 },
  offline: { word: 'Offline', glyph: 'x', tone: 'bad', rank: 0 },
  unknown: { word: 'Not sure', glyph: '?', tone: 'unsure', rank: 2 },
};

/**
 * A session's state, derived once.
 *
 * `awaiting-input` is not a stored status and cannot become one without a
 * change to agent-hub's registry, so waiting-ness arrives alongside: a session
 * carries an open `prompt` when the host recognised one.
 *
 * @param {{ status?: string, prompt?: unknown }} session
 */
export function sessionState(session) {
  if (session?.prompt) return 'waiting';
  switch (session?.status) {
    case 'running':
      return 'working';
    case 'error':
      return 'broken';
    case 'stopped':
      return 'stopped';
    default:
      return 'finished';
  }
}

/**
 * Sort order for the wall: what needs a person, first.
 *
 * An interruption costs more than the time it takes to answer
 * (docs/psychology.md §1), so the surface's job is to make "which one" a
 * glance rather than a search.
 *
 * @param {any} a @param {any} b
 */
export function byUrgency(a, b) {
  const d = SESSION_STATES[sessionState(a)].rank - SESSION_STATES[sessionState(b)].rank;
  return d !== 0 ? d : String(a?.name || '').localeCompare(String(b?.name || ''));
}

/**
 * Is this fleet quiet because everything is fine, or quiet because we have lost
 * the ability to tell?
 *
 * docs/psychology.md §7: if those two look the same, quiet means nothing and
 * the anxiety the product exists to bound comes straight back. So "nothing
 * needs you" is only ever claimed when it can be justified, and the reasons are
 * returned so the surface can show its working.
 *
 * @param {{ hosts?: any[], sessions?: any[], reachable?: boolean }} snap
 */
export function fleetConfidence(snap) {
  const hosts = snap?.hosts || [];
  const sessions = snap?.sessions || [];

  if (snap?.reachable === false) {
    return {
      settled: false,
      headline: 'Cannot reach the coordinator',
      because: ['Everything below is the last thing we knew, and it is not being updated.'],
    };
  }
  if (!hosts.length) {
    return { settled: false, headline: 'No machines have joined yet', because: ['Mint a pin and enrol one.'] };
  }

  const waiting = sessions.filter((s) => sessionState(s) === 'waiting');
  const broken = sessions.filter((s) => sessionState(s) === 'broken');
  const notHealthy = hosts.filter((h) => h.state !== 'healthy');

  if (waiting.length) {
    return {
      settled: false,
      headline: waiting.length === 1 ? 'One session needs you' : `${waiting.length} sessions need you`,
      because: waiting.map((s) => `${s.title || s.name}: ${s.prompt?.question || 'is waiting'}`),
    };
  }
  if (broken.length) {
    return {
      settled: false,
      headline: broken.length === 1 ? 'One session broke' : `${broken.length} sessions broke`,
      because: broken.map((s) => `${s.title || s.name} stopped with an error.`),
    };
  }
  if (notHealthy.length) {
    return {
      settled: false,
      // Not "all good with a caveat". A host we cannot vouch for is a reason
      // the quiet is not trustworthy, and saying so is the whole point.
      headline: `${notHealthy.length} of ${hosts.length} machines cannot be vouched for`,
      because: notHealthy.map(
        (h) => `${h.hostId}: ${h.reason || HOST_STATES[/** @type {keyof typeof HOST_STATES} */ (h.state)]?.word || 'state unknown'}`,
      ),
    };
  }

  // The important one. Not an empty state — a positive claim, with its working
  // shown, because that is what converts unbounded anxiety into bounded
  // knowledge (docs/psychology.md).
  const running = sessions.filter((s) => sessionState(s) === 'working').length;
  return {
    settled: true,
    headline: 'Nothing needs you',
    because: [
      `${hosts.length} machine${hosts.length === 1 ? '' : 's'} connected and reporting healthy.`,
      running ? `${running} session${running === 1 ? '' : 's'} working, none waiting on an answer.` : 'No sessions running.',
      'Every machine has reported within the last minute.',
    ],
  };
}
