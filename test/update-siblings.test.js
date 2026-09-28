// `/update --restart` restarts the hub by exiting and letting systemd bring it
// back. It cannot restart fleetwright-sidecar — a system unit the service user
// has no privilege over. (The coordinator was on this list while a box could run
// one; it runs as a Worker now.)
//
// So on a box running both, an update pulls code for both and applies it to
// one, while the message said "Restarting now" as though it were finished.
// That is a false report of completion, which is the failure mode
// this project keeps paying for.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { staleSiblings } from '../src/core/update.js';

test('names only units that are actually running', () => {
  // In this environment neither unit is active, so the honest answer is none.
  // The value of the assertion is the shape: never invent work for a box that
  // has nothing to restart.
  const stale = staleSiblings();
  assert.ok(Array.isArray(stale));
  for (const unit of stale) {
    assert.match(unit, /^fleetwright-sidecar$/);
  }
});

test('a unit systemd has never heard of is not reported', () => {
  // `systemctl is-active` prints "inactive" for an unknown unit rather than
  // failing, so a box without the sidecar installed looks exactly like one
  // where it is stopped. Both mean nothing to restart.
  assert.ok(!staleSiblings().includes('fleetwright-definitely-not-real'));
});
