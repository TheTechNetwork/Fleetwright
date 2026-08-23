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
import { ClientRegistry } from './clients.js';
import { HostIdentities } from './hosts.js';
import { Enrollment } from './enrollment.js';
import { place } from './scheduler.js';
import { VERBS, PROTOCOL_VERSION, buildIntent, isMutating } from '../protocol/intents.js';

const DEFAULT_INTENT_TIMEOUT_MS = 320_000;

/**
 * @typedef {object} Device
 * @property {string} id            opaque, minted at enrollment
 * @property {'ios'|'android'|'web'} platform
 * @property {string} token         APNs/FCM token
 * @property {string} [actor]       who this device belongs to
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
   *   logger?: { info: Function, warn: Function, error: Function, debug: Function },
   *   push?: import('../push.js').Pusher|null,
   * }} [opts]
   */
  constructor({
    now = () => Date.now(),
    newId = () => crypto.randomUUID(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    intentTimeoutMs = DEFAULT_INTENT_TIMEOUT_MS,
    logger,
    push = null,
  } = {}) {
    this.now = now;
    this.newId = newId;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.intentTimeoutMs = intentTimeoutMs;
    this.log = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.push = push;
    this.registry = new HostRegistry({ now });
    // Credentials issued to devices, one per phone, each revocable alone.
    this.clients = new ClientRegistry({ now });
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
  }

  // --- hosts ---------------------------------------------------------------

  /**
   * @param {string} hostId
   * @param {(msg: object) => void} send
   */
  hostConnected(hostId, send) {
    this.registry.connect(hostId, send);
    this.log.info(`coordinator: ${hostId} connected`);
  }

  /** @param {string} hostId @param {string} reason */
  hostDisconnected(hostId, reason) {
    this.registry.disconnect(hostId, reason);
    this.log.warn(`coordinator: ${hostId} disconnected (${reason})`);
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
      this.registry.recordHealth(hostId, msg.health);
      return;
    }

    if (msg.kind === 'event') return this.#onHostEvent(hostId, msg);

    if (msg.kind !== 'reply' || typeof msg.id !== 'string') {
      this.log.warn(`coordinator: ${hostId} sent something that is not a reply, health or event`);
      return;
    }
    const waiter = this.pending.get(msg.id);
    if (!waiter) {
      // A reply to something already given up on. The host was slow, not wrong.
      this.log.debug(`coordinator: late reply from ${hostId} for ${msg.id}`);
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
    const event = {
      hostId,
      event: String(msg.event || 'unknown'),
      name: msg.name ? String(msg.name) : null,
      text: msg.text ? String(msg.text).slice(0, 500) : null,
      url: msg.url ? String(msg.url).slice(0, 500) : null,
      at: this.now(),
    };
    // Bounded: a coordinator is not a log server, and an unbounded array in a
    // Durable Object is a memory leak with a long fuse.
    this.events.push(event);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);

    this.log.info(`coordinator: ${hostId} ${event.event}${event.name ? ` ${event.name}` : ''}`);
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
    return event;
  }

  /** @param {Record<string, any>} event */
  async #notify(event) {
    const devices = [...this.devices.values()];
    if (!devices.length) return;
    const body = describeEvent(event);
    try {
      await this.push?.send(devices, {
        title: event.name ? `${event.name} on ${event.hostId}` : event.hostId,
        body,
        data: { event: event.event, name: event.name ?? '', hostId: event.hostId, url: event.url ?? '' },
      });
    } catch (e) {
      // A push provider being down must never take the coordinator with it.
      this.log.warn(`coordinator: push failed: ${/** @type {Error} */ (e).message}`);
    }
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
   * @param {string} [token] one device, or every registered device if omitted
   * @returns {Promise<{ ok: boolean, sent?: number, dead?: number, error?: object, text: string }>}
   */
  async testPush(token) {
    const all = [...this.devices.values()];
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
    const { client, token } = await this.clients.issue(`${label} (${who.email})`);
    // Recorded on the client so an intent can say who sent it without another
    // lookup, and so a revocation list reads as people rather than ids.
    client.email = who.email;
    this.log.info(`coordinator: issued a credential to ${who.email} for ${label}`);
    return { token, client: { id: client.id, name: client.name, createdAt: client.createdAt } };
  }

  // --- devices -------------------------------------------------------------

  /**
   * Register a phone for push. Keyed by the push token rather than by a device
   * id we mint, because the token is what actually identifies a delivery
   * target — and a reinstall gives the same phone a new one, which should not
   * accumulate as a second registration that fails forever.
   *
   * @param {{ platform: string, token: string, actor?: string }} reg
   */
  registerDevice({ platform, token, actor }) {
    if (!['ios', 'android', 'web'].includes(platform)) {
      return { ok: false, error: `unknown platform ${JSON.stringify(platform)}` };
    }
    if (typeof token !== 'string' || token.length < 8 || token.length > 4096) {
      return { ok: false, error: 'a push token is required' };
    }
    const existing = this.devices.get(token);
    const device = {
      id: existing?.id ?? this.newId(),
      platform: /** @type {any} */ (platform),
      token,
      ...(actor ? { actor } : {}),
      registeredAt: existing?.registeredAt ?? this.now(),
    };
    this.devices.set(token, device);
    this.log.info(`coordinator: registered ${platform} device ${device.id}`);
    return { ok: true, deviceId: device.id };
  }

  /** @param {string} token */
  unregisterDevice(token) {
    return { ok: this.devices.delete(token) };
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
   * @param {{ verb: string, params?: Record<string, any>, actor?: string, id?: string }} spec
   * @param {number} [timeoutMs]
   */
  send(host, spec, timeoutMs = this.intentTimeoutMs) {
    const intent = buildIntent({
      id: spec.id || this.newId(),
      verb: spec.verb,
      params: spec.params || {},
      ...(spec.actor ? { actor: spec.actor } : {}),
    });

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
   * @param {{ verb: string, params?: Record<string, any>, actor?: string, id?: string }} spec
   */
  async dispatch(spec) {
    if (!Object.prototype.hasOwnProperty.call(VERBS, spec.verb)) {
      return { ok: false, error: { code: 'unknown_verb' }, text: `unknown verb ${JSON.stringify(spec.verb)}` };
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
    if (isMutating(spec.verb) && spec.actor) {
      this.record({
        event: 'intent',
        verb: spec.verb,
        actor: spec.actor,
        name: spec.params?.name ?? null,
        text: `${spec.actor} asked for ${spec.verb}${spec.params?.name ? ` ${spec.params.name}` : ''}`,
      });
    }

    const placement = place(this.registry, spec);
    if (placement.kind === 'refused') {
      return { ok: false, error: { code: placement.code }, text: placement.reason };
    }


    if (placement.kind === 'fanout') {
      const results = await Promise.all(
        (placement.hosts || []).map((h) =>
          this.send(h, spec)
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
      return await this.send(placement.host, spec);
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
  recentEvents() {
    return this.events.slice(-EVENT_PAGE);
  }

  /** Everything a client can see about the fleet. */
  snapshot() {
    return {
      protocol: PROTOCOL_VERSION,
      hosts: this.registry.list(),
      devices: this.devices.size,
      events: this.events.slice(-20),
    };
  }
}

/** How many events a catch-up returns. One number, two coordinators. */
const EVENT_PAGE = 50;

/** Events worth waking somebody for. The rest are for the log. */
const NOTIFIABLE = new Set(['session.awaiting-input', 'session.ended', 'session.error', 'session.rc-online']);

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
    default:
      return event.event;
  }
}
