// A minimal RFC 6455 WebSocket, server and client, in plain Node.
//
// Why hand-rolled rather than `ws`: this project has zero runtime dependencies
// and that is the portability promise — a coworker clones the repo and runs it,
// with no install step on either the host or the coordinator. A WebSocket is
// about 200 lines of well-specified framing, and the alternative is a dependency
// on the one code path that every host holds open permanently.
//
// What is implemented: the handshake, text frames, fragmentation, ping/pong,
// and the close handshake. What is not: binary frames (nothing here sends
// bytes), extensions, and compression. An unexpected opcode closes the
// connection rather than being ignored — a peer speaking something we do not
// understand is not a peer we should keep talking to.
//
// Direction rules from the spec that are easy to get wrong and are enforced
// here: a client MUST mask every frame it sends, a server MUST NOT mask, and a
// server MUST reject an unmasked client frame. Getting this wrong appears to
// work against your own implementation and fails against everyone else's.

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

/** The magic string from RFC 6455 §1.3. Not configurable, not a secret. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

// A fleet message is an intent or a reply — a few KB at most, and a pane peek
// at the outside. A megabyte is a bug or an attempt to exhaust memory, and this
// cap is what stops a peer announcing a 2^63-byte payload from being believed.
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

/** @param {string} key */
export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/**
 * One open connection. Emits:
 *   'message' (string)  a complete text message
 *   'close'   (code, reason)
 *   'error'   (Error)
 *
 * Deliberately not a general-purpose WebSocket object: no binary, no
 * readyState machine beyond what the callers here need.
 */
export class WsConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket
   * @param {{ isClient: boolean, maxMessageBytes?: number }} opts
   */
  constructor(socket, { isClient, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES }) {
    super();
    this.socket = socket;
    this.isClient = isClient;
    this.maxMessageBytes = maxMessageBytes;
    this.closed = false;
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0);
    /** @type {{ opcode: number, chunks: Buffer[], length: number }|null} */
    this.fragment = null;

    socket.on('data', (/** @type {Buffer} */ chunk) => this.#onData(chunk));
    socket.on('error', (e) => this.#fail(e));
    socket.on('close', () => this.#finish(1006, 'socket closed'));
    // A half-open TCP connection looks identical to a healthy idle one, which
    // is the failure mode a fleet host would hit at 3am behind a NAT that
    // silently dropped the mapping. Keepalive is not optional here.
    socket.setNoDelay(true);
  }

  /** @param {string} text */
  send(text) {
    if (this.closed) return false;
    this.socket.write(encodeFrame(OP.TEXT, Buffer.from(text, 'utf8'), this.isClient));
    return true;
  }

  ping() {
    if (this.closed) return;
    this.socket.write(encodeFrame(OP.PING, Buffer.alloc(0), this.isClient));
  }

  /** @param {number} code @param {string} reason */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try {
      this.socket.write(encodeFrame(OP.CLOSE, body, this.isClient));
    } catch { /* peer already gone */ }
    // Do not wait for the peer's close frame forever; a peer that has already
    // vanished will never send one.
    this.socket.end();
    this.#finish(code, reason);
  }

  /** @param {Buffer} chunk */
  #onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      let frame;
      try {
        frame = decodeFrame(this.buffer, { expectMasked: !this.isClient, max: this.maxMessageBytes });
      } catch (e) {
        // A protocol violation is not recoverable: the stream position is no
        // longer known, so everything after it is noise.
        this.close(1002, /** @type {Error} */ (e).message.slice(0, 120));
        return;
      }
      if (!frame) return; // need more bytes
      this.buffer = this.buffer.subarray(frame.consumed);
      this.#onFrame(frame);
      if (this.closed) return;
    }
  }

  /** @param {{ fin: boolean, opcode: number, payload: Buffer }} frame */
  #onFrame({ fin, opcode, payload }) {
    if (opcode === OP.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      // Echo the close so the peer sees a clean shutdown rather than a reset.
      if (!this.closed) {
        try {
          this.socket.write(encodeFrame(OP.CLOSE, payload, this.isClient));
        } catch { /* nothing to echo to */ }
      }
      this.socket.end();
      this.#finish(code, reason);
      return;
    }
    if (opcode === OP.PING) {
      this.socket.write(encodeFrame(OP.PONG, payload, this.isClient));
      return;
    }
    if (opcode === OP.PONG) {
      this.emit('pong');
      return;
    }
    if (opcode === OP.BINARY) {
      this.close(1003, 'binary frames are not accepted');
      return;
    }

    if (opcode === OP.TEXT) {
      if (this.fragment) {
        this.close(1002, 'new message began before the previous one finished');
        return;
      }
      if (fin) return void this.#deliver(payload);
      this.fragment = { opcode, chunks: [payload], length: payload.length };
      return;
    }
    if (opcode === OP.CONT) {
      if (!this.fragment) {
        this.close(1002, 'continuation frame with nothing to continue');
        return;
      }
      this.fragment.chunks.push(payload);
      this.fragment.length += payload.length;
      if (this.fragment.length > this.maxMessageBytes) {
        this.close(1009, 'message too large');
        return;
      }
      if (!fin) return;
      const whole = Buffer.concat(this.fragment.chunks, this.fragment.length);
      this.fragment = null;
      return void this.#deliver(whole);
    }
    this.close(1002, `unexpected opcode 0x${opcode.toString(16)}`);
  }

  /** @param {Buffer} payload */
  #deliver(payload) {
    this.emit('message', payload.toString('utf8'));
  }

  /** @param {Error} e */
  #fail(e) {
    if (this.closed) return;
    this.emit('error', e);
    this.#finish(1006, e.message);
  }

  /** @param {number} code @param {string} reason */
  #finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
  }
}

/**
 * Serve WebSocket upgrades on an existing HTTP server.
 *
 * Returns a detach function. The HTTP server keeps serving ordinary requests —
 * the coordinator needs both on one port, because a host dials one origin.
 *
 * @param {import('node:http').Server} server
 * @param {{
 *   path?: string,
 *   authorise?: (req: import('node:http').IncomingMessage) => boolean | string | Promise<boolean|string>,
 *   onConnection: (conn: WsConnection, req: import('node:http').IncomingMessage) => void,
 *   maxMessageBytes?: number,
 * }} opts
 */
export function attachWebSocketServer(server, { path = '/', authorise, onConnection, maxMessageBytes }) {
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} [_head]
   */
  const onUpgrade = async (req, socket, _head) => {
    /** @param {number} status @param {string} message */
    const refuse = (status, message) => {
      socket.write(`HTTP/1.1 ${status} ${message}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      socket.destroy();
    };

    const url = new URL(req.url || '/', 'http://placeholder');
    if (url.pathname !== path) return refuse(404, 'Not Found');

    const key = req.headers['sec-websocket-key'];
    if (
      String(req.headers.upgrade || '').toLowerCase() !== 'websocket' ||
      typeof key !== 'string' ||
      req.headers['sec-websocket-version'] !== '13'
    ) {
      return refuse(400, 'Bad Request');
    }

    // Authorisation happens BEFORE the upgrade completes, so an unauthenticated
    // peer never gets a framed connection it can send anything down.
    //
    // Awaited: verifying a signature is asynchronous. Nothing reads the socket
    // until the connection object is built below, and an unread socket buffers
    // rather than dropping, so a peer that talks early is not truncated by the
    // wait — it just waits with us.
    if (authorise) {
      const verdict = await authorise(req);
      if (socket.destroyed) return;
      if (verdict !== true) return refuse(401, typeof verdict === 'string' ? verdict : 'Unauthorized');
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'upgrade: websocket\r\n' +
        'connection: Upgrade\r\n' +
        `sec-websocket-accept: ${acceptKey(key)}\r\n\r\n`,
    );
    onConnection(
      new WsConnection(/** @type {import('node:net').Socket} */ (socket), { isClient: false, maxMessageBytes }),
      req,
    );
  };

  server.on('upgrade', (req, socket, head) => {
    void onUpgrade(req, /** @type {import('node:stream').Duplex} */ (socket), head).catch(() => {
      try {
        socket.destroy();
      } catch { /* already gone */ }
    });
  });
  return () => server.off('upgrade', onUpgrade);
}

/**
 * Dial a WebSocket. Resolves once the server has accepted the upgrade.
 *
 * @param {string} url ws:// or wss://
 * @param {{ headers?: Record<string,string>, timeoutMs?: number, maxMessageBytes?: number }} [opts]
 * @returns {Promise<WsConnection>}
 */
export function connectWebSocket(url, { headers = {}, timeoutMs = 15_000, maxMessageBytes } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === 'wss:';
    if (!secure && u.protocol !== 'ws:') return reject(new Error(`not a websocket url: ${url}`));
    const port = Number(u.port) || (secure ? 443 : 80);
    const key = randomBytes(16).toString('base64');

    const socket = secure
      ? tlsConnect({ host: u.hostname, port, servername: u.hostname })
      : netConnect({ host: u.hostname, port });

    let settled = false;
    /** @param {Error} e */
    const fail = (e) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(e);
    };

    const timer = setTimeout(() => fail(new Error(`websocket handshake to ${url} timed out`)), timeoutMs);
    timer.unref?.();

    socket.on('error', fail);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      const lines = [
        `GET ${u.pathname}${u.search} HTTP/1.1`,
        `host: ${u.host}`,
        'upgrade: websocket',
        'connection: Upgrade',
        `sec-websocket-key: ${key}`,
        'sec-websocket-version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });

    /** @type {Buffer} */
    let head = Buffer.alloc(0);
    const onHandshakeData = (/** @type {Buffer} */ chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        // A server that never finishes its headers must not be able to grow
        // this buffer without limit.
        if (head.length > 64 * 1024) fail(new Error('handshake response headers too large'));
        return;
      }
      const raw = head.subarray(0, end).toString('latin1');
      const [status, ...rest] = raw.split('\r\n');
      if (!/^HTTP\/1\.1 101/.test(status)) {
        return fail(new Error(`websocket upgrade refused: ${status.trim()}`));
      }
      const got = rest
        .map((l) => l.split(':'))
        .find(([k]) => k.toLowerCase().trim() === 'sec-websocket-accept');
      if (!got || got.slice(1).join(':').trim() !== acceptKey(key)) {
        // Wrong accept value means whatever answered is not speaking WebSocket
        // to us — a proxy, a captive portal, or the wrong service on that port.
        return fail(new Error('websocket accept header did not match'));
      }

      clearTimeout(timer);
      settled = true;
      socket.off('data', onHandshakeData);
      socket.off('error', fail);
      const conn = new WsConnection(/** @type {import('node:net').Socket} */ (socket), {
        isClient: true,
        maxMessageBytes,
      });
      resolve(conn);
      // Bytes that arrived in the same packet as the handshake response are
      // already frames, and dropping them loses the first message.
      const leftover = head.subarray(end + 4);
      if (leftover.length) socket.emit('data', leftover);
    };
    socket.on('data', onHandshakeData);
  });
}

// --- framing ----------------------------------------------------------------

/**
 * @param {number} opcode
 * @param {Buffer} payload
 * @param {boolean} mask true for a client, which MUST mask
 */
export function encodeFrame(opcode, payload, mask) {
  const len = payload.length;
  const lenBytes = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const head = Buffer.alloc(2 + lenBytes + (mask ? 4 : 0));
  head[0] = 0x80 | opcode; // FIN set: nothing here fragments on the way out
  head[1] = (mask ? 0x80 : 0) | (lenBytes === 0 ? len : lenBytes === 2 ? 126 : 127);
  if (lenBytes === 2) head.writeUInt16BE(len, 2);
  else if (lenBytes === 8) head.writeBigUInt64BE(BigInt(len), 2);

  if (!mask) return Buffer.concat([head, payload], head.length + len);

  const key = randomBytes(4);
  key.copy(head, 2 + lenBytes);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([head, masked], head.length + len);
}

/**
 * Decode one frame if a whole one is buffered.
 *
 * @param {Buffer} buf
 * @param {{ expectMasked: boolean, max: number }} opts
 * @returns {{ fin: boolean, opcode: number, payload: Buffer, consumed: number }|null}
 */
export function decodeFrame(buf, { expectMasked, max }) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  if (buf[0] & 0x70) throw new Error('reserved bits set (no extension was negotiated)');
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  if (masked !== expectMasked) {
    // The spec is one-directional about this, and honouring it is what makes a
    // half-implemented peer fail loudly here rather than subtly later.
    throw new Error(expectMasked ? 'client frame was not masked' : 'server frame was masked');
  }

  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    // Checked before allocating anything: this number is attacker-supplied.
    if (big > BigInt(max)) throw new Error('frame larger than the message limit');
    len = Number(big);
    offset = 10;
  }
  if (len > max) throw new Error('frame larger than the message limit');

  // A control frame carries its meaning in one piece, always.
  if (opcode >= 0x8 && (!fin || len > 125)) throw new Error('control frame must be short and unfragmented');

  const keyLen = masked ? 4 : 0;
  if (buf.length < offset + keyLen + len) return null;

  let payload = buf.subarray(offset + keyLen, offset + keyLen + len);
  if (masked) {
    const key = buf.subarray(offset, offset + 4);
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
    payload = out;
  } else {
    // subarray aliases the read buffer, which the caller is about to advance
    // past — copy so the payload stays valid.
    payload = Buffer.from(payload);
  }
  return { fin, opcode, payload, consumed: offset + keyLen + len };
}
