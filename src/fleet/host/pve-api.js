// Proxmox VE's own REST API, as a box holding a pool's token speaks it.
// docs/proxmox.md, "Setting it up", for how a record comes to trust a cluster.
//
// ONE REQUEST, ONE CONNECTION, CHECKED BEFORE A BYTE IS WRITTEN. Every call
// opens TLS, holds the server to what the record trusts, and only then hands
// the socket to `https.request`, so the `Authorization` header, which is the
// token, is never written to a server that was not the one set up. A box asks
// a pool a few dozen things a pass; a connection each costs nothing worth the
// state a kept-alive one would carry.
//
// TWO WAYS TO TRUST A SERVER, and the record says which (pve-pools.js,
// pveRecord). Neither turns chain checking off.
//
//   ca      CERTIFICATES THE SETUP READ ON THE NODE, as the only roots.
//           Normally the cluster's own CA, /etc/pve/pve-root-ca.pem: every
//           node's certificate is signed by it and renewed by Proxmox under it,
//           so a pin to the cluster survives what a pin to one certificate does
//           not, the renewal `pvecm updatecerts` makes and a second node of the
//           same cluster. This is the lesson of Xen Orchestra's pin (xo-ws.js),
//           which named one leaf and broke the day it changed. When somebody
//           installed a certificate of their own (pveproxy-ssl.pem) that no CA
//           of the cluster signed and no public one did either, the setup hands
//           over that file instead, which must hold its own root. Either way
//           `ca` replaces the system's roots, so a publicly signed certificate
//           for the same name is refused. The name is not checked, because the
//           address is most often an IP the certificate may not list, and roots
//           that exist only on this cluster already say which servers it is.
//   public  A PUBLICLY TRUSTED CERTIFICATE (ACME, which Proxmox renews every
//           sixty days, or a tunnel's), checked as a browser checks it. When
//           the address is an IP, the record also names the host the
//           certificate was issued to (`name`), and the certificate is held
//           to that name while the IP is dialled: what a hosts-file entry
//           does, for this one connection, with no DNS and no system file.
//           Checked against the IP, as it was, every box refused a cluster
//           with a valid certificate. A name the certificate does not cover
//           is refused exactly as a browser would refuse it.

import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { splitAddress, upgrade } from './xo-ws.js';

/** Proxmox's API port, when an address names none. */
export const PVE_PORT = 8006;
/** The most of an answer read, so a server cannot fill this process's memory. */
export const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

/**
 * @typedef {{ ca?: string|null, trust?: 'ca'|'public', name?: string|null }} Trust
 */

export class PveError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Open TLS to the server, held to the record's trust, or refuse.
 *
 * `roots` stands in for the system's roots, for the tests alone: a public
 * certificate cannot be made for one.
 *
 * @param {{ host: string, port: number, trust: Trust, timeoutMs?: number, roots?: string[] }} opts
 * @returns {Promise<tls.TLSSocket>}
 */
export function connectTrusted({ host, port, trust, timeoutMs = 15_000, roots }) {
  const kind = trust.ca ? 'ca' : 'public';
  const name = kind === 'public' && typeof trust.name === 'string' && trust.name ? trust.name : null;
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      // THE NAME TO HOLD IT TO: the record's, for a public certificate at an
      // IP; else the address itself when it is a name.
      ...(name ? { servername: name } : net.isIP(host) ? {} : { servername: host }),
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: true,
      ...(kind === 'ca'
        ? { ca: [String(trust.ca)], checkServerIdentity: () => undefined }
        : {
            ...(roots ? { ca: roots } : {}),
            ...(name ? { checkServerIdentity: (/** @type {string} */ _host, /** @type {any} */ cert) => tls.checkServerIdentity(name, cert) } : {}),
          }),
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${host}:${port} did not answer within ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (e) => {
      clearTimeout(timer);
      // The chain check's own words name a CA nobody here chose; say which.
      if (kind === 'ca' && /certificate|self.signed|issuer/i.test(e.message)) {
        reject(new Error(`${host}:${port} answered with a certificate this cluster's CA did not sign. Nothing was sent.`));
        return;
      }
      reject(e);
    });
  });
}

/**
 * A form body as Proxmox reads one. Booleans are 1 and 0, as its schema has
 * them; undefined and null are left out rather than sent as the word.
 *
 * @param {Record<string, unknown>} params
 */
export function formOf(params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    body.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  return body.toString();
}

/**
 * A client for one Proxmox address and token.
 *
 * `connect` is replaceable for the tests, which give it a stand-in's socket.
 */
export class PveApi {
  /**
   * @param {{ address: string, token: string, trust: Trust, timeoutMs?: number, connect?: typeof connectTrusted }} opts
   */
  constructor({ address, token, trust, timeoutMs = 15_000, connect = connectTrusted }) {
    const { host, port } = splitAddress(address, PVE_PORT);
    this.host = host;
    this.port = port;
    this.address = address;
    this.token = token;
    this.trust = trust;
    this.timeoutMs = timeoutMs;
    this.connect = connect;
  }

  /**
   * One call. Answers `data`, which is what every Proxmox endpoint wraps its
   * answer in; throws PveError with Proxmox's own words on anything else.
   *
   * @param {'GET'|'POST'|'PUT'|'DELETE'} method
   * @param {string} path  under /api2/json, starting with a slash
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  async call(method, path, params = {}) {
    if (!path.startsWith('/') || path.includes('..')) throw new Error(`not a Proxmox API path: ${path}`);
    const socket = await this.connect({ host: this.host, port: this.port, trust: this.trust, timeoutMs: this.timeoutMs });
    const form = formOf(params);
    const inQuery = method === 'GET' || method === 'DELETE';
    const target = `/api2/json${path}${inQuery && form ? `?${form}` : ''}`;
    // AN AGENT FOR THIS ONE SOCKET. `agent: false` with `createConnection`
    // looks like it says the same and does not: Node then makes an agent of
    // its own, which ignores `createConnection` and dials again with the
    // system's roots, so the request went out on a connection nothing here
    // had checked. This agent can only ever hand out the socket checked above.
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = () => socket;
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          method,
          host: this.host,
          port: this.port,
          path: target,
          agent,
          headers: {
            Authorization: `PVEAPIToken=${this.token}`,
            Accept: 'application/json',
            ...(inQuery ? {} : { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          /** @type {Buffer[]} */
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size > MAX_ANSWER_BYTES) {
              req.destroy(new Error(`${this.address} answered with more than ${MAX_ANSWER_BYTES} bytes`));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            /** @type {any} */
            let body = null;
            try {
              body = text ? JSON.parse(text) : null;
            } catch {
              /* Proxmox puts its reason in the status line when the body is not JSON */
            }
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              resolve(body?.data ?? null);
              return;
            }
            // PROXMOX'S OWN WORDS: the status line carries the reason ("Permission
            // check failed (/pool/fleetwright, VM.Allocate)"), and a parameter
            // error lists each field under `errors`.
            const fields = body?.errors && typeof body.errors === 'object' ? Object.entries(body.errors).map(([k, v]) => `${k}: ${String(v).trim()}`).join('; ') : '';
            const reason = String(res.statusMessage || '').trim() || `HTTP ${status}`;
            reject(new PveError(`${reason}${fields ? ` (${fields})` : ''}`.slice(0, 300), status));
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`${this.address} did not answer within ${Math.round(this.timeoutMs / 1000)} seconds`)));
      req.on('error', reject);
      if (!inQuery) req.write(form);
      req.end();
    });
  }

  /**
   * A WebSocket to one API path, on a socket checked as `call`'s are, with
   * the token on the upgrade: Proxmox VE's `vncwebsocket`, which is how a
   * machine's serial console is read (pve-console.js). Binary frames, as the
   * console sends them.
   *
   * @param {string} path  under /api2/json, starting with a slash
   * @param {Record<string, unknown>} [params]
   */
  async websocket(path, params = {}) {
    if (!path.startsWith('/') || path.includes('..')) throw new Error(`not a Proxmox API path: ${path}`);
    const socket = await this.connect({ host: this.host, port: this.port, trust: this.trust, timeoutMs: this.timeoutMs });
    const form = formOf(params);
    return upgrade(/** @type {any} */ (socket), {
      host: this.host,
      port: this.port,
      path: `/api2/json${path}${form ? `?${form}` : ''}`,
      timeoutMs: this.timeoutMs,
      headers: { Authorization: `PVEAPIToken=${this.token}`, 'Sec-WebSocket-Protocol': 'binary' },
      binary: true,
      who: this.address,
    });
  }

  /** @param {string} path @param {Record<string, unknown>} [params] */
  get(path, params) {
    return this.call('GET', path, params);
  }

  /** @param {string} path @param {Record<string, unknown>} [params] */
  post(path, params) {
    return this.call('POST', path, params);
  }

  /** @param {string} path @param {Record<string, unknown>} [params] */
  put(path, params) {
    return this.call('PUT', path, params);
  }

  /** @param {string} path @param {Record<string, unknown>} [params] */
  del(path, params) {
    return this.call('DELETE', path, params);
  }

  /**
   * Wait for a task Proxmox started (a clone, a start) to end, and say how.
   * A UPID names its node in its second field.
   *
   * @param {string} upid @param {{ timeoutMs?: number, pollMs?: number, sleep?: (ms: number) => Promise<void> }} [opts]
   */
  async waitTask(upid, { timeoutMs = 10 * 60_000, pollMs = 1500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const node = String(upid).split(':')[1];
    if (!node || !/^UPID:/.test(String(upid))) throw new Error(`not a Proxmox task: ${upid}`);
    const until = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.get(`/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`);
      if (s?.status === 'stopped') {
        if (s.exitstatus === 'OK') return;
        throw new Error(String(s.exitstatus || 'the task failed and said nothing').slice(0, 300));
      }
      if (Date.now() > until) throw new Error(`the task was still running after ${Math.round(timeoutMs / 60_000)} minutes`);
      await sleep(pollMs);
    }
  }
}
