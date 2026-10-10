// A box reading a pool's edge routers: their API over TLS held to the
// certificate the policy job made, and their syslog as it arrives.
// docs/hypervisors.md, "Watching the edge routers".
//
//   node --test test/edge-watch.test.js
//
// ASKED FOR: "Why is there no live info of opnsense in the app to help trouble
// shoot this?" The router is played by a real TLS server serving the
// certificate newWatch made, answering the four OPNsense 26.7 endpoints in
// their own shapes (read from its controllers).

import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';

import { EdgeWatch, EVENTS, kindOf, parseSyslog, statusOf } from '../src/fleet/host/edge-watch.js';
import { newWatch } from '../src/fleet/host/edge-credentials.js';

const ELI = 'eli@example.com';

/** OPNsense's answers, as its controllers shape them. */
const ANSWERS = {
  '/api/diagnostics/interface/get_vip_status': { total: 1, rowCount: 1, current: 1, rows: [{ interface: 'lan', vhid: '1', subnet: '10.254.0.1', status: 'MASTER', mode: 'carp' }], carp: { maintenancemode: false } },
  '/api/unbound/service/status': { status: 'running', widget: {} },
  '/api/routes/gateway/status': { status: 'ok', items: [{ name: 'WAN_DHCP', address: '192.168.1.1', status: 'none', status_translated: 'Online', loss: '0.0 %', delay: '0.4 ms', monitor: '192.168.1.1' }] },
  '/api/dnsmasq/leases/search': { total: 2, rowCount: 2, current: 1, rows: [{ address: '10.254.0.120' }, { address: '10.254.0.121' }] },
};

/**
 * A router at 127.0.0.1 on a port of its own, serving `w`'s certificate and
 * taking only `w`'s key; every request it saw is kept.
 * @param {any} t @param {ReturnType<typeof newWatch>} w
 */
async function router(t, w) {
  /** @type {Array<{ method: string, path: string, auth: string }>} */
  const seen = [];
  const server = https.createServer({ cert: w.crt, key: w.prv }, (req, res) => {
    const auth = String(req.headers.authorization || '');
    seen.push({ method: String(req.method), path: String(req.url), auth });
    if (auth !== `Basic ${Buffer.from(`${w.key}:${w.secret}`).toString('base64')}`) {
      res.writeHead(401).end('{"status":401}');
      return;
    }
    const body = /** @type {Record<string, any>} */ (ANSWERS)[String(req.url)];
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? {}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  t.after(() => server.close());
  return { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, seen };
}

/** The syslog socket, stood in for. */
function fakeSocket() {
  const s = /** @type {any} */ (new EventEmitter());
  s.bound = null;
  s.bind = (/** @type {number} */ p) => (s.bound = p);
  s.close = () => {};
  return s;
}

/**
 * A box holding Eli's pool with the key to its routers.
 * @param {ReturnType<typeof newWatch>} w @param {Array<{ name: string, address: string|null }>} routers
 */
function holding(w, routers, key = w.key) {
  return { held: new Map([[`${ELI} xo.lan`, { owner: ELI, record: { address: 'xo.lan', edge: { key, secret: w.secret, pin: w.pin, routers } } }]]) };
}

test('a router is read over TLS held to its certificate, with the key, into the flags the phone shows', async (t) => {
  const w = newWatch();
  const { port, seen } = await router(t, w);
  const socket = fakeSocket();
  const watch = new EdgeWatch({ pools: holding(w, [{ name: 'fleetwright-edge', address: '127.0.0.1' }, { name: 'fleetwright-edge-b', address: null }]), apiPort: port, createSocket: () => socket, now: () => 1_700_000_000_000 });
  await watch.poll();
  assert.equal(socket.bound, 5514, 'the routers’ syslog is listened for once a pool has a key');
  const r = /** @type {any} */ (watch.reportFor(ELI, 'xo.lan'));
  assert.equal(r.at, 1_700_000_000_000);
  assert.deepEqual(r.routers[0], { name: 'fleetwright-edge', address: '127.0.0.1', heardAt: null, reached: true, role: 'master', dns: true, gateway: true, leases: 2, problem: null });
  assert.equal(r.routers[1].reached, null, 'a router with no known address is cannot tell, not down');
  assert.match(r.routers[1].problem, /did not know its address when the policy last ran/);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), [
    'POST /api/diagnostics/interface/get_vip_status',
    'GET /api/unbound/service/status',
    'GET /api/routes/gateway/status',
    'POST /api/dnsmasq/leases/search',
  ]);
  assert.equal(watch.reportFor('sam@example.com', 'xo.lan'), null, 'nobody else’s pool');
});

test('the key goes to nothing but the router’s own certificate, and a refused key says what to do', async (t) => {
  const w = newWatch();
  const impostor = await router(t, newWatch());
  const elsewhere = new EdgeWatch({ pools: holding(w, [{ name: 'fleetwright-edge', address: '127.0.0.1' }]), apiPort: impostor.port, createSocket: fakeSocket });
  await elsewhere.poll();
  const r = /** @type {any} */ (elsewhere.reportFor(ELI, 'xo.lan')).routers[0];
  assert.equal(r.reached, false);
  assert.match(r.problem, /certificate that is not this router’s, so the key was not sent/);
  assert.deepEqual(impostor.seen, [], 'something with another certificate saw a request');

  const real = await router(t, w);
  const stale = new EdgeWatch({ pools: holding(w, [{ name: 'fleetwright-edge', address: '127.0.0.1' }], newWatch().key), apiPort: real.port, createSocket: fakeSocket });
  await stale.poll();
  assert.match(/** @type {any} */ (stale.reportFor(ELI, 'xo.lan')).routers[0].problem, /refused this machine’s key \(401\)[\s\S]*apply the policy again/);
});

test('what OPNsense says it cannot tell stays cannot tell', () => {
  assert.deepEqual(statusOf({}), { role: null, dns: null, gateway: null, leases: null });
  // dpinger with no data: OPNsense calls it Online with `~` everywhere.
  assert.equal(statusOf({ gateways: { items: [{ name: 'WAN_DHCP', status: 'none', status_translated: 'Online', monitor: '~' }] } }).gateway, null);
  assert.equal(statusOf({ gateways: { items: [{ name: 'WAN_DHCP', status: 'down', monitor: '192.168.1.1' }] } }).gateway, false);
  assert.equal(statusOf({ gateways: { items: [{ name: 'WAN_DHCP', status: 'delay+loss', monitor: '192.168.1.1' }] } }).gateway, true, 'slow is still a way out');
  assert.equal(statusOf({ unbound: { status: 'stopped' } }).dns, false);
  assert.equal(statusOf({ unbound: { status: 'unknown' } }).dns, null);
  assert.equal(statusOf({ vip: { rows: [] } }).role, null, 'one router alone has no CARP role');
  assert.equal(statusOf({ vip: { rows: [{ subnet: '10.254.0.1', status: 'DISABLED' }] } }).role, null);
  assert.equal(statusOf({ vip: { rows: [{ subnet: '10.254.0.1', status: 'BACKUP' }] } }).role, 'backup');
});

test('syslog lines are the routers’ by name and address, a new address is learned for the next read, and DHCP cannot crowd out the rest', async () => {
  assert.deepEqual(parseSyslog('<13>Oct 10 21:04:05 fleetwright-edge-b.internal kernel: carp: 1@xn1: BACKUP -> MASTER (master timed out)'), {
    router: 'fleetwright-edge-b',
    program: 'kernel',
    text: 'carp: 1@xn1: BACKUP -> MASTER (master timed out)',
  });
  assert.equal(parseSyslog('<13>Oct 10 21:04:05 somebody.lan kernel: carp: nothing'), null, 'not one of the routers');
  assert.equal(parseSyslog('not syslog'), null);
  assert.deepEqual(
    [['kernel', 'carp: 1@xn1: MASTER -> BACKUP'], ['kernel', 'xn0: link state changed'], ['unbound', 'error: x'], ['dnsmasq-dhcp', 'DHCPACK'], ['dpinger', 'alarm'], ['suricata', 'started']].map(([p, s]) => kindOf(p, s)),
    ['carp', 'system', 'dns', 'dhcp', 'gateway', 'ids'],
  );

  const w = newWatch();
  let now = 1_700_000_000_000;
  const watch = new EdgeWatch({ pools: holding(w, [{ name: 'fleetwright-edge', address: '192.168.1.40' }]), createSocket: fakeSocket, now: () => now, connect: async () => { throw new Error('ECONNREFUSED'); } });
  watch.hear('<13>Oct 10 21:04:05 fleetwright-edge-b.internal kernel: carp: 1@xn1: BACKUP -> MASTER (master timed out)', '192.168.1.41');
  for (let i = 0; i < 20; i++) watch.hear(`<30>Oct 10 21:04:${String(i).padStart(2, '0')} fleetwright-edge.internal dnsmasq-dhcp[123]: DHCPACK(xn1) 10.254.0.${100 + i}`, '192.168.1.40');
  now += 1000;
  await watch.poll();
  const r = /** @type {any} */ (watch.reportFor(ELI, 'xo.lan'));
  assert.deepEqual(r.routers.map((/** @type {any} */ x) => [x.name, x.address]), [['fleetwright-edge', '192.168.1.40'], ['fleetwright-edge-b', '192.168.1.41']], 'the second router, unknown to the policy, is read where its logs came from');
  assert.equal(r.routers[1].heardAt, 1_700_000_000_000);
  assert.equal(r.events.filter((/** @type {any} */ e) => e.kind === 'dhcp').length, EVENTS.dhcp);
  assert.deepEqual(r.events[0], { at: 1_700_000_000_000, router: 'fleetwright-edge-b', kind: 'carp', text: 'carp: 1@xn1: BACKUP -> MASTER (master timed out)' }, 'the change of master was pushed out by DHCP');
  assert.match(r.routers[0].problem, /192\.168\.1\.40 did not answer: ECONNREFUSED/);
});
