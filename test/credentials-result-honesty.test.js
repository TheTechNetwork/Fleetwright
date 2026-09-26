// THE CREDENTIALS SCREEN SAYS WHAT THE HOST FOUND, not what the app did.
//
// Both apps used to answer a finished authorization with "Checked with
// GitHub." — deliberately, on the principle that the row underneath is the
// authority and the app should not claim more than it knows. The principle is
// right and the sentence was still wrong: rendered directly above a row
// reading "not connected", it is two sentences that disagree, with the
// reassuring one on top and in the place a person looks after tapping. A
// connect that stored nothing read as a success, and the only way to find out
// was to notice the small grey text beneath it contradicting the banner.
//
// Checked on the source rather than by running it: neither app builds here,
// and the property is "this consults the refreshed connections before it
// speaks", which breaks by somebody restoring the unconditional string.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** The block that runs when an authorization comes back. */
function authorizeBlock(src, start, end) {
  const a = src.indexOf(start);
  assert.notEqual(a, -1, `could not find ${start}`);
  const b = src.indexOf(end, a);
  assert.notEqual(b, -1, `could not find ${end}`);
  return src.slice(a, b);
}

test('iOS words the result from the refreshed connections', () => {
  const src = readFileSync(new URL('../apps/ios/Fleetwright/Credentials.swift', import.meta.url), 'utf8');
  const block = authorizeBlock(src, 'private func authorize(', 'private func forget(');

  assert.match(block, /await load\(\)/, 'it must refresh before it speaks');
  assert.match(
    block,
    /connections\.linked\(provider\.provider\)\s*!=\s*nil/,
    'the result must consult the same fact the row renders',
  );
  assert.match(block, /did not connect/, 'a failed connect must say so');
  // The regression: an unconditional success line with nothing testing it.
  const unconditional = /result\s*=\s*"Checked with \\\(provider\.label\)\."/;
  assert.doesNotMatch(block, unconditional, 'the result went back to claiming success unconditionally');
});

test('Android words the result from the refreshed connections', () => {
  const src = readFileSync(
    new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/CredentialsSheet.kt', import.meta.url),
    'utf8',
  );
  const block = authorizeBlock(src, 'WebAuth.returned.collect', 'AlertDialog(');

  assert.match(block, /connections\.linked\(/, 'the result must consult the same fact the row renders');
  assert.match(block, /did not connect/, 'a failed connect must say so');
  // The callback is global, so the provider has to be captured before `pending`
  // is cleared or the message cannot name which one came back.
  const capture = block.indexOf('val came = pending');
  const clear = block.indexOf('pending = null');
  assert.notEqual(capture, -1, 'the provider must be captured from pending');
  assert.ok(capture < clear, 'it must be captured BEFORE pending is cleared');
  assert.doesNotMatch(
    block,
    /result\s*=\s*"Checked with the provider\."\s*\n\s*}/,
    'the result went back to the unconditional string',
  );
});
