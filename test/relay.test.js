// The relays, at the request: a fleet registers, sends notifications whose
// envelopes it made itself, is capped and told so, and a GitHub sign-in comes
// back to its coordinator sealed. And the promise the whole thing rests on:
// after any of it, nothing is kept but a hash per fleet and a counter.
//
//   node --test test/relay.test.js
//
// docs/relay-terms.md is the specification; issue #348.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LIMITS, MAX_ITEMS, answerRelay, quiet } from '../src/fleet/relay/relay.js';
import { fcmPusher } from '../src/fleet/push.js';
import { openWith, toBase64Url } from '../src/fleet/push-crypto.js';

const ORIGIN = 'https://fleet.test';

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

/** A pusher that records what it was handed. */
function recorder() {
  /** @type {any[]} */
  const sends = [];
  return {
    sends,
    async send(/** @type {any[]} */ devices, /** @type {any} */ message) {
      sends.push({ devices, message });
      return { sent: devices.length, dead: [] };
    },
  };
}

async function keypair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toBase64Url(raw) };
}

/** @param {any} deps @param {string} path @param {any} [body] @param {{ method?: string, auth?: string }} [opts] */
async function call(deps, path, body, { method = 'POST', auth } = {}) {
  const res = await answerRelay(new Request(`${ORIGIN}/relay/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), deps);
  return { status: res.status, headers: res.headers, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
}

const wire = (/** @type {string} */ e) => ({ encrypted: true, title: 'Fleetwright', body: 'Something needs you. Open to see.', data: { e } });

test('a fleet registers, its secret is kept only as a hash, and it is the only key that opens it', async () => {
  const store = memory();
  const pusher = recorder();
  const deps = { store, env: {}, pusher };
  const made = await call(deps, '/fleets', {});
  assert.equal(made.status, 201);
  const { fleet, secret } = made.body;
  assert.ok(![...store.rows.values()].some((r) => JSON.stringify(r).includes(secret)), 'the secret is kept as it was given');
  const item = { token: 'tok-1', platform: 'android', wire: wire('sealed') };
  assert.equal((await call(deps, '/push', { items: [item] })).status, 401);
  assert.equal((await call(deps, '/push', { items: [item] }, { auth: `${fleet}.${'A'.repeat(43)}` })).status, 401);
  assert.equal((await call(deps, '/push', { items: [item] }, { auth: `${fleet}.${secret}` })).status, 200);
  // Forgotten is gone.
  assert.equal((await call(deps, '/fleets/self', undefined, { method: 'DELETE', auth: `${fleet}.${secret}` })).status, 200);
  assert.equal((await call(deps, '/push', { items: [item] }, { auth: `${fleet}.${secret}` })).status, 401);
  assert.equal(store.rows.has(`f:${fleet}`), false);
});

test('a notification is delivered as its coordinator made it, and nothing about it is kept', async () => {
  const store = memory();
  const pusher = recorder();
  const deps = { store, env: {}, pusher };
  const { fleet, secret } = (await call(deps, '/fleets', {})).body;
  const items = [
    { token: 'ios-token', platform: 'ios', wire: wire('ciphertext-one') },
    { token: 'droid-token', platform: 'android', wire: { encrypted: false, title: 'build-server', body: 'Allow it?', data: { name: 'build-server', sentAt: '1' } } },
  ];
  const got = await call(deps, '/push', { items, category: 'answer.yesno' }, { auth: `${fleet}.${secret}` });
  assert.deepEqual(got.body, { ok: true, sent: 2, dead: [] });
  // Handed on exactly: not edited, not re-sealed.
  assert.deepEqual(pusher.sends[0].devices, items.map(({ token, platform, wire: w }) => ({ token, platform, wire: w })));
  assert.equal(pusher.sends[0].message.category, 'answer.yesno');
  // THE PROMISE: a hash for the fleet and a counter, and not a byte of any
  // notification, token or device.
  assert.deepEqual([...store.rows.keys()].sort(), [`f:${fleet}`, `n:push:${fleet}`, 'n:register:all'].sort());
  const kept = JSON.stringify([...store.rows.values()]);
  for (const word of ['ios-token', 'droid-token', 'ciphertext-one', 'Allow it?', 'build-server']) assert.ok(!kept.includes(word), word);
});

test('the senders send an envelope that arrives made, and do not make another', async () => {
  // The relay's whole claim about a sealed notification: it forwards the
  // coordinator's ciphertext. A sender that sealed again, or sent the
  // plaintext beside it, would make that untrue.
  /** @type {any[]} */
  const posted = [];
  const fetchImpl = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'g', expires_in: 3600 }), { status: 200 });
    posted.push(JSON.parse(init.body));
    return new Response('{}', { status: 200 });
  });
  const { privateKey: pem } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign'])
    .then(async (k) => ({ privateKey: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', k.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----` }));
  const fcm = fcmPusher({ client_email: 'a@b', private_key: pem, project_id: 'p' }, { fetchImpl });
  await fcm.send([{ token: 't', platform: 'android', pushKey: 'never-used', wire: wire('made-upstream') }], { title: 'secret title', body: 'secret body' });
  assert.equal(posted[0].message.data.e, 'made-upstream');
  assert.ok(!JSON.stringify(posted).includes('secret'), 'the plaintext travelled beside the envelope');
});

test('a fleet over its cap is refused and told the cap and when it resets, and nobody else is', async () => {
  const store = memory();
  let now = Date.UTC(2026, 9, 7, 12, 0, 0);
  const deps = { store, env: {}, pusher: recorder(), now: () => now };
  const a = (await call(deps, '/fleets', {})).body;
  const b = (await call(deps, '/fleets', {})).body;
  const items = Array.from({ length: MAX_ITEMS }, (_, i) => ({ token: `t${i}`, platform: 'android', wire: wire('x') }));
  for (let i = 0; i < LIMITS.push.max / MAX_ITEMS; i++) assert.equal((await call(deps, '/push', { items }, { auth: `${a.fleet}.${a.secret}` })).status, 200);
  const over = await call(deps, '/push', { items: items.slice(0, 1) }, { auth: `${a.fleet}.${a.secret}` });
  assert.equal(over.status, 429);
  assert.equal(over.body.limit, LIMITS.push.max);
  assert.equal(over.body.resetAt, Date.UTC(2026, 9, 7, 13, 0, 0));
  assert.ok(Number(over.headers.get('retry-after')) > 0);
  assert.match(over.body.text, /limit of 600 an hour\. It resets at 2026-10-07T13:00:00\.000Z/);
  assert.equal((await call(deps, '/push', { items: items.slice(0, 1) }, { auth: `${b.fleet}.${b.secret}` })).status, 200, 'another fleet paid for it');
  // The window turns, and the counter is overwritten rather than added to.
  now += LIMITS.push.window;
  assert.equal((await call(deps, '/push', { items: items.slice(0, 1) }, { auth: `${a.fleet}.${a.secret}` })).status, 200);
  assert.deepEqual(store.rows.get(`n:push:${a.fleet}`), { window: Date.UTC(2026, 9, 7, 13, 0, 0), used: 1 });
});

test('registering is open and capped across everybody', async () => {
  const deps = { store: memory(), env: {}, pusher: recorder(), now: () => Date.UTC(2026, 9, 7, 12, 30) };
  for (let i = 0; i < LIMITS.register.max; i++) assert.equal((await call(deps, '/fleets', {})).status, 201);
  assert.equal((await call(deps, '/fleets', {})).status, 429);
});

test('a GitHub sign-in is exchanged here with the secret and goes back to its coordinator sealed, and nothing about it is kept', async () => {
  const store = memory();
  const { privateKey, publicKey } = await keypair();
  /** @type {any} */
  let asked = null;
  const fetchImpl = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    asked = { url: String(url), body: new URLSearchParams(init.body) };
    return new Response(JSON.stringify({ access_token: 'ghu_the-token', expires_in: 28800, refresh_token: 'ghr_never-forwarded', scope: '' }), { status: 200 });
  });
  const deps = { store, env: { FLEETWRIGHT_GITHUB_CLIENT_ID: 'Iv-client', FLEETWRIGHT_GITHUB_CLIENT_SECRET: 'the-secret' }, pusher: recorder(), fetchImpl };
  const { fleet } = (await call(deps, '/fleets', { callback: 'https://their.coordinator/oauth/github/relayed', key: publicKey })).body;
  const res = await call(deps, `/github/callback?code=c0de&state=${fleet}.inner-state-1`, undefined, { method: 'GET' });
  assert.equal(res.status, 303);
  const back = new URL(/** @type {string} */ (res.headers.get('location')));
  assert.equal(`${back.origin}${back.pathname}`, 'https://their.coordinator/oauth/github/relayed');
  assert.equal(back.searchParams.get('state'), 'inner-state-1', 'the coordinator is handed its own state, not the fleet');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(asked.body.get('client_secret'), 'the-secret');
  assert.equal(asked.body.get('redirect_uri'), `${ORIGIN}/relay/v1/github/callback`);
  // Only ciphertext in the URL, and it opens with the coordinator's key.
  const sealed = /** @type {string} */ (back.searchParams.get('sealed'));
  assert.ok(!back.toString().includes('ghu_'), 'the token travelled in the clear');
  const opened = await openWith(privateKey, publicKey, sealed);
  assert.deepEqual(opened, { accessToken: 'ghu_the-token', expiresIn: 28800, scope: '' });
  // Nothing kept: no code, no token, no state.
  const kept = JSON.stringify([...store.rows.entries()]);
  for (const word of ['c0de', 'ghu_', 'ghr_', 'inner-state-1']) assert.ok(!kept.includes(word), word);
});

test('a sign-in that went wrong goes back in one word, and one that is not a fleet’s goes nowhere', async () => {
  const { publicKey } = await keypair();
  const failing = /** @type {any} */ (async () => new Response('{"error":"bad_verification_code"}', { status: 200 }));
  const deps = { store: memory(), env: { FLEETWRIGHT_GITHUB_CLIENT_ID: 'Iv', FLEETWRIGHT_GITHUB_CLIENT_SECRET: 's' }, pusher: recorder(), fetchImpl: failing };
  const { fleet } = (await call(deps, '/fleets', { callback: 'https://c.example/back', key: publicKey })).body;
  const errorOf = async (/** @type {string} */ q) => new URL(/** @type {string} */ ((await call(deps, `/github/callback?${q}`, undefined, { method: 'GET' })).headers.get('location'))).searchParams.get('error');
  assert.equal(await errorOf(`state=${fleet}.state-one-1&error=access_denied&error_description=%3Cscript%3E`), 'denied');
  assert.equal(await errorOf(`state=${fleet}.state-two-2&code=c`), 'exchange');
  for (const state of ['nofleet', `${'A'.repeat(22)}.s3`, `${fleet}.`, `${fleet}.d.device-state`]) {
    const page = await call(deps, `/github/callback?code=c&state=${encodeURIComponent(state)}`, undefined, { method: 'GET' });
    assert.equal(page.status, 400, state);
    assert.match(page.body, /did not come from a fleet this relay knows/);
  }
  // Both or neither: a callback with nowhere sealed to go is refused.
  assert.equal((await call(deps, '/fleets', { callback: 'https://c.example/back' })).status, 400);
  assert.equal((await call(deps, '/fleets', { callback: 'http://c.example/back', key: publicKey })).status, 400);
});

test('the only words a provider’s answer leaves in the log are its status', () => {
  /** @type {string[]} */
  const said = [];
  const warn = console.warn;
  console.warn = (/** @type {string} */ m) => void said.push(m);
  try {
    quiet.warn('push: FCM 400 {"error":{"message":"Invalid value at message.data[0].value: Allow it? on build-server"}}');
    quiet.warn('push: a android device was skipped — token tok-123 could not be read');
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(said, ['relay: a provider refused one (400)', 'relay: a provider refused one']);
});

test('the relay Worker has observability off, so no callback URL is logged by the platform', () => {
  const toml = readFileSync(new URL('../worker/wrangler.relay.toml', import.meta.url), 'utf8');
  assert.match(toml, /^\[observability\]\nenabled = false$/m);
  assert.match(toml, /^workers_dev = false$/m);
});
