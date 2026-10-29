// Box-wide verbs against admins the machine pins itself.
//
//   node --test test/pinned-admins.test.js
//
// A coordinator can name anybody an admin, and anybody a member, and the
// minter lists keys for whoever it names a member: a throwaway account it
// signed up itself signs as `signed`. So the first pin is set on the box by
// whoever runs it and never over the wire, and over the wire only an admin
// the box already pins, with their own signature, changes the list. Nobody
// pinned is the behaviour from before, on purpose: every box already deployed
// keeps working with nothing to set up. The coordinator's half (who is shown
// the addresses) is test/pinned-admins-coordinator.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Sidecar } from '../src/fleet/host/sidecar.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { adminCommand, seedPins, LEFT } from '../src/fleet/host/pinned-admins.js';
import { loadSidecarConfig, validateSidecarConfig } from '../src/fleet/host/config.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { startStubHub } from './helpers/stub-hub.js';

const ADA = 'ada@example.com';
const BEA = 'bea@example.com';

/** @param {import('node:test').TestContext} t */
function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pinned-admins-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** @param {string} dir @param {object} record */
const pinFile = (dir, record) => writeFileSync(path.join(dir, 'pinned-admins.json'), `${JSON.stringify(record)}\n`);
/** @param {string} dir */
const pins = (dir) => JSON.parse(readFileSync(path.join(dir, 'pinned-admins.json'), 'utf8'));

/**
 * A box, its hub, and what its signature check says about the next intent.
 *
 * The constructor builds IntentKeys only when the process holds a vault key,
 * so a test that wants a verdict assigns the checker handle() calls. `listed`
 * stands in for the people the minter lists keys for now.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ dir?: string|null, facts?: Record<string, unknown>, verdict?: string|null, record?: object }} [opts]
 */
async function box(t, { dir, facts = {}, verdict = 'signed', record } = {}) {
  const stateDir = dir === undefined ? tempDir(t) : dir;
  if (record && stateDir) pinFile(stateDir, record);
  const stub = await startStubHub({ facts });
  t.after(() => stub.close());
  const say = { verdict, listed: /** @type {Set<string>} */ (new Set()) };
  const sidecar = new Sidecar({
    hub: new HubClient({ baseUrl: stub.baseUrl, token: null, readTimeoutMs: 2000 }),
    transport: /** @type {any} */ ({ origin: 'https://coord.example.workers.dev', onMessage() {}, send() {}, start: async () => true, stop: async () => true }),
    hostId: 'ops-box',
    healthIntervalMs: 0,
    watch: false,
    xoStateDir: stateDir,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  sidecar.intentKeys = /** @type {any} */ ({
    check: async () => ({ verdict: say.verdict }),
    isSigner: () => true,
    problem: null,
    get directory() { return say.listed; },
    report: () => ({ keys: 1, keysAt: null, checked: {} }),
  });
  return { stub, sidecar, say, dir: /** @type {string} */ (stateDir) };
}

let seq = 0;
/** @param {string} verb @param {Record<string, unknown>} [params] @param {string|null} [actor] */
const intent = (verb, params = {}, actor = ADA) => ({
  v: PROTOCOL_VERSION, kind: 'intent', id: `idem-pin-${String(++seq).padStart(4, '0')}`, verb, params, actor, issuedAt: Date.now(),
});
/** @param {any} sidecar @param {string} email @param {'add'|'remove'} op @param {string} actor */
const pin = (sidecar, email, op, actor) => sidecar.handle(intent('pinadmin', { email, op }, actor));

test('with nobody pinned, the box acts as before: an unsigned reboot reaches the machine and nothing is written', async (t) => {
  const { sidecar, stub, say, dir } = await box(t, { verdict: null });
  assert.equal((await sidecar.handle(intent('reboot'))).ok, true);
  say.verdict = 'unsigned';
  assert.equal((await sidecar.handle(intent('update', { restart: 'yes' }, BEA))).ok, true);
  assert.deepEqual(stub.commands, ['/reboot', '/update --restart']);
  assert.equal(existsSync(path.join(dir, 'pinned-admins.json')), false);
  // AND SAYS SO, so a phone knows the verb exists here and that nobody is
  // pinned, which draws every button as it is drawn today.
  assert.deepEqual((await sidecar.health()).admins, { pinned: [] });
});

test('a throwaway account the coordinator listed cannot pin itself on a box nobody pinned', async (t) => {
  // The attack: a coordinator names an account it signed up a member, the
  // minter lists its key, it signs a pinadmin naming itself, and it becomes
  // the box's only admin, unremovable, keeping the pin after it is "removed".
  // The first pin is not taken from the wire at all.
  const { sidecar, stub, say, dir } = await box(t);
  const r = await pin(sidecar, 'mallory@example.com', 'add', 'mallory@example.com');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'pinned_admins');
  assert.match(r.text, /the first admin is pinned on the machine itself, by whoever runs it: fleetwright-sidecar pin-admin/);
  assert.equal(existsSync(path.join(dir, 'pinned-admins.json')), false, 'a refusal wrote a record');
  say.verdict = 'unsigned';
  assert.equal((await sidecar.handle(intent('reboot', {}, BEA))).ok, true, 'the box stopped taking the fleet’s word');
  assert.deepEqual(stub.commands, ['/reboot']);
});

test('the fleet admin cannot pin themselves on a member’s box and lock the member out', async (t) => {
  // The coordinator lets the admin reach every box (scheduler.js administers),
  // and the box is the member's. Over the wire nobody unpinned changes its
  // pins, so the member still updates it, as the fleet's word says they may.
  const { sidecar, stub, say } = await box(t);
  const r = await pin(sidecar, 'admin@example.com', 'add', 'admin@example.com');
  assert.equal(r.ok, false);
  say.verdict = 'unsigned';
  assert.equal((await sidecar.handle(intent('update', { restart: 'yes' }, BEA))).ok, true);
  assert.deepEqual(stub.commands, ['/update --restart']);
});

test('a delegation does not change who is pinned, even from a pinned admin', async (t) => {
  const { sidecar, say, dir } = await box(t, { record: { admins: [ADA] }, verdict: 'delegated' });
  const r = await pin(sidecar, BEA, 'add', ADA);
  assert.equal(r.ok, false);
  assert.match(r.text, /A delegation does not carry it/);
  for (const verdict of ['unsigned', 'bad-signature', 'unknown-key', null]) {
    say.verdict = verdict;
    assert.equal((await pin(sidecar, BEA, 'add', ADA)).ok, false, String(verdict));
  }
  assert.deepEqual(pins(dir), { admins: [ADA] });
});

test('a pinned admin adds and removes others with their own signature, and the last is removed only on the box', async (t) => {
  const { sidecar, dir } = await box(t, { record: { admins: [ADA] } });
  const stranger = await pin(sidecar, 'cy@example.com', 'add', BEA);
  assert.equal(stranger.ok, false);
  assert.match(stranger.text, /bea@example.com is not a pinned admin on this machine/);

  const added = await pin(sidecar, 'Bea@Example.com', 'add', ADA);
  assert.equal(added.ok, true, added.text);
  assert.match(added.text, /^Pinned bea@example.com\./);
  assert.deepEqual(pins(dir), { admins: [ADA, BEA] });
  assert.match((await pin(sidecar, BEA, 'add', ADA)).text, /already pinned/);

  assert.equal((await pin(sidecar, ADA, 'remove', BEA)).ok, true);
  const last = await pin(sidecar, BEA, 'remove', BEA);
  assert.equal(last.ok, false);
  assert.match(last.text, /That is the last admin pinned on this machine/);
  assert.deepEqual(pins(dir), { admins: [BEA] });
});

test('once somebody is pinned, the box-wide verbs need one of them, signed or delegated', async (t) => {
  const { sidecar, stub, say } = await box(t, { record: { admins: [ADA] }, verdict: 'unsigned' });
  for (const [verb, params] of /** @type {const} */ ([['reboot', {}], ['upgrade', { apply: 'yes' }], ['update', {}]])) {
    const r = await sidecar.handle(intent(verb, params));
    assert.equal(r.ok, false, verb);
    assert.match(r.text, /not signed by one of them/, verb);
  }
  // Asking what is waiting installs nothing, and anybody the fleet lets ask may.
  assert.equal((await sidecar.handle(intent('upgrade', {}, BEA))).ok, true);

  say.verdict = 'signed';
  const other = await sidecar.handle(intent('reboot', {}, BEA));
  assert.match(other.text, /bea@example.com is not a pinned admin on this machine, and this reaches everybody’s work on it/);
  assert.equal((await sidecar.handle(intent('update', { restart: 'yes' }, ADA))).ok, true);
  say.verdict = 'delegated';
  assert.equal((await sidecar.handle(intent('reboot', {}, ADA))).ok, true);
  assert.deepEqual(stub.commands, ['/upgrade', '/update --restart', '/reboot']);
});

test('a signed person may restore their own binned session, and somebody else’s only if pinned', async (t) => {
  const { sidecar, stub } = await box(t, {
    record: { admins: [ADA] },
    facts: { bin: [{ name: 'mine', createdBy: `fleet:${BEA}` }, { name: 'theirs', createdBy: `fleet:${ADA}` }, { name: 'web', createdBy: 'web' }] },
  });
  assert.equal((await sidecar.handle(intent('restore', { name: 'mine' }, BEA))).ok, true);
  assert.match((await sidecar.handle(intent('restore', { name: 'theirs' }, BEA))).text, /that session is somebody else’s/);
  assert.match((await sidecar.handle(intent('restore', { name: 'web' }, BEA))).text, /cannot tell whose that session is/);
  assert.match((await sidecar.handle(intent('restore', { name: 'gone' }, BEA))).text, /cannot tell whose/);
  assert.equal((await sidecar.handle(intent('restore', { name: 'theirs' }, ADA))).ok, true);
  assert.deepEqual(stub.commands, ['/restore mine', '/restore theirs']);
});

test('a record that cannot be read refuses the box-wide verbs, is not written over from the wire, and says so', async (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, 'pinned-admins.json'), '{');
  const { sidecar, stub } = await box(t, { dir });
  assert.match((await sidecar.handle(intent('reboot'))).text, /cannot be read/);
  assert.equal((await pin(sidecar, ADA, 'add', ADA)).ok, false);
  assert.equal(readFileSync(path.join(dir, 'pinned-admins.json'), 'utf8'), '{');
  assert.deepEqual(stub.commands, []);
  const { admins } = await sidecar.health();
  assert.equal(admins.pinned, null, 'cannot tell was reported as somebody or nobody');
  assert.match(admins.problem, /cannot be read/);
});

test('somebody removed from the fleet loses their pin, unless they were the only admin', async (t) => {
  const { sidecar, stub, dir } = await box(t, { record: { admins: [ADA, BEA] } });
  const r = await sidecar.handle(intent('forgetperson', {}, BEA));
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(stub.forgotten, [BEA]);
  assert.match(r.text, /bea@example.com is no longer pinned as an admin here/);
  assert.deepEqual(pins(dir), { admins: [ADA] });
  // Somebody never pinned changes nothing.
  assert.equal((await sidecar.handle(intent('forgetperson', {}, 'cy@example.com'))).ok, true);
  assert.deepEqual(pins(dir), { admins: [ADA] });
});

test('the only admin leaving fails closed, and the box’s health says what to do in words', async (t) => {
  const { sidecar, stub, say, dir } = await box(t, { record: { admins: [ADA] } });
  const r = await sidecar.handle(intent('forgetperson', {}, ADA));
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /was the only admin pinned here and stays pinned/);
  assert.deepEqual(pins(dir), { admins: [ADA], left: [ADA] });

  // Their key is no longer listed, so nobody signs as them: everybody else,
  // the fleet's admin included, is refused, and nothing falls back to the
  // coordinator's word.
  for (const actor of [BEA, 'admin@example.com']) assert.equal((await sidecar.handle(intent('reboot', {}, actor))).ok, false, actor);
  say.verdict = 'unsigned';
  assert.equal((await sidecar.handle(intent('reboot', {}, BEA))).ok, false);
  assert.deepEqual(stub.commands, []);
  const { admins } = await sidecar.health();
  assert.deepEqual(admins, { pinned: [ADA], left: LEFT });
  assert.match(LEFT, /^The only admin pinned on this machine has left the fleet, so it updates, upgrades and reboots for nobody\. A new admin is pinned on the machine itself: fleetwright-sidecar pin-admin/);
  assert.doesNotMatch(LEFT, /@/, 'the sentence goes to members, who are not shown addresses');

  // Let back in, their key is listed again and the sentence would be false.
  say.listed.add(ADA);
  assert.deepEqual((await sidecar.health()).admins, { pinned: [ADA] });
});

test('on the box, whoever runs it lists, pins, unpins and resets, the first and the last included', async (t) => {
  const dir = tempDir(t);
  assert.match((await adminCommand(dir, 'admins', [])).text, /^Nobody is pinned on this machine/);
  const first = await adminCommand(dir, 'pin-admin', ['Ada@Example.com', BEA]);
  assert.equal(first.code, 0, first.text);
  assert.equal(first.text, 'Pinned admins on this machine: ada@example.com, bea@example.com.');
  assert.deepEqual(pins(dir), { admins: [ADA, BEA] });
  assert.equal((await adminCommand(dir, 'pin-admin', ['not an address'])).code, 2);
  assert.equal((await adminCommand(dir, 'unpin-admin', ['cy@example.com'])).code, 1);
  assert.equal((await adminCommand(dir, 'unpin-admin', [BEA])).code, 0);
  assert.equal((await adminCommand(dir, 'unpin-admin', [ADA])).code, 0, 'the last admin is removed here');
  assert.deepEqual(pins(dir), { admins: [] });

  // THE WAY BACK from an admin who left, and from a record that will not read.
  pinFile(dir, { admins: [ADA], left: [ADA] });
  assert.match((await adminCommand(dir, 'admins', [])).text, /has left the fleet/);
  await adminCommand(dir, 'pin-admin', [BEA]);
  assert.deepEqual(pins(dir), { admins: [ADA, BEA] });
  writeFileSync(path.join(dir, 'pinned-admins.json'), 'not json');
  assert.equal((await adminCommand(dir, 'admins', [])).code, 1);
  const reset = await adminCommand(dir, 'reset-admins', [], { envAdmins: [ADA] });
  assert.match(reset.text, /FLEETWRIGHT_ADMINS in this machine’s env file pins ada@example.com again when the sidecar next starts/);
  assert.deepEqual(pins(dir), { admins: [] });
});

test('FLEETWRIGHT_ADMINS pins the first admins when nobody is pinned, and never overrules the record after', async (t) => {
  const env = (/** @type {string} */ v) => loadSidecarConfig({ FLEETWRIGHT_COORDINATOR_URL: 'https://fleet.example', FLEETWRIGHT_ADMINS: v });
  assert.deepEqual(env(`${ADA}, ${BEA}`).admins, [ADA, BEA]);
  assert.match(validateSidecarConfig(env('ada')).errors.join('\n'), /FLEETWRIGHT_ADMINS names ada, which is not a fleet address/);

  const dir = tempDir(t);
  assert.deepEqual(await seedPins(dir, [ADA]), [ADA]);
  await adminCommand(dir, 'pin-admin', [BEA]);
  await adminCommand(dir, 'unpin-admin', [ADA]);
  assert.equal(await seedPins(dir, [ADA]), null, 'a restart undid an unpin');
  assert.deepEqual(pins(dir), { admins: [BEA] });
});

test('the commands are the sidecar’s own, run from its entrypoint with its env file', async (t) => {
  const dir = tempDir(t);
  const run = (/** @type {string[]} */ args) =>
    execFileSync(process.execPath, [new URL('../bin/fleetwright-sidecar', import.meta.url).pathname, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, FLEETWRIGHT_SIDECAR_ENV_FILE: path.join(dir, 'none.env'), FLEETWRIGHT_HOST_KEY: path.join(dir, 'host-key.json') },
    });
  run(['pin-admin', ADA]);
  assert.match(run(['admins']), /Pinned admins on this machine: ada@example.com\./);
  assert.deepEqual(pins(dir), { admins: [ADA] });
});

test('changes made at the same time from the box and from the wire all land', async (t) => {
  // Two processes each reading the record before the other wrote it lose one
  // change. Four command lines at once, and the running sidecar beside them.
  const { sidecar, dir } = await box(t, { record: { admins: [ADA] } });
  const exec = promisify(execFile);
  const bin = new URL('../bin/fleetwright-sidecar', import.meta.url).pathname;
  const env = { PATH: process.env.PATH, HOME: dir, FLEETWRIGHT_SIDECAR_ENV_FILE: path.join(dir, 'none.env'), FLEETWRIGHT_HOST_KEY: path.join(dir, 'host-key.json') };
  const local = ['c1', 'c2', 'c3', 'c4'].map((n) => exec(process.execPath, [bin, 'pin-admin', `${n}@example.com`], { env }));
  const wire = ['w1', 'w2', 'w3', 'w4'].map((n) => pin(sidecar, `${n}@example.com`, 'add', ADA));
  const replies = await Promise.all(wire);
  await Promise.all(local);
  for (const r of replies) assert.equal(r.ok, true, r.text);
  assert.deepEqual(
    [...pins(dir).admins].sort(),
    [ADA, ...['c1', 'c2', 'c3', 'c4', 'w1', 'w2', 'w3', 'w4'].map((n) => `${n}@example.com`)].sort(),
  );
});
