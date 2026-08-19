// What is out of date on this box.
//
// The check path is what matters here: it runs on every health report, so it
// has to be cheap, and it must never throw a working host out of the fleet
// because git could not reach a remote.

import test from 'node:test';
import assert from 'node:assert/strict';

import { describeSystemUpdates, runUpgrade } from '../src/core/upgrades.js';

test('a box with nothing waiting says nothing at all', () => {
  // Null, not "0 updates available". This goes into a health report that
  // something else decides whether to surface, and a quiet box should be quiet
  // rather than reassuring.
  assert.equal(describeSystemUpdates({ supported: true, count: 0, security: 0, rebootRequired: false, packages: [] }), null);
  assert.equal(describeSystemUpdates({ supported: false, count: 0, security: 0, rebootRequired: false, packages: [] }), null);
});

test('a summary leads with the count and calls out security and reboots', () => {
  assert.equal(
    describeSystemUpdates({ supported: true, count: 12, security: 3, rebootRequired: true, packages: [] }),
    '12 packages can be upgraded · 3 security · reboot pending',
  );
  assert.equal(
    describeSystemUpdates({ supported: true, count: 1, security: 0, rebootRequired: false, packages: [] }),
    '1 package can be upgraded',
  );
  // A reboot with nothing to install is still worth saying: it means an
  // upgrade already happened and the box is running the old kernel.
  assert.equal(
    describeSystemUpdates({ supported: true, count: 0, security: 0, rebootRequired: true, packages: [] }),
    'reboot pending',
  );
});

test('with upgrades off, the refusal is the instructions', () => {
  // A "not permitted" that does not say how to permit it is a dead end, and
  // this one is a scoped sudoers line most people would accept if they could
  // see it.
  const r = runUpgrade(/** @type {any} */ ({ systemUpgrade: false, runUser: 'agent' }));
  assert.equal(r.ok, false);
  assert.match(r.text, /agent ALL=\(root\) NOPASSWD: \/usr\/bin\/apt-get -y upgrade/);
  assert.match(r.text, /AGENT_HUB_SYSTEM_UPGRADE=1/);
  assert.match(r.text, /cannot install, remove or run anything else/);
});
