// Talking to Xen Orchestra: its JSON-RPC, over a WebSocket, over TLS that is
// checked against one certificate.
//
// WHY NOT THE WebSocket NODE ALREADY HAS. A Xen Orchestra built from sources
// serves a self-signed certificate — the installer generates one — so the
// ordinary check (a chain to a public root) fails on every real pool, and the
// built-in client offers no way to replace that check with a better one. The
// better one is the PIN: the SHA-256 of the exact certificate the person saw
// and accepted when the probe ran (docs/hypervisors.md). This file accepts
// that certificate and no other, whoever signed it, which is a stronger
// statement than "some public CA vouched for a name" and is the only one a
// self-signed server can make.
//
// So the client is written here, small: an RFC 6455 handshake and its frames
// on top of node:tls, and JSON-RPC 2.0 on top of that. Text frames only,
// because that is all Xen Orchestra speaks on /api/, and a server frame of any
// other kind it has no business sending ends the connection.
//
// NOTHING HERE LOGS A MESSAGE. The first call made on one of these carries an
// admin password; a debug line that printed frames would print it.

import tls from 'node:tls';
import net from 'node:net';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';

/** What RFC 6455 appends to the key before hashing it, to prove an upgrade was understood. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Bigger than any answer onboarding asks for, small enough that a hostile server cannot fill memory. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** @param {Buffer} der */
export function certSha256(der) {
  return createHash('sha256').update(der).digest('hex');
}

/**
 * What a server's certificate says about itself, and what is wrong with it,
 * for the person deciding whether to accept it.
 *
 * WORKED OUT HERE rather than read off `authorizationError` alone, because
 * that names only the first thing OpenSSL tripped on: a self-signed
 * certificate that has also expired, for a different name, says only
 * "self-signed", and the person accepting it should hear all three.
 * `trusted` is the machine's own verdict — the chain checks out against the
 * authorities Node trusts AND the name matches — with nothing found wrong.
 *
 * @param {import('node:tls').TLSSocket} socket
 * @param {string} host
 * @param {number} [now]
 * @returns {{ trusted: boolean, problems: string[], subject: string, issuer: string, notBefore: string|null, notAfter: string|null, names: string[] } | null}
 */
export function describeCertificate(socket, host, now = Date.now()) {
  const peer = socket.getPeerCertificate();
  if (!peer?.raw) return null;
  /** @type {X509Certificate} */
  let x;
  try {
    x = new X509Certificate(peer.raw);
  } catch {
    return null;
  }
  const problems = [];
  let selfSigned = false;
  try {
    selfSigned = x.checkIssued(x) && x.verify(x.publicKey);
  } catch {
    selfSigned = false;
  }
  const code = socket.authorized ? null : String(socket.authorizationError || 'UNKNOWN');
  if (selfSigned) problems.push('self-signed');
  else if (code && !['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) problems.push('untrusted-issuer');
  const from = Date.parse(x.validFrom);
  const to = Date.parse(x.validTo);
  if (Number.isFinite(to) && to < now) problems.push('expired');
  if (Number.isFinite(from) && from > now) problems.push('not-yet-valid');
  const matches = net.isIP(host) ? x.checkIP(host) : x.checkHost(host);
  if (!matches) problems.push('name-mismatch');
  const names = String(x.subjectAltName || '')
    .split(/,\s*/)
    .map((n) => n.replace(/^(DNS|IP Address):/, '').trim())
    .filter(Boolean);
  return {
    trusted: socket.authorized === true && problems.length === 0,
    problems,
    subject: x.subject.split('\n').join(', '),
    issuer: x.issuer.split('\n').join(', '),
    notBefore: Number.isFinite(from) ? new Date(from).toISOString() : null,
    notAfter: Number.isFinite(to) ? new Date(to).toISOString() : null,
    names,
  };
}

/** What each problem a certificate can have reads as, after "the certificate". */
export const CERT_PROBLEM_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  'self-signed': 'is self-signed',
  'untrusted-issuer': 'is signed by an authority this machine does not trust',
  expired: 'has expired',
  'not-yet-valid': 'is not valid yet',
  'name-mismatch': 'is for a different name',
}));

/**
 * An address as the protocol carries it — `name`, `name:port`, `[v6]` or
 * `[v6]:port` (XO_ADDRESS_RE) — as a host and a port.
 *
 * @param {string} address
 * @param {number} [defaultPort]
 * @returns {{ host: string, port: number, explicitPort: boolean }}
 */
export function splitAddress(address, defaultPort = 443) {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(address);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : defaultPort, explicitPort: Boolean(v6[2]) };
  const i = address.lastIndexOf(':');
  if (i > 0) return { host: address.slice(0, i), port: Number(address.slice(i + 1)), explicitPort: true };
  return { host: address, port: defaultPort, explicitPort: false };
}

/**
 * Open a TLS connection and refuse it unless the certificate is the pinned one.
 *
 * `rejectUnauthorized: false` reads alarming and is the opposite: the chain
 * check it turns off is replaced by an exact match on the certificate, done
 * before a single byte of ours is written. A server presenting anything else
 * is disconnected and never hears a request.
 *
 * @param {{ host: string, port: number, pin: string, timeoutMs?: number }} opts
 * @returns {Promise<import('node:tls').TLSSocket>}
 */
export function connectPinnedTls({ host, port, pin, timeoutMs = 15_000 }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      // SNI only for names: sending an IP literal as a server name is not
      // allowed by the spec and some servers reset on it.
      ...(net.isIP(host) ? {} : { servername: host }),
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${host}:${port} did not answer within ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const cert = socket.getPeerCertificate();
      const seen = cert?.raw ? certSha256(cert.raw) : null;
      if (seen !== pin) {
        socket.destroy();
        reject(new Error(
          `${host}:${port} answered with a different certificate from the one you accepted. ` +
            'Nothing was sent. If Xen Orchestra’s certificate changed, check the address again from the app.',
        ));
        return;
      }
      resolve(socket);
    });
    socket.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * A WebSocket client on a socket that is already connected and checked.
 *
 * @param {import('node:tls').TLSSocket} socket
 * @param {{ host: string, port: number, path?: string, timeoutMs?: number }} opts
 * @returns {Promise<WebSocketLink>}
 */
export function upgrade(socket, { host, port, path = '/api/', timeoutMs = 15_000 }) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const expect = createHash('sha1').update(key + GUID).digest('base64');
    const hostHeader = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error('Xen Orchestra did not accept the WebSocket upgrade in time')), timeoutMs);
    let settled = false;
    /** @param {Error} e */
    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.destroy();
      reject(e);
    };
    // A server that hangs up mid-handshake is said so at once, not after the
    // whole timeout spent waiting for an answer that cannot come.
    const onClose = () => fail(new Error('Xen Orchestra closed the connection before accepting the API upgrade'));
    socket.once('close', onClose);
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 16 * 1024) fail(new Error('Xen Orchestra answered the upgrade with something that is not HTTP'));
        return;
      }
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      settled = true;
      const lines = head.subarray(0, end).toString('latin1').split('\r\n');
      const status = /^HTTP\/1\.1 (\d{3})/.exec(lines[0] || '');
      const headers = new Map(lines.slice(1).map((l) => {
        const i = l.indexOf(':');
        return /** @type {[string, string]} */ ([l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()]);
      }));
      if (!status || status[1] !== '101' || headers.get('sec-websocket-accept') !== expect) {
        socket.destroy();
        reject(new Error(`Xen Orchestra refused the API connection (${status ? status[1] : 'no status'})`));
        return;
      }
      resolve(new WebSocketLink(socket, head.subarray(end + 4)));
    };
    socket.on('data', onData);
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  });
}

/** The frame layer: text messages in and out, pings answered, a close honoured. */
export class WebSocketLink {
  /**
   * @param {import('node:net').Socket} socket
   * @param {Buffer} [rest] bytes that arrived with the upgrade answer
   */
  constructor(socket, rest = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    /** @type {Buffer[]} */
    this.fragments = [];
    this.closed = false;
    /** @type {(text: string) => void} */
    this.onMessage = () => {};
    /** @type {(reason: string) => void} */
    this.onClose = () => {};
    socket.on('data', (/** @type {Buffer} */ chunk) => this.#take(chunk));
    socket.on('close', () => this.#closed('the connection closed'));
    socket.on('error', (e) => this.#closed(e.message));
    if (rest.length) this.#take(rest);
  }

  /** @param {string} text */
  send(text) {
    if (this.closed) throw new Error('the connection to Xen Orchestra is closed');
    this.socket.write(frame(0x1, Buffer.from(text, 'utf8')));
  }

  close() {
    if (this.closed) return;
    try {
      this.socket.write(frame(0x8, Buffer.alloc(0)));
    } catch {
      /* already going */
    }
    this.socket.end();
    this.#closed('closed here');
  }

  /** @param {string} reason */
  #closed(reason) {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.onClose(reason);
  }

  /** @param {Buffer} chunk */
  #take(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const parsed = parseFrame(this.buffer);
      if (parsed === null) return;
      if (parsed === 'too-big') {
        this.#closed('Xen Orchestra sent a message larger than this client accepts');
        return;
      }
      this.buffer = this.buffer.subarray(parsed.length);
      const { fin, opcode, payload } = parsed;
      if (opcode === 0x9) {
        this.socket.write(frame(0xa, payload));
      } else if (opcode === 0x8) {
        this.#closed('Xen Orchestra closed the connection');
        return;
      } else if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        const size = this.fragments.reduce((n, b) => n + b.length, 0);
        if (size > MAX_MESSAGE_BYTES) {
          this.#closed('Xen Orchestra sent a message larger than this client accepts');
          return;
        }
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.onMessage(text);
        }
      } else if (opcode !== 0xa) {
        this.#closed(`Xen Orchestra sent a frame this client does not speak (${opcode})`);
        return;
      }
    }
  }
}

/**
 * One frame as a client sends it: always masked, because RFC 6455 requires a
 * client to and a server must refuse one that is not.
 *
 * @param {number} opcode
 * @param {Buffer} payload
 */
export function frame(opcode, payload, { mask = true } = {}) {
  const len = payload.length;
  const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (len < 126) header[1] = len;
  else if (len < 65536) {
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const key = randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([header, key, body]);
}

/**
 * One frame out of a buffer, masked or not, or null when it has not all
 * arrived yet.
 *
 * @param {Buffer} buf
 * @returns {{ fin: boolean, opcode: number, payload: Buffer, length: number }|null|'too-big'}
 */
export function parseFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(MAX_MESSAGE_BYTES)) return 'too-big';
    len = Number(big);
    offset = 10;
  }
  if (len > MAX_MESSAGE_BYTES) return 'too-big';
  const keyLen = masked ? 4 : 0;
  if (buf.length < offset + keyLen + len) return null;
  let payload = buf.subarray(offset + keyLen, offset + keyLen + len);
  if (masked) {
    const key = buf.subarray(offset, offset + 4);
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
    payload = out;
  }
  return { fin, opcode, payload, length: offset + keyLen + len };
}

/**
 * JSON-RPC 2.0 over one of those links. Xen Orchestra also pushes
 * notifications on the same socket (`all`, object changes); a message with no
 * id is one of those and is ignored.
 */
export class XoRpc {
  /** @param {WebSocketLink} link */
  constructor(link, { callTimeoutMs = 60_000 } = {}) {
    this.link = link;
    this.callTimeoutMs = callTimeoutMs;
    /** @type {ReturnType<typeof describeCertificate>} What the server's certificate is, as `connectXo` found it. */
    this.certificate = null;
    this.nextId = 1;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
    this.pending = new Map();
    link.onMessage = (text) => this.#answer(text);
    link.onClose = (reason) => {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`the connection to Xen Orchestra ended: ${reason}`));
        this.pending.delete(id);
      }
    };
  }

  /**
   * @param {string} method
   * @param {Record<string, any>} [params]
   * @returns {Promise<any>}
   */
  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Xen Orchestra did not answer ${method} in time`));
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.link.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close() {
    this.link.close();
  }

  /** @param {string} text */
  #answer(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      // Xen Orchestra's own words, bounded, and never the params: the params
      // of the one call that can fail loudest carry a password.
      const why = typeof msg.error.message === 'string' ? msg.error.message.slice(0, 300) : 'an error';
      const err = /** @type {Error & { code?: unknown }} */ (new Error(why));
      err.code = msg.error.code;
      p.reject(err);
    } else {
      p.resolve(msg.result);
    }
  }
}

/**
 * Connect to Xen Orchestra's API at an address, pinned.
 *
 * @param {{ address: string, pin: string, timeoutMs?: number }} opts
 * @returns {Promise<XoRpc>}
 */
export async function connectXo({ address, pin, timeoutMs = 15_000 }) {
  const { host, port } = splitAddress(address);
  const socket = await connectPinnedTls({ host, port, pin, timeoutMs });
  const certificate = describeCertificate(socket, host);
  const link = await upgrade(socket, { host, port, timeoutMs });
  const rpc = new XoRpc(link);
  rpc.certificate = certificate;
  return rpc;
}
