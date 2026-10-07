// Connections to Xen Orchestra through somebody's phone, for a pool no machine
// in the fleet can reach. docs/hypervisors.md, "Through the phone".
//
// WHAT THIS IS: a stream. Each connection is a Duplex whose bytes go to the
// coordinator as `relay` frames on this box's own socket, from there to the
// phone that opened the relay, and from the phone to the address on its own
// network as plain TCP. Nothing here speaks TLS or HTTP: xo-ws.js opens TLS
// OVER this stream (`tls.connect({ socket })`) and checks the pin exactly as
// it does over a socket of its own, so what crosses the coordinator and the
// phone is TLS records, the sign-in inside them, readable by this machine and
// Xen Orchestra and nobody between.
//
// WHY THE MACHINE AND NOT THE PHONE TERMINATES IT. The phone could speak to
// Xen Orchestra itself, and it would then hold the admin session the setup
// works through — the thing onboarding exists to keep on one machine, for one
// run (xo-setup.js). Relaying bytes keeps the setup exactly what it is over a
// machine's own network: the same pinned TLS, the same steps, the same
// hand-off, with the phone as a length of wire.
//
// WHAT THE OTHER END CAN DO TO THIS ONE, since the coordinator is the party
// this project treats as compromised: send bytes into a connection, which TLS
// refuses unless they are Xen Orchestra's; end one, which fails the step it
// was carrying; or say nothing, which the call timeouts in xo-ws.js bound. It
// cannot name a connection this box did not open — a frame for one is
// dropped — and it cannot choose where the phone connects, which the phone
// fixed when it opened the relay.

import { Duplex } from 'node:stream';

/** The largest piece one frame carries, before base64: the coordinator's bound (relays.js). */
export const RELAY_CHUNK = 48 * 1024;
const RELAY_ID_RE = /^[0-9a-f]{24}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The connections this box has open through phones, by relay and number.
 */
export class RelayStreams {
  /**
   * @param {{
   *   send: (frame: Record<string, unknown>) => boolean|void|Promise<unknown>,
   *   openTimeoutMs?: number,
   *   log?: { info: (m: string) => void, warn: (m: string) => void },
   * }} opts
   */
  constructor({ send, openTimeoutMs = 15_000, log }) {
    this.send = send;
    this.openTimeoutMs = openTimeoutMs;
    this.log = log || { info() {}, warn() {} };
    /** @type {Map<string, { relay: string, stream: number, duplex: Duplex, opening: { resolve: (d: Duplex) => void, reject: (e: Error) => void, timer: any }|null, ended: boolean }>} */
    this.streams = new Map();
    /** Relays the coordinator said are closed, and why, so a late open is refused in its words. @type {Map<string, string>} */
    this.closed = new Map();
    this.next = 1;
  }

  /**
   * A new connection through the relay: resolves once the phone has reached
   * the address, rejects with the phone's or the coordinator's reason when it
   * could not.
   *
   * @param {string} relay
   * @returns {Promise<Duplex>}
   */
  open(relay) {
    if (!RELAY_ID_RE.test(relay)) return Promise.reject(new Error('that is not a relay'));
    const gone = this.closed.get(relay);
    if (gone) return Promise.reject(new Error(gone));
    const stream = this.next++;
    const key = `${relay}:${stream}`;
    const self = this;
    const duplex = new Duplex({
      read() {},
      write(chunk, _enc, done) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (let at = 0; at < bytes.length; at += RELAY_CHUNK) {
          if (!self.#frame({ relay, stream, op: 'data', data: bytes.subarray(at, at + RELAY_CHUNK).toString('base64') })) {
            done(new Error('this machine lost its connection to the fleet, so nothing reaches Xen Orchestra through the phone'));
            return;
          }
        }
        done();
      },
      final(done) {
        self.#end(key);
        done();
      },
      destroy(err, done) {
        self.#end(key);
        done(err);
      },
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(key, new Error(`the phone did not reach the address within ${Math.round(this.openTimeoutMs / 1000)} seconds`));
      }, this.openTimeoutMs);
      timer.unref?.();
      this.streams.set(key, { relay, stream, duplex, opening: { resolve, reject, timer }, ended: false });
      if (!this.#frame({ relay, stream, op: 'open' })) {
        this.#fail(key, new Error('this machine is not connected to the fleet, so it cannot reach anything through a phone'));
      }
    });
  }

  /**
   * This box has finished with a relay: its job ended. The coordinator closes
   * it at both ends; whatever was still open here goes now.
   *
   * @param {string} relay
   */
  done(relay) {
    if (!RELAY_ID_RE.test(relay)) return;
    for (const [key, s] of [...this.streams]) if (s.relay === relay) this.#fail(key, new Error('the job using this relay ended'));
    this.#frame({ relay, op: 'done' });
    this.closed.set(relay, 'the job using this relay ended');
    this.#trimClosed();
  }

  /**
   * A frame from the coordinator, about a connection this box opened or a
   * relay it is using. Anything about one it did not open is dropped.
   *
   * @param {any} msg
   */
  onFrame(msg) {
    const relay = typeof msg?.relay === 'string' && RELAY_ID_RE.test(msg.relay) ? msg.relay : null;
    if (!relay) return;
    if (msg.op === 'closed' && msg.stream === undefined) {
      const why = words(msg.text) || 'the relay through the phone was closed';
      this.closed.set(relay, why);
      this.#trimClosed();
      for (const [key, s] of [...this.streams]) if (s.relay === relay) this.#fail(key, new Error(why));
      return;
    }
    const key = `${relay}:${Number(msg.stream)}`;
    const s = this.streams.get(key);
    if (!s) return;
    if (msg.op === 'opened' && s.opening) {
      clearTimeout(s.opening.timer);
      const { resolve } = s.opening;
      s.opening = null;
      resolve(s.duplex);
    } else if (msg.op === 'refused' || msg.op === 'closed') {
      this.#fail(key, new Error(words(msg.text) || 'the phone could not reach the address'));
    } else if (msg.op === 'data' && !s.opening) {
      const data = typeof msg.data === 'string' && msg.data.length <= Math.ceil(RELAY_CHUNK / 3) * 4 && BASE64_RE.test(msg.data) ? msg.data : null;
      if (data === null) return this.#fail(key, new Error('the relay sent something that is not bytes'));
      s.duplex.push(Buffer.from(data, 'base64'));
    } else if (msg.op === 'end') {
      // Xen Orchestra, or the phone, hung up. What it sent before is read
      // first; the stream then ends, which TLS reads as the server closing.
      s.ended = true;
      this.streams.delete(key);
      s.duplex.push(null);
    }
  }

  /** @param {Record<string, unknown>} frame */
  #frame(frame) {
    try {
      return this.send(frame) !== false;
    } catch {
      return false;
    }
  }

  /** This end closing a connection: the phone is told once, and it is forgotten. @param {string} key */
  #end(key) {
    const s = this.streams.get(key);
    if (!s) return;
    this.streams.delete(key);
    if (s.opening) {
      clearTimeout(s.opening.timer);
      s.opening.reject(new Error('the connection was closed before the phone reached the address'));
      s.opening = null;
    }
    if (!s.ended) this.#frame({ relay: s.relay, stream: s.stream, op: 'end' });
  }

  /** A connection that cannot go on: its opener, or its reader, hears why. @param {string} key @param {Error} err */
  #fail(key, err) {
    const s = this.streams.get(key);
    if (!s) return;
    this.streams.delete(key);
    if (s.opening) {
      clearTimeout(s.opening.timer);
      s.opening.reject(err);
      s.opening = null;
      if (!s.ended) this.#frame({ relay: s.relay, stream: s.stream, op: 'end' });
      return;
    }
    if (!s.ended) this.#frame({ relay: s.relay, stream: s.stream, op: 'end' });
    s.ended = true;
    s.duplex.destroy(err);
  }

  /** A box runs a few setups a day; the reasons for the last few are plenty. */
  #trimClosed() {
    while (this.closed.size > 32) this.closed.delete(/** @type {string} */ (this.closed.keys().next().value));
  }
}

/** Words from the coordinator, as an error may carry them: printable and short. @param {unknown} v */
function words(v) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200) : '';
}
