// A user per box, and a machine whose box is gone.
//
//   node --test test/xo-box-users.test.js
//
// The policy job is what asks (xo-setup.js). What is tested here is the
// refusal to start when Xen Orchestra cannot do it, and the machine that is
// in the middle of a resize: deleting that user is how a machine gets stranded.

import test from 'node:test';
import assert from 'node:assert/strict';

import { settleBoxUsers } from '../src/fleet/host/xo-box-users.js';
import { connectXo } from '../src/fleet/host/xo-ws.js';
import { standIn, PASSWORD, skip } from './helpers/xo-stand-in.js';

test('a Xen Orchestra that cannot add an ACL changes nothing about who may reach a machine', async () => {
  let calls = 0;
  const settled = await settleBoxUsers({
    admin: { async call() { calls += 1; return []; } },
    methods: {},
    setId: 'rs-0',
    boxes: ['deb14'],
    now: 0,
    signInAs: async () => { throw new Error('signed in'); },
    tokenLifetimeMs: 1,
  });
  assert.equal(calls, 0);
  assert.equal(settled.handoff, null);
  assert.match(settled.text, /Nothing about who may reach them was changed/);
});

test('a machine being resized keeps the user of the box that is gone', { skip }, async (t) => {
  const xo = await standIn(t, {
    sets: [{ id: 'rs-0', name: 'fleetwright', subjects: ['u-shared'], objects: [] }],
    users: [
      { id: 'u-shared', email: 'fleetwright', permission: 'none' },
      { id: 'u-old', email: 'fleetwright-box-oldbox', permission: 'none' },
    ],
    vms: {
      busy: { id: 'busy', type: 'VM', power_state: 'Halted', tags: ['fleetwright-session', 'fleetwright-box:oldbox', 'fleetwright-busy'] },
      plain: { id: 'plain', type: 'VM', power_state: 'Halted', tags: ['fleetwright-session'] },
    },
  });
  const admin = await connectXo({ address: xo.address, pin: xo.pin });
  t.after(() => admin.close());
  await admin.call('session.signIn', { email: 'admin@admin.net', password: PASSWORD });
  const methods = await admin.call('system.getMethodsInfo');
  const settled = await settleBoxUsers({
    admin,
    methods,
    setId: 'rs-0',
    boxes: ['deb14'],
    now: Date.now(),
    tokenLifetimeMs: 180 * 24 * 60 * 60_000,
    signInAs: async (email, password) => {
      const rpc = await connectXo({ address: xo.address, pin: xo.pin });
      await rpc.call('session.signIn', { email, password });
      return rpc;
    },
  });
  assert.match(settled.text, /in the middle of a resize/);
  assert.ok(xo.users.some((u) => u.email === 'fleetwright-box-oldbox'));
  assert.ok(xo.users.some((u) => u.email === 'fleetwright'));
  assert.ok(!xo.calls.some((c) => c.method === 'user.delete'));
  assert.ok(!xo.calls.some((c) => c.method === 'vm.delete' && c.params.id === 'plain'));
  assert.ok(!xo.calls.some((c) => c.method === 'acl.add' && c.params.object === 'plain'));
  assert.ok(xo.vms.busy);
  assert.ok(xo.vms.plain);
});
