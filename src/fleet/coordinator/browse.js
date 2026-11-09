// A web view on a phone whose connections leave from one of your machines.
// docs/browse.md.
//
// THE SHAPE OF IT is the console from away (tunnels.js), with streams:
//
//   web view ──CONNECT──▶ phone's loopback proxy ──WebSocket──▶ here ──frames──▶ box ──TCP──▶ the page
//
// A page is dozens of connections, so one phone socket carries many STREAMS,
// each one TCP connection the box makes. This file joins the phone's socket to
// the box's frames, counts, and reads nothing: an https page's TLS is opened by
// the phone's web view, through the stream, to the page's own name.
//
// WHAT IS DECIDED HERE AND WHAT IS NOT. Who may open a socket on which box is
// the caller's (core.js openBrowse). Where each connection may go is THE
// BOX'S, every time (src/fleet/host/browse.js), because this is the party the
// project treats as compromised. What this tells the box, once, when the
// socket opens, is the person and the session from its own record, never the
// phone's word; the box keeps them for every connection after.
//
// AND HOW FAST. A connection's bytes toward the phone are acknowledged by the
// phone (`ack`), and the box reads no more than a window ahead of it
// (host/browse.js BROWSE_WINDOW), so a page served at LAN speed to a phone on
// a slow link does not pile up here.
//
// WHAT BOUNDS A SOCKET, each for a reason:
//
//   - ONE PHONE, the socket that opened it, and one person.
//   - ONE BOX, chosen when it opened.
//   - THIRTY-TWO CONNECTIONS open at once. A page opens a handful per origin;
//     a page asking for more than this is not one a phone needs.
//   - THIRTY MINUTES and 512 MiB, whichever comes first, as the console's.
//   - TWO SOCKETS A PERSON, SIXTEEN IN THE FLEET.
//
// IN MEMORY ONLY, as a tunnel is, and for the same reason.
//
// NOTHING IN THIS FILE TOUCHES A RUNTIME API, for the reason core.js gives.

/** How long a socket may stay open, from when the phone opened it. */
export const BROWSE_TTL_MS = 30 * 60_000;
/** The most it carries, every stream both ways together, before it is closed. */
export const BROWSE_MAX_BYTES = 512 * 1024 * 1024;
/** The largest piece of one frame, in bytes before base64: the tunnel's. */
export const BROWSE_MAX_CHUNK = 48 * 1024;
/** The most one acknowledgement may say the phone has: more than any window. */
const BROWSE_MAX_ACK = 16 * 1024 * 1024;
/** Connections one socket may have open at once. */
export const BROWSE_MAX_STREAMS = 32;
/** Sockets open at once across the fleet, and for one person. */
export const MAX_BROWSES = 16;
export const MAX_BROWSES_EACH = 2;

export const BROWSE_ID_RE = /^[0-9a-f]{24}$/;
/** A stream's number, the phone's to choose. */
const STREAM_RE = /^[1-9][0-9]{0,8}$/;
/**
 * A host a connection may name: a DNS name or an IP literal, IPv6 in or out
 * of brackets. Only its shape is checked here; whether it may be reached is
 * the box's.
 */
export const BROWSE_HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?|\[?[0-9A-Fa-f:.]{2,45}\]?)$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_CHUNK_TEXT = Math.ceil(BROWSE_MAX_CHUNK / 3) * 4;

/**
 * @typedef {object} Browse
 * @property {string} id
 * @property {string} owner
 * @property {string} device
 * @property {string} hostId
 * @property {string|null} session
 * @property {boolean} box  whether the box's own rules apply: the person administers it
 * @property {'opening'|'open'} state
 * @property {Map<number, 'connecting'|'open'>} streams
 * @property {number} bytes
 * @property {number} expiresAt
 * @property {(msg: Record<string, unknown>) => void} toPhone
 * @property {(code: number, reason: string) => void} closePhone
 * @property {any} timer
 */

/**
 * A stream number as a number, or null when it is not one.
 *
 * @param {unknown} v
 */
function streamOf(v) {
  const s = typeof v === 'number' && Number.isInteger(v) ? String(v) : typeof v === 'string' ? v : '';
  return STREAM_RE.test(s) ? Number(s) : null;
}

/**
 * A host and port a connection may name, or null.
 *
 * @param {unknown} host @param {unknown} port
 * @returns {{ host: string, port: number }|null}
 */
export function browseTarget(host, port) {
  const h = typeof host === 'string' ? host : '';
  const p = typeof port === 'number' ? port : typeof port === 'string' && /^[0-9]{1,5}$/.test(port) ? Number(port) : NaN;
  if (!h || h.length > 253 || !BROWSE_HOST_RE.test(h)) return null;
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  return { host: h.replace(/^\[(.*)\]$/, '$1').toLowerCase(), port: p };
}

export class Browses {
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
    /** @type {Map<string, Browse>} */
    this.open = new Map();
  }

  /**
   * A phone's socket, become a browse socket through one box. The caller has
   * chosen the box, checked who is asking and what the box opens for them;
   * this checks how many, and asks the box to agree.
   *
   * @param {{ owner: string, device: string, hostId: string, session: string|null, box: boolean, toPhone: Browse['toPhone'], closePhone: Browse['closePhone'] }} spec
   * @returns {{ ok: true, browse: Browse } | { ok: false, error: { code: string }, text: string }}
   */
  start({ owner, device, hostId, session, box, toPhone, closePhone }) {
    if (this.open.size >= MAX_BROWSES) {
      return { ok: false, error: { code: 'too_many' }, text: `This fleet is already carrying ${MAX_BROWSES} pages through its machines. Try again in a few minutes.` };
    }
    if ([...this.open.values()].filter((b) => b.owner === owner).length >= MAX_BROWSES_EACH) {
      return { ok: false, error: { code: 'too_many' }, text: 'Your phones already have two pages open through a machine. Close one first.' };
    }
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    /** @type {Browse} */
    const browse = {
      id, owner, device, hostId, session, box,
      state: 'opening', streams: new Map(), bytes: 0, expiresAt: this.now() + BROWSE_TTL_MS, toPhone, closePhone, timer: null,
    };
    browse.timer = this.setTimer(() => this.close(id, 'This page was open through a machine for thirty minutes, which is as long as one may be. Open it again.'), BROWSE_TTL_MS);
    // A timer that keeps nothing alive by itself: a Node process with only an
    // open page's deadline left in it has nothing left to carry it to.
    browse.timer?.unref?.();
    this.open.set(id, browse);
    this.log.info(`browse: ${id} opened through ${hostId}${session ? ` on ${session}` : ''}`);
    return { ok: true, browse };
  }

  /**
   * Ask the box to agree, once the phone has been told the socket is ready:
   * a box that refuses at once then closes a socket the phone knows about.
   *
   * @param {string} id
   */
  ask(id) {
    const b = this.open.get(id);
    if (!b || b.state !== 'opening') return;
    // THE PERSON AND THE SESSION GO WITH IT, from this record, so the box can
    // check the session is theirs before it opens anything.
    this.toHost(b.hostId, { browse: id, op: 'open', owner: b.owner, session: b.session, box: b.box });
  }

  /**
   * Close a socket, telling both ends why.
   *
   * @param {string} id @param {string} text
   */
  close(id, text) {
    const b = this.open.get(id);
    if (!b) return;
    this.open.delete(id);
    this.clearTimer(b.timer);
    try {
      this.toHost(b.hostId, { browse: id, op: 'close' });
    } catch { /* the box's socket is going */ }
    try {
      b.toPhone({ op: 'closed', text });
    } catch { /* the phone's socket is going */ }
    try {
      b.closePhone(1000, 'browse closed');
    } catch { /* already closed */ }
    this.log.info(`browse: ${id} closed (${b.bytes} bytes carried): ${text}`);
  }

  /** @param {string} hostId @param {string} text */
  closeForHost(hostId, text) {
    for (const b of [...this.open.values()]) if (b.hostId === hostId) this.close(b.id, text);
  }

  /** The phone's socket closed. @param {string} id */
  phoneGone(id) {
    this.close(id, 'The phone closed the page.');
  }

  /**
   * A frame from the phone: a connection to open, bytes for one, or its end.
   *
   * @param {string} id @param {unknown} raw  the socket message, as text
   */
  fromPhone(id, raw) {
    const b = this.open.get(id);
    if (!b) return;
    const text = typeof raw === 'string' ? raw : '';
    /** @type {any} */
    let msg = null;
    try {
      msg = text && text.length <= MAX_CHUNK_TEXT + 512 ? JSON.parse(text) : null;
    } catch { /* below */ }
    if (!msg || typeof msg !== 'object') return this.close(id, 'The phone sent something this page does not carry, so it was closed.');
    if (msg.op === 'close') return this.close(id, 'The phone closed the page.');
    if (b.state !== 'open') return;
    const stream = streamOf(msg.stream);
    if (stream === null) return this.close(id, 'The phone named a connection that is not one, so the page was closed.');
    if (msg.op === 'connect') {
      if (b.streams.has(stream)) return this.close(id, 'The phone opened a connection twice, so the page was closed.');
      const target = browseTarget(msg.host, msg.port);
      if (!target) {
        b.toPhone({ op: 'failed', stream, text: 'That is not an address a page can be on.' });
        return;
      }
      if (b.streams.size >= BROWSE_MAX_STREAMS) {
        b.toPhone({ op: 'failed', stream, text: `This page already has ${BROWSE_MAX_STREAMS} connections open through the machine.` });
        return;
      }
      b.streams.set(stream, 'connecting');
      this.toHost(b.hostId, { browse: id, op: 'connect', stream, host: target.host, port: target.port });
      return;
    }
    const state = b.streams.get(stream);
    if (!state) return;
    if (msg.op === 'end') {
      b.streams.delete(stream);
      this.toHost(b.hostId, { browse: id, op: 'end', stream });
      return;
    }
    if (msg.op === 'ack') {
      if (state !== 'open' || typeof msg.bytes !== 'number' || !Number.isInteger(msg.bytes) || msg.bytes < 1 || msg.bytes > BROWSE_MAX_ACK) return;
      this.toHost(b.hostId, { browse: id, op: 'ack', stream, bytes: msg.bytes });
      return;
    }
    if (msg.op !== 'data' || state !== 'open') return;
    if (!this.#count(b, msg.data)) return;
    this.toHost(b.hostId, { browse: id, op: 'data', stream, data: msg.data });
  }

  /**
   * A frame from a box. ONLY FROM THE SOCKET'S BOX; any other box naming it is
   * told it is closed, which is true for it.
   *
   * @param {string} hostId @param {any} msg
   */
  fromHost(hostId, msg) {
    const id = typeof msg?.browse === 'string' ? msg.browse : '';
    const b = this.open.get(id);
    if (!b || b.hostId !== hostId) {
      if (BROWSE_ID_RE.test(id)) {
        try {
          this.toHost(hostId, { browse: id, op: 'close' });
        } catch { /* nothing to tell */ }
      }
      return;
    }
    if (msg.op === 'opened' && b.state === 'opening') {
      b.state = 'open';
      b.toPhone({ op: 'open' });
      return;
    }
    if (msg.op === 'refused' && b.state === 'opening') return this.close(id, words(msg.text) || `${hostId} would not open pages for this phone.`);
    if (msg.op === 'closed') return this.close(id, words(msg.text) || `${hostId} closed the page.`);
    if (b.state !== 'open') return;
    const stream = streamOf(msg.stream);
    if (stream === null) return;
    const state = b.streams.get(stream);
    if (!state) {
      // A stream the phone already ended, or never opened: the box is told,
      // so it stops sending for it.
      if (msg.op !== 'end') this.toHost(hostId, { browse: id, op: 'end', stream });
      return;
    }
    if (msg.op === 'connected' && state === 'connecting') {
      b.streams.set(stream, 'open');
      b.toPhone({ op: 'connected', stream });
    } else if (msg.op === 'failed' && state === 'connecting') {
      b.streams.delete(stream);
      b.toPhone({ op: 'failed', stream, text: words(msg.text) || `${hostId} could not open that.` });
    } else if (msg.op === 'data' && state === 'open') {
      if (!this.#count(b, msg.data)) return;
      b.toPhone({ op: 'data', stream, data: msg.data });
    } else if (msg.op === 'end') {
      b.streams.delete(stream);
      b.toPhone({ op: 'end', stream });
    }
  }

  /** @param {Browse} b @param {unknown} data */
  #count(b, data) {
    if (typeof data !== 'string' || !data.length || data.length > MAX_CHUNK_TEXT || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
      this.close(b.id, 'Something sent this page bytes it does not carry, so it was closed.');
      return false;
    }
    const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    b.bytes += (data.length / 4) * 3 - pad;
    if (b.bytes > BROWSE_MAX_BYTES) {
      this.close(b.id, `This page carried ${BROWSE_MAX_BYTES / 1024 / 1024} MiB through the machine, which is as much as one may, so it was closed. Open it again.`);
      return false;
    }
    return true;
  }
}

/** Words from a box, as a phone may show them: printable and short. @param {unknown} v */
function words(v) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200) : '';
}
