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
// allowed (C-5). The Swift compiles only in CI, so this reads it as text: the
// words a person sees, including why the choice is missing, and the condition
// around the one choice that can be refused.

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
  'Permissions bypassed is not offered while the fleet picks the machine: one of them has not said what it allows.',
  'Permissions bypassed is not offered here: this machine has not said what it allows.',
  'Permissions bypassed is not offered: no machine this could start on has said what it allows.',
  'Box default leaves permissions to the machine. Permission prompts on asks before each tool wherever it starts. ' +
    "Bypassing them is chosen on New session, where each machine's setting is shown.",
];

test('iOS says the permission mode in these words', () => {
  for (const words of WORDS) assert.ok(joined(IOS).includes(words), `iOS does not say: ${words}`);
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

test('iOS draws bypassing only when every machine it could land on says it bypasses', () => {
  // The health field, and the word that takes the choice away.
  assert.match(IOS, /permissions == "asks"/);
  // Every Permissions bypassed choice, the kinds editor's included (it shows
  // one only for a kind already saved that way), is behind a condition.
  const all = [...IOS.matchAll(/Text\("Permissions bypassed"\)/g)];
  for (const m of all) {
    const before = IOS.slice(Math.max(0, /** @type {number} */ (m.index) - 120), m.index);
    assert.match(before, /\bif [^\n{]+\{\s*$/, 'a Permissions bypassed choice is drawn unconditionally');
  }
  // The one on New session, which sends the bypass with the start, is behind
  // a condition that holds only when every machine has said it bypasses.
  const choices = [...IOS.matchAll(/Text\("Permissions bypassed"\)\.tag\("dangerous"\)/g)];
  assert.ok(choices.length > 0, 'no Permissions bypassed choice on New session');
  for (const m of choices) {
    const before = IOS.slice(Math.max(0, /** @type {number} */ (m.index) - 120), m.index);
    const guard = before.match(/\bif \(?([A-Za-z_]\w*)\)? \{\s*$/);
    assert.ok(guard, 'the Permissions bypassed choice is drawn without a plain condition around it');
    const body = definition(IOS, guard[1]);
    assert.ok(body, `no definition of ${guard[1]}`);
    // Every machine, not "none of them asks": a machine that has not said, or
    // no machine at all, must leave the choice out.
    assert.match(body, /"bypassed"/, `${guard[1]} does not ask for "bypassed"`);
    assert.match(body, /allSatisfy|\.all \{/, `${guard[1]} is not about every machine`);
    assert.match(body, /!\w+\.isEmpty|\.isNotEmpty\(\)/, `${guard[1]} allows it with no machine to judge`);
    assert.doesNotMatch(body, /"asks"/, `${guard[1]} is "none asks", which lets cannot tell through`);
    // And the send holds to the same condition, so a choice made while it was
    // offered is not sent after it went.
    assert.match(IOS, new RegExp(`"dangerous" && ${guard[1]}\\)? \\? permission`), 'the send is not guarded');
  }
});
