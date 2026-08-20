// Host identity: which machines are in the fleet, and how each proves it.
//
// The tests are ordered by what they would cost if wrong. Accepting a
// signature that should not verify is the whole fleet; failing to revoke is a
// machine you thought you removed; the rest is ergonomics.

import test from 'node:test';
import assert from 'node:assert/strict';

import { HostIdentities } from '../src/fleet/coordinator/hosts.js';
import { generateKeyPair, sign, signingInput } from '../src/fleet/crypto.js';

/** @param {HostIdentities} hosts @param {string} id */
async function enrolled(hosts, id = 'deb13-staging') {
  const keys = await generateKeyPair();
  const r = await hosts.enrol({ hostId: id, publicJwk: keys.publicJwk, enrolledBy: 'eli@thetech.network' });
  assert.equal(r.ok, true);
  return { keys, host: /** @type {any} */ (r).host };
}

/** What a host does to connect. */
async function answer(hosts, id, privateJwk, nonce) {
  return sign(privateJwk, signingInput('host-connect', { hostId: id, nonce }));
}

test('a host proves itself by signing a challenge', async () => {
  const hosts = new HostIdentities();
  const { keys } = await enrolled(hosts);

  const nonce = hosts.challenge('deb13-staging');
  const proof = await answer(hosts, 'deb13-staging', keys.privateJwk, nonce);

  const r = await hosts.prove('deb13-staging', proof);
  assert.equal(r.ok, true);
  assert.equal(/** @type {any} */ (r).host.hostId, 'deb13-staging');
});

test('another key does not get in, however well formed', async () => {
  // The one that matters. A machine that is not the enrolled machine must not
  // be able to answer, and "has a valid P-256 signature" is not the question.
  const hosts = new HostIdentities();
  await enrolled(hosts);
  const impostor = await generateKeyPair();

  const nonce = hosts.challenge('deb13-staging');
  const proof = await answer(hosts, 'deb13-staging', impostor.privateJwk, nonce);

  const r = await hosts.prove('deb13-staging', proof);
  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).reason, /does not match/);
});

test('a signature cannot be replayed, even seconds later', async () => {
  const hosts = new HostIdentities();
  const { keys } = await enrolled(hosts);

  const nonce = hosts.challenge('deb13-staging');
  const proof = await answer(hosts, 'deb13-staging', keys.privateJwk, nonce);
  assert.equal((await hosts.prove('deb13-staging', proof)).ok, true);

  // Same proof, same nonce, immediately after: the nonce is spent.
  const again = await hosts.prove('deb13-staging', proof);
  assert.equal(again.ok, false);
  assert.match(/** @type {any} */ (again).reason, /no challenge/);
});

test('a stranger cannot stop a host from connecting', async () => {
  // The challenge endpoint cannot be authenticated — asking for a nonce is what
  // an unauthenticated party does IN ORDER to authenticate — so anyone can
  // reach it for any host id. Two ways that could have been turned into a
  // denial of service, and neither works.
  const hosts = new HostIdentities();
  const { keys } = await enrolled(hosts);
  const nonce = hosts.challenge('deb13-staging');

  // One: a wrong signature, to burn the nonce the host is in the middle of
  // signing. An earlier version spent the challenge on failure and this
  // succeeded.
  assert.equal((await hosts.prove('deb13-staging', 'not-a-signature')).ok, false);

  // Two: flooding the host with fresh challenges, to overwrite its nonce. The
  // ring keeps several outstanding, so the one in flight survives.
  for (let i = 0; i < 5; i++) hosts.challenge('deb13-staging');

  const honest = await answer(hosts, 'deb13-staging', keys.privateJwk, nonce);
  assert.equal((await hosts.prove('deb13-staging', honest)).ok, true);
});

test('challenges for hosts that do not exist are not remembered', async () => {
  // Unbounded growth from an unauthenticated endpoint, otherwise: naming a
  // million machines that were never enrolled would cost a million entries. A
  // nonce is still returned, because refusing one would answer "does this host
  // exist" to anybody who asks.
  const hosts = new HostIdentities();
  await enrolled(hosts);

  assert.match(hosts.challenge('never-heard-of-it'), /\./);
  assert.equal(hosts.challenges.has('never-heard-of-it'), false);

  hosts.revoke('deb13-staging');
  hosts.challenge('deb13-staging');
  assert.equal(hosts.challenges.has('deb13-staging'), false, 'nor for one that was removed');
});

test('a host that asks many times keeps only the recent ones', async () => {
  const hosts = new HostIdentities();
  const { keys } = await enrolled(hosts);
  const first = hosts.challenge('deb13-staging');
  for (let i = 0; i < 20; i++) hosts.challenge('deb13-staging');

  const stale = await answer(hosts, 'deb13-staging', keys.privateJwk, first);
  const r = await hosts.prove('deb13-staging', stale);
  assert.equal(r.ok, false, 'the ring is bounded, so a long-abandoned nonce does fall out');
});

test('a signature for one host is not a signature for another', async () => {
  // Domain separation, from the other direction: the host id is inside what is
  // signed, so a proof from a machine that IS enrolled cannot be presented as
  // a proof from a different one.
  const hosts = new HostIdentities();
  const a = await enrolled(hosts, 'box-a');
  await enrolled(hosts, 'box-b');

  const nonceB = hosts.challenge('box-b');
  // box-a signs box-b's nonce, but names itself.
  const proof = await answer(hosts, 'box-a', a.keys.privateJwk, nonceB);

  const r = await hosts.prove('box-b', proof);
  assert.equal(r.ok, false);
});

test('a revoked host is refused, and told that it was revoked', async () => {
  const hosts = new HostIdentities();
  const { keys } = await enrolled(hosts);
  assert.equal(hosts.revoke('deb13-staging'), true);

  const nonce = hosts.challenge('deb13-staging');
  const proof = await answer(hosts, 'deb13-staging', keys.privateJwk, nonce);
  const r = await hosts.prove('deb13-staging', proof);

  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).reason, /revoked/, 'not "unknown host" — the machine should learn why');
  assert.equal(hosts.revoke('deb13-staging'), false, 'revoking twice is not an event');
});

test('re-enrolling replaces the key, which is what a rebuilt machine needs', async () => {
  const hosts = new HostIdentities();
  const first = await enrolled(hosts);
  const second = await enrolled(hosts);

  const nonce = hosts.challenge('deb13-staging');
  assert.equal((await hosts.prove('deb13-staging', await answer(hosts, 'deb13-staging', second.keys.privateJwk, nonce))).ok, true);

  const nonce2 = hosts.challenge('deb13-staging');
  assert.equal(
    (await hosts.prove('deb13-staging', await answer(hosts, 'deb13-staging', first.keys.privateJwk, nonce2))).ok,
    false,
    'the old key stops working, or a rebuild leaves a spare way in',
  );
});

test('a private key is refused rather than stored', async () => {
  // A coordinator holding host private keys is the failure this whole design
  // exists to avoid, so it refuses one loudly rather than accepting it.
  const hosts = new HostIdentities();
  const keys = await generateKeyPair();
  const r = await hosts.enrol({ hostId: 'oops', publicJwk: keys.privateJwk });
  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).error, /private key/);
});

test('what is listed carries no key material', async () => {
  const hosts = new HostIdentities();
  const { host } = await enrolled(hosts);
  const listed = JSON.stringify(hosts.list());
  assert.equal(listed.includes('"x"'), false, 'the public key is not interesting to a person');
  assert.ok(listed.includes(host.fingerprint), 'the fingerprint is, because it identifies the machine');
});

test('a fingerprint is stable across exports of the same key', async () => {
  const hosts = new HostIdentities();
  const keys = await generateKeyPair();
  await hosts.enrol({ hostId: 'a', publicJwk: keys.publicJwk });
  // Same key, decorated the way a different export would.
  await hosts.enrol({ hostId: 'b', publicJwk: { ...keys.publicJwk, alg: 'ES256', ext: true, key_ops: ['verify'] } });

  const [a, b] = ['a', 'b'].map((id) => hosts.hosts.get(id));
  assert.equal(a?.fingerprint, b?.fingerprint, 'a fingerprint that moves when nothing moved is worse than none');
});
