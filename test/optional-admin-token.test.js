// A coordinator without a break-glass admin token, which most fleets will be.
//
// The Worker refused to run without AGENT_FLEET_API_TOKEN, on the reasoning
// that a coordinator with no credentials is remote control of every box for
// whoever finds the URL. True when the admin token was the ONLY credential —
// and it stopped being true when sign-in shipped. Phones hold per-device
// credentials from a verified identity, hosts authenticate by signature against
// a per-host keypair, runners present a token GitHub minted for one job.
//
// THE HAZARD THAT MADE THE OLD GUARD NECESSARY IS REAL AND IS THE POINT OF THIS
// FILE. `timingSafeEqual('', '')` is TRUE — two zero-length strings differ
// nowhere. So with no admin token configured, a request arriving with no
// Authorization header compares '' against '' and, without an explicit
// emptiness check, is admitted AS ADMIN. The 503 was hiding that; making the
// token optional exposes it.

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/src/worker.js';

/** A Durable Object binding that screams if an unauthenticated request reaches it. */
const noFleet = {
  idFromName() { throw new Error('the Durable Object was reached without a credential'); },
  get() { throw new Error('the Durable Object was reached without a credential'); },
};

/** Sign-in configured, which is what makes the admin token optional. */
const SIGNIN = {
  AGENT_FLEET_AUTH_ISSUERS: 'https://accounts.google.com',
  AGENT_FLEET_AUTH_AUDIENCES: 'network.thetech.fleetwright',
};

/** @param {string} path */
const call = (path, env = {}, headers = {}) =>
  worker.fetch(new Request(`https://fleet.example${path}`, { headers }), /** @type {any} */ ({ FLEET: noFleet, ...env }));

test('no credential is not the admin credential, even with no token set', async () => {
  // THE ONE THAT MATTERS. An empty presented against an empty expected must
  // never pass, or an unconfigured coordinator is an open one.
  const res = await call('/api/hosts', SIGNIN);
  assert.equal(res.status, 401, 'a request with no credential was let through');
  const body = /** @type {any} */ (await res.json());
  assert.equal(body.error.code, 'unauthorised');
});

test('an empty Authorization header is not admin either', async () => {
  // The header present and empty is a different path through credentialFrom
  // than the header absent, and both end at the same comparison.
  for (const header of ['', 'Bearer ', 'Bearer']) {
    const res = await call('/api/hosts', SIGNIN, { authorization: header });
    assert.equal(res.status, 401, `"${header}" was accepted as admin`);
  }
});

test('a coordinator with sign-in and no admin token runs', async () => {
  // It has no break-glass. That is a choice, not a fault, and refusing to boot
  // it was refusing a correct configuration.
  const res = await call('/healthz', SIGNIN);
  assert.equal(res.status, 200);
  const body = /** @type {any} */ (await res.json());
  assert.equal(body.ok, true);
});

test('a coordinator with NO way in at all refuses, and names both ways', async () => {
  // This is what the old guard was really about. Neither an admin token nor an
  // issuer and audience means nobody can ever authenticate, which is worth
  // saying at boot rather than discovering one 401 at a time.
  const res = await call('/api/hosts', {});
  assert.equal(res.status, 503);
  const body = /** @type {any} */ (await res.json());
  assert.equal(body.error.code, 'not_configured');
  assert.match(body.text, /AGENT_FLEET_AUTH_ISSUERS/);
  assert.match(body.text, /AGENT_FLEET_API_TOKEN/);
  // And says hosts need neither, because that is the question somebody asks
  // next and the answer stops them setting a token they do not want.
  assert.match(body.text, /Hosts need neither/);
});

test('half a sign-in configuration is not a sign-in configuration', async () => {
  // An issuer with no audience verifies nothing, so it must not count as a way
  // in — otherwise the 503 stops firing for a fleet nobody can reach.
  for (const half of [
    { AGENT_FLEET_AUTH_ISSUERS: 'https://accounts.google.com' },
    { AGENT_FLEET_AUTH_AUDIENCES: 'network.thetech.fleetwright' },
    { AGENT_FLEET_AUTH_ISSUERS: '  ', AGENT_FLEET_AUTH_AUDIENCES: 'x' },
  ]) {
    const res = await call('/api/hosts', half);
    assert.equal(res.status, 503, `${JSON.stringify(half)} was treated as configured`);
  }
});

test('the admin token still works when it is set', async () => {
  // The break-glass has to keep working, or this is a removal rather than a
  // relaxation. It reaches the Durable Object, which throws in this harness —
  // that throw IS the evidence it got past the gate.
  const env = { ...SIGNIN, AGENT_FLEET_API_TOKEN: 'a-token-at-least-16ch' };
  const res = await call('/api/hosts', env, { authorization: 'Bearer a-token-at-least-16ch' });
  assert.notEqual(res.status, 401, 'the admin token stopped being admin');

  // And a wrong one does not.
  const wrong = await call('/api/hosts', env, { authorization: 'Bearer not-the-token-here' });
  assert.equal(wrong.status, 401);
});
