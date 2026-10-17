// The pool's own machine, as the coordinator sees it: the pin the box running
// a policy job is given for it, and the machine asked first once it holds the
// pool. The box's half has its own tests (test/xo-holder.test.js).
//
//   node --test test/holder-coordinator.test.js
//
// ASKED FOR: "dedicated hypervisor VM on the pool (preferred holder; any LAN
// host is the fallback)". docs/hypervisors.md, "A machine of its own".

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore, MAX_HOLDER_PINS, HOLDER_ID_RE } from '../src/fleet/coordinator/core.js';

const ELI = 'eli@example.com';
const JOB = 'a1b2c3d4e5f6';
const IMAGE = '0b1e8c2a-3f4d-4e5a-9b6c-7d8e9f0a1b2c';

/** A box running Eli's policy job, and every frame each box was sent. */
function fleet() {
  const core = new CoordinatorCore({});
  /** @type {Record<string, any[]>} */
  const sent = {};
  for (const hostId of ['laptop', 'build']) {
    sent[hostId] = [];
    core.registry.connect(hostId, (/** @type {any} */ f) => sent[hostId].push(f));
    core.registry.recordHealth(hostId, { hub: { reachable: true }, protocol: 9, maxSessions: 5, running: 0, free: 5, labels: [] });
  }
  core.setups.set(JOB, { hostId: 'laptop', owner: ELI, startedAt: core.now(), last: null, activities: [] });
  /** @param {string} hostId @param {Record<string, any>} [extra] */
  const ask = async (hostId, extra = {}) => {
    const id = `holder-${'1'.repeat(8)}-${sent[hostId].length}`;
    await core.onHostMessage(hostId, { kind: 'holder-pin', id, job: JOB, ...extra });
    return sent[hostId].find((f) => f.id === id);
  };
  return { core, sent, ask };
}

test('the box running the job is given a pin bound to a new name, for a permanent host of nobody’s', async () => {
  const { core, ask } = fleet();
  const a = await ask('laptop');
  assert.equal(a.kind, 'minted');
  assert.equal(a.ok, true, a.text);
  assert.match(a.hostId, HOLDER_ID_RE);
  assert.match(a.pin, /^\d{6}$/);
  const spent = await core.enrollment.redeem(a.pin, 'host', 'build');
  assert.equal(spent.ok, false, 'the pin enrols its own name and no other');
  const right = await core.enrollment.redeem(a.pin, 'host', a.hostId);
  assert.equal(right.ok, true);
  assert.equal(right.ok && right.entry.ephemeral, false, 'a machine that holds a pool is not swept like a temporary one');
  assert.equal(right.ok && right.entry.actor, ELI);
});

test('another box, a job nobody began, or a job past its pins is given nothing', async () => {
  const { ask } = fleet();
  assert.equal((await ask('build')).error.code, 'not_your_job', 'only the box running the job');
  assert.equal((await ask('laptop', { job: 'ffffffffffff' })).error.code, 'not_your_job');
  for (let i = 0; i < MAX_HOLDER_PINS; i++) assert.equal((await ask('laptop')).ok, true);
  assert.equal((await ask('laptop')).error.code, 'too_many');
});

test('a job’s pins are counted across the coordinator being rebuilt from storage', async () => {
  // serialiseSetups wrote the count and restoreSetups did not read it back,
  // so every eviction gave a job its pins again.
  const { core, ask } = fleet();
  for (let i = 0; i < MAX_HOLDER_PINS; i++) await ask('laptop');
  const again = new CoordinatorCore({});
  /** @type {any[]} */
  const frames = [];
  again.registry.connect('laptop', (/** @type {any} */ f) => frames.push(f));
  again.restoreSetups(JSON.parse(JSON.stringify(core.serialiseSetups())));
  await again.onHostMessage('laptop', { kind: 'holder-pin', id: 'holder-11111111-9', job: JOB });
  assert.equal(frames.find((f) => f.id === 'holder-11111111-9')?.error?.code, 'too_many');
});

test('a setup ends when its box’s name is re-keyed, and the new key is given nothing in the owner’s name', async () => {
  // A later audit: the job was bound to the host NAME for a day. Any member
  // can mint a pin bound to an existing name and replace its key; the
  // re-keyed box acts for that member, yet the admin's next phase still took
  // it the job id, and with the id it was minted a holder pin in the admin's
  // name, which enrols a machine of operator tier and is sent the fleet's
  // OAuth client secrets.
  const { admit, makeAdmin } = await import('./helpers/enrolled-hosts.js');
  const { generateKeyPair } = await import('../src/fleet/crypto.js');
  const core = new CoordinatorCore({});
  await makeAdmin(core, ELI);
  await admit(core, 'box');
  core.registry.recordHealth('box', { hub: { reachable: true }, protocol: 9, maxSessions: 5, running: 0, free: 5, labels: [] });
  /** @type {any[]} */
  const delivered = [];
  core.send = /** @type {any} */ (async (/** @type {any} */ host, /** @type {any} */ spec) => {
    delivered.push({ hostId: host.hostId, phase: spec.params.phase });
    return { ok: true, text: 'Ready.', xosetup: { job: JOB, state: 'waiting', key: 'k', keySig: 's', hostKey: 'h' } };
  });
  const eli = { email: ELI, admin: true };
  const phase = (/** @type {Record<string, any>} */ params) => core.dispatch({ verb: 'xosetup', params, actor: `fleet:${ELI}`, requester: eli });
  assert.equal((await phase({ phase: 'begin', address: 'xo.lan', pin: 'a'.repeat(64) })).ok, true);

  // The member's pin bound to `box`, redeemed as /api/enroll/host does.
  const key = await generateKeyPair();
  const rekeyed = await core.hostIds.enrol({ hostId: 'box', publicJwk: key.publicJwk, enrolledBy: 'sam@example.com', boundToThisHost: true });
  assert.equal(rekeyed.ok && rekeyed.replaced, true);
  core.hostDisconnected('box', 're-enrolled');
  /** @type {any[]} */
  const frames = [];
  core.hostConnected('box', (/** @type {any} */ f) => frames.push(f));
  core.registry.recordHealth('box', { hub: { reachable: true }, protocol: 9, maxSessions: 5, running: 0, free: 5, labels: [] });

  const status = await phase({ phase: 'status', job: JOB });
  assert.equal(status.ok, false, 'the admin’s phase went to the re-keyed box');
  assert.deepEqual(delivered.map((d) => d.phase), ['begin'], 'the job id reached the new key');

  await core.onHostMessage('box', { kind: 'holder-pin', id: 'holder-11111111-0', job: JOB });
  const minted = frames.find((f) => f.id === 'holder-11111111-0');
  assert.equal(minted?.ok, false, 'a re-keyed box was minted a pin in the admin’s name');
  assert.equal(core.setups.has(JOB), false, 'the job outlived its machine’s key');
});

test('the name given is never one a host already has, so the pin cannot replace its key', async () => {
  const { core, ask } = fleet();
  const taken = new Set();
  for (let i = 0; i < MAX_HOLDER_PINS; i++) {
    const a = await ask('laptop');
    assert.ok(!core.registry.hosts.has(a.hostId) && !core.hostIds.get(a.hostId));
    assert.ok(!taken.has(a.hostId));
    taken.add(a.hostId);
  }
});

test('the pool’s own machine is asked first, and the box that set the pool up is the fallback', async () => {
  const core = new CoordinatorCore({});
  /** @type {string[]} */
  const asked = [];
  /** @param {boolean} holder */
  const xo = (holder) => [{ address: 'xo.lan', owner: ELI, reachable: true, holder, pools: [], images: [{ id: IMAGE, name: 'Debian 13', pool: 'p', poolName: 'rack' }], networks: [], machines: [] }];
  // `aaa` sorts first by name, so only the holder flag can put `holder-0a0b0c` ahead of it.
  for (const [hostId, holder] of /** @type {Array<[string, boolean]>} */ ([['aaa-laptop', false], ['holder-0a0b0c', true]])) {
    core.registry.connect(hostId, () => {});
    core.registry.recordHealth(hostId, { hub: { reachable: true }, protocol: 9, maxSessions: 5, running: 0, free: 5, labels: [], xo: xo(holder) });
  }
  core.send = /** @type {any} */ (async (/** @type {any} */ host) => {
    asked.push(host.hostId);
    return asked.length === 1 ? { ok: false, unreachable: true, text: 'down' } : { ok: true, text: 'Cloning.' };
  });
  const r = await core.dispatch({ verb: 'provision', params: { platform: 'vm', template: IMAGE }, actor: `fleet:${ELI}`, requester: { email: ELI, admin: true } });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(asked, ['holder-0a0b0c', 'aaa-laptop']);
});
