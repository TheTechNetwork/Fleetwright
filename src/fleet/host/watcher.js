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
export const AWAITING_RE =
  /Resume from summary|Resume full session|Do you want to proceed|Do you trust the files|Is this a project you created or one you trust/i;

/**
 * The CLI is drawing its own chrome, so it is not wedged.
 *
 * THIS IS THE SECOND VERSION AND THE FIRST ONE WAS WRONG, in the exact way an
 * outside reviewer predicted and a real capture then proved. It read:
 *
 *     /bypass permissions on|shift+tab to cycle|accept edits on|plan mode on/
 *
 * on the stated premise that "Claude Code draws its permission-mode line
 * whenever it is READY FOR INPUT and not while it is working". Captured from
 * tmux against CLI 2.1.234, that premise is FALSE. The mode line is drawn in
 * both states; only the parenthetical changes:
 *
 *     idle     ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
 *     working  ⏵⏵ auto mode on · 1 shell · ← for agents · ↓ to manage
 *
 * So in `bypass permissions` — which is what this fleet runs by default — a
 * session in the middle of a tool call matched "at rest". It would never be
 * restarted however wedged it got, and the apps showed it as "ready · idle"
 * while it was actively working. Both directions wrong, from one unverified
 * sentence about somebody else's TUI.
 *
 * WHAT THE PANE CAN ACTUALLY TELL US, having gone and looked: whether the CLI
 * is drawing at all. It cannot distinguish "working quietly" from "wedged" — a
 * frozen process keeps whatever it last painted, footer included — and no
 * regex over pane text ever will. That is a fact about the measurement, not a
 * gap in this pattern, and pretending otherwise produced both bugs.
 *
 * So the trigger is narrow on purpose: restart only when the pane shows none of
 * the CLI's chrome, which is as close to "it is not drawing" as this
 * measurement gets. Working, waiting and finished all keep their footer and are
 * all left alone — and of those three, left alone is right for every one.
 *
 * If this needs to fire more often the signal is process liveness, not more
 * clever reading of text. Written down in docs/sidecar.md rather than guessed
 * at again here.
 */
export const DRAWING_RE = /⏵⏵|shift\+tab to cycle|to manage\b|esc to interrupt/i;

/**
 * The CLI is READY FOR INPUT specifically — not merely alive.
 *
 * A narrower question than DRAWING_RE, with a different consumer. The restart
 * gate asks "is it wedged", and working and waiting are both "no". The app asks
 * "is this finished or is it busy", and those are opposite answers to somebody
 * deciding whether to look.
 *
 * The parenthetical is what separates them, verified against real captures:
 * `(shift+tab to cycle)` is drawn when the CLI is waiting for input and is
 * replaced by the running-shell hints while it works. It is the one part of
 * that line that means anything.
 */
export const READY_RE = /shift\+tab to cycle/i;

/**
 * How long we go on suppressing "finished" after starting a restart.
 *
 * The restart's own `/stop` is a status change like any other, and the watcher
 * reported it the way it reports every other one: "cc-brave-narwhal finished".
 * It had not finished. We stopped it, deliberately, one second earlier — and
 * telling somebody their session finished when we ended it ourselves is the
 * kind of small lie that costs the whole surface its credibility.
 *
 * Generous, because a resume can take most of a minute and the window only has
 * to outlive our own stop.
 */
const RESTART_QUIET_MS = 3 * 60_000;

/**
 * How many times a session may be restarted for idleness before we stop.
 *
 * Two, and the second one is the point: once covers the ordinary wedge, and a
 * session that goes straight back to idle after being restarted has a problem
 * a restart does not fix. Trying a third time only delays somebody finding
 * out.
 */
const DEFAULT_IDLE_RESTART_LIMIT = 2;

export class SessionWatcher {
  /**
   * @param {{
   *   hub: import('./hub-client.js').HubClient,
   *   emit: (event: Record<string, any>) => void,
   *   intervalMs?: number,
   *   allowSessionText?: boolean,
   *   idleRestartMs?: number,
   *   idleRestartLimit?: number,
   *   logger?: typeof import('../../log.js').log,
   * }} opts
   */
  constructor({
    hub,
    emit,
    intervalMs = DEFAULT_INTERVAL_MS,
    allowSessionText = false,
    idleRestartMs = 0,
    idleRestartLimit = DEFAULT_IDLE_RESTART_LIMIT,
    logger,
  }) {
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
     * @type {Map<string, { hash: string, since: number, atRest?: boolean }>}
     */
    this.idle = new Map();
    /**
     * How many times each session has been restarted for going idle, and when
     * the last one was.
     *
     * The cap is the whole reason this map exists. A session that is idle
     * because it is genuinely broken comes back and is idle again, and a
     * restarter with no memory would sit in that loop indefinitely — burning
     * a slot, and, worse, doing it silently.
     *
     * `at` is what makes the count clearable without clearing it instantly. A
     * restart ALWAYS moves the pane — that is what stopping and resuming does
     * — so "the pane changed" cannot on its own mean the restart worked, or
     * the budget resets one tick after every attempt and the cap never binds.
     * Recovery is the pane moving a full idle window LATER, which is the same
     * thing as the session having run that long without needing another one.
     * @type {Map<string, { count: number, at: number }>}
     */
    this.restarts = new Map();
    /**
     * Sessions we are stopping on purpose right now, and when we started.
     * See RESTART_QUIET_MS — this exists so our own `/stop` does not get
     * announced as the session finishing.
     * @type {Map<string, number>}
     */
    this.restarting = new Map();
    this.idleRestartMs = idleRestartMs;
    this.idleRestartLimit = idleRestartLimit;
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
      // THREE QUESTIONS, NOT ONE, and collapsing any pair has produced a bug:
      //   awaiting — a dialog is blocking it and a person must answer
      //   drawing  — the CLI is painting its own chrome, so it is not wedged
      //   ready    — it is waiting for input specifically, rather than working
      let atRest = false;
      let ready = false;
      /** @type {any} */
      let prompt = null;
      let rcUrl = session.rcUrl ?? null;
      if (!running) this.prompts.delete(name);
      if (running) {
        const pane = await this.hub.peek(name).catch(() => null);
        if (pane) {
          this.#noteIdle(name, pane);
          awaiting = AWAITING_RE.test(pane);
          atRest = DRAWING_RE.test(pane);
          ready = READY_RE.test(pane);
          // Kept beside the clock so health can report WHY a pane is still
          // without reading it a second time. "Still" is not one fact: a
          // finished session and a wedged one look identical on a timer and
          // are opposites to a person.
          const entry = this.idle.get(name);
          if (entry) entry.atRest = ready;
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
          // NOT WHEN WE STOPPED IT. A restart's own `/stop` is a status change
          // like any other, and this reported it the way it reports every
          // other one — "cc-brave-narwhal finished", one second after we ended
          // it ourselves. An error still gets through: that is a fact about
          // the session rather than about our own action.
          const ours = this.#restartingRecently(name);
          if (!ours || session.status === 'error') {
            this.#fire(quiet, {
              event: session.status === 'error' ? 'session.error' : 'session.ended',
              name,
              text: session.detail,
            });
          }
        }
        // The transition, not the state — a session parked at a prompt is one
        // notification, not one every twenty seconds until somebody answers.
        if (!before.awaiting && awaiting) {
          this.#fire(quiet, this.#awaiting(name, session, prompt));
        }
      }

      // AUTO-RESTART, last, and only for a session that is running, not
      // asking anything, and has been frozen longer than the threshold. Each
      // of those three is load-bearing — see #maybeRestartIdle.
      // A PANE THE CLI IS STILL PAINTING IS NOT A WEDGED ONE, whether it is
      // waiting, working or finished. All three exclusions are the same shape:
      // a still pane is not evidence of a problem when there is a perfectly
      // good reason for it to be still, and there usually is.
      if (running && !awaiting && !atRest) await this.#maybeRestartIdle(name, quiet);

      this.seen.set(name, { status: session.status, awaiting, rcUrl });
    }

    // A session the hub has forgotten is gone; keeping it would mean it fires
    // "ended" again if the name is ever reused.
    for (const name of [...this.seen.keys()]) if (!live.has(name)) this.seen.delete(name);
    for (const name of [...this.idle.keys()]) if (!live.has(name)) this.idle.delete(name);
    for (const name of [...this.restarts.keys()]) if (!live.has(name)) this.restarts.delete(name);
    for (const name of [...this.restarting.keys()]) if (!live.has(name)) this.restarting.delete(name);
  }

  /**
   * Restart a session whose pane has stopped moving.
   *
   * "Auto restart sessions that are idle." The useful case is a session that
   * wedged overnight — the agent stopped, or the CLI lost its connection —
   * where the fix is mechanical and nobody was awake to do it.
   *
   * THREE THINGS IT MUST NOT DO, and each one is a condition somewhere:
   *
   *  - **Never a session at a prompt.** A pane waiting for an answer is
   *    perfectly still and is the most active thing in the fleet: somebody has
   *    to answer it. Restarting would throw the question away, and the person
   *    who was about to answer it would never learn why. Excluded by the
   *    caller, which has `awaiting` in hand from the same pane read.
   *  - **Never forever.** A session that is idle because it is broken comes
   *    back broken. The count is cleared only when the pane actually moves, so
   *    the limit counts restarts THAT DID NOT WORK rather than restarts.
   *  - **Never silently.** Both the restart and giving up are events, because
   *    a fleet that quietly restarts things is one nobody can debug — and the
   *    session's conversation history will not explain a gap it did not cause.
   *
   * Stop then resume, rather than anything cleverer: resume is the path that
   * keeps the conversation, and it is the same one a person would use. Its
   * volumes survive, so the credential is re-seeded on the way back up too.
   *
   * @param {string} name @param {boolean} quiet
   */
  async #maybeRestartIdle(name, quiet) {
    if (!this.idleRestartMs) return; // off, which is a supported answer
    const since = this.idle.get(name)?.since;
    if (!since || Date.now() - since < this.idleRestartMs) return;

    const already = this.restarts.get(name)?.count ?? 0;
    if (already >= this.idleRestartLimit) return; // said once, below, when it hit the cap

    const minutes = Math.round((Date.now() - since) / 60_000);
    this.restarts.set(name, { count: already + 1, at: Date.now() });
    // Restart the clock BEFORE the work, not after. Stopping and resuming
    // takes tens of seconds, and a tick landing in the middle of it would read
    // the same frozen pane and start a second restart of the same session.
    // The hash is kept as it was: the next read is expected to differ, and it
    // differing proves nothing on its own — see this.restarts.
    this.idle.set(name, { hash: this.idle.get(name)?.hash ?? '', since: Date.now() });

    // Marked before the stop, so our own stop is not announced as the session
    // finishing on whichever tick observes it.
    this.restarting.set(name, Date.now());
    let ok = false;
    try {
      await this.hub.command(`/stop ${name}`);
      const resumed = await this.hub.command(`/resume ${name} summary`);
      ok = /** @type {any} */ (resumed)?.ok !== false;
      this.log.info(`watcher: ${name} was idle ${minutes}m — restarted (attempt ${already + 1})`);
    } catch (e) {
      // A failed restart is not a reason to keep trying every tick — the
      // attempt is already counted above, deliberately before the work.
      this.log.warn(`watcher: could not restart ${name}: ${/** @type {Error} */ (e).message}`);
    }

    // ONE MESSAGE, NOT TWO. These used to be separate events, so hitting the
    // cap sent "Restarted after 60 minutes with nothing happening" AND
    // "Restarted 2 times and it went straight back to idle" — arriving
    // together, the second contradicting the tone of the first, for one
    // decision. An interruption costs far more than the time it takes to read;
    // spending two on one event is spending one of them against the person.
    const last = already + 1 >= this.idleRestartLimit;
    this.#fire(quiet, {
      event: last ? 'session.stuck' : 'session.restarted',
      name,
      text: !ok
        ? `Tried to restart it after ${minutes} minutes idle and the resume did not take.`
        : last
          // Says what happens next, which is nothing. A message that only
          // reports a failure leaves somebody waiting for a retry that is not
          // coming.
          ? `Restarted it ${already + 1} times and it went straight back to idle. Not trying again — `
            + 'something is wrong that a restart does not fix.'
          : `Restarted after ${minutes} minutes with nothing happening. The conversation was kept.`,
    });
  }

  /**
   * Did we stop this session ourselves a moment ago?
   *
   * @param {string} name
   */
  #restartingRecently(name) {
    const at = this.restarting.get(name);
    if (at === undefined) return false;
    if (Date.now() - at > RESTART_QUIET_MS) {
      this.restarting.delete(name);
      return false;
    }
    return true;
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
    if (before && before.hash === hash) return;
    this.idle.set(name, { hash, since: Date.now(), atRest: this.idle.get(name)?.atRest ?? false });
    // RECOVERED, and only then. A restart always moves the pane, so "it moved"
    // cannot mean "the restart worked" — that reset would fire one tick after
    // every attempt and the cap would never bind. What does mean it: the pane
    // still moving a full idle window after the last restart, which is the
    // same thing as the session having run that long without needing another.
    //
    // The limit then counts restarts that did not help, which is the number
    // worth capping. A long-lived session that wedges once a week is not the
    // same problem as one that wedges every time it comes up.
    const restarted = this.restarts.get(name);
    if (restarted && this.idleRestartMs && Date.now() - restarted.at >= this.idleRestartMs) {
      this.restarts.delete(name);
    }
  }

  /**
   * When this session's pane last changed, or null if it is not being watched.
   * @param {string} name
   */
  idleSince(name) {
    return this.idle.get(name)?.since ?? null;
  }

  /**
   * Is this session's pane READY FOR INPUT — finished, or between things?
   *
   * Narrower than the restart gate on purpose, and the two were briefly one
   * value: a working session is not wedged (do not restart) and is also not
   * ready (do not call it idle). One boolean could not say both, and the
   * version that tried told the apps a session running a build was "ready".
   *
   * The difference between "done" and "stuck", which a timer cannot see. The
   * app showed "quiet for 3h" for both, which is true of each and useful about
   * neither: the whole question somebody opens the app to ask is which one it
   * is.
   *
   * @param {string} name
   */
  atRest(name) {
    return this.idle.get(name)?.atRest ?? false;
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
