// A VM's console for a phone away from the pool, end to end in one process:
// the phone's half opening real TLS, the coordinator's switchboard
// (tunnels.js), the box's TCP (console-tunnel.js), and a stand-in Xen
// Orchestra serving TLS on loopback. docs/manage.md, "The console".
//
// What is pinned is what makes a tunnel safe to offer: the phone's TLS reaches
// Xen Orchestra and is held to its certificate there, nothing the coordinator
// or the box carries is readable, and a tunnel goes only to a pool the box
// holds for that person, through a box new enough to carry it.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { ConsoleTunnels } from '../src/fleet/host/console-tunnel.js';

const openssl = spawnSync('openssl', ['version']).status === 0;
const skip = !openssl && 'needs openssl to make a certificate for the stand-in';
const OWNER = 'eli@example.com';
const PHONE = 'cl_phone_1';
const XO = 'xo.lan:8443';
const SCREEN = 'RFB 003.008 the-screen-nobody-between-may-read';
const COOKIE = 'token=the-console-token-nobody-between-may-read';

function certificate() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xo-console-'));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-days', '1', '-subj', '/CN=xo.lan'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const cert = readFileSync(path.join(dir, 'c.pem'), 'utf8');
  return { key: readFileSync(path.join(dir, 'k.pem'), 'utf8'), cert, pin: createHash('sha256').update(new X509Certificate(cert).raw).digest('hex') };
}

/** A stand-in Xen Orchestra: TLS on loopback, answering the console's first bytes with a screen. */
async function xoStandIn(/** @type {{ key: string, cert: string }} */ c) {
  /** @type {string[]} */
  const heard = [];
  const server = tls.createServer({ key: c.key, cert: c.cert }, (s) => {
    s.on('data', (d) => {
      heard.push(String(d));
      s.write(SCREEN);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  return { heard, port: /** @type {any} */ (server.address()).port, close: () => new Promise((r) => server.close(() => r(null))) };
}

/**
 * A fleet with one box at `protocol` holding `holds` for OWNER, its tunnel
 * half joined to the coordinator, and every frame either way kept.
 */
function fleet({ protocol = 17, holds = XO, port = 1, owner = OWNER } = {}) {
  const core = new CoordinatorCore({});
  /** @type {any[]} */
  const carried = [];
  /** @type {string[]} */
  const dialed = [];
  const box = new ConsoleTunnels({
    send: (frame) => {
      carried.push(frame);
      void core.onHostMessage('deb14', { kind: 'tunnel', ...frame });
    },
    where: (who, address) => (who === owner && address === holds ? { host: '127.0.0.1', port } : null),
    connect: (o) => {
      dialed.push(`${o.host}:${o.port}`);
      return net.connect(o);
    },
  });
  core.registry.connect('deb14', (/** @type {any} */ msg) => {
    if (msg.kind === 'tunnel') {
      carried.push(msg);
      box.onFrame(msg);
    }
  });
  core.registry.recordHealth('deb14', { hub: { reachable: true }, protocol, maxSessions: 5, running: 0, free: 5, labels: [], xo: [{ owner, address: holds, reachable: true }] });
  return { core, carried, dialed };
}

/** The phone's half: its socket to the coordinator, and a byte stream TLS can be opened over. */
function phone(/** @type {CoordinatorCore} */ core, address = XO) {
  /** @type {any[]} */
  const got = [];
  /** @type {Array<[number, string]>} */
  const closed = [];
  /** @type {string|null} */
  let tunnel = null;
  /** @type {(v: unknown) => void} */
  let opened = () => {};
  const open = new Promise((r) => {
    opened = r;
  });
  const wire = new Duplex({
    read() {},
    write(chunk, _enc, done) {
      core.tunnelFromPhone(/** @type {string} */ (tunnel), JSON.stringify({ op: 'data', data: Buffer.from(chunk).toString('base64') }));
      done();
    },
  });
  const answer = core.openTunnel({ email: OWNER }, PHONE, { address }, {
    send: (m) => {
      got.push(m);
      if (m.op === 'open') opened(true);
      if (m.op === 'data') wire.push(Buffer.from(String(m.data), 'base64'));
      if (m.op === 'closed') wire.push(null);
    },
    close: (c, r) => closed.push([c, r]),
  });
  if (answer.ok) tunnel = answer.tunnel;
  return { answer, got, closed, wire, open };
}

test('the phone’s own TLS reaches Xen Orchestra through the box, and nothing between can read the console', { skip }, async () => {
  const c = certificate();
  const xo = await xoStandIn(c);
  try {
    const f = fleet({ port: xo.port });
    const p = phone(f.core);
    assert.equal(p.answer.ok, true, /** @type {any} */ (p.answer).text);
    assert.equal(p.got[0].op, 'ready');
    assert.equal(p.got[0].hostId, 'deb14');
    await p.open;
    assert.deepEqual(f.dialed, [`127.0.0.1:${xo.port}`]);
    // THE PHONE HOLDS IT TO THE PIN, as on the pool's own network: here the
    // stand-in's certificate is its own root, and the pin is checked after.
    const secure = tls.connect({ socket: /** @type {any} */ (p.wire), ca: c.cert, checkServerIdentity: () => undefined, servername: 'xo.lan' });
    await new Promise((r) => secure.once('secureConnect', r));
    const seen = createHash('sha256').update(/** @type {any} */ (secure.getPeerX509Certificate()).raw).digest('hex');
    assert.equal(seen, c.pin);
    secure.write(`GET /api/consoles/vm-1 HTTP/1.1\r\nCookie: ${COOKIE}\r\n\r\n`);
    const screen = await new Promise((r) => secure.once('data', (d) => r(String(d))));
    assert.equal(screen, SCREEN);
    assert.ok(xo.heard.join('').includes(COOKIE), 'Xen Orchestra did not hear the phone');
    // NEITHER THE BOX NOR THE COORDINATOR CARRIED ANYTHING READABLE.
    const crossed = [...f.carried, ...p.got].filter((m) => m.op === 'data').map((m) => Buffer.from(String(m.data), 'base64').toString('latin1')).join('');
    assert.ok(crossed.length > 0);
    assert.ok(!crossed.includes('the-console-token') && !crossed.includes('the-screen'), 'the console crossed readable');
    secure.destroy();
    p.wire.destroy();
    f.core.tunnelPhoneGone(/** @type {any} */ (p.answer).tunnel);
  } finally {
    await xo.close();
  }
});

test('a tunnel goes only to a pool a box holds for that person, through a box new enough to carry it', async () => {
  // NOBODY HOLDS IT for this person: refused down the socket, nothing dialed.
  const none = fleet({ owner: 'sam@example.com' });
  const refused = phone(none.core);
  assert.equal(refused.answer.ok, false);
  assert.equal(/** @type {any} */ (refused.answer).error.code, 'no_hosts');
  assert.equal(refused.got.at(-1).op, 'closed');
  assert.deepEqual(refused.closed[0][0], 1008);
  assert.deepEqual(none.dialed, []);
  // AN OLDER BOX holds it: said as that, not as nobody holding it.
  const old = fleet({ protocol: 16 });
  const outdated = phone(old.core);
  assert.equal(/** @type {any} */ (outdated.answer).error.code, 'host_outdated');
  // THE BOX CHECKS AGAIN: told to dial an address it holds nothing at, it
  // refuses, and the phone hears why.
  const f = fleet({ holds: 'other.lan' });
  f.core.registry.recordHealth('deb14', { hub: { reachable: true }, protocol: 17, maxSessions: 5, running: 0, free: 5, labels: [], xo: [{ owner: OWNER, address: XO, reachable: true }] });
  const p = phone(f.core);
  assert.equal(p.answer.ok, true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.dialed, []);
  assert.equal(p.got.at(-1).op, 'closed');
  assert.match(p.got.at(-1).text, /holds no pool of yours at xo\.lan:8443/);
});

test('bytes before the box has connected, or that are not ours, are not carried', () => {
  const f = fleet();
  /** @type {any[]} */
  const toBox = [];
  f.core.tunnels.toHost = (_h, frame) => toBox.push(frame);
  const p = phone(f.core);
  const id = /** @type {any} */ (p.answer).tunnel;
  f.core.tunnelFromPhone(id, JSON.stringify({ op: 'data', data: 'aGVsbG8=' }));
  assert.ok(!toBox.some((m) => m.op === 'data'), 'bytes went to a box that had not connected');
  f.core.tunnels.fromHost('deb14', { tunnel: id, op: 'opened' });
  f.core.tunnelFromPhone(id, JSON.stringify({ op: 'data', data: 'not base64!' }));
  assert.equal(p.got.at(-1).op, 'closed');
  assert.match(p.got.at(-1).text, /bytes it does not carry/);
});
