// A stand-in Xen Orchestra for the hypervisor tests: HTML on `/signin`, a
// real WebSocket on `/api/` speaking Xen Orchestra's JSON-RPC, over TLS with
// a certificate made for the run, or over plain HTTP. Shared by
// test/xo-setup.test.js, which onboards a pool against it,
// test/xo-deploy.test.js, which installs Xen Orchestra first and then does
// the same against it with a certificate the machine made, and
// test/relay-end-to-end.test.js, which reaches it only through a phone. It
// counts its connections (`connections`), so a test can hold every one of
// them to having gone the way it should.
//
// THE STAND-IN IS REAL WHERE IT MATTERS. A TLS server with a certificate made
// for this run, a real WebSocket upgrade, and frames parsed the way the client
// parses them, so the pin, the handshake and the framing are exercised, not
// assumed. What it cannot prove is that a live Xen Orchestra names its methods
// as these do; that is why `inventory` asks the server for its method list
// before changing anything.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { FLEET_USER } from '../../src/fleet/host/xo-setup.js';
import { frame, parseFrame } from '../../src/fleet/host/xo-ws.js';

const openssl = spawnSync('openssl', ['version']).status === 0;
export const skip = !openssl && 'needs openssl to make a certificate for the stand-in';
export const PASSWORD = 'correct-horse-battery-staple-9';

/** A certificate and key for this run only, and the pin a phone would accept. */
export function certificate() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xo-cert-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=xo.test'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const pem = readFileSync(cert, 'utf8');
  return { key: readFileSync(key, 'utf8'), cert: pem, pin: createHash('sha256').update(new X509Certificate(pem).raw).digest('hex') };
}

/**
 * A stand-in Xen Orchestra: HTML on `/`, JSON-RPC on `/api/`. Records every
 * call, per connection, so a test can say what was asked and as whom.
 *
 * `tls` serves a certificate and key the caller made instead of one made
 * here, and `adminPassword` is the admin's password before anybody changes it.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ admin?: boolean, drop?: string[], plugin?: any, maxTokenMs?: number, plain?: boolean, sets?: any[], tls?: { key: string, cert: string, pin: string }, adminPassword?: string, more?: string[], vms?: Record<string, any>, templates?: Record<string, any>, nets?: Record<string, string> }} [opts]
 */
export async function standIn(t, { tls: givenTls = undefined, adminPassword = PASSWORD, admin = true, drop = [], plugin = { id: 'installer-updates', loaded: false, autoload: false, configuration: {} }, maxTokenMs = 0.5 * 365.25 * 24 * 60 * 60_000, plain = false, sets: given = [], more = /** @type {string[]} */ ([]), vms = /** @type {Record<string, any>} */ ({}), templates = /** @type {Record<string, any>} */ ({}), nets = /** @type {Record<string, string>} */ ({}), vifs = /** @type {Record<string, any>} */ ({}), xoServer = '5.211.1' } = {}) {
  const { key, cert, pin } = givenTls ?? certificate();
  /** @type {Array<{ conn: number, method: string, params: any, as: string|null }>} */
  const calls = [];
  const users = /** @type {any[]} */ ([{ id: 'u-admin', email: 'admin@admin.net', permission: admin ? 'admin' : 'none' }]);
  const sets = /** @type {any[]} */ (given);
  /** @type {Map<string, string[]>} the tags each network carries, as tag.add and tag.remove leave them */
  const tags = new Map([['net-mgmt', ['fleetwright-egress']], ['net-lab', []], ['net-dmz', []]]);
  const passwords = new Map([['admin@admin.net', adminPassword]]);
  const methods = Object.fromEntries(
    ['session.signIn', 'system.getMethodsInfo', 'xo.getAllObjects', 'user.getAll', 'user.create', 'user.set', 'resourceSet.getAll', 'resourceSet.create', 'resourceSet.set', 'token.create', 'plugin.get', 'plugin.load', 'plugin.enableAutoload', 'plugin.configure', 'tag.add', 'tag.remove']
      .concat(more)
      .filter((m) => !drop.includes(m))
      .map((m) => [m, {}]),
  );
  const objects = {
    pool: { p1: { id: 'p1', type: 'pool', name_label: 'Home', default_SR: 'sr1' } },
    host: { h1: { id: 'h1', type: 'host', cpus: { cores: 16 }, memory: { size: 64 * 1024 ** 3 } } },
    SR: {
      sr1: { id: 'sr1', type: 'SR', name_label: 'Local storage', $pool: 'p1', size: 1000 * 1024 ** 3, physical_usage: 200 * 1024 ** 3, content_type: 'user', shared: false },
      sr2: { id: 'sr2', type: 'SR', name_label: 'NFS', $pool: 'p1', size: 4000 * 1024 ** 3, physical_usage: 1000 * 1024 ** 3, content_type: 'user', shared: true },
      iso: { id: 'iso', type: 'SR', name_label: 'ISOs', $pool: 'p1', size: 50 * 1024 ** 3, physical_usage: 10 * 1024 ** 3, content_type: 'iso', shared: true },
    },
    get network() {
      const named = { 'net-mgmt': 'Pool-wide network associated with eth0', 'net-lab': 'lab', 'net-dmz': 'dmz', ...nets };
      return Object.fromEntries(Object.entries(named).map(([id, name]) => [id, { id, type: 'network', name_label: name, $pool: 'p1', tags: [...(tags.get(id) ?? [])] }]));
    },
    PIF: {
      pif1: { id: 'pif1', type: 'PIF', $network: 'net-mgmt', vlan: -1 },
      pif2: { id: 'pif2', type: 'PIF', $network: 'net-dmz', vlan: 30 },
    },
    VM: vms,
    'VM-template': templates,
    VIF: vifs,
  };
  let conns = 0;
  /** @param {import('node:net').Socket} socket */
  const serve = (socket) => {
    const conn = ++conns;
    /** @type {string|null} */
    let as = null;
    let buf = Buffer.alloc(0);
    let upgraded = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString('latin1');
        buf = buf.subarray(end + 4);
        if (head.startsWith('GET /api/')) {
          const k = /sec-websocket-key: (.+)/i.exec(head)?.[1]?.trim() ?? '';
          const accept = createHash('sha1').update(k + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
          socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
          upgraded = true;
          // A notification before any answer, the way Xen Orchestra pushes object changes.
          socket.write(frame(0x1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'all', params: {} })), { mask: false }));
        } else {
          socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><head><title>Xen Orchestra</title></head></html>');
          return;
        }
      }
      for (;;) {
        const f = parseFrame(buf);
        if (!f || f === 'too-big') return;
        buf = buf.subarray(f.length);
        if (f.opcode === 0x8) return void socket.end();
        const msg = JSON.parse(f.payload.toString('utf8'));
        calls.push({ conn, method: msg.method, params: msg.params, as });
        /** @param {any} result */
        const answer = (result) => socket.write(frame(0x1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })), { mask: false }));
        /** @param {string} message */
        const refuse = (message) => socket.write(frame(0x1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: 1, message } })), { mask: false }));
        const p = msg.params || {};
        switch (msg.method) {
          case 'session.signIn': {
            const u = users.find((x) => x.email === p.email);
            if (!u || passwords.get(p.email) !== p.password) refuse('invalid credentials');
            else {
              as = u.email;
              answer(u);
            }
            break;
          }
          case 'system.getMethodsInfo': answer(methods); break;
          case 'system.getServerVersion': answer(xoServer); break;
          case 'xo.getAllObjects': answer(/** @type {any} */ (objects)[p.filter?.type] ?? {}); break;
          case 'user.getAll': answer(users); break;
          case 'user.create': {
            const u = { id: `u-${users.length}`, email: p.email, permission: p.permission };
            users.push(u);
            passwords.set(p.email, p.password);
            answer(u.id);
            break;
          }
          case 'user.set': passwords.set(users.find((x) => x.id === p.id)?.email, p.password); answer(true); break;
          case 'resourceSet.getAll': answer(sets); break;
          case 'resourceSet.create': {
            const set = { id: `rs-${sets.length}`, ...p };
            sets.push(set);
            answer(set);
            break;
          }
          case 'resourceSet.set': {
            const set = sets.find((x) => x.id === p.id);
            if (set) Object.assign(set, p);
            answer(true);
            break;
          }
          case 'network.create': answer('net-uplink'); break;
          case 'tag.add': tags.set(p.id, [...(tags.get(p.id) ?? []), p.tag]); answer(true); break;
          case 'tag.remove': tags.set(p.id, (tags.get(p.id) ?? []).filter((x) => x !== p.tag)); answer(true); break;
          case 'token.create':
            // Xen Orchestra's own cap, and the words a limited user is given for going over it.
            if (p.expiresIn !== undefined && p.expiresIn > maxTokenMs) refuse('unknown error from the peer');
            else answer(as === FLEET_USER ? 'tok-limited-123' : 'tok-WRONG-USER');
            break;
          case 'plugin.get': answer(plugin ? [plugin] : []); break;
          default: answer(true);
        }
      }
    });
  };
  // PLAIN HTTP is the installer's default; the same stand-in, without TLS.
  const server = plain ? net.createServer(serve) : tls.createServer({ key, cert }, serve);
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  t.after(() => server.close());
  const address = `127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  return { address, pin, calls, users, sets, tags, passwords, connections: () => conns };
}
