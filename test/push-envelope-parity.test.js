// The sealed notification both phones are tested against is one this
// coordinator opens.
//
//   node --test test/push-envelope-parity.test.js
//
// test/push-encryption.test.js seals to a fresh key every run, which proves
// the scheme and says nothing about whether a phone derives the same key.
// test/fixtures/parity/push-envelope.json is one notification envelopeFor
// sealed, with the recipient's private key written down: PushCryptoTest.kt
// and PushCryptoTests.swift open it. This is the third leg, the same one
// seal-parity.test.js is for seal.json: the fixture is what
// src/fleet/push-crypto.js makes, so "the phone opens the fixture" means "the
// phone opens what the coordinator sends".
//
// AN ANSWERABLE PROMPT, as the coordinator sends one (core.js, `#notify`):
// the session, the box, the prompt id, the digits and the sealed
// category. The phones test their category rule against it, so a fixture
// with nothing to answer would let that rule pass by never running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { openWith } from '../src/fleet/push-crypto.js';
import { PROMPT_CATEGORY } from '../src/fleet/coordinator/core.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/push-envelope.json', import.meta.url), 'utf8'));

test('the phones’ sealed notification opens with push-crypto.js, to the words they are given', async () => {
  const { d, x, y, pushKey } = fixture.recipient;
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d, x, y, ext: true },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  assert.deepEqual(await openWith(privateKey, pushKey, fixture.envelope), fixture.plaintext);

  const { data } = fixture.plaintext;
  assert.ok(data.category.startsWith(`${PROMPT_CATEGORY}.`), 'the fixture seals no category, so the phones’ category rule is untested');
  assert.ok(data.promptId && /^a:\d,b:\d$/.test(data.answers), 'the fixture is not an answerable prompt');
});
