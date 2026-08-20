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
import { verifyIdToken, isAllowed, isPrivateRelay } from './oidc.js';

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
    } catch {
      return; // never enrolled anything yet
    }
    const state = JSON.parse(raw);
    this.core.hostIds.restore(state.hosts || []);
    this.core.clients.restore(state.clients || []);
    this.core.enrollment.restore(state.enrollment || []);
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
        enrollment: this.core.enrollment.serialise(),
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
        const outcome = await this.core.hostIds.prove(hostId, proof);
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
      // Only forget the socket if it is still the current one. A reconnect
      // from the same host replaces the entry before the old socket's close
      // event lands, and deleting unconditionally would drop the live one.
      if (this.connections.get(hostId) === conn) this.connections.delete(hostId);
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
   * @param {{ verb: string, params?: Record<string, any>, actor?: string, id?: string }} spec
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

    // --- enrolment, before the token gate ------------------------------------
    //
    // These three are what an UNAUTHENTICATED machine uses to become an
    // authenticated one, so requiring the API token here would mean every host
    // needed the fleet-wide admin credential to join — exactly the shared
    // secret this rework removes. The pin is the authorisation for the first;
    // a signature is the authorisation for the other two.
    if (p === '/api/enroll/host' && req.method === 'POST') {
      const body = await readJson(req);
      const spent = this.core.enrollment.redeem(String(body?.code || ''), 'host');
      if (!spent.ok) {
        this.saveState(); // a spent code must not survive a restart
        return json(res, 403, { ok: false, error: { code: 'bad_code' }, text: spent.reason });
      }

      const result = await this.core.hostIds.enrol({
        hostId: String(body?.hostId || ''),
        publicJwk: body?.publicJwk,
        enrolledBy: spent.entry.actor,
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
        text: result.replaced
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
      if (!isAllowed(who.email, allow)) {
        return json(res, 403, { ok: false, error: { code: 'not_allowed' }, text: `${who.email} is not on this fleet's list.` });
      }

      const issued = await this.core.issueClient(who, body?.deviceName ? String(body.deviceName) : undefined);
      this.saveState();
      return json(res, 200, { ok: true, ...issued });
    }

    if (p === '/api/host/challenge' && req.method === 'POST') {
      const body = await readJson(req);
      return json(res, 200, { ok: true, nonce: this.core.hostIds.challenge(String(body?.hostId || '')) });
    }

    if (p === '/api/host/verify' && req.method === 'POST') {
      const body = await readJson(req);
      const outcome = await this.core.hostIds.prove(String(body?.hostId || ''), String(body?.proof || ''));
      if (!outcome.ok) return json(res, 401, { ok: false, text: outcome.reason });
      return json(res, 200, { ok: true, hostId: outcome.host.hostId, fingerprint: outcome.host.fingerprint });
    }

    // Two ways to be allowed past here, and they are not the same thing.
    //
    // A per-device credential is the everyday one: issued at sign-in, named
    // after the person who holds it, revocable on its own. The admin token is
    // break-glass — it can stop every session in the fleet — and exists to mint
    // the first pin and to get back in when nothing else works.
    const presented = bearerOf(req.headers.authorization) || url.searchParams.get('token') || '';
    let client = null;
    if (presented.startsWith('fwk_')) {
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

    if (p === '/api/hosts' && req.method === 'GET') {
      // core.snapshot(), the same call the Worker makes, so the two
      // coordinators answer in the SAME SHAPE. They did not: this returned
      // {ok, hosts} while the Worker returned {ok, protocol, hosts, devices,
      // events}. A client that works against one and not the other makes
      // "the same code runs in both places" false in the only place a client
      // can see — and the apps have to hold both shapes in their head.
      return json(res, 200, { ok: true, ...this.core.snapshot() });
    }

    if (p === '/api/hosts/enrolled' && req.method === 'GET') {
      return json(res, 200, { ok: true, hosts: this.core.hostIds.list() });
    }

    if (p.startsWith('/api/hosts/') && req.method === 'DELETE') {
      const hostId = decodeURIComponent(p.slice('/api/hosts/'.length));
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
      const gone = this.core.clients.revoke(id);
      if (gone) this.saveState();
      return json(res, gone ? 200 : 404, { ok: gone, text: gone ? 'Revoked.' : 'No such client, or already revoked.' });
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
      });
      this.saveState();
      return json(res, 200, { ok: true, ...issued });
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
      });
      return json(res, 200, reply);
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
      }));
    }

    return json(res, 404, { ok: false, error: { code: 'not_found' } });
  }
}

// --- helpers ----------------------------------------------------------------

/** Comma or whitespace separated, the same shape the Worker reads from its env. */
/** @param {string|undefined} value */
function splitList(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** @param {string|undefined} header */
function bearerOf(header) {
  const h = header || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

/** @param {unknown} a @param {unknown} b */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
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
