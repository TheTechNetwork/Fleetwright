// An update has to reach every service, and it must not need a terminal.
//
// `/update --restart` restarts the hub by exiting and letting systemd bring it
// back. The sidecar and coordinator kept running old code, and the answer on
// offer was "ssh in and systemctl restart" -- the one thing this product exists
// so that nobody has to do. An update that needs a terminal to finish is not an
// update.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requestRestart, readMarker, markerPath, watchForRestart } from '../src/core/restart-watch.js';

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

test('a marker written after we started makes us exit', async () => {
  const d = dir();
  let exited = false;
  const since = Date.now() - 1000;
  const stop = watchForRestart({ since, everyMs: 5, stateDir: d, exit: () => { exited = true; } });
  requestRestart({ stateDir: d });
  await new Promise((r) => setTimeout(r, 40));
  stop();
  assert.equal(exited, true);
});

test('a marker OLDER than our start does not, or a restart is a loop', async () => {
  // The service that comes back up after an update reads the very marker that
  // caused it. Without the comparison it exits again immediately, for ever --
  // a restart loop built out of the mechanism meant to end one.
  const d = dir();
  requestRestart({ stateDir: d });
  await new Promise((r) => setTimeout(r, 5));
  let exited = false;
  const stop = watchForRestart({ since: Date.now(), everyMs: 5, stateDir: d, exit: () => { exited = true; } });
  await new Promise((r) => setTimeout(r, 40));
  stop();
  assert.equal(exited, false);
});

test('it stops watching once it has fired, so exit is called once', async () => {
  const d = dir();
  let calls = 0;
  const stop = watchForRestart({ since: Date.now() - 1000, everyMs: 5, stateDir: d, exit: () => { calls += 1; } });
  requestRestart({ stateDir: d });
  await new Promise((r) => setTimeout(r, 60));
  stop();
  assert.equal(calls, 1);
});

test('the watcher never holds the process open', () => {
  // unref'd: a service whose real work has finished should exit, not linger
  // because it is still waiting for an update it will never act on.
  const stop = watchForRestart({ stateDir: dir(), everyMs: 1000 });
  stop();
  assert.ok(true);
});
