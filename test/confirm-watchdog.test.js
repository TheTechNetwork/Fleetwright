// The commit-confirm watchdog (install/fleetwright-confirm), the arbiter that
// lives OUTSIDE the app so it can catch any of the three services failing to
// start. It is POSIX shell on purpose — it must work when node is the broken
// part — so it is tested as shell: a real release layout in a temp dir, the
// script run against it, and the symlink and marker checked afterwards.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, readlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'install', 'fleetwright-confirm');

// /proc/uptime is Linux-only, and the uptime guard is load-bearing to the
// revert path. On anything else the script cannot make its uptime decision, so
// these run on Linux only.
const linux = os.platform() === 'linux';

/** A packaged layout + state dir, with `current -> to`. */
function layout(t, { from = 'main-1', to = 'main-2', keepPrevious = true } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'wd-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const releases = path.join(base, 'releases');
  for (const v of keepPrevious ? [from, to] : [to]) mkdirSync(path.join(releases, v), { recursive: true });
  const link = path.join(base, 'current');
  symlinkSync(path.join(releases, to), link);
  const stateDir = path.join(base, 'state');
  mkdirSync(stateDir, { recursive: true });
  return { base, stateDir, link, releases };
}

/** Write the trial record and back-date it, so evidence written "now" is newer. */
function arm(stateDir, { from = 'main-1', to = 'main-2', windowMs = 600_000, armedAt = Date.now() } = {}) {
  const f = path.join(stateDir, 'update-confirm');
  writeFileSync(f, `FROM=${from}\nTO=${to}\nWINDOW_MS=${windowMs}\nARMED_AT=${armedAt}\n`);
  const old = new Date(Date.now() - 5000);
  utimesSync(f, old, old);
}

function run(base, stateDir) {
  execFileSync('sh', [SCRIPT], { env: { ...process.env, FLEET_BASE: base, AGENT_HUB_STATE_DIR: stateDir } });
}

test('nothing on trial: the watchdog does nothing', { skip: !linux }, (t) => {
  const s = layout(t);
  run(s.base, s.stateDir);
  assert.equal(path.basename(readlinkSync(s.link)), 'main-2');
});

test('both halves of health, fresh: confirm — keep the update, clear the trial', { skip: !linux }, (t) => {
  const s = layout(t);
  arm(s.stateDir, { windowMs: 600_000 });
  writeFileSync(path.join(s.stateDir, 'confirm-hub.ok'), '');
  writeFileSync(path.join(s.stateDir, 'confirm-coord.ok'), '');
  run(s.base, s.stateDir);
  assert.equal(existsSync(path.join(s.stateDir, 'update-confirm')), false, 'the trial is cleared');
  assert.equal(path.basename(readlinkSync(s.link)), 'main-2', 'the update is kept');
  assert.equal(existsSync(path.join(s.stateDir, 'restart-marker.json')), false, 'no restart was asked for');
});

test('only one half of health: not confirmed, and inside the window not reverted', { skip: !linux }, (t) => {
  const s = layout(t);
  arm(s.stateDir, { windowMs: 600_000 }); // window wide open
  writeFileSync(path.join(s.stateDir, 'confirm-coord.ok'), ''); // reached coordinator, but no session proof
  run(s.base, s.stateDir);
  assert.ok(existsSync(path.join(s.stateDir, 'update-confirm')), 'still on trial');
  assert.equal(path.basename(readlinkSync(s.link)), 'main-2', 'not reverted yet');
});

test('window elapsed with health incomplete: revert, and ask the services to restart', { skip: !linux }, (t) => {
  const s = layout(t);
  // Tiny window, armed in the past: the wall-clock deadline is gone and real
  // uptime is far more than a few ms, so the revert path fires.
  arm(s.stateDir, { windowMs: 10, armedAt: Date.now() - 100_000 });
  writeFileSync(path.join(s.stateDir, 'confirm-hub.ok'), ''); // only one half ever arrived
  run(s.base, s.stateDir);
  assert.equal(path.basename(readlinkSync(s.link)), 'main-1', 'current points back at the previous release');
  const marker = JSON.parse(readFileSync(path.join(s.stateDir, 'restart-marker.json'), 'utf8'));
  assert.equal(marker.head, 'main-1');
  assert.equal(marker.actor, 'auto-rollback');
  assert.equal(existsSync(path.join(s.stateDir, 'update-confirm')), false, 'the trial is closed');
});

test('window elapsed but the revert target is gone: left as is, never a broken link', { skip: !linux }, (t) => {
  const s = layout(t, { keepPrevious: false });
  arm(s.stateDir, { windowMs: 10, armedAt: Date.now() - 100_000 });
  run(s.base, s.stateDir);
  assert.equal(path.basename(readlinkSync(s.link)), 'main-2', 'current is untouched');
  assert.equal(existsSync(path.join(s.stateDir, 'restart-marker.json')), false, 'no restart onto nothing');
});
