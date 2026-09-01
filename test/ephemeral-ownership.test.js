import test from 'node:test';
import assert from 'node:assert/strict';
import { place } from '../src/fleet/coordinator/scheduler.js';

/** A registry stub: placement only reads these. */
function registry(hosts) {
  return {
    schedulable: () => hosts,
    reachable: () => hosts,
    list: () => hosts,
    get: (id) => hosts.find((h) => h.hostId === id) ?? null,
    findSessions: () => [],
    nextCursor: () => 0,
  };
}
const host = (hostId, extra = {}) => ({
  hostId,
  connected: true,
  health: { free: 3, claudeAccounts: 1 },
  healthAt: Date.now(),
  ...extra,
});
const START = { verb: 'start', params: { cwd: '/work' } };

test("somebody else's runner is not spare capacity", () => {
  // Several people may want a runner at once and they are not interchangeable:
  // each exists because somebody asked for it, for their job, and costs them
  // money while it lives. A runner belonging to someone else is a machine that
  // vanishes when a job you cannot see finishes.
  const hosts = [
    host('box', {}),
    host('gha-1', { ephemeral: true, owner: 'someone@else.com' }),
  ];
  const r = place(registry(hosts), START, { requester: { email: 'me@example.com' } });
  assert.equal(r.kind, 'host');
  assert.equal(r.host.hostId, 'box');
});

test('a fleet whose only host is somebody else\'s runner refuses', () => {
  const hosts = [host('gha-1', { ephemeral: true, owner: 'someone@else.com' })];
  const r = place(registry(hosts), START, { requester: { email: 'me@example.com' } });
  assert.equal(r.kind, 'refused');
  // NOT "only_ephemeral_hosts", and emphatically not "at_capacity" — which is
  // what it said before, about an empty machine. The reason it cannot be used
  // has nothing to do with how full it is.
  assert.equal(r.code, 'no_hosts');
  assert.match(r.reason, /belonging to somebody else/);
  assert.equal(/gha-1/.test(r.reason), false, 'do not name a machine they cannot use');
});

test('my own runner is still never chosen for me automatically', () => {
  // Ownership does not make it a default target. It is empty, so capacity would
  // pick it every time — and work placed there is lost when the job ends.
  const hosts = [host('gha-1', { ephemeral: true, owner: 'me@example.com' })];
  const r = place(registry(hosts), START, { requester: { email: 'me@example.com' } });
  assert.equal(r.kind, 'refused');
  assert.equal(r.code, 'only_ephemeral_hosts');
  assert.match(r.reason, /gha-1/);
  assert.match(r.reason, /Name one explicitly/);
});

test('an unowned ephemeral host stays visible to everyone', () => {
  // Hosts enrolled before ownership existed have no owner. Hiding them from
  // everybody would strand them; they behave exactly as they did.
  const hosts = [host('gha-old', { ephemeral: true })];
  const r = place(registry(hosts), START, { requester: { email: 'me@example.com' } });
  assert.equal(r.code, 'only_ephemeral_hosts');
});
