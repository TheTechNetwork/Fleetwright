// A stand-in Xen Orchestra for the hypervisor tests: HTML on `/signin`, a
// real WebSocket on `/api/` speaking Xen Orchestra's JSON-RPC, over TLS with
// a certificate made for the run, or over plain HTTP. Shared by
// test/xo-setup.test.js, which onboards a pool against it,
// test/xo-deploy.test.js, which installs Xen Orchestra first and then does
// the same against it with a certificate the machine made, and
// test/relay-end-to-end.test.js, which reaches it only through a phone. It
// counts its connections (`connections`, and `live` for those still open),
// so a test can hold every one of them to having gone the way it should.
//
// ITS SERVERS, when a test gives it some (`servers`), behave as xo-server's
// xo-mixins/xen-servers.mjs does, which is where the reconnect job's reading
// of them comes from: `server.enable` refuses with `incorrect state` (25)
// unless the status is `disconnected` and no attempt of its own is running
// (`busy`, the `_connectingXenServers` window), sets `enabled` on its way
// in and answers once connected; `server.disable` sets `enabled: false` and
// answers once disconnected, refusing a server already off. A refused
// connection records its error on the server as Xen Orchestra does, and is
// answered as an admin is answered: SESSION_AUTHENTICATION_FAILED as
// `authenticationFailed` (8), PoolAlreadyConnected in its own words. A pool
// object is listed only while the server it is the connection of is
// connected.
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

/**
 * A VM's xenStoreData as Xen Orchestra hands it back after `vm.set` was given
 * `data`: every key under `vm-data/`, which its vm.set prefixes and its VM
 * objects keep (xo-server's api/vm.mjs and xapi-object-to-xo.mjs). Fixtures
 * that seeded the bare names hid that a router's key was never read back.
 *
 * @param {Record<string, string>} data
 */
export function xenStoreAsXo(data) {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [`vm-data/${k}`, v]));
}

/**
 * @typedef {{ id: string, label: string, host: string, status: string, enabled: boolean, error?: any, poolId: string, poolName?: string,
 *   busy?: number, linger?: number, slow?: number, refuse?: 'auth'|'pool'|'down', lingering?: number, slowing?: number, cut?: boolean, stumble?: boolean, stumbling?: boolean }} XoServer
 */

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
 * `servers` are Xen Orchestra's own, each `{ id, label, host, status,
 * enabled, error?, poolId, poolName }` and, to play how one behaves:
 * `busy` (enables refused as `connecting` before one is taken), `linger`
 * (looks it stays `disconnecting` after a disable), `slow` (looks it stays
 * `connecting` after an enable; Infinity for never) and `refuse` (`auth`,
 * `pool` or `down`: what every enable fails with). Two play the connection
 * failing in the middle of a reconnect's cycle: `cut` ends it just after a
 * disable of that server answers, and `stumble` refuses the first look
 * after one and keeps the connection.
 *
 * `refuse` names methods the server lists and still turns down, each with the
 * words it refuses them in, for a job that must say what it could not do.
 * `on` is called with a call's params when it arrives, before it is answered:
 * how a test lands a cancel while that call is in flight.
 *
 * @param {{ admin?: boolean, drop?: string[], plugin?: any, maxTokenMs?: number, plain?: boolean, sets?: any[], tls?: { key: string, cert: string, pin: string }, adminPassword?: string, more?: string[], vms?: Record<string, any>, templates?: Record<string, any>, nets?: Record<string, string>, servers?: XoServer[], refuse?: Record<string, string>, on?: Record<string, (params: any) => void> }} [opts]
 */
export async function standIn(t, { tls: givenTls = undefined, adminPassword = PASSWORD, admin = true, drop = [], plugin = { id: 'installer-updates', loaded: false, autoload: false, configuration: {} }, watchdog = /** @type {any} */ (null), maxTokenMs = 0.5 * 365.25 * 24 * 60 * 60_000, plain = false, sets: given = [], more = /** @type {string[]} */ ([]), vms = /** @type {Record<string, any>} */ ({}), templates = /** @type {Record<string, any>} */ ({}), nets = /** @type {Record<string, string>} */ ({}), vifs = /** @type {Record<string, any>} */ ({}), servers = /** @type {XoServer[]|null} */ (null), refuse: refused = /** @type {Record<string, string>} */ ({}), on = /** @type {Record<string, (params: any) => void>} */ ({}) } = {}) {
  const { key, cert, pin } = givenTls ?? certificate();
  /** @type {Array<{ conn: number, method: string, params: any, as: string|null }>} */
  const calls = [];
  const users = /** @type {any[]} */ ([{ id: 'u-admin', email: 'admin@admin.net', permission: admin ? 'admin' : 'none' }]);
  const sets = /** @type {any[]} */ (given);
  /** @type {Map<string, string[]>} the tags each network carries, as tag.add and tag.remove leave them */
  const tags = new Map([['net-mgmt', ['fleetwright-egress']], ['net-lab', []], ['net-dmz', []]]);
  const passwords = new Map([['admin@admin.net', adminPassword]]);
  /**
   * @type {Map<string, string[]>} each user's tokens, as xo-server keeps them
   * by user: `token.create` adds one and `token.deleteAll` removes the
   * signed-in user's but the one named in `except`. The limited user's first
   * is `tok-limited-123`, which the handoff tests collect; later ones count up.
   */
  const tokens = new Map();
  const methods = Object.fromEntries(
    ['session.signIn', 'system.getMethodsInfo', 'xo.getAllObjects', 'user.getAll', 'user.create', 'user.set', 'resourceSet.getAll', 'resourceSet.create', 'resourceSet.set', 'token.create', 'token.deleteAll', 'plugin.get', 'plugin.load', 'plugin.enableAutoload', 'plugin.configure', 'tag.add', 'tag.remove']
      .concat(servers ? ['server.getAll', 'server.enable', 'server.disable'] : [])
      .concat(more)
      .filter((m) => !drop.includes(m))
      .map((m) => [m, {}]),
  );
  const objects = {
    // With servers, the pools of the connected ones; without, the one pool.
    get pool() {
      if (!servers) return { p1: { id: 'p1', type: 'pool', name_label: 'Home', default_SR: 'sr1' } };
      return Object.fromEntries(servers.filter((s) => s.status === 'connected' && s.poolId).map((s) => [s.poolId, { id: s.poolId, type: 'pool', name_label: s.poolName ?? s.poolId }]));
    },
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
  // THE ONES STILL OPEN, so a test can say a job let go of its session.
  let live = 0;
  /** @param {import('node:net').Socket} socket */
  const serve = (socket) => {
    const conn = ++conns;
    live++;
    socket.once('close', () => live--);
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
        /** @param {string} message @param {number} [code] @param {any} [data] */
        const refuse = (message, code = 1, data = undefined) => socket.write(frame(0x1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message, ...(data ? { data } : {}) } })), { mask: false }));
        const p = msg.params || {};
        const server = servers?.find((s) => s.id === p.id);
        on[msg.method]?.(p);
        // A METHOD THE SERVER LISTS AND REFUSES, in the words a test gave it:
        // what a limited user gets for a call above its station, say.
        if (Object.hasOwn(refused, msg.method)) {
          refuse(refused[msg.method]);
          continue;
        }
        switch (msg.method) {
          case 'server.getAll':
            if (servers?.some((s) => s.stumbling)) {
              for (const s of servers) s.stumbling = false;
              refuse('the event loop was busy', 1);
              break;
            }
            // A look moves a server along whatever it is in the middle of.
            for (const s of servers ?? []) {
              if (s.status === 'disconnecting' && --s.lingering <= 0) s.status = 'disconnected';
              if (s.status === 'connecting' && s.slowing !== undefined && --s.slowing <= 0) Object.assign(s, { status: 'connected', error: undefined, slowing: undefined });
            }
            answer((servers ?? []).map((s) => ({
              id: s.id,
              label: s.label,
              host: s.host,
              username: 'root',
              status: s.status,
              enabled: s.enabled,
              readOnly: false,
              allowUnauthorized: true,
              ...(s.error ? { error: s.error } : {}),
              ...(s.status === 'connected' ? { poolId: s.poolId } : {}),
            })));
            break;
          case 'server.enable': {
            if (!server) { refuse(`no such xenServer ${p.id}`, 1); break; }
            const busy = (server.busy ?? 0) > 0;
            if (server.status !== 'disconnected' || busy) {
              if (busy) server.busy = /** @type {number} */ (server.busy) - 1;
              refuse('incorrect state', 25, { actual: busy ? 'connecting' : server.status, expected: 'disconnected', object: server.id, property: 'status' });
              break;
            }
            server.enabled = true;
            if (server.refuse) {
              const why = {
                auth: { recorded: { code: 'SESSION_AUTHENTICATION_FAILED', params: ['root', ''], message: 'SESSION_AUTHENTICATION_FAILED(root, )' }, code: 8, message: 'authentication failed' },
                pool: { recorded: { name: 'PoolAlreadyConnected', message: 'this pool is already connected', poolId: server.poolId }, code: -32000, message: 'this pool is already connected' },
                down: { recorded: { code: 'EHOSTUNREACH', message: 'connect EHOSTUNREACH' }, code: 9, message: 'server unreachable' },
              }[server.refuse];
              server.error = why.recorded;
              refuse(why.message, why.code);
              break;
            }
            if (server.slow) Object.assign(server, { status: 'connecting', slowing: server.slow });
            else Object.assign(server, { status: 'connected', error: undefined });
            answer(true);
            break;
          }
          case 'server.disable':
            if (!server) { refuse(`no such xenServer ${p.id}`, 1); break; }
            if (server.status === 'disconnected' && !server.enabled) {
              refuse('incorrect state', 25, { actual: 'disconnected', expected: ['connected', 'connecting'], object: server.id, property: 'status' });
              break;
            }
            server.enabled = false;
            if (server.linger) Object.assign(server, { status: 'disconnecting', lingering: server.linger });
            else if (server.status !== 'disconnected') server.status = 'disconnected';
            if (server.stumble) server.stumbling = true;
            answer(true);
            if (server.cut) socket.end();
            break;
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
          case 'xo.getAllObjects': answer(/** @type {any} */ (objects)[p.filter?.type] ?? {}); break;
          case 'user.getAll': answer(users); break;
          case 'user.create': {
            const u = { id: `u-${users.length}`, email: p.email, permission: p.permission };
            users.push(u);
            passwords.set(p.email, p.password);
            answer(u.id);
            break;
          }
          case 'user.set': {
            // As xo-server's updateUser does: a password only when one is
            // given, and preferences merged in, a null one deleted.
            const u = users.find((x) => x.id === p.id);
            if (p.password !== undefined) passwords.set(u?.email, p.password);
            if (u && p.preferences) {
              const prefs = { ...u.preferences };
              for (const [k, v] of Object.entries(p.preferences)) {
                if (v === null || v === undefined) delete prefs[k];
                else prefs[k] = v;
              }
              u.preferences = prefs;
            }
            answer(true);
            break;
          }
          // AS ITS vm.set DOES TO xenStoreData: each key filed under
          // `vm-data/`, and a null one deleted, on the VM xo.getAllObjects
          // then shows to everybody signed in.
          case 'vm.set': {
            const vm = Object.hasOwn(vms, p.id) ? vms[p.id] : undefined;
            if (vm && p.xenStoreData) {
              const data = { ...vm.xenStoreData };
              for (const [k, v] of Object.entries(p.xenStoreData)) {
                if (v === null) delete data[`vm-data/${k}`];
                else data[`vm-data/${k}`] = v;
              }
              vm.xenStoreData = data;
            }
            answer(true);
            break;
          }
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
          // The new VM's id, as Xen Orchestra answers; the pool's own
          // machine is listed by it (xo-holder.js, ensureHolder).
          case 'vm.create': answer(`vm-made-${calls.filter((c) => c.method === 'vm.create').length}`); break;
          case 'tag.add': tags.set(p.id, [...(tags.get(p.id) ?? []), p.tag]); answer(true); break;
          case 'tag.remove': tags.set(p.id, (tags.get(p.id) ?? []).filter((x) => x !== p.tag)); answer(true); break;
          case 'token.create': {
            // Xen Orchestra's own cap, and the words a limited user is given for going over it.
            if (p.expiresIn !== undefined && p.expiresIn > maxTokenMs) {
              refuse('unknown error from the peer');
              break;
            }
            const mine = tokens.get(String(as)) ?? [];
            const made = as === FLEET_USER ? `tok-limited-${123 + mine.length}` : 'tok-WRONG-USER';
            tokens.set(String(as), [...mine, made]);
            answer(made);
            break;
          }
          case 'token.deleteAll':
            // As xo-server's token.deleteAll: the signed-in user's own, all but `except`.
            tokens.set(String(as), (tokens.get(String(as)) ?? []).filter((tok) => tok === p.except));
            answer(true);
            break;
          case 'plugin.get': answer([plugin, watchdog].filter(Boolean)); break;
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
  return { address, pin, calls, users, sets, tags, passwords, tokens, connections: () => conns, live: () => live };
}
