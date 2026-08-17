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
import { HostRegistry } from './registry.js';
import { place } from './scheduler.js';
import { PROTOCOL_VERSION, VERBS, buildIntent } from '../protocol/intents.js';

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
    this.registry = new HostRegistry();
    /** @type {Map<string, { resolve: (reply: any) => void, timer: NodeJS.Timeout }>} */
    this.pending = new Map();
    /** @type {import('node:http').Server|null} */
    this.server = null;
    /** @type {NodeJS.Timeout|null} */
    this.healthTimer = null;
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
    for (const host of this.registry.hosts.values()) {
      try {
        /** @type {any} */ (host).conn?.close(1001, 'coordinator shutting down');
      } catch { /* best effort */ }
    }
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

    this.log.info(`coordinator: ${hostId} connected`);
    this.registry.connect(hostId, (msg) => conn.send(JSON.stringify(msg)));
    /** @type {any} */ (this.registry.hosts.get(hostId)).conn = conn;

    conn.on('message', (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        this.log.warn(`coordinator: ${hostId} sent a non-JSON frame`);
        return;
      }
      this.#onHostMessage(hostId, msg);
    });
    conn.on('close', (code, reason) => {
      this.log.warn(`coordinator: ${hostId} disconnected (${code}${reason ? ` ${reason}` : ''})`);
      this.registry.disconnect(hostId, `socket closed: ${code}${reason ? ` ${reason}` : ''}`);
    });
    conn.on('error', (e) => this.log.warn(`coordinator: ${hostId} socket error: ${e.message}`));

    // Ask immediately rather than waiting out the first interval, so a freshly
    // connected host is schedulable in milliseconds instead of ~15 seconds.
    void this.#askHealth(hostId);
  }

  /** @param {string} hostId @param {any} msg */
  #onHostMessage(hostId, msg) {
    if (msg?.kind !== 'reply' || typeof msg.id !== 'string') {
      this.log.warn(`coordinator: ${hostId} sent something that is not a reply`);
      return;
    }
    const waiter = this.pending.get(msg.id);
    if (!waiter) {
      // A reply to something we have already given up on. Not an error — the
      // host was slow, not wrong — but worth seeing in a log.
      this.log.debug(`coordinator: late reply from ${hostId} for ${msg.id}`);
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(waiter.timer);
    waiter.resolve({ ...msg, hostId });
  }

  /** @param {string} hostId */
  async #askHealth(hostId) {
    const host = this.registry.hosts.get(hostId);
    if (!host?.connected) return;
    const reply = await this.#send(host, { verb: 'health' }, 10_000).catch(() => null);
    if (reply?.ok && reply.health) this.registry.recordHealth(hostId, reply.health);
  }

  #pollHealth() {
    for (const hostId of this.registry.hosts.keys()) void this.#askHealth(hostId);
  }

  /**
   * Send one intent to one host and await its reply.
   *
   * @param {any} host
   * @param {{ verb: string, params?: Record<string, any>, actor?: string, id?: string }} spec
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  #send(host, spec, timeoutMs = this.intentTimeoutMs) {
    // buildIntent validates before anything reaches the wire. A coordinator bug
    // that produces a malformed intent should fail here, loudly, rather than
    // being refused by every host in the fleet one at a time.
    const intent = buildIntent({
      id: spec.id || randomUUID(),
      verb: spec.verb,
      params: spec.params || {},
      ...(spec.actor ? { actor: spec.actor } : {}),
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(intent.id);
        reject(new Error(`${host.hostId} did not answer ${intent.verb} within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(intent.id, { resolve, timer });
      try {
        host.send(intent);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(intent.id);
        reject(e);
      }
    });
  }

  /**
   * Route one intent and return the reply. The public entry point — used by the
   * HTTP API and directly by tests.
   *
   * @param {{ verb: string, params?: Record<string, any>, actor?: string, id?: string }} spec
   * @returns {Promise<any>}
   */
  async dispatch(spec) {
    if (!Object.prototype.hasOwnProperty.call(VERBS, spec.verb)) {
      return { ok: false, error: { code: 'unknown_verb' }, text: `unknown verb ${JSON.stringify(spec.verb)}` };
    }

    const placement = place(this.registry, spec);
    if (placement.kind === 'refused') {
      return { ok: false, error: { code: placement.code }, text: placement.reason };
    }

    if (placement.kind === 'fanout') {
      const results = await Promise.all(
        (placement.hosts || []).map((h) =>
          this.#send(h, spec)
            .then((r) => ({ hostId: h.hostId, ...r }))
            .catch((e) => ({ hostId: h.hostId, ok: false, text: e.message, error: { code: 'host_timeout' } })),
        ),
      );
      return {
        ok: results.some((r) => r.ok),
        fanout: true,
        // Attribution is not decoration: two hosts can hold sessions with the
        // same name, and a merged list that loses which box each came from
        // cannot be acted on.
        sessions: results.flatMap((r) => (r.sessions || []).map((/** @type {any} */ s) => ({ ...s, hostId: r.hostId }))),
        hosts: results.map(({ hostId, ok, text, error }) => ({ hostId, ok, text, error })),
        text: results.map((r) => `${r.hostId}: ${r.text ?? ''}`).join('\n'),
      };
    }

    try {
      return await this.#send(placement.host, spec);
    } catch (e) {
      return { ok: false, error: { code: 'host_timeout' }, text: /** @type {Error} */ (e).message };
    }
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
      return json(res, 200, { ok: true, hosts: this.registry.list() });
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
