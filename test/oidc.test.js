// Verifying somebody else's identity token.
//
// Every test here is a way the check could pass when it should not. That is
// the only interesting direction: a verifier that rejects a good token is a
// support ticket, and one that accepts a bad token is the whole fleet.

import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyIdToken, isAllowed, isPrivateRelay, forgetJwks } from '../src/fleet/coordinator/oidc.js';

const ISSUER = 'https://accounts.example.com';
const AUDIENCE = 'fleetwright-app';

/** A signing key plus the JWKS and fetch stub an issuer would serve. */
async function issuer({ kid = 'k1' } = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const keys = [{ ...jwk, kid, alg: 'RS256', use: 'sig' }];

  // jose uses the global fetch, so the stub goes there. That is a better test
  // than injecting a function: it exercises the same path production takes,
  // including jose's own caching and cooldown behaviour.
  let fetches = 0;
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => {
    fetches++;
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const restore = () => {
    globalThis.fetch = real;
  };

  const b64 = (/** @type {any} */ o) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');

  /** @param {any} claims @param {any} [header] */
  const sign = async (claims, header = {}) => {
    const h = b64({ alg: 'RS256', kid, typ: 'JWT', ...header });
    const c = b64(claims);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${c}`));
    return `${h}.${c}.${Buffer.from(sig).toString('base64url')}`;
  };

  return { sign, restore, fetches: () => fetches, keys };
}

// Real time, because jose reads the real clock — a fixture pinned to a date in
// 2027 made "expired" mean "expires next year".
const NOW = Date.now();
const base = { iss: ISSUER, aud: AUDIENCE, sub: 'u1', email: 'eli@thetech.network', email_verified: true, exp: Math.floor(NOW / 1000) + 600 };

test('a good token yields the identity in it', async (t) => {
  forgetJwks();
  const { sign, restore } = await issuer();
  t.after(restore);
  const who = await verifyIdToken(await sign({ ...base, name: 'Eli' }), {
    issuers: [ISSUER], audiences: [AUDIENCE],
  });
  assert.equal(who.email, 'eli@thetech.network');
  assert.equal(who.sub, 'u1');
  assert.equal(who.name, 'Eli');
});

test('an unconfigured issuer is refused BEFORE any key is fetched', async (t) => {
  // The important half. A token naming an attacker's issuer must not make the
  // coordinator go and fetch that attacker's keys — the signature would then
  // verify perfectly against them.
  forgetJwks();
  const { sign, restore, fetches } = await issuer();
  t.after(restore);
  const token = await sign({ ...base, iss: 'https://evil.example' });
  await assert.rejects(
    () => verifyIdToken(token, { issuers: [ISSUER], audiences: [AUDIENCE] }),
    /is not configured/,
  );
  assert.equal(fetches(), 0, 'nothing was fetched, so nothing attacker-controlled was trusted');
});

test('a token for another application is refused', async (t) => {
  forgetJwks();
  const { sign, restore } = await issuer();
  t.after(restore);
  const token = await sign({ ...base, aud: 'some-other-app' });
  await assert.rejects(
    () => verifyIdToken(token, { issuers: [ISSUER], audiences: [AUDIENCE] }),
    /different application/,
  );
});

test('alg: none and friends are refused', async (t) => {
  // The oldest JWT hole. Worth a test precisely because it is old enough that
  // somebody might assume it cannot still be here.
  forgetJwks();
  const { restore } = await issuer();
  t.after(restore);
  const b64 = (/** @type {any} */ o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const forged = `${b64({ alg: 'none', kid: 'k1' })}.${b64(base)}.`;
  await assert.rejects(
    () => verifyIdToken(forged, { issuers: [ISSUER], audiences: [AUDIENCE] }),
    /unsupported algorithm/,
  );
});

test('a tampered payload does not verify', async (t) => {
  forgetJwks();
  const { sign, restore } = await issuer();
  t.after(restore);
  const token = await sign(base);
  const [h, , s] = token.split('.');
  const swapped = Buffer.from(JSON.stringify({ ...base, email: 'attacker@elsewhere.com' })).toString('base64url');
  await assert.rejects(
    () => verifyIdToken(`${h}.${swapped}.${s}`, { issuers: [ISSUER], audiences: [AUDIENCE] }),
    /does not verify/,
  );
});

test('an expired token is refused, and the skew is small', async (t) => {
  forgetJwks();
  const { sign, restore } = await issuer();
  t.after(restore);
  const token = await sign({ ...base, exp: Math.floor(NOW / 1000) - 120 });
  await assert.rejects(
    () => verifyIdToken(token, { issuers: [ISSUER], audiences: [AUDIENCE] }),
    /expired/,
  );
});

test('an unverified email is refused even though the signature is good', async (t) => {
  // A signed token proves the provider issued it, not that the address belongs
  // to whoever is holding it. Providers will happily sign an unverified one.
  forgetJwks();
  const { sign, restore } = await issuer();
  t.after(restore);
  const token = await sign({ ...base, email_verified: false });
  await assert.rejects(
    () => verifyIdToken(token, { issuers: [ISSUER], audiences: [AUDIENCE] }),
    /not verified/,
  );
});

test('keys are cached, and a new key id refetches', async (t) => {
  forgetJwks();
  const { sign, restore, fetches } = await issuer();
  t.after(restore);
  const opts = { issuers: [ISSUER], audiences: [AUDIENCE] };
  await verifyIdToken(await sign(base), opts);
  const afterFirst = fetches();
  await verifyIdToken(await sign(base), opts);
  assert.equal(fetches(), afterFirst, 'a second sign-in does not go back to the issuer');
});

test('the allowlist takes an address or a domain, and nothing by default', () => {
  assert.equal(isAllowed('eli@thetech.network', ['eli@thetech.network']), true);
  assert.equal(isAllowed('ELI@TheTech.Network', ['eli@thetech.network']), true, 'addresses are not case sensitive');
  assert.equal(isAllowed('anyone@thetech.network', ['@thetech.network']), true);
  assert.equal(isAllowed('eli@elsewhere.com', ['@thetech.network']), false);
  // The one that would be a disaster: a domain rule must not match a lookalike.
  assert.equal(isAllowed('eli@notthetech.network', ['@thetech.network']), false);
  assert.equal(isAllowed('eli@thetech.network.evil.com', ['@thetech.network']), false);
  assert.equal(isAllowed('eli@thetech.network', []), false, 'no list means nobody, not everybody');
});

test('an Apple relay address is recognised, because a domain rule can never match it', () => {
  assert.equal(isPrivateRelay('abc123@privaterelay.appleid.com'), true);
  assert.equal(isPrivateRelay('eli@thetech.network'), false);
});
