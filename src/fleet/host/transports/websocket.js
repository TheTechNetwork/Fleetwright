// The real transport: a persistent outbound WebSocket to the coordinator.
//
// This is the property that makes agent-hub deployable at all, preserved into
// the fleet (design.md §3): the host DIALS OUT and nothing you own ever listens.
// No inbound firewall rule, no port forward, no tunnel daemon, works behind NAT
// on a Pi — and wake comes for free, because the coordinator already has a
// socket open to push down.
//
// Reconnection is not an add-on here, it is the main feature. A host is
// expected to lose this socket routinely: laptops sleep, NATs drop mappings,
// the coordinator redeploys. What must never happen is a host that quietly
// stops being part of the fleet while its process is still running and its
// sessions are still alive.

import { connectWebSocket } from '../../ws.js';

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

// A dead TCP connection is indistinguishable from an idle healthy one until you
// write to it. The coordinator polls health every 15s, which would usually be
// enough — but that traffic stops exactly when something is wrong, so the
// transport pings on its own schedule rather than relying on it.
const PING_INTERVAL_MS = 20_000;
const PONG_GRACE_MS = 15_000;

export class WebSocketTransport {
  /**
   * `origin` is the coordinator, e.g. https://coord.example.workers.dev — the
   * ws:// URL is derived from it rather than configured separately, so there is
   * only ever one origin to pin.
   *
   * @param {{
   *   origin: string,
   *   hostId: string,
   *   proof?: (() => Promise<{ nonce: string, proof: string }>)|null,
   *   logger?: typeof import('../../../log.js').log,
   *   maxBackoffMs?: number,
   * }} opts
   */
  constructor({ origin, hostId, proof = null, logger, maxBackoffMs = MAX_BACKOFF_MS }) {
    this.origin = origin;
    this.hostId = hostId;
    // A function rather than a value: it is called on every dial, because each
    // connection needs its own nonce.
    this.proof = proof;
    this.log = logger || { debug() {}, info() {}, warn() {}, error() {} };
    this.maxBackoffMs = maxBackoffMs;
    /** @type {((msg: unknown) => Promise<void>)|null} */
    this.handler = null;
    /** @type {import('../../ws.js').WsConnection|null} */
    this.conn = null;
    this.stopped = false;
    this.backoff = INITIAL_BACKOFF_MS;
    /** @type {NodeJS.Timeout|null} */
    this.pingTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this.retryTimer = null;
    /** Resolves once the first connection is up, so start() can report it. */
    this.connectedOnce = false;
  }

  /** The ws:// URL derived from the pinned origin. */
  get url() {
    const u = new URL(this.origin);
    u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol;
    u.pathname = '/host/connect';
    u.search = `?hostId=${encodeURIComponent(this.hostId)}`;
    return u.toString();
  }

  /** @param {(msg: unknown) => Promise<void>} handler */
  onMessage(handler) {
    this.handler = handler;
  }

  /**
   * Dial, and keep dialling.
   *
   * Resolves as soon as the first attempt has been made — successful or not.
   * It deliberately does NOT wait for a connection: a host whose coordinator is
   * down must still come up, serve its sessions, and keep retrying, rather than
   * refusing to start because something else is broken.
   */
  async start() {
    this.stopped = false;
    await this.#dial();
    return true;
  }

  async #dial() {
    if (this.stopped) return;
    try {
      // Prove first, then upgrade. The proof is a signature over a nonce the
      // coordinator issued seconds ago, so a captured connection contains
      // nothing that can open another one — which a bearer token, sent
      // identically on every reconnect, could not say.
      /** @type {Record<string, string>} */
      const headers = {};
      if (this.proof) {
        // Two headers, not one string to be split: the nonce says which
        // challenge this answers, and the coordinator holds no record of having
        // issued it — the nonce authenticates itself.
        const { nonce, proof } = await this.proof();
        headers['x-fleet-nonce'] = nonce;
        headers['x-fleet-proof'] = proof;
      }
      const conn = await connectWebSocket(this.url, { headers });
      this.conn = conn;
      this.backoff = INITIAL_BACKOFF_MS;
      this.connectedOnce = true;
      this.log.info(`fleet: connected to ${this.origin} as ${this.hostId}`);

      conn.on('message', (text) => {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          this.log.warn('fleet: coordinator sent a non-JSON frame');
          return;
        }
        void this.handler?.(msg);
      });
      conn.on('close', (code, reason) => {
        this.#stopPinging();
        this.conn = null;
        if (this.stopped) return;
        this.log.warn(`fleet: disconnected (${code}${reason ? ` ${reason}` : ''}) — reconnecting`);
        this.#scheduleRetry();
      });
      conn.on('error', (e) => this.log.warn(`fleet: socket error: ${e.message}`));

      this.#startPinging(conn);
    } catch (e) {
      this.log.warn(`fleet: could not reach ${this.origin}: ${/** @type {Error} */ (e).message}`);
      this.#scheduleRetry();
    }
  }

  #scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    // Jittered, so a coordinator coming back up is not hit by every host in the
    // fleet in the same millisecond.
    const wait = Math.round(this.backoff * (0.5 + Math.random()));
    this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.#dial();
    }, wait);
    // NOT unref'd, and that is the whole difference between a service and a
    // script. While this timer is pending it is the ONLY thing holding the
    // event loop open — the socket is gone, that is why we are here — so an
    // unref'd one lets node decide there is nothing left to do and exit. The
    // sidecar then died every time it lost its coordinator, which under systemd
    // looks like a restart loop with no reason in it, and on a box run by hand
    // is simply a process that vanished.
    //
    // stop() clears it, so nothing hangs on the way out.
  }

  /** @param {import('../../ws.js').WsConnection} conn */
  #startPinging(conn) {
    let awaitingPong = false;
    conn.on('pong', () => {
      awaitingPong = false;
    });
    this.pingTimer = setInterval(() => {
      if (conn.closed) return;
      if (awaitingPong) {
        // The socket is open as far as the kernel is concerned and the peer is
        // not answering. That is the half-open case, and the only way out is to
        // tear it down ourselves.
        this.log.warn('fleet: coordinator did not answer a ping — dropping the connection');
        conn.close(1001, 'no pong');
        return;
      }
      awaitingPong = true;
      conn.ping();
      setTimeout(() => {
        awaitingPong = false;
      }, PONG_GRACE_MS).unref?.();
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  #stopPinging() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** @param {object} msg */
  send(msg) {
    if (!this.conn || this.conn.closed) {
      // Dropping is correct rather than queueing: every reply is an answer to
      // an intent the coordinator is timing out anyway, and a queue that
      // delivers a stale reply after a reconnect is worse than no reply.
      this.log.warn('fleet: no connection — reply dropped');
      return false;
    }
    return this.conn.send(JSON.stringify(msg));
  }

  async stop() {
    this.stopped = true;
    this.#stopPinging();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.conn?.close(1000, 'shutting down');
    this.conn = null;
    return true;
  }
}
