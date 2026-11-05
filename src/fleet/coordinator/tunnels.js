// A VM's console for a phone away from the pool, through a box that holds the
// pool. docs/manage.md, "The console", "From away".
//
// THE SHAPE OF IT is the relay through a phone (relays.js), turned round:
//
//   phone ──WebSocket──▶ coordinator ──frames──▶ box ──TCP──▶ Xen Orchestra
//
// The phone opens TLS itself, over the bytes this carries, and holds it to the
// pool's pinned certificate exactly as it does on the pool's own network
// (XOConsole.swift, XoConsole.kt); the console's token goes inside that TLS as
// the cookie Xen Orchestra reads. The box opens one plain TCP connection to
// the pool's address and pumps bytes. This file joins the two and reads none
// of it, because none of it is readable here: TLS records end to end, the
// screen and every key typed inside them.
//
// Asked for, about the console: "Yes relayed as well", after the pool's page
// and its actions had gone through a box (xolook, xoact) and the console was
// the one thing left that worked only on the pool's own network.
//
// WHAT BOUNDS A TUNNEL, each for a reason:
//
//   - ONE PHONE, the socket that opened it, and one person, its owner.
//   - ONE BOX, one that reported holding THIS person's token for THIS address
//     (the same rule as the page, core.js #poolPage). The box checks again,
//     and dials only the address of a pool it holds for them: a tunnel is
//     never a way into the box's network to anywhere else.
//   - ONE CONNECTION, for one console.
//   - THIRTY MINUTES and 512 MiB, whichever comes first: a screen is frames,
//     and a console left open on a phone should not run up somebody's data or
//     sit open for a day.
//
// IN MEMORY ONLY, as a relay is, and for the same reason.
//
// NOTHING IN THIS FILE TOUCHES A RUNTIME API, for the reason core.js gives.

/** How long a tunnel may stay open, from when the phone opened it. */
export const TUNNEL_TTL_MS = 30 * 60_000;
/** The most it carries, both ways together, before it is closed. */
export const TUNNEL_MAX_BYTES = 512 * 1024 * 1024;
/** The largest piece of one frame, in bytes before base64: the relay's. */
export const TUNNEL_MAX_CHUNK = 48 * 1024;
/** Tunnels open at once across the fleet, and for one person. */
export const MAX_TUNNELS = 16;
export const MAX_TUNNELS_EACH = 2;

export const TUNNEL_ID_RE = /^[0-9a-f]{24}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_CHUNK_TEXT = Math.ceil(TUNNEL_MAX_CHUNK / 3) * 4;

/**
 * @typedef {object} Tunnel
 * @property {string} id
 * @property {string} owner
 * @property {string} device
 * @property {string} hostId
 * @property {string} address
 * @property {'opening'|'open'} state
 * @property {number} bytes
 * @property {number} expiresAt
 * @property {(msg: Record<string, unknown>) => void} toPhone
 * @property {(code: number, reason: string) => void} closePhone
 * @property {any} timer
 */

export class Tunnels {
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
    /** @type {Map<string, Tunnel>} */
    this.open = new Map();
  }

  /**
   * A phone's socket, become a tunnel through one box to one pool's address.
   * The caller has chosen the box and checked who is asking; this checks how
   * many, and asks the box to dial.
   *
   * @param {{ owner: string, device: string, hostId: string, address: string, toPhone: Tunnel['toPhone'], closePhone: Tunnel['closePhone'] }} spec
   * @returns {{ ok: true, tunnel: Tunnel } | { ok: false, error: { code: string }, text: string }}
   */
  start({ owner, device, hostId, address, toPhone, closePhone }) {
    if (this.open.size >= MAX_TUNNELS) {
      return { ok: false, error: { code: 'too_many' }, text: `This fleet is already carrying ${MAX_TUNNELS} consoles from away. Try again in a few minutes.` };
    }
    if ([...this.open.values()].filter((t) => t.owner === owner).length >= MAX_TUNNELS_EACH) {
      return { ok: false, error: { code: 'too_many' }, text: 'Your phones already have two consoles open from away. Close one first.' };
    }
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    /** @type {Tunnel} */
    const tunnel = { id, owner, device, hostId, address, state: 'opening', bytes: 0, expiresAt: this.now() + TUNNEL_TTL_MS, toPhone, closePhone, timer: null };
    tunnel.timer = this.setTimer(() => this.close(id, 'This console was open from away for thirty minutes, which is as long as one may be. Open it again.'), TUNNEL_TTL_MS);
    this.open.set(id, tunnel);
    this.log.info(`tunnel: ${id} opened through ${hostId} to ${address}`);
    return { ok: true, tunnel };
  }

  /**
   * Ask the box to connect, once the phone has been told the tunnel is
   * ready: a box that refuses at once then closes a tunnel the phone knows
   * about, rather than one it is told of afterwards.
   *
   * @param {string} id
   */
  dial(id) {
    const tunnel = this.open.get(id);
    if (!tunnel || tunnel.state !== 'opening') return;
    // THE OWNER GOES WITH THE DIAL, so the box can check it holds this
    // person's pool at this address before it connects anywhere.
    this.toHost(tunnel.hostId, { tunnel: id, op: 'open', owner: tunnel.owner, address: tunnel.address });
  }

  /**
   * Close a tunnel, telling both ends why.
   *
   * @param {string} id @param {string} text
   */
  close(id, text) {
    const tunnel = this.open.get(id);
    if (!tunnel) return;
    this.open.delete(id);
    this.clearTimer(tunnel.timer);
    try {
      this.toHost(tunnel.hostId, { tunnel: id, op: 'end' });
    } catch { /* the box's socket is going */ }
    try {
      tunnel.toPhone({ op: 'closed', text });
    } catch { /* the phone's socket is going */ }
    try {
      tunnel.closePhone(1000, 'tunnel closed');
    } catch { /* already closed */ }
    this.log.info(`tunnel: ${id} closed (${tunnel.bytes} bytes carried): ${text}`);
  }

  /** @param {string} hostId @param {string} text */
  closeForHost(hostId, text) {
    for (const t of [...this.open.values()]) if (t.hostId === hostId) this.close(t.id, text);
  }

  /** The phone's socket closed. @param {string} id */
  phoneGone(id) {
    this.close(id, 'The phone closed the console.');
  }

  /**
   * A frame from the phone: bytes for the console, or its end. Bytes before
   * the box has connected are refused, because there is nowhere for them yet.
   *
   * @param {string} id @param {unknown} raw  the socket message, as text
   */
  fromPhone(id, raw) {
    const tunnel = this.open.get(id);
    if (!tunnel) return;
    const text = typeof raw === 'string' ? raw : '';
    /** @type {any} */
    let msg = null;
    try {
      msg = text && text.length <= MAX_CHUNK_TEXT + 256 ? JSON.parse(text) : null;
    } catch { /* below */ }
    if (!msg) return this.close(id, 'The phone sent something this console does not carry, so it was closed.');
    if (msg.op === 'end') return this.close(id, 'The phone closed the console.');
    if (msg.op !== 'data' || tunnel.state !== 'open') return;
    if (!this.#count(tunnel, msg.data)) return;
    this.toHost(tunnel.hostId, { tunnel: id, op: 'data', data: msg.data });
  }

  /**
   * A frame from a box: connected, refused, bytes from the console, or its
   * end. ONLY FROM THE TUNNEL'S BOX; any other box naming it is told it is
   * closed, which is true for it.
   *
   * @param {string} hostId @param {any} msg
   */
  fromHost(hostId, msg) {
    const id = typeof msg?.tunnel === 'string' ? msg.tunnel : '';
    const tunnel = this.open.get(id);
    if (!tunnel || tunnel.hostId !== hostId) {
      if (TUNNEL_ID_RE.test(id)) {
        try {
          this.toHost(hostId, { tunnel: id, op: 'end' });
        } catch { /* nothing to tell */ }
      }
      return;
    }
    if (msg.op === 'opened' && tunnel.state === 'opening') {
      tunnel.state = 'open';
      tunnel.toPhone({ op: 'open' });
    } else if (msg.op === 'refused' && tunnel.state === 'opening') {
      this.close(id, words(msg.text) || `${hostId} could not reach ${tunnel.address}.`);
    } else if (msg.op === 'data' && tunnel.state === 'open') {
      if (!this.#count(tunnel, msg.data)) return;
      tunnel.toPhone({ op: 'data', data: msg.data });
    } else if (msg.op === 'end') {
      this.close(id, `${hostId}'s connection to ${tunnel.address} ended.`);
    }
  }

  /** @param {Tunnel} tunnel @param {unknown} data */
  #count(tunnel, data) {
    if (typeof data !== 'string' || !data.length || data.length > MAX_CHUNK_TEXT || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
      this.close(tunnel.id, 'Something sent this console bytes it does not carry, so it was closed.');
      return false;
    }
    const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    tunnel.bytes += (data.length / 4) * 3 - pad;
    if (tunnel.bytes > TUNNEL_MAX_BYTES) {
      this.close(tunnel.id, `This console carried ${TUNNEL_MAX_BYTES / 1024 / 1024} MiB from away, which is as much as one may, so it was closed. Open it again.`);
      return false;
    }
    return true;
  }
}

/** Words from a box, as a phone may show them: printable and short. @param {unknown} v */
function words(v) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200) : '';
}
