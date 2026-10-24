// The browser's signing page (src/fleet/minter/sign-page.js): served only on
// the minter's own hostname, its script agreeing byte for byte with the
// fleet's own signing and sealing, and the whole of listing a key and using
// the vault with it run in a real browser against the real minter, the
// coordinator's callbacks and `/me`.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync } from 'node:fs';

import minterWorker, { ClaudeLogins, KEY_PATH } from '../worker/src/minter.js';
import { newDepositKey, seal, open, importDepositKey, GITHUB_REQUEST_AAD, GITHUB_REPLY_AAD, VAULT_REQUEST_AAD, VAULT_REPLY_AAD, SETUP_TOKEN_AAD } from '../src/fleet/seal.js';
import { signingInput, toB64Url } from '../src/fleet/crypto.js';
import { intentSigningInput, keyId, checkIntentSignature } from '../src/fleet/protocol/intent-signature.js';
import { boxKeyHash } from '../src/fleet/minter/vault.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { callbackPage, SIGNER_STATE_RE } from '../src/fleet/coordinator/oauth.js';
import { memberRoutes } from '../src/fleet/coordinator/member-page.js';

const ELI = 'eli@example.com';
const SIGN = 'sign.fleet.test';
const FLEET = 'https://fleet.test';

const json = (/** @type {number} */ status, /** @type {any} */ body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A minter with its own storage and a signing host, and GitHub stood in: a
 * code exchanges only with the verifier whose challenge GitHub was shown.
 */
async function signingMinter() {
  const deposit = await newDepositKey();
  const rows = new Map();
  /** @type {Record<string, any>} */
  const env = {
    FLEETWRIGHT_MINTER_DEPOSIT_KEY: deposit.secret,
    FLEETWRIGHT_GITHUB_CLIENT_ID: 'Iv23liTEST',
    FLEETWRIGHT_GITHUB_CLIENT_SECRET: 'gh-secret',
    FLEETWRIGHT_SIGNING_HOST: SIGN,
    FLEETWRIGHT_FLEET_ORIGIN: FLEET,
    FLEETWRIGHT_NAME: 'Test fleet',
    FLEETWRIGHT_CLOUDFLARE_CLIENT_ID: 'cf-id',
    FLEETWRIGHT_CLOUDFLARE_CLIENT_SECRET: 'cf-secret',
    FLEETWRIGHT_CLOUDFLARE_SCOPES: 'account-settings.read offline_access',
  };
  const storage = { get: async (/** @type {string} */ k) => rows.get(k), put: async (/** @type {string} */ k, /** @type {any} */ v) => { rows.set(k, structuredClone(v)); } };
  const instance = new ClaudeLogins({ storage }, env);
  env.LOGINS = { idFromName: () => 'logins', get: () => ({ fetch: (/** @type {string} */ u, /** @type {any} */ i) => instance.fetch(new Request(u, i)) }) };

  /** The challenge each provider's page was opened with, which its exchange has to answer. */
  const github = { challenge: '', exchanged: 0 };
  const cloudflare = { challenge: '', exchanged: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    const u = String(url);
    if (u === 'https://api.github.com/user') {
      return String(init.headers?.authorization) === 'Bearer ghu_browser' ? json(200, { id: 42, login: 'eli' }) : json(401, {});
    }
    if (u === 'https://github.com/login/oauth/access_token') {
      const f = Object.fromEntries(new URLSearchParams(String(init.body)).entries());
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(f.code_verifier || '')));
      const ok = f.client_secret === 'gh-secret' && f.code === 'browsercode1' && github.challenge && toB64Url(digest) === github.challenge &&
        f.redirect_uri === `${FLEET}/oauth/github/callback`;
      if (ok) github.exchanged += 1;
      return ok ? json(200, { access_token: 'ghu_browser', expires_in: 28800 }) : json(200, { error: 'bad_verification_code' });
    }
    if (u === 'https://dash.cloudflare.com/oauth2/token') {
      const f = Object.fromEntries(new URLSearchParams(String(init.body)).entries());
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(f.code_verifier || '')));
      const ok = f.client_secret === 'cf-secret' && f.code === 'cfcode1234' && cloudflare.challenge && toB64Url(digest) === cloudflare.challenge &&
        f.redirect_uri === `${FLEET}/oauth/cloudflare/callback`;
      if (ok) cloudflare.exchanged += 1;
      return ok ? json(200, { access_token: 'cf_access', refresh_token: 'cf_refresh', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
    }
    // Claude, asked whether a sign-in works before it is kept (claude.js,
    // checkBeforeKeeping): yes, without anything leaving this process.
    if (u === 'https://api.anthropic.com/v1/messages') return json(200, { content: [] });
    return real(url, init);
  });

  /** @param {string} path @param {unknown} body */
  const post = async (path, body) =>
    /** @type {any} */ (await (await minterWorker.fetch(new Request(`https://minter.internal${path}`, { method: 'POST', body: JSON.stringify(body) }), env)).json());
  /** The keys the minter lists for Eli, as a box's directory. */
  const directory = () => {
    const row = rows.get(`dk:${ELI}`);
    return new Map([[ELI, (row?.keys ?? []).filter((/** @type {any} */ k) => !k.removed).map((/** @type {any} */ k) => ({ kid: k.kid, key: k.key, label: k.label }))]]);
  };
  return { env, deposit, rows, github, cloudflare, post, directory, restore: () => { globalThis.fetch = real; } };
}

/** The page's own helpers, as it serves them, run in a VM with WebCrypto. @param {Record<string, any>} env */
async function pageHelpers(env) {
  const html = await (await minterWorker.fetch(new Request(`https://${SIGN}/`), env)).text();
  const first = html.split('<script>')[1].split('</script>')[0];
  const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob });
  vm.runInContext(first, ctx);
  return /** @type {any} */ (ctx).SIGNER;
}

test('the signing host answers its page, its callback and the public key, and none of the coordinator\u2019s routes', async () => {
  const m = await signingMinter();
  try {
    const page = await minterWorker.fetch(new Request(`https://${SIGN}/`), m.env);
    assert.equal(page.status, 200);
    const html = await page.text();
    // THE BROWSER RUNS ONLY WHAT THE POLICY HASHES, so a hash that drifted
    // from the script is a page that does nothing.
    const csp = String(page.headers.get('content-security-policy'));
    for (const script of html.split('<script>').slice(1).map((s) => s.split('</script>')[0])) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script)));
      assert.ok(csp.includes(`'sha256-${Buffer.from(digest).toString('base64')}'`), 'every inline script is in the policy');
    }
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.equal((await minterWorker.fetch(new Request(`https://${SIGN}/oauth/github/callback?code=x&state=y`), m.env)).status, 200);

    const key = await (await minterWorker.fetch(new Request(`https://${SIGN}${KEY_PATH}`), m.env)).json();
    assert.equal(/** @type {any} */ (key).key, m.deposit.publicKey);

    // A Custom Domain sends every path here. The POST routes trust that only
    // the coordinator's binding reaches them, so on this host they are not
    // there at all, while the binding is answered as before.
    for (const path of ['/vault/box', '/vault/device', '/vault/keys', '/github/token', '/mint', '/claude/login']) {
      const r = await minterWorker.fetch(new Request(`https://${SIGN}${path}`, { method: 'POST', body: '{}' }), m.env);
      assert.equal(r.status, 404, `${path} on the signing host`);
    }
    const bound = await minterWorker.fetch(new Request('https://minter.internal/vault/keys', { method: 'POST', body: '{}' }), m.env);
    assert.equal(bound.status, 200, 'the binding still reaches the vault');
    assert.equal((await minterWorker.fetch(new Request(`https://${SIGN}/me`), m.env)).status, 404);
  } finally {
    m.restore();
  }
});

test('the page’s script signs and seals exactly as the fleet’s own code checks', async () => {
  const m = await signingMinter();
  try {
    const S = await pageHelpers(m.env);
    for (const payload of [{ b: 1, a: [2, { d: null, c: 'x' }], u: undefined }, { verb: 'setuptoken', params: { kind: 'login', code: 'cé' } }, {}]) {
      assert.equal(S.signingInput('intent', payload), signingInput('intent', payload));
    }
    for (const [k, v] of Object.entries({ GITHUB_REQUEST_AAD, GITHUB_REPLY_AAD, VAULT_REQUEST_AAD, VAULT_REPLY_AAD, SETUP_TOKEN_AAD })) assert.equal(S[k], v, k);

    // A signature a box takes, over an intent the page built, from a key a
    // box would list.
    const key = await S.newSigningKey();
    assert.equal(key.kid, await keyId(key.publicJwk));
    const directory = new Map([[ELI, [{ kid: key.kid, key: key.publicJwk }]]]);
    const intent = JSON.parse(JSON.stringify(S.intent('setuptoken', { kind: 'login' }, ELI, 'box1', Date.now())));
    const sig = await S.sign(key.privateKey, S.intentInput(intent, 'box1', {}));
    assert.equal((await checkIntentSignature({ intent, sig, kid: key.kid, host: 'box1', directory })).verdict, 'signed');
    assert.equal((await checkIntentSignature({ intent, sig, kid: key.kid, host: 'box2', directory })).verdict, 'bad-signature');
    // The parameters the fleet sets are left out, as a box leaves them out.
    const start = { verb: 'start', params: { title: 't', archive: 'fleet-set' }, actor: ELI, id: 'intent-0002', issuedAt: 1 };
    assert.equal(S.intentInput(start, 'box1', { start: ['archive', 'boxSecrets'] }), intentSigningInput(start, 'box1'));

    // Sealed both ways with the minter's construction.
    const deposit = await importDepositKey(m.deposit.secret);
    const sealed = await S.seal(m.deposit.publicKey, GITHUB_REQUEST_AAD, { v: 1, hello: 'minter' });
    assert.deepEqual(await open({ ...deposit, aad: GITHUB_REQUEST_AAD, sealed }), { v: 1, hello: 'minter' });
    const mine = await S.newSealKey();
    const back = await seal({ to: mine.publicKey, aad: VAULT_REPLY_AAD, payload: { kid: key.kid } });
    assert.deepEqual(JSON.parse(JSON.stringify(await S.open(mine, VAULT_REPLY_AAD, back))), { kid: key.kid });
    await assert.rejects(S.open(mine, VAULT_REQUEST_AAD, back), 'under another name it does not open');

    // A sign-in the page starts is one the coordinator sends back to it.
    const p = await S.pkce();
    assert.match(p.state, SIGNER_STATE_RE);
    assert.match(p.verifier, /^[A-Za-z0-9._~-]{43,128}$/);

    // A machine's fingerprint, as the minter files its grant and the machine
    // prints it: the first sixteen of the same hash.
    const box = { kty: 'EC', crv: 'P-256', x: key.publicJwk.x, y: key.publicJwk.y };
    assert.equal(S.fingerprint(await S.keyId(box)).replace(/ /g, ''), (await boxKeyHash(box)).slice(0, 16));
  } finally {
    m.restore();
  }
});

test('the page signs a Claude sign-in made on one machine, and nothing else', async () => {
  const m = await signingMinter();
  try {
    const S = await pageHelpers(m.env);
    const now = Date.now();
    assert.equal(S.intent('setuptoken', { kind: 'login' }, ELI, 'box1', now).actor, ELI);
    // A slip elsewhere on the page cannot make it sign a start, or an intent
    // for every machine at once.
    assert.throws(() => S.intent('start', {}, ELI, 'box1', now), /only a Claude sign-in/);
    assert.throws(() => S.intent('link', { provider: 'github' }, ELI, 'box1', now), /only a Claude sign-in/);
    assert.throws(() => S.intent('setuptoken', {}, ELI, '', now), /no machine/);
    // Cloudflare's page, opened the way the phone opens it.
    const u = new URL(S.cloudflareUrl('cf-id', `${FLEET}/oauth/cloudflare/callback`, 's.state', 'challenge', 'a.read offline_access'));
    assert.equal(u.origin + u.pathname, 'https://dash.cloudflare.com/oauth2/auth');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('scope'), 'a.read offline_access');
    assert.equal(u.searchParams.get('response_type'), 'code');
  } finally {
    m.restore();
  }
});

test('the page offers a Cloudflare sign-in only where the minter can keep one', async () => {
  const m = await signingMinter();
  try {
    const cfg = async (/** @type {Record<string, any>} */ env) => {
      const html = await (await minterWorker.fetch(new Request(`https://${SIGN}/`), env)).text();
      return JSON.parse(html.split('<script type="application/json" id="cfg">')[1].split('</script>')[0]);
    };
    assert.deepEqual((await cfg(m.env)).cloudflare, { clientId: 'cf-id', scopes: 'account-settings.read offline_access' });
    for (const missing of ['FLEETWRIGHT_CLOUDFLARE_CLIENT_SECRET', 'FLEETWRIGHT_CLOUDFLARE_SCOPES']) {
      assert.equal((await cfg({ ...m.env, [missing]: '' })).cloudflare, null, `without ${missing}`);
    }
    assert.equal((await cfg(m.env)).secret, undefined);
    assert.equal(JSON.stringify(await cfg(m.env)).includes('cf-secret'), false, 'the secret is looked at, never sent');
    // Both providers come back to a page of the signing host's.
    assert.equal((await minterWorker.fetch(new Request(`https://${SIGN}/oauth/cloudflare/callback?code=x&state=y`), m.env)).status, 200);
  } finally {
    m.restore();
  }
});

test('the coordinator sends a signing page\u2019s GitHub sign-in back to the configured signing page and nowhere else', () => {
  const state = `s.${'a'.repeat(32)}`;
  const core = new CoordinatorCore({ githubApp: { clientId: 'Iv23liTEST', clientSecret: 'gh-secret' }, signingOrigin: `https://${SIGN}` });
  const r = core.githubCallback({ code: 'browsercode1', state });
  assert.equal(r.ok, true);
  assert.equal(r.device, `https://${SIGN}/oauth/github/callback?code=browsercode1&state=${state}`);
  assert.ok(callbackPage(r).includes(`location.replace("https://${SIGN}/oauth/github/callback?code=browsercode1`), 'the page goes there');
  assert.equal(core.githubCallback({ code: 'browsercode1', state: 's.short' }).ok, false);
  // No signing page configured, or one that is not https: nowhere to send it.
  for (const signingOrigin of [null, 'http://sign.fleet.test']) {
    const none = new CoordinatorCore({ githubApp: { clientId: 'Iv23liTEST', clientSecret: 'gh-secret' }, signingOrigin });
    assert.equal(none.githubCallback({ code: 'browsercode1', state }).ok, false);
  }
});

test('a Cloudflare sign-in the signing page started goes back to it too, for the vault to keep', () => {
  const state = `s.${'b'.repeat(32)}`;
  const cloudflareOauth = { clientId: 'cf-id', clientSecret: 'cf-secret', scopes: 'account-settings.read offline_access' };
  const core = new CoordinatorCore({ cloudflareOauth, signingOrigin: `https://${SIGN}` });
  const r = core.cloudflareCallback({ code: 'cfcode1234', state });
  assert.equal(r.ok, true);
  assert.equal(r.device, `https://${SIGN}/oauth/cloudflare/callback?code=cfcode1234&state=${state}`);
  // Not the box flow's finishing page, which would hand the code to a
  // machine: the signing page holds the verifier, and the minter exchanges.
  assert.equal(r.finish, undefined);
  assert.equal(new CoordinatorCore({ cloudflareOauth, signingOrigin: null }).cloudflareCallback({ code: 'cfcode1234', state }).ok, false);
});

/** The first value `get` gives that is not undefined, within ten seconds. @template T @param {() => T|undefined} get @returns {Promise<T>} */
async function until(get) {
  for (let i = 0; i < 200; i++) {
    const v = get();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('it never came');
}

/** A browser to run the pages in, or null. */
async function browser() {
  const { chromium } = await import('playwright');
  for (const options of [{}, { executablePath: '/opt/pw-browsers/chromium' }]) {
    if (options.executablePath && !existsSync(options.executablePath)) continue;
    try {
      return await chromium.launch(options);
    } catch { /* the next */ }
  }
  return null;
}

test('in a browser: /me opens the vault’s signing page, which lists its key through it, and carries nothing else', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (!b) return t.skip('no browser to run the pages in');
  const m = await signingMinter();
  const core = new CoordinatorCore({ githubApp: { clientId: 'Iv23liTEST', clientSecret: 'gh-secret' }, signingOrigin: `https://${SIGN}` });
  /** Every API request /me made, as `METHOD /path`. @type {string[]} */
  const asked = [];
  try {
    const context = await b.newContext();
    await context.addInitScript(({ email }) => {
      if (location.origin === 'https://fleet.test') {
        localStorage.setItem('fleetwright.credential', 'fw_test_credential');
        localStorage.setItem('fleetwright.device', 'a browser');
        if (!localStorage.getItem('fleetwright.email')) localStorage.setItem('fleetwright.email', email);
      }
    }, { email: ELI });

    // The minter answers the signing host, through its real fetch handler.
    await context.route(`https://${SIGN}/**`, async (route) => {
      const req = route.request();
      const res = await minterWorker.fetch(new Request(req.url(), { method: req.method() }), m.env);
      await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    });
    // GitHub's page: it remembers the challenge and sends the code back to
    // the redirect it was given.
    await context.route('https://github.com/login/oauth/authorize**', async (route) => {
      const u = new URL(route.request().url());
      assert.equal(u.searchParams.get('redirect_uri'), `${FLEET}/oauth/github/callback`);
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      m.github.challenge = String(u.searchParams.get('code_challenge'));
      await route.fulfill({ status: 302, headers: { location: `${FLEET}/oauth/github/callback?code=browsercode1&state=${u.searchParams.get('state')}` } });
    });
    // The coordinator: its real callback and /me, its API stood in.
    // An assertion that fails in here fails the test, rather than leaving the
    // page waiting on a request nobody answers.
    /** @type {Error|null} */
    let failed = null;
    await context.route(`${FLEET}/**`, (route) => coordinator(route).catch((e) => { failed = e; return route.abort(); }));
    /** @param {import('playwright').Route} route */
    async function coordinator(route) {
      const req = route.request();
      const u = new URL(req.url());
      if (u.pathname === '/oauth/github/callback') {
        const r = core.githubCallback({ code: u.searchParams.get('code'), state: u.searchParams.get('state') });
        return route.fulfill({ status: r.ok ? 200 : 400, contentType: 'text/html', body: callbackPage(r) });
      }
      if (u.pathname === '/me') {
        const page = /** @type {any} */ (memberRoutes({ method: 'GET', path: '/me' }, { fleet: 'Test fleet', signIn: { google: null, apple: null }, signer: `https://${SIGN}` }));
        return route.fulfill({ status: 200, contentType: page.contentType, body: page.body });
      }
      if (u.pathname.startsWith('/me/')) return route.fulfill({ status: 404, body: '' });
      asked.push(`${req.method()} ${u.pathname}`);
      const body = JSON.parse(req.postData() || '{}');
      assert.equal(req.headers().authorization, 'Bearer fw_test_credential');
      if (u.pathname === '/api/github/device') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(await m.post('/github/token', { sealed: body.sealed, boxCodes: [] })) });
      if (u.pathname === '/api/vault') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(await m.post('/vault/device', { sealed: body.sealed, email: ELI })) });
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' });
    }

    const me = await context.newPage();
    await me.goto(`${FLEET}/me`);
    // NOTHING IS READ OR LINKED FROM HERE: the vault is the signing page's.
    await me.waitForSelector('#in:not([hidden])');
    assert.equal(await me.$('#providers'), null);
    assert.match(String(await me.textContent('#signing-state')), /kept in your vault/);

    // OPEN, AND LIST: the signing page shows the address, and GitHub's
    // window opens from its button.
    const [signer] = await Promise.all([me.waitForEvent('popup'), me.click('#signing-open')]);
    await signer.waitForSelector('#setup:not([hidden])');
    assert.equal(await signer.textContent('#setup-who'), ELI);
    await signer.waitForSelector('#list:not([disabled])');
    await signer.click('#list');
    await signer.waitForSelector('#listed:not([hidden])', { timeout: 30_000 });
    assert.equal(m.github.exchanged, 1, 'GitHub exchanged the code once, with the page’s verifier');
    assert.equal((m.directory().get(ELI) ?? []).length, 1);
    await me.waitForFunction(() => /Open on the signing page/.test(document.getElementById('signing-state')?.textContent || ''));

    // WHAT /me CARRIES FOR IT, and nothing past that: an intent it would
    // carry only for the one verb that makes a Claude sign-in, and a route
    // off its list not at all. Asked as the signing page would ask.
    /** @param {any} relay */
    const carry = (relay) => signer.evaluate((r) => new Promise((resolve) => {
      window.addEventListener('message', function on(e) {
        if (e.data?.type !== 'relayed' || e.data.id !== r.id) return;
        window.removeEventListener('message', on);
        resolve(e.data.body);
      });
      window.opener.postMessage({ type: 'relay', ...r }, 'https://fleet.test');
    }), relay);
    const before = asked.length;
    assert.match(String((await carry({ id: 'start-1', method: 'POST', path: '/api/intent', body: { verb: 'start', params: {} } }))?.text), /only what the signing page needs/);
    assert.match(String((await carry({ id: 'admin-1', method: 'GET', path: '/api/admin/clients' }))?.text), /only what the signing page needs/);
    assert.equal(asked.length, before, 'neither reached the coordinator');
    await carry({ id: 'hosts-1', method: 'GET', path: '/api/hosts/enrolled' });
    assert.equal(asked.at(-1), 'GET /api/hosts/enrolled', 'a listed route did');
    assert.ok(!asked.some((a) => a === 'POST /api/intent'), '/me sent no intent of its own');
    await context.close();
    if (failed) throw failed;
  } finally {
    m.restore();
    await b.close();
  }
});

test('in a browser: the signing page lists its key, opens the vault, and keeps every credential there through /me', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (!b) return t.skip('no browser to run the pages in');
  const m = await signingMinter();
  const core = new CoordinatorCore({
    githubApp: { clientId: 'Iv23liTEST', clientSecret: 'gh-secret' },
    cloudflareOauth: { clientId: 'cf-id', clientSecret: 'cf-secret', scopes: 'account-settings.read offline_access' },
    signingOrigin: `https://${SIGN}`,
  });
  // A machine of the fleet's, with a key of its own, as /api/hosts/enrolled lists it.
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const boxJwk = { kty: 'EC', crv: 'P-256', x: String(exported.x), y: String(exported.y) };
  const boxHash = await boxKeyHash(boxJwk);
  /** Every request /me carried, in order. @type {Array<{ path: string, body: any }>} */
  const carried = [];
  const SECRET = 'npm_secret_value_1234';
  const CODE = 'claude-code-from-the-page-5678';
  try {
    const context = await b.newContext();
    await context.addInitScript(({ email }) => {
      if (location.origin === 'https://fleet.test') {
        localStorage.setItem('fleetwright.credential', 'fw_test_credential');
        localStorage.setItem('fleetwright.device', 'a browser');
        if (!localStorage.getItem('fleetwright.email')) localStorage.setItem('fleetwright.email', email);
      }
    }, { email: ELI });

    // The minter answers the signing host, through its real fetch handler.
    await context.route(`https://${SIGN}/**`, async (route) => {
      const req = route.request();
      const res = await minterWorker.fetch(new Request(req.url(), { method: req.method() }), m.env);
      await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    });
    // Each provider's page: it remembers the challenge and sends a code back
    // to the redirect it was given.
    await context.route('https://github.com/login/oauth/authorize**', async (route) => {
      const u = new URL(route.request().url());
      assert.equal(u.searchParams.get('redirect_uri'), `${FLEET}/oauth/github/callback`);
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      m.github.challenge = String(u.searchParams.get('code_challenge'));
      await route.fulfill({ status: 302, headers: { location: `${FLEET}/oauth/github/callback?code=browsercode1&state=${u.searchParams.get('state')}` } });
    });
    await context.route('https://dash.cloudflare.com/oauth2/auth**', async (route) => {
      const u = new URL(route.request().url());
      assert.equal(u.searchParams.get('redirect_uri'), `${FLEET}/oauth/cloudflare/callback`);
      assert.equal(u.searchParams.get('client_id'), 'cf-id');
      m.cloudflare.challenge = String(u.searchParams.get('code_challenge'));
      await route.fulfill({ status: 302, headers: { location: `${FLEET}/oauth/cloudflare/callback?code=cfcode1234&state=${u.searchParams.get('state')}` } });
    });
    await context.route('https://claude.ai/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Claude sign-in</p>' }));

    // The coordinator: its real callbacks and /me, its API stood in.
    /** @type {Error|null} */
    let failed = null;
    await context.route(`${FLEET}/**`, (route) => coordinator(route).catch((e) => { failed = e; return route.abort(); }));
    /** @param {import('playwright').Route} route */
    async function coordinator(route) {
      const req = route.request();
      const u = new URL(req.url());
      if (u.pathname === '/oauth/github/callback' || u.pathname === '/oauth/cloudflare/callback') {
        const q = { code: u.searchParams.get('code'), state: u.searchParams.get('state') };
        const r = u.pathname.includes('cloudflare') ? { ...core.cloudflareCallback(q), provider: 'cloudflare' } : core.githubCallback(q);
        return route.fulfill({ status: r.ok ? 200 : 400, contentType: 'text/html', body: callbackPage(r) });
      }
      if (u.pathname === '/me') {
        const page = /** @type {any} */ (memberRoutes({ method: 'GET', path: '/me' }, { fleet: 'Test fleet', signIn: { google: null, apple: null }, signer: `https://${SIGN}` }));
        return route.fulfill({ status: 200, contentType: page.contentType, body: page.body });
      }
      if (u.pathname.startsWith('/me/')) return route.fulfill({ status: 404, body: '' });
      const body = JSON.parse(req.postData() || '{}');
      carried.push({ path: `${req.method()} ${u.pathname}`, body });
      assert.equal(req.headers().authorization, 'Bearer fw_test_credential');
      const reply = (/** @type {any} */ v) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(v) });
      if (u.pathname === '/api/github/device') return reply(await m.post('/github/token', { sealed: body.sealed, boxCodes: [] }));
      if (u.pathname === '/api/vault') return reply(await m.post('/vault/device', { sealed: body.sealed, email: ELI }));
      if (u.pathname === '/api/hosts/enrolled') {
        return reply({ ok: true, hosts: [{ hostId: 'box1', fingerprint: boxHash.slice(0, 16), publicJwk: boxJwk, revokedAt: null }, { hostId: 'gha-runner-1', publicJwk: boxJwk, ephemeral: true }] });
      }
      if (u.pathname === '/api/intent') {
        // THE MACHINE: it takes only what this person's listed key signed,
        // for it, and seals the sign-in it made to the key it was handed.
        assert.equal(body.verb, 'setuptoken');
        const verdict = (await checkIntentSignature({ intent: { verb: body.verb, params: body.params, actor: ELI, id: body.id, issuedAt: body.issuedAt }, sig: body.sig, kid: body.kid, host: body.host, directory: m.directory() })).verdict;
        assert.equal(verdict, 'signed', 'the machine takes what the signing page signed');
        if (!body.params.code) return reply({ ok: true, text: 'Open the sign-in page.', url: 'https://claude.ai/oauth/authorize?code=true&x=1' });
        assert.equal(body.params.code, CODE);
        const signIn = {
          oauth: { accessToken: `sk-ant-oat01-${'a'.repeat(40)}`, refreshToken: `sk-ant-ort01-${'r'.repeat(40)}`, expiresAt: Date.now() + 8 * 3_600_000, scopes: ['user:inference', 'user:profile'] },
          account: { emailAddress: ELI },
        };
        return reply({ ok: true, text: 'Signed in to Claude on box1.', sealed: await seal({ to: body.params.reply, aad: SETUP_TOKEN_AAD, payload: { v: 1, signIn } }) });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' });
    }

    const me = await context.newPage();
    await me.goto(`${FLEET}/me`);
    const [signer] = await Promise.all([me.waitForEvent('popup'), me.click('#signing-open')]);
    /** @param {string} title */
    const rowOf = (title) => `#items .item:has(h3:text-is("${title}"))`;
    /** Wait until a row says this. @param {string} title @param {RegExp} said */
    const rowSays = (title, said) => signer.waitForFunction(([t, src]) => {
      const row = [...document.querySelectorAll('#items .item, #machines .item')].find((r) => r.querySelector('h3')?.textContent === t);
      return Boolean(row && new RegExp(src).test(row.textContent || ''));
    }, [title, said.source], { timeout: 30_000 });

    // LIST, AND THE VAULT OPENS WITH THE SAME SIGN-IN: one GitHub window.
    await signer.waitForSelector('#list:not([disabled])');
    await signer.click('#list');
    await signer.waitForSelector('#vault-body:not([hidden])', { timeout: 30_000 });
    assert.equal(m.github.exchanged, 1);
    assert.equal((m.directory().get(ELI) ?? []).length, 1);
    // No Claude sign-in kept: the card that asks, and what it asks.
    assert.match(String(await signer.getAttribute('#vault', 'class')), /asking/);
    await rowSays('Claude', /Not kept\. A session you start is refused until it is\./);
    // The machine, with the fingerprint worked out here; a runner is not offered.
    await rowSays('box1', new RegExp(`Not approved\\. Fingerprint ${boxHash.slice(0, 4)} ${boxHash.slice(4, 8)}`));
    assert.equal(await signer.$('#machines .item:has(h3:text-is("gha-runner-1"))'), null);

    // APPROVE THE MACHINE: a grant filed under its key's whole hash.
    await signer.click('#machines .item:has(h3:text-is("box1")) button:text-is("Approve")');
    await rowSays('box1', /Approved to hold your credentials/);
    assert.ok(m.rows.get('v:42')?.grants?.[boxHash]?.jwk, 'the minter holds the grant');

    // A NAMED SECRET, typed here, and sealed before /me carries it.
    await signer.click(`${rowOf('A named secret')} button:text-is("Keep one")`);
    await signer.fill(`${rowOf('A named secret')} input[type=text]`, 'NPM_TOKEN');
    await signer.fill(`${rowOf('A named secret')} input[type=password]`, SECRET);
    await signer.click(`${rowOf('A named secret')} button:text-is("Keep it")`);
    await rowSays('NPM_TOKEN', /Kept/);

    // A CLAUDE SIGN-IN, made on the machine, both halves signed for it, kept
    // as a whole sign-in.
    await signer.click(`${rowOf('Claude')} button:text-is("Sign in on a machine")`);
    await signer.click(`${rowOf('Claude')} button.chip:text-is("box1")`);
    await signer.waitForSelector(`${rowOf('Claude')} a.btn[href^="https://claude.ai/"]`);
    await signer.fill(`${rowOf('Claude')} input[type=password]`, CODE);
    await signer.click(`${rowOf('Claude')} button:text-is("Keep it")`);
    await rowSays('Claude', /Kept: a whole sign-in, which Remote Control needs\./);
    assert.doesNotMatch(String(await signer.getAttribute('#vault', 'class')), /asking/);
    assert.equal(m.rows.get('gh:42')?.kind, 'login');
    const intents = carried.filter((c) => c.path === 'POST /api/intent');
    assert.equal(intents.length, 2);
    assert.ok(intents.every((c) => c.body.host === 'box1'), 'both halves went to the one machine');

    // GITHUB AND CLOUDFLARE, each a sign-in the page started with a verifier
    // of its own, finished by the minter; then GitHub tested.
    await signer.click(`${rowOf('GitHub')} button:text-is("Sign in with GitHub")`);
    await rowSays('GitHub', /Kept, for the machines you approve/);
    assert.equal(m.github.exchanged, 2, 'listing, then the vault’s own');
    await signer.click(`${rowOf('GitHub')} button:text-is("Test")`);
    await rowSays('GitHub', /GitHub works: it answered as eli/);
    await signer.click(`${rowOf('Cloudflare')} button:text-is("Sign in with Cloudflare")`);
    await rowSays('Cloudflare', /Kept, for the machines you approve/);
    assert.equal(m.cloudflare.exchanged, 1);

    // FORGET ASKS ONCE MORE, then the secret is gone.
    await signer.click(`${rowOf('NPM_TOKEN')} button:text-is("Forget")`);
    await signer.click(`${rowOf('NPM_TOKEN')} button:text-is("Forget it")`);
    await signer.waitForFunction(() => ![...document.querySelectorAll('#items h3')].some((h) => h.textContent === 'NPM_TOKEN'));

    // WHAT /me CARRIED, which is all a coordinator saw: no secret, no code,
    // no token, and nothing but the four things it carries.
    const wire = JSON.stringify(carried);
    for (const plain of [SECRET, 'ghu_browser', 'cf_access', 'sk-ant-oat01']) assert.equal(wire.includes(plain), false, `${plain} crossed /me in the clear`);
    assert.deepEqual([...new Set(carried.map((c) => c.path))].sort(), ['GET /api/hosts/enrolled', 'POST /api/github/device', 'POST /api/intent', 'POST /api/vault']);
    // The code a machine types is the one thing an intent carries, as a phone's does.
    assert.equal(intents[1].body.params.code, CODE);
    await context.close();
    if (failed) throw failed;
  } finally {
    m.restore();
    await b.close();
  }
});
