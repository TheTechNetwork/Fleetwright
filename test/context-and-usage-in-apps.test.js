// The two phones say the same thing about a window and an account's limits.
//
//   node --test test/context-and-usage-in-apps.test.js
//
// A grep, not a run: the Swift is compiled by CI's iOS job and the Kotlin by
// the Android one, and each has a unit test of the words. What neither can
// check is that the OTHER phone uses the same words — that is a question about
// two files, and this answers it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SWIFT = ['Fleet.swift', 'FleetView.swift', 'HostView.swift', 'SessionView.swift', 'Credentials.swift'].map((f) => read(`apps/ios/Fleetwright/${f}`)).join('\n');
const KOTLIN = ['Fleet.kt', 'SettingsPanel.kt', 'MainActivity.kt', 'SessionSheet.kt', 'CredentialsSheet.kt']
  .map((f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`))
  .join('\n');
const SWIFT_TEST = read('apps/ios/FleetwrightTests/ContextAndUsageTests.swift');
const KOTLIN_TEST = read('apps/android/app/src/test/java/network/thetech/fleetwright/ContextAndUsageTest.kt');

test('both phones decode the two additive fields the host sends, and neither invents a size', () => {
  assert.match(SWIFT, /let context: Context\?/);
  assert.match(KOTLIN, /val context: ContextUsage\? = null/);
  assert.match(SWIFT, /let usage: UsageReport\?/);
  assert.match(KOTLIN, /val usage: UsageReport\? = null/);
  // A count, never a percentage of a window whose size the host does not know.
  for (const src of [SWIFT, KOTLIN]) {
    assert.match(src, /in context"/);
    assert.doesNotMatch(src, /contextWindow|windowSize|\b200_?000\b/, 'a table about somebody else\'s models');
  }
});

test('the words are the same on both phones', () => {
  for (const words of ['in context', 'usage not reported', 'resets in ', '5h ', '7d ', 'Opus 7d ', 'Sonnet 7d ', '"now"']) {
    assert.ok(SWIFT.includes(words), `iOS lost: ${words}`);
    assert.ok(KOTLIN.includes(words), `Android lost: ${words}`);
  }
  // The same coarse units for a count.
  for (const words of ['tokens"', 'k"', '%.1fM']) {
    assert.ok(SWIFT.includes(words), `iOS lost: ${words}`);
    assert.ok(KOTLIN.includes(words), `Android lost: ${words}`);
  }
});

test('the unit tests on both phones pin the same sentences', () => {
  for (const sentence of [
    '248k in context',
    '412 tokens in context',
    '1.2M in context',
    '5h 42% · resets in 2h · 7d 12%',
    'usage not reported — the credential has expired and has not renewed yet',
    '5h 95% · resets in 1m · Opus 7d 50%',
  ]) {
    assert.ok(SWIFT_TEST.includes(sentence), `iOS test lost: ${sentence}`);
    assert.ok(KOTLIN_TEST.includes(sentence), `Android test lost: ${sentence}`);
  }
});

test('both draw them where a person looks: the session row and page, and the account\'s own row — not the host\'s', () => {
  const [fleetView, hostView, sessionView, credentials] = ['FleetView.swift', 'HostView.swift', 'SessionView.swift', 'Credentials.swift'].map((f) => read(`apps/ios/Fleetwright/${f}`));
  assert.match(fleetView, /session\.contextLine/);
  assert.match(sessionView, /session\.contextLine/);
  // An account is a person's, not a machine's: once, under "connected as".
  assert.match(credentials, /describeUsage\(usage\)/);
  // The function is defined in FleetView.swift beside describeWhoCanStart; what
  // must not exist is a Text drawn from it on a host surface.
  assert.doesNotMatch(fleetView, /Text\(describeUsage\(/, 'not on the host row');
  assert.doesNotMatch(hostView, /Text\(describeUsage\(/, 'not on the host page');
  const [settings, main, sheet, credentialsSheet] = ['SettingsPanel.kt', 'MainActivity.kt', 'SessionSheet.kt', 'CredentialsSheet.kt']
    .map((f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`));
  assert.match(main, /session\.contextLine/);
  assert.match(sheet, /session\.contextLine/);
  assert.match(credentialsSheet, /describeUsage\(usage\)/);
  assert.doesNotMatch(settings, /describeUsage\(/, 'not on the host card');
  // Coloured only when a window is nearly spent, and only from a figure.
  assert.match(SWIFT, /usage\.isNearLimit \? Design\.Palette\.attention/);
  assert.match(KOTLIN, /if \(usage\.isNearLimit\) MaterialTheme\.colorScheme\.error/);
});
