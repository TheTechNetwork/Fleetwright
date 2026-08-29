// Noticing that a session needs a person, and saying so.
//
// design.md §3's third meaning of "wake": push when a session needs you. The
// other two — resume a stopped session, wake a sleeping box — are things
// somebody already decided to do. This one is the only one where the machine
// knows something the person does not, which is exactly why it is the one that
// makes a phone app worth carrying.
//
// It works by polling the session manager, not by being told. agent-hub has no
// event stream, and adding one would be a change to a tree we are trying to
// keep contributable — whereas /api/state is cheap (two tmux calls) and the
// resume dialog it detects has been sitting in a pane for minutes by the time
// anyone notices. A 20-second poll is not the bottleneck.
//
// WHAT IT WILL NOT DO IS SPAM. An event fires on a TRANSITION, never on a
// state. A session sitting at a prompt for an hour is one notification, not
// 180 — because the second one tells you nothing the first did not, and a phone
// that cries wolf gets its notifications turned off, which costs you the one
// that mattered.

import { isRemoteControlOnline, extractRcUrl } from './pane.js';
import { readPrompt, promptId, describePrompt } from './prompt.js';

const DEFAULT_INTERVAL_MS = 20_000;

/** Text in a pane that means a person is needed.
 *
 *  Still here, and still the backstop: prompt.js recognises the shapes it can
 *  describe, and this catches the case where a person is plainly needed and we
 *  cannot say why. "Something is waiting" is worth a notification even when the
 *  question is not one we know how to read. */
const AWAITING_RE = /Resume from summary|Resume full session|Do you want to proceed|Do you trust the files/i;

export class SessionWatcher {
  /**
   * @param {{
   *   hub: import('./hub-client.js').HubClient,
   *   emit: (event: Record<string, any>) => void,
   *   intervalMs?: number,
   *   allowSessionText?: boolean,
   *   logger?: typeof import('../../log.js').log,
   * }} opts
   */
  constructor({ hub, emit, intervalMs = DEFAULT_INTERVAL_MS, allowSessionText = false, logger }) {
    /** The last prompt read per session, so health need not peek again. */
    this.prompts = new Map();
    /**
     * How long each session's pane has looked exactly the same.
     *
     * Free, because the pane is already being read every tick to find prompts
     * — this is one hash of text that is in hand. `{ hash, since }` per
     * session: when the hash changes the clock restarts, and `since` is the
     * moment it last stopped changing.
     *
     * IDLE IS NOT THE SAME AS DONE. A session waiting at a prompt has a still
     * pane and is the most active thing in the fleet: somebody has to answer
     * it. Anything acting on idleness has to exclude those, which is why the
     * prompt is tracked in the same pass.
     * @type {Map<string, { hash: string, since: number }>}
     */
    this.idle = new Map();
    this.hub = hub;
    this.emit = emit;
    // Whether a prompt that quotes the session — a path, a command line — may
    // travel. Default off, and the default is the interesting part: the fuller
    // form goes to a lock screen, through Apple's and Google's servers, for a
    // fleet that may not belong to the person holding the phone.
    //
    // It costs less than it sounds. The question is always ours, because
    // prompt.js writes it; what this gates is the option LABELS on the two
    // kinds that can name a command. A resume prompt — the common one — is
    // unaffected either way.
    this.allowSessionText = allowSessionText;
    this.intervalMs = intervalMs;
    this.log = logger || { debug() {}, info() {}, warn() {}, error() {} };
    /**
     * What each session looked like last time. The whole point of the watcher
     * is the difference between this and now.
     * @type {Map<string, { status: string, awaiting: boolean, rcUrl: string|null }>}
     */
    this.seen = new Map();
    /** @type {any} */
    this.timer = null;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    // Prime first, so the sessions already running when the sidecar starts do
    // not all announce themselves as brand new. A restart is not news.
    void this.tick({ quiet: true }).then(() => {
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
      this.timer.unref?.();
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  /**
   * One pass. Exposed so a test can drive it without waiting on a timer.
   * @param {{ quiet?: boolean }} [opts] quiet primes the state without emitting
   */
  async tick({ quiet = false } = {}) {
    /** @type {any} */
    let state;
    try {
      state = await this.hub.state();
    } catch {
      // The hub being down is already reported through health. It is not an
      // event, and it must not clear what we know about sessions — otherwise
      // every session "starts" again when it comes back.
      return;
    }

    const sessions = Array.isArray(state.sessions) ? state.sessions : [];
    const live = new Set();

    for (const session of sessions) {
      if (!session || typeof session.name !== 'string') continue;
      const name = session.name;
      live.add(name);
      const before = this.seen.get(name);
      const running = session.status === 'running';

      // Only a running session has a pane worth reading, and only a running
      // session can be waiting for anybody.
      let awaiting = false;
      /** @type {any} */
      let prompt = null;
      let rcUrl = session.rcUrl ?? null;
      if (!running) this.prompts.delete(name);
      if (running) {
        const pane = await this.hub.peek(name).catch(() => null);
        if (pane) {
          this.#noteIdle(name, pane);
          awaiting = AWAITING_RE.test(pane);
          // The pane is read either way. Reading the QUESTION out of it costs
          // one more pass over text already in hand, and is the difference
          // between a notification that says "resumed (summary)" and one that
          // says what is being asked.
          prompt = readPrompt(pane);
          rcUrl = extractRcUrl(pane) ?? rcUrl;
          // Kept so health can report what a session is ASKING without a
          // second peek per session per tick. The watcher is already the one
          // process reading every pane on an interval; anything else wanting
          // that text should take it from here rather than reading again.
          this.prompts.set(name, prompt);
          if (!before?.rcUrl && isRemoteControlOnline(pane) && rcUrl) {
            this.#fire(quiet, { event: 'session.rc-online', name, url: rcUrl });
          }
        }
      }

      if (!before) {
        // New to us. On a restart everything is new, which is why the first
        // pass is quiet.
        if (session.status === 'error') this.#fire(quiet, { event: 'session.error', name, text: session.detail });
        else if (awaiting) this.#fire(quiet, this.#awaiting(name, session, prompt));
      } else {
        if (before.status === 'running' && !running) {
          this.#fire(quiet, {
            event: session.status === 'error' ? 'session.error' : 'session.ended',
            name,
            text: session.detail,
          });
        }
        // The transition, not the state — a session parked at a prompt is one
        // notification, not one every twenty seconds until somebody answers.
        if (!before.awaiting && awaiting) {
          this.#fire(quiet, this.#awaiting(name, session, prompt));
        }
      }

      this.seen.set(name, { status: session.status, awaiting, rcUrl });
    }

    // A session the hub has forgotten is gone; keeping it would mean it fires
    // "ended" again if the name is ever reused.
    for (const name of [...this.seen.keys()]) if (!live.has(name)) this.seen.delete(name);
    for (const name of [...this.idle.keys()]) if (!live.has(name)) this.idle.delete(name);
  }

  /**
   * Track whether this pane is still moving.
   *
   * A cheap non-cryptographic hash, because the question is "did these bytes
   * change" and nothing here is deciding anything about a secret. The last
   * lines are what a working session churns, so the whole visible pane is
   * hashed rather than a tail — a spinner at the bottom of an otherwise static
   * screen is still work happening.
   *
   * @param {string} name @param {string} pane
   */
  #noteIdle(name, pane) {
    let h = 5381;
    for (let i = 0; i < pane.length; i++) h = ((h * 33) ^ pane.charCodeAt(i)) >>> 0;
    const hash = String(h);
    const before = this.idle.get(name);
    if (!before || before.hash !== hash) this.idle.set(name, { hash, since: Date.now() });
  }

  /**
   * When this session's pane last changed, or null if it is not being watched.
   * @param {string} name
   */
  idleSince(name) {
    return this.idle.get(name)?.since ?? null;
  }

  /** @param {boolean} quiet @param {Record<string, any>} event */
  /**
   * The prompt this session was last seen showing, or null.
   *
   * Exposed so health can report what a session is ASKING without a second
   * peek per session per tick — this watcher is already the one process
   * reading every pane on an interval.
   *
   * @param {string} name
   */
  promptFor(name) {
    return this.prompts.get(name) ?? null;
  }

  /**
   * The event for "this one needs you".
   *
   * It used to be `{event, name, text: firstPrompt(session)}`, and
   * firstPrompt returns `session.detail` — the registry's last lifecycle
   * string. So the notification said "resumed (summary)" or "/new (safe)". The
   * one event whose entire job is to tell you what a session wants was the one
   * event that could not.
   *
   * @param {string} name
   * @param {any} session
   * @param {any} prompt
   */
  #awaiting(name, session, prompt) {
    if (!prompt) {
      // Recognised as waiting, not recognised as a question. Honest about it.
      return { event: 'session.awaiting-input', name, text: firstPrompt(session) };
    }
    const shown = describePrompt(prompt, this.allowSessionText);
    return {
      event: 'session.awaiting-input',
      name,
      text: shown.question,
      prompt: {
        id: promptId(name, prompt),
        kind: prompt.kind,
        question: shown.question,
        options: shown.options,
      },
    };
  }

  /** @param {boolean} quiet @param {Record<string, any>} event */
  #fire(quiet, event) {
    if (quiet) return;
    this.log.info(`watcher: ${event.event} ${event.name ?? ''}`);
    this.emit(event);
  }
}

/** @param {any} session */
function firstPrompt(session) {
  return session?.detail || 'is waiting for input';
}
