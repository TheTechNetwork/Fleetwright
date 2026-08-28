// Hosts that are expected to vanish.
//
// A CI runner is a host with a job and a clock: it enrols, works, and is
// destroyed. Everything the registry does for a real box -- keep it after a
// disconnect, offer it to the scheduler, remember its key -- is wrong for one,
// and wrong in a way that accumulates: one corpse per build.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HostRegistry } from '../src/fleet/coordinator/registry.js';
import { place } from '../src/fleet/coordinator/scheduler.js';

function fleet() {
  const r = new HostRegistry();
  return r;
}

function add(r, id, { ephemeral = false, free = 5 } = {}) {
  r.connect(id, () => {}, { ephemeral });
  r.recordHealth(id, { hub: { reachable: true }, maxSessions: 5, running: 5 - free, free, labels: [] });
}

const start = { verb: 'start', params: {} };

test('an ephemeral host is never chosen for you', () => {
  // It has plenty of capacity, being empty -- which is exactly why capacity
  // must not be the thing that selects it.
  const r = fleet();
  add(r, 'real-box', { free: 1 });
  add(r, 'runner-1', { ephemeral: true, free: 5 });
  const p = place(r, start, {});
  assert.equal(p.kind, 'host');
  assert.equal(p.host.hostId, 'real-box');
});

test('but it can be asked for by name', () => {
  const r = fleet();
  add(r, 'real-box');
  add(r, 'runner-1', { ephemeral: true });
  const p = place(r, start, { preferHost: 'runner-1' });
  assert.equal(p.kind, 'host');
  assert.equal(p.host.hostId, 'runner-1');
});

test('a fleet of only temporary hosts refuses, and says why', () => {
  // Silently using one would start work that disappears with the runner.
  const r = fleet();
  add(r, 'runner-1', { ephemeral: true });
  add(r, 'runner-2', { ephemeral: true });
  const p = place(r, start, {});
  assert.equal(p.kind, 'refused');
  assert.equal(p.code, 'only_ephemeral_hosts');
  assert.match(p.reason, /runner-1/);
  assert.match(p.reason, /lost when it goes/);
});

test('disconnecting retires it instead of leaving a corpse', () => {
  const r = fleet();
  const retired = [];
  r.onRetired = (id, why) => retired.push([id, why]);
  add(r, 'runner-1', { ephemeral: true });
  assert.equal(r.list().length, 1);

  r.disconnect('runner-1', 'job finished');
  assert.deepEqual(r.list(), [], 'one corpse per build is not a fleet');
  assert.deepEqual(retired, [['runner-1', 'job finished']], 'the key is revoked by the listener');
});

test('a real host that drops is KEPT, as it always was', () => {
  // It may come back, and its last known sessions are the best guess about
  // where a resume would land.
  const r = fleet();
  add(r, 'real-box');
  r.disconnect('real-box', 'network blip');
  assert.equal(r.list().length, 1);
  assert.equal(r.list()[0].state, 'offline');
});

test('ephemeral is sticky across a reconnect', () => {
  // A runner that drops and comes back is still a runner. The enrolment is the
  // authority, not whatever the last connect happened to pass.
  const r = fleet();
  add(r, 'runner-1', { ephemeral: true });
  r.connect('runner-1', () => {});
  assert.equal(r.list()[0].ephemeral, true);
});
