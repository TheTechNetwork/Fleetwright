// The state vocabulary and the standing claims, in one place.
//
// Phase 2a of docs/plan.md, and a product decision rather than a UI cleanup.
// Five surfaces currently invent their own words for the same thing: the
// registry stores three session statuses, the watcher has a boolean, the push
// sender returns prose, the apps have badge cases for states that can never
// arrive, and nothing reconciles any of it.
//
// NEVER COLOUR ALONE (docs/psychology.md §5). Every entry carries a word and a
// glyph; the tint only agrees with what those already say.

/** What a session is doing, in the words a person should see. */
export const SESSION_STATES = {
  waiting: { word: 'Waiting for you', glyph: '!', tone: 'attention', rank: 0 },
  working: { word: 'Working', glyph: '>', tone: 'active', rank: 1 },
  stopped: { word: 'Stopped', glyph: '=', tone: 'idle', rank: 2 },
  finished: { word: 'Finished', glyph: 'o', tone: 'idle', rank: 3 },
  broken: { word: 'Broken', glyph: 'x', tone: 'bad', rank: 4 },
};

/**
 * What a host is.
 *
 * FOUR, not three. `offline` is a thing we KNOW — the socket dropped — and
 * `unknown` is what we say when we have not heard recently enough to be sure.
 * Collapsing them reports a box we know is gone as a box we cannot see, which
 * is the more alarming of the two and the less accurate.
 */
export const HOST_STATES = {
  healthy: { word: 'Healthy', glyph: '+', tone: 'ok', rank: 3 },
  degraded: { word: 'Degraded', glyph: '!', tone: 'attention', rank: 1 },
  offline: { word: 'Offline', glyph: 'x', tone: 'bad', rank: 0 },
  unknown: { word: 'Not sure', glyph: '?', tone: 'unsure', rank: 2 },
};

/** How long before a host that has stopped reporting is no longer current. */
const HEALTH_STALE_MS = 45_000;

/**
 * Strip what must never reach the DOM.
 *
 * C0 controls first: a bare carriage return can make a pane appear to show text
 * the session never printed.
 *
 * Then Unicode bidi overrides, and this one is not theoretical. An RLO inside
 * an option label can make a button read `Deny` and mean `Approve` — six pixels
 * from an irreversible action, on the origin that holds every credential.
 * Replaced with a visible replacement character rather than deleted, so a label
 * that was trying it looks wrong instead of looking fine.
 *
 * @param {unknown} s
 */
export function scrub(s) {
  return String(s == null ? '' : s)
    // C0 controls, minus tab and newline. A bare carriage return can make a
    // pane appear to show text the session never printed.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    // Unicode bidi overrides, and this one is not theoretical: an RLO inside
    // an option label can make a button read `Deny` and mean `Approve`, six
    // pixels from an irreversible action, on the origin that holds every
    // credential. Replaced with a visible replacement character rather than
    // deleted, so a label that was trying it looks wrong instead of fine.
    .replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g, '\uFFFD');
}

/**
 * A session's state, derived once.
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
 * @param {any} a @param {any} b
 */
export function byUrgency(a, b) {
  const d = SESSION_STATES[sessionState(a)].rank - SESSION_STATES[sessionState(b)].rank;
  return d !== 0 ? d : String(a?.name || '').localeCompare(String(b?.name || ''));
}

/**
 * THE STANDING CLAIMS.
 *
 * Four things this page asserts about itself, each one a specific way it could
 * be lying to you, stated as the reason it is not.
 *
 * They are STANDING: a claim that passes is still rendered, quietly. It never
 * disappears and it is never replaced somewhere else — because a claim that
 * vanishes when it holds is indistinguishable from a claim nobody is checking,
 * and that is the difference between silence you can trust and silence that
 * means nothing (docs/psychology.md §7).
 *
 * My first version of this branched instead: one headline, and the reasons for
 * whichever thing was worst. So a single degraded host hid the fact that
 * everything else was fine and being watched. The design review was right and
 * this is its model.
 *
 * @param {{ hosts?: any[], sessions?: any[], events?: any[], enrolled?: number, devices?: number, reachable?: boolean, now?: number }} snap
 * @returns {{ id: string, ok: boolean|null, claim: string, because?: string, remedy?: string }[]}
 */
export function standingClaims(snap) {
  const hosts = snap?.hosts || [];
  const connected = hosts.filter((h) => h.connected);
  const now = snap?.now ?? Date.now();
  const enrolled = snap?.enrolled ?? hosts.length;
  /** @type {{ id: string, ok: boolean|null, claim: string, because?: string, remedy?: string }[]} */
  const out = [];

  // 1. COVERAGE — am I seeing every box?
  if (!enrolled) {
    out.push({
      id: 'coverage',
      ok: null,
      claim: 'No machine has enrolled yet.',
      because: 'There is no fleet to watch, so there is nothing this page could be failing to show you.',
      remedy: 'Mint an enrolment pin and run agent-fleet-sidecar enrol on a box.',
    });
  } else if (connected.length >= enrolled) {
    out.push({ id: 'coverage', ok: true, claim: `All ${enrolled} enrolled machines are connected.` });
  } else {
    const gone = hosts.filter((h) => !h.connected).map((h) => h.hostId);
    out.push({
      id: 'coverage',
      ok: false,
      claim: `${connected.length} of ${enrolled} enrolled machines are connected.`,
      because: `${gone.join(', ') || 'Some'} stopped dialling in. Sessions on them cannot be seen from here.`,
      remedy: 'A host reappears on its own when it dials back in — nothing needs re-enrolling.',
    });
  }

  // 2. FRESHNESS — is what I am showing you current?
  if (!connected.length) {
    out.push({ id: 'freshness', ok: null, claim: 'No machine is reporting.', because: 'Nothing on this page is current.' });
  } else {
    const stale = connected.filter((h) => !h.healthAt || now - h.healthAt > HEALTH_STALE_MS);
    if (!stale.length) {
      out.push({ id: 'freshness', ok: true, claim: 'Every machine has reported in the last minute.' });
    } else {
      out.push({
        id: 'freshness',
        ok: null,
        claim: `${stale.map((h) => h.hostId).join(', ')} ${stale.length === 1 ? 'has' : 'have'} gone quiet.`,
        // The registry's own sentence, verbatim. It works to make "we don't
        // know" unrepresentable as a benign value, and nothing rendered it.
        because: stale.map((h) => `${h.hostId}: ${h.reason || 'no reason recorded'}`).join(' · '),
      });
    }
  }

  // 3. CAPABILITY — can these machines actually do the work?
  const unable = connected.filter((h) => h.state !== 'healthy');
  if (!connected.length) {
    out.push({ id: 'capability', ok: null, claim: 'Nothing is connected, so nothing can take work.' });
  } else if (!unable.length) {
    out.push({ id: 'capability', ok: true, claim: 'Every connected machine can take work.' });
  } else {
    out.push({
      id: 'capability',
      ok: false,
      claim: `${unable.length} connected ${unable.length === 1 ? 'machine cannot' : 'machines cannot'} take work.`,
      because: unable.map((h) => `${h.hostId}: ${h.reason || HOST_STATES[/** @type {keyof typeof HOST_STATES} */ (h.state)]?.word}`).join(' · '),
      remedy: 'agent-fleet-sidecar doctor on that box says which check failed.',
    });
  }

  // 4. SELF — is this page even talking to the coordinator?
  if (snap?.reachable === false) {
    out.push({
      id: 'self',
      ok: false,
      claim: 'This page is not talking to the coordinator.',
      because: 'Everything below is the last thing it knew, and it is not being updated.',
      remedy: 'Your machines keep running and keep their sessions — each box is the authority on its own tmux.',
    });
  } else {
    out.push({ id: 'self', ok: true, claim: 'This page is talking to the coordinator.' });
  }

  return out;
}

/**
 * The headline over the claims.
 *
 * It only says "nothing needs you" when the claims support it. If any of them
 * is failing, the console cannot honestly assert that nothing needs you — it
 * can only assert that nothing is ASKING, which is a smaller thing and is said
 * as such.
 *
 * @param {{ hosts?: any[], sessions?: any[], reachable?: boolean }} snap
 */
export function headline(snap) {
  const sessions = snap?.sessions || [];
  const waiting = sessions.filter((s) => sessionState(s) === 'waiting');
  if (waiting.length) {
    return {
      settled: false,
      glyph: '!',
      text: waiting.length === 1 ? 'One session needs you' : `${waiting.length} sessions need you`,
    };
  }

  const broken = sessions.filter((s) => sessionState(s) === 'broken');
  if (broken.length) {
    return { settled: false, glyph: '!', text: broken.length === 1 ? 'One session broke' : `${broken.length} sessions broke` };
  }

  const failing = standingClaims(snap).filter((c) => c.ok === false || c.ok === null);
  if (failing.length) {
    return {
      settled: false,
      glyph: '~',
      text: 'Nothing is asking you — but this screen is not seeing the whole fleet',
    };
  }

  return { settled: true, glyph: '+', text: 'Nothing needs you' };
}
