// Starting a session must not make anybody wait.
//
// Reported first as "creating a new session still hangs after clicking start".
// It was not hanging: the host brings up a container, seeds credentials into a
// fresh volume and waits out the Remote Control check — up to a minute of real
// work — and the sheet answered by greying out the button and changing nothing.
//
// TWO FIXES WERE WRONG IN THE SAME DIRECTION before this one. A spinner, then
// a spinner with an explanation. Explaining a wait is still a wait, and the
// correction was the obvious thing once said out loud: nobody needs to be
// present for it.
//
//   "Start shouldn't show starting but rather close with your session will
//    start shortly and notify once ready or if any issues."
//
// So these tests assert the ABSENCE of the wait, which is the unusual shape
// here — a test that fails if somebody reintroduces a progress indicator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/**
 * Source with the prose taken out.
 *
 * FOURTH TIME. A tripwire that greps raw source keeps finding the COMMENT
 * explaining the thing it is looking for and calling it the defect — it has
 * cost a rewrite on the redaction check, the TestFlight check, the refresh
 * token check and now this one. A check on code has to read code.
 */
const code = (p) =>
  read(p)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
const SHEETS = [
  ['iOS', 'apps/ios/Fleetwright/StartSheet.swift'],
  ['Android', 'apps/android/app/src/main/java/network/thetech/fleetwright/StartSheet.kt'],
];

test('the sheet closes on tap and does not await the start', () => {
  for (const [name, path] of SHEETS) {
    const src = code(path);
    // No BUSY state, because there is nothing to be busy for. Written as
    // "no `busy` flag" rather than "no spinner": the title-suggestion
    // spinner is local, instant, and entirely legitimate — the thing that
    // must not come back is a wait on the network round trip.
    assert.equal(/\bbusy\b/.test(src), false, `${name} still tracks a busy state while starting`);
    assert.match(src, /hand(s| it)? up|onStart/i, `${name} still owns the request it should hand up`);
  }
});

test('the request outlives the sheet that described it', () => {
  // A task tied to a dismissed view is one that may not finish, and this is a
  // mutating request that has already left.
  const ios = read('apps/ios/Fleetwright/FleetView.swift');
  assert.match(ios, /startInBackground/, 'iOS does not own the start task above the sheet');
  assert.match(ios, /LocalNotice\.post/, 'iOS never tells anybody how it went');

  const android = read('apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt');
  assert.match(android, /startInBackground/, 'Android does not own the start task above the sheet');
});

test('a timeout is still not reported as a failure', () => {
  // `start` is mutating and carries an idempotency key, so a request that gave
  // up may well have started a session. "Failed" would send somebody to start
  // a second one — and the second WOULD be a second session, because a retry
  // mints a new key.
  for (const [name, path] of [
    ['iOS', 'apps/ios/Fleetwright/FleetView.swift'],
    ['Android', 'apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt'],
  ]) {
    const src = read(path);
    assert.match(src, /Still starting, or started/, `${name} calls a timeout a failure`);
  }
});

test('both outcomes reach somebody who has put the phone down', () => {
  // The whole promise: "notify once ready or if any issues". A success that is
  // only visible to somebody still looking at the screen is the wait again,
  // wearing a different hat.
  const ios = read('apps/ios/Fleetwright/FleetView.swift');
  assert.match(ios, /Session ready/, 'iOS does not announce success');
  assert.match(ios, /Could not start/, 'iOS does not announce failure');

  const android = read('apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt');
  assert.match(android, /Session ready/, 'Android does not announce success');
  assert.match(android, /Could not start/, 'Android does not announce failure');
});
