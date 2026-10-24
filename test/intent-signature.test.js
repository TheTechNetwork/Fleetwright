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
import {
  checkDelegation, checkIntentSignature, delegationSigningInput, grantShape, intentSigningInput, keyId, DELEGATION_MAX_MS,
} from '../src/fleet/protocol/intent-signature.js';

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

// A delegation is a standing permission the person signed on their phone for
// the coordinator to use while they are not there. What it is worth is what
// it names, and the box checks each part: the person, the verb, the box, the
// parameters it was signed with, and the window.
test('a delegation covers only what its maker signed, here, inside its window, until they revoke it', async () => {
  const nina = await phone();
  const directory = new Map([[NINA, [{ kid: nina.kid, key: nina.key, label: 'Nina’s Pixel' }]]]);
  const now = 1_800_000_000_000;
  const grant = {
    v: 1, id: 'keep-ready-0001-aaaa', actor: NINA, verbs: ['provision', 'vmctl'], hosts: ['holder-1'],
    match: { template: 'debian-13' }, issuedAt: now - 60_000, expires: now + 3_600_000,
  };
  const delegation = { grant, sig: await sign(nina.privateJwk, delegationSigningInput(grant)), kid: nina.kid };
  const ask = (/** @type {any} */ over = {}) => checkDelegation({
    intent: { actor: NINA, verb: 'provision', params: { template: 'debian-13', ticket: 'set-by-the-fleet' } },
    delegation, host: 'holder-1', directory, now, ...over,
  });

  assert.deepEqual(await ask(), { verdict: 'delegated', label: 'Nina’s Pixel', id: grant.id });
  // Each thing it names, missed one at a time.
  assert.equal((await ask({ host: 'holder-2' })).verdict, 'not-covered');
  assert.equal((await ask({ intent: { actor: NINA, verb: 'start', params: { template: 'debian-13' } } })).verdict, 'not-covered');
  assert.equal((await ask({ intent: { actor: NINA, verb: 'provision', params: { template: 'windows' } } })).verdict, 'not-covered');
  assert.equal((await ask({ intent: { actor: NINA, verb: 'provision', params: {} } })).verdict, 'not-covered');
  assert.equal((await ask({ intent: { actor: 'kim@example.test', verb: 'provision', params: { template: 'debian-13' } } })).verdict, 'not-covered');
  assert.equal((await ask({ now: grant.expires + 1 })).verdict, 'not-covered');
  assert.match(String((await ask({ now: grant.expires + 1 })).gap), /run out/);
  // Revoked from the phone, which the minter's list carries.
  assert.equal((await ask({ revoked: new Map([[NINA, new Set([grant.id])]]) })).verdict, 'revoked');
  // A grant changed on the way no longer holds, and one made by a key the
  // minter does not list for the person is not theirs.
  assert.equal((await ask({ delegation: { ...delegation, grant: { ...grant, hosts: ['*'] } } })).verdict, 'bad-signature');
  assert.equal((await ask({ directory: new Map() })).verdict, 'unknown-key');
  assert.equal((await ask({ directory: null })).verdict, 'no-directory');
});

test('a delegation is refused in a shape a box could be made to spend time on, or that runs longer than a month', () => {
  const g = { v: 1, id: 'held-start-0001-aaaa', actor: NINA, verbs: ['start'], hosts: ['*'], match: {}, issuedAt: 1, expires: 2 };
  assert.ok(grantShape(g));
  assert.equal(grantShape({ ...g, expires: 1 + DELEGATION_MAX_MS + 1 }), null);
  assert.equal(grantShape({ ...g, hosts: ['*', 'box-a'] }), null);
  // A verb a box answers whoever asks needs no delegation, and one nobody knows is not a verb.
  assert.equal(grantShape({ ...g, verbs: ['list'] }), null);
  assert.equal(grantShape({ ...g, verbs: ['rm'] }), null);
  assert.equal(grantShape({ ...g, actor: 'nobody' }), null);
  assert.equal(grantShape({ ...g, match: { task: 'x'.repeat(9000) } }), null);
});
