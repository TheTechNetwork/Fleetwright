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

test('disconnecting takes it off the list, leaving the key for retireStranded', () => {
  const r = fleet();
  add(r, 'runner-1', { ephemeral: true });
  assert.equal(r.list().length, 1);

  r.disconnect('runner-1', 'socket closed: 1006');
  assert.deepEqual(r.list(), [], 'one corpse per build is not a fleet');
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

test('a temporary host that drops is remembered for ten minutes, and so are its sessions', () => {
  // A macOS runner mid-build, starved by xcodebuild, dropped its socket and
  // dialled back two minutes later. In between the fleet said "not a host
  // this fleet knows" about it and "No host reports a session named duo-sim"
  // about the session it was running — both false, and the second one sent
  // the caller looking for a session it had just started. Its key was still
  // good; the fleet simply had no word for "dropped, may return".
  let clock = 1_700_000_000_000;
  const r = new HostRegistry({ now: () => clock });
  // A permanent box beside it, as that fleet had: an empty fleet is refused
  // before any name is looked at, and that is a different sentence.
  add(r, 'real-box');
  r.connect('runner-1', () => {}, { ephemeral: true });
  r.recordHealth('runner-1', { hub: { reachable: true }, maxSessions: 5, running: 1, free: 4, labels: [], sessions: [{ name: 'duo-sim', status: 'running' }] });
  clock += 20_000;
  r.disconnect('runner-1', 'socket closed: 1006');

  // Not listed: a screen must not show a runner that is not there.
  assert.deepEqual(r.list().map((h) => h.hostId), ['real-box']);
  // But its session is still placed on it, as an offline box that says why.
  const stop = place(r, { verb: 'stop', params: { name: 'duo-sim' } });
  assert.equal(stop.kind, 'refused');
  assert.equal(stop.code, 'host_unreachable', stop.reason);
  assert.match(String(stop.reason), /dropped its connection 0s ago \(socket closed: 1006\)/);
  assert.match(String(stop.reason), /keeps its key and usually returns/);
  // And naming it for new work says the same, not "not a host this fleet knows".
  clock += 90_000;
  add(r, 'real-box'); // still reporting, as the rest of that fleet was
  const named = place(r, start, { preferHost: 'runner-1' });
  assert.equal(named.code, 'host_unavailable');
  assert.match(String(named.reason), /dropped its connection 90s ago/);
  assert.doesNotMatch(String(named.reason), /not a host this fleet knows/);

  // Ten minutes is the chance retireStranded gives it; after that it is gone.
  clock += 10 * 60_000;
  add(r, 'real-box');
  assert.equal(place(r, { verb: 'stop', params: { name: 'duo-sim' } }).code, 'unknown_session');
  assert.match(String(place(r, start, { preferHost: 'runner-1' }).reason), /not a host this fleet knows/);
});

test('a dropped temporary host that dials back picks up what it had', () => {
  let clock = 1_700_000_000_000;
  const r = new HostRegistry({ now: () => clock });
  r.connect('runner-1', () => {}, { ephemeral: true });
  r.recordHealth('runner-1', { hub: { reachable: true }, maxSessions: 5, running: 1, free: 4, labels: [], sessions: [{ name: 'duo-sim', status: 'running' }] });
  r.disconnect('runner-1', 'socket closed: 1006');
  assert.equal(r.recentlyDropped('runner-1')?.reason, 'socket closed: 1006');

  clock += 30_000;
  r.connect('runner-1', () => {});
  assert.equal(r.recentlyDropped('runner-1'), null, 'back, so no longer dropped');
  assert.equal(r.list().length, 1);
  assert.equal(r.list()[0].ephemeral, true);
  // Its session is on a connected box again, from the health it had before
  // the drop, until the next frame says otherwise.
  const [claim] = r.findSessions('duo-sim');
  assert.equal(claim?.host.connected, true);
  assert.equal(claim?.status, 'running');

  // A goodbye (a 1000 close) is not a drop: nothing to come back from.
  r.disconnect('runner-1', 'socket closed: 1000 shutting down');
  r.remove('runner-1');
  assert.equal(r.recentlyDropped('runner-1'), null);
  assert.deepEqual(r.findSessions('duo-sim'), []);
});
