// The envelope both phones open.
//
// test/push-encryption.test.js seals a fresh key every run, which proves the
// scheme and proves nothing about the bytes a phone was given. This file is
// one envelope, committed, opened here with the same code that sealed it and
// opened on each phone against the same file (PushCryptoTests.swift,
// PushCryptoTest.kt). A phone that derives a different key fails there, not
// by agreeing with itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { openWith, fromBase64 } from '../src/fleet/push-crypto.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/push-envelope.json', import.meta.url), 'utf8'));

test('the committed envelope still opens to the notification it was sealed from', async () => {
  const { d, x, y, pushKey } = fixture.recipient;
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d, x, y, ext: true },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  assert.deepEqual(await openWith(privateKey, pushKey, fixture.envelope), fixture.plaintext);

  const bytes = fromBase64(fixture.envelope);
  assert.equal(bytes[0], 1);
  assert.equal(bytes.length, 1 + 16 + 65 + (bytes.length - 82));
  assert.equal(bytes[17], 0x04);
  // The session name is inside, not in any field a relay could log beside the envelope.
  assert.equal(JSON.stringify({ envelope: fixture.envelope }).includes(fixture.plaintext.data.name), false);
});
