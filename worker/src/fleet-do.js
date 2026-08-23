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
import { verifyIdToken, isAllowed, isPrivateRelay } from '../../src/fleet/coordinator/oidc.js';
import { credentialFrom, isClientCredential } from '../../src/fleet/coordinator/credential.js';

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
      this.core.hostIds.restore(/** @type {any[]} */ ((await this.state.storage.get('hostIds')) || []));
      this.core.clients.restore(/** @type {any[]} */ ((await this.state.storage.get('clients')) || []));
      this.core.enrollment.restore(/** @type {any[]} */ ((await this.state.storage.get('enrollment')) || []));
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

    // A device credential, if that is what arrived. worker.js has already
    // established this is not the shared token, so anything reaching here with
    // an fwk_ prefix is either a live client or a revoked one — and a revoked
    // one must be refused rather than falling through to the routes below.
    // credentialFrom, NOT a second extraction. This read the header only, while
    // worker.js also accepted ?token= — so `?token=fwk_` passed the Worker's
    // "let the object judge it" check and arrived here looking like no
    // credential at all, which meant no judging and no refusal.
    const presented = credentialFrom(request.headers.get('authorization'), url);
    let client = null;
    if (isClientCredential(presented)) {
      client = await this.core.clients.verify(presented);
      if (!client) {
        return json({ ok: false, error: { code: 'unauthorised' }, text: 'That device credential is not valid.' }, 401);
      }
    }

    if (url.pathname === '/host/connect') return this.#acceptHost(request, url);

    // --- enrolment ---------------------------------------------------------
    //
    // A machine with no credential asking for one. The code is the whole of the
    // authorisation, which is why it is short-lived and single-use — see
    // enrollment.js.
    if (url.pathname === '/api/enroll/host' && request.method === 'POST') {
      const body = await readJson(request);
      const wanted = String(body?.hostId || '');
      const spent = this.core.enrollment.redeem(String(body?.code || ''), 'host', wanted);
      // Saved either way: a spent code must not come back if this object is
      // evicted between the redemption and the next write.
      await this.#saveEnrollment();
      if (!spent.ok) return json({ ok: false, error: { code: 'bad_code' }, text: spent.reason }, 403);


      const result = await this.core.hostIds.enrol({
        hostId: wanted,
        publicJwk: body?.publicJwk,
        enrolledBy: spent.entry.actor,
        readmit: spent.entry.readmit,
        boundToThisHost: Boolean(spent.entry.hostId),
      });
      if (!result.ok) return json({ ok: false, error: { code: 'bad_request' }, text: result.error }, 400);
      await this.#saveHosts();

      this.core.record({ event: 'host.enrolled', hostId: result.host.hostId, fingerprint: result.host.fingerprint });

      // A re-enrolment REPLACES the key, and the machine holding the old one
      // may still be connected on this name. Leaving that socket open means two
      // machines are one host: the old one keeps answering intents addressed to
      // a name whose key it no longer holds, and which of them a `resume` lands
      // on is whichever the registry saw last. Close it and let whoever holds
      // the current key dial back in.
      if (result.replaced) {
        for (const socket of this.state.getWebSockets()) {
          if (this.#hostIdOf(socket) === result.host.hostId) {
            try {
              socket.close(1008, 're-enrolled');
            } catch { /* already gone */ }
          }
        }
      }
      return json({
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

    // A nonce to sign. Unauthenticated by necessity — it is what an
    // unauthenticated party asks for in order to become authenticated — and it
    // gives nothing away: a nonce is only useful to whoever holds the key.
    if (url.pathname === '/api/host/challenge' && request.method === 'POST') {
      const body = await readJson(request);
      const hostId = String(body?.hostId || '');
      return json({ ok: true, nonce: await this.core.hostIds.challenge(hostId) });
    }

    // The same check `/host/connect` makes, without the socket. `sidecar doctor`
    // asks this so an operator finds out that the key on disk was never enrolled
    // — or was revoked — from a diagnostic that says so, instead of from a
    // reconnect loop in the journal. It reveals nothing a connect attempt would
    // not, and it spends the challenge exactly the same way.
    if (url.pathname === '/api/host/verify' && request.method === 'POST') {
      const body = await readJson(request);
      const outcome = await this.core.hostIds.prove(
        String(body?.hostId || ''),
        String(body?.proof || ''),
        String(body?.nonce || ''),
      );
      if (!outcome.ok) return json({ ok: false, text: outcome.reason }, 401);
      return json({ ok: true, hostId: outcome.host.hostId, fingerprint: outcome.host.fingerprint });
    }

    if (url.pathname === '/api/hosts/enrolled' && request.method === 'GET') {
      return json({ ok: true, hosts: this.core.hostIds.list() });
    }

    if (url.pathname.startsWith('/api/hosts/') && request.method === 'DELETE') {
      const hostId = decodeURIComponent(url.pathname.slice('/api/hosts/'.length));
      const gone = this.core.hostIds.revoke(hostId);
      if (gone) {
        await this.#saveHosts();
        // Disconnected as well as revoked: a revoked host with a live socket is
        // still in the fleet until something closes it, and "revoked" that
        // leaves the machine working is not revoked.
        for (const socket of this.state.getWebSockets()) {
          if (this.#hostIdOf(socket) === hostId) {
            try {
              socket.close(1008, 'revoked');
            } catch { /* already gone */ }
          }
        }
        this.core.hostDisconnected(hostId, 'revoked');
      }
      return json({ ok: gone, text: gone ? `${hostId} is out of the fleet.` : 'No such host, or already revoked.' }, gone ? 200 : 404);
    }

    // Signing in: the one route that takes an identity token rather than a
    // fleet credential, because it is where a fleet credential comes from.
    if (url.pathname === '/api/session' && request.method === 'POST') {
      const body = await readJson(request);
      const issuers = split(this.env.AGENT_FLEET_AUTH_ISSUERS);
      const audiences = split(this.env.AGENT_FLEET_AUTH_AUDIENCES);
      const allow = split(this.env.AGENT_FLEET_AUTH_ALLOW);

      if (!issuers.length || !audiences.length) {
        return json({ ok: false, error: { code: 'not_configured' }, text: 'This coordinator has no sign-in configured.' }, 503);
      }

      let who;
      try {
        who = await verifyIdToken(String(body?.idToken || ''), { issuers, audiences });
      } catch (e) {
        // The reason is returned rather than swallowed: every failure here is
        // something an operator may need to act on, and "sign-in failed" tells
        // them none of it. It reveals nothing a holder of the token does not
        // already have.
        return json({ ok: false, error: { code: 'unauthorised' }, text: String(/** @type {Error} */ (e).message) }, 401);
      }

      if (isPrivateRelay(who.email)) {
        return json(
          {
            ok: false,
            error: { code: 'private_relay' },
            text:
              'Sign in again and choose "Share My Email". This coordinator allows people by email domain, ' +
              'and a hidden Apple address can never match one.',
          },
          403,
        );
      }
      if (!isAllowed(who.email, allow)) {
        return json({ ok: false, error: { code: 'not_allowed' }, text: `${who.email} is not on this fleet's list.` }, 403);
      }

      const issued = await this.core.issueClient(who, body?.deviceName ? String(body.deviceName) : undefined);
      await this.#saveClients();
      return json({ ok: true, ...issued });
    }

    // Minting a pin. Requires an existing credential — this is the operator
    // handing out an invitation, not a way in — and the pin it returns is the
    // only thing shown, once, because it is written down and typed somewhere
    // else.
    if (url.pathname === '/api/enroll' && request.method === 'POST') {
      const body = await readJson(request);
      const kind = body?.kind === 'device' ? 'device' : 'host';
      // Whoever signed in owns the code. A caller using the admin token can
      // name themselves, and if they do not, the event says so — an enrolment
      // nobody is attached to is a thing worth being able to see later.
      const actor = client?.email || (body?.actor ? String(body.actor) : null);
      const issued = this.core.enrollment.mint({
        purpose: kind,
        label: body?.label ? String(body.label) : '',
        actor,
        hostId: body?.hostId ? String(body.hostId) : null,
        readmit: Boolean(body?.readmit),
      });
      await this.#saveEnrollment();
      this.core.record({ event: 'enrol.minted', hostId: null, text: `a ${kind} code was minted by ${actor || 'the admin token'}` });
      return json({ ok: true, ...issued });
    }

    if (url.pathname === '/api/enroll' && request.method === 'GET') {
      return json({ ok: true, codes: this.core.enrollment.outstanding() });
    }

    // Which devices can reach this fleet, and dropping one.
    if (url.pathname === '/api/clients' && request.method === 'GET') {
      return json({ ok: true, clients: this.core.clients.list() });
    }
    if (url.pathname.startsWith('/api/clients/') && request.method === 'DELETE') {
      const id = url.pathname.slice('/api/clients/'.length);
      const gone = this.core.clients.revoke(id);
      if (gone) await this.#saveClients();
      return json({ ok: gone, text: gone ? 'Revoked.' : 'No such client, or already revoked.' }, gone ? 200 : 404);
    }

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

    // A notification a person asked for, so they can find out whether push
    // works before they need it to.
    if (url.pathname === '/api/devices/test' && request.method === 'POST') {
      const body = await readJson(request);
      const r = await this.core.testPush(body?.token ? String(body.token) : undefined);
      if (!r.ok && r.error?.code === 'not_delivered') await this.#saveDevices();
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
          // The client's own identity wins over anything the request claims:
          // an actor a caller can choose is a label, not an attribution.
          actor: client?.email || (typeof body.actor === 'string' ? body.actor : undefined),
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

    // THE HANDSHAKE. A host proves it holds the enrolled private key by
    // signing a nonce this coordinator issued moments ago, and the signature
    // arrives in a header on the upgrade request.
    //
    // Nothing reusable crosses the wire. The old arrangement sent a shared
    // bearer token on every connection, so anything that saw one connection
    // could open its own — and every host sent the same one, so seeing any
    // host's connection was as good as seeing all of them.
    //
    // The reason is in the response body rather than a bare 401, because the
    // party reading it is a machine whose operator will be reading its journal:
    // "not enrolled", "revoked" and "signature does not match" send them to
    // three different actions.
    const proof = request.headers.get('x-fleet-proof') || '';
    const nonce = request.headers.get('x-fleet-nonce') || '';
    const outcome = await this.core.hostIds.prove(hostId, proof, nonce);
    if (!outcome.ok) {
      this.core.record({ event: 'host.refused', hostId, text: outcome.reason });
      // In the reason phrase as well as the body. A refused upgrade is read out
      // of a journal on the box, and some clients only surface the status line
      // — a bare "401 Unauthorized" throws away the one sentence that says
      // which of three completely different problems this is.
      return new Response(outcome.reason, { status: 401, statusText: outcome.reason.replace(/[^\x20-\x7e]/g, ' ') });
    }
    await this.#saveHosts();

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

  async #saveHosts() {
    await this.state.storage.put('hostIds', this.core.hostIds.serialise());
  }

  async #saveClients() {
    await this.state.storage.put('clients', this.core.clients.serialise());
  }

  async #saveEnrollment() {
    await this.state.storage.put('enrollment', this.core.enrollment.serialise());
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

/** A comma or space separated setting, as a list. */
function split(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
