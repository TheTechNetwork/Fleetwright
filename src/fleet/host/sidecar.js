// The sidecar: what runs on a fleet host.
//
// It dials the coordinator, validates every intent that arrives against the
// verb allowlist, and drives a STOCK agent-hub through its loopback HTTP API.
// agent-hub is not modified, not forked, and not aware of any of this — from
// its side the sidecar is just another HTTP client holding its token.
//
//     coordinator ──ws──▶ sidecar ──http──▶ 127.0.0.1:8790 (agent-hub) ──▶ tmux
//                          │
//                          └── validates, translates, repairs
//
// --- what the sidecar is for -----------------------------------------------
//
// §5's principle: the coordinator sends INTENTS, never commands. Down the
// socket comes
//
//     {v: 1, kind: "intent", id: "…", verb: "resume", params: {name: "bigjob"}}
//
// and never a shell string, never a command line, never a path. The failure
// being designed against is not a bug in the coordinator but the coordinator
// compromised outright — bad deploy, leaked API token, dependency — while it
// drives boxes running unsupervised shells. With a fixed verb set the blast
// radius is "someone started and stopped some sessions". With command strings
// it is every box in the fleet.
//
// Running out-of-process sharpens that rather than softening it. agent-hub's
// `POST /api/command` will run ANY command line it is given, `/login` included,
// and the sidecar is the only thing holding its token. So the allowlist here is
// not defence in depth — it is THE defence, and the command line is assembled
// from literals in this file and never received from the wire.
//
// --- the trade this makes ---------------------------------------------------
//
// One thing genuinely gets worse out-of-process, and it should be stated rather
// than discovered: agent-hub hardcodes `actor: 'web'` for every HTTP caller, so
// `createdBy` on a session the fleet starts will read "web", not who asked. The
// sidecar knows the real actor and puts it in its own logs and replies, but it
// cannot make agent-hub record it. That is design.md §1's flat-allowlist gap,
// and it is fixable upstream or in the coordinator — not from here.
//
// One thing gets better: the sidecar re-derives Remote Control URLs from the
// pane itself (see host/pane.js) instead of trusting the ones agent-hub
// recorded with its unguarded matcher, which are truncated or missing outright
// on any pane that is not exactly 80 columns wide.

import os from 'node:os';
import { validateIntent, isMutating, PROTOCOL_VERSION } from '../protocol/intents.js';
import { HubError } from './hub-client.js';
import { reconcileRcUrl, extractRcUrl, isRemoteControlOnline } from './pane.js';
import { SessionWatcher } from './watcher.js';
import { promptId, describePrompt } from './prompt.js';
import { redactCommandLine } from '../../core/redact.js';
import { emailFromActor } from '../../core/accounts.js';

/** @typedef {typeof import('../../log.js').log} Logger */

// The sidecar is a library as much as an entrypoint, so it says nothing unless
// it is given somewhere to say it. bin/agent-fleet-sidecar passes the real
// logger; tests pass one that captures.
/** @type {Logger} */
const SILENT = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// A replayed /stop is harmless; a replayed /new is not — it burns a slot
// against the concurrency cap and starts work nobody asked for twice. So every
// mutating intent carries an idempotency key and its result is remembered.
export const REPLAY_TTL_MS = 10 * 60_000;
const REPLAY_MAX = 512;

// How many panes to read at once when enriching a session list. Loopback HTTP
// is cheap but each one is a `tmux capture-pane` on the host, and a box at its
// cap has only a handful of sessions anyway.
const PEEK_CONCURRENCY = 4;

/**
 * @typedef {object} Transport
 * @property {string} origin  the coordinator origin this transport is pinned to
 * @property {(handler: (msg: unknown) => Promise<void>) => void} onMessage
 * @property {(msg: object) => void|Promise<void>} send
 * @property {() => Promise<unknown>} start
 * @property {() => Promise<unknown>} stop
 */

export class Sidecar {
  /**
   * @param {{
   *   hub: import('./hub-client.js').HubClient,
   *   transport: Transport,
   *   hostId?: string,
   *   labels?: string[],
   *   maxSkewMs?: number,
   *   logger?: Logger,
   *   healthIntervalMs?: number,
   *   promptText?: boolean,
   *   idleRestartMs?: number,
   *   watch?: boolean,
   *   updates?: (() => { appBehind: number|null, system: string|null, rebootRequired: boolean })|null,
   *   version?: (() => { head: string|null, branch: string|null }|null)|null,
   * }} opts
   */
  constructor({ hub, transport, hostId, labels = [], maxSkewMs = 300_000, logger = SILENT, healthIntervalMs = 15_000, watch = true, updates = null,
    version = null,
    promptText = false,
    idleRestartMs = 0,
  }) {
    // The acceptance window must be shorter than the replay cache's memory.
    // Otherwise there is a band — older than the cache, younger than the skew
    // limit — where a replayed `start` passes the freshness check against a
    // cache that has already forgotten it, and runs a second time. That is the
    // exact failure the idempotency key exists to prevent, reintroduced by two
    // constants drifting apart.
    if (maxSkewMs >= REPLAY_TTL_MS) {
      throw new Error(
        `maxSkewMs (${maxSkewMs}) must be less than the replay cache TTL (${REPLAY_TTL_MS}), ` +
          'or a replay can outlive the memory of it',
      );
    }
    this.hub = hub;
    this.transport = transport;
    this.hostId = hostId || os.hostname();
    this.labels = labels;
    // Injected rather than read here: the sidecar knows about a coordinator
    // and an agent-hub, and nothing about git checkouts or package managers.
    /** @type {(() => { appBehind: number|null, system: string|null, rebootRequired: boolean })|null} */
    this.updates = updates;
    this.version = version;
    // Whether a prompt that quotes the session may leave the box.
    this.promptText = promptText;
    this.maxSkewMs = maxSkewMs;
    this.log = logger;
    this.healthIntervalMs = healthIntervalMs;
    /** @type {any} */
    this.healthTimer = null;
    // Watching is what turns "a session needs you" into a notification on a
    // phone. Off in tests, which drive tick() directly.
    this.watcher = watch
      ? new SessionWatcher({
          hub,
          emit: (event) => this.emitEvent(event),
          allowSessionText: promptText,
          idleRestartMs,
          logger,
        })
      : null;
    /** @type {Map<string, { at: number, reply: Promise<object> }>} */
    this.replay = new Map();
  }

  get name() {
    return 'sidecar';
  }

  async start() {
    // §5: the agent pins the expected coordinator origin. Refusing to start
    // without one is the point — a transport that will talk to whoever answers
    // is the same shape of mistake as accepting command strings.
    if (!this.transport.origin) {
      throw new Error('sidecar: refusing to start without a pinned coordinator origin');
    }
    this.transport.onMessage((msg) => this.#onMessage(msg));
    await this.transport.start();

    // Health is PUSHED rather than waited for. A coordinator that has to ask
    // needs a timer per host, and in a Worker that means a Durable Object alarm
    // — far too coarse a tool for a 15-second heartbeat. The host knows its own
    // state; it can say so.
    if (this.healthIntervalMs > 0) {
      this.healthTimer = setInterval(() => void this.#pushHealth(), this.healthIntervalMs);
      this.healthTimer.unref?.();
      void this.#pushHealth();
    }
    this.watcher?.start();
    this.log.info(`sidecar: ${this.hostId} → ${this.transport.origin} (protocol v${PROTOCOL_VERSION})`);
    return true;
  }

  async stop() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.watcher?.stop();
    await this.transport.stop();
  }

  /** Volunteer our health, so the coordinator never has to ask. */
  async #pushHealth() {
    try {
      await this.transport.send({ v: PROTOCOL_VERSION, kind: 'health', hostId: this.hostId, health: await this.health() });
    } catch (e) {
      this.log.warn(`sidecar: could not send health: ${/** @type {Error} */ (e).message}`);
    }
  }

  /**
   * Something happened that a person may want to know about right now.
   *
   * Fire and forget: an event that cannot be delivered is not worth holding a
   * session up for, and the coordinator will see the state on the next health
   * report anyway. What is lost is the immediacy, not the fact.
   *
   * @param {Record<string, any>} event
   */
  emitEvent(event) {
    try {
      this.transport.send({ v: PROTOCOL_VERSION, kind: 'event', hostId: this.hostId, ...event });
    } catch (e) {
      this.log.warn(`sidecar: could not send ${event.event}: ${/** @type {Error} */ (e).message}`);
    }
  }

  /** @param {unknown} msg */
  async #onMessage(msg) {
    const reply = await this.handle(msg);
    await this.transport.send(reply);
  }

  /**
   * Turn one inbound envelope into a reply. Exposed rather than private so a
   * test can drive it with no transport at all.
   *
   * Never throws. A coordinator that gets no answer cannot tell a refused
   * intent from a dead host, and "dead host" is the one it will retry.
   *
   * @param {unknown} msg
   * @returns {Promise<Record<string, any>>}
   */
  async handle(msg) {
    const checked = validateIntent(msg, { maxSkewMs: this.maxSkewMs });
    if (checked.ok === false) {
      const raw = /** @type {any} */ (msg);
      // The id may be exactly what is wrong with the envelope, so echo it only
      // when it is well-formed enough to correlate on.
      const id = typeof raw?.id === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(raw.id) ? raw.id : null;
      this.log.warn(`sidecar: refused an intent (${checked.code}): ${checked.error}`);
      return { v: PROTOCOL_VERSION, kind: 'reply', id, ok: false, text: checked.error, error: { code: checked.code } };
    }
    const intent = checked.intent;

    if (!isMutating(intent.verb)) return this.#run(intent);

    // Idempotency. The PROMISE is cached, not just the result, so a retry that
    // arrives while the first attempt is still in flight — which is exactly
    // when a retry arrives — waits for that attempt instead of starting a
    // second session.
    const cached = this.#recall(intent.id);
    if (cached) {
      this.log.info(`sidecar: ${intent.verb} ${intent.id} already handled — replaying the original reply`);
      return { ...(await cached), replayed: true };
    }
    const pending = this.#run(intent);
    this.#remember(intent.id, pending);
    return pending;
  }

  /**
   * @param {import('../protocol/intents.js').Intent} intent
   * @returns {Promise<Record<string, any>>}
   */
  async #run(intent) {
    /** @param {Record<string, unknown>} extra */
    const reply = (extra) => ({ v: PROTOCOL_VERSION, kind: 'reply', id: intent.id, ...extra });
    const actor = intent.actor ? `fleet:${intent.actor}` : 'fleet';

    try {
      // Two verbs never reach the command registry, because they read host
      // state rather than acting on a session.
      if (intent.verb === 'health') return reply({ ok: true, text: 'ok', health: await this.health() });

      if (intent.verb === 'peek') {
        const name = String(intent.params.name);
        const text = await this.hub.peek(name, Number(intent.params.lines || 0) || null);
        if (text === null) return reply({ ok: false, text: `"${name}" is not running.` });
        return reply({
          ok: true,
          text,
          name,
          rcUrl: extractRcUrl(text),
          remoteControl: isRemoteControlOnline(text),
        });
      }

      // Everything else goes through the same command registry Telegram, the
      // web UI and the CLI use, so a fleet command cannot behave differently
      // from the same command typed into chat — or exist when that one does not.
      const line = toCommandLine(intent);
      // Prose beside the line, never in it. The log prints only the line, so a
      // title never lands in the journal — it is a person's words about their
      // own work, and there is no reason for it to be in a log a whole box can
      // read.
      // THE PREFIXED ACTOR, not the bare one. This line read `intent.actor`
      // and that was a real vulnerability, not a tidiness point.
      //
      // `emailFromActor` answers only for `fleet:<email>` — the prefix is the
      // marker of "the coordinator verified this against an ID token", and
      // `/api/command` accepts a caller-supplied actor otherwise, so a bare
      // email there is a claim rather than a fact. The prefix was being built
      // four lines up and spent only on the log string, so everything
      // downstream that asked "who is this" got `null`: per-person Claude
      // credentials never resolved, the ownership filters in the coordinator
      // could never match, and — once connectors landed — a member's pasted
      // GitHub token was written to the box's shared row and seeded into
      // every other member's sessions.
      //
      // Deliberately not `actor` (which is 'fleet' when there is none): an
      // intent with no actor must still record NO actor, exactly as before.
      const meta = commandMeta(intent.verb, intent.params, intent.actor ? `fleet:${intent.actor}` : '');
      this.log.info(`sidecar: ${actor} → ${redactCommandLine(line)}`);
      const r = await this.hub.command(line, meta);

      const sessions = Array.isArray(r.sessions) ? await this.#enrich(r.sessions) : undefined;
      // A single-session reply gets the URL hoisted to the top level: §7 asks
      // for flat JSON and one round trip per action, because the consumer is a
      // Shortcut as often as it is an app.
      const single = sessions && sessions.length === 1 ? sessions[0] : null;
      return reply({
        ok: r.ok !== false,
        text: r.text ?? '',
        ...(sessions ? { sessions } : {}),
        ...(single?.rcUrl ? { rcUrl: single.rcUrl } : {}),
        ...(r.buttons ? { buttons: r.buttons } : {}),
        // What is connected, and what could be. Never a token — the shape of
        // the object is what guarantees that, and test/connectors.test.js
        // pins its keys for exactly this reason.
        ...(r.connections ? { connections: r.connections } : {}),
        // What a stored token can actually do, when it was just asked. Scope
        // names, an account, and what is absent — never the token.
        ...(r.check ? { check: r.check } : {}),
      });
    } catch (e) {
      if (e instanceof HubError) {
        // Kept distinct from a refusal on purpose: the coordinator should retry
        // an unreachable hub and must not retry a rejected command.
        this.log.error(`sidecar: ${intent.verb}: ${e.message}`);
        return reply({ ok: false, text: `agent-hub is not answering: ${e.message}`, error: { code: e.code } });
      }
      const err = /** @type {Error} */ (e);
      this.log.error(`sidecar: ${intent.verb} failed`, err);
      return reply({ ok: false, text: `${intent.verb} failed: ${err.message}`, error: { code: 'internal' } });
    }
  }

  /**
   * Repair the Remote Control URL on every running session in a reply.
   *
   * agent-hub's recorded `rcUrl` comes from a matcher that reads the raw pane
   * with no de-wrapping, so on any pane that is not exactly 80 columns it is
   * either truncated to something that loads and goes nowhere, or missing
   * entirely while the session reports as online. Reading the pane here and
   * re-extracting is the whole reason `peek` exists on the hub API.
   *
   * @param {any[]} sessions
   */
  async #enrich(sessions) {
    const running = sessions.filter((s) => s && s.status === 'running' && typeof s.name === 'string');
    /** @type {Map<string, string|null>} */
    const panes = new Map();

    for (let i = 0; i < running.length; i += PEEK_CONCURRENCY) {
      const batch = running.slice(i, i + PEEK_CONCURRENCY);
      await Promise.all(
        batch.map(async (s) => {
          // A pane that cannot be read is not a failure of the command that
          // asked — the session list is still the answer.
          panes.set(s.name, await this.hub.peek(s.name).catch(() => null));
        }),
      );
    }

    return sessions.map((s) => {
      if (!panes.has(s?.name)) return s;
      const r = reconcileRcUrl({ recorded: s.rcUrl, pane: panes.get(s.name) });
      if (r.repaired) {
        this.log.warn(
          `sidecar: ${s.name}: repaired the Remote Control URL from the pane (${r.reason}) — ` +
            `agent-hub had ${s.rcUrl ? JSON.stringify(s.rcUrl) : 'nothing'}`,
        );
      }
      return {
        ...s,
        rcUrl: r.url,
        ...(r.repaired ? { rcUrlRepaired: r.reason } : {}),
        // HOW LONG THIS PANE HAS LOOKED THE SAME. Health has carried it since
        // idle tracking shipped and the session list did not, so the app could
        // show "running" for a session that had not moved since Tuesday and
        // "running" for one mid-build, in the same font.
        //
        // A timestamp rather than a duration: the phone doing the arithmetic
        // is the only place it stays right while a screen is open. Null for a
        // session that is not running, and for one showing a prompt — that
        // pane is still because somebody has to answer it, which is the
        // opposite of idle.
        idleSince: this.watcher?.idleSince?.(s.name) ?? null,
      };
    });
  }

  /**
   * What the scheduler ranks on (§3).
   *
   * When the hub cannot be reached, capacity is reported as **null rather than
   * zero**. They are different facts: zero free slots means "full, try later",
   * null means "we do not know". §3's principle is that `unknown` is a state
   * with a reason, never a default that reads as benign — a scheduler that sees
   * 0 will simply skip this host, while one that sees null can say why.
   */
  async health() {
    const [load1, load5, load15] = os.loadavg();
    /** @type {Record<string, any>} */
    const base = {
      hostId: this.hostId,
      protocol: PROTOCOL_VERSION,
      labels: this.labels,
      loadavg: [load1, load5, load15],
      freeMemBytes: os.freemem(),
      totalMemBytes: os.totalmem(),
      uptimeSec: Math.round(os.uptime()),
    };

    try {
      const state = await this.hub.state();
      const sessions = /** @type {any[]} */ (Array.isArray(state.sessions) ? state.sessions : []);
      const running = sessions.filter((s) => s?.status === 'running').length;
      return {
        ...base,
        hub: { reachable: true, host: state.host ?? null },
        maxSessions: state.maxSessions ?? null,
        running,
        free: typeof state.maxSessions === 'number' ? Math.max(0, state.maxSessions - running) : null,
        // Resume is pinned: claude-<name> is a host-local volume, so a /resume
        // must land on the box holding it. This is how the coordinator knows
        // which box that is instead of round-robining onto one that does not.
        resumable: sessions.filter((s) => s?.status !== 'running' && s?.uuid).map((s) => s.name),
        // Every session this box holds, running or not, so the coordinator can
        // pin `stop`/`peek`/`status` too — not just `resume`. Names only: the
        // coordinator has no business caching conversation uuids or paths.
        sessions: sessions
          .filter((s) => s && typeof s.name === 'string')
          .map((s) => ({
            name: s.name,
            // What the session is about. The coordinator and the app show this;
            // everything that identifies a session still keys on the name.
            title: s.title ?? null,
            status: s.status,
            resumable: Boolean(s.uuid),
            // WHO STARTED IT, so the coordinator can refuse a member acting on
            // a session that is not theirs. Without this, visibility filtering
            // hides other people's sessions from a member's LIST while a
            // guessed name still stops them — privacy against reading with no
            // authorisation against acting.
            createdBy: s.createdBy ?? null,
            // WHERE the work is happening. The app showed a session with no
            // way to answer "which checkout is this?" — the commonest question
            // about a session somebody started yesterday, and the answer was
            // sitting in the registry the whole time.
            cwd: s.cwd ?? null,
            // HOW LONG it has been going. Sent as a timestamp rather than a
            // duration: a duration is stale the moment it is serialised, and
            // the phone doing the arithmetic is the only place it can be
            // right. Same reason the console freezes age counters when the
            // fleet is unreachable — a ticking clock over frozen data is the
            // most convincing lie a stale UI tells.
            startedAt: s.createdAt ?? null,
            // Whose Claude account it was seeded with: an email, or "shared".
            account: s.account ?? null,
            // WHAT IT IS ASKING, when it is asking. Without this the `answer`
            // verb exists and nothing can call it: a phone cannot offer
            // options it has never been told about, and asking the host again
            // per session would be a peek per row per refresh.
            //
            // describePrompt() decides what may leave the box — it emits
            // fields the host wrote, never pane text, and "don't ask me again"
            // is filtered everywhere. The promptId is what makes an answer
            // safe to act on later.
            prompt: this.#promptFor(s),
            // WHEN THIS PANE LAST CHANGED. A timestamp rather than a duration,
            // for the same reason startedAt is: the phone doing the arithmetic
            // is the only place it can stay right while a screen is open.
            //
            // Null for a session that is not running, and meaningless for one
            // showing a prompt — that pane is still because somebody has to
            // answer it, which is the opposite of idle.
            idleSince: this.watcher?.idleSince?.(s.name) ?? null,
          })),
        loggedIn: state.auth?.loggedIn === true,
        // The account this box runs on, for the app's settings screen: which
        // plan, which org, which address. Not a secret — it is what
        // `agent-hub login status` prints on the box — and it is the
        // difference between "sessions are failing" and "sessions are failing
        // because this box is on a plan that ran out".
        account: state.auth?.loggedIn
          ? {
              email: state.auth.email ?? null,
              plan: state.auth.subscriptionType ?? null,
              org: state.auth.orgName ?? null,
            }
          : null,
        // WHAT A SESSION WOULD GET, which `loggedIn` above does not answer.
        // `loggedIn` reports on the box's home directory; a sandboxed session
        // runs on a copy taken at volume creation, and the two came apart in
        // production — a box reporting itself logged in while every session
        // started on it came up logged out.
        //
        // Additive, and null on a host that is not sandboxed or is one release
        // behind. Null means CANNOT TELL and must not be rendered as a
        // problem: a fleet that flags every older host as broken teaches
        // people to ignore the flag.
        credential: state.credential ?? null,
        // What code this box is running, so the app can say "three commits
        // behind" without anybody opening a terminal. updates already computed
        // whether it is behind; this says what it IS.
        // What code this box is RUNNING, so the app can say "three commits
        // behind" without anybody opening a terminal. `updates` already says
        // whether it is behind; this says what it is. Injected like updates,
        // rather than shelling out from here: the sidecar has no business
        // knowing it was installed from git.
        version: this.version?.() ?? null,
        // WHAT IS STILL RECOVERABLE. Additive, so an older client ignores it
        // and a newer one can offer an undo — which is the whole point of a
        // bin that nobody can see is not a bin, it is a delay.
        // The recycle bin: names, titles, owners and when each one goes.
        // Never the conversation. `createdBy` travels because the coordinator
        // filters on it — a member must not see, or restore, somebody else's
        // forgotten work any more than their live work.
        bin: Array.isArray(state.bin)
          ? state.bin.map((/** @type {any} */ b) => ({
              name: b.name,
              title: b.title ?? null,
              createdBy: b.createdBy ?? null,
              deletedAt: b.deletedAt ?? null,
              expiresAt: b.expiresAt ?? null,
            }))
          : [],
        // What is out of date on this box, so a phone can say so without
        // anybody logging in to look. Both are cheap: the app check is cached
        // for fifteen minutes, and the system one reads what apt already knows
        // rather than refreshing anything.
        updates: this.#updates(),
      };
    } catch (e) {
      const err = /** @type {Error & {code?: string}} */ (e);
      this.log.warn(`sidecar: health could not reach agent-hub: ${err.message}`);
      return {
        ...base,
        hub: { reachable: false, reason: err.message, code: err.code || 'hub_unreachable' },
        maxSessions: null,
        running: null,
        free: null,
        resumable: null,
        sessions: null,
        loggedIn: null,
      };
    }
  }

  /** @param {string} id */
/**
   * The two "out of date" answers, folded into one small object.
   *
   * Failures are swallowed to null. A health report that throws because git
   * could not reach a remote would take a working host out of the fleet over
   * something that stops no session running.
   */
  /**
   * The live prompt for a session, in the shape a phone can act on.
   *
   * Read from the pane rather than from the record: "waiting" is a fact about
   * the screen, and the options are only meaningful if they are the ones
   * currently rendered. Cheap because the watcher is already capturing panes
   * on the same interval.
   *
   * @param {any} session
   */
  #promptFor(session) {
    if (session?.status !== 'running') return null;
    try {
      // From the watcher's cache: it is already the one process reading every
      // pane on an interval, and a peek per session per health tick would be
      // the same text fetched twice.
      const prompt = this.watcher?.promptFor?.(session.name);
      if (!prompt) return null;
      const shown = describePrompt(prompt, this.promptText);
      return { id: promptId(session.name, prompt), ...shown };
    } catch {
      // A prompt we cannot read is a prompt we do not offer. Never a reason
      // for health to fail.
      return null;
    }
  }

  #updates() {
    try {
      return this.updates?.() ?? null;
    } catch {
      return null;
    }
  }

  #recall(/** @type {string} */ id) {
    const hit = this.replay.get(id);
    if (!hit) return null;
    if (Date.now() - hit.at > REPLAY_TTL_MS) {
      this.replay.delete(id);
      return null;
    }
    return hit.reply;
  }

  /** @param {string} id @param {Promise<object>} reply */
  #remember(id, reply) {
    this.replay.set(id, { at: Date.now(), reply });
    // Insertion-ordered, so the oldest keys are at the front. Dropping the
    // oldest can only cause a re-execution of something from more than
    // REPLAY_MAX intents ago, which is not the retry window.
    for (const key of this.replay.keys()) {
      if (this.replay.size <= REPLAY_MAX) break;
      this.replay.delete(key);
    }
  }
}

/**
 * Build the agent-hub command line for a validated intent.
 *
 * Every part is either a literal from this file or a value that has already
 * been charset-checked by validateIntent, so this is assembly, not
 * interpolation. There is no point at which a coordinator-supplied string
 * reaches agent-hub as anything but a single token — which matters more here
 * than it would in-process, because `/api/command` will run whatever line it is
 * handed.
 *
 * @param {{ verb: string, params: Record<string, any>, actor?: string }} intent
 */
export function toCommandLine({ verb, params, actor }) {
  const p = params || {};
  // WHOSE credential, resolved HERE and never from a parameter.
  //
  // `scope: me` means the verified actor, whose email this host derives from
  // the actor string the coordinator resolved against an ID token. There is no
  // `email` parameter in this protocol and there must not be one: the moment
  // the caller can name the account row, "link my account" becomes "link an
  // account", and a compromised coordinator can aim it.
  const mine = emailFromActor(actor ? `fleet:${actor}` : null);
  switch (verb) {
    case 'list':
      return '/list';
    case 'status':
      return p.name ? `/status ${p.name}` : '/status';
    case 'start':
      // `mode` becomes a flag rather than passing through as text; the only two
      // values it can hold are the two literals below. `title` and `brief` are
      // deliberately NOT here — they are prose, they travel as fields on the
      // request, and commandMeta() below is what picks them up.
      return ['/new', p.name, p.mode === 'safe' ? '--safe' : p.mode === 'dangerous' ? '--dangerous' : null]
        .filter(Boolean)
        .join(' ');
    case 'resume':
      return p.choice ? `/resume ${p.name} ${p.choice}` : `/resume ${p.name}`;
    case 'stop':
      return `/stop ${p.name}`;
    case 'forget':
      return `/forget ${p.name}`;
    case 'logs':
      // Both tokens are constrained by the protocol — an enum and a bounded
      // integer — so nothing here can carry a space or a metacharacter.
      // `name` wins when both arrive: naming a session is the more specific
      // request. Every token is protocol-constrained — a name, an enum, or a
      // bounded integer.
      return ['/logs', p.name || p.service, p.lines].filter((x) => x !== undefined && x !== null).join(' ');
    case 'update':
      return p.restart === 'yes' ? '/update --restart' : '/update';
    case 'upgrade':
      // `--apply`, NOT `apply`. agent-hub's upgrade reads `flags.has('apply')`,
      // and parse() only puts a dash-prefixed token in flags — so a positional
      // `apply` was silently the reporting mode. The symptom was exact and
      // misleading: tapping "Apply upgrade" returned the CHECK text, ending in
      // the host's own hint, "/upgrade --apply to install them."
      //
      // `update` sent `--restart` and worked, which is why one of the pair
      // looked fine and the other looked broken. Two mappings, one convention,
      // and nothing checked that they agreed.
      return p.apply === 'yes' ? '/upgrade --apply' : '/upgrade';
    case 'reboot':
      // Bare `/reboot` is step one and returns the pin; pin + hostname is
      // step two. Both are `name`-typed, so neither can carry anything but
      // the characters a pin or a hostname has.
      return ['/reboot', p.pin, p.confirm].filter(Boolean).join(' ');
    case 'answer':
      // A digit and a hex id — both safe in a command line, unlike the free
      // text this verb exists to refuse. commandMeta carries nothing extra.
      return ['/answer', p.name, p.option, p.promptId].filter((x) => x !== undefined && x !== null).join(' ');
    case 'restore':
      return `/restore ${p.name}`;
    case 'purge':
      return `/purge ${p.name}`;
    case 'connect':
      // Claude's flow is not a token to paste — it is an OAuth login the CLI
      // drives in a pane on this box, and the URL comes back from that pane.
      // So `connect claude` is `/login`, and the two scopes are the two
      // commands that already existed:
      //
      //   me   → /login for <email>   the requester's own account, isolated in
      //                               its own CLAUDE_CONFIG_DIR, box untouched
      //   host → /login force         THE BOX itself, which is the original
      //                               no-SSH promise and is admin-only
      //
      // Refusing rather than defaulting when scope is `me` and the actor has
      // no email: an unattributed caller asking to link "their" account has
      // not named anybody, and picking the box for them would silently do the
      // admin-only thing.
      if (!p.provider) return p.scope === 'host' ? '/connect --host' : '/connect';
      if (p.provider === 'claude') {
        if (p.scope === 'host') return '/login force';
        if (!mine) throw new Error('connect me needs a signed-in identity — this caller has no email');
        return `/login for ${mine}`;
      }
      return `/connect ${p.provider}${p.scope === 'host' ? ' --host' : ''}`;
    case 'link':
      // The secret is protocol-constrained to printable ASCII with no
      // whitespace, quote or backslash, and cannot begin with a dash, so it is
      // one token on this line and can be neither split in two nor read as a
      // flag by the registry's parser. It is masked in every log between here
      // and the pane by src/core/redact.js — which is the reason `/code` and
      // `/link` are the two command words in that table.
      if (p.provider === 'claude') return `/code ${p.secret}`;
      // SCOPE HAS TO REACH THE HOST. It did not, and that made the
      // coordinator's admin gate a no-op for token providers: `scope: host`
      // and no scope at all produced the identical line, so the gate could be
      // stepped around by omitting a parameter that changed nothing. A
      // permission check on a value the enforcing end never sees is not a
      // permission check.
      return `/link ${p.provider} ${p.secret}${p.scope === 'host' ? ' --host' : ''}`;
    case 'verify':
      return `/verify ${p.provider}${p.scope === 'host' ? ' --host' : ''}`;
    case 'unlink':
      if (p.provider === 'claude') {
        if (p.scope === 'host') return '/login logout';
        if (!mine) throw new Error('unlink me needs a signed-in identity — this caller has no email');
        return `/accounts remove ${mine}`;
      }
      return `/unlink ${p.provider}${p.scope === 'host' ? ' --host' : ''}`;
    case 'renew':
      // Both are protocol-constrained the same way `link.secret` is — printable
      // ASCII, no whitespace, no quote, no dash to start — so they are two
      // tokens on this line that cannot be split or read as flags. Masked from
      // the provider name onwards by src/core/redact.js.
      return `/renew ${p.provider} ${p.clientId} ${p.refresh} ${p.client}`;
    default:
      // Unreachable: validateIntent has already refused anything not in VERBS,
      // and peek/health never get here. Throwing rather than returning a
      // plausible string keeps a future verb from silently doing nothing.
      throw new Error(`no command mapping for verb "${verb}"`);
  }
}

/**
 * The parts of an intent that are prose rather than command.
 *
 * Kept beside commandFor() on purpose: the two together are the whole
 * translation, and splitting them across the file is how one of them acquires a
 * parameter the other has never heard of.
 *
 * @param {string} verb
 * @param {Record<string, string|number>} [params]
 * @param {string} [actor]  the VERIFIED identity, as the coordinator resolved it
 * @returns {Record<string, string>}
 */
export function commandMeta(verb, params = {}, actor = '') {
  return {
    // WHO, on every verb, not just start.
    //
    // agent-hub hardcoded `actor: 'web'` for every HTTP caller, so every
    // session on every host recorded "web" as its creator — the coordinator
    // knew the verified email, the sidecar knew it, and then it was thrown
    // away one hop from the record that wanted it.
    //
    // This is the value that makes "whose session is this" answerable, which
    // everything in docs/accounts.md depends on.
    ...(typeof actor === 'string' && actor ? { actor } : {}),
    ...(verb === 'start' && typeof params?.title === 'string' ? { title: params.title } : {}),
    ...(verb === 'start' && typeof params?.brief === 'string' ? { brief: params.brief } : {}),
  };
}
