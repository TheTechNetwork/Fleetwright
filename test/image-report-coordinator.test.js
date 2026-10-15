// A machine image's build VM reporting on its install, as the coordinator
// sees it: the token the box running the build is given for it, and each
// report passed to that box and no other. The box's half has its own tests
// (test/xo-pools.test.js).
//
//   node --test test/image-report-coordinator.test.js
//
// ASKED FOR: "Or script call back something so we get it in the app", after
// a real build sat at "18 min so far, usually about 8" with nothing to say
// why: the box could see only the VM's power state. docs/hypervisors.md,
// "Machines from your pool".

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore, MAX_IMAGE_REPORTERS, MAX_IMAGE_REPORTS } from '../src/fleet/coordinator/core.js';
import { IMAGE_REPORT_TOKEN_RE } from '../src/fleet/protocol/intents.js';

const ELI = 'eli@example.com';
const JOB = 'a1b2c3d4e5f6';

/** A box running Eli's policy job, another box, and every frame each was sent. */
function fleet({ now = () => Date.now() } = {}) {
  const core = new CoordinatorCore({ now });
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
    const id = `reporter-${'1'.repeat(8)}-${sent[hostId].length}`;
    await core.onHostMessage(hostId, { kind: 'image-reporter', id, job: JOB, ...extra });
    return sent[hostId].find((f) => f.id === id);
  };
  /** What reached a box as a build VM's report. @param {string} hostId */
  const reports = (hostId) => sent[hostId].filter((f) => f.kind === 'image-report');
  return { core, sent, ask, reports };
}

test('the box running the build is given a token, and each step reported with it reaches that box', async () => {
  const { core, ask, reports } = fleet();
  const a = await ask('laptop');
  assert.equal(a.kind, 'minted');
  assert.equal(a.ok, true, a.text);
  assert.match(a.token, IMAGE_REPORT_TOKEN_RE);
  assert.equal(IMAGE_REPORT_TOKEN_RE.exec(a.token)?.[1], JOB, 'the token names its job');

  const r = await core.imageReport({ token: a.token, step: 'packages' });
  assert.equal(r.status, 202, r.body.text);
  assert.deepEqual(reports('laptop'), [{ v: reports('laptop')[0].v, kind: 'image-report', job: JOB, step: 'packages' }]);
  assert.equal(reports('build').length, 0, 'no other box hears it');
});

test('another box, a job nobody began, or a job past its tokens is given nothing', async () => {
  const { ask } = fleet();
  assert.equal((await ask('build')).error.code, 'not_your_job', 'only the box running the job');
  assert.equal((await ask('laptop', { job: 'ffffffffffff' })).error.code, 'not_your_job');
  for (let i = 0; i < MAX_IMAGE_REPORTERS; i++) assert.equal((await ask('laptop')).ok, true);
  assert.equal((await ask('laptop')).error.code, 'too_many');
});

test('a wrong secret, a replaced token, an ended job and an old token are all the same refusal', async () => {
  let at = Date.now();
  const { core, ask, reports } = fleet({ now: () => at });
  const first = (await ask('laptop')).token;
  const wrong = first.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
  assert.equal((await core.imageReport({ token: wrong, step: 'started' })).status, 403);

  const second = (await ask('laptop')).token;
  assert.equal((await core.imageReport({ token: first, step: 'started' })).status, 403, 'a build started over leaves nothing for the VM it gave up on');
  assert.equal((await core.imageReport({ token: second, step: 'started' })).status, 202);

  at += 61 * 60_000;
  assert.equal((await core.imageReport({ token: second, step: 'packages' })).status, 403, 'an hour, and it is gone');

  at = Date.now();
  const third = (await ask('laptop')).token;
  await core.onHostMessage('laptop', { kind: 'event', event: 'xosetup.progress', job: JOB, step: 5, of: 5, phase: 'apply', purpose: 'policy', state: 'failed', text: 'Stopped.' });
  assert.equal((await core.imageReport({ token: third, step: 'packages' })).status, 403, 'the job ending takes it back');
  assert.equal(reports('laptop').length, 1, 'only the one good report got through');
  for (const r of [await core.imageReport({}), await core.imageReport({ token: 'fwt_x_y', step: 'done' })]) {
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'unknown');
  }
});

test('a step is a word from the list, and only a failure carries the log, stripped and cut short', async () => {
  const { core, ask, reports } = fleet();
  const token = (await ask('laptop')).token;
  assert.equal((await core.imageReport({ token, step: 'Installing everything' })).status, 400);
  assert.equal((await core.imageReport({ token, step: 'packages', detail: 'ignored' })).status, 202);
  assert.equal('detail' in reports('laptop')[0], false, 'words ride on a failure only');

  const log = `${'x'.repeat(3000)}\nE: Unable to locate package‮ nope\u001b[0m\n`;
  assert.equal((await core.imageReport({ token, step: 'failed', detail: log })).status, 202);
  const failed = reports('laptop')[1];
  assert.equal(failed.step, 'failed');
  assert.equal(failed.detail.length, 2000, 'the end of the log, not all of it');
  assert.ok(failed.detail.endsWith('E: Unable to locate package nope[0m\n'), 'control and direction characters are dropped');
});

test('the session image’s pull carries its bytes, and only whole counts on that step get through', async () => {
  const { core, ask, reports } = fleet();
  const token = (await ask('laptop')).token;
  const GB = 1024 ** 3;
  assert.equal((await core.imageReport({ token, step: 'image', got: 412 * 1024 ** 2, of: 1.3 * GB | 0 })).status, 202);
  assert.deepEqual(reports('laptop')[0], { v: reports('laptop')[0].v, kind: 'image-report', job: JOB, step: 'image', got: 412 * 1024 ** 2, of: 1.3 * GB | 0 });

  // Before the registry answered, or when it never does: a count and no size.
  assert.equal((await core.imageReport({ token, step: 'image', got: 0 })).status, 202);
  assert.deepEqual([reports('laptop')[1].got, 'of' in reports('laptop')[1]], [0, false]);

  for (const [got, of] of [['412 MB', '1 GB'], [-1, 0], [1.5, 2.5], [65 * GB, 65 * GB], [Number.MAX_VALUE, Infinity]]) {
    assert.equal((await core.imageReport({ token, step: 'image', got, of })).status, 202, 'a bad count is dropped, the step still counts');
    const r = reports('laptop').at(-1);
    assert.equal('got' in r || 'of' in r, false, `${got} of ${of} is not a count`);
  }
  assert.equal((await core.imageReport({ token, step: 'packages', got: 5, of: 10 })).status, 202);
  assert.equal('got' in reports('laptop').at(-1), false, 'numbers ride on the pull only');
});

test('a token carries the pull reported every 15 seconds through the whole install, and none when its box is away', async () => {
  const { core, ask } = fleet();
  const token = (await ask('laptop')).token;
  assert.ok(MAX_IMAGE_REPORTS >= (25 * 60) / 15 + 12, 'the install’s 25 minutes at one report per 15 seconds, and its steps');
  let last;
  for (let i = 0; i <= MAX_IMAGE_REPORTS; i++) last = await core.imageReport({ token, step: 'image', got: i });
  assert.equal(last?.status, 429);

  const fresh = (await ask('laptop')).token;
  core.registry.disconnect('laptop');
  assert.equal((await core.imageReport({ token: fresh, step: 'started' })).body.error.code, 'host_away');
});

test('the token outlives the coordinator being restarted from storage, so a build halfway through is not refused', async () => {
  const { core, ask } = fleet();
  const token = (await ask('laptop')).token;
  const stored = JSON.parse(JSON.stringify(core.serialiseSetups()));

  const back = fleet().core;
  back.setups.clear();
  back.restoreSetups(stored);
  assert.equal((await back.imageReport({ token, step: 'installer' })).status, 202);
});
