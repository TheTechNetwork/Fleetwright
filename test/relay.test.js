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

import { IDLE, LIMITS, MAX_BODY, MAX_ITEMS, answerRelay, quiet } from '../src/fleet/relay/relay.js';
import { fcmPusher } from '../src/fleet/push.js';
import { openWith, toBase64Url } from '../src/fleet/push-crypto.js';

const ORIGIN = 'https://fleet.test';

/** Durable Object storage as the relay uses it, `list` included, keys in order. */
function memory() {
  /** @type {Map<string, any>} */
  const rows = new Map();
  return {
    rows,
    get: async (/** @type {string} */ k) => structuredClone(rows.get(k)),
    put: async (/** @type {string} */ k, /** @type {any} */ v) => void rows.set(k, structuredClone(v)),
    delete: async (/** @type {string} */ k) => void rows.delete(k),
    list: async (/** @type {{ prefix: string, startAfter?: string, limit: number }} */ { prefix, startAfter, limit }) => new Map(
      [...rows.keys()].filter((k) => k.startsWith(prefix) && (startAfter === undefined || k > startAfter)).sort().slice(0, limit)
        .map((k) => [k, structuredClone(rows.get(k))]),
    ),
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

/** @param {any} deps @param {string} path @param {any} [body] @param {{ method?: string, auth?: string, cookie?: string }} [opts] */
async function call(deps, path, body, { method = 'POST', auth, cookie } = {}) {
  const res = await answerRelay(new Request(`${ORIGIN}/relay/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), deps);
  return { status: res.status, headers: res.headers, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
}

/**
 * A sign-in started the way a browser starts one: the relay's page, then its
 * button, posted from that page. The response, and the cookie it set.
 *
 * @param {any} deps @param {string} state @param {string} [origin]
 */
async function startSignIn(deps, state, origin = ORIGIN) {
  const res = await answerRelay(new Request(`${ORIGIN}/relay/v1/github/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: new URLSearchParams({ state }).toString(),
  }), deps);
  return { res, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
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

test('a body over the cap is refused having read no more than the cap, counted in bytes', async () => {
  // Every POST is read before anybody is authorised, inside the one object
  // every fleet shares, so a body read whole and measured afterwards is
  // memory any stranger can spend there.
  const store = memory();
  const deps = { store, env: {}, pusher: recorder() };
  const chunk = new Uint8Array(16 * 1024).fill(0x20);
  /** 8 MiB that counts what was taken from it. @param {{ pulled: number }} seen */
  const big = (seen) => new ReadableStream({
    pull(c) {
      if (seen.pulled >= 8 * 1024 * 1024) return c.close();
      seen.pulled += chunk.byteLength;
      c.enqueue(chunk);
    },
  });
  const post = (/** @type {any} */ body, /** @type {Record<string, string>} */ headers = {}) =>
    answerRelay(new Request(`${ORIGIN}/relay/v1/fleets`, { method: 'POST', headers, body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) }), deps);
  // No length declared: the reader stops at the cap, not at the end.
  const chunked = { pulled: 0 };
  assert.equal((await post(big(chunked))).status, 413);
  assert.ok(chunked.pulled <= MAX_BODY + 2 * chunk.byteLength, `read ${chunked.pulled} bytes of a body over the cap`);
  // A length over the cap is refused before anything is read.
  const declared = { pulled: 0 };
  assert.equal((await post(big(declared), { 'content-length': String(8 * 1024 * 1024) })).status, 413);
  assert.ok(declared.pulled <= chunk.byteLength, `read ${declared.pulled} bytes of a body declared over the cap`);
  // Bytes, not UTF-16 units: 30,000 three-byte characters is 90,000 bytes.
  assert.equal((await post(JSON.stringify({ pad: '中'.repeat(30_000) }))).status, 413);
  assert.equal(store.rows.size, 0, 'something was kept from a refused body');
});

test('a fleet row is small, and is not kept after its fleet stops using it or forgets itself', async () => {
  const store = memory();
  let now = Date.UTC(2026, 9, 7, 12, 0, 0);
  const deps = { store, env: {}, pusher: recorder(), now: () => now };
  const { publicKey } = await keypair();
  // THE CALLBACK IS MEASURED AS KEPT: a path of non-ASCII characters is
  // stored percent-encoded, nine bytes for every one that arrived.
  const long = await call(deps, '/fleets', { callback: `https://c.example/${'中'.repeat(300)}`, key: publicKey });
  assert.equal(long.status, 400, 'a callback of 2.7 KB was kept');
  assert.ok(![...store.rows.keys()].some((k) => k.startsWith('f:')));

  const item = { token: 't', platform: 'android', wire: wire('x') };
  const idle = (await call(deps, '/fleets', {})).body;
  const busy = (await call(deps, '/fleets', {})).body;
  for (const f of [idle, busy]) assert.equal((await call(deps, '/push', { items: [item] }, { auth: `${f.fleet}.${f.secret}` })).status, 200);
  // One keeps sending and one goes quiet, until the quiet one is past IDLE.
  now += IDLE - 24 * 3600_000;
  assert.equal((await call(deps, '/push', { items: [item] }, { auth: `${busy.fleet}.${busy.secret}` })).status, 200);
  now += 2 * 24 * 3600_000;
  const late = (await call(deps, '/fleets', {})).body;
  assert.equal(store.rows.has(`f:${idle.fleet}`), false, 'a fleet idle past IDLE is still kept');
  assert.equal(store.rows.has(`n:push:${idle.fleet}`), false, 'its counter outlived it');
  assert.equal((await call(deps, '/push', { items: [item] }, { auth: `${busy.fleet}.${busy.secret}` })).status, 200, 'a fleet in use was forgotten');
  // Forgetting itself takes its counters with it.
  assert.equal((await call(deps, '/fleets/self', undefined, { method: 'DELETE', auth: `${busy.fleet}.${busy.secret}` })).status, 200);
  assert.deepEqual([...store.rows.keys()].sort(), [`f:${late.fleet}`, 'n:register:all']);
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
  const registered = structuredClone(Object.fromEntries(store.rows));
  const { cookie } = await startSignIn(deps, `${fleet}.inner-state-1`);
  const res = await call(deps, `/github/callback?code=c0de&state=${fleet}.inner-state-1`, undefined, { method: 'GET', cookie });
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
  assert.deepEqual(opened, { state: 'inner-state-1', accessToken: 'ghu_the-token', expiresIn: 28800, scope: '' });
  // Nothing kept: no code, no token, no state. The store after the sign-in is
  // the store before it plus the fleet's sign-in counter, compared row for
  // row. Searching the rows for the words instead failed about one run in a
  // thousand: the fleet's record holds its secret's SHA-256 in hex, and `c0de`
  // turns up in 61 of every 65,536 of those (38 in 40,000 runs, measured).
  const kept = Object.fromEntries(store.rows);
  assert.deepEqual(Object.keys(kept).sort(), [...Object.keys(registered), `n:oauth:${fleet}`].sort());
  for (const [key, row] of Object.entries(registered)) assert.deepEqual(kept[key], row, key);
  assert.deepEqual(Object.keys(kept[`n:oauth:${fleet}`]).sort(), ['used', 'window']);
  assert.ok(Object.values(kept[`n:oauth:${fleet}`]).every(Number.isFinite), 'the counter holds numbers and nothing else');
});

test('a sign-in that went wrong goes back in one word, and one that is not a fleet’s goes nowhere', async () => {
  const { publicKey } = await keypair();
  const failing = /** @type {any} */ (async () => new Response('{"error":"bad_verification_code"}', { status: 200 }));
  const deps = { store: memory(), env: { FLEETWRIGHT_GITHUB_CLIENT_ID: 'Iv', FLEETWRIGHT_GITHUB_CLIENT_SECRET: 's' }, pusher: recorder(), fetchImpl: failing };
  const { fleet } = (await call(deps, '/fleets', { callback: 'https://c.example/back', key: publicKey })).body;
  const errorOf = async (/** @type {string} */ state, /** @type {string} */ q) => {
    const { cookie } = await startSignIn(deps, state);
    const res = await call(deps, `/github/callback?state=${state}&${q}`, undefined, { method: 'GET', cookie });
    return new URL(/** @type {string} */ (res.headers.get('location'))).searchParams.get('error');
  };
  assert.equal(await errorOf(`${fleet}.state-one-1`, 'error=access_denied&error_description=%3Cscript%3E'), 'denied');
  assert.equal(await errorOf(`${fleet}.state-two-2`, 'code=c'), 'exchange');
  for (const state of ['nofleet', `${'A'.repeat(22)}.s3`, `${fleet}.`, `${fleet}.d.device-state`]) {
    assert.equal((await startSignIn(deps, state)).res.status, 400, `a sign-in was started for ${state}`);
    const page = await call(deps, `/github/callback?code=c&state=${encodeURIComponent(state)}`, undefined, { method: 'GET' });
    assert.equal(page.status, 400, state);
    assert.match(page.body, /cannot tell that this sign-in started here/);
  }
  // Both or neither: a callback with nowhere sealed to go is refused.
  assert.equal((await call(deps, '/fleets', { callback: 'https://c.example/back' })).status, 400);
  assert.equal((await call(deps, '/fleets', { callback: 'http://c.example/back', key: publicKey })).status, 400);
});

test('a sign-in reaches a fleet only when it was started on the relay’s page for that fleet, in the same browser', async () => {
  // Registering is open, so a stranger can register a callback and key of
  // their own and hand somebody a real github.com link naming that fleet.
  // The App's consent screen says Fleetwright either way; what tells the
  // person where the token goes is the relay's page, so a code reaches a
  // fleet only through it.
  const { publicKey } = await keypair();
  /** @type {string[]} */
  const exchanged = [];
  const fetchImpl = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    exchanged.push(new URLSearchParams(init.body).get('code') ?? '');
    return new Response(JSON.stringify({ access_token: 'ghu_t', expires_in: 28800 }), { status: 200 });
  });
  const deps = { store: memory(), env: { FLEETWRIGHT_GITHUB_CLIENT_ID: 'Iv-client', FLEETWRIGHT_GITHUB_CLIENT_SECRET: 's' }, pusher: recorder(), fetchImpl };
  const { fleet } = (await call(deps, '/fleets', { callback: 'https://their.coordinator/oauth/github/relayed', key: publicKey })).body;
  const state = `${fleet}.inner-state-1`;

  // A link straight to GitHub, never started here: no exchange, nowhere sent.
  const direct = await call(deps, `/github/callback?code=victim-code&state=${state}`, undefined, { method: 'GET' });
  assert.equal(direct.status, 400);
  assert.equal(direct.headers.get('location'), null, 'sent on to the fleet’s callback');
  assert.deepEqual(exchanged, [], 'a code was exchanged for a sign-in nobody started here');

  // The page names where the token goes, before anything leaves for GitHub.
  const shown = await call(deps, `/github/start?state=${state}`, undefined, { method: 'GET' });
  assert.equal(shown.status, 200);
  assert.match(shown.body, /their\.coordinator/);
  assert.equal(shown.headers.get('set-cookie'), null, 'the page alone started a sign-in');
  // Its button, posted from another site, starts nothing.
  const forged = await startSignIn(deps, state, 'https://elsewhere.example');
  assert.equal(forged.res.status, 403);
  assert.equal(forged.cookie, '');
  // Posted from the page: on to GitHub, with the relay's own client and callback.
  const { res, cookie } = await startSignIn(deps, state);
  assert.equal(res.status, 303);
  const authorize = new URL(/** @type {string} */ (res.headers.get('location')));
  assert.equal(`${authorize.origin}${authorize.pathname}`, 'https://github.com/login/oauth/authorize');
  assert.equal(authorize.searchParams.get('client_id'), 'Iv-client');
  assert.equal(authorize.searchParams.get('redirect_uri'), `${ORIGIN}/relay/v1/github/callback`);
  assert.equal(authorize.searchParams.get('state'), state);
  // That browser's cookie is for that sign-in and no other.
  const other = await call(deps, `/github/callback?code=other-code&state=${fleet}.inner-state-2`, undefined, { method: 'GET', cookie });
  assert.equal(other.status, 400);
  assert.deepEqual(exchanged, []);
  const back = await call(deps, `/github/callback?code=c0de&state=${state}`, undefined, { method: 'GET', cookie });
  assert.equal(back.status, 303);
  assert.ok(new URL(/** @type {string} */ (back.headers.get('location'))).searchParams.get('sealed'));
  assert.deepEqual(exchanged, ['c0de']);
  assert.match(/** @type {string} */ (back.headers.get('set-cookie')), /Max-Age=0/, 'the cookie outlived its sign-in');
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
