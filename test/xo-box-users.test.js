// A user per box, and a machine whose box is gone.
//
//   node --test test/xo-box-users.test.js
//
// The policy job is what asks (xo-setup.js, and test/xo-setup.test.js runs it
// end to end). What is tested here is the module on its own: the refusal to
// start when Xen Orchestra cannot do it, what each verdict on a gone box's
// machine comes to, and that a resize in progress holds that box's user and
// the shared user's withdrawal alike, because deleting a user in the middle
// of a resize is how a machine gets stranded. docs/security.md, G14.

import test from 'node:test';
import assert from 'node:assert/strict';

import { settleBoxUsers, operates, boxTag, boxOfTags, boxUserEmail } from '../src/fleet/host/xo-box-users.js';
import { machineDone, markedBusy, BUSY_MS, YOUNG_MS, GRACE_MS } from '../src/fleet/host/machine-verdict.js';
import { splitHypervisorItem, hypervisorItemName } from '../src/fleet/protocol/hypervisor-name.js';
import { connectXo } from '../src/fleet/host/xo-ws.js';
import { standIn, PASSWORD, skip } from './helpers/xo-stand-in.js';

const S = 'fleetwright-session';
const sec = (/** @type {number} */ ms) => Math.floor(ms / 1000);

test('the name a box’s token is filed under is the address and the box, and nothing else splits that way', () => {
  assert.deepEqual(splitHypervisorItem('hypervisor:xo.lan'), { address: 'xo.lan', box: null });
  assert.deepEqual(splitHypervisorItem('hypervisor:xo.lan:8443+deb14'), { address: 'xo.lan:8443', box: 'deb14' });
  assert.deepEqual(splitHypervisorItem('hypervisor:[fd00::1]:443+holder-0a0b0c'), { address: '[fd00::1]:443', box: 'holder-0a0b0c' });
  assert.equal(splitHypervisorItem('hypervisor:xo.lan+not a box'), null);
  assert.equal(splitHypervisorItem('hypervisor:xo.lan+'), null);
  assert.equal(splitHypervisorItem('hypervisor:+deb14'), null);
  assert.equal(splitHypervisorItem('secret:hypervisor:xo.lan'), null);
  assert.equal(hypervisorItemName('xo.lan'), 'hypervisor:xo.lan');
  assert.equal(hypervisorItemName('xo.lan', 'deb14'), 'hypervisor:xo.lan+deb14');
  assert.equal(boxUserEmail('deb14'), 'fleetwright-box-deb14');
});

test('a box’s token works the machines tagged for it, and the shared token the ones with no box', () => {
  const mine = { tags: [S, boxTag('deb14')] };
  const theirs = { tags: [S, boxTag('gpu-1')] };
  const loose = { tags: [S] };
  assert.equal(operates({ box: 'deb14' }, mine), true);
  assert.equal(operates({ box: 'deb14' }, theirs), false);
  assert.equal(operates({ box: 'deb14' }, loose), false);
  assert.equal(operates({}, loose), true);
  assert.equal(operates({}, mine), false);
  assert.equal(boxOfTags([S, 'fleetwright-box:not a box']), null, 'a tag naming no box this fleet could have is no box');
});

test('the verdict on a machine is the sweep’s own: young or before its end is not done, busy is held for half an hour', () => {
  const now = Date.now();
  const made = (/** @type {number} */ ago) => `fleetwright-made:${sec(now - ago)}`;
  const until = (/** @type {number} */ inMs) => `fleetwright-until:${sec(now + inMs)}`;
  assert.equal(machineDone({ power_state: 'Halted', tags: [S, made(60_000), until(60 * 60_000)] }, now), false, 'just made, stopped while it clones');
  assert.equal(machineDone({ power_state: 'Halted', tags: [S, made(YOUNG_MS + 1000), until(60 * 60_000)] }, now), false, 'stopped before its end: the sweep starts it again');
  assert.equal(machineDone({ power_state: 'Halted', tags: [S, made(YOUNG_MS + 1000), until(-1000)] }, now), true, 'stopped past its end');
  assert.equal(machineDone({ power_state: 'Halted', tags: [S] }, now), true, 'stopped with no end was never given one to wait for');
  assert.equal(machineDone({ power_state: 'Running', tags: [S, until(-(GRACE_MS + 1000))] }, now), true, 'running well past its end');
  assert.equal(machineDone({ power_state: 'Running', tags: [S, until(-1000)] }, now), false, 'a minute of grace past its end');
  assert.equal(machineDone({ power_state: 'Running', tags: [S, until(60_000)] }, now), false);
  assert.equal(markedBusy(['fleetwright-busy'], now), true, 'the bare mark an older box writes');
  assert.equal(markedBusy([`fleetwright-busy:${sec(now - 60_000)}`], now), true);
  assert.equal(markedBusy([`fleetwright-busy:${sec(now - BUSY_MS - 1000)}`], now), false, 'a resize that never finished');
  assert.equal(markedBusy([S], now), false);
});

test('a Xen Orchestra that cannot add an ACL changes nothing about who may reach a machine', async () => {
  let calls = 0;
  const settled = await settleBoxUsers({
    admin: { async call() { calls += 1; return []; } },
    methods: { 'user.create': {} },
    setId: 'rs-0',
    boxes: ['deb14'],
    now: 0,
    signInAs: async () => { throw new Error('signed in'); },
    tokenLifetimeMs: 1,
  });
  assert.equal(calls, 0);
  assert.equal(settled.handoff, null);
  assert.match(settled.text, /Nothing about who may reach them was changed/);
  assert.match(settled.text, /acl\.add/);
});

/** The admin's connection and the sign-in the job makes for each box's user. */
async function admin(/** @type {any} */ t, /** @type {any} */ xo) {
  const rpc = await connectXo({ address: xo.address, pin: xo.pin });
  t.after(() => rpc.close());
  await rpc.call('session.signIn', { email: 'admin@admin.net', password: PASSWORD });
  const methods = await rpc.call('system.getMethodsInfo');
  const signInAs = async (/** @type {string} */ email, /** @type {string} */ password) => {
    const as = await connectXo({ address: xo.address, pin: xo.pin });
    await as.call('session.signIn', { email, password });
    return as;
  };
  return { rpc, methods, signInAs };
}

test('a machine being resized keeps the user of the box that is gone, and a machine with no box is nobody’s to touch', { skip }, async (t) => {
  const xo = await standIn(t, {
    sets: [{ id: 'rs-0', name: 'fleetwright', subjects: ['u-shared'], objects: [] }],
    users: [
      { id: 'u-shared', email: 'fleetwright', permission: 'none' },
      { id: 'u-old', email: 'fleetwright-box-oldbox', permission: 'none' },
    ],
    vms: {
      busy: { id: 'busy', type: 'VM', power_state: 'Halted', tags: [S, 'fleetwright-box:oldbox', `fleetwright-busy:${sec(Date.now())}`] },
      plain: { id: 'plain', type: 'VM', power_state: 'Halted', tags: [S] },
    },
  });
  const { rpc, methods, signInAs } = await admin(t, xo);
  const settled = await settleBoxUsers({ admin: rpc, methods, setId: 'rs-0', boxes: ['deb14'], now: Date.now(), tokenLifetimeMs: 180 * 24 * 60 * 60_000, signInAs });
  assert.match(settled.text, /oldbox is in the middle of a resize/);
  assert.ok(xo.users.some((u) => u.email === 'fleetwright-box-oldbox'));
  assert.ok(xo.users.some((u) => u.email === 'fleetwright'));
  assert.ok(!xo.calls.some((c) => c.method === 'user.delete'));
  assert.ok(!xo.calls.some((c) => c.method === 'vm.delete'));
  assert.ok(!xo.calls.some((c) => c.method === 'acl.add' && c.params.object === 'plain'), 'not asked to retire the shared user, so its machine is left');
  assert.ok(xo.vms.busy && xo.vms.plain);
  // The box's new user is a subject of the set, has a token, and its minting
  // password did not stay.
  const user = xo.users.find((u) => u.email === 'fleetwright-box-deb14');
  assert.ok(user);
  assert.ok(xo.sets[0].subjects.includes(user.id));
  assert.deepEqual(settled.handoff?.boxTokens.map((b) => [b.box, b.user, b.token]), [['deb14', 'fleetwright-box-deb14', 'tok-fleetwright-box-deb14']]);
  const sets = xo.calls.filter((c) => c.method === 'user.set' && c.params.id === user.id && c.params.password);
  assert.ok(sets.length >= 1, 'the password was replaced after minting');
  assert.notEqual(xo.passwords.get('fleetwright-box-deb14'), undefined);
});

test('a gone box’s machines go the way the sweep would send them: done ones removed, the rest handed to the first named box, then its user deleted', { skip }, async (t) => {
  const now = Date.now();
  const xo = await standIn(t, {
    sets: [{ id: 'rs-0', name: 'fleetwright', subjects: ['u-shared'], objects: [] }],
    users: [
      { id: 'u-shared', email: 'fleetwright', permission: 'none' },
      { id: 'u-old', email: 'fleetwright-box-oldbox', permission: 'none' },
    ],
    vms: {
      young: { id: 'young', type: 'VM', power_state: 'Halted', tags: [S, 'fleetwright-box:oldbox', `fleetwright-made:${sec(now - 30_000)}`, `fleetwright-until:${sec(now + 3_600_000)}`] },
      early: { id: 'early', type: 'VM', power_state: 'Halted', tags: [S, 'fleetwright-box:oldbox', `fleetwright-made:${sec(now - 3_600_000)}`, `fleetwright-until:${sec(now + 3_600_000)}`] },
      late: { id: 'late', type: 'VM', power_state: 'Running', tags: [S, 'fleetwright-box:oldbox', `fleetwright-until:${sec(now + 3_600_000)}`] },
      dead: { id: 'dead', type: 'VM', power_state: 'Halted', tags: [S, 'fleetwright-box:oldbox', `fleetwright-made:${sec(now - 3_600_000)}`, `fleetwright-until:${sec(now - 60_000)}`] },
      overdue: { id: 'overdue', type: 'VM', power_state: 'Running', tags: [S, 'fleetwright-box:oldbox', `fleetwright-until:${sec(now - 600_000)}`] },
    },
  });
  const { rpc, methods, signInAs } = await admin(t, xo);
  const settled = await settleBoxUsers({ admin: rpc, methods, setId: 'rs-0', boxes: ['gpu-1', 'deb14'], now, tokenLifetimeMs: 1000, signInAs });
  assert.match(settled.text, /3 machines a box that is gone had made were handed to deb14/);
  assert.match(settled.text, /2 machines of a box that is gone were removed/);
  assert.equal(xo.vms.dead, undefined);
  assert.equal(xo.vms.overdue, undefined);
  assert.ok(xo.calls.some((c) => c.method === 'vm.stop' && c.params.id === 'overdue' && c.params.force === true), 'running past its end is stopped before it is removed');
  const succ = xo.users.find((u) => u.email === 'fleetwright-box-deb14');
  for (const id of ['young', 'early', 'late']) {
    assert.ok(xo.vms[id], `${id} stays`);
    const order = xo.calls.filter((c) => (c.method === 'acl.add' || c.method === 'acl.remove' || c.method === 'tag.add' || c.method === 'tag.remove') && (c.params.object === id || c.params.id === id)).map((c) => c.method);
    assert.deepEqual(order, ['acl.add', 'tag.add', 'tag.remove', 'acl.remove'], `${id}: the successor first, then the tag, then the gone user's access off`);
    assert.equal(xo.calls.find((c) => c.method === 'acl.add' && c.params.object === id)?.params.subject, succ?.id);
    assert.equal(xo.calls.find((c) => c.method === 'acl.remove' && c.params.object === id)?.params.subject, 'u-old');
  }
  assert.ok(!xo.users.some((u) => u.email === 'fleetwright-box-oldbox'), 'deleted only after its machines were handed on');
  assert.ok(xo.users.some((u) => u.email === 'fleetwright'), 'the shared user is not this job’s to delete');
  assert.deepEqual(settled.handoff?.boxTokens.map((b) => b.box), ['gpu-1', 'deb14']);
  assert.equal(settled.handoff?.retiredShared, undefined);
});

test('withdrawing the shared user hands what was still on it to the first named box, and a resize on one of those holds it', { skip }, async (t) => {
  const now = Date.now();
  const xo = await standIn(t, {
    sets: [{ id: 'rs-0', name: 'fleetwright', subjects: ['u-shared'], objects: [] }],
    users: [{ id: 'u-shared', email: 'fleetwright', permission: 'none' }],
    vms: {
      loose: { id: 'loose', type: 'VM', power_state: 'Running', tags: [S, `fleetwright-until:${sec(now + 3_600_000)}`] },
      busy: { id: 'busy', type: 'VM', power_state: 'Running', tags: [S, 'fleetwright-busy'] },
      other: { id: 'other', type: 'VM', power_state: 'Running', tags: ['somebody-elses'] },
    },
  });
  const { rpc, methods, signInAs } = await admin(t, xo);
  const held = await settleBoxUsers({ admin: rpc, methods, setId: 'rs-0', boxes: ['deb14'], retireShared: true, now, tokenLifetimeMs: 1000, signInAs });
  assert.match(held.text, /the shared user is in the middle of a resize/);
  assert.match(held.text, /left as it was/);
  assert.equal(held.handoff?.retiredShared, undefined);
  assert.ok(!xo.calls.some((c) => c.method === 'acl.add'));

  delete xo.vms.busy;
  xo.calls.length = 0;
  const done = await settleBoxUsers({ admin: rpc, methods, setId: 'rs-0', boxes: ['deb14'], retireShared: true, now, tokenLifetimeMs: 1000, signInAs });
  assert.match(done.text, /One machine still on the shared user was handed to deb14/);
  assert.match(done.text, /Boxes stop being given its token/);
  assert.equal(done.handoff?.retiredShared, true);
  const succ = xo.users.find((u) => u.email === 'fleetwright-box-deb14');
  assert.equal(xo.calls.find((c) => c.method === 'acl.add' && c.params.object === 'loose')?.params.subject, succ?.id);
  assert.ok(xo.calls.some((c) => c.method === 'tag.add' && c.params.id === 'loose' && c.params.tag === 'fleetwright-box:deb14'));
  assert.ok(xo.calls.some((c) => c.method === 'acl.remove' && c.params.object === 'loose' && c.params.subject === 'u-shared'));
  assert.ok(!xo.calls.some((c) => c.params?.object === 'other' || (c.method === 'tag.add' && c.params.id === 'other')), 'a machine that is not the fleet’s is not touched');
  assert.ok(xo.users.some((u) => u.email === 'fleetwright'), 'the shared user stays for the phone');
  // Minted again, the box's earlier token is gone and the new one is in the seal.
  assert.equal(done.handoff?.boxTokens[0].token, 'tok-fleetwright-box-deb14-2');
  assert.deepEqual(xo.tokens.get('fleetwright-box-deb14'), ['tok-fleetwright-box-deb14-2']);
});
