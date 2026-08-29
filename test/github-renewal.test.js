// Keeping a GitHub connection alive without asking anybody again.
//
//   node --test test/
//
// "Same applies to GitHub, something has to ask." It does, and the mechanism
// is NOT the one that works for Claude — which is the point of this file.
//
//   Claude  a credential renews when it is USED. Exercising it is the fix, and
//           src/core/keepalive.js does exactly that.
//   GitHub  an App user token is not renewed by use at all. It lasts eight
//           hours and is replaced only by an explicit exchange against
//           `POST /login/oauth/access_token`, which needs the client secret.
//           A thousand API calls extend it by zero seconds.
//
// Building the Claude mechanism for GitHub would have produced something that
// runs on a timer, reports success, and achieves nothing — which is the exact
// failure shape this repository keeps meeting.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connections, refreshGithubToken } from '../src/core/connectors.js';
import { HOST_ROW } from '../src/core/accounts.js';
import { renewProviderTokens } from '../src/core/keepalive.js';
import { VERBS } from '../src/fleet/protocol/intents.js';
import { validateIntent } from '../src/fleet/protocol/intents.js';

const REFRESH = 'ghr_refreshtoken000000000000000000';
const CLIENT = 'clientsecret000000000000000000000000';
const ACCESS = 'ghu_accesstoken00000000000000000000';
const CLIENT_ID = 'Iv23liTEST';

/** @param {import('node:test').TestContext} t */
function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'renewal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new Connections(dir), cfg: /** @type {any} */ ({ stateDir: dir }) };
}

// --- where it lives ----------------------------------------------------------

test('the refresh token is in a third file, not the one sessions are given', (t) => {
  // THE WHOLE CUSTODY ARGUMENT IN ONE ASSERTION. `<row>.env` is sourced into
  // every container this person starts. An access token there expires in eight
  // hours; a refresh token there is something that RE-MINTS after every
  // revocation, handed to every session, and a session that leaked one would
  // have leaked far more than a session can.
  const s = store(t);
  s.store.save(HOST_ROW, 'github', ACCESS, 'octocat', null);
  s.store.saveRenewal(HOST_ROW, 'github', { clientId: CLIENT_ID, refresh: REFRESH, client: CLIENT });

  const env = readFileSync(/** @type {string} */ (s.store.envPathFor(HOST_ROW)), 'utf8');
  assert.ok(env.includes(ACCESS), 'the access token is what a session gets');
  assert.ok(!env.includes(REFRESH), 'the refresh token reached the file sessions source');
  assert.ok(!env.includes(CLIENT), 'the client secret reached the file sessions source');

  // Nor in the one a phone reads, which has no secret in it at all.
  const meta = readFileSync(/** @type {string} */ (s.store.metaPathFor(HOST_ROW)), 'utf8');
  assert.ok(!meta.includes(REFRESH) && !meta.includes(CLIENT));

  assert.deepEqual(s.store.readRenewal(HOST_ROW, 'github'), { clientId: CLIENT_ID, refresh: REFRESH, client: CLIENT });
});

test('renewal material is 0600, like every other secret here', (t) => {
  const s = store(t);
  s.store.saveRenewal(HOST_ROW, 'github', { clientId: CLIENT_ID, refresh: REFRESH, client: CLIENT });
  const { mode } = statSync(/** @type {string} */ (s.store.renewalPathFor(HOST_ROW)));
  assert.equal(mode & 0o777, 0o600);
});

test('rows are found without being told who exists', (t) => {
  const s = store(t);
  s.store.saveRenewal(HOST_ROW, 'github', { clientId: CLIENT_ID, refresh: REFRESH, client: CLIENT });
  s.store.saveRenewal('guest@example.com', 'github', { clientId: CLIENT_ID, refresh: REFRESH, client: CLIENT });

  const rows = s.store.renewableRows();
  assert.equal(rows.length, 2);
  assert.ok(rows.includes(HOST_ROW), 'the box own row is a symbol and must survive the round trip');
  assert.ok(rows.includes('guest@example.com'));
});

// --- the exchange ------------------------------------------------------------

test('a renewal stores BOTH halves, because GitHub rotates the refresh token', async (t) => {
  // The failure this prevents is delayed by exactly one token lifetime: store
  // the new access token without the new refresh token and the connection
  // renews once, then breaks eight hours later with nothing to point at.
  const s = store(t);
  s.store.save(HOST_ROW, 'github', ACCESS, 'octocat', null);
  s.store.saveRenewal(HOST_ROW, 'github', { clientId: CLIENT_ID, refresh: REFRESH, client: CLIENT, expiresIn: 1 });

  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(/** @type {any} */ (init).body));
    assert.equal(body.grant_type, 'refresh_token', 'a renewal is not a code exchange');
    assert.equal(body.refresh_token, REFRESH);
    assert.equal(body.client_secret, CLIENT);
    assert.equal(body.client_id, CLIENT_ID, 'the app the token was issued by, carried rather than configured');
    return new Response(
      JSON.stringify({
        access_token: 'ghu_second00000000000000000000000',
        refresh_token: 'ghr_second00000000000000000000000',
        expires_in: 28_800,
      }),
      { status: 200 },
    );
  };

  const results = await renewProviderTokens(s.cfg);

  assert.equal(results[0].outcome, 'renewed');
  const env = readFileSync(/** @type {string} */ (s.store.envPathFor(HOST_ROW)), 'utf8');
  assert.ok(env.includes('ghu_second00000000000000000000000'), 'the new access token was not stored');
  assert.equal(s.store.readRenewal(HOST_ROW, 'github')?.refresh, 'ghr_second00000000000000000000000',
    'the rotated refresh token was dropped — this connection would break at the NEXT renewal');
});

test('a token with hours left is not spent on a renewal', async (t) => {
  // GitHub rotates on every exchange, so a renewal is not free even though it
  // costs no quota: each one throws away a working refresh token for a new
  // one, and every exchange is a chance to lose the connection to a network
  // failure at the wrong moment.
  const s = store(t);
  s.store.saveRenewal(HOST_ROW, 'github', { clientId: CLIENT_ID, refresh: REFRESH, client: CLIENT, expiresIn: 28_800 });
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async () => { throw new Error('the network was touched'); };

  const results = await renewProviderTokens(s.cfg);
  assert.equal(results[0].outcome, 'not-due');
});

test('an unknown expiry is treated as due, not as fine', async (t) => {
  // The access token is opaque to us and GitHub publishes no introspection we
  // may call, so "we cannot tell" has to resolve somewhere. Being early costs
  // one HTTPS request; being late costs a session.
  const s = store(t);
  s.store.save(HOST_ROW, 'github', ACCESS, 'octocat', null);
  s.store.saveRenewal(HOST_ROW, 'github', { clientId: CLIENT_ID, refresh: REFRESH, client: CLIENT });

  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  let asked = false;
  globalThis.fetch = async () => {
    asked = true;
    return new Response(JSON.stringify({ access_token: 'ghu_x0000000000000000000000000000', expires_in: 28_800 }), { status: 200 });
  };

  await renewProviderTokens(s.cfg);
  assert.equal(asked, true);
});

test('a refused renewal is reported and does not damage what is stored', async (t) => {
  // A revoked App, a rotated client secret, a person who uninstalled it. The
  // stored access token still has time left on it — overwriting it with
  // nothing would turn "this expires later today" into "this is broken now".
  const s = store(t);
  s.store.save(HOST_ROW, 'github', ACCESS, 'octocat', null);
  s.store.saveRenewal(HOST_ROW, 'github', { clientId: CLIENT_ID, refresh: REFRESH, client: CLIENT });

  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: 'bad_refresh_token', error_description: 'expired' }), { status: 200 });

  const results = await renewProviderTokens(s.cfg);

  assert.equal(results[0].outcome, 'failed');
  assert.match(String(results[0].detail), /refused/);
  assert.ok(readFileSync(/** @type {string} */ (s.store.envPathFor(HOST_ROW)), 'utf8').includes(ACCESS));
  assert.equal(s.store.readRenewal(HOST_ROW, 'github')?.refresh, REFRESH, 'the material was left usable');
});

test('a network failure is not a dead refresh token', async (t) => {
  // The difference decides whether somebody has to go and reconnect, which is
  // the same argument verifyToken makes about a bad token.
  const s = store(t);
  s.store.saveRenewal(HOST_ROW, 'github', { clientId: CLIENT_ID, refresh: REFRESH, client: CLIENT });
  const r = await refreshGithubToken({
    refresh: REFRESH,
    client: CLIENT,
    clientId: CLIENT_ID,
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /Could not reach GitHub/);
});

test('a box with no renewal material does nothing at all', async (t) => {
  // Every box that connected before this shipped, and every connection made by
  // pasting a classic token — which has no refresh token and never expires.
  const s = store(t);
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async () => { throw new Error('the network was touched'); };

  assert.deepEqual(await renewProviderTokens(s.cfg), []);
});

// --- the protocol ------------------------------------------------------------

test('renew carries two secrets and no way to aim them at somebody else', () => {
  // The rule the whole verb set is built on: whose credential is derived from
  // the ACTOR, never from a parameter, so "renew my connection" cannot become
  // "renew somebody else's".
  for (const key of Object.keys(VERBS.renew.params)) {
    assert.ok(!/email|account|user|owner|actor/i.test(key), `renew exposes an identity-shaped parameter "${key}"`);
  }
  assert.equal(VERBS.renew.params.refresh.type, 'secret');
  assert.equal(VERBS.renew.params.client.type, 'secret');
});

test('a refusal never quotes the material back', () => {
  // It travels to the caller past every log line on the way — the same reason
  // link.secret is typed separately from text.
  const bad = 'this has spaces in it and should be refused';
  const r = validateIntent({
    v: 2, id: 'x'.repeat(20), verb: 'renew', issuedAt: Date.now(),
    params: { provider: 'github', clientId: CLIENT_ID, refresh: bad, client: CLIENT },
  });
  assert.equal(r.ok, false);
  assert.equal(String(r.error).includes('spaces'), false, 'a refusal quoted the material back');
});

test('a host needs no configuration at all to renew', () => {
  // The standing goal: "I want to be able to spin up a host, run the install
  // and registration, and go — all the questions in the install are the goal
  // to eliminate." A renewal that needed AGENT_HUB_GITHUB_CLIENT_ID on every
  // box would have added one, for a value that is public and already travels
  // past that box in every authorization URL.
  //
  // Checked on the source rather than by running it, because the property is
  // "this reads nothing from config", and the way that breaks is somebody
  // adding a convenient fallback.
  const src = readFileSync(new URL('../src/core/keepalive.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(!/cfg\.github/i.test(src), 'the renewal grew a config fallback');
  const config = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.ok(!/GITHUB_CLIENT/i.test(config), 'the host gained a GitHub setting to be told about');
});

test('a partial record renews nothing rather than failing at the provider', (t) => {
  // All three or none. Two of the three produces an error from GitHub that
  // nobody reading it can act on, several hours from the thing that caused it.
  const s = store(t);
  s.store.saveRenewal(HOST_ROW, 'github', { clientId: CLIENT_ID, refresh: REFRESH, client: CLIENT });
  const file = /** @type {string} */ (s.store.renewalPathFor(HOST_ROW));
  const all = JSON.parse(readFileSync(file, 'utf8'));
  delete all.github.clientId;
  writeFileSync(file, JSON.stringify(all));

  assert.equal(s.store.readRenewal(HOST_ROW, 'github'), null);
});
