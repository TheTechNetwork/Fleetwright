// A relay through somebody's phone, for a pool no machine in the fleet can
// reach. docs/hypervisors.md, "Through the phone".
//
// THE SHAPE OF IT. Three legs, and only the ends understand what crosses:
//
//   machine ──frames──▶ coordinator ──WebSocket──▶ phone ──TCP──▶ Xen Orchestra
//
// The machine opens TLS itself, over a stream made of these frames, and holds
// it to the pin the person accepted (src/fleet/host/xo-relay.js). The phone
// opens a plain TCP connection to the one address the person typed, on its
// own network, and pumps bytes. This file joins the two: it is a switchboard
// that counts what it carries and reads none of it, because none of it is
// readable here — it is TLS records end to end, the sign-in inside them.
//
// WHY A PHONE AT ALL. The phone is often the only thing that can see the pool:
// a laptop on the same Wi-Fi as a homelab, a pool behind a VPN the phone is on
// and no fleet machine is. It carries the first minute — the setup that makes
// the limited user and its token, and, where the pool already has a machine
// image, the pool's own machine (xo-holder.js) — and that machine then holds
// the pool with the app closed.
//
// WHAT BOUNDS A RELAY, each for a reason:
//
//   - ONE PHONE. The relay is made by the phone's own socket and lives on it;
//     no second socket can attach, and an intent naming the relay is accepted
//     only from that same device credential. Closing the app ends it.
//   - ONE PERSON, an admin: adding a hypervisor is an admin's (core.js), and
//     a relay is refused to the break-glass token, which has no phone.
//   - ONE MACHINE, chosen when it is opened. Only that machine's frames are
//     carried, and only while it is using the relay for something the person
//     asked: one probe, or the one job `begin` made on it.
//   - ONE ADDRESS, fixed when it is opened and never carried in a frame. The
//     phone connects to what the person typed and nowhere else, so neither a
//     machine nor this coordinator can point it at another host on the
//     person's network.
//   - ONE JOB. A probe, then one `begin`; the job that begin made is the only
//     thing that may open streams afterwards, and the relay closes when it
//     ends (the machine's `done`, a progress event or a status that says so).
//   - FIFTEEN MINUTES and 64 MiB, whichever comes first. Ten minutes is how
//     long a job waits for its sign-in, and a setup runs in about one; the
//     bytes are JSON-RPC, a few megabytes for a large pool. Building an edge
//     router or a machine image is gigabytes, and is refused over a relay on
//     the machine rather than sent through somebody's mobile data.
//
// IN MEMORY ONLY. A relay is a live socket and is worth nothing without it, so
// there is nothing to restore. On Cloudflare the phone's socket is accepted
// without hibernation, which keeps the Durable Object in memory while it is
// open (fleet-do.js).
//
// NOTHING IN THIS FILE TOUCHES A RUNTIME API, for the reason core.js gives:
// it runs in the Worker and in the Node harness alike.

/** How long a relay may stay open, from when the phone opened it. */
export const RELAY_TTL_MS = 15 * 60_000;
/** The most it carries, both ways together, before it is closed. */
export const RELAY_MAX_BYTES = 64 * 1024 * 1024;
/** Connections a relay may carry over its life: a probe, a setup's two, a policy job's one, and spare. */
export const RELAY_MAX_STREAMS = 8;
/** The largest piece of one frame, in bytes before base64. */
export const RELAY_MAX_CHUNK = 48 * 1024;
/** Relays open at once across the fleet, and for one person. */
export const MAX_RELAYS = 8;
export const MAX_RELAYS_EACH = 2;

const RELAY_ID_RE = /^[0-9a-f]{24}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
/** The base64 of RELAY_MAX_CHUNK bytes. */
const MAX_CHUNK_TEXT = Math.ceil(RELAY_MAX_CHUNK / 3) * 4;

/**
 * @typedef {object} Relay
 * @property {string} id
 * @property {string} owner      the person who opened it, lowercased
 * @property {string} device     the credential id of the phone carrying it
 * @property {string} hostId     the one machine whose frames it carries
 * @property {string} address    the one address the phone connects to
 * @property {number} expiresAt
 * @property {number} bytes      carried so far, both ways
 * @property {Map<number, 'opening'|'open'>} streams  open now, by the machine's number
 * @property {number} opened     streams ever opened
 * @property {'idle'|'probing'|'probed'|'job'} use
 * @property {string|null} job
 * @property {(msg: Record<string, unknown>) => void} toPhone
 * @property {(code: number, reason: string) => void} closePhone
 * @property {any} timer
 */

/** The relays open now, and the rules for each frame that crosses one. */
export class Relays {
  /**
   * @param {{
   *   now?: () => number,
   *   setTimer?: (fn: () => void, ms: number) => any,
   *   clearTimer?: (handle: any) => void,
   *   toHost: (hostId: string, frame: Record<string, unknown>) => void,
   *   log?: { info: Function, warn: Function },
   * }} opts
   */
  constructor({ now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h), toHost, log }) {
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.toHost = toHost;
    this.log = log || { info() {}, warn() {} };
    /** @type {Map<string, Relay>} */
    this.open = new Map();
  }

  /**
   * A phone's socket, become a relay to one address for one machine. The
   * caller has already checked who is asking; this checks how many.
   *
   * @param {{ owner: string, device: string, hostId: string, address: string, toPhone: Relay['toPhone'], closePhone: Relay['closePhone'] }} spec
   * @returns {{ ok: true, relay: Relay } | { ok: false, error: { code: string }, text: string }}
   */
  start({ owner, device, hostId, address, toPhone, closePhone }) {
    if (this.open.size >= MAX_RELAYS) {
      return { ok: false, error: { code: 'too_many' }, text: `This fleet is already carrying ${MAX_RELAYS} relays through phones. Try again in a few minutes.` };
    }
    if ([...this.open.values()].filter((r) => r.owner === owner).length >= MAX_RELAYS_EACH) {
      return { ok: false, error: { code: 'too_many' }, text: 'Your phones are already carrying two relays. Close the other setup first.' };
    }
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    /** @type {Relay} */
    const relay = {
      id,
      owner,
      device,
      hostId,
      address,
      expiresAt: this.now() + RELAY_TTL_MS,
      bytes: 0,
      streams: new Map(),
      opened: 0,
      use: 'idle',
      job: null,
      toPhone,
      closePhone,
      timer: null,
    };
    relay.timer = this.setTimer(() => this.close(id, 'This relay was open for fifteen minutes, which is as long as one may be. Start again from Add a hypervisor.'), RELAY_TTL_MS);
    this.open.set(id, relay);
    this.log.info(`relay: ${id} opened for ${hostId} to ${address}`);
    return { ok: true, relay };
  }

  /**
   * The relay an intent names, for its owner on the phone carrying it, to
   * the address it was opened for, for one more thing: its one probe, or its
   * one `begin`. A relay that is somebody else's, carried by another phone,
   * gone or spent is refused in the same words, so a relay id is never an
   * oracle for whether one exists.
   *
   * @param {unknown} id
   * @param {{ owner: string|null, device: string|null, address: string, use: 'probe'|'begin' }} ask
   * @returns {{ ok: true, relay: Relay } | { ok: false, error: { code: string }, text: string }}
   */
  claim(id, { owner, device, address, use }) {
    const relay = typeof id === 'string' && RELAY_ID_RE.test(id) ? this.open.get(id) : undefined;
    if (!relay || !owner || relay.owner !== owner || !device || relay.device !== device) {
      return { ok: false, error: { code: 'unknown_relay' }, text: 'This phone is not carrying that relay. Ask through this phone again.' };
    }
    if (relay.address !== address) {
      return { ok: false, error: { code: 'relay_address' }, text: `That relay goes to ${relay.address} and nowhere else.` };
    }
    // ONE PROBE, THEN ONE BEGIN, in that order or begin alone: a relay that
    // has carried a job never carries anything again.
    const free = use === 'probe' ? relay.use === 'idle' : relay.use === 'idle' || relay.use === 'probed';
    if (!free) {
      return { ok: false, error: { code: 'relay_spent' }, text: 'That relay has already been used for this. Ask through this phone again.' };
    }
    relay.use = use === 'probe' ? 'probing' : 'job';
    return { ok: true, relay };
  }

  /** A probe has had its answer: the relay may now carry one `begin`. @param {string} id */
  probed(id) {
    const relay = this.open.get(id);
    if (relay && relay.use === 'probing') relay.use = 'probed';
    // A probe's connection ends with its answer, whatever the machine did.
    if (relay) for (const stream of relay.streams.keys()) this.#endStream(relay, stream);
  }

  /** `begin` made a job on the relay's machine: from now on it carries that job and nothing else. @param {string} id @param {string} job */
  bind(id, job) {
    const relay = this.open.get(id);
    if (relay) relay.job = job;
  }

  /** @param {string} job @param {string} text */
  closeForJob(job, text) {
    for (const relay of [...this.open.values()]) if (relay.job === job) this.close(relay.id, text);
  }

  /** @param {string} hostId @param {string} text */
  closeForHost(hostId, text) {
    for (const relay of [...this.open.values()]) if (relay.hostId === hostId) this.close(relay.id, text);
  }

  /**
   * Close a relay, telling both ends why. The machine hears it as a closed
   * relay and fails whatever it was reading with these words; the phone shows
   * them and drops its connections.
   *
   * @param {string} id @param {string} text
   */
  close(id, text) {
    const relay = this.open.get(id);
    if (!relay) return;
    this.open.delete(id);
    this.clearTimer(relay.timer);
    try {
      this.toHost(relay.hostId, { relay: id, op: 'closed', text });
    } catch { /* the machine's socket is going; it learns from that */ }
    try {
      relay.toPhone({ op: 'closed', text });
    } catch { /* the phone's socket is going */ }
    try {
      relay.closePhone(1000, 'relay closed');
    } catch { /* already closed */ }
    this.log.info(`relay: ${id} closed (${relay.bytes} bytes carried): ${text}`);
  }

  /**
   * A frame from the phone carrying a relay: one of its connections opened,
   * was refused, carried bytes or ended. Anything else, or anything about a
   * connection the machine did not ask for, is dropped.
   *
   * @param {string} id @param {unknown} raw  the socket message, as text
   */
  fromPhone(id, raw) {
    const relay = this.open.get(id);
    if (!relay) return;
    const text = typeof raw === 'string' ? raw : '';
    if (!text || text.length > MAX_CHUNK_TEXT + 512) return this.close(id, 'The phone sent something this relay does not carry, so it was closed.');
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return this.close(id, 'The phone sent something this relay does not carry, so it was closed.');
    }
    const stream = streamOf(msg?.stream);
    const state = stream === null ? undefined : relay.streams.get(stream);
    if (!state) return;
    if (msg.op === 'opened' && state === 'opening') {
      relay.streams.set(/** @type {number} */ (stream), 'open');
      this.toHost(relay.hostId, { relay: id, stream, op: 'opened' });
    } else if (msg.op === 'refused' && state === 'opening') {
      relay.streams.delete(/** @type {number} */ (stream));
      this.toHost(relay.hostId, { relay: id, stream, op: 'refused', text: words(msg.text) || `the phone could not reach ${relay.address}` });
    } else if (msg.op === 'data' && state === 'open') {
      if (!this.#count(relay, msg.data)) return;
      this.toHost(relay.hostId, { relay: id, stream, op: 'data', data: msg.data });
    } else if (msg.op === 'end') {
      relay.streams.delete(/** @type {number} */ (stream));
      this.toHost(relay.hostId, { relay: id, stream, op: 'end' });
    }
  }

  /** The phone's socket closed. @param {string} id */
  phoneGone(id) {
    this.close(id, 'The phone carrying this relay closed it, so nothing more reaches Xen Orchestra through it.');
  }

  /**
   * A frame from a machine: open a connection through the phone, send bytes
   * on one, end one, or say it has finished with the relay.
   *
   * ONLY FROM THE RELAY'S MACHINE, and a connection only while it is using
   * the relay for something the person asked — the probe in flight, or the
   * job bound to it. Any other machine naming a relay is told it is closed,
   * which is true for it.
   *
   * @param {string} hostId @param {any} msg
   */
  fromHost(hostId, msg) {
    const id = typeof msg?.relay === 'string' ? msg.relay : '';
    const relay = this.open.get(id);
    if (!relay || relay.hostId !== hostId) {
      if (RELAY_ID_RE.test(id)) {
        try {
          this.toHost(hostId, { relay: id, op: 'closed', text: 'that relay is not open for this machine' });
        } catch { /* nothing to tell */ }
      }
      return;
    }
    if (msg.op === 'done') return this.close(id, 'The job using this relay ended, so it was closed.');
    const stream = streamOf(msg.stream);
    if (stream === null) return;
    if (msg.op === 'open') {
      const using = relay.use === 'probing' || relay.job !== null;
      if (!using || relay.streams.has(stream)) {
        this.toHost(hostId, { relay: id, stream, op: 'refused', text: 'this relay is not carrying anything for this machine now' });
        return;
      }
      if (relay.opened >= RELAY_MAX_STREAMS) {
        this.toHost(hostId, { relay: id, stream, op: 'refused', text: `this relay has carried the ${RELAY_MAX_STREAMS} connections one may` });
        return;
      }
      relay.opened += 1;
      relay.streams.set(stream, 'opening');
      relay.toPhone({ op: 'open', stream });
      return;
    }
    const state = relay.streams.get(stream);
    if (!state) return;
    if (msg.op === 'data' && state === 'open') {
      if (!this.#count(relay, msg.data)) return;
      relay.toPhone({ op: 'data', stream, data: msg.data });
    } else if (msg.op === 'end') {
      this.#endStream(relay, stream);
    }
  }

  /** @param {Relay} relay @param {number} stream */
  #endStream(relay, stream) {
    if (!relay.streams.delete(stream)) return;
    try {
      relay.toPhone({ op: 'end', stream });
    } catch { /* the phone's socket is going */ }
  }

  /**
   * Count a piece of bytes against the relay's cap, or close it. A piece that
   * is not base64 of at most RELAY_MAX_CHUNK bytes closes it too: an end that
   * sends that is not one of ours.
   *
   * @param {Relay} relay @param {unknown} data
   */
  #count(relay, data) {
    if (typeof data !== 'string' || !data.length || data.length > MAX_CHUNK_TEXT || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
      this.close(relay.id, 'Something sent this relay bytes it does not carry, so it was closed.');
      return false;
    }
    const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    relay.bytes += (data.length / 4) * 3 - pad;
    if (relay.bytes > RELAY_MAX_BYTES) {
      this.close(relay.id, `This relay carried ${RELAY_MAX_BYTES / 1024 / 1024} MiB, which is as much as one may, so it was closed.`);
      return false;
    }
    return true;
  }
}

/** A connection's number as a frame carries it, or null. @param {unknown} v */
function streamOf(v) {
  return Number.isSafeInteger(v) && /** @type {number} */ (v) >= 1 && /** @type {number} */ (v) <= 1_000_000 ? /** @type {number} */ (v) : null;
}

/** Words from a phone, as a machine may repeat them: printable and short. @param {unknown} v */
function words(v) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200) : '';
}
