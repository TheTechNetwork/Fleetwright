// What a box signs when it answers an engine sign-in, and seals to a phone
// that asked, and so what a phone opens and checks before it shows a code or
// an account (docs/engines.md, "The machine signs what it answers").
//
// THE VECTORS are two answers, each signed once with a key made for it and
// kept nowhere: test/fixtures/parity/engine-signin-answer.json. One in the
// clear, as an MCP client is answered. One sealed, as a phone is, to a key
// whose private half is in the fixture so that a phone's test can open it.
// ECDSA signatures and seals differ each time they are made, so a phone
// cannot make either again; it can only show that it opens and takes them,
// and refuses them with any one field changed. This file shows the same of
// the code a box runs, so the vectors the phones carry are ones the box
// would have made. That a real box answers this way is in
// test/vault.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verify, fromB64Url, signingInput } from '../src/fleet/crypto.js';
import { keyId, signinAnswerInput } from '../src/fleet/protocol/intent-signature.js';
import { boxKeyHash } from '../src/fleet/minter/vault.js';
import { open, importDepositKey, newSealKey, ENGINE_SIGNIN_AAD } from '../src/fleet/seal.js';

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

test('the sealed vector opens with the key a phone kept, to what a box signed: the page, the code and who is signed in', async () => {
  const S = VECTOR.sealed;
  assert.equal(S.aad, ENGINE_SIGNIN_AAD);
  assert.equal(S.aad, 'fleetwright-engine-signin/v1');
  const mine = await importDepositKey(JSON.stringify({ kty: 'EC', crv: 'P-256', d: S.recipient.d, x: S.recipient.x, y: S.recipient.y }));
  assert.equal(mine.publicKey, S.recipient.publicKey);
  const opened = await open({ privateKey: mine.privateKey, publicKey: mine.publicKey, aad: S.aad, sealed: S.sealed });
  assert.deepEqual(opened, S.opened);
  // Not with another key, and not as anything but an engine sign-in's answer.
  const other = await newSealKey();
  await assert.rejects(open({ privateKey: other.privateKey, publicKey: other.publicKey, aad: S.aad, sealed: S.sealed }));
  await assert.rejects(open({ privateKey: mine.privateKey, publicKey: mine.publicKey, aad: 'fleetwright-vault-reply/v1', sealed: S.sealed }));

  // WHAT WAS SIGNED is everything opened but the key and the signature, with who is signed in among it.
  const { hostKey, signature, v, ...signed } = opened;
  assert.equal(v, 1);
  assert.equal(signinAnswerInput(signed), S.signingInput);
  assert.equal(
    S.signingInput,
    `agent-fleet/v1/engine-signin-answer\n{"at":${signed.at},"code":"${signed.code}","engine":"${signed.engine}","host":"${S.host}","id":"${signed.id}","member":"${signed.member}",` +
      `"signedIn":{"since":${signed.signedIn.since},"who":{"email":"${signed.signedIn.who.email}","plan":"${signed.signedIn.who.plan}"}},"url":"${signed.url}","v":1}`,
  );
  assert.equal(S.keyHashInput, `{"crv":"P-256","kty":"EC","x":"${hostKey.x}","y":"${hostKey.y}"}`);
  assert.deepEqual([await keyId(hostKey), signed.host], [S.host, S.host]);
  assert.equal(await verify(hostKey, signature, S.signingInput), true);
  // Sealing proves nothing by itself, since anybody can seal to a public
  // key: with anything changed, an account above all, the signature inside
  // does not hold.
  assert.deepEqual([...new Set(S.changed.map((/** @type {any} */ c) => c.field))].sort(), Object.keys(signed).sort());
  for (const { field, value } of S.changed) {
    assert.notDeepEqual(value, signed[field], `${field} is not changed`);
    assert.equal(await verify(hostKey, signature, signinAnswerInput({ ...signed, [field]: value })), false, `a changed ${field} still passes`);
  }
  // And a sealed answer's bytes are not a clear one's: left out, who is signed in is not "nobody".
  const { signedIn: _who, ...clear } = signed;
  assert.equal(await verify(hostKey, signature, signinAnswerInput(clear)), false);
});

test('each further sealed answer opens with its own key, to bytes a box builds and a signature that holds over them', async () => {
  // FIVE MORE, under `more`, made by test/helpers/make-engine-signin-vectors.mjs
  // (which says how) and carried by both phones' tests. Three are the shape a
  // box sends on main: their bytes are `signinAnswerInput`'s, the function a
  // box signs with. Two are the next shape, with `state`, `detail` and
  // `expiresAt` inside what is signed: their bytes are every opened field
  // but the key and the signature, in the same canonical form, which is what
  // a phone checks whatever the fields are.
  const names = VECTOR.more.map((/** @type {any} */ m) => m.name);
  assert.deepEqual(names, ['opencode-signed-in', 'none', 'next-waiting', 'next-failed', 'foreign-page']);
  for (const m of VECTOR.more) {
    const mine = await importDepositKey(JSON.stringify({ kty: 'EC', crv: 'P-256', d: m.recipient.d, x: m.recipient.x, y: m.recipient.y }));
    assert.equal(mine.publicKey, m.recipient.publicKey, m.name);
    const opened = await open({ privateKey: mine.privateKey, publicKey: mine.publicKey, aad: ENGINE_SIGNIN_AAD, sealed: m.sealed });
    assert.deepEqual(opened, m.opened, m.name);
    const { hostKey, signature, v, ...signed } = opened;
    assert.equal(v, 1);
    assert.deepEqual([await keyId(hostKey), signed.host], [m.host, m.host], m.name);
    assert.equal(signingInput('engine-signin-answer', { v: 1, ...signed }), m.signingInput, m.name);
    if (m.shape === 'main') assert.equal(signinAnswerInput(signed), m.signingInput, `${m.name}: not the bytes a box on main signs`);
    else assert.deepEqual(['state', 'detail'].map((k) => k in signed), [true, true], `${m.name}: the next shape signs how it stands and why`);
    assert.equal(await verify(hostKey, signature, m.signingInput), true, m.name);
    // With who is signed in changed, or the code, it does not hold.
    assert.equal(await verify(hostKey, signature, signingInput('engine-signin-answer', { v: 1, ...signed, signedIn: { since: 1, who: null } })), false, m.name);
  }
  // What each is there to show a phone.
  const by = Object.fromEntries(VECTOR.more.map((/** @type {any} */ m) => [m.name, m.opened]));
  assert.deepEqual(by['opencode-signed-in'].signedIn.who, null);
  assert.equal(by.none.signedIn, null);
  assert.equal(by['next-waiting'].expiresAt - by['next-waiting'].at, 15 * 60_000);
  assert.deepEqual([by['next-failed'].state, typeof by['next-failed'].detail, 'code' in by['next-failed']], ['failed', 'string', false]);
  assert.notEqual(by['foreign-page'].url, 'https://auth.openai.com/codex/device');
});
