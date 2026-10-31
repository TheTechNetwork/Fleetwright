// The walls around the one thing in the fleet that costs money per question:
// asking Clef-flash whether a still pane is a person being asked something
// (docs/decide-design.md, sections B and C; docs/decide.md for the operator).
//
// WHY EVERY WALL IS HERE AND NOT IN THE HOST. The host is the asker, and the
// coordinator is treated as compromised for custody but not for spend: it is
// the one place that sees every host, so it is the one place a cap means
// "per fleet" rather than "per box that behaves". The host has its own
// restraint (one ask per pane hash, only on a still pane, only when every
// deterministic reader is blind); these walls assume it has none.
//
// EVERY CAP IS PERSISTED. A Durable Object is rebuilt on every deploy and
// whenever it is evicted between messages, so a cap held in memory is a cap
// per rebuild (core.js serialisePushLimits says what that cost the pushes).
// The day's spend and both windows go to storage under `decide` the moment
// they move.
//
// THE GATE REFUSES, IT NEVER CLEANS. A host whose mask let something through
// is a host whose mask is wrong, and cleaning its text here would hide that
// from the only person who can fix it. The host is told which pattern, the
// operator's log names the host and the pattern, and the text is never logged
// and never stored.

import { GATE_PATTERNS, MASK_MAX_BYTES, MASK_MAX_LINES } from '../../core/mask-pane.js';

/** Neurons per input token: $0.038 per million tokens, at $0.011 per 1,000 neurons. */
export const NEURONS_PER_INPUT_TOKEN = 0.003455;

/** Inside the free 10,000 a day, so a fleet that sets nothing spends nothing. */
export const DEFAULT_DECIDE_NEURONS_PER_DAY = 8_000;

/**
 * Whatever `[vars]` says, never more than this: about $1 a day, $30 a month,
 * the worst case with every other wall down.
 */
export const MAX_DECIDE_NEURONS_PER_DAY = 100_000;

/** One decision per session per ten minutes, twenty per host per hour. */
export const DECIDE_SESSION_QUIET_MS = 10 * 60_000;
export const DECIDE_HOST_EACH = 20;
export const DECIDE_HOST_WINDOW_MS = 60 * 60_000;

/** The model is asked once. A retry is a second spend for the same evidence. */
export const DECIDE_TIMEOUT_MS = 8_000;

/**
 * How many hosts' and sessions' windows survive a rebuild. At the widest rows
 * restore admits, a host's DECIDE_HOST_EACH times and a 128-byte id and a
 * session's 300-byte key, 128 of each is about 94 KB, inside the 128 KiB a
 * Durable Object value holds; 256 was 188 KB, which test/do-key-bounds.test.js
 * caught. A host dropped past that starts its hour again, which is what every
 * host did before this was kept.
 */
export const MAX_DECIDE_WINDOW_ROWS = 128;

/** The warn line, once a day, when the spend crosses this share of the budget. */
const WARN_AT = 0.8;

/**
 * The day's budget from `[vars]`, clamped. Absent or unreadable is the
 * default; a number above the ceiling is the ceiling, so a typo of an extra
 * zero costs a dollar and not ten.
 *
 * @param {unknown} raw
 */
export function decideBudget(raw) {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DECIDE_NEURONS_PER_DAY;
  return Math.min(Math.floor(n), MAX_DECIDE_NEURONS_PER_DAY);
}

/**
 * The input tokens every call costs before its state: the two pinned
 * questions and whatever the model wraps around them.
 *
 * THE DESIGN SAID bytes/3 OVER-ESTIMATES, AND ALONE IT DOES NOT. The first
 * harness run (2026-10-31) billed a 166-byte shell prompt at 423 input tokens
 * and the 771-byte masked trust dialog at 455: the state is the small part.
 * bytes/3 alone under-charged 148 of 152 calls. Across the run, tokens minus
 * bytes/3 was at most 388; 450 leaves room and under-charged none, at an
 * average of 1.6 times the real cost, which reconcile() then gives back.
 * Re-measure it with the harness when the questions change.
 */
export const DECIDE_OVERHEAD_TOKENS = 450;

/**
 * What a call of this many bytes of state is charged before it is made, on the high side on purpose.
 *
 * @param {number} bytes
 */
export function estimateNeurons(bytes) {
  return (DECIDE_OVERHEAD_TOKENS + Math.ceil(bytes / 3)) * NEURONS_PER_INPUT_TOKEN;
}

/**
 * The name of the first rule a decide frame breaks, or null when it may go to
 * the model. Cheapest first. `images` anywhere on the frame refuses: the fleet
 * never sends a picture of a terminal, and a frame that carries one was not
 * built by this fleet's host.
 *
 * @param {any} msg  the whole frame, not only its state
 * @returns {string|null}
 */
export function refuseUnlessMasked(msg) {
  if (msg && typeof msg === 'object' && 'images' in msg) return 'images';
  const state = msg?.state;
  if (typeof state !== 'string' || state.trim() === '') return 'no-state';
  if (new TextEncoder().encode(state).length > MASK_MAX_BYTES) return 'too-long';
  if (state.split('\n').length > MASK_MAX_LINES) return 'too-many-lines';
  for (const [name, re] of GATE_PATTERNS) if (re.test(state)) return name;
  return null;
}

/** 'YYYY-MM-DD' in UTC, the day Cloudflare's free allowance resets on. */
const utcDay = (/** @type {number} */ t) => new Date(t).toISOString().slice(0, 10);

/**
 * The day's spend and the two windows, with storage in mind.
 *
 * `neurons` is what the day has cost as far as the coordinator can tell:
 * each call is charged its estimate before it is made and reconciled to its
 * real input tokens after, so a call that never comes back stays charged at
 * the estimate. `refused` counts gate refusals only, so a number above zero
 * means some host's mask is wrong.
 */
export class DecideLimits {
  /**
   * @param {{ now?: () => number, budget?: unknown, log?: { warn: Function } }} [opts]
   */
  constructor({ now = () => Date.now(), budget = DEFAULT_DECIDE_NEURONS_PER_DAY, log = { warn() {} } } = {}) {
    this.now = now;
    this.budget = decideBudget(budget);
    this.log = log;
    /** @type {{ day: string, neurons: number, calls: number, refused: number, warned: boolean }} */
    this.spend = { day: utcDay(now()), neurons: 0, calls: 0, refused: 0, warned: false };
    /** @type {Map<string, number>} `${host}\n${session}` → when it was last asked about */
    this.sessions = new Map();
    /** @type {Map<string, number[]>} host → when each of its last hour's asks was */
    this.hosts = new Map();
  }

  #today() {
    const day = utcDay(this.now());
    if (this.spend.day !== day) this.spend = { day, neurons: 0, calls: 0, refused: 0, warned: false };
    return this.spend;
  }

  /**
   * A gate refusal, counted where the health surface reads it.
   *
   * NOT WRITTEN ON ITS OWN. The count rides along the next time the spend or
   * a window is stored. A frame the gate rejects is the common case of a
   * wrong mask, and writing the object for each one would be a storage write
   * per bad frame.
   */
  refused() {
    this.#today().refused++;
  }

  /**
   * The local refusal, without spending a window or the day. The platform
   * rate limit is one key for the whole fleet, so it is asked only when this
   * is null: a box already at its own cap, or a day already spent, cannot
   * take one of the fleet's 30 a minute.
   *
   * @param {string} hostId @param {string} session @param {number} bytes
   * @returns {'ratelimited'|'budget'|null}
   */
  blocked(hostId, session, bytes) {
    const now = this.now();
    const key = `${hostId}\n${session}`;
    if (now - (this.sessions.get(key) ?? -Infinity) < DECIDE_SESSION_QUIET_MS) return 'ratelimited';
    const recent = (this.hosts.get(hostId) || []).filter((t) => now - t < DECIDE_HOST_WINDOW_MS);
    if (recent.length >= DECIDE_HOST_EACH) return 'ratelimited';
    if (this.#today().neurons + estimateNeurons(bytes) > this.budget) return 'budget';
    return null;
  }

  /**
   * Whether a call of this size may be made now for this session, and if so,
   * spend its windows and pre-charge its estimate. Returns the refusal's
   * `why`, or null when the call may go ahead.
   *
   * @param {string} hostId @param {string} session @param {number} bytes
   * @returns {'ratelimited'|'budget'|null}
   */
  admit(hostId, session, bytes) {
    const why = this.blocked(hostId, session, bytes);
    if (why) return why;
    const now = this.now();
    const key = `${hostId}\n${session}`;
    const recent = (this.hosts.get(hostId) || []).filter((t) => now - t < DECIDE_HOST_WINDOW_MS);
    const spend = this.#today();
    const estimate = estimateNeurons(bytes);
    for (const [k, at] of this.sessions) if (now - at >= DECIDE_SESSION_QUIET_MS) this.sessions.delete(k);
    for (const [k, times] of this.hosts) if (now - times[times.length - 1] >= DECIDE_HOST_WINDOW_MS) this.hosts.delete(k);
    this.sessions.set(key, now);
    recent.push(now);
    this.hosts.set(hostId, recent);
    spend.neurons += estimate;
    spend.calls++;
    this.#warnOnce();
    return null;
  }

  /**
   * Replace a call's estimate with what it actually cost. A call whose usage
   * did not come back keeps its estimate, which over-charges rather than under.
   *
   * @param {number} bytes  the size admit() was charged for
   * @param {number|null} inputTokens  `usage.input_tokens`, when there was one
   */
  reconcile(bytes, inputTokens) {
    if (!Number.isInteger(inputTokens) || /** @type {number} */ (inputTokens) < 0) return;
    const spend = this.#today();
    spend.neurons = Math.max(0, spend.neurons - estimateNeurons(bytes) + /** @type {number} */ (inputTokens) * NEURONS_PER_INPUT_TOKEN);
  }

  #warnOnce() {
    const spend = this.spend;
    if (spend.warned || spend.neurons < WARN_AT * this.budget) return;
    spend.warned = true;
    this.log.warn(
      `coordinator: decide has spent ${Math.round(spend.neurons)} of ${this.budget} neurons today (${spend.calls} calls); it stops asking at the budget and starts again at 00:00 UTC`,
    );
  }

  /** What the health surface shows: `decide: { today, budget, calls, refused }`. */
  snapshot() {
    const spend = this.#today();
    return { today: Math.round(spend.neurons * 100) / 100, budget: this.budget, calls: spend.calls, refused: spend.refused };
  }

  /** For storage, under `decide`. Only what is still inside its window, and at most MAX_DECIDE_WINDOW_ROWS of each, newest first. */
  serialise() {
    const now = this.now();
    const sessions = [...this.sessions]
      .filter(([, at]) => now - at < DECIDE_SESSION_QUIET_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_DECIDE_WINDOW_ROWS);
    const hosts = [...this.hosts]
      .map(([h, times]) => /** @type {[string, number[]]} */ ([h, times.filter((t) => now - t < DECIDE_HOST_WINDOW_MS)]))
      .filter(([, times]) => times.length)
      .sort((a, b) => b[1][b[1].length - 1] - a[1][a[1].length - 1])
      .slice(0, MAX_DECIDE_WINDOW_ROWS);
    return { spend: { ...this.#today() }, sessions, hosts };
  }

  /**
   * Back from storage, each row checked as if a stranger wrote it. A spend
   * from another day is dropped; one from today is taken as it is, including
   * its neurons, which is the whole point.
   *
   * @param {unknown} saved
   */
  restore(saved) {
    const now = this.now();
    const s = /** @type {any} */ (saved);
    const at = (/** @type {unknown} */ t, /** @type {number} */ window) => typeof t === 'number' && Number.isFinite(t) && t <= now && now - t < window;
    const count = (/** @type {unknown} */ n) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0);
    const spend = s?.spend;
    if (spend && spend.day === utcDay(now)) {
      this.spend = { day: spend.day, neurons: count(spend.neurons), calls: Math.floor(count(spend.calls)), refused: Math.floor(count(spend.refused)), warned: spend.warned === true };
    }
    const rows = (/** @type {unknown} */ list) => (Array.isArray(list) ? list.slice(0, MAX_DECIDE_WINDOW_ROWS) : []);
    for (const row of rows(s?.sessions)) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || row[0].length > 300 || !at(row[1], DECIDE_SESSION_QUIET_MS)) continue;
      this.sessions.set(row[0], row[1]);
    }
    for (const row of rows(s?.hosts)) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || row[0].length > 128 || !Array.isArray(row[1])) continue;
      const times = row[1].filter((/** @type {unknown} */ t) => at(t, DECIDE_HOST_WINDOW_MS)).sort((/** @type {number} */ a, /** @type {number} */ b) => a - b).slice(-DECIDE_HOST_EACH);
      if (times.length) this.hosts.set(row[0], times);
    }
  }
}
