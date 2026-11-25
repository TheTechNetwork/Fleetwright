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
import { DELEGATION_LIMITS, MCP_UNDELEGATED_VERBS, needsSignature } from '../src/fleet/protocol/intent-signature.js';
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
// that needs a signature, less the two the phones leave out on purpose
// (MCP_UNDELEGATED_VERBS, which the coordinator's refusal reads so it never
// sends an MCP client to delegate one of them), the same on both phones, and
// small enough for a box to take.
test('both phones delegate to an MCP client exactly the verbs it offers that a box would want signed', () => {
  const offered = Object.keys(VERBS).filter((v) => !DEFAULT_DENY.includes(v) && !COORDINATOR_ONLY.includes(v) && needsSignature(v));
  const expected = offered.filter((v) => !MCP_UNDELEGATED_VERBS.includes(v)).sort();
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
    'Sent in your name: ', 'Allow for a day', 'Allow for a week', 'Revoke this delegation?',
    'Nothing is delegated. What the app sends now, it signs as it sends it.',
  ]) {
    assert.ok(iosSources().includes(words), `iOS does not say "${words}"`);
    assert.ok(androidSources().includes(words), `Android does not say "${words}"`);
  }
});

// WHOM AN MCP CLIENT MAY START SESSIONS AS is the person's choice, made on the
// phone and signed there: a box refuses a delegated start as a member the
// grant does not name (src/fleet/protocol/intent-signature.js). So both
// phones offer the same switches in the same words, start with none on, and
// say on a delegation's row whom it may start as.
test('both phones offer the members an MCP client may start as, none chosen until one is turned on', () => {
  const ios = iosSources();
  const android = androidSources();
  for (const words of [
    'Start sessions as ',
    "The MCP client may start a session as a member turned on here, on that member's sign-ins, and as no other member.",
    // A box from before the field refuses such a grant as badly signed, so
    // the switches say what to do about that refusal.
    'If a machine refuses a start as a member, update that machine: an older one does not take a grant that names members.',
    ' · starts sessions as ',
  ]) {
    assert.ok(ios.includes(words), `iOS does not say "${words}"`);
    assert.ok(android.includes(words), `Android does not say "${words}"`);
  }
  // Each switch reads one set, and that set starts empty.
  const iosSet = /Toggle\("Start sessions as \\\(\w+\.name\)", isOn: Binding\(\s*get: \{ (\w+)\.contains\(/.exec(ios)?.[1];
  assert.ok(iosSet, 'iOS has no switch for a member an MCP client may start as');
  assert.match(ios, new RegExp(`@State private var ${iosSet}: Set<String> = \\[\\]`), 'iOS starts with a member already chosen');
  const androidSet = /Text\("Start sessions as \$\{\w+\.name\}"[\s\S]{0,200}?Switch\(\s*checked = \w+\.id in (\w+),/.exec(android)?.[1];
  assert.ok(androidSet, 'Android has no switch for a member an MCP client may start as');
  assert.match(android, new RegExp(`var ${androidSet} by remember \\{ mutableStateOf\\(setOf<String>\\(\\)\\) \\}`), 'Android starts with a member already chosen');
  // And what is turned on is what the grant is asked to name.
  assert.match(ios, new RegExp(`\\.allowMCP\\(days: \\w+, members: Array\\(${iosSet}\\)\\)`));
  assert.match(android, new RegExp(`\\.allowMcp\\(\\w+, ${androidSet}\\.toList\\(\\)\\)`));
});

// THE BYTES. `members` is a key of the grant, so it is in what the phone signs
// (the whole grant, keys sorted, which puts it between `match` and `v`) and in
// what it sends. A GRANT THAT NAMES NOBODY LEAVES THE KEY OUT, never `[]`: it
// is then byte for byte the grant a phone made before the field, which every
// box already takes, and which test/fixtures/parity/intent-signing.json holds.
test('a grant carries members only when it names some, and what is signed is what is sent', () => {
  assert.match(
    iosSources(),
    /if !(\w+)\.isEmpty \{ grant\["members"\] = \1 \}\s*guard let sig = try\? key\.sign\(IntentSigning\.delegationInput\(grant\)\) else \{ return nil \}\s*return \["grant": grant,/,
    'iOS sends an empty members list, or signs a grant other than the one it sends',
  );
  assert.match(
    androidSources(),
    /val grant = if \((\w+)\.isEmpty\(\)\) (\w+) else \2 \+ \("members" to \1\)\s*val sig = runCatching \{ key\.sign\(IntentSigning\.delegationInput\(grant\)\) \}[^\n]*\n\s*return JSONObject\(\)\.put\("grant", JSONObject\(grant\)\)/,
    'Android sends an empty members list, or signs a grant other than the one it sends',
  );
});

// A START AS A MEMBER THAT THE FLEET PLACES goes under a ten-minute grant the
// phone signs for that one request. It names the member, or a box that takes
// a member start only from a grant that names it refuses the phone's own.
test('a start as a member that the fleet places names that member in its grant, and nothing else names any', () => {
  assert.match(iosSources(), /let (\w+) = verb == "start" \? \(params\["member"\] \?\? ""\) : ""[\s\S]{0,200}?members: \1\.isEmpty \? \[\] : \[\1\]\)/);
  assert.match(androidSources(), /val (\w+) = if \(verb == "start"\) params\["member"\]\.orEmpty\(\) else ""[\s\S]{0,260}?if \(\1\.isEmpty\(\)\) emptyList\(\) else listOf\(\1\),/);
});
