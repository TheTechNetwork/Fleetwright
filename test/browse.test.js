// A page through a machine, end to end in one process: the phone's streams,
// the coordinator's switchboard (src/fleet/coordinator/browse.js), the box's
// rules and wire (src/fleet/host/browse.js), and the hub's door into a
// session's container (src/core/session-port.js), with real sockets and real
// TLS. docs/browse.md.
//
// What is pinned is what makes the feature safe to offer: the phone's TLS
// reaches the page and nothing between can read it; the box, not the
// coordinator, decides where every connection goes, and never to itself or
// to a private address its owner did not list; a session's ports open only
// for the person who started it, on a box that contains its sessions.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { Browses, BROWSE_MAX_STREAMS, MAX_BROWSES_EACH, browseTarget } from '../src/fleet/coordinator/browse.js';
import { browseShape } from '../src/fleet/coordinator/registry.js';
import { BrowseCarrier, BROWSE_WINDOW, decideBrowse, isPublicAddress, parseBrowseHosts, plainAddress } from '../src/fleet/host/browse.js';
import { answerSessionPort, DIAL_SCRIPT, isSessionPortUpgrade } from '../src/core/session-port.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { loadSidecarConfig, validateSidecarConfig } from '../src/fleet/host/config.js';

const OWNER = 'eli@example.com';
const OTHER = 'sam@example.com';
const PHONE = 'cl_phone_1';
const BOX = 'deb18';
/** Where a public name resolves, in this test's world. */
const PUBLIC_IP = '93.184.215.14';
const WORLD = /** @type {Record<string, string[]>} */ ({
  'example.com': [PUBLIC_IP],
  'rebind.example': ['10.9.9.9'],
  'nas.lan': ['192.168.1.20'],
  'both.example': ['10.1.1.1', PUBLIC_IP],
});
const lookup = async (/** @type {string} */ n) => WORLD[n] ?? [];

const openssl = spawnSync('openssl', ['version']).status === 0;

/** A server on loopback that answers each connection's first bytes. @param {(heard: string) => string} answer */
async function standIn(answer, { secure = null } = /** @type {{ secure?: { key: string, cert: string }|null }} */ ({})) {
  /** @type {string[]} */
  const heard = [];
  const onConn = (/** @type {net.Socket} */ s) => {
    s.on('data', (d) => {
      heard.push(String(d));
      s.end(answer(String(d)));
    });
    s.on('error', () => {});
  };
  const server = secure ? tls.createServer(secure, onConn) : net.createServer(onConn);
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  return { heard, port: /** @type {any} */ (server.address()).port, close: () => new Promise((r) => server.close(() => r(null))) };
}

/**
 * A fleet with one box that speaks 18 and reports what it opens; its browse
 * half joined to the coordinator, every frame either way kept. `route` maps
 * an address the box decided on to a local port, because every public
 * address in this test is a stand-in on loopback.
 */
function fleet({
  protocol = 18,
  web = true,
  hosts = ['nas.lan', '192.168.1.0/24:8080'],
  sandboxed = true,
  sessions = [{ name: 'web', status: 'running', createdBy: `fleet:${OWNER}` }],
  actsFor = OWNER,
  pinned = /** @type {string[]|null} */ ([]),
  route = /** @type {Record<string, number>} */ ({}),
  sessionPort = /** @type {number|null} */ (null),
} = {}) {
  const core = new CoordinatorCore({});
  /** @type {any[]} */
  const carried = [];
  /** @type {string[]} */
  const dialed = [];
  /** @type {Array<{ owner: string, session: string, port: number }>} */
  const sessionDials = [];
  const { entries } = parseBrowseHosts(hosts);
  const box = new BrowseCarrier({
    send: (frame) => {
      carried.push({ from: 'box', ...frame });
      void core.onHostMessage(BOX, { kind: 'browse', ...frame });
    },
    policy: () => ({ web, entries }),
    checkSession: async (owner, session) => {
      const row = sessions.find((s) => s.name === session);
      if (!sandboxed) return { ok: false, text: 'not contained' };
      if (!row || row.createdBy !== `fleet:${owner}`) return { ok: false, text: `no session of yours called ${session}` };
      return { ok: true };
    },
    dialSession: async (owner, session, port) => {
      sessionDials.push({ owner, session, port });
      if (sessionPort === null) return { ok: false, text: `Nothing is listening on port ${port} in ${session}.` };
      return { ok: true, wire: net.connect({ host: '127.0.0.1', port: sessionPort }) };
    },
    pinned: () => pinned,
    lookup,
    own: () => ({ addresses: ['198.51.100.7'], networks: [] }),
    connect: (o) => {
      dialed.push(`${o.host}:${o.port}`);
      const local = route[`${o.host}:${o.port}`];
      return net.connect({ host: '127.0.0.1', port: local ?? 1 });
    },
  });
  core.registry.connect(BOX, (/** @type {any} */ msg) => {
    if (msg.kind === 'browse') {
      carried.push({ from: 'coordinator', ...msg });
      box.onFrame(msg);
    }
  });
  const entry = core.registry.hosts.get(BOX);
  if (entry) /** @type {any} */ (entry).actsFor = actsFor;
  core.registry.recordHealth(BOX, {
    hub: { reachable: true }, protocol, maxSessions: 5, running: sessions.length, free: 5, labels: [], sandboxed,
    sessions,
    ...(protocol >= 18 ? { browse: { sessions: sandboxed, web, hosts } } : {}),
  });
  return { core, box, carried, dialed, sessionDials };
}

/**
 * The phone's half: its socket to the coordinator, and a way to open a
 * stream and get a byte stream for it.
 *
 * @param {CoordinatorCore} core
 * @param {{ host?: string, session?: string|null, who?: { email: string, admin?: boolean } }} [ask]
 */
function phone(core, { host = BOX, session = null, who = { email: OWNER } } = {}) {
  /** @type {any[]} */
  const got = [];
  /** @type {Array<[number, string]>} */
  const closed = [];
  /** @type {string|null} */
  let id = null;
  /** @type {(v: unknown) => void} */
  let opened = () => {};
  const open = new Promise((r) => {
    opened = r;
  });
  /** @type {Map<number, { resolve: (v: any) => void, chunks: Buffer[], ended: Promise<string>, end: () => void }>} */
  const streams = new Map();
  let next = 1;
  const answer = core.openBrowse(who, PHONE, { host, session: session ?? undefined }, {
    send: (m) => {
      got.push(m);
      if (m.op === 'open') opened(true);
      const s = typeof m.stream === 'number' ? streams.get(m.stream) : undefined;
      if (!s) return;
      if (m.op === 'connected') s.resolve({ ok: true });
      if (m.op === 'failed') s.resolve({ ok: false, text: m.text });
      if (m.op === 'data') s.chunks.push(Buffer.from(String(m.data), 'base64'));
      if (m.op === 'end') s.end();
    },
    close: (c, r) => closed.push([c, r]),
  });
  if (answer.ok) id = answer.browse;
  const send = (/** @type {any} */ m) => core.browseFromPhone(/** @type {string} */ (id), JSON.stringify(m));
  /** Open a stream; answers whether it connected, and its bytes once the box ends it. */
  const connect = (/** @type {string} */ h, /** @type {number} */ port) => {
    const stream = next++;
    /** @type {(v: any) => void} */
    let resolve = () => {};
    const result = new Promise((r) => {
      resolve = r;
    });
    /** @type {() => void} */
    let end = () => {};
    const ended = new Promise((r) => {
      end = () => r(Buffer.concat(streams.get(stream)?.chunks ?? []).toString('latin1'));
    });
    streams.set(stream, { resolve, chunks: [], ended: /** @type {Promise<string>} */ (ended), end });
    send({ op: 'connect', stream, host: h, port });
    return {
      stream,
      result: /** @type {Promise<{ ok: boolean, text?: string }>} */ (result),
      write: (/** @type {string|Buffer} */ b) => send({ op: 'data', stream, data: Buffer.from(b).toString('base64') }),
      ended: /** @type {Promise<string>} */ (ended),
      chunks: () => streams.get(stream)?.chunks ?? [],
    };
  };
  return { answer, got, closed, open, send, connect, id: () => id };
}

// --- the box's rules ---------------------------------------------------------

test('public is the web and nothing else, IPv4 and IPv6, a mapped address judged as itself', () => {
  for (const a of ['8.8.8.8', PUBLIC_IP, '2606:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(a), true, a);
  for (const a of [
    '10.1.1.1', '172.16.0.1', '192.168.1.1', '127.0.0.1', '100.64.0.1', '169.254.169.254', '0.0.0.0', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '64:ff9b::808:808', '2002:c0a8:101::1', '::ffff:10.0.0.1', '::8.8.8.8',
  ]) assert.equal(isPublicAddress(a), false, a);
  assert.deepEqual(plainAddress('::ffff:192.168.1.1'), { address: '192.168.1.1', family: 4 });
  // The same address in hex is the same address.
  assert.deepEqual(plainAddress('::ffff:c0a8:101'), { address: '192.168.1.1', family: 4 });
  assert.deepEqual(plainAddress('0:0:0:0:0:ffff:c0a8:0101'), { address: '192.168.1.1', family: 4 });
  assert.equal(isPublicAddress('::ffff:a00:1'), false);
});

test('the owner’s list: names, addresses and ranges, with a port or on 80 and 443, and nothing that is not one', () => {
  const { entries, bad } = parseBrowseHosts(['nas.lan', 'nas.lan:5000', '192.168.1.0/24', '192.168.1.0/24:8080', '[fd00::/64]', '[fd00::10]:8443', 'fd00::/8', '10.0.0.5', 'bad host', 'localhost', 'x.localhost', '1.2.3.4/40', 'nas.lan:99999']);
  assert.deepEqual(entries.map((e) => [e.raw, e.kind, e.port]), [
    ['nas.lan', 'name', null], ['nas.lan:5000', 'name', 5000], ['192.168.1.0/24', 'range', null], ['192.168.1.0/24:8080', 'range', 8080],
    ['[fd00::/64]', 'range', null], ['[fd00::10]:8443', 'range', 8443], ['fd00::/8', 'range', null], ['10.0.0.5', 'range', null],
  ]);
  assert.deepEqual(bad, ['bad host', 'localhost', 'x.localhost', '1.2.3.4/40', 'nas.lan:99999']);
});

test('the box decides: a session’s localhost, the listed, the public web on 80 and 443, and never itself', async () => {
  const policy = { web: true, entries: parseBrowseHosts(['nas.lan', 'nas.lan:5000', '192.168.1.0/24:8080']).entries };
  const own = { addresses: ['198.51.100.7'], networks: [] };
  /** @param {string} host @param {number} port @param {{ session?: string|null, box?: boolean, web?: boolean }} [o] */
  const at = (host, port, o = {}) => decideBrowse({ host, port, session: o.session ?? null, box: o.box ?? true, policy: { ...policy, web: o.web ?? true }, lookup: async (n) => (n === 'self.example' ? ['198.51.100.7'] : lookup(n)), own });
  assert.deepEqual(await at('localhost', 5173, { session: 'web', box: false }), { to: 'session', port: 5173 });
  assert.deepEqual(await at('127.0.0.1', 3000, { session: 'web', box: false }), { to: 'session', port: 3000 });
  assert.deepEqual(await at('[::1]', 3000, { session: 'web', box: false }), { to: 'session', port: 3000 });
  // WITHOUT A SESSION, LOCALHOST IS NOBODY'S: the box's loopback is the hub.
  assert.match(/** @type {any} */ (await at('localhost', 8790)).refused, /does not open its own addresses/);
  assert.match(/** @type {any} */ (await at('127.0.0.2', 80)).refused, /this machine itself/);
  assert.match(/** @type {any} */ (await at('self.example', 443)).refused, /this machine itself/);
  // The web, on the web's ports.
  assert.deepEqual(await at('example.com', 443), { to: 'tcp', host: PUBLIC_IP, port: 443 });
  assert.deepEqual(await at('example.com', 80), { to: 'tcp', host: PUBLIC_IP, port: 80 });
  assert.match(/** @type {any} */ (await at('example.com', 22)).refused, /80 and 443 only/);
  assert.match(/** @type {any} */ (await at('example.com', 443, { web: false })).refused, /only the addresses its owner listed/);
  // A NAME THAT RESOLVES PRIVATE is refused, and the address decided on is
  // the one connected to: there is no second resolution to rebind.
  assert.match(/** @type {any} */ (await at('rebind.example', 443)).refused, /private address/);
  assert.deepEqual(await at('both.example', 443), { to: 'tcp', host: PUBLIC_IP, port: 443 });
  assert.match(/** @type {any} */ (await at('10.0.0.1', 80)).refused, /private address/);
  // What the owner listed, on the ports they listed.
  assert.deepEqual(await at('nas.lan', 5000), { to: 'tcp', host: '192.168.1.20', port: 5000 });
  assert.deepEqual(await at('nas.lan', 443), { to: 'tcp', host: '192.168.1.20', port: 443 });
  assert.match(/** @type {any} */ (await at('nas.lan', 22)).refused, /only on 80, 443 and 5000/);
  assert.deepEqual(await at('192.168.1.9', 8080), { to: 'tcp', host: '192.168.1.9', port: 8080 });
  assert.match(/** @type {any} */ (await at('192.168.1.9', 80)).refused, /private address/);
  // Somebody who does not administer the box gets only the session's ports.
  assert.match(/** @type {any} */ (await at('example.com', 443, { session: 'web', box: false })).refused, /not one of web's ports/);
  assert.match(/** @type {any} */ (await at('nowhere.example', 443)).refused, /no address/);
});

// --- the whole path ----------------------------------------------------------

test('a public https page: the phone’s own TLS reaches it through the box, and nothing between can read it', { skip: !openssl && 'needs openssl' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'browse-'));
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-days', '1', '-subj', '/CN=example.com'], { cwd: dir, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const cert = readFileSync(path.join(dir, 'c.pem'), 'utf8');
  const page = await standIn(() => 'HTTP/1.1 200 OK\r\ncontent-length: 25\r\n\r\nthe-page-nobody-may-read!', { secure: { key: readFileSync(path.join(dir, 'k.pem'), 'utf8'), cert } });
  try {
    const f = fleet({ route: { [`${PUBLIC_IP}:443`]: page.port } });
    const p = phone(f.core);
    assert.equal(p.answer.ok, true, /** @type {any} */ (p.answer).text);
    assert.equal(p.got[0].op, 'ready');
    assert.deepEqual(p.got[0].opens, { web: true, hosts: ['nas.lan', '192.168.1.0/24:8080'] });
    await p.open;
    const s = p.connect('example.com', 443);
    assert.deepEqual(await s.result, { ok: true });
    assert.deepEqual(f.dialed, [`${PUBLIC_IP}:443`]);
    // The web view's TLS, opened over the stream, to the page's own name.
    const { Duplex } = await import('node:stream');
    const wire = new Duplex({ read() {}, write(chunk, _e, done) { s.write(chunk); done(); } });
    const pump = setInterval(() => {
      for (const c of s.chunks().splice(0)) wire.push(c);
    }, 5);
    const secure = tls.connect({ socket: /** @type {any} */ (wire), ca: cert, servername: 'example.com' });
    await new Promise((r, j) => {
      secure.once('secureConnect', r);
      secure.once('error', j);
    });
    secure.write('GET / HTTP/1.1\r\nhost: example.com\r\ncookie: secret=the-cookie-nobody-may-read\r\n\r\n');
    const body = await new Promise((r) => {
      let all = '';
      secure.on('data', (d) => {
        all += d;
        if (all.includes('read!')) r(all);
      });
    });
    clearInterval(pump);
    assert.match(String(body), /the-page-nobody-may-read!/);
    assert.ok(page.heard.join('').length > 0);
    const crossed = f.carried.filter((m) => m.op === 'data').map((m) => Buffer.from(String(m.data), 'base64').toString('latin1')).join('');
    assert.ok(crossed.length > 0);
    assert.ok(!crossed.includes('the-cookie-nobody') && !crossed.includes('the-page-nobody'), 'the page crossed readable');
    secure.destroy();
    f.core.browsePhoneGone(/** @type {string} */ (p.id()));
    assert.equal(f.box.sockets.size, 0, 'the box forgot the socket when the phone went');
  } finally {
    await page.close();
  }
});

test('a session’s port: localhost goes into that session, for the person who started it', async () => {
  const server = await standIn((heard) => `HTTP/1.0 200 OK\r\n\r\nyou asked ${heard.split(' ')[1]}`);
  try {
    const f = fleet({ sessionPort: server.port, actsFor: null });
    // A MEMBER on an operator's box: not an admin, so only their session.
    const p = phone(f.core, { session: 'web', who: { email: OWNER } });
    assert.equal(p.answer.ok, true, /** @type {any} */ (p.answer).text);
    assert.equal(p.got[0].session, 'web');
    assert.equal(p.got[0].opens, null, 'a member is not told what the box lists');
    await p.open;
    const s = p.connect('localhost', 5173);
    assert.deepEqual(await s.result, { ok: true });
    s.write('GET /hello HTTP/1.0\r\n\r\n');
    assert.equal(await s.ended, 'HTTP/1.0 200 OK\r\n\r\nyou asked /hello');
    assert.deepEqual(f.sessionDials, [{ owner: OWNER, session: 'web', port: 5173 }]);
    // Anything else on a member's socket is refused by the box.
    const other = p.connect('example.com', 443);
    assert.match(String((await other.result).text), /not one of web's ports/);
    assert.deepEqual(f.dialed, []);
  } finally {
    await server.close();
  }
});

test('what the coordinator refuses before a box is asked', async () => {
  const cases = /** @type {Array<[string, Parameters<typeof fleet>[0], Parameters<typeof phone>[1], RegExp]>} */ ([
    ['older box', { protocol: 17 }, {}, /too old/],
    // On an operator's box: one that acts for a single person files every
    // session under them (hosts.js believedCreator), which is its own rule.
    ['somebody else’s session', { actsFor: null, sessions: [{ name: 'web', status: 'running', createdBy: `fleet:${OTHER}` }] }, { session: 'web' }, /no session of yours called web/],
    ['a stopped session', { sessions: [{ name: 'web', status: 'stopped', createdBy: `fleet:${OWNER}` }] }, { session: 'web' }, /not running/],
    ['a box that does not contain its sessions', { sandboxed: false }, { session: 'web' }, /does not run sessions in containers/],
    ['a member who does not administer the box, with no session', { actsFor: null }, {}, /Only people who administer/],
    ['an admin’s box that opens nothing', { web: false, hosts: [] }, {}, /has listed no addresses/],
    ['a box that is not connected', {}, { host: 'nowhere' }, /not connected/],
  ]);
  for (const [why, spec, ask, text] of cases) {
    const f = fleet(spec);
    const p = phone(f.core, ask);
    assert.equal(p.answer.ok, false, why);
    assert.match(/** @type {any} */ (p.answer).text, text, why);
    assert.equal(p.got[0].op, 'closed', why);
    assert.equal(p.closed.length, 1, why);
    assert.equal(f.carried.length, 0, `${why}: the box was asked`);
  }
  const f = fleet();
  const p = /** @type {any} */ (f.core).openBrowse(null, PHONE, { host: BOX }, { send() {}, close() {} });
  assert.equal(p.error.code, 'not_signed_in');
});

test('the box has the last word: it refuses a session that is not that person’s, and its own rules to people it does not pin', async () => {
  // The coordinator believed the session was theirs; the hub did not.
  const f = fleet();
  /** @type {any} */ (f.box).checkSession = async () => ({ ok: false, text: 'This machine has no session of yours called web.' });
  const p = phone(f.core, { session: 'web' });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(p.got.at(-1).op, 'closed');
  assert.match(p.got.at(-1).text, /no session of yours called web/);
  // A box that pins its admins opens its own rules only for them.
  const g = fleet({ pinned: [OTHER] });
  const q = phone(g.core);
  await new Promise((r) => setImmediate(r));
  assert.equal(q.got.at(-1).op, 'closed');
  assert.match(q.got.at(-1).text, /do not include you/);
});

test('how many: connections on a socket, sockets a person, and frames that are not ours close it', async () => {
  const f = fleet();
  const p = phone(f.core);
  await p.open;
  // Every connection is refused by the box here (nothing routed), but each
  // counts while it is open on the coordinator: hold them open.
  /** @type {any} */ (f.box).onFrame = () => {};
  for (let i = 0; i < BROWSE_MAX_STREAMS; i++) p.connect('example.com', 443);
  const over = p.connect('example.com', 443);
  assert.match(String((await over.result).text), new RegExp(`already has ${BROWSE_MAX_STREAMS} connections`));
  // A second socket is fine, a third is not.
  assert.equal(phone(f.core).answer.ok, true);
  const third = phone(f.core);
  assert.equal(third.answer.ok, false);
  assert.match(/** @type {any} */ (third.answer).text, new RegExp(MAX_BROWSES_EACH === 2 ? 'two pages open' : 'pages open'));
  // A frame that is not one closes the socket.
  f.core.browseFromPhone(/** @type {string} */ (p.id()), 'not a frame');
  assert.equal(p.got.at(-1).op, 'closed');
  assert.match(p.got.at(-1).text, /does not carry/);
});

test('a box that is not the socket’s is told it is closed, and the coordinator adds the person, not the phone', () => {
  /** @type {any[]} */
  const toHost = [];
  const b = new Browses({ toHost: (h, f) => toHost.push([h, f]) });
  const s = b.start({ owner: OWNER, device: PHONE, hostId: BOX, session: 'web', box: false, toPhone() {}, closePhone() {} });
  assert.equal(s.ok, true);
  const id = /** @type {any} */ (s).browse.id;
  b.ask(id);
  assert.deepEqual(toHost[0], [BOX, { browse: id, op: 'open', owner: OWNER, session: 'web', box: false }]);
  b.fromHost('intruder', { browse: id, op: 'opened' });
  assert.deepEqual(toHost[1], ['intruder', { browse: id, op: 'close' }]);
  assert.equal(b.open.get(id)?.state, 'opening');
  // The phone names a host and a port; the coordinator checks their shape.
  assert.deepEqual(browseTarget('Example.COM', 443), { host: 'example.com', port: 443 });
  assert.deepEqual(browseTarget('[::1]', '3000'), { host: '::1', port: 3000 });
  for (const [h, p] of /** @type {Array<[unknown, unknown]>} */ ([['ex ample.com', 443], ['example.com', 0], ['example.com', 70000], ['a/b', 80], ['', 80], ['example.com', '80x']])) assert.equal(browseTarget(h, p), null, `${h}:${p}`);
});

// --- what the phones are told ------------------------------------------------

test('a member sees whether a box opens their sessions’ ports, and only its admins see what it lists', () => {
  const f = fleet({ actsFor: null });
  const member = /** @type {any} */ (f.core.snapshot({ email: OWNER })).hosts.find((/** @type {any} */ h) => h.hostId === BOX);
  assert.deepEqual(member.health.browse, { sessions: true, web: false, hosts: [] });
  const admin = /** @type {any} */ (f.core.snapshot({ email: 'root@example.com', admin: true })).hosts.find((/** @type {any} */ h) => h.hostId === BOX);
  assert.deepEqual(admin.health.browse, { sessions: true, web: true, hosts: ['nas.lan', '192.168.1.0/24:8080'] });
  // A box that sends anything else there is held to the shape the phones decode.
  assert.equal(browseShape('yes'), null);
  assert.deepEqual(browseShape({ sessions: 1, web: 'on', hosts: ['ok.lan', 7, 'not ok', 'x'.repeat(200)] }), { sessions: false, web: false, hosts: ['ok.lan'] });
});

test('a box’s settings: a bad entry or a web switch that is not on or off stops the sidecar', () => {
  const base = { FLEETWRIGHT_COORDINATOR_URL: 'stdio:local' };
  const good = loadSidecarConfig({ ...base, FLEETWRIGHT_BROWSE_HOSTS: 'nas.lan, 192.168.1.0/24:8080', FLEETWRIGHT_BROWSE_WEB: 'on' });
  assert.deepEqual(good.browseHosts, ['nas.lan', '192.168.1.0/24:8080']);
  assert.equal(good.browseWeb, 'on');
  assert.ok(!validateSidecarConfig(good).errors.some((e) => /BROWSE/.test(e)));
  const off = loadSidecarConfig(base);
  assert.equal(off.browseWeb, 'off');
  assert.deepEqual(off.browseHosts, []);
  const bad = validateSidecarConfig(loadSidecarConfig({ ...base, FLEETWRIGHT_BROWSE_HOSTS: 'nas.lan,bad_host', FLEETWRIGHT_BROWSE_WEB: 'yes' }));
  assert.ok(bad.errors.some((e) => /FLEETWRIGHT_BROWSE_HOSTS names bad_host/.test(e)), bad.errors.join('\n'));
  assert.ok(bad.errors.some((e) => /FLEETWRIGHT_BROWSE_WEB is yes/.test(e)), bad.errors.join('\n'));
});

// --- the hub's door into a session --------------------------------------------

/**
 * A hub that answers only the session-port upgrade, with the real handler,
 * whose `podman exec` is Node on this machine running the same script the
 * container would.
 */
async function hub({ contained = true, record = /** @type {(n: string) => any} */ ((n) => (n === 'web' ? { status: 'running', createdBy: `fleet:${OWNER}` } : undefined)) } = {}) {
  /** @type {Array<[string, number]>} */
  const execs = [];
  const server = http.createServer((_req, res) => res.end());
  server.on('upgrade', (req, socket, head) => {
    if (!isSessionPortUpgrade(req)) return void socket.destroy();
    const bearer = String(req.headers.authorization || '');
    answerSessionPort(req, socket, head, {
      principal: bearer === 'Bearer sidecar-token' ? 'sidecar' : null,
      contained,
      record,
      exec: (session, port) => {
        execs.push([session, port]);
        return spawn(process.execPath, ['-e', DIAL_SCRIPT, String(port)], { stdio: ['pipe', 'pipe', 'pipe'] });
      },
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  const port = /** @type {any} */ (server.address()).port;
  return { execs, client: (token = 'sidecar-token') => new HubClient({ baseUrl: `http://127.0.0.1:${port}`, token }), close: () => new Promise((r) => server.close(() => r(null))) };
}

test('the hub opens a session’s port for the sidecar, and says why when it will not', async () => {
  const server = await standIn((heard) => `inside: ${heard}`);
  const h = await hub();
  try {
    const opened = await h.client().dialSessionPort('web', server.port, OWNER);
    assert.equal(opened.ok, true, /** @type {any} */ (opened).text);
    const wire = /** @type {any} */ (opened).wire;
    wire.write('ping');
    const back = await new Promise((r) => {
      let all = '';
      wire.on('data', (/** @type {Buffer} */ d) => (all += d));
      wire.on('end', () => r(all));
    });
    assert.equal(back, 'inside: ping');
    assert.deepEqual(h.execs, [['web', server.port]]);

    // NOTHING LISTENING is an answer with a sentence.
    const free = await new Promise((r) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const p = /** @type {any} */ (probe.address()).port;
        probe.close(() => r(p));
      });
    });
    const none = await h.client().dialSessionPort('web', /** @type {number} */ (free), OWNER);
    assert.equal(none.ok, false);
    assert.match(/** @type {any} */ (none).text, new RegExp(`Nothing is listening on port ${free} in web`));

    // Not theirs, no token, no such session: refused before anything runs.
    const before = h.execs.length;
    assert.match(/** @type {any} */ (await h.client().dialSessionPort('web', server.port, OTHER)).text, /no session of yours called web/);
    assert.match(/** @type {any} */ (await h.client('wrong').dialSessionPort('web', server.port, OWNER)).text, /sidecar/);
    assert.match(/** @type {any} */ (await h.client().dialSessionPort('nope', server.port, OWNER)).text, /no session of yours called nope/);
    assert.match(/** @type {any} */ (await h.client().dialSessionPort('../etc', server.port, OWNER)).text, /Say which session/);
    assert.equal(h.execs.length, before);
  } finally {
    await h.close();
    await server.close();
  }
  // A box that runs its sessions as plain panes opens none of their ports.
  const loose = await hub({ contained: false });
  try {
    assert.match(/** @type {any} */ (await loose.client().dialSessionPort('web', 3000, OWNER)).text, /does not run sessions in containers/);
    assert.equal(loose.execs.length, 0);
  } finally {
    await loose.close();
  }
});

// --- what the review found ---------------------------------------------------

test('the box is never itself, however its address is written, and its own network is not the web', async () => {
  const policy = { web: true, entries: parseBrowseHosts(['192.168.1.0/24']).entries };
  const own = { addresses: ['192.168.1.5', '2a02:1234::5'], networks: ['192.168.1.5/24', '2a02:1234::5/64'] };
  /** @param {string} host @param {number} [port] */
  const at = (host, port = 443) => decideBrowse({ host, port, session: null, box: true, policy, lookup: async () => [], own });
  for (const self of ['2a02:1234::5', '2a02:1234:0:0:0:0:0:5', '2a02:1234:0000::0005', '[2A02:1234::5]', '192.168.1.5', '::ffff:192.168.1.5', '::ffff:c0a8:105', '0.0.0.0', '0.1.2.3', '::']) {
    const d = /** @type {any} */ (await at(self));
    assert.ok('refused' in d, `${self} was opened: ${JSON.stringify(d)}`);
  }
  // A neighbour with a global IPv6 address is the owner's network, not the web.
  assert.ok('refused' in /** @type {any} */ (await at('2a02:1234::20')));
  // A listed range still opens its neighbours, the box excepted.
  assert.deepEqual(await at('192.168.1.20'), { to: 'tcp', host: '192.168.1.20', port: 443 });
  assert.deepEqual(await at('::ffff:c0a8:114'), { to: 'tcp', host: '192.168.1.20', port: 443 });
  // The web beyond it is still the web.
  assert.deepEqual(await at('2606:4700::1111'), { to: 'tcp', host: '2606:4700::1111', port: 443 });
});

test('a resolver that does not answer is a refusal in seconds, not a slot held for the page', async () => {
  const started = Date.now();
  const d = await decideBrowse({
    host: 'slow.example', port: 443, session: null, box: true, policy: { web: true, entries: [] },
    // Answers too late. The box's own limit is ten seconds; this one is
    // shortened, and the lookup rejects only after the answer was given.
    lookup: () => new Promise((_r, j) => setTimeout(() => j(new Error('late')), 2_000).unref()),
    lookupMs: 100,
  });
  assert.match(/** @type {any} */ (d).refused, /no address/);
  assert.ok(Date.now() - started < 1_000);
});

test('the box reads no further than the phone has acknowledged', async () => {
  const big = Buffer.alloc(BROWSE_WINDOW * 3, 120);
  const server = net.createServer((s) => s.end(big));
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  const port = /** @type {any} */ (server.address()).port;
  try {
    /** @type {any[]} */
    const sent = [];
    const box = new BrowseCarrier({
      send: (f) => sent.push(f),
      policy: () => ({ web: true, entries: [] }),
      checkSession: async () => ({ ok: true }),
      dialSession: async () => ({ ok: false, text: 'no' }),
      lookup: async () => [PUBLIC_IP],
      own: () => ({ addresses: [], networks: [] }),
      connect: () => net.connect({ host: '127.0.0.1', port }),
    });
    const id = 'a'.repeat(24);
    box.onFrame({ browse: id, op: 'open', owner: OWNER, session: null, box: true });
    await new Promise((r) => setImmediate(r));
    box.onFrame({ browse: id, op: 'connect', stream: 1, host: 'example.com', port: 443 });
    const carried = () => sent.filter((f) => f.op === 'data').reduce((n, f) => n + Buffer.from(f.data, 'base64').length, 0);
    const settle = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
    };
    await settle();
    // About one window, then it stops: a socket read can overshoot by what
    // one read returns, never by the rest of the file.
    const first = carried();
    assert.ok(first >= BROWSE_WINDOW && first < BROWSE_WINDOW * 2, `carried ${first} before any ack`);
    box.onFrame({ browse: id, op: 'ack', stream: 1, bytes: first });
    await settle();
    assert.ok(carried() > first, 'an ack did not let it read on');
    box.onFrame({ browse: id, op: 'ack', stream: 1, bytes: BROWSE_WINDOW });
    box.onFrame({ browse: id, op: 'ack', stream: 1, bytes: BROWSE_WINDOW });
    await settle();
    assert.equal(carried(), big.length);
    box.closeAll();
  } finally {
    await new Promise((r) => server.close(() => r(null)));
  }
});

test('a page with a hole in it is closed: the box drops it when a frame cannot be sent, says so when asked, and the coordinator closes it when the box dials again', async () => {
  // The box: a send that fails closes the page, and a page it does not have
  // is answered `closed`.
  /** @type {any[]} */
  const sent = [];
  let up = true;
  const box = new BrowseCarrier({
    send: (f) => {
      sent.push(f);
      return up;
    },
    policy: () => ({ web: true, entries: [] }),
    checkSession: async () => ({ ok: true }),
    dialSession: async () => ({ ok: false, text: 'no' }),
  });
  const id = 'b'.repeat(24);
  box.onFrame({ browse: id, op: 'open', owner: OWNER, session: null, box: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(box.sockets.size, 1);
  up = false;
  box.onFrame({ browse: id, op: 'connect', stream: 1, host: 'example.com', port: 22 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(box.sockets.size, 0, 'a page whose frame could not be sent stayed open');
  up = true;
  box.onFrame({ browse: id, op: 'connect', stream: 2, host: 'example.com', port: 443 });
  assert.equal(sent.at(-1).op, 'closed');

  // The coordinator: a box that dials again takes its pages with it.
  const f = fleet();
  const p = phone(f.core);
  await p.open;
  f.core.hostConnected(BOX, () => {});
  assert.equal(p.got.at(-1).op, 'closed');
  assert.match(p.got.at(-1).text, /reconnected/);
});

test('the coordinator carries an acknowledgement only for an open stream, and only a sane one', async () => {
  /** @type {any[]} */
  const toHost = [];
  const b = new Browses({ toHost: (_h, fr) => toHost.push(fr) });
  const s = /** @type {any} */ (b.start({ owner: OWNER, device: PHONE, hostId: BOX, session: null, box: true, toPhone() {}, closePhone() {} }));
  const id = s.browse.id;
  b.fromHost(BOX, { browse: id, op: 'opened' });
  b.fromPhone(id, JSON.stringify({ op: 'connect', stream: 1, host: 'example.com', port: 443 }));
  b.fromPhone(id, JSON.stringify({ op: 'ack', stream: 1, bytes: 100 }));
  assert.equal(toHost.filter((f) => f.op === 'ack').length, 0, 'an ack for a stream still connecting was carried');
  b.fromHost(BOX, { browse: id, op: 'connected', stream: 1 });
  b.fromPhone(id, JSON.stringify({ op: 'ack', stream: 1, bytes: 100 }));
  b.fromPhone(id, JSON.stringify({ op: 'ack', stream: 1, bytes: -5 }));
  b.fromPhone(id, JSON.stringify({ op: 'ack', stream: 1, bytes: 1.5 }));
  assert.deepEqual(toHost.filter((f) => f.op === 'ack'), [{ browse: id, op: 'ack', stream: 1, bytes: 100 }]);
  b.close(id, 'done');
});

test('a caller that leaves before the connection inside is made leaves nothing running', async () => {
  // Nothing listens, and the dial is made to wait: the caller goes first.
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  const server = http.createServer((_req, res) => res.end());
  server.on('upgrade', (req, socket, head) => {
    answerSessionPort(req, socket, head, {
      principal: 'sidecar',
      contained: true,
      record: () => ({ status: 'running', createdBy: `fleet:${OWNER}` }),
      // A dial that would never answer on its own: it waits on stdin.
      exec: () => {
        child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'], { stdio: ['pipe', 'pipe', 'pipe'] });
        return /** @type {any} */ (child);
      },
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  try {
    const port = /** @type {any} */ (server.address()).port;
    const raw = net.connect({ host: '127.0.0.1', port });
    raw.on('error', () => {});
    raw.write(`GET /api/session-port?name=web&port=3000&owner=${OWNER} HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\nupgrade: fleetwright-port\r\n\r\n`);
    for (let i = 0; i < 50 && !child; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(child, 'the dial never started');
    const exited = new Promise((r) => /** @type {any} */ (child).once('exit', r));
    raw.resetAndDestroy();
    // Its stdin is ended at once, so it goes well inside the grace period.
    const how = await Promise.race([exited.then(() => 'exited'), new Promise((r) => setTimeout(() => r('still running'), 1500))]);
    assert.equal(how, 'exited');
  } finally {
    await new Promise((r) => server.close(() => r(null)));
  }
});
