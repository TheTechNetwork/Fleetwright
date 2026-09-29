// A host's socket, the way the sidecar opens it, for tests that speak frames.
//
// Node's own WebSocket, with the two proof headers on the upgrade — the same
// constructor call src/fleet/host/transports/websocket.js makes, so a test that
// connects through this is exercising the contract a real sidecar depends on:
// that `{ headers }` reaches the coordinator. Wrapped as an EventEmitter with
// `message` (string), `close` (code, reason) and `send`, because that is what
// the parity and live tests were written against and it is the shape a test
// wants: listeners added after the fact, not one onmessage property.
//
// The one thing the platform API will not say is WHY an upgrade was refused —
// the status and body are not surfaced — so the rejection here says only that
// it was, and the coordinator tests that care about the reason ask
// /api/host/verify for it, as the sidecar's `diagnose` hook does.

import { EventEmitter } from 'node:events';

/**
 * @param {string} url ws:// URL, with the hostId in the query
 * @param {{ headers?: Record<string, string>, timeoutMs?: number }} [opts]
 * @returns {Promise<HostSocket>}
 */
export function connectHostSocket(url, { headers = {}, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, /** @type {any} */ ({ headers }));
    ws.binaryType = 'arraybuffer';
    const wrapped = new HostSocket(ws);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* never opened */ }
      reject(new Error(`websocket handshake to ${url} timed out`));
    }, timeoutMs);
    timer.unref?.();
    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(wrapped);
    });
    ws.addEventListener('close', (ev) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`websocket upgrade refused (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})`));
    });
  });
}

export class HostSocket extends EventEmitter {
  /** @param {WebSocket} ws */
  constructor(ws) {
    super();
    this.ws = ws;
    this.closed = false;
    ws.addEventListener('message', (ev) => {
      this.emit('message', typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    });
    ws.addEventListener('close', (ev) => {
      this.closed = true;
      this.emit('close', ev.code, ev.reason);
    });
    ws.addEventListener('error', () => { /* the close that follows says what happened */ });
  }

  /** @param {string} text */
  send(text) {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(text);
    return true;
  }

  /** @param {number} [code] @param {string} [reason] */
  close(code = 1000, reason = '') {
    try { this.ws.close(code, reason); } catch { /* already closing */ }
  }
}
