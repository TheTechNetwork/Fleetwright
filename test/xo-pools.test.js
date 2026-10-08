// A box making machines on its people's pools: what it keeps of the vault's
// answer and where, what it reports, what it sweeps, and the machine it asks
// Xen Orchestra for.
//
//   node --test test/xo-pools.test.js
//
// Xen Orchestra is played by a stand-in that records every call and answers
// from a table of objects, as test/edge-router.test.js does. ASKED FOR:
// "Still can't run sessions on it". docs/hypervisors.md, "Machines from your
// pool".

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { XoPools, poolRecord, machineCloudConfig, groupPlace, trafficFrom, NET_POINTS } from '../src/fleet/host/xo-pools.js';
import { VM_IMAGE, CONFIG_DRIVE_NAME, buildCloudConfig, ensureImage, removeImage, imageStorage, DEBIAN_IMAGE } from '../src/fleet/host/vm-image.js';
import { enrolVmOnce, vmLogin, forgetJoin } from '../src/fleet/host/vm-join.js';
import { readAssignedName } from '../src/fleet/host/identity.js';
import { generateKeyPair } from '../src/fleet/crypto.js';

const ELI = 'eli@example.com';
const PIN = 'a'.repeat(64);
const IMAGE = '0b1e8c2a-3f4d-4e5a-9b6c-7d8e9f0a1b2c';
const TICKET = `fwt_${'1'.repeat(12)}_${'2'.repeat(48)}`;
const CLAUDE = `sk-ant-oat01-${'c'.repeat(40)}`;

/** @param {Record<string, any>} [extra] */
const record = (extra = {}) => JSON.stringify({ v: 1, address: 'xo.lan', pin: PIN, token: 'xo-limited-token', resourceSet: 'set-1', ...extra });

/**
 * A Xen Orchestra stand-in: objects by type, every call recorded.
 * @param {{ objects?: any[], fail?: Record<string, string>, stats?: Record<string, any> }} [opts]
 */
function xo({ objects = [], fail = {}, stats = {} } = {}) {
  /** @type {Array<{ method: string, params: any }>} */
  const calls = [];
  const rpc = {
    closed: false,
    async call(/** @type {string} */ method, /** @type {any} */ params = {}) {
      calls.push({ method, params });
      if (fail[method]) throw new Error(fail[method]);
      // `vm.restart:clean` refuses only the clean one, as a machine without
      // its guest agent does.
      if (params?.force === false && fail[`${method}:clean`]) throw new Error(fail[`${method}:clean`]);
      if (method === 'session.signIn') return { id: 'u1', permission: 'none' };
      if (method === 'xo.getAllObjects') {
        const f = params.filter || {};
        return Object.fromEntries(objects.filter((o) => Object.entries(f).every(([k, v]) => o[k] === v)).map((o) => [o.id, o]));
      }
      if (method === 'vm.create') return 'new-vm-id';
      if (method === 'vm.stats') return stats[params.id] ?? true;
      return true;
    },
    close() {
      rpc.closed = true;
    },
  };
  return { rpc, calls };
}

const pool = { type: 'pool', id: 'pool-1', name_label: 'rack' };
const image = { type: 'VM-template', id: IMAGE, name_label: 'Fleetwright Debian 13', $pool: 'pool-1', tags: [VM_IMAGE.tag] };
const stranger = { type: 'VM-template', id: 'other-template', name_label: 'Windows', $pool: 'pool-1', tags: [] };
const uplink = { type: 'network', id: 'net-uplink', name_label: 'fleetwright-uplink', $pool: 'pool-1' };

/** @param {ReturnType<typeof xo>} stand */
const holder = (stand, now = () => Date.now()) =>
  new XoPools({ connect: /** @type {any} */ (async () => stand.rpc), connectPlain: /** @type {any} */ (async () => stand.rpc), now });

test('a pool’s token is taken out of the vault’s answer before the hub sees it, and only a good record is kept', () => {
  const pools = holder(xo());
  const given = pools.adopt([
    {
      email: 'Eli@Example.com',
      items: [
        { name: 'secret:NPM', value: 'npm_abc' },
        { name: 'claude', value: CLAUDE },
        { name: 'hypervisor:xo.lan', value: record() },
        { name: 'hypervisor:other.lan', value: record() },
        { name: 'hypervisor:nopin.lan', value: record({ address: 'nopin.lan', pin: null }) },
      ],
    },
  ]);
  assert.deepEqual(given[0].items.map((/** @type {any} */ i) => i.name), ['secret:NPM', 'claude'], 'the hub is given everything but pools');
  assert.deepEqual([...pools.held.keys()], [`${ELI} xo.lan`], 'filed under another address, or pinned to nothing, is not a pool');
  assert.equal(pools.claude.get(ELI), CLAUDE);
  // Plain HTTP only with the person's acceptance recorded at setup.
  assert.ok(poolRecord('hypervisor:plain.lan', record({ address: 'plain.lan', pin: null, plain: true })));
  pools.adopt([]);
  assert.equal(pools.held.size, 0, 'forgotten when the vault stops handing it');
});

test('a look reports the pool’s machine images, and sweeps machines that are done', async () => {
  const now = Date.now();
  const stand = xo({
    objects: [
      pool, image, stranger,
      { type: 'VM', id: 'done', name_label: 'vm-done', power_state: 'Halted', tags: [VM_IMAGE.sessionTag] },
      { type: 'VM', id: 'overdue', name_label: 'vm-overdue', power_state: 'Running', tags: [VM_IMAGE.sessionTag, `${VM_IMAGE.untilPrefix}${Math.floor((now - 20 * 60_000) / 1000)}`] },
      { type: 'VM', id: 'live', name_label: 'vm-live', power_state: 'Running', tags: [VM_IMAGE.sessionTag, `${VM_IMAGE.untilPrefix}${Math.floor((now + 60_000) / 1000)}`] },
      { type: 'VM', id: 'theirs', name_label: 'somebody’s VM', power_state: 'Halted', tags: [] },
    ],
  });
  const pools = holder(stand, () => now);
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  assert.deepEqual(pools.report(), [{ address: 'xo.lan', owner: ELI, reachable: null, pools: [], images: [], networks: [], machines: [] }], 'not looked at yet is cannot tell');
  await pools.refresh();
  const [seen] = pools.report();
  assert.equal(seen.reachable, true);
  assert.deepEqual(seen.images, [{ id: IMAGE, name: 'Fleetwright Debian 13', pool: 'pool-1', poolName: 'rack' }]);
  assert.equal(stand.calls[0].params.token, 'xo-limited-token', 'signed in with the limited token');
  const deleted = stand.calls.filter((c) => c.method === 'vm.delete').map((c) => c.params.id);
  assert.deepEqual(deleted.sort(), ['done', 'overdue'], 'stopped, or well past its end; never another VM');
  assert.ok(stand.calls.some((c) => c.method === 'vm.stop' && c.params.id === 'overdue'));
  assert.ok(stand.rpc.closed);
});

test('a pool that cannot be reached is reported so, and asking it for a machine says so for the next box', async () => {
  const pools = new XoPools({ connect: /** @type {any} */ (async () => { throw new Error('connect ECONNREFUSED'); }) });
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  await pools.refresh();
  assert.equal(pools.report()[0].reachable, false);
  // Seen once with the image, then unreachable: the refusal is `unreachable`.
  pools.seen.set(`${ELI} xo.lan`, { address: 'xo.lan', owner: ELI, reachable: true, pools: [], images: [{ id: IMAGE, name: 'Debian', pool: 'pool-1', poolName: 'rack' }] });
  const r = await pools.make({ owner: ELI, template: IMAGE, ticket: TICKET, coordinatorUrl: 'https://fleet.test' });
  assert.equal(r.ok, false);
  assert.equal(r.unreachable, true);
});

test('a machine is made from the person’s own image, on the uplink, with its ticket, its login and its end', async () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const stand = xo({ objects: [pool, image, uplink] });
  const pools = holder(stand, () => now);
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }, { name: 'claude', value: CLAUDE }] }]);
  await pools.refresh();

  assert.equal((await pools.make({ owner: 'sam@example.com', template: IMAGE, ticket: TICKET, coordinatorUrl: 'https://fleet.test' })).ok, false, 'not somebody else’s pool');
  assert.equal((await pools.make({ owner: ELI, template: 'other-template', ticket: TICKET, coordinatorUrl: 'https://fleet.test' })).ok, false, 'not an image this box saw');
  assert.equal((await pools.make({ owner: ELI, template: IMAGE, ticket: 'nope', coordinatorUrl: 'https://fleet.test' })).ok, false, 'not without its ticket');

  stand.calls.length = 0;
  const r = await pools.make({ owner: ELI, template: IMAGE, ticket: TICKET, minutes: 30, coordinatorUrl: 'https://fleet.test/' });
  assert.equal(r.ok, true, r.text);
  assert.equal(r.vm, 'new-vm-id');
  assert.match(r.text, /vm-111111111111 from Fleetwright Debian 13 on rack/);
  const made = /** @type {any} */ (stand.calls.find((c) => c.method === 'vm.create')).params;
  assert.equal(made.template, IMAGE);
  assert.equal(made.name_label, 'vm-111111111111', 'named as the coordinator will name it');
  assert.equal(made.resourceSet, 'set-1', 'counted against the pool’s limits');
  assert.deepEqual(made.VIFs, [{ network: 'net-uplink' }]);
  assert.equal(made.destroyCloudConfigVdiAfterBoot, true);
  assert.deepEqual(made.tags, [
    VM_IMAGE.sessionTag,
    `${VM_IMAGE.untilPrefix}${Math.floor(now / 1000) + 30 * 60}`,
    `fleetwright-made:${Math.floor(now / 1000)}`,
    `fleetwright-from:${IMAGE}`,
    `fleetwright-for:${ELI}`,
    'fleetwright-on:fleetwright-uplink',
  ]);
  const join = JSON.parse(/** @type {string} */ (made.cloudConfig.split('\n').find((/** @type {string} */ l) => l.trim().startsWith('{"v":1'))).trim());
  // The power-off the machine schedules for itself is a backstop past the
  // longest it can be given; its end is the box's to keep, by the tag, so an
  // extension needs nothing from inside the machine.
  assert.deepEqual(join, { v: 1, coordinator: 'https://fleet.test', ticket: TICKET, owner: ELI, claude: CLAUDE, minutes: 380 });
  assert.match(made.cloudConfig, /fleetwright-vm-join, \/run\/fleetwright\/join.json/);
  // ON THE UPLINK, FENCED: the network file, the script and its unit, and
  // the unit started before the join script starts anything that listens.
  const net = JSON.parse(/** @type {string} */ (made.cloudConfig.split('\n').find((/** @type {string} */ l) => l.trim().startsWith('{"v":1,"isolate"'))).trim());
  assert.deepEqual(net, { v: 1, isolate: { subnet: '10.254.0.0/24', gateway: '10.254.0.1' } });
  const lines = made.cloudConfig.split('\n');
  assert.ok(lines.indexOf('  - [systemctl, enable, --now, fleetwright-net.service]') < lines.findIndex((/** @type {string} */ l) => l.includes('fleetwright-vm-join')));

  // A refusal from the pool itself is not "unreachable": another box would hear the same.
  const full = holder(xo({ objects: [pool, image, uplink], fail: { 'vm.create': 'resource set limit exceeded' } }));
  full.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  await full.refresh();
  const refused = await full.make({ owner: ELI, template: IMAGE, ticket: TICKET, coordinatorUrl: 'https://fleet.test' });
  assert.equal(refused.ok, false);
  assert.equal(refused.unreachable, undefined);
  assert.match(refused.text, /limit exceeded/);
});

test('a machine can go on a network of the pool the person chose, and on no other', async () => {
  const lan = { type: 'network', id: 'net-lan', name_label: 'LAN', $pool: 'pool-1' };
  const stand = xo({ objects: [pool, image, uplink, lan] });
  const pools = holder(stand);
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  await pools.refresh();
  assert.deepEqual(pools.report()[0].networks, [{ id: 'net-lan', name: 'LAN', pool: 'pool-1', group: false }], 'the uplink is the default, not a choice');
  const refused = await pools.make({ owner: ELI, template: IMAGE, ticket: TICKET, network: 'net-elsewhere', coordinatorUrl: 'https://fleet.test' });
  assert.equal(refused.ok, false, 'not a network this box saw');
  assert.ok(!stand.calls.some((c) => c.method === 'vm.create'));
  const r = await pools.make({ owner: ELI, template: IMAGE, ticket: TICKET, network: 'net-lan', coordinatorUrl: 'https://fleet.test' });
  assert.equal(r.ok, true, r.text);
  const made = /** @type {any} */ (stand.calls.find((c) => c.method === 'vm.create')).params;
  assert.deepEqual(made.VIFs, [{ network: 'net-lan' }]);
  assert.ok(made.tags.includes('fleetwright-on:LAN'));
  assert.match(r.text, /on LAN/);
  // A network of the person's own is left as that network has it: no fence.
  assert.ok(!made.cloudConfig.includes('/etc/fleetwright-net.json'));
});

test('a machine in a group is also on the group network, with a MAC and an address of its own there', async () => {
  const group = { type: 'network', id: 'net-group', name_label: 'fleetwright-group-1', $pool: 'pool-1' };
  const lan = { type: 'network', id: 'net-lan', name_label: 'LAN', $pool: 'pool-1' };
  // Another machine in that group already has the address this ticket starts at.
  const other = { type: 'VM', id: 'vm-other', name_label: 'vm-222222222222', power_state: 'Running', tags: [VM_IMAGE.sessionTag, 'fleetwright-grp:fleetwright-group-1', 'fleetwright-gip:10.200.17.52'] };
  const stand = xo({ objects: [pool, image, uplink, lan, group, other] });
  const pools = holder(stand);
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  await pools.refresh();
  assert.deepEqual(
    pools.report()[0].networks.map((n) => [n.name, n.group]),
    [['LAN', false], ['fleetwright-group-1', true]],
  );

  assert.equal((await pools.make({ owner: ELI, template: IMAGE, ticket: TICKET, group: 'net-lan', coordinatorUrl: 'https://fleet.test' })).ok, false, 'a group is a group network');
  assert.equal((await pools.make({ owner: ELI, template: IMAGE, ticket: TICKET, network: 'net-group', coordinatorUrl: 'https://fleet.test' })).ok, false, 'and is never a machine’s own network');
  assert.ok(!stand.calls.some((c) => c.method === 'vm.create'));

  const r = await pools.make({ owner: ELI, template: IMAGE, ticket: TICKET, group: 'net-group', coordinatorUrl: 'https://fleet.test' });
  assert.equal(r.ok, true, r.text);
  const made = /** @type {any} */ (stand.calls.find((c) => c.method === 'vm.create')).params;
  assert.deepEqual(made.VIFs, [{ network: 'net-uplink' }, { network: 'net-group', mac: '02:11:11:11:11:11' }], 'its own network first, then the group');
  assert.ok(made.tags.includes('fleetwright-grp:fleetwright-group-1'));
  assert.ok(made.tags.includes('fleetwright-gip:10.200.17.53'), 'moved past the address taken');
  const net = JSON.parse(/** @type {string} */ (made.cloudConfig.split('\n').find((/** @type {string} */ l) => l.trim().startsWith('{"v":1,"isolate"'))).trim());
  assert.deepEqual(net.group, { mac: '02:11:11:11:11:11', address: '10.200.17.53/16' });
  assert.ok(net.isolate, 'on the uplink, still fenced from everyone not in its group');
  assert.match(r.text, /with the others on fleetwright-group-1 at 10\.200\.17\.53/);
});

// LABS: a lab network on the edge, tagged open or closed by the policy job,
// with one of the fleet's machines on it at a time. docs/hypervisors.md, "Labs".
const openLab = { type: 'network', id: 'net-lab-1', name_label: 'fleetwright-lab-1', $pool: 'pool-1', tags: ['fleetwright-lab:open', 'fleetwright-lab-each:2'] };
const closedLab = { type: 'network', id: 'net-lab-2', name_label: 'fleetwright-lab-2', $pool: 'pool-1', tags: ['fleetwright-lab:closed'] };
const formerLab = { type: 'network', id: 'net-lab-3', name_label: 'fleetwright-lab-3', $pool: 'pool-1', tags: [] };
const inLab = { type: 'VM', id: 'vm-in-lab', name_label: 'vm-222222222222', power_state: 'Running', tags: [VM_IMAGE.sessionTag, 'fleetwright-in-lab:fleetwright-lab-2'] };
const labVif = { type: 'VIF', id: 'vif-in-lab', $VM: 'vm-in-lab', $network: 'net-lab-2' };
// The edge's own interface on a lab, which is not one of the fleet's machines.
const edgeVif = { type: 'VIF', id: 'vif-edge', $VM: 'vm-edge', $network: 'net-lab-1' };

test('a look reports each lab, its kind and whether a machine of the fleet’s is on it, and a machine says which lab it is in', async () => {
  const stand = xo({ objects: [pool, image, uplink, openLab, closedLab, formerLab, inLab, labVif, edgeVif] });
  const pools = holder(stand);
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  await pools.refresh();
  const [seen] = pools.report();
  assert.deepEqual(seen.networks.map((n) => [n.name, n.lab ?? null, n.taken ?? null, n.perPerson ?? null]), [
    ['fleetwright-lab-1', 'open', false, 2],
    ['fleetwright-lab-2', 'closed', true, null],
    ['fleetwright-lab-3', null, null, null],
  ], 'the edge’s own interface made a lab look taken, a lab the policy took away is still one, or a limit was misread');
  assert.deepEqual(seen.machines.find((m) => m.name === 'vm-222222222222')?.lab, { name: 'fleetwright-lab-2', open: false });

  // An interface list the pool will not give is cannot tell, never free.
  const blind = xo({ objects: [pool, image, uplink, openLab] });
  const call = blind.rpc.call;
  blind.rpc.call = async (/** @type {string} */ method, /** @type {any} */ params = {}) =>
    method === 'xo.getAllObjects' && params.filter?.type === 'VIF' ? Promise.reject(new Error('forbidden')) : call(method, params);
  const unsure = holder(blind);
  unsure.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  await unsure.refresh();
  assert.deepEqual(unsure.report()[0].networks.map((n) => n.taken), [null]);
});

test('a machine in a lab goes on the lab alone, unfenced, and only on a lab this box saw empty', async () => {
  const stand = xo({ objects: [pool, image, uplink, openLab, closedLab, inLab, labVif] });
  const pools = holder(stand);
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  await pools.refresh();
  const ask = (/** @type {Record<string, any>} */ p) => pools.make({ owner: ELI, template: IMAGE, ticket: TICKET, lab: true, coordinatorUrl: 'https://fleet.test', ...p });
  assert.match((await ask({ network: 'net-lab-2' })).text, /fleetwright-lab-2 has a machine on it/);
  assert.equal((await ask({ network: 'net-uplink' })).ok, false, 'not a lab');
  assert.equal((await ask({ network: 'net-lab-1', group: 'net-lab-2' })).ok, false, 'a lab machine in a group');
  // And a lab is never a plain machine's network of choice.
  assert.equal((await pools.make({ owner: ELI, template: IMAGE, ticket: TICKET, network: 'net-lab-1', coordinatorUrl: 'https://fleet.test' })).ok, false);
  assert.ok(!stand.calls.some((c) => c.method === 'vm.create'));

  const r = await ask({ network: 'net-lab-1' });
  assert.equal(r.ok, true, r.text);
  const made = /** @type {any} */ (stand.calls.find((c) => c.method === 'vm.create')).params;
  assert.deepEqual(made.VIFs, [{ network: 'net-lab-1' }], 'on the uplink as well, it would leave around the lab’s rules');
  assert.ok(made.tags.includes('fleetwright-in-lab:fleetwright-lab-1'));
  assert.ok(made.tags.includes(VM_IMAGE.sessionTag), 'swept like any machine');
  // ITS END IS ITS OWN, like any machine's: nothing else ends a lab, so a lab
  // machine made without one would hold its lab until somebody ended it.
  assert.ok(made.tags.some((/** @type {string} */ t) => t.startsWith(VM_IMAGE.untilPrefix)), 'made with no end of its own');
  assert.ok(!made.cloudConfig.includes('/etc/fleetwright-net.json'), 'fenced against an uplink it is not on');
  assert.match(r.text, /in fleetwright-lab-1: it reaches the internet and nothing private/);
});

test('two machines put in one lab at once: the one made second is removed again', async () => {
  const objects = [pool, image, uplink, closedLab];
  const stand = xo({ objects });
  const pools = holder(stand);
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  await pools.refresh();
  // Another box's machine lands on the lab between this box's look and its clone.
  const s = Math.floor(Date.now() / 1000);
  objects.push({ ...inLab, id: 'vm-other', tags: [VM_IMAGE.sessionTag, `fleetwright-made:${s - 5}`] }, { ...labVif, $VM: 'vm-other' });
  const r = await pools.make({ owner: ELI, template: IMAGE, ticket: TICKET, lab: true, network: 'net-lab-2', coordinatorUrl: 'https://fleet.test' });
  assert.equal(r.ok, false);
  assert.match(r.text, /taken a moment ago by another machine/);
  assert.deepEqual(stand.calls.filter((c) => c.method === 'vm.delete').map((c) => c.params.id), ['new-vm-id'], 'the machine there first was removed');
});

test('a place on a group network comes from the ticket’s id and never repeats an address in use', () => {
  const id = 'abcdef012345';
  const first = groupPlace(id, new Set());
  assert.equal(first.mac, '02:ab:cd:ef:01:23', 'locally administered, unicast');
  assert.match(first.address, /^10\.200\.\d{1,3}\.\d{1,3}$/);
  assert.notEqual(groupPlace(id, new Set([first.address])).address, first.address);
  // Never the network's own address or its broadcast.
  for (const n of ['000000000000', '0000000000fd', '0000000000fe', '00000000ffff']) {
    const { address } = groupPlace(n, new Set());
    const last = Number(address.split('.')[3]);
    assert.ok(last >= 1 && last <= 254, address);
  }
});

test('a look reports the machines made there, what each is and where, for the phone’s page of it', async () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const s = Math.floor(now / 1000);
  const vm = {
    type: 'VM', id: 'vm-uuid', name_label: 'vm-111111111111', power_state: 'Running',
    tags: [VM_IMAGE.sessionTag, `${VM_IMAGE.untilPrefix}${s + 600}`, `fleetwright-made:${s - 600}`, `fleetwright-from:${IMAGE}`, `fleetwright-for:${ELI}`, 'fleetwright-on:LAN'],
    mainIpAddress: '192.168.1.40', addresses: { '0/ipv6/0': 'fe80::1', '0/ipv4/0': '10.0.0.9', '1/ipv4/0': '192.168.1.40' }, CPUs: { number: 2 }, memory: { size: 4 * 1024 ** 3 },
  };
  const paused = { ...vm, id: 'vm-stopped', name_label: 'vm-222222222222', power_state: 'Paused' };
  const traffic = { endTimestamp: s, interval: 60, stats: { vifs: { rx: { 0: [100, 200] }, tx: { 0: [5, 6] } } } };
  const stand = xo({ objects: [pool, image, uplink, vm, paused], stats: { 'vm-uuid': traffic, 'vm-stopped': traffic } });
  const pools = holder(stand, () => now);
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  await pools.refresh();
  assert.deepEqual(pools.report()[0].machines, [
    { name: 'vm-111111111111', vm: 'vm-uuid', state: 'Running', ip: '192.168.1.40', until: (s + 600) * 1000, madeAt: (s - 600) * 1000, cpus: 2, memory: 4 * 1024 ** 3, image: 'Fleetwright Debian 13', network: 'LAN', group: null, groupIp: null, lab: null, net: { interval: 60, end: s * 1000, rx: [100, 200], tx: [5, 6] } },
    { name: 'vm-222222222222', vm: 'vm-stopped', state: 'Paused', ip: '192.168.1.40', until: (s + 600) * 1000, madeAt: (s - 600) * 1000, cpus: 2, memory: 4 * 1024 ** 3, image: 'Fleetwright Debian 13', network: 'LAN', group: null, groupIp: null, lab: null, net: null },
  ]);
  assert.deepEqual(stand.calls.filter((c) => c.method === 'vm.stats').map((c) => c.params), [{ id: 'vm-uuid', granularity: 'minutes' }], 'only a running machine is asked what it did');
});

test('a machine’s traffic is every interface added up, the last half hour of it, with a sample nothing counted kept as a gap', () => {
  const at = 1_799_999_940;
  const long = Array.from({ length: NET_POINTS + 5 }, (_, i) => i);
  assert.deepEqual(trafficFrom({ endTimestamp: at, interval: 60, stats: { vifs: { rx: { 0: [10, null, 1.6], 1: [5, null, null] }, tx: { 0: [1, null, 2], 1: [1, null, 'x'] } } } }),
    { interval: 60, end: at * 1000, rx: [15, null, 2], tx: [2, null, 2] });
  assert.deepEqual(trafficFrom({ endTimestamp: at, interval: 60, stats: { vifs: { rx: [long], tx: [long] } } })?.rx, long.slice(-NET_POINTS), 'an older Xen Orchestra lists its interfaces, and only the newest points are kept');
  for (const bad of [true, null, {}, { endTimestamp: at, interval: 60, stats: {} }, { endTimestamp: at, interval: 0, stats: { vifs: { rx: [[1]], tx: [[1]] } } }, { interval: 60, stats: { vifs: { rx: [[1]], tx: [[1]] } } }, { endTimestamp: at, interval: 60, stats: { vifs: { rx: {}, tx: {} } } }, { endTimestamp: at, interval: 60, stats: { vifs: { rx: [[1, 2]], tx: [[1]] } } }])
    assert.equal(trafficFrom(bad), null, JSON.stringify(bad));
});

test('a pool that will not say what one machine did is cannot tell for that one, and the rest are still reported', async () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const vm = { type: 'VM', id: 'vm-uuid', name_label: 'vm-111111111111', power_state: 'Running', tags: [VM_IMAGE.sessionTag] };
  const pools = holder(xo({ objects: [pool, image, vm], fail: { 'vm.stats': 'not allowed' } }), () => now);
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  await pools.refresh();
  const [seen] = pools.report();
  assert.equal(seen.reachable, true);
  assert.deepEqual(seen.machines.map((m) => [m.name, m.net]), [['vm-111111111111', null]]);
});

/**
 * A pool with one machine of Eli's on it, made `age` minutes ago and running
 * for `left` more, with its guest agent unless `agent` is false.
 * @param {{ age?: number, left?: number, state?: string, fail?: Record<string, string>, owner?: string, tags?: string[], agent?: boolean }} [o]
 */
function withMachine({ age = 10, left = 20, state = 'Running', fail = {}, owner = ELI, tags = [], agent = true } = {}) {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const s = Math.floor(now / 1000);
  const vm = {
    type: 'VM', id: 'vm-uuid', name_label: 'vm-111111111111', power_state: state, managementAgentDetected: agent,
    tags: [VM_IMAGE.sessionTag, `${VM_IMAGE.untilPrefix}${s + left * 60}`, `fleetwright-made:${s - age * 60}`, `fleetwright-for:${owner}`, ...tags],
  };
  const stand = xo({ objects: [pool, image, vm], fail });
  const pools = holder(stand, () => now);
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  const asked = () => stand.calls.filter((c) => !['session.signIn', 'xo.getAllObjects'].includes(c.method)).map((c) => [c.method, c.params]);
  return { pools, stand, asked, s };
}

test('a machine is restarted, or ended now, only for the person it was made for', async () => {
  let m = withMachine();
  assert.equal((await m.pools.control({ owner: ELI, name: 'vm-111111111111', action: 'reboot' })).ok, true);
  assert.deepEqual(m.asked()[0], ['vm.restart', { id: 'vm-uuid', force: false }]);

  m = withMachine();
  const ended = await m.pools.control({ owner: ELI, name: 'vm-111111111111', action: 'stop' });
  assert.equal(ended.ok, true);
  assert.deepEqual(m.asked().slice(0, 2), [['vm.stop', { id: 'vm-uuid', force: true }], ['vm.delete', { id: 'vm-uuid', deleteDisks: true }]]);

  // Somebody else's machine on the same Xen Orchestra is not there for Eli.
  m = withMachine({ owner: 'sam@example.com' });
  const theirs = await m.pools.control({ owner: ELI, name: 'vm-111111111111', action: 'stop' });
  assert.equal(theirs.notHere, true);
  assert.deepEqual(m.asked(), []);

  // A person with no pool here, or a pool that cannot be reached: the next box is asked.
  assert.equal((await m.pools.control({ owner: 'sam@example.com', name: 'vm-111111111111', action: 'reboot' })).notHere, true);
  const down = new XoPools({ connect: /** @type {any} */ (async () => { throw new Error('ECONNREFUSED'); }) });
  down.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  assert.equal((await down.control({ owner: ELI, name: 'vm-111111111111', action: 'reboot' })).unreachable, true);
});

test('a restart is clean where the machine has its guest agent, and hard where it has not or refuses', async () => {
  // Xen Orchestra's own API: a clean reboot "Requires guest tools to be
  // installed", and the image installs them only where the distribution has them.
  let m = withMachine({ agent: false });
  assert.equal((await m.pools.control({ owner: ELI, name: 'vm-111111111111', action: 'reboot' })).ok, true);
  assert.deepEqual(m.asked(), [['vm.restart', { id: 'vm-uuid', force: true }]]);

  m = withMachine({ fail: { 'vm.restart:clean': 'VM_MISSING_PV_DRIVERS' } });
  assert.equal((await m.pools.control({ owner: ELI, name: 'vm-111111111111', action: 'reboot' })).ok, true);
  assert.deepEqual(m.asked(), [['vm.restart', { id: 'vm-uuid', force: false }], ['vm.restart', { id: 'vm-uuid', force: true }]]);

  m = withMachine({ agent: false });
  assert.equal((await m.pools.control({ owner: ELI, name: 'vm-111111111111', action: 'resize', cpus: 2 })).ok, true);
  assert.deepEqual(m.asked()[1], ['vm.stop', { id: 'vm-uuid', force: true }], 'a resize stops it hard too');
});

test('a machine is given longer up to its longest life from when it was made, and not past it', async () => {
  let m = withMachine({ age: 10, left: 20 });
  const r = await m.pools.control({ owner: ELI, name: 'vm-111111111111', action: 'extend', minutes: 60 });
  assert.equal(r.ok, true, r.text);
  assert.equal(r.until, (m.s + 80 * 60) * 1000);
  assert.deepEqual(m.asked(), [
    ['tag.add', { id: 'vm-uuid', tag: `${VM_IMAGE.untilPrefix}${m.s + 80 * 60}` }],
    ['tag.remove', { id: 'vm-uuid', tag: `${VM_IMAGE.untilPrefix}${m.s + 20 * 60}` }],
  ]);

  m = withMachine({ age: 300, left: 40 });
  const capped = await m.pools.control({ owner: ELI, name: 'vm-111111111111', action: 'extend', minutes: 60 });
  assert.equal(capped.until, (m.s + 50 * 60) * 1000, 'made 300 minutes ago, so 50 more at most');
  assert.match(capped.text, /the longest a machine can run/);

  m = withMachine({ age: 330, left: 20 });
  const full = await m.pools.control({ owner: ELI, name: 'vm-111111111111', action: 'extend', minutes: 30 });
  assert.equal(full.ok, false);
  assert.deepEqual(m.asked(), []);
});

test('a resize stops the machine marked busy so the sweep leaves it, and starts it again whatever the pool said', async () => {
  let m = withMachine();
  const r = await m.pools.control({ owner: ELI, name: 'vm-111111111111', action: 'resize', cpus: 4, memory: 8 });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(m.asked().slice(0, 5), [
    ['tag.add', { id: 'vm-uuid', tag: 'fleetwright-busy' }],
    ['vm.stop', { id: 'vm-uuid', force: false }],
    ['vm.set', { id: 'vm-uuid', CPUs: 4, memory: 8 * 1024 ** 3 }],
    ['vm.start', { id: 'vm-uuid' }],
    ['tag.remove', { id: 'vm-uuid', tag: 'fleetwright-busy' }],
  ]);
  assert.match(r.text, /4 vCPUs and 8 GiB/);

  m = withMachine({ fail: { 'vm.set': 'resource set limit exceeded' } });
  const refused = await m.pools.control({ owner: ELI, name: 'vm-111111111111', action: 'resize', cpus: 64 });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /old size.*limit exceeded/);
  assert.ok(m.asked().some(([method]) => method === 'vm.start'), 'not left stopped');
  assert.ok(m.asked().some(([method, p]) => method === 'tag.remove' && p.tag === 'fleetwright-busy'), 'not left marked busy');

  // Busy is left alone by the sweep, though stopped.
  const busy = withMachine({ state: 'Halted', tags: ['fleetwright-busy'] });
  await busy.pools.refresh();
  assert.ok(!busy.asked().some(([method]) => method === 'vm.delete'));
});

test('a machine is given its owner’s SSH keys and sudo when they keep some, and nothing when they do not', () => {
  const key = `ssh-ed25519 ${'A'.repeat(68)} eli@laptop`;
  const pools = holder(xo());
  pools.adopt([{ email: ELI, items: [{ name: 'secret:SSH_AUTHORIZED_KEYS', value: `${key}\nnot a key\nrm -rf /\n` }] }]);
  assert.deepEqual(pools.ssh.get(ELI), [key], 'public keys only, a line each');
  const config = machineCloudConfig({ name: 'vm-abc', coordinatorUrl: 'https://fleet.test', ticket: TICKET, owner: ELI, claude: null, minutes: 60, sshKeys: [key] });
  assert.match(config, /users:\n {2}- name: fleetwright\n/);
  assert.ok(config.includes(`      - ${JSON.stringify(key)}`));
  assert.ok(!machineCloudConfig({ name: 'vm-abc', coordinatorUrl: 'https://fleet.test', ticket: TICKET, owner: ELI, claude: null, minutes: 60 }).includes('users:'));
});

test('the cloud-init a machine boots with is one join file and the join script, and carries what it was given', () => {
  const config = machineCloudConfig({ name: 'vm-abc', coordinatorUrl: 'https://fleet.test/x', ticket: TICKET, owner: ELI, claude: null, minutes: 60 });
  assert.match(config, /^#cloud-config\nhostname: vm-abc\n/);
  assert.match(config, /"coordinator":"https:\/\/fleet.test"/, 'the bare origin');
  assert.match(config, /"claude":null/);
});

test('a machine enrols itself with its ticket once, records its name, and hands its login over once', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-vm-join-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'vm-join.json');
  const hostKeyFile = join(dir, 'host-key.json');
  writeFileSync(file, JSON.stringify({ v: 1, coordinator: 'https://fleet.test', ticket: TICKET, owner: 'Eli@Example.com', claude: CLAUDE, minutes: 60 }), { mode: 0o600 });
  const key = await generateKeyPair();
  /** @type {any[]} */
  const posted = [];
  const fetchImpl = /** @type {any} */ (async (/** @type {URL} */ url, /** @type {any} */ init) => {
    posted.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, hostId: 'vm-111111111111', fingerprint: 'f', ephemeral: true }), { status: 200 });
  });

  assert.equal(await enrolVmOnce({ file, origin: 'https://fleet.test', hostKeyFile, publicJwk: key.publicJwk, fetchImpl }), 'vm-111111111111');
  assert.equal(posted[0].url, 'https://fleet.test/api/enroll/vm');
  assert.equal(posted[0].body.ticket, TICKET);
  assert.equal(posted[0].body.publicJwk.x, key.publicJwk.x);
  assert.equal(readAssignedName(hostKeyFile), 'vm-111111111111', 'dials under the name it was given');
  assert.ok(!readFileSync(file, 'utf8').includes(TICKET), 'the ticket is gone from the file');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(await enrolVmOnce({ file, origin: 'https://fleet.test', hostKeyFile, publicJwk: key.publicJwk, fetchImpl }), null, 'a restart has nothing to enrol with');
  assert.equal(posted.length, 1);

  assert.deepEqual(vmLogin(file), { email: ELI, token: CLAUDE });
  forgetJoin(file);
  assert.equal(existsSync(file), false);
  assert.equal(vmLogin(file), null);
});

test('a refused ticket is spent too, and says why', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-vm-join-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'vm-join.json');
  writeFileSync(file, JSON.stringify({ v: 1, ticket: TICKET, owner: ELI }), { mode: 0o600 });
  const key = await generateKeyPair();
  const fetchImpl = /** @type {any} */ (async () => new Response(JSON.stringify({ ok: false, text: 'That ticket has already been spent.' }), { status: 403 }));
  await assert.rejects(enrolVmOnce({ file, origin: 'https://fleet.test', hostKeyFile: join(dir, 'k.json'), publicJwk: key.publicJwk, fetchImpl }), /already been spent/);
  assert.ok(!readFileSync(file, 'utf8').includes(TICKET));
});

// --- the image ---------------------------------------------------------------

test('the image’s cloud-init installs from this fleet without a pin, leaves nothing that makes two clones one, and says how it ended', () => {
  const config = buildCloudConfig({ coordinatorUrl: 'https://fleet.test/anything' });
  assert.match(config, /curl -fsSL 'https:\/\/fleet.test\/install' \| FLEETWRIGHT_COORDINATOR_URL='https:\/\/fleet.test' FLEETWRIGHT_USER=fleetwright sh -s -- --yes/);
  assert.ok(!/ENROL_PIN/.test(config), 'never enrolled');
  for (const wiped of ['truncate -s 0 /etc/machine-id', 'rm -f /var/lib/dbus/machine-id /etc/ssh/ssh_host_*', 'host-key.json', 'cloud-init clean']) {
    assert.ok(config.includes(wiped), wiped);
  }
  assert.match(config, /systemctl disable --now fleetwright-sidecar fleetwright/);
  assert.ok(!config.includes('fwi_'), 'no token, no reports');
  assert.throws(() => buildCloudConfig({ coordinatorUrl: 'https://fleet.test', token: "x'; reboot; '" }), /not a report token/, 'a token is never a way into the script');
});

/**
 * The build VM's install script, run in bash with every command it calls
 * replaced by a function that writes down how it was called: what it reports,
 * and how it ends. Functions, not stubs on PATH, because `test` is a builtin
 * and `rm` must not touch this machine.
 *
 * @param {{ fail?: string, token?: string|null }} [o]  a command that fails
 */
function runImageScript({ fail = '', token = REPORT_TOKEN } = {}) {
  const config = buildCloudConfig({ coordinatorUrl: 'https://fleet.test', token });
  const lines = config.split('\n');
  const script = lines.slice(lines.indexOf('    content: |') + 1, lines.indexOf('runcmd:')).map((l) => l.slice(6)).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'image-script-'));
  try {
    const stubs = ['apt-get', 'curl', 'sh', 'systemctl', 'cloud-init', 'truncate', 'rm', 'test', 'ip', 'getent'].map((c) =>
      `${c}() { echo "${c} $*" >>"$CALLS"; ${c === fail ? 'return 1' : 'return 0'}; }`);
    // python3 only ever builds a report's body: its fourth argument is the
    // step, which is all the body need be here; curl is what sends it.
    stubs.push('python3() { echo "$4"; }');
    const body = script
      .replace('log=/var/log/fleetwright-image.log', `log='${dir}/image.log'`)
      .replace("screens='/dev/console /dev/tty1'", "screens=''")
      .replace('#!/bin/bash', '');
    const run = spawnSync('bash', ['-c', `${stubs.join('\n')}\n${body}`], { env: { CALLS: join(dir, 'calls'), PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    // A report is a curl to the report route under an agent of its own, not
    // a stock one a CDN's bot check turns away, and reads back as
    // `report <step>`.
    return readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map((c) => {
      const sent = /^curl -fsS -m 10 -A fleetwright-image .*--data-binary (\S+) https:\/\/fleet\.test\/api\/xosetup\/report$/.exec(c);
      return sent ? `report ${sent[1]}` : c;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const REPORT_TOKEN = `fwi_a1b2c3d4e5f6_${'ab'.repeat(24)}`;

test('the install script reports each step to the fleet and powers off when every step worked', () => {
  const calls = runImageScript();
  assert.deepEqual(calls.filter((c) => c.startsWith('report ')), ['report started', 'report packages', 'report installer', 'report cleaning', 'report done']);
  assert.equal(calls.at(-1), 'systemctl poweroff');
  assert.ok(calls.includes('rm -f /root/fleetwright-image.sh'), 'the script, with its token in it, is not left in the image');
  // A VM that never reports in is most often one with no network, so the
  // first thing it puts on its screen is whether it has one.
  assert.ok(calls.indexOf('ip -4 -br addr') < calls.indexOf('apt-get update'));
  assert.ok(calls.includes('getent hosts deb.debian.org'));
});

test('the install script stops at the first step that fails, says so with its log, and reboots rather than becoming the template', () => {
  // THE BUG THIS FIXES: the steps ran in `{ ... } && poweroff || reboot`, and
  // bash ignores `set -e` on the left of `&&`. A failed apt-get went on to
  // the next step, and a broken install powered off and was made the template.
  const calls = runImageScript({ fail: 'apt-get' });
  assert.equal(calls.at(-1), 'systemctl reboot');
  assert.ok(calls.includes('report failed'));
  assert.ok(!calls.some((c) => c.includes('/install')), 'nothing after the failure ran');
  assert.ok(!calls.includes('systemctl poweroff'));
  const checked = runImageScript({ fail: 'test' });
  assert.equal(checked.at(-1), 'systemctl reboot', 'an install that left no fleetwright-vm-join is a failure too');
  assert.ok(!checked.some((c) => c.startsWith('cloud-init ')));
});

test('without a token the script reports nothing and still ends the same two ways', () => {
  const calls = runImageScript({ token: null });
  assert.deepEqual(calls.filter((c) => c.startsWith('report ')), [], 'nothing is sent anywhere');
  assert.equal(calls.at(-1), 'systemctl poweroff');
});

test('the image goes on storage the fleet may use with room for a whole disk', () => {
  const srs = [
    { id: 'small', $pool: 'pool-1', size: 10 * 1024 ** 3, physical_usage: 0 },
    { id: 'big', $pool: 'pool-1', size: 500 * 1024 ** 3, physical_usage: 0 },
    { id: 'elsewhere', $pool: 'pool-2', size: 900 * 1024 ** 3, physical_usage: 0 },
  ];
  assert.equal(imageStorage({ pool: 'pool-1', srs, fleetSrs: ['small', 'big', 'elsewhere'] }).id, 'big');
  assert.throws(() => imageStorage({ pool: 'pool-1', srs, fleetSrs: [], sr: 'small' }), /no 20 GiB free/);
  assert.throws(() => imageStorage({ pool: 'pool-1', srs, fleetSrs: ['small'] }), /Choose where it goes/);
});

/**
 * An admin stand-in for a build: the VM it makes goes from Running to
 * whatever `then` says on the second look.
 * @param {{ then: 'Halted'|'rebooted'|'Running', existing?: any[], runs?: number }} o
 */
function buildPool({ then, existing = [], runs = 1 }) {
  let looks = 0;
  const base = { type: 'VM-template', id: 'other-media', name_label: VM_IMAGE.template, $pool: 'pool-1', tags: [] };
  const sr = { type: 'SR', id: 'sr-1', name_label: 'Local storage', $pool: 'pool-1', size: 500 * 1024 ** 3, physical_usage: 0 };
  /** @type {Array<{ method: string, params: any }>} */
  const calls = [];
  const admin = {
    async call(/** @type {string} */ method, /** @type {any} */ params = {}) {
      calls.push({ method, params });
      if (method === 'xo.getAllObjects') {
        const f = params.filter || {};
        if (f.id === 'build-vm') {
          looks++;
          const state = looks <= runs || then === 'Running' ? { power_state: 'Running', startTime: 100 } : then === 'Halted' ? { power_state: 'Halted' } : { power_state: 'Running', startTime: 200 };
          return { 'build-vm': { id: 'build-vm', ...state } };
        }
        const drives = /** @type {any} */ (objects)[f.type]?.() ?? [];
        return Object.fromEntries([base, ...existing, ...drives].filter((o) => o.type === f.type && (!f.id || o.id === f.id) && (!f.VM || o.VM === f.VM)).map((o) => [o.id, o]));
      }
      if (method === 'disk.import') return { $sendTo: '/upload/1' };
      // AS XEN ORCHESTRA DOES: a cloud-init drive goes on the storage of the
      // VM's first disk, so one asked for with none is refused, in its words.
      if (method === 'vm.create') {
        if (params.cloudConfig != null && !(params.VDIs || []).length) throw new Error("Can't create cloud init config drive for VM without disks");
        return 'build-vm';
      }
      if (method === 'vm.attachDisk') disks.push({ vbd: `vbd-${disks.length}`, vdi: params.vdi, name: 'disk' });
      if (method === 'vm.createCloudInitConfigDrive') disks.push({ vbd: `vbd-${disks.length}`, vdi: 'cfg-1', name: CONFIG_DRIVE_NAME });
      if (method === 'vdi.delete') {
        const i = disks.findIndex((d) => d.vdi === params.id);
        if (i >= 0) disks.splice(i, 1);
      }
      return true;
    },
  };
  /** @type {Array<{ vbd: string, vdi: string, name: string }>} */
  const disks = [];
  const objects = {
    VBD: () => disks.map((d) => ({ type: 'VBD', id: d.vbd, VM: 'build-vm', VDI: d.vdi, is_cd_drive: false })),
    VDI: () => disks.map((d) => ({ type: 'VDI', id: d.vdi, name_label: d.name })),
  };
  return { admin, calls, sr, disks, objects };
}

// THE DOWNLOAD the build is handed: a real compressed qcow2 (qemu-img's, see
// test/qcow2.test.js), and the SHA-256 of the raw disk qemu-img reads out of
// it, which is what must reach the upload.
const downloaded = new URL('./fixtures/qcow2/zlib.qcow2', import.meta.url).pathname;
const DOWNLOADED_RAW = { size: 263168, sha256: '6e6cb97d4a311209778794ef3611d7ce245e9df9a6745038d4375214c0ac003f' };

/** @param {any} p */
const buildArgs = (p) => ({
  admin: p.admin,
  pool: 'pool-1',
  poolName: 'rack',
  uplink: 'net-uplink',
  setId: 'set-1',
  srs: [p.sr],
  fleetSrs: ['sr-1'],
  address: 'xo.lan',
  pin: PIN,
  plain: false,
  imageDir: '/nowhere',
  coordinatorUrl: 'https://fleet.test',
  say: () => {},
  getImage: /** @type {any} */ (async () => downloaded),
  upload: /** @type {any} */ (async (/** @type {any} */ o) => {
    /** @type {Buffer[]} */
    const chunks = [];
    for await (const c of o.body) chunks.push(c);
    p.uploaded = { ...o, body: Buffer.concat(chunks) };
    o.onProgress?.(DEBIAN_IMAGE.compressedSize, DEBIAN_IMAGE.compressedSize);
    return 'vdi-1';
  }),
  sleep: async () => {},
});

test('a build that powers off becomes the template, tagged, in the set; one already there is left alone', async () => {
  const p = buildPool({ then: 'Halted' });
  /** @type {string[]} */
  const said = [];
  const text = await ensureImage({ ...buildArgs(p), say: (t) => said.push(t) });
  assert.match(text, /machine image is ready on rack/);
  const order = p.calls.map((c) => c.method).filter((m) => m !== 'xo.getAllObjects');
  assert.deepEqual(order, ['disk.import', 'disk.resize', 'vm.create', 'vm.attachDisk', 'vm.createCloudInitConfigDrive', 'vm.start', 'vdi.delete', 'vm.set', 'tag.remove', 'tag.add', 'tag.add', 'vm.convertToTemplate', 'resourceSet.addObject']);
  const create = /** @type {any} */ (p.calls.find((c) => c.method === 'vm.create')).params;
  assert.deepEqual(create.VIFs, [{ network: 'net-uplink' }], 'built behind the edge router');
  // The install reaches the VM on a drive made once its disk is there, on that
  // disk's storage; and it is gone before the VM is a template.
  assert.deepEqual(/** @type {any} */ (p.calls.find((c) => c.method === 'vm.createCloudInitConfigDrive')).params, { vm: 'build-vm', sr: 'sr-1', config: buildCloudConfig({ coordinatorUrl: 'https://fleet.test' }) });
  assert.deepEqual(/** @type {any} */ (p.calls.find((c) => c.method === 'vdi.delete')).params, { id: 'cfg-1' });
  assert.deepEqual(p.disks.map((d) => d.vdi), ['vdi-1'], 'the template keeps its own disk and nothing else');
  assert.equal(/** @type {any} */ (p.calls.find((c) => c.method === 'disk.resize')).params.size, VM_IMAGE.diskSize);
  // RAW, READ OUT OF THE DOWNLOAD: the pool takes no compressed qcow2
  // (Compressed_unsupported on a real pool), so what Xen Orchestra is sent is
  // the raw disk, the same bytes qemu-img reads out of it, at its length.
  assert.equal(/** @type {any} */ (p.calls.find((c) => c.method === 'disk.import')).params.type, 'iso');
  assert.equal(p.uploaded.size, DOWNLOADED_RAW.size);
  assert.equal(p.uploaded.body.length, DOWNLOADED_RAW.size);
  assert.equal(createHash('sha256').update(p.uploaded.body).digest('hex'), DOWNLOADED_RAW.sha256);
  assert.deepEqual(p.calls.filter((c) => c.method === 'tag.add').map((c) => c.params), [{ id: 'build-vm', tag: VM_IMAGE.tag }, { id: 'build-vm', tag: 'fleetwright-image:debian-13' }]);
  assert.deepEqual(/** @type {any} */ (p.calls.find((c) => c.method === 'resourceSet.addObject')).params, { id: 'set-1', object: 'build-vm' });
  assert.ok(said.some((s) => /Installing Fleetwright on the machine image/.test(s)));

  const there = buildPool({ then: 'Halted', existing: [{ type: 'VM-template', id: 'img', name_label: 'Fleetwright Debian 13', $pool: 'pool-1', tags: [VM_IMAGE.tag] }] });
  assert.match(await ensureImage(buildArgs(there)), /already there on rack/);
  assert.ok(!there.calls.some((c) => c.method === 'disk.import'));
});

test('a Xen Orchestra without disk.resize grows the image’s disk through vdi.set, with the same id and size', async () => {
  // SEEN ON A REAL ONE: "this Xen Orchestra does not offer disk.resize, so
  // the machine image cannot be built".
  const p = buildPool({ then: 'Halted' });
  await ensureImage({ ...buildArgs(p), resize: 'vdi.set' });
  assert.ok(!p.calls.some((c) => c.method === 'disk.resize'));
  assert.deepEqual(/** @type {any} */ (p.calls.find((c) => c.method === 'vdi.set')).params, { id: 'vdi-1', size: VM_IMAGE.diskSize });
});

test('a build that reboots failed, and its VM is kept stopped, named for what happened', async () => {
  const p = buildPool({ then: 'rebooted' });
  await assert.rejects(ensureImage(buildArgs(p)), /did not install on the machine image, and it did not send its log back/);
  assert.ok(p.calls.some((c) => c.method === 'vm.stop' && c.params.id === 'build-vm'));
  assert.ok(p.calls.some((c) => c.method === 'vm.set' && /install failed/.test(c.params.name_label)));
  assert.ok(!p.calls.some((c) => c.method === 'vm.delete'), 'kept, for its log');
  assert.ok(!p.calls.some((c) => c.method === 'vm.convertToTemplate'));
});

test('a build VM’s reports are what the phone is told, and a failure it reports ends the build at once with its log', async () => {
  // ASKED FOR: "Or script call back something so we get it in the app",
  // after a real build sat at "18 min so far, usually about 8".
  const p = buildPool({ then: 'Running' });
  const reports = [null, { step: 'packages', detail: null, at: 0 }, { step: 'installer', detail: null, at: 0 }, { step: 'failed', detail: 'Get:1 deb.debian.org\nE: Unable to fetch some archives', at: 0 }];
  let looks = 0;
  /** @type {Array<{ text: string, fill: number }>} */
  const shown = [];
  const err = await ensureImage({
    ...buildArgs(p),
    reporter: async () => REPORT_TOKEN,
    vmReport: () => reports[Math.min(looks, reports.length - 1)],
    sleep: async () => { looks++; },
    say: (text, part) => shown.push({ text, fill: part?.fill ?? 0 }),
  }).catch((e) => e);
  assert.ok(/** @type {any} */ (p.calls.find((c) => c.method === 'vm.createCloudInitConfigDrive')).params.config.includes(REPORT_TOKEN), 'the VM is given its token');
  const install = shown.filter((s) => s.text.startsWith('Installing Fleetwright on the machine image:'));
  assert.match(install[0].text, /installing Debian’s packages, 1 min so far\./);
  assert.match(install[1].text, /installing Fleetwright and fetching the session image/);
  assert.ok(install[1].fill > install[0].fill, 'a later step moves the bar on');
  assert.match(String(err), /did not install on the machine image\. The end of its log:\nGet:1 deb\.debian\.org\nE: Unable to fetch some archives\n/);
  assert.ok(p.calls.some((c) => c.method === 'vm.set' && /install failed/.test(c.params.name_label)));
  assert.ok(!p.calls.some((c) => c.method === 'vm.delete'), 'kept');
});

test('a build VM that never reports in is named as the likely problem, and one that runs out of time is kept', async () => {
  const p = buildPool({ then: 'Running' });
  let at = 0;
  /** @type {string[]} */
  const shown = [];
  const err = await ensureImage({
    ...buildArgs(p),
    reporter: async () => REPORT_TOKEN,
    now: () => at,
    sleep: async () => { at += 2 * 60_000; },
    say: (text) => shown.push(text),
  }).catch((e) => e);
  assert.ok(shown.some((s) => /min so far, usually about 8\./.test(s)), 'quiet at first: it may still be booting');
  assert.ok(shown.some((s) => /6 min so far, and its VM has not reported in\. It may have no network, or its start-up script did not run\./.test(s)));
  assert.match(String(err), /did not finish within 25 minutes, and its VM never reported in.*kept, stopped, as "fleetwright-image-build \(install timed out\)"/);
  assert.ok(p.calls.some((c) => c.method === 'vm.stop' && c.params.id === 'build-vm'));
  assert.ok(!p.calls.some((c) => c.method === 'vm.delete'), 'kept, where a timeout used to delete it');
});

// --- rebuilt and removed ----------------------------------------------------
//
// ASKED FOR: "There is no rebuild button or delete button", on a pool whose
// three images were built before the install script stopped at its first
// failure, so any of them may be one that should not have become a template.

const OLD = { type: 'VM-template', id: 'img-old', name_label: 'Fleetwright Debian 13', $pool: 'pool-1', tags: [VM_IMAGE.tag, 'fleetwright-image:debian-13'] };
const CLONE = { type: 'VM', id: 'vm-a', $pool: 'pool-1', tags: [`${VM_IMAGE.fromPrefix}img-old`] };

test('a rebuild makes the new image beside the old one, and removes the old one once the new one is a template', async () => {
  const p = buildPool({ then: 'Halted', existing: [OLD] });
  const text = await ensureImage({ ...buildArgs(p), replace: true });
  const order = p.calls.map((c) => c.method).filter((m) => m !== 'xo.getAllObjects');
  assert.ok(order.indexOf('vm.convertToTemplate') < order.lastIndexOf('vm.delete'), 'never neither: the new one first');
  assert.deepEqual(p.calls.filter((c) => c.method === 'vm.delete').map((c) => c.params), [{ id: 'img-old', deleteDisks: true }]);
  assert.match(text, /rebuilt on rack.*The one that was there was removed\./);
});

test('a rebuild keeps the old image while a machine made from it exists, untagged so nothing offers it', async () => {
  const p = buildPool({ then: 'Halted', existing: [OLD, CLONE] });
  const text = await ensureImage({ ...buildArgs(p), replace: true });
  assert.ok(!p.calls.some((c) => c.method === 'vm.delete' && c.params.id === 'img-old'));
  assert.deepEqual(p.calls.filter((c) => c.method === 'tag.remove' && c.params.id === 'img-old').map((c) => c.params.tag).sort(), [VM_IMAGE.tag, 'fleetwright-image:debian-13']);
  assert.ok(p.calls.some((c) => c.method === 'vm.set' && c.params.id === 'img-old' && c.params.name_label === 'Fleetwright Debian 13 (replaced)'));
  assert.match(text, /kept as "Fleetwright Debian 13 \(replaced\)", because a machine made from it still exists/);
});

test('a rebuild that fails leaves the image that was there as it was', async () => {
  const p = buildPool({ then: 'rebooted', existing: [OLD] });
  await assert.rejects(ensureImage({ ...buildArgs(p), replace: true }), /did not install/);
  assert.ok(!p.calls.some((c) => c.params?.id === 'img-old'), 'nothing was done to it');
});

test('a removed image is deleted, and one a machine was made from is kept with how many and what to do', async () => {
  const gone = buildPool({ then: 'Halted', existing: [OLD] });
  assert.match(await removeImage({ admin: gone.admin, pool: 'pool-1', poolName: 'rack', image: 'debian-13' }), /removed from rack\. New session no longer offers it\./);
  assert.deepEqual(gone.calls.filter((c) => c.method === 'vm.delete').map((c) => c.params), [{ id: 'img-old', deleteDisks: true }]);

  const kept = buildPool({ then: 'Halted', existing: [OLD, CLONE, { ...CLONE, id: 'vm-b' }] });
  assert.match(await removeImage({ admin: kept.admin, pool: 'pool-1', poolName: 'rack', image: 'debian-13' }), /kept on rack: 2 machines made from it still exist\. Remove them and apply again\./);
  assert.ok(!kept.calls.some((c) => c.method === 'vm.delete'));

  assert.match(await removeImage({ admin: kept.admin, pool: 'pool-2', image: 'debian-13' }), /already gone/);
});

test('cancelled mid-build, what was made is removed', async () => {
  const p = buildPool({ then: 'Halted' });
  const abort = new AbortController();
  const args = buildArgs(p);
  args.sleep = async () => { abort.abort(); };
  await assert.rejects(ensureImage({ ...args, signal: abort.signal }));
  assert.ok(p.calls.some((c) => c.method === 'vm.delete' && c.params.id === 'build-vm'));
});
