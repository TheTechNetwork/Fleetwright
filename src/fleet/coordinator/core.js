// The coordinator, with no transport in it.
//
// Everything that carries a decision — the host registry, placement, the
// request/reply correlation, device registrations, turning a host event into a
// push — lives here and touches no runtime API. `node:http` + `ws.js` wrap it
// for the Node coordinator; a Durable Object wraps it for Cloudflare.
//
// That split is not tidiness. §4 chose Workers for the phone leg and Node is
// what makes the whole loop testable on one box, so this logic has to run in
// both or one of them becomes a second implementation that drifts.
//
// Nothing in here imports from `node:` — if that stops being true, the Worker
// build breaks, which is the check that keeps it honest.

import { HostRegistry } from './registry.js';
import { ClientRegistry, RUNNER_PREFIX } from './clients.js';
import { Invites } from './invites.js';
import { HostIdentities } from './hosts.js';
import { Enrollment } from './enrollment.js';
import { place } from './scheduler.js';
import { VERBS, PROTOCOL_VERSION, PROTOCOL_MIN, buildIntent, isMutating, checkParams, REPO_RE, JWT_RE, XOSETUP_JOB_RE, XOSETUP_STEPS, XOPOLICY_STEPS, CERT_PIN_RE } from '../protocol/intents.js';
import { SEAL_KEY_RE } from '../seal.js';
import { PendingAuthorizations, authorizeUrl, exchangeCode, cloudflareAuthorizeUrl, exchangeCloudflareCode, connectedText, DEVICE_STATE_RE, deviceReturnUrl } from './oauth.js';
import { checkPublicKey } from '../push-crypto.js';
import { Authorizations } from '../../mcp/oauth.js';
import { buildConfigFrame } from '../protocol/config-frame.js';
import { HEARTBEAT_PONG } from '../protocol/heartbeat.js';
import { RunnerTickets } from './runner-tickets.js';
import { RunnerRepos } from './runner-repos.js';
import { RUNNER_WORKFLOWS, DEFAULT_MINUTES as DEFAULT_RUNNER_MINUTES } from '../../core/runners.js';
import { SpentTokens } from './spent-tokens.js';

/**
 * How long a start waits for a host that has connected and not yet reported
 * (see #firstHealth). A little over the sidecar's 15-second health interval.
 */
const FIRST_HEALTH_WAIT_MS = 20_000;
const DEFAULT_INTENT_TIMEOUT_MS = 320_000;

/** How long a runner has, after enrolling, to report health and be given the
 * session it was asked for. A runner reports within seconds of enrolling; one
 * that has not in half an hour is a job that died, and its session with it. */
const RUNNER_START_TTL_MS = 30 * 60_000;

/** At most one waiting session per live ticket, so the same ceiling as the
 * tickets it came from (runner-tickets.js). Oldest out: a runner that has not
 * reported health while two hundred newer ones did is not coming. */
const MAX_RUNNER_STARTS = 200;
/**
 * Hypervisor setup jobs the coordinator remembers, and for how long. Twenty
 * because each row carries up to four Live Activity tokens of up to 400 hex
 * characters, and the whole store is one Durable Object value: twenty full
 * rows are about 45 KiB of the 128 a value may hold (test/do-key-bounds).
 */
const MAX_SETUPS = 20;
const SETUP_TTL_MS = 24 * 60 * 60_000;

/**
 * How many repository tokens one runner may ask for in MINT_WINDOW_MS. A runner
 * holds what it was given for most of an hour, so an honest one asks once per
 * repository; this is the ceiling on a dishonest or looping one, because every
 * ask costs a permanent box a few GitHub calls.
 */
const MAX_MINTS_PER_WINDOW = 30;
const MINT_WINDOW_MS = 10 * 60_000;

/**
 * How many times one runner may ask for its owner's Claude login in
 * MINT_WINDOW_MS. It asks once, when it joins; a few more is a reconnect or
 * two. Past that it is asking for something other than a login.
 */
const MAX_CLAUDE_PER_WINDOW = 5;

/** GitHub sign-ins and renewals one person's devices may finish in MINT_WINDOW_MS. */
const MAX_GITHUB_PER_WINDOW = 20;
// A person's vault changes: a phone listing, keeping and approving, a few at
// a time. Thirty in ten minutes is a busy afternoon and not a script.
const MAX_VAULT_PER_WINDOW = 30;
// A box asks for its vault every ten minutes and when a token is about to run
// out; twelve in ten minutes is that with room for reconnects.
const MAX_BOX_VAULT_PER_WINDOW = 12;
/** A frame id worth correlating on — the same shape a reply id is held to. */
const FRAME_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * The longest push token this fleet will store, and the most rows it will hold.
 *
 * BOTH NUMBERS EXIST FOR ONE REASON: every device row is serialised into a
 * SINGLE Durable Object value, and DO storage refuses a value over 128KiB. Past
 * that, `#saveDevices` throws, and it keeps throwing — the same failure the
 * event ring already had a post-mortem for, in the third key that never got the
 * same treatment (#351).
 *
 * The token bound was 4096. Real ones are nowhere near it: an APNs token is 64
 * hex characters, an FCM registration token about 180, and a Firebase
 * installation ID shorter than either — so 4096 was room for roughly thirty
 * rows to break every save, from a caller who only needed a credential and a
 * long string. 512 is generous against every token any provider this fleet
 * talks to actually issues, and there are only two.
 *
 * 150 rows at 512 bytes of token plus its metadata stays comfortably inside the
 * limit; `test/push.test.js` pins that arithmetic rather than this sentence.
 * A fleet with 150 phones on it is a large fleet.
 */
const MAX_PUSH_TOKEN = 512;
const MAX_DEVICES = 150;

/**
 * @typedef {object} Device
 * @property {string} id            opaque, minted at enrollment
 * @property {'ios'|'android'|'web'} platform
 * @property {string} token         APNs/FCM token
 * @property {string} [actor]       who this device belongs to
 * @property {string} [pushKey]     the phone's public key, when it sent one, so
 *                                  its notifications are sealed to it. Absent
 *                                  is not "no encryption configured" — it is
 *                                  this device falling back to plaintext, and
 *                                  `device.plaintext` is recorded when a row
 *                                  that had one comes back without it.
 * @property {string} [clientId]    the credential this registration belongs to,
 *                                  so revoking a phone stops the fleet talking
 *                                  to it. Optional only for registrations made
 *                                  before it existed.
 * @property {number} registeredAt
 */

export class CoordinatorCore {
  /**
   * @param {{
   *   now?: () => number,
   *   newId?: () => string,
   *   setTimer?: (fn: () => void, ms: number) => any,
   *   clearTimer?: (handle: any) => void,
   *   intentTimeoutMs?: number,
   *   firstHealthWaitMs?: number,
   *   logger?: { info: Function, warn: Function, error: Function, debug: Function },
   *   push?: import('../push.js').Pusher|null,
 *   mailer?: { send: ((m: { to: string, subject: string, text: string }) => Promise<void>)|null, from: string|null }|null,
   *   githubApp?: { clientId?: string, clientSecret?: string, slug?: string }|null,
   *   cloudflareOauth?: { clientId?: string, clientSecret?: string, scopes?: string }|null,
   *   runnerRepo?: string|null,
   *   minter?: { mint: (ask: { repo: string, job: string, key: string }) => Promise<any>,
   *     claude?: (route: 'key'|'deposit'|'login', ask: Record<string, unknown>) => Promise<any>,
   *     runnerRepo?: (ask: { repo: string }) => Promise<any>,
   *     github?: (ask: { sealed: unknown }) => Promise<any>,
   *     vault?: (route: 'device'|'box', ask: Record<string, unknown>) => Promise<any> }|null,
   * }} [opts]
   */
  constructor({
    now = () => Date.now(),
    newId = () => crypto.randomUUID(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    intentTimeoutMs = DEFAULT_INTENT_TIMEOUT_MS,
    firstHealthWaitMs = FIRST_HEALTH_WAIT_MS,
    logger,
    push = null,
    // Sending an invitation email, when a deployment has set it up. Optional
    // and injected for the same reason `push` is: the core knows nothing about
    // Cloudflare bindings, and the Node coordinator has none.
    mailer = null,
    // The GitHub App, when a deployment has registered one. Absent is the
    // normal case for a fresh clone and is not an error: the paste route is
    // first-class, not a fallback. See docs/github-app.md.
    githubApp = null,
    // The Cloudflare OAuth client, same shape and same rule — absent means the
    // paste route, which stays first-class. `scopes` travels with the client
    // rather than being a constant here because Cloudflare scopes are chosen
    // at client registration, and only whoever registered it knows the list.
    // See docs/connectors.md.
    cloudflareOauth = null,
    // Where `provision` dispatches runner workflows, as `owner/repo`. Absent
    // is the normal case and is not an error — a fleet with no runner
    // repository refuses `provision` with the one line an operator needs,
    // rather than pretending it can start machines it has nowhere to start.
    // See docs/runner-central.md.
    runnerRepo = null,
    // THE MINTING WORKER, when the deployment binds one: a separate Worker that
    // holds the GitHub App key and mints runners their repository tokens. The
    // coordinator only relays to it and never holds the key — see
    // src/fleet/minter/answer.js. Absent means a permanent box that holds the
    // key is asked instead, and a fleet with neither mints nothing. Its
    // `claude` half keeps people's Claude logins for their own runners
    // (src/fleet/minter/claude.js), and is absent on a minter that predates it.
    minter = null,
  } = {}) {
    this.now = now;
    this.newId = newId;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.firstHealthWaitMs = firstHealthWaitMs;
    this.intentTimeoutMs = intentTimeoutMs;
    this.log = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.push = push;
    this.githubApp = githubApp;
    this.cloudflareOauth = cloudflareOauth;
    this.runnerRepo = runnerRepo;
    this.minter = minter;
    // Single-use, minutes-long, and minted only when this coordinator itself
    // dispatches a run — so a runner's owner is decided before the job exists
    // rather than by a reusable secret sitting in a repository. Separate store
    // and separate prefix from `runnerTokens` above, for the same reason that
    // one is separate from `clients`: a credential that cannot be confused for
    // another cannot be accepted in its place by a check somebody forgot.
    this.runnerTickets = new RunnerTickets({ now });
    /**
     * Hypervisor onboarding jobs, by the id the host made: which machine runs
     * each, whose it is, where it has got to, and the Live Activity tokens its
     * owner's phone registered for it.
     *
     * KEPT IN STORAGE on the Worker (serialiseSetups), not memory only, which
     * it was until a review found what that cost: the Durable Object is
     * evicted between messages as a matter of course, and a person reading a
     * fingerprint and typing a password is a gap it is evicted across. Every
     * later phase then answered `unknown_job`, and progress from a machine
     * still mid-run was dropped as coming from a job nobody had begun.
     * @type {Map<string, { hostId: string, owner: string|null, startedAt: number, last: SetupProgress|null, activities: string[] }>}
     */
    this.setups = new Map();
    // EACH PERSON'S OWN RUNNER REPOSITORY, when they set one — see
    // runner-repos.js for why a member may, and what bounds it.
    this.runnerRepos = new RunnerRepos({ now });
    /**
     * A session to start on a runner once it joins, keyed by the host id the
     * runner enrolled under. Set when a ticket carrying a start is spent,
     * spent on that host's first health frame. Bounded by time rather than
     * count: a runner that enrolled and never reported health is a job that
     * died, and its session is not going to happen.
     * @type {Map<string, { owner: string, start: { title?: string, brief?: string, mode?: string, task?: string }, until: number }>}
     */
    this.runnerStarts = new Map();
    /**
     * When each runner last asked for repository tokens, for the ceiling above.
     * Memory only: a coordinator restart forgetting it costs one more window.
     * @type {Map<string, number[]>}
     */
    this.mintAsks = new Map();
    /** The same, for Claude logins. @type {Map<string, number[]>} */
    this.claudeAsks = new Map();
    /**
     * In-flight GitHub authorizations, keyed by the `state` GitHub will hand
     * back. In memory rather than in storage on purpose: it lives ten minutes,
     * and a coordinator restart losing one costs somebody a second tap, while
     * persisting it would mean writing who-is-authorizing-what to disk.
     */
    this.pendingGithub = new PendingAuthorizations({ now });
    /**
     * Cloudflare's, in a separate store on purpose: a state minted for one
     * provider's callback must not be redeemable at the other's, and two maps
     * make that true without a check somebody could forget.
     */
    this.pendingCloudflare = new PendingAuthorizations({ now });
    /**
     * In-flight sign-ins from an MCP client, and the clients that have
     * registered. The remote MCP endpoint's OAuth lives here rather than in the
     * transport so BOTH coordinators get it from the same object — see
     * src/mcp/routes.js for why that is not a stylistic preference.
     */
    this.mcpAuthorizations = new Authorizations({ now });
    this.registry = new HostRegistry({ now });
    // An ephemeral host that drops is retired by the registry; the key it
    // enrolled with has to go with it, which only the core can do.
    this.registry.onRetired = (hostId, reason) => this.ephemeralHostRetired(hostId, reason);
    // Credentials issued to devices, one per phone, each revocable alone.
    this.clients = new ClientRegistry({ now });
    // The ID tokens that have already bought one of those. A token is
    // exchanged once; see spent-tokens.js for what a second exchange would
    // have been.
    this.spentTokens = new SpentTokens({ now });
    // REUSABLE, AND DELIBERATELY POWERLESS. A claim has to live in a repository
    // secret and be spent on every run, so a single-use code cannot be it —
    // and a device credential must not be, because that one authenticates API
    // calls. Same machinery, separate store, separate prefix: the authenticator
    // only ever consults `clients`, so one of these cannot authenticate
    // anything even if a check is forgotten. All it does is answer "whose
    // runner is this", after GitHub has already proved the job is real.
    this.runnerTokens = new ClientRegistry({ now, prefix: RUNNER_PREFIX });
    // Who the admin has let in since the deploy. The env allowlist says who
    // this deployment BELONGS to and survives losing all state; this says who
    // that person has invited, and is the half that does not need a deploy.
    // See src/fleet/coordinator/invites.js.
    this.invites = new Invites({ now });
    this.mailer = mailer;
    // Which machines are in the fleet. The authority, unlike `registry` above,
    // which is a cache of what those machines say about themselves.
    this.hostIds = new HostIdentities({ now });
    // Codes that admit a new host or device, once.
    this.enrollment = new Enrollment({ now });
    /** @type {Map<string, { resolve: (reply: any) => void, timer: any }>} */
    this.pending = new Map();
    /** @type {Map<string, Device>} */
    this.devices = new Map();
    /** Recent events, so a phone that was asleep can catch up on open. */
    /** @type {Array<Record<string, any>>} */
    this.events = [];
    /**
     * Called after the ring changes, so whoever owns storage can persist it —
     * a file on a box, Durable Object storage in the Worker. The core does not
     * know which, and must not: it is shared by both and imports nothing from
     * `node:`.
     * @type {(() => void)|null}
     */
    this.onEvents = null;
    /**
     * Called when something the coordinator must not forget has changed —
     * today only a minted runner ticket, which is spent by a job that starts
     * minutes later and may cross a restart or a Durable Object eviction on
     * the way. Same shape and the same reason as `onEvents`: the core does not
     * know whether storage is a file or a Durable Object, and must not.
     * @type {(() => void)|null}
     */
    this.onStateChanged = null;
  }

  // --- hosts ---------------------------------------------------------------

  /**
   * @param {string} hostId
   * @param {(msg: object) => void} send
   */
  hostConnected(hostId, send) {
    // THE ENROLMENT IS WHAT KNOWS, and until now nothing asked it. `connect`
    // has taken an `ephemeral` flag since the framework was built and no caller
    // ever passed one — so the registry's default of `false` applied to every
    // host, and `disconnect` kept the entry for a runner exactly as it would
    // for a real box. The retirement code could not fire, one layer below the
    // place the flag was already being dropped.
    const enrolled = this.hostIds?.get(hostId) ?? null;
    this.registry.connect(hostId, send, {
      ephemeral: Boolean(enrolled?.ephemeral),
      owner: enrolled?.owner ?? null,
    });
    this.log.info(`coordinator: ${hostId} connected`);
    // WHAT THIS HOST NEEDS AND MUST NOT KEEP. One frame, a fixed set of named
    // values, sent on every connect — so a host enrolled tomorrow gets it by
    // connecting, nothing is at rest on any box, and rotating a value here is a
    // deploy rather than a fan-out to N machines somebody has to remember.
    //
    // Failure is not fatal to the connection: a host with no client secret
    // cannot renew a GitHub token and can do everything else, and refusing the
    // socket over it would turn a degraded capability into an offline box.
    try {
      const frame = buildConfigFrame({
        githubClientSecret: this.githubApp?.clientSecret,
        cloudflareClientSecret: this.cloudflareOauth?.clientSecret,
        runnerRepo: this.runnerRepo,
      });
      if (frame) send(frame);
    } catch (e) {
      this.log.warn(`coordinator: could not send config to ${hostId}: ${/** @type {Error} */ (e).message}`);
    }
  }

  /**
   * Take a host out of the fleet: its key stops being accepted and it leaves
   * the live picture in the same act.
   *
   * Both coordinators used to revoke the key and then treat the socket closing
   * as an ordinary disconnect, which left the entry in `registry` as `offline`
   * — still listed, still in `snapshot()`, until a restart. The two halves
   * belong together, so they are one method, and the event is recorded here
   * rather than by whichever coordinator remembered to.
   *
   * @param {string} hostId
   * @returns {boolean} false when there was nothing live to revoke
   */
  revokeHost(hostId) {
    const gone = this.hostIds.revoke(hostId);
    if (!gone) return false;
    this.registry.remove(hostId);
    this.record({ event: 'host.revoked', hostId });
    return true;
  }

  /** @param {string} hostId @param {string} reason */
  hostDisconnected(hostId, reason) {
    this.registry.disconnect(hostId, reason);
    this.log.warn(`coordinator: ${hostId} disconnected (${reason})`);
  }

  /**
   * An ephemeral host has gone for good: forget its key as well as its entry.
   *
   * Without this the registry is clean and `enrolled` fills up instead — one
   * dead key per CI job, for ever, each of them a credential that would still
   * be accepted if the private half ever leaked out of a build log. A
   * throwaway host's key should not outlive the throwaway host.
   *
   * @param {string} hostId @param {string} reason
   */
  ephemeralHostRetired(hostId, reason) {
    this.hostIds.revoke(hostId);
    this.record({ event: 'host.retired', hostId, text: `temporary host went away (${reason})` });
    this.log.info(`coordinator: retired temporary host ${hostId} (${reason})`);
  }

  /**
   * Anything a host sends us.
   *
   * Three kinds, and the split matters: a `reply` answers something we asked,
   * `health` is volunteered, and an `event` is the host telling us something
   * happened that a human may want to know about right now. Only the last one
   * can wake a phone.
   *
   * @param {string} hostId
   * @param {any} msg
   */
  async onHostMessage(hostId, msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.kind === 'health' && msg.health) {
      const moved = this.registry.recordHealth(hostId, msg.health);
      // The outcome, not just the input: recordHealth silently ignores a host
      // the registry does not know, and during the outage that silence was
      // indistinguishable from the frame never arriving.
      const known = this.registry.list().find((h) => h.hostId === hostId);
      this.log.info(`coordinator: health from ${hostId} → ${known ? `${known.state}` : 'IGNORED — not in registry'}`);
      // A BOX THAT CANNOT START SESSIONS IS AT LEAST AS WORTH SAYING AS A
      // SESSION THAT NEEDS AN ANSWER, and until now it was said only in a
      // journal. deb132's shared credential expired on a Saturday afternoon;
      // fleetwright warned about it hourly for thirty hours, the coordinator
      // marked the host degraded, the app showed it — three storeys down in
      // Settings — and nobody was told. docs/psychology.md §7 is exactly this:
      // silence has to be trustworthy before it is comfortable, and a warning
      // that reaches a log file is silence.
      if (moved) await this.#onHostState(hostId, moved);
      // A RUNNER THAT WAS ASKED FOR WITH A SESSION gets it now. Only once the
      // hub answers: a frame from a box whose hub is still starting would place
      // the start and have it refused.
      if (this.runnerStarts.has(hostId) && msg.health?.hub?.reachable !== false) {
        void this.#startOnRunner(hostId);
      }
      return;
    }

    if (msg.kind === 'event') return this.#onHostEvent(hostId, msg);

    // A RUNNER ASKING FOR A REPOSITORY TOKEN. The one host-initiated request in
    // the protocol, and it is answered on the same socket by a `minted` frame.
    if (msg.kind === 'mint') return this.#onRunnerMint(hostId, msg);
    // AND FOR ITS OWNER'S CLAUDE LOGIN, answered the same way.
    if (msg.kind === 'claude-login') return this.#onRunnerClaude(hostId, msg);
    // ANY BOX ASKING FOR WHAT ITS PEOPLE APPROVED IT TO HOLD, the same way.
    if (msg.kind === 'vault') return this.#onHostVault(hostId, msg);

    // THE HEARTBEAT. "Are you there" wants "yes" and nothing else: no state
    // moves, no event is recorded, no log line — twenty hosts ask three times a
    // minute, for weeks. Answered here so both coordinators answer it
    // identically; on Cloudflare the runtime's auto-response usually gets there
    // first and this branch is what runs when it does not. A pong arriving here
    // is a host echoing us, and is dropped in the same silence.
    if (msg.kind === 'ping') {
      const host = this.registry.hosts.get(hostId);
      if (host?.connected && typeof host.send === 'function') {
        // The constant, not a fresh object: the sidecar compares bytes.
        try { host.send(JSON.parse(HEARTBEAT_PONG)); } catch { /* the socket is going; its close says so */ }
      }
      return;
    }
    if (msg.kind === 'pong') return;

    if (msg.kind !== 'reply' || typeof msg.id !== 'string') {
      this.log.warn(`coordinator: ${hostId} sent something that is not a reply, health or event`);
      return;
    }
    const waiter = this.pending.get(msg.id);
    if (!waiter) {
      // WARN, not debug. In the Worker, debug is a no-op — so when every reply
      // in an outage was somehow "late", the one line that said so was being
      // thrown away. A late reply is rare and interesting; a debug level that
      // eats it in production is how that stops being true.
      this.log.warn(`coordinator: late reply from ${hostId} for ${msg.id} — nothing was waiting`);
      return;
    }
    this.pending.delete(msg.id);
    this.clearTimer(waiter.timer);
    waiter.resolve({ ...msg, hostId });
  }

  /**
   * A host says something happened. This is §3's third meaning of "wake" — the
   * one that makes a phone app worth having, because it is the only one the
   * person is not already watching for.
   *
   * @param {string} hostId
   * @param {any} msg
   */
  async #onHostEvent(hostId, msg) {
    // ONBOARDING PROGRESS IS ITS OWN AUDIENCE: the job's owner, on the surfaces
    // that show progress, never the ring every phone reads.
    if (msg.event === 'xosetup.progress') return this.#onSetupProgress(hostId, msg);
    const event = {
      hostId,
      event: String(msg.event || 'unknown'),
      name: msg.name ? String(msg.name) : null,
      text: msg.text ? String(msg.text).slice(0, 500) : null,
      url: msg.url ? String(msg.url).slice(0, 500) : null,
      // The NAME of the profile a session was started with, when the host
      // says. A name, never content — docs/wanted.md's rule for profiles —
      // and the one fact that says whether "back at its prompt" is a job
      // handed over coming back finished, or a turn in a conversation.
      ...(msg.profile ? { profile: String(msg.profile).slice(0, 80) } : {}),
      // The same fact for a session handed its words directly (v7 `task`):
      // whether it had a job, never what the job said.
      ...(msg.tasked === true ? { tasked: true } : {}),
      at: this.now(),
    };
    // A TEMPORARY MACHINE THAT HAS FINISHED IS COSTING MONEY, and that is the
    // one sentence its owner needs more than "done". The host cannot know it
    // is temporary — the registry does, from the provision that made it — so
    // the text is completed here, where both halves are in hand.
    const ephemeral = Boolean(this.registry.get(hostId)?.ephemeral);
    if (event.event === 'session.ready' && ephemeral) {
      event.text = `${event.text || 'is back at its prompt'}. This is a temporary machine, and it keeps running, and costing, until it is stopped or its time is up.`;
    }
    // WHICH QUESTION, carried alongside rather than into the event.
    //
    // The host has always sent this and this method has always dropped it,
    // which is why a notification could say what a session was asking and not
    // which asking it was. An answer needs the id — the host refuses one aimed
    // at a question that has since been replaced — and the two buttons need to
    // know which digit each of them types.
    //
    // NOT ON `event`, deliberately. That object goes into the ring, which is
    // served by /api/events and read back by every phone the scoping rules let
    // through; push is filtered to the session's owner a few lines into
    // #notify, and this is the narrower of the two audiences. Putting it on the
    // event would widen who can see it for no reader that wants it there.
    const prompt = promptForPush(msg.prompt);
    // Bounded: a coordinator is not a log server, and an unbounded array in a
    // Durable Object is a memory leak with a long fuse.
    this.events.push(event);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    // Persisted by whoever owns storage — a file on a box, DO storage in the
    // Worker. The ring used to be RAM only, so "a phone that was asleep can
    // catch up" was false the moment anything restarted.
    this.onEvents?.();

    this.log.info(`coordinator: ${hostId} ${event.event}${event.name ? ` ${event.name}` : ''}`);
    // BACK AT ITS PROMPT IS NEWS TWICE AND NOISE OTHERWISE. A session that was
    // handed a job (a task or a profile) coming back is the "done" both beta testers
    // asked for; a session on a temporary machine coming back is a bill
    // still running. A turn in a conversation somebody is driving by hand is
    // neither — they are looking at it — and a buzz per turn is how the one
    // notification that matters gets switched off with the rest. The ring
    // keeps all of them; only the phone is selective.
    const worth = event.event !== 'session.ready' || Boolean(event.profile) || event.tasked === true || ephemeral;
    if (this.push && worth && NOTIFIABLE.has(event.event)) await this.#notify(event, prompt);
  }

  /**
   * A host changed state. Say so, once, in words about what it means.
   *
   * @param {string} hostId
   * @param {{ from: string, to: string, reason: string }} moved
   */
  async #onHostState(hostId, moved) {
    // NOT AGAIN, FOR THE SAME REASON, WITHIN THE HOUR.
    //
    // The registry's memory of a host's previous state is reset by `connect()`,
    // so every reconnect looks like a fresh transition — and a degraded box
    // reconnects for all the ordinary reasons: a service restart, an update, a
    // socket blip, the coordinator itself being replaced. That is the "cries
    // wolf" failure the watcher's transition rule exists to avoid, arriving
    // through the one path that had no such rule.

    // RECOVERY IS WORTH SAYING TOO. A person told a box is broken and never
    // told it came back checks manually forever after, which is the anxiety
    // this product exists to remove rather than relocate.
    const recovered = moved.to === 'healthy';
    // NOT EVERY TRANSITION IS NEWS, and the registry is right to report them
    // all — deciding what is worth a person's attention is this function's job,
    // not its bookkeeping's.
    //
    // `unknown` is what a host looks like while it is being restarted,
    // including by an update somebody just asked for. Going INTO it says
    // nothing (we lost contact, briefly, on purpose), and coming OUT of it into
    // health is the other half of the same non-event: every connect,
    // every deploy, every restart would ring a phone to say a box is fine.
    //
    // Coming out of unknown into DEGRADED is news, which is why this is not
    // simply "ignore anything touching unknown": a box that reboots and comes
    // back signed out is exactly the thing nobody found out about for thirty
    // hours.
    if (moved.to === 'unknown') return;
    if (moved.from === 'unknown' && recovered) return;

    // SUPPRESSED FROM THE EVENT RING, WHICH SURVIVES A RESTART. The first
    // version of this kept an in-memory map — and the coordinator is a Durable
    // Object that is replaced on every deploy, of which there were six in a
    // day. Every deploy emptied the map and re-announced every standing fault,
    // which is most of what "still spamming" was.
    //
    // The ring is already persisted for exactly this class of question, and a
    // notification we sent IS an event in it, so there is nothing new to store.
    const text = recovered
      ? `${hostId} is reporting normally again.`
      // The reason, verbatim: the registry works hard to make it specific, and
      // a notification saying "degraded" sends somebody to find out what this
      // line already knows.
      : `${hostId} cannot start sessions: ${moved.reason}`;
    const said = this.events.some(
      (e) => e.hostId === hostId
        && (e.event === 'host.degraded' || e.event === 'host.recovered')
        && e.text === text
        && this.now() - e.at < HOST_STATE_QUIET_MS,
    );
    if (said) return;
    const event = this.record({
      hostId,
      event: recovered ? 'host.recovered' : 'host.degraded',
      name: hostId,
      text,
    });
    // `record` writes to the ring; it does not notify. Only host-originated
    // events did, which is part of how this whole class of fact stayed
    // invisible — the coordinator's own observations went to a log and a list
    // nobody opens.
    if (this.push && NOTIFIABLE.has(event.event)) await this.#notify(event);
  }

  /**
   * Record something the coordinator itself did, as opposed to something a
   * host reported.
   *
   * Enrolment and revocation belong in the same stream as sessions starting
   * and stopping: when somebody asks "how did that machine get in", the answer
   * should be in one place and not in a log nobody kept.
   *
   * @param {{ event: string, hostId?: string|null, name?: string|null, text?: string|null, fingerprint?: string, actor?: string|null, verb?: string|null, url?: string|null }} entry
   */
  record(entry) {
    const event = {
      hostId: entry.hostId ?? 'coordinator',
      event: String(entry.event),
      name: entry.name ?? null,
      text: entry.text ?? (entry.fingerprint ? `fingerprint ${entry.fingerprint}` : null),
      // WHO, and WHAT THEY ASKED FOR. Both were already in hand and both were
      // thrown away: every intent arrives carrying a verified email since
      // sign-in, and it was forwarded to a host and forgotten. So the fleet
      // could tell you a session stopped and never who stopped it.
      actor: entry.actor ?? null,
      verb: entry.verb ?? null,
      url: entry.url ?? null,
      at: this.now(),
    };
    this.events.push(event);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    this.log.info(`coordinator: ${event.event}${event.hostId !== 'coordinator' ? ` ${event.hostId}` : ''}`);
    this.onEvents?.();
    return event;
  }

  /**
   * @param {Record<string, any>} event
   * @param {{ id: string, kind: string, answers: string, category: string }|null} [prompt]
   *   what the session is asking, when it is asking something answerable
   */
  async #notify(event, prompt = null) {
    // WHOSE SESSION THIS IS, resolved from the registry rather than carried on
    // the event, because the host does not send it. A session the fleet has not
    // heard of yet, or one nobody is recorded as having started, is
    // unattributed — which everywhere else in this file means "the fleet's,
    // which is to say the admin's".
    const owner = event.name ? (this.registry.findSessions(event.name)[0]?.createdBy ?? null) : null;

    // FILTERED FOR WHOSE PHONE IT IS, which it was not.
    //
    // This filtered on revocation alone, so every registered device in the
    // fleet received every session's notification — the session name, the host,
    // and since prompts started carrying the question, the QUESTION. On a lock
    // screen. docs/security.md says a member is "Explicitly NOT trusted to: See
    // or act on another member's sessions", and `list`, `/api/hosts` and
    // `/api/events` all enforce that. Push was a fourth route and was not.
    //
    // It is the worst of the four to have missed. The others require somebody
    // to go and look; this one arrives.
    //
    // A HOST-LEVEL EVENT STILL GOES TO EVERYONE, matching visibleEvents: which
    // machines exist and what state they are in is fleet topology, not
    // somebody's private work, and a box going offline is exactly the thing
    // everybody needs to be told about.
    const devices = [...this.devices.values()].filter((d) => {
      const client = d.clientId ? this.clients.clients.get(d.clientId) : null;
      // Belt as well as braces: a registration that somehow outlives its
      // credential must not be told what a session is asking.
      if (d.clientId && client?.revokedAt) return false;
      if (!event.name) return true;
      // No clientId means it was registered with the admin token, and an
      // unattributed registration belongs to whoever operates the box — the
      // same rule ownedBy() applies to an unattributed record.
      if (!d.clientId || client?.admin) return true;
      return ownedBy(owner, { email: String(d.actor || '').replace(/^fleet:/, ''), admin: false });
    });
    if (!devices.length) return;
    const body = describeEvent(event);
    try {
      await this.push?.send(devices, {
        // "deb132 on deb132" — a host event's name IS the host, and this
        // template was written for sessions, where the two differ. Reported
        // from a lock screen within minutes of host events shipping.
        title: event.name && event.name !== event.hostId ? `${event.name} on ${event.hostId}` : event.hostId,
        body,
        // Which two buttons, or none. The senders draw nothing without it.
        ...(prompt ? { category: prompt.category } : {}),
        data: {
          event: event.event,
          name: event.name ?? '',
          hostId: event.hostId,
          url: event.url ?? '',
          // ONLY WHEN THERE IS SOMETHING TO ANSWER. An empty promptId on every
          // host event is four bytes of nothing in a payload both providers cap
          // at 4 KB, and it is also a lie an app would have to test for: a key
          // that is present and empty reads as "answerable, badly" rather than
          // "not that kind of notification".
          ...(prompt ? { promptId: prompt.id, promptKind: prompt.kind, answers: prompt.answers } : {}),
        },
      });
    } catch (e) {
      // A push provider being down must never take the coordinator with it.
      this.log.warn(`coordinator: push failed: ${/** @type {Error} */ (e).message}`);
    }
  }

  /**
   * One phase of hypervisor onboarding. docs/hypervisors.md.
   *
   * `begin` is placed like anything pinned: the machine the caller chose, or
   * the only one there is. Every later phase goes to the machine that answered
   * `begin`, from the job record, whatever the caller asked for — the sealed
   * sign-in can only be opened there — and only for the person who began it.
   * A job this coordinator does not know is refused in the same words as one
   * that is somebody else's.
   *
   * @param {any} spec
   * @param {Record<string, any>} params
   * @returns {Promise<any>}
   */
  async #setup(spec, params) {
    const phase = String(params.phase);
    const owner = spec.requester?.email ? String(spec.requester.email).toLowerCase() : null;
    if (phase === 'begin') {
      if (!params.address) {
        return { ok: false, error: { code: 'bad_params' }, text: 'Say where Xen Orchestra answers: xosetup begin needs an address.' };
      }
      const placement = place(this.registry, spec, { preferHost: typeof spec.preferHost === 'string' ? spec.preferHost : '', requester: spec.requester ?? null });
      if (placement.kind !== 'host' || !placement.host) {
        return { ok: false, error: { code: placement.code || 'no_hosts' }, text: placement.reason || 'No machine can run the setup.' };
      }
      const hostId = placement.host.hostId;
      /** @type {any} */
      const answer = await this.dispatch({ ...spec, preferHost: hostId, setupRouted: true });
      const job = answer?.xosetup?.job;
      if (answer?.ok !== false && typeof job === 'string' && XOSETUP_JOB_RE.test(job)) {
        this.#pruneSetups();
        this.setups.set(job, { hostId, owner, startedAt: this.now(), last: null, activities: [] });
        this.onStateChanged?.();
      }
      return answer ? { ...answer, hostId } : answer;
    }
    const job = String(params.job || '');
    const rec = this.setups.get(job);
    if (!rec || rec.owner !== owner) {
      return {
        ok: false,
        error: { code: 'unknown_job' },
        text: 'No setup with that id is running for you. Start again from Add a hypervisor.',
      };
    }
    /** @type {any} */
    const answer = await this.dispatch({ ...spec, preferHost: rec.hostId, setupRouted: true });
    return answer ? { ...answer, hostId: rec.hostId } : answer;
  }

  /** Forget jobs a day old, and keep the map bounded whatever happens. */
  #pruneSetups() {
    const cutoff = this.now() - SETUP_TTL_MS;
    for (const [job, rec] of this.setups) if (rec.startedAt < cutoff) this.setups.delete(job);
    while (this.setups.size >= MAX_SETUPS) this.setups.delete(/** @type {string} */ (this.setups.keys().next().value));
  }

  /** The setup jobs, for storage. @returns {Array<[string, any]>} */
  serialiseSetups() {
    const cutoff = this.now() - SETUP_TTL_MS;
    return [...this.setups.entries()].filter(([, r]) => r.startedAt >= cutoff);
  }

  /**
   * Back from storage, each row checked as if a stranger wrote it: a row that
   * does not have the shape is dropped rather than half-believed.
   *
   * @param {unknown} entries
   */
  restoreSetups(entries) {
    if (!Array.isArray(entries)) return;
    const cutoff = this.now() - SETUP_TTL_MS;
    for (const e of entries.slice(-MAX_SETUPS)) {
      if (!Array.isArray(e) || !XOSETUP_JOB_RE.test(String(e[0])) || !e[1] || typeof e[1] !== 'object') continue;
      const r = e[1];
      if (typeof r.hostId !== 'string' || !(Number(r.startedAt) >= cutoff)) continue;
      this.setups.set(e[0], {
        hostId: r.hostId,
        owner: typeof r.owner === 'string' ? r.owner : null,
        startedAt: Number(r.startedAt),
        last: r.last ? narrowProgress(r.last) : null,
        activities: Array.isArray(r.activities) ? r.activities.filter((/** @type {unknown} */ t) => typeof t === 'string' && /^[0-9a-f]{64,400}$/.test(t)).slice(-4) : [],
      });
    }
  }

  /**
   * A host says an onboarding job moved. Narrowed, then shown to the job's
   * owner: a Live Activity update on iOS, an ongoing notification on Android,
   * and an ordinary notification on both when it ends.
   *
   * ONLY FROM THE MACHINE RUNNING IT. Any other host naming the job is
   * ignored, so one machine cannot paint progress onto another's setup.
   *
   * @param {string} hostId
   * @param {any} msg
   */
  async #onSetupProgress(hostId, msg) {
    const job = String(msg.job || '');
    const rec = this.setups.get(job);
    if (!rec || rec.hostId !== hostId) {
      this.log.warn(`coordinator: ${hostId} reported progress for a setup it is not running`);
      return;
    }
    const progress = narrowProgress(msg);
    if (!progress) return;
    rec.last = progress;
    this.onStateChanged?.();
    if (!this.push) return;

    const ended = progress.state !== 'running';
    // THE LIVE ACTIVITY: numbers and a key, never words a lock screen should
    // not show — see ActivityUpdate in push.js for why it cannot be sealed.
    if (rec.activities.length && this.push.activity) {
      try {
        const r = await this.push.activity(rec.activities, {
          event: ended ? 'end' : 'update',
          state: { step: progress.step, of: progress.of, phase: progress.phase, state: progress.state, ...(progress.fill === null ? {} : { fill: progress.fill }) },
          ...(ended ? { dismissAt: this.now() + 15 * 60_000 } : {}),
        });
        if (r.dead.length) rec.activities = rec.activities.filter((t) => !r.dead.includes(t));
      } catch (e) {
        this.log.warn(`coordinator: live activity update failed: ${/** @type {Error} */ (e).message}`);
      }
    }

    const devices = this.#devicesOf(rec.owner);
    // Android draws progress as one ongoing notification the app keeps up to
    // date, so every step goes there. iOS has the Live Activity for that and
    // hears only the end, as an ordinary notification.
    const targets = ended ? devices : devices.filter((d) => d.platform !== 'ios');
    if (!targets.length) return;
    const title = (progress.purpose === 'policy' ? POLICY_TITLES : SETUP_TITLES)[progress.state];
    const body = progress.text || `Step ${Math.min(progress.step + 1, progress.of)} of ${progress.of}`;
    try {
      await this.push.send(targets, {
        title,
        body,
        // Android draws progress itself, as one ongoing notification; a tray
        // notification per step would sit on top of it whenever the app is in
        // the background, which is the whole time it matters.
        drawnByApp: true,
        data: {
          kind: 'xosetup',
          // The collapse key both providers read: each step replaces the last.
          name: `xosetup-${job}`,
          job,
          hostId,
          step: String(progress.step),
          of: String(progress.of),
          ...(progress.fill === null ? {} : { fill: String(progress.fill) }),
          phase: progress.phase,
          state: progress.state,
          purpose: progress.purpose,
        },
      });
    } catch (e) {
      this.log.warn(`coordinator: push failed: ${/** @type {Error} */ (e).message}`);
    }
  }

  /**
   * A phone registers the push token of the Live Activity it started for a
   * job, so progress reaches the Lock Screen and the Dynamic Island while the
   * app is closed. Answers with where the job has got to, so an activity that
   * starts late starts right.
   *
   * @param {{ email?: string|null, admin?: boolean }|null} requester
   * @param {any} body
   */
  registerSetupActivity(requester, body) {
    const job = String(body?.job || '');
    const token = String(body?.token || '').toLowerCase();
    if (!XOSETUP_JOB_RE.test(job) || !/^[0-9a-f]{64,400}$/.test(token)) {
      return { ok: false, error: { code: 'bad_params' }, text: 'That is not a setup job and a Live Activity token.' };
    }
    const owner = requester?.email ? String(requester.email).toLowerCase() : null;
    const rec = this.setups.get(job);
    if (!rec || rec.owner !== owner) {
      return { ok: false, error: { code: 'unknown_job' }, text: 'No setup with that id is running for you.' };
    }
    if (!rec.activities.includes(token)) {
      rec.activities.push(token);
      // A phone that reinstalls or restarts the activity gets a new token;
      // four is more than one person's phones and still bounded.
      if (rec.activities.length > 4) rec.activities.splice(0, rec.activities.length - 4);
      this.onStateChanged?.();
    }
    return { ok: true, job, hostId: rec.hostId, progress: rec.last };
  }

  /**
   * The registered devices of one person, by verified email — or, for null,
   * the operator's: unattributed means the fleet's, here as in #notify.
   *
   * @param {string|null} owner
   */
  #devicesOf(owner) {
    return [...this.devices.values()].filter((d) => {
      const client = d.clientId ? this.clients.clients.get(d.clientId) : null;
      if (d.clientId && client?.revokedAt) return false;
      if (!d.clientId || client?.admin) return owner === null || Boolean(client?.admin) || !d.clientId;
      return String(d.actor || '').replace(/^fleet:/, '').toLowerCase() === owner;
    });
  }

  /**
   * Send a notification on demand, so a person can find out whether push works
   * without waiting for a session to need them at three in the morning.
   *
   * This is the only way to test the delivery chain end to end. Every other
   * notification is a side effect of something happening on a host, so a
   * failure anywhere between the app's registration and the provider is
   * invisible until the moment it matters most and nobody hears it. A button
   * that answers "did that arrive?" turns a silent failure into a question
   * with an answer.
   *
   * @param {string} [token] one device, or every device the requester may
   *   reach if omitted — their own for a member, the whole fleet for an admin
   * @param {{ id?: string, email?: string, admin?: boolean } | null} [requester]
   * @returns {Promise<{ ok: boolean, sent?: number, dead?: number, error?: object, text: string }>}
   */
  async testPush(token, requester = null) {
    const all = [...this.devices.values()].filter((d) => this.deviceReachableBy(d, requester));
    const devices = token ? all.filter((d) => d.token === token) : all;

    if (!devices.length) {
      return {
        ok: false,
        error: { code: 'no_devices' },
        text: token
          ? 'That device is not registered. Open the app and let it register first.'
          : 'No device is registered for push yet.',
      };
    }
    if (!this.push) {
      return { ok: false, error: { code: 'no_pusher' }, text: 'This coordinator has no push sender configured.' };
    }

    try {
      const result = await this.push.send(devices, {
        title: 'Fleetwright',
        body: 'Test notification — push is working.',
        data: { event: 'test', name: '', hostId: '', url: '' },
      });
      if (result.dead?.length) this.pruneDevices(result.dead);

      // sent: 0 with no error is the interesting case, and it is the one a
      // logging pusher produces — configured to log, so nothing was ever going
      // to arrive. Saying "sent" there would be a lie a person then spends an
      // hour on.
      return result.sent > 0
        ? { ok: true, sent: result.sent, dead: result.dead?.length ?? 0, text: `Sent to ${result.sent} device(s).` }
        : {
            ok: false,
            sent: 0,
            error: { code: 'not_delivered' },
            text:
              result.dead?.length
                ? 'The push provider rejected that token as dead; the registration was removed. Reopen the app to register again.'
                : 'Nothing was sent. This coordinator is logging notifications rather than delivering them — see docs/push.md.',
          };
    } catch (e) {
      return { ok: false, error: { code: 'push_failed' }, text: `Push failed: ${/** @type {Error} */ (e).message}` };
    }
  }

  /**
   * Turn a verified identity into a credential for this device.
   *
   * The ID token is spent here and never stored: everything afterwards uses the
   * client token, so revoking a phone is a local act and no request needs the
   * identity provider to be reachable.
   *
   * @param {{ email: string, name?: string|null }} who
   * @param {string} [deviceName]
   */
  async issueClient(who, deviceName) {
    const label = String(deviceName || '').trim() || who.name || who.email;
    // THE FIRST PERSON INTO A FRESH FLEET IS ITS ADMIN.
    //
    // Not a role system — there are two levels and this is the top one. Until
    // now every allowed address could do everything: revoke every machine,
    // revoke every other person's phone, mint pins. On a fleet whose allowlist
    // is a domain, that is every colleague.
    //
    // Written down where docs/identity.md can point at it: this is a guardrail
    // against mistakes and against a colleague having a bad day. It is NOT a
    // security control, because it is enforced inside the coordinator — the
    // component docs/trust.md assumes compromised.
    //
    // AND ADMIN FOLLOWS THE PERSON, NOT THE CREDENTIAL ROW. It was granted to
    // the first credential ever issued and then stuck to that row — so signing
    // out and back in on the same phone DEMOTED THE FLEET'S OWNER: the old row
    // still held admin, hasAdmin() said "taken", and the new credential came
    // out a plain member whose every host removal answered 403. Silently, in
    // the app's case.
    //
    // The email on a credential is verified by the identity provider before it
    // is ever stored, which is exactly what makes it usable as the thing role
    // attaches to. And it deliberately follows across REVOKED rows: revocation
    // exists for lost devices, not demotion — removing a person is taking them
    // off the allowlist, after which they cannot sign in at all.
    // everHadAdmin, not hasAdmin: the founding of a fleet happens once.
    // Checking live admins reopened it — revoke the owner's lost phone and the
    // next person to sign in, whoever they were, inherited the fleet.
    const admin = !this.clients.everHadAdmin() || this.clients.emailHasAdmin(who.email);
    const issued = await this.clients.issue(`${label} (${who.email})`, { admin });
    // A FULL STORE REFUSES THE SIGN-IN RATHER THAN HALF-COMPLETING IT. The
    // caller already spent their ID token to get here, so this is the one
    // place the refusal has to be legible: minting a credential the save
    // cannot persist is precisely the fleet-wide sign-in failure the ceiling
    // exists to prevent (#351).
    if (issued.ok === false) {
      this.record({ event: 'clients.full', actor: who.email, text: `${who.email} could not sign in: this fleet is holding as many credentials as it can store` });
      return issued;
    }
    const { client, token } = issued;
    // Recorded on the client so an intent can say who sent it without another
    // lookup, and so a revocation list reads as people rather than ids.
    client.email = who.email;
    this.log.info(`coordinator: issued a credential to ${who.email} for ${label}${admin ? ' (admin — first in)' : ''}`);
    if (admin) this.record({ event: 'client.admin', actor: who.email, text: `${who.email} is the first person in, and is this fleet's admin` });
    return { token, client: { id: client.id, name: client.name, createdAt: client.createdAt, admin: client.admin } };
  }

  // --- devices -------------------------------------------------------------

  /**
   * Register a phone for push. Keyed by the push address rather than by a
   * device id we mint, because the address is what actually identifies a
   * delivery target — and a reinstall gives the same phone a new one, which
   * should not accumulate as a second registration that fails forever.
   *
   * `token` is the field name and no longer the whole story: FCM is moving to
   * addressing a message by Firebase installation ID, and its `token` field
   * accepts either during the transition. The name is kept because renaming a
   * protocol parameter is a flag day — an old client sending `token` to a new
   * coordinator expecting `fid` fails AFTER the version handshake agreed, which
   * is the worst-shaped failure this protocol has.
   *
   * `pushKey` is the phone's P-256 public key, and supplying it is what makes
   * this device's notifications unreadable to Apple, Google and anything we
   * ever put in between. OPTIONAL, and it has to stay optional: an installed
   * app that predates encryption registers without one and must keep working,
   * which is why the sender falls back rather than refusing. See
   * docs/push-encryption.md.
   *
   * VALIDATED HERE rather than at send time. A key that cannot be imported is
   * a registration that fails on every notification forever, and the moment to
   * say so is while somebody is looking at a settings screen — not silently,
   * hours later, when a session needs an answer.
   *
   * @param {{ platform: string, token: string, actor?: string, clientId?: string, pushKey?: string }} reg
   */
  async registerDevice({ platform, token, actor, clientId, pushKey }) {
    if (!['ios', 'android', 'web'].includes(platform)) {
      return { ok: false, error: `unknown platform ${JSON.stringify(platform)}` };
    }
    if (typeof token !== 'string' || token.length < 8 || token.length > MAX_PUSH_TOKEN) {
      return { ok: false, error: 'a push token is required' };
    }
    if (pushKey !== undefined && pushKey !== null && pushKey !== '') {
      const checked = await checkPublicKey(pushKey);
      if (!checked.ok) return { ok: false, error: checked.error };
    }
    const existing = this.devices.get(token);
    // A TOKEN BELONGS TO THE CREDENTIAL THAT REGISTERED IT. Rows are keyed by
    // push token, so any member who learned another phone's token could
    // re-register it under their own credential: the victim's row is
    // replaced, revoking the victim no longer removes it, and revoking the
    // attacker silently kills the victim's push (#351). Refused by name. The
    // admin token has no credential and may re-register anything — and when
    // it does, the row keeps the credential it had, so it stays revocable
    // rather than becoming the unrevocable admin row the same issue names.
    if (existing?.clientId && clientId && existing.clientId !== clientId) {
      return { ok: false, error: 'that push token is registered to another device', code: 'not_yours' };
    }
    const owner = clientId ?? existing?.clientId;

    // A CEILING THAT REFUSES RATHER THAN FORGETS, which is the whole difference
    // between this key and the one above it.
    //
    // `mcpClients` is bounded by evicting the oldest row, and that is safe
    // there: a dropped OAuth client gets `invalid_client` and registers again,
    // within the same second, without anybody noticing. Evicting a DEVICE row
    // silently stops somebody's notifications, and this product's entire
    // argument rests on the phone being woken. So the store fills and says so.
    //
    // Only a registration that would actually GROW it is refused. A phone
    // re-registering on the token it already holds replaces a row; a phone
    // whose address changed frees its old row in the sweep below; both are net
    // zero and neither can be locked out by a full fleet. What is refused is a
    // genuinely new phone on a fleet that has run out of room, which is a thing
    // an operator has to be told rather than a thing to absorb.
    const grows = !existing && !(owner && [...this.devices.values()].some((d) => d.clientId === owner));
    if (grows && this.devices.size >= MAX_DEVICES) {
      this.record({
        event: 'devices.full',
        text:
          `a ${platform} device could not register: this fleet is holding ${MAX_DEVICES} push ` +
          'registrations, which is the most it can store in one record. Remove the phones that ' +
          'have gone before adding another.',
      });
      return {
        ok: false,
        code: 'devices_full',
        error:
          `This fleet is already holding ${MAX_DEVICES} push registrations, which is as many as it can ` +
          'store. An admin can remove the ones that belong to phones that have gone.',
      };
    }

    // A DEVICE THAT HAD A KEY AND CAME BACK WITHOUT ONE is not inherited from —
    // see below, the reason is a reinstall — but it was also not RECORDED, and
    // that is the half #351 named. The row quietly reverts to plaintext
    // notifications and nothing anywhere says so, which is the one shape a
    // security property must never fail in. Whether it is a reinstall (right)
    // or a key that failed to generate this launch (wrong) cannot be told apart
    // from here, so this says what happened and not what it means.
    if (existing?.pushKey && !pushKey) {
      this.record({
        event: 'device.plaintext',
        text:
          `a ${platform} device re-registered without an encryption key, so its notifications are ` +
          'no longer sealed to it. A reinstall does this and is expected; the same phone doing it ' +
          'twice is not.',
      });
    }

    const device = {
      id: existing?.id ?? this.newId(),
      platform: /** @type {any} */ (platform),
      token,
      ...(actor ? { actor } : !clientId && existing?.actor ? { actor: existing.actor } : {}),
      // WHICH CREDENTIAL THIS BELONGS TO, so revoking a phone can stop the
      // fleet talking to it. Without this a revoked device kept receiving
      // session names — and since prompts started carrying the question, the
      // questions themselves. Revoking a lost phone removed its ability to ASK
      // and left its ability to be TOLD, which is the wrong half.
      ...(owner ? { clientId: owner } : {}),
      // KEPT ONLY WHEN SUPPLIED THIS TIME, never inherited from `existing`.
      //
      // A phone that reinstalls loses its private key — it was in the Keychain
      // or the Keystore and both go with the app — so carrying the old public
      // key forward would encrypt every future notification to a key nobody
      // holds. The failure would be silent and permanent: delivery succeeds,
      // decryption fails, and the person sees the fallback text forever.
      ...(pushKey ? { pushKey } : {}),
      registeredAt: existing?.registeredAt ?? this.now(),
    };
    this.devices.set(token, device);
    // ONE PHONE, ONE ROW. The map is keyed by the push address, so a phone
    // whose address changed leaves its old row behind — and the old row is not
    // obviously dead. FCM keeps accepting a superseded registration token for a
    // while, so the fleet would deliver every notification twice to the same
    // phone until the day FCM finally said UNREGISTERED. Nobody would read that
    // as stale state; they would read it as the fleet being broken.
    //
    // This is not hypothetical: FCM is moving from registration tokens to the
    // Firebase installation ID, and every phone crosses that line once, on the
    // update that changes what it registers.
    //
    // clientId is the credential issued to this phone, so it is the only thing
    // here that identifies the DEVICE rather than the address. Where it is
    // missing the rows are left alone — an unauthenticated registration cannot
    // tell "the same phone" from "a different one", and guessing deletes
    // somebody else's.
    if (owner) {
      for (const [key, other] of this.devices) {
        if (key !== token && other.clientId === owner) {
          this.devices.delete(key);
          this.log.info(`coordinator: dropped superseded ${other.platform} device ${other.id}`);
        }
      }
    }
    this.log.info(`coordinator: registered ${platform} device ${device.id}`);
    return { ok: true, deviceId: device.id };
  }

  /**
   * May this requester act on this device?
   *
   * A device belongs to the credential that registered it and to the person
   * that credential names, so a second phone on the same account counts. One
   * registered with the admin token has no credential and belongs to whoever
   * holds that token. An admin reaches everything — removing other people's
   * devices is what the admin seat is for.
   *
   * THIS USED TO BE NOBODY'S QUESTION. The destructive-route guard covers
   * `/api/hosts/` and `/api/clients/` and never mentioned devices, so any
   * member could unregister any phone by its token, or send a test to every
   * phone in the fleet. Filed as #351; the check lives here so both
   * coordinators ask it the same way.
   *
   * `null` is the break-glass admin token, which the route layer never wraps
   * in a client row.
   *
   * @param {{ clientId?: string, actor?: string }} device
   * @param {{ id?: string, email?: string, admin?: boolean } | null} [requester]
   */
  deviceReachableBy(device, requester = null) {
    if (!requester || requester.admin) return true;
    if (device.clientId && device.clientId === requester.id) return true;
    const email = String(device.actor || '').replace(/^fleet:/, '').toLowerCase();
    return Boolean(email && requester.email && email === requester.email.toLowerCase());
  }

  /**
   * @param {string} token
   * @param {{ id?: string, email?: string, admin?: boolean } | null} [requester]
   * @returns {{ ok: true } | { ok: false, error: { code: 'not_registered' | 'not_yours' } }}
   */
  unregisterDevice(token, requester = null) {
    const device = this.devices.get(token);
    if (!device) return { ok: false, error: { code: 'not_registered' } };
    if (!this.deviceReachableBy(device, requester)) return { ok: false, error: { code: 'not_yours' } };
    this.devices.delete(token);
    return { ok: true };
  }

  /**
   * Revoke everything belonging to one person.
   *
   * For when the person themselves withdraws consent — revoking this app from
   * their Apple ID settings, or deleting their Apple Account. An admin removing
   * a lost phone revokes one credential; this revokes all of them, because the
   * subject is the person rather than the device.
   *
   * @param {string} email
   * @param {string} why
   */
  revokePerson(email, why) {
    const address = String(email || '').toLowerCase();
    if (!address) return { revoked: 0, devices: 0 };
    let revoked = 0;
    let devices = 0;
    for (const client of [...this.clients.clients.values()]) {
      if (String(client.email || '').toLowerCase() !== address || client.revokedAt) continue;
      const r = this.revokeClient(client.id);
      if (r.revoked) revoked++;
      devices += r.devices;
    }
    if (revoked) {
      this.record({
        event: 'client.withdrawn',
        actor: address,
        text: `${address} ${why}; ${revoked} credential${revoked === 1 ? '' : 's'} revoked`,
      });
    }
    return { revoked, devices };
  }

  /**
   * Revoke a credential AND stop notifying the device that held it.
   *
   * Two halves of one act. Revoking used to do only the first, so a stolen
   * phone lost the ability to ask the fleet anything and kept the ability to be
   * told everything — every session name, every host, and now every question a
   * session asks.
   *
   * @param {string} clientId
   * @returns {{ revoked: boolean, devices: number }}
   */
  revokeClient(clientId) {
    const revoked = this.clients.revoke(clientId);
    let devices = 0;
    for (const [token, device] of this.devices) {
      if (device.clientId === clientId) {
        this.devices.delete(token);
        devices++;
      }
    }
    if (revoked || devices) {
      this.record({ event: 'client.revoked', text: `a device credential was revoked, and ${devices} push registration${devices === 1 ? '' : 's'} with it` });
    }
    return { revoked, devices };
  }

  /** Drop a token the provider told us is dead. */
  /** @param {string[]} tokens */
  pruneDevices(tokens) {
    let gone = 0;
    for (const token of tokens) if (this.devices.delete(token)) gone++;
    if (gone) this.log.info(`coordinator: dropped ${gone} dead push token(s)`);
    return gone;
  }

  // --- intents -------------------------------------------------------------

  /**
   * @param {any} host
   * @param {{ verb: string, params?: Record<string, any>, actor?: string, id?: string, preferHost?: string, preferLabels?: string[]|string|null, requester?: { email?: string|null, admin?: boolean }|null }} spec
   * @param {number} [timeoutMs]
   */
  send(host, spec, timeoutMs = this.intentTimeoutMs) {
    const intent = buildIntent({
      id: spec.id || this.newId(),
      verb: spec.verb,
      params: spec.params || {},
      ...(spec.actor ? { actor: spec.actor } : {}),
      // WHAT THIS BOX SAYS IT SPEAKS, which matters for exactly one envelope.
      //
      // A host behind the fleet refuses every intent before reading the verb,
      // and the verb that would fix it is one of them — the D2 deadlock. It is
      // running code from before the protocol had an escape hatch, so the
      // escape hatch has to be on this side: `buildIntent` stamps a rescue
      // `update` with the number that host is waiting for and leaves every
      // other intent alone. It ignores this field unless the shape is frozen
      // and the host is behind, so passing it always is safe and passing it
      // conditionally would only move the rule somewhere it is harder to read.
      //
      // Health is not version-gated, which is what makes this possible: a
      // drifted box still reports, so the fleet still knows the number.
      speaks: host?.health?.protocol,
    });

    // A waiter already holds this id: refuse loudly rather than clobber it.
    // The silent overwrite was a fleet-wide outage — the fan-out above used to
    // send one id to every host, and the last set() won while the first
    // waiter starved to timeout. The fan-out now mints per-host ids, and this
    // makes the invariant structural instead of a habit.
    if (this.pending.has(intent.id)) {
      return Promise.reject(new Error(`an intent with id ${intent.id} is already in flight`));
    }
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.pending.delete(intent.id);
        reject(new Error(`${host.hostId} did not answer ${intent.verb} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(intent.id, { resolve, timer });
      try {
        host.send(intent);
      } catch (e) {
        this.clearTimer(timer);
        this.pending.delete(intent.id);
        reject(e);
      }
    });
  }

  /**
   * Route one intent and return the reply.
   * @param {{ verb: string, params?: Record<string, any>, actor?: string, id?: string, preferHost?: string, preferLabels?: string[]|string|null, requester?: { email?: string|null, admin?: boolean }|null, startAfter?: Record<string, any>|null, internal?: boolean, setupRouted?: boolean }} spec
   *   `internal`, for `mint` only: set by the coordinator itself, never by a route
   *   `setupRouted`, for `xosetup` only: set by #setup once it has placed the job, never by a route
   * @returns {Promise<any>}
   *   `startAfter`, for `provision` only: a session to start on the runner once
   *   it joins — title, brief and mode, checked by `start`'s own rules
   */
  async dispatch(spec) {
    if (!Object.prototype.hasOwnProperty.call(VERBS, spec.verb)) {
      return { ok: false, error: { code: 'unknown_verb' }, text: `unknown verb ${JSON.stringify(spec.verb)}` };
    }

    // A CALLER'S TYPO IS A REFUSAL, NOT AN EXCEPTION.
    //
    // `buildIntent` throws on a malformed intent, which is right for a
    // programming error inside this file and wrong for the case that actually
    // happens: somebody posting `params: {session: "x"}` to /api/intent. It is
    // called inside `send`, which is called inside a `.map` over the fan-out —
    // so the throw left dispatch synchronously, past every handler, and became
    // a Cloudflare error page.
    //
    // That is the "error code: 1101" a beta tester hit twice and reported as
    // the fleet being down. It was their typo. Retrying could never have
    // worked, and the coordinator told them retrying was reasonable.
    //
    // CHECKED HERE RATHER THAN IN `send` because the placement decision reads
    // `params.name`: a bad params object should be refused before a scheduler
    // makes any decision on the strength of it.
    const shaped = checkParams(spec.verb, spec.params || {});
    if (shaped.ok === false) {
      return { ok: false, error: { code: shaped.code }, text: shaped.error };
    }

    // A MINT IS THE COORDINATOR'S OWN, sent for a runner that asked on its
    // socket and for that runner's owner. From anybody else it is refused
    // whatever it carries: the job token in it is what would decide, and a
    // caller holding a job token for their own runner already has a runner to
    // ask through. `internal` is set by #onRunnerMint and by nothing a route
    // builds — no route copies fields off a request into the spec.
    if (spec.verb === 'mint' && spec.internal !== true) {
      return {
        ok: false,
        error: { code: 'coordinator_only' },
        text: 'mint is sent by the coordinator for a runner that asked for a repository token. It cannot be called.',
      };
    }

    // Recorded BEFORE placement, and only for verbs that change something.
    //
    // Before placement, not after the work: an intent that was REFUSED — no
    // hosts, ambiguous name, a box that had just gone — is exactly the one an
    // audit wants, and recording on the way back loses every one of them. "Who
    // tried to stop everything at 3am" is a better question to be able to
    // answer than "what succeeded".
    //
    // Mutating only: a `list` every fifteen seconds from three phones would
    // push everything else out of a 200-entry ring inside an hour, and that
    // ring is the only memory this coordinator has.
    // A setup phase routed on to its machine by #setup comes through here a
    // second time; it was recorded the first.
    if (isMutating(spec.verb) && spec.actor && spec.setupRouted !== true) {
      this.record({
        event: 'intent',
        verb: spec.verb,
        actor: spec.actor,
        name: spec.params?.name ?? null,
        // The provider, when there is one — "asked for link" tells an audit
        // nothing, and `params.secret` must never come near this ring, which
        // is why this names the two safe fields rather than serialising params.
        text:
          `${spec.actor} asked for ${spec.verb}` +
          `${spec.params?.name ? ` ${spec.params.name}` : ''}` +
          `${spec.params?.provider ? ` ${spec.params.provider}` : ''}` +
          `${spec.params?.scope === 'host' ? ' for the box itself' : ''}`,
      });
    }

    // LOGGING THE BOX IN IS ADMIN-ONLY, and this is the only place that can
    // say so — the host receives an actor, not a role, and a role it cannot
    // verify is a role it must not act on.
    //
    // Be precise about what this defends against, because overclaiming here is
    // how a control stops being maintained: it stops a MEMBER from replacing
    // the shared Claude account every other session on that box runs on. It is
    // not a defence against a compromised coordinator, which is the party
    // performing the check. `scope: me` needs no gate at all — the host
    // derives that email from the verified actor and no parameter can name
    // somebody else.
    if (
      (spec.verb === 'connect' || spec.verb === 'link' || spec.verb === 'unlink') &&
      spec.params?.scope === 'host' &&
      spec.requester &&
      !spec.requester.admin
    ) {
      return {
        ok: false,
        error: { code: 'not_admin' },
        text:
          'Only this fleet\u2019s admin can change the account a box itself runs on. ' +
          'Connecting your OWN credential needs no permission \u2014 leave the scope off.',
      };
    }

    // ADDING A HYPERVISOR IS AN ADMIN'S, the probe included. It brings a pool
    // into the fleet with an admin sign-in, and the probe asks every machine to
    // reach an address on its network; neither is a member's to do. The
    // break-glass token arrives with no requester and is the operator's.
    if ((spec.verb === 'xoprobe' || spec.verb === 'xosetup') && spec.requester && !spec.requester.admin) {
      return {
        ok: false,
        error: { code: 'not_admin' },
        text: 'Only this fleet\u2019s admin can add a hypervisor.',
      };
    }
    if (spec.verb === 'xosetup' && spec.setupRouted !== true) return this.#setup(spec, shaped.params);

    // ASKING FOR A MACHINE THAT DOES NOT EXIST YET.
    //
    // Two things have to be true before this can be placed, and neither is a
    // property of any host, so both are settled here rather than by a refusal
    // travelling back from a box that could not have known.
    //
    // WHOSE RUNNER IT IS, decided from the VERIFIED caller and never from a
    // parameter. A runner exists because one person asked for it, costs them
    // money while it lives, and is placed only for them — so an unattributed
    // caller has not named anybody, and picking somebody would be attributing a
    // machine to a person who did not ask for it. The break-glass token arrives
    // with no requester at all, deliberately: it is what you hold when identity
    // is broken, and identity is exactly what this verb needs.
    //
    // The ticket is minted HERE, overwriting anything the caller sent. That is
    // the whole of the ownership design: the fleet dispatches the run, so it
    // knows who asked before the job exists, and the job proves which dispatch
    // it is by presenting a single-use value it could not have invented. See
    // src/fleet/coordinator/runner-tickets.js.
    if (spec.verb === 'provision') {
      const minted = await this.#mintRunnerTicket(spec.requester, String(shaped.params.platform || ''), spec.startAfter, spec.actor ?? null);
      if (minted.ok === false) return minted;
      /** @type {Record<string, any>} */
      const params = { ...shaped.params, ticket: minted.ticket };
      if (minted.own) params.repo = minted.own;
      else delete params.repo;
      spec = { ...spec, params };
    }

    const placeIt = () => place(this.registry, spec, {
      // The caller's chosen host, when they chose one. Beside the spec rather
      // than in params, so it can never leak into the intent a host validates.
      preferHost: typeof spec.preferHost === 'string' ? spec.preferHost : '',
      // And the tag, for the same reason and by the same route. "Tag linux" is
      // a statement about WHERE, not about what to do, so it never becomes part
      // of the intent a host validates — which also keeps it from being a flag
      // day, since adding a parameter to an existing verb is one.
      preferLabels: spec.preferLabels ?? null,
      // And who is asking, so pinned verbs can refuse a member acting on work
      // that is not theirs — with the same words as "unknown", so an access
      // control never becomes an existence oracle.
      requester: spec.requester ?? null,
    });
    let placement = placeIt();
    // A MACHINE THAT HAS NOT SPOKEN YET IS NOT A MACHINE THAT CANNOT WORK. A
    // coordinator deploy restarts this object and forgets every host's last
    // report, so for the first seconds afterwards each box is connected and
    // "unknown". A start in that window was refused with "unknown (connected,
    // no health report yet)" for every machine, and the phone called the
    // refusal "Session ready". A box reports within one health interval of
    // connecting, so wait that long for one, once, and only when the waiting
    // is all that stands between this request and a host.
    if (placement.kind === 'refused' && placement.code === 'no_hosts' && this.#awaitingFirstHealth()) {
      await this.#firstHealth();
      placement = placeIt();
    }
    if (placement.kind === 'refused') {
      // SEVERAL BOXES COULD ASK GITHUB, AND ONLY SOME HOLD YOUR CONNECTION.
      // The scheduler refuses to guess, which is right for it — it cannot see
      // who connected what where. This can: ask each permanent box in turn,
      // and move on only when the whole answer was "not connected for you
      // here", which is a reply that dispatched nothing. Anything else — a
      // dispatch, a refusal from GitHub — is the answer.
      if ((spec.verb === 'provision' || spec.verb === 'runnerrepo') && placement.code === 'ambiguous_host') {
        return this.#askEachBox(spec);
      }
      return { ok: false, error: { code: placement.code }, text: placement.reason };
    }


    if (placement.kind === 'fanout') {
      // A SHORT deadline of its own, not the intent timeout. This was the full
      // 60 seconds per host under Promise.all — so one connected-but-mute host
      // (a half-open socket from a reconnect storm, a host mid-death, a probe
      // that reads and does not reply) stalled EVERY fan-out for a minute, and
      // every phone gave up first. The whole fleet looked down because one
      // member would not answer a question.
      //
      // Ten seconds is generous for "list what you are running": a healthy
      // host answers in tens of milliseconds, and a host that needs longer
      // than ten seconds to enumerate its sessions has news the per-host
      // error slot below is designed to carry. The slow host degrades ITS
      // OWN entry, never the fleet.
      // A FRESH id per host, never the caller's. send() keys the reply-waiter
      // by intent id, so fanning one id to N hosts made the second set()
      // CLOBBER the first waiter: whichever host replied first resolved the
      // survivor — attributed to the wrong slot — the clobbered slot waited
      // out its entire timeout, and every other honest reply arrived as
      // "late, nothing waiting" and was discarded.
      //
      // The apps supply an idempotency id on every intent, which is right for
      // a mutating verb aimed at one host and catastrophic here: THE FLEET
      // BROKE THE MOMENT IT GAINED ITS SECOND HOST, in exactly this line. One
      // host is one waiter and works forever; two hosts is a 60-second stall
      // and a mislabeled answer, per tap, while every host and every log
      // looks perfect. Reads are not idempotency-protected — a retried list
      // is just a list — so a minted id per host loses nothing.
      //
      // And ...r BEFORE hostId: a reply carries the hostId the responding
      // host was resolved under, and spreading it after the attribution let
      // it overwrite the one fact the comment below says must never be lost.
      const results = await Promise.all(
        (placement.hosts || []).map((h) =>
          this.send(h, { ...spec, id: this.newId() }, FANOUT_TIMEOUT_MS)
            .then((r) => ({ ...r, hostId: h.hostId }))
            .catch((e) => ({ hostId: h.hostId, ok: false, text: e.message, error: { code: 'host_timeout' } })),
        ),
      );
      let sessions = results.flatMap((r) => (r.sessions || []).map((/** @type {any} */ s) => ({ ...s, hostId: r.hostId })));

      // WHOSE sessions the caller may see — filtered HERE, never at the host.
      // The host has one token and no idea who is asking; a host-side filter
      // would be a check performed by the party with the least information.
      //
      // Admin sees everything (and so does the break-glass token, which
      // arrives with no requester at all — it is what you hold when identity
      // itself is broken). A member sees the sessions their verified identity
      // created. Sessions with no attribution — telegram, the CLI on the box,
      // anything from before attribution existed — belong to the fleet, which
      // is to say the admin: the invited-client scenario this exists for is
      // precisely "my client must not read my org's other work", and erring
      // open would quietly break that promise.
      //
      // The hosts array is NOT filtered: which machines exist is fleet
      // topology, and a member starting a session needs the picker to work.
      const filtering = Boolean(spec.requester && !spec.requester.admin);
      if (filtering) {
        const mine = `fleet:${String(spec.requester?.email || '').toLowerCase()}`;
        sessions = sessions.filter((s) => String(s.createdBy || '').toLowerCase() === mine);
      }

      // AND THE PROSE WITH IT, which is where this filter was leaking everything
      // it removed.
      //
      // A host answers `list` with two renderings of the same fact: `sessions`,
      // as records, and `text`, as the listing a person reads. Only the records
      // were filtered — so the app, which draws the records, was correct, and
      // the MCP server, which renders `text` because that is what an agent
      // reads, handed every member the whole fleet: every session's name, its
      // title, who started it, and the REMOTE CONTROL URL of anything running.
      // A live link into somebody else's session, in the reply to the one verb
      // an invited guest is most likely to call first.
      //
      // Rendered here from the filtered records rather than cut out of the
      // host's prose. Parsing a listing to remove lines from it is a filter
      // that fails open the first time the listing improves — and this file
      // already says the host is the party with the least information about
      // who is asking, so it cannot render this either.
      //
      // Only for replies that carried sessions, so the other fan-out verbs —
      // `profiles`, `connect`, `link` — keep the host's own words, and a host
      // that refused keeps its reason.
      const rendered = new Map(
        results.map((r) => [
          r.hostId,
          filtering && Array.isArray(r.sessions)
            ? describeOwnSessions(sessions.filter((s) => s.hostId === r.hostId))
            : (r.text ?? ''),
        ]),
      );

      // COVERAGE, when the question was "what am I connected to". A fan-out
      // returns one reply per host, and for `connect` the interesting part is
      // where they DISAGREE: a credential reaches the hosts that were
      // reachable when it was stored, so a machine enrolled later has none.
      // Merging that into a per-provider list of hosts is what lets a screen
      // say "missing on deb14" instead of implying the fleet is uniform.
      const connections = mergeConnections(results);

      // THE SAME QUESTION FOR PROFILES, and the attribution is the answer
      // rather than decoration: a profile lives on one box, and `start` on a
      // host that does not have it is refused. A merged list that lost which
      // machine each came from would be a picker that sends people at the wrong
      // one. Undefined rather than [] when no host answered with the key at
      // all — a fleet of hosts too old to know the verb has not told us there
      // are no profiles, and null is cannot-tell.
      const profiles = results.some((r) => Array.isArray(r.profiles))
        ? results.flatMap((r) => (r.profiles || []).map((/** @type {any} */ p) => ({ ...p, hostId: r.hostId })))
        : undefined;

      // THE SAME MERGE FOR SECRETS, and the hostId matters for the same reason:
      // a named secret lives on one box, and `start { secret }` on a host that
      // does not hold it is refused, so a picker that lost which machine each
      // name came from would send people at the wrong one. Names only — the host
      // never sends a value, and there is nothing here that could carry one.
      const secrets = results.some((r) => Array.isArray(r.secrets))
        ? results.flatMap((r) => (r.secrets || []).map((/** @type {any} */ s) => ({ ...s, hostId: r.hostId })))
        : undefined;

      // A TEST ASKED OF EVERY BOX answers with what a box that holds the
      // token found, attributed to it. A box without one has nothing to
      // check, and its "No GitHub token is stored here" stays in its own line
      // of `hosts` rather than standing for the fleet.
      // WHICH MACHINES CAN REACH A HYPERVISOR, attributed, because the answer
      // is per machine and the app offers only the ones that could. Narrowed
      // to the fields a probe has, so nothing else a host put on it travels.
      //
      // ONLY MACHINES THAT ANSWERED. A machine that timed out, errored or is
      // too old to know the verb did not find the address unreachable; it
      // said nothing, and an entry reading `reachable: false` would be a claim
      // nobody made. Its sentence is in `hosts`.
      const probing = results.filter((r) => r?.xoprobe && typeof r.xoprobe === 'object');
      const probes = probing.length ? probing.map((r) => ({ hostId: r.hostId, ...narrowProbe(r.xoprobe) })) : undefined;

      const checked = results.filter((r) => r?.check && typeof r.check === 'object');
      const answered = checked.find((r) => r.check.ok) ?? checked[0];
      const check = answered ? { ...answered.check, hostId: answered.hostId } : undefined;

      return {
        ok: results.some((r) => r.ok),
        fanout: true,
        ...(check ? { check } : {}),
        ...(connections ? { connections } : {}),
        ...(profiles ? { profiles } : {}),
        ...(secrets ? { secrets } : {}),
        ...(probes ? { probes } : {}),
        // Attribution is not decoration: two hosts can hold sessions with the
        // same name, and a merged list that loses which box each came from
        // cannot be acted on.
        sessions,
        hosts: results.map(({ hostId, ok, error }) => ({ hostId, ok, text: rendered.get(hostId) ?? '', error })),
        text: results.map((r) => `${r.hostId}: ${rendered.get(r.hostId) ?? ''}`).join('\n'),
      };
    }

    const outdated = placement.host ? this.#cannotCarry(placement.host, spec) : null;
    if (outdated) return outdated;

    try {
      const answer = explainUnsupportedVersion(
        explainUnknownVerb(await this.send(placement.host, spec), placement.host),
        placement.host,
      );
      // THE SESSION IS REAL THE MOMENT THE HOST SAYS SO, not when the next
      // health frame happens to arrive.
      //
      // The registry learns which sessions exist only from those frames, and
      // placement for `status`, `peek` and `await` reads that list — so `start`
      // answered "Started X" and an await one call later was refused with "No
      // host reports a session named X. It may exist on a host that is
      // currently offline", about a session the same host had just confirmed
      // creating. Pushing health after `start` narrowed the window; it did not
      // close it, because the frame still has to travel.
      //
      // The reply already carries the record. Believing it costs nothing: the
      // next real frame overwrites this, and a session the host invented is a
      // session the host has.
      if (answer?.ok !== false && Array.isArray(answer?.sessions)) {
        this.registry.noteSessions(placement.host?.hostId || '', answer.sessions);
      }
      return answer;
    } catch (e) {
      return { ok: false, error: { code: 'host_timeout' }, text: /** @type {Error} */ (e).message };
    }
  }

  /**
   * What a phone asks for when it opens, having been asleep while things
   * happened. Push wakes it; this tells it what it missed.
   *
   * On the core rather than in each coordinator's route, because the two had
   * already drifted — the Worker served 50 and the Node one served none at all.
   */
  /**
   * Offer an OAuth flow in place of the paste, for each provider this
   * deployment has registered a client with.
   *
   * The HOST publishes the catalogue and knows nothing about a GitHub App or a
   * Cloudflare OAuth client — correctly, since a client id and secret belong
   * to the deployment rather than to any machine. So the coordinator rewrites
   * the entries it can improve on, and leaves everything else alone.
   *
   * This used to say "Cloudflare is untouched, and always will be: there is no
   * third-party app program to rewrite it to." There is one — the correction
   * is in docs/connectors.md — and Cloudflare is now the second provider
   * through the same flow rather than a second design.
   *
   * @param {any} reply       a connect reply carrying `connections`
   * @param {string} hostId   where the flow must come back to
   * @param {string|null} email  whose credential this will be
   * @param {string} origin   this coordinator's public origin
   */
  offerOauth(reply, hostId, email, origin) {
    const catalogue = reply?.connections?.catalogue;
    if (!Array.isArray(catalogue)) return reply;

    /** @type {Record<string, { url: string, hint: string }>} */
    const offers = {};

    // THE HOST'S CHALLENGE, when it minted one. A host that holds the client
    // secret answers `connect` with a PKCE challenge per provider on the
    // catalogue entry, and from then on the code that comes back is worth
    // nothing to anybody but that host — this coordinator included. Shape
    // checked before it is built into a URL: 43 base64url characters is what
    // S256 produces and anything else is not a challenge.
    /** @param {string} provider */
    const challengeFrom = (provider) => {
      const entry = catalogue.find((c) => c?.provider === provider);
      const value = entry?.codeChallenge;
      return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    };

    // An origin we cannot parse means no offer, and the paste route is
    // returned untouched. Better a working paste than an authorize URL built
    // out of something that was not an address. Each provider gets its OWN
    // state, minted into its own store, so one callback cannot redeem the
    // other's flow.
    if (this.githubApp?.clientId && this.githubApp?.clientSecret) {
      const state = this.newId();
      const codeChallenge = challengeFrom('github');
      const url = authorizeUrl({ clientId: this.githubApp.clientId, origin, state, codeChallenge });
      if (url) {
        this.pendingGithub.mint({ state, hostId, email, pkce: Boolean(codeChallenge) });
        offers.github = {
          url,
          hint:
            'Choose which repositories Fleetwright may see. Nothing is copied or pasted — ' +
            'GitHub sends the result back, and you can change the repositories or uninstall ' +
            'it from your GitHub settings at any time.',
        };
      }
    }
    // ALL THREE OR NO OFFER. Without the scope list the authorize request asks
    // Cloudflare for nothing, and what comes back is a token that verifies and
    // then cannot do a single piece of work — a failure discovered four hours
    // into a session, which is the exact shape this catalogue exists to
    // prevent. A deployment that sets the id and secret but not the scopes
    // keeps the paste route, which works.
    if (this.cloudflareOauth?.clientId && this.cloudflareOauth?.clientSecret && this.cloudflareOauth?.scopes) {
      const state = this.newId();
      const codeChallenge = challengeFrom('cloudflare');
      const url = cloudflareAuthorizeUrl({
        clientId: this.cloudflareOauth.clientId,
        origin,
        state,
        scopes: this.cloudflareOauth.scopes,
        codeChallenge,
      });
      if (url) {
        this.pendingCloudflare.mint({ state, hostId, email, pkce: Boolean(codeChallenge) });
        offers.cloudflare = {
          url,
          hint:
            'Sign in to Cloudflare and approve the access this fleet asks for. Nothing is copied or ' +
            'pasted — Cloudflare sends the result back, and you can revoke it from your Cloudflare ' +
            'dashboard at any time.',
        };
      }
    }
    if (!Object.keys(offers).length) return reply;

    return {
      ...reply,
      connections: {
        ...reply.connections,
        catalogue: catalogue.map((c) =>
          offers[c?.provider]
            ? {
                ...c,
                url: offers[c.provider].url,
                // The app renders no paste field for this one: there is
                // nothing to copy, which is the entire point of the flow.
                flow: 'app',
                hint: offers[c.provider].hint,
              }
            : c,
        ),
      },
    };
  }

  /**
   * What a device needs to START signing in to GitHub by itself: the App's
   * client id, which is public and in every authorize URL anyway, and the
   * callback GitHub sends it back through. Not the client secret: that stays
   * in the minting Worker, which finishes the exchange (githubDeviceToken).
   *
   * @param {string} origin
   */
  githubDeviceStart(origin) {
    const clientId = this.githubApp?.clientId;
    if (!clientId) {
      return { ok: false, error: { code: 'not_configured' }, text: 'This fleet has no GitHub App configured, so there is nothing to sign in to GitHub with.' };
    }
    return { ok: true, clientId, redirectUri: `${origin}/oauth/github/callback`, statePrefix: 'd.' };
  }

  /**
   * A device finishing, or renewing, its own GitHub sign-in, through the
   * minting Worker.
   *
   * WHY THE MINTER AND NOT HERE. The exchange needs the App's client secret
   * and this process holds it, so it could make the exchange itself; but then
   * the person's GitHub token would come back through the part of the fleet
   * this project treats as compromised, and a phone's token is what starts
   * their runners and proves who they are to the minter. So the device seals
   * the code and its PKCE verifier (or its refresh token) to the minter's key,
   * this relays the ciphertext, the minter, which holds its own copy of the
   * secret, asks GitHub, and seals the answer to a key only the device has.
   * The code alone is no use to this process: GitHub refuses it without the
   * verifier that never left the phone.
   *
   * @param {{ email?: string|null }|null} requester @param {any} body
   * @returns {Promise<Record<string, unknown>>}
   */
  async githubDeviceToken(requester, body) {
    const email = String(requester?.email || '').toLowerCase();
    const sealed = body?.sealed;
    if (!sealed || typeof sealed !== 'object' || JSON.stringify(sealed).length > 8192) {
      return { ok: false, error: { code: 'bad_params' }, text: 'That is not a sealed GitHub sign-in.' };
    }
    if (!this.minter?.github) {
      return {
        ok: false,
        error: { code: 'no_minter' },
        text: 'This fleet has no minting Worker to finish a GitHub sign-in on a device. See docs/runner-central.md.',
      };
    }
    // A FEW A MINUTE PER PERSON is a sign-in and a renewal with room to retry;
    // more is something else.
    const now = this.now();
    const key = `github:${email}`;
    const recent = (this.claudeAsks.get(key) || []).filter((t) => now - t < MINT_WINDOW_MS);
    if (recent.length >= MAX_GITHUB_PER_WINDOW) {
      return { ok: false, error: { code: 'too_many' }, text: 'Too many GitHub sign-ins in ten minutes. Wait a little and try again.' };
    }
    recent.push(now);
    this.claudeAsks.set(key, recent);
    const r = await this.minter.github({ sealed: { epk: sealed.epk, iv: sealed.iv, ct: sealed.ct } }).then(
      (x) => (x && typeof x === 'object' ? x : { ok: false, error: { code: 'refused' }, text: 'The minting Worker gave no answer.' }),
      (e) => ({ ok: false, error: { code: 'minter_unreachable' }, text: `The minting Worker did not answer: ${/** @type {Error} */ (e).message}.` }),
    );
    return r.ok
      ? { ok: true, sealed: r.sealed, text: String(r.text || '') }
      : { ok: false, error: { code: String(r.error?.code || 'refused') }, text: String(r.text || 'The minting Worker refused it.') };
  }

  /**
   * What a device needs to sign in to Cloudflare for its person's vault: the
   * client id, the scopes this fleet asks for and the page to open. Not the
   * client secret, which the minting Worker holds for the exchange.
   *
   * @param {string} origin
   */
  cloudflareDeviceStart(origin) {
    const c = this.cloudflareOauth;
    if (!c?.clientId || !c?.scopes) {
      return { ok: false, error: { code: 'not_configured' }, text: 'This fleet has no Cloudflare sign-in configured.' };
    }
    return {
      ok: true,
      clientId: c.clientId,
      redirectUri: `${origin}/oauth/cloudflare/callback`,
      authorizeUrl: 'https://dash.cloudflare.com/oauth2/auth',
      scopes: c.scopes,
      statePrefix: 'd.',
    };
  }

  /**
   * A person reads or changes their vault: lists it, keeps or forgets an item,
   * finishes a sign-in for it, approves a box or removes one.
   *
   * All of it is sealed on their device to the minting Worker's key, and this
   * relays it unread with one thing beside it: which fleet account sent it.
   * The minter checks that against the account named inside the seal before
   * a box approval can name anybody (src/fleet/minter/vault.js), so this
   * coordinator's word is needed for that and is not enough on its own. The
   * answer comes back sealed to a key the device made for it.
   *
   * @param {{ email?: string|null }|null} requester @param {any} body
   * @returns {Promise<Record<string, unknown>>}
   */
  async vaultDevice(requester, body) {
    const email = String(requester?.email || '').toLowerCase();
    if (!email) return { ok: false, error: { code: 'not_signed_in' }, text: 'Sign in first: a vault belongs to a person.' };
    const sealed = body?.sealed;
    if (!sealed || typeof sealed !== 'object' || JSON.stringify(sealed).length > 16_384) {
      return { ok: false, error: { code: 'bad_params' }, text: 'That is not a sealed vault request.' };
    }
    if (!this.minter?.vault) {
      return { ok: false, error: { code: 'no_minter' }, text: 'This fleet has no minting Worker to keep a vault. See docs/vault.md.' };
    }
    const now = this.now();
    const key = `vault:${email}`;
    const recent = (this.claudeAsks.get(key) || []).filter((t) => now - t < MINT_WINDOW_MS);
    if (recent.length >= MAX_VAULT_PER_WINDOW) {
      return { ok: false, error: { code: 'too_many' }, text: 'Too many vault changes in ten minutes. Wait a little and try again.' };
    }
    recent.push(now);
    this.claudeAsks.set(key, recent);
    const r = await this.minter.vault('device', { sealed: { epk: sealed.epk, iv: sealed.iv, ct: sealed.ct }, email }).then(
      (x) => (x && typeof x === 'object' ? x : { ok: false, error: { code: 'refused' }, text: 'The minting Worker gave no answer.' }),
      (e) => ({ ok: false, error: { code: 'minter_unreachable' }, text: `The minting Worker did not answer: ${/** @type {Error} */ (e).message}.` }),
    );
    // WHAT CHANGED, in the minter's own words, which never carry a value.
    this.record({ event: r.ok ? 'vault.changed' : 'vault.refused', actor: email, text: `${email}: ${String(r.text || '').slice(0, 200)}` });
    return r.ok
      ? { ok: true, sealed: r.sealed, text: String(r.text || '') }
      : { ok: false, error: { code: String(r.error?.code || 'refused') }, text: String(r.text || 'The minting Worker refused it.') };
  }

  /**
   * Finish an authorization GitHub has redirected back to us.
   *
   * Everything here is refusable and says why in a sentence a person reading a
   * browser page can act on. The one thing it must never do is exchange a code
   * for a flow it did not start — which is what `redeem` is for, and why it is
   * the first thing that happens.
   *
   * @param {{ code?: unknown, state?: unknown, origin: string,
   *   setupAction?: unknown, installationId?: unknown }} args
   */
  async finishGithubAuthorization({ code, state, origin, setupAction, installationId }) {
    const clientId = this.githubApp?.clientId;
    const clientSecret = this.githubApp?.clientSecret;
    if (!clientId || !clientSecret) {
      return { ok: false, text: 'This fleet has no GitHub App configured.' };
    }
    // A SIGN-IN A DEVICE STARTED, for the device's own use (starting a
    // runner, depositing a Claude login) with no box anywhere. The phone made
    // this state and holds the PKCE verifier; the code goes back to it, and it
    // finishes the exchange through the minting Worker, so the token never
    // comes near this process. See githubDeviceToken.
    if (DEVICE_STATE_RE.test(String(state ?? ''))) {
      const back = deviceReturnUrl({ code, state });
      return back
        ? { ok: true, device: back, text: 'Back to Fleetwright to finish signing in to GitHub.' }
        : { ok: false, text: 'GitHub did not send back a code to finish signing in with. Try again from the app.' };
    }
    const flow = this.pendingGithub.redeem(state);
    if (!flow) {
      // TWO FLOWS ARRIVE AT THIS ONE URL, and only one of them was ours.
      //
      //   AUTHORIZATION — somebody tapped Connect in the app. We minted a
      //     state, GitHub hands it back, and there is a person to attach the
      //     token to.
      //
      //   INSTALLATION — somebody installed the App from GitHub's own page.
      //     GitHub sends `installation_id` and `setup_action=install` and NO
      //     state, because we did not start it.
      //
      // The second was being reported as "that sign-in link has expired or was
      // already used", which is alarming and untrue: nothing expired, the
      // install worked. A real report of it:
      //
      //   /oauth/github/callback?code=…&installation_id=159793900&setup_action=install
      //
      // NOT ATTRIBUTED TO WHOEVER LOADED THE PAGE. No state means no verified
      // actor, and storing a token for the person who happens to be holding the
      // URL is precisely the thing every other flow here refuses to do. So this
      // says what happened and where to finish, and stores nothing.
      if (setupAction) {
        return {
          ok: true,
          installed: true,
          text:
            'The Fleetwright GitHub App is installed on your account. ' +
            'To connect it to your Fleetwright sign-in, open the app and tap Connect under GitHub — ' +
            'that step is what tells the fleet which account is yours.',
        };
      }
      // Deliberately one message for unknown, expired and replayed. Telling a
      // stranger which of those it was is telling them whether a state exists.
      return { ok: false, text: 'That sign-in link has expired or was already used. Start again from the app.' };
    }
    if (typeof code !== 'string' || !code) {
      return { ok: false, text: 'GitHub did not send an authorization code back.' };
    }

    if (flow.pkce) return this.#exchangeOnHost({ provider: 'github', flow, code, clientId, origin });

    const exchanged = await exchangeCode({ clientId, clientSecret, code, origin });
    if (!exchanged.ok) return { ok: false, text: exchanged.message };

    return this.#storeAuthorizedToken({ provider: 'github', label: 'GitHub', flow, exchanged, clientId });
  }

  /**
   * Finish an authorization Cloudflare has redirected back to us.
   *
   * The GitHub flow minus the installation branch, which is GitHub's alone: a
   * Cloudflare OAuth client has no install page, so everything arriving here
   * either carries a state this coordinator minted or is refused.
   *
   * @param {{ code?: unknown, state?: unknown, origin: string }} args
   */
  async finishCloudflareAuthorization({ code, state, origin }) {
    const clientId = this.cloudflareOauth?.clientId;
    const clientSecret = this.cloudflareOauth?.clientSecret;
    if (!clientId || !clientSecret) {
      return { ok: false, text: 'This fleet has no Cloudflare OAuth client configured.' };
    }
    // A DEVICE'S SIGN-IN, for its person's vault: the code goes back to the
    // phone, which holds the verifier, and the minting Worker makes the
    // exchange. The same branch GitHub's callback has.
    if (DEVICE_STATE_RE.test(String(state ?? ''))) {
      const back = deviceReturnUrl({ code, state, provider: 'cloudflare' });
      return back
        ? { ok: true, device: back, text: 'Back to Fleetwright to finish signing in to Cloudflare.' }
        : { ok: false, text: 'Cloudflare did not send back a code to finish signing in with. Try again from the app.' };
    }
    const flow = this.pendingCloudflare.redeem(state);
    if (!flow) {
      // Deliberately one message for unknown, expired and replayed — same as
      // GitHub's, and for the same reason: telling a stranger which of those
      // it was is telling them whether a state exists.
      return { ok: false, text: 'That sign-in link has expired or was already used. Start again from the app.' };
    }
    // A person who pressed Deny arrives here with `error=access_denied` and no
    // code. The query's own words are NOT echoed — this page is reached by
    // following a link, and its text must not be writable from the URL.
    if (typeof code !== 'string' || !code) {
      return { ok: false, text: 'Cloudflare did not send an authorization code back.' };
    }

    if (flow.pkce) return this.#exchangeOnHost({ provider: 'cloudflare', flow, code, clientId, origin });

    const exchanged = await exchangeCloudflareCode({ clientId, clientSecret, code, origin });
    if (!exchanged.ok) return { ok: false, text: exchanged.message };

    return this.#storeAuthorizedToken({ provider: 'cloudflare', label: 'Cloudflare', flow, exchanged, clientId });
  }

  /**
   * Hand the code to the host that minted the verifier, and say what it said.
   *
   * THIS COORDINATOR NEVER SEES THE TOKENS on this path. It relays a code it
   * cannot spend to the one host that can, over the socket that host already
   * holds open; the host exchanges with its verifier and the client secret the
   * config frame gave it, stores the access token by its own `link`, deposits
   * the renewal material by its own `renew`, and answers with the sentence a
   * person should read. Compared with #storeAuthorizedToken below, what a
   * compromised coordinator learns at link time drops from "the access and
   * refresh tokens" to "a code it cannot use".
   *
   * `unknown_verb` cannot happen — a host that offered a challenge is a host
   * that speaks this verb — but it is answered anyway, because a silent
   * mismatch here would read as "GitHub refused" to the person.
   *
   * @param {{ provider: 'github'|'cloudflare', flow: { hostId: string, email: string|null },
   *   code: string, clientId: string, origin: string }} args
   */
  async #exchangeOnHost({ provider, flow, code, clientId, origin }) {
    const base = new URL(origin).origin;
    const reply = await this.dispatch({
      verb: 'exchange',
      params: { provider, code, clientId, origin: base },
      actor: flow.email ?? undefined,
      preferHost: flow.hostId,
      // The person authorized in a browser; the state is what proved who they
      // are, and it has just been spent.
      requester: null,
    });
    if (reply?.error?.code === 'unknown_verb') {
      return { ok: false, text: 'That host offered a secure sign-in it does not know how to finish. Update the host and try again.' };
    }
    if (reply?.ok === false) return { ok: false, text: reply.text || 'The host could not finish the sign-in.' };
    return { ok: true, text: reply?.text || connectedText({ label: provider === 'github' ? 'GitHub' : 'Cloudflare', expiresIn: null, renewable: false }) };
  }

  /**
   * Store what an authorization produced: the access token on the host, and
   * the renewal material beside it. One function for both providers, because
   * the storing half of the flow is where the invariants live and an invariant
   * implemented twice is one that drifts.
   *
   * THE ACCESS TOKEN, NEVER THE REFRESH TOKEN. The GitHub flow once read
   * `exchanged.refreshToken ?? exchanged.accessToken`, reaching for the
   * longer-lived value — and a refresh token is not an API credential. It
   * authenticates nothing: `GET /user` with one is a 401, every time. The
   * whole flow worked and then reported "GitHub rejected that token (401)",
   * which read like a bad token and was a wrong one.
   *
   * Stored by the verb that already does it: same validation, same redaction,
   * same per-person file. A second path into that storage is a second thing
   * to get right.
   *
   * @param {{ provider: string, label: string,
   *   flow: { hostId: string, email: string|null },
   *   exchanged: { accessToken?: string, refreshToken?: string|null, expiresIn?: number|null },
   *   clientId: string }} args
   */
  async #storeAuthorizedToken({ provider, label, flow, exchanged, clientId }) {
    const secret = exchanged.accessToken;
    const reply = await this.dispatch({
      verb: 'link',
      params: { provider, secret },
      actor: flow.email ?? undefined,
      preferHost: flow.hostId,
      // The person authorized in a browser; there is no fleet credential on
      // that request, and the state is what proved who they are.
      requester: null,
    });
    if (reply?.ok === false) return { ok: false, text: reply.text || 'The token could not be stored.' };

    // THE RENEWAL MATERIAL, DEPOSITED ONCE. The refresh token used to be
    // received here and thrown away, because there was nowhere for it to live
    // — so every GitHub App connection was dead eight hours after it was made,
    // and reconnecting was the only remedy.
    //
    // IT GOES TO THE HOST, WITH THE CLIENT SECRET, which is docs/trust.md's
    // rule and not a convenience: "spreading minting keys across hosts means a
    // compromised host costs that host's access; centralising them means a
    // compromised coordinator costs everything." Keeping refresh tokens here
    // would make this internet-facing component hold every member's renewable
    // credential, which is the outcome that rule exists to refuse.
    //
    // A separate verb rather than two more parameters on `link`, because
    // adding a parameter is the flag day and adding a verb is free — an older
    // host answers `unknown_verb` and simply keeps behaving as it does today.
    let renewable = false;
    if (exchanged.refreshToken) {
      const deposited = await this.dispatch({
        verb: 'renew',
        // NO CLIENT SECRET HERE ANY MORE. It used to travel with the deposit
        // and be written to disk beside the refresh token, which is what
        // github-app.md has always said does not happen. It arrives on the
        // config frame instead and stays in the sidecar's memory.
        params: { provider, clientId, refresh: exchanged.refreshToken },
        actor: flow.email ?? undefined,
        preferHost: flow.hostId,
        requester: null,
      });
      renewable = deposited?.ok !== false;
      // Not fatal. The connection works until the token expires either way,
      // and failing the whole flow over the part that makes it last would
      // throw away a credential the person just authorised.
      if (!renewable) this.log?.warn?.(`${provider}: ${flow.hostId} could not store renewal material: ${deposited?.text}`);
    }

    // The sentence is shared with the host's own exchange path (connectedText),
    // because it carries a promise that has to mean the same thing wherever
    // it was decided.
    return { ok: true, text: connectedText({ label, expiresIn: exchanged.expiresIn, renewable }) };
  }

  /**
   * @param {{ email?: string|null, admin?: boolean }|null} [requester]
   */
  recentEvents(requester = null) {
    return visibleEvents(this.events.slice(-EVENT_PAGE), requester);
  }

  /**
   * What the snapshot says about starting machines, for one person.
   * @param {{ email?: string|null, admin?: boolean }|null} requester
   * @returns {{ repo: string, own: boolean }|null}
   */
  #runnersFor(requester) {
    const own = this.runnerRepos.get(requester?.email);
    if (own) return { repo: own, own: true };
    return this.runnerRepo ? { repo: this.runnerRepo, own: false } : null;
  }

  /**
   * One person's runner repository, and the fleet's beside it, for the
   * setting's screen. The fleet's is shown so a person can see what they get
   * by leaving theirs empty.
   * @param {{ email?: string|null }|null} requester
   */
  runnerRepoFor(requester) {
    return { ok: true, repo: this.runnerRepos.get(requester?.email), fleet: this.runnerRepo || null };
  }

  /**
   * Set somebody's runner repository — ONLY IF IT PASSES THE CHECK.
   *
   * The check runs on a permanent box with their GitHub connection (see the
   * `runnerrepo` verb), and nothing is saved unless every answer is one a
   * dispatch can use. Saving an unchecked name would move the failure to the
   * moment somebody asks for a machine, which is the moment they can least
   * afford to debug a repository setting. What is saved is the name as GitHub
   * spells it, because that is the spelling a job's token will carry.
   *
   * @param {{ email?: string|null, admin?: boolean }|null} requester
   * @param {unknown} repo
   */
  async setRunnerRepo(requester, repo) {
    const email = String(requester?.email || '').toLowerCase();
    if (!email) {
      return {
        ok: false,
        error: { code: 'not_signed_in' },
        text: 'A runner repository belongs to a person, so this needs a signed-in identity.',
      };
    }
    // THE MINTING WORKER FIRST, as the App, so no permanent box is needed; a
    // box with the person's GitHub connection only when the Worker holds no
    // key or cannot be reached — the same order a mint takes.
    /** @type {any} */
    let reply = null;
    if (this.minter?.runnerRepo) {
      reply = await this.minter.runnerRepo({ repo: String(repo ?? '') }).then(
        (r) => (r && typeof r === 'object' ? r : null),
        () => null,
      );
      if (reply?.needsMinter) reply = null;
    }
    reply ??= await this.dispatch({ verb: 'runnerrepo', params: { repo: String(repo ?? '') }, actor: email, requester });
    const check = reply?.runnerRepo;
    if (reply?.ok === false || !check?.ok) {
      return {
        ok: false,
        error: reply?.error ?? { code: 'check_failed' },
        ...(check ? { runnerRepo: check } : {}),
        ...(reply?.needsConnection ? { needsConnection: reply.needsConnection } : {}),
        text: `${reply?.text || 'The check did not pass.'} Nothing was saved.`,
      };
    }
    const saved = this.runnerRepos.set(email, check.repo);
    if (saved.ok === false) return { ok: false, error: { code: 'not_saved' }, text: saved.text };
    this.onStateChanged?.();
    this.record({ event: 'runner.repo', actor: email, text: `${email} will start machines from ${check.repo}` });
    return { ok: true, repo: check.repo, runnerRepo: check, text: check.message };
  }

  /** @param {{ email?: string|null }|null} requester */
  clearRunnerRepo(requester) {
    const email = String(requester?.email || '').toLowerCase();
    const had = email ? this.runnerRepos.clear(email) : false;
    if (had) this.onStateChanged?.();
    return {
      ok: true,
      text: had
        ? (this.runnerRepo
          ? `Cleared. Your machines will come from the fleet's repository, ${this.runnerRepo}.`
          : 'Cleared. There is nowhere to start a machine from until you set one again.')
        : 'You had no runner repository set.',
    };
  }

  /**
   * WHICH REPOSITORIES AND WORKFLOWS MAY ADMIT THIS JOB, decided before its
   * GitHub token is verified, because verification is against this answer.
   *
   * The operator's allowlist, as it always was — plus, for a job presenting a
   * live ticket minted for a repository NOT on that list, that one repository
   * and the one workflow file its platform names. Nothing else widens the
   * list: a stored runner repository admits nothing on its own, and a ticket
   * for a repository admits only a job from that repository running that
   * workflow. The ticket is only peeked at here; it is spent after the token
   * verifies, so a job whose token fails does not burn it.
   *
   * Null means nobody may: no allowlist, and no ticket that names a repository.
   *
   * @param {unknown} claim what the job presented as its claim
   * @param {{ repositories: string[], workflowRef: string[] }} operator
   * @returns {Promise<{ repositories: string[], workflowRef: string[] }|null>}
   */
  async runnerAdmission(claim, operator) {
    const peeked = RunnerTickets.looksLikeTicket(claim) ? await this.runnerTickets.peek(claim) : null;
    const repository = peeked?.repository || '';
    const listed = operator.repositories.some((r) => r.toLowerCase() === repository.toLowerCase());
    if (repository && !listed) {
      const file = Object.hasOwn(RUNNER_WORKFLOWS, peeked?.platform || '')
        ? RUNNER_WORKFLOWS[/** @type {keyof typeof RUNNER_WORKFLOWS} */ (peeked?.platform)]
        : null;
      if (!file) return null;
      return { repositories: [repository], workflowRef: [`${repository}/.github/workflows/${file}@`] };
    }
    return operator.repositories.length ? operator : null;
  }

  /**
   * After a ticket is spent: was it spent by a job from the repository it was
   * minted for? A ticket that names one and arrives from another is refused —
   * it was dispatched somewhere else, and whoever holds it is not that run.
   *
   * @param {{ repository?: string|null }|null} ticket @param {{ repository: string }} job
   */
  static ticketFitsJob(ticket, job) {
    if (!ticket?.repository) return true;
    return ticket.repository.toLowerCase() === String(job?.repository || '').toLowerCase();
  }

  /**
   * A runner enrolled on a ticket that asked for a session: remember it until
   * the runner's first health frame, which is the moment it can start one.
   *
   * @param {string} hostId
   * @param {{ owner: string, start?: { title?: string, brief?: string, mode?: string, task?: string }|null }|null} ticket
   */
  noteRunnerEnrolled(hostId, ticket) {
    if (!ticket?.start || !ticket.owner) return;
    while (this.runnerStarts.size >= MAX_RUNNER_STARTS) {
      const oldest = this.runnerStarts.keys().next().value;
      if (oldest === undefined) break;
      this.runnerStarts.delete(oldest);
    }
    this.runnerStarts.set(hostId, { owner: ticket.owner, start: { ...ticket.start }, until: this.now() + RUNNER_START_TTL_MS });
    this.onStateChanged?.();
  }

  /** The pending runner sessions, for storage. @returns {Array<[string, any]>} */
  serialiseRunnerStarts() {
    const now = this.now();
    return [...this.runnerStarts.entries()].filter(([, v]) => v.until > now);
  }

  /** @param {unknown} entries */
  restoreRunnerStarts(entries) {
    if (!Array.isArray(entries)) return;
    const now = this.now();
    for (const e of entries) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || !e[1] || typeof e[1].owner !== 'string') continue;
      if (!(Number(e[1].until) > now) || !e[1].start || typeof e[1].start !== 'object') continue;
      this.runnerStarts.set(e[0], { owner: e[1].owner, start: { ...e[1].start }, until: Number(e[1].until) });
    }
  }

  /**
   * The session somebody asked for when they asked for the machine, started on
   * that machine's first health frame — the first moment the fleet knows the
   * box is up and answering.
   *
   * Taken out of the map BEFORE the start is sent, so a second frame arriving
   * while the first start is still waiting on Remote Control cannot start a
   * second session. Started AS THE OWNER, placed by name: an ephemeral host
   * takes work only from its owner and only when named, and both are true
   * here. Not awaited by the health path — a start can take a minute and the
   * health frame should not wait for it. The session announces itself the way
   * every session does (its Remote Control link is a notification); a start
   * that fails is recorded, so it is not silence.
   *
   * @param {string} hostId
   */
  async #startOnRunner(hostId) {
    const pending = this.runnerStarts.get(hostId);
    if (!pending) return;
    this.runnerStarts.delete(hostId);
    this.onStateChanged?.();
    if (pending.until <= this.now()) return;
    const reply = await this.dispatch({
      verb: 'start',
      params: pending.start,
      actor: pending.owner,
      preferHost: hostId,
      requester: { email: pending.owner, admin: false },
    }).catch((e) => ({ ok: false, text: /** @type {Error} */ (e).message }));
    this.record({
      hostId,
      event: reply?.ok === false ? 'runner.start-failed' : 'runner.started',
      actor: pending.owner,
      text: reply?.ok === false
        ? `the session ${pending.owner} asked for could not start on ${hostId}: ${reply?.text || 'no reason given'}`
        : `started the session ${pending.owner} asked for on ${hostId}`,
    });
  }

  /**
   * A box too old to carry somebody's own runner repository, refused here
   * rather than sent. `buildIntent` drops a param newer than the host speaks,
   * which is right for an optional capability and wrong for this one: the
   * dispatch would go to the FLEET's repository instead, starting a machine
   * somewhere the person did not choose, and the reply would say it worked.
   *
   * @param {any} host @param {any} spec
   * @returns {{ ok: false, error: { code: string }, text: string }|null}
   */
  #cannotCarry(host, spec) {
    // A TASK, for the same reason: dropped, the session starts idle — the thing
    // `task` exists to end — and the reply says it started.
    if (spec.verb === 'start' && typeof spec.params?.task === 'string' && spec.params.task) {
      const speaks = Number(host?.health?.protocol);
      if (Number.isInteger(speaks) && speaks >= 7) return null;
      return {
        ok: false,
        error: { code: 'host_outdated' },
        text:
          `${host?.hostId} is too old to be handed a task — it speaks protocol ` +
          `${Number.isInteger(speaks) ? speaks : 'an older version'}, and this needs 7. Update it, or start the ` +
          'session there with a profile.',
      };
    }
    if (spec.verb !== 'provision' || !spec.params?.repo) return null;
    const speaks = Number(host?.health?.protocol);
    if (Number.isInteger(speaks) && speaks >= 6) return null;
    return {
      ok: false,
      error: { code: 'host_outdated' },
      text:
        `${host?.hostId} is too old to start a machine from your own runner repository — it speaks protocol ` +
        `${Number.isInteger(speaks) ? speaks : 'an older version'}, and this needs 6. Update it and ask again.`,
    };
  }

  /**
   * `provision` or `runnerrepo`, tried on each permanent box until one can
   * answer for this person. See the refusal branch in dispatch for why.
   *
   * In hostId order, so the same fleet asks in the same order every time and a
   * person who connected GitHub on one box gets the same box every time.
   * Sequential rather than all at once: a dispatch starts a machine, and two
   * boxes answering the same request would start two.
   *
   * @param {any} spec
   */
  async #askEachBox(spec) {
    const boxes = this.registry
      .reachable()
      .filter((h) => !h.ephemeral)
      .sort((a, b) => a.hostId.localeCompare(b.hostId));
    /** @type {string[]} */
    const skipped = [];
    for (const host of boxes) {
      if (this.#cannotCarry(host, spec)) {
        skipped.push(`${host.hostId} (needs updating)`);
        continue;
      }
      let answer;
      try {
        answer = explainUnknownVerb(await this.send(host, spec), host);
      } catch (e) {
        skipped.push(`${host.hostId} (${/** @type {Error} */ (e).message})`);
        continue;
      }
      if (answer?.ok === false && (answer.needsConnection || answer.needsMinter || answer.error?.code === 'unknown_verb')) {
        skipped.push(
          `${host.hostId} (${answer.needsConnection ? 'GitHub not connected for you' : answer.needsMinter ? 'holds no GitHub App key' : 'needs updating'})`,
        );
        continue;
      }
      return { ...answer, hostId: host.hostId };
    }
    if (spec.verb === 'mint') {
      // SAID AS WHICH HALF IS MISSING, because they are fixed by different
      // people: the key is an operator's, on one box; the connection is the
      // person's, from the app.
      return {
        ok: false,
        error: { code: 'no_minter' },
        text:
          `No permanent box could mint a repository token for you: ${skipped.join(', ') || 'none is connected'}. ` +
          'It takes a box that holds the fleet\u2019s GitHub App key and has your GitHub connection.',
      };
    }
    return {
      ok: false,
      error: { code: 'not_connected' },
      needsConnection: 'github',
      text:
        `None of the permanent boxes could ask GitHub for you: ${skipped.join(', ')}. ` +
        'Connect GitHub in the app — it is your own connection that starts the machine — and ask again.',
    };
  }


  /**
   * A dispatch ticket for a runner this person asked for, and the repository
   * it will run in — the part of `provision` that does not need a box.
   *
   * Shared by the two ways a runner is started: a permanent box dispatching
   * the workflow with the person's GitHub connection (`provision`), and the
   * person's own device dispatching it with its own (`prepareRunnerDispatch`).
   * Either way the coordinator decides the repository and mints the ticket;
   * what differs is only whose hands carry it to GitHub.
   *
   * @param {{ email?: string|null }|null|undefined} requester
   * @param {string} platform
   * @param {any} startAfter  a session to start when it joins, `start`'s rules
   * @param {string|null} actor
   * @returns {Promise<{ ok: true, ticket: string, repository: string, own: string|null }
   *   | { ok: false, error: { code: string }, text: string }>}
   */
  async #mintRunnerTicket(requester, platform, startAfter, actor) {
    const owner = String(requester?.email || '').toLowerCase();
    if (!owner) {
      return {
        ok: false,
        error: { code: 'not_signed_in' },
        text:
          'A runner belongs to the person who asked for it, so this needs a signed-in identity. ' +
          'Sign in on a device and use its credential rather than the fleet-wide admin token.',
      };
    }
    // WHOSE REPOSITORY: the person's own when they set one, the fleet's
    // otherwise. Decided here and never taken from the caller — whatever
    // arrived in `repo` is replaced or removed below.
    const own = this.runnerRepos.get(owner);
    const repository = own || this.runnerRepo;
    if (!repository) {
      return {
        ok: false,
        error: { code: 'not_configured' },
        text:
          'There is nowhere to start a machine from yet. Set your own runner repository in the app — a ' +
          'public repository with the Fleetwright GitHub App installed and the runner workflows in it — or ' +
          'an operator sets FLEETWRIGHT_RUNNER_REPO for the whole fleet. See docs/runner-central.md.',
      };
    }
    // A SESSION TO START WHEN IT JOINS, if the caller asked for one. Beside
    // the params like `host`, never inside them — the host dispatching the
    // run has nothing to do with it — and checked against `start`'s own rules
    // so a runner is never handed a session request the protocol would
    // refuse. A task, and title, brief and mode: a runner is minutes old and
    // holds no task profiles or secrets to name, so the words are how it is
    // given its job.
    /** @type {{ title?: string, brief?: string, mode?: string, task?: string }|null} */
    let start = null;
    if (startAfter && typeof startAfter === 'object') {
      /** @type {Record<string, any>} */
      const wanted = {};
      for (const k of ['title', 'brief', 'mode', 'task']) {
        if (startAfter[k] !== undefined && startAfter[k] !== null) wanted[k] = startAfter[k];
      }
      const checked = checkParams('start', wanted);
      if (checked.ok === false) return { ok: false, error: { code: 'bad_params' }, text: checked.error };
      start = /** @type {any} */ (checked.params);
    }
    const ticket = await this.runnerTickets.mint({
      owner,
      platform,
      repository,
      start,
    });
    // Persisted before the dispatch leaves, not after it succeeds: a ticket
    // that is spent by a job but was never written down is an unattributed
    // host, and the window between minting and enrolment is minutes long —
    // long enough to contain a restart, which is precisely the case this
    // exists for.
    this.onStateChanged?.();
    this.record({
      event: 'runner.requested',
      actor,
      // Never the ticket. It is single-use and short-lived and it is still a
      // value that attributes a machine to a person, and the event ring is
      // read by every device this fleet has issued a credential to.
      text: `${owner} asked for a ${platform} runner from ${repository}`,
    });
    return { ok: true, ticket: ticket.token, repository, own: own || null };
  }

  /**
   * Everything a person's own device needs to start a runner itself.
   *
   * THE WAY TO START A RUNNER WITH NO PERMANENT BOX. `provision` hands the
   * dispatch to a box because a box held the person's GitHub connection; a
   * phone that has signed in to GitHub, or a computer with `gh`, holds one of
   * its own. So this mints the same ticket and remembers the same held
   * session, and instead of sending them to a box it gives the caller what to
   * send to GitHub: the repository, the workflow file, and the inputs. The run
   * is then started by the person themselves, which is what makes everything
   * after it work — GitHub's job token names them, and the minter gives their
   * runner their repository tokens and their Claude login.
   *
   * What this hands out is what the box was handed: a single-use ticket for a
   * dispatch only this person can make, into a repository the coordinator
   * chose. Nothing here is a GitHub credential.
   *
   * @param {{ email?: string|null }|null} requester
   * @param {{ platform?: unknown, minutes?: unknown, start?: unknown }|null} body
   * @param {string} origin  this coordinator's own, which the runner enrols with
   * @returns {Promise<Record<string, any>>}
   */
  async prepareRunnerDispatch(requester, body, origin) {
    /** @type {Record<string, unknown>} */
    const wanted = { platform: body?.platform };
    if (body?.minutes !== undefined && body?.minutes !== null) wanted.minutes = body.minutes;
    const shaped = checkParams('provision', wanted);
    if (shaped.ok === false) return { ok: false, error: { code: 'bad_params' }, text: shaped.error };
    const platform = /** @type {keyof typeof RUNNER_WORKFLOWS} */ (String(shaped.params.platform));
    const minted = await this.#mintRunnerTicket(requester, platform, body?.start, requester?.email ? `app:${requester.email}` : null);
    if (minted.ok === false) return minted;
    const minutes = String(shaped.params.minutes ?? DEFAULT_RUNNER_MINUTES);
    return {
      ok: true,
      repo: minted.repository,
      workflow: RUNNER_WORKFLOWS[platform],
      inputs: { minutes, ticket: minted.ticket, coordinator: origin },
      text:
        `Start it by dispatching ${RUNNER_WORKFLOWS[platform]} in ${minted.repository} with your own GitHub sign-in. ` +
        'The ticket is good once, for forty-five minutes.',
    };
  }

  /**
   * Is a host connected that has not reported yet, recently enough that its
   * first report is on its way? Older than the wait, it is a host that is not
   * going to report, and the registry already says so in its own words.
   */
  #awaitingFirstHealth() {
    const now = this.now();
    return this.registry.list().some(
      (h) => h.connected && h.state === 'unknown' && now - h.connectedAt < this.firstHealthWaitMs,
    );
  }

  /**
   * Until some host has reported or the wait runs out, whichever is first. A
   * poll rather than a hook into recordHealth: it runs only in the seconds after
   * a restart, and a quarter of a second is shorter than anyone notices.
   */
  async #firstHealth() {
    const deadline = this.now() + this.firstHealthWaitMs;
    while (this.#awaitingFirstHealth() && this.now() < deadline) {
      await new Promise((resolve) => this.setTimer(() => resolve(undefined), 250));
      if (this.registry.list().some((h) => h.connected && h.state === 'healthy')) return;
    }
  }

  /**
   * A runner wants git credentials for one repository.
   *
   * What the coordinator adds is the one thing only it knows: WHOSE runner this
   * is, decided at enrolment. It turns the frame into a `mint` for that person's
   * permanent boxes and relays the answer back down the runner's socket. What
   * it relays is sealed to a key only the runner holds (src/fleet/seal.js), and
   * the job token it forwards names this exact request in its audience, so a
   * coordinator that changed the repository, the key or the person would be
   * refused by the box rather than trusted by it.
   *
   * Only an EPHEMERAL host with an OWNER may ask. A permanent box has the
   * person's own connection already and needs no minted token; a runner with no
   * owner has nobody to mint for.
   *
   * @param {string} hostId @param {any} msg
   */
  async #onRunnerMint(hostId, msg) {
    const host = this.registry.hosts.get(hostId);
    const id = typeof msg.id === 'string' && FRAME_ID_RE.test(msg.id) ? msg.id : null;
    if (!id) {
      this.log.warn(`coordinator: ${hostId} asked for a repository token without an id to answer on`);
      return;
    }
    /** @param {Record<string, unknown>} answer */
    const answer = (answer) => {
      try {
        host?.send?.({ v: PROTOCOL_VERSION, kind: 'minted', id, ...answer });
      } catch { /* the socket is going; the runner's wait runs out and says so */ }
    };
    if (!host?.ephemeral || !host.owner) {
      answer({ ok: false, error: { code: 'not_a_runner' }, text: 'Only a temporary machine with an owner is minted repository tokens.' });
      return;
    }
    const repo = String(msg.repo || '');
    const job = String(msg.job || '');
    const key = String(msg.key || '');
    if (!REPO_RE.test(repo) || !JWT_RE.test(job) || job.length > 8192 || !SEAL_KEY_RE.test(key)) {
      answer({ ok: false, error: { code: 'bad_params' }, text: 'That request for a repository token is not in the shape one takes.' });
      return;
    }
    const now = this.now();
    const recent = (this.mintAsks.get(hostId) || []).filter((t) => now - t < MINT_WINDOW_MS);
    if (recent.length >= MAX_MINTS_PER_WINDOW) {
      answer({
        ok: false,
        error: { code: 'too_many' },
        text: `${hostId} has asked for ${recent.length} repository tokens in ten minutes. A token lasts an hour; ask again later.`,
      });
      return;
    }
    recent.push(now);
    this.mintAsks.set(hostId, recent);

    // THE MINTING WORKER FIRST, a permanent box only when it cannot answer —
    // it holds no key, or it is not there. A refusal from the Worker is final:
    // it checked the request against GitHub, and asking a box the same
    // question would only look for a second opinion on a no.
    /** @type {any} */
    let reply = null;
    if (this.minter) {
      reply = await this.minter.mint({ repo, job, key }).then(
        (r) => ({
          ok: r?.ok === true,
          text: typeof r?.text === 'string' ? r.text : '',
          ...(r?.ok === true ? { sealed: r.sealed, repo: r.repo, expiresAt: r.expiresAt, permissions: r.permissions } : {}),
          ...(r?.error?.code ? { error: { code: String(r.error.code) } } : {}),
          ...(r?.needsMinter ? { needsMinter: true } : {}),
          hostId: 'the minting Worker',
        }),
        (e) => ({ ok: false, needsMinter: true, text: `the minting Worker did not answer: ${/** @type {Error} */ (e).message}` }),
      );
    }
    if (!reply || (reply.ok === false && reply.needsMinter)) {
      reply = await this.#askEachBox({
        verb: 'mint',
        params: { repo, job, key },
        actor: host.owner,
        internal: true,
        requester: { email: host.owner, admin: false },
      });
    }
    // RECORDED EITHER WAY, by repository and outcome — never the token, which
    // this process could not read if it wanted to. "Whose runner reached which
    // private repository, and which box let it" is the question an audit of
    // this feature asks, and the ring is where it is answered.
    this.record({
      hostId,
      event: reply?.ok ? 'runner.token' : 'runner.token-refused',
      actor: host.owner,
      verb: 'mint',
      text: reply?.ok
        ? `${host.owner}\u2019s runner ${hostId} was given a token for ${reply.repo || repo} by ${reply.hostId}`
        : `${host.owner}\u2019s runner ${hostId} was refused a token for ${repo}: ${reply?.text || 'no reason given'}`,
    });
    answer(
      reply?.ok
        ? { ok: true, sealed: reply.sealed, repo: reply.repo, expiresAt: reply.expiresAt, permissions: reply.permissions, text: reply.text }
        : { ok: false, error: reply?.error || { code: 'refused' }, text: reply?.text || 'No box would mint that token.' },
    );
  }

  /**
   * A runner wants its owner's Claude login.
   *
   * The same relay as #onRunnerMint, to the minting Worker's `claude` half and
   * nowhere else: there is no permanent box to fall back to, because no box
   * holds a person's deposited login. The coordinator adds whose runner this
   * is — for the record and for the reply, so the runner knows which person's
   * sessions the login is for — and carries back ciphertext it cannot open.
   * What decides the answer is the job token, checked by the minter against
   * GitHub, and not anything said here.
   *
   * A refusal is ordinary: most people will not have deposited one, and their
   * runner then uses its repository's API key, as every runner did before.
   *
   * @param {string} hostId @param {any} msg
   */
  async #onRunnerClaude(hostId, msg) {
    const host = this.registry.hosts.get(hostId);
    const id = typeof msg.id === 'string' && FRAME_ID_RE.test(msg.id) ? msg.id : null;
    if (!id) {
      this.log.warn(`coordinator: ${hostId} asked for a Claude login without an id to answer on`);
      return;
    }
    /** @param {Record<string, unknown>} answer */
    const answer = (answer) => {
      try {
        host?.send?.({ v: PROTOCOL_VERSION, kind: 'minted', id, ...answer });
      } catch { /* the socket is going; the runner's wait runs out and says so */ }
    };
    if (!host?.ephemeral || !host.owner) {
      answer({ ok: false, error: { code: 'not_a_runner' }, text: 'Only a temporary machine with an owner is given a Claude login.' });
      return;
    }
    const job = String(msg.job || '');
    const key = String(msg.key || '');
    if (!JWT_RE.test(job) || job.length > 8192 || !SEAL_KEY_RE.test(key)) {
      answer({ ok: false, error: { code: 'bad_params' }, text: 'That request for a Claude login is not in the shape one takes.' });
      return;
    }
    const now = this.now();
    const recent = (this.claudeAsks.get(hostId) || []).filter((t) => now - t < MINT_WINDOW_MS);
    if (recent.length >= MAX_CLAUDE_PER_WINDOW) {
      answer({ ok: false, error: { code: 'too_many' }, text: `${hostId} has asked for a Claude login ${recent.length} times in ten minutes.` });
      return;
    }
    recent.push(now);
    this.claudeAsks.set(hostId, recent);

    const reply = await this.#askMinterClaude('login', { job, key });
    this.record({
      hostId,
      event: reply.ok ? 'runner.claude' : 'runner.claude-refused',
      actor: host.owner,
      text: reply.ok
        ? `${host.owner}’s runner ${hostId} was given ${reply.login || 'their'} Claude login`
        : `${host.owner}’s runner ${hostId} runs on its repository’s API key: ${reply.text || 'no reason given'}`,
    });
    answer(
      reply.ok
        ? { ok: true, sealed: reply.sealed, login: reply.login, owner: host.owner, text: reply.text }
        : { ok: false, owner: host.owner, error: reply.error || { code: 'refused' }, text: reply.text || 'No Claude login for this runner.' },
    );
  }

  /**
   * A box asks for what its people approved it to hold.
   *
   * The request is signed by the box's own key, and the minting Worker decides
   * everything from that signature and the approvals people made from their
   * phones (src/fleet/minter/vault.js). What this adds is one check of its
   * own, that the key is the one this box enrolled with: an honest coordinator
   * refuses a box that presents somebody else's key, and a dishonest one gains
   * nothing by skipping the check, because the answer is sealed to the box.
   *
   * @param {string} hostId @param {any} msg
   */
  async #onHostVault(hostId, msg) {
    const host = this.registry.hosts.get(hostId);
    const id = typeof msg.id === 'string' && FRAME_ID_RE.test(msg.id) ? msg.id : null;
    if (!id) {
      this.log.warn(`coordinator: ${hostId} asked for its vault without an id to answer on`);
      return;
    }
    /** @param {Record<string, unknown>} answer */
    const answer = (answer) => {
      try {
        host?.send?.({ v: PROTOCOL_VERSION, kind: 'minted', id, ...answer });
      } catch { /* the socket is going; the box asks again on its next pass */ }
    };
    const request = msg.request;
    const signature = String(msg.signature || '');
    const enrolled = this.hostIds?.get(hostId);
    const k = request?.hostKey;
    if (!request || typeof request !== 'object' || JSON.stringify(request).length > 2048 || signature.length > 200) {
      answer({ ok: false, error: { code: 'bad_params' }, text: 'That vault request is not in the shape one takes.' });
      return;
    }
    if (!enrolled?.publicJwk || enrolled.revokedAt || k?.x !== enrolled.publicJwk.x || k?.y !== enrolled.publicJwk.y) {
      answer({ ok: false, error: { code: 'not_this_box' }, text: `That is not the key ${hostId} enrolled with.` });
      return;
    }
    if (!this.minter?.vault) {
      answer({ ok: false, error: { code: 'no_minter' }, text: 'This fleet has no minting Worker to keep a vault.' });
      return;
    }
    const now = this.now();
    const key = `box-vault:${hostId}`;
    const recent = (this.claudeAsks.get(key) || []).filter((t) => now - t < MINT_WINDOW_MS);
    if (recent.length >= MAX_BOX_VAULT_PER_WINDOW) {
      answer({ ok: false, error: { code: 'too_many' }, text: `${hostId} has asked for its vault ${recent.length} times in ten minutes.` });
      return;
    }
    recent.push(now);
    this.claudeAsks.set(key, recent);
    const r = await this.minter.vault('box', { request, signature }).then(
      (x) => (x && typeof x === 'object' ? x : { ok: false, error: { code: 'refused' }, text: 'The minting Worker gave no answer.' }),
      (e) => ({ ok: false, error: { code: 'minter_unreachable' }, text: `The minting Worker did not answer: ${/** @type {Error} */ (e).message}.` }),
    );
    answer(r.ok
      ? { ok: true, sealed: r.sealed, text: String(r.text || '') }
      : { ok: false, error: { code: String(r.error?.code || 'refused') }, text: String(r.text || 'The minting Worker refused it.') });
  }

  /**
   * Ask the minting Worker's Claude half, and turn "there is none" and "it did
   * not answer" into refusals like any other, so no caller has to know which
   * of the three it was.
   *
   * @param {'key'|'deposit'|'login'} route @param {Record<string, unknown>} ask
   * @returns {Promise<any>}
   */
  async #askMinterClaude(route, ask) {
    if (!this.minter?.claude) {
      return {
        ok: false,
        error: { code: 'no_minter' },
        text: 'This fleet has no minting Worker that keeps Claude logins. See docs/runner-central.md, “Your Claude login on a runner”.',
      };
    }
    return this.minter.claude(route, ask).then(
      (r) => (r && typeof r === 'object' ? r : { ok: false, error: { code: 'refused' }, text: 'The minting Worker gave no answer.' }),
      (e) => ({ ok: false, error: { code: 'minter_unreachable' }, text: `The minting Worker did not answer: ${/** @type {Error} */ (e).message}.` }),
    );
  }

  /**
   * The key a person seals their Claude login to, as the minting Worker states
   * it. Offered so the deposit tool can show it — and compare it with the pin
   * the person was given, because a coordinator is exactly what would swap it.
   *
   * @returns {Promise<{ ok: boolean, key?: string, error?: { code: string }, text?: string }>}
   */
  async claudeLoginKey() {
    const r = await this.#askMinterClaude('key', {});
    return r.ok && typeof r.key === 'string' && SEAL_KEY_RE.test(r.key)
      ? { ok: true, key: r.key }
      : { ok: false, error: { code: String(r.error?.code || 'refused') }, text: String(r.text || 'The minting Worker has no deposit key.') };
  }

  /**
   * A person deposits, replaces or forgets their Claude login.
   *
   * The body is sealed on their computer to the minting Worker's key, and this
   * carries it through unread. Whose login it is comes from GitHub, inside the
   * seal, and is the minter's to decide; the requester here is only recorded,
   * so the fleet's events say which member made a deposit for which GitHub
   * account.
   *
   * @param {{ email?: string|null }|null} requester @param {any} body
   * @returns {Promise<Record<string, unknown>>}
   */
  async depositClaudeLogin(requester, body) {
    const sealed = body?.sealed;
    if (!sealed || typeof sealed !== 'object' || JSON.stringify(sealed).length > 8192) {
      return { ok: false, error: { code: 'bad_params' }, text: 'That is not a sealed Claude login.' };
    }
    const r = await this.#askMinterClaude('deposit', { sealed: { epk: sealed.epk, iv: sealed.iv, ct: sealed.ct } });
    this.record({
      event: r.ok ? (r.forgotten ? 'claude.forgotten' : 'claude.deposited') : 'claude.deposit-refused',
      actor: requester?.email ?? null,
      text: r.ok
        ? `${requester?.email ?? 'someone'} ${r.forgotten ? 'forgot' : 'deposited'} the Claude login for GitHub account ${r.login}`
        : `${requester?.email ?? 'someone'}’s Claude login was refused: ${r.text || 'no reason given'}`,
    });
    return r.ok
      ? { ok: true, login: String(r.login || ''), forgotten: r.forgotten === true, text: String(r.text || '') }
      : { ok: false, error: { code: String(r.error?.code || 'refused') }, text: String(r.text || 'The minting Worker refused it.') };
  }

  /**
   * Everything a client can see about the fleet.
   *
   * FILTERED FOR WHOEVER IS ASKING, which it was not. This route returned
   * every host's health blob verbatim — and that blob carries, for every
   * session on every box, the name, the title, the working directory, who
   * created it, whose account it runs on, and the live prompt text
   * (`sidecar.js` health). So the visibility filter on `list` was being
   * enforced one route over while this one handed the whole fleet's work to
   * any member who asked.
   *
   * Topology is NOT filtered — which machines exist, what state they are in,
   * what code they run. A member needs the host picker to work, and the
   * existence of a box is not somebody's private information. What is private
   * is what is running on it.
   *
   * @param {{ email?: string|null, admin?: boolean }|null} [requester]
   */
  snapshot(requester = null) {
    return {
      protocol: PROTOCOL_VERSION,
      hosts: this.registry.list().map((h) => visibleHost(h, requester)),
      devices: this.devices.size,
      events: visibleEvents(this.events.slice(-20), requester),
      // WHETHER THIS FLEET CAN START A MACHINE, so a phone offers the button
      // on exactly the fleets where it does something. `provision` refuses
      // with a sentence when no runner repository is configured, and that
      // sentence is right for an agent that just asked — but a button that
      // answers "an operator sets FLEETWRIGHT_RUNNER_REPO" is a dead control
      // on every fleet that has not, which is most of them. The repository
      // name is not a secret: it is where the runner workflows live, and the
      // host it dispatches from names it in every refusal already.
      //
      // NULL IS AN ANSWER HERE, not cannot-tell: this coordinator knows it has
      // nowhere to start a machine. A coordinator too old to send the field
      // omits it, which decodes to the same nothing and is right as well.
      //
      // AND WHOSE: a person with their own runner repository sees theirs,
      // everybody else the fleet's. `own` tells a screen which it is, so the
      // setting shows what is in effect rather than what is typed.
      runners: this.#runnersFor(requester),
    };
  }
}

/**
 * `unsupported_version`, which had no explanation at all.
 *
 * The sibling of the function below and the more serious of the two, because
 * the two failures are not the same shape. `unknown_verb` means the host
 * understood the request and does not have that one command — so everything
 * else still gets through, INCLUDING `update`, and the fleet can fix it. A
 * version mismatch is refused by `validateIntent` before the verb is even read,
 * so nothing at all arrives and the remedy cannot be delivered over the
 * protocol that is refusing it.
 *
 * That difference is the whole message. Told the wrong one, somebody presses
 * Apply update, watches it be refused for the same reason, and concludes the
 * product is broken rather than that this box needs a person.
 *
 * The bare code reached a phone as one word — `unsupported_version` — while the
 * verb existed on the coordinator, so the request looked perfectly valid.
 * Finding D2 says the drift error "names `fleetwright update --restart`". It does
 * not: that is the OTHER error, and this one named nothing at all.
 *
 * WHAT CHANGED SINCE THAT PARAGRAPH WAS WRITTEN is the sentence in capitals it
 * used to end on. `update` now travels in a frozen envelope the coordinator
 * labels with the host's own version (RESCUE_VERB), so on a box that is BEHIND
 * it is the one command that still arrives — and telling somebody the fleet
 * cannot help would now be sending them to a machine they do not need to visit.
 * On a box that is AHEAD nothing changed and nothing should: pulling code on a
 * host that is already newer than the fleet is the fleet prescribing its own
 * symptom.
 *
 * @param {any} reply
 * @param {{ hostId: string, health?: any }|undefined} host
 */
function explainUnsupportedVersion(reply, host) {
  if (reply?.error?.code !== 'unsupported_version' || !host) return reply;
  // Below the fleet FLOOR now, not merely below its max — a host inside the
  // range is negotiated with and never reaches here. See PROTOCOL_MIN.
  const theirs = host.health?.protocol;
  const behind = Number.isInteger(theirs) && theirs < PROTOCOL_MIN;
  const fleet = PROTOCOL_MIN === PROTOCOL_VERSION ? `${PROTOCOL_VERSION}` : `${PROTOCOL_MIN}..${PROTOCOL_VERSION}`;
  const preamble =
    `${host.hostId} speaks protocol ${theirs ?? 'an older version'} and this fleet speaks ` +
    `${fleet}, so it refuses every command before reading it — not just this one.\n`;
  return {
    ...reply,
    text: behind
      ? preamble +
        'ONE COMMAND STILL GETS THROUGH. Apply update is sent in this box\u2019s own version precisely so a\n' +
        'drifted machine can be repaired from here, and it is the thing to try first:\n' +
        `  Apply update, on ${host.hostId}, from the app or \`fleet_update\`\n` +
        'If it comes back still on the old version, the pull found nothing newer — this box is pinned to a\n' +
        'channel that has no release for it, and that is the case that needs somebody on the machine:\n' +
        '  curl -fsSL <your coordinator>/install | sudo sh\n' +
        'Nothing else in the fleet is affected, and this host is already marked degraded so no new work ' +
        'is being sent to it.'
      : preamble +
        'THIS HOST IS AHEAD OF THE FLEET, which is what half a deploy looks like — hosts upgrade first and\n' +
        'the coordinator follows. THE FLEET CANNOT FIX THIS ONE from inside itself, and `update` is the\n' +
        'wrong direction: the box is already newer than the thing refusing it. What it is waiting for is\n' +
        'this coordinator to be deployed. Nothing else in the fleet is affected, and this host is already ' +
        'marked degraded so no new work is being sent to it.',
  };
}

/**
 * Turn `unknown_verb` from a host into the sentence somebody can act on.
 *
 * This refusal is the protocol working exactly as designed — adding a verb
 * costs no version bump precisely BECAUSE an older host answers `unknown_verb`
 * rather than misbehaving. What was missing is that the answer, as it reached
 * a phone, was the bare word: the verb exists on the coordinator, so the
 * request looked valid, and the failure named a thing rather than a remedy.
 *
 * The remedy is also the awkward part, and saying it out loud is the whole
 * point: THE VERB THAT FIXES THIS IS OFTEN THE ONE THAT IS UNKNOWN. `update`
 * over the fleet cannot update a box too old to have `update`. What works is
 * that box's own Telegram bot, or a shell on it — both of which talk to
 * fleetwright directly rather than through this protocol.
 *
 * A pull that did not restart looks identical from here, and is at least as
 * common: the files are new and the running process still holds the old verb
 * table. So the message names both, in the order they are likely.
 *
 * @param {any} reply
 * @param {{ hostId: string, health?: any }|undefined} host
 */
function explainUnknownVerb(reply, host) {
  if (reply?.error?.code !== 'unknown_verb' || !host) return reply;
  const behind = host.health?.updates?.appBehind ?? 0;
  const head = host.health?.version?.head;
  return {
    ...reply,
    text:
      `${host.hostId} does not know that command — it is running older code than this coordinator` +
      `${head ? ` (${head}${behind > 0 ? `, ${behind} behind` : ''})` : ''}.\n` +
      'This is the protocol refusing cleanly rather than guessing, and unlike a version mismatch it is\n' +
      'fixable from here, because everything EXCEPT the new verb still gets through:\n' +
      `  Apply update, on ${host.hostId}, from the app or \`fleet_update\`\n` +
      `  fleetwright update --restart      (or a shell on ${host.hostId})\n` +
      'A pull without a restart looks the same from here — the files are new and the running ' +
      'service still holds the old command list, which is why the shell line says --restart.',
  };
}

/**
 * Fold per-host `connections` replies into one answer with coverage in it.
 *
 * The catalogue is the same everywhere, so the first host's wins. What differs
 * is `connected`, and the difference is the point: `hosts` names where each
 * credential actually is, and `missing` names where it is not.
 *
 * @param {any[]} results
 */
function mergeConnections(results) {
  const withConnections = results.filter((r) => r?.connections?.catalogue);
  if (!withConnections.length) return null;

  /** @type {string[]} */
  const everywhere = results.map((r) => r.hostId).filter(Boolean);
  /** @type {Map<string, { provider: string, label: string|null, account: string|null, hosts: string[], usage?: any }>} */
  const byProvider = new Map();
  for (const r of withConnections) {
    for (const c of r.connections.connected || []) {
      // SPREAD THE HOST'S RECORD, then add coverage — rather than building a
      // fresh object from the four fields I happened to think of. The first
      // version dropped `missing` (the PERMISSIONS a token was not granted)
      // entirely, which is worse than the collision it was avoiding: a screen
      // that had been saying "missing workflow" would simply stop.
      const found = byProvider.get(c.provider) || { ...c, hosts: /** @type {string[]} */ ([]) };
      found.hosts.push(r.hostId);
      // An account name differing between hosts is possible and worth surfacing
      // rather than averaging: it means two different tokens are in play.
      if (c.account && found.account && c.account !== found.account) found.account = 'differs between machines';
      // WHAT THE ACCOUNT HAS LEFT is one fact about one plan, however many
      // boxes asked: the box that asked most recently has the answer, and a
      // box that could not ask never overwrites one that could.
      //
      // "COULD NOT ASK" IS NOT ONLY NULL. A box whose copy of the login has
      // expired answers with a report and no figures ("the credential has
      // expired and has not renewed yet"), and because it asked last, that
      // replaced a real reading from a box where the same account works. The
      // row then said expired while a Test on the other box said two hours
      // left. A reading beats a reason whenever it was taken; between two of
      // the same kind, the newer one wins.
      if (c.usage && (!found.usage || newerOrBetter(c.usage, found.usage))) {
        found.usage = c.usage;
      }
      byProvider.set(c.provider, found);
    }
  }

  return {
    catalogue: withConnections[0].connections.catalogue,
    connected: [...byProvider.values()].map((c) => ({
      ...c,
      // `absentFrom`, NOT `missing`. A connected credential already carries a
      // `missing` — the PERMISSIONS it was not granted — and spreading this on
      // top would have silently replaced "missing workflow" with "missing
      // deb14". Two different absences, and one word for both is how a screen
      // ends up telling somebody the wrong thing about their token.
      absentFrom: everywhere.filter((h) => !c.hosts.includes(h)),
    })),
    hosts: everywhere,
  };
}

/**
 * Whether usage report `a` should replace `b`: a report with figures beats one
 * without, and otherwise the newer one wins.
 *
 * @param {any} a @param {any} b
 */
function newerOrBetter(a, b) {
  const read = (/** @type {any} */ u) => Boolean(u?.windows);
  if (read(a) !== read(b)) return read(a);
  return (a.checkedAt ?? 0) > (b.checkedAt ?? 0);
}

/**
 * Whether a record belongs to the person asking.
 *
 * `fleet:<email>` is what the sidecar records as `createdBy`, and the
 * comparison is made in that form on purpose — see src/core/accounts.js. An
 * unattributed record belongs to the fleet, which is to say the admin: the
 * scenario this exists for is "my client must not read my org's other work",
 * and erring open would quietly break exactly that promise.
 *
 * @param {unknown} owner  a createdBy or an actor
 * @param {{ email?: string|null, admin?: boolean }|null} requester
 */
function ownedBy(owner, requester) {
  if (!requester || requester.admin) return true;
  const mine = String(requester.email || '').toLowerCase();
  if (!mine) return false;
  const theirs = String(owner || '').toLowerCase();
  return theirs === `fleet:${mine}` || theirs === mine;
}

/**
 * One host's listing, written from the records the caller may see.
 *
 * The host's own rendering cannot be reused: it describes every session on the
 * box, and the box does not know who is asking. So this is the same listing
 * said again over the filtered records — glyphs and shape borrowed from
 * `/list` in src/adapters/commands.js so the two read as one product, and
 * deliberately a separate few lines rather than an import, because that file
 * is host code with a filesystem behind it and this one runs in a Worker.
 *
 * "nothing of yours" and never "no sessions": the box may be holding a dozen,
 * and a screen may not report a state it does not know (C-5).
 *
 * @param {any[]} sessions  already filtered to the requester
 */
function describeOwnSessions(sessions) {
  if (!sessions.length) return 'nothing of yours';
  const running = sessions.filter((s) => String(s?.status || '') === 'running');
  const rest = sessions.filter((s) => String(s?.status || '') !== 'running');
  const lines = [`${running.length} of your sessions running, ${rest.length} resumable`, ''];
  // The Remote Control URL rides along on a running session, the way the
  // host's listing carries it: it is the caller's own session, and it is the
  // link they would otherwise ask for next.
  for (const s of running) lines.push(`▶ ${sessionLabel(s)}${s?.rcUrl ? `\n   ${s.rcUrl}` : ''}`);
  if (rest.length) {
    lines.push('', 'Resumable:');
    for (const s of rest) lines.push(`◼ ${sessionLabel(s)}`);
  }
  return lines.join('\n');
}

/**
 * A session on one line. A title is a label, not a transcript — somebody
 * pasted a whole task in as one, and the listing rendered its first paragraph.
 *
 * @param {any} s
 */
function sessionLabel(s) {
  const title = s?.title ? String(s.title).split('\n')[0].trim() : '';
  const short = title.length > 48 ? `${title.slice(0, 47)}…` : title;
  return short ? `${s.name} · ${short}` : String(s?.name ?? '');
}

/**
 * One host, with everything private to somebody else removed.
 *
 * The host keeps its identity, its state, its capacity and its version. It
 * loses the per-session detail that is not the requester's, and `resumable`
 * with it — a list of names somebody cannot act on is an existence oracle
 * wearing a convenience.
 *
 * @param {any} host
 * @param {{ email?: string|null, admin?: boolean }|null} requester
 */
function visibleHost(host, requester) {
  if (!requester || requester.admin || !host?.health) return host;
  const sessions = Array.isArray(host.health.sessions)
    ? host.health.sessions.filter((/** @type {any} */ s) => ownedBy(s?.createdBy, requester))
    : host.health.sessions;
  const mine = new Set((sessions || []).map((/** @type {any} */ s) => s?.name));
  return {
    ...host,
    health: {
      ...host.health,
      sessions,
      resumable: Array.isArray(host.health.resumable)
        ? host.health.resumable.filter((/** @type {any} */ n) => mine.has(n))
        : host.health.resumable,
    },
  };
}

/**
 * The event ring, minus other people's work.
 *
 * An event with neither an actor nor a session name is fleet topology — a host
 * connected, a credential was revoked — and stays. Anything naming a person or
 * a session is theirs.
 *
 * This is not tidiness. The ring records "somebody asked for connect claude
 * for the box itself" the moment an admin starts a box login, which is the
 * timing half of a real attack: it tells a member exactly when a login is open
 * to be finished. The login flow now refuses that, and the feed should not
 * have been offering the schedule either.
 *
 * @param {any[]} events
 * @param {{ email?: string|null, admin?: boolean }|null} requester
 */
function visibleEvents(events, requester) {
  if (!requester || requester.admin) return events;
  return events.filter((e) => {
    if (!e) return false;
    if (!e.actor && !e.name) return true;
    return ownedBy(e.actor, requester);
  });
}

/** How many events a catch-up returns. One number, two coordinators. */
const EVENT_PAGE = 50;

/**
 * How long a fan-out read waits for any single host. Deliberately much shorter
 * than the intent timeout: a mutating intent addressed to one host is worth
 * waiting a minute for, but a read fanned to everyone must not let its slowest
 * member set the price for the whole fleet.
 */
const FANOUT_TIMEOUT_MS = 10_000;

/**
 * How long before the same host fact is worth saying again.
 *
 * An hour. Long enough that a flapping or restarting box says it once, short
 * enough that a machine still broken tomorrow morning says so again — a fault
 * reported once at midnight and never repeated is a fault somebody scrolls
 * past.
 */
const HOST_STATE_QUIET_MS = 60 * 60_000;

/** Events worth waking somebody for. The rest are for the log. */
const NOTIFIABLE = new Set([
  'session.awaiting-input',
  'session.ended',
  'session.error',
  'session.rc-online',
  // Gated further in #onHostEvent: only a job handed over, or a temporary
  // machine, is worth a buzz for coming back to its prompt.
  'session.ready',
  // A BOX THAT CANNOT START SESSIONS, and its recovery. This list was sessions
  // only, so the one fact that stops the whole fleet working reached a journal
  // and nothing else — deb132 spent thirty hours signed out, warning hourly,
  // while the phone said nothing.
  'host.degraded',
  'host.recovered',
  // BOTH ENDS OF THE AUTO-RESTART. A fleet that quietly restarts things is
  // one nobody can debug — the session's own conversation history will not
  // explain a gap it did not cause — and giving up has to be louder than
  // trying, because that is the point at which a person is needed and nothing
  // further is going to happen without them.
  'session.restarted',
  'session.stuck',
]);

/**
 * The prefix both apps register their answer categories under. The kind is
 * appended, because the words on the buttons differ by kind and a category is
 * where iOS keeps them.
 */
export const PROMPT_CATEGORY = 'fleet.prompt';

/**
 * The titles of a job's notifications, by state. The phones draw the same
 * words for the same state (XOSetupWords and XOPolicy.statusLine on iOS,
 * XoSetupNotice on Android), so the banner and the screen say one thing.
 *
 * A policy job's end is not a hypervisor added, which is what the first
 * version said for both, because policy jobs did not report at all.
 */
const SETUP_TITLES = Object.freeze({ running: 'Adding a hypervisor', done: 'Hypervisor added', failed: 'Hypervisor setup stopped', cancelled: 'Hypervisor setup cancelled' });
const POLICY_TITLES = Object.freeze({ running: 'Changing what the fleet may use', done: 'What the fleet may use is changed', failed: 'The change stopped', cancelled: 'The change was cancelled' });

/**
 * Where an onboarding job has got to, as a host may report it.
 *
 * @typedef {object} SetupProgress
 * @property {number} step   index into XOSETUP_STEPS of the step now running, or the count when finished
 * @property {number} of     how many steps there are
 * @property {string} phase  the step's key, or `done`
 * @property {'running'|'done'|'failed'|'cancelled'} state
 * @property {'setup'|'policy'} purpose  adding a pool, or changing what the fleet may use on one
 * @property {number|null} fill  how far the step now running has got, in thousandths, when the host can
 *   tell (the edge router's download and disk), or null
 * @property {string} text   one sentence for the person, never shown on a Live Activity
 * @property {number} at
 */

/**
 * A host's progress report, narrowed to its known shape or refused.
 * NARROWED, NOT FORWARDED, for the reason promptForPush gives: what a host
 * sends crosses into a payload the coordinator signs its name to.
 *
 * @param {any} msg
 * @returns {SetupProgress|null}
 */
export function narrowProgress(msg) {
  const of = Number(msg?.of);
  const step = Number(msg?.step);
  if (!Number.isInteger(of) || of < 1 || of > 32 || !Number.isInteger(step) || step < 0 || step > of) return null;
  const state = String(msg?.state || '');
  if (!['running', 'done', 'failed', 'cancelled'].includes(state)) return null;
  // A POLICY JOB REPORTS TOO, once it is building something that takes
  // minutes (the edge router's download), and its last two steps are its own.
  // A host that predates `purpose` sends none, and only adds pools.
  const purpose = msg?.purpose === 'policy' ? 'policy' : 'setup';
  const phase = String(msg?.phase || '');
  const steps = purpose === 'policy' ? XOPOLICY_STEPS : XOSETUP_STEPS;
  if (!steps.includes(phase) && phase !== 'done') return null;
  return {
    step,
    of,
    phase,
    state: /** @type {SetupProgress['state']} */ (state),
    purpose: /** @type {SetupProgress['purpose']} */ (purpose),
    text: msg?.text ? String(msg.text).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200) : '',
    // HOW FAR INTO THE STEP, in thousandths, for a step that is bytes
    // moving and can say so: the edge router's build is most of a policy
    // job, and "step 5 of 5" alone held the bar at four fifths for minutes.
    // A number and nothing else, so a Lock Screen can draw it.
    fill: Number.isInteger(msg?.fill) && msg.fill >= 0 && msg.fill <= 1000 ? msg.fill : null,
    at: Date.now(),
  };
}

/**
 * A probe answer, narrowed to the fields a probe has.
 *
 * @param {any} p
 */
export function narrowProbe(p) {
  if (!p || typeof p !== 'object') return { reachable: false, xo: null, tls: false, cert: null, certificate: null, version: null };
  const cert = typeof p.cert === 'string' && CERT_PIN_RE.test(p.cert) ? p.cert : null;
  return {
    reachable: p.reachable === true,
    // null is cannot-tell: a host that reached something it could not identify
    // has not said it is not Xen Orchestra.
    xo: p.xo === true ? true : p.xo === false ? false : null,
    tls: p.tls === true,
    cert,
    certificate: cert ? narrowCertificate(p.certificate) : null,
    version: typeof p.version === 'string' ? p.version.slice(0, 40) : null,
  };
}

/** What can be wrong with a certificate, as a probe names it. */
export const CERT_PROBLEMS = Object.freeze(['self-signed', 'untrusted-issuer', 'expired', 'not-yet-valid', 'name-mismatch']);

/**
 * What a certificate says about itself and whether it checks out, narrowed to
 * what the phone shows before the person accepts it.
 *
 * `trusted` is true only when the host said so AND named no problem: a
 * certificate the phone is told is fine is never asked about, so the doubtful
 * case has to land on the side that asks. Absent or malformed is null, which
 * the apps treat the same way.
 *
 * @param {any} c
 */
export function narrowCertificate(c) {
  if (!c || typeof c !== 'object') return null;
  /** @param {unknown} v @param {number} max */
  const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max) : null);
  /** @param {unknown} v */
  const when = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
  const problems = Array.isArray(c.problems) ? CERT_PROBLEMS.filter((k) => c.problems.includes(k)) : [];
  return {
    trusted: c.trusted === true && problems.length === 0,
    problems,
    subject: text(c.subject, 200),
    issuer: text(c.issuer, 200),
    notBefore: when(c.notBefore),
    notAfter: when(c.notAfter),
    names: Array.isArray(c.names) ? c.names.filter((/** @type {unknown} */ n) => typeof n === 'string').slice(0, 20).map((/** @type {string} */ n) => n.slice(0, 255)) : [],
  };
}

/**
 * The answerable part of a host's prompt, narrowed to what a notification may
 * carry, or null if there is nothing to answer.
 *
 * NARROWED RATHER THAN FORWARDED, and the reason is which way the trust runs.
 * A host is a machine somebody else enrolled; everything it sends crosses into
 * a payload the coordinator signs its own name to and pushes at a phone. The
 * fields below are the whole of what an answer needs — which question, what
 * kind, and which digit each button types — so anything else the host put on
 * `prompt` stops here rather than being passed along because it happened to be
 * in the object.
 *
 * The shapes are checked, not assumed. `id` is what promptId() produces, the
 * slots are what prompt.js declares, and an index outside 1-9 is not a thing
 * the answer verb accepts (see src/fleet/protocol/intents.js). A host that
 * sends something else gets a notification with no actions on it, which is the
 * behaviour every host had before this existed.
 *
 * @param {any} prompt
 * @returns {{ id: string, kind: string, answers: string, category: string }|null}
 */
export function promptForPush(prompt) {
  if (!prompt || typeof prompt !== 'object') return null;
  const id = String(prompt.id ?? '');
  const kind = String(prompt.kind ?? '');
  if (!/^[0-9a-f]{8}$/.test(id) || !/^[a-z]{1,16}$/.test(kind)) return null;

  const actions = Array.isArray(prompt.actions) ? prompt.actions : [];
  /** @type {string[]} */
  const answers = [];
  for (const action of actions) {
    const slot = String(action?.slot ?? '');
    const index = Number(action?.index);
    if (!/^[a-z]$/.test(slot) || !Number.isInteger(index) || index < 1 || index > 9) continue;
    if (answers.some((a) => a.startsWith(`${slot}:`))) continue;
    answers.push(`${slot}:${index}`);
  }
  // ONE BUTTON IS NOT A DECISION — the same bar answerActions() applies on the
  // host, restated here because this side cannot assume that ran.
  if (answers.length < 2) return null;

  // A STRING, because FCM data values are. Two pairs, so the comma form costs
  // seven bytes against a JSON array's twenty-five, on a payload capped at 4 KB
  // that is mostly ciphertext once a device registers a key.
  //
  // THE CATEGORY IS NOT IN THE ENVELOPE, and cannot be. iOS reads it to decide
  // which buttons to draw, which happens before the app is consulted and
  // therefore before anything could be decrypted — so on a device that has
  // registered a push key this is the one field Apple or Google can read.
  //
  // It names the KIND of question and never the question: "a session on this
  // fleet is at a permission prompt". That is strictly less than the same
  // request already discloses — `apns-collapse-id` has carried the session NAME
  // in the clear since notifications learned to replace each other — and it is
  // the price of the buttons existing at all.
  return { id, kind, answers: answers.join(','), category: `${PROMPT_CATEGORY}.${kind}` };
}

/** @param {Record<string, any>} event */
export function describeEvent(event) {
  switch (event.event) {
    case 'session.awaiting-input':
      return event.text || 'is waiting for you';
    case 'session.ended':
      return 'finished';
    case 'session.error':
      return event.text || 'hit an error';
    case 'session.rc-online':
      return 'is ready to drive';
    case 'session.ready':
      return event.text || 'is back at its prompt';
    case 'session.restarted':
      return event.text || 'was restarted after going idle';
    case 'session.stuck':
      return event.text || 'keeps going idle and a restart is not fixing it';
    case 'host.degraded':
      return event.text || 'cannot start sessions';
    case 'host.recovered':
      return event.text || 'is reporting normally again';
    default:
      return event.event;
  }
}

/**
 * The status and the sentence for a device removal, shared by both
 * coordinators so they refuse in the same words. Here rather than in server.js
 * because the Worker imports this file and must never import node:http.
 *
 * @param {{ ok: boolean, error?: { code: string } }} r
 */
export function deviceStatus(r) {
  if (r.ok) return 200;
  return r.error?.code === 'not_yours' ? 403 : 404;
}

/** @param {{ ok: boolean, error?: { code: string } }} r */
export function deviceText(r) {
  if (r.ok) return 'This device will not be notified again.';
  return r.error?.code === 'not_yours'
    ? 'That device is somebody else\u2019s. Removing other people\u2019s devices needs an admin credential on this fleet.'
    : 'That device was not registered.';
}
