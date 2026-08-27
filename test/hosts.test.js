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
async function enrolled(hosts, id = 'deb13-staging', opts = {}) {
  const keys = await generateKeyPair();
  const r = await hosts.enrol({ hostId: id, publicJwk: keys.publicJwk, enrolledBy: 'eli@thetech.network', ...opts });
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

  const nonce = await hosts.challenge('deb13-staging');
  const proof = await answer(hosts, 'deb13-staging', keys.privateJwk, nonce);

  const r = await hosts.prove('deb13-staging', proof, nonce);
  assert.equal(r.ok, true);
  assert.equal(/** @type {any} */ (r).host.hostId, 'deb13-staging');
});

test('another key does not get in, however well formed', async () => {
  // The one that matters. A machine that is not the enrolled machine must not
  // be able to answer, and "has a valid P-256 signature" is not the question.
  const hosts = new HostIdentities();
  await enrolled(hosts);
  const impostor = await generateKeyPair();

  const nonce = await hosts.challenge('deb13-staging');
  const proof = await answer(hosts, 'deb13-staging', impostor.privateJwk, nonce);

  const r = await hosts.prove('deb13-staging', proof, nonce);
  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).reason, /does not match/);
});

test('a signature cannot be replayed, even seconds later', async () => {
  const hosts = new HostIdentities();
  const { keys } = await enrolled(hosts);

  const nonce = await hosts.challenge('deb13-staging');
  const proof = await answer(hosts, 'deb13-staging', keys.privateJwk, nonce);
  assert.equal((await hosts.prove('deb13-staging', proof, nonce)).ok, true);

  // Same proof, same nonce, immediately after: the nonce is spent.
  const again = await hosts.prove('deb13-staging', proof, nonce);
  assert.equal(again.ok, false);
  assert.match(/** @type {any} */ (again).reason, /already been used/);
});

test('a stranger cannot stop a host from connecting', async () => {
  // The challenge endpoint cannot be authenticated — asking for a nonce is what
  // an unauthenticated party does IN ORDER to authenticate — so anyone can ask
  // for one, for any host id, as often as they like.
  //
  // This used to be survivable rather than harmless. Nonces were kept in a ring
  // of eight per host, so nine requests evicted the one an honest host was in
  // the middle of signing, and a sustained flood kept a named machine out of
  // the fleet indefinitely. Now there is no per-host state to churn: a nonce
  // carries its own proof that this coordinator issued it.
  const hosts = new HostIdentities();
  const { keys } = await enrolled(hosts);
  const nonce = await hosts.challenge('deb13-staging');

  // A wrong answer, which used to burn the nonce.
  assert.equal((await hosts.prove('deb13-staging', 'not-a-signature', nonce)).ok, false);

  // And a flood, which used to evict it. Far past the old ring size.
  for (let i = 0; i < 500; i++) await hosts.challenge('deb13-staging');

  const honest = await answer(hosts, 'deb13-staging', keys.privateJwk, nonce);
  assert.equal((await hosts.prove('deb13-staging', honest, nonce)).ok, true);
});

test('issuing a challenge stores nothing at all', async () => {
  // Not "nothing for hosts that do not exist" — nothing for anyone. An
  // unauthenticated caller naming a million machines costs this coordinator a
  // million HMACs and zero bytes, which is the property that makes the flood
  // above pointless rather than merely expensive.
  const hosts = new HostIdentities();
  await enrolled(hosts);

  assert.equal(hosts.spent.size, 0);
  for (let i = 0; i < 100; i++) await hosts.challenge(`whatever-${i}`);
  await hosts.challenge('deb13-staging');
  assert.equal(hosts.spent.size, 0, 'nothing is remembered until a nonce is actually spent');
});

test('a nonce this coordinator did not issue is refused', async () => {
  const hosts = new HostIdentities();
  const { keys } = await enrolled(hosts);

  // Shaped right, signed properly, and simply not ours.
  const forged = `${Date.now().toString(36)}.abcdef.${'0'.repeat(64)}`;
  const proof = await answer(hosts, 'deb13-staging', keys.privateJwk, forged);
  const r = await hosts.prove('deb13-staging', proof, forged);
  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).reason, /not issued by this coordinator/);
});

test('a nonce minted for one host does not work for another', async () => {
  // The host id is inside the MAC, so a nonce is bound to the name it was asked
  // for even before any signature is checked.
  const hosts = new HostIdentities();
  await enrolled(hosts);
  await hosts.enrol({ hostId: 'box-b', publicJwk: (await generateKeyPair()).publicJwk });

  const forOther = await hosts.challenge('box-b');
  const r = await hosts.prove('deb13-staging', 'whatever', forOther);
  assert.match(/** @type {any} */ (r).reason, /not issued by this coordinator/);
});

test('an old nonce keeps working until it expires', async () => {
  // The ring used to drop it: ask twenty times and the first was gone. Nothing
  // evicts now, so the only thing that ends a nonce is its age or its use —
  // which is what a host on a slow link needs.
  let clock = 1_000_000;
  const hosts = new HostIdentities({ now: () => clock });
  const { keys } = await enrolled(hosts);

  const first = await hosts.challenge('deb13-staging');
  for (let i = 0; i < 20; i++) await hosts.challenge('deb13-staging');

  const proof = await answer(hosts, 'deb13-staging', keys.privateJwk, first);
  assert.equal((await hosts.prove('deb13-staging', proof, first)).ok, true);

  // ...and age does end it.
  const second = await hosts.challenge('deb13-staging');
  clock += 130_000;
  const late = await answer(hosts, 'deb13-staging', keys.privateJwk, second);
  const r = await hosts.prove('deb13-staging', late, second);
  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).reason, /expired/);
});

test('a signature for one host is not a signature for another', async () => {
  // Domain separation, from the other direction: the host id is inside what is
  // signed, so a proof from a machine that IS enrolled cannot be presented as
  // a proof from a different one.
  const hosts = new HostIdentities();
  const a = await enrolled(hosts, 'box-a');
  await enrolled(hosts, 'box-b');

  const nonceB = await hosts.challenge('box-b');
  // box-a signs box-b's nonce, but names itself.
  const proof = await answer(hosts, 'box-a', a.keys.privateJwk, nonceB);

  const r = await hosts.prove('box-b', proof, nonceB);
  assert.equal(r.ok, false);
});

test('a revoked host is refused, and told that it was revoked', async () => {
  const hosts = new HostIdentities();
  const { keys } = await enrolled(hosts);
  assert.equal(hosts.revoke('deb13-staging'), true);

  const nonce = await hosts.challenge('deb13-staging');
  const proof = await answer(hosts, 'deb13-staging', keys.privateJwk, nonce);
  const r = await hosts.prove('deb13-staging', proof, nonce);

  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).reason, /revoked/, 'not "unknown host" — the machine should learn why');
  assert.equal(hosts.revoke('deb13-staging'), false, 'revoking twice is not an event');
});

test('replacing the key of a machine that exists takes a pin minted for that name', async () => {
  // Binding existed but nothing used it: every path that mints a pin minted an
  // unbound one, so a pin handed out to add a Raspberry Pi was still a pin that
  // took over the build server. The rule that closes it without making the
  // ordinary case worse — an unbound pin ADDS a machine, and replacing one that
  // already exists needs a pin minted for that name.
  const hosts = new HostIdentities();
  await enrolled(hosts);

  const takeover = await hosts.enrol({ hostId: 'deb13-staging', publicJwk: (await generateKeyPair()).publicJwk });
  assert.equal(takeover.ok, false);
  assert.match(String(takeover.error), /already enrolled/);
});

test('a rebuilt machine re-enrols, with a pin minted for it', async () => {
  const hosts = new HostIdentities();
  const first = await enrolled(hosts);
  const second = await enrolled(hosts, 'deb13-staging', { boundToThisHost: true });

  const nonce = await hosts.challenge('deb13-staging');
  assert.equal(
    (await hosts.prove('deb13-staging', await answer(hosts, 'deb13-staging', second.keys.privateJwk, nonce), nonce)).ok,
    true,
  );

  const nonce2 = await hosts.challenge('deb13-staging');
  assert.equal(
    (await hosts.prove('deb13-staging', await answer(hosts, 'deb13-staging', first.keys.privateJwk, nonce2), nonce2)).ok,
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

test('one captured handshake cannot open five sockets at once', async () => {
  // The nonce used to be spent AFTER verify(), two awaits downstream of the
  // check that read it. So five copies of one captured handshake submitted in
  // PARALLEL all read an empty spent set, all verified, and all succeeded — and
  // "a captured proof cannot open a second connection" was true only for a
  // caller polite enough to be sequential.
  const hosts = new HostIdentities();
  const { keys } = await enrolled(hosts);
  const nonce = await hosts.challenge('deb13-staging');
  const proof = await answer(hosts, 'deb13-staging', keys.privateJwk, nonce);

  const together = await Promise.all(
    Array.from({ length: 5 }, () => hosts.prove('deb13-staging', proof, nonce)),
  );
  assert.equal(together.filter((r) => r.ok).length, 1, 'exactly one, however many arrive at once');
});

test('a bad answer does not burn somebody else s nonce', async () => {
  // The reservation above must not become the denial of service the old ring
  // was: anyone who saw a nonce could otherwise spend it by answering rubbish.
  const hosts = new HostIdentities();
  const { keys } = await enrolled(hosts);
  const nonce = await hosts.challenge('deb13-staging');

  assert.equal((await hosts.prove('deb13-staging', 'rubbish', nonce)).ok, false);
  const honest = await answer(hosts, 'deb13-staging', keys.privateJwk, nonce);
  assert.equal((await hosts.prove('deb13-staging', honest, nonce)).ok, true, 'the real host still gets in');
});

test('a nonce has exactly one spelling', async () => {
  // parseInt(stamp, 36) skips whitespace, takes a leading '+', and stops at the
  // first character it dislikes — so one challenge had an unbounded family of
  // spellings that all recomputed to the same MAC while being different keys in
  // the spent map. Adding a space dodged "already used".
  const hosts = new HostIdentities();
  const { keys } = await enrolled(hosts);
  const nonce = await hosts.challenge('deb13-staging');
  const [stamp, ...rest] = nonce.split('.');

  for (const variant of [` ${nonce}`, `+${nonce}`, `${stamp}!.${rest.join('.')}`, `${nonce}\n`]) {
    const sig = await answer(hosts, 'deb13-staging', keys.privateJwk, variant);
    const r = await hosts.prove('deb13-staging', sig, variant);
    assert.equal(r.ok, false, `accepted ${JSON.stringify(variant)}`);
  }
});
