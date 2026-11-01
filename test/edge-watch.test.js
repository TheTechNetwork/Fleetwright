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

import { EdgeWatch, EVENTS, REREAD_MS, TOP_BLOCKED, UNREAD, kindOf, parseSyslog, statusOf } from '../src/fleet/host/edge-watch.js';
import { newWatch } from '../src/fleet/host/edge-credentials.js';

const ELI = 'eli@example.com';

/** OPNsense's answers, as its controllers shape them. */
const ANSWERS = {
  '/api/diagnostics/interface/get_vip_status': { total: 1, rowCount: 1, current: 1, rows: [{ interface: 'lan', vhid: '1', subnet: '10.254.0.1', status: 'MASTER', mode: 'carp' }], carp: { maintenancemode: false } },
  '/api/unbound/service/status': { status: 'running', widget: {} },
  '/api/routes/gateway/status': { status: 'ok', items: [{ name: 'WAN_DHCP', address: '192.168.1.1', status: 'none', status_translated: 'Online', loss: '0.0 %', delay: '0.4 ms', monitor: '192.168.1.1' }] },
  '/api/dnsmasq/leases/search': { total: 2, rowCount: 2, current: 1, rows: [{ address: '10.254.0.120' }, { address: '10.254.0.121' }] },
  // unbound/diagnostics/stats, as scripts/unbound/stats.py prints it (handle_top).
  '/api/unbound/diagnostics/stats': {
    status: 'ok',
    data: {
      total: 412,
      blocklist_size: 1000,
      passed: 409,
      resolved: { total: 300, pcnt: '72.82' },
      blocked: { total: 3, pcnt: '0.73' },
      local: { total: 9, pcnt: '2.18' },
      start_time: 1_699_999_000,
      top: { 'api.anthropic.com': { total: 120, pcnt: '29.34' } },
      top_blocked: { 'bad.example': { total: 1, pcnt: '33.33', blocklist: 'atf', latest_policy_uuid: null }, 'evil.example': { total: 2, pcnt: '66.67', blocklist: 'hgz011', latest_policy_uuid: null } },
    },
  },
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
  s.bind = (/** @type {number} */ p) => {
    s.bound = p;
    s.emit('listening');
  };
  s.close = () => {};
  return s;
}

/**
 * A box holding Eli's pool with the key to its routers, whose look at the
 * pool's Xen Orchestra reached it (`seen`, as XoPools keeps it).
 * @param {ReturnType<typeof newWatch>} w @param {Array<{ name: string, address: string|null }>} routers
 */
function holding(w, routers, key = w.key) {
  const k = `${ELI} xo.lan`;
  return {
    held: new Map([[k, { owner: ELI, record: { address: 'xo.lan', edge: { key, secret: w.secret, pin: w.pin, routers } } }]]),
    seen: new Map([[k, { reachable: true }]]),
  };
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
  assert.equal(r.listening, true, 'the box says it has the syslog port');
  assert.deepEqual(r.routers[0], {
    name: 'fleetwright-edge',
    address: '127.0.0.1',
    heardAt: null,
    reached: true,
    role: 'master',
    dns: true,
    gateway: true,
    leases: 2,
    delay: 0.4,
    loss: 0,
    answered: 412,
    blocked: 3,
    since: 1_699_999_000_000,
    topBlocked: [
      { name: 'evil.example', count: 2 },
      { name: 'bad.example', count: 1 },
    ],
    problem: null,
  });
  assert.equal(r.routers[1].reached, null, 'a router with no known address is cannot tell, not down');
  assert.match(r.routers[1].problem, /did not know its address when the policy last ran/);
  assert.deepEqual(r.routers[1].topBlocked, null);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), [
    'POST /api/diagnostics/interface/get_vip_status',
    'GET /api/unbound/service/status',
    'GET /api/routes/gateway/status',
    'POST /api/dnsmasq/leases/search',
    'GET /api/unbound/diagnostics/stats',
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

test('a box that cannot reach the pool’s Xen Orchestra never tries its routers, and says it did not try rather than that they are down', async (t) => {
  // A cloud runner holding the pool's token, off the pool's network: it read
  // both routers every half minute, reached neither, and was the report shown.
  const w = newWatch();
  const { port, seen } = await router(t, w);
  /** @type {boolean|null} */
  let reachable = null;
  let asked = 0;
  const pools = { ...holding(w, [{ name: 'fleetwright-edge', address: '127.0.0.1' }]), async edgeAddresses() { asked++; return new Map(); } };
  const said = /** @type {string[]} */ ([]);
  const watch = new EdgeWatch({ pools, apiPort: port, createSocket: fakeSocket, reaches: () => reachable, log: { info: (m) => said.push(m), warn: (m) => said.push(m) } });

  await watch.poll();
  let r = /** @type {any} */ (watch.reportFor(ELI, 'xo.lan')).routers[0];
  assert.equal(r.reached, null, 'cannot tell, not down');
  assert.match(r.problem, /has not tried yet: it has not reached the pool’s Xen Orchestra/);
  assert.deepEqual(seen, [], 'nothing was opened to the router before this box had reached Xen Orchestra');
  assert.equal(asked, 0, 'nor was Xen Orchestra asked where the routers are');

  reachable = false;
  await watch.poll();
  r = /** @type {any} */ (watch.reportFor(ELI, 'xo.lan')).routers[0];
  assert.equal(r.reached, null);
  assert.match(r.problem, /did not try: it cannot reach the pool’s Xen Orchestra, and the routers answer on that network/);
  assert.deepEqual(seen, []);
  assert.equal(said.filter((m) => /not reading the edge routers of xo.lan from here/.test(m)).length, 1, 'the journal is told once, not every half minute');

  reachable = true;
  await watch.poll();
  r = /** @type {any} */ (watch.reportFor(ELI, 'xo.lan')).routers[0];
  assert.equal(r.reached, true, 'read once this box reaches Xen Orchestra');
  assert.ok(seen.length > 0);
  assert.equal(asked, 1);
  assert.equal(said.filter((m) => /reading the edge routers of xo.lan from here: this box reaches/.test(m)).length, 1);

  // A PASSING XEN ORCHESTRA OUTAGE DOES NOT BLIND A BOX THAT WAS THERE: that
  // is a moment the routers are wanted most.
  reachable = false;
  const before = seen.length;
  await watch.poll();
  assert.equal(/** @type {any} */ (watch.reportFor(ELI, 'xo.lan')).routers[0].reached, true);
  assert.ok(seen.length > before);

  // THE DEFAULT READS WHAT XoPools KEEPS: a pool whose last look failed is not tried.
  const off = new EdgeWatch({ pools: { ...holding(w, [{ name: 'fleetwright-edge', address: '127.0.0.1' }]), seen: new Map([[`${ELI} xo.lan`, { reachable: false }]]) }, apiPort: port, createSocket: fakeSocket });
  const was = seen.length;
  await off.poll();
  assert.equal(seen.length, was, 'nothing opened');
  assert.match(/** @type {any} */ (off.reportFor(ELI, 'xo.lan')).routers[0].problem, /did not try/);
});

test('what OPNsense says it cannot tell stays cannot tell', () => {
  assert.deepEqual(statusOf({}), UNREAD);
  // dpinger with no data: OPNsense calls it Online with `~` everywhere. That
  // is every router built before its gateway was monitored (MEASURED).
  const unmonitored = statusOf({ gateways: { items: [{ name: 'WAN_DHCP', status: 'none', status_translated: 'Online', monitor: '~', delay: '~', loss: '~' }] } });
  assert.deepEqual([unmonitored.gateway, unmonitored.delay, unmonitored.loss], [null, null, null]);
  const slow = statusOf({ gateways: { items: [{ name: 'WAN_DHCP', status: 'delay', monitor: '192.168.1.1', delay: '312.5 ms', loss: '4.0 %' }] } });
  assert.deepEqual([slow.gateway, slow.delay, slow.loss], [true, 312.5, 4]);
  // A router not counting names (an older build, or its database not there yet) is cannot tell, not zero.
  const uncounted = statusOf({ stats: { status: 'failed' } });
  assert.deepEqual([uncounted.answered, uncounted.blocked, uncounted.since, uncounted.topBlocked], [null, null, null, null]);
  const quiet = statusOf({ stats: { status: 'ok', data: { total: 0, blocked: { total: 0 }, start_time: 1_700_000_000, top_blocked: {} } } });
  assert.deepEqual([quiet.answered, quiet.blocked, quiet.since, quiet.topBlocked], [0, 0, 1_700_000_000_000, []]);
  const many = statusOf({ stats: { status: 'ok', data: { total: 9, blocked: { total: 9 }, start_time: 1, top_blocked: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [`n${i}.example`, { total: i }])) } } });
  assert.deepEqual(many.topBlocked?.map((t) => t.count), [7, 6, 5, 4, 3], `the ${TOP_BLOCKED} refused most, most first`);
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

test('where a router is comes from Xen Orchestra now, asked on the first poll and every five minutes, not only from the policy run', async (t) => {
  // The guest agent arrives with a router's first daily update, after the
  // policy job that recorded "no address": the watch must not keep that for good.
  const w = newWatch();
  const { port, seen } = await router(t, w);
  let now = 1_700_000_000_000;
  /** @type {Map<string, string>|null} */
  let xo = new Map();
  let asked = 0;
  const pools = {
    ...holding(w, [{ name: 'fleetwright-edge', address: null }]),
    async edgeAddresses(/** @type {string} */ k) {
      asked++;
      assert.equal(k, `${ELI} xo.lan`);
      return xo;
    },
  };
  const watch = new EdgeWatch({ pools, apiPort: port, createSocket: fakeSocket, now: () => now });

  await watch.poll();
  let r = /** @type {any} */ (watch.reportFor(ELI, 'xo.lan')).routers[0];
  assert.equal(r.reached, null);
  assert.match(r.problem, /does not know its address yet: its guest agent has not reported it \(one built before the image carried the agent gets it with its first update, after 10:00 UTC\)/, 'Xen Orchestra was asked and said none, which is not the same as not asked');

  xo = new Map([['fleetwright-edge', '127.0.0.1']]);
  now += 60_000;
  await watch.poll();
  assert.equal(asked, 1, 'asked again inside five minutes');
  now += REREAD_MS;
  await watch.poll();
  assert.equal(asked, 2);
  r = /** @type {any} */ (watch.reportFor(ELI, 'xo.lan')).routers[0];
  assert.deepEqual([r.address, r.reached, r.role], ['127.0.0.1', true, 'master'], 'read where Xen Orchestra says it is now');
  assert.ok(seen.length > 0);

  xo = null;
  now += REREAD_MS;
  await watch.poll();
  assert.equal(/** @type {any} */ (watch.reportFor(ELI, 'xo.lan')).routers[0].address, '127.0.0.1', 'a Xen Orchestra that did not answer once does not lose where the router was');
});
