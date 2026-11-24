// The sandbox driver (src/fleet/host/sandbox-pools.js, docs/api-engines.md)
// against a server that stands in for E2B's API as its reference documents
// it: create, list, set the timeout, delete, each with X-API-Key.
//
// NO PROVIDER IS CALLED HERE. The stand-in listens on loopback and answers
// in the documented shapes, including the ones that matter most: a key that
// is refused, a provider that is down, and a retry of a create.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SandboxPools, sandboxRecord, sandboxImageId, isSandboxItem, SANDBOX_MAX_MINUTES, MAX_SANDBOX_TEMPLATES } from '../src/fleet/host/sandbox-pools.js';
import { Pools } from '../src/fleet/host/pools.js';

const KEY = 'e2b_0123456789abcdef0123456789abcdef';
const TICKET = `fwt_${'a1b2c3d4e5f6'}_${'0'.repeat(48)}`;
const ELI = 'eli@example.com';
const item = (/** @type {any} */ o = {}) => ({ name: 'sandbox:e2b', value: JSON.stringify({ key: KEY, templates: [{ id: 'fleetwright-linux', name: 'Linux, with the fleet' }], ...o }) });

/** E2B, on loopback. `sandboxes` is what the account holds; `requests` every call made. */
async function e2b(/** @type {import('node:test').TestContext} */ t) {
  /** @type {any[]} */
  const sandboxes = [];
  /** @type {any[]} */
  const requests = [];
  const state = { down: false, refuse: /** @type {number|null} */ (null), says: /** @type {string|null} */ (null), nextId: 1 };
  /** @type {Map<string, any>} what each idempotency key made */
  const made = new Map();
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      const url = new URL(String(req.url), 'http://e2b.test');
      const body = text ? JSON.parse(text) : undefined;
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, key: req.headers['x-api-key'], idempotency: req.headers['idempotency-key'] });
      const send = (/** @type {number} */ status, /** @type {any} */ json) => {
        res.writeHead(status, json === undefined ? {} : { 'content-type': 'application/json' });
        res.end(json === undefined ? '' : JSON.stringify(json));
      };
      if (state.down) return void req.socket.destroy();
      if (req.headers['x-api-key'] !== KEY) return send(401, { code: 401, message: 'Invalid API key' });
      if (state.refuse) return send(state.refuse, { code: state.refuse, message: state.says ?? (state.refuse === 429 ? 'Rate limit exceeded' : 'team is banned\nSECOND LINE') });
      if (req.method === 'POST' && url.pathname === '/v2/sandboxes') {
        const again = made.get(String(req.headers['idempotency-key']));
        if (again) return send(201, again);
        const sandbox = { sandboxID: `sbx-${state.nextId++}`, templateID: body.templateID, alias: body.templateID, state: 'running', startedAt: new Date(Date.UTC(2026, 10, 24, 12)).toISOString(), cpuCount: 2, memoryMB: 512, metadata: body.metadata, endAt: new Date(Date.UTC(2026, 10, 24, 12) + body.timeout * 1000).toISOString(), envVars: body.envVars };
        sandboxes.push(sandbox);
        const answer = { sandboxID: sandbox.sandboxID, templateID: sandbox.templateID, clientID: 'c', envdVersion: '0.2.0' };
        made.set(String(req.headers['idempotency-key']), answer);
        return send(201, answer);
      }
      if (req.method === 'GET' && url.pathname === '/v2/sandboxes') {
        const want = new URLSearchParams(url.searchParams.get('metadata') ?? '');
        return send(200, sandboxes.filter((s) => [...want].every(([k, v]) => s.metadata?.[k] === v)).map(({ envVars: _never, ...s }) => s));
      }
      const one = /^\/sandboxes\/([^/]+)(\/timeout)?$/.exec(url.pathname);
      const at = one ? sandboxes.findIndex((s) => s.sandboxID === decodeURIComponent(one[1])) : -1;
      if (one && at < 0) return send(404, { code: 404, message: `Sandbox "${one[1]}" doesn't exist or you don't have access to it` });
      if (one && req.method === 'DELETE' && !one[2]) { sandboxes.splice(at, 1); return send(204); }
      if (one && req.method === 'POST' && one[2]) { sandboxes[at].endAt = new Date(Date.UTC(2026, 10, 24, 12) + body.timeout * 1000).toISOString(); return send(204); }
      send(404, { code: 404, message: 'not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  t.after(() => new Promise((r) => server.close(() => r(null))));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  return { base, sandboxes, requests, state };
}

/** A driver on the stand-in, holding Eli's key. */
async function driver(/** @type {import('node:test').TestContext} */ t, /** @type {any} */ opts = {}) {
  const provider = await e2b(t);
  const pools = new SandboxPools({ providers: ['e2b'], base: { e2b: provider.base }, now: () => Date.UTC(2026, 10, 24, 12), ...opts });
  pools.adopt([{ email: ELI, items: [item(), { name: 'claude', value: 'not-this-driver’s' }] }]);
  return { pools, ...provider, image: sandboxImageId('e2b', 'fleetwright-linux') };
}
const ask = (/** @type {any} */ o = {}) => ({ owner: ELI, ticket: TICKET, coordinatorUrl: 'https://fleet.example', ...o });

test('a sandbox record is a key and the templates a person listed, and anything else is not one', () => {
  assert.deepEqual(sandboxRecord('sandbox:e2b', item().value), { provider: 'e2b', key: KEY, templates: [{ id: 'fleetwright-linux', name: 'Linux, with the fleet' }] });
  // A template with no name is called by its id; one that does not read as an id is left out; and a record offers a dozen.
  const many = sandboxRecord('sandbox:e2b', JSON.stringify({ key: KEY, templates: [{ id: 'bare' }, { id: 'has space' }, 'nope', ...Array.from({ length: 20 }, (_, i) => ({ id: `t${i}` }))] }));
  assert.equal(many?.templates[0].name, 'bare');
  assert.equal(many?.templates.length, MAX_SANDBOX_TEMPLATES);
  assert.ok(!many?.templates.some((x) => x.id === 'has space'));
  for (const [name, value] of /** @type {Array<[string, any]>} */ ([['sandbox:acme', item().value], ['sandbox:e2b', 'not json'], ['sandbox:e2b', JSON.stringify({ key: 'short' })], ['sandbox:e2b', JSON.stringify({ templates: [] })], ['hypervisor:e2b', item().value], ['sandbox:e2b', 7]])) {
    assert.equal(sandboxRecord(name, value), null, `${name} ${String(value).slice(0, 20)}`);
  }
  assert.deepEqual([isSandboxItem('sandbox:e2b'), isSandboxItem('secret:sandbox'), isSandboxItem(null)], [true, false, false]);
  // An image id is a UUID, the same for the same template, and not the template's own name.
  assert.match(sandboxImageId('e2b', 'fleetwright-linux'), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(sandboxImageId('e2b', 'a'), sandboxImageId('e2b', 'b'));
});

test('a box whose operator named no provider holds no key, reports nothing, and still takes the item out of what the hub is handed', () => {
  const off = new SandboxPools({});
  const out = off.adopt([{ email: ELI, items: [item(), { name: 'secret:X', value: 'kept' }] }]);
  assert.equal(off.takes, false);
  assert.deepEqual([off.held.size, off.report()], [0, []]);
  assert.deepEqual(out, [{ email: ELI, items: [{ name: 'secret:X', value: 'kept' }] }], 'a provider’s key is never filed by the hub');
  // A provider nobody has a row for is not turned on by being named.
  assert.equal(new SandboxPools({ providers: ['acme', ' E2B '] }).takes, true);
  assert.deepEqual(new SandboxPools({ providers: ['acme'] }).allowed, []);
});

test('the report is the shape a hypervisor’s is: the templates as images, the fleet’s own sandboxes as machines, and never the key', async (t) => {
  const { pools, sandboxes, image } = await driver(t);
  // Before anybody asked the provider: held, and whether it answers is not known.
  assert.deepEqual(pools.report(), [{ address: 'e2b', owner: ELI, kind: 'sandbox', provider: 'E2B', reachable: null, pools: [], images: [{ id: image, name: 'Linux, with the fleet' }], networks: [], machines: [] }]);
  // The account also holds sandboxes this fleet never made, and one made for somebody else.
  sandboxes.push({ sandboxID: 'theirs', templateID: 'other', state: 'running', metadata: {}, endAt: '2026-11-24T13:00:00Z' });
  sandboxes.push({ sandboxID: 'sams', templateID: 'fleetwright-linux', state: 'running', metadata: { fleetwright: '1', name: 'vm-ffffffffffff', owner: 'sam@example.com' }, endAt: '2026-11-24T13:00:00Z' });
  assert.equal((await pools.make(ask({ template: image, minutes: 30 }))).ok, true);
  await pools.refresh();
  const [entry] = pools.report();
  assert.equal(entry.reachable, true);
  assert.deepEqual(entry.machines, [{ name: 'vm-a1b2c3d4e5f6', id: 'sbx-1', state: 'Running', until: Date.UTC(2026, 10, 24, 12, 30), madeAt: Date.UTC(2026, 10, 24, 12), cpus: 2, memory: 512 * 1024 * 1024, image: 'Linux, with the fleet' }]);
  assert.ok(!JSON.stringify(pools.report()).includes(KEY));
  assert.equal(pools.hasImage(ELI, image), true);
  assert.equal(pools.hasImage('sam@example.com', image), false);
});

test('a person whose address has a plus in it is still found among the provider’s sandboxes', async (t) => {
  // The list is filtered by a query string inside a query string.
  const PLUS = 'eli+fleet@example.com';
  const provider = await e2b(t);
  const pools = new SandboxPools({ providers: ['e2b'], base: { e2b: provider.base }, now: () => Date.UTC(2026, 10, 24, 12) });
  pools.adopt([{ email: PLUS, items: [item()] }]);
  assert.equal((await pools.make(ask({ owner: PLUS, template: sandboxImageId('e2b', 'fleetwright-linux') }))).ok, true);
  await pools.refresh();
  assert.deepEqual(pools.report()[0].machines.map((/** @type {any} */ m) => m.name), ['vm-a1b2c3d4e5f6']);
  assert.equal((await pools.control({ owner: PLUS, name: 'vm-a1b2c3d4e5f6', action: 'stop' })).ok, true);
});

test('make starts the template with the ticket and the fleet’s address, for the minutes asked, under a key that makes a retry the same machine', async (t) => {
  const { pools, requests, sandboxes, image } = await driver(t);
  const made = await pools.make(ask({ template: image, minutes: 45 }));
  assert.deepEqual([made.ok, made.name, made.minutes], [true, 'vm-a1b2c3d4e5f6', 45]);
  assert.equal(made.text, 'Made vm-a1b2c3d4e5f6 at E2B, for 45 minutes. It joins when its template has started and enrolled; a template that does not enrol leaves it running there until its time is up.');
  const sent = requests.at(-1);
  assert.deepEqual([sent.method, sent.path, sent.key, sent.idempotency], ['POST', '/v2/sandboxes', KEY, 'fleetwright-a1b2c3d4e5f6']);
  assert.deepEqual(sent.body, {
    templateID: 'fleetwright-linux',
    timeout: 45 * 60,
    envVars: { FLEETWRIGHT_TICKET: TICKET, FLEETWRIGHT_COORDINATOR: 'https://fleet.example' },
    metadata: { fleetwright: '1', name: 'vm-a1b2c3d4e5f6', owner: ELI },
  });
  assert.ok(!String(sent.idempotency).includes('0'.repeat(48)), 'the key is the ticket’s public half, never its secret');
  // The same ticket again is the same machine at the provider.
  assert.equal((await pools.make(ask({ template: image, minutes: 45 }))).ok, true);
  assert.equal(sandboxes.length, 1);
  // The life is held to what a machine may have.
  await pools.make(ask({ template: image, minutes: 100_000, ticket: `fwt_${'b'.repeat(12)}_${'1'.repeat(48)}` }));
  assert.equal(requests.at(-1).body.timeout, SANDBOX_MAX_MINUTES * 60);
});

test('make refuses in words what it will not do, and sends nothing', async (t) => {
  const { pools, requests, image } = await driver(t);
  const refused = async (/** @type {any} */ o) => {
    const before = requests.length;
    const r = await pools.make(ask({ template: image, ...o }));
    assert.equal(requests.length, before, JSON.stringify(o));
    return r.text;
  };
  assert.equal(await refused({ ticket: 'not-a-ticket' }), 'That machine came without the ticket it enrols with, so it was not made.');
  assert.equal(await refused({ template: sandboxImageId('e2b', 'somebody-elses') }), 'This machine holds no sandbox provider of yours with that template.');
  assert.equal(await refused({ owner: 'sam@example.com' }), 'This machine holds no sandbox provider of yours with that template.');
  assert.equal(await refused({ network: 'n-1' }), 'A machine at E2B is on E2B’s own network. It joins no network, group or lab of a pool’s, so it was not made.');
  assert.match(await refused({ lab: true }), /joins no network, group or lab/);
  assert.equal(await refused({ coordinatorUrl: 'http://fleet.example' }), 'This machine does not know the fleet’s address to give the new one, so it was not made.');
});

test('a provider that refuses the key, is busy, or is down is said as that, and a create nobody answered is not called made or not made', async (t) => {
  const { pools, state, image } = await driver(t);
  state.refuse = 403;
  assert.equal((await pools.make(ask({ template: image }))).text, 'E2B did not make the machine: it refused the key (403: team is banned).');
  // A PROVIDER THAT QUOTES THE KEY BACK in its refusal does not put it on a screen.
  state.refuse = 401;
  state.says = `key ${KEY} is not valid`;
  const quoted = (await pools.make(ask({ template: image }))).text;
  assert.equal(quoted, 'E2B did not make the machine: it refused the key (401: key [the key] is not valid).');
  state.says = null;
  state.refuse = 429;
  assert.equal((await pools.make(ask({ template: image }))).text, 'E2B did not make the machine: it is being asked too often just now.');
  await pools.refresh();
  assert.deepEqual([pools.report()[0].reachable, pools.report()[0].problem], [false, 'it is being asked too often just now']);
  state.refuse = null;
  state.down = true;
  const lost = await pools.make(ask({ template: image }));
  assert.deepEqual([lost.ok, lost.unreachable], [false, true]);
  assert.match(lost.text, /^E2B could not be reached from here, so whether vm-a1b2c3d4e5f6 was made is not known: .*\. Look at Machines before trying again\.$/);
  await pools.refresh();
  assert.equal(pools.report()[0].reachable, false);
  assert.equal((await pools.control({ owner: ELI, name: 'vm-a1b2c3d4e5f6', action: 'stop' })).unreachable, true);
});

test('a machine is ended or given more time, and a sandbox has neither a restart nor a resize', async (t) => {
  const { pools, sandboxes, requests, image } = await driver(t);
  await pools.make(ask({ template: image, minutes: 30 }));
  const name = 'vm-a1b2c3d4e5f6';
  const more = await pools.control({ owner: ELI, name, action: 'extend', minutes: 90 });
  assert.deepEqual([more.ok, more.minutes, more.text], [true, 90, `${name} now ends 90 minutes from now.`]);
  assert.deepEqual([requests.at(-1).method, requests.at(-1).path, requests.at(-1).body], ['POST', '/sandboxes/sbx-1/timeout', { timeout: 90 * 60 }]);
  assert.equal((await pools.control({ owner: ELI, name, action: 'reboot' })).text, 'A machine at E2B can be ended or given more time. It has no restart.');
  assert.equal((await pools.control({ owner: ELI, name, action: 'resize' })).text, 'A machine at E2B can be ended or given more time. It has no resize.');
  // Somebody else cannot end it, and is told nothing about whether it exists.
  assert.deepEqual([(await pools.control({ owner: 'sam@example.com', name, action: 'stop' })).notHere, sandboxes.length], [true, 1]);
  assert.equal((await pools.control({ owner: ELI, name: 'rm -rf', action: 'stop' })).text, 'That is not the name of a machine this fleet made.');
  const ended = await pools.control({ owner: ELI, name, action: 'stop' });
  assert.deepEqual([ended.ok, ended.text, sandboxes.length], [true, `Ended ${name}. E2B has removed it.`, 0]);
  // Gone is gone: asked again, it is not there.
  assert.equal((await pools.control({ owner: ELI, name, action: 'stop' })).notHere, true);
  // And no sign-in is handed to a machine on somebody else's cloud.
  const login = await pools.handLogin({ owner: ELI, name });
  assert.deepEqual([login.ok, /a sign-in is not handed to a machine on somebody else’s cloud/.test(login.text)], [false, true]);
});

test('behind the one seam: an image goes to the driver that has it, and a machine nobody else has is the sandbox driver’s to end', async (t) => {
  const { pools: sandbox, sandboxes, image } = await driver(t);
  /** A hypervisor driver that holds nothing of anybody's. */
  const empty = () => /** @type {any} */ ({
    held: new Map(), seen: new Map(), adopt: (/** @type {any} */ a) => a, report: () => [], refresh: async () => {},
    hasImage: () => false, holdsFor: () => false,
    make: async () => ({ ok: false, text: 'This machine manages no pool of yours with that machine image.' }),
    control: async () => ({ ok: false, notHere: true, text: 'This machine manages none of your pools.' }),
    handLogin: async () => ({ ok: false, notHere: true, text: 'This machine manages none of your pools.' }),
  });
  const pools = new Pools({ xo: empty(), pve: empty(), sandbox });
  assert.equal((await pools.make(ask({ template: image }))).ok, true);
  assert.equal(sandboxes.length, 1);
  assert.equal((await pools.make(ask({ template: '00000000-0000-8000-8000-000000000000' }))).text, 'This machine manages no pool of yours with that machine image.');
  assert.equal((await pools.control({ owner: ELI, name: 'vm-a1b2c3d4e5f6', action: 'stop' })).ok, true);
  assert.equal(sandboxes.length, 0);
  assert.match((await pools.handLogin({ owner: ELI, name: 'vm-a1b2c3d4e5f6', key: 'k' })).text, /is at a sandbox provider/);
  await pools.refresh();
  assert.deepEqual(pools.report().map((e) => e.kind), ['sandbox']);
  assert.equal(pools.kindOf(`${ELI} e2b`), 'sandbox');
  // What the seam hands the hub has no provider's key in it.
  assert.deepEqual(pools.adopt([{ email: ELI, items: [item()] }]), [{ email: ELI, items: [] }]);
});

test('a sandbox machine can be ended while the same person’s hypervisor is out of reach', async (t) => {
  // A pool that did not answer has not said whose the machine is. Taken as
  // the answer, it left a rented machine running that nobody could end.
  const { pools: sandbox, sandboxes, image } = await driver(t);
  const down = () => /** @type {any} */ ({
    held: new Map([[`${ELI} xo.lan`, { owner: ELI, record: {} }]]), seen: new Map(), adopt: (/** @type {any} */ a) => a, report: () => [], refresh: async () => {},
    hasImage: () => false, holdsFor: () => true,
    make: async () => ({ ok: false, text: 'This machine manages no pool of yours with that machine image.' }),
    control: async () => ({ ok: false, unreachable: true, text: 'Your pools could not be reached from here: xo.lan (no answer)' }),
    handLogin: async () => ({ ok: false, unreachable: true, text: 'Your pools could not be reached from here: xo.lan (no answer)' }),
  });
  const none = () => /** @type {any} */ ({ ...down(), held: new Map(), holdsFor: () => false });
  const pools = new Pools({ xo: down(), pve: none(), sandbox });
  assert.equal((await pools.make(ask({ template: image }))).ok, true);
  assert.equal((await pools.control({ owner: ELI, name: 'vm-a1b2c3d4e5f6', action: 'stop' })).ok, true);
  assert.equal(sandboxes.length, 0, 'the provider was asked, and ended it');
  // A machine neither has: the pool that could not be reached is still the thing to say.
  assert.match((await pools.control({ owner: ELI, name: 'vm-000000000000', action: 'stop' })).text, /^Your pools could not be reached from here/);
});

test('a box that holds only a sandbox provider says so in its report, with no hypervisor beside it', async (t) => {
  // The sidecar looked and reported only while it held a pool or a cluster,
  // so a provider on its own was held, never asked and never offered.
  const { Sidecar } = await import('../src/fleet/host/sidecar.js');
  const { HubClient } = await import('../src/fleet/host/hub-client.js');
  const { startStubHub } = await import('./helpers/stub-hub.js');
  const { XoPools } = await import('../src/fleet/host/xo-pools.js');
  const { PvePools } = await import('../src/fleet/host/pve-pools.js');
  const { pools: sandbox, image } = await driver(t);
  const pools = new Pools({ xo: new XoPools({}), pve: new PvePools({}), sandbox });
  assert.equal(pools.held.size, 0, 'no pool and no cluster');
  assert.equal(pools.holdsAny, true);
  const stub = await startStubHub({});
  t.after(() => stub.close());
  const sidecar = new Sidecar({
    hub: new HubClient({ baseUrl: stub.baseUrl, token: null, readTimeoutMs: 2000 }),
    transport: /** @type {any} */ ({ origin: 'https://fleet.example', send: () => true, on() {}, start() {}, stop() {}, close() {} }),
    hostId: 'deb132', labels: [], healthIntervalMs: 0, watch: false, logger: { debug() {}, info() {}, warn() {}, error() {} }, xoPools: /** @type {any} */ (pools),
  });
  const health = /** @type {any} */ (await sidecar.health());
  assert.deepEqual(health.xo.map((/** @type {any} */ e) => [e.kind, e.provider, e.images.map((/** @type {any} */ i) => i.id)]), [['sandbox', 'E2B', [image]]]);
  assert.ok(!JSON.stringify(health).includes(KEY));
  assert.equal(new Pools({ xo: new XoPools({}), pve: new PvePools({}), sandbox: new SandboxPools({ providers: ['e2b'] }) }).holdsAny, false, 'and one that holds nothing reports nothing');
});
