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
