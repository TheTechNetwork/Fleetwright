// The real transport: a persistent outbound WebSocket to the coordinator.
//
// This is the property that makes fleetwright deployable at all, preserved into
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
//
// THE SOCKET IS NODE'S OWN. `globalThis.WebSocket` has been in Node since 22,
// and this transport used to carry four hundred lines of hand-rolled RFC 6455
// framing beside it for two things the platform API lacks: custom headers on
// the upgrade, and a ping. The first turned out not to be lacking — Node's
// implementation takes `{ headers }` as its second argument, and the two proof
// headers arrive at the coordinator exactly as before (worker/test/parity.
// test.js holds that against real workerd). The second became a message: see
// protocol/heartbeat.js. So the framing left the package, and what every host
// holds open for weeks is the runtime's WebSocket rather than ours.
//
// What that costs, said plainly: the platform API does not surface the body of
// a refused upgrade, and the coordinator puts the REASON there — "not
// enrolled", "revoked", "the signature does not match" send an operator to
// three different actions. So a refused dial asks the coordinator again, over
// plain HTTP, through the `diagnose` hook the sidecar supplies, and logs the
// sentence. And there is no client-side cap on message size any more; the peer
// is the pinned coordinator, which sends frames of a few kilobytes.

import { HEARTBEAT_PING, heartbeatKind } from '../../protocol/heartbeat.js';

const INITIAL_BACKOFF_MS = 1_000;
// Exported so the enrol command can promise a reconnect window without
// hardcoding a number that would drift the first time this changed.
export const MAX_BACKOFF_MS = 30_000;

// A dead TCP connection is indistinguishable from an idle healthy one until you
// write to it. The coordinator polls health every 15s, which would usually be
// enough — but that traffic stops exactly when something is wrong, so the
// transport asks on its own schedule rather than relying on it.
export const PING_INTERVAL_MS = 20_000;
export const PONG_GRACE_MS = 15_000;

// The WHATWG close() accepts 1000 or 3000–4999 and throws on anything else, so
// the transport's own reasons live in the application range.
const CLOSE_NO_PONG = 4000;

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
   *   diagnose?: (() => Promise<string|null>)|null,
   *   logger?: typeof import('../../../log.js').log,
   *   maxBackoffMs?: number,
   *   pingIntervalMs?: number,
   *   pongGraceMs?: number,
   *   onConnect?: (() => void)|null,
   * }} opts
   */
  constructor({
    origin,
    hostId,
    proof = null,
    diagnose = null,
    logger,
    maxBackoffMs = MAX_BACKOFF_MS,
    pingIntervalMs = PING_INTERVAL_MS,
    pongGraceMs = PONG_GRACE_MS,
    onConnect = null,
  }) {
    this.origin = origin;
    this.hostId = hostId;
    // A function rather than a value: it is called on every dial, because each
    // connection needs its own nonce.
    this.proof = proof;
    // Asked once after a dial the coordinator refused, for the sentence the
    // platform WebSocket could not give us. Optional: a transport without it
    // still reconnects, it just cannot say why it was turned away.
    this.diagnose = diagnose;
    // Called once each time a connection comes up — the one signal that says
    // this box reached its coordinator. The commit-confirm watchdog uses it to
    // confirm an update on trial; nothing else here needs it, so it is optional.
    this.onConnect = onConnect;
    this.log = logger || { debug() {}, info() {}, warn() {}, error() {} };
    this.maxBackoffMs = maxBackoffMs;
    this.pingIntervalMs = pingIntervalMs;
    this.pongGraceMs = pongGraceMs;
    /** @type {((msg: unknown) => Promise<void>)|null} */
    this.handler = null;
    /** @type {WebSocket|null} */
    this.ws = null;
    this.stopped = false;
    this.backoff = INITIAL_BACKOFF_MS;
    /** @type {NodeJS.Timeout|null} */
    this.pingTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this.retryTimer = null;
    /** Resolves once the first connection is up, so start() can report it. */
    this.connectedOnce = false;
    /** Pongs received, over the life of the transport. Read by tests and the container smoke. */
    this.heartbeats = 0;
  }

  /** The ws:// URL derived from the pinned origin. */
  get url() {
    const u = new URL(this.origin);
    u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol;
    u.pathname = '/host/connect';
    u.search = `?hostId=${encodeURIComponent(this.hostId)}`;
    return u.toString();
  }

  /** Is there an open socket right now? */
  get connected() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
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
      const ws = await this.#open(headers);
      this.ws = ws;
      this.backoff = INITIAL_BACKOFF_MS;
      this.connectedOnce = true;
      this.log.info(`fleet: connected to ${this.origin} as ${this.hostId}`);
      // Reaching the coordinator is the proof a fresh update works. Guarded so a
      // throwing callback cannot take the transport down — a confirm that fails
      // is a trial that runs its full window, not a dead connection.
      if (this.onConnect) {
        try { this.onConnect(); } catch (e) { this.log.warn(`fleet: onConnect hook threw: ${/** @type {Error} */ (e).message}`); }
      }
      this.#startHeartbeat(ws);
    } catch (e) {
      this.log.warn(`fleet: could not reach ${this.origin}: ${/** @type {Error} */ (e).message}`);
      this.#scheduleRetry();
    }
  }

  /**
   * Open the socket and wire it. Resolves once the upgrade completed; rejects
   * on anything before that, with the coordinator's reason where one can be
   * had.
   *
   * @param {Record<string, string>} headers
   * @returns {Promise<WebSocket>}
   */
  #open(headers) {
    return new Promise((resolve, reject) => {
      // `headers` is Node's extension to the WebSocket constructor, and the one
      // thing this transport relies on beyond the standard: the proof rides in
      // the upgrade request, where the coordinator reads it before it accepts.
      const ws = new WebSocket(this.url, /** @type {any} */ ({ headers }));
      // Nothing here sends bytes, but a peer might; read them as a buffer
      // rather than a Blob so the check below is one typeof.
      ws.binaryType = 'arraybuffer';
      let opened = false;

      ws.addEventListener('open', () => {
        opened = true;
        resolve(ws);
      });
      ws.addEventListener('message', (ev) => {
        if (this.ws !== ws) return; // an abandoned socket, still draining
        this.#onFrame(ev.data);
      });
      ws.addEventListener('error', (ev) => {
        // Before open this is the dial failing; the close that follows carries
        // the outcome. After open it is a transport fault the close will also
        // report, so it is logged and nothing more.
        if (opened) this.log.warn(`fleet: socket error: ${/** @type {any} */ (ev).message || 'unknown'}`);
      });
      ws.addEventListener('close', (ev) => {
        if (!opened) {
          // The platform API says only that the upgrade did not complete — the
          // status and body the coordinator sent are not surfaced. Ask again
          // over HTTP for the sentence, so the journal says "revoked" rather
          // than "network error".
          void this.#explainRefusal().then((why) => reject(new Error(why)));
          return;
        }
        if (this.ws !== ws) return; // we already moved on from this socket
        this.#stopHeartbeat();
        this.ws = null;
        if (this.stopped) return;
        this.log.warn(`fleet: disconnected (${ev.code}${ev.reason ? ` ${ev.reason}` : ''}) — reconnecting`);
        this.#scheduleRetry();
      });
    });
  }

  /** @returns {Promise<string>} */
  async #explainRefusal() {
    if (!this.diagnose) return 'the coordinator did not accept the connection';
    try {
      const reason = await this.diagnose();
      return reason ? `the coordinator refused this host: ${reason}` : 'the coordinator did not accept the connection';
    } catch (e) {
      return `the coordinator did not accept the connection (and could not be asked why: ${/** @type {Error} */ (e).message})`;
    }
  }

  /** @param {unknown} data */
  #onFrame(data) {
    // Anything at all from the peer is proof the socket is alive, which is what
    // the heartbeat exists to establish — so a coordinator that answers health
    // asks but predates the pong keeps the socket up, and only total silence
    // drops it.
    this.awaitingPong = false;
    if (typeof data !== 'string') {
      this.log.warn('fleet: coordinator sent a binary frame — ignored');
      return;
    }
    const beat = heartbeatKind(data);
    if (beat === 'pong') {
      this.heartbeats += 1;
      return;
    }
    if (beat === 'ping') return; // the coordinator does not ask; nothing to answer with
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      this.log.warn('fleet: coordinator sent a non-JSON frame');
      return;
    }
    void this.handler?.(msg);
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

  /**
   * The liveness check. Every interval, send the heartbeat; if the previous one
   * went unanswered — and nothing else arrived either — the socket is half-open
   * and the only way out is to abandon it.
   *
   * ABANDON, NOT AWAIT. The platform close() sends a close frame and then waits
   * for the peer's, and a peer behind a NAT that dropped the mapping will never
   * send one: the socket would sit in CLOSING until the kernel gave up on the
   * TCP retransmits, minutes later, with the host out of the fleet the whole
   * time. So the transport forgets the socket the moment it is judged dead and
   * dials a new one; the old one's eventual close event finds `this.ws` is no
   * longer it and is ignored.
   *
   * @param {WebSocket} ws
   */
  #startHeartbeat(ws) {
    this.awaitingPong = false;
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        this.log.warn('fleet: coordinator did not answer a heartbeat — dropping the connection');
        this.#abandon(ws, CLOSE_NO_PONG, 'no pong');
        return;
      }
      this.awaitingPong = true;
      try {
        ws.send(HEARTBEAT_PING);
      } catch (e) {
        this.log.warn(`fleet: could not send a heartbeat: ${/** @type {Error} */ (e).message}`);
        this.#abandon(ws, CLOSE_NO_PONG, 'send failed');
        return;
      }
      // The grace: a pong is expected well inside the interval, so a socket
      // that misses one is judged on the NEXT tick rather than on this one, and
      // a slow-but-alive coordinator is given the whole grace period first.
      const grace = setTimeout(() => { this.awaitingPong = false; }, this.pongGraceMs);
      grace.unref?.();
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  /** @param {WebSocket} ws @param {number} code @param {string} reason */
  #abandon(ws, code, reason) {
    this.#stopHeartbeat();
    if (this.ws === ws) this.ws = null;
    try { ws.close(code, reason); } catch { /* already closing */ }
    if (!this.stopped) this.#scheduleRetry();
  }

  #stopHeartbeat() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.awaitingPong = false;
  }

  /** @param {object} msg */
  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Dropping is correct rather than queueing: every reply is an answer to
      // an intent the coordinator is timing out anyway, and a queue that
      // delivers a stale reply after a reconnect is worse than no reply.
      this.log.warn('fleet: no connection — reply dropped');
      return false;
    }
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      this.log.warn(`fleet: send failed: ${/** @type {Error} */ (e).message}`);
      return false;
    }
  }

  async stop() {
    this.stopped = true;
    this.#stopHeartbeat();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(1000, 'shutting down'); } catch { /* already closed */ }
    }
    return true;
  }
}
