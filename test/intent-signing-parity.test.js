// The bytes both phones sign for an intent are the bytes a box checks.
//
//   node --test test/intent-signing-parity.test.js
//
// test/fixtures/parity/intent-signing.json holds intents and the signing input
// for each. The phones prove against it that they build the same string
// (IntentSigningTests.swift, IntentSigningTest.kt). This is the third leg: that
// the file is what src/fleet/protocol/intent-signature.js makes, so "the phone
// matches the fixture" means "the phone matches the box" rather than "the
// phone matches a file somebody typed". The cases are the places a JSON
// encoder other than JavaScript's differs from it: key order, numbers, which
// characters are escaped and how.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { intentSigningInput, keyId } from '../src/fleet/protocol/intent-signature.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/intent-signing.json', import.meta.url), 'utf8'));

test('each intent’s signing input in the phones’ fixture is the one a box builds', () => {
  assert.ok(fixture.cases.length >= 8, 'the fixture lost its cases');
  for (const c of fixture.cases) assert.equal(intentSigningInput(c.intent, c.host), c.input, c.why);
});

test('and the key id the phones send is the one the minter lists the key under', async () => {
  assert.equal(await keyId(fixture.key.jwk), fixture.key.kid);
});
