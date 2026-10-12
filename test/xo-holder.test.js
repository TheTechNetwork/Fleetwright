// A pool's own machine, from the box's side: the policy job cloning it onto
// the way out from the pool's machine image, the cloud-init it boots with,
// the pin it enrols with, and its health saying which pool it holds. The
// coordinator's half has its own tests (test/holder-coordinator.test.js).
//
//   node --test test/xo-holder.test.js
//
// ASKED FOR: "dedicated hypervisor VM on the pool (preferred holder; any LAN
// host is the fallback)". docs/hypervisors.md, "A machine of its own".

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HOLDER, ensureHolder, holderCloudConfig } from '../src/fleet/host/xo-holder.js';
import { checkPolicy } from '../src/fleet/host/xo-setup.js';
import { XoPools } from '../src/fleet/host/xo-pools.js';
import { VM_IMAGE } from '../src/fleet/host/vm-image.js';
import { enrolVmOnce, waitToBeLetIn } from '../src/fleet/host/vm-join.js';
import { keyHashOf, proofOf } from '../src/fleet/protocol/holder-join.js';
import { readAssignedName } from '../src/fleet/host/identity.js';
import { generateKeyPair } from '../src/fleet/crypto.js';

const GiB = 1024 ** 3;
const NAME = 'holder-0a1b2c';
const PIN = '123456';
const SECRET = 'ab'.repeat(32);
const debian = { type: 'VM-template', id: 'tpl-debian', name_label: 'Fleetwright Debian 13', $pool: 'p1', tags: [VM_IMAGE.tag, 'fleetwright-image:debian-13'] };
const ubuntu = { type: 'VM-template', id: 'tpl-ubuntu', name_label: 'Fleetwright Ubuntu', $pool: 'p1', tags: [VM_IMAGE.tag, 'fleetwright-image:ubuntu-24.04'] };

/** The admin's Xen Orchestra: objects by type, every call recorded. @param {any[]} objects */
function admin(objects) {
  /** @type {Array<[string, any]>} */
  const calls = [];
  return {
    calls,
    async call(/** @type {string} */ method, /** @type {any} */ params = {}) {
      calls.push([method, params]);
      if (method === 'xo.getAllObjects') return Object.fromEntries(objects.filter((o) => o.type === params.filter?.type).map((o) => [o.id, o]));
      return true;
    },
  };
}

/** @param {any} answer */
const pinner = (answer = { ok: true, pin: PIN, hostId: NAME }) => {
  const asked = { count: 0 };
  return { asked, askPin: async () => (asked.count++, answer) };
};

const spec = (/** @type {any} */ xo, /** @type {any} */ askPin) => ({
  admin: xo,
  pool: 'p1',
  egress: { id: 'net-lan', name: 'LAN' },
  address: 'xo.lan',
  coordinatorUrl: 'https://fleet.test/x',
  askPin,
});

test('a pool without one gets a machine from its Debian image, on the way out, outside the fleet’s set, booting with its pin', async () => {
  const xo = admin([debian, ubuntu]);
  const { asked, askPin } = pinner();
  const said = await ensureHolder(spec(xo, askPin));
  assert.equal(asked.count, 1);
  const [, made] = /** @type {[string, any]} */ (xo.calls.find(([m]) => m === 'vm.create'));
  assert.equal(made.template, 'tpl-debian', 'Debian where there is one');
  assert.equal(made.name_label, NAME, 'the name the pin is bound to');
  assert.deepEqual(made.VIFs, [{ network: 'net-lan' }], 'on the way out, where Xen Orchestra and the coordinator are');
  assert.deepEqual(made.tags, [HOLDER.tag, `${HOLDER.forPrefix}xo.lan`]);
  assert.ok(!made.tags.includes(VM_IMAGE.sessionTag), 'nothing the sweep removes by');
  assert.ok(!('resourceSet' in made), 'not one of the fleet’s machines, and not the limited user’s to remove');
  assert.equal(made.destroyCloudConfigVdiAfterBoot, true, 'the drive with the pin is gone once it has booted');
  assert.ok(made.cloudConfig.includes(`"pin":"${PIN}"`));
  assert.match(said, /Approve it under Machines/);
});

test('one already there is left alone, or started when it is off, and no pin is asked for', async () => {
  const running = { type: 'VM', id: 'vm-h', name_label: NAME, $pool: 'p1', power_state: 'Running', tags: [HOLDER.tag] };
  for (const [vm, call] of /** @type {Array<[any, string|null]>} */ ([[running, null], [{ ...running, power_state: 'Halted' }, 'vm.start']])) {
    const xo = admin([debian, vm]);
    const { asked, askPin } = pinner();
    await ensureHolder(spec(xo, askPin));
    assert.equal(asked.count, 0);
    assert.deepEqual(xo.calls.filter(([m]) => m !== 'xo.getAllObjects').map(([m]) => m), call ? [call] : []);
  }
});

test('no image to make it from, or no pin from the fleet, is a stop that says so, before anything is made', async () => {
  const bare = admin([]);
  const { asked, askPin } = pinner();
  await assert.rejects(ensureHolder(spec(bare, askPin)), /no machine image/);
  assert.equal(asked.count, 0, 'no pin spent on a pool with nothing to clone');
  for (const answer of [null, { ok: false, text: 'not your job' }, { ok: true, pin: PIN, hostId: 'build-server' }]) {
    const xo = admin([debian]);
    await assert.rejects(ensureHolder(spec(xo, pinner(answer).askPin)), /gave no pin/);
    assert.ok(!xo.calls.some(([m]) => m === 'vm.create'), JSON.stringify(answer));
  }
});

test('its cloud-init is its name and one join file with the pin, the name and the pool, and no ticket, owner or login', () => {
  const config = holderCloudConfig({ hostId: NAME, pin: PIN, coordinatorUrl: 'https://fleet.test/x', address: 'xo.lan' });
  assert.match(config, new RegExp(`^#cloud-config\\nhostname: ${NAME}\\n`));
  const join = JSON.parse(/** @type {string} */ (/content: \|\n {6}(\{.*\})/.exec(config)?.[1]));
  assert.deepEqual(join, { v: 1, coordinator: 'https://fleet.test', pin: PIN, hostId: NAME, holder: 'xo.lan' });
  assert.match(config, /fleetwright-vm-join, \/run\/fleetwright\/join.json/);
  assert.throws(() => holderCloudConfig({ hostId: 'build-server', pin: PIN, coordinatorUrl: 'https://fleet.test', address: 'xo.lan' }), /not a name/);
  assert.throws(() => holderCloudConfig({ hostId: NAME, pin: 'abc', coordinatorUrl: 'https://fleet.test', address: 'xo.lan' }), /not an enrolment pin/);
  const withSecret = JSON.parse(/** @type {string} */ (/content: \|\n {6}(\{.*\})/.exec(holderCloudConfig({ hostId: NAME, pin: PIN, coordinatorUrl: 'https://fleet.test', address: 'xo.lan', secret: SECRET }))?.[1]));
  assert.equal(withSecret.secret, SECRET, 'the phone’s secret, for the machine to ask to join with');
  assert.throws(() => holderCloudConfig({ hostId: NAME, pin: PIN, coordinatorUrl: 'https://fleet.test', address: 'xo.lan', secret: 'short' }), /not the secret/);
});

test('it enrols with its pin once, as a permanent host under the bound name, and dials under it after', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-holder-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'vm-join.json');
  const hostKeyFile = join(dir, 'host-key.json');
  writeFileSync(file, JSON.stringify({ v: 1, coordinator: 'https://fleet.test', pin: PIN, hostId: NAME, holder: 'xo.lan' }), { mode: 0o600 });
  const key = await generateKeyPair();
  /** @type {any[]} */
  const posted = [];
  const fetchImpl = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    posted.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, hostId: NAME, fingerprint: 'f' }), { status: 200 });
  });
  assert.equal(await enrolVmOnce({ file, origin: 'https://fleet.test', hostKeyFile, publicJwk: key.publicJwk, fetchImpl }), NAME);
  assert.equal(posted[0].url, 'https://fleet.test/api/enroll/host', 'a permanent host’s enrolment, not a temporary machine’s');
  assert.deepEqual([posted[0].body.code, posted[0].body.hostId], [PIN, NAME]);
  assert.equal(readAssignedName(hostKeyFile), NAME);
  assert.ok(!readFileSync(file, 'utf8').includes(PIN), 'the pin is gone from the file');
  assert.equal(await enrolVmOnce({ file, origin: 'https://fleet.test', hostKeyFile, publicJwk: key.publicJwk, fetchImpl }), null);
  assert.equal(posted.length, 1);
});

test('a pin is spent even when the fleet refuses it, and a name it was not bound to is not enrolled with at all', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-holder-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'vm-join.json');
  const key = await generateKeyPair();
  let calls = 0;
  const fetchImpl = /** @type {any} */ (async () => (calls++, new Response(JSON.stringify({ ok: false, text: 'that code has expired — mint another' }), { status: 403 })));
  writeFileSync(file, JSON.stringify({ v: 1, pin: PIN, hostId: NAME }), { mode: 0o600 });
  await assert.rejects(enrolVmOnce({ file, origin: 'https://fleet.test', hostKeyFile: join(dir, 'k.json'), publicJwk: key.publicJwk, fetchImpl }), /expired/);
  assert.ok(!readFileSync(file, 'utf8').includes(PIN));
  writeFileSync(file, JSON.stringify({ v: 1, pin: PIN, hostId: 'build-server' }), { mode: 0o600 });
  assert.equal(await enrolVmOnce({ file, origin: 'https://fleet.test', hostKeyFile: join(dir, 'k.json'), publicJwk: key.publicJwk, fetchImpl }), null);
  assert.equal(calls, 1);
});

test('its health says it holds the pool it was made for, and no other box’s does', () => {
  const record = JSON.stringify({ v: 1, address: 'xo.lan', pin: 'a'.repeat(64), token: 't' });
  const other = JSON.stringify({ v: 1, address: 'other.lan', pin: 'a'.repeat(64), token: 't' });
  const items = [{ name: 'hypervisor:xo.lan', value: record }, { name: 'hypervisor:other.lan', value: other }];
  const mine = new XoPools({ holderFor: 'xo.lan' });
  mine.adopt([{ email: 'eli@example.com', items }]);
  assert.deepEqual(mine.report().map((e) => [e.address, e.holder === true]), [['xo.lan', true], ['other.lan', false]]);
  const laptop = new XoPools({});
  laptop.adopt([{ email: 'eli@example.com', items }]);
  assert.ok(laptop.report().every((e) => !e.holder));
});

test('the policy asks for one only on a way out, from an image there or built with it', () => {
  const choices = {
    srs: new Map([['sr1', 100 * GiB]]),
    networks: new Set(['n1', 'n2']),
    capacity: { cpus: 8, memory: 32 * GiB },
    networkPools: new Map([['n1', 'p1'], ['n2', 'p2']]),
    edgePools: new Set(['p1']),
    imageKeys: new Set(['debian-13']),
    imagePools: new Set(['p1']),
  };
  const base = { v: 1, srs: ['sr1'], networks: ['n1'], limits: { cpus: 2, memory: 4 * GiB, disk: 20 * GiB } };
  const ok = checkPolicy({ ...base, egress: 'n1', holder: true }, /** @type {any} */ (choices));
  assert.equal(ok.ok && ok.policy.holder, true, 'p1 has an image');
  assert.match(/** @type {any} */ (checkPolicy({ ...base, egress: null, holder: true }, /** @type {any} */ (choices))).text, /goes on the way out/);
  assert.match(/** @type {any} */ (checkPolicy({ ...base, egress: 'n2', holder: true }, /** @type {any} */ (choices))).text, /has none yet/);
  const built = checkPolicy({ ...base, egress: 'n2', edge: true, images: ['debian-13'], holder: true }, /** @type {any} */ (choices));
  assert.equal(built.ok && built.policy.holder, true, 'an image built with it will do');
  const old = checkPolicy({ ...base, egress: 'n1' }, /** @type {any} */ (choices));
  assert.equal(old.ok && old.policy.holder, false, 'a phone that predates it asks for none');
  // THE SECRET AND MAKING IT AGAIN, only with the machine asked for.
  const asking = checkPolicy({ ...base, egress: 'n1', holder: true, holderSecret: SECRET, holderAgain: true }, /** @type {any} */ (choices));
  assert.deepEqual(asking.ok && [asking.policy.holderSecret, asking.policy.holderAgain], [SECRET, true]);
  assert.deepEqual(ok.ok && [ok.policy.holderSecret, ok.policy.holderAgain], [null, false], 'a phone that predates them joins it with its pin');
  assert.match(/** @type {any} */ (checkPolicy({ ...base, egress: 'n1', holder: true, holderSecret: 'short' }, /** @type {any} */ (choices))).text, /not a secret/);
  assert.match(/** @type {any} */ (checkPolicy({ ...base, egress: 'n1', holderSecret: SECRET }, /** @type {any} */ (choices))).text, /not a secret/);
  assert.match(/** @type {any} */ (checkPolicy({ ...base, egress: 'n1', holderAgain: true }, /** @type {any} */ (choices))).text, /made again only while it is asked for/);
});

test('made again, the one there goes first, disk and all, and the new one boots with the phone’s secret', async () => {
  const stuck = { type: 'VM', id: 'vm-stuck', name_label: 'holder-c09fcd', $pool: 'p1', power_state: 'Running', tags: [HOLDER.tag] };
  const xo = admin([debian, stuck]);
  const { asked, askPin } = pinner();
  const said = await ensureHolder({ ...spec(xo, askPin), secret: SECRET, again: true });
  assert.deepEqual(xo.calls.filter(([m]) => m !== 'xo.getAllObjects').map(([m, p]) => `${m} ${p.id ?? p.name_label}`), ['vm.stop vm-stuck', 'vm.delete vm-stuck', `vm.create ${NAME}`]);
  assert.equal(asked.count, 1);
  const [, made] = /** @type {[string, any]} */ (xo.calls.find(([m]) => m === 'vm.create'));
  assert.ok(made.cloudConfig.includes(`"secret":"${SECRET}"`));
  assert.match(said, /asks to join, and your phone asks you to let it in/);
});

test('with the phone’s secret it asks to join under its name and keeps its pin unspent, proving the key it made', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-holder-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'vm-join.json');
  const hostKeyFile = join(dir, 'host-key.json');
  writeFileSync(file, JSON.stringify({ v: 1, coordinator: 'https://fleet.test', pin: PIN, hostId: NAME, holder: 'xo.lan', secret: SECRET }), { mode: 0o600 });
  const key = await generateKeyPair();
  /** @type {any[]} */
  const posted = [];
  const fetchImpl = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    posted.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, text: 'Asked.' }), { status: 202 });
  });
  assert.equal(await enrolVmOnce({ file, origin: 'https://fleet.test', hostKeyFile, publicJwk: key.publicJwk, fetchImpl }), NAME);
  assert.deepEqual(posted.map((p) => p.url), ['https://fleet.test/api/holder/join'], 'asked, and no pin spent at /api/enroll/host');
  const { body } = posted[0];
  assert.equal(body.hostId, NAME);
  const keyHash = await keyHashOf(body.publicJwk);
  assert.equal(body.proof, await proofOf(SECRET, { hostId: NAME, address: 'xo.lan', keyHash }), 'the proof the phone checks, over this machine’s key');
  assert.equal(body.publicJwk.x, key.publicJwk.x);
  assert.equal(readAssignedName(hostKeyFile), NAME, 'it dials under the name it was booted with');
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.pin, null, 'the pin is dropped unused');
  assert.equal(after.secret, SECRET, 'and the secret kept, to ask again until it is let in');
});

test('it waits to be let in without dialling, asks again now and then, and wipes the secret once it is in', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-holder-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'vm-join.json');
  writeFileSync(file, JSON.stringify({ v: 1, coordinator: 'https://fleet.test', hostId: NAME, holder: 'xo.lan', secret: SECRET }), { mode: 0o600 });
  const key = await generateKeyPair();
  let clock = 0;
  let checks = 0;
  /** @type {string[]} */
  const asked = [];
  const fetchImpl = /** @type {any} */ (async (/** @type {string} */ url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/host/challenge') return new Response(JSON.stringify({ ok: true, nonce: 'n'.repeat(20) }));
    if (path === '/api/host/verify') return (checks++ < 3) ? new Response(JSON.stringify({ ok: false, text: 'not enrolled' }), { status: 401 }) : new Response(JSON.stringify({ ok: true, fingerprint: 'f' }));
    asked.push(path);
    return new Response(JSON.stringify({ ok: true }), { status: 202 });
  });
  const wait = { checkMs: 60_000, askMs: 120_000, forMs: 24 * 3_600_000 };
  const inside = await waitToBeLetIn({ file, origin: 'https://fleet.test', hostId: NAME, publicJwk: key.publicJwk, privateJwk: key.privateJwk, fetchImpl, wait, now: () => clock, sleep: async (ms) => { clock += ms; } });
  assert.equal(inside, true);
  assert.equal(checks, 4, 'checked each minute until it was in');
  assert.deepEqual(asked, ['/api/holder/join'], 'and asked again once in those minutes');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).secret, null, 'nothing to ask with once it is in');
  // A name the fleet stopped waiting on is the end of waiting.
  writeFileSync(file, JSON.stringify({ v: 1, coordinator: 'https://fleet.test', hostId: NAME, holder: 'xo.lan', secret: SECRET }), { mode: 0o600 });
  const refused = /** @type {any} */ (async (/** @type {string} */ url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/host/challenge') return new Response(JSON.stringify({ ok: true, nonce: 'n'.repeat(20) }));
    if (path === '/api/host/verify') return new Response(JSON.stringify({ ok: false, text: 'not enrolled' }), { status: 401 });
    return new Response(JSON.stringify({ ok: false, error: { code: 'not_reserved' }, text: 'not waited on' }), { status: 404 });
  });
  clock = 0;
  assert.equal(await waitToBeLetIn({ file, origin: 'https://fleet.test', hostId: NAME, publicJwk: key.publicJwk, privateJwk: key.privateJwk, fetchImpl: refused, wait, now: () => clock, sleep: async (ms) => { clock += ms; } }), false);
  assert.ok(clock < wait.forMs, 'well before the day was out');
});
