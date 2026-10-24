// The browser's signing page (src/fleet/minter/sign-page.js): served only on
// the minter's own hostname, its script agreeing byte for byte with the
// fleet's own signing and sealing, and the whole of listing a key and signing
// with it run in a real browser against the real minter, coordinator callback
// and `/me`.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync } from 'node:fs';

import minterWorker, { ClaudeLogins, KEY_PATH } from '../worker/src/minter.js';
import { newDepositKey, newSealKey, seal, open, importDepositKey, GITHUB_REQUEST_AAD, GITHUB_REPLY_AAD, VAULT_REQUEST_AAD, VAULT_REPLY_AAD } from '../src/fleet/seal.js';
import { signingInput, toB64Url } from '../src/fleet/crypto.js';
import { intentSigningInput, delegationSigningInput, keyId, checkIntentSignature, checkDelegation } from '../src/fleet/protocol/intent-signature.js';
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
  };
  const storage = { get: async (/** @type {string} */ k) => rows.get(k), put: async (/** @type {string} */ k, /** @type {any} */ v) => { rows.set(k, structuredClone(v)); } };
  const instance = new ClaudeLogins({ storage }, env);
  env.LOGINS = { idFromName: () => 'logins', get: () => ({ fetch: (/** @type {string} */ u, /** @type {any} */ i) => instance.fetch(new Request(u, i)) }) };

  /** The challenge GitHub's page was opened with, which the exchange has to answer. */
  const github = { challenge: '', exchanged: 0 };
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
  return { env, deposit, rows, github, post, directory, restore: () => { globalThis.fetch = real; } };
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

test('the page\u2019s script signs and seals exactly as the fleet\u2019s own code checks', async () => {
  const m = await signingMinter();
  try {
    const S = await pageHelpers(m.env);
    for (const payload of [{ b: 1, a: [2, { d: null, c: 'x' }], u: undefined }, { verb: 'link', params: { provider: 'github', secret: 'ghp_\u00e9' } }, {}]) {
      assert.equal(S.signingInput('intent', payload), signingInput('intent', payload));
    }
    for (const [k, v] of Object.entries({ GITHUB_REQUEST_AAD, GITHUB_REPLY_AAD, VAULT_REQUEST_AAD, VAULT_REPLY_AAD })) assert.equal(S[k], v, k);

    // A signature a box takes, from a key a box would list.
    const key = await S.newSigningKey();
    assert.equal(key.kid, await keyId(key.publicJwk));
    const directory = new Map([[ELI, [{ kid: key.kid, key: key.publicJwk }]]]);
    const intent = { verb: 'link', params: { provider: 'github', secret: 'ghp_x', scope: 'me' }, actor: ELI, id: 'intent-0001', issuedAt: Date.now() };
    const sig = await S.sign(key.privateKey, S.intentInput(intent, 'box1', {}));
    assert.equal((await checkIntentSignature({ intent, sig, kid: key.kid, host: 'box1', directory })).verdict, 'signed');
    assert.equal((await checkIntentSignature({ intent, sig, kid: key.kid, host: 'box2', directory })).verdict, 'bad-signature');
    // The parameters the fleet sets are left out, as a box leaves them out.
    const start = { verb: 'start', params: { title: 't', archive: 'fleet-set' }, actor: ELI, id: 'intent-0002', issuedAt: 1 };
    assert.equal(S.intentInput(start, 'box1', { start: ['archive', 'boxSecrets'] }), intentSigningInput(start, 'box1'));

    // A delegation it builds and signs, which a box takes for what it covers.
    const built = S.buildGrant({ grant: { verbs: ['connect'], hosts: ['*'], match: {}, lifetimeMs: 600_000 } }, ELI, Date.now());
    assert.equal(S.delegationInput(built.grant), delegationSigningInput(built.grant));
    const delegation = { grant: built.grant, sig: await S.sign(key.privateKey, S.delegationInput(built.grant)), kid: key.kid };
    const check = (/** @type {any} */ i) => checkDelegation({ intent: i, delegation, host: 'box1', directory, now: Date.now() });
    assert.equal((await check({ verb: 'connect', params: {}, actor: ELI })).verdict, 'delegated');
    assert.equal((await check({ verb: 'link', params: {}, actor: ELI })).verdict, 'not-covered');

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
  } finally {
    m.restore();
  }
});

test('the page signs only changes to its own person\u2019s accounts, and delegates for a day at most', async () => {
  const m = await signingMinter();
  try {
    const S = await pageHelpers(m.env);
    const now = Date.now();
    const ask = (/** @type {any} */ intent) => S.checkSign({ intent: { actor: ELI, id: 'intent-0003', issuedAt: now, params: {}, ...intent }, host: 'box1' }, ELI, now);
    assert.equal(ask({ verb: 'link' }), null);
    assert.match(ask({ verb: 'start' }), /only changes to your accounts, and that was start/);
    assert.match(ask({ verb: 'link', actor: 'mallory@example.com' }), /in the name of mallory@example\.com/);
    assert.match(ask({ verb: 'link', issuedAt: now - 3_600_000 }), /last few minutes/);
    const grant = (/** @type {any} */ g) => S.buildGrant({ grant: { verbs: ['link'], hosts: ['*'], match: {}, lifetimeMs: 600_000, ...g } }, ELI, now);
    assert.equal(grant({}).grant.actor, ELI);
    assert.match(grant({ verbs: ['provision'] }).error, /only changes to your accounts/);
    assert.match(grant({ lifetimeMs: 2 * 24 * 3_600_000 }).error, /between a minute and a day/);
    // What the person reads: a secret by its length.
    assert.deepEqual(JSON.parse(JSON.stringify(S.shown({ secret: 'ghp_abcdef', provider: 'github' }))), [['provider', 'github'], ['secret', 'hidden, 10 characters']]);
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
