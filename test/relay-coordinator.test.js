// The relays, from a coordinator's side: a fleet with no credentials of its
// own sends through the push relay with every envelope made before it
// leaves, and one with the App's id and not its secret signs people in to
// GitHub through the OAuth relay, the token arriving sealed to its own key.
// The relay's half is test/relay.test.js; this drives both together.
//
//   node --test test/relay-coordinator.test.js
//
// docs/relay-terms.md; issue #348.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { pusherFromEnv, relayPusher } from '../src/fleet/push.js';
import { relayFromEnv } from '../src/fleet/relay/client.js';
import { answerRelay } from '../src/fleet/relay/relay.js';
import { openWith, toBase64Url } from '../src/fleet/push-crypto.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function keypair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, jwk, publicKey: toBase64Url(raw) };
}

function memory() {
  /** @type {Map<string, any>} */
  const rows = new Map();
  return {
    rows,
    get: async (/** @type {string} */ k) => structuredClone(rows.get(k)),
    put: async (/** @type {string} */ k, /** @type {any} */ v) => void rows.set(k, structuredClone(v)),
    delete: async (/** @type {string} */ k) => void rows.delete(k),
  };
}

test('a phone with a key is sealed to before anything leaves for the relay', async () => {
  const phone = await keypair();
  /** @type {any[]} */
  const posted = [];
  const fetchImpl = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    posted.push({ url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, sent: 2, dead: [] }), { status: 200 });
  });
  const pusher = relayPusher({ url: 'https://relay.test', fleet: 'F'.repeat(22), secret: 'S'.repeat(43) }, { fetchImpl, now: () => 5 });
  const got = await pusher.send(
    [{ token: 'sealed-phone', platform: 'ios', pushKey: phone.publicKey }, { token: 'old-phone', platform: 'android' }],
    { title: 'build-server', body: 'Allow it?', data: { name: 'build-server' }, category: 'answer.yesno' },
  );
  assert.deepEqual(got, { sent: 2, dead: [] });
  assert.equal(posted[0].url, 'https://relay.test/relay/v1/push');
  assert.equal(posted[0].auth, `Bearer ${'F'.repeat(22)}.${'S'.repeat(43)}`);
  const [sealed, plain] = posted[0].body.items;
  assert.equal(sealed.wire.encrypted, true);
  assert.ok(!JSON.stringify(sealed).includes('Allow it?'), 'the relay was sent what the phone’s key was for');
  assert.deepEqual(await openWith(phone.privateKey, phone.publicKey, sealed.wire.data.e), { title: 'build-server', body: 'Allow it?', data: { name: 'build-server', sentAt: '5' } });
  // A phone that never registered a key gets what it would get from Apple or
  // Google anyway, and the category rides in the clear because iOS reads it
  // before anything could be decrypted.
  assert.equal(plain.wire.encrypted, false);
  assert.equal(posted[0].body.category, 'answer.yesno');
});

test('a fleet the relay is limiting says so with the cap and when it resets', async () => {
  /** @type {string[]} */
  const warned = [];
  const fetchImpl = /** @type {any} */ (async () => new Response(JSON.stringify({ ok: false, limited: true, limit: 600, resetAt: Date.UTC(2026, 9, 7, 13) }), { status: 429 }));
  const pusher = relayPusher({ url: 'https://relay.test', fleet: 'F'.repeat(22), secret: 'S'.repeat(43) }, { fetchImpl, logger: { info() {}, warn: (/** @type {string} */ m) => void warned.push(m) } });
  assert.deepEqual(await pusher.send([{ token: 't', platform: 'android' }], { title: 'a', body: 'b' }), { sent: 0, dead: [] });
  assert.deepEqual(warned, ['push: the relay is limiting this fleet to 600 an hour, until 2026-10-07T13:00:00.000Z']);
});

test('a coordinator with credentials of its own sends with them, and one without uses the relay', async () => {
  const relay = { FLEETWRIGHT_PUSH: '1', FLEETWRIGHT_RELAY_URL: 'https://relay.test/', FLEETWRIGHT_RELAY_FLEET: 'F'.repeat(22), FLEETWRIGHT_RELAY_SECRET: 'S'.repeat(43) };
  /** @type {string[]} */
  const said = [];
  const logger = { info: (/** @type {string} */ m) => void said.push(m), warn: (/** @type {string} */ m) => void said.push(m) };
  pusherFromEnv(relay, logger);
  assert.deepEqual(said, ['push: through the relay at https://relay.test']);
  said.length = 0;
  pusherFromEnv({ ...relay, FLEETWRIGHT_FCM_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'a@b', private_key: 'k', project_id: 'p' }) }, logger);
  assert.ok(said.some((m) => /FCM configured/.test(m)) && !said.some((m) => /relay/.test(m)), said.join('\n'));
  // A relay over plain HTTP is no relay: the secret would cross in the clear.
  assert.equal(relayFromEnv({ ...relay, FLEETWRIGHT_RELAY_URL: 'http://relay.test' }), null);
});

test('a GitHub sign-in goes out through the relay and comes back sealed to this coordinator, once', async () => {
  const coord = await keypair();
  const store = memory();
  const github = /** @type {any} */ (async () => new Response(JSON.stringify({ access_token: 'ghu_relayed', expires_in: 28800 }), { status: 200 }));
  const relayDeps = { store, env: { FLEETWRIGHT_GITHUB_CLIENT_ID: 'Iv-public', FLEETWRIGHT_GITHUB_CLIENT_SECRET: 'ours' }, fetchImpl: github, pusher: { async send() { return { sent: 0, dead: [] }; } } };
  const relayCall = async (/** @type {string} */ path, /** @type {RequestInit} */ init) => answerRelay(new Request(`https://relay.test/relay/v1${path}`, init), relayDeps);
  const registered = await (await relayCall('/fleets', { method: 'POST', body: JSON.stringify({ callback: 'https://their.fleet/oauth/github/relayed', key: coord.publicKey }) })).json();

  // THE COORDINATOR: the App's id and no secret, and the relay registration.
  const core = new CoordinatorCore({
    logger: quiet,
    githubApp: { clientId: 'Iv-public' },
    oauthRelay: { url: 'https://relay.test', fleet: registered.fleet, privateJwk: coord.jwk, publicKey: coord.publicKey },
  });
  /** @type {any[]} */
  const dispatched = [];
  core.dispatch = async (/** @type {any} */ spec) => (dispatched.push(spec), { ok: true });
  const reply = { ok: true, connections: { catalogue: [{ provider: 'github', url: 'https://github.com/settings/tokens/new', codeChallenge: 'A'.repeat(43) }], connected: [] } };
  const offered = core.offerOauth(reply, 'box', 'eli@example.com', 'https://their.fleet');
  const authorize = new URL(offered.connections.catalogue[0].url);
  assert.equal(authorize.searchParams.get('redirect_uri'), 'https://relay.test/relay/v1/github/callback', 'not sent to the relay');
  assert.equal(authorize.searchParams.get('code_challenge'), null, 'a challenge whose verifier no exchange here can use');
  const [fleet, state] = /** @type {string} */ (authorize.searchParams.get('state')).split('.');
  assert.equal(fleet, registered.fleet);

  // GitHub sends the person to the relay, which sends them back here.
  const back = new URL(/** @type {string} */ ((await relayCall(`/github/callback?code=c0de&state=${fleet}.${state}`, { method: 'GET' })).headers.get('location')));
  assert.equal(back.searchParams.get('state'), state);
  const done = await core.finishRelayedGithubAuthorization({ state: back.searchParams.get('state'), sealed: back.searchParams.get('sealed'), error: back.searchParams.get('error') });
  assert.equal(done.ok, true, done.text);
  assert.deepEqual(dispatched.map((d) => [d.verb, d.params.provider, d.params.secret, d.preferHost, d.actor]), [['link', 'github', 'ghu_relayed', 'box', 'eli@example.com']]);
  assert.ok(!dispatched.some((d) => d.verb === 'renew'), 'renewal material deposited with no secret anywhere to renew with');

  // ONCE: the same URL again is refused.
  const again = await core.finishRelayedGithubAuthorization({ state, sealed: back.searchParams.get('sealed') });
  assert.equal(again.ok, false);
  assert.match(again.text, /expired or was already used/);
});

test('a sealed token made for another sign-in, or a flow not made for the relay, connects nothing', async () => {
  const coord = await keypair();
  const { sealTo } = await import('../src/fleet/push-crypto.js');
  const core = new CoordinatorCore({ logger: quiet, githubApp: { clientId: 'Iv' }, oauthRelay: { url: 'https://relay.test', fleet: 'F'.repeat(22), privateJwk: coord.jwk, publicKey: coord.publicKey } });
  /** @type {any[]} */
  const dispatched = [];
  core.dispatch = async (/** @type {any} */ spec) => (dispatched.push(spec), { ok: true });
  // Anybody can seal to a public key; nobody can seal it for a state they never saw.
  core.pendingGithub.mint({ state: 'the-real-state', hostId: 'box', email: 'a@b.com', relayed: true });
  const forged = await sealTo(coord.publicKey, { state: 'some-other-state', accessToken: 'ghu_attacker' });
  const r = await core.finishRelayedGithubAuthorization({ state: 'the-real-state', sealed: forged });
  assert.equal(r.ok, false);
  assert.match(r.text, /not made for this link/);
  // A direct-exchange flow cannot be finished with a sealed token.
  core.pendingGithub.mint({ state: 'direct-state', hostId: 'box', email: 'a@b.com' });
  const sealed = await sealTo(coord.publicKey, { state: 'direct-state', accessToken: 'ghu_x' });
  assert.equal((await core.finishRelayedGithubAuthorization({ state: 'direct-state', sealed })).ok, false);
  // What the relay said, in this coordinator's words, never the query's.
  core.pendingGithub.mint({ state: 'denied-state', hostId: 'box', email: 'a@b.com', relayed: true });
  assert.match((await core.finishRelayedGithubAuthorization({ state: 'denied-state', error: 'denied' })).text, /not authorised/);
  assert.deepEqual(dispatched, []);
});
