// A sandbox provider in the coordinator (docs/api-engines.md, "Part two"):
// its templates among the machine images, marked as the provider's; making
// one asked of the box that holds the key; the machine listed, never given a
// member, and gone at the box's next look once the provider has ended it.
//
//   node --test test/sandbox-coordinator.test.js
//
// The box is played by a transport that answers from a function, as in
// test/pool-vms-coordinator.test.js. What the entry looks like is the
// driver's own report, which test/sandbox-pools.test.js holds against a
// stand-in for the provider.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { generateKeyPair } from '../src/fleet/crypto.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { sandboxImageId } from '../src/fleet/host/sandbox-pools.js';

const ELI = 'eli@example.com';
const eli = { email: ELI, admin: true };
const sam = { email: 'sam@example.com', admin: false };
const LINUX = sandboxImageId('e2b', 'fleetwright-linux');

/** What a box holding Eli's E2B key reports, as SandboxPools.report() writes it. @param {Record<string, any>} [over] */
const look = (over = {}) => [{ address: 'e2b', owner: ELI, kind: 'sandbox', provider: 'E2B', reachable: true, pools: [], images: [{ id: LINUX, name: 'Linux, with the fleet' }], networks: [], machines: [], ...over }];
const health = (/** @type {any[]} */ xo) => ({ kind: 'health', health: { hub: { reachable: true }, protocol: PROTOCOL_VERSION, maxSessions: 5, running: 0, free: 5, labels: [], xo } });

function fleet() {
  const core = new CoordinatorCore({});
  core.registry.connect('deb132', () => {});
  core.registry.recordHealth('deb132', health(look()).health);
  /** @type {Array<{ hostId: string, spec: any }>} */
  const asked = [];
  core.send = /** @type {any} */ (async (/** @type {any} */ host, /** @type {any} */ spec) => {
    asked.push({ hostId: host.hostId, spec });
    return { ok: true, text: 'Made it at E2B.' };
  });
  const make = () => /** @type {Promise<any>} */ (core.dispatch({ verb: 'provision', params: { platform: 'vm', template: LINUX }, actor: `fleet:${ELI}`, requester: eli }));
  return { core, asked, make };
}

test('a sandbox template is offered as a machine image marked as the provider’s, to the person whose key it is', () => {
  const { core } = fleet();
  const mine = core.snapshot(eli);
  assert.deepEqual(mine.vmImages.map((/** @type {any} */ i) => [i.template, i.name, i.kind, i.provider, i.hosts, i.networks, i.labs]), [[LINUX, 'Linux, with the fleet', 'sandbox', 'E2B', ['deb132'], [], []]]);
  // Listed with the hypervisors, as a third kind of place and by its own name.
  assert.deepEqual(mine.hypervisors.map((/** @type {any} */ h) => [h.address, h.kind, h.provider, h.images]), [['e2b', 'sandbox', 'E2B', 1]]);
  assert.deepEqual(core.snapshot(sam).vmImages, [], 'a key is its owner’s, and so are its templates');
  // An entry that says another kind is not turned into a sandbox by naming a provider.
  core.registry.recordHealth('deb132', health(look({ kind: 'proxmox' })).health);
  assert.deepEqual(core.snapshot(eli).vmImages.map((/** @type {any} */ i) => [i.kind, i.provider]), [['proxmox', null]]);
});

test('making one asks the box that holds the key, with a ticket, and the record says whose cloud it is on', async () => {
  const { core, asked, make } = fleet();
  const r = await make();
  assert.equal(r.ok, true, r.text);
  assert.match(r.vm, /^vm-[0-9a-f]{12}$/);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].hostId, 'deb132');
  assert.equal(asked[0].spec.verb, 'provision');
  assert.equal(asked[0].spec.params.template, LINUX);
  assert.ok(asked[0].spec.params.ticket, 'the machine enrols with a ticket, as a VM does');
  assert.equal(core.events.find((e) => e.event === 'vm.requested')?.text, `${ELI} asked for a machine from Linux, with the fleet on E2B, as ${r.vm}`);
});

test('the machine is listed as the provider’s, is never given a member, and goes at the box’s next look once the provider has ended it', async () => {
  const { core, asked, make } = fleet();
  assert.equal(core.setMember(eli, 'eli', { name: 'Eli', kind: 'person', email: ELI, role: 'owner' }).ok, true);
  assert.equal(core.setMember(eli, 'debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer', reportsTo: 'eli' }).ok, true);
  const r = await make();
  const vm = r.vm;
  const until = Date.now() + 1_800_000;
  const key = await generateKeyPair();
  assert.equal((await core.enrolVm({ ticket: asked[0].spec.params.ticket, publicJwk: key.publicJwk })).status, 200);
  core.registry.connect(vm, () => {}, { ephemeral: true, owner: ELI, actsFor: ELI });
  core.registry.recordHealth(vm, { hub: { reachable: true }, protocol: PROTOCOL_VERSION, maxSessions: 1, running: 0, free: 1, labels: [], sandboxed: true, sessions: [] });
  await core.onHostMessage('deb132', health(look({ machines: [{ name: vm, id: 'sbx-1', state: 'Running', until, madeAt: until - 1_800_000, cpus: 2, memory: 512 * 1024 * 1024, image: 'Linux, with the fleet' }] })));

  const [listed] = core.snapshot(eli).vmMachines;
  assert.deepEqual([listed.name, listed.kind, listed.provider, listed.state, listed.until, listed.image], [vm, 'sandbox', 'E2B', 'Running', until, 'Linux, with the fleet']);
  assert.ok(!JSON.stringify(listed).includes('sbx-1'), 'the provider’s own id stays on the box');

  // A MEMBER IS NEVER STARTED THERE: what a rented machine holds, its provider can read.
  const started = /** @type {any} */ (await core.dispatch({ verb: 'start', params: { member: 'debbie', task: 'Fix it.' }, actor: ELI, requester: eli, preferHost: vm }));
  assert.equal(started.error?.code, 'member_needs_a_box', started.text);
  assert.ok(!asked.some((a) => a.hostId === vm), 'nothing was sent to it');

  const retired = () => core.events.filter((e) => e.event === 'host.retired').map((e) => e.hostId);
  core.hostDisconnected(vm, 'socket closed: 1006');
  // THE PROVIDER OUT OF REACH says nothing about the machine.
  await core.onHostMessage('deb132', health(look({ reachable: false, problem: 'it did not answer' })));
  assert.deepEqual(retired(), []);
  // REACHED, AND THE MACHINE NOT AMONG THIS FLEET'S: its time was up. A
  // provider has no pools to show, and its answer is believed without one.
  await core.onHostMessage('deb132', health(look()));
  assert.deepEqual(retired(), [vm]);
  assert.ok(core.hostIds.get(vm).revokedAt, 'its key went with it');
});

test('a box of the person’s own is a place marked own and named for the box, never a provider’s, and its machine goes at the box’s next look', async () => {
  const core = new CoordinatorCore({});
  core.registry.connect('deb132', () => {});
  const OWN = '6f1e2d3c-4b5a-8697-8a1b-2c3d4e5f6a7b';
  const own = (/** @type {any} */ over = {}) => ({ address: 'own:deb132', owner: ELI, kind: 'sandbox', own: true, provider: 'deb132', reachable: true, pools: [], images: [{ id: OWN, name: 'Linux, with the fleet' }], networks: [], machines: [], ...over });
  // Beside a provider's, on the same box: one is the person's own and the other is rented.
  core.registry.recordHealth('deb132', health([...look(), own()]).health);
  const mine = core.snapshot(eli);
  assert.deepEqual(mine.vmImages.map((/** @type {any} */ i) => [i.template, i.kind, i.provider, i.own, i.address]), [[LINUX, 'sandbox', 'E2B', false, 'e2b'], [OWN, 'sandbox', 'deb132', true, 'own:deb132']]);
  assert.deepEqual(mine.hypervisors.map((/** @type {any} */ h) => [h.address, h.kind, h.provider, h.own, h.images]), [['e2b', 'sandbox', 'E2B', false, 1], ['own:deb132', 'sandbox', 'deb132', true, 1]]);
  assert.deepEqual(core.snapshot(sam).vmImages, [], 'a box makes these for the people it is approved for, and says whose each is');

  // ONLY `true` IS OWN: a hypervisor's entry that says it, or a word that is
  // not the word, is what it was before this.
  core.registry.recordHealth('deb132', health([own({ own: 'yes' }), own({ address: 'xo.lan', kind: 'xo', pools: ['p'] })]).health);
  assert.deepEqual(core.snapshot(eli).hypervisors.map((/** @type {any} */ h) => [h.kind, h.own]), [['sandbox', false], ['xo', false]]);

  // WHY IT OFFERS NO IMAGE YET reaches the person while the box is reached:
  // it is building one. A provider's place says why only when it is not reached.
  core.registry.recordHealth('deb132', health([own({ images: [], problem: 'This machine is building its machine image, which takes a few minutes the first time and after an update.' }), ...look({ problem: 'ignored while reached' })]).health);
  assert.deepEqual(core.snapshot(eli).hypervisors.map((/** @type {any} */ h) => [h.address, h.images, h.boxes[0].problem]), [
    ['e2b', 1, null],
    ['own:deb132', 0, 'This machine is building its machine image, which takes a few minutes the first time and after an update.'],
  ]);

  // MADE AS ANY MACHINE IS: the box is asked, with a ticket, and the record names the box it is on.
  core.registry.recordHealth('deb132', health([own()]).health);
  /** @type {any[]} */
  const asked = [];
  core.send = /** @type {any} */ (async (/** @type {any} */ host, /** @type {any} */ spec) => {
    asked.push({ hostId: host.hostId, spec });
    return { ok: true, text: 'Made it on deb132.' };
  });
  const r = /** @type {any} */ (await core.dispatch({ verb: 'provision', params: { platform: 'vm', template: OWN }, actor: `fleet:${ELI}`, requester: eli }));
  assert.equal(r.ok, true, r.text);
  assert.equal(core.events.find((e) => e.event === 'vm.requested')?.text, `${ELI} asked for a machine from Linux, with the fleet on deb132, as ${r.vm}`);
  const key = await generateKeyPair();
  assert.equal((await core.enrolVm({ ticket: asked[0].spec.params.ticket, publicJwk: key.publicJwk })).status, 200);
  core.registry.connect(r.vm, () => {}, { ephemeral: true, owner: ELI, actsFor: ELI });
  const until = Date.now() + 1_800_000;
  await core.onHostMessage('deb132', health([own({ machines: [{ name: r.vm, id: r.vm, state: 'Running', until, madeAt: until - 1_800_000, cpus: null, memory: null, image: 'Linux, with the fleet' }] })]));
  const [listed] = core.snapshot(eli).vmMachines;
  assert.deepEqual([listed.name, listed.kind, listed.provider, listed.own, listed.state, listed.until], [r.vm, 'sandbox', 'deb132', true, 'Running', until]);
  // THE BOX COULD NOT LOOK (its Podman did not answer): that says nothing about the machine.
  core.hostDisconnected(r.vm, 'socket closed: 1006');
  const retired = () => core.events.filter((e) => e.event === 'host.retired').map((e) => e.hostId);
  await core.onHostMessage('deb132', health([own({ reachable: false, problem: 'Podman could not list this machine’s containers' })]));
  assert.deepEqual(retired(), []);
  // IT LOOKED, AND THE CONTAINER IS GONE: its time was up, and the box ended it.
  await core.onHostMessage('deb132', health([own()]));
  assert.deepEqual(retired(), [r.vm]);
});
