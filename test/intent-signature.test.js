// What a box makes of a signature on an intent. docs/signed-intents.md.
//
//   node --test test/intent-signature.test.js
//
// The box's half of the check, over a key made the way a phone's is and a
// directory shaped the way the minter's answer leaves it. What each verdict
// guards is the reason the signature covers what it covers: the box (so a
// stop for one box does not run on another), the actor (so one person's key
// is not taken for another's) and the parameters.

import test from 'node:test';
import assert from 'node:assert/strict';

import { generateKeyPair, sign } from '../src/fleet/crypto.js';
import { checkIntentSignature, intentSigningInput, keyId } from '../src/fleet/protocol/intent-signature.js';

const NINA = 'nina@example.test';

async function phone() {
  const { publicJwk, privateJwk } = await generateKeyPair();
  const key = { kty: 'EC', crv: 'P-256', x: String(publicJwk.x), y: String(publicJwk.y) };
  return { key, privateJwk, kid: await keyId(key) };
}

const intent = (over = {}) => ({ actor: NINA, id: 'intent-0001', issuedAt: 1_800_000_000_000, verb: 'stop', params: { name: 'build' }, ...over });

test('a box takes an intent signed for it by a key the minter lists for the person asking, and nothing changed on the way', async () => {
  const nina = await phone();
  const other = await phone();
  const directory = new Map([[NINA, [{ kid: nina.kid, key: nina.key, label: 'Nina’s iPhone' }]]]);
  const sig = await sign(nina.privateJwk, intentSigningInput(intent(), 'box-a'));

  const at = (/** @type {any} */ over) => checkIntentSignature({ intent: intent(), sig, kid: nina.kid, host: 'box-a', directory, ...over });
  assert.deepEqual(await at({}), { verdict: 'signed', label: 'Nina’s iPhone' });
  // Another box, other parameters, another person, another key.
  assert.equal((await at({ host: 'box-b' })).verdict, 'bad-signature');
  assert.equal((await at({ intent: intent({ params: { name: 'prod' } }) })).verdict, 'bad-signature');
  assert.equal((await at({ intent: intent({ verb: 'forget' }) })).verdict, 'bad-signature');
  assert.equal((await at({ intent: intent({ actor: 'kim@example.test' }) })).verdict, 'unknown-key');
  assert.equal((await at({ kid: other.kid })).verdict, 'unknown-key');
  // What the coordinator writes after the person asked (`setBy: 'fleet'`) is
  // its own word and not the person's, so a start it adds `boxSecrets` to still
  // holds; anything else it adds does not.
  const start = intent({ verb: 'start', params: { name: 'build' } });
  const startSig = await sign(nina.privateJwk, intentSigningInput(start, 'box-a'));
  assert.equal((await at({ sig: startSig, intent: { ...start, params: { name: 'build', boxSecrets: 'no' } } })).verdict, 'signed');
  assert.equal((await at({ sig: startSig, intent: { ...start, params: { name: 'build', task: 'rm -rf' } } })).verdict, 'bad-signature');
  // No key list from the minter: the box cannot tell.
  assert.equal((await at({ directory: null })).verdict, 'no-directory');
  // The actor is matched as the box matches it everywhere: case does not make another person.
  assert.equal((await checkIntentSignature({
    intent: intent({ actor: 'Nina@Example.test' }), sig: await sign(nina.privateJwk, intentSigningInput(intent({ actor: 'Nina@Example.test' }), 'box-a')), kid: nina.kid, host: 'box-a', directory,
  })).verdict, 'signed');
});

test('an unsigned intent is told apart from one that will need a signature', async () => {
  const directory = new Map();
  assert.equal((await checkIntentSignature({ intent: intent(), host: 'box-a', directory })).verdict, 'unsigned');
  assert.equal((await checkIntentSignature({ intent: intent({ verb: 'readfile', params: { name: 'build', path: 'a' } }), host: 'box-a', directory })).verdict, 'unsigned');
  assert.equal((await checkIntentSignature({ intent: intent({ verb: 'list', params: {} }), host: 'box-a', directory })).verdict, 'not-needed');
  // Present and malformed is not "unsigned": somebody sent something.
  assert.equal((await checkIntentSignature({ intent: intent(), sig: 'nope', kid: 'nope', host: 'box-a', directory })).verdict, 'bad-signature');
});
