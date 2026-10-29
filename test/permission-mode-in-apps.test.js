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
// "Permissions bypassed" only when every machine the start could land on has
// said it bypasses: a box set to ask refuses it (C-2), and one that has not
// said may be set to ask with no refusal to stop it, so cannot tell is not
// allowed (C-5). The same words on both phones. The Swift and the Kotlin
// compile only in CI, so this reads them as text: the words a person sees,
// including why the choice is missing, and the condition around the one
// choice that can be refused.

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
  'Permissions bypassed is not offered while the fleet picks the machine: one of them has not said what it allows.',
  'Permissions bypassed is not offered here: this machine has not said what it allows.',
  'Permissions bypassed is not offered: no machine this could start on has said what it allows.',
  'Box default leaves permissions to the machine. Permission prompts on asks before each tool wherever it starts. ' +
    "Bypassing them is chosen on New session, where each machine's setting is shown.",
];

test('both phones say the permission mode in the same words', () => {
  for (const [phone, src] of Object.entries(PHONES)) {
    for (const words of WORDS) assert.ok(joined(src).includes(words), `${phone} does not say: ${words}`);
  }
});

/**
 * The body of the condition named `name`: a Swift computed property, or a
 * Kotlin `val`, up to the end of its block or line.
 *
 * @param {string} src @param {string} name
 */
function definition(src, name) {
  const start = src.search(new RegExp(`(?:var ${name}: Bool \\{|val ${name} =)`));
  if (start < 0) return null;
  const rest = src.slice(start);
  const ends = ['\n    }', '\n    //', '\n\n'].map((e) => rest.indexOf(e)).filter((n) => n > 0);
  return rest.slice(0, Math.min(...ends));
}

test('both phones draw bypassing only when every machine a start could land on says it bypasses', () => {
  // Any Permissions bypassed choice, a picker row on iOS or a chip on Android;
  // and the one on New session, which sends the bypass with the start. The
  // kinds editors show one only for a kind already saved that way.
  const ANY = { iOS: /Text\("Permissions bypassed"\)/g, Android: /AssistChip\(\s*onClick = \{[^}\n]*"dangerous"[^}\n]*\}/g };
  const START = { iOS: /Text\("Permissions bypassed"\)\.tag\("dangerous"\)/g, Android: /AssistChip\(\s*onClick = \{ permission = "dangerous" \}/g };
  const SEND = { iOS: (/** @type {string} */ g) => `"dangerous" && ${g}) ? permission`, Android: (/** @type {string} */ g) => `it == "dangerous" && ${g})` };
  for (const [name, src] of Object.entries(PHONES)) {
    const phone = /** @type {'iOS'|'Android'} */ (name);
    // The health field, and the word that takes the choice away.
    assert.match(src, /permissions == "asks"/, phone);
    for (const m of src.matchAll(ANY[phone])) {
      const before = src.slice(Math.max(0, /** @type {number} */ (m.index) - 120), m.index);
      assert.match(before, /\bif [^\n{]+\{\s*$/, `${phone} draws a Permissions bypassed choice unconditionally`);
    }
    const choices = [...src.matchAll(START[phone])];
    assert.ok(choices.length > 0, `${phone} has no Permissions bypassed choice on New session`);
    for (const m of choices) {
      const before = src.slice(Math.max(0, /** @type {number} */ (m.index) - 120), m.index);
      const guard = before.match(/\bif \(?([A-Za-z_]\w*)\)? \{\s*$/);
      assert.ok(guard, `${phone} draws the Permissions bypassed choice without a plain condition around it`);
      const g = guard[1];
      const body = definition(src, g);
      assert.ok(body, `${phone} has no definition of ${g}`);
      // Every machine, not "none of them asks": a machine that has not said,
      // or no machine at all, must leave the choice out.
      assert.match(body, /"bypassed"/, `${phone}: ${g} does not ask for "bypassed"`);
      assert.match(body, /allSatisfy|\.all \{/, `${phone}: ${g} is not about every machine`);
      assert.match(body, /!\w+\.isEmpty|\.isNotEmpty\(\)/, `${phone}: ${g} allows it with no machine to judge`);
      assert.doesNotMatch(body, /"asks"/, `${phone}: ${g} is "none asks", which lets cannot tell through`);
      // And the send holds to the same condition, so a choice made while it
      // was offered is not sent after it went.
      assert.ok(src.includes(SEND[phone](g)), `${phone} sends a bypass without checking ${g}`);
    }
  }
});
