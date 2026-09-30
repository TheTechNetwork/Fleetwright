// The two phones say the same thing about where somebody's machines come from,
// and offer a new machine only where one can be started.
//
//   node --test test/runner-repo-in-apps.test.js
//
// A read of the sources, not a run: the Swift and the Kotlin compile only in
// CI, and each phone has a unit test of its own words. What neither can check
// is that the OTHER phone uses the same ones.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const IOS = ['Fleet.swift', 'FleetView.swift', 'StartSheet.swift'].map((f) => read(`apps/ios/Fleetwright/${f}`)).join('\n');
const ANDROID = ['Fleet.kt', 'SettingsPanel.kt', 'StartSheet.kt', 'MainActivity.kt']
  .map((f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`))
  .join('\n');

test('the words about a runner repository are the same on both phones', () => {
  for (const words of [
    'Your runner repository (owner/repo)',
    'Check and save',
    'Use the fleet\'s repository instead',
    'Remove your runner repository',
    'Your machines come from the fleet\'s repository, ',
    'Set your own to use your free Actions minutes.',
    'Set a public repository with the Fleetwright GitHub App installed and the runner workflows in it, and your machines come from there.',
    'Public: ',
    ' · GitHub app: ',
    'Actions write: ',
    ' · Machines: ',
    'can\'t tell',
  ]) {
    assert.ok(IOS.includes(words), `iOS lost: ${words}`);
    assert.ok(ANDROID.includes(words), `Android lost: ${words}`);
  }
});

test('the same four new machines, in the same order, on both phones', () => {
  const order = (/** @type {string} */ src) =>
    [...src.matchAll(/"(New (?:Linux|macOS|Windows) machine|New Android emulator)"/g)].map((m) => m[1]);
  const expected = ['New Linux machine', 'New macOS machine', 'New Windows machine', 'New Android emulator'];
  assert.deepEqual(order(read('apps/ios/Fleetwright/StartSheet.swift')), expected);
  assert.deepEqual(order(read('apps/android/app/src/main/java/network/thetech/fleetwright/StartSheet.kt')), expected);
  // And the promise that comes with choosing one.
  for (const src of [IOS, ANDROID]) {
    assert.match(src, /The session starts on it when it joins/);
    assert.match(src, /Everything on it is "\s*\+\s*"gone when the time runs out\./);
  }
});

test('a new machine is offered only where the fleet can start one (C-2)', () => {
  // Drawn from the snapshot's `runners` and nothing else: a fleet with no
  // runner repository for this person offers no machine, rather than one that
  // is refused on tap.
  assert.match(IOS, /canStartMachine = \(try\? await fleet\.runners\(\)\) != nil/);
  assert.match(IOS, /if canStartMachine \{\s*ForEach\(newMachineChoices/);
  assert.match(ANDROID, /canStartMachine = Fleet\(settings\)\.runners\(\)\.getOrNull\(\) != null/);
  assert.match(ANDROID, /if \(canStartMachine\) \{\s*newMachineChoices\.forEach/);
  // And the setting is drawn only for a credential that can have one.
  assert.match(IOS, /if runnerRepoAnswered \{/);
  assert.match(ANDROID, /if \(runnerRepoAnswered\) \{/);
});

test('a new machine carries the session, and is never held offline without it', () => {
  // The outbox replays verb, params and host. A provision replayed without
  // its session would start a machine nobody is waiting on.
  assert.match(IOS, /extra\.isEmpty,/);
  assert.match(ANDROID, /extra\.isEmpty\(\) && isDeliveryFailure/);
  assert.match(IOS, /\.provision\(platform: platform, minutes: request\.minutes, start: start\)/);
  assert.match(ANDROID, /fleet\.provision\(platform, minutes = request\.minutes, start = start\)/);
});
