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
  assert.equal(currentVersion('/home/somebody/agent-fleet'), null);
});
