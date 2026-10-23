// What both phones say and sign about delegations (docs/signed-intents.md,
// "Delegations"). The Swift and Kotlin compile only in CI, so this reads them
// as text, for the two things a person or a box would notice disagreeing.
//
//   node --test test/delegations-apps.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';
import { VERBS } from '../src/fleet/protocol/intents.js';
import { DELEGATION_LIMITS, needsSignature } from '../src/fleet/protocol/intent-signature.js';
import { COORDINATOR_ONLY, DEFAULT_DENY } from '../src/mcp/tools.js';

/** The quoted strings in the list literal that follows `marker`: Swift's `[…]`, Kotlin's `listOf(…)`. */
function listAfter(src, marker) {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `${marker} is gone`);
  const m = /[[(]([^\])]*)[\])]/.exec(src.slice(at));
  return [...String(m?.[1]).matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
}

// THE MCP DELEGATION IS A BOX'S CONTRACT: a verb missing from it is a tool an
// MCP client offers that an enforcing box then refuses, and a verb added to it
// is a permission nobody chose. So it is what the MCP server offers by default
// that needs a signature, less the two the phones leave out on purpose, the
// same on both phones, and small enough for a box to take.
test('both phones delegate to an MCP client exactly the verbs it offers that a box would want signed', () => {
  const offered = Object.keys(VERBS).filter((v) => !DEFAULT_DENY.includes(v) && !COORDINATOR_ONLY.includes(v) && needsSignature(v));
  const expected = offered.filter((v) => v !== 'exchange' && v !== 'update').sort();
  const ios = listAfter(iosSources(), 'static let mcpVerbs');
  const android = listAfter(androidSources(), 'internal val MCP_DELEGATED_VERBS');
  assert.deepEqual([...ios].sort(), expected);
  assert.deepEqual([...android].sort(), expected);
  assert.ok(expected.length <= DELEGATION_LIMITS.verbs, 'more verbs than a box takes in one delegation');
});

// THE SAME WORDS FOR THE SAME DELEGATION, because a person comparing two
// phones, or reading a refusal that says to look under You, should find one
// list in one language.
test('both phones name each kind of delegation in the same words', () => {
  for (const words of [
    'Finishing a sign-in', 'Ending machines kept ready', 'Making machines kept ready', 'An MCP client',
    'A request the fleet places: ', 'Allow for a day', 'Allow for a week', 'Revoke this delegation?',
    'Nothing is delegated. What the app sends now, it signs as it sends it.',
  ]) {
    assert.ok(iosSources().includes(words), `iOS does not say "${words}"`);
    assert.ok(androidSources().includes(words), `Android does not say "${words}"`);
  }
});
