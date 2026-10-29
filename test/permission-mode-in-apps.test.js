// New session names the permission mode from what the box says, and offers
// bypassing only where the box allows it.
//
//   node --test test/permission-mode-in-apps.test.js
//
// The choice a start sheet selects first is the box's own default, which
// sends no mode: the operator's FLEETWRIGHT_SKIP_PERMISSIONS decides, and a
// box set to ask refuses a fleet start that asks to bypass
// (test/fleet-permission-ceiling.test.js owns that). So the sheet names the
// default only from the box's `permissions` health field (C-5), and draws
// "Permissions bypassed" only behind a condition (C-2), in the same words on
// both phones. The Swift and the Kotlin compile only in CI, so this reads them
// as text: the words a person sees, and the guard around the one choice that
// can be refused.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

const PHONES = { iOS: iosSources(), Android: androidSources() };

/**
 * A sentence written across lines read as one: Swift's multi-line string
 * continuations, and Kotlin's `"..." + "..."`.
 *
 * @param {string} src
 */
const joined = (src) => src.replace(/\\\n\s*/g, '').replace(/"\s*\+\s*"/g, '');

const WORDS = [
  'Box default',
  'Box default — asks before each tool',
  'Box default — permissions bypassed',
  'Permission prompts on',
  'Permissions bypassed',
  'It stops and asks before each tool, whatever its machine is set to.',
  'It runs each tool without asking first.',
  'It asks before each tool, because that is how its machine is set.',
  'It runs each tool without asking, because that is how its machine is set.',
  'It runs the way its machine is set.',
  'Permissions bypassed is not offered while the fleet picks the machine: one of them is set to ask before each tool.',
  'Permissions bypassed is not offered here: this machine is set to ask before each tool.',
  'Box default leaves permissions to the machine. Permission prompts on asks before each tool wherever it starts. ' +
    "Bypassing them is chosen on New session, where each machine's setting is shown.",
];

test('both phones say the permission mode in the same words', () => {
  for (const [phone, src] of Object.entries(PHONES)) {
    for (const words of WORDS) assert.ok(joined(src).includes(words), `${phone} does not say: ${words}`);
  }
});

test('both phones read what the box says its default is, and draw bypassing only behind a condition', () => {
  // A Permissions bypassed choice: a picker row on iOS, a chip on Android.
  const CHOICE = { iOS: /Text\("Permissions bypassed"\)/g, Android: /AssistChip\(\s*onClick = \{[^}\n]*"dangerous"[^}\n]*\}/g };
  for (const [phone, src] of Object.entries(PHONES)) {
    // The health field, and the word that takes the choice away.
    assert.match(src, /permissions == "asks"/, phone);
    const choices = [...src.matchAll(CHOICE[/** @type {'iOS'|'Android'} */ (phone)])];
    assert.ok(choices.length > 0, `${phone} has no Permissions bypassed choice at all`);
    for (const m of choices) {
      const before = src.slice(Math.max(0, /** @type {number} */ (m.index) - 120), m.index);
      assert.match(before, /\bif [^\n{]+\{\s*$/, `${phone} draws a Permissions bypassed choice unconditionally`);
    }
  }
});
