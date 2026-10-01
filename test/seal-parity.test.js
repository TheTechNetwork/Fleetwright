// The sealed message both phones are tested against is one seal.js opens.
//
//   node --test test/seal-parity.test.js
//
// test/fixtures/parity/seal.json is a message sealed with every random value
// written down. The phones prove against it that they build the same bytes
// (SealTest.kt, SealTests.swift) and open what the minter sends them. This is
// the third leg: that the fixture is what src/fleet/seal.js makes, so "the
// phone matches the fixture" means "the phone matches the minter" rather than
// "the phone matches a file somebody typed".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { importDepositKey, open } from '../src/fleet/seal.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/seal.json', import.meta.url), 'utf8'));

test('the phones’ sealed message opens with seal.js, to the plaintext they were given', async () => {
  const recipient = await importDepositKey(JSON.stringify({ kty: 'EC', crv: 'P-256', ...fixture.recipient }));
  assert.equal(recipient.publicKey, fixture.recipient.publicKey);
  const opened = await open({ privateKey: recipient.privateKey, publicKey: recipient.publicKey, aad: fixture.aad, sealed: fixture.sealed });
  assert.deepEqual(opened, JSON.parse(fixture.plaintext));
  // And it is bound to its additional data, as every seal here is.
  await assert.rejects(open({ privateKey: recipient.privateKey, publicKey: recipient.publicKey, aad: 'something else', sealed: fixture.sealed }));
});
