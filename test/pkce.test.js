// PKCE on the host: the verifier stays, the challenge goes, and the one who
// relays the code cannot spend it.
//
//   node --test test/
//
// Three layers, each with its own test: the arithmetic (RFC 7636's own vector),
// the host's pending verifiers (single-use, ten minutes, per person), and the
// two ends of the flow — the coordinator building the challenge into the URL
// and relaying the code, and the sidecar minting on `connect` and exchanging
// on `exchange` with the client secret it holds in memory.

import test from 'node:test';
import assert from 'node:assert/strict';

import { newVerifier, challengeFor, CHALLENGE_RE, PendingVerifiers } from '../src/fleet/host/pkce.js';
import { authorizeUrl, cloudflareAuthorizeUrl, exchangeCode, exchangeCloudflareCode, PendingAuthorizations } from '../src/fleet/coordinator/oauth.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { Sidecar } from '../src/fleet/host/sidecar.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { startStubHub } from './helpers/stub-hub.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

// --- the arithmetic ----------------------------------------------------------

test('S256 matches RFC 7636 appendix B, and a verifier is 43 unreserved characters', () => {
  assert.equal(
    challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
  const v = newVerifier();
  assert.match(v, /^[A-Za-z0-9_-]{43}$/);
  assert.match(challengeFor(v), CHALLENGE_RE);
  assert.notEqual(newVerifier(), v);
});

test('a verifier is spent once, expires in ten minutes, and is kept per person', () => {
  let clock = 1_000_000;
  const p = new PendingVerifiers({ now: () => clock });
  const challenge = p.mint('github', 'a@b.com');
  assert.match(challenge, CHALLENGE_RE);

  assert.equal(p.spend('github', 'b@b.com'), null, "somebody else's connect is not this one");
  const verifier = p.spend('github', 'a@b.com');
  assert.ok(verifier && challengeFor(verifier) === challenge, 'what comes back hashes to what went out');
  assert.equal(p.spend('github', 'a@b.com'), null, 'once');

  p.mint('cloudflare', null);
  clock += 10 * 60_000 + 1;
  assert.equal(p.spend('cloudflare', null), null, 'expired');
});

test('a second connect replaces the first, so the URL on screen is the one that works', () => {
  const p = new PendingVerifiers();
  const first = p.mint('github', 'a@b.com');
  const second = p.mint('github', 'a@b.com');
  assert.notEqual(first, second);
  assert.equal(challengeFor(/** @type {string} */ (p.spend('github', 'a@b.com'))), second);
});

// --- the coordinator's half --------------------------------------------------

test('the authorize URLs carry the challenge as S256, and only when there is one', () => {
  const c = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  const gh = new URL(String(authorizeUrl({ clientId: 'id', origin: 'https://fleet.example', state: 's', codeChallenge: c })));
  assert.equal(gh.searchParams.get('code_challenge'), c);
  assert.equal(gh.searchParams.get('code_challenge_method'), 'S256');
  const plain = new URL(String(authorizeUrl({ clientId: 'id', origin: 'https://fleet.example', state: 's' })));
  assert.equal(plain.searchParams.has('code_challenge'), false);

  const cf = new URL(String(cloudflareAuthorizeUrl({ clientId: 'id', origin: 'https://fleet.example', state: 's', scopes: 'a.read', codeChallenge: c })));
  assert.equal(cf.searchParams.get('code_challenge'), c);
  assert.equal(cf.searchParams.get('code_challenge_method'), 'S256');
});

test('the exchanges send the verifier when given one, in each provider\'s own encoding', async () => {
  /** @type {any[]} */
  const seen = [];
  const fetch = /** @type {any} */ (async (url, init) => {
    seen.push({ url, init });
    return { status: 200, json: async () => ({ access_token: 'tok', refresh_token: 'ref', expires_in: 28800 }) };
  });
  await exchangeCode({ clientId: 'id', clientSecret: 'shh', code: 'c', origin: 'https://fleet.example', codeVerifier: 'v', fetch });
  assert.equal(JSON.parse(seen[0].init.body).code_verifier, 'v');
  await exchangeCode({ clientId: 'id', clientSecret: 'shh', code: 'c', origin: 'https://fleet.example', fetch });
  assert.equal('code_verifier' in JSON.parse(seen[1].init.body), false);

  await exchangeCloudflareCode({ clientId: 'id', clientSecret: 'shh', code: 'c', origin: 'https://fleet.example', codeVerifier: 'v', fetch });
  assert.equal(new URLSearchParams(seen[2].init.body).get('code_verifier'), 'v');
});

test('a pending state remembers whether the host offered a challenge', () => {
  const p = new PendingAuthorizations();
  p.mint({ state: 'a', hostId: 'box', email: 'a@b.com', pkce: true });
  p.mint({ state: 'b', hostId: 'box', email: 'a@b.com' });
  assert.equal(p.redeem('a')?.pkce, true);
  assert.equal(p.redeem('b')?.pkce, false);
});

test('offerOauth builds the host\'s challenge into the URL, and refuses a malformed one', () => {
  const core = new CoordinatorCore({ logger: quiet, githubApp: { clientId: 'Iv23liTEST', clientSecret: 'shh', slug: 's' } });
  const c = challengeFor(newVerifier());
  const reply = { ok: true, connections: { catalogue: [{ provider: 'github', url: 'x', codeChallenge: c }], connected: [] } };
  const offered = core.offerOauth(reply, 'box', 'a@b.com', 'https://fleet.example');
  const url = new URL(offered.connections.catalogue[0].url);
  assert.equal(url.searchParams.get('code_challenge'), c);
  assert.equal(core.pendingGithub.pending.get(url.searchParams.get('state')).pkce, true);

  const bad = { ok: true, connections: { catalogue: [{ provider: 'github', url: 'x', codeChallenge: 'not a challenge' }], connected: [] } };
  const plain = new URL(core.offerOauth(bad, 'box', 'a@b.com', 'https://fleet.example').connections.catalogue[0].url);
  assert.equal(plain.searchParams.has('code_challenge'), false);
  assert.equal(core.pendingGithub.pending.get(plain.searchParams.get('state')).pkce, false);
});

test('with a challenge on file the coordinator relays the code and never exchanges it', async () => {
  const core = new CoordinatorCore({ logger: quiet, githubApp: { clientId: 'Iv23liTEST', clientSecret: 'shh', slug: 's' } });
  /** @type {any[]} */
  const dispatched = [];
  core.dispatch = async (spec) => {
    dispatched.push(spec);
    return { ok: true, text: 'Your sessions can use GitHub now. The token lasts 8 hours and that machine renews it by itself from here on.' };
  };
  // Any fetch at all would be the coordinator exchanging; there must be none.
  const before = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => { throw new Error('the coordinator must not talk to GitHub on this path'); });
  try {
    core.pendingGithub.mint({ state: 'st', hostId: 'box', email: 'a@b.com', pkce: true });
    const r = await core.finishGithubAuthorization({ code: 'the-code', state: 'st', origin: 'https://fleet.example/' });
    assert.equal(r.ok, true);
    assert.match(r.text, /renews it by itself/);
  } finally {
    globalThis.fetch = before;
  }
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].verb, 'exchange');
  assert.deepEqual(dispatched[0].params, { provider: 'github', code: 'the-code', clientId: 'Iv23liTEST', origin: 'https://fleet.example' });
  assert.equal(dispatched[0].preferHost, 'box');
  assert.equal(dispatched[0].actor, 'a@b.com');
});

test('a host that offered a challenge but cannot finish is reported, not mistaken for GitHub refusing', async () => {
  const core = new CoordinatorCore({ logger: quiet, githubApp: { clientId: 'id', clientSecret: 'shh', slug: 's' } });
  core.dispatch = async () => ({ ok: false, error: { code: 'unknown_verb' }, text: 'unknown verb' });
  core.pendingGithub.mint({ state: 'st', hostId: 'box', email: null, pkce: true });
  const r = await core.finishGithubAuthorization({ code: 'c', state: 'st', origin: 'https://fleet.example' });
  assert.equal(r.ok, false);
  assert.match(r.text, /Update the host/);
});

// --- the host's half ---------------------------------------------------------

/** A transport that hands messages in and collects what comes back out. */
function fakeTransport() {
  /** @type {object[]} */
  const sent = [];
  return {
    origin: 'https://coord.example',
    sent,
    onMessage: () => {},
    send: (/** @type {object} */ msg) => { sent.push(msg); },
    start: async () => true,
    stop: async () => true,
  };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{ fetchImpl?: any, catalogue?: any[] }} [opts]
 */
async function host(t, { fetchImpl, catalogue } = {}) {
  /** @type {string[]} */
  const commands = [];
  const stub = await startStubHub({
    onCommand: (line) => {
      commands.push(line);
      if (line.startsWith('/connect')) {
        return {
          ok: true,
          text: 'pick one',
          connections: { catalogue: catalogue ?? [{ provider: 'github', url: 'paste', flow: 'paste' }, { provider: 'claude', url: null }], connected: [] },
        };
      }
      return { ok: true, text: `ran ${line}` };
    },
  });
  t.after(() => stub.close());
  const sidecar = new Sidecar({
    hub: new HubClient({ baseUrl: stub.baseUrl, readTimeoutMs: 2000 }),
    transport: /** @type {any} */ (fakeTransport()),
    hostId: 'box',
    healthIntervalMs: 0,
    watch: false,
    logger: quiet,
    fetchImpl,
  });
  return { stub, sidecar, commands };
}

/** @param {object} patch */
const intent = (patch) => ({
  v: PROTOCOL_VERSION, kind: 'intent', id: `id-${Math.random().toString(36).slice(2, 12)}`, verb: 'list', params: {}, issuedAt: Date.now(), ...patch,
});

const FRAME = { v: PROTOCOL_VERSION, kind: 'config', values: { githubClientSecret: 'shh-secret' } };

test('a connect reply carries a challenge only for a provider whose secret is on the frame', async (t) => {
  const { sidecar } = await host(t);
  const before = await sidecar.handle(intent({ verb: 'connect', params: {}, actor: 'a@b.com' }));
  assert.equal('codeChallenge' in before.connections.catalogue[0], false, 'no secret, no promise this host cannot keep');

  await sidecar.handle(FRAME);
  const after = await sidecar.handle(intent({ verb: 'connect', params: {}, actor: 'a@b.com' }));
  const github = after.connections.catalogue.find((/** @type {any} */ c) => c.provider === 'github');
  assert.match(github.codeChallenge, CHALLENGE_RE);
  assert.equal(github.url, 'paste', 'the URL is the coordinator\'s to rewrite, not this host\'s');
  const claude = after.connections.catalogue.find((/** @type {any} */ c) => c.provider === 'claude');
  assert.equal('codeChallenge' in claude, false);
});

test('exchange spends the verifier, exchanges with the frame\'s secret, and stores by /link and /renew', async (t) => {
  /** @type {any[]} */
  const seen = [];
  const fetchImpl = async (/** @type {string} */ url, /** @type {any} */ init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return { status: 200, json: async () => ({ access_token: 'gho_token', refresh_token: 'ghr_refresh', expires_in: 28800 }) };
  };
  const { sidecar, commands } = await host(t, { fetchImpl });
  await sidecar.handle(FRAME);
  const offered = await sidecar.handle(intent({ verb: 'connect', params: {}, actor: 'a@b.com' }));
  const challenge = offered.connections.catalogue[0].codeChallenge;

  const r = await sidecar.handle(intent({
    verb: 'exchange',
    params: { provider: 'github', code: 'the-code', clientId: 'Iv23liTEST', origin: 'https://fleet.example' },
    actor: 'a@b.com',
  }));

  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /renews it by itself/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://github.com/login/oauth/access_token');
  assert.equal(seen[0].body.client_secret, 'shh-secret', 'the secret from the frame, held in memory');
  assert.equal(seen[0].body.code, 'the-code');
  assert.equal(seen[0].body.redirect_uri, 'https://fleet.example/oauth/github/callback');
  assert.equal(challengeFor(seen[0].body.code_verifier), challenge, 'the verifier that hashes to the challenge offered');
  assert.deepEqual(commands.filter((c) => !c.startsWith('/connect')), [
    '/link github gho_token',
    '/renew github Iv23liTEST ghr_refresh',
  ]);
  assert.equal(commands.some((c) => c.includes('shh-secret')), false, 'the client secret never becomes a command line');
});

test('exchange without a pending verifier is refused, and a second exchange finds the first one spent', async (t) => {
  const fetchImpl = async () => ({ status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) });
  const { sidecar } = await host(t, { fetchImpl });
  await sidecar.handle(FRAME);
  const params = { provider: 'github', code: 'c', clientId: 'id', origin: 'https://fleet.example' };

  const cold = await sidecar.handle(intent({ verb: 'exchange', params, actor: 'a@b.com' }));
  assert.equal(cold.ok, false);
  assert.match(cold.text, /No GitHub sign-in is waiting/);

  await sidecar.handle(intent({ verb: 'connect', params: {}, actor: 'a@b.com' }));
  const first = await sidecar.handle(intent({ verb: 'exchange', params, actor: 'a@b.com' }));
  assert.equal(first.ok, true);
  const again = await sidecar.handle(intent({ verb: 'exchange', params, actor: 'a@b.com' }));
  assert.equal(again.ok, false, 'spent');
});

test('somebody else cannot spend a verifier minted for another person', async (t) => {
  const fetchImpl = async () => ({ status: 200, json: async () => ({ access_token: 't' }) });
  const { sidecar } = await host(t, { fetchImpl });
  await sidecar.handle(FRAME);
  await sidecar.handle(intent({ verb: 'connect', params: {}, actor: 'a@b.com' }));
  const r = await sidecar.handle(intent({
    verb: 'exchange', params: { provider: 'github', code: 'c', clientId: 'id', origin: 'https://fleet.example' }, actor: 'b@b.com',
  }));
  assert.equal(r.ok, false);
});

test('a provider refusing the exchange is the provider\'s words, and nothing is stored', async (t) => {
  const fetchImpl = async () => ({ status: 200, json: async () => ({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }) });
  const { sidecar, commands } = await host(t, { fetchImpl });
  await sidecar.handle(FRAME);
  await sidecar.handle(intent({ verb: 'connect', params: {}, actor: 'a@b.com' }));
  const r = await sidecar.handle(intent({
    verb: 'exchange', params: { provider: 'github', code: 'c', clientId: 'id', origin: 'https://fleet.example' }, actor: 'a@b.com',
  }));
  assert.equal(r.ok, false);
  assert.match(r.text, /incorrect or expired/);
  assert.equal(commands.some((c) => c.startsWith('/link')), false);
});
