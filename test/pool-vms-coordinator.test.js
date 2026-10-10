// Machines from the person's own hypervisor, as the coordinator sees them:
// which images a person is offered, which box is asked to make one, the
// ticket it boots with, and the machine enrolling itself and being started
// the session it was asked for with.
//
//   node --test test/pool-vms-coordinator.test.js
//
// ASKED FOR: "Still can't run sessions on it". docs/hypervisors.md,
// "Machines from your pool". The boxes are played by a transport that answers
// from a function, as in xosetup-coordinator.test.js; the box's half has its
// own tests (test/xo-pools.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore, MAX_NET_POINTS } from '../src/fleet/coordinator/core.js';
import { place } from '../src/fleet/coordinator/scheduler.js';
import { generateKeyPair } from '../src/fleet/crypto.js';

const ELI = 'eli@example.com';
const SAM = 'sam@example.com';
const eli = { email: ELI, admin: true };
const sam = { email: SAM, admin: false };
const DEBIAN = '0b1e8c2a-3f4d-4e5a-9b6c-7d8e9f0a1b2c';
const OTHER = '1c2f9d3b-4a5e-4f6b-8c7d-8e9f0a1b2c3d';

/** @param {string} owner @param {string[]} [images] */
const holding = (owner, images = [DEBIAN]) => [{
  address: 'xo.lan',
  owner,
  reachable: true,
  pools: [{ id: 'pool-1', name: 'rack' }],
  images: images.map((id) => ({ id, name: id === DEBIAN ? 'Debian 13' : 'Other', pool: 'pool-1', poolName: 'rack' })),
}];

/**
 * Boxes, each with what it holds, and a transport that records what each was
 * sent and answers from a function.
 * @param {Record<string, { xo?: any[], protocol?: number }>} boxes
 * @param {(hostId: string, spec: any) => any} [reply]
 */
function fleet(boxes, reply = () => ({ ok: true, text: 'Cloning Debian 13 on rack.' })) {
  const core = new CoordinatorCore({});
  for (const [hostId, b] of Object.entries(boxes)) {
    core.registry.connect(hostId, () => {});
    core.registry.recordHealth(hostId, { hub: { reachable: true }, protocol: b.protocol ?? 8, maxSessions: 5, running: 0, free: 5, labels: [], ...(b.xo ? { xo: b.xo } : {}) });
  }
  /** @type {Array<{ hostId: string, spec: any }>} */
  const asked = [];
  core.send = /** @type {any} */ (async (/** @type {any} */ host, /** @type {any} */ spec) => {
    asked.push({ hostId: host.hostId, spec });
    return reply(host.hostId, spec);
  });
  return { core, asked };
}

const ask = (/** @type {any} */ requester, /** @type {Record<string, any>} */ params = {}, /** @type {any} */ startAfter = undefined) => ({
  verb: 'provision',
  params: { platform: 'vm', template: DEBIAN, ...params },
  actor: `fleet:${requester.email}`,
  requester,
  ...(startAfter ? { startAfter } : {}),
});

test('a person is offered the images their own pools have, once each, with the boxes that can make them', () => {
  const { core } = fleet({ deb14: { xo: [...holding(ELI, [DEBIAN, OTHER]), ...holding(SAM)] }, rpi: { xo: holding(ELI) }, plain: {} });
  const mine = core.snapshot(eli).vmImages;
  assert.deepEqual(mine.map((/** @type {any} */ i) => [i.template, i.name, i.poolName, i.hosts]), [
    [DEBIAN, 'Debian 13', 'rack', ['deb14', 'rpi']],
    [OTHER, 'Other', 'rack', ['deb14']],
  ]);
  assert.deepEqual(core.snapshot(sam).vmImages.map((/** @type {any} */ i) => i.hosts), [['deb14']]);
  assert.deepEqual(core.snapshot({ email: 'nobody@example.com', admin: false }).vmImages, []);
  assert.deepEqual(core.snapshot(null).vmImages, [], 'no person, no pool');
});

test('a member sees which pools a box holds only for themselves', () => {
  const { core } = fleet({ deb14: { xo: [...holding(ELI), ...holding(SAM)] } });
  const seen = core.snapshot(sam).hosts.find((/** @type {any} */ h) => h.hostId === 'deb14');
  assert.deepEqual(seen.health.xo.map((/** @type {any} */ e) => e.owner), [SAM]);
});

test('asking for a machine mints a VM ticket and asks a box that holds the pool, never a runner repository', async () => {
  const { core, asked } = fleet({ deb14: { xo: holding(ELI) }, other: {} });
  const r = await core.dispatch(ask(eli, { minutes: 30, repo: 'mallory/evil' }));
  assert.equal(r.ok, true, r.text);
  assert.equal(r.hostId, 'deb14');
  assert.match(r.vm, /^vm-[0-9a-f]{12}$/);
  assert.equal(asked.length, 1);
  const sent = asked[0].spec.params;
  assert.equal(sent.platform, 'vm');
  assert.equal(sent.template, DEBIAN);
  assert.equal(sent.minutes, 30);
  assert.match(sent.ticket, /^fwt_[0-9a-f]{12}_[0-9a-f]{48}$/);
  assert.equal(sent.repo, undefined, 'a caller’s repo goes nowhere');
  assert.equal(r.vm, `vm-${sent.ticket.split('_')[1]}`, 'the name is the ticket’s');
});

test('nobody holding the pool, an unsigned caller or no image is a refusal that says what to do', async () => {
  const { core, asked } = fleet({ deb14: { xo: holding(SAM) } });
  const none = await core.dispatch(ask(eli));
  assert.equal(none.error.code, 'no_hosts');
  assert.match(none.text, /Keep the pool in your vault/);
  const anon = await core.dispatch({ verb: 'provision', params: { platform: 'vm', template: DEBIAN } });
  assert.equal(anon.error.code, 'not_signed_in');
  const noImage = await core.dispatch({ ...ask(sam), params: { platform: 'vm' } });
  assert.equal(noImage.error.code, 'bad_params');
  assert.equal(asked.length, 0);
});

test('a box that cannot reach the pool hands on to the next, and one too old is not asked', async () => {
  const { core, asked } = fleet(
    { a: { xo: holding(ELI) }, b: { xo: holding(ELI), protocol: 7 }, c: { xo: holding(ELI) } },
    (hostId) => (hostId === 'a' ? { ok: false, unreachable: true, text: 'xo.lan did not answer' } : { ok: true, text: 'Cloning.' }),
  );
  const r = await core.dispatch(ask(eli));
  assert.equal(r.ok, true);
  assert.equal(r.hostId, 'c');
  assert.deepEqual(asked.map((x) => x.hostId), ['a', 'c']);
});

test('a refusal from the pool itself is the answer, not a reason to try another box', async () => {
  const { core, asked } = fleet({ a: { xo: holding(ELI) }, c: { xo: holding(ELI) } }, () => ({ ok: false, text: 'The pool’s limits have no room for another machine.' }));
  const r = await core.dispatch(ask(eli));
  assert.equal(r.ok, false);
  assert.equal(r.vm, null);
  assert.deepEqual(asked.map((x) => x.hostId), ['a']);
});

test('the machine enrols with its ticket once, as its owner’s temporary host, and is started the session asked for', async () => {
  const { core, asked } = fleet({ deb14: { xo: holding(ELI) } });
  const r = await core.dispatch(ask(eli, {}, { title: 'Try the build', task: 'Run the tests' }));
  const ticket = asked[0].spec.params.ticket;
  const key = await generateKeyPair();

  // NOT A RUNNER'S: a GitHub job cannot spend it, and a runner's cannot enrol a VM.
  assert.equal(CoordinatorCore.ticketFitsJob(await core.runnerTickets.peek(ticket), { repository: 'eli/runners' }), false);
  const runnerTicket = await core.runnerTickets.mint({ owner: ELI, platform: 'linux', repository: 'eli/runners' });
  assert.equal((await core.enrolVm({ ticket: runnerTicket.token, publicJwk: key.publicJwk })).status, 403);

  const enrolled = await core.enrolVm({ ticket, publicJwk: key.publicJwk });
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
  assert.equal(enrolled.body.hostId, r.vm);
  assert.equal(enrolled.body.ephemeral, true);
  const host = core.hostIds.get(r.vm);
  assert.equal(host.owner, ELI);
  assert.equal(host.ephemeral, true);
  assert.equal((await core.enrolVm({ ticket, publicJwk: key.publicJwk })).status, 403, 'single use');

  // ITS FIRST FRAME, before it can take work: the start is held, not lost.
  core.registry.connect(r.vm, () => {}, { ephemeral: true, owner: ELI });
  asked.length = 0;
  await core.onHostMessage(r.vm, { kind: 'health', health: { hub: { reachable: true }, protocol: 8, maxSessions: 1, running: 0, free: 1, claudeAccounts: 0, runnerAuth: null, labels: [] } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(asked.length, 0, 'nothing placed on a machine that cannot take it yet');
  assert.ok(core.runnerStarts.has(r.vm), 'still held for the next frame');

  // READY: started as its owner, by name.
  await core.onHostMessage(r.vm, { kind: 'health', health: { hub: { reachable: true }, protocol: 8, maxSessions: 1, running: 0, free: 1, claudeAccounts: 0, runnerAuth: 'owner', labels: [] } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const start = asked.find((x) => x.spec.verb === 'start');
  assert.ok(start, 'the held session was started');
  assert.equal(start.hostId, r.vm);
  assert.equal(start.spec.params.task, 'Run the tests');
  assert.equal(start.spec.actor, ELI);
  assert.ok(!core.runnerStarts.has(r.vm));
});

test('naming somebody else’s temporary machine does not put work on it', () => {
  const { core } = fleet({});
  core.registry.connect('vm-aaaaaaaaaaaa', () => {}, { ephemeral: true, owner: ELI });
  core.registry.recordHealth('vm-aaaaaaaaaaaa', { hub: { reachable: true }, protocol: 8, maxSessions: 1, running: 0, free: 1, claudeAccounts: 1, labels: [] });
  const theirs = place(core.registry, { verb: 'start', params: {} }, { preferHost: 'vm-aaaaaaaaaaaa', requester: sam });
  assert.equal(theirs.kind, 'refused');
  assert.equal(/** @type {any} */ (theirs).code, 'host_unavailable');
  const mine = place(core.registry, { verb: 'start', params: {} }, { preferHost: 'vm-aaaaaaaaaaaa', requester: eli });
  assert.equal(mine.kind, 'host');
});

test('a phone cannot be handed a GitHub dispatch for a VM', async () => {
  const { core } = fleet({});
  core.runnerRepo = 'eli/runners';
  const r = await core.prepareRunnerDispatch(eli, { platform: 'vm' }, 'https://fleet.test');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'bad_params');
});

// --- working a machine (protocol 9) -------------------------------------------

const NET = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a';
/** A pool entry that also lists a network and a machine on it. @param {string} owner */
const withMachine = (owner) => [{
  ...holding(owner)[0],
  networks: [{ id: NET, name: 'LAN', pool: 'pool-1' }],
  machines: [{ name: 'vm-aaaaaaaaaaaa', vm: '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b', state: 'Running', ip: '10.254.0.120', until: 1_800_000_000_000, madeAt: 1_799_990_000_000, cpus: 2, memory: 4 * 1024 ** 3, image: 'Fleetwright Debian 13', network: 'fleetwright-uplink' }],
}];

test('a person sees their machines and the networks a new one can go on, and nobody else’s', () => {
  const { core } = fleet({ deb14: { xo: [...withMachine(ELI), ...holding(SAM)], protocol: 9 } });
  const mine = core.snapshot(eli);
  assert.deepEqual(mine.vmMachines.map((/** @type {any} */ m) => [m.name, m.ip, m.state, m.address]), [['vm-aaaaaaaaaaaa', '10.254.0.120', 'Running', 'xo.lan']]);
  assert.deepEqual(mine.vmImages[0].networks, [{ id: NET, name: 'LAN' }]);
  assert.deepEqual(core.snapshot(sam).vmMachines, []);
  assert.equal(mine.vmMachines[0].until, 1_800_000_000_000);
});

test('a machine that did not report its end or size is cannot tell, not the epoch or nothing', () => {
  const [entry] = withMachine(ELI);
  const quiet = [{ ...entry, machines: [{ name: 'vm-aaaaaaaaaaaa', vm: null, state: null, ip: null, until: null, madeAt: null, cpus: null, memory: null, image: null, network: null }] }];
  const { core } = fleet({ deb14: { xo: quiet, protocol: 9 } });
  const [m] = core.snapshot(eli).vmMachines;
  assert.deepEqual([m.until, m.madeAt, m.memory, m.cpus, m.state], [null, null, null, null, null]);
  assert.equal(m.net, null, 'a machine the box sent no traffic for has none, not a flat line');
});

test('a machine’s traffic is passed on as the box counted it, gaps kept, and a malformed or oversized one is none', () => {
  const [entry] = withMachine(ELI);
  /** @param {any} net */
  const seen = (net) => {
    const { core } = fleet({ deb14: { xo: [{ ...entry, machines: [{ ...entry.machines[0], net }] }], protocol: 9 } });
    return core.snapshot(eli).vmMachines[0].net;
  };
  const end = 1_799_999_940_000;
  assert.deepEqual(seen({ interval: 60, end, rx: [1200.4, null, 9000], tx: [10, 'x', 20.6] }),
    { interval: 60, end, rx: [1200, null, 9000], tx: [10, null, 21] }, 'a point the pool did not count stays a gap, not a 0');
  const long = Array.from({ length: MAX_NET_POINTS + 1 }, () => 1);
  for (const bad of [
    { interval: 60, end, rx: long, tx: long },
    { interval: 60, end, rx: [1, 2], tx: [1] },
    { interval: 0, end, rx: [1], tx: [1] },
    { interval: 60, rx: [1], tx: [1] },
    { interval: 60, end, rx: 'lots', tx: [1] },
  ]) assert.equal(seen(bad), null, JSON.stringify(bad).slice(0, 60));
});

test('a machine can go on a network the person chose, and a box too old to carry that is not asked', async () => {
  const { core, asked } = fleet({ old: { xo: holding(ELI), protocol: 8 }, deb14: { xo: holding(ELI), protocol: 9 } });
  const r = await core.dispatch(ask(eli, { network: NET }));
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(asked.map((x) => x.hostId), ['deb14']);
  assert.equal(asked[0].spec.params.network, NET);
});

test('a machine is worked by its owner, through the box that last saw it first', async () => {
  const { core, asked } = fleet(
    { a: { xo: holding(ELI), protocol: 9 }, b: { xo: withMachine(ELI), protocol: 9 } },
    () => ({ ok: true, text: 'Restarting vm-aaaaaaaaaaaa.' }),
  );
  const r = await core.dispatch({ verb: 'vmctl', params: { name: 'vm-aaaaaaaaaaaa', action: 'reboot' }, actor: `fleet:${ELI}`, requester: eli });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(asked.map((x) => x.hostId), ['b'], 'the box that saw it, first');
  assert.equal(asked[0].spec.params.action, 'reboot');

  // Not found on one box's pools moves on; the pool's own refusal does not.
  const moved = fleet(
    { a: { xo: holding(ELI), protocol: 9 }, b: { xo: holding(ELI), protocol: 9 } },
    (hostId) => (hostId === 'a' ? { ok: false, notHere: true, text: 'not on these pools' } : { ok: true, text: 'Stopped.' }),
  );
  assert.equal((await moved.core.dispatch({ verb: 'vmctl', params: { name: 'vm-aaaaaaaaaaaa', action: 'stop' }, requester: eli })).ok, true);
  assert.deepEqual(moved.asked.map((x) => x.hostId), ['a', 'b']);
});

test('somebody else’s machine, an unsigned caller, or an action without its numbers is refused before any box is asked', async () => {
  const { core, asked } = fleet({ b: { xo: withMachine(ELI), protocol: 9 } });
  const key = await generateKeyPair();
  await core.hostIds.enrol({ hostId: 'vm-aaaaaaaaaaaa', publicJwk: key.publicJwk, owner: ELI, ephemeral: true });
  assert.equal((await core.dispatch({ verb: 'vmctl', params: { name: 'vm-aaaaaaaaaaaa', action: 'stop' }, requester: sam })).error.code, 'not_yours');
  assert.equal((await core.dispatch({ verb: 'vmctl', params: { name: 'vm-aaaaaaaaaaaa', action: 'stop' } })).error.code, 'not_signed_in');
  assert.equal((await core.dispatch({ verb: 'vmctl', params: { name: 'vm-aaaaaaaaaaaa', action: 'extend' }, requester: eli })).error.code, 'bad_params');
  assert.equal((await core.dispatch({ verb: 'vmctl', params: { name: 'vm-aaaaaaaaaaaa', action: 'resize' }, requester: eli })).error.code, 'bad_params');
  assert.equal(asked.length, 0);
});

// --- machines kept ready ------------------------------------------------------
//
// Asked for: "standby vms to speed up session starts". docs/hypervisors.md,
// "Machines kept ready".

/** A kept machine joining the fleet and saying it can take work. @param {any} core @param {string} vm */
async function joinReady(core, vm, /** @type {string} */ ticket) {
  const key = await generateKeyPair();
  const enrolled = await core.enrolVm({ ticket, publicJwk: key.publicJwk });
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
  core.registry.connect(vm, () => {}, { ephemeral: true, owner: ELI });
  core.registry.recordHealth(vm, { hub: { reachable: true }, protocol: 9, maxSessions: 1, running: 0, free: 1, claudeAccounts: 0, runnerAuth: 'owner', labels: [] });
}

/**
 * Until `done()` holds. A top-up or an ending runs behind the call that set
 * it going and finishes when it finishes, so a test waits for what it does,
 * never for a fixed time: ten milliseconds was enough alone and not enough
 * with the whole suite running beside it.
 *
 * @param {() => boolean} done @param {string} what
 */
async function until(done, what) {
  for (let i = 0; i < 1000 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(done(), `waited two seconds for ${what}`);
}
/**
 * Until the box has been asked for a kept machine. It counts as being made
 * from its ticket, before the box is asked, so the ask is waited for too.
 * @param {any} core @param {any[]} asked
 */
const madeOne = (core, asked) =>
  until(() => core.vmStandby.machines.size > 0 && asked.some((x) => x.spec.verb === 'provision'), 'a kept machine to be asked for');

test('keeping a machine ready makes one with its whole life and no session, for its owner, and says so', async () => {
  const { core, asked } = fleet({ deb14: { xo: holding(ELI), protocol: 9 } });
  const set = await core.setVmStandby(eli, { template: DEBIAN, count: 1 });
  assert.equal(set.ok, true, set.text);
  await madeOne(core, asked);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].spec.verb, 'provision');
  assert.equal(asked[0].spec.params.minutes, 350, 'the longest a machine lives, so it is ready for longer');
  assert.equal(asked[0].spec.actor, ELI, 'made for its owner: the box makes it for the actor');
  const { since, ...counts } = core.snapshot(eli).vmStandby;
  assert.deepEqual(counts, { template: DEBIAN, count: 1, network: null, ready: 0, starting: 1 });
  assert.ok(Math.abs(Date.now() - since) < 5_000, 'when the one being made was asked for');
  assert.equal(core.snapshot(sam).vmStandby, null, 'only their own');
  // One being made counts: no second one is asked for.
  await core.topUpStandby();
  assert.equal(asked.length, 1);
});

test('two top-ups at once ask for one machine, not one each', async () => {
  // A real pool was asked for two machines for one kept ready: the second
  // top-up, set off by a health frame, ran before the box had answered the
  // first, and a machine counted only from that answer.
  const { core, asked } = fleet({ deb14: { xo: holding(ELI), protocol: 9 } });
  await Promise.all([core.setVmStandby(eli, { template: DEBIAN, count: 1 }), core.topUpStandby(), core.topUpStandby()]);
  await madeOne(core, asked);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(asked.filter((x) => x.spec.verb === 'provision').length, 1);
  assert.equal(core.vmStandby.machines.size, 1);
});

test('a session takes the ready machine at once, as its owner, and another is made behind it', async () => {
  const { core, asked } = fleet({ deb14: { xo: holding(ELI), protocol: 9 } });
  await core.setVmStandby(eli, { template: DEBIAN, count: 1 });
  await madeOne(core, asked);
  const ticket = asked[0].spec.params.ticket;
  const kept = `vm-${ticket.split('_')[1]}`;
  await joinReady(core, kept, ticket);
  assert.equal(core.snapshot(eli).vmStandby.ready, 1);
  assert.equal(core.snapshot(eli).vmMachines.length, 0, 'the pool had not reported it yet');

  asked.length = 0;
  const r = await core.dispatch(ask(eli, {}, { title: 'Try the build', task: 'Run the tests' }));
  await until(() => asked.some((x) => x.spec.verb === 'provision'), 'another to be made behind it');
  assert.equal(r.standby, true);
  assert.equal(r.vm, kept);
  const start = asked.find((x) => x.spec.verb === 'start');
  assert.ok(start, 'started on the kept machine');
  assert.equal(start.hostId, kept);
  assert.equal(start.spec.params.task, 'Run the tests');
  assert.equal(start.spec.actor, ELI);
  const remade = asked.filter((x) => x.spec.verb === 'provision');
  assert.equal(remade.length, 1, 'another is made to keep one ready');
  assert.notEqual(`vm-${remade[0].spec.params.ticket.split('_')[1]}`, kept);

  // TAKEN IS NEVER GIVEN BACK: the next session does not get it again.
  assert.equal(core.vmStandby.isKept(kept), false);
});

test('a machine is taken only for the image and network it was kept for, with the time asked still on it', async () => {
  const NET = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a';
  const { core, asked } = fleet({ deb14: { xo: [{ ...holding(ELI, [DEBIAN, OTHER])[0], networks: [{ id: NET, name: 'LAN', pool: 'pool-1' }] }], protocol: 9 } });
  await core.setVmStandby(eli, { template: DEBIAN, count: 1 });
  await madeOne(core, asked);
  const ticket = asked[0].spec.params.ticket;
  const kept = `vm-${ticket.split('_')[1]}`;
  await joinReady(core, kept, ticket);

  for (const params of [{ template: OTHER }, { network: NET }]) {
    asked.length = 0;
    const r = await core.dispatch(ask(eli, params));
    assert.notEqual(r.vm, kept, JSON.stringify(params));
    assert.ok(core.vmStandby.isKept(kept));
  }

  // NEAR ITS END, by the pool's last look: a fresh one rather than a session cut short.
  const s = Date.now();
  core.registry.recordHealth('deb14', { hub: { reachable: true }, protocol: 9, maxSessions: 5, running: 0, free: 5, labels: [], xo: [{ ...holding(ELI)[0], machines: [{ name: kept, until: s + 20 * 60_000, state: 'Running' }] }] });
  asked.length = 0;
  const r = await core.dispatch(ask(eli, { minutes: 60 }));
  assert.notEqual(r.vm, kept);
  assert.ok(core.vmStandby.isKept(kept), 'still kept, for a session that asks for less');
});

test('keeping fewer ends the machines no longer wanted, and what may be kept is bounded and checked', async () => {
  const { core, asked } = fleet({ deb14: { xo: holding(ELI), protocol: 9 } });
  await core.setVmStandby(eli, { template: DEBIAN, count: 1 });
  await madeOne(core, asked);
  const kept = `vm-${asked[0].spec.params.ticket.split('_')[1]}`;
  asked.length = 0;
  const stop = await core.setVmStandby(eli, { count: 0 });
  assert.equal(stop.ok, true);
  await until(() => asked.some((x) => x.spec.verb === 'vmctl'), 'the kept machine to be ended');
  const ended = asked.find((x) => x.spec.verb === 'vmctl');
  assert.ok(ended, 'the kept machine is ended');
  assert.deepEqual(ended.spec.params, { name: kept, action: 'stop' });
  assert.equal(core.snapshot(eli).vmStandby, null);

  assert.equal((await core.setVmStandby(eli, { template: DEBIAN, count: 4 })).error.code, 'bad_params');
  assert.equal((await core.setVmStandby(eli, { template: OTHER, count: 1 })).error.code, 'no_hosts', 'an image no box offers now');
  assert.equal((await core.setVmStandby(eli, { template: DEBIAN, count: 1, network: 'nope' })).error.code, 'bad_params');
  assert.equal((await core.setVmStandby(null, { template: DEBIAN, count: 1 })).error.code, 'not_signed_in');
});

test('what is kept ready survives a restart, and a machine that never joined is forgotten in time', async () => {
  const { core, asked } = fleet({ deb14: { xo: holding(ELI), protocol: 9 } });
  await core.setVmStandby(eli, { template: DEBIAN, count: 2 });
  await madeOne(core, asked);
  const saved = JSON.parse(JSON.stringify(core.serialiseStandby()));
  const again = new CoordinatorCore({ now: () => Date.now() + 16 * 60_000 });
  again.restoreStandby(saved);
  assert.deepEqual(again.vmStandby.wishFor(ELI), { template: DEBIAN, count: 2, network: null });
  assert.equal(again.vmStandby.machines.size, asked.length);
  assert.deepEqual(again.vmStandby.tally(ELI, () => true), { ready: 0, starting: 0 }, 'asked for sixteen minutes ago and never enrolled');
  // AND SAYS SO, where "0 being made" used to be the whole of it.
  const shown = again.vmStandbyFor(eli);
  assert.equal(shown.since, undefined, 'none is being made now');
  assert.match(shown.failed.text, /^vm-[0-9a-f]+ did not join the fleet within 15 minutes of being asked for/);
  // Which a machine that does join answers.
  const later = JSON.parse(JSON.stringify(again.serialiseStandby()));
  const third = new CoordinatorCore({ now: () => Date.now() + 16 * 60_000 });
  third.restoreStandby(later);
  assert.ok(third.vmStandby.failureFor(ELI), 'kept across a restart');
  third.vmStandby.noteMade('vm-0000000000aa', { owner: ELI, template: DEBIAN, network: null });
  third.vmStandby.noteEnrolled('vm-0000000000aa');
  assert.equal(third.vmStandby.failureFor(ELI), null);
});

// --- machines that work together (protocol 10) --------------------------------
//
// Asked for: "testing HA ... the 3 VMs need to reach each other ... a default
// of isolate from each other and only allow outbound". docs/hypervisors.md,
// "Machines that work together".

const GROUP = '3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d';

test('a group network is offered apart from the networks a machine goes on, and a group is passed to a box that speaks 10', async () => {
  const LAN = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a';
  const xo = [{ ...holding(ELI)[0], networks: [{ id: LAN, name: 'LAN', pool: 'pool-1' }, { id: GROUP, name: 'fleetwright-group-1', pool: 'pool-1', group: true }] }];
  const { core, asked } = fleet({ old: { xo, protocol: 9 }, deb14: { xo, protocol: 10 } });
  const [image] = core.snapshot(eli).vmImages;
  assert.deepEqual(image.networks, [{ id: LAN, name: 'LAN' }]);
  assert.deepEqual(image.groups, [{ id: GROUP, name: 'fleetwright-group-1' }]);

  const r = await core.dispatch(ask(eli, { group: GROUP }));
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(asked.map((x) => x.hostId), ['deb14'], 'a box that speaks 9 would drop the group, so it is not asked');
  assert.equal(asked[0].spec.params.group, GROUP);
});

test('a machine asked for in a group is never one kept ready, which has no group network', async () => {
  const xo = [{ ...holding(ELI)[0], networks: [{ id: GROUP, name: 'fleetwright-group-1', pool: 'pool-1', group: true }] }];
  const { core, asked } = fleet({ deb14: { xo, protocol: 10 } });
  await core.setVmStandby(eli, { template: DEBIAN, count: 1 });
  await madeOne(core, asked);
  const ticket = asked[0].spec.params.ticket;
  const kept = `vm-${ticket.split('_')[1]}`;
  await joinReady(core, kept, ticket);
  const r = await core.dispatch(ask(eli, { group: GROUP }));
  assert.notEqual(r.vm, kept);
  assert.ok(core.vmStandby.isKept(kept));
});

test('a machine in a group says which group and its address there, and an address outside the group range is not passed on', () => {
  const [entry] = withMachine(ELI);
  const machine = { ...entry.machines[0], group: 'fleetwright-group-1', groupIp: '10.200.3.17' };
  const odd = { ...entry.machines[0], name: 'vm-bbbbbbbbbbbb', group: 'fleetwright-group-1', groupIp: '192.168.1.5' };
  const { core } = fleet({ deb14: { xo: [{ ...entry, machines: [machine, odd] }], protocol: 10 } });
  const seen = core.snapshot(eli).vmMachines.map((/** @type {any} */ m) => [m.name, m.group, m.groupIp]);
  assert.deepEqual(seen, [
    ['vm-aaaaaaaaaaaa', 'fleetwright-group-1', '10.200.3.17'],
    ['vm-bbbbbbbbbbbb', 'fleetwright-group-1', null],
  ]);
});

// --- labs ---------------------------------------------------------------------
//
// A lab is one of the pool's lab networks on its edge router, with one
// machine on it alone: open (the internet) or closed (only the fleet and
// Claude). docs/hypervisors.md, "Labs". The box's half, which takes the
// network and keeps the machine alone on it, is in test/xo-pools.test.js.

const LAB1 = '4b5c6d7e-8f9a-4b1c-8d2e-3f4a5b6c7d8e';
const LAB2 = '5c6d7e8f-9a0b-4c2d-9e3f-4a5b6c7d8e9f';
const LAB3 = '6d7e8f9a-0b1c-4d3e-8f4a-5b6c7d8e9f0a';

/** A pool with three labs, as a box that knows labs reports them: open, closed, and one nobody could say was empty. */
const withLabs = (/** @type {string} */ owner) => [{
  ...holding(owner)[0],
  networks: [
    { id: LAB1, name: 'fleetwright-lab-1', pool: 'pool-1', lab: 'open', taken: false },
    { id: LAB2, name: 'fleetwright-lab-2', pool: 'pool-1', lab: 'closed', taken: false },
    { id: LAB3, name: 'fleetwright-lab-3', pool: 'pool-1', lab: 'open', taken: null },
  ],
  machines: [],
}];
const inLab = (/** @type {any} */ requester, /** @type {Record<string, any>} */ p) => ({ ...ask(requester), params: { platform: 'lab', template: DEBIAN, ...p } });

test('a pool’s labs are offered under each image, open or closed, free only when the box said so, and never as ordinary networks', () => {
  // An old box lists a lab network as it lists any network, with no kind.
  const old = [{ ...holding(ELI)[0], networks: [{ id: LAB1, name: 'fleetwright-lab-1', pool: 'pool-1' }] }];
  const { core } = fleet({ deb14: { xo: withLabs(ELI), protocol: 10 } });
  const [image] = core.snapshot(eli).vmImages;
  assert.deepEqual(image.labs, [
    { id: LAB1, name: 'fleetwright-lab-1', open: true, free: true },
    { id: LAB2, name: 'fleetwright-lab-2', open: false, free: true },
    { id: LAB3, name: 'fleetwright-lab-3', open: true, free: false },
  ]);
  assert.deepEqual(image.networks, [], 'a lab network is offered as a network a machine can go on');
  const older = fleet({ older: { xo: old, protocol: 10 } }).core.snapshot(eli).vmImages[0];
  assert.deepEqual([older.labs, older.networks], [[], []], 'a box from before labs offers its lab network as a lab or as a network');
});

test('a machine in a lab is asked of a box that saw the lab, on that network and alone, and the lab is held until the box sees it there', async () => {
  const { core, asked } = fleet({ blind: { xo: holding(ELI), protocol: 10 }, deb14: { xo: withLabs(ELI), protocol: 10 } });
  const r = await core.dispatch(inLab(eli, { network: LAB2, minutes: 45 }));
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(asked.map((x) => x.hostId), ['deb14'], 'a box that did not report the lab was asked for it');
  const sent = asked[0].spec.params;
  assert.deepEqual([sent.platform, sent.template, sent.network, sent.minutes, sent.group], ['lab', DEBIAN, LAB2, 45, undefined]);
  assert.match(sent.ticket, /^fwt_[0-9a-f]{12}_[0-9a-f]{48}$/);
  // NOT FREE NOW, though the box has not looked again: a second ask for the
  // same lab would put two people's machines on one network.
  assert.equal(core.snapshot(eli).vmImages[0].labs.find((/** @type {any} */ l) => l.id === LAB2).free, false);
  const again = await core.dispatch(inLab(eli, { network: LAB2 }));
  assert.equal(again.error.code, 'lab_taken');
  assert.equal(asked.length, 1);
});

test('a lab is refused when it is not named, not a lab, joined to a group, or not known to be free', async () => {
  const { core, asked } = fleet({ deb14: { xo: withLabs(ELI), protocol: 10 } });
  assert.equal((await core.dispatch(inLab(eli, {}))).error.code, 'bad_params', 'no lab named');
  assert.equal((await core.dispatch(inLab(eli, { network: NET }))).error.code, 'bad_params', 'not a lab');
  assert.equal((await core.dispatch(inLab(eli, { network: LAB1, group: GROUP }))).error.code, 'bad_params', 'a lab machine joined a group');
  assert.equal((await core.dispatch(inLab(eli, { network: LAB3 }))).error.code, 'lab_taken', 'a lab the box could not say was empty was handed out');
  assert.equal(asked.length, 0);
});

// LABS PER PERSON is the admin's, in the pool's policy, which the box reports
// on each lab network (`perPerson`). None set is no limit: an older policy or
// an older box says nothing, and nothing is never read as 0.
const seenIn = (/** @type {number|undefined} */ perPerson) => [{
  ...withLabs(ELI)[0],
  networks: withLabs(ELI)[0].networks.map((n) => (perPerson === undefined ? n : { ...n, perPerson })),
  machines: [{ name: 'vm-aaaaaaaaaaaa', state: 'Running', lab: { name: 'fleetwright-lab-3', open: true } }],
}];

test('labs per person: no limit unless the policy sets one, and past one that is set, a refusal that names it', async () => {
  // One held and two asked for: with no limit, each is asked of the box.
  const free = fleet({ deb14: { xo: seenIn(undefined), protocol: 10 } });
  assert.equal((await free.core.dispatch(inLab(eli, { network: LAB1 }))).ok, true);
  assert.equal((await free.core.dispatch(inLab(eli, { network: LAB2 }))).ok, true, 'a policy that sets no limit held a person to two');
  assert.equal(free.asked.length, 2);

  // Limited to two: one held and one asked for is two, and the third is refused.
  const capped = fleet({ deb14: { xo: seenIn(2), protocol: 10 } });
  assert.equal((await capped.core.dispatch(inLab(eli, { network: LAB1 }))).ok, true);
  const third = await capped.core.dispatch(inLab(eli, { network: LAB2 }));
  assert.equal(third.error.code, 'too_many_labs');
  assert.match(third.text, /lets one person hold 2 labs at once, and you hold 2\./);
  assert.equal(capped.asked.length, 1);
});

test('a machine says which lab it is in and whether it is open, and anything else is no lab', () => {
  const [entry] = withMachine(ELI);
  const machines = [
    { ...entry.machines[0], lab: { name: 'fleetwright-lab-2', open: false } },
    { ...entry.machines[0], name: 'vm-bbbbbbbbbbbb', lab: { name: 'my-network', open: true } },
    { ...entry.machines[0], name: 'vm-cccccccccccc' },
  ];
  const { core } = fleet({ deb14: { xo: [{ ...entry, machines }], protocol: 10 } });
  assert.deepEqual(core.snapshot(eli).vmMachines.map((/** @type {any} */ m) => [m.name, m.lab]), [
    ['vm-aaaaaaaaaaaa', { name: 'fleetwright-lab-2', open: false }],
    ['vm-bbbbbbbbbbbb', null],
    ['vm-cccccccccccc', null],
  ]);
});
