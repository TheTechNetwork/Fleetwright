// The notification nobody in the middle can read.
//
// docs/relay-terms.md promises that nothing about a notification is written
// down, and that promise is CONTRACTUAL — kept by not adding a log line, which
// is a thing people do during incidents. This makes it structural: the payload
// is encrypted to a key one phone holds, so a relay forwards bytes it cannot
// read and neither APNs nor FCM sees what a session is asking.
//
// WHAT IS TESTED HERE IS THE WHOLE SCHEME, not the shape of a function call.
// Both apps implement the other half natively — CryptoKit and the Android
// Keystore — and nothing in this repository can run either. That is exactly the
// gap that let push ship unproven for months, so the decrypting half exists in
// JS purely so the scheme can be exercised end to end HERE, against the same
// bytes a phone will receive.

import test from 'node:test';
import assert from 'node:assert/strict';

import { sealTo, openWith, checkPublicKey, toBase64Url, fromBase64 } from '../src/fleet/push-crypto.js';
import { envelopeFor } from '../src/fleet/push.js';

/** A phone: a P-256 keypair whose private half never leaves. */
async function phone() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pushKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  return { pushKey, privateKey: pair.privateKey };
}

test('a sealed notification round-trips, and only to the phone it was for', async () => {
  const alice = await phone();
  const bob = await phone();
  const payload = { title: 'cc-brave-otter', body: 'Overwrite src/index.js?', data: { name: 'cc-brave-otter' } };

  const sealed = await sealTo(alice.pushKey, payload);
  assert.deepEqual(await openWith(alice.privateKey, alice.pushKey, sealed), payload);

  // The other phone holds a valid key and a valid private half and still gets
  // nothing. This is the property the whole design exists for.
  await assert.rejects(() => openWith(bob.privateKey, bob.pushKey, sealed));
});

test('two notifications to one phone share no bytes', async () => {
  // A FRESH EPHEMERAL KEY PER MESSAGE. Generating one and reusing it is the
  // obvious optimisation, and it would make two notifications to the same phone
  // linkable by anyone holding only the ciphertexts, and would make one
  // compromised message reveal the next.
  const alice = await phone();
  const one = await sealTo(alice.pushKey, { title: 'a', body: 'b' });
  const two = await sealTo(alice.pushKey, { title: 'a', body: 'b' });
  assert.notEqual(one, two, 'identical payloads produced identical ciphertext');

  // Same plaintext, and not even the ephemeral key is shared.
  const ephemeralOf = (/** @type {string} */ e) => toBase64Url(fromBase64(e).slice(17, 17 + 65));
  assert.notEqual(ephemeralOf(one), ephemeralOf(two));

  // Both still open.
  assert.deepEqual(await openWith(alice.privateKey, alice.pushKey, one), { title: 'a', body: 'b' });
  assert.deepEqual(await openWith(alice.privateKey, alice.pushKey, two), { title: 'a', body: 'b' });
});

test('a tampered envelope fails closed', async () => {
  // AES-GCM authenticates, so a flipped bit is a rejection rather than
  // plausible garbage rendered on a lock screen.
  const alice = await phone();
  const sealed = await sealTo(alice.pushKey, { title: 'yes', body: 'no' });
  const bytes = fromBase64(sealed);

  for (const at of [0, 5, 30, bytes.length - 1]) {
    const edited = new Uint8Array(bytes);
    edited[at] ^= 0x01;
    await assert.rejects(
      () => openWith(alice.privateKey, alice.pushKey, toBase64Url(edited)),
      `a flipped bit at ${at} was accepted`,
    );
  }
});

test('the version byte is checked rather than written', async () => {
  // A version nobody reads is decoration. This is what lets a second scheme be
  // a different first byte instead of a guess about length.
  const alice = await phone();
  const bytes = fromBase64(await sealTo(alice.pushKey, { title: 'x', body: 'y' }));
  bytes[0] = 9;
  await assert.rejects(
    () => openWith(alice.privateKey, alice.pushKey, toBase64Url(bytes)),
    /unsupported push envelope version 9/,
  );
});

test('a key that is not a point on the curve is refused', async () => {
  // The classic way to learn somebody's private key one bit at a time is to
  // hand them a point that is not on the curve and watch what comes back.
  // WebCrypto refuses it on import, which is where it should be refused.
  const offCurve = new Uint8Array(65);
  offCurve[0] = 0x04;
  offCurve.fill(0x01, 1);
  const bad = await checkPublicKey(toBase64Url(offCurve));
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /P-256/);

  assert.equal((await checkPublicKey('nope')).ok, false);
  assert.equal((await checkPublicKey(toBase64Url(new Uint8Array(64)))).ok, false, 'wrong length accepted');
  assert.equal((await checkPublicKey('')).ok, false);
  assert.equal((await checkPublicKey((await phone()).pushKey)).ok, true);

  // Both base64 alphabets, because three platforms disagree about which one
  // they hand you and none of them is wrong.
  const { pushKey } = await phone();
  const standard = pushKey.replace(/-/g, '+').replace(/_/g, '/');
  assert.equal((await checkPublicKey(standard)).ok, true);
});

test('what goes on the wire carries no detail, and still fits', async () => {
  const alice = await phone();
  const message = {
    title: 'cc-brave-otter on deb132',
    body: 'Waiting: overwrite src/index.js, or write to a copy?',
    data: { name: 'cc-brave-otter', promptId: 'p-01J8', options: 'overwrite,copy,cancel' },
  };
  const wire = await envelopeFor({ pushKey: alice.pushKey }, message);

  assert.equal(wire.encrypted, true);
  // NOT the session name, not the question. Everything real is in `e`.
  assert.equal(/cc-brave-otter|overwrite|src\/index\.js/.test(JSON.stringify(wire)), false,
    'a detail leaked outside the envelope');
  assert.deepEqual(Object.keys(wire.data), ['e']);

  // The fallback is a SENTENCE, because it is what a person sees when the
  // extension times out or a restored phone no longer holds the key. A
  // placeholder there is the contentless wake this design rejected.
  assert.match(wire.body, /\w+ \w+/);

  // Both services cap a payload at 4 KB, and the alert and the envelope share
  // it. A realistic notification must leave room to spare.
  assert.ok(JSON.stringify(wire).length < 2048, `wire payload is ${JSON.stringify(wire).length} bytes`);

  assert.deepEqual(await openWith(alice.privateKey, alice.pushKey, wire.data.e), {
    title: message.title,
    body: message.body,
    data: message.data,
  });
});

test('a phone that predates encryption still gets its notification', async () => {
  // There are installed apps with no key, and refusing to send to them would be
  // choosing "no notification" over "a notification Apple can read" — the wrong
  // trade for somebody waiting on a session.
  const wire = await envelopeFor({}, { title: 'cc-quiet-heron', body: 'stopped', data: { name: 'cc-quiet-heron' } });
  assert.equal(wire.encrypted, false);
  assert.equal(wire.title, 'cc-quiet-heron');
  assert.deepEqual(wire.data, { name: 'cc-quiet-heron' });
});

test('a reinstall does not inherit the old key', async () => {
  // A phone that reinstalls loses its private key — Keychain and Keystore both
  // go with the app. Carrying the public key forward would encrypt every future
  // notification to a key nobody holds, and the failure would be silent and
  // permanent: delivery succeeds, decryption fails, the fallback shows forever.
  const { CoordinatorCore } = await import('../src/fleet/coordinator/core.js');
  const core = new CoordinatorCore({ log: { info() {}, warn() {}, error() {} } });
  const alice = await phone();

  await core.registerDevice({ platform: 'ios', token: 'a'.repeat(40), clientId: 'phone-1', pushKey: alice.pushKey });
  assert.equal(core.devices.get('a'.repeat(40)).pushKey, alice.pushKey);

  await core.registerDevice({ platform: 'ios', token: 'a'.repeat(40), clientId: 'phone-1' });
  assert.equal(core.devices.get('a'.repeat(40)).pushKey, undefined, 'the stale key was inherited');
});
