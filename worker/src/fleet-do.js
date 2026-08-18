// The Durable Object that IS the fleet.
//
// It holds every host's WebSocket, the registry built from what they report,
// and the device registrations push goes to. One instance, so there is exactly
// one place that knows the fleet — which is also the only way the "resume is
// pinned to the box holding the volume" rule can be enforced at all.
//
// The logic is CoordinatorCore, shared verbatim with the Node coordinator. What
// is here is the parts that are genuinely Cloudflare: WebSocket hibernation,
// storage, and alarms.
//
// HIBERNATION MATTERS MORE THAN IT LOOKS. A fleet host holds its socket open
// for weeks and says almost nothing. Without `acceptWebSocket`, that idle
// socket would keep this object in memory the entire time and bill for it. With
// it, the object is evicted between messages and rebuilt on the next one —
// which is why the registry is reconstructed from what hosts report rather than
// held as the authority. That constraint and design.md §3's "the registry is a
// cache with provenance, never the authority" happen to be the same rule, which
// is a good sign the rule was right.

import { CoordinatorCore } from '../../src/fleet/coordinator/core.js';
import { pusherFromEnv } from '../../src/fleet/push.js';

/** How often to ask hosts for health if they have gone quiet. */
const ALARM_MS = 30_000;

export class Fleet {
  /**
   * @param {DurableObjectState} state
   * @param {Record<string, string|undefined>} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;
    const logger = {
      info: (/** @type {any[]} */ ...a) => console.log(...a),
      warn: (/** @type {any[]} */ ...a) => console.warn(...a),
      error: (/** @type {any[]} */ ...a) => console.error(...a),
      debug: () => {},
    };
    this.core = new CoordinatorCore({
      logger,
      push: pusherFromEnv(env, logger),
      // A Worker request cannot outlive its invocation the way a Node process
      // can, so an intent waits far less long here than on a box.
      intentTimeoutMs: 60_000,
    });

    // Rebuilt on wake: hibernation means this object is evicted between
    // messages, and every socket that is still open comes back with the host id
    // we attached to it.
    this.state.blockConcurrencyWhile(async () => {
      const devices = (await this.state.storage.get('devices')) || [];
      for (const device of /** @type {any[]} */ (devices)) this.core.devices.set(device.token, device);
      for (const socket of this.state.getWebSockets()) {
        const hostId = this.#hostIdOf(socket);
        if (hostId) this.core.hostConnected(hostId, (msg) => socket.send(JSON.stringify(msg)));
      }
    });
  }

  /** @param {WebSocket} socket */
  #hostIdOf(socket) {
    try {
      return /** @type {any} */ (this.state.getTags?.(socket) || [])[0] || socket.deserializeAttachment?.()?.hostId || null;
    } catch {
      return null;
    }
  }

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/host/connect') return this.#acceptHost(request, url);

    if (url.pathname === '/api/hosts' && request.method === 'GET') {
      return json({ ok: true, ...this.core.snapshot() });
    }

    if (url.pathname === '/api/events' && request.method === 'GET') {
      // What a phone asks for when it opens, having been asleep while things
      // happened. Push wakes it; this tells it what it missed.
      return json({ ok: true, events: this.core.events.slice(-50) });
    }

    if (url.pathname === '/api/devices' && request.method === 'POST') {
      const body = await readJson(request);
      const r = this.core.registerDevice({
        platform: String(body?.platform || ''),
        token: String(body?.token || ''),
        actor: body?.actor ? String(body.actor) : undefined,
      });
      if (r.ok) await this.#saveDevices();
      return json(r, r.ok ? 200 : 400);
    }

    if (url.pathname === '/api/devices' && request.method === 'DELETE') {
      const body = await readJson(request);
      const r = this.core.unregisterDevice(String(body?.token || ''));
      await this.#saveDevices();
      return json(r);
    }

    if (url.pathname === '/api/intent' && request.method === 'POST') {
      const body = await readJson(request);
      if (!body || typeof body.verb !== 'string') {
        return json({ ok: false, error: { code: 'bad_request' }, text: 'send {verb, params}' }, 400);
      }
      return json(
        await this.core.dispatch({
          verb: body.verb,
          params: body.params && typeof body.params === 'object' ? body.params : {},
          actor: typeof body.actor === 'string' ? body.actor : undefined,
          // A caller-supplied idempotency key is honoured, so a phone that
          // retries a `start` gets the original outcome rather than a second
          // session.
          id: typeof body.id === 'string' ? body.id : undefined,
        }),
      );
    }

    // Shortcut-friendly shorthand: GET /api/<verb>/<name>. §7 wants flat JSON
    // and one round trip, because the caller is as often a spoken phrase routed
    // through "Get Contents of URL" as it is an app.
    const shorthand = url.pathname.match(
      /^\/api\/(list|status|peek|resume|stop|start|health)(?:\/([A-Za-z0-9][A-Za-z0-9_-]{0,39}))?$/,
    );
    if (shorthand) {
      const [, verb, name] = shorthand;
      /** @type {Record<string, any>} */
      const params = name ? { name } : {};
      const choice = url.searchParams.get('choice');
      if (verb === 'resume' && choice) params.choice = choice;
      return json(await this.core.dispatch({ verb, params, actor: url.searchParams.get('actor') || undefined }));
    }

    return json({ ok: false, error: { code: 'not_found' } }, 404);
  }

  /** @param {Request} request @param {URL} url */
  async #acceptHost(request, url) {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }
    const hostId = url.searchParams.get('hostId') || '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(hostId)) {
      return new Response('hostId missing or malformed', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernatable, and tagged with the host id so the socket can be matched
    // back to its host after this object has been evicted and rebuilt.
    this.state.acceptWebSocket(server, [hostId]);
    server.serializeAttachment?.({ hostId });

    this.core.hostConnected(hostId, (msg) => server.send(JSON.stringify(msg)));
    await this.state.storage.setAlarm(Date.now() + ALARM_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** @param {WebSocket} socket @param {string|ArrayBuffer} message */
  async webSocketMessage(socket, message) {
    const hostId = this.#hostIdOf(socket);
    if (!hostId) return;
    let parsed;
    try {
      parsed = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      console.warn(`fleet: ${hostId} sent a non-JSON frame`);
      return;
    }
    await this.core.onHostMessage(hostId, parsed);
    // A push that reported dead tokens is the only chance to drop them; the
    // provider will not tell us again.
    await this.#saveDevices();
  }

  /** @param {WebSocket} socket @param {number} code @param {string} reason */
  async webSocketClose(socket, code, reason) {
    const hostId = this.#hostIdOf(socket);
    if (hostId) this.core.hostDisconnected(hostId, `socket closed: ${code}${reason ? ` ${reason}` : ''}`);
  }

  /** @param {WebSocket} socket @param {any} error */
  async webSocketError(socket, error) {
    const hostId = this.#hostIdOf(socket);
    if (hostId) this.core.hostDisconnected(hostId, `socket error: ${error?.message ?? error}`);
  }

  /**
   * Hosts push their own health, so this is a backstop rather than the
   * mechanism: it re-arms while any socket is open, and asks anything that has
   * gone quiet. A DO alarm is far too coarse to poll on.
   */
  async alarm() {
    const sockets = this.state.getWebSockets();
    if (!sockets.length) return;
    for (const host of this.core.registry.schedulable()) {
      // Only the ones we have not heard from recently; a healthy host is
      // already telling us.
      const age = Date.now() - (host.healthAt ?? 0);
      if (age > ALARM_MS) void this.core.send(host, { verb: 'health' }, 10_000).catch(() => {});
    }
    await this.state.storage.setAlarm(Date.now() + ALARM_MS);
  }

  async #saveDevices() {
    await this.state.storage.put('devices', [...this.core.devices.values()]);
  }
}

/** @param {unknown} body @param {number} [status] */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** @param {Request} request */
async function readJson(request) {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? /** @type {any} */ (parsed) : null;
  } catch {
    return null;
  }
}
