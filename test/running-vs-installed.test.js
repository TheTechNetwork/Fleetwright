// A service knows two versions: the one it is running and the one on its disk.
//
// A fleet showed a box as `main-88 · up to date` while the same box, asked,
// said "already on main-102". Both were true. The sidecar sending health was
// still running main-88 out of releases/main-88; the hub had moved `current`
// to main-102 and restarted; and "up to date" was measuring what was left to
// download, which was nothing. Nothing anywhere compared running to installed,
// so the gap had no words.
//
// This is the host's half: the two numbers, from the two places they come
// from, and the fact that they travel together in the frame so a phone can
// draw the difference.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { installedVersion, currentVersion } from '../src/core/release-apply.js';

/** A packaged layout with two releases and `current` on the newer one. */
function layout(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'layout-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const v of ['main-88', 'main-102']) {
    mkdirSync(path.join(base, 'releases', v), { recursive: true });
    writeFileSync(path.join(base, 'releases', v, 'package.json'), JSON.stringify({ version: v }));
  }
  symlinkSync(path.join('releases', 'main-102'), path.join(base, 'current'));
  return base;
}

test('a process on the old release reports what it runs, and what the box would run', (t) => {
  const base = layout(t);
  // What a service started before the update sees: its install root resolves
  // to the real directory it was launched from, not through the link.
  const running = realpathSync(path.join(base, 'releases', 'main-88'));

  assert.equal(installedVersion(running), 'main-88', 'the process is on main-88');
  assert.equal(currentVersion(running), 'main-102', 'the disk is on main-102');
});

test('a process on the new release sees no gap', (t) => {
  const base = layout(t);
  const running = realpathSync(path.join(base, 'releases', 'main-102'));
  assert.equal(installedVersion(running), 'main-102');
  assert.equal(currentVersion(running), 'main-102');
});

test('asked through the link, both answers are the link', (t) => {
  const base = layout(t);
  assert.equal(currentVersion(path.join(base, 'current')), 'main-102');
});

test('a checkout has no second answer', () => {
  // Not a release layout: no `current`, nothing to compare, and null rather
  // than 'unknown' so a caller cannot mistake it for a version to draw.
  assert.equal(currentVersion('/home/somebody/fleetwright'), null);
});

test('what `current` holds is read only as a package.json: not through a link, not at any size, not a version of any shape', (t) => {
  // The sidecar reads `current` on every health frame, and the service user
  // owns the base it is under. A package.json linked to a file only the
  // sidecar's account can read was parsed and its version sent with health; a
  // FIFO blocked the sidecar's one thread for good.
  const base = layout(t);
  const release = path.join(base, 'releases', 'main-102');
  const secret = path.join(base, 'only-the-sidecar-reads-this.json');
  writeFileSync(secret, JSON.stringify({ version: 'what-the-sidecar-keeps' }));
  rmSync(path.join(release, 'package.json'));
  symlinkSync(secret, path.join(release, 'package.json'));
  assert.equal(currentVersion(path.join(base, 'current')), null, 'read through a link');

  rmSync(path.join(release, 'package.json'));
  writeFileSync(path.join(release, 'package.json'), JSON.stringify({ version: 'main-102', pad: 'x'.repeat(300 * 1024) }));
  assert.equal(installedVersion(release), 'unknown', 'read whatever its size');
  writeFileSync(path.join(release, 'package.json'), JSON.stringify({ version: { not: 'a version' } }));
  assert.equal(installedVersion(release), 'unknown', 'passed on a version of any shape');
});

test('a FIFO where package.json should be is not waited on', { skip: spawnSync('mkfifo', ['--version']).status !== 0 && 'no mkfifo here' }, (t) => {
  // In a child, because a read that blocks blocks the test runner with it.
  const base = layout(t);
  const release = path.join(base, 'releases', 'main-102');
  rmSync(path.join(release, 'package.json'));
  assert.equal(spawnSync('mkfifo', [path.join(release, 'package.json')]).status, 0);
  const mod = new URL('../src/core/release-apply.js', import.meta.url).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(mod)}); console.log(m.installedVersion(${JSON.stringify(release)}))`], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.signal, null, 'it waited on the FIFO until it was killed');
  assert.equal(r.stdout.trim(), 'unknown', r.stderr);
});
