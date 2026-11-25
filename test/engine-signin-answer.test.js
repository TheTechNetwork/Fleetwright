// What a box signs when it answers an engine sign-in with the page and the
// code, and so what a phone checks before it shows either (docs/engines.md,
// "The machine signs the page and the code").
//
// THE VECTOR is one answer signed once with a key made for it and kept
// nowhere: test/fixtures/parity/engine-signin-answer.json. ECDSA signatures
// differ each time they are made, so a phone cannot make this one again; it
// can only show that its check takes it, and refuses it with any one field
// changed. This file shows the same of the code a box runs, so the vector
// the phones carry is one the box would have made. That a real box signs a
// real answer this way is in test/vault.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verify, fromB64Url } from '../src/fleet/crypto.js';
import { keyId, signinAnswerInput } from '../src/fleet/protocol/intent-signature.js';
import { boxKeyHash } from '../src/fleet/minter/vault.js';

const VECTOR = JSON.parse(readFileSync(new URL('./fixtures/parity/engine-signin-answer.json', import.meta.url), 'utf8'));

test('the vector is what a box signs: the bytes, the key’s hash as the vault names a grant, and a signature that holds', async () => {
  // The exact bytes, written out, so a phone can compare a string before it compares a signature.
  assert.equal(signinAnswerInput(VECTOR.payload), VECTOR.signingInput);
  assert.equal(
    VECTOR.signingInput,
    `agent-fleet/v1/engine-signin-answer\n{"at":${VECTOR.payload.at},"code":"${VECTOR.payload.code}","engine":"${VECTOR.payload.engine}","host":"${VECTOR.host}","id":"${VECTOR.payload.id}","member":"${VECTOR.payload.member}","url":"${VECTOR.payload.url}","v":1}`,
  );
  // `host` is the hash a grant is filed under, over exactly these bytes.
  assert.equal(VECTOR.keyHashInput, `{"crv":"P-256","kty":"EC","x":"${VECTOR.hostKey.x}","y":"${VECTOR.hostKey.y}"}`);
  assert.equal(await boxKeyHash(VECTOR.hostKey), VECTOR.host);
  assert.equal(await keyId(VECTOR.hostKey), VECTOR.host);
  assert.equal(VECTOR.payload.host, VECTOR.host);
  // Raw r||s, base64url with no padding: 64 bytes, 86 characters.
  assert.match(VECTOR.signature, /^[A-Za-z0-9_-]{86}$/);
  assert.equal(fromB64Url(VECTOR.signature).length, 64);
  assert.equal(await verify(VECTOR.hostKey, VECTOR.signature, VECTOR.signingInput), true);
});

test('with any one field changed the signature does not hold, and it is no other key’s', async () => {
  const fields = VECTOR.changed.map((/** @type {any} */ c) => c.field);
  // Every field that is signed is changed once: a field nothing here changes is one a phone could leave out.
  assert.deepEqual([...fields].sort(), Object.keys(VECTOR.payload).filter((k) => k !== 'v').sort());
  for (const { field, value } of VECTOR.changed) {
    assert.notEqual(value, VECTOR.payload[field], `${field} is not changed`);
    assert.equal(await verify(VECTOR.hostKey, VECTOR.signature, signinAnswerInput({ ...VECTOR.payload, [field]: value })), false, `a changed ${field} still passes`);
  }
  // Another machine's key, with the right bytes.
  const other = { ...VECTOR.hostKey, x: VECTOR.hostKey.y, y: VECTOR.hostKey.x };
  assert.equal(await verify(other, VECTOR.signature, VECTOR.signingInput), false);
  // And the same payload under another purpose is other bytes.
  assert.equal(await verify(VECTOR.hostKey, VECTOR.signature, VECTOR.signingInput.replace('engine-signin-answer', 'vault-box')), false);
});
