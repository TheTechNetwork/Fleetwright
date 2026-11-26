// The sidecar: what runs on a fleet host.
//
// It dials the coordinator, validates every intent that arrives against the
// verb allowlist, and drives a STOCK fleetwright through its loopback HTTP API.
// fleetwright is not modified, not forked, and not aware of any of this — from
// its side the sidecar is just another HTTP client holding its token.
//
//     coordinator ──ws──▶ sidecar ──http──▶ 127.0.0.1:8790 (fleetwright) ──▶ tmux
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
// Running out-of-process sharpens that rather than softening it. fleetwright's
// `POST /api/command` will run ANY command line it is given, `/login` included,
// and the sidecar is the only thing holding its token. So the allowlist here is
// not defence in depth — it is THE defence, and the command line is assembled
// from literals in this file and never received from the wire.
//
// --- the trade this makes ---------------------------------------------------
//
// One thing genuinely gets worse out-of-process, and it should be stated rather
// than discovered: fleetwright hardcodes `actor: 'web'` for every HTTP caller, so
// `createdBy` on a session the fleet starts will read "web", not who asked. The
// sidecar knows the real actor and puts it in its own logs and replies, but it
// cannot make fleetwright record it. That is design.md §1's flat-allowlist gap,
// and it is fixable upstream or in the coordinator — not from here.
//
// One thing gets better: the sidecar re-derives Remote Control URLs from the
// pane itself (see host/pane.js) instead of trusting the ones fleetwright
// recorded with its unguarded matcher, which are truncated or missing outright
// on any pane that is not exactly 80 columns wide.

import { BootConsoles, bootLogAnswer } from './pve-console.js';
import os from 'node:os';
import { validateIntent, isMutating, PROTOCOL_VERSION, PROTOCOL_MIN, REPO_RE, LINK_ROLES } from '../protocol/intents.js';
import { readConfigFrame } from '../protocol/config-frame.js';
import { PendingVerifiers } from './pkce.js';
import { exchangeCode, exchangeCloudflareCode, connectedText } from '../coordinator/oauth.js';
import { HubError } from './hub-client.js';
import { reconcileRcUrl, extractRcUrl, isRemoteControlOnline } from './pane.js';
import { SessionWatcher } from './watcher.js';
import { promptId, describePrompt } from './prompt.js';
import { redactCommandLine } from '../../core/redact.js';
import { emailFromActor } from '../../core/accounts.js';
import { LOG_SOURCES, unitInstalled, tidyPane } from '../../core/logs.js';
import { verifyRunnerJob } from '../coordinator/oidc.js';
import { newSealKey, bindingFor, claudeBindingFor, seal, open, canSealTo, VAULT_BOX_AAD, ENGINE_SIGNIN_AAD } from '../seal.js';
import { signingInput, fingerprint, verify } from '../crypto.js';
import { vaultBoxAnswerInput } from '../protocol/vault-answer.js';
import { probe, XoSetups } from './xo-setup.js';
import { RelayStreams } from './xo-relay.js';
import { ConsoleTunnels } from './console-tunnel.js';
import { BrowseCarrier, parseBrowseHosts } from './browse.js';
import { XoPools } from './xo-pools.js';
import { PvePools } from './pve-pools.js';
import { SandboxPools } from './sandbox-pools.js';
import { OwnPools, OWN_PROVIDER } from './own-pools.js';
import { Pools } from './pools.js';
import { EdgeWatch } from './edge-watch.js';
import { IntentKeys, MINTER_KEY_FILE } from './intent-keys.js';
import { decideBoxWide, decidePin, forgetPinned, isBoxWide, ownerOf, pinReport, readPins, updatePins } from './pinned-admins.js';
import { actorEmail, needsSignature, keyId, signinAnswerInput, delegationShape, SESSION_VERBS } from '../protocol/intent-signature.js';
import { accountOfMember, memberOfAccount, composeFirstMessage, MEMBER_ID_RE } from '../protocol/members.js';
import { ENGINE_IDS, DEFAULT_ENGINE, SIGNIN_ENGINES } from '../protocol/engines.js';
import { composeTaskMessage, TASK_BRANCH_RE } from '../protocol/tasks.js';
import { runnerJobProblem, runnerJobRepoProblem, ownerAllowed, permissionsFor, mintRepoToken } from '../../core/repo-tokens.js';
import { CLAUDE_REFRESH_AHEAD_MS } from '../minter/claude-login.js';

/** @typedef {typeof import('../../log.js').log} Logger */

// The sidecar is a library as much as an entrypoint, so it says nothing unless
// it is given somewhere to say it. bin/fleetwright-sidecar passes the real
// logger; tests pass one that captures.
/** @type {Logger} */
const SILENT = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * What fleetwright publishes about the box on /api/state, in the shape the
 * health frame carries. See #hostFacts in src/adapters/http.js for the other
 * end and for why each field is null rather than defaulted when unknown.
 *
 * @typedef {object} HostFacts
 * @property {{ auto: string[], set: string[] }|null} labels
 * @property {'stable'|'rolling'|null} channel
 * @property {boolean|null} channelPinned
 * @property {{ variant: string, image: string, pinned: boolean }|null} sandbox
 * @property {boolean|null} sandboxed
 * @property {string|null} sandboxedWhy
 * @property {string[]} sandboxedAlso
 * @property {number|null} houseRules
 * @property {'asks'|'bypassed'|null} permissions
 */

/** What a reason the hub gives looks like: a short code (http.js uncontained). */
const REASON_RE = /^[a-z_]{1,32}$/;

/** More reasons than a hub has: it gives five at most. */
const REASONS_MAX = 8;

/**
 * The reasons after the first, as the frame carries them.
 *
 * NOT FILTERED. A list with an entry dropped reads as complete, and the
 * coordinator would name too few fixes and say they open the box, which is
 * the false sentence this list exists to stop (scheduler.js NOT_CONTAINED).
 * So an entry that is not a code, or a list longer than a hub sends, is
 * carried as `unreadable`, a code nothing knows, and the fleet says only
 * that the box is not contained. Absent, from a hub that gives one reason,
 * is an empty list.
 *
 * @param {unknown} list
 * @returns {string[]}
 */
function reasonsAfter(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > REASONS_MAX) return ['unreadable'];
  return list.map((c) => (typeof c === 'string' && REASON_RE.test(c) ? c : 'unreadable'));
}

/** How many sign-ins one frame carries. A fleet has at most 200 members, and each has two such engines. */
const SIGNINS_MAX = 400;

/** The protocol a coordinator speaks once it shows each person only the sign-ins they may see (core.js, signinsSeenBy). */
const ENGINE_SIGNINS_SINCE = 22;

/**
 * Which members are signed in to which engine on this box, out of what its
 * hub says of every sign-in it knows: only the ones signed in now, each as
 * a member's id, an engine and since when, shape-checked.
 *
 * An entry that does not read is left out, which here is the safe side: a
 * sign-in the frame does not carry is one nobody is told of, never one
 * somebody is wrongly told of (C-5).
 *
 * @param {unknown[]} list
 * @returns {Array<{ member: string, engine: string, since: number }>}
 */
function signedInOn(list) {
  return list
    .filter((/** @type {any} */ e) => e && typeof e === 'object' && typeof e.member === 'string' && MEMBER_ID_RE.test(e.member)
      && SIGNIN_ENGINES.includes(e.engine) && Number.isFinite(e.since) && e.since > 0)
    .slice(0, SIGNINS_MAX)
    .map((/** @type {any} */ e) => ({ member: e.member, engine: e.engine, since: Math.round(e.since) }));
}

/**
 * The facts out of a /api/state reply, shape-checked.
 *
 * Checked rather than spread, because this is the one place the sidecar
 * takes another process's word for what the health frame will say, and a
 * fleetwright from before these fields existed answers none of them. A
 * missing field is null — the frame's word for cannot tell — and a field of
 * the wrong shape is treated the same way rather than forwarded.
 *
 * @param {any} state
 * @returns {HostFacts}
 */
export function factsFrom(state) {
  const labels = state?.labels;
  const strings = (/** @type {unknown} */ v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const sandbox = state?.sandbox;
  // A first reason that is there and is not a code is `unreadable`, as in
  // reasonsAfter, not null: null beside a `false` is a hub from before the
  // field, which the coordinator reads as `off` and answers with "turn its
  // sandbox on", and that is not known to be the way on for this box.
  const said = state?.sandboxedWhy;
  const why =
    state?.sandboxed !== false || said === undefined || said === null
      ? null
      : typeof said === 'string' && REASON_RE.test(said)
        ? said
        : 'unreadable';
  return {
    labels: labels && strings(labels.auto) && strings(labels.set) ? { auto: labels.auto, set: labels.set } : null,
    channel: state?.channel === 'stable' || state?.channel === 'rolling' ? state.channel : null,
    channelPinned: typeof state?.channelPinned === 'boolean' ? state.channelPinned : null,
    sandbox:
      sandbox && typeof sandbox.variant === 'string' && typeof sandbox.image === 'string' && typeof sandbox.pinned === 'boolean'
        ? { variant: sandbox.variant, image: sandbox.image, pinned: sandbox.pinned }
        : null,
    sandboxed: typeof state?.sandboxed === 'boolean' ? state.sandboxed : null,
    // Why not, and only beside a `false`: a reason next to `true` or next to
    // cannot tell would be a reason for nothing. A short code and nothing
    // else, because it is carried to the coordinator and read there as one
    // (scheduler.js NOT_CONTAINED), never as prose.
    sandboxedWhy: why,
    // And the rest, only beside a first (reasonsAfter).
    sandboxedAlso: why === null ? [] : reasonsAfter(state?.sandboxedAlso),
    houseRules: typeof state?.houseRules === 'number' ? state.houseRules : null,
    permissions: state?.permissions === 'asks' || state?.permissions === 'bypassed' ? state.permissions : null,
  };
}

// A replayed /stop is harmless; a replayed /new is not — it burns a slot
// against the concurrency cap and starts work nobody asked for twice. So every
// mutating intent carries an idempotency key and its result is remembered.
export const REPLAY_TTL_MS = 10 * 60_000;
const REPLAY_MAX = 512;
/** What is remembered of an engine sign-in's reply, whatever it said: that its id was answered, and nothing of it (handle). */
const CODE_NOT_KEPT = Object.freeze({ codeNotKept: true });

/**
 * Whose vaults a vault's answer to a box names: an agent member's by its id
 * (`member`), a person's by the address it is filed under (`email`).
 *
 * @param {Array<any>} accounts
 * @returns {{ members: Set<string>, people: Set<string> }}
 */
function approvalsIn(accounts) {
  const members = new Set();
  const people = new Set();
  for (const a of accounts) {
    if (typeof a?.member === 'string' && MEMBER_ID_RE.test(a.member)) members.add(a.member);
    else if (typeof a?.email === 'string' && a.email.trim()) people.add(a.email.trim().toLowerCase());
  }
  return { members, people };
}

// How many panes to read at once when enriching a session list. Loopback HTTP
// is cheap but each one is a `tmux capture-pane` on the host, and a box at its
// cap has only a handful of sessions anyway.
const PEEK_CONCURRENCY = 4;

/**
 * Verbs after which the coordinator's picture of this host is out of date.
 *
 * Health is pushed immediately once one of these lands, so somebody who just
 * changed something is not answered from the frame before it.
 *
 * START, RESUME AND STOP ARE HERE FOR A SHARPER REASON than the others. The
 * coordinator learns which sessions exist ONLY from these frames, and it
 * places `status`, `peek` and `await` by that list. So for up to a full health
 * interval after a successful `start`, the fleet answered
 *
 *     No host reports a session named "job2". It may exist on a host that is
 *     currently offline
 *
 * about a session it had just confirmed starting — a plausible reason that was
 * not the true one, which is worse than an opaque error. An agent following
 * this server's own instructions does `start` then `await`, so it hit the
 * window every time.
 */
const CAPABILITY_VERBS = new Set([
  'connect',
  'link',
  'exchange',
  'unlink',
  'renew',
  'forgetperson',
  'pinadmin',
  'update',
  'upgrade',
  'start',
  'resume',
  'stop',
]);

/**
 * @typedef {object} Transport
 * @property {string} origin  the coordinator origin this transport is pinned to
 * @property {(handler: (msg: unknown) => Promise<void>) => void} onMessage
 * @property {(msg: object) => void|Promise<void>} send
 * @property {() => Promise<unknown>} start
 * @property {() => Promise<unknown>} stop
 */

/**
 * How soon a box asks the vault after the coordinator says somebody's vault
 * changed: long enough that keeping several things at once is one ask.
 */
export const VAULT_CHANGED_ASK_MS = 2_000;

/**
 * How long until a holder of the vault's tokens asks again, given the soonest
 * of them to run out: at the minute the minter renews it, which is a minute
 * inside its half hour, so every box and runner holding the same token asks
 * within the same minute (renewing revokes the token every holder has, and
 * Claude Code reads its credentials file again on that 401 and carries on).
 * Just past that minute, once a minute for a few minutes, for a clock that
 * disagrees with the minter's or a holder that renewed first; after that, ten
 * minutes before it runs out. Never later than `intervalMs`, and never
 * sooner than a minute, or than `intervalMs` when that is shorter.
 *
 * @param {number} soonest  ms since the epoch, Infinity for nothing that runs out
 * @param {number} intervalMs @param {number} [now]
 */
export function askAgainIn(soonest, intervalMs, now = Date.now()) {
  const left = soonest - now;
  const atRenewal = left - (CLAUDE_REFRESH_AHEAD_MS - 60_000);
  const due = !Number.isFinite(soonest) ? Infinity
    : atRenewal > 0 ? atRenewal
      : atRenewal > -5 * 60_000 ? 60_000
        : left - 10 * 60_000;
  const floor = intervalMs > 0 ? Math.min(60_000, intervalMs) : 60_000;
  return Math.max(floor, Math.min(intervalMs, due));
}

/**
 * A 1-minute load this many times the core count is "overloaded" in a health
 * frame's reason. Four, not two: a box building something is often at two
 * per core and answering fine; the fleet's own measurements of a box that
 * had stopped answering were a hundred and more.
 */
const OVERLOAD_LOAD_PER_CORE = 4;


/** How long a decide frame waits for its `decided` answer before it is nothing (docs/decide-design.md, section A). */
const DECIDE_ANSWER_MS = 10_000;
export class Sidecar {
  /**
   * @param {{
   *   hub: import('./hub-client.js').HubClient,
   *   transport: Transport,
   *   hostId?: string,
   *   labels?: string[], machine?: { loadavg?: () => number[], cpus?: () => number, platform?: string }|null,
   *   maxSkewMs?: number,
   *   requireSigned?: boolean|'off'|'signers'|'all',
   *   logger?: Logger,
   *   healthIntervalMs?: number,
   *   promptText?: boolean,
   *   decide?: boolean,
   *   idleRestartMs?: number,
   *   renewIntervalMs?: number,
   *   poolIntervalMs?: number,
   *   hubConfig?: any,
   *   fetchImpl?: typeof globalThis.fetch,
   *   watch?: boolean,
   *   updates?: (() => { appBehind: number|null, system: string|null, rebootRequired: boolean, release?: any, appPending?: boolean|null, grants?: { upgrades: boolean, reboot: boolean }|null, incomplete?: string|null })|null,
   *   adoptUpdates?: ((waiting: any) => void)|null,
   *   version?: (() => { head: string|null, branch: string|null, installed?: string|null, helper?: 'current'|'stale'|null }|null)|null,
   *   onRestartRequested?: ((at: number) => void)|null,
   *   startedAt?: number,
   *   minter?: import('./minter-config.js').Minter|null,
   *   jobToken?: ((audience: string) => Promise<string>)|null,
   *   mintTimeoutMs?: number,
   *   vaultKey?: { publicJwk: { x: string, y: string }, sign: (message: string) => Promise<string> }|null,
   *   vaultIntervalMs?: number,
   *   xoStateDir?: string|null,
   *   xoPools?: XoPools|Pools|null,
   *   edgeWatch?: EdgeWatch|null,
   *   holderFor?: string,
   *   sandboxProviders?: string[],
   *   vmLogin?: { email: string, token: string|null }|null,
   *   onVmLoginHanded?: (() => void)|null,
   *   browse?: { hosts?: string[], web?: boolean }|null,
   * }} opts
   */
  constructor({ hub, transport, hostId, labels = [], machine = null, maxSkewMs = 300_000, requireSigned = false, logger = SILENT, healthIntervalMs = 15_000, watch = true, updates = null,
    adoptUpdates = null,
    version = null,
    promptText = false,
    decide = false,
    idleRestartMs = 0,
    renewIntervalMs = 3_600_000,
    // How often the pools this box holds are looked at between vault passes:
    // a machine's end is kept by the sweep, and a phone's page of a machine
    // is only as fresh as the last look.
    poolIntervalMs = 120_000,
    hubConfig = null,
    fetchImpl = globalThis.fetch,
    onRestartRequested = null,
    startedAt = Date.now(),
    // THIS BOX AS A MINTER: the GitHub App key, its client id and whose
    // repositories it may mint into, from this box's own configuration
    // (repo-tokens.js, loadMinter). Null on almost every box, and then a
    // `mint` is answered "not here" so the coordinator asks the next one.
    minter = null,
    // THIS BOX AS A RUNNER: how to ask GitHub for this job's token with a
    // given audience. Null anywhere that is not a GitHub Actions job with
    // id-token permission, and then there is nothing to ask for a mint with.
    jobToken = null,
    mintTimeoutMs = 30_000,
    // THIS BOX'S OWN KEY, as a public half and a way to sign with the private
    // one, for asking the fleet's vault for what this box's people approved it
    // to hold (src/fleet/minter/vault.js). The private half stays in the
    // process that loaded it (bin/fleetwright-sidecar). Null: no vault here.
    vaultKey = null,
    vaultIntervalMs = 10 * 60_000,
    // THIS PROCESS'S OWN STATE DIRECTORY, the one beside its key. The admins
    // this box pins are recorded there (pinned-admins.js), beside the
    // minter's key and the signers (intent-keys.js). It is also where the
    // first version of hypervisor onboarding kept a pool's token, which a
    // setup run again looks for to remove (xo-setup.js, hand-off).
    xoStateDir = null,
    // THE HYPERVISORS THIS BOX CAN MAKE MACHINES ON, from its people's
    // vaults, in memory only (src/fleet/host/xo-pools.js). Made here for any
    // box that asks the vault; a test hands its own.
    xoPools = null,
    edgeWatch = null,
    holderFor = '',
    // The sandbox providers this box's operator turned on (docs/api-engines.md). None unless said.
    sandboxProviders = [],
    // THIS BOX AS A MACHINE FROM SOMEBODY'S HYPERVISOR: whose it is and the
    // Claude login it runs on, from the file it was booted with
    // (src/fleet/host/vm-join.js), handed to the hub before the first health
    // frame like a runner's. And what to do once the hub has it: forget it.
    vmLogin = null,
    onVmLoginHanded = null,
    // WHAT THIS BOX OPENS FOR A PHONE'S WEB VIEW besides its people's own
    // sessions (docs/browse.md): the names and ranges its owner listed, and
    // whether it opens the public web. From this box's own env file and
    // nothing the coordinator sends. Null opens neither.
    browse = null,
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
    /**
     * What the coordinator has told this host about itself, IN MEMORY ONLY.
     *
     * Never written anywhere. That is the entire point: the one value in here
     * today is the fleet-wide GitHub App client secret, and the version of this
     * that shipped first put it in the credential store — at rest, once per
     * member per host, with rotation silently breaking every renewal eight
     * hours later. Nothing to place, nothing at rest, rotation is a deploy.
     * @type {Map<string, string>}
     */
    this.config = new Map();
    this.hostId = hostId || os.hostname();
    // WHAT THIS BOX WAS GIVEN: FLEETWRIGHT_LABELS plus what auto-labels derived
    // at startup. Kept separate from the composed list below because fleetwright
    // needs the difference — a label it stores is removable and a fact the
    // machine derives is not, and one flat list cannot say which is which.
    this.givenLabels = labels;
    // WHAT THE MACHINE IS, as functions, so a test can be a box at load 519
    // on three cores without being one: that is the only way to prove the
    // sentence below is written, and it is written exactly when the box
    // cannot be asked anything else.
    /** @type {{ loadavg: () => number[], cpus: () => number, platform: string }} */
    this.machine = {
      loadavg: () => os.loadavg(),
      cpus: () => os.availableParallelism?.() ?? os.cpus().length,
      platform: process.platform,
      ...(machine ?? {}),
    };
    // Injected rather than read here: the sidecar knows about a coordinator
    // and an fleetwright, and nothing about git checkouts or package managers.
    /** @type {(() => { appBehind: number|null, system: string|null, rebootRequired: boolean, release?: any })|null} */
    this.updates = updates;
    // Lets a fresh check replace the cached answer health reports. See the
    // `updates` verb below, and adoptUpdates in bin/fleetwright-sidecar.
    this.adoptUpdates = adoptUpdates;
    this.version = version;
    // Whether a prompt that quotes the session may leave the box.
    this.promptText = promptText;
    this.maxSkewMs = maxSkewMs;
    // TAKES ONLY WHAT A PERSON SIGNED (FLEETWRIGHT_REQUIRE_SIGNED, phase 3 of
    // docs/signed-intents.md): the operator of this box said so in its own
    // env file, and nothing the coordinator sends can turn it off. `all`
    // refuses what is not signed or delegated from anybody; `signers` from the
    // people this box has been shown a key for, and anything with nobody named,
    // which on the box's own hub is the box itself (src/core/accounts.js).
    /** @type {'off'|'signers'|'all'} */
    this.requireSigned = requireSigned === true || requireSigned === 'all' ? 'all' : requireSigned === 'signers' ? 'signers' : 'off';
    this.log = logger;
    this.healthIntervalMs = healthIntervalMs;
    /** @type {any} */
    this.healthTimer = null;
    /** @type {any} */
    this.renewTimer = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this.poolTimer = null;
    this.renewIntervalMs = renewIntervalMs;
    this.poolIntervalMs = poolIntervalMs;
    // fleetwright's configuration AS THIS PROCESS SEES IT, which is the
    // defaults plus whatever of its environment the sidecar can read — and
    // /etc/fleetwright.env is root's, so mostly the defaults. Used for one
    // thing: which systemctl to ask about units. It used to be how the sidecar
    // found fleetwright's state directory and read and wrote files in it,
    // which only worked while the two ran as one user (#270). Everything that
    // was read that way is now asked of fleetwright over HTTP — see `facts`.
    this.hubConfig = hubConfig;
    /**
     * What fleetwright last said about this box: labels, channel, variant,
     * house rules. Read off /api/state on every health frame and kept here so
     * the `labels` getter has an answer between frames and a frame built
     * while fleetwright is restarting still names the labels the scheduler
     * was matching on a minute ago. Null until the first frame — CANNOT TELL,
     * which is what an app renders when the fields are missing.
     * @type {HostFacts|null}
     */
    this.facts = null;
    /**
     * How this process picks up an update. fleetwright's /api/state carries
     * the time the updater last asked every service to restart; a time after
     * this process started means it is running code older than the tree it
     * was launched from, and the entrypoint exits so systemd or launchd brings
     * it back on the new code. Strictly after, or the process that comes back
     * reads the request that restarted it and exits again, for ever.
     *
     * The sidecar used to watch the marker file itself, in fleetwright's state
     * directory, which only worked while the two ran as one user (#270).
     */
    this.onRestartRequested = onRestartRequested;
    this.startedAt = startedAt;
    // The PKCE verifiers this box is holding between a `connect` it answered
    // and the `exchange` that spends one — see ./pkce.js. Memory only, like
    // the client secret they are used with.
    this.verifiers = new PendingVerifiers();
    // Injected so a test can stand in for GitHub; the exchange is the one
    // network call this process makes on its own account.
    this.fetchImpl = fetchImpl;
    /**
     * Which service logs this box can read, once asked. See #logSources.
     * @type {string[]|null}
     */
    this.logSources = null;
    // Watching is what turns "a session needs you" into a notification on a
    // phone. Off in tests, which drive tick() directly.
    this.watcher = watch
      ? new SessionWatcher({
          hub,
          emit: (event) => this.emitEvent(event),
          allowSessionText: promptText,
          idleRestartMs,
          decide: decide === true ? (ask) => this.#askDecide(ask) : null,
          logger,
        })
      : null;
    /** @type {Map<string, { at: number, reply: Promise<object> }>} */
    this.replay = new Map();
    /**
     * The GitHub App key, in memory. Never logged, never sent, never written:
     * the only thing done with it is signing a ten-minute JWT in appJwt.
     * @type {import('./minter-config.js').Minter|null}
     */
    this.minter = minter;
    this.jobToken = jobToken;
    this.mintTimeoutMs = mintTimeoutMs;
    /**
     * A runner's minted repository tokens, IN MEMORY, keyed by the lowercased
     * repository. The container broker caches nothing on purpose — a copy is
     * what goes stale — but it reads a file; this costs a GitHub mint, and git
     * asks once per fetch, push and submodule. An hour-long token held until
     * five minutes before it dies is the same freshness with one mint an hour.
     * @type {Map<string, { token: string, expiresAt: number, repo: string }>}
     */
    this.repoTokens = new Map();
    /** Asks in flight, so twenty submodules asking at once mint once. @type {Map<string, Promise<any>>} */
    this.repoAsks = new Map();
    /** Waiters for the coordinator's `minted` answer, by frame id. @type {Map<string, { resolve: (m: any) => void, timer: any }>} */
    this.mintWaiters = new Map();
    /**
     * On a runner, the ask for its owner's Claude login, made once when it
     * joins. A session start waits for it (#run), so the first session is not
     * placed on the API key a moment before the login arrives. Never rejects.
     * @type {Promise<void>|null}
     */
    this.claudeLoginReady = null;
    /** The next ask for this runner's owner's sign-in, when it is one that is renewed. @type {ReturnType<typeof setTimeout>|null} */
    this.claudeLoginTimer = null;
    this.vaultKey = vaultKey;
    this.xoStateDir = xoStateDir;
    /**
     * THE KEYS A PERSON'S SIGNATURE IS CHECKED WITH, from the minter and never
     * from the coordinator (intent-keys.js, docs/signed-intents.md). Every
     * intent is checked and counted, and `#enforces` says which are refused
     * for it: none under `off`; under `signers`, the default a deployed box
     * reads, those naming nobody or a person this box has been shown a key
     * for; every one that needs a signature under `all`.
     * @type {IntentKeys|null}
     */
    this.intentKeys = vaultKey && transport?.origin
      ? new IntentKeys({ origin: transport.origin, dir: xoStateDir, hostKey: vaultKey, ask: (request, signature) => this.#askKeys(request, signature), log: this.log })
      : null;
    /** @type {XoPools|Pools|null} */
    // ON A POOL'S OWN MACHINE, the Xen Orchestra it was made to hold
    // (xo-holder.js): its health says so, and the coordinator asks it first.
    // AND PROXMOX'S CLUSTERS beside Xen Orchestra's pools, behind one face
    // (pools.js, docs/proxmox.md).
    this.pools = xoPools ?? (vaultKey ? new Pools({ xo: new XoPools({ log: this.log, holderFor, boxId: this.hostId }), pve: new PvePools({ log: this.log, holderFor }), sandbox: new SandboxPools({ providers: sandboxProviders, log: this.log }), own: new OwnPools({ enabled: sandboxProviders.map((p) => String(p).trim().toLowerCase()).includes(OWN_PROVIDER), hub: this.hub, boxId: this.hostId, log: this.log }) }) : null);
    /**
     * THE POOLS' EDGE ROUTERS, read with the key the person's vault keeps
     * beside a pool's token (edge-watch.js), for the pools that have one.
     */
    this.edgeWatch = this.pools ? (edgeWatch ?? new EdgeWatch({ pools: this.pools, log: this.log, onChange: () => void this.#pushHealth() })) : null;
    this.vmLogin = vmLogin;
    this.onVmLoginHanded = onVmLoginHanded;
    /** @type {XoSetups|null} made on first use */
    this.xoSetups = null;
    // CONNECTIONS THROUGH SOMEBODY'S PHONE, for a pool no machine reaches
    // (xo-relay.js): bytes of TLS this process opened, as frames on its own
    // socket to the coordinator, which joins them to the phone's.
    this.relays = new RelayStreams({
      send: (frame) => this.transport.send({ v: PROTOCOL_VERSION, kind: 'relay', hostId: this.hostId, ...frame }),
      log: this.log,
    });
    // A VM'S CONSOLE FOR A PHONE AWAY FROM THE POOL (console-tunnel.js): one
    // plain TCP connection to a pool this box holds for that person, carrying
    // the TLS the phone opened through it.
    this.tunnels = new ConsoleTunnels({
      send: (frame) => this.transport.send({ v: PROTOCOL_VERSION, kind: 'tunnel', hostId: this.hostId, ...frame }),
      where: (owner, address, machine) => this.pools?.consoleAddress?.(owner, address, machine) ?? null,
      log: this.log,
    });
    // A PHONE'S WEB VIEW, ITS CONNECTIONS LEAVING FROM HERE (browse.js): this
    // box decides each one by what its owner wrote and what the hub says of
    // the session, and the hub dials a session's own port because the
    // container is the hub's.
    this.browsePolicy = (() => {
      const { entries } = parseBrowseHosts(Array.isArray(browse?.hosts) ? browse.hosts : []);
      return { web: browse?.web === true, entries };
    })();
    this.browses = new BrowseCarrier({
      send: (frame) => this.transport.send({ v: PROTOCOL_VERSION, kind: 'browse', hostId: this.hostId, ...frame }),
      policy: () => this.browsePolicy,
      checkSession: async (owner, session) => {
        const state = await this.hub.state();
        if (state?.sandboxed !== true) {
          return { ok: false, text: 'This machine does not run sessions in containers, so a session here shares the machine\u2019s own addresses and its ports are not opened from a phone.' };
        }
        const row = (Array.isArray(state?.sessions) ? state.sessions : []).find((/** @type {any} */ r) => r?.name === session);
        if (!row || ownerOf(row.createdBy) !== owner) return { ok: false, text: `This machine has no session of yours called ${session}.` };
        if (row.status !== 'running') return { ok: false, text: `${session} is not running, so nothing is listening in it. Resume it first.` };
        return { ok: true };
      },
      dialSession: (owner, session, port) => this.hub.dialSessionPort(session, port, owner),
      // WHO THIS BOX PINS, when it pins anybody; null when it cannot read its
      // record, which opens its own rules to nobody.
      pinned: () => {
        const pins = readPins(this.xoStateDir);
        return pins.unreadable ? null : pins.admins;
      },
      log: this.log,
    });
    this.vaultIntervalMs = vaultIntervalMs;
    /** @type {any} */
    this.vaultTimer = null;
    /** An ask of the vault is under way, and a change said meanwhile asks again after it. */
    this.vaultAsking = false;
    this.vaultAgain = false;
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
    // BEFORE THE FIRST HEALTH FRAME, because that frame is what tells the
    // coordinator to start a session it was holding for this runner.
    if (this.jobToken) this.claudeLoginReady = this.#takeClaudeLogin();
    else if (this.vmLogin) this.claudeLoginReady = this.#handVmLogin();
    // THE VAULT, a few seconds in so the socket is up, then on its own clock.
    // NOT ON A RUNNER: nobody approves a runner's key, which is new every run,
    // so its answer is always empty, and an empty answer clears what is held,
    // which on a runner is its owner's sign-in (#takeClaudeLogin). A runner's
    // credentials come from its own asks.
    if (this.vaultKey && this.vaultIntervalMs > 0 && !this.jobToken) this.#scheduleVault(5_000);

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

    // RENEWING PROVIDER TOKENS IS TIMED FROM HERE, because the exchange needs
    // the App client secret and this is the process that has it — in memory,
    // off the config frame, never on disk. The exchange itself runs in
    // fleetwright, which owns the store the refresh tokens are in; the secret
    // travels there for the duration of one loopback request. fleetwright
    // renews the CLAUDE credential on its own timer, which is a different
    // mechanism for a different reason: that one renews by being used.
    if (this.renewIntervalMs > 0) {
      this.renewTimer = setInterval(() => void this.#renewProviders(), this.renewIntervalMs);
      this.renewTimer.unref?.();
    }
    // THE POOLS, between vault passes, while it holds any: the sweep is what
    // ends a machine at its end, so ten minutes late is too late.
    this.edgeWatch?.start();
    if (this.pools && this.poolIntervalMs > 0) {
      this.poolTimer = setInterval(() => {
        if (this.pools && this.#holdsAny()) void this.pools.refresh().then(() => this.#pushHealth()).catch(() => {});
      }, this.poolIntervalMs);
      this.poolTimer.unref?.();
    }
    this.log.info(`sidecar: ${this.hostId} → ${this.transport.origin} (protocol v${PROTOCOL_VERSION})`);
    return true;
  }

  async stop() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
    if (this.poolTimer) clearInterval(this.poolTimer);
    this.poolTimer = null;
    this.edgeWatch?.stop();
    if (this.vaultTimer) clearTimeout(this.vaultTimer);
    this.vaultTimer = null;
    if (this.claudeLoginTimer) clearTimeout(this.claudeLoginTimer);
    this.claudeLoginTimer = null;
    this.watcher?.stop();
    await this.transport.stop();
  }

  /**
   * Trade refresh tokens for new access tokens, using the secret the
   * coordinator supplied.
   *
   * Silent when there is nothing to do, which is the common case: a box with no
   * GitHub connections, or one whose tokens have hours left, does nothing and
   * says nothing.
   */
  async #renewProviders() {
    /** @type {Record<string, string>} */
    const secrets = {};
    for (const key of ['githubClientSecret', 'cloudflareClientSecret']) {
      const value = this.config.get(key);
      if (value) secrets[key] = value;
    }
    // Not a warning. A fleet with no OAuth client configured for any provider
    // is a supported fleet, and warning hourly about a feature nobody turned
    // on is how a log stops being read.
    if (!Object.keys(secrets).length) return;
    try {
      const results = await this.hub.renewProviders(secrets);
      if (results === null) {
        // A fleetwright from before it took renewal requests. Said once an
        // hour rather than swallowed: the tokens on this box will expire on
        // schedule and the fix is an update, which is worth a line.
        this.log.warn('sidecar: fleetwright here does not renew provider tokens — update it');
        return;
      }
      const renewed = results.filter((r) => r.outcome === 'renewed').length;
      if (renewed) this.log.info(`sidecar: renewed ${renewed} provider token(s)`);
    } catch (e) {
      this.log.warn(`sidecar: provider renewal failed: ${/** @type {Error} */ (e).message}`);
    }
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

  /**
   * One phase of hypervisor onboarding, for the person the coordinator says
   * is asking. The coordinator checks they are an admin and that the job is
   * theirs; this checks the job is theirs again, because it is the party that
   * holds the key, and the coordinator is the one this project assumes may be
   * lying.
   *
   * @param {import('../protocol/intents.js').Intent} intent
   */
  async #xosetup(intent) {
    if (!this.xoSetups) {
      this.xoSetups = new XoSetups({
        signer: this.vaultKey,
        emit: (event) => this.emitEvent(event),
        stateDir: this.xoStateDir,
        fingerprint,
        log: this.log,
        // What a machine image installs from, and joins: this box's own
        // fleet, as it pinned it (vm-image.js).
        coordinatorUrl: this.transport?.origin ?? null,
        // And how it asks the fleet for the pin a pool's own machine joins
        // with, for the job it is running (xo-holder.js).
        holderPin: (/** @type {string} */ job, /** @type {string} */ address) => this.#askHolderPin(job, address),
        // And for the token its machine image's build VM reports its
        // install with (vm-image.js), for the job it is running.
        imageReporter: (/** @type {string} */ job) => this.#askForJob('image-reporter', job),
        // And how it reaches a pool through the phone adding it.
        relay: { open: (relay) => this.relays.open(relay), done: (relay) => this.relays.done(relay) },
        // AFTER A RECONNECT, however it ended, a look with the fleet's own
        // token and a health frame saying what it saw: the pools coming back
        // is reported by the eyes that reported them gone, so the
        // coordinator's `xo.pool-back` rests on the fleet's view and not on
        // what an admin session happened to see.
        onEnd: ({ purpose }) => {
          if (purpose !== 'reconnect' || !this.pools?.held.size) return;
          void this.pools.refresh().then(() => this.#pushHealth()).catch(() => {});
        },
      });
    }
    const actor = intent.actor ? String(intent.actor) : null;
    const p = intent.params;
    switch (p.phase) {
      case 'begin':
        if (!p.address) return { ok: false, text: 'Say where Xen Orchestra answers.' };
        return this.xoSetups.begin({ address: String(p.address), pin: p.pin ? String(p.pin) : null, trust: p.trust ? String(p.trust) : null, plain: p.plain ? String(p.plain) : null, relay: p.relay ? String(p.relay) : null, actor });
      case 'deploy':
        // A begin for a pool with no Xen Orchestra, pinned to its master's
        // SSH host key (xo-deploy.js). `relay` is passed so that it is
        // refused in words, not dropped: installing needs this machine's own
        // way to the pool, which a phone does not carry.
        if (!p.address) return { ok: false, text: 'Say where the pool master answers.' };
        return this.xoSetups.beginDeploy({ address: String(p.address), pin: p.pin ? String(p.pin) : null, relay: p.relay ? String(p.relay) : null, actor });
      case 'watchdog':
        // A begin for adding the reconnect watchdog to a Xen Orchestra that
        // predates it, through the pool master that runs its VM, pinned as
        // an install is (xo-watchdog.js).
        if (!p.address) return { ok: false, text: 'Say where the pool master answers.' };
        return this.xoSetups.beginWatchdog({ address: String(p.address), pin: p.pin ? String(p.pin) : null, relay: p.relay ? String(p.relay) : null, actor });
      case 'pve':
        // A begin for setting up a Proxmox VE node for a phone that cannot
        // reach it, pinned to the node's SSH host key (pve-setup.js).
        if (!p.address) return { ok: false, text: 'Say where the node answers SSH.' };
        return this.xoSetups.beginPve({ address: String(p.address), pin: p.pin ? String(p.pin) : null, relay: p.relay ? String(p.relay) : null, actor });
      case 'run':
        return this.xoSetups.run({ job: String(p.job || ''), sealed: String(p.sealed || ''), actor });
      case 'status':
        return this.xoSetups.status({ job: String(p.job || ''), actor });
      case 'cancel':
        return this.xoSetups.cancel({ job: String(p.job || ''), actor });
      case 'policy':
        return this.xoSetups.policy({ job: String(p.job || ''), sealed: String(p.sealed || ''), actor });
      default:
        return { ok: false, text: 'Unknown setup phase.' };
    }
  }

  /** @param {unknown} msg */
  async #onMessage(msg) {
    const reply = await this.handle(msg);
    // A frame with nothing to answer sends nothing. The coordinator correlates
    // replies by id, and a reply with no id is a message it can only discard —
    // or, worse, one that clobbers a waiter. See the fan-out bug in
    // docs/fleet-debug notes: replies keyed by the wrong thing broke the fleet
    // the moment it had two hosts.
    if (reply?.kind === 'none') return;
    await this.transport.send(reply);
  }

  /**
   * Whether this box refuses this intent unless a person signed or delegated
   * it. `signers` covers nobody named, because a box runs that as itself, and
   * anybody it has been shown a key for, because a person who signs is a
   * person a forged request in their name would be a forgery of.
   *
   * @param {{ actor?: string }} intent
   */
  #enforces(intent) {
    if (this.requireSigned === 'all') return true;
    if (this.requireSigned === 'off') return false;
    return !actorEmail(intent.actor) || Boolean(this.intentKeys?.isSigner(intent.actor));
  }

  /**
   * The protocol the coordinator on this socket has shown it speaks, or null
   * while it has shown none.
   *
   * WHAT IT IS FOR: a list this box volunteers that only a newer coordinator
   * knows to filter. Which members are signed in to which engine here
   * (`engineSignins`) is shown by a coordinator on 22 to who may act for
   * each member, and a coordinator from before it passed every health key it
   * did not know to every member. Boxes update ahead of the coordinator in
   * half a deploy, so for that window a box on 22 told the whole fleet who
   * was signed in where. The list now waits for a frame that says the
   * coordinator has it (health).
   *
   * HOW IT IS HEARD. The coordinator stamps its own number on every frame
   * it writes that is not an intent: a config frame, the answer to a vault
   * or key-list request (`minted`), `decided`, `vault-changed`, a relay's.
   * A box with a key asks for its key list seconds after it starts, so one
   * arrives early. The LATEST such frame is believed, so a coordinator
   * rolled back under a box that stays up is heard too. An intent is
   * spoken in the older of the two parties' versions (buildIntent), so it
   * can only show the number is at least its own.
   *
   * @type {number|null}
   */
  coordinatorSpeaks = null;

  /** @param {unknown} msg  a frame from the coordinator (coordinatorSpeaks) */
  #heardCoordinator(msg) {
    const frame = /** @type {any} */ (msg);
    const v = frame?.v;
    if (!Number.isInteger(v) || v < 1) return;
    if (frame.kind !== 'intent') this.coordinatorSpeaks = v;
    else if (v > (this.coordinatorSpeaks ?? 0)) this.coordinatorSpeaks = v;
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
    this.#heardCoordinator(msg);
    // BYTES THROUGH A PHONE, before anything that awaits: a relay's frames
    // must reach its streams in the order they arrived, and they are not
    // intents and get no reply (xo-relay.js checks each).
    if (/** @type {any} */ (msg)?.kind === 'relay') {
      this.relays.onFrame(msg);
      return { kind: 'none' };
    }
    // AND A CONSOLE'S, for the same reason: in order, and no reply.
    if (/** @type {any} */ (msg)?.kind === 'tunnel') {
      this.tunnels.onFrame(msg);
      return { kind: 'none' };
    }
    // AND A PHONE'S PAGE'S, for the same reason.
    if (/** @type {any} */ (msg)?.kind === 'browse') {
      this.browses.onFrame(msg);
      return { kind: 'none' };
    }
    // CONFIG BEFORE INTENT, because it is not one. A config frame carries named
    // values from a fixed set (src/fleet/protocol/config-frame.js) and gets no
    // reply — there is nothing to correlate and nothing to say. Checked first so
    // validateIntent never sees a frame it would refuse as a malformed intent.
    if (/** @type {any} */ (msg)?.kind === 'config') return this.#onConfig(msg);
    // A MACHINE IMAGE'S BUILD VM SAYING WHERE ITS INSTALL HAS GOT TO, passed
    // on by the coordinator because this box asked for its token. No reply:
    // the VM was answered when the coordinator took the report.
    if (/** @type {any} */ (msg)?.kind === 'image-report') {
      this.xoSetups?.imageReport(msg);
      return { kind: 'none' };
    }
    // SOMEBODY'S VAULT CHANGED, said by the coordinator after a person kept,
    // forgot or approved something (core.js, #vaultChanged). Not an intent and
    // no reply: this box asks the vault now rather than at its next ten
    // minutes, and the vault decides what that gives it.
    if (/** @type {any} */ (msg)?.kind === 'vault-changed') {
      this.#vaultChangedSoon();
      return { kind: 'none' };
    }
    // THE ANSWER TO A MINT THIS RUNNER ASKED FOR. Not an intent either, and it
    // gets no reply: it closes a request this process opened. An answer
    // nobody is waiting for is dropped — it is sealed to a key that has gone.
    // AND TO A DECISION IT ASKED FOR (`decided`, the same shape): an answer
    // with an id nobody is waiting on is dropped, like any other.
    if (/** @type {any} */ (msg)?.kind === 'minted' || /** @type {any} */ (msg)?.kind === 'decided') {
      const m = /** @type {any} */ (msg);
      const waiter = typeof m.id === 'string' ? this.mintWaiters.get(m.id) : undefined;
      if (waiter) {
        this.mintWaiters.delete(m.id);
        clearTimeout(waiter.timer);
        waiter.resolve(m);
      }
      return { kind: 'none' };
    }

    const checked = validateIntent(msg, { maxSkewMs: this.maxSkewMs });
    if (checked.ok === false) {
      const raw = /** @type {any} */ (msg);
      // The id may be exactly what is wrong with the envelope, so echo it only
      // when it is well-formed enough to correlate on.
      const id = typeof raw?.id === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(raw.id) ? raw.id : null;
      this.log.warn(`sidecar: refused an intent (${checked.code}): ${checked.error}`);
      return { v: PROTOCOL_VERSION, kind: 'reply', id, ok: false, text: checked.error, error: { code: checked.code } };
    }
    let intent = checked.intent;

    // NOBODY ASKS AS A MEMBER'S OWN ACCOUNT. `<id>@members.invalid` is where
    // this box files an agent member's sign-ins (protocol/members.js), and a
    // session runs on them only through `start` with `member`, checked below
    // against the list the minter signed. A request naming that address as
    // the one asking is the coordinator inventing a person nobody is, and on
    // a box that takes unsigned work it would run on the member's sign-ins
    // with nobody having signed for it.
    if (memberOfAccount(intent.actor)) {
      this.log.warn(`sidecar: refused ${intent.verb} ${intent.id}: it names a member's own account, ${intent.actor}, as who is asking`);
      return {
        v: PROTOCOL_VERSION, kind: 'reply', id: intent.id, ok: false, error: { code: 'not_a_person' },
        text: `${this.hostId} takes requests from people. ${intent.actor} is a member’s own account, which nobody asks as: a session is started as a member by one of its custodians. Nothing was done.`,
      };
    }

    // WHO SIGNED IT, counted and said on every box (docs/signed-intents.md,
    // phase 1). A signature that does not hold is logged with what it was
    // for, so the fleet sees what enforcement would refuse.
    //
    // AND REFUSED, on a box that takes only what a person signed (phase 3):
    // anything needsSignature names that is not signed by a key the minter
    // lists for its actor, whatever the reason. A box that cannot check at
    // all, with no key of its own to ask the minter with or no list yet,
    // refuses too: enforcement that lapses when the list is late is
    // enforcement a coordinator can lapse by holding the list back.
    /** @type {string|null} */
    let verdict = null;
    /** @type {'taken'|'failed'|'held'|undefined} */
    let askedAgain;
    /** The members a delegation names, when that is the one thing it lacks for this start. @type {string[]|undefined} */
    let grantNames;
    if (this.intentKeys) {
      try {
        ({ verdict, askedAgain, members: grantNames } = await this.intentKeys.check(intent, this.hostId));
        if (verdict === 'bad-signature' || verdict === 'unknown-key' || verdict === 'revoked') {
          const what = intent.sig ? 'a signature' : 'a delegation';
          this.log.warn(`sidecar: ${intent.verb} ${intent.id} from ${intent.actor ?? 'nobody'} carries ${what} that does not hold (${verdict})${this.requireSigned !== 'off' ? '' : '; not refused, as this box does not enforce'}`);
        }
      } catch (e) {
        this.log.warn(`sidecar: could not check ${intent.id}'s signature: ${/** @type {Error} */ (e).message}`);
      }
    }
    // A DELEGATION THAT DOES NOT NAME THE MEMBER, on a start as one. Its
    // signer's key is listed and the grant holds in every other way, so this
    // is said in its own words on every box, enforcing or not: what the grant
    // does name, and that the way on is a grant made again on the phone. A
    // delegation used to carry a start as any member its signer could act
    // for, which let the coordinator alone start a session on a member's
    // sign-ins with words of its own (intent-signature.js, `members`).
    //
    // AND ON AN ENGINE SIGN-IN FOR ONE (`enginesignin`), by the same list and
    // in the same code: it puts a sign-in where that member's sessions run.
    if (verdict === 'not-covered' && grantNames) {
      const id = String(intent.params?.member ?? '');
      const name = typeof intent.params?.memberName === 'string' && intent.params.memberName ? intent.params.memberName : id;
      const names = grantNames.length ? grantNames.join(', ') : 'no member';
      this.log.warn(`sidecar: refused ${intent.verb} ${intent.id} as ${id} from ${intent.actor ?? 'nobody'}: the delegation it carries names ${names}`);
      return {
        v: PROTOCOL_VERSION, kind: 'reply', id: intent.id, ok: false, error: { code: 'member_not_delegated' },
        text: intent.verb === 'enginesignin'
          ? `What ${intent.actor} granted this connection does not cover signing an engine in for ${name}: it names ${names}. ` +
            `Grant it again from the Fleetwright app on a phone, under You \u2192 Delegations, with ${name} among its members. Nothing was done.`
          : `What ${intent.actor} granted this connection does not cover starting a session as ${name}: it names ${names}. ` +
            `Grant it again from the Fleetwright app on a phone, under You \u2192 Delegations, with ${name} among the members it may start as. Nothing was started.`,
      };
    }
    if (this.#enforces(intent) && verdict !== 'signed' && verdict !== 'delegated' && needsSignature(intent.verb)) {
      const why = unsignedReason(verdict, intent, this.intentKeys?.problem ?? null, askedAgain);
      this.log.warn(`sidecar: refused ${intent.verb} ${intent.id} from ${intent.actor ?? 'nobody'}: ${why}`);
      return {
        v: PROTOCOL_VERSION, kind: 'reply', id: intent.id, ok: false, error: { code: 'signature_required' },
        text: `${this.hostId} takes only requests a person signed, and ${why}. Nothing was done.`,
      };
    }

    // A DELEGATION AT A SESSION THAT RUNS AS A MEMBER (docs/members.md, "A
    // delegation covers a member only by naming it"). The rule above stopped
    // a grant that names no member from starting a session as one, and
    // nothing after the start asked it: the same grant wrote files into a
    // member's running session, answered its prompts, resumed it and read
    // it. So a delegated verb that names a session is held to the grant's
    // `members` when that session is a member's.
    //
    // ONLY WHERE THIS BOX TAKES NOTHING UNSIGNED. A box that takes unsigned
    // work takes the coordinator's word for these verbs with or without a
    // grant, so refusing the grant there would stop an honest coordinator
    // and nobody else (docs/members.md, "What it does not stop").
    if (verdict === 'delegated' && this.#enforces(intent) && SESSION_VERBS.includes(intent.verb) && typeof intent.params?.name === 'string') {
      // The grant as it was just checked: `delegated` is a signature that
      // held over exactly this shape, `members` in it or left out.
      const refused = await this.#heldToMembers(intent, delegationShape(intent.delegation)?.grant.members ?? []);
      if (refused) {
        this.log.warn(`sidecar: refused ${intent.verb} ${intent.id} at ${intent.params.name} from ${intent.actor ?? 'nobody'}: ${refused.why}`);
        return { v: PROTOCOL_VERSION, kind: 'reply', id: intent.id, ok: false, error: { code: refused.code }, text: refused.text };
      }
    }

    // AS A MEMBER (docs/members.md, "Starting as a member"): checked here,
    // against the list the minter signed, whatever this box's mode. From
    // here on the intent is the member's own start, with who asked beside it.
    //
    // ON A TASK (docs/tasks.md) is a member start and nothing else: a task
    // is one member's work, and a session on one with no member named would
    // be work on a task as whoever asked.
    if (intent.verb === 'start' && intent.params?.taskId !== undefined && intent.params?.member === undefined) {
      return {
        v: PROTOCOL_VERSION, kind: 'reply', id: intent.id, ok: false, error: { code: 'bad_params' },
        text: `A session on ${String(intent.params.taskId)} is started as the task’s assignee, and this names no member. Nothing was started.`,
      };
    }
    if (intent.verb === 'start' && intent.params?.member !== undefined) {
      const as = this.#startAs(intent, verdict);
      if (!as.ok) {
        this.log.warn(`sidecar: refused start ${intent.id} as ${String(intent.params.member)} from ${intent.actor ?? 'nobody'}: ${as.text}`);
        return { v: PROTOCOL_VERSION, kind: 'reply', id: intent.id, ok: false, error: { code: as.code }, text: as.text };
      }
      intent = as.intent;
    }

    // AN ENGINE SIGNED IN FOR A MEMBER (docs/engines.md, "Signing in on the
    // machine"), held to the rule a start as that member is, here and for
    // every one of its actions: `status` answers with the code.
    if (intent.verb === 'enginesignin') {
      const as = this.#signInAs(intent, verdict);
      if (!as.ok) {
        this.log.warn(`sidecar: refused enginesignin ${intent.id} for ${String(intent.params.member)} from ${intent.actor ?? 'nobody'}: ${as.text}`);
        return { v: PROTOCOL_VERSION, kind: 'reply', id: intent.id, ok: false, error: { code: as.code }, text: as.text };
      }
      intent = as.intent;
    }

    if (!isMutating(intent.verb)) return this.#run(intent, verdict);

    // Idempotency. The PROMISE is cached, not just the result, so a retry that
    // arrives while the first attempt is still in flight — which is exactly
    // when a retry arrives — waits for that attempt instead of starting a
    // second session.
    const cached = this.#recall(intent.id);
    if (cached) {
      const was = await cached;
      // NOTHING OF AN ENGINE SIGN-IN'S ANSWER WAS KEPT (below), so there is
      // no first reply to replay. The retry is answered with where the
      // sign-in stands now, FOR THE MEMBER AND ENGINE THIS REQUEST NAMES,
      // which never starts anything: the attempt in flight while there is
      // one, with its code, signed over this same id.
      if (was === CODE_NOT_KEPT && intent.verb === 'enginesignin') {
        this.log.info(`sidecar: enginesignin ${intent.id} already answered; nothing of its answer is kept, so it is answered with where the sign-in stands now`);
        return { ...(await this.#run({ ...intent, params: { ...intent.params, action: 'status' } }, verdict)), replayed: true };
      }
      // AN ID THAT ANSWERED A SIGN-IN, OR ANOTHER KIND OF REQUEST, IS NOT RUN
      // AS THIS ONE. An id is one request's. This ran whatever verb arrived
      // under a sign-in's id as if it were new, a stop among them, and
      // answered a sign-in under another request's id with that request's
      // reply. Neither is a retry, so neither is answered as one.
      if (was === CODE_NOT_KEPT || intent.verb === 'enginesignin') {
        this.log.warn(`sidecar: refused ${intent.verb} ${intent.id}: that id already answered another kind of request`);
        return {
          v: PROTOCOL_VERSION, kind: 'reply', id: intent.id, ok: false, error: { code: 'id_reused' },
          text: `${this.hostId} already answered another request under this id, so it does not run this one. Send it again under an id of its own. Nothing was done.`,
        };
      }
      this.log.info(`sidecar: ${intent.verb} ${intent.id} already handled — replaying the original reply`);
      return { ...was, replayed: true };
    }
    const pending = this.#run(intent, verdict);
    // WHAT IS REMEMBERED IS THE REPLY, EXCEPT AN ENGINE SIGN-IN'S, OF WHICH
    // NOTHING IS. The page and the code are for whoever asked, for as long as
    // they are of use, and ten minutes in this map is neither. And the rest
    // of an answer is one member's: this kept every answer that carried no
    // code, the account a sign-in is on among it, under the id alone, and a
    // second outside review asked after another member under the same id
    // and was handed the first member's account. So of every such reply
    // only the id is remembered, as answered: it still cannot be run twice,
    // and a retry is answered afresh, for what it asks, sealed to its own
    // `reply`, which need not be the first one's.
    if (intent.verb === 'enginesignin') {
      // Whoever asked is told of a failure by `pending` itself; this copy of it is only for a retry.
      this.#remember(intent.id, pending.then(() => CODE_NOT_KEPT, () => CODE_NOT_KEPT));
    } else {
      this.#remember(intent.id, pending);
    }
    // A VERB THAT CHANGES WHAT THIS HOST IS CAPABLE OF PUSHES HEALTH AT ONCE.
    //
    // Health is volunteered every fifteen seconds, which is right for a number
    // that drifts and wrong for one somebody just changed on purpose. Connect
    // an account and test it immediately, and the coordinator answers from the
    // frame before the change — "nobody has linked a Claude account on this
    // host", about a host where you have just linked one. Reported from a
    // phone, where it reads as the link having failed.
    //
    // Cheap: health is a couple of local reads, and only these verbs can move
    // it.
    if (CAPABILITY_VERBS.has(intent.verb)) {
      void pending.then(() => this.#pushHealth()).catch(() => {});
    }
    return pending;
  }

  /**
   * A `pinadmin` from the wire, decided against the record as it is now and
   * written in the same step (pinned-admins.js, updatePins).
   *
   * @param {import('../protocol/intents.js').Intent} intent
   * @param {string|null} verdict
   */
  async #pinAdmin(intent, verdict) {
    const dir = this.xoStateDir;
    const decided = dir
      ? await updatePins(dir, (pins) => {
          const d = decidePin(intent, pins, verdict, this.intentKeys?.directory ?? null);
          return { ...(d.ok && d.write ? { write: d.write } : {}), result: d };
        })
      : decidePin(intent, readPins(null), verdict);
    if (!decided.ok) {
      this.log.warn(`sidecar: refused pinadmin ${intent.id} from ${intent.actor ?? 'nobody'}: ${decided.text}`);
      return { ok: false, text: decided.text, error: { code: decided.code } };
    }
    if (decided.write) this.log.info(`sidecar: ${intent.actor} changed who is pinned here: ${decided.write.admins.join(', ')}`);
    return { ok: true, text: decided.text };
  }

  /**
   * The refusal for a box-wide verb this box's pins do not allow, or null.
   *
   * A restore of the asker's own binned session goes through on their
   * signature, pinned or not. Whose it is comes from the hub's bin; missing,
   * unreadable, or with no owner is cannot tell, which refuses, because a
   * guess would restore somebody else's work.
   *
   * @param {import('../protocol/intents.js').Intent} intent
   * @param {string|null} verdict
   * @returns {Promise<Record<string, unknown>|null>}
   */
  async #boxWide(intent, verdict) {
    const pins = readPins(this.xoStateDir);
    /** @type {boolean|null} */
    let owns = null;
    if (intent.verb === 'restore' && pins.admins.length > 0 && !pins.unreadable) owns = await this.#ownsBinned(intent);
    const decided = decideBoxWide(intent, pins, verdict, owns);
    if (decided.ok) return null;
    this.log.warn(`sidecar: refused ${intent.verb} ${intent.id} from ${intent.actor ?? 'nobody'}: ${decided.text}`);
    return { ok: false, text: decided.text, error: { code: decided.code } };
  }

  /**
   * @param {import('../protocol/intents.js').Intent} intent
   * @returns {Promise<boolean|null>}
   */
  async #ownsBinned(intent) {
    /** @type {any} */
    let state;
    try {
      state = await this.hub.state();
    } catch {
      return null;
    }
    const bin = state?.bin;
    if (!Array.isArray(bin)) return null;
    const name = String(intent.params?.name ?? '');
    const row = bin.find((/** @type {any} */ r) => r && r.name === name);
    if (!row) return null;
    const owner = ownerOf(row.createdBy);
    const who = actorEmail(intent.actor);
    if (!owner || !who) return null;
    return owner === who;
  }

  /**
   * Why a delegated verb at a session is not covered by the members its
   * grant names, or null when it is.
   *
   * WHOSE THE SESSION IS COMES FROM THIS BOX'S OWN HUB, and from nothing the
   * request says. The hub wrote `member` on the session's record when it
   * started it, and this box sent that start only after it had checked it
   * against the minter's list (#startAs), so the record is this box's own
   * word. The coordinator's list of sessions is not asked: it is the party
   * the grant is checked against.
   *
   *  - A session the hub records no member for is its starter's, and the
   *    grant covers it as it always did.
   *  - A name the hub does not have is passed on, and the hub says so.
   *  - A HUB THAT DOES NOT ANSWER IS CANNOT TELL, and that refuses: a check
   *    that lapsed while the hub was busy would be one a coordinator could
   *    wait for.
   *
   * Running, stopped and binned alike: a resume runs on the member's
   * sign-ins again, and a restore brings the session back to do so.
   *
   * @param {any} intent @param {string[]} names  the members the grant names
   * @returns {Promise<{ code: string, text: string, why: string }|null>}
   */
  async #heldToMembers(intent, names) {
    const session = String(intent.params.name);
    /** @type {any} */
    let state = null;
    try {
      state = await this.hub.state();
    } catch {
      state = null;
    }
    if (!state || !Array.isArray(state.sessions)) {
      return {
        code: 'member_unchecked',
        why: 'the hub did not say whose session it is',
        text: `${this.hostId} could not read from its own session manager whose session ${session} is, so it cannot tell whether what ${intent.actor} granted this connection covers it. Nothing was done. Try again in a moment.`,
      };
    }
    const rows = [...state.sessions, ...(Array.isArray(state.bin) ? state.bin : [])].filter((/** @type {any} */ r) => r && r.name === session);
    const row = rows.find((/** @type {any} */ r) => typeof r.member === 'string' && r.member && !names.includes(r.member));
    if (!row) return null;
    const name = typeof row.memberName === 'string' && row.memberName ? row.memberName : row.member;
    const named = names.length ? names.join(', ') : 'no member';
    return {
      code: 'member_not_delegated',
      why: `it runs as ${row.member} and the delegation it carries names ${named}`,
      text:
        `What ${intent.actor} granted this connection does not cover ${session}, which runs as ${name}: it names ${named}. ` +
        `Grant it again from the Fleetwright app on a phone, under You \u2192 Delegations, with ${name} among the members it may start as. Nothing was done.`,
    };
  }

  /**
   * May this start run as the member it names, and as what?
   *
   * THE CHECK THAT COUNTS. The coordinator refuses first and decides nothing
   * (core.js, #startAs): it is the party this box does not believe. What
   * this box believes is the minter's signed list of who may start as each
   * member, and a signature or delegation, by a key the same list names for
   * that person, over this start with this member in it. A delegation says
   * so by naming the member (`members`), and one that does not never gets
   * here: checkDelegation finds it does not cover the start, and handle()
   * refuses it first.
   *
   *  - SIGNED OR DELEGATED, WHATEVER THE MODE. A box set to take unsigned
   *    work takes the coordinator's word for who asked. Here that word would
   *    name a custodian, and the session would run on sign-ins that are not
   *    the asker's, so it is not taken.
   *  - NO LIST IS A REFUSAL, as it is for signatures: a check that lapsed
   *    while the list was late would be one a coordinator could lapse.
   *
   * What comes back is the member's own start: the account its vault is
   * filed under here as who it runs as, its instructions and the task as one
   * first message under the cap a first message has, and who asked kept
   * beside it for the record. This box's own secrets never answer it: they
   * are its operator's, for the operator's own sessions.
   *
   * @param {any} intent @param {string|null} verdict
   * @returns {{ ok: true, intent: any } | { ok: false, code: string, text: string }}
   */
  #startAs(intent, verdict) {
    /** @param {string} code @param {string} text */
    const refuse = (code, text) => /** @type {const} */ ({ ok: false, code, text: `${text} Nothing was started.` });
    const as = this.#actingAs(intent, verdict);
    const { id, name, asker } = as;
    if (!as.ok) {
      if (as.why === 'unchecked') return refuse('member_unchecked', `${this.hostId} holds no list from the vault of who may start a session as a member${as.problem}, so it starts nobody as one.`);
      if (as.why === 'unknown') return refuse('no_member', `The vault lists no member called ${id}. Whoever manages ${name} files it from the Org screen first.`);
      if (as.why === 'unlisted') return refuse('not_custodian', `${asker || 'Nobody named'} may not start a session as ${name}. The vault lists ${as.listed}.`);
      return refuse('signature_required', `A session as ${name} runs on ${name}’s sign-ins, so ${this.hostId} starts one only when ${asker} signed for it, or delegated it in a grant that names ${name}, and this was neither.`);
    }
    const member = as.member;
    const instructions = typeof intent.params.memberBrief === 'string' ? intent.params.memberBrief : '';
    const words = typeof intent.params.task === 'string' ? intent.params.task : '';
    // ON A TASK (docs/tasks.md, "Starting on a task"): which task and branch
    // this is go before the words the person signed, and where to write the
    // result goes after them. The id, branch and repository are signed with
    // the words, so the line this box writes is the asker's and not the
    // coordinator's.
    const onTask = typeof intent.params.taskId === 'string';
    if (onTask && !(typeof intent.params.taskBranch === 'string' && TASK_BRANCH_RE.test(intent.params.taskBranch))) {
      return refuse('bad_params', `A session on ${intent.params.taskId} needs the task’s branch, and this start names none.`);
    }
    const first = onTask
      ? composeTaskMessage({ instructions, taskId: intent.params.taskId, branch: intent.params.taskBranch, repo: typeof intent.params.taskRepo === 'string' ? intent.params.taskRepo : '', words })
      : composeFirstMessage(instructions, words);
    if (!first.ok) return refuse('bad_params', first.text);
    const params = { ...intent.params, boxSecrets: 'no' };
    delete params.memberBrief;
    if (first.text) params.task = first.text;
    else delete params.task;
    return { ok: true, intent: { ...intent, actor: as.account, startedBy: asker, params } };
  }

  /**
   * May whoever sent this act as the member it names? THE ONE RULE a start
   * as a member and an engine sign-in for one are both held to, so the two
   * cannot come to disagree about who a member's sign-ins are open to.
   *
   * What this box believes is the minter's signed list of who may start as
   * each member, and a signature or delegation, by a key the same list names
   * for that person, over this request with this member in it.
   *
   *  - NO LIST IS A REFUSAL (`unchecked`), as it is for signatures.
   *  - A member the list does not have (`unknown`), and an asker it does not
   *    name for that member (`unlisted`).
   *  - SIGNED OR DELEGATED, WHATEVER THE MODE (`unsigned`): a box set to take
   *    unsigned work would otherwise take the coordinator's word for who
   *    asked, and here that word would name a custodian.
   *
   * It words nothing: each caller says what was being asked for. `account`
   * is what the member's sessions run as on this box, the member's own
   * address for a person and `<id>@members.invalid` for an agent.
   *
   * @param {any} intent @param {string|null} verdict
   * @returns {{ ok: true, id: string, name: string, asker: string, member: any, account: string }
   *   | { ok: false, why: 'unchecked'|'unknown'|'unlisted'|'unsigned', id: string, name: string, asker: string, problem: string, listed: string }}
   */
  #actingAs(intent, verdict) {
    const id = String(intent.params.member);
    const name = typeof intent.params.memberName === 'string' && intent.params.memberName ? intent.params.memberName : id;
    const asker = String(intent.actor || '').trim().toLowerCase();
    /** @param {'unchecked'|'unknown'|'unlisted'|'unsigned'} why @param {{ problem?: string, listed?: string }} [said] */
    const no = (why, said = {}) => /** @type {const} */ ({ ok: false, why, id, name, asker, problem: said.problem ?? '', listed: said.listed ?? '' });
    const members = this.intentKeys?.currentMembers ?? null;
    if (!members) return no('unchecked', { problem: this.intentKeys?.problem ? ` (${this.intentKeys.problem})` : '' });
    const member = members.get(id);
    if (!member) return no('unknown');
    if (!asker || !member.may.includes(asker)) return no('unlisted', { listed: member.may.length ? member.may.join(', ') : 'nobody in the fleet now' });
    if (verdict !== 'signed' && verdict !== 'delegated') return no('unsigned');
    return { ok: true, id, name, asker, member, account: member.kind === 'agent' ? accountOfMember(id) : String(member.email ?? '') };
  }

  /**
   * May this engine sign-in be made for the member it names?
   *
   * EXACTLY WHO MAY START A SESSION AS THAT MEMBER (#actingAs), because what
   * it does is put a sign-in where that member's sessions run on it. For all
   * four actions: `status` answers with the code a person types, and a sign
   * out ends what those sessions run on.
   *
   * What comes back carries the member's account on this box beside the
   * intent, for the hub to name the engine home by, and who asked. Neither
   * is a parameter: a caller cannot say whose home is opened.
   *
   * @param {any} intent @param {string|null} verdict
   * @returns {{ ok: true, intent: any } | { ok: false, code: string, text: string }}
   */
  #signInAs(intent, verdict) {
    /** @param {string} code @param {string} text */
    const refuse = (code, text) => /** @type {const} */ ({ ok: false, code, text: `${text} Nothing was done.` });
    const as = this.#actingAs(intent, verdict);
    const { id, name, asker } = as;
    if (!as.ok) {
      if (as.why === 'unchecked') return refuse('member_unchecked', `${this.hostId} holds no list from the vault of who may start a session as a member${as.problem}, so it signs no member’s engine in.`);
      if (as.why === 'unknown') return refuse('no_member', `The vault lists no member called ${id}. Whoever manages ${name} files it from the Org screen first.`);
      if (as.why === 'unlisted') return refuse('not_custodian', `${asker || 'Nobody named'} may not sign an engine in for ${name}. That is for whoever may start a session as ${name}, and the vault lists ${as.listed}.`);
      return refuse('signature_required', `An engine signed in for ${name} is what ${name}’s sessions run on, so ${this.hostId} does it only when ${asker} signed for it, or delegated it in a grant that names ${name}, and this was neither.`);
    }
    // ONLY ON A MACHINE APPROVED FOR THAT MEMBER'S VAULT, for a start. A
    // sign-in made here is a credential here, and the one identity of this
    // box a phone can check without believing the coordinator is the key a
    // custodian approved for the member's vault: its hash is in the vault's
    // own sealed answer to the phone, and it is the key the answer to this
    // start is signed with (#signAnswer). On a box nobody approved, the
    // phone would have nothing to hold that signature to.
    //
    // CANNOT TELL IS NOT "NOT APPROVED": a box the vault has not answered
    // yet says so. And only a start: a sign-in is still signed out, and
    // asked after, on a machine whose approval has since been removed.
    if (intent.params.action === 'start') {
      const held = this.approvedFor;
      // AND WHY, when the vault did answer and this box could not take the
      // answer for the vault's: "try again in a few minutes" would send a
      // person round a loop that only a deploy, or a file on this box, ends.
      if (!held && this.vaultUnchecked) {
        return refuse('approval_unknown',
          `${this.hostId} cannot tell whether it is approved to hold ${name}’s credentials, because ${this.vaultUnchecked.why}. ${this.vaultUnchecked.todo}`);
      }
      if (!held) {
        const asks = this.vaultKey && this.vaultIntervalMs > 0 && !this.jobToken;
        return refuse('approval_unknown',
          `${this.hostId} has not heard from the vault whose credentials it is approved to hold, so it cannot tell whether it is approved for ${name}’s. ` +
          (asks ? `It asks every ${Math.round(this.vaultIntervalMs / 60_000)} minutes: try again in a few minutes.` : 'It does not ask the vault by itself, so the sign-in is made on a machine that does.'));
      }
      const approved = as.member.kind === 'agent' ? held.members.has(id) : held.people.has(as.account.trim().toLowerCase());
      if (!approved) {
        return refuse('not_approved',
          `${this.hostId} is not approved to hold ${name}’s credentials, and an engine signed in here would be one of them. ` +
          `Approve this machine from ${name}’s Credentials in the Fleetwright app first, then sign in. If it was approved a moment ago, ask again shortly.`);
      }
    }
    return { ok: true, intent: { ...intent, signInAs: { account: as.account, by: asker } } };
  }

  /**
   * The hub's answer to an engine sign-in, signed by this box and, for a
   * phone, sealed to it (docs/engines.md, "The machine signs what it
   * answers").
   *
   * SIGNED WITH THE KEY THIS BOX SIGNS ITS VAULT REQUESTS WITH, and by the
   * same function, so the signature is in the one encoding everything here
   * uses and under the key a custodian approved. Over the id of the request
   * it answers, so an answer to one request is not an answer to another; a
   * status asked under a new id is signed over that id.
   *
   * SEALED TO `reply`, WHEN THE REQUEST CARRIES ONE, which is a key the
   * asking phone made and signed for with the rest of the request. Then the
   * page, the code and who is signed in go inside, with this box's key and
   * its signature over them, and NOTHING OF THEM GOES ON IN THE CLEAR: the
   * coordinator carries a state, some times and ciphertext. Every answer
   * that says where a sign-in stands is sealed then, whatever the state,
   * because who it ended signed in as is the thing a person checks, and it
   * should be this box's word. The signature is what makes it so: anybody
   * can seal to a public key.
   *
   * WITHOUT ONE, as it was: in the clear, and signed only while it carries
   * the page and the code. That is an MCP client, which has no key to seal
   * to and is told the code is unverified.
   *
   * WHAT THIS BOX CANNOT SIGN OR SEAL IS NOT PASSED ON. It is refused
   * instead, in words that say so.
   *
   * @param {import('../protocol/intents.js').Intent} intent
   * @param {Record<string, any>} said
   * @returns {Promise<Record<string, any>>}
   */
  async #signAnswer(intent, said) {
    const sealTo = typeof intent.params?.reply === 'string' ? intent.params.reply : null;
    const coded = typeof said?.url === 'string' && typeof said?.code === 'string';
    // A refusal says nothing of a page, a code or an account, and goes as it is.
    if (said?.ok !== true || !(coded || (sealTo && typeof said.state === 'string'))) return said;
    /** What goes on in the clear. Under a `reply`, nothing of the page, the code or the account. @type {Record<string, any>} */
    const clear = { ...said };
    if (sealTo) {
      delete clear.url;
      delete clear.code;
      clear.signedIn = said.signedIn ? { since: said.signedIn.since } : null;
    }
    const key = this.vaultKey;
    const at = Date.now();
    try {
      if (!key) throw new Error('it has no key of its own');
      const hostKey = { kty: 'EC', crv: 'P-256', x: key.publicJwk.x, y: key.publicJwk.y };
      const who = said.signedIn?.who ? { email: said.signedIn.who.email ?? null, plan: said.signedIn.who.plan ?? null } : null;
      // WHERE IT STANDS, WHY IT FAILED AND WHEN THE CODE RUNS OUT, signed and
      // sealed with the rest. They were only in the clear part, where the
      // coordinator carries them, and a phone wrote its sentence from them:
      // a genuine sealed answer came back beside `state: "failed"` and a
      // `detail` naming a code of the coordinator's own, and the sentence a
      // person read was that. In a sealed answer only, so a clear one's
      // bytes are what they were. The clear copies stay beside the seal.
      //
      //   state      a code that is out is `waiting`, whatever else was said.
      //   detail     the engine's sentence or null, held to one line of
      //              printable ASCII: the phones' encoders and this one
      //              must write the same bytes, and that is the range in
      //              which no two JSON encoders differ.
      //   expiresAt  a whole number, and only while a code is out.
      const state = typeof said.state === 'string' ? said.state : 'waiting';
      const detail = typeof said.detail === 'string' ? said.detail.replace(/[^\x20-\x7e]/g, '').slice(0, 200) : null;
      const expiresAt = coded && said.expiresAt !== null && Number.isFinite(Number(said.expiresAt)) ? Math.round(Number(said.expiresAt)) : null;
      const signed = {
        id: intent.id, host: await keyId(hostKey), member: String(intent.params.member), engine: String(intent.params.engine),
        ...(coded ? { url: said.url, code: said.code } : {}), at,
        ...(sealTo ? { signedIn: said.signedIn ? { since: Number(said.signedIn.since), who } : null, state, detail, ...(expiresAt === null ? {} : { expiresAt }) } : {}),
      };
      const signature = await key.sign(signinAnswerInput(signed));
      if (!sealTo) return { ...said, signedAt: at, hostKey, signature };
      return { ...clear, sealed: await seal({ to: sealTo, aad: ENGINE_SIGNIN_AAD, payload: { v: 1, ...signed, hostKey, signature } }) };
    } catch (e) {
      // The reason only: nothing of the answer is logged.
      this.log.warn(`sidecar: could not sign the answer to enginesignin ${intent.id}: ${/** @type {Error} */ (e).message}`);
      delete clear.url;
      delete clear.code;
      // WHAT TO DO NEXT, BY WHO IS READING. A phone's sheet has no button
      // that asks again: while a code is out it asks by itself every few
      // seconds, and otherwise when the screen is opened. Told to "ask
      // where it stands again", a person on a phone was told to do
      // something the screen does not offer. An agent, which sends no
      // `reply`, has the tool to ask with, and is still told to.
      const next = sealTo
        ? (coded ? 'This screen asks again by itself in a few seconds: wait for that, or cancel it.' : 'This screen asks again the next time it is opened.')
        : (coded ? 'Ask where it stands again, or cancel it.' : 'Ask where it stands again.');
      return {
        ...clear, ok: false, error: { code: 'answer_unsigned' },
        text: coded
          ? `${this.hostId} could not sign its answer, so the page and the code are not passed on: a code this machine has not signed is one nobody can tell is its own. ` +
            `The sign-in is still waiting there. ${next}`
          : `${this.hostId} could not sign its answer, so what it says of this sign-in is not passed on. ${next}`,
      };
    }
  }

  /**
   * @param {import('../protocol/intents.js').Intent} intent
   * @param {string|null} [verdict]  what the signature check said, null when this box could not check
   * @returns {Promise<Record<string, any>>}
   */
  async #run(intent, verdict = null) {
    /** @param {Record<string, unknown>} extra */
    const reply = (extra) => ({ v: PROTOCOL_VERSION, kind: 'reply', id: intent.id, ...extra });
    const actor = intent.actor ? `fleet:${intent.actor}` : 'fleet';

    try {
      // WHO THIS BOX TAKES ITS REBOOTS FROM (pinned-admins.js). Before the
      // command line: a reboot the pins refuse must not reach the hub, and
      // `pinadmin` never becomes a command line at all.
      if (intent.verb === 'pinadmin') return reply(await this.#pinAdmin(intent, verdict));
      if (isBoxWide(intent)) {
        const refused = await this.#boxWide(intent, verdict);
        if (refused) return reply(refused);
      }

      // Two verbs never reach the command registry, because they read host
      // state rather than acting on a session.
      if (intent.verb === 'health') return reply({ ok: true, text: 'ok', health: await this.health() });

      if (intent.verb === 'peek') {
        const name = String(intent.params.name);
        const text = await this.hub.peek(name, Number(intent.params.lines || 0) || null);
        if (text === null) return reply({ ok: false, text: `"${name}" is not running.` });
        // A PANE OF EMPTY ROWS IS NOT A PICTURE OF ANYTHING. capture-pane
        // returns every row of the visible region, so a session that has
        // printed nothing comes back as forty newlines rather than as the
        // empty string — and a phone drew that as a card the height of the
        // screen with nothing on it. See tidyPane for the whole story.
        //
        // rcUrl and remoteControl read the ORIGINAL text: they are answered by
        // matching, and nothing here should change what they match against.
        const pane = tidyPane(text);
        return reply({
          ok: true,
          text: pane || `${name} is running and has printed nothing yet.`,
          name,
          rcUrl: extractRcUrl(text),
          remoteControl: isRemoteControlOnline(text),
        });
      }

      // The exchange is this process's own: it needs the client secret, which
      // lives in this sidecar's memory and nowhere on the box, so it never
      // becomes a command line at all. The token it produces does — through
      // `/link`, the same way a pasted one would.
      if (intent.verb === 'exchange') return reply(await this.#exchange(intent));

      // A MINT NEVER BECOMES A COMMAND LINE EITHER, for the same reason: the
      // key it signs with is in this process and nowhere else on the box.
      if (intent.verb === 'mint') return reply(await this.#mint(intent));

      // SOMEBODY REMOVED FROM THE FLEET, named by the actor and nothing else,
      // as `unlink` is. The hub does the forgetting, because every store
      // involved is its own (src/core/forget-person.js); the reply says what
      // it did, which is the only thing that settles it at the coordinator.
      //
      // AND THEIR PIN AS AN ADMIN HERE, unless they are the last one who can
      // sign, who stays pinned so the box does not fall back to the
      // coordinator's word (pinned-admins.js, forgetPinned). A pin that could
      // not be changed fails the reply, so the coordinator asks again.
      //
      // SOMEBODY NOT PINNED HERE IS THE REPLY FROM BEFORE PINS, read without
      // the lock: on a box that pins nobody, which is every box until
      // somebody pins one, a lock that cannot be taken (a directory this
      // account cannot write, one left by a change that died) must not turn
      // a forgetperson into a failure the coordinator retries forever.
      // updatePins reads again under the lock before it writes.
      if (intent.verb === 'forgetperson') {
        const who = emailFromActor(intent.actor ? `fleet:${intent.actor}` : null);
        if (!who) return reply({ ok: false, text: 'forgetperson names its person as the actor, and this one names nobody.' });
        const forgot = await this.hub.forgetPerson(who);
        if (!this.xoStateDir) return reply(forgot);
        const now = readPins(this.xoStateDir);
        if (now.unreadable || !now.admins.includes(who)) return reply(forgot);
        const listed = this.intentKeys?.directory ?? null;
        try {
          const note = await updatePins(this.xoStateDir, (pins) => forgetPinned(pins, who, listed));
          return reply(note ? { ...forgot, text: [forgot.text, note].filter(Boolean).join(' ') } : forgot);
        } catch (e) {
          return reply({ ...forgot, ok: false, text: `${forgot.text ? `${forgot.text} ` : ''}Their pin as an admin here could not be changed: ${/** @type {Error} */ (e).message}` });
        }
      }

      // ADDING A HYPERVISOR IS THIS PROCESS'S TOO. The setup key is signed
      // with the key this process holds, the sealed sign-in is opened with a
      // key that lives only in its memory, and neither may become a command
      // line on the way to the hub. docs/hypervisors.md.
      if (intent.verb === 'xoprobe') {
        // Through the phone that asked, when it named its relay: one
        // attempt, over HTTPS. Fifteen seconds for the phone to connect
        // (xo-relay.js) and eight for the handshake, inside the
        // coordinator's twenty-five for a probe through a phone.
        const relay = intent.params.relay ? String(intent.params.relay) : null;
        const found = relay
          ? await probe(String(intent.params.address), { through: () => this.relays.open(relay), timeoutMs: 8_000 })
          : await probe(String(intent.params.address));
        const { text, ...xoprobe } = found;
        return reply({ ok: true, text, xoprobe });
      }
      if (intent.verb === 'xosetup') return reply(await this.#xosetup(intent));

      // AN ENGINE SIGN-IN NEVER BECOMES A COMMAND LINE EITHER: a command is
      // something every surface that types one can reach, and who may is
      // decided in this process, against the minter's list (#signInAs). The
      // hub is asked on a route of its own, with the account handle() worked
      // out and no parameter can name. Its answer is passed on whole: where
      // the sign-in stands, and for whoever asked the page and the code,
      // which this box signs (#signAnswer). Nothing of it is logged here.
      if (intent.verb === 'enginesignin') {
        const as = /** @type {any} */ (intent).signInAs;
        if (!as || typeof as.account !== 'string') {
          return reply({ ok: false, error: { code: 'member_unchecked' }, text: `${this.hostId} did not check who may sign this member’s engine in. Nothing was done.` });
        }
        // A `reply` NOTHING CAN BE SEALED TO is refused here, before the hub
        // is asked and so before any container: found afterwards, it would
        // leave an attempt out whose code nobody could be given. The
        // protocol checked its length and alphabet, which is all a pattern
        // can; whether it is a point on the curve is checked by using it.
        const sealTo = typeof intent.params.reply === 'string' ? intent.params.reply : null;
        if (sealTo && !(await canSealTo(sealTo))) {
          return reply({
            ok: false, error: { code: 'bad_params' },
            text: 'enginesignin.reply is not a key an answer can be sealed to. It is the public half of a P-256 key the asking phone makes for this one request, as for a vault request. Nothing was done.',
          });
        }
        return reply(await this.#signAnswer(intent, await this.hub.engineSignin({
          member: String(intent.params.member), account: as.account, engine: String(intent.params.engine), action: String(intent.params.action),
          by: String(as.by ?? ''), box: this.hostId, ...(sealTo ? { sealed: true } : {}),
        })));
      }

      // A MACHINE FROM A HYPERVISOR IS THIS PROCESS'S TOO: the pool's token
      // is in its memory and nowhere else (xo-pools.js), and the ticket the
      // machine boots with must not become a command line.
      // A LAB IS A VM in a lab of its own (xo-pools.js, make), never a runner.
      if (intent.verb === 'provision' && (intent.params?.platform === 'vm' || intent.params?.platform === 'lab')) return reply(await this.#makeVm(intent));
      if (intent.verb === 'vmctl') return reply(await this.#vmctl(intent));
      // WHAT A MACHINE IT MADE PRINTED AS IT BOOTED, kept in this process
      // (pve-console.js), for the machine that never joined. The hub has no
      // part in it, so it is answered here, past the same check a journal is.
      if (intent.verb === 'logs' && intent.params?.service === 'boot' && !intent.params?.name) {
        const pve = /** @type {any} */ (this.pools)?.pve;
        const p = intent.params;
        return reply(bootLogAnswer(pve?.consoles ?? new BootConsoles(), { machine: p.machine ? String(p.machine) : null, lines: p.lines ? Number(p.lines) : null }));
      }
      // A MACHINE THIS BOX MADE ASKING FOR ITS OWNER'S CLAUDE LOGIN, which is
      // in this process's memory from their vault and goes out sealed to the
      // machine's key (xo-pools.js, handLogin).
      if (intent.verb === 'vmlogin') return reply(await this.#vmLoginFor(intent));
      // A POOL'S PAGE FOR A PHONE AWAY FROM IT, under the token in this
      // process's memory (xo-pools.js, look and act).
      if (intent.verb === 'xolook' || intent.verb === 'xoact') return reply(await this.#poolPage(intent));

      // A session on a runner waits for the answer about its owner's Claude
      // login, which is bounded by the mint timeout and never throws.
      if ((intent.verb === 'start' || intent.verb === 'resume') && this.claudeLoginReady) await this.claudeLoginReady;

      // Everything else goes through the same command registry the web UI and
      // the CLI use, so a fleet command cannot behave differently from the same
      // command typed on the box — or exist when that one does not.
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
      // WHO ASKED, for a start as a member (#startAs): `actor` is by then the
      // member it runs as, and the record keeps both.
      // Not a field of an intent as it arrives: #startAs adds it to the one it hands on.
      const startedBy = /** @type {any} */ (intent).startedBy;
      if (intent.verb === 'start' && typeof startedBy === 'string') /** @type {any} */ (meta).startedBy = `fleet:${startedBy}`;
      // WHERE RUNNERS COME FROM AND WHICH FLEET THEY JOIN, added here because
      // neither is in the intent and they come from two different places.
      //
      // The repository is the coordinator's, off the config frame — one
      // operator decision for the whole fleet rather than a file on every box.
      // The coordinator ORIGIN is this host's own, from its transport: it is
      // what this box pinned at enrolment, so a runner is told to join the
      // fleet this machine is actually in rather than one the coordinator
      // names for itself.
      // WHAT THIS BOX IS ALREADY LABELLED, so fleetwright can tell a label it
      // stores from a fact the machine derives — and refuse a remove with the
      // reason rather than with "this box does not have that" about a label the
      // app is displaying. FLEETWRIGHT_LABELS is in this process's environment
      // and in no other, which is why it has to travel.
      if (intent.verb === 'labels') meta.hostLabels = this.givenLabels.join(',');
      // FROM THE FLEET, said on every line built from an intent, so the hub
      // holds a start to the operator's FLEETWRIGHT_SKIP_PERMISSIONS off even
      // where this process still holds the operator's token, which the hub
      // cannot tell from the operator's own console (commands.js
      // permissionCeiling). It only ever takes something away.
      meta.via = 'fleet';
      if (intent.verb === 'provision') {
        // THE PERSON'S OWN REPOSITORY WHEN THE COORDINATOR NAMED ONE, and the
        // fleet's off the config frame otherwise. Both came from the
        // coordinator — one per dispatch, one per connection — so neither is
        // something a caller typed; `repo` is overwritten there whatever a
        // caller sent, and shape-checked by the protocol before it got here.
        const own = typeof intent.params?.repo === 'string' && intent.params.repo ? intent.params.repo : '';
        const repo = own || this.config.get('runnerRepo');
        if (repo) meta.runnerRepo = repo;
        // Normalised to a bare origin. `FLEETWRIGHT_COORDINATOR_URL` is
        // whatever an operator typed — a trailing slash is ordinary — and this
        // becomes a workflow input that a runner puts in its own environment,
        // where `https://fleet.example/` and `https://fleet.example` are two
        // different strings to anything doing a comparison.
        try {
          const origin = this.transport?.origin ? new URL(this.transport.origin).origin : '';
          if (origin) meta.coordinator = origin;
        } catch { /* not a URL: the host refuses the dispatch and says so */ }
      }
      this.log.info(`sidecar: ${actor} → ${redactCommandLine(line)}`);
      const r = await this.hub.command(line, meta);

      // A `connect` reply carries this host's PKCE challenge per provider, so
      // the authorize URL the coordinator builds around it produces a code
      // only this host can spend. See #offerChallenges.
      if (intent.verb === 'connect' && Array.isArray(r?.connections?.catalogue)) {
        r.connections = { ...r.connections, catalogue: this.#offerChallenges(r.connections.catalogue, intent) };
      }

      // A CHECK IS A READ THAT CHANGES WHAT THIS BOX KNOWS. `updates` is not
      // mutating — it moves nothing on the machine — so it is deliberately not
      // in isMutating(), and that is why it never refreshed anything. But it is
      // the one verb whose entire job is finding out, and the answer it finds
      // is strictly fresher than the fifteen-minute cache the health frame
      // reports from.
      //
      // So the fresh answer BECOMES the cached one, and a frame goes out
      // carrying it. Without this, pressing Check told you an update was
      // waiting and left the row saying "up to date" with nothing to press —
      // the reply and the row disagreeing for up to fifteen minutes, which is
      // indistinguishable from the check not working.
      if (intent.verb === 'updates' && r.waiting) {
        try {
          this.adoptUpdates?.(r.waiting);
        } catch (e) {
          this.log.warn(`sidecar: could not adopt the update check: ${/** @type {Error} */ (e).message}`);
        }
        setImmediate(() => void this.#pushHealth());
      }

      const sessions = Array.isArray(r.sessions) ? await this.#enrich(r.sessions) : undefined;
      // A single-session reply gets the URL hoisted to the top level: §7 asks
      // for flat JSON and one round trip per action, because the consumer is a
      // Shortcut as often as it is an app.
      const single = sessions && sessions.length === 1 ? sessions[0] : null;
      // THE SIDECAR'S OWN HALF of "is this box up to date". The hub answers
      // for itself and for the disk; it cannot see that this process is
      // running an older release than both, and work that runs here (setups,
      // mints, the vault) runs that older code until it restarts.
      const behind = intent.verb === 'updates' ? this.#behind() : '';
      return reply({
        ok: r.ok !== false,
        text: behind ? `${r.text ?? ''}\n\n${behind}` : (r.text ?? ''),
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
        // `setuptoken`'s two halves: the sign-in page to open, and the token
        // it made, sealed to the asking phone's key. Ciphertext, so the
        // coordinator relays it without being able to read it.
        ...(typeof r.url === 'string' && r.url ? { url: r.url } : {}),
        ...(r.sealed && typeof r.sealed === 'object' ? { sealed: r.sealed } : {}),
        // WHAT IS WAITING, AS DATA, and it was computed and then thrown away
        // here. `/updates` returns `{ app, system }` — kind, pending, version —
        // precisely so a row can render a state instead of parsing a sentence,
        // and this reply forwarded only the sentence. So Check printed
        // "main-57 → main-63 (available)" into a text box, and the row beside
        // it went on rendering from a fifteen-minute-old cache that said
        // otherwise, with no Apply button because the button reads the row.
        ...(r.waiting ? { waiting: r.waiting } : {}),
        // WHAT A REBOOT WILL COST, as data. The app asks for a fingerprint when
        // nothing is running and for the box's pin when something is, and it
        // cannot know which without being told — reading it out of the prose
        // would break the first time the wording changed.
        ...(r.reboot ? { reboot: r.reboot } : {}),
        // A directory listing, as DATA. The rendered text is for a person; an
        // app needs the names, kinds and sizes separately or it is reduced to
        // parsing emoji out of a string.
        ...(Array.isArray(r.entries) ? { entries: r.entries } : {}),
        // The task profiles this box has, as data. Same reasoning as entries:
        // the rendered text is padded for a terminal, and a picker built by
        // parsing padding is a picker that breaks on a long name.
        ...(Array.isArray(r.profiles) ? { profiles: r.profiles } : {}),
        // The named secrets this box holds, as data and by name only — the same
        // reasoning as profiles, and the value is never among these fields.
        ...(Array.isArray(r.secrets) ? { secrets: r.secrets } : {}),
        // Which releases this box takes, as data — a picker rendered by parsing
        // the sentence above would break the first time the wording changed.
        ...(r.channel ? { channel: r.channel, channelPinned: Boolean(r.channelPinned) } : {}),
        // Which image new sessions run in, as data, for the same reason as the
        // channel beside it: a picker built by parsing the sentence breaks the
        // first time somebody improves the wording.
        ...(r.sandbox ? { sandbox: r.sandbox } : {}),
        // What a runner repository check found, as data — public, installed,
        // which platforms — so the app draws three answers rather than parsing
        // one sentence, and the coordinator saves the name GitHub spells.
        ...(r.runnerRepo ? { runnerRepo: r.runnerRepo } : {}),
        // Which connection was missing, when that is the whole refusal. Only
        // ever a provider name — the reply to a missing token has no token in
        // it to leak — and it is what lets the coordinator ask the next box.
        ...(typeof r.needsConnection === 'string' && /^[a-z]{1,20}$/.test(r.needsConnection)
          ? { needsConnection: r.needsConnection }
          : {}),
      });
    } catch (e) {
      if (e instanceof HubError) {
        // Kept distinct from a refusal on purpose: the coordinator should retry
        // an unreachable hub and must not retry a rejected command.
        this.log.error(`sidecar: ${intent.verb}: ${e.message}`);
        return reply({ ok: false, text: `fleetwright is not answering: ${e.message}`, error: { code: e.code } });
      }
      const err = /** @type {Error} */ (e);
      this.log.error(`sidecar: ${intent.verb} failed`, err);
      return reply({ ok: false, text: `${intent.verb} failed: ${err.message}`, error: { code: 'internal' } });
    } finally {
      // A CHANGE NOBODY IS TOLD ABOUT LOOKS LIKE A CHANGE THAT DID NOT HAPPEN.
      //
      // Health goes every fifteen seconds and the coordinator answers /api/hosts
      // from the last frame it received. So a mutating command succeeded, said
      // so, and the next refresh returned the OLD value — a channel picker
      // snapping back to stable, a session list without the session just
      // started. The app and the API both saw it, because both read the same
      // cache.
      //
      // A frame after a mutating verb closes that at the source rather than
      // asking every reader to guess. Not after a read: `list` and `health`
      // change nothing, and a frame per poll would be a busy loop.
      //
      // In `finally`, so a command that FAILED also refreshes — a refusal often
      // means the box is not what the caller thought, and that is exactly when
      // a stale cache is most misleading.
      //
      // And after the reply, never before it: this is a refresh, and nobody
      // should wait on it to be told what happened.
      if (isMutating(intent.verb)) setImmediate(() => void this.#pushHealth());
    }
  }

  /**
   * Mint a repository token for a runner, if this box may.
   *
   * The checks are in repo-tokens.js's header, in this order, and the order is
   * cheapest first: a box that holds no key says so without touching GitHub,
   * and a job token that does not verify costs no call to the hub.
   *
   * @param {import('../protocol/intents.js').Intent} intent
   * @returns {Promise<Record<string, unknown>>}
   */
  async #mint(intent) {
    const repo = String(intent.params.repo);
    const key = String(intent.params.key);
    /** @param {string} code @param {string} text */
    const refuse = (code, text) => {
      this.log.warn(`sidecar: did not mint a token for ${repo}: ${text}`);
      return { ok: false, text, error: { code } };
    };
    if (!this.minter) {
      // AS DATA, like needsConnection: the coordinator asks the next box when
      // this is the whole reason, rather than reading it out of the sentence.
      return {
        ok: false,
        text: 'This machine has no GitHub App key, so it cannot make repository tokens.',
        error: { code: 'not_a_minter' },
        needsMinter: true,
      };
    }
    if (!intent.actor) return refuse('no_actor', 'Nobody was named as the runner’s owner, so there is no one to mint for.');

    const audience = await bindingFor({ repo, key });
    let job;
    try {
      job = await verifyRunnerJob(String(intent.params.job), { audience });
    } catch (e) {
      return refuse('bad_job', `The runner’s job token did not verify: ${/** @type {Error} */ (e).message}.`);
    }
    const notRunner = runnerJobProblem(job);
    if (notRunner) return refuse('not_a_runner', notRunner);
    // The job's own repository, as the minting Worker asks (repo-tokens.js).
    const elsewhere = runnerJobRepoProblem(job, this.minter.owners, 'a repository token');
    if (elsewhere) return refuse('repo_not_allowed', elsewhere);
    if (!ownerAllowed(repo, this.minter.owners)) {
      return refuse(
        'owner_not_allowed',
        `This box mints repository tokens only for ${this.minter.owners.join(', ')}, and ${repo.split('/')[0]} is not one ` +
          'of them. The GitHub App is installable by anyone, so which accounts it mints into is decided here.',
      );
    }

    // THE PERSON'S HALF, asked of the hub, which holds their connection. The
    // answer is an account id and two booleans; the token stays where it is.
    const r = /** @type {any} */ (await this.hub.command(toCommandLine(intent), commandMeta('mint', {}, `fleet:${intent.actor}`)));
    if (r?.needsConnection === 'github') {
      return { ok: false, text: r.text || 'GitHub is not connected for you on this box.', error: { code: 'not_connected' }, needsConnection: 'github' };
    }
    const access = r?.githubAccess;
    if (r?.ok === false || !access) return refuse('no_access', String(r?.text || 'Your GitHub connection could not be checked.'));
    // THE BINDING BETWEEN THE RUNNER AND THE PERSON, decided by GitHub twice
    // rather than by the coordinator once: the job token says which account
    // started the run, and the connection says whose it is.
    if (String(access.userId) !== job.actorId) {
      return refuse(
        'not_the_asker',
        `That runner was started by ${job.actor || 'another GitHub account'}, and the GitHub connection here is ${access.login}. ` +
          'A token is minted only for the account that started the runner.',
      );
    }
    if (!access.pull) return refuse('no_access', `${access.login} cannot read ${access.repo}, so neither can a runner.`);

    const minted = await mintRepoToken({
      repo: String(access.repo),
      permissions: permissionsFor(access),
      clientId: this.minter.clientId,
      key: this.minter.key,
      fetchImpl: this.fetchImpl,
    });
    if (!minted.ok) return refuse('mint_failed', minted.message);
    const sealed = await seal({
      to: key,
      aad: audience,
      payload: { token: minted.token, expiresAt: minted.expiresAt, repo: access.repo, permissions: minted.permissions },
    });
    const perms = Object.entries(minted.permissions).map(([k, v]) => `${k}:${v}`).join(', ');
    // By name and scope, never the value — the same rule as the broker's log.
    this.log.info(`sidecar: minted a token for ${access.repo} (${perms}) for ${intent.actor}’s runner`);
    return {
      ok: true,
      text: `A token for ${access.repo} (${perms}), good for an hour, sealed to the runner that asked.`,
      sealed,
      repo: access.repo,
      expiresAt: minted.expiresAt,
      permissions: minted.permissions,
    };
  }

  /**
   * Git credentials for one repository, on a runner.
   *
   * Called by the runner's broker socket (./runner-broker.js) when a session's
   * git asks. Makes a key for this one request, asks GitHub for a job token
   * whose audience binds that key to the repository, sends both up as a `mint`
   * frame, and opens what comes back. Never throws: git treats silence as
   * "no credential here", which is what every refusal below becomes.
   *
   * @param {{ provider?: unknown, repo?: unknown }} ask
   * @returns {Promise<{ ok: true, provider: string, env: Record<string, string>, expiresAt: number, repo: string }
   *   | { ok: false, error: string, message: string }>}
   */
  async repoCredential({ provider, repo }) {
    if (provider !== 'github') {
      return { ok: false, error: 'unknown_provider', message: `A runner can be given GitHub credentials and nothing else, not "${String(provider).slice(0, 40)}".` };
    }
    const name = String(repo || '');
    if (!REPO_RE.test(name)) {
      // git sends the path only when credential.useHttpPath is on, which the
      // runner workflow sets. Without it there is no repository to scope to,
      // and a token for "whatever" is the one thing this will not mint.
      return { ok: false, error: 'no_repo', message: 'git did not say which repository it wants, and a runner is only given a token for one.' };
    }
    if (!this.jobToken) {
      return { ok: false, error: 'not_a_runner', message: 'This box is not a GitHub Actions runner, so it has no job token to ask with.' };
    }
    const k = name.toLowerCase();
    const held = this.repoTokens.get(k);
    if (held && held.expiresAt - Date.now() > 5 * 60_000) {
      return { ok: true, provider: 'github', env: { GH_TOKEN: held.token }, expiresAt: held.expiresAt, repo: held.repo };
    }
    const inFlight = this.repoAsks.get(k);
    if (inFlight) return inFlight;
    const ask = this.#askForRepoToken(name).finally(() => this.repoAsks.delete(k));
    this.repoAsks.set(k, ask);
    return ask;
  }

  /** @param {string} repo */
  async #askForRepoToken(repo) {
    /** @param {string} error @param {string} message */
    const no = (error, message) => {
      this.log.warn(`sidecar: no token for ${repo}: ${message}`);
      return /** @type {const} */ ({ ok: false, error, message });
    };
    const { privateKey, publicKey } = await newSealKey();
    const audience = await bindingFor({ repo, key: publicKey });
    let job;
    try {
      job = await /** @type {(a: string) => Promise<string>} */ (this.jobToken)(audience);
    } catch (e) {
      return no('no_job_token', `GitHub would not give this job a token to ask with: ${/** @type {Error} */ (e).message}`);
    }
    const id = `mint-${crypto.randomUUID()}`;
    /** @type {any} */
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.mintWaiters.delete(id);
        resolve(null);
      }, this.mintTimeoutMs);
      timer.unref?.();
      this.mintWaiters.set(id, { resolve, timer });
      Promise.resolve()
        .then(() => this.transport.send({ v: PROTOCOL_VERSION, kind: 'mint', id, hostId: this.hostId, repo, job, key: publicKey }))
        .catch((e) => {
          this.mintWaiters.delete(id);
          clearTimeout(timer);
          resolve({ ok: false, text: `could not reach the fleet: ${/** @type {Error} */ (e).message}` });
        });
    });
    if (!answer) return no('timeout', 'The fleet did not answer in time. A coordinator from before repository tokens drops the question.');
    if (answer.ok !== true) return no(String(answer.error?.code || 'refused'), String(answer.text || 'The fleet refused.'));
    let payload;
    try {
      payload = await open({ privateKey, publicKey, aad: audience, sealed: answer.sealed });
    } catch {
      // Something between here and the box that minted it changed the bytes,
      // the repository or the key. Whatever it is, it is not a token to use.
      return no('unsealed', 'The answer did not open with this request’s key, so it was not used.');
    }
    const token = typeof payload?.token === 'string' ? payload.token : '';
    const expiresAt = Number(payload?.expiresAt);
    const got = String(payload?.repo || '');
    if (!token || !Number.isFinite(expiresAt) || got.toLowerCase() !== repo.toLowerCase()) {
      return no('unsealed', `The token that came back is not for ${repo}, so it was not used.`);
    }
    this.repoTokens.set(repo.toLowerCase(), { token, expiresAt, repo: got });
    this.log.info(`sidecar: holding a token for ${got} until ${new Date(expiresAt).toISOString()}`);
    return /** @type {const} */ ({ ok: true, provider: 'github', env: { GH_TOKEN: token }, expiresAt, repo: got });
  }

  /**
   * On a runner: ask for the owner's Claude login and tell the hub the
   * answer, which is either the login or "none, use the API key".
   *
   * The ask is #askForRepoToken's without a repository: a one-request key, a
   * job token whose audience binds it (seal.js, claudeBindingFor), and a
   * `claude-login` frame. The minting Worker decides from GitHub's job token
   * whose login this runner gets, and it can only ever be the account that
   * started it (src/fleet/minter/claude.js). What comes back is sealed to the
   * key, which dies with this call.
   */
  async #takeClaudeLogin() {
    const said = await this.#askForClaudeLogin();
    const given = said.ok
      ? { email: said.owner, login: said.login, token: said.token }
      : { email: said.owner ?? null, login: null, token: null };
    try {
      const r = await this.hub.runnerLogin(given);
      if (!r.ok) this.log.warn(`sidecar: the hub did not take this runner's Claude login: ${r.text}`);
    } catch (e) {
      this.log.warn(`sidecar: could not tell the hub about this runner's Claude login: ${/** @type {Error} */ (e).message}`);
    }
    if (said.ok && said.signIn) await this.#holdSignIn(said, said.signIn);
    // SAID EITHER WAY, in the runner's log, because the person paying is
    // decided here and "why did this bill to the API key" deserves an answer.
    if (said.ok) this.log.info(`sidecar: sessions ${said.owner} starts here run on ${said.login}'s Claude login`);
    else this.log.info(`sidecar: no Claude login for this runner's owner, so sessions use ANTHROPIC_API_KEY: ${said.text}`);
  }

  /**
   * A runner's owner's sign-in, kept as a box keeps one from the vault: the
   * credentials file every session of theirs here is staged with, which
   * Claude Code reads again when its token is refused, and which the hub
   * rewrites in every running session when it changes (vault-sessions.js).
   * A token in a session's environment, as the runner was given before,
   * cannot be changed once the session starts, so the renewal that revokes it
   * stopped every session on the runner.
   *
   * THEN ASKED AGAIN at the minute the vault renews it, as boxes ask
   * (askAgainIn), and a renewed one replaces it. An ask that fails keeps what
   * is held: a runner keeps working on the token it has until that runs out.
   *
   * @param {{ owner: string, login: string, token: string }} said
   * @param {{ expiresAt: number, scopes?: unknown, subscriptionType?: unknown, rateLimitTier?: unknown, account?: unknown }} signIn
   */
  async #holdSignIn(said, signIn) {
    const item = {
      name: 'claude',
      value: said.token,
      expiresAt: signIn.expiresAt,
      login: { scopes: signIn.scopes, subscriptionType: signIn.subscriptionType, rateLimitTier: signIn.rateLimitTier },
      account: signIn.account && typeof signIn.account === 'object' ? signIn.account : {},
    };
    const r = await this.hub.vault({ accounts: [{ email: said.owner, login: said.login, items: [item], problems: [] }] })
      .catch((e) => ({ ok: false, text: /** @type {Error} */ (e).message }));
    if (!r.ok) this.log.warn(`sidecar: the hub did not take ${said.owner}'s sign-in for this runner's sessions: ${r.text}`);
    if (this.claudeLoginTimer) clearTimeout(this.claudeLoginTimer);
    this.claudeLoginTimer = setTimeout(() => void this.#askAgainForSignIn(), askAgainIn(signIn.expiresAt, this.#askInterval()));
    this.claudeLoginTimer.unref?.();
  }

  /** The vault's interval, which a runner keeps for its own asks; ten minutes where it is switched off. */
  #askInterval() {
    return this.vaultIntervalMs > 0 ? this.vaultIntervalMs : 10 * 60_000;
  }

  async #askAgainForSignIn() {
    this.claudeLoginTimer = null;
    const said = await this.#askForClaudeLogin();
    if (said.ok && said.signIn) {
      await this.hub.runnerLogin({ email: said.owner, login: said.login, token: said.token }).catch(() => {});
      await this.#holdSignIn(said, said.signIn);
      return;
    }
    this.log.warn(`sidecar: asking again for this runner's owner's Claude sign-in did not work, so it keeps the one it has: ${said.ok ? 'the answer carried no sign-in' : said.text}`);
    this.claudeLoginTimer = setTimeout(() => void this.#askAgainForSignIn(), Math.min(60_000, this.#askInterval()));
    this.claudeLoginTimer.unref?.();
  }

  /**
   * On a machine from somebody's hypervisor: tell the hub whose machine this
   * is and the Claude login it runs on. The hub may still be starting, so
   * this tries for two minutes; once it has the answer the file is forgotten
   * (vm-join.js). Never rejects.
   *
   * THE LOGIN IS ASKED FOR, now that the machine has enrolled: the same
   * `claude-login` frame a runner sends, without a job token, which the
   * coordinator relays to the box that made this machine (`vmlogin`). It
   * comes back sealed to a key made for the one ask. A file from a box older
   * than that still carries the login, which is used as it was given.
   */
  async #handVmLogin() {
    const given = /** @type {{ email: string, token: string|null }} */ (this.vmLogin);
    let token = given.token;
    /** @type {string|null} */
    let why = null;
    if (!token) {
      const said = await this.#askForClaudeLogin();
      if (said.ok) token = said.token;
      else why = said.text;
    }
    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        const r = await this.hub.runnerLogin({ email: given.email, login: null, token });
        if (r.ok) {
          this.vmLogin = null;
          try {
            this.onVmLoginHanded?.();
          } catch { /* the file is gone or going; nothing reads it again */ }
          this.log.info(token
            ? `sidecar: sessions ${given.email} starts on this machine run on their Claude login`
            : `sidecar: this machine has no Claude login for ${given.email}, so sessions here have nothing to run on: ${why ?? 'none came with it'}`);
          return;
        }
        this.log.warn(`sidecar: the hub did not take this machine's Claude login: ${r.text}`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
    this.log.warn('sidecar: the hub never answered, so this machine has no Claude login for its sessions');
  }

  /**
   * Make a machine on one of this box's people's pools, for the person
   * asking. The coordinator chose this box because its health said it holds
   * that person's pool with that image; xo-pools.js checks the same again.
   *
   * @param {import('../protocol/intents.js').Intent} intent
   */
  async #makeVm(intent) {
    if (!this.pools) return { ok: false, text: 'This box asks no vault, so it holds no hypervisor to make a machine on.' };
    const owner = intent.actor ? String(intent.actor).toLowerCase() : '';
    if (!owner) return { ok: false, text: 'A machine is made for a signed-in person.' };
    const origin = this.transport?.origin ? new URL(this.transport.origin).origin : '';
    const ask = {
      owner,
      template: String(intent.params.template || ''),
      ticket: String(intent.params.ticket || ''),
      minutes: intent.params.minutes == null ? null : Number(intent.params.minutes),
      network: intent.params.network ? String(intent.params.network) : null,
      group: intent.params.group ? String(intent.params.group) : null,
      lab: intent.params.platform === 'lab',
      coordinatorUrl: origin,
    };
    let r = await this.pools.make(ask);
    // NOT SEEN YET is not "not there": a box that restarted has its tokens
    // back from the vault before it has looked at the pools. Look, then ask
    // once more.
    if (!r.ok && !r.unreachable && /holds no pool/.test(r.text)) {
      await this.pools.refresh();
      r = await this.pools.make(ask);
    }
    if (r.ok) setImmediate(() => void this.#pushHealth());
    return r;
  }

  /**
   * A machine this box made asks for its owner's Claude login (`vmlogin`,
   * relayed by the coordinator): handed sealed to its key, by xo-pools.js,
   * only if this box made it for the actor. `notHere` from a box that holds
   * no pools, so the coordinator asks the next.
   *
   * @param {import('../protocol/intents.js').Intent} intent
   */
  async #vmLoginFor(intent) {
    if (!this.pools) return { ok: false, notHere: true, text: 'This box asks no vault, so it made no machine.' };
    const owner = intent.actor ? String(intent.actor).toLowerCase() : '';
    if (!owner) return { ok: false, text: 'A machine’s login is its owner’s, and this ask names nobody.' };
    return this.pools.handLogin({ owner, name: String(intent.params.name || ''), key: String(intent.params.key || '') });
  }

  /**
   * Work a machine on one of the asker's pools: restart, longer, a new size,
   * or end it now (xo-pools.js, `control`). The coordinator checked the
   * machine is theirs; the pool is asked under their token, and only a
   * machine tagged as made for them is touched.
   *
   * @param {import('../protocol/intents.js').Intent} intent
   */
  async #vmctl(intent) {
    if (!this.pools) return { ok: false, notHere: true, text: 'This box asks no vault, so it holds no hypervisor.' };
    const owner = intent.actor ? String(intent.actor).toLowerCase() : '';
    if (!owner) return { ok: false, text: 'A machine is worked by the person it belongs to.' };
    const p = intent.params || {};
    const r = await this.pools.control({
      owner,
      name: String(p.name || ''),
      action: /** @type {any} */ (String(p.action || '')),
      minutes: p.minutes == null ? null : Number(p.minutes),
      cpus: p.cpus == null ? null : Number(p.cpus),
      memory: p.memory == null ? null : Number(p.memory),
    });
    if (r.ok) setImmediate(() => void this.#pushHealth());
    return r;
  }

  /**
   * A pool's page read or worked here for its owner's phone, which cannot
   * reach the pool from where it is (docs/manage.md, "From away"). The
   * coordinator chose this box because it reported holding their token for
   * that address; the pools check that again, and the answer to a look is
   * sealed to the phone, so it passes the coordinator as ciphertext.
   *
   * @param {import('../protocol/intents.js').Intent} intent
   */
  async #poolPage(intent) {
    if (!this.pools) return { ok: false, notHere: true, text: 'This box asks no vault, so it holds no hypervisor.' };
    const owner = intent.actor ? String(intent.actor).toLowerCase() : '';
    if (!owner) return { ok: false, text: 'A pool\u2019s page is read by the person whose pool it is.' };
    const p = intent.params || {};
    const address = String(p.address || '');
    if (intent.verb === 'xolook') return this.pools.look({ owner, address, reply: String(p.reply || '') });
    return this.pools.act({ owner, address, method: String(p.method || ''), args: p.args });
  }

  /** @param {number} ms */
  #scheduleVault(ms) {
    if (this.vaultTimer) clearTimeout(this.vaultTimer);
    this.vaultTimer = setTimeout(() => {
      this.vaultAsking = true;
      void this.syncVault().then((next) => {
        this.vaultAsking = false;
        // A CHANGE SAID WHILE IT WAS ASKING may have reached the vault after
        // this answer was made, so it is asked once more, soon.
        this.#scheduleVault(this.vaultAgain ? VAULT_CHANGED_ASK_MS : next);
        this.vaultAgain = false;
      });
    }, ms);
    this.vaultTimer.unref?.();
  }

  /**
   * Ask the vault in a moment, because the coordinator said somebody's vault
   * changed. A moment and not at once, so a person keeping three things is
   * one ask; and only on a box that asks the vault at all, which a runner
   * does not (it takes its owner's login on its own clock).
   */
  #vaultChangedSoon() {
    if (!this.vaultKey || this.vaultIntervalMs <= 0 || this.jobToken) return;
    if (this.vaultAsking) {
      this.vaultAgain = true;
      return;
    }
    this.#scheduleVault(VAULT_CHANGED_ASK_MS);
  }

  /**
   * Ask the fleet's vault for what this box's people approved it to hold, and
   * hand the answer to fleetwright, which keeps it where the broker and a
   * session's Claude login already look (src/core/vault-store.js).
   *
   * EVERY TEN MINUTES, and sooner when a token it holds is about to run out:
   * the vault renews tokens, this only asks for the current one, so a box
   * never holds a refresh token and never renews one. An answer that is an
   * answer (nobody approved this box, or this is not the key it enrolled
   * with) clears what was held, which is how removing a box from a phone
   * reaches it. Silence keeps what was held until it runs out, and so does
   * every other refusal (#askVault): a vault that could not read the
   * question has not said this box is approved for nothing.
   *
   * @returns {Promise<number>} how long until the next ask
   */
  async syncVault() {
    // THE KEY LIST rides the vault's clock: the same ten minutes, the same
    // socket, and the minter answers both.
    void this.intentKeys?.refresh();
    const said = await this.#askVault();
    // WHY THE LAST ANSWER COULD NOT BE CHECKED, kept for whoever is refused a
    // sign-in for want of an approval this box cannot now hear (#signInAs).
    this.vaultUnchecked = said.ok ? null : (said.unchecked ?? null);
    if (said.ok) {
      this.approvedFor = approvalsIn(said.accounts);
      // POOLS OUT, before the hub sees the answer: kept in this process and
      // written nowhere (xo-pools.js). Then looked at, and the health frame
      // that says what they have goes out when that is done.
      const accounts = this.pools ? this.pools.adopt(said.accounts) : said.accounts;
      if (this.pools && this.#holdsAny()) void this.pools.refresh().then(() => this.#pushHealth()).catch(() => {});
      const r = await this.hub.vault({ accounts }).catch((e) => ({ ok: false, text: /** @type {Error} */ (e).message }));
      if (r.ok) this.log.info(`sidecar: vault: ${r.text}`);
      else this.log.warn(`sidecar: fleetwright did not take the vault's answer: ${r.text}`);
      for (const a of said.accounts) for (const p of a.problems || []) this.log.warn(`sidecar: vault, ${a.email}: ${p}`);
      // SOONER WHEN SOMETHING RUNS OUT, and AT THE MOMENT IT IS RENEWED.
      // Renewing a Claude sign-in revokes the access token every holder has:
      // the minter renews on the first ask inside its window, and each other
      // box went on sending the old token until its own ten minutes came
      // round, which a session there met as "OAuth access token has been
      // revoked · Please run /login" (askAgainIn, docs/vault.md).
      const soonest = Math.min(...said.accounts.flatMap((a) => (a.items || []).map((i) => (i.expiresAt === null ? Infinity : Number(i.expiresAt)))));
      return askAgainIn(soonest, this.vaultIntervalMs);
    }
    if (said.forget) {
      this.approvedFor = approvalsIn([]);
      this.pools?.adopt([]);
      await this.hub.vault({ accounts: [] }).catch(() => {});
    }
    // AN ANSWER THIS BOX COULD NOT CHECK is somebody's to fix, and is said as
    // a warning; every other refusal is said as it always was.
    if (this.vaultUnchecked) this.log.warn(`sidecar: vault: ${said.text}`);
    else this.log.info(`sidecar: vault: ${said.text}`);
    return this.vaultIntervalMs;
  }

  /**
   * The pin a pool's own machine joins with, for the policy job `job` this
   * box is running. The coordinator gives one only to the box running that
   * job, bound to a name it chose (core.js, #onHolderPin). Never rejects:
   * no answer is null.
   *
   * @param {string} job @param {string} address
   * @returns {Promise<{ ok: boolean, pin?: string, hostId?: string, text?: string }|null>}
   */
  async #askHolderPin(job, address) {
    // The Xen Orchestra it will hold, so the coordinator keeps its name for
    // that pool while it asks to join (core.js, #onHolderPin).
    return this.#askForJob('holder-pin', job, { address });
  }

  /**
   * Something the coordinator gives only the box running policy job `job`:
   * a holder pin, or the token a machine image's build VM reports with
   * (core.js, #onHolderPin and #onImageReporter). Answered by a `minted`
   * frame. Never rejects: no answer is null.
   *
   * @param {'holder-pin'|'image-reporter'} kind
   * @param {string} job
   * @param {Record<string, string>} [extra]
   * @returns {Promise<any>}
   */
  async #askForJob(kind, job, extra = {}) {
    const id = `${kind}-${crypto.randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.mintWaiters.delete(id);
        resolve(null);
      }, this.mintTimeoutMs);
      timer.unref?.();
      this.mintWaiters.set(id, { resolve, timer });
      let sent;
      try {
        sent = this.transport.send({ v: PROTOCOL_VERSION, kind, id, hostId: this.hostId, job, ...extra });
      } catch {
        sent = false;
      }
      if (sent === false) {
        this.mintWaiters.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, text: 'this box was not connected to the fleet when it asked' });
      }
    });
  }

  /**
   * The box's request for the fleet's device keys, sent and answered as a
   * vault request is: what came back, or null when nothing did.
   *
   * @param {any} request @param {string} signature
   */
  async #askKeys(request, signature) {
    const id = `keys-${crypto.randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.mintWaiters.delete(id);
        resolve(null);
      }, this.mintTimeoutMs);
      timer.unref?.();
      this.mintWaiters.set(id, { resolve, timer });
      let sent;
      try {
        sent = this.transport.send({ v: PROTOCOL_VERSION, kind: 'keys', id, hostId: this.hostId, request, signature });
      } catch {
        sent = false;
      }
      if (sent === false) {
        this.mintWaiters.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, text: 'this box was not connected to the fleet when it asked' });
      }
    });
  }

  /**
   * Ask the coordinator whether a still, unreadable pane is a person being
   * asked something (docs/decide.md). `state` is already masked; the
   * watcher is the only caller. Ten seconds and then nothing: an unanswered
   * ask is `null`, which the watcher reads as cannot tell, so a coordinator
   * that predates this frame, or has it off, changes nothing here.
   *
   * THE FINGERPRINT STAYS HERE. It is of the unmasked pane, and the only text
   * that leaves the box is the masked state (docs/decide.md).
   *
   * @param {{ name: string, state: string }} ask
   * @returns {Promise<any>}
   */
  async #askDecide({ name, state }) {
    const id = `decide-${crypto.randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.mintWaiters.delete(id);
        resolve(null);
      }, DECIDE_ANSWER_MS);
      timer.unref?.();
      this.mintWaiters.set(id, { resolve, timer });
      let sent;
      try {
        sent = this.transport.send({ v: PROTOCOL_VERSION, kind: 'decide', hostId: this.hostId, id, name, state });
      } catch {
        sent = false;
      }
      if (sent === false) {
        this.mintWaiters.delete(id);
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  /**
   * Whether this box holds anything a machine can be made from. The seam
   * (pools.js) counts a sandbox provider's key; a bare hypervisor driver,
   * which a test may hand in, counts its own.
   */
  #holdsAny() {
    const p = /** @type {any} */ (this.pools);
    return Boolean(p && (typeof p.holdsAny === 'boolean' ? p.holdsAny : p.held?.size));
  }

  /**
   * Whose vaults the vault last said this box is approved to hold: agent
   * members by id and people by address, as its answer names them
   * (minter/vault.js, itemsFor). An engine is signed in here only for one of
   * them (#signInAs).
   *
   * NULL UNTIL THE VAULT HAS ANSWERED, which is cannot tell and never
   * nobody: a box that has not been answered is not a box approved for
   * nothing. An answer that names nobody is nobody, and so is the one
   * refusal that forgets what was held. Silence, and every other refusal,
   * keep what was last heard, as they keep what is held (syncVault).
   *
   * @type {{ members: Set<string>, people: Set<string> }|null}
   */
  approvedFor = null;

  /**
   * Why this box took nothing from the vault's last answer, when the reason
   * was that it could not tell the answer was the vault's
   * (#vaultAnswerUnchecked), else null.
   *
   * @type {{ why: string, todo: string }|null}
   */
  vaultUnchecked = null;

  /** The API providers this box's hub last said it may bill to. @type {string[]} */
  apiProviders = [];
  /** Whether the last vault request asked for API keys, or null before any and once a change has been acted on. @type {boolean|null} */
  askedForKeys = null;

  /** The engines beside Claude Code this box's hub last said it runs, in the order they are signed in. @type {string[]} */
  engines = [];
  /** The engines the last vault request named, as one string, or null before any and once a change has been acted on. @type {string|null} */
  askedForEngines = null;

  /**
   * Keep what the hub says it runs beside Claude Code (engine-box.js,
   * boxEngines), held to the engines there are. Asked again in a moment when
   * it has changed since the vault was last asked, for the reason API
   * providers are: a box that asked before its hub had answered asked for no
   * engine's sign-in, and would hold none for ten minutes.
   *
   * @param {unknown} said @returns {string[]}
   */
  #noteEngines(said) {
    this.engines = Array.isArray(said)
      ? [...new Set(said.filter((/** @type {unknown} */ e) => typeof e === 'string' && e !== DEFAULT_ENGINE && ENGINE_IDS.includes(e)))].sort()
      : [];
    if (this.askedForEngines !== null && this.askedForEngines !== this.engines.join(',')) {
      this.askedForEngines = null;
      this.#vaultChangedSoon();
    }
    return this.engines;
  }

  /** Keep what the hub says of its API providers, held to short strings. @param {unknown} said @returns {string[]} */
  #noteApiProviders(said) {
    this.apiProviders = Array.isArray(said) ? said.filter((/** @type {unknown} */ p) => typeof p === 'string' && /^[a-z0-9-]{1,40}$/.test(p)).slice(0, 8) : [];
    // WHAT THIS BOX ACCEPTS HAS CHANGED SINCE IT LAST ASKED THE VAULT. A box
    // that asked before its hub had answered asked for no keys, and the
    // answer it then filed held none, so the keys it had kept were dropped
    // until the next ask ten minutes on. Asked again in a moment instead.
    if (this.askedForKeys !== null && this.askedForKeys !== this.apiProviders.length > 0) {
      this.askedForKeys = null;
      this.#vaultChangedSoon();
    }
    return this.apiProviders;
  }

  /**
   * @returns {Promise<{ ok: true, accounts: Array<{ email: string, items: Array<{ name: string, expiresAt: number|null }>, problems?: string[] }> }
   *   | { ok: false, forget: boolean, text: string, unchecked?: { why: string, todo: string } }>}
   *   `unchecked`, when the refusal is that this box could not tell the answer was the vault's (#vaultAnswerUnchecked)
   */
  async #askVault() {
    const key = /** @type {NonNullable<typeof this.vaultKey>} */ (this.vaultKey);
    const { privateKey, publicKey } = await newSealKey();
    // `accepts`, signed with the rest: this box files a member's vault under
    // an account of its own (vault-store.js, applyVault), so the minter may
    // hand it one. A box from before members sends none and is handed none.
    // And `engines`: the sign-ins an engine runs on, which this box hands a
    // session's runner over its socket (docs/engines.md). ONLY WHEN IT RUNS
    // ONE, and with which beside it (`codex`, `opencode`): the vault hands a
    // Codex sign-in to one machine, the first that asks, and every box used
    // to say `engines` whatever it ran, so the sign-in went to whichever
    // asked first, a box with no Codex on it included, and the machine that
    // could run it was refused. A vault from before the names reads `engines`
    // as it always did. IN ALPHABETICAL
    // ORDER, because the minter checks the signature over the list sorted.
    // And `apikeys`, only while this box's operator has an API provider
    // turned on: a box that bills nobody is handed no key (docs/api-engines.md).
    // And `sandboxes`, only while it has a sandbox provider turned on: the
    // record is a provider's whole account, held here in memory and nowhere else.
    this.askedForKeys = this.apiProviders.length > 0;
    this.askedForEngines = this.engines.join(',');
    const accepts = [
      ...(this.apiProviders.length ? ['apikeys'] : []), ...(this.engines.length ? ['engines', ...this.engines] : []), 'members',
      ...(/** @type {any} */ (this.pools)?.sandbox?.takes ? ['sandboxes'] : []),
    ].sort();
    const request = { v: 1, hostKey: { kty: 'EC', crv: 'P-256', x: key.publicJwk.x, y: key.publicJwk.y }, at: Date.now(), reply: publicKey, accepts };
    let signature;
    try {
      signature = await key.sign(signingInput('vault-box', request));
    } catch (e) {
      return { ok: false, forget: false, text: `this box could not sign its request: ${/** @type {Error} */ (e).message}` };
    }
    const id = `vault-${crypto.randomUUID()}`;
    /** @type {any} */
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.mintWaiters.delete(id);
        resolve(null);
      }, this.mintTimeoutMs);
      timer.unref?.();
      this.mintWaiters.set(id, { resolve, timer });
      let sent;
      try {
        sent = this.transport.send({ v: PROTOCOL_VERSION, kind: 'vault', id, hostId: this.hostId, request, signature });
      } catch {
        sent = false;
      }
      if (sent === false) {
        this.mintWaiters.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: { code: 'not_connected' }, text: 'this box was not connected to the fleet when it asked' });
      }
    });
    if (!answer) return { ok: false, forget: false, text: 'the fleet did not answer; a coordinator from before the vault drops the question' };
    if (answer.ok !== true) {
      // ONE REFUSAL FORGETS WHAT WAS HELD: the one that says this is not the
      // key this box enrolled with. Beside it only an answer the vault
      // itself sealed does (above, an answer naming nobody). Everything else
      // is cannot tell, and keeps what is held until it runs out.
      //
      // `bad_signature` used to forget, as did a fleet saying it has no
      // vault. A vault from before `accepts` checks the signature without
      // it, so it answered every request from a box that signs one with
      // `bad_signature`, and such a box, upgraded first, dropped every
      // credential it held within ten minutes and never got them back. A
      // vault that could not read the question has not answered it.
      const code = String(answer.error?.code || '');
      const said = String(answer.text || 'the fleet refused');
      if (code === 'not_this_box') return { ok: false, forget: true, text: said };
      const why = code === 'bad_signature'
        ? `the vault could not check this box’s request (${said}), which is what a vault older than this box answers`
        : `the vault did not answer for this box (${said})`;
      return { ok: false, forget: false, text: `${why}. Nothing this box holds was forgotten, and it asks again in ${Math.round(this.vaultIntervalMs / 60_000)} minutes.` };
    }
    // THE VAULT'S OWN ANSWER, OR NOTHING IS TAKEN FROM IT (#vaultAnswerUnchecked).
    // Before it is opened, and so before anything below reads a word of it.
    const unchecked = await this.#vaultAnswerUnchecked(request, answer.sealed);
    if (unchecked) return { ok: false, forget: false, unchecked, text: `${unchecked.why}. ${unchecked.todo} Nothing this box holds was changed, and it asks again in ${Math.round(this.vaultIntervalMs / 60_000)} minutes.` };
    try {
      const inside = /** @type {any} */ (await open({ privateKey, publicKey, aad: VAULT_BOX_AAD, sealed: answer.sealed }));
      return { ok: true, accounts: Array.isArray(inside?.accounts) ? inside.accounts : [] };
    } catch {
      return { ok: false, forget: false, text: 'the answer did not open with this request’s key, so it was not used' };
    }
  }

  /**
   * Why an answer to this box's vault request is not the vault's own, as far
   * as this box can tell, or null when it is.
   *
   * SEALED WAS NEVER ENOUGH. This box's request is signed and not sealed, so
   * the key its answer is sealed to goes through the coordinator in the
   * clear, and anybody can seal to a public key. A second outside review
   * answered a box in the vault's place: the box set itself approved for a
   * member's vault nobody had approved it for, and handed its hub a Codex
   * sign-in for a member that no custodian had kept. So the answer carries
   * the minter's signature, inside `sealed` beside its three strings, by the
   * key this box pins from the fleet's own address for the key list
   * (intent-keys.js), over this box, this request and this sealed part
   * (protocol/vault-answer.js), and it is checked HERE, before the answer is
   * opened: nothing is set approved, handed to the hub, or forgotten on an
   * answer that does not pass.
   *
   * EVERY WAY OF NOT PASSING IS CANNOT TELL, and keeps what is held, as
   * silence does (syncVault): a coordinator that could make a box forget by
   * sending it an answer it cannot check would be given the one thing this
   * check takes from it. The reason is said in words that say what to do,
   * because two of the three are somebody's to fix: a minter older than
   * this box, which signs nothing, and a minter given a new signing key.
   *
   * @param {{ hostKey: { kty: string, crv: string, x: string, y: string }, at: number, reply: string }} request  what this box signed and sent
   * @param {any} sealed  what came back as the sealed part
   * @returns {Promise<{ why: string, todo: string }|null>}
   */
  async #vaultAnswerUnchecked(request, sealed) {
    const signature = typeof sealed?.signature === 'string' ? sealed.signature : '';
    if (!signature) {
      return {
        why: 'the vault’s answer is not signed, which is what a minter older than this box sends, and one whose signing key does not load',
        todo: 'Whoever runs the fleet deploys its minting Worker again, and this box takes its vault at its next ask.',
      };
    }
    const pinned = this.intentKeys ? await this.intentKeys.minterKey() : null;
    if (!pinned) {
      const problem = this.intentKeys?.problem;
      return {
        why: `this box keeps no signing key of the minter’s to check the vault’s answer with${problem ? ` (${problem})` : ''}`,
        todo: 'It keeps one the first time it reaches the fleet’s own address, so look at whether this box can reach it.',
      };
    }
    const signed = await vaultBoxAnswerInput({ host: await keyId(request.hostKey), at: request.at, reply: request.reply, sealed });
    if (await verify(pinned, signature, signed)) return null;
    return {
      why: 'the vault’s answer is not signed by the minter’s key this box keeps, so it was changed on its way here, or the minter has a new signing key',
      todo: `If the minter was given a new key, delete ${this.intentKeys?.file ?? MINTER_KEY_FILE} on this box to accept it. If it was not, something between this box and the vault is answering in its place.`,
    };
  }

  /**
   * @returns {Promise<{ ok: true, token: string, login: string, owner: string,
   *   signIn?: { expiresAt: number, scopes?: unknown, subscriptionType?: unknown, rateLimitTier?: unknown, account?: unknown } }
   *   | { ok: false, owner?: string|null, text: string }>}
   */
  async #askForClaudeLogin() {
    const { privateKey, publicKey } = await newSealKey();
    const audience = await claudeBindingFor(publicKey);
    // A MACHINE FROM A POOL has no job token: it asks with its key alone,
    // over the socket its enrolment opened (#handVmLogin).
    /** @type {string|undefined} */
    let job;
    if (this.jobToken) {
      try {
        job = await this.jobToken(audience);
      } catch (e) {
        return { ok: false, text: `GitHub would not give this job a token to ask with: ${/** @type {Error} */ (e).message}` };
      }
    }
    const id = `claude-${crypto.randomUUID()}`;
    /** @type {any} */
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.mintWaiters.delete(id);
        resolve(null);
      }, this.mintTimeoutMs);
      timer.unref?.();
      this.mintWaiters.set(id, { resolve, timer });
      let sent;
      try {
        sent = this.transport.send({ v: PROTOCOL_VERSION, kind: 'claude-login', id, hostId: this.hostId, ...(job ? { job } : {}), key: publicKey });
      } catch {
        sent = false;
      }
      if (sent === false) {
        this.mintWaiters.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, text: 'this runner was not connected to the fleet when it asked' });
      }
    });
    if (!answer) return { ok: false, text: 'the fleet did not answer in time; a coordinator from before Claude logins drops the question' };
    const owner = typeof answer.owner === 'string' ? answer.owner : null;
    if (answer.ok !== true) return { ok: false, owner, text: String(answer.text || 'the fleet refused') };
    try {
      const inside = await open({ privateKey, publicKey, aad: audience, sealed: answer.sealed });
      const token = typeof inside?.token === 'string' ? inside.token : '';
      if (!token || !owner) return { ok: false, owner, text: 'the answer carried no login, so none was used' };
      // A SIGN-IN THE VAULT RENEWS comes with its expiry and what its
      // credentials file says (claude.js); a setup-token, or a minter from
      // before, without.
      const s = inside?.signIn;
      const signIn = s && typeof s === 'object' && Number.isSafeInteger(s.expiresAt)
        ? { expiresAt: Number(s.expiresAt), scopes: s.scopes, subscriptionType: s.subscriptionType, rateLimitTier: s.rateLimitTier, account: s.account }
        : null;
      return { ok: true, token, login: String(inside.login || answer.login || ''), owner, ...(signIn ? { signIn } : {}) };
    } catch {
      return { ok: false, owner, text: 'the answer did not open with this request’s key, so it was not used' };
    }
  }

  /**
   * Repair the Remote Control URL on every running session in a reply.
   *
   * fleetwright's recorded `rcUrl` comes from a matcher that reads the raw pane
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
            `fleetwright had ${s.rcUrl ? JSON.stringify(s.rcUrl) : 'nothing'}`,
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
        // WHY it is still, which a timestamp cannot say. A finished session
        // and a wedged one both stop changing; they are opposites to the
        // person looking at them, and the app was rendering both as "quiet
        // for 3h". Additive — an older client ignores it and shows what it
        // showed before.
        atRest: this.watcher?.atRest?.(s.name) ?? false,
        // WHEN IT LAST CAME BACK TO ITS PROMPT after working, in this run of
        // the session, or null. `atRest` says where the pane is now; this
        // says it got there by finishing something since it started, which
        // is what fleet_await waits for. Additive, like the two above.
        readyAt: this.watcher?.readyAt?.(s.name) ?? null,
        // THE THREE FIELDS HEALTH HAD AND THIS REPLY DID NOT, and the phones
        // draw sessions from this reply. So a phone was told what a session
        // was asking on every health frame it never read, and on the list it
        // did read the question was always absent: "Waiting for you" and the
        // answer card keyed on a field no list reply carried. Same values as
        // health, from the same caches, so the two cannot disagree.
        //
        // `awaitingSince` is new to both: since when it has been blocked on a
        // person, a floor from this box's clock (watcher.js awaitingSince).
        prompt: this.#promptFor(s),
        awaitingSince: this.watcher?.awaitingSince?.(s.name) ?? null,
        startedAt: s.createdAt ?? null,
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
  /**
   * Every label this box carries, right now.
   *
   * A GETTER AND NOT A FIELD, because the point of the `labels` verb is that
   * this changes without a restart. Health goes out every fifteen seconds and
   * the coordinator ranks and filters on the last frame it received, so a list
   * frozen at construction would mean a label added from a phone reached the
   * scheduler on the next service restart — which is the "the product names a
   * fix and only a shell can apply it" shape this whole file argues against.
   *
   * Three sources, composed: FLEETWRIGHT_LABELS from this process's own env
   * file; the facts fleetwright derives about the machine (`arm64`, `debian`,
   * `browser` — the last from the image it runs sessions in, which only it
   * knows); and the ones set from an app, which fleetwright stores. The
   * second and third arrive on /api/state, so what this answers between
   * frames is what the last frame said.
   *
   * @returns {string[]}
   */
  get labels() {
    const auto = this.facts?.labels?.auto ?? [];
    const set = this.facts?.labels?.set ?? [];
    return [...new Set([...this.givenLabels, ...auto, ...set])].sort();
  }

  /** The `admins` field of health, or nothing. Never throws: a frame is not lost to it. */
  #adminsReport() {
    try {
      // The list check() would use, not whatever list is held: one past its
      // age refuses every signature, and health must say so (C-5).
      const report = pinReport(readPins(this.xoStateDir), this.intentKeys?.current ?? null, { checks: Boolean(this.intentKeys) });
      return report ? { admins: report } : {};
    } catch (e) {
      this.log.warn(`sidecar: could not read who is pinned here: ${/** @type {Error} */ (e).message}`);
      return {};
    }
  }

  async health() {
    const [load1, load5, load15] = this.machine.loadavg();
    const cpus = this.machine.cpus();

    // ASK FIRST, so the facts below are this frame's. The fields that used to
    // be read out of fleetwright's state directory here — labels, channel,
    // variant, house rules — ride on /api/state now, and the frame is built
    // from that one answer. When fleetwright cannot be reached the last facts
    // stand (see `facts`), and the fields that need a live answer are null.
    /** @type {any} */
    let state = null;
    /** @type {(Error & { code?: string })|null} */
    let unreachable = null;
    try {
      state = await this.hub.state();
      this.facts = factsFrom(state);
      this.#noticeRestart(state);
    } catch (e) {
      unreachable = /** @type {Error & { code?: string }} */ (e);
    }

    /** @type {Record<string, any>} */
    const base = {
      hostId: this.hostId,
      protocol: PROTOCOL_VERSION,
      // The oldest version this host still reads, so the coordinator can speak
      // this box its own highest understood version instead of refusing it on a
      // bump. Additive: a host from before this sends only `protocol`, and the
      // coordinator reads a missing `protocolMin` as equal to `protocol` (exact
      // match, exactly as before). See docs/protocol-negotiation.md.
      protocolMin: PROTOCOL_MIN,
      labels: this.labels,
      // THE HYPERVISORS THIS BOX CAN MAKE MACHINES ON, and the machine images
      // each pool has: how the coordinator knows to ask this box for one, and
      // how a phone is offered one. Never the token. In every frame, the hub
      // answering or not, because making a machine is this process's and not
      // the hub's. Absent when it holds none, so an older coordinator sees
      // nothing new.
      ...(this.pools && this.#holdsAny()
        ? {
            xo: this.pools.report().map(({ problem, ...seen }) => {
              const edges = this.edgeWatch?.reportFor(seen.owner, seen.address);
              // WHY A PROXMOX CLUSTER DID NOT ANSWER, for the phone's
              // Hypervisors page: its token lives on boxes alone, so a box
              // that cannot reach it is the only one who can say why. Proxmox
              // API errors name a path and a status, never the token. Xen
              // Orchestra's stays home, as before: its page asks the pool
              // itself, phone-direct.
              // And why this box offers no machine of its own just now: its
              // image is being built, or the build failed. Its own words
              // about itself, with nobody's token near them.
              const why = ((seen.kind === 'proxmox' && seen.reachable === false) || /** @type {any} */ (seen).own === true) && typeof problem === 'string' ? { problem: problem.slice(0, 200) } : {};
              return { ...seen, ...why, ...(edges ? { edges } : {}) };
            }),
          }
        : {}),
      // WHICH OF THOSE CAN BE TAKEN OFF, so a screen offers Remove on exactly
      // the ones it works for. The flat list above cannot say: `arm64` and
      // `gpu` look identical in it, and one of them is a fact the host refuses
      // to drop. An app rendering the flat list would show a control that
      // exists and does not work, which is C-2 in the place it is easiest to
      // get wrong — and the person only finds out by tapping.
      //
      // Sent rather than asked for, like the channel and the variant beside it:
      // a list of machines must not become a round trip per row.
      setLabels: this.facts?.labels?.set ?? [],
      // WHAT THE SIGNATURES ON INTENTS HAVE BEEN FOUND TO BE, and whether this
      // box has the minter's key list to check them with
      // (docs/signed-intents.md, phase 1). Absent on a box with no enrolment
      // key, which cannot ask for the list at all.
      // And whether it refuses what is not signed (FLEETWRIGHT_REQUIRE_SIGNED),
      // which is what the coordinator reads to refuse there first.
      ...(this.intentKeys || this.requireSigned !== 'off'
        ? {
            signatures: {
              ...(this.intentKeys
                ? this.intentKeys.report()
                : { keys: null, keysAt: null, checked: {}, problem: 'this box has no key of its own to ask the minter for the key list with, so it can check no signature' }),
              // `true` for everybody, as it always read; `signers` for the
              // people this box has seen a key for and nobody named.
              ...(this.requireSigned === 'all' ? { enforcing: true } : this.requireSigned === 'signers' ? { enforcing: 'signers' } : {}),
            },
          }
        : {}),
      // WHO THIS BOX TAKES REBOOT, UPGRADE, UPDATE, A NEW CHANNEL OR SANDBOX
      // IMAGE AND RESTORING SOMEBODY ELSE'S WORK FROM (pinned-admins.js),
      // read from the record on every frame so a pin made at the box's own
      // prompt shows without a restart. `stranded` when nobody pinned can
      // sign, so a phone draws none of those for anybody.
      // Empty is nobody pinned: the coordinator's word, as before. Present at
      // all is how a phone knows `pinadmin` exists here; absent, from an older
      // box or one with nowhere to keep a record, it offers nothing. The
      // coordinator shapes it per person before anybody sees the addresses
      // (core.js adminsSeenBy).
      ...this.#adminsReport(),
      // WHICH SERVICE LOGS THIS BOX CAN READ, so a screen offers a button for
      // exactly those. The chat surface already checks — logButtons in
      // commands.js filters on unitInstalled, because "no log entries for
      // fleetwright-coordinator" on a box that never ran one looks like a
      // broken service rather than an absent one — and a phone has no way to
      // ask that question per row. Carried in `base` rather than beside
      // `channel` below on purpose: the logs are most wanted when the hub is
      // unreachable, which is exactly when the block below is not sent.
      //
      // Null on a host too old to send it, which is CANNOT TELL: the verb
      // still works there, the frame just does not say which of the three
      // will answer with something.
      // `boot` WHERE THIS BOX MAKES PROXMOX VE MACHINES: what each printed as
      // it booted (pve-console.js), which a phone offers beside the journals.
      logs: this.#withBoot(this.#logSources()),
      // WHAT THIS BOX PUTS INTO EVERY SESSION, as a number rather than a flag.
      //
      // House rules are read on every turn of every session, so their size IS
      // the fact worth reporting — docs/wanted.md puts it plainly, "a
      // 2,000-token house style is a 2,000-token tax on a one-line question".
      // A boolean would say a box has rules and leave the only decidable
      // question unanswered.
      //
      // Three states, and they are the ones this project keeps insisting on:
      // a number is "this many characters, on every turn"; 0 is "there is a
      // rules file and it is NOT being used", which is a fault somebody should
      // see rather than silence; null is no rules file at all, which is the
      // normal case and also what a host too old to send this reads as. The
      // last two collapsing would be the C-5 failure — cannot-tell rendered as
      // nothing.
      houseRules: this.facts?.houseRules ?? null,
      loadavg: [load1, load5, load15],
      // HOW MANY CORES THE LOAD IS ON. A load of 20 is a quiet eight-core box
      // or a three-core runner at the start of a simulator boot, and the frame
      // said only the 20. Null never: every Node can count its cores.
      cpus,
      freeMemBytes: os.freemem(),
      totalMemBytes: os.totalmem(),
      uptimeSec: Math.round(os.uptime()),
    };

    if (state) {
      const sessions = /** @type {any[]} */ (Array.isArray(state.sessions) ? state.sessions : []);
      const running = sessions.filter((s) => s?.status === 'running').length;
      // WHAT THE HUB RUNS BESIDE CLAUDE CODE, kept because it is also what
      // this box tells the vault it can be handed a sign-in for (#askVault).
      this.#noteEngines(state.engines);
      return {
        ...base,
        hub: { reachable: true, host: state.host ?? null },
        maxSessions: state.maxSessions ?? null,
        // THE ENGINES THIS BOX RUNS (docs/engines.md), as its hub says. A hub
        // from before engines says nothing, and the coordinator reads that
        // as Claude Code alone.
        ...(Array.isArray(state.engines) ? { engines: state.engines.filter((/** @type {unknown} */ e) => typeof e === 'string').slice(0, 8) } : {}),
        // WHICH MEMBERS ARE SIGNED IN TO WHICH ENGINE HERE, as the hub was told
        // (docs/engines.md, "What a machine reports"): a member's id, an
        // engine and since when. Only the ones signed in now, and no account.
        // A hub from before sign-ins says nothing, and the frame then has no
        // list, which is cannot tell and never nobody.
        //
        // AND ONLY TO A COORDINATOR THAT HAS SHOWN IT KNOWS THE LIST
        // (coordinatorSpeaks): one from before it hands every member every
        // entry. Held back, the frame has no list, which that coordinator
        // and every screen already read as cannot tell.
        ...(Array.isArray(state.engineSignins) && (this.coordinatorSpeaks ?? 0) >= ENGINE_SIGNINS_SINCE ? { engineSignins: signedInOn(state.engineSignins) } : {}),
        // The metered API providers an engine here may bill to, when its
        // operator named any (docs/api-engines.md). Kept, because it is also
        // what decides whether this box asks a vault for keys (#askVault).
        ...(this.#noteApiProviders(state.apiProviders).length ? { apiProviders: this.apiProviders } : {}),
        running,
        // The hub's own answer when it gives one (it measures memory and load,
        // core/capacity.js); a hub from before that has only a fixed count.
        free: typeof state.free === 'number' ? state.free
          : typeof state.maxSessions === 'number' ? Math.max(0, state.maxSessions - running) : null,
        // What stops it, when free is 0, as a code: the coordinator says why
        // from the numbers in this frame, rather than "5/5" for a box out of
        // memory at 3.
        capacityBound: typeof state.capacity?.bound === 'string' ? state.capacity.bound : null,
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
            // AS WHICH MEMBER, and who asked for it, when it was started as
            // one (docs/members.md): what lets the person who started it, and
            // the member's managers, see and stop a session whose creator is
            // the member.
            ...(s.member ? { member: s.member, memberName: s.memberName ?? null, memberRole: s.memberRole ?? null, startedBy: s.startedBy ?? null } : {}),
            // AND ON WHICH TASK (docs/tasks.md), so a screen can go from a
            // session to the task it is work on.
            ...(s.taskId ? { taskId: s.taskId, taskBranch: s.taskBranch ?? null } : {}),
            // WHICH ENGINE IT IS ON, of the ones its member names, and how
            // its last turn ended (docs/engines.md).
            ...(Array.isArray(s.engines) ? { engines: s.engines, engineAt: s.engineAt ?? 0, engineLog: s.engineLog ?? [] } : {}),
            ...(s.turn ? { turn: s.turn } : {}),
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
            // HOW FULL ITS WINDOW IS: the tokens in context at the last
            // assistant turn, and the model that answered. Read off the
            // transcript by whichever process can see it (src/core/
            // context-usage.js), never guessed from the pane. No window size
            // and no percentage, because the transcript does not say and a
            // table about somebody else's models would be wrong the week one
            // changed. Null is CANNOT TELL — not running, no turn yet, an
            // older host — and both phones draw that as nothing rather than
            // as empty.
            context: s.context ?? null,
            // SINCE WHEN IT HAS BEEN BLOCKED ON A PERSON, or null when it is
            // not: a floor, from this box's clock (watcher.js awaitingSince).
            // `prompt` says what it is asking when the pane can be read;
            // this says it is waiting even when it cannot, and for how long.
            awaitingSince: this.watcher?.awaitingSince?.(s.name) ?? null,
            // HOW THIS RUN HAS SPENT ITS TIME — working, blocked on a person,
            // at its own prompt — from its own hooks (src/core/activity.js
            // advancePhases). Closed totals and the moment the open stretch
            // began, so the phone adds the open part from its own clock. Null
            // is CANNOT TELL: not running, an image older than the hooks, a
            // run that has said nothing yet.
            phases: s.phases ?? null,
            // WHAT IT HAS COST, as Claude Code counted it in its own
            // transcript (src/core/spent.js). Never priced, summed or guessed
            // on this box. Null is CANNOT TELL, never "free".
            spent: s.spent ?? null,
          })),
        loggedIn: state.auth?.loggedIn === true,
        // HOW MANY PEOPLE CAN START A SESSION HERE. The health field that
        // replaced `loggedIn` as the thing the coordinator judges on: a machine
        // has no Claude account of its own any more, so `loggedIn: false` is
        // the ordinary state of every box and stopped meaning anything.
        // Additive — an older host sends nothing and is not faulted for it.
        claudeAccounts: typeof state.claudeAccounts === 'number' ? state.claudeAccounts : null,
        // On a runner, what a session with nobody linked runs on: 'owner',
        // 'key' or 'none' (src/core/runner-login.js). The coordinator judges a
        // runner by this rather than by claudeAccounts, which is always zero
        // on a GitHub job. Null off a runner and from an older hub.
        runnerAuth: ['owner', 'key', 'none'].includes(state.runnerAuth) ? state.runnerAuth : null,
        // The account this box runs on, for the app's settings screen: which
        // plan, which org, which address. Not a secret — it is what
        // `fleetwright login status` prints on the box — and it is the
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
        // WHICH RELEASES THIS BOX TAKES, carried with health rather than
        // fetched per host when a screen opens. The app shows a list of
        // machines; a picker that had to ask each one separately would be a
        // round trip per row, and a row that could not draw until it answered.
        //
        // Null on a host too old to send it, which is CANNOT TELL and not
        // "stable" — the distinction the credential field above is written
        // around, and the one that stops an app confidently mislabelling a box
        // that is taking prereleases.
        //
        // Null too on a fleetwright from before it published this — the
        // sidecar could read the file then and cannot now, and answering
        // "stable" for it would be the same claim in a new place.
        channel: this.facts?.channel ?? null,
        // Whether that is forced by the box's environment, so an app disables
        // the control instead of offering a change that will be refused.
        channelPinned: this.facts?.channelPinned ?? null,
        // WHICH IMAGE SESSIONS RUN IN, carried with health for the same reason
        // as the channel: the app draws a list of machines, and a variant
        // picker that had to ask each box separately would be a round trip per
        // row and a row that could not draw until it answered.
        //
        // Null on a host too old to send it, which is CANNOT TELL and never
        // "minimal" — a fleet where every old box claims to have no browser is
        // a fleet where `tag: browser` looks broken.
        sandbox: this.facts?.sandbox ?? null,
        // WHETHER ITS SESSIONS ARE CONTAINED, the question `sandbox` does not
        // answer (http.js #hostFacts). The coordinator places a member's
        // session on a box they do not administer only when this is `true`
        // (hosts.js runsSessionsFor, docs/security.md G8). Null from a hub
        // too old to say, which is cannot tell and is treated as not.
        sandboxed: this.facts?.sandboxed ?? null,
        // AND WHY NOT, beside a `false` (http.js uncontained): the sandbox
        // off, opened by FLEETWRIGHT_SANDBOX_ARGS, or in the host user
        // namespace because the hub runs as root, runs docker, or was told
        // to. The coordinator names the way on from it; null from a hub too
        // old to say, which it reads as off.
        sandboxedWhy: this.facts?.sandboxedWhy ?? null,
        // AND EVERY REASON AFTER IT, because a box with two is not opened by
        // fixing the first, and the coordinator names them all. Empty when
        // there is one, or none.
        sandboxedAlso: this.facts?.sandboxedAlso ?? [],
        // WHAT A START WITH NO MODE DOES HERE: `asks` before each tool, or
        // runs with permissions `bypassed` (http.js #hostFacts). A phone
        // labels its "Box default" choice from this and offers "Permissions
        // bypassed" only on a box that says `bypassed`, since on one that says
        // `asks` the hub refuses a fleet start that asks for it. Null from a
        // hub too old to say, which is cannot tell: a phone then says nothing
        // about the mode rather than guessing at the usual one. Additive, so
        // an older coordinator stores it with the rest and an older phone
        // never reads it.
        permissions: this.facts?.permissions ?? null,
        // WHAT THIS BOX OPENS FOR A PHONE'S WEB VIEW (docs/browse.md):
        // `sessions`, whether a session's own ports can be opened, which is
        // whether its sessions are contained; `web` and `hosts`, what its
        // owner turned on. A phone draws Open a port and Browse from this,
        // and a box older than protocol 18 sends none, so neither is drawn
        // for it. The coordinator shows `web` and `hosts` only to people who
        // administer the box.
        browse: {
          sessions: this.facts?.sandboxed === true,
          web: this.browsePolicy.web,
          hosts: this.browsePolicy.entries.map((e) => e.raw),
        },
      };
    }
    const err = /** @type {Error & {code?: string}} */ (unreachable);
    this.log.warn(`sidecar: health could not reach fleetwright: ${err.message}`);
    // WHY, WHEN THE BOX ITSELF IS THE REASON. "GET /api/state: The operation
    // was aborted due to timeout" is what a fleet saw for six minutes while a
    // 3-core macOS runner booted the iPhone Duo at a load of 519, and it sent
    // the reader to look for a broken service. The load is the whole story,
    // and this process has it. Said in numbers, and on a Mac said for what it
    // usually is: measured three times on GitHub's runners, a simulator boot
    // is four to six minutes at a load of 500 to 700, and the box answers
    // again after. The coordinator carries this sentence into its "busy"
    // refusal (registry.js), so an agent waiting on a session there reads it.
    const overloaded = load1 >= OVERLOAD_LOAD_PER_CORE * cpus
      ? ` — overloaded: 1-minute load ${Math.round(load1)} on ${cpus} core${cpus === 1 ? '' : 's'}` +
        (this.machine.platform === 'darwin' ? '; on a Mac that is what a simulator boot looks like, four to six minutes, and it answers again after' : '')
      : '';
    return {
      ...base,
      hub: { reachable: false, reason: `${err.message}${overloaded}`, code: err.code || 'hub_unreachable' },
      maxSessions: null,
      running: null,
      free: null,
      resumable: null,
      sessions: null,
      loggedIn: null,
      claudeAccounts: null,
      runnerAuth: null,
    };
  }

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

  /**
   * Mint a PKCE verifier per provider this host can exchange for, and put the
   * challenge on the catalogue entry.
   *
   * ONLY FOR A PROVIDER WHOSE CLIENT SECRET IS ON THE FRAME. A challenge is a
   * promise to finish the exchange here, and without the secret this host
   * cannot keep it — the coordinator would relay a code to a host that then
   * answers "no secret", and the person would see a sign-in that failed for a
   * reason neither end can name. With no secret the entry goes out as it was,
   * and the coordinator exchanges as it always did.
   *
   * Keyed by provider and by the person asking, so two members connecting the
   * same provider on one box do not spend each other's verifier.
   *
   * @param {any[]} catalogue
   * @param {import('../protocol/intents.js').Intent} intent
   */
  #offerChallenges(catalogue, intent) {
    const who = intent.actor ? emailFromActor(`fleet:${intent.actor}`) : null;
    return catalogue.map((entry) => {
      const provider = entry?.provider;
      if (provider !== 'github' && provider !== 'cloudflare') return entry;
      if (!this.config.get(`${provider}ClientSecret`)) return entry;
      return { ...entry, codeChallenge: this.verifiers.mint(provider, who) };
    });
  }

  /**
   * Finish an authorization whose code the coordinator relayed here.
   *
   * The sequence docs/recommendations-review.md §4 lays out, from this end:
   * the verifier minted at `connect` is spent, once; the code is exchanged
   * with it and the frame's client secret; the access token is stored by the
   * same `/link` a pasted token takes, and the renewal material by the same
   * `/renew` the coordinator used to deposit. What changes is what the
   * coordinator saw on the way: a code it cannot use, and nothing else.
   *
   * ONE ANSWER FOR NO VERIFIER, AN EXPIRED ONE AND A SPENT ONE. Which of the
   * three it was is not something the person can act on differently — the
   * remedy is the same — and a retry of the intent replays this reply from
   * the idempotency cache rather than reaching a second, refused, exchange.
   *
   * @param {import('../protocol/intents.js').Intent} intent
   * @returns {Promise<Record<string, any>>}
   */
  async #exchange(intent) {
    const provider = String(intent.params.provider);
    const label = provider === 'github' ? 'GitHub' : 'Cloudflare';
    const who = intent.actor ? emailFromActor(`fleet:${intent.actor}`) : null;
    const actor = intent.actor ? `fleet:${intent.actor}` : '';
    // A PERSON'S SIGN-IN IS THEIR VAULT'S, finished by the minter for the
    // phone that started it (src/fleet/minter/vault.js, `connect`). Finishing
    // one here stored it on this box alone, as a second copy, so it is refused
    // before the code is spent or anything is asked of ${label}.
    if (who) return { ok: false, text: VAULT_ONLY };

    const verifier = this.verifiers.spend(provider, who);
    if (!verifier) {
      return { ok: false, text: `No ${label} sign-in is waiting on this host — start again from the app.` };
    }
    const clientSecret = this.config.get(`${provider}ClientSecret`);
    if (!clientSecret) {
      return { ok: false, text: `This host has no ${label} client secret to finish the sign-in with.` };
    }

    const exchange = provider === 'github' ? exchangeCode : exchangeCloudflareCode;
    const exchanged = await exchange({
      clientId: String(intent.params.clientId),
      clientSecret,
      code: String(intent.params.code),
      origin: String(intent.params.origin),
      codeVerifier: verifier,
      fetch: this.fetchImpl,
    });
    if (!exchanged.ok) return { ok: false, text: exchanged.message };

    // THE ACCESS TOKEN, NEVER THE REFRESH TOKEN, stored by the verb that
    // already stores pasted ones — same validation, same redaction, same
    // per-person file (core.js #storeAuthorizedToken says why).
    const linkParams = { provider, secret: exchanged.accessToken };
    const linkLine = toCommandLine({ verb: 'link', params: linkParams, actor: intent.actor });
    this.log.info(`sidecar: ${actor || 'fleet'} → ${redactCommandLine(linkLine)}`);
    const linked = await this.hub.command(linkLine, commandMeta('link', linkParams, actor));
    if (linked?.ok === false) return { ok: false, text: linked.text || `The ${label} token could not be stored.` };

    let renewable = false;
    if (exchanged.refreshToken) {
      const renewParams = { provider, clientId: String(intent.params.clientId), refresh: exchanged.refreshToken };
      const renewLine = toCommandLine({ verb: 'renew', params: renewParams, actor: intent.actor });
      this.log.info(`sidecar: ${actor || 'fleet'} → ${redactCommandLine(renewLine)}`);
      const deposited = await this.hub.command(renewLine, commandMeta('renew', renewParams, actor));
      renewable = deposited?.ok !== false;
      if (!renewable) this.log.warn(`sidecar: ${provider}: could not store renewal material: ${deposited?.text}`);
    }
    return { ok: true, text: connectedText({ label, expiresIn: exchanged.expiresIn, renewable }) };
  }

  /**
   * Take a config frame.
   *
   * Returns nothing: there is no reply to a frame that carries no id, and a
   * host that acknowledged its own configuration would be telling the
   * coordinator something it already knows.
   *
   * @param {unknown} msg
   */
  #onConfig(msg) {
    const read = readConfigFrame(msg);
    if (!read.ok) {
      this.log.warn(`sidecar: ignored a config frame — ${read.error}`);
      return { kind: 'none' };
    }
    // ONLY WHAT CHANGED IS NEWS. The coordinator sends the frame on every
    // connect and again every fifteen seconds, and this logged every one of
    // them: four lines a minute, forever, saying the same thing, which is
    // what buried "sidecar: vault: holding vault credentials for …" when
    // somebody opened the journal to find out whether a box had been given
    // a credential. A key that arrives for the first time, or with a value
    // that differs from the one held, is logged; a frame that repeats what
    // this process already has says nothing.
    //
    // The KEYS are logged, never the values. Knowing what arrived is how
    // somebody diagnoses a renewal that is not happening; knowing the value is
    // how a journal that now reaches a phone becomes a credential leak.
    const changed = Object.entries(read.values).filter(([key, value]) => this.config.get(key) !== value).map(([key]) => key);
    for (const [key, value] of Object.entries(read.values)) this.config.set(key, value);
    if (changed.length) {
      this.log.info(`sidecar: coordinator supplied ${changed.join(', ')}`);
    }
    for (const key of read.dropped) {
      this.log.warn(`sidecar: config frame carried "${key}", which this host does not recognise — dropped`);
    }
    return { kind: 'none' };
  }

  /**
   * The log sources whose unit exists on this box, in LOG_SOURCES order.
   *
   * ASKED ONCE. A unit appears or disappears with an install, which restarts
   * this process, so three `systemctl cat` spawns four times a minute would be
   * spending a fork on a fact that cannot change under it — unlike the labels
   * above, which a phone can change and which are read on every frame.
   * @returns {string[]|null}
   */
  /** @param {string[]|null} sources */
  #withBoot(sources) {
    if (!sources || !(/** @type {any} */ (this.pools)?.pve?.held?.size)) return sources;
    return [...sources, 'boot'];
  }

  #logSources() {
    if (!this.hubConfig?.systemctlBin) return null;
    this.logSources ??= Object.entries(LOG_SOURCES)
      .filter(([, { unit }]) => unitInstalled(this.hubConfig, unit))
      .map(([key]) => key);
    return this.logSources;
  }

  #updates() {
    try {
      return this.updates?.() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Exit for new code, once, when fleetwright says an update landed after this
   * process started. See `onRestartRequested` in the constructor.
   * @param {any} state
   */
  #noticeRestart(state) {
    const at = state?.restartRequestedAt;
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= this.startedAt) return;
    if (!this.onRestartRequested) return;
    const hook = this.onRestartRequested;
    // Cleared first: exiting is the caller's, and if it does anything slower
    // than process.exit the next frame must not ask twice.
    this.onRestartRequested = null;
    this.log.warn('sidecar: new code was installed — restarting to pick it up');
    hook(at);
  }

  /**
   * A sentence when this sidecar is running a different release from the one
   * on disk, and nothing otherwise: `version()` reads `head` from this
   * process's own tree and `installed` from `current`.
   */
  #behind() {
    /** @type {any} */
    let v = null;
    try {
      v = this.version?.() ?? null;
    } catch {
      return '';
    }
    if (!v?.head || !v?.installed || v.head === v.installed) return '';
    return `The sidecar here is still running ${v.head}; ${v.installed} is on disk. What the sidecar runs (hypervisor setups among it) is the older code until it restarts: /update --restart.`;
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
 * What a person is told who asks a box to keep a credential of theirs: every
 * credential a fleet person's session uses comes from their vault (vault-store.js).
 */
const VAULT_ONLY =
  'Your credentials are kept in your vault now, not on a machine: keep them under You › Credentials in the app, ' +
  'and approve this machine from its page. A sign-in made on a machine for that machine held a second copy that ' +
  'renewed on its own clock.';

/**
 * Build the fleetwright command line for a validated intent.
 *
 * Every part is either a literal from this file or a value that has already
 * been charset-checked by validateIntent, so this is assembly, not
 * interpolation. There is no point at which a coordinator-supplied string
 * reaches fleetwright as anything but a single token — which matters more here
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
      // values it can hold are the two literals below. `title`, `brief` and
      // `task` are deliberately NOT here — they are prose, they travel as
      // fields on the request, and commandMeta() below is what picks them up.
      //
      // `profile` IS here, and the difference is the whole design. It is a
      // NAME — charset-checked by validateIntent, no whitespace, no quote, no
      // leading dash — so it is a single token that cannot become a second
      // flag. The words it selects never travel: fleetwright reads them off a
      // file on this box. (Since v7 a `task` can carry words of its own, beside
      // the line rather than in it.)
      //
      // `secret` is here for the same reason and with the same guarantee: a
      // charset-checked NAME, a single token, and what it names — the value —
      // never crosses this line either. It grants the session permission to
      // fetch that secret from the store at runtime. See src/core/secret-store.js.
      //
      // `archive` (v11) is here on the same terms: an `owner/repo` held to
      // GitHub's naming rules by the protocol's pattern, so one token with no
      // space, quote or leading dash. The hub keeps it on the record and
      // pushes the session there before it goes (src/core/archive.js).
      if (p.archive && !REPO_RE.test(String(p.archive))) throw new Error('an archive is a repository, as owner/repo');
      return [
        '/new',
        p.name,
        p.mode === 'safe' ? '--safe' : p.mode === 'dangerous' ? '--dangerous' : null,
        p.profile ? `--profile=${p.profile}` : null,
        p.secret ? `--secret=${p.secret}` : null,
        p.archive ? `--archive=${p.archive}` : null,
        // `boxSecrets` (v14), an enum of two literals: whether this box's own
        // named secrets may answer the session, which the coordinator decides
        // from who administers the box. Absent from an older coordinator, and
        // the hub then serves a fleet actor's session from its vault alone.
        p.boxSecrets ? `--box-secrets=${p.boxSecrets === 'yes' ? 'yes' : 'no'}` : null,
      ]
        .filter(Boolean)
        .join(' ');
    case 'profiles':
      return '/profiles';
    case 'secrets':
      return '/secrets';
    // A bounded enum, so it is a single token that cannot become a second flag.
    // `--fresh` is a literal this side adds, never a param: this line is the
    // app's Check, somebody asking now, and it tells the verb to fetch apt's
    // lists before answering. The sidecar's own fifteen-minute poll sends the
    // bare verb and keeps the rate limit.
    case 'updates':
      return '/updates --fresh';
    case 'channel':
      return p.to ? `/channel ${p.to}` : '/channel';
    case 'sandbox':
      return p.to ? `/sandbox ${p.to}` : '/sandbox';
    // `+gpu` / `-gpu`, so one command expresses both and a bare word never has
    // to mean one of them. Both are `name`-typed, so neither can carry a space
    // or become a second flag.
    case 'labels':
      return p.add ? `/labels +${p.add}` : p.remove ? `/labels -${p.remove}` : '/labels';
    // THE WORKSPACE. Quoted with the same care as everything else here: a
    // path is a filename and never a command, so it travels as one argument.
    case 'files':
      return p.path ? `/files ${p.name} ${p.path}` : `/files ${p.name}`;
    case 'readfile':
      return `/readfile ${p.name} ${p.path}`;
    // THE CONTENT IS NOT ON THE COMMAND LINE. It is a file: it has newlines,
    // it has leading whitespace that matters, and it may be a shell script.
    // It travels as a field beside the command, the same way `brief` does —
    // see commandMeta below.
    case 'writefile':
      return `/writefile ${p.name} ${p.path}`;
    case 'copyfile':
      return `/copyfile ${p.name} ${p.path} ${p.to}`;
    case 'deletefile':
      return `/deletefile ${p.name} ${p.path}`;
    case 'resume':
      // `boxSecrets` as on `start`, decided again for the session's owner.
      return [
        '/resume',
        p.name,
        p.choice ?? null,
        p.boxSecrets ? `--box-secrets=${p.boxSecrets === 'yes' ? 'yes' : 'no'}` : null,
      ]
        .filter(Boolean)
        .join(' ');
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
      //
      // A name goes as `--session=<name>`, which the hub reads as a session
      // and nothing else: as a bare word, a session named after a log source
      // (`hub`, `sidecar`) or a number read the service journal, which the
      // coordinator lets a member reach only on a box that acts for them alone
      // (seventh audit).
      return ['/logs', p.name ? `--session=${p.name}` : p.service, p.lines].filter((x) => x !== undefined && x !== null).join(' ');
    case 'update':
      return p.restart === 'yes' ? '/update --restart' : '/update';
    case 'upgrade':
      // `--apply`, NOT `apply`. fleetwright's upgrade reads `flags.has('apply')`,
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
        // NO BOX ACCOUNT TO SIGN IN ANY MORE. `scope: host` on Claude used to
        // mean "log this MACHINE in", and the machine has no Claude account —
        // see docs/one-account-per-person.md. Refused with a reason rather than
        // removed from the enum: dropping a value an older coordinator still
        // sends would be `bad_params` arriving after the version handshake had
        // already agreed, which is the flag day the whole protocol design
        // exists to avoid.
        if (p.scope === 'host') {
          throw new Error(
            'this box has no Claude account of its own — sign in as a person instead, and their sessions run on '
            + 'their account. See docs/one-account-per-person.md',
          );
        }
        // A PERSON'S CLAUDE LOGIN IS THEIR VAULT'S, and is not made on a box
        // for that box any more: a box that held its own refresh token renewed
        // it on its own clock, which is the race the vault ends. The vault's
        // sign-in is made on a machine with `setuptoken` and `kind: login`,
        // and kept by the phone that asked (docs/vault.md).
        throw new Error(VAULT_ONLY);
      }
      // THE SAME FOR A TOKEN, unless it is the box's own (`scope: host`, an
      // administrator's, for the box's command line).
      if (p.scope !== 'host') throw new Error(VAULT_ONLY);
      return `/connect ${p.provider} --host`;
    case 'link':
      // The secret is protocol-constrained to printable ASCII with no
      // whitespace, quote or backslash, and cannot begin with a dash, so it is
      // one token on this line and can be neither split in two nor read as a
      // flag by the registry's parser. It is masked in every log between here
      // and the pane by src/core/redact.js — which is the reason `/code` and
      // `/link` are the two command words in that table.
      if (p.provider === 'claude' || p.scope !== 'host') throw new Error(VAULT_ONLY);
      // SCOPE HAS TO REACH THE HOST. It did not, and that made the
      // coordinator's admin gate a no-op for token providers: `scope: host`
      // and no scope at all produced the identical line, so the gate could be
      // stepped around by omitting a parameter that changed nothing. A
      // permission check on a value the enforcing end never sees is not a
      // permission check.
      return `/link ${p.provider} ${p.secret}${p.scope === 'host' ? ' --host' : ''}`;
    case 'verify':
      return `/verify ${p.provider}${p.scope === 'host' ? ' --host' : ''}`;
    case 'setuptoken':
      // The code is a protocol `secret`, so one token with no leading dash. The
      // key is held to SEAL_KEY_RE, and an uncompressed P-256 point always
      // starts with byte 0x04, so its base64url always starts with `B`: never a
      // flag either. A finish without a key is refused here, not sent.
      // `kind: login` makes the whole sign-in Remote Control needs, for the
      // vault, in place of a setup-token (login.js, startVaultSignIn).
      if (!p.code) return p.kind === 'login' ? '/setuptoken --login' : '/setuptoken';
      if (!p.reply) throw new Error('setuptoken with a code needs `reply`, the key to seal the token to');
      return `/setuptoken${p.kind === 'login' ? ' --login' : ''} ${p.code} ${p.reply}`;
    case 'unlink':
      if (p.provider === 'claude') {
        // Same as `connect` above: there is no machine account to log out of.
        if (p.scope === 'host') {
          throw new Error('this box has no Claude account of its own — unlink a person instead');
        }
        if (!mine) throw new Error('unlink me needs a signed-in identity — this caller has no email');
        return `/accounts remove ${mine}`;
      }
      return `/unlink ${p.provider}${p.scope === 'host' ? ' --host' : ''}`;
    case 'provision':
      // A word from a four-value enum and a bounded integer, so both are single
      // tokens that cannot become flags. The TICKET is deliberately not here —
      // it is a credential and travels beside the command, where no log site
      // between here and the pane has to remember to mask it. Nor is the
      // repository: the coordinator named it on the config frame, and a value
      // this process holds is not a value a caller typed.
      // The image is a word from the protocol's fixed list, none of which
      // starts with a dash, so it too is one token that cannot become a flag.
      return ['/provision', p.platform, p.minutes, ...(p.image ? ['--image', p.image] : [])]
        .filter((x) => x !== undefined && x !== null).join(' ');
    case 'runnerrepo':
      // `owner/repo`, held to that shape by the protocol's pattern before this
      // is reached — so it is one token with no space, quote or leading dash,
      // and cannot become a flag. Checked again here because this function is
      // the last place a malformed one could still become part of a line.
      if (!REPO_RE.test(String(p.repo || ''))) throw new Error('runnerrepo needs a repository as owner/repo');
      return `/runnerrepo ${p.repo}`;
    case 'linkrepo':
      // Two tokens, each held to one shape: the role is one of three words and
      // the repository is `owner/repo`, both checked by the protocol and again
      // here, the last place either could still become part of a line.
      if (!LINK_ROLES.includes(String(p.role))) throw new Error('linkrepo needs a role');
      if (!REPO_RE.test(String(p.repo || ''))) throw new Error('linkrepo needs a repository as owner/repo');
      return `/linkrepo ${p.role} ${p.repo}`;
    case 'mint':
      // THE ONLY LINE A MINT PRODUCES IS THE QUESTION, never the answer. The
      // job token and the key are not on it and never become a command at all
      // — the sidecar checks the one and seals to the other itself. What the
      // hub is asked is what the person's own GitHub connection can do in the
      // repository, which is the half only the hub can answer.
      if (!REPO_RE.test(String(p.repo || ''))) throw new Error('mint needs a repository as owner/repo');
      return `/githubaccess ${p.repo}`;
    case 'renew':
      // Both are protocol-constrained the same way `link.secret` is — printable
      // ASCII, no whitespace, no quote, no dash to start — so they are two
      // tokens on this line that cannot be split or read as flags. Masked from
      // the provider name onwards by src/core/redact.js.
      //
      // `p.client` is NOT forwarded, twice over. Interpolating it after the
      // coordinator stopped sending it appended the literal word "undefined"
      // to every deposit — harmless only because /renew discards its fourth
      // argument. And when an OLDER coordinator does still send it, the value
      // is the fleet-wide App client secret, which the hub has no use for and
      // this line has no business carrying: the protocol accepts the parameter
      // for compatibility and this is where it stops travelling.
      return `/renew ${p.provider} ${p.clientId} ${p.refresh}`;
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
    // fleetwright hardcoded `actor: 'web'` for every HTTP caller, so every
    // session on every host recorded "web" as its creator — the coordinator
    // knew the verified email, the sidecar knew it, and then it was thrown
    // away one hop from the record that wanted it.
    //
    // This is the value that makes "whose session is this" answerable, which
    // everything in docs/accounts.md depends on.
    ...(typeof actor === 'string' && actor ? { actor } : {}),
    ...(verb === 'start' && typeof params?.title === 'string' ? { title: params.title } : {}),
    ...(verb === 'start' && typeof params?.brief === 'string' ? { brief: params.brief } : {}),
    // THE TASK, v7: the session's first message. Beside the line like the
    // brief and for the same reason, only more so: it is several lines of
    // prose, and anything in the line is split on whitespace and could read
    // as a flag.
    ...(verb === 'start' && typeof params?.task === 'string' && params.task ? { task: params.task } : {}),
    // THE MEMBER IT RUNS AS, v19, for the record: its id, and the name and
    // role the coordinator's record has. Who it runs as is `actor`.
    ...(verb === 'start' && typeof params?.member === 'string' ? { member: params.member } : {}),
    ...(verb === 'start' && typeof params?.memberName === 'string' ? { memberName: params.memberName } : {}),
    ...(verb === 'start' && typeof params?.memberRole === 'string' ? { memberRole: params.memberRole } : {}),
    // THE TASK IT IS WORK ON, v20, for the record: the id and the branch it
    // was told. The words are `task`, above, and are not kept.
    ...(verb === 'start' && typeof params?.taskId === 'string' ? { taskId: params.taskId } : {}),
    ...(verb === 'start' && typeof params?.taskId === 'string' && typeof params?.taskBranch === 'string' ? { taskBranch: params.taskBranch } : {}),
    // THE MEMBER'S ENGINES, v21, in order: what the pane runs first, and
    // what takes over at a limit (docs/engines.md).
    ...(verb === 'start' && typeof params?.memberEngines === 'string' ? { memberEngines: params.memberEngines } : {}),
    // File content, for the same reason and by the same route: prose and
    // payloads travel beside a command rather than inside it.
    ...(verb === 'writefile' && typeof params?.content === 'string' ? { content: params.content } : {}),
    // THE DISPATCH TICKET, for the same reason and by the same route: it is a
    // credential, and a credential on a command line is a credential in the
    // journal of every surface that logs one.
    //
    // The repository and the coordinator origin are NOT here, because they are
    // not part of the intent at all — one comes off the config frame and one
    // out of this host's own configuration, so they are added where the request
    // is assembled rather than where an intent is translated. This function
    // takes an intent and nothing else, which is what keeps it testable.
    ...(verb === 'provision' && typeof params?.ticket === 'string' ? { ticket: params.ticket } : {}),
  };
}

/**
 * Why a box that takes only signed requests refused one, as the rest of a
 * sentence (Sidecar#handle). Each verdict is a different thing to fix, so each
 * says which.
 *
 * @param {string|null} verdict  checkIntentSignature's or checkDelegation's, or null when this box
 *   could not check at all
 * @param {{ verb: string, actor?: string }} intent
 * @param {string|null} problem  what the box's key list is missing, if anything
 * @param {'taken'|'failed'|'held'} [askedAgain]  for an unknown key, what asking
 *   the minter again came to (IntentKeys#check): a phone added a moment ago is
 *   the usual reason, and what the person can do about it depends on this
 */
export function unsignedReason(verdict, intent, problem, askedAgain) {
  const who = intent.actor || 'nobody named';
  switch (verdict) {
    case 'unsigned':
      return `this ${intent.verb} from ${who} was not signed`;
    case 'unknown-key':
      return `this ${intent.verb} is signed by a key the minter does not list for ${who}${
        askedAgain === 'taken' ? ', even on the list this box asked the minter for just now'
          : askedAgain === 'failed' ? `, and this box could not ask the minter again just now${problem ? ` (${problem})` : ''}. A phone added in the last few minutes can try again shortly`
            : askedAgain === 'held' ? ', and this box asked the minter for a new list moments ago. A phone added since then can try again in two minutes'
              : ''}`;
    case 'bad-signature':
      return `the signature on this ${intent.verb} does not hold for what arrived, so it was changed after it was signed`;
    case 'no-directory':
      return `this box has no key list from the minter to check the signature on this ${intent.verb} with${problem ? ` (${problem})` : ''}`;
    case 'not-covered':
      return `what ${who} delegated does not cover this ${intent.verb} here, now`;
    case 'revoked':
      return `${who} revoked the delegation this ${intent.verb} carries`;
    default:
      return `this box cannot check signatures${problem ? ` (${problem})` : ''}`;
  }
}
