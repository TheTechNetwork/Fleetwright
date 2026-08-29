// Starting a session takes up to a minute. The app has to say so.
//
// Reported as "creating a new session still hangs after clicking start". It
// was not hanging: the host brings up a container, seeds credentials into a
// fresh volume and waits out the Remote Control check, which the iOS sheet
// answered by GREYING OUT THE BUTTON AND CHANGING NOTHING ELSE. That is
// indistinguishable from a hang, and a person is right to read it as one.
//
// The fix is not to make it faster — the work is real. It is to make the
// waiting legible, and to be honest about what a timeout does and does not
// mean.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SHEETS = [
  ['iOS', 'apps/ios/Fleetwright/StartSheet.swift'],
  ['Android', 'apps/android/app/src/main/java/network/thetech/fleetwright/StartSheet.kt'],
];

test('both sheets show something moving while they wait', () => {
  for (const [name, path] of SHEETS) {
    const src = read(path);
    assert.match(src, /ProgressView|CircularProgressIndicator/, `${name} shows no progress indicator`);
    assert.match(src, /Starting…/, `${name} does not say it is starting`);
  }
});

test('and say WHAT they are waiting for once it drags', () => {
  // A spinner says "wait". This says what for, which is the difference between
  // waiting and wondering whether it broke.
  for (const [name, path] of SHEETS) {
    const src = read(path);
    assert.match(src, /Still starting/, `${name} never explains the wait`);
    assert.match(src, /Remote Control/, `${name} does not say what the box is doing`);
  }
});

test('a timeout is not reported as a failure', () => {
  // THE PART THAT MATTERS MOST. `start` is mutating and carries an idempotency
  // key, so a request that gave up may well have started a session anyway.
  // "Failed" would send somebody to start a second one — and the second would
  // be a NEW session, because a new attempt mints a new key.
  for (const [name, path] of SHEETS) {
    const src = read(path);
    assert.match(src, /Still starting, or started/, `${name} calls a timeout a failure`);
    assert.match(src, /pull to refresh/i, `${name} does not point at the list`);
    assert.match(src, /not run twice/, `${name} does not say retrying is safe`);
  }
});

test('the sheet keeps what was typed when something goes wrong', () => {
  // Pre-existing and worth keeping pinned: the sheet holds the only copy of
  // the brief and title, so closing it to show an error elsewhere throws that
  // away.
  for (const [name, path] of SHEETS) {
    assert.match(read(path), /only copy of what they typed|only copy of what they/, `${name} may be discarding the draft`);
  }
});
