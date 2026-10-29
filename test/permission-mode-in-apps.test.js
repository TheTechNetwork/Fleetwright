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
// "Permissions bypassed" only behind a condition (C-2). The Swift compiles
// only in CI, so this reads it as text: the words a person sees, and the
// guard around the one choice that can be refused.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';

const IOS = iosSources();

/** Swift's multi-line string continuations joined, so a sentence reads as one. */
const joined = (/** @type {string} */ src) => src.replace(/\\\n\s*/g, '');

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

test('iOS says the permission mode in these words', () => {
  for (const words of WORDS) assert.ok(joined(IOS).includes(words), `iOS does not say: ${words}`);
});

test('iOS reads what the box says its default is, and draws bypassing only behind a condition', () => {
  // The health field and the word that takes the choice away.
  assert.match(IOS, /permissions == "asks"/);
  const choices = [...IOS.matchAll(/Text\("Permissions bypassed"\)/g)];
  assert.ok(choices.length > 0, 'no Permissions bypassed choice at all');
  for (const m of choices) {
    const before = IOS.slice(Math.max(0, /** @type {number} */ (m.index) - 120), m.index);
    assert.match(before, /\bif [^\n{]+\{\s*$/, 'a Permissions bypassed choice is drawn unconditionally');
  }
});
