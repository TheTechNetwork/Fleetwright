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
import { VERBS, PROTOCOL_VERSION, buildIntent, isMutating } from '../protocol/intents.js';
import { PendingAuthorizations, authorizeUrl, exchangeCode } from './github-oauth.js';
import { buildConfigFrame } from '../protocol/config-frame.js';

const DEFAULT_INTENT_TIMEOUT_MS = 320_000;

/**
 * @typedef {object} Device
 * @property {string} id            opaque, minted at enrollment
 * @property {'ios'|'android'|'web'} platform
 * @property {string} token         APNs/FCM token
 * @property {string} [actor]       who this device belongs to
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
   *   logger?: { info: Function, warn: Function, error: Function, debug: Function },
   *   push?: import('../push.js').Pusher|null,
 *   mailer?: { send: ((m: { to: string, subject: string, text: string }) => Promise<void>)|null, from: string|null }|null,
   *   githubApp?: { clientId?: string, clientSecret?: string, slug?: string }|null,
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
    // Sending an invitation email, when a deployment has set it up. Optional
    // and injected for the same reason `push` is: the core knows nothing about
    // Cloudflare bindings, and the Node coordinator has none.
    mailer = null,
    // The GitHub App, when a deployment has registered one. Absent is the
    // normal case for a fresh clone and is not an error: the paste route is
    // first-class, not a fallback. See docs/github-app.md.
    githubApp = null,
  } = {}) {
    this.now = now;
    this.newId = newId;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.intentTimeoutMs = intentTimeoutMs;
    this.log = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.push = push;
    this.githubApp = githubApp;
    /**
     * In-flight GitHub authorizations, keyed by the `state` GitHub will hand
     * back. In memory rather than in storage on purpose: it lives ten minutes,
     * and a coordinator restart losing one costs somebody a second tap, while
     * persisting it would mean writing who-is-authorizing-what to disk.
     */
    this.pendingGithub = new PendingAuthorizations({ now });
    this.registry = new HostRegistry({ now });
    // An ephemeral host that drops is retired by the registry; the key it
    // enrolled with has to go with it, which only the core can do.
    this.registry.onRetired = (hostId, reason) => this.ephemeralHostRetired(hostId, reason);
    // Credentials issued to devices, one per phone, each revocable alone.
    this.clients = new ClientRegistry({ now });
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
      const frame = buildConfigFrame({ githubClientSecret: this.githubApp?.clientSecret });
      if (frame) send(frame);
    } catch (e) {
      this.log.warn(`coordinator: could not send config to ${hostId}: ${/** @type {Error} */ (e).message}`);
    }
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
      // agent-hub warned about it hourly for thirty hours, the coordinator
      // marked the host degraded, the app showed it — three storeys down in
      // Settings — and nobody was told. docs/psychology.md §7 is exactly this:
      // silence has to be trustworthy before it is comfortable, and a warning
      // that reaches a log file is silence.
      if (moved) await this.#onHostState(hostId, moved);
      return;
    }

    if (msg.kind === 'event') return this.#onHostEvent(hostId, msg);

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
    // Persisted by whoever owns storage — a file on a box, DO storage in the
    // Worker. The ring used to be RAM only, so "a phone that was asleep can
    // catch up" was false the moment anything restarted.
    this.onEvents?.();

    this.log.info(`coordinator: ${hostId} ${event.event}${event.name ? ` ${event.name}` : ''}`);
    if (this.push && NOTIFIABLE.has(event.event)) await this.#notify(event);
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

  /** @param {Record<string, any>} event */
  async #notify(event) {
    // Filtered here as well as on revocation. The cascade above is the fix; this
    // is the belt — a registration that somehow outlives its credential must
    // not be told what a session is asking.
    const devices = [...this.devices.values()].filter(
      (d) => !d.clientId || !this.clients.clients.get(d.clientId)?.revokedAt,
    );
    if (!devices.length) return;
    const body = describeEvent(event);
    try {
      await this.push?.send(devices, {
        // "deb132 on deb132" — a host event's name IS the host, and this
        // template was written for sessions, where the two differ. Reported
        // from a lock screen within minutes of host events shipping.
        title: event.name && event.name !== event.hostId ? `${event.name} on ${event.hostId}` : event.hostId,
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
    const { client, token } = await this.clients.issue(`${label} (${who.email})`, { admin });
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
   * @param {{ platform: string, token: string, actor?: string, clientId?: string }} reg
   */
  registerDevice({ platform, token, actor, clientId }) {
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
      // WHICH CREDENTIAL THIS BELONGS TO, so revoking a phone can stop the
      // fleet talking to it. Without this a revoked device kept receiving
      // session names — and since prompts started carrying the question, the
      // questions themselves. Revoking a lost phone removed its ability to ASK
      // and left its ability to be TOLD, which is the wrong half.
      ...(clientId ? { clientId } : {}),
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
    if (clientId) {
      for (const [key, other] of this.devices) {
        if (key !== token && other.clientId === clientId) {
          this.devices.delete(key);
          this.log.info(`coordinator: dropped superseded ${other.platform} device ${other.id}`);
        }
      }
    }
    this.log.info(`coordinator: registered ${platform} device ${device.id}`);
    return { ok: true, deviceId: device.id };
  }

  /** @param {string} token */
  unregisterDevice(token) {
    return { ok: this.devices.delete(token) };
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
   * @param {{ verb: string, params?: Record<string, any>, actor?: string, id?: string, preferHost?: string, preferLabels?: string[]|string|null, requester?: { email?: string|null, admin?: boolean }|null }} spec
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

    const placement = place(this.registry, spec, {
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
    if (placement.kind === 'refused') {
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
      if (spec.requester && !spec.requester.admin) {
        const mine = `fleet:${String(spec.requester.email || '').toLowerCase()}`;
        sessions = sessions.filter((s) => String(s.createdBy || '').toLowerCase() === mine);
      }

      // COVERAGE, when the question was "what am I connected to". A fan-out
      // returns one reply per host, and for `connect` the interesting part is
      // where they DISAGREE: a credential reaches the hosts that were
      // reachable when it was stored, so a machine enrolled later has none.
      // Merging that into a per-provider list of hosts is what lets a screen
      // say "missing on deb14" instead of implying the fleet is uniform.
      const connections = mergeConnections(results);

      return {
        ok: results.some((r) => r.ok),
        fanout: true,
        ...(connections ? { connections } : {}),
        // Attribution is not decoration: two hosts can hold sessions with the
        // same name, and a merged list that loses which box each came from
        // cannot be acted on.
        sessions,
        hosts: results.map(({ hostId, ok, text, error }) => ({ hostId, ok, text, error })),
        text: results.map((r) => `${r.hostId}: ${r.text ?? ''}`).join('\n'),
      };
    }

    try {
      return explainUnknownVerb(await this.send(placement.host, spec), placement.host);
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
   * Offer the App flow in place of the paste, when there is an App.
   *
   * The HOST publishes the catalogue and knows nothing about a GitHub App —
   * correctly, since the client id and secret belong to the deployment rather
   * than to any machine. So the coordinator rewrites the one entry it can
   * improve on, and leaves everything else alone.
   *
   * Cloudflare is untouched, and always will be: there is no third-party app
   * program to rewrite it to.
   *
   * @param {any} reply       a connect reply carrying `connections`
   * @param {string} hostId   where the flow must come back to
   * @param {string|null} email  whose credential this will be
   * @param {string} origin   this coordinator's public origin
   */
  offerGithubApp(reply, hostId, email, origin) {
    const clientId = this.githubApp?.clientId;
    if (!clientId || !this.githubApp?.clientSecret) return reply;
    const catalogue = reply?.connections?.catalogue;
    if (!Array.isArray(catalogue)) return reply;

    // An origin we cannot parse means no App offer, and the paste route is
    // returned untouched. Better a working paste than an authorize URL built
    // out of something that was not an address.
    const state = this.newId();
    const url = authorizeUrl({ clientId, origin, state });
    if (!url) return reply;
    this.pendingGithub.mint({ state, hostId, email });
    return {
      ...reply,
      connections: {
        ...reply.connections,
        catalogue: catalogue.map((c) =>
          c?.provider === 'github'
            ? {
                ...c,
                url,
                // The app renders no paste field for this one: there is
                // nothing to copy, which is the entire point of the App.
                flow: 'app',
                hint:
                  'Choose which repositories Fleetwright may see. Nothing is copied or pasted — ' +
                  'GitHub sends the result back, and you can change the repositories or uninstall ' +
                  'it from your GitHub settings at any time.',
              }
            : c,
        ),
      },
    };
  }

  /**
   * Finish an authorization GitHub has redirected back to us.
   *
   * Everything here is refusable and says why in a sentence a person reading a
   * browser page can act on. The one thing it must never do is exchange a code
   * for a flow it did not start — which is what `redeem` is for, and why it is
   * the first thing that happens.
   *
   * @param {{ code?: unknown, state?: unknown, origin: string }} args
   */
  async finishGithubAuthorization({ code, state, origin }) {
    const clientId = this.githubApp?.clientId;
    const clientSecret = this.githubApp?.clientSecret;
    if (!clientId || !clientSecret) {
      return { ok: false, text: 'This fleet has no GitHub App configured.' };
    }
    const flow = this.pendingGithub.redeem(state);
    if (!flow) {
      // Deliberately one message for unknown, expired and replayed. Telling a
      // stranger which of those it was is telling them whether a state exists.
      return { ok: false, text: 'That sign-in link has expired or was already used. Start again from the app.' };
    }
    if (typeof code !== 'string' || !code) {
      return { ok: false, text: 'GitHub did not send an authorization code back.' };
    }

    const exchanged = await exchangeCode({ clientId, clientSecret, code, origin });
    if (!exchanged.ok) return { ok: false, text: exchanged.message };

    // THE ACCESS TOKEN, NEVER THE REFRESH TOKEN. This read
    // `exchanged.refreshToken ?? exchanged.accessToken`, reaching for the
    // longer-lived value — and a refresh token is not an API credential. It
    // authenticates nothing: `GET /user` with one is a 401, every time. The
    // whole flow worked and then reported "GitHub rejected that token (401)",
    // which read like a bad token and was a wrong one.
    //
    // What a session uses is the access token. The refresh token exists only to
    // mint the next one, and has nowhere to live until the host can refresh —
    // which needs the client secret it is sent over the socket, and that is the
    // next piece rather than this one.
    //
    // Stored by the verb that already does it: same validation, same redaction,
    // same per-person file. A second path into that storage is a second thing
    // to get right.
    const secret = exchanged.accessToken;
    const reply = await this.dispatch({
      verb: 'link',
      params: { provider: 'github', secret },
      actor: flow.email ?? undefined,
      preferHost: flow.hostId,
      // The person authorized in a browser; there is no fleet credential on
      // that request, and the state is what proved who they are.
      requester: null,
    });
    if (reply?.ok === false) return { ok: false, text: reply.text || 'The token could not be stored.' };

    // THE RENEWAL MATERIAL, DEPOSITED ONCE, and this is the piece the comment
    // above used to say was next. The refresh token was received here and
    // thrown away, because there was nowhere for it to live — so every GitHub
    // App connection was dead eight hours after it was made, and reconnecting
    // was the only remedy.
    //
    // IT GOES TO THE HOST, WITH THE CLIENT SECRET, which is docs/trust.md's
    // rule and not a convenience: "spreading minting keys across hosts means a
    // compromised host costs that host's access; centralising them means a
    // compromised coordinator costs everything." Keeping refresh tokens here
    // would make this internet-facing component hold every member's renewable
    // GitHub credential, which is the outcome that rule exists to refuse.
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
        params: { provider: 'github', clientId, refresh: exchanged.refreshToken },
        actor: flow.email ?? undefined,
        preferHost: flow.hostId,
        requester: null,
      });
      renewable = deposited?.ok !== false;
      // Not fatal. The connection works for eight hours either way, and
      // failing the whole flow over the part that makes it last would throw
      // away a credential the person just authorised.
      if (!renewable) this.log?.warn?.(`github: ${flow.hostId} could not store renewal material: ${deposited?.text}`);
    }

    return {
      ok: true,
      // Honest about the eight hours rather than quiet about them, and honest
      // about which of the two situations this is. A token that stops working
      // tomorrow, from a screen that said "connected", is worse than one that
      // said so — and a token that renews itself should not still be
      // apologising for a limitation that no longer applies.
      text: !exchanged.expiresIn
        ? 'Your sessions can use GitHub now.'
        : renewable
          ? `Your sessions can use GitHub now. The token lasts ${Math.round(exchanged.expiresIn / 3600)} hours and ` +
            'that machine renews it by itself from here on.'
          : `Your sessions can use GitHub now. This token lasts ${Math.round(exchanged.expiresIn / 3600)} hours, and ` +
            'that machine could not store what it needs to renew it — connect again when it expires.',
    };
  }

  /**
   * @param {{ email?: string|null, admin?: boolean }|null} [requester]
   */
  recentEvents(requester = null) {
    return visibleEvents(this.events.slice(-EVENT_PAGE), requester);
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
    };
  }
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
 * agent-hub directly rather than through this protocol.
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
      'This is the protocol refusing cleanly rather than guessing, and it is fixed on that box:\n' +
      `  agent-hub update --restart      (a shell on ${host.hostId})\n` +
      `  /update --restart               (that box's own Telegram bot)\n` +
      'A pull without a restart looks the same from here — the files are new and the running ' +
      'service still holds the old command list, which is why both lines say --restart.',
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
  /** @type {Map<string, { provider: string, label: string|null, account: string|null, hosts: string[] }>} */
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
