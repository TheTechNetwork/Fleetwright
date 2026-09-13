// Commit-confirm, the app's half: arm a trial and record health evidence. The
// DECISION (confirm or revert) belongs to a standing watchdog outside the app —
// see install/fleetwright-confirm and test/confirm-watchdog.test.js — because a
// watchdog inside a service cannot catch that service failing to start.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  armConfirmation,
  readConfirmation,
  noteHealth,
  confirmPath,
  evidencePath,
} from '../src/core/update-confirm.js';

/** A config with a throwaway state directory. */
function box(t) {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'confirm-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  return { stateDir, cfg: { stateDir, installDir: '/opt/x/releases/main-2' } };
}

test('a trial is armed as a shell-readable record with what a revert needs', (t) => {
  const s = box(t);
  const r = armConfirmation(s.cfg, { from: 'main-1', to: 'main-2', windowMs: 60_000, now: () => 1000 });
  assert.equal(r.armed, true);
  // KEY=VALUE, not JSON, because the watchdog that reads it is POSIX shell.
  const body = readFileSync(confirmPath(s.stateDir), 'utf8');
  assert.match(body, /^FROM=main-1$/m);
  assert.match(body, /^TO=main-2$/m);
  assert.match(body, /^WINDOW_MS=60000$/m);
  assert.match(body, /^ARMED_AT=1000$/m);
  assert.deepEqual(readConfirmation(s.cfg), { from: 'main-1', to: 'main-2', windowMs: 60_000, armedAt: 1000 });
});

test('commit-confirm off, or nothing to fall back to, arms nothing', (t) => {
  const s = box(t);
  assert.equal(armConfirmation(s.cfg, { from: 'main-1', to: 'main-2', windowMs: 0 }).armed, false, 'window 0 disables it');
  assert.equal(armConfirmation(s.cfg, { from: null, to: 'main-2', windowMs: 60_000 }).armed, false, 'no previous release');
  assert.equal(armConfirmation(s.cfg, { from: 'main-2', to: 'main-2', windowMs: 60_000 }).armed, false, 'same version');
  assert.equal(readConfirmation(s.cfg), null, 'and none of those wrote a record');
});

test('arming clears stale evidence, so a previous trial cannot confirm this one', (t) => {
  const s = box(t);
  // Evidence left from an earlier update.
  writeFileSync(evidencePath(s.stateDir, 'hub'), '');
  writeFileSync(evidencePath(s.stateDir, 'coord'), '');
  armConfirmation(s.cfg, { from: 'main-1', to: 'main-2', windowMs: 60_000 });
  assert.equal(existsSync(evidencePath(s.stateDir, 'hub')), false);
  assert.equal(existsSync(evidencePath(s.stateDir, 'coord')), false);
});

test('a half-written record is no trial, not a trial to act on', (t) => {
  const s = box(t);
  writeFileSync(confirmPath(s.stateDir), 'FROM=main-1\nTO=main-2\n'); // no window / armedAt
  assert.equal(readConfirmation(s.cfg), null);
});

test('health is recorded only while a trial is open, and is fresh', (t) => {
  const s = box(t);
  // No trial: nothing to record, and no stray files.
  assert.equal(noteHealth(s.cfg, 'hub').noted, false);
  assert.equal(existsSync(evidencePath(s.stateDir, 'hub')), false);

  armConfirmation(s.cfg, { from: 'main-1', to: 'main-2', windowMs: 60_000 });
  const trialAt = statSync(confirmPath(s.stateDir)).mtimeMs;
  const r = noteHealth(s.cfg, 'hub');
  assert.equal(r.noted, true);
  const evAt = statSync(evidencePath(s.stateDir, 'hub')).mtimeMs;
  assert.ok(evAt >= trialAt - 5, 'evidence is stamped no earlier than the trial it answers');

  assert.equal(noteHealth(s.cfg, 'nonsense').noted, false, 'only the two known halves are accepted');
});
