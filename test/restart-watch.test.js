// An update has to reach every service, and it must not need a terminal.
//
// `/update --restart` restarts the hub by exiting and letting systemd bring it
// back. The sidecar and coordinator kept running old code, and the answer on
// offer was "ssh in and systemctl restart" -- the one thing this product exists
// so that nobody has to do. An update that needs a terminal to finish is not an
// update.
//
// The marker's half is here. Who reads it moved: the sidecar used to watch the
// file and cannot since it runs as its own user (#270), so the hub publishes
// the marker's time on /api/state and the sidecar acts on that -- see
// test/hub-host-routes.test.js and test/sidecar.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requestRestart, readMarker, markerPath } from '../src/core/restart-watch.js';

const dir = () => mkdtempSync(join(tmpdir(), 'restart-'));

test('the updater leaves a marker the others can read', () => {
  const d = dir();
  assert.equal(requestRestart({ head: 'abc1234', actor: 'telegram:1', stateDir: d }), true);
  const m = readMarker(d);
  assert.equal(m.head, 'abc1234');
  assert.equal(m.actor, 'telegram:1');
  assert.ok(m.at > 0);
});

test('no marker is not an error -- a box that has never updated has none', () => {
  assert.equal(readMarker(dir()), null);
});

test('an unreadable marker does not take a service down', () => {
  const d = dir();
  writeFileSync(markerPath(d), 'not json at all');
  assert.equal(readMarker(d), null);
});
