// The coordinator.
//
// Hosts dial IN and hold the socket open; nothing you own ever listens on a
// host (design.md §3). Clients — a phone, a Shortcut, curl — speak ordinary
// HTTPS to the same origin. Both on one port, because a host pins exactly one
// origin and adding a second would mean pinning two.
//
//     host  ──ws──▶  /host/connect      (persistent, host dials out)
//     phone ──http─▶ /api/intent        (one round trip, flat JSON)
//
// This runs as a plain Node process today so the whole loop is testable on one
// box. It is written against nothing Node-specific beyond `node:http`, so the
// Worker + Durable Object version is a transport swap rather than a rewrite:
// the registry, the scheduler and the intent plumbing below are the parts that
// carry the design decisions, and none of them touch the runtime.
//
// WHAT THE COORDINATOR IS NOT ALLOWED TO BE
//
// Its registry is a cache with provenance, never the authority — see
// registry.js. And it sends intents, never commands: it cannot express a shell
// string even to itself, because `place()` routes verbs and the host validates
// the verb set again on arrival. A compromised coordinator can start and stop
// sessions. It cannot run anything.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { attachWebSocketServer } from '../ws.js';
import { CoordinatorCore } from './core.js';
import { http2Deliver } from '../apns-node.js';
import { pusherFromEnv } from '../push.js';
import { PROTOCOL_VERSION } from '../protocol/intents.js';
import { verifyActionsToken, DEFAULT_ACTIONS_AUDIENCE, verifyIdToken, isAllowed, isPrivateRelay, verifyAppleNotification, isWithdrawal } from './oidc.js';
import { sendInvite } from './invite-email.js';
import { credentialFrom, isClientCredential } from './credential.js';
import { callbackPage } from './github-oauth.js';
import { resource } from '../../core/resources.js';

/** How long to wait for a host's reply before giving up on it. */
const DEFAULT_INTENT_TIMEOUT_MS = 320_000;

/** How often to ask each host how it is doing. Must be well under the
 * registry's staleness window, or hosts oscillate into `unknown`. */
const HEALTH_INTERVAL_MS = 15_000;

export class Coordinator {
  /**
   * @param {{
   *   apiToken?: string|null,
   *   stateFile?: string|null,
   *   intentTimeoutMs?: number,
   *   healthIntervalMs?: number,
   *   logger?: typeof import('../../log.js').log,
   * }} [opts]
   */
  constructor({
    apiToken = null,
    stateFile = null,
    intentTimeoutMs = DEFAULT_INTENT_TIMEOUT_MS,
    healthIntervalMs = HEALTH_INTERVAL_MS,
    logger,
  } = {}) {
    this.apiToken = apiToken;
    // Enrolled host keys ARE the authority — the registry is the cache, they
    // are not. Losing them on restart means every box in the fleet is refused
    // until somebody walks round re-enrolling them, so unlike everything else
    // in this process, this goes to disk.
    this.stateFile = stateFile;
    this.intentTimeoutMs = intentTimeoutMs;
    this.healthIntervalMs = healthIntervalMs;
    this.log = logger || { debug() {}, info() {}, warn() {}, error() {} };
    // Everything that carries a decision lives in the core, shared verbatim
    // with the Cloudflare Worker. This class is transport and nothing else.
    this.core = new CoordinatorCore({
      logger: this.log,
      intentTimeoutMs,
      // The HTTP/2 transport is handed in here rather than reached for in
      // push.js: that file also runs in a Worker, where node:http2 does not
      // exist and importing it would break the bundle.
      push: pusherFromEnv(process.env, this.log, {
        apnsDeliver: http2Deliver(process.env.AGENT_FLEET_APNS_SANDBOX === '1' ? 'api.sandbox.push.apple.com' : undefined),
      }),
    });
    /** @type {import('node:http').Server|null} */
    this.server = null;
    /** @type {NodeJS.Timeout|null} */
    this.healthTimer = null;
    // Sockets live here, NOT on the registry entry. A registry entry is a
    // value that gets serialised straight out of `GET /api/hosts`, and a live
    // WsConnection hanging off it drags the raw socket, the http.Server and
    // its connection table into that response — see the comment on close().
    /** @type {Map<string, import('../ws.js').WsConnection>} */
    this.connections = new Map();
    // Debounced: a busy fleet records several events a second and this is a
    // file write. Losing the last 2s of history to a hard kill is a fair price
    // for not writing the ring on every line.
    /** @type {any} */
    this.eventSaveTimer = null;
    this.core.onEvents = () => {
      if (this.eventSaveTimer) return;
      this.eventSaveTimer = setTimeout(() => {
        this.eventSaveTimer = null;
        this.saveEvents();
      }, 2000);
      this.eventSaveTimer.unref?.();
    };
  }

  /** The host registry, for tests and for anything that wants to look. */
  get registry() {
    return this.core.registry;
  }

  get pending() {
    return this.core.pending;
  }

  /**
   * Read back what was enrolled.
   *
   * A missing file is a new coordinator, not an error. A CORRUPT one is an
   * error and is left alone rather than overwritten: the recovery for "the
   * file got truncated" is restoring it, and a coordinator that silently
   * starts empty makes that impossible to notice.
   */
  loadState() {
    if (!this.stateFile) return;
    let raw;
    try {
      raw = readFileSync(this.stateFile, 'utf8');
    } catch (e) {
      // ONLY a missing file means "new coordinator". This caught everything —
      // a permission error, an EISDIR, a failing disk — and returned quietly,
      // after which assertStateWritable() wrote an empty state over the top and
      // the fleet's entire membership list was gone. Permanently, and with a
      // healthy-looking startup line saying "0 enrolled hosts".
      //
      // That is the failure this file already refuses to have for a CORRUPT
      // file. Guarding JSON.parse and not the read that feeds it was half a
      // guard. A root-owned state file left by somebody running the coordinator
      // under sudo once is the ordinary way to get here.
      if (/** @type {any} */ (e)?.code === 'ENOENT') return;
      throw e;
    }
    const state = JSON.parse(raw);
    this.core.hostIds.restore(state.hosts || []);
    this.core.clients.restore(state.clients || []);
    this.core.invites.load(state.invites || []);
    this.core.enrollment.restore(state.enrollment || []);
    // Push registrations too. The Worker has always kept these in Durable
    // Object storage; the Node coordinator held them in a Map and lost them on
    // every restart, so push worked until the service bounced and then stopped
    // — silently, because a coordinator with no registrations has nothing to
    // report and a phone has no way to know it was forgotten.
    for (const device of state.devices || []) if (device?.token) this.core.devices.set(device.token, device);
    const hosts = this.core.hostIds.list().filter((h) => !h.revokedAt).length;
    this.log.info(`coordinator: ${hosts} enrolled host${hosts === 1 ? '' : 's'} from ${this.stateFile}`);
  }

  /**
   * Prove the state file can be written, before anything depends on it.
   *
   * Called once at startup and allowed to throw. An upgraded box is the case
   * that needs it: the unit gained StateDirectory=agent-fleet-coordinator, but
   * the copy in /etc/systemd/system is only refreshed by the installer, and
   * ProtectSystem=strict makes /var/lib read-only to the service — so the
   * directory does not exist and cannot be created. Everything would then work
   * perfectly until the first restart, at which point the whole fleet is
   * refused. A coordinator that cannot remember who is in the fleet should say
   * so while somebody is still looking at it.
   */
  assertStateWritable() {
    if (!this.stateFile) return;
    this.#writeState();
  }

  /**
   * The event ring, in a SEPARATE file from the membership list.
   *
   * Separate on purpose. loadState() deliberately throws on anything but
   * ENOENT, because a coordinator that starts with no members refuses the whole
   * fleet while looking healthy — and events are appended far more often than
   * hosts are, so a truncated event write must never be able to take the host
   * list down with it.
   *
   * "A phone that was asleep can catch up" was false until this existed: the
   * ring was RAM, so a restart lost every record of who did what.
   */
  #eventsFile() {
    return this.stateFile ? `${this.stateFile}.events` : null;
  }

  loadEvents() {
    const f = this.#eventsFile();
    if (!f) return;
    try {
      const events = JSON.parse(readFileSync(f, 'utf8'));
      if (Array.isArray(events)) this.core.events.push(...events);
    } catch (e) {
      // NOT fatal, unlike the membership list. Losing the history is a shame;
      // refusing to start over it would be worse than the thing it protects.
      if (/** @type {any} */ (e)?.code !== 'ENOENT') {
        this.log.warn(`coordinator: could not read ${f}, starting with no history`);
      }
    }
  }

  saveEvents() {
    const f = this.#eventsFile();
    if (!f) return;
    try {
      writeFileSync(f, JSON.stringify(this.core.events.slice(-500)), { mode: 0o600 });
    } catch (e) {
      this.log.warn(`coordinator: could not save events: ${/** @type {Error} */ (e).message}`);
    }
  }

  /** Write it back. Through a temp file, because a half-written host list is
   *  a fleet that cannot connect. */
  saveState() {
    if (!this.stateFile) return;
    try {
      this.#writeState();
    } catch (e) {
      this.log.error(`coordinator: could not save state to ${this.stateFile}: ${/** @type {Error} */ (e).message}`);
    }
  }

  #writeState() {
    const body = JSON.stringify(
      {
        hosts: this.core.hostIds.serialise(),
        clients: this.core.clients.serialise(),
        invites: this.core.invites.toJSON(),
        enrollment: this.core.enrollment.serialise(),
        devices: [...this.core.devices.values()],
      },
      null,
      2,
    );
    mkdirSync(path.dirname(String(this.stateFile)), { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, `${body}\n`, { mode: 0o600 });
    renameSync(tmp, String(this.stateFile));
  }

  /** @param {number} port @param {string} host */
  async listen(port = 8791, host = '127.0.0.1') {
    this.server = createServer((req, res) => {
      this.#route(req, res).catch((e) => {
        this.log.error('coordinator: unhandled', e);
        json(res, 500, { ok: false, error: 'internal error' });
      });
    });

    attachWebSocketServer(this.server, {
      path: '/host/connect',
      // The same handshake the Worker makes, for the same reason: a host proves
      // it holds the enrolled private key by signing a nonce issued moments
      // ago. There is no shared host token to fall back to, not even on
      // loopback — "it's only dev" is how a shared secret ends up in
      // production, and the sidecar generates its key without being asked.
      authorise: async (req) => {
        const url = new URL(req.url || '/', 'http://placeholder');
        const hostId = url.searchParams.get('hostId') || '';
        const proof = String(req.headers['x-fleet-proof'] || '');
        const nonce = String(req.headers['x-fleet-nonce'] || '');
        const outcome = await this.core.hostIds.prove(hostId, proof, nonce);
        if (outcome.ok) return true;
        this.core.record({ event: 'host.refused', hostId, text: outcome.reason });
        return outcome.reason;
      },
      onConnection: (conn, req) => this.#onHost(conn, req),
    });

    await new Promise((resolve, reject) => {
      this.server?.on('error', reject);
      this.server?.listen(port, host, () => resolve(null));
    });

    this.healthTimer = setInterval(() => this.#pollHealth(), this.healthIntervalMs);
    this.healthTimer.unref?.();
    const address = /** @type {import('node:net').AddressInfo} */ (this.server.address());
    this.log.info(`coordinator: listening on ${host}:${address.port} (protocol v${PROTOCOL_VERSION})`);
    return address.port;
  }

  async close() {
    if (this.eventSaveTimer) clearTimeout(this.eventSaveTimer);
    this.saveEvents();
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const [, waiter] of this.pending) clearTimeout(waiter.timer);
    this.pending.clear();
    for (const conn of this.connections.values()) {
      try {
        conn.close(1001, 'coordinator shutting down');
      } catch { /* best effort */ }
    }
    this.connections.clear();
    this.server?.closeAllConnections?.();
    await new Promise((r) => (this.server ? this.server.close(() => r(null)) : r(null)));
  }

  // --- hosts ---------------------------------------------------------------

  /**
   * @param {import('../ws.js').WsConnection} conn
   * @param {import('node:http').IncomingMessage} req
   */
  #onHost(conn, req) {
    const url = new URL(req.url || '/', 'http://placeholder');
    const hostId = url.searchParams.get('hostId') || '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(hostId)) {
      conn.close(1008, 'hostId missing or malformed');
      return;
    }

    // Retire the connection this one replaces, before registering the new
    // one — same rule as the Worker. Two sockets for one host means the
    // loser's close clobbers the winner's registration.
    const previous = this.connections.get(hostId);
    if (previous && previous !== conn) {
      try { previous.close(1012, 'superseded'); } catch { /* already gone */ }
    }
    this.core.hostConnected(hostId, (msg) => conn.send(JSON.stringify(msg)));
    this.connections.set(hostId, conn);

    conn.on('message', (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        this.log.warn(`coordinator: ${hostId} sent a non-JSON frame`);
        return;
      }
      void this.core.onHostMessage(hostId, msg);
    });
    conn.on('close', (code, reason) => {
      // Only the CURRENT socket's fate is the host's fate. The map delete was
      // already guarded; the hostDisconnected beside it was NOT — so the close
      // of a superseded socket, landing after its replacement connected, still
      // marked a freshly-connected host offline in the registry. Connected in
      // every log, routed to by nothing.
      if (this.connections.get(hostId) !== conn) return;
      this.connections.delete(hostId);
      this.core.hostDisconnected(hostId, `socket closed: ${code}${reason ? ` ${reason}` : ''}`);
    });
    conn.on('error', (e) => this.log.warn(`coordinator: ${hostId} socket error: ${e.message}`));

    // Ask immediately rather than waiting out the first interval, so a freshly
    // connected host is schedulable in milliseconds instead of ~15 seconds.
    void this.#askHealth(hostId);
  }


  /** @param {string} hostId */
  async #askHealth(hostId) {
    const host = this.registry.hosts.get(hostId);
    if (!host?.connected) return;
    const reply = await this.core.send(host, { verb: 'health' }, 10_000).catch(() => null);
    if (reply?.ok && reply.health) this.core.registry.recordHealth(hostId, reply.health);
  }

  #pollHealth() {
    for (const hostId of this.registry.hosts.keys()) void this.#askHealth(hostId);
  }

  /**
   * Route one intent and return the reply. The public entry point — used by the
   * HTTP API and directly by tests.
   *
   * Delegated to the core, which is the same object the Worker uses: placement,
   * fan-out and correlation are decisions, and a decision implemented twice is
   * a decision that will eventually be made two different ways.
   *
   * @param {{ verb: string, params?: Record<string, any>, actor?: string, id?: string, preferHost?: string, requester?: { email?: string|null, admin?: boolean }|null }} spec
   * @returns {Promise<any>}
   */
  async dispatch(spec) {
    return this.core.dispatch(spec);
  }

  // --- the client API ------------------------------------------------------

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async #route(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    // The one deliberately unauthenticated surface (§5), returning liveness and
    // nothing else — no host names, no counts.
    if (p === '/healthz') return json(res, 200, { ok: true, protocol: PROTOCOL_VERSION });

    // The same contract the Worker serves, read from the file rather than
    // inlined, because this process has a filesystem and the Worker does not.
    if (p === '/openapi.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(readFileSync(resource('openapi.json'), 'utf8'));
    }

    // --- enrolment, before the token gate ------------------------------------
    //
    // These three are what an UNAUTHENTICATED machine uses to become an
    // authenticated one, so requiring the API token here would mean every host
    // needed the fleet-wide admin credential to join — exactly the shared
    // secret this rework removes. The pin is the authorisation for the first;
    // a signature is the authorisation for the other two.
    // A CI JOB ENROLLING ITSELF, with no pin and no stored credential.
    //
    // "so user input doesn't work" — a runner has nobody to read a pin to, and
    // the alternative everybody reaches for is a long-lived secret in CI that
    // can admit a host. That secret is readable by every workflow in the
    // repository, survives the job, and cannot say WHICH job used it.
    //
    // GitHub will instead mint a short-lived OIDC token per job, naming the
    // repository, the workflow file and the run. The coordinator already knows
    // how to verify an ID token — this is the same machinery pointed at a
    // different issuer, with an allowlist of REPOSITORIES rather than people,
    // because the subject is a job and not a person.
    //
    // ALWAYS EPHEMERAL, never negotiable. A host admitted this way is a job and
    // will be destroyed with it; letting the request ask for anything else
    // would put "clean me up" back in the hands of the thing being cleaned up.
    if (p === '/api/enroll/actions' && req.method === 'POST') {
      const body = await readJson(req);
      const repositories = splitList(process.env.AGENT_FLEET_ACTIONS_REPOS);
      const audiences = splitList(process.env.AGENT_FLEET_ACTIONS_AUDIENCE);
      if (!repositories.length) {
        return json(res, 503, {
          ok: false,
          error: { code: 'not_configured' },
          text: 'This coordinator does not admit CI runners. Set AGENT_FLEET_ACTIONS_REPOS to the repositories that may.',
        });
      }

      let job;
      try {
        job = await verifyActionsToken(String(body?.token || ''), {
          // A constant both sides agree on, so a token minted for some other
          // service cannot be replayed here. The workflow asks GitHub for a
          // token with this audience; anything else fails the check before a
          // repository is even looked at.
          audiences: audiences.length ? audiences : [DEFAULT_ACTIONS_AUDIENCE],
          repositories,
          workflowRef: process.env.AGENT_FLEET_ACTIONS_WORKFLOW || null,
        });
      } catch (e) {
        return json(res, 403, { ok: false, error: { code: 'bad_token' }, text: /** @type {Error} */ (e).message });
      }

      // THE HOST ID IS DERIVED, NOT ACCEPTED. A job that could choose its own
      // name could choose a permanent host's, and re-enrolment REPLACES a key —
      // so a workflow would be able to take over a real box. run_attempt is in
      // it because a re-run reuses run_id.
      const hostId = `gha-${job.repository.replace(/[^A-Za-z0-9]+/g, '-')}-${job.runId}-${job.runAttempt}`;

      // WHOSE RUNNER IT IS. A fleet may have several people wanting one at
      // once, and an unowned temporary host is one everybody sees and nobody
      // is responsible for. The OIDC token names the account that triggered
      // the run — trustworthy, because GitHub signed it — and a configured map
      // turns that into a fleet identity.
      //
      // Unmapped is a REFUSAL, not an ownerless host. "I cannot tell who this
      // belongs to" and "it belongs to nobody" are different facts, and only
      // one of them should put a machine in somebody's fleet.
      const owner = ownerForGithubActor(job.actor);
      if (!owner) {
        return json(res, 403, {
          ok: false,
          error: { code: 'unknown_actor' },
          text:
            `${job.actor || 'that account'} is not mapped to anyone on this fleet. ` +
            'Add it to AGENT_FLEET_ACTIONS_OWNERS as github-login=email.',
        });
      }

      const result = await this.core.hostIds.enrol({
        hostId,
        publicJwk: body?.publicJwk,
        enrolledBy: `actions:${job.repository}`,
        owner,
        ephemeral: true,
      });
      this.saveState();
      if (!result.ok || !result.host) {
        return json(res, 400, { ok: false, error: { code: 'bad_request' }, text: result.error });
      }
      this.core.record({
        event: 'host.enrolled',
        hostId: result.host.hostId,
        fingerprint: result.host.fingerprint,
        text: `a runner from ${job.repository} (${job.workflowRef}) enrolled itself`,
      });
      return json(res, 200, { ok: true, hostId, fingerprint: result.host.fingerprint, ephemeral: true });
    }

    if (p === '/api/enroll/host' && req.method === 'POST') {
      const body = await readJson(req);
      const wanted = String(body?.hostId || '');
      const spent = await this.core.enrollment.redeem(String(body?.code || ''), 'host', wanted);
      if (!spent.ok) {
        this.saveState(); // a spent code must not survive a restart
        return json(res, 403, { ok: false, error: { code: 'bad_code' }, text: spent.reason });
      }

      const result = await this.core.hostIds.enrol({
        hostId: wanted,
        publicJwk: body?.publicJwk,
        enrolledBy: spent.entry.actor,
        // "Since they are ephemeral they belong to the user whose token started
        // em." The pin IS that token: it was minted by one person, for one
        // machine, and the actor travelled with it all along. Only recorded for
        // an ephemeral host — a permanent box is the fleet's, and one person
        // owning it would mean nobody else could work.
        owner: spent.entry.ephemeral ? emailOf(spent.entry.actor) : null,
        readmit: spent.entry.readmit,
        boundToThisHost: Boolean(spent.entry.hostId),
      });
      // Saved either way: the code was spent above whether or not the key that
      // arrived with it was any good, and a spent code that comes back after a
      // restart is a second host nobody minted.
      this.saveState();
      if (!result.ok || !result.host) {
        return json(res, 400, { ok: false, error: { code: 'bad_request' }, text: result.error });
      }
      this.core.record({ event: 'host.enrolled', hostId: result.host.hostId, fingerprint: result.host.fingerprint });

      // A re-enrolment REPLACES the key, and the machine holding the old one may
      // still be connected on this name. Two machines as one host is the worst
      // shape this can take: the old one keeps answering intents addressed to a
      // name whose key it no longer holds. Same close the Worker does.
      if (result.replaced) this.connections.get(result.host.hostId)?.close(1008, 're-enrolled');
      return json(res, 200, {
        ok: true,
        hostId: result.host.hostId,
        fingerprint: result.host.fingerprint,
        replaced: result.replaced,
        text: result.readmitted
          ? `Readmitted ${result.host.hostId}, which had been revoked.`
          : result.replaced
            ? `Re-enrolled ${result.host.hostId}. The previous key no longer works.`
            : `Enrolled ${result.host.hostId}.`,
      });
    }

    // Signing in: the one route that takes an identity token rather than a
    // fleet credential, because it is where a fleet credential comes from.
    // Identical in shape to the Worker's — the apps must not be able to tell
    // which coordinator they are talking to.
    if (p === '/api/session' && req.method === 'POST') {
      const body = await readJson(req);
      const issuers = splitList(process.env.AGENT_FLEET_AUTH_ISSUERS);
      const audiences = splitList(process.env.AGENT_FLEET_AUTH_AUDIENCES);
      const allow = splitList(process.env.AGENT_FLEET_AUTH_ALLOW);
      if (!issuers.length || !audiences.length) {
        return json(res, 503, { ok: false, error: { code: 'not_configured' }, text: 'This coordinator has no sign-in configured.' });
      }

      let who;
      try {
        who = await verifyIdToken(String(body?.idToken || ''), { issuers, audiences });
      } catch (e) {
        return json(res, 401, { ok: false, error: { code: 'unauthorised' }, text: String(/** @type {Error} */ (e).message) });
      }
      if (isPrivateRelay(who.email)) {
        return json(res, 403, {
          ok: false,
          error: { code: 'private_relay' },
          text:
            'Sign in again and choose "Share My Email". This coordinator allows people by email domain, ' +
            'and a hidden Apple address can never match one.',
        });
      }
      // EITHER LIST. The env one says who this deployment belongs to and
      // survives losing all state; the invited one says who they have let in
      // since, and needs no deploy. See invites.js for why they stay separate.
      if (!isAllowed(who.email, allow) && !this.core.invites.has(who.email)) {
        return json(res, 403, { ok: false, error: { code: 'not_allowed' }, text: `${who.email} is not on this fleet's list.` });
      }

      const issued = await this.core.issueClient(who, body?.deviceName ? String(body.deviceName) : undefined);
      this.saveState();
      return json(res, 200, { ok: true, ...issued });
    }

    // Apple's server-to-server notification.
    //
    // PUBLIC BY NECESSITY — Apple has no credential of ours, and the signature
    // on the JWT is the whole authentication. Anyone can POST here; only a
    // message signed by Apple, for our audience, does anything.
    //
    // It answers 200 to everything it can parse, including notifications it
    // ignores, because Apple retries on failure and there is nothing to gain
    // from making it retry a message we understood and did not act on.
    if (p === '/apple/notifications' && req.method === 'POST') {
      const body = await readJson(req);
      const audiences = splitList(process.env.AGENT_FLEET_AUTH_AUDIENCES);
      if (!audiences.length) return json(res, 503, { ok: false, text: 'no audience configured' });
      try {
        const note = await verifyAppleNotification(String(body?.payload || ''), { audiences });
        if (isWithdrawal(note.type) && note.email) {
          const r = this.core.revokePerson(note.email, `withdrew consent at Apple (${note.type})`);
          if (r.revoked) this.saveState();
        }
        return json(res, 200, { ok: true });
      } catch (e) {
        this.log.warn(`apple notification refused: ${/** @type {Error} */ (e).message}`);
        return json(res, 401, { ok: false, text: 'that notification did not verify' });
      }
    }

    if (p === '/api/host/challenge' && req.method === 'POST') {
      const body = await readJson(req);
      return json(res, 200, { ok: true, nonce: await this.core.hostIds.challenge(String(body?.hostId || '')) });
    }

    if (p === '/api/host/verify' && req.method === 'POST') {
      const body = await readJson(req);
      const outcome = await this.core.hostIds.prove(
        String(body?.hostId || ''),
        String(body?.proof || ''),
        String(body?.nonce || ''),
      );
      if (!outcome.ok) return json(res, 401, { ok: false, text: outcome.reason });
      return json(res, 200, { ok: true, hostId: outcome.host.hostId, fingerprint: outcome.host.fingerprint });
    }

    // THE GITHUB CALLBACK. GitHub redirects a BROWSER here, which carries no
    // fleet credential — `state` is what stands in for one: unguessable,
    // single-use, minutes-long, and bound to the host and person who started
    // the flow. Both coordinators serve it, because a client that works
    // against one and not the other is exactly what openapi.json exists to
    // prevent.
    if (p === '/oauth/github/callback' && req.method === 'GET') {
      const result = await this.core.finishGithubAuthorization({
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        origin: `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost'}`,
      });
      res.writeHead(result.ok ? 200 : 400, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      // HTML, not JSON: a person was sent here by a browser, and a raw object
      // on screen is how a working flow looks broken.
      res.end(callbackPage(result));
      return undefined;
    }

    // Two ways to be allowed past here, and they are not the same thing.
    //
    // A per-device credential is the everyday one: issued at sign-in, named
    // after the person who holds it, revocable on its own. The admin token is
    // break-glass — it can stop every session in the fleet — and exists to mint
    // the first pin and to get back in when nothing else works.
    const presented = credentialFrom(req.headers.authorization, url);
    let client = null;
    if (isClientCredential(presented)) {
      client = await this.core.clients.verify(presented);
      if (!client) {
        return json(res, 401, { ok: false, error: { code: 'unauthorised' }, text: 'That device credential is not valid.' });
      }
    } else if (this.apiToken && !safeEqual(presented, this.apiToken)) {
      return json(res, 401, { ok: false, error: { code: 'unauthorised' }, text: 'a token is required' });
    } else if (!this.apiToken && presented) {
      // Nothing configured and something presented: refuse rather than wave it
      // through, or a fleet that forgot to set a token looks authenticated.
      return json(res, 401, { ok: false, error: { code: 'unauthorised' }, text: 'this coordinator has no admin token set' });
    }

    // The destructive routes, checked BEFORE any of them run. The first version
    // of this sat further down the file, after the /api/hosts/ DELETE handler
    // it was supposed to guard, so it never fired — a check placed after the
    // thing it guards, which is on this project's own review checklist.
    //
    // A device credential needs the admin bit; the
    // break-glass token always passes, because it is what you use when the
    // admin's phone is the thing that got lost.
    if (DESTRUCTIVE.test(p) && req.method === 'DELETE' && client && !client.admin) {
      return json(res, 403, {
        ok: false,
        error: { code: 'not_admin' },
        text: 'Removing machines and other people\u2019s devices needs an admin credential on this fleet.',
      });
    }

    // INVITING IS ADMIN, IN EVERY DIRECTION — reading the list included,
    // because a list of who has been invited is a list of colleagues, and a
    // member has no reason to hold one. An invited person is a member and
    // cannot invite anybody else; otherwise "invite" would be a way to hand out
    // the fleet, one step removed. See src/fleet/coordinator/invites.js.
    if (p.startsWith('/api/invites') && client && !client.admin) {
      return json(res, 403, {
        ok: false,
        error: { code: 'not_admin' },
        text: 'Inviting people to this fleet needs an admin credential.',
      });
    }

    if (p === '/api/invites' && req.method === 'GET') {
      return json(res, 200, { ok: true, invites: this.core.invites.list() });
    }

    if (p === '/api/invites' && req.method === 'POST') {
      const body = await readJson(req);
      const r = this.core.invites.add(String(body?.email || ''), {
        invitedBy: client?.email || 'admin',
        note: body?.note ? String(body.note) : null,
      });
      if (r.ok) this.saveState();
      // BEST EFFORT, AND SAID EITHER WAY. The list is the authority and the
      // mail is a courtesy: an invitation whose email bounced is still an
      // invitation, which is why `add` has already succeeded by here. What the
      // reply must not do is imply an email went when it did not — the whole
      // point of sending one is that the person knows which address to use.
      const posted = r.ok
        ? await sendInvite(this.core.mailer, {
          email: r.invite?.email ?? '',
          fleet: inviteFleetName(),
          invitedBy: client?.email || 'admin',
          note: r.invite?.note ?? null,
          apps: inviteApps(),
        })
        : { sent: false, why: 'not invited' };
      const text = r.ok
        ? `${r.message}${posted.sent ? '\nAn email is on its way to them.' : `\nNo email sent — ${posted.why}. Send them the app yourself.`}`
        : r.message;
      return json(res, r.ok ? 200 : 400, { ...r, text, invites: this.core.invites.list() });
    }

    if (p.startsWith('/api/invites/') && req.method === 'DELETE') {
      const r = this.core.invites.remove(decodeURIComponent(p.slice('/api/invites/'.length)));
      if (r.ok) this.saveState();
      return json(res, r.ok ? 200 : 404, { ...r, invites: this.core.invites.list() });
    }

    if (p === '/api/hosts' && req.method === 'GET') {
      // core.snapshot(), the same call the Worker makes, so the two
      // coordinators answer in the SAME SHAPE. They did not: this returned
      // {ok, hosts} while the Worker returned {ok, protocol, hosts, devices,
      // events}. A client that works against one and not the other makes
      // "the same code runs in both places" false in the only place a client
      // can see — and the apps have to hold both shapes in their head.
      // WHO IS ASKING. This route used to answer the same for everybody,
      // which meant the visibility filter on `list` was enforced one route
      // over while this one returned every session on every box.
      return json(res, 200, { ok: true, ...this.core.snapshot(requesterFor(client)) });
    }

    // The event ring. The Worker has had this since push was built and the Node
    // coordinator never did — the fifth parity gap on this branch, and the one
    // that made the case for openapi.json: it was found by listing both route
    // tables side by side, in about ten seconds, after four others had been
    // found the hard way.
    if (p === '/api/events' && req.method === 'GET') {
      return json(res, 200, { ok: true, events: this.core.recentEvents(requesterFor(client)) });
    }

    if (p === '/api/hosts/enrolled' && req.method === 'GET') {
      return json(res, 200, { ok: true, hosts: this.core.hostIds.list() });
    }

    if (p.startsWith('/api/hosts/') && req.method === 'DELETE') {
      const hostId = decodeURIComponent(p.slice('/api/hosts/'.length));
      // Revoking twice is agreement, not an error. This used to answer 404
      // "is not enrolled" for a host that IS enrolled and revoked — so a person
      // whose first tap seemed not to work (the list bug in hosts.js) tapped
      // again and was told the host did not exist, while still looking at it.
      const existing = this.core.hostIds.hosts.get(hostId);
      if (existing?.revokedAt) {
        return json(res, 200, { ok: true, text: `${hostId} was already revoked.` });
      }
      const gone = this.core.hostIds.revoke(hostId);
      if (gone) {
        // Revoked AND disconnected. A revoked host holding a live socket is
        // still in the fleet until something closes it.
        this.connections.get(hostId)?.close(1008, 'revoked');
        this.core.record({ event: 'host.revoked', hostId });
        this.saveState();
      }
      return json(res, gone ? 200 : 404, {
        ok: gone,
        text: gone ? `${hostId} is revoked and disconnected.` : `${hostId} is not enrolled.`,
      });
    }


    if (p === '/api/clients' && req.method === 'GET') {
      return json(res, 200, { ok: true, clients: this.core.clients.list() });
    }

    if (p.startsWith('/api/clients/') && req.method === 'DELETE') {
      const id = p.slice('/api/clients/'.length);
      const { revoked, devices } = this.core.revokeClient(id);
      if (revoked || devices) this.saveState();
      return json(res, revoked ? 200 : 404, {
        ok: revoked,
        text: revoked
          ? `Revoked${devices ? `, and stopped ${devices} push registration${devices === 1 ? '' : 's'}` : ''}.`
          : 'No such client, or already revoked.',
      });
    }

    if (p === '/api/enroll' && req.method === 'GET') {
      return json(res, 200, { ok: true, codes: this.core.enrollment.outstanding() });
    }

    if (p === '/api/enroll' && req.method === 'POST') {
      const body = await readJson(req);
      const kind = body?.kind === 'device' ? 'device' : 'host';
      // Six digits is small enough to read down a phone and small enough to
      // guess, so the guessing is what has to be bounded — see enrollment.js.
      const issued = this.core.enrollment.mint({
        purpose: kind,
        label: body?.label ? String(body.label) : '',
        actor: client?.email || (body?.actor ? String(body.actor) : null),
        hostId: body?.hostId ? String(body.hostId) : null,
        readmit: Boolean(body?.readmit),
        // EPHEMERAL IS DECIDED WHEN THE PIN IS MINTED, which is the whole
        // design (docs/ephemeral-hosts.md) — a host that could declare itself
        // temporary is a host that could decline to be cleaned up. mint() has
        // accepted this since the framework was built; the HTTP layer dropped
        // it, so every runner enrolled as a PERMANENT host and its entry
        // survived the job that created it. One corpse per build, and the
        // retirement code that exists to prevent exactly that never ran.
        ephemeral: Boolean(body?.ephemeral),
      });
      this.saveState();
      return json(res, 200, { ok: true, ...issued });
    }

    // Push registration. The Worker has had these since push was built; the
    // Node coordinator never did, so a phone pointed at a box registered
    // against a 404 and then waited for notifications that had nowhere to come
    // from. Both apps call this on every launch.
    if (p === '/api/devices' && req.method === 'POST') {
      const body = await readJson(req);
      const r = this.core.registerDevice({
        platform: String(body?.platform || ''),
        token: String(body?.token || ''),
        actor: client?.email || (body?.actor ? String(body.actor) : undefined),
        clientId: client?.id,
      });
      if (r.ok) this.saveState();
      return json(res, r.ok ? 200 : 400, r);
    }

    if (p === '/api/devices' && req.method === 'DELETE') {
      const body = await readJson(req);
      const { ok: gone } = this.core.unregisterDevice(String(body?.token || ''));
      if (gone) this.saveState();
      return json(res, gone ? 200 : 404, {
        ok: gone,
        text: gone ? 'This device will not be notified again.' : 'That device was not registered.',
      });
    }

    if (p === '/api/devices/test' && req.method === 'POST') {
      const body = await readJson(req);
      const r = await this.core.testPush(body?.token ? String(body.token) : undefined);
      return json(res, r.ok ? 200 : 400, r);
    }

    if (p === '/api/intent' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body || typeof body.verb !== 'string') {
        return json(res, 400, { ok: false, error: { code: 'bad_request' }, text: 'send {verb, params}' });
      }
      const reply = await this.dispatch({
        verb: body.verb,
        params: body.params && typeof body.params === 'object' ? body.params : {},
        // The client's own identity wins over anything the request claims: an
        // actor a caller can choose is a label, not an attribution. Same rule
        // as the Worker's, because a session record that means one thing on one
        // coordinator and another thing on the other means nothing.
        actor: client?.email || (typeof body.actor === 'string' ? body.actor : undefined),
        // An idempotency key supplied by the caller is honoured, so a phone that
        // retries a `start` gets the original outcome rather than a second
        // session. One we mint is unique per call, which is right for a first
        // attempt and useless for a retry — that is the caller's to own.
        id: typeof body.id === 'string' ? body.id : undefined,
        // Which host, when the person picked one in the app. A placement
        // preference, never an intent parameter — see scheduler.js.
        preferHost: typeof body.host === 'string' ? body.host : undefined,
        // The VERIFIED caller, for visibility. Null for the break-glass token,
        // which sees everything — it is what you hold when identity is broken.
        requester: requesterFor(client),
      });
      // A `connect` reply carries the host's catalogue, which offers the paste
      // route because a host knows nothing about a GitHub App. Only the
      // coordinator can improve on that, and it rewrites the one entry it can.
      return json(
        res,
        200,
        body.verb === 'connect'
          ? this.core.offerGithubApp(
              reply,
              typeof body.host === 'string' ? body.host : (reply?.hostId ?? ''),
              client?.email ?? null,
              `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost'}`,
            )
          : reply,
      );
    }

    // Shortcut-friendly shorthand: GET /api/<verb>/<name>. §7 asks for flat
    // JSON and a single round trip, because the caller is as often a spoken
    // phrase routed through "Get Contents of URL" as it is an app.
    const shorthand = p.match(/^\/api\/(list|status|peek|resume|stop|start|health)(?:\/([A-Za-z0-9][A-Za-z0-9_-]{0,39}))?$/);
    if (shorthand && (req.method === 'GET' || req.method === 'POST')) {
      const [, verb, name] = shorthand;
      /** @type {Record<string, any>} */
      const params = name ? { name } : {};
      const choice = url.searchParams.get('choice');
      if (verb === 'resume' && choice) params.choice = choice;
      return json(res, 200, await this.dispatch({
        verb,
        params,
        actor: client?.email || url.searchParams.get('actor') || undefined,
        // THE SHORTHAND IS NOT A BACK DOOR. It omitted `requester` entirely,
        // so `stop`, `resume` and `peek` reached any member's session by name
        // — the ownership check in the scheduler is skipped when there is
        // nobody to check against.
        requester: requesterFor(client),
      }));
    }

    return json(res, 404, { ok: false, error: { code: 'not_found' } });
  }
}

// --- helpers ----------------------------------------------------------------

/** The routes that remove something somebody else depends on. */
const DESTRUCTIVE = /^\/api\/(hosts|clients)\//;

/** Comma or whitespace separated, the same shape the Worker reads from its env. */
/**
 * The email inside an actor string, or null.
 *
 * Actors arrive as `fleet:<email>` when the coordinator verified one, and as
 * anything else when it did not. Only the verified form names a person.
 *
 * @param {string|null|undefined} actor
 */
function emailOf(actor) {
  const s = String(actor || '');
  return s.startsWith('fleet:') ? s.slice('fleet:'.length).toLowerCase() || null : null;
}

/**
 * The fleet identity behind a GitHub login.
 *
 * AGENT_FLEET_ACTIONS_OWNERS is `login=email,login=email`. A map rather than a
 * claim in the request, because the request is made by the runner and a runner
 * must not be able to say whose it is.
 *
 * @param {string} login
 */
function ownerForGithubActor(login) {
  const wanted = String(login || '').toLowerCase();
  if (!wanted) return null;
  for (const pair of splitList(process.env.AGENT_FLEET_ACTIONS_OWNERS)) {
    const [name, email] = pair.split('=').map((x) => x.trim().toLowerCase());
    if (name && email && name === wanted) return email;
  }
  return null;
}


/** @param {string|undefined} value */
function splitList(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}


/** @param {unknown} a @param {unknown} b */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * The identity an authorisation check is made against.
 *
 * `null` means "no client at all", which is the break-glass token — what you
 * hold when identity itself is broken, and deliberately unfiltered. Every
 * other route must pass this rather than omitting it: a missing requester is
 * read as "do not filter", so forgetting it is the fail-OPEN direction.
 *
 * @param {{ email?: string|null, admin?: boolean }|null|undefined} client
 */
function requesterFor(client) {
  return client ? { email: client.email ?? null, admin: Boolean(client.admin) } : null;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, any>|null>}
 */
function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 256 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** What to call this fleet in an invitation. */
function inviteFleetName() {
  return process.env.AGENT_FLEET_NAME || 'this Fleetwright fleet';
}

/** Where to get the app, per phone. See appLines in invite-email.js. */
function inviteApps() {
  return {
    ios: process.env.AGENT_FLEET_APP_IOS || null,
    android: process.env.AGENT_FLEET_APP_ANDROID || null,
  };
}
