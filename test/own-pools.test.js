// Machines on a box of your own, from the sidecar's side
// (src/fleet/host/own-pools.js; docs/api-engines.md, part three).
//
// The driver asks the box's hub and holds nothing, so it is run here against
// THE REAL HUB ROUTES (src/adapters/http.js, src/core/machines.js) with the
// real client between them, and a `podman` under the hub that stands in for
// the real one. What is not real is Podman and the fleet: no container is
// run and no coordinator is dialled.
//
//   node --test test/own-pools.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { OwnPools, OWN_PROVIDER, ownImageId } from '../src/fleet/host/own-pools.js';
import { Pools } from '../src/fleet/host/pools.js';
import { XoPools } from '../src/fleet/host/xo-pools.js';
import { PvePools } from '../src/fleet/host/pve-pools.js';
import { SandboxPools } from '../src/fleet/host/sandbox-pools.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken } from '../src/core/api-token.js';
import { newSealKey, open, claudeBindingFor } from '../src/fleet/seal.js';
import { stubMachinePodman } from './helpers/stub-machine-podman.js';

const ELI = 'eli@example.com';
const SAM = 'sam@example.com';
const BOX = 'deb132';
const TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789';
const ticket = (/** @type {string} */ id = 'a1b2c3d4e5f6') => `fwt_${id}_${'0'.repeat(48)}`;
const VM = 'vm-a1b2c3d4e5f6';
const FLEET = 'https://fleet.example';
const IMAGE = ownImageId(BOX);
const accounts = () => [{ email: ELI, items: [{ name: 'claude', value: TOKEN }] }, { email: 'Sam@Example.com', items: [] }];
const ask = (/** @type {Record<string, unknown>} */ over = {}) => /** @type {any} */ ({ owner: ELI, template: IMAGE, ticket: ticket(), minutes: 30, coordinatorUrl: FLEET, ...over });

/** A box: a hub with a stand-in Podman, the real client, and the driver turned on. */
async function box(/** @type {import('node:test').TestContext} */ t, { built = true, patch = {} } = {}) {
  const podman = stubMachinePodman(t);
  const cfg = { ...podman.cfg(patch), bind: '127.0.0.1', port: 0, token: '', hostname: BOX, maxSessions: 5, loginEnabled: true, sandbox: false, sandboxCredentialsFile: '', sandboxImage: 'ghcr.io/example/fleetwright-session:latest', sandboxImagePinned: false, releaseChannel: '' };
  cfg.workdir = path.join(cfg.stateDir, 'work');
  cfg.rulesFile = path.join(cfg.stateDir, 'CLAUDE.md');
  const token = ensureApiToken(cfg);
  const adapter = new HttpAdapter(cfg, { sessions: /** @type {any} */ ({ list: () => [], running: () => [], binned: () => [] }), login: /** @type {any} */ ({ status: () => ({ loggedIn: true }), isPending: () => false, pending: null }), token });
  await adapter.start();
  t.after(() => { adapter.machines.unwatch(); adapter.server?.close(); });
  if (built) assert.equal((await adapter.machines.ensureImage()).ok, true);
  const hub = new HubClient({ baseUrl: `http://127.0.0.1:${/** @type {any} */ (adapter.server).address().port}`, token, readTimeoutMs: 2000, commandTimeoutMs: 5000 });
  const own = new OwnPools({ enabled: true, hub, boxId: BOX });
  own.adopt(accounts());
  return { podman, adapter, hub, own, cfg };
}

test('off unless the operator named it: a box that was not told holds nothing, reports nothing and asks its hub nothing', async () => {
  let asked = 0;
  const hub = /** @type {any} */ ({ machines: async () => { asked += 1; return { ok: true, machines: [] }; } });
  const off = new OwnPools({ enabled: false, hub, boxId: BOX });
  assert.deepEqual(off.adopt(accounts()), accounts());
  await off.refresh();
  assert.deepEqual([off.held.size, off.report(), off.hasImage(ELI, IMAGE), asked], [0, [], false, 0]);
  assert.equal(new Pools({ own: off }).holdsAny, false);
  assert.equal(OWN_PROVIDER, 'own', 'the word an operator writes in FLEETWRIGHT_SANDBOX_PROVIDERS');
  // Turned on with no hub to ask, it is off: there is nobody to run a container.
  assert.equal(new OwnPools({ enabled: true, hub: null, boxId: BOX }).enabled, false);
});

test('a box reports itself as a place of the person’s own, for each person it is approved for, with its image once that is built', async (t) => {
  const { podman, own, adapter } = await box(t, { built: false });
  // BEFORE IT HAS LOOKED it cannot tell, and says neither "reachable" nor an image.
  assert.deepEqual(own.report().map((e) => [e.owner, e.reachable, e.images]), [[ELI, null, []], [SAM, null, []]]);
  podman.set({ buildMs: 250 });
  await own.refresh();
  const [building] = own.report();
  // THE FIRST LOOK STARTS THE BUILD, so the first machine asked for does not
  // wait one out; until then no image is offered, and why is said.
  assert.deepEqual(building, {
    address: `own:${BOX}`, owner: ELI, kind: 'sandbox', own: true, provider: BOX, reachable: true, pools: [], images: [], networks: [], machines: [],
    problem: 'This machine is building its machine image, which takes a few minutes the first time and after an update.',
  });
  await adapter.machines.building;
  await own.refresh();
  assert.deepEqual(own.report().map((e) => [e.owner, e.own, e.images, e.problem]), [[ELI, true, [{ id: IMAGE, name: 'Linux, with the fleet' }], undefined], [SAM, true, [{ id: IMAGE, name: 'Linux, with the fleet' }], undefined]]);
  assert.equal(podman.calls().filter((a) => a[0] === 'build').length, 1);
  // Somebody this box is not approved for is offered nothing here.
  assert.equal(own.hasImage('mallory@example.com', IMAGE), false);
  assert.notEqual(ownImageId('deb133'), IMAGE, 'two boxes are two images');
  // FORGOTTEN IS GONE: a person the vault no longer answers for is no longer made machines for.
  own.adopt([accounts()[0]]);
  assert.deepEqual(own.report().map((e) => e.owner), [ELI]);
});

test('making one asks the hub, which starts the container; the person’s machines are listed as theirs and nobody else’s', async (t) => {
  const { podman, own } = await box(t);
  const r = await own.make(ask());
  assert.deepEqual(r, { ok: true, name: VM, minutes: 30, text: `Made ${VM} on ${BOX}, for 30 minutes. It joins when it has started and enrolled.` });
  assert.deepEqual(JSON.parse(podman.state().seeds[0].stdin), { v: 1, coordinator: FLEET, ticket: ticket(), owner: ELI, minutes: 30 });
  await own.refresh();
  const [eli, sam] = own.report();
  assert.deepEqual(eli.machines.map((/** @type {any} */ m) => [m.name, m.state, m.image, typeof m.until, m.cpus, m.memory]), [[VM, 'Running', 'Linux, with the fleet', 'number', null, null]]);
  assert.deepEqual(sam.machines, [], 'one person’s machine is not in another’s list');

  // ONLY WITH A HYPERVISOR, said and not ignored: the machine would not be where it was asked to be.
  for (const over of [{ network: 'lan' }, { group: 'team' }, { lab: true }]) {
    const no = await own.make(ask({ ticket: ticket('c'.repeat(12)), ...over }));
    assert.deepEqual(no, { ok: false, text: `A machine on ${BOX} is on ${BOX}’s own network. A network, a group or a lab of its own needs a hypervisor, so it was not made.` });
  }
  assert.equal((await own.make(ask({ owner: 'mallory@example.com' }))).text, `${BOX} makes no machine of its own for you.`);
  assert.equal((await own.make(ask({ coordinatorUrl: '' }))).text, 'This machine does not know the fleet’s address to give the new one, so it was not made.');
  assert.equal(podman.state().containers.length, 1);
  // WHAT THE HUB REFUSES reaches the person in the hub's own sentence.
  await own.make(ask({ owner: SAM, ticket: ticket('b'.repeat(12)) }));
  assert.match((await own.make(ask({ ticket: ticket('d'.repeat(12)) }))).text, /^This machine already runs 2 of the 2 machines it may \(FLEETWRIGHT_MACHINE_MAX\)/);
});

test('more time and ending go to the hub; a restart and a resize are refused in words; another person’s machine is not theirs', async (t) => {
  const { podman, own } = await box(t);
  await own.make(ask());
  const more = await own.control({ owner: ELI, name: VM, action: 'extend', minutes: 20 });
  assert.deepEqual([more.ok, more.minutes, more.text], [true, 20, `${VM} now ends 50 minutes from now.`]);
  assert.equal((await own.control({ owner: ELI, name: VM, action: 'reboot' })).text, 'A machine on a box of your own can be ended or given more time. A restart needs a hypervisor.');
  assert.equal((await own.control({ owner: ELI, name: VM, action: 'resize' })).text, 'A machine on a box of your own can be ended or given more time. A resize needs a hypervisor.');
  const theirs = await own.control({ owner: SAM, name: VM, action: 'stop' });
  assert.deepEqual([theirs.ok, theirs.notHere], [false, true]);
  assert.equal(podman.state().containers.length, 1);
  assert.deepEqual(await own.control({ owner: ELI, name: VM, action: 'stop' }), { ok: true, text: `Ended ${VM}. Its container and its disk are removed.` });
  assert.equal(podman.state().containers.length, 0);
});

test('the sign-in is handed to the person’s own running machine, sealed to the machine’s key, and to no other', async (t) => {
  const { own } = await box(t);
  await own.make(ask());
  const key = await newSealKey();
  const handed = await own.handLogin({ owner: ELI, name: VM, key: key.publicKey });
  assert.equal(handed.ok, true, handed.text);
  // ONLY THE MACHINE THAT ASKED OPENS IT, bound to its key as a VM's is.
  const inside = /** @type {any} */ (await open({ privateKey: key.privateKey, publicKey: key.publicKey, aad: await claudeBindingFor(key.publicKey), sealed: handed.sealed }));
  assert.equal(inside.token, TOKEN);
  assert.equal(JSON.stringify(handed).includes(TOKEN), false);
  // ONCE: a second ask under the same name, with another key, is handed nothing.
  const other = await newSealKey();
  const again = await own.handLogin({ owner: ELI, name: VM, key: other.publicKey });
  assert.deepEqual([again.ok, 'sealed' in again, again.text], [false, false, `${VM} was handed its login by this machine already, so this ask is handed nothing.`]);
  // A NAME THIS BOX DID NOT MAKE, or made for somebody else, is `notHere`: the coordinator asks the next box.
  for (const [owner, name] of [[ELI, 'vm-000000000000'], [SAM, VM], ['mallory@example.com', VM]]) {
    const no = await own.handLogin({ owner, name, key: key.publicKey });
    assert.deepEqual([no.ok, no.notHere, 'sealed' in no], [false, true, false], `${owner} ${name}`);
  }
  // A PERSON WHOSE SIGN-IN THIS BOX DOES NOT HOLD is handed nothing by it.
  await own.make(ask({ owner: SAM, ticket: ticket('b'.repeat(12)) }));
  const none = await own.handLogin({ owner: SAM, name: 'vm-bbbbbbbbbbbb', key: key.publicKey });
  assert.deepEqual([none.ok, none.notHere, none.text], [false, true, `${BOX} made vm-bbbbbbbbbbbb but has no Claude login of ${SAM}’s to hand it; another of their machines may.`]);
});

test('a hub that cannot be asked is "could not look", never "no machines"', async (t) => {
  const { podman, own, adapter } = await box(t);
  await own.make(ask());
  await own.refresh();
  assert.equal(own.report()[0].machines.length, 1);
  // PODMAN DOWN: the coordinator retires a machine a reachable place no
  // longer lists, so "reachable" must not be said of a look that failed.
  podman.set({ down: true });
  await own.refresh();
  assert.deepEqual([own.report()[0].reachable, own.report()[0].machines, own.report()[0].problem], [false, [], 'Podman could not list this machine’s containers: Error: cannot connect to Podman']);
  // THE HUB ITSELF GONE: the same, and making says it does not know whether one was made.
  await new Promise((r) => adapter.server?.close(() => r(null)));
  adapter.server?.closeAllConnections?.();
  await own.refresh();
  assert.equal(own.report()[0].reachable, false);
  assert.match(String(own.report()[0].problem), /^The hub on this machine did not answer/);
  const r = await own.make(ask({ ticket: ticket('e'.repeat(12)) }));
  assert.deepEqual([r.ok, r.unreachable], [false, true]);
  assert.match(r.text, /^The hub on deb132 did not answer, so whether vm-eeeeeeeeeeee was made is not known: .*\. Look at Machines before trying again\.$/);
  const c = await own.control({ owner: ELI, name: VM, action: 'stop' });
  assert.deepEqual([c.ok, c.unreachable], [false, true]);
});

test('behind the one seam: its image is made here, and a machine by name is asked of this box before a hypervisor that is down', async (t) => {
  const { own, podman } = await box(t);
  /** @type {string[]} */
  const askedOf = [];
  const down = (/** @type {string} */ who) => /** @type {any} */ ({
    held: new Map([[`${ELI} ${who}`, { owner: ELI, record: {} }]]), seen: new Map(), adopt: (/** @type {any} */ a) => a, report: () => [], refresh: async () => {},
    hasImage: () => false, holdsFor: () => true,
    make: async () => { askedOf.push(`${who} make`); return { ok: false, text: 'no' }; },
    control: async () => { askedOf.push(`${who} control`); return { ok: false, unreachable: true, text: 'Your pools could not be reached from here: xo.lan (no answer)' }; },
    handLogin: async () => { askedOf.push(`${who} handLogin`); return { ok: false, notHere: true, text: 'not on your pools' }; },
  });
  const pools = new Pools({ xo: down('xo'), pve: new PvePools({}), sandbox: new SandboxPools({}), own });
  assert.equal(pools.holdsAny, true);
  assert.equal(pools.kindOf(`${ELI} own`), 'sandbox');
  assert.deepEqual(pools.report().map((e) => [e.kind, /** @type {any} */ (e).own]), [['sandbox', true], ['sandbox', true]]);
  assert.equal((await pools.make(ask())).ok, true);
  assert.equal((await pools.control({ owner: ELI, name: VM, action: 'stop' })).ok, true);
  assert.deepEqual(askedOf, [], 'the pool that is down was never waited on for a machine that is here');
  assert.equal(podman.state().containers.length, 0);
  // A MACHINE THAT IS NOT HERE goes on to the hypervisors, and their answer is the one given.
  const elsewhere = await pools.control({ owner: ELI, name: 'vm-000000000000', action: 'stop' });
  assert.deepEqual([elsewhere.unreachable, elsewhere.text], [true, 'Your pools could not be reached from here: xo.lan (no answer)']);
  assert.equal((await pools.handLogin({ owner: ELI, name: 'vm-000000000000', key: 'k' })).text, 'not on your pools');
  assert.deepEqual(askedOf, ['xo control', 'xo handLogin']);
  // WITH NOTHING ELSE TO ASK, this box's own answer stands.
  const alone = new Pools({ xo: new XoPools({}), pve: new PvePools({}), sandbox: new SandboxPools({}), own });
  assert.equal((await alone.control({ owner: ELI, name: 'vm-000000000000', action: 'stop' })).text, 'vm-000000000000 is not a machine of yours on this machine.');
});

test('a sidecar told `own` reports the box in its health frame, with why it offers no image yet and nobody’s sign-in', async (t) => {
  const { Sidecar } = await import('../src/fleet/host/sidecar.js');
  const { hub, podman, adapter } = await box(t, { built: false });
  podman.set({ failBuild: true });
  const make = (/** @type {string[]} */ sandboxProviders) => new Sidecar({
    hub,
    transport: /** @type {any} */ ({ origin: FLEET, send: () => true, on() {}, start() {}, stop() {}, close() {} }),
    hostId: BOX, labels: [], healthIntervalMs: 0, watch: false, logger: { debug() {}, info() {}, warn() {}, error() {} },
    vaultKey: /** @type {any} */ ({}), sandboxProviders,
  });
  const sidecar = make(['own']);
  const pools = /** @type {Pools} */ (sidecar.pools);
  pools.adopt(accounts());
  await pools.refresh();
  await adapter.machines.building;
  await pools.refresh();
  const health = /** @type {any} */ (await sidecar.health());
  assert.deepEqual(health.xo.map((/** @type {any} */ e) => [e.address, e.kind, e.own, e.provider, e.owner, e.reachable, e.images, e.problem]), [
    [`own:${BOX}`, 'sandbox', true, BOX, ELI, true, [], 'The machine image could not be built on this machine: STEP 4/9: RUN curl ... / Error: could not resolve deb.nodesource.com'],
    [`own:${BOX}`, 'sandbox', true, BOX, SAM, true, [], 'The machine image could not be built on this machine: STEP 4/9: RUN curl ... / Error: could not resolve deb.nodesource.com'],
  ]);
  assert.equal(JSON.stringify(health).includes(TOKEN), false);
  // NOT TOLD, the same box says nothing of itself, as every box did before this.
  const quiet = make([]);
  /** @type {Pools} */ (quiet.pools).adopt(accounts());
  assert.equal('xo' in /** @type {any} */ (await quiet.health()), false);
});
