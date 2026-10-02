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
import { fingerprint } from '../src/fleet/crypto.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/seal.json', import.meta.url), 'utf8'));

test('the phones’ sealed message opens with seal.js, to the plaintext they were given', async () => {
  const recipient = await importDepositKey(JSON.stringify({ kty: 'EC', crv: 'P-256', ...fixture.recipient }));
  assert.equal(recipient.publicKey, fixture.recipient.publicKey);
  const opened = await open({ privateKey: recipient.privateKey, publicKey: recipient.publicKey, aad: fixture.aad, sealed: fixture.sealed });
  assert.deepEqual(opened, JSON.parse(fixture.plaintext));
  // And it is bound to its additional data, as every seal here is.
  await assert.rejects(open({ privateKey: recipient.privateKey, publicKey: recipient.publicKey, aad: 'something else', sealed: fixture.sealed }));
});

test('the box fingerprint the phones work out is the one a box prints', async () => {
  // fleetwright-sidecar identity prints crypto.js's fingerprint; both phones
  // compute it themselves from the key the fleet lists, to approve a box for a
  // vault (PhoneVault.kt, PhoneVault.swift), and are tested against this.
  assert.equal(await fingerprint(fixture.boxKey), fixture.fingerprint);
  assert.match(fixture.fingerprint, /^[0-9a-f]{16}$/);
});
