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
import { randomUUID } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { attachWebSocketServer } from '../ws.js';
import { CoordinatorCore } from './core.js';
import { pusherFromEnv } from '../push.js';
import { PROTOCOL_VERSION } from '../protocol/intents.js';

/** How long to wait for a host's reply before giving up on it. */
const DEFAULT_INTENT_TIMEOUT_MS = 320_000;

/** How often to ask each host how it is doing. Must be well under the
 * registry's staleness window, or hosts oscillate into `unknown`. */
const HEALTH_INTERVAL_MS = 15_000;

export class Coordinator {
  /**
   * @param {{
   *   hostToken?: string|null,
   *   apiToken?: string|null,
   *   intentTimeoutMs?: number,
   *   healthIntervalMs?: number,
   *   logger?: typeof import('../../log.js').log,
   * }} [opts]
   */
  constructor({
    hostToken = null,
    apiToken = null,
    intentTimeoutMs = DEFAULT_INTENT_TIMEOUT_MS,
    healthIntervalMs = HEALTH_INTERVAL_MS,
    logger,
  } = {}) {
    this.hostToken = hostToken;
    this.apiToken = apiToken;
    this.intentTimeoutMs = intentTimeoutMs;
    this.healthIntervalMs = healthIntervalMs;
    this.log = logger || { debug() {}, info() {}, warn() {}, error() {} };
    // Everything that carries a decision lives in the core, shared verbatim
    // with the Cloudflare Worker. This class is transport and nothing else.
    this.core = new CoordinatorCore({
      logger: this.log,
      intentTimeoutMs,
      push: pusherFromEnv(process.env, this.log),
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
      authorise: (req) => {
        if (!this.hostToken) return true; // loopback dev; see validateCoordinatorConfig
        const bearer = bearerOf(req.headers.authorization);
        return safeEqual(bearer, this.hostToken) || 'Unauthorized';
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

    if (this.apiToken && !safeEqual(bearerOf(req.headers.authorization) || url.searchParams.get('token') || '', this.apiToken)) {
      return json(res, 401, { ok: false, error: { code: 'unauthorised' }, text: 'a token is required' });
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

    if (p === '/api/intent' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body || typeof body.verb !== 'string') {
        return json(res, 400, { ok: false, error: { code: 'bad_request' }, text: 'send {verb, params}' });
      }
      const reply = await this.dispatch({
        verb: body.verb,
        params: body.params && typeof body.params === 'object' ? body.params : {},
        actor: typeof body.actor === 'string' ? body.actor : undefined,
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
      return json(res, 200, await this.dispatch({ verb, params, actor: url.searchParams.get('actor') || undefined }));
    }

    return json(res, 404, { ok: false, error: { code: 'not_found' } });
  }
}

// --- helpers ----------------------------------------------------------------

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
