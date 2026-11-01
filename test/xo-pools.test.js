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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';

import { XoPools, poolRecord, machineCloudConfig, groupPlace, trafficFrom, NET_POINTS, MISSING_FORGET_MS } from '../src/fleet/host/xo-pools.js';
import { VM_IMAGE, CONFIG_DRIVE_NAME, buildCloudConfig, ensureImage, removeImage, imageStorage, imageChannelOf, DEBIAN_IMAGE } from '../src/fleet/host/vm-image.js';
import { enrolVmOnce, vmLogin, forgetJoin } from '../src/fleet/host/vm-join.js';
import { readAssignedName } from '../src/fleet/host/identity.js';
import { generateKeyPair } from '../src/fleet/crypto.js';
import { HOLDER } from '../src/fleet/host/xo-holder.js';
import { newSealKey, open as openSealed, xolookAad } from '../src/fleet/seal.js';

const ELI = 'eli@example.com';
const PIN = 'a'.repeat(64);
const IMAGE = '0b1e8c2a-3f4d-4e5a-9b6c-7d8e9f0a1b2c';
const TICKET = `fwt_${'1'.repeat(12)}_${'2'.repeat(48)}`;
const CLAUDE = `sk-ant-oat01-${'c'.repeat(40)}`;

/** @param {Record<string, any>} [extra] */
const record = (extra = {}) => JSON.stringify({ v: 1, address: 'xo.lan', pin: PIN, token: 'xo-limited-token', resourceSet: 'set-1', ...extra });

/**
 * A Xen Orchestra stand-in: objects by type, every call recorded.
 *
 * THE FLEET'S RESOURCE SET is `set-1`, as the limited user reads it
 * (resourceSet.getAll answers it only the sets it is a subject of): every
 * template and network given is in it, as a policy job puts them there, and
 * every VM given was made in it, as the fleet's own vm.create makes them.
 * `outside` names the objects in no set of the fleet's: what somebody else
 * made or was given, which Xen Orchestra shows the limited user all the same.
 *
 * @param {{ objects?: any[], fail?: Record<string, string|string[]>, stats?: Record<string, any>, methods?: string[], outside?: string[] }} [opts]
 */
function xo({ objects = [], fail = {}, stats = {}, methods, outside = [] } = {}) {
  /** @type {Array<{ method: string, params: any }>} */
  const calls = [];
  const theirs = new Set(outside);
  const asSeen = (/** @type {any} */ o) => (o.type === 'VM' && !theirs.has(o.id) && o.resourceSet === undefined ? { ...o, resourceSet: 'set-1' } : o);
  const rpc = {
    closed: false,
    async call(/** @type {string} */ method, /** @type {any} */ params = {}) {
      calls.push({ method, params });
      // `fail[method]` is why every call of it fails; a list is why each of
      // the next calls fails in turn, and the calls after the list succeed,
      // as a start that fails once does.
      const why = Array.isArray(fail[method]) ? fail[method].shift() : fail[method];
      if (why) throw new Error(why);
      // `vm.restart:clean` refuses only the clean one, as a machine without
      // its guest agent does.
      if (params?.force === false && fail[`${method}:clean`]) throw new Error(fail[`${method}:clean`]);
      if (method === 'session.signIn') return { id: 'u1', permission: 'none' };
      if (method === 'xo.getAllObjects') {
        const f = params.filter || {};
        return Object.fromEntries(objects.map(asSeen).filter((o) => Object.entries(f).every(([k, v]) => o[k] === v)).map((o) => [o.id, o]));
      }
      if (method === 'resourceSet.getAll') {
        return [{ id: 'set-1', name: 'fleetwright', subjects: ['u1'], objects: objects.filter((o) => o.type !== 'VM' && !theirs.has(o.id)).map((o) => o.id) }];
      }
      if (method === 'system.getMethodsInfo' && methods) return Object.fromEntries(methods.map((m) => [m, { description: m }]));
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
        // A record from a setup that kept the pool master's addresses for
        // the phone to show: adopted as one without them is.
        { name: 'hypervisor:masters.lan', value: record({ address: 'masters.lan', masters: ['10.10.10.11', '10.10.10.12'] }) },
      ],
    },
  ]);
  assert.deepEqual(given[0].items.map((/** @type {any} */ i) => i.name), ['secret:NPM', 'claude'], 'the hub is given everything but pools');
  assert.deepEqual([...pools.held.keys()], [`${ELI} xo.lan`, `${ELI} masters.lan`], 'filed under another address, or pinned to nothing, is not a pool');
  assert.equal(pools.claude.get(ELI), CLAUDE);
  // THE FIELD IS THE PHONE'S: the box holds the pool exactly as it would
  // without it, so a setup adding to the record changes nothing here.
  assert.deepEqual(poolRecord('hypervisor:masters.lan', record({ address: 'masters.lan', masters: ['10.10.10.11'] })), poolRecord('hypervisor:masters.lan', record({ address: 'masters.lan' })));
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

test('a look reports, sweeps and works only what is in the fleet’s resource set: a tag is something anybody given a VM can add', async () => {
  // MEASURED on Xen Orchestra 5.211.0 (docs/hypervisors.md, "What Xen
  // Orchestra lets whom do"): it shows a user who is not an admin every
  // object, and one given administrate on a single VM can rename it, tag it
  // as the fleet tags its machines, clone it, and copy a snapshot of it to a
  // template carrying its tags. None of that puts anything in the fleet's set.
  const now = Date.now();
  const ours = { type: 'VM', id: 'ours', name_label: 'vm-bbbbbbbbbbbb', power_state: 'Running', tags: [VM_IMAGE.sessionTag, `${VM_IMAGE.untilPrefix}${Math.floor((now + 60_000) / 1000)}`, `fleetwright-for:${ELI}`] };
  const planted = { type: 'VM', id: 'planted', name_label: 'vm-aaaaaaaaaaaa', power_state: 'Halted', tags: [VM_IMAGE.sessionTag, `fleetwright-for:${ELI}`] };
  const plantedImage = { type: 'VM-template', id: 'planted-image', name_label: 'Fleetwright Debian 13', $pool: 'pool-1', tags: [VM_IMAGE.tag] };
  const office = { type: 'network', id: 'net-office', name_label: 'office', $pool: 'pool-1' };
  const lan = { type: 'network', id: 'net-lan', name_label: 'lan', $pool: 'pool-1' };
  const stand = xo({ objects: [pool, image, plantedImage, uplink, lan, office, ours, planted], outside: ['planted', 'planted-image', 'net-office'] });
  const pools = holder(stand, () => now);
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  await pools.refresh();
  const [seen] = pools.report();
  assert.deepEqual(seen.images.map((/** @type {any} */ i) => i.id), [IMAGE], 'a template tagged as an image and outside the set is not one to offer');
  assert.deepEqual(seen.networks.map((/** @type {any} */ n) => n.id), ['net-lan'], 'a network outside the set is not one a machine can be made on');
  assert.deepEqual(seen.machines.map((/** @type {any} */ m) => m.name), ['vm-bbbbbbbbbbbb'], 'a VM tagged as a machine and outside the set is not one of ours');
  const r = await pools.control({ owner: ELI, name: 'vm-aaaaaaaaaaaa', action: 'stop' });
  assert.equal(r.notHere, true, r.text);
  assert.deepEqual(stand.calls.filter((c) => c.params?.id === 'planted').map((c) => c.method), [], 'never swept, stopped or worked');
});

test('a machine is born allowed what its owner chose for the pool’s machines, and an answer that is not one reaches none', async () => {
  const joinOf = async (/** @type {any} */ grants) => {
    const stand = xo({ objects: [pool, image, uplink] });
    const pools = holder(stand);
    pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record(grants === undefined ? {} : { grants }) }] }]);
    await pools.refresh();
    const r = await pools.make({ owner: ELI, template: IMAGE, ticket: TICKET, coordinatorUrl: 'https://fleet.test' });
    assert.equal(r.ok, true, r.text);
    const made = /** @type {any} */ (stand.calls.find((c) => c.method === 'vm.create')).params;
    return JSON.parse(/** @type {string} */ (made.cloudConfig.split('\n').find((/** @type {string} */ l) => l.trim().startsWith('{"v":1,"coordinator"'))).trim());
  };
  assert.deepEqual((await joinOf({ upgrades: true, reboot: false })).grants, { upgrades: true, reboot: false });
  assert.equal('grants' in (await joinOf(undefined)), false, 'the image’s own answer, from a phone that never chose');
  assert.equal('grants' in (await joinOf({ reboot: 'on' })), false);
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

test('a pool the token saw and no longer sees is reported missing, and for how long, only by a look that reached Xen Orchestra, and forgotten after a day', async () => {
  // WHAT THE COORDINATOR READS "Xen Orchestra shows none of its pools" from
  // (docs/hypervisors.md): this box's own token saw a pool, and a look that
  // reached Xen Orchestra no longer does.
  let now = 1_800_000_000_000;
  const rack = { type: 'pool', id: 'pool-2', name_label: 'rack two' };
  const objects = [pool, rack];
  const stand = xo({ objects });
  let down = false;
  const reach = async () => {
    if (down) throw new Error('connect ECONNREFUSED');
    return stand.rpc;
  };
  const pools = new XoPools({ connect: /** @type {any} */ (reach), now: () => now });
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  const look = async () => {
    await pools.refresh();
    return /** @type {any} */ (pools.report()[0]);
  };

  let seen = await look();
  assert.equal('missing' in seen, false, 'nothing missing is said as nothing at all');
  objects.splice(0, objects.length);
  now += 60_000;
  seen = await look();
  assert.deepEqual([seen.reachable, seen.pools], [true, []]);
  assert.deepEqual(seen.missing, [{ id: 'pool-1', name: 'rack' }, { id: 'pool-2', name: 'rack two' }]);
  assert.equal(seen.missingFor, 0, 'from the first look that missed them, not from when they were last seen');
  objects.push(rack);
  now += 4 * 60_000;
  seen = await look();
  assert.deepEqual(seen.missing, [{ id: 'pool-1', name: 'rack' }]);
  assert.equal(seen.missingFor, 4 * 60_000);

  // A LOOK THAT DID NOT REACH IT says nothing of its pools, and the clock
  // starts again from the next one that does.
  down = true;
  now += 60_000;
  seen = await look();
  assert.equal(seen.reachable, false);
  assert.equal('missing' in seen || 'missingFor' in seen, false);
  down = false;
  now += 60_000;
  seen = await look();
  assert.deepEqual([seen.missing, seen.missingFor], [[{ id: 'pool-1', name: 'rack' }], 0]);

  // A DAY after it was last seen, it is no longer news.
  now = 1_800_000_000_000 + MISSING_FORGET_MS;
  seen = await look();
  assert.equal('missing' in seen, false);
  assert.deepEqual(seen.pools, [{ id: 'pool-2', name: 'rack two' }]);

  // And a token never seen with a pool reports none and misses none.
  const empty = new XoPools({ connect: /** @type {any} */ (async () => xo().rpc), now: () => now });
  empty.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  await empty.refresh();
  assert.deepEqual(/** @type {any} */ (empty.report()[0]).pools, []);
  assert.equal('missing' in /** @type {any} */ (empty.report()[0]), false);
});

test('a machine is made from the person’s own image, on the uplink, with its ticket and its end, and never its owner’s login on the drive', async () => {
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
  //
  // NOT THE CLAUDE LOGIN, which this box holds for Eli (G14): every box
  // holding the pool's token may export this drive through Xen Orchestra
  // until boot destroys it. The machine asks for it once enrolled.
  assert.deepEqual(join, { v: 1, coordinator: 'https://fleet.test', ticket: TICKET, owner: ELI, minutes: 380 });
  assert.equal(pools.claude.get(ELI), CLAUDE, 'the box holds the login it keeps off the drive');
  assert.ok(!made.cloudConfig.includes(CLAUDE), 'the drive carries the Claude login');
  assert.match(made.cloudConfig, /fleetwright-vm-join.*, \/run\/fleetwright\/join\.json\]$/m);
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

test('a machine joins with root’s copy of the join script, and one cloned from an older image with the copy that has', () => {
  // `current` is the run user's on the image, as on every box, and root ran
  // the join script out of it on the machine's first boot. Run here as
  // cloud-init runs it — the argv on the runcmd line — with the two places
  // it looks pointed at this test's directories.
  const config = machineCloudConfig({ name: 'm', coordinatorUrl: 'https://fleet.test', ticket: TICKET, owner: ELI, minutes: 60 });
  const line = config.split('\n').find((l) => l.includes('fleetwright-vm-join')) ?? '';
  const argv = /^ {2}- \[sh, -c, '([^']*)', (\/run\/fleetwright\/join\.json)\]$/.exec(line);
  assert.ok(argv, `cloud-init does not run root’s copy: ${line}`);
  const dir = mkdtempSync(join(tmpdir(), 'fw-join-runcmd-'));
  try {
    const roots = join(dir, 'sbin');
    const theirs = join(dir, 'current');
    for (const [d, said] of [[roots, 'root’s'], [theirs, 'current’s']]) {
      mkdirSync(d);
      writeFileSync(join(d, 'fleetwright-vm-join'), `#!/bin/sh\necho "${said} $1"\n`, { mode: 0o755 });
    }
    const script = argv[1].replaceAll('/usr/local/sbin/', `${roots}/`).replaceAll('/opt/fleetwright/current/install/', `${theirs}/`);
    const run = () => spawnSync('sh', ['-c', script, argv[2]], { encoding: 'utf8' });
    assert.equal(run().stdout, 'root’s /run/fleetwright/join.json\n');
    rmSync(join(roots, 'fleetwright-vm-join'));
    assert.equal(run().stdout, 'current’s /run/fleetwright/join.json\n', 'an image from before root’s copy existed still joins');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
 * @param {{ age?: number, left?: number, state?: string, fail?: Record<string, string|string[]>, owner?: string, tags?: string[], agent?: boolean }} [o]
 */
function withMachine({ age = 10, left = 20, state = 'Running', fail = {}, owner = ELI, tags = [], agent = true } = {}) {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const s = Math.floor(now / 1000);
  const vm = {
    type: 'VM', id: 'vm-uuid', name_label: 'vm-111111111111', power_state: state, managementAgentDetected: agent, CPUs: { number: 2 }, memory: { size: 4 * 1024 ** 3 },
    tags: [VM_IMAGE.sessionTag, `${VM_IMAGE.untilPrefix}${s + left * 60}`, `fleetwright-made:${s - age * 60}`, `fleetwright-for:${owner}`, ...tags],
  };
  const stand = xo({ objects: [pool, image, vm], fail });
  const pools = holder(stand, () => now);
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  const asked = () => stand.calls.filter((c) => !['session.signIn', 'xo.getAllObjects', 'resourceSet.getAll'].includes(c.method)).map((c) => [c.method, c.params]);
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
  const busyTag = `fleetwright-busy:${m.s}`;
  const r = await m.pools.control({ owner: ELI, name: 'vm-111111111111', action: 'resize', cpus: 4, memory: 8 });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(m.asked().slice(0, 5), [
    ['tag.add', { id: 'vm-uuid', tag: busyTag }],
    ['vm.stop', { id: 'vm-uuid', force: false }],
    ['vm.set', { id: 'vm-uuid', CPUs: 4, memory: 8 * 1024 ** 3 }],
    ['vm.start', { id: 'vm-uuid' }],
    ['tag.remove', { id: 'vm-uuid', tag: busyTag }],
  ]);
  assert.match(r.text, /4 vCPUs and 8 GiB/);

  m = withMachine({ fail: { 'vm.set': 'resource set limit exceeded' } });
  const refused = await m.pools.control({ owner: ELI, name: 'vm-111111111111', action: 'resize', cpus: 64 });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /old size.*limit exceeded/);
  assert.ok(m.asked().some(([method]) => method === 'vm.start'), 'not left stopped');
  assert.ok(m.asked().some(([method, p]) => method === 'tag.remove' && p.tag === busyTag), 'not left marked busy');
});

test('a resize whose restart fails puts the old size back and starts again; failing that too, the machine is left stopped, marked, and said so', async () => {
  // THE CHANGE TOOK AND THE MACHINE WOULD NOT START WITH IT (no host has
  // that much memory free): the old size goes back and it is started again.
  // This used to fall through to the sweep, which took the stop for done and
  // removed the machine with its disk.
  let m = withMachine({ fail: { 'vm.start': ['HOST_NOT_ENOUGH_FREE_MEMORY'] } });
  const busyTag = `fleetwright-busy:${m.s}`;
  const back = await m.pools.control({ owner: ELI, name: 'vm-111111111111', action: 'resize', memory: 64 });
  assert.equal(back.ok, false);
  assert.match(back.text, /restarted at its old size.*HOST_NOT_ENOUGH_FREE_MEMORY/);
  assert.deepEqual(m.asked().slice(2), [
    ['vm.set', { id: 'vm-uuid', memory: 64 * 1024 ** 3 }],
    ['vm.start', { id: 'vm-uuid' }],
    ['vm.set', { id: 'vm-uuid', memory: 4 * 1024 ** 3 }],
    ['vm.start', { id: 'vm-uuid' }],
    ['tag.remove', { id: 'vm-uuid', tag: busyTag }],
  ]);

  // NOR AT ITS OLD SIZE: left stopped and still marked busy, so the sweep
  // leaves it, and the person is told the state it is in.
  m = withMachine({ fail: { 'vm.start': 'HOST_NOT_ENOUGH_FREE_MEMORY' } });
  const stuck = await m.pools.control({ owner: ELI, name: 'vm-111111111111', action: 'resize', memory: 64 });
  assert.equal(stuck.ok, false);
  assert.match(stuck.text, /^vm-111111111111 is stopped: it would not start with 64 GiB \(HOST_NOT_ENOUGH_FREE_MEMORY\), nor at its old size .*It was not removed/);
  assert.ok(!m.asked().some(([method, p]) => method === 'tag.remove' && String(p.tag).startsWith('fleetwright-busy')), 'kept marked busy');
});

test('busy holds the sweep off for half an hour from the time in the mark, and no longer: a mark left behind is not a machine kept for ever', async () => {
  // A sidecar that died between marking and unmarking left the bare tag on,
  // and the machine with it: stopped, never swept, never started.
  const S = Math.floor(Date.parse('2026-10-06T12:00:00Z') / 1000);
  const fresh = withMachine({ state: 'Halted', left: -5, tags: [`fleetwright-busy:${S - 60}`] });
  await fresh.pools.refresh();
  assert.deepEqual(fresh.asked(), [], 'marked a minute ago: left as it is');

  // A BARE MARK, from a box older than the time in it: dated from now, so
  // it runs out like the rest, and honoured this pass.
  const bare = withMachine({ state: 'Halted', left: -5, tags: ['fleetwright-busy'] });
  await bare.pools.refresh();
  assert.deepEqual(bare.asked(), [
    ['tag.add', { id: 'vm-uuid', tag: `fleetwright-busy:${S}` }],
    ['tag.remove', { id: 'vm-uuid', tag: 'fleetwright-busy' }],
  ]);

  // OLDER THAN A RESIZE TAKES: the mark comes off and the machine is swept
  // by the rules, here stopped past its end.
  const stale = withMachine({ state: 'Halted', left: -5, tags: [`fleetwright-busy:${S - 31 * 60}`] });
  await stale.pools.refresh();
  assert.deepEqual(stale.asked(), [
    ['tag.remove', { id: 'vm-uuid', tag: `fleetwright-busy:${S - 31 * 60}` }],
    ['vm.delete', { id: 'vm-uuid', deleteDisks: true }],
  ]);
});

test('a stopped machine is removed only once it is old enough to have booted and past its end; stopped before its end, it is started again, once', async () => {
  // vm.create clones and tags a machine before it boots, so a box looking
  // in that window took it for a stopped one and removed it, disk and all,
  // before it ran once; and a host reboot or an evacuation stops a machine
  // mid-session, which went the same way, the session's work with it.
  const now = Date.parse('2026-10-06T12:00:00Z');
  const s = Math.floor(now / 1000);
  /** @param {string} id @param {string} state @param {{ age: number, left: number, tags?: string[] }} o */
  const vm = (id, state, { age, left, tags = [] }) => ({
    type: 'VM', id, name_label: `vm-${id}`, power_state: state,
    tags: [VM_IMAGE.sessionTag, `${VM_IMAGE.untilPrefix}${s + left * 60}`, `fleetwright-made:${s - age * 60}`, `fleetwright-for:${ELI}`, ...tags],
  });
  const stand = xo({
    objects: [
      pool, image,
      vm('young', 'Halted', { age: 1, left: 59 }),
      vm('stopped', 'Halted', { age: 30, left: 30 }),
      vm('twice', 'Halted', { age: 30, left: 30, tags: [`fleetwright-restarted:${s - 120}`] }),
      vm('done', 'Halted', { age: 70, left: -10 }),
      vm('overdue', 'Running', { age: 80, left: -20 }),
    ],
  });
  const pools = holder(stand, () => now);
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  await pools.refresh();
  const did = (/** @type {string} */ method) => stand.calls.filter((c) => c.method === method).map((c) => c.params.id);
  assert.deepEqual(did('vm.delete'), ['done', 'overdue'], 'stopped past its end, or running past it: never one still booting, or stopped before its end');
  assert.deepEqual(did('vm.stop'), ['overdue'], 'the running case as it was');
  assert.deepEqual(did('vm.start'), ['stopped'], 'stopped before its end: started again, and not a second time');
  assert.deepEqual(stand.calls.filter((c) => c.method === 'tag.add').map((c) => [c.params.id, c.params.tag]), [['stopped', `fleetwright-restarted:${s}`]]);
});

test('two asks for one machine’s login at once: one is handed it and the other is handed nothing', async () => {
  // Both used to read the machine from `made` before either had taken it
  // out, and both were handed the login.
  const m = withMachine();
  m.pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }, { name: 'claude', value: CLAUDE }] }]);
  m.pools.made.set('vm-111111111111', { vm: 'vm-uuid', owner: ELI, at: Date.now() });
  const key = await newSealKey();
  const ask = () => m.pools.handLogin({ owner: ELI, name: 'vm-111111111111', key: key.publicKey });
  const [a, b] = await Promise.all([ask(), ask()]);
  assert.equal([a, b].filter((r) => r.ok).length, 1, `${a.text} / ${b.text}`);
  const other = /** @type {any} */ ([a, b].find((r) => !r.ok));
  assert.match(other.text, /is being handed its login already/);
  assert.equal(other.notHere, undefined, 'this box made it: the coordinator is not sent to the next');
  assert.equal(m.pools.made.has('vm-111111111111'), false);
  assert.equal(m.pools.handing.size, 0);

  // A NO THAT MAY PASS keeps the machine for its next ask: not running yet.
  const paused = withMachine({ state: 'Paused' });
  paused.pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }, { name: 'claude', value: CLAUDE }] }]);
  paused.pools.made.set('vm-111111111111', { vm: 'vm-uuid', owner: ELI, at: Date.now() });
  const later = await paused.pools.handLogin({ owner: ELI, name: 'vm-111111111111', key: key.publicKey });
  assert.equal(later.ok, false);
  assert.match(later.text, /is paused/);
  assert.equal(paused.pools.made.has('vm-111111111111'), true, 'asked again once running, it is handed');
  assert.equal(paused.pools.handing.size, 0);
});

test('a pool’s own machine that made a machine holds no login to hand it and says so as notHere, and the box that holds the login hands it, vouched for by the pool', async () => {
  // holder-5a5829's journal: "made vm-72ee54698806 ... for elibrody2". Let in
  // for the pool's item alone, it held no Claude login, answered "holds no
  // Claude login ... keep one in your vault" to a person whose vault held
  // one, and the coordinator, which moves on only on notHere, stopped there.
  // The machine ran with nothing to run on.
  const maker = withMachine();
  maker.pools.holderFor = 'xo.lan';
  maker.pools.made.set('vm-111111111111', { vm: 'vm-uuid', owner: ELI, at: Date.now() });
  const key = await newSealKey();
  const said = await maker.pools.handLogin({ owner: ELI, name: 'vm-111111111111', key: key.publicKey });
  assert.equal(said.ok, false);
  assert.equal(said.notHere, true, 'the coordinator is sent to the next box');
  assert.match(said.text, /made vm-111111111111 but holds no Claude login/);
  assert.match(said.text, /pool’s own machine/);
  assert.ok(maker.pools.made.has('vm-111111111111'), 'and remembers it still');
  // The same words at make, for the person reading the reply.
  assert.equal(maker.pools.claude.get(ELI), undefined);

  // ANOTHER BOX, which made nothing but holds the login and the pool: the
  // machine is found by name, tagged as made for the person, in the fleet's
  // set, running — the maker's checks, with the pool as the witness.
  const other = withMachine();
  other.pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }, { name: 'claude', value: CLAUDE }] }]);
  assert.equal(other.pools.made.size, 0);
  const handed = await other.pools.handLogin({ owner: ELI, name: 'vm-111111111111', key: key.publicKey });
  assert.equal(handed.ok, true, handed.text);
  const inside = /** @type {any} */ (await openSealed({ privateKey: key.privateKey, publicKey: key.publicKey, aad: await (await import('../src/fleet/seal.js')).claudeBindingFor(key.publicKey), sealed: handed.sealed }));
  assert.equal(inside.token, CLAUDE);
  // ONCE from this box.
  const again = await other.pools.handLogin({ owner: ELI, name: 'vm-111111111111', key: key.publicKey });
  assert.equal(again.ok, false);
  assert.equal(again.notHere, undefined, 'handed already is an answer, not a pass to the next box');
  assert.match(again.text, /handed its login by this box already/);
});

test('a box vouching from the pool hands nothing to a machine made for somebody else, not in the fleet’s set, or not there', async () => {
  const key = await newSealKey();
  const theirs = withMachine({ owner: 'somebody@example.com' });
  theirs.pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }, { name: 'claude', value: CLAUDE }] }]);
  const r1 = await theirs.pools.handLogin({ owner: ELI, name: 'vm-111111111111', key: key.publicKey });
  assert.equal(r1.ok, false);
  assert.equal(r1.notHere, true, r1.text);
  assert.match(r1.text, /not as a machine the fleet made for eli@example.com/);

  const outside = xo({ objects: [pool, image, { type: 'VM', id: 'vm-uuid', name_label: 'vm-111111111111', power_state: 'Running', tags: [VM_IMAGE.sessionTag, `fleetwright-for:${ELI}`] }], outside: ['vm-uuid'] });
  const stranger = holder(outside);
  stranger.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }, { name: 'claude', value: CLAUDE }] }]);
  const r2 = await stranger.handLogin({ owner: ELI, name: 'vm-111111111111', key: key.publicKey });
  assert.equal(r2.ok, false);
  assert.equal(r2.notHere, true, r2.text);

  const gone = holder(xo({ objects: [pool, image] }));
  gone.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }, { name: 'claude', value: CLAUDE }] }]);
  const r3 = await gone.handLogin({ owner: ELI, name: 'vm-111111111111', key: key.publicKey });
  assert.equal(r3.ok, false);
  assert.equal(r3.notHere, true, r3.text);
  assert.match(r3.text, /not on any of eli@example.com’s pools this box holds/);
  // Nothing of the maker's path leaks: a box without the login says notHere too.
  const empty = withMachine();
  const r4 = await empty.pools.handLogin({ owner: ELI, name: 'vm-111111111111', key: key.publicKey });
  assert.equal(r4.notHere, true, r4.text);
});

test('a machine not found on the pools that answered, with another unreached, is said to be so and kept for the next ask', async () => {
  // One of two pools down and the machine not on the other used to answer
  // "not on any of your pools any more", with neither `unreachable` nor
  // `notHere`: the coordinator stopped there, the entry was gone, and the
  // machine never got its login.
  const stand = xo({ objects: [pool, image] });
  const connect = /** @type {any} */ (async ({ address }) => {
    if (address === 'other.lan') throw new Error('connect ETIMEDOUT');
    return stand.rpc;
  });
  const pools = new XoPools({ connect, connectPlain: connect });
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }, { name: 'hypervisor:other.lan', value: record({ address: 'other.lan' }) }, { name: 'claude', value: CLAUDE }] }]);
  pools.made.set('vm-111111111111', { vm: 'vm-uuid', owner: ELI, at: Date.now() });
  const key = await newSealKey();
  const r = await pools.handLogin({ owner: ELI, name: 'vm-111111111111', key: key.publicKey });
  assert.equal(r.ok, false);
  assert.equal(r.unreachable, true, r.text);
  assert.match(r.text, /pools of yours that answered.*other\.lan: connect ETIMEDOUT/);
  assert.ok(pools.made.has('vm-111111111111'), 'kept for the next ask');
  // The same of working it.
  const c = await pools.control({ owner: ELI, name: 'vm-111111111111', action: 'reboot' });
  assert.equal(c.unreachable, true, c.text);
  assert.equal(c.notHere, undefined);
  assert.match(c.text, /pools of yours that answered.*other\.lan: connect ETIMEDOUT/);
});

test('a machine is given its owner’s SSH keys and sudo when they keep some, and nothing when they do not', () => {
  const key = `ssh-ed25519 ${'A'.repeat(68)} eli@laptop`;
  const pools = holder(xo());
  pools.adopt([{ email: ELI, items: [{ name: 'secret:SSH_AUTHORIZED_KEYS', value: `${key}\nnot a key\nrm -rf /\n` }] }]);
  assert.deepEqual(pools.ssh.get(ELI), [key], 'public keys only, a line each');
  const config = machineCloudConfig({ name: 'vm-abc', coordinatorUrl: 'https://fleet.test', ticket: TICKET, owner: ELI, minutes: 60, sshKeys: [key] });
  assert.match(config, /users:\n {2}- name: fleetwright\n/);
  assert.ok(config.includes(`      - ${JSON.stringify(key)}`));
  assert.ok(!machineCloudConfig({ name: 'vm-abc', coordinatorUrl: 'https://fleet.test', ticket: TICKET, owner: ELI, minutes: 60 }).includes('users:'));
});

test('the cloud-init a machine boots with is one join file and the join script, and carries what it was given', () => {
  const config = machineCloudConfig({ name: 'vm-abc', coordinatorUrl: 'https://fleet.test/x', ticket: TICKET, owner: ELI, minutes: 60 });
  assert.match(config, /^#cloud-config\nhostname: vm-abc\n/);
  assert.match(config, /"coordinator":"https:\/\/fleet.test"/, 'the bare origin');
});

test('a machine enrols itself with its ticket once, records its name, and hands its login over once', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-vm-join-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'vm-join.json');
  const hostKeyFile = join(dir, 'host-key.json');
  // A FILE FROM A BOX OLDER THAN G14's FIX, which still put the login on the
  // drive: a machine from an image built since uses it as given.
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

test('the image’s cloud-init installs the signed package without a fleet or a pin, leaves nothing that makes two clones one, and says how it ended', () => {
  const config = buildCloudConfig({ coordinatorUrl: 'https://fleet.test/anything' });
  assert.match(config, /signed-by=\/usr\/share\/keyrings\/fleetwright.gpg\] https:\/\/fleet-apt.thetech.network stable main/);
  assert.ok(!config.includes('trusted=yes'), 'an unsigned repository');
  assert.match(config, /debconf-set-selections <<<'fleetwright fleetwright\/user string fleetwright'/);
  assert.ok(!config.includes('fleetwright/coordinator-url'), 'the image would join a fleet before it is a clone');
  assert.ok(!/ENROL_PIN/.test(config), 'never enrolled');
  for (const wiped of ['truncate -s 0 /etc/machine-id', 'rm -f /var/lib/dbus/machine-id /etc/ssh/ssh_host_*', 'host-key.json', 'cloud-init clean']) {
    assert.ok(config.includes(wiped), wiped);
  }
  assert.match(config, /systemctl disable --now fleetwright-sidecar fleetwright/);
  assert.ok(!config.includes('fwi_'), 'no token, no reports');
  assert.throws(() => buildCloudConfig({ coordinatorUrl: 'https://fleet.test', token: "x'; reboot; '" }), /not a report token/, 'a token is never a way into the script');
  assert.match(buildCloudConfig({ coordinatorUrl: 'https://fleet.test', addresses: ["1.2.3.4'; reboot; '", 'fleet.test'] }), /pinned=''/, 'nor is an address that is not one');
});

/** A stand-in for GUEST_AGENT's bytes. */
const AGENT = Buffer.from('\x7fELF a stand-in for xen-guest-agent');

test('the guest agent goes in the cloud-init drive and starts before anything that needs a network; the packaged one is only a fallback', () => {
  // ASKED FOR: the guest agent everywhere. Debian has no package for one, so
  // `apt-get install xe-guest-utilities || true` put nothing on a Debian
  // image, and apt needs the network, so a build VM whose network was the
  // problem never had one either.
  const agent = gzipSync(AGENT).toString('base64');
  const config = buildCloudConfig({ coordinatorUrl: 'https://fleet.test', token: REPORT_TOKEN, agent });
  const lines = config.split('\n');
  const at = lines.indexOf('  - path: /usr/sbin/xen-guest-agent');
  assert.ok(at > lines.indexOf('write_files:'), 'not written by cloud-init');
  assert.deepEqual(lines.slice(at + 1, at + 4), ["    permissions: '0755'", '    encoding: gz+b64', `    content: ${agent}`]);
  assert.ok(gunzipSync(Buffer.from(agent, 'base64')).equals(AGENT), 'what cloud-init writes is the agent');
  assert.ok(config.includes('      ExecStart=/usr/sbin/xen-guest-agent'));
  const start = lines.findIndex((l) => l.includes('systemctl enable --now xen-guest-agent.service'));
  assert.ok(start > 0 && start < lines.findIndex((l) => l.trim() === 'report started'), 'started after the first report, or not at all');
  assert.ok(config.includes('[ -x /usr/sbin/xen-guest-agent ] || apt-get install -y xe-guest-utilities || true'), 'both agents would run');
  assert.ok(!buildCloudConfig({ coordinatorUrl: 'https://fleet.test' }).includes('/usr/sbin/xen-guest-agent\n'), 'none written without one');
  assert.throws(() => buildCloudConfig({ coordinatorUrl: 'https://fleet.test', agent: "x\n    content: |\n      reboot" }), /not the guest agent/, 'nor is anything else written in its place');
});

/**
 * The build VM's install script, run in bash with every command it calls
 * replaced by a function that writes down how it was called: what it reports,
 * and how it ends. Functions, not stubs on PATH, because `test` is a builtin
 * and `rm` must not touch this machine.
 *
 * Its processes and network counters are directories of its own, never this
 * machine's. With `pull`, the installer's `apt-get install fleetwright` holds
 * a `podman pull` among them while 4000 bytes arrive, and ends it.
 *
 * @param {{ fail?: string, token?: string|null, addresses?: string[], offline?: boolean, pull?: boolean }} [o]
 *   a command that fails; and, offline, a VM that cannot look up a name, so
 *   curl gets nowhere by name and only by an address it is given
 */
/**
 * The install script, run against stubs. `deaf` is the fleet not answering a
 * report: `true` is no HTTP answer at all, a number is that status with
 * nothing behind it. `log` collects the lines the script writes to its log
 * and screen, which is where it records what each report was answered.
 */
function runImageScript({ fail = '', token = REPORT_TOKEN, addresses = [], offline = false, pull = false, beat = 60, slow = false, deaf = false, log = /** @type {string[]} */ ([]) } = {}) {
  const config = buildCloudConfig({ coordinatorUrl: 'https://fleet.test', token, addresses });
  const lines = config.split('\n');
  const script = lines.slice(lines.indexOf('    content: |') + 1, lines.indexOf('runcmd:')).map((l) => l.slice(6)).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'image-script-'));
  try {
    for (const nic of ['eth0', 'lo']) {
      mkdirSync(join(dir, 'net', nic, 'statistics'), { recursive: true });
      writeFileSync(join(dir, 'net', nic, 'statistics', 'rx_bytes'), '1000\n');
    }
    mkdirSync(join(dir, 'proc', '17'), { recursive: true });
    writeFileSync(join(dir, 'proc', '17', 'cmdline'), 'bash\0-lc\0podman pull ghcr.io/x/y:latest\0', 'utf8');
    // The pull, while apt-get installs: seen, bytes arrive (and some on the
    // loopback, which is not a download), reported, and then it is gone.
    const until = (/** @type {string} */ seen) => `for _ in $(seq 400); do grep -q '${seen}' "$CALLS" && break; command sleep 0.05; done`;
    // A COUNTER CHANGES IN ONE STEP. `echo 5000 >file` truncates the file and
    // then writes it, and the watcher reads these every few milliseconds here
    // (every=0): a read that lands in the gap sees an empty file, counts it as
    // nothing, and reports `-1000`, which this test then fails on — once in
    // many runs, on whichever Node happened to schedule it so. A real
    // /sys/class/net counter is never half-written, so the fixture must not
    // be either: written beside, then renamed over.
    const counter = (/** @type {string} */ nic, /** @type {number} */ n) =>
      `echo ${n} >'${dir}/net/${nic}/statistics/rx_bytes.next' && mv -f '${dir}/net/${nic}/statistics/rx_bytes.next' '${dir}/net/${nic}/statistics/rx_bytes'`;
    const holdPull = [
      'if [ "$*" = "install -y --no-install-recommends fleetwright" ]; then',
      `  mkdir -p '${dir}/proc/4242'; printf 'podman\\0pull\\0ghcr.io/x/y:latest\\0' >'${dir}/proc/4242/cmdline'`,
      `  ${until('image:0/262144000')}`,
      `  ${counter('eth0', 5000)}; ${counter('lo', 9000000)}`,
      `  ${until('image:4000/262144000')}`,
      `  rm -rf '${dir}/proc/4242'`,
      `  for _ in $(seq 400); do [ "$(grep -c 'image:4000/262144000' "$CALLS")" -ge 2 ] && break; command sleep 0.05; done`,
      'fi',
    ].join('\n');
    const stubs = ['apt-get', 'curl', 'sh', 'systemctl', 'cloud-init', 'truncate', 'rm', 'test', 'ip', 'getent', 'sleep', 'resolvectl', 'dpkg', 'debconf-set-selections'].map((c) => {
      // `deaf`: the fleet cannot be reached for reports, and nothing else fails.
      // A report's curl prints the status it got, as the real one is asked to
      // (-w '%{http_code}'); the stand-in's fleet answers 200, a deaf one by
      // status answers that and nothing, one with no answer exits as curl
      // does when nothing spoke.
      const report = '[[ "$*" != */api/xosetup/report ]]';
      const fails = c === fail ? 'return 1' : offline && c === 'getent' ? 'return 2' : offline && c === 'curl' ? '[[ "$*" == *--resolve* ]] || return 6' : deaf === true && c === 'curl' ? `${report} || return 6` : deaf && c === 'curl' ? `${report} || { printf ${deaf}; return 0; }` : '';
      const answers = c === 'curl' ? `${report} || printf 200; ` : '';
      // `slow` holds apt-get update long enough for the heartbeat to beat.
      const held = `${pull && c === 'apt-get' ? `${holdPull}\n` : ''}${slow && c === 'apt-get' ? 'if [ "$*" = update ]; then command sleep 0.4; fi\n' : ''}`;
      return `${c}() { echo "${c} $*" >>"$CALLS"; ${held}${fails}${fails ? '; ' : ''}${answers}return 0; }`;
    });
    // python3 builds a report's body, whose fourth argument is the step and
    // all the body need be here (curl is what sends it), with the pull's
    // counts after it as `:got/of`; and asks a server for a name when names
    // do not work, with three; and, read from stdin, asks a registry how big
    // an image is, which here is 250 MiB.
    stubs.push('python3() { if [ "${1-}" = - ]; then cat >/dev/null; echo 262144000; else echo "${4-}${6:+:$6}${7:+/$7}"; fi; }');
    const body = script
      .replace('log=/var/log/fleetwright-image.log', `log='${dir}/image.log'`)
      .replace('stepfile=/run/fleetwright-image.step', `stepfile='${dir}/step'`)
      .replace('beat=60', `beat=${beat}`)
      .replace('procs=/proc', `procs='${dir}/proc'`)
      .replace('nets=/sys/class/net', `nets='${dir}/net'`)
      .replace('every=15', 'every=0')
      .replace("screens='/dev/console /dev/tty1'", "screens=''")
      .replace('/etc/apt/sources.list.d/fleetwright.list', `${dir}/fleetwright.list`)
      .replace('#!/bin/bash', '');
    const run = spawnSync('bash', ['-c', `${stubs.join('\n')}\n${body}`], { env: { CALLS: join(dir, 'calls'), PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    if (existsSync(join(dir, 'image.log'))) log.push(...readFileSync(join(dir, 'image.log'), 'utf8').trim().split('\n'));
    // A report is a curl to the report route under an agent of its own, not
    // a stock one a CDN's bot check turns away, and reads back as
    // `report <step>`, or `report <step> to <host:port:address>` when it went
    // to an address rather than by name. Whether it asked for the status it
    // got is the log's to show (`report done: 200`), not this parse's.
    return readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map((c) => {
      const sent = /^curl -f?sS -m 10 (?:-o \/dev\/null -w %\{http_code\} )?-A fleetwright-image (?:--resolve (\S+) )?.*--data-binary (\S+) https:\/\/fleet\.test\/api\/xosetup\/report$/.exec(c);
      return sent ? `report ${sent[2]}${sent[1] ? ` to ${sent[1]}` : ''}` : c;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const REPORT_TOKEN = `fwi_a1b2c3d4e5f6_${'ab'.repeat(24)}`;

test('the install script reports each step to the fleet and powers off when every step worked', () => {
  const calls = runImageScript();
  assert.deepEqual(calls.filter((c) => c.startsWith('report ')), ['report started', 'report dns', 'report packages', 'report installer', 'report cleaning', 'report done']);
  assert.equal(calls.at(-1), 'systemctl poweroff');
  assert.ok(calls.includes('rm -f /root/fleetwright-image.sh'), 'the script, with its token in it, is not left in the image');
  // A VM that never reports in is most often one with no network, so the
  // first thing it puts on its screen is whether it has one.
  assert.ok(calls.indexOf('ip -4 -br addr') < calls.indexOf('apt-get update'));
  assert.ok(calls.includes('getent hosts deb.debian.org'));
  // Fleetwright from apt, whose package carries the Node the installer
  // needs: the distributions' own is older, and the installer refuses it.
  const key = calls.indexOf('curl -fsSL https://fleet-apt.thetech.network/fleetwright.gpg -o /usr/share/keyrings/fleetwright.gpg');
  const user = calls.indexOf('debconf-set-selections ');
  const install = calls.indexOf('apt-get install -y --no-install-recommends fleetwright');
  assert.ok(key > 0 && key < install && user > 0 && user < install, 'installed before its key or its run user');
  // NO CONTAINER ON THE IMAGE: the VM is the sandbox, FLEETWRIGHT_SANDBOX is
  // never turned on in a clone, and podman with the 293 MB session image were
  // most of a build for nothing. Recommends off, and the installer told.
  const script = buildCloudConfig({ coordinatorUrl: 'https://fleet.test', token: REPORT_TOKEN });
  assert.match(script, /export DEBIAN_FRONTEND=noninteractive FLEETWRIGHT_NO_SANDBOX=1 FLEETWRIGHT_BUILD_IMAGE=0/);
  const sh = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');
  assert.match(sh, /FLEETWRIGHT_NO_SANDBOX:-0}" = "1" \]; then\n\s+ok "sandboxing off/, 'the installer honours the knob by not installing podman');
  assert.equal(calls.filter((c) => c === 'apt-get update').length, 2, 'apt is not told about the repository it was just given');
  assert.ok(!calls.some((c) => c.includes('fleet.test/install') || c.includes('/prereq')), 'the installer is still fetched by hand');
});

test('the session image’s pull is watched from beside the installer: its size, the bytes since it began, and nothing once it is gone', () => {
  // ASKED FOR: "What's it doing here I feel like we can give a better sense
  // of status". The pull is inside apt-get install fleetwright and was most
  // of the build, and the VM said nothing through it.
  const calls = runImageScript({ pull: true });
  const sent = calls.filter((c) => c.startsWith('report '));
  const pulls = sent.filter((c) => c.startsWith('report image'));
  assert.equal(pulls[0], 'report image:0/262144000', 'its size, as soon as the pull is seen, and no bytes yet');
  const firstBytes = pulls.indexOf('report image:4000/262144000');
  assert.ok(firstBytes > 0, `the bytes, once they arrive: ${pulls.join(', ')}`);
  assert.ok(pulls.every((c, i) => c === (i < firstBytes ? 'report image:0/262144000' : 'report image:4000/262144000')), `bytes off the network since the pull began, not the loopback: ${pulls.join(', ')}`);
  assert.ok(pulls.length >= 3, 'reported while it runs, and once more as it ends');
  assert.ok(sent.indexOf('report installer') < sent.indexOf(pulls[0]) && sent.lastIndexOf(pulls.at(-1)) < sent.indexOf('report cleaning'), 'inside the install, never after it');
  assert.deepEqual(sent.slice(sent.indexOf('report cleaning')), ['report cleaning', 'report done'], 'nothing more from the watcher once the pull is over');
  assert.equal(calls.at(-1), 'systemctl poweroff');
  // And no pull, no reports of one: what the other runs here show.
  assert.ok(!runImageScript().some((c) => c.startsWith('report image')));
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

test('a VM that cannot look up a name stops within half a minute, says which servers it asked, and its failure still reaches the fleet', () => {
  // ASKED FOR after a real build VM had an address and a route from the edge
  // router and printed "cannot look up deb.debian.org" on its screen in its
  // first second, then went on: one look, too early to be sure, and a
  // failure the phone could not hear because its reports went by name.
  const calls = runImageScript({ offline: true, addresses: ['203.0.113.7', '203.0.113.7', '198.51.100.2'] });
  assert.equal(calls.filter((c) => c === 'getent hosts deb.debian.org').length, 15, 'fifteen looks, two seconds apart');
  assert.ok(calls.includes('sleep 2'));
  // SAID, AND BOUNDED. A build sat at "started" for twelve minutes on a phone
  // while fifteen looks at a server that dropped queries each waited the
  // resolver's default (five seconds, twice, per server): the wait is a step
  // of its own now, each look waits two seconds for one answer, and the whole
  // wait is held to a minute.
  assert.ok(calls.indexOf('report dns') > calls.indexOf('report started') && calls.indexOf('report dns') < calls.indexOf('getent hosts deb.debian.org'));
  const script = buildCloudConfig({ coordinatorUrl: 'https://fleet.test', token: REPORT_TOKEN });
  assert.match(script, /RES_OPTIONS='timeout:2 attempts:1' getent hosts deb\.debian\.org/);
  assert.match(script, /\[ \$\(\(SECONDS - t0\)\) -lt 60 \] \|\| break/);
  assert.ok(calls.includes('resolvectl dns'), 'and the servers DHCP gave it, on its screen and in the log it sends');
  // And who answers when asked straight, and whose MAC the gateway is: a
  // build behind two edge routers was told 10.254.0.1 and heard nothing,
  // and the log could not say whether either router answered at all.
  assert.ok(calls.includes('ip -4 route show default'), 'its gateway is asked as well as its servers');
  assert.ok(calls.indexOf('ip neigh show') > calls.lastIndexOf('getent hosts deb.debian.org'));
  assert.ok(!calls.some((c) => c.startsWith('apt-get')), 'nothing that needs a name is tried');
  assert.ok(calls.includes('report failed to fleet.test:443:203.0.113.7,198.51.100.2'), 'sent again to the addresses the box gave it');
  assert.equal(calls.at(-1), 'systemctl reboot');

  const named = runImageScript({ addresses: ['203.0.113.7'] });
  assert.equal(named.filter((c) => c.startsWith('getent')).length, 1, 'a VM with names looks once');
  assert.ok(!named.some((c) => c.includes(' to fleet.test:')), 'and reports by name alone');
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
 * whatever `then` says on the second look. Its resource sets are the fleet's,
 * `set-1`, holding every image among `existing`, and the list of what the
 * policy job made (xo-made.js), which holds every `kept` disk unless it says
 * `recorded: false`.
 * @param {{ then: 'Halted'|'rebooted'|'Running', existing?: any[], runs?: number, kept?: Array<{ id: string, tags: string[], sr?: string, recorded?: boolean, resourceSet?: string }>, named?: any[] }} o
 */
function buildPool({ then, existing = [], runs = 1, kept = [], named = [] }) {
  let looks = 0;
  // XCP-ng's own, marked so and with no disks; `named` are listed before it.
  const base = { type: 'VM-template', id: 'other-media', name_label: VM_IMAGE.template, $pool: 'pool-1', tags: [], isDefaultTemplate: true, $VBDs: [] };
  const sr = { type: 'SR', id: 'sr-1', name_label: 'Local storage', $pool: 'pool-1', size: 500 * 1024 ** 3, physical_usage: 0 };
  /** @type {Array<{ method: string, params: any }>} */
  const calls = [];
  // EVERY DISK ON THE POOL by the VM it is on, its storage, and its name,
  // which is how a cloud-init drive is told from a disk.
  /** @type {Array<{ vm: string, vdi: string, name: string, sr: string }>} */
  const disks = kept.map((k) => ({ vm: k.id, vdi: `${k.id}-disk`, name: 'disk', sr: k.sr ?? 'sr-1' }));
  const templates = [...named, base, ...existing, ...kept.map((k) => ({ type: 'VM-template', id: k.id, $pool: 'pool-1', tags: k.tags, ...(k.resourceSet ? { resourceSet: k.resourceSet } : {}) }))];
  /** @type {Array<{ id: string, name: string, objects: string[] }>} */
  const sets = [
    { id: 'set-1', name: 'fleetwright', objects: existing.filter((t) => t.type === 'VM-template' && t.tags?.includes(VM_IMAGE.tag)).map((t) => t.id) },
    ...(kept.length ? [{ id: 'set-made', name: 'fleetwright-made', objects: kept.filter((k) => k.recorded !== false).map((k) => k.id) }] : []),
  ];
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
        return Object.fromEntries([...templates, ...drives].filter((o) => o.type === f.type && (!f.id || o.id === f.id) && (!f.VM || o.VM === f.VM)).map((o) => [o.id, o]));
      }
      if (method === 'disk.import') return { $sendTo: '/upload/1' };
      if (method === 'resourceSet.getAll') return sets.map((x) => ({ ...x, objects: [...x.objects] }));
      if (method === 'resourceSet.create') sets.push({ id: `set-${sets.length + 1}`, name: params.name, objects: [...params.objects] });
      if (method === 'resourceSet.addObject') sets.find((x) => x.id === params.id)?.objects.push(params.object);
      // AS XEN ORCHESTRA DOES: a cloud-init drive goes on the storage of the
      // VM's first disk, so one asked for with none is refused, in its words;
      // and a VM made from a template gets a copy of each of its disks, on
      // the storage that disk is on.
      if (method === 'vm.create') {
        if (params.cloudConfig != null && !(params.VDIs || []).length) throw new Error("Can't create cloud init config drive for VM without disks");
        const id = params.tags.includes(VM_IMAGE.baseTag) ? 'base-vm' : 'build-vm';
        for (const d of disks.filter((x) => x.vm === params.template)) disks.push({ vm: id, vdi: `${id}-copy`, name: 'disk', sr: d.sr });
        return id;
      }
      if (method === 'vm.attachDisk') disks.push({ vm: params.vm, vdi: params.vdi, name: 'disk', sr: 'sr-1' });
      if (method === 'vm.createCloudInitConfigDrive') disks.push({ vm: params.vm, vdi: 'cfg-1', name: CONFIG_DRIVE_NAME, sr: params.sr });
      if (method === 'vdi.delete') {
        const i = disks.findIndex((d) => d.vdi === params.id);
        if (i >= 0) disks.splice(i, 1);
      }
      return true;
    },
  };
  const objects = {
    VBD: () => disks.map((d) => ({ type: 'VBD', id: `vbd-${d.vdi}`, VM: d.vm, VDI: d.vdi, is_cd_drive: false })),
    VDI: () => disks.map((d) => ({ type: 'VDI', id: d.vdi, name_label: d.name, $SR: d.sr })),
  };
  return { admin, calls, sr, disks, objects, sets };
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
  addressesOf: async () => ['203.0.113.7'],
  getAgent: async () => AGENT,
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
  const order = p.calls.map((c) => c.method).filter((m) => m !== 'xo.getAllObjects' && m !== 'resourceSet.getAll');
  assert.deepEqual(order, ['disk.import', 'vm.create', 'vm.attachDisk', 'vm.convertToTemplate', 'resourceSet.create', 'vm.create', 'disk.resize', 'vm.createCloudInitConfigDrive', 'vm.start', 'vdi.delete', 'vm.set', 'tag.remove', 'tag.add', 'tag.add', 'tag.add', 'vm.convertToTemplate', 'resourceSet.addObject', 'resourceSet.addObject']);
  // THE DISK AS PUBLISHED IS KEPT, never booted and offered to nothing, and
  // the build is a copy of it.
  const [keptCreate, create] = p.calls.filter((c) => c.method === 'vm.create').map((c) => c.params);
  assert.deepEqual(keptCreate.tags, [VM_IMAGE.baseTag, `${VM_IMAGE.baseTag}:debian-13:${DEBIAN_IMAGE.build}`]);
  assert.deepEqual(keptCreate.VIFs, [], 'it never boots and is on no network');
  assert.deepEqual(/** @type {any} */ (p.calls.find((c) => c.method === 'vm.attachDisk')).params, { vm: 'base-vm', vdi: 'vdi-1', bootable: true, position: '0' });
  assert.equal(create.template, 'base-vm');
  assert.deepEqual(create.VIFs, [{ network: 'net-uplink' }], 'built behind the edge router');
  // The install reaches the VM on a drive made once its disk is there, on that
  // disk's storage; and it is gone before the VM is a template.
  assert.deepEqual(/** @type {any} */ (p.calls.find((c) => c.method === 'vm.createCloudInitConfigDrive')).params, { vm: 'build-vm', sr: 'sr-1', config: buildCloudConfig({ coordinatorUrl: 'https://fleet.test', agent: gzipSync(AGENT).toString('base64') }) });
  assert.deepEqual(/** @type {any} */ (p.calls.find((c) => c.method === 'vdi.delete')).params, { id: 'cfg-1' });
  assert.deepEqual(p.disks.filter((d) => d.vm === 'build-vm').map((d) => d.vdi), ['build-vm-copy'], 'the template keeps its own disk and nothing else');
  assert.deepEqual(/** @type {any} */ (p.calls.find((c) => c.method === 'disk.resize')).params, { id: 'build-vm-copy', size: VM_IMAGE.diskSize }, 'the copy grows, the kept disk stays as published');
  // RAW, READ OUT OF THE DOWNLOAD: the pool takes no compressed qcow2
  // (Compressed_unsupported on a real pool), so what Xen Orchestra is sent is
  // the raw disk, the same bytes qemu-img reads out of it, at its length.
  assert.equal(/** @type {any} */ (p.calls.find((c) => c.method === 'disk.import')).params.type, 'iso');
  assert.equal(p.uploaded.size, DOWNLOADED_RAW.size);
  assert.equal(p.uploaded.body.length, DOWNLOADED_RAW.size);
  assert.equal(createHash('sha256').update(p.uploaded.body).digest('hex'), DOWNLOADED_RAW.sha256);
  assert.deepEqual(p.calls.filter((c) => c.method === 'tag.add').map((c) => c.params), [{ id: 'build-vm', tag: VM_IMAGE.tag }, { id: 'build-vm', tag: 'fleetwright-image:debian-13' }, { id: 'build-vm', tag: 'fleetwright-channel:stable' }]);
  assert.deepEqual(p.sets.find((x) => x.name === 'fleetwright')?.objects, ['build-vm'], 'the kept disk is the fleet’s to clone, or the image is not');
  assert.deepEqual(p.sets.find((x) => x.name === 'fleetwright-made')?.objects, ['base-vm', 'build-vm'], 'what the job made is not on its list, so no build would trust it');
  assert.ok(said.some((s) => /Installing Fleetwright on the machine image/.test(s)));

  const there = buildPool({ then: 'Halted', existing: [{ type: 'VM-template', id: 'img', name_label: 'Fleetwright Debian 13', $pool: 'pool-1', tags: [VM_IMAGE.tag] }] });
  assert.match(await ensureImage(buildArgs(there)), /already there on rack/);
  assert.ok(!there.calls.some((c) => c.method === 'disk.import'));
});

// BUILT FROM MAIN. ASKED FOR: "Or should we build a path for the images to
// use main/rolling?" The suite is written into the apt line every clone keeps,
// so it decides what the pool's machines update along, not only what the image
// starts with (docs/hypervisors.md, "Built from main").
test('an image built from main installs from the rolling suite, is tagged so, and says so', async () => {
  const config = buildCloudConfig({ coordinatorUrl: 'https://fleet.test', channel: 'rolling' });
  assert.match(config, /https:\/\/fleet-apt.thetech.network rolling main" >\/etc\/apt\/sources.list.d\/fleetwright.list/);
  assert.ok(!config.includes('fleet-apt.thetech.network stable main'), 'both suites in one line set');
  assert.throws(() => buildCloudConfig({ coordinatorUrl: 'https://fleet.test', channel: 'main; reboot' }), /not a suite/, 'the suite is never a way into the script');

  const p = buildPool({ then: 'Halted' });
  const text = await ensureImage({ ...buildArgs(p), channel: 'rolling' });
  assert.ok(p.calls.some((c) => c.method === 'tag.add' && c.params.tag === 'fleetwright-channel:rolling'));
  assert.match(/** @type {any} */ (p.calls.find((c) => c.method === 'vm.createCloudInitConfigDrive')).params.config, / rolling main"/);
  assert.match(text, /with Fleetwright installed from the newest build of main/);
  await assert.rejects(ensureImage({ ...buildArgs(buildPool({ then: 'Halted' })), channel: 'nightly' }), /not a suite/);
});

test('the suite is chosen per build: an image kept says what it was built from, and a rebuild not told keeps it', async () => {
  const rolling = { type: 'VM-template', id: 'img', name_label: 'Fleetwright Debian 13', $pool: 'pool-1', tags: [VM_IMAGE.tag, 'fleetwright-image:debian-13', 'fleetwright-channel:rolling'] };
  // Kept, asked for the other: nothing is built, and it says how to change it.
  const kept = buildPool({ then: 'Halted', existing: [rolling] });
  const text = await ensureImage({ ...buildArgs(kept), channel: 'stable' });
  assert.match(text, /already there on rack: Fleetwright Debian 13\. It was built from the newest build of main; rebuild it to build it from released versions\./);
  assert.ok(!kept.calls.some((c) => c.method === 'vm.createCloudInitConfigDrive'));
  // Kept, asked for the same, or not asked: no second sentence.
  assert.doesNotMatch(await ensureImage({ ...buildArgs(buildPool({ then: 'Halted', existing: [rolling] })), channel: 'rolling' }), /rebuild it/);
  // A rebuild from a phone that predates the choice keeps the suite it had.
  const again = buildPool({ then: 'Halted', existing: [rolling] });
  await ensureImage({ ...buildArgs(again), replace: true });
  assert.match(/** @type {any} */ (again.calls.find((c) => c.method === 'vm.createCloudInitConfigDrive')).params.config, / rolling main"/);
  // And an image from before the choice was built from stable, the only suite.
  assert.equal(imageChannelOf({ tags: [VM_IMAGE.tag] }), 'stable');
});

test('a Xen Orchestra without disk.resize grows the image’s disk through vdi.set, with the same id and size', async () => {
  // SEEN ON A REAL ONE: "this Xen Orchestra does not offer disk.resize, so
  // the machine image cannot be built".
  const p = buildPool({ then: 'Halted' });
  await ensureImage({ ...buildArgs(p), resize: 'vdi.set' });
  assert.ok(!p.calls.some((c) => c.method === 'disk.resize'));
  assert.deepEqual(/** @type {any} */ (p.calls.find((c) => c.method === 'vdi.set')).params, { id: 'build-vm-copy', size: VM_IMAGE.diskSize });
});

// THE DISK AS PUBLISHED, KEPT. ASKED FOR: "Rebuilding machines why don’t we
// have cached copies?" Each build used to send the whole disk from this box
// through Xen Orchestra to the pool's storage again (vm-image.js, baseOf).
const KEPT_TAG = `${VM_IMAGE.baseTag}:debian-13:${DEBIAN_IMAGE.build}`;

test('a rebuild starts from the disk kept on that storage: nothing is downloaded or sent, and only the copy grows', async () => {
  const p = buildPool({ then: 'Halted', existing: [OLD], kept: [{ id: 'kept-1', tags: [VM_IMAGE.baseTag, KEPT_TAG] }] });
  /** @type {string[]} */
  const said = [];
  const text = await ensureImage({
    ...buildArgs(p),
    replace: true,
    getImage: /** @type {any} */ (async () => assert.fail('downloaded although a copy was kept')),
    say: (t) => said.push(t),
  });
  assert.match(text, /rebuilt on rack/);
  assert.ok(!p.calls.some((c) => c.method === 'disk.import'), 'no disk sent through Xen Orchestra');
  const creates = p.calls.filter((c) => c.method === 'vm.create').map((c) => c.params);
  assert.deepEqual(creates.map((c) => c.template), ['kept-1'], 'one VM, the build, made from the kept disk');
  assert.deepEqual(/** @type {any} */ (p.calls.find((c) => c.method === 'disk.resize')).params, { id: 'build-vm-copy', size: VM_IMAGE.diskSize });
  assert.ok(!p.calls.some((c) => c.params?.id === 'kept-1'), 'the kept disk is not touched');
  assert.ok(said.some((s) => /^Debian 13 is already on Local storage, kept from an earlier build, so the machine image starts from a copy of it\.$/.test(s)));
});

test('a kept disk is used only on its own storage and for its own build, and an older build’s goes once a newer one is kept', async () => {
  const p = buildPool({
    then: 'Halted',
    kept: [
      { id: 'kept-elsewhere', sr: 'sr-2', tags: [VM_IMAGE.baseTag, KEPT_TAG] },
      { id: 'kept-older', tags: [VM_IMAGE.baseTag, `${VM_IMAGE.baseTag}:debian-13:20250901-0000`] },
    ],
  });
  await ensureImage(buildArgs(p));
  assert.ok(p.calls.some((c) => c.method === 'disk.import'), 'a copy on other storage would not be a fast clone here, and an older build is not this one');
  assert.equal(/** @type {any} */ (p.calls.filter((c) => c.method === 'vm.create')[1]).params.template, 'base-vm');
  assert.deepEqual(p.calls.filter((c) => c.method === 'vm.delete').map((c) => c.params), [{ id: 'kept-older', deleteDisks: true }], 'the older build’s, and not the one kept on the other storage');
});

test('the image starts from XCP-ng’s own template and not one that only shares its name, and its build VM with two disks grows neither', async () => {
  const named = { type: 'VM-template', id: 'tpl-named', name_label: VM_IMAGE.template, $pool: 'pool-1', tags: [], isDefaultTemplate: false, $VBDs: [] };
  const p = buildPool({ then: 'Halted', named: [named] });
  await ensureImage(buildArgs(p));
  assert.equal(/** @type {any} */ (p.calls.find((c) => c.method === 'vm.create')).params.template, 'other-media', 'made from a template that only has the name');

  const two = buildPool({ then: 'Halted', kept: [{ id: 'kept-1', tags: [VM_IMAGE.baseTag, `${VM_IMAGE.baseTag}:debian-13:${DEBIAN_IMAGE.build}`] }] });
  two.disks.push({ vm: 'build-vm', vdi: 'build-vm-second', name: 'disk', sr: 'sr-1' });
  await assert.rejects(ensureImage(buildArgs(two)), /build VM came from the kept Debian 13 with 2 disks where it has one, so none was grown and it was not started/);
  assert.ok(!two.calls.some((c) => c.method === 'disk.resize' || c.method === 'vm.start'), 'a disk was grown, or the VM started');
});

test('a kept disk is used only when the job’s own list says it made it, and anything else is passed over for the checked download and left alone', async () => {
  for (const [what, kept, spoil] of /** @type {Array<[string, any, (p: ReturnType<typeof buildPool>) => void]>} */ ([
    ['carrying the tag and on no list', { recorded: false }, () => {}],
    ['made in a resource set, as the fleet’s user makes its VMs', { resourceSet: 'set-1' }, () => {}],
    ['in the fleet’s own set, where its token reaches it', {}, (p) => void p.sets[0].objects.push('kept-1')],
  ])) {
    const p = buildPool({
      then: 'Halted',
      kept: [
        { id: 'kept-1', tags: [VM_IMAGE.baseTag, KEPT_TAG], ...kept },
        { id: 'kept-older', tags: [VM_IMAGE.baseTag, `${VM_IMAGE.baseTag}:debian-13:20250901-0000`], recorded: false },
      ],
    });
    spoil(p);
    await ensureImage(buildArgs(p));
    assert.ok(p.calls.some((c) => c.method === 'disk.import'), `${what}: the download was skipped`);
    assert.deepEqual(p.calls.filter((c) => c.method === 'vm.create').map((c) => c.params.template), ['other-media', 'base-vm'], `${what}: built from it`);
    assert.ok(!p.calls.some((c) => c.method === 'vm.delete'), `${what}: removed something the job did not make`);
  }
});

test('a build that reboots failed, and its VM is kept stopped, named for what happened', async () => {
  const p = buildPool({ then: 'rebooted' });
  await assert.rejects(ensureImage(buildArgs(p)), /did not install on the machine image, and it did not send its log back/);
  assert.ok(p.calls.some((c) => c.method === 'vm.stop' && c.params.id === 'build-vm'));
  assert.ok(p.calls.some((c) => c.method === 'vm.set' && /install failed/.test(c.params.name_label)));
  assert.ok(!p.calls.some((c) => c.method === 'vm.delete'), 'kept, for its log');
  assert.ok(!p.calls.some((c) => c.method === 'vm.convertToTemplate' && c.params.id === 'build-vm'));
});

test('a build VM’s reports are what the phone is told, and a failure it reports ends the build at once with its log', async () => {
  // ASKED FOR: "Or script call back something so we get it in the app",
  // after a real build sat at "18 min so far, usually about 8".
  const p = buildPool({ then: 'Running' });
  const MB = 1024 ** 2;
  const at = Date.now();
  const reports = [
    null,
    { step: 'packages', detail: null, at },
    { step: 'installer', detail: null, at },
    { step: 'image', detail: null, got: 0, of: 262 * MB, at },
    { step: 'image', detail: null, got: 131 * MB, of: 262 * MB, at },
    { step: 'image', detail: null, got: 268 * MB, of: 262 * MB, at },
    { step: 'failed', detail: 'Get:1 deb.debian.org\nE: Unable to fetch some archives', at },
  ];
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
  const config = /** @type {any} */ (p.calls.find((c) => c.method === 'vm.createCloudInitConfigDrive')).params.config;
  assert.ok(config.includes(REPORT_TOKEN), 'the VM is given its token');
  assert.ok(config.includes("pinned='fleet.test:443:203.0.113.7'"), 'and the coordinator’s address, as this box looked it up');
  assert.ok(config.includes(`    content: ${gzipSync(AGENT).toString('base64')}`), 'and the guest agent the box fetched');
  const install = shown.filter((s) => s.text.startsWith('Installing Fleetwright on the machine image:'));
  assert.match(install[0].text, /installing Debian’s packages, 1 min so far\./);
  assert.match(install[1].text, /: installing Fleetwright, 1 min so far\./);
  // ASKED FOR: "What's it doing here I feel like we can give a better sense
  // of status", of a phone that said "installing Fleetwright and fetching
  // the session image, 10 min so far" over a bar pinned at 91%.
  assert.match(install[2].text, /: fetching the session image: 0 of 262 MB, 1 min so far\./, 'its size, before a byte of it');
  assert.match(install[3].text, /: fetching the session image: 131 of 262 MB, 1 min so far\./);
  assert.match(install[4].text, /: fetching the session image: all 262 MB are in and being unpacked, 1 min so far\./, 'past its size is the network’s overhead, and done');
  for (let i = 1; i < install.length; i++) assert.ok(install[i].fill > install[i - 1].fill, `${install[i].text} moves the bar on`);
  assert.ok(install[3].fill - install[2].fill > install[1].fill - install[0].fill, 'the pull, most of the time, is most of the bar');
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
  assert.ok(shown.some((s) => /4 min so far, and its VM has not reported in\. It may have no network, or its start-up script did not run\./.test(s)));
  assert.match(String(err), /did not finish within 25 minutes, and its VM never reported in.*kept, stopped, as "fleetwright-image-build \(install timed out\)"/);
  assert.ok(p.calls.some((c) => c.method === 'vm.stop' && c.params.id === 'build-vm'));
  assert.ok(!p.calls.some((c) => c.method === 'vm.delete'), 'kept, where a timeout used to delete it');
});

test('a build VM that halts without saying it finished is kept, named for it, and never made the template', async () => {
  // THE BUG: the install powers the VM off when every step worked, and the
  // build took any halt for that. A host rebooted for maintenance, a VM
  // stopped from Xen Orchestra, an install cut off mid-step: each became the
  // image every session was cloned from. Found by a review that ran it.
  const p = buildPool({ then: 'Halted' });
  let at = 0;
  const err = await ensureImage({
    ...buildArgs(p),
    reporter: async () => REPORT_TOKEN,
    now: () => at,
    sleep: async () => { at += 10_000; },
  }).catch((e) => e);
  assert.match(String(err), /build VM stopped before it said the install was done \(it never reported in\), so it was not made the template\. rack still has no Debian 13 machine image\. Its build VM was kept, stopped, as "fleetwright-image-build \(stopped before done\)"/);
  assert.ok(!p.calls.some((c) => c.method === 'vm.convertToTemplate' && c.params.id === 'build-vm'), 'a half-built VM became the template');
  assert.ok(!p.calls.some((c) => c.method === 'vm.delete'), 'kept, to be looked at');
  // TWO MINUTES for a late done, which comes by way of the coordinator: a
  // build on a Raspberry Pi that had said every step through cleaning was
  // failed at the thirty seconds this used to wait.
  assert.ok(at >= 20_000 + 120_000, `given two minutes for a late done first, not ${(at - 20_000) / 1000} s`);

  // Cut off after a step it had reported: that step is named, and how long
  // before the halt it was said, so a VM that died mid-step (seconds) reads
  // differently from one whose last report never got through (minutes).
  const q = buildPool({ then: 'Halted' });
  at = 0;
  const cut = await ensureImage({
    ...buildArgs(q), reporter: async () => REPORT_TOKEN, now: () => at, sleep: async () => { at += 10_000; },
    vmReport: () => ({ step: 'installer', detail: null, at: 10_000 }),
  }).catch((e) => e);
  assert.match(String(cut), /stopped before it said the install was done \(the last it said, 10 seconds before it stopped, was that installing Fleetwright\)/);
  assert.ok(!q.calls.some((c) => c.method === 'vm.convertToTemplate' && c.params.id === 'build-vm'));

  // A REBUILD THAT STOPS SO says the image that was there still is, and that
  // machines keep being made from it: the person whose Apply failed this
  // way had no word on whether the pool still had an image at all. A report
  // without a time, from before times were kept, says nothing about one.
  const r = buildPool({ then: 'Halted', existing: [{ type: 'VM-template', id: 'img', name_label: 'Fleetwright Debian 13', $pool: 'pool-1', tags: [VM_IMAGE.tag] }] });
  at = 0;
  const kept = await ensureImage({
    ...buildArgs(r), replace: true, reporter: async () => REPORT_TOKEN, now: () => at, sleep: async () => { at += 10_000; },
    vmReport: () => ({ step: 'cleaning', detail: null }),
  }).catch((e) => e);
  assert.match(String(kept), /\(the last it said was that clearing what would make two machines cloned from it the same\), so it was not made the template\. The Debian 13 machine image that was there, Fleetwright Debian 13, is still the template, and machines keep being made from it\. Its build VM was kept/);
  assert.ok(!r.calls.some((c) => c.method === 'vm.delete' && c.params.id === 'img'), 'the image that was there was removed');
});

test('a build VM whose done report lands after Xen Orchestra already said Halted is still the template', async () => {
  // The VM reports done just before it powers off; the report can arrive
  // after the halt, and it comes by way of the coordinator, which forwards
  // it when it next speaks to the box. Here it lands 90 seconds after the
  // halt was seen (at 20 s): within the two minutes waited now, and past
  // the thirty seconds that failed a real build.
  const p = buildPool({ then: 'Halted' });
  let at = 0;
  const text = await ensureImage({
    ...buildArgs(p),
    reporter: async () => REPORT_TOKEN,
    now: () => at,
    sleep: async () => { at += 10_000; },
    vmReport: () => (at >= 110_000 ? { step: 'done', detail: null, at } : { step: 'cleaning', detail: null, at: 10_000 }),
  });
  assert.match(text, /machine image is ready on rack/);
  assert.ok(p.calls.some((c) => c.method === 'vm.convertToTemplate' && c.params.id === 'build-vm'));
  assert.ok(!p.calls.some((c) => c.method === 'vm.set' && /stopped before/.test(c.params.name_label)));
});

test('a build VM that said a step and then nothing for three minutes is said to have gone quiet, with what it last said and when', async () => {
  // THE FROZEN BAR: "started, 12 min so far" on a phone, with no warning,
  // because the box only warned of a VM that had never reported. The VM now
  // says its step again every minute (heartbeat), so silence is news.
  const p = buildPool({ then: 'Running' });
  let at = 0;
  /** @type {string[]} */
  const shown = [];
  await ensureImage({
    ...buildArgs(p),
    reporter: async () => REPORT_TOKEN,
    now: () => at,
    sleep: async () => { at += 60_000; },
    vmReport: () => (at >= 60_000 ? { step: 'packages', detail: null, at: 60_000 } : null),
    say: (text) => shown.push(text),
  }).catch(() => {});
  assert.ok(shown.some((s) => /: installing Debian’s packages, 1 min so far\./.test(s)), 'the step, while it is fresh');
  assert.ok(shown.some((s) => /: installing Debian’s packages, 3 min so far\./.test(s)), 'three minutes is still within what a slow step takes');
  assert.ok(shown.some((s) => /: its VM last said that installing Debian’s packages, 4 min ago, and nothing since\. 5 min so far\./.test(s)), `nothing said that it had gone quiet: ${shown.join('\n')}`);
});

test('the install script says its step again every minute, so a box can tell silence from a slow step, and says nothing more once it is done', () => {
  const calls = runImageScript({ beat: 0.05, slow: true });
  const sent = calls.filter((c) => c.startsWith('report '));
  assert.ok(sent.filter((c) => c === 'report packages').length >= 2, `packages said again while apt-get ran: ${sent.join(', ')}`);
  assert.ok(sent.slice(sent.lastIndexOf('report done') + 1).length === 0 && sent.at(-1) === 'report done', 'the heartbeat outlived the build');
  assert.equal(calls.at(-1), 'systemctl poweroff');
});

test('the done report is tried for five minutes until it is heard, each answer on the VM’s screen, and a VM with no token powers off at once', () => {
  // A VM that halts without a heard `done` is not made the template, so the
  // one report that decides the build is worth five minutes of trying: a
  // build on a Raspberry Pi had its six tries go unanswered and powered off
  // into "stopped before done" with nothing anywhere about why. What each
  // report was answered now goes on the log and the console Xen Orchestra
  // shows, which is the one place a person can read it from a kept VM.
  /** @type {string[]} */
  const log = [];
  const deaf = runImageScript({ deaf: true, log });
  assert.equal(deaf.filter((c) => c === 'report done').length, 30, 'thirty tries, ten seconds apart');
  assert.equal(deaf.filter((c) => c === 'sleep 10').length, 30);
  assert.equal(deaf.at(-1), 'systemctl poweroff', 'and it still powers off, kept for the box to look at');
  assert.equal(log.filter((l) => l === 'report done: no answer').length, 30, `nothing spoke HTTP back, and the screen says so: ${log.join(' | ')}`);
  // A fleet that answers and refuses, as a front door does with 429, is told
  // apart from one that cannot be reached, and a refusal is not "sent".
  /** @type {string[]} */
  const refused = [];
  const turnedAway = runImageScript({ deaf: 429, log: refused });
  assert.equal(turnedAway.filter((c) => c === 'report done').length, 30, 'a refusal is not heard');
  assert.ok(refused.includes('report cleaning: 429') && refused.filter((l) => l === 'report done: 429').length === 30, refused.join(' | '));
  /** @type {string[]} */
  const fine = [];
  const heard = runImageScript({ log: fine });
  assert.equal(heard.filter((c) => c === 'report done').length, 1);
  assert.deepEqual(fine.filter((l) => /^report (started|done)/.test(l)), ['report started: 200', 'report done: 200']);
  assert.equal(runImageScript({ token: null }).filter((c) => c === 'sleep 10').length, 0);
});

// --- rebuilt and removed ----------------------------------------------------
//
// ASKED FOR: "There is no rebuild button or delete button", on a pool whose
// three images were built before the install script stopped at its first
// failure, so any of them may be one that should not have become a template.

const OLD = { type: 'VM-template', id: 'img-old', name_label: 'Fleetwright Debian 13', $pool: 'pool-1', tags: [VM_IMAGE.tag, 'fleetwright-image:debian-13'] };
const CLONE = { type: 'VM', id: 'vm-a', $pool: 'pool-1', tags: [`${VM_IMAGE.fromPrefix}img-old`] };

test('a template that only carries the image’s tags is not the image: it is not left as one, put in the set, retired or removed, and one is built', async () => {
  const planted = { ...OLD, id: 'img-planted' };
  // On no list of the fleet's; or in its set, but made in it, as the fleet's own user makes VMs.
  for (const [what, template, inSet] of /** @type {Array<[string, any, boolean]>} */ ([
    ['on no list', planted, false],
    ['made in the fleet’s set', { ...planted, resourceSet: 'set-1' }, true],
  ])) {
    const p = buildPool({ then: 'Halted', existing: [template] });
    if (!inSet) p.sets[0].objects = [];
    for (const replace of [false, true]) {
      const text = await ensureImage({ ...buildArgs(p), replace });
      assert.match(text, /machine image is ready on rack/, `${what}, replace ${replace}: ${text}`);
    }
    assert.ok(!p.calls.some((c) => c.params?.id === 'img-planted' || c.params?.object === 'img-planted'), `${what}: ${JSON.stringify(p.calls.filter((c) => c.params?.id === 'img-planted' || c.params?.object === 'img-planted'))}`);
  }
  const gone = buildPool({ then: 'Halted', existing: [planted] });
  gone.sets[0].objects = [];
  assert.match(await removeImage({ admin: gone.admin, pool: 'pool-1', poolName: 'rack', image: 'debian-13' }), /already gone/);
  assert.ok(!gone.calls.some((c) => c.method === 'vm.delete'), 'an admin’s session deleted a template because somebody else tagged it');
});

test('a guest agent the box cannot get does not stop the build, and the phone is told what it goes without', async () => {
  const p = buildPool({ then: 'Halted' });
  /** @type {string[]} */
  const said = [];
  const text = await ensureImage({
    ...buildArgs(p),
    getAgent: async () => {
      throw new Error('the Xen guest agent image downloaded with SHA-256 0000…, not the published aa2e…, so it was not used');
    },
    say: (t) => said.push(t),
  });
  assert.match(text, /machine image is ready on rack/);
  assert.ok(said.some((s) => /^Installing Fleetwright on the machine image, its disk on .*\. It goes without the Xen guest agent, so Xen Orchestra will not show its address: the Xen guest agent image downloaded with SHA-256 0000/.test(s)));
  const config = /** @type {any} */ (p.calls.find((c) => c.method === 'vm.createCloudInitConfigDrive')).params.config;
  assert.ok(!config.includes('encoding: gz+b64'), 'nothing that failed its check is written');
});

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
  const gone = buildPool({ then: 'Halted', existing: [OLD], kept: [{ id: 'kept-1', tags: [VM_IMAGE.baseTag, KEPT_TAG] }] });
  assert.match(await removeImage({ admin: gone.admin, pool: 'pool-1', poolName: 'rack', image: 'debian-13' }), /removed from rack\. New session no longer offers it\./);
  assert.deepEqual(gone.calls.filter((c) => c.method === 'vm.delete').map((c) => c.params), [{ id: 'kept-1', deleteDisks: true }, { id: 'img-old', deleteDisks: true }], 'its kept disk goes with it');

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

// A POOL'S PAGE FROM AWAY: the box reads what the phone would have, for a
// phone that cannot reach the pool. docs/manage.md, "From away".

const PAGE_VM = {
  type: 'VM',
  id: '2d3e4f50-6172-4384-9596-a7b8c9d0e1f2',
  name_label: 'web',
  $pool: 'pool-1',
  $container: 'host-1',
  power_state: 'Running',
  CPUs: { number: 2, max: 4 },
  memory: { size: 4 * 2 ** 30, static: [1, 2] },
  addresses: { '0/ipv4/0': '10.0.0.5', '0/ipv6/0': 'fe80::1' },
  managementAgentDetected: true,
  tags: ['private'],
  boot: { order: 'cd' },
  other: { secret_note: 'kept off the page' },
};

/** @param {Parameters<typeof xo>[0]} [opts] */
function pageHolder(opts) {
  const stand = xo({ objects: [pool, PAGE_VM, image], methods: ['xo.getAllObjects', 'vm.start', 'vm.restart'], ...opts });
  const pools = holder(stand);
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  return { stand, pools };
}

test('a pool’s page is read under its owner’s token and sealed to the phone’s key, with only what the page draws', async () => {
  const { stand, pools } = pageHolder();
  const key = await newSealKey();
  const r = await pools.look({ owner: ELI, address: 'xo.lan', reply: key.publicKey });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(stand.calls[0], { method: 'session.signIn', params: { token: 'xo-limited-token' } });
  const page = await openSealed({ privateKey: key.privateKey, publicKey: key.publicKey, aad: xolookAad('xo.lan'), sealed: /** @type {any} */ (r.sealed) });
  assert.deepEqual(page.methods, ['xo.getAllObjects', 'vm.start', 'vm.restart']);
  assert.deepEqual(page.objects, [
    { id: 'pool-1', type: 'pool', name_label: 'rack' },
    {
      id: PAGE_VM.id,
      type: 'VM',
      name_label: 'web',
      $pool: 'pool-1',
      $container: 'host-1',
      power_state: 'Running',
      managementAgentDetected: true,
      CPUs: { number: 2 },
      addresses: { '0/ipv4/0': '10.0.0.5', '0/ipv6/0': 'fe80::1' },
      memory: { size: 4 * 2 ** 30 },
    },
  ], 'the pool and the VM as the page reads them; not the image, its tags, boot order or other config');
  await assert.rejects(
    openSealed({ privateKey: key.privateKey, publicKey: key.publicKey, aad: xolookAad('other.lan'), sealed: /** @type {any} */ (r.sealed) }),
    'the answer for one pool does not open as another’s',
  );
  assert.equal(stand.rpc.closed, true);
});

test('the pool’s own machine keeps the one tag that says so on its page, and no other', async () => {
  const own = { ...PAGE_VM, id: 'vm-holder', name_label: 'holder-c09fcd', tags: ['private', HOLDER.tag, `${HOLDER.forPrefix}xo.lan`] };
  const { pools } = pageHolder({ objects: [pool, PAGE_VM, own] });
  const key = await newSealKey();
  const r = await pools.look({ owner: ELI, address: 'xo.lan', reply: key.publicKey });
  const page = await openSealed({ privateKey: key.privateKey, publicKey: key.publicKey, aad: xolookAad('xo.lan'), sealed: /** @type {any} */ (r.sealed) });
  const byId = Object.fromEntries(page.objects.map((/** @type {any} */ o) => [o.id, o]));
  assert.deepEqual(byId['vm-holder'].tags, [HOLDER.tag], 'the phones offer it nothing, which they can tell only from this');
  assert.equal(byId[PAGE_VM.id].tags, undefined, 'any other VM still carries none');
});

test('a page whose methods cannot be read says cannot tell, and one too large for the fleet says so', async () => {
  let { pools } = pageHolder({ methods: undefined, fail: { 'system.getMethodsInfo': 'no such method' } });
  const key = await newSealKey();
  const r = await pools.look({ owner: ELI, address: 'xo.lan', reply: key.publicKey });
  const page = await openSealed({ privateKey: key.privateKey, publicKey: key.publicKey, aad: xolookAad('xo.lan'), sealed: /** @type {any} */ (r.sealed) });
  assert.equal(page.methods, null, 'null, which offers no action, and not an empty list');
  assert.equal(page.objects.length, 2, 'the objects are still read');

  const many = Array.from({ length: 4000 }, (_, i) => ({ ...PAGE_VM, id: `vm-${i}`, name_label: `machine ${i} `.repeat(12) }));
  ({ pools } = pageHolder({ objects: many }));
  const big = await pools.look({ owner: ELI, address: 'xo.lan', reply: key.publicKey });
  assert.equal(big.ok, false);
  assert.equal(big.sealed, undefined);
  assert.match(big.text, /^xo\.lan\u2019s page is \d+ KB, more than the fleet carries in one answer \(512 KB\)\. Open it from the pool\u2019s own network\.$/);
});

test('a page action is called under the owner’s token in the shape it takes, and nothing else is', async () => {
  const { stand, pools } = pageHolder();
  const args = JSON.stringify({ id: PAGE_VM.id, force: false });
  assert.deepEqual(await pools.act({ owner: ELI, address: 'xo.lan', method: 'vm.restart', args }), { ok: true, text: 'xo.lan did it.' });
  assert.deepEqual(stand.calls.map((c) => c.method), ['session.signIn', 'vm.restart']);
  assert.deepEqual(stand.calls[1].params, { id: PAGE_VM.id, force: false });

  // Held to the shape again here, whatever the coordinator checked.
  const extra = await pools.act({ owner: ELI, address: 'xo.lan', method: 'vm.restart', args: JSON.stringify({ id: PAGE_VM.id, deleteDisks: true }) });
  assert.deepEqual(extra, { ok: false, text: 'vm.restart takes no deleteDisks' });
  assert.deepEqual(stand.calls.length, 2, 'refused before signing in');

  // Xen Orchestra's own refusal is the answer, and a slow one is not a no.
  const refused = pageHolder({ fail: { 'vm.restart': 'not enough permissions' } });
  assert.deepEqual(await refused.pools.act({ owner: ELI, address: 'xo.lan', method: 'vm.restart', args }), { ok: false, text: 'xo.lan refused it: not enough permissions' });
  const slow = pageHolder({ fail: { 'vm.stop': 'Xen Orchestra did not answer vm.stop in time' } });
  const late = await slow.pools.act({ owner: ELI, address: 'xo.lan', method: 'vm.stop', args });
  assert.match(late.text, /had not finished within a minute\. It may still be doing it/);
});

test('a pool’s page is only its owner’s, and a box that cannot reach it sends the coordinator to the next', async () => {
  const { stand, pools } = pageHolder();
  const key = await newSealKey();
  assert.equal((await pools.look({ owner: 'sam@example.com', address: 'xo.lan', reply: key.publicKey })).notHere, true);
  assert.equal((await pools.act({ owner: 'sam@example.com', address: 'xo.lan', method: 'vm.start', args: JSON.stringify({ id: PAGE_VM.id }) })).notHere, true);
  assert.equal((await pools.look({ owner: ELI, address: 'other.lan', reply: key.publicKey })).notHere, true);
  assert.deepEqual(stand.calls, [], 'no sign-in with Eli’s token for anybody else');

  const down = new XoPools({ connect: /** @type {any} */ (async () => { throw new Error('ECONNREFUSED'); }) });
  down.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  const r = await down.look({ owner: ELI, address: 'xo.lan', reply: key.publicKey });
  assert.equal(r.unreachable, true);
  assert.equal(r.text, 'xo.lan could not be reached from here: ECONNREFUSED');
});

test('the key to a pool’s edge routers is kept with its token when it is whole, and the pool is held without it when it is not', () => {
  // docs/hypervisors.md, "Watching the edge routers": the phone keeps the
  // routers' key beside the token after a policy job.
  const edge = { key: 'k'.repeat(80), secret: 's'.repeat(80), pin: 'b'.repeat(64), routers: [{ name: 'fleetwright-edge', address: '192.168.1.40' }, { name: 'fleetwright-edge-b', address: 'nope' }, { name: 'other', address: '1.2.3.4' }] };
  const pools = holder(xo());
  pools.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record({ edge }) }, { name: 'hypervisor:other.lan', value: record({ address: 'other.lan', edge: { ...edge, secret: 'a:b' } }) }] }]);
  assert.deepEqual(pools.held.get(`${ELI} xo.lan`)?.record.edge, { key: edge.key, secret: edge.secret, pin: edge.pin, routers: [{ name: 'fleetwright-edge', address: '192.168.1.40' }, { name: 'fleetwright-edge-b', address: null }] });
  const other = pools.held.get(`${ELI} other.lan`);
  assert.ok(other, 'a pool whose router key is malformed is still held');
  assert.equal(other.record.edge, undefined);
});

test('a pool’s page asks for the method list and every object type at once, not one after another', async () => {
  // Seven round trips to Xen Orchestra, in turn, was the wait before a phone
  // away from the pool saw anything.
  const { stand, pools } = pageHolder();
  /** @type {Array<() => void>} */
  const waiting = [];
  const call = stand.rpc.call;
  let inFlight = 0;
  let most = 0;
  stand.rpc.call = async (/** @type {string} */ method, /** @type {any} */ params) => {
    if (method === 'session.signIn') return call(method, params);
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((r) => waiting.push(() => r(null)));
    inFlight--;
    return call(method, params);
  };
  const key = await newSealKey();
  const looking = pools.look({ owner: ELI, address: 'xo.lan', reply: key.publicKey });
  while (waiting.length < 7) await new Promise((r) => setImmediate(r));
  for (const go of waiting.splice(0)) go();
  const r = await looking;
  assert.equal(r.ok, true, r.text);
  assert.equal(most, 7, 'the method list and the six types were all asked before any answer came');
});

test('where the pool’s edge routers are is read from Xen Orchestra now, by their tag, a running one first', async () => {
  const edge = (/** @type {string} */ id, /** @type {string} */ ip, /** @type {string[]} */ tags, state = 'Running') => ({ type: 'VM', id, name_label: 'x', power_state: state, tags, addresses: { '0/ipv4/0': ip } });
  const { stand, pools } = pageHolder({
    objects: [
      pool,
      edge('old-a', '192.168.1.9', ['fleetwright-edge'], 'Halted'),
      edge('a', '192.168.1.40', ['fleetwright-edge', 'fleetwright-edge-node:0']),
      edge('b', '192.168.1.41', ['fleetwright-edge', 'fleetwright-edge-node:1']),
      edge('not-one', '192.168.1.99', []),
    ],
  });
  const got = await pools.edgeAddresses(`${ELI} xo.lan`);
  assert.deepEqual([...(got ?? new Map()).entries()], [['fleetwright-edge', '192.168.1.40'], ['fleetwright-edge-b', '192.168.1.41']]);
  assert.deepEqual(stand.calls[0], { method: 'session.signIn', params: { token: 'xo-limited-token' } }, 'under the person’s own token');
  assert.equal(stand.rpc.closed, true);
  assert.equal(await pools.edgeAddresses('sam@example.com xo.lan'), null, 'nobody else’s pool');
  stand.rpc.call = async () => {
    throw new Error('ECONNREFUSED');
  };
  assert.equal(await pools.edgeAddresses(`${ELI} xo.lan`), null, 'could not ask is null, never "has none"');
});
