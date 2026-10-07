// The two phones say the same thing about what a session cost, how its run
// spent its time, and how long it has been waiting on a person.
//
//   node --test test/telemetry-in-apps.test.js
//
// A grep, not a run: the Swift is compiled by CI's iOS job and the Kotlin by
// the Android one, and each has a unit test of the words (TelemetryTests.swift,
// TelemetryTest.kt). What neither can check is that the OTHER phone uses the
// same words — that is a question about two files, and this answers it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const IOS = (/** @type {string} */ f) => read(`apps/ios/Fleetwright/${f}`);
const ANDROID = (/** @type {string} */ f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`);
const SWIFT = IOS('Fleet.swift');
const KOTLIN = ANDROID('Fleet.kt');
const SWIFT_TEST = read('apps/ios/FleetwrightTests/TelemetryTests.swift');
const KOTLIN_TEST = read('apps/android/app/src/test/java/network/thetech/fleetwright/TelemetryTest.kt');

test('both phones decode the three fields the host sends, each one optional', () => {
  // Optional all the way down: a host one release behind sends none of them,
  // and a non-optional field would fail the whole list reply, not the line.
  assert.match(SWIFT, /let awaitingSince: Double\?/);
  assert.match(SWIFT, /let phases: Phases\?/);
  assert.match(SWIFT, /let spent: Spent\?/);
  assert.match(KOTLIN, /val awaitingSince: Long\? = null/);
  assert.match(KOTLIN, /val phases: Phases\? = null/);
  assert.match(KOTLIN, /val spent: Spent\? = null/);
});

test('neither phone prices anything: the dollars are Claude Code\'s, and only said as such', () => {
  for (const [name, src] of [['iOS', SWIFT], ['Android', KOTLIN]]) {
    assert.ok(src.includes(' at API prices'), `${name} lost the words that say what the figure is`);
    assert.doesNotMatch(src, /perMillion|pricePer|PRICE_TABLE|costPerToken/i, `${name} has a price table`);
  }
});

test('the words are the same on both phones', () => {
  for (const words of ['Waiting for you · ', 'Worked ', 'waited on you ', 'at its prompt ', 'counted for the last ', 'under 1m', 'at least ', ' at API prices', ' tokens', ' out', 'as of ', ' ago']) {
    assert.ok(SWIFT.includes(words), `iOS lost: ${words}`);
    assert.ok(KOTLIN.includes(words), `Android lost: ${words}`);
  }
});

test('the unit tests on both phones pin the same sentences', () => {
  for (const sentence of [
    '"12m"',
    'Worked 42m · waited on you 3m · at its prompt 1h 10m',
    'Worked under 1m',
    'Worked 2h · counted for the last 2h',
    '$12.40 at API prices · 48k tokens out',
    'at least $0.47 at API prices · 84 tokens out',
    '$835.96 at API prices · 4.6M tokens out · as of 12m ago',
  ]) {
    assert.ok(SWIFT_TEST.includes(sentence), `iOS test lost: ${sentence}`);
    assert.ok(KOTLIN_TEST.includes(sentence), `Android test lost: ${sentence}`);
  }
});

test('both draw them on the session\'s own page, and colour the state when it is waiting on you', () => {
  const page = IOS('SessionView.swift');
  const sheet = ANDROID('SessionSheet.kt');
  for (const [name, src] of [['iOS', page], ['Android', sheet]]) {
    assert.match(src, /session\.timeLine\(/, `${name} does not draw the time`);
    assert.match(src, /session\.spentLine\(/, `${name} does not draw the cost`);
    assert.match(src, /session\.isWaitingOnYou/, `${name} colours the state off the question alone`);
  }
  // The rows stay one shape (CLAUDE.md, RHYTHM 1): the cost and the time are
  // on the page somebody opened, not on every row of the list.
  assert.doesNotMatch(IOS('FleetView.swift'), /spentLine|timeLine/);
  assert.doesNotMatch(ANDROID('MainActivity.kt'), /spentLine|timeLine/);
});
