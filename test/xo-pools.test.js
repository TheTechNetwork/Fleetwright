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
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { XoPools, poolRecord, machineCloudConfig } from '../src/fleet/host/xo-pools.js';
import { VM_IMAGE, buildCloudConfig, ensureImage, imageStorage, DEBIAN_IMAGE } from '../src/fleet/host/vm-image.js';
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
 * @param {{ objects?: any[], fail?: Record<string, string> }} [opts]
 */
function xo({ objects = [], fail = {} } = {}) {
  /** @type {Array<{ method: string, params: any }>} */
  const calls = [];
  const rpc = {
    closed: false,
    async call(/** @type {string} */ method, /** @type {any} */ params = {}) {
      calls.push({ method, params });
      if (fail[method]) throw new Error(fail[method]);
      if (method === 'session.signIn') return { id: 'u1', permission: 'none' };
      if (method === 'xo.getAllObjects') {
        const f = params.filter || {};
        return Object.fromEntries(objects.filter((o) => Object.entries(f).every(([k, v]) => o[k] === v)).map((o) => [o.id, o]));
      }
      if (method === 'vm.create') return 'new-vm-id';
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
  assert.deepEqual(pools.report(), [{ address: 'xo.lan', owner: ELI, reachable: null, pools: [], images: [] }], 'not looked at yet is cannot tell');
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
  assert.deepEqual(made.tags, [VM_IMAGE.sessionTag, `${VM_IMAGE.untilPrefix}${Math.floor(now / 1000) + 30 * 60}`]);
  const join = JSON.parse(/** @type {string} */ (made.cloudConfig.split('\n').find((/** @type {string} */ l) => l.trim().startsWith('{"v":1'))).trim());
  assert.deepEqual(join, { v: 1, coordinator: 'https://fleet.test', ticket: TICKET, owner: ELI, claude: CLAUDE, minutes: 30 });
  assert.match(made.cloudConfig, /fleetwright-vm-join, \/run\/fleetwright\/join.json/);

  // A refusal from the pool itself is not "unreachable": another box would hear the same.
  const full = holder(xo({ objects: [pool, image, uplink], fail: { 'vm.create': 'resource set limit exceeded' } }));
  full.adopt([{ email: ELI, items: [{ name: 'hypervisor:xo.lan', value: record() }] }]);
  await full.refresh();
  const refused = await full.make({ owner: ELI, template: IMAGE, ticket: TICKET, coordinatorUrl: 'https://fleet.test' });
  assert.equal(refused.ok, false);
  assert.equal(refused.unreachable, undefined);
  assert.match(refused.text, /limit exceeded/);
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
  assert.match(config, /&& systemctl poweroff \|\| systemctl reboot/);
  assert.match(config, /systemctl disable --now fleetwright-sidecar fleetwright/);
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
 * @param {{ then: 'Halted'|'rebooted', existing?: any[] }} o
 */
function buildPool({ then, existing = [] }) {
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
          const state = looks === 1 ? { power_state: 'Running', startTime: 100 } : then === 'Halted' ? { power_state: 'Halted' } : { power_state: 'Running', startTime: 200 };
          return { 'build-vm': { id: 'build-vm', ...state } };
        }
        return Object.fromEntries([base, ...existing].filter((o) => o.type === f.type).map((o) => [o.id, o]));
      }
      if (method === 'disk.import') return { $sendTo: '/upload/1' };
      if (method === 'vm.create') return 'build-vm';
      return true;
    },
  };
  return { admin, calls, sr };
}

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
  getImage: /** @type {any} */ (async () => '/nowhere/debian.tar.xz'),
  unpackImpl: /** @type {any} */ (() => ({})),
  upload: /** @type {any} */ (async (/** @type {any} */ o) => { o.onProgress?.(DEBIAN_IMAGE.rawSize, DEBIAN_IMAGE.rawSize); return 'vdi-1'; }),
  sleep: async () => {},
});

test('a build that powers off becomes the template, tagged, in the set; one already there is left alone', async () => {
  const p = buildPool({ then: 'Halted' });
  /** @type {string[]} */
  const said = [];
  const text = await ensureImage({ ...buildArgs(p), say: (t) => said.push(t) });
  assert.match(text, /machine image is ready on rack/);
  const order = p.calls.map((c) => c.method).filter((m) => m !== 'xo.getAllObjects');
  assert.deepEqual(order, ['disk.import', 'disk.resize', 'vm.create', 'vm.attachDisk', 'vm.start', 'vm.set', 'tag.remove', 'tag.add', 'vm.convertToTemplate', 'resourceSet.addObject']);
  const create = /** @type {any} */ (p.calls.find((c) => c.method === 'vm.create')).params;
  assert.deepEqual(create.VIFs, [{ network: 'net-uplink' }], 'built behind the edge router');
  assert.equal(/** @type {any} */ (p.calls.find((c) => c.method === 'disk.resize')).params.size, VM_IMAGE.diskSize);
  assert.deepEqual(/** @type {any} */ (p.calls.find((c) => c.method === 'tag.add')).params, { id: 'build-vm', tag: VM_IMAGE.tag });
  assert.deepEqual(/** @type {any} */ (p.calls.find((c) => c.method === 'resourceSet.addObject')).params, { id: 'set-1', object: 'build-vm' });
  assert.ok(said.some((s) => /Installing Fleetwright on the machine image/.test(s)));

  const there = buildPool({ then: 'Halted', existing: [{ type: 'VM-template', id: 'img', name_label: 'Fleetwright Debian 13', $pool: 'pool-1', tags: [VM_IMAGE.tag] }] });
  assert.match(await ensureImage(buildArgs(there)), /already there on rack/);
  assert.ok(!there.calls.some((c) => c.method === 'disk.import'));
});

test('a build that reboots failed, and its VM is kept stopped, named for what happened', async () => {
  const p = buildPool({ then: 'rebooted' });
  await assert.rejects(ensureImage(buildArgs(p)), /did not install on the machine image.*fleetwright-image.log/s);
  assert.ok(p.calls.some((c) => c.method === 'vm.stop' && c.params.id === 'build-vm'));
  assert.ok(p.calls.some((c) => c.method === 'vm.set' && /install failed/.test(c.params.name_label)));
  assert.ok(!p.calls.some((c) => c.method === 'vm.delete'), 'kept, for its log');
  assert.ok(!p.calls.some((c) => c.method === 'vm.convertToTemplate'));
});

test('cancelled mid-build, what was made is removed', async () => {
  const p = buildPool({ then: 'Halted' });
  const abort = new AbortController();
  const args = buildArgs(p);
  args.sleep = async () => { abort.abort(); };
  await assert.rejects(ensureImage({ ...args, signal: abort.signal }));
  assert.ok(p.calls.some((c) => c.method === 'vm.delete' && c.params.id === 'build-vm'));
});
