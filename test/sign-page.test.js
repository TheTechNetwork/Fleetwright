// The browser's signing page (src/fleet/minter/sign-page.js): served only on
// the minter's own hostname, its script agreeing byte for byte with the
// fleet's own signing and sealing, and the whole of listing a key and using
// the vault with it run in a real browser against the real minter, the
// coordinator's callbacks and `/me`: a person's own vault, and a member's
// opened by whoever may act for it (docs/members.md).

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync } from 'node:fs';

import minterWorker, { ClaudeLogins, KEY_PATH } from '../worker/src/minter.js';
import { newDepositKey, newSealKey, seal, open, importDepositKey, GITHUB_REQUEST_AAD, GITHUB_REPLY_AAD, VAULT_REQUEST_AAD, VAULT_REPLY_AAD, SETUP_TOKEN_AAD } from '../src/fleet/seal.js';
import { signingInput, toB64Url } from '../src/fleet/crypto.js';
import { intentSigningInput, keyId, checkIntentSignature } from '../src/fleet/protocol/intent-signature.js';
import { boxKeyHash } from '../src/fleet/minter/vault.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { callbackPage, SIGNER_STATE_RE } from '../src/fleet/coordinator/oauth.js';
import { memberRoutes } from '../src/fleet/coordinator/member-page.js';

const ELI = 'eli@example.com';
const DANA = 'dana@example.com';
/**
 * Who signs in with each code GitHub's page hands back, and whose each token
 * then is: Eli, as every test here has him, and Dana, who reports to him.
 * @type {Record<string, { email: string, token: string, id: number, login: string }>}
 */
const GITHUB_PEOPLE = {
  browsercode1: { email: ELI, token: 'ghu_browser', id: 42, login: 'eli' },
  danacode1234: { email: DANA, token: 'ghu_dana', id: 43, login: 'dana' },
};
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
  const storage = {
    get: async (/** @type {string} */ k) => structuredClone(rows.get(k)),
    put: async (/** @type {string} */ k, /** @type {any} */ v) => { rows.set(k, structuredClone(v)); },
    // As a Durable Object's storage lists, in key order: the organization's tree is a row a member.
    list: async (/** @type {{ prefix: string }} */ o) => new Map([...rows.entries()].filter(([k]) => k.startsWith(o.prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  const instance = new ClaudeLogins({ storage }, env);
  env.LOGINS = { idFromName: () => 'logins', get: () => ({ fetch: (/** @type {string} */ u, /** @type {any} */ i) => instance.fetch(new Request(u, i)) }) };

  /** The challenge each provider's page was opened with, which its exchange has to answer. */
  const github = { challenge: '', exchanged: 0 };
  const cloudflare = { challenge: '', exchanged: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    const u = String(url);
    if (u === 'https://api.github.com/user') {
      const who = Object.values(GITHUB_PEOPLE).find((p) => String(init.headers?.authorization) === `Bearer ${p.token}`);
      return who ? json(200, { id: who.id, login: who.login }) : json(401, {});
    }
    if (u === 'https://github.com/login/oauth/access_token') {
      const f = Object.fromEntries(new URLSearchParams(String(init.body)).entries());
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(f.code_verifier || '')));
      const who = GITHUB_PEOPLE[f.code];
      const ok = f.client_secret === 'gh-secret' && who && github.challenge && toB64Url(digest) === github.challenge &&
        f.redirect_uri === `${FLEET}/oauth/github/callback`;
      if (ok) github.exchanged += 1;
      return ok ? json(200, { access_token: who.token, expires_in: 28800 }) : json(200, { error: 'bad_verification_code' });
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
  /**
   * A GitHub sign-in finished through the minter as a phone finishes one,
   * which is what makes the token a device's here. @param {string} code
   */
  const signIn = async (code) => {
    const verifier = 'p'.repeat(64);
    github.challenge = toB64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const reply = await newSealKey();
    const sealed = await seal({ to: deposit.publicKey, aad: GITHUB_REQUEST_AAD, payload: { v: 1, grant: 'code', code, verifier, redirectUri: `${FLEET}/oauth/github/callback`, at: Date.now(), reply: reply.publicKey } });
    const r = await post('/github/token', { sealed, boxCodes: [] });
    assert.equal(r.ok, true, r.text);
  };
  /** Request times in order: the tree refuses a change not newer than the one it holds. */
  let clock = 0;
  /**
   * A vault request as that person's phone seals it, with their own GitHub
   * sign-in inside. `beside` is what the coordinator says next to the seal
   * (`admin`, for the first org admin). Each person signed in first, here or
   * on the page.
   * @param {string} person @param {Record<string, unknown>} body @param {Record<string, unknown>} [beside]
   */
  const phone = async (person, body, beside = {}) => {
    const github = Object.values(GITHUB_PEOPLE).find((p) => p.email === person)?.token;
    const reply = await newSealKey();
    clock = Math.max(clock + 1, Date.now());
    const sealed = await seal({ to: deposit.publicKey, aad: VAULT_REQUEST_AAD, payload: { v: 1, github, email: person, at: clock, reply: reply.publicKey, ...body } });
    const r = await post('/vault/device', { sealed, email: person, ...beside });
    if (r.ok) r.answer = await open({ privateKey: reply.privateKey, publicKey: reply.publicKey, aad: VAULT_REPLY_AAD, sealed: r.sealed });
    return r;
  };
  /**
   * The organization, filed with the vault as Eli files it from a phone
   * (docs/members.md): Eli its first admin, Dana under him, and the agent
   * Debbie under Dana. Both people have listed a signing key by then.
   */
  const fileTree = async () => {
    const admin = await phone(ELI, { op: 'orgadmin', address: ELI }, { admin: true });
    assert.equal(admin.ok, true, admin.text);
    for (const member of [{ id: 'eli', kind: 'person', address: ELI }, { id: 'dana', kind: 'person', address: DANA, reportsTo: 'eli' }, { id: 'debbie', kind: 'agent', reportsTo: 'dana' }]) {
      const filed = await phone(ELI, { op: 'orgmember', ...member });
      assert.equal(filed.ok, true, filed.text);
    }
  };
  return { env, deposit, rows, github, cloudflare, post, directory, signIn, phone, fileTree, restore: () => { globalThis.fetch = real; } };
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

test('the page aims each request at the vault it is showing, and words a team and a manager’s changes from what the vault itself answers', async () => {
  const m = await signingMinter();
  try {
    const S = await pageHelpers(m.env);
    // WHAT A VAULT KEEPS follows the view, and what is a person's alone never
    // does: the minter refuses a custodian's `custody` or `devicekey`, so a
    // page that sent the member with one would turn a person's own switch
    // into a refusal.
    for (const op of ['list', 'put', 'forget', 'test', 'connect', 'grant', 'revoke']) assert.equal(S.vaultFor(op, {}, 'debbie'), 'debbie', op);
    for (const op of ['custody', 'devicekey', 'revokedelegation', 'org', 'orgadmin', 'orgmember', 'custodian']) assert.equal(S.vaultFor(op, {}, 'debbie'), null, op);
    assert.equal(S.vaultFor('list', {}, null), null, 'nobody’s but the person’s own');
    // A sign-in that took minutes is kept where it was started: the vault it
    // names wins over whatever is showing by then, its owner's own included.
    assert.equal(S.vaultFor('put', { name: 'claude', for: null }, 'debbie'), null);
    assert.equal(S.vaultFor('put', { name: 'claude', for: 'debbie' }, null), 'debbie');

    // THE REAL VAULT'S ANSWERS, worded by the page. Eli and Dana each signed
    // in and listed a key, as a phone does.
    for (const [code, person] of /** @type {Array<[string, string]>} */ ([['browsercode1', ELI], ['danacode1234', DANA]])) {
      await m.signIn(code);
      const listed = await m.phone(person, { op: 'devicekey', key: (await S.newSigningKey()).publicJwk, label: 'a phone' });
      assert.equal(listed.ok, true, listed.text);
    }
    await m.fileTree();
    const team = async (/** @type {string} */ person) => S.team((await m.phone(person, { op: 'org' })).answer, person).map((/** @type {any} */ x) => x.id).sort();
    // Eli filed Debbie and manages her through Dana. Dana's own vault is not
    // his until she says so, and nobody's own member is on their own team.
    assert.deepEqual(await team(ELI), ['debbie']);
    assert.deepEqual(await team(DANA), ['debbie']);
    assert.equal((await m.phone(DANA, { op: 'custody', allow: true })).ok, true);
    assert.deepEqual(await team(ELI), ['dana', 'debbie']);

    // Everything the vault writes down when a manager changes a person's
    // vault, read back by that person and said in the page's words.
    const box = (await S.newSigningKey()).publicJwk;
    for (const body of [
      { op: 'put', name: 'secret:NPM_TOKEN', value: 'x' },
      { op: 'grant', hostKey: box, label: 'box1' },
      { op: 'forget', name: 'secret:NPM_TOKEN' },
      { op: 'revoke', key: await boxKeyHash(box) },
    ]) {
      const done = await m.phone(ELI, { ...body, for: 'dana' });
      assert.equal(done.ok, true, done.text);
    }
    const log = (await m.phone(DANA, { op: 'list' })).answer.custody.log;
    assert.deepEqual(log.map((/** @type {any} */ e) => S.custodyLine(e)), [
      `${ELI} kept NPM_TOKEN`,
      `${ELI} approved a machine`,
      `${ELI} removed NPM_TOKEN`,
      `${ELI} removed a machine`,
    ]);
  } finally {
    m.restore();
  }
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

test('in a browser: a custodian opens a member’s vault from My team and keeps things there and not in their own, and a person lets their manager in and reads what was changed', { timeout: 240_000 }, async (t) => {
  const b = await browser();
  if (!b) return t.skip('no browser to run the pages in');
  const m = await signingMinter();
  const core = new CoordinatorCore({ githubApp: { clientId: 'Iv23liTEST', clientSecret: 'gh-secret' }, signingOrigin: `https://${SIGN}` });
  // A machine of the fleet's, as /api/hosts/enrolled lists it.
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const boxJwk = { kty: 'EC', crv: 'P-256', x: String(exported.x), y: String(exported.y) };
  const boxHash = await boxKeyHash(boxJwk);
  const SECRETS = { MINE: 'elis-own-secret-2222', DANAS_OWN: 'danas-own-secret-3333', DEPLOY_KEY: 'debbie-deploy-secret-4444', FOR_DANA: 'kept-for-dana-secret-5555' };
  const CODE = 'claude-code-for-debbie-6789';
  /** Something to do the moment the vault next tells Eli's page the organization, before the page hears it. @type {null | (() => Promise<void>)} */
  let afterOrg = null;
  /** @type {Error|null} */
  let failed = null;
  try {
    /**
     * One person's browser: `/me` signed in as them, the signing page it
     * opens at a phone's width, and everything `/me` carried for it.
     * @param {string} email
     */
    const signedIn = async (email) => {
      const code = String(Object.keys(GITHUB_PEOPLE).find((c) => GITHUB_PEOPLE[c].email === email));
      /** @type {Array<{ path: string, body: any }>} */
      const carried = [];
      const context = await b.newContext();
      await context.addInitScript(({ address }) => {
        if (location.origin === 'https://fleet.test') {
          localStorage.setItem('fleetwright.credential', 'fw_test_credential');
          localStorage.setItem('fleetwright.device', 'a browser');
          if (!localStorage.getItem('fleetwright.email')) localStorage.setItem('fleetwright.email', address);
        }
      }, { address: email });
      await context.route(`https://${SIGN}/**`, async (route) => {
        const req = route.request();
        const res = await minterWorker.fetch(new Request(req.url(), { method: req.method() }), m.env);
        await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
      });
      await context.route('https://github.com/login/oauth/authorize**', async (route) => {
        const u = new URL(route.request().url());
        m.github.challenge = String(u.searchParams.get('code_challenge'));
        await route.fulfill({ status: 302, headers: { location: `${FLEET}/oauth/github/callback?code=${code}&state=${u.searchParams.get('state')}` } });
      });
      await context.route('https://claude.ai/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Claude sign-in</p>' }));
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
        const body = JSON.parse(req.postData() || '{}');
        carried.push({ path: `${req.method()} ${u.pathname}`, body });
        assert.equal(req.headers().authorization, 'Bearer fw_test_credential');
        const reply = (/** @type {any} */ v) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(v) });
        if (u.pathname === '/api/github/device') return reply(await m.post('/github/token', { sealed: body.sealed, boxCodes: [] }));
        if (u.pathname === '/api/vault') {
          // The coordinator says who sent it, and nothing about whose vault it is for: that is inside the seal.
          const r = await m.post('/vault/device', { sealed: body.sealed, email });
          if (email === ELI && afterOrg && r.ok && r.text === 'The organization, as the vault holds it.') {
            const then = afterOrg;
            afterOrg = null;
            await then();
          }
          return reply(r);
        }
        if (u.pathname === '/api/hosts/enrolled') return reply({ ok: true, hosts: [{ hostId: 'box1', fingerprint: boxHash.slice(0, 16), publicJwk: boxJwk, revokedAt: null }] });
        // THE FLEET'S OWN LIST, which the page takes names from, and each member's
        // engines only to choose which sign-in rows to offer.
        if (u.pathname === '/api/members') {
          return reply({ ok: true, members: [{ id: 'eli', name: 'Eli', kind: 'person' }, { id: 'dana', name: 'Dana', kind: 'person' }, { id: 'debbie', name: 'Debbie', kind: 'agent' }], you: { admin: email === ELI } });
        }
        if (u.pathname === '/api/intent') {
          // THE MACHINE: it takes what the custodian's own listed key signed, and seals the sign-in to the key it was handed.
          assert.equal(body.verb, 'setuptoken');
          const verdict = (await checkIntentSignature({ intent: { verb: body.verb, params: body.params, actor: email, id: body.id, issuedAt: body.issuedAt }, sig: body.sig, kid: body.kid, host: body.host, directory: m.directory() })).verdict;
          assert.equal(verdict, 'signed', 'the machine takes what the signing page signed');
          if (!body.params.code) return reply({ ok: true, text: 'Open the sign-in page.', url: 'https://claude.ai/oauth/authorize?code=true&x=1' });
          const signIn = {
            oauth: { accessToken: `sk-ant-oat01-${'b'.repeat(40)}`, refreshToken: `sk-ant-ort01-${'s'.repeat(40)}`, expiresAt: Date.now() + 8 * 3_600_000, scopes: ['user:inference', 'user:profile'] },
            account: { emailAddress: 'debbie@example.com' },
          };
          return reply({ ok: true, text: 'Signed in to Claude on box1.', sealed: await seal({ to: body.params.reply, aad: SETUP_TOKEN_AAD, payload: { v: 1, signIn } }) });
        }
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' });
      }

      const me = await context.newPage();
      await me.goto(`${FLEET}/me`);
      const [signer] = await Promise.all([me.waitForEvent('popup'), me.click('#signing-open')]);
      await signer.setViewportSize({ width: 390, height: 844 });
      // LIST, which opens the vault with the same sign-in.
      await signer.waitForSelector('#list:not([disabled])');
      await signer.click('#list');
      await says(signer, 'Claude', /Not kept\. A session you start is refused until it is\./);
      return { context, signer, carried };
    };
    /** @param {string} title */
    const rowOf = (title) => `#items .item:has(h3:text-is("${title}"))`;
    /** @param {string} name */
    const teamRow = (name) => `#team .item:has(h3:text-is("${name}"))`;
    /** Wait until a row says this. @param {import('playwright').Page} page @param {string} title @param {RegExp} said */
    const says = (page, title, said) => page.waitForFunction(([t, src]) => {
      const row = [...document.querySelectorAll('#items .item, #machines .item, #team .item')].find((r) => r.querySelector('h3')?.textContent === t);
      return Boolean(row && new RegExp(src).test(row.textContent || ''));
    }, [title, said.source], { timeout: 30_000 });
    /** Wait until the vault shown is this one. @param {import('playwright').Page} page @param {string} title */
    const shows = (page, title) => page.waitForFunction((want) => document.getElementById('vault-title')?.textContent === want, title, { timeout: 30_000 });
    /** A named secret typed on the page, into whichever vault it is showing. @param {import('playwright').Page} page @param {keyof typeof SECRETS} name */
    const keep = async (page, name) => {
      const row = rowOf('A named secret');
      await page.click(`${row} button:text-is("Keep one")`);
      await page.fill(`${row} input[type=text]`, name);
      await page.fill(`${row} input[type=password]`, SECRETS[name]);
      await page.click(`${row} button:text-is("Keep it")`);
      await says(page, name, /Kept/);
    };

    const dana = await signedIn(DANA);
    const eli = await signedIn(ELI);
    assert.equal(m.github.exchanged, 2, 'each of them signed in to GitHub once, with their own page’s verifier');

    // NOBODY HAS FILED AN ORGANIZATION: the page is the page it was, and
    // asks the fleet for no list of members.
    assert.equal(await eli.signer.isHidden('#team-card'), true);
    assert.equal(await dana.signer.$(rowOf('Your managers')), null);
    assert.equal(eli.carried.some((c) => c.path === 'GET /api/members'), false);

    // The tree is filed from a phone, not from here (docs/members.md).
    await m.fileTree();
    assert.equal(await eli.signer.$('button:text-matches("member|admin", "i")'), null, 'the signing page files no tree');

    // DANA'S OWN SWITCH. Her manager is named, with nothing let in and
    // nothing changed, until she says so herself.
    await keep(dana.signer, 'DANAS_OWN');
    await says(dana.signer, 'Your managers', /eli@example\.com cannot manage your credentials\./);
    await says(dana.signer, 'Your managers', /What they changedNothing yet\./);
    const lets = dana.signer.getByLabel('Let my managers manage my credentials');
    assert.equal(await lets.isChecked(), false);
    // From the keyboard, as everything here can be.
    await lets.focus();
    await dana.signer.keyboard.press('Space');
    await says(dana.signer, 'Your managers', /eli@example\.com can manage your credentials\./);
    await says(dana.signer, 'Your managers', /Your managers can now keep, test and remove what your vault holds/);
    assert.equal(m.rows.get('v:43')?.custody?.allow, true);

    // ELI'S TEAM, as the vault lists it, with the fleet's names. Between
    // the vault saying Dana let him in and his page asking after her, she
    // turns it off: her vault refuses, and that is not "Not signed in".
    afterOrg = async () => {
      const off = await m.phone(DANA, { op: 'custody', allow: false });
      assert.equal(off.ok, true, off.text);
    };
    await keep(eli.signer, 'MINE');
    await eli.signer.waitForSelector('#team-card:not([hidden])');
    await says(eli.signer, 'Debbie', /^DebbieAgent \(debbie\)\. Not signed in\./);
    await says(eli.signer, 'Dana', /^DanaPerson \(dana\)\. Not checked\./);
    await says(eli.signer, 'Dana', /dana@example\.com has not let their managers manage their credentials/);
    assert.doesNotMatch(String(await eli.signer.textContent(teamRow('Dana'))), /Not signed in|Signed in to Claude/);
    // And opening it is refused on her row, with Eli's own vault still the one showing.
    await eli.signer.click(`${teamRow('Dana')} button:text-is("Open their credentials")`);
    await says(eli.signer, 'Dana', /Not checked\..*has not let their managers/);
    assert.equal(await eli.signer.textContent('#vault-title'), 'Your vault');
    assert.equal((await m.phone(DANA, { op: 'custody', allow: true })).ok, true);

    // DEBBIE'S VAULT, in the same view: the heading says whose, a keyboard
    // is put on it, and every sentence that said "your" names her.
    await eli.signer.focus(`${teamRow('Debbie')} button:text-is("Open its credentials")`);
    await eli.signer.keyboard.press('Enter');
    await shows(eli.signer, 'Debbie’s vault');
    await says(eli.signer, 'Claude', /Not kept\. A session started as Debbie is refused until it is\./);
    assert.equal(await eli.signer.evaluate(() => document.activeElement?.id), 'vault-title');
    assert.match(String(await eli.signer.textContent('#vault-who')), /Filed with the vault as debbie\. You are managing its credentials as one of its custodians/);
    assert.equal(await eli.signer.isVisible('#vault-back'), true);
    assert.equal(await eli.signer.isHidden('#team-card'), true);
    // "Your vault" is only where the way back to it is.
    assert.doesNotMatch(String(await eli.signer.textContent('#items')) + String(await eli.signer.textContent('#machines-card')), /\byour (vault|credentials)\b/i);

    // A NAMED SECRET lands in the member's row and not the custodian's.
    await keep(eli.signer, 'DEPLOY_KEY');
    await says(eli.signer, 'DEPLOY_KEY', /Kept\. A session started as Debbie on a machine approved for this vault/);
    assert.deepEqual(Object.keys(m.rows.get('v:member:debbie')?.items ?? {}), ['secret:DEPLOY_KEY']);
    assert.deepEqual(Object.keys(m.rows.get('v:42')?.items ?? {}), ['secret:MINE']);

    // A MACHINE is approved for this vault and no other.
    await eli.signer.click('#machines .item:has(h3:text-is("box1")) button:text-is("Approve")');
    await says(eli.signer, 'box1', /Approved to hold Debbie’s credentials/);
    assert.ok(m.rows.get('v:member:debbie')?.grants?.[boxHash]?.jwk, 'the grant is in Debbie’s vault');
    assert.equal(m.rows.get('v:42')?.grants?.[boxHash], undefined, 'and not in Eli’s');

    // A CLAUDE SIGN-IN made on a machine, signed by the custodian's own key,
    // comes back sealed to his page and is kept as Debbie's and not his.
    await eli.signer.click(`${rowOf('Claude')} button:text-is("Sign in on a machine")`);
    await eli.signer.click(`${rowOf('Claude')} button.chip:text-is("box1")`);
    await eli.signer.waitForSelector(`${rowOf('Claude')} a.btn[href^="https://claude.ai/"]`);
    await eli.signer.fill(`${rowOf('Claude')} input[type=password]`, CODE);
    await eli.signer.click(`${rowOf('Claude')} button:text-is("Keep it")`);
    await says(eli.signer, 'Claude', /Kept: a whole sign-in, which Remote Control needs\./);
    assert.equal(m.rows.get('gh:member:debbie')?.kind, 'login');
    assert.equal(m.rows.get('gh:42'), undefined, 'Eli’s own vault holds no Claude sign-in');

    // CUSTODIANS, as the vault lists them: Eli, who filed her, with Remove
    // beside him, and Dana for as long as the tree says so, with none. The
    // last one stays, in the vault's own words; then Dana is added.
    const custodians = rowOf('Custodians');
    await says(eli.signer, 'Custodians', /eli@example\.com \(you\)Remove/);
    await says(eli.signer, 'Custodians', /dana@example\.com, for as long as they manage Debbie(?!Remove)/);
    assert.equal(await eli.signer.locator(`${custodians} button:text-is("Remove")`).count(), 1);
    await eli.signer.click(`${custodians} button:text-is("Remove")`);
    await says(eli.signer, 'Custodians', /eli@example\.com is debbie’s last custodian, and the last one stays\. Add another first\./);
    await eli.signer.getByLabel('Add a custodian by their fleet address').fill(DANA);
    await eli.signer.click(`${custodians} button:text-is("Add custodian")`);
    await says(eli.signer, 'Custodians', /dana@example\.com is now one of debbie’s custodians/);
    await eli.signer.locator(`${custodians} li button:text-is("Remove")`).nth(1).waitFor();
    assert.deepEqual(m.rows.get('orgm:debbie')?.custodians, [ELI, DANA]);

    // AT A PHONE'S WIDTH, with the longest lines the view has: nothing
    // scrolls sideways, and everything pressed is 44px tall.
    const fits = await eli.signer.evaluate(() => ({
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      short: [...document.querySelectorAll('button, a.btn, label.check, input')].filter((e) => e instanceof HTMLElement && e.offsetParent !== null && !(e instanceof HTMLInputElement && e.type === 'checkbox'))
        .filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.textContent || e.getAttribute('aria-label')),
    }));
    assert.deepEqual(fits, { sideways: 0, short: [] });

    // BACK, and the team is asked again, as it is every time it is drawn:
    // Debbie is signed in now, and Dana, who let him in again, answers that
    // she is not.
    await eli.signer.click('#vault-back');
    await shows(eli.signer, 'Your vault');
    await says(eli.signer, 'Debbie', /Agent \(debbie\)\. Signed in to Claude\./);
    await says(eli.signer, 'Dana', /Person \(dana\)\. Not signed in\./);
    assert.match(String(await eli.signer.textContent('#machines .item:has(h3:text-is("box1"))')), /Not approved\./, 'his own vault approved no machine');

    // DANA'S VAULT, now that she let him in: what he keeps there is hers,
    // and a person has no custodians to add.
    await eli.signer.click(`${teamRow('Dana')} button:text-is("Open their credentials")`);
    await shows(eli.signer, 'Dana’s vault');
    await says(eli.signer, 'DANAS_OWN', /Kept/);
    assert.match(String(await eli.signer.textContent('#vault-who')), /as one of their managers, because they allowed it/);
    assert.equal(await eli.signer.$(custodians), null);
    await keep(eli.signer, 'FOR_DANA');
    assert.ok(m.rows.get('v:43')?.items?.['secret:FOR_DANA'], 'kept in Dana’s vault');
    assert.equal(m.rows.get('v:42')?.items?.['secret:FOR_DANA'], undefined);

    // SHE READS WHAT HE CHANGED, the next time her page reads her vault, from
    // the vault's own log and with the time it happened.
    await dana.signer.click(`${rowOf('DANAS_OWN')} button:text-is("Forget")`);
    await dana.signer.click(`${rowOf('DANAS_OWN')} button:text-is("Forget it")`);
    await says(dana.signer, 'Your managers', /What they changedeli@example\.com kept FOR_DANA, \S/);
    const times = await dana.signer.$$eval(`${rowOf('Your managers')} li time`, (els) => els.map((e) => /** @type {HTMLTimeElement} */ (e).dateTime));
    assert.equal(times.length, 1);
    assert.ok(Math.abs(Date.parse(times[0]) - Date.now()) < 10 * 60_000, 'the time the vault wrote down');
    assert.equal(await dana.signer.getByLabel('Let my managers manage my credentials').isChecked(), true);
    // Debbie reports to Dana, so she is on Dana's team too. Dana's page asked
    // after her before Eli signed her in, and says what is true now.
    await says(dana.signer, 'Debbie', /Agent \(debbie\)\. Signed in to Claude\./);

    // WHAT /me CARRIED, which is all a coordinator saw: no secret, no token,
    // and not whose vault any request was for. Five things, one of them the
    // list of members it already serves everybody.
    for (const who of [eli, dana]) {
      const wire = JSON.stringify(who.carried);
      for (const plain of [...Object.values(SECRETS), 'ghu_browser', 'ghu_dana', 'sk-ant-oat01']) assert.equal(wire.includes(plain), false, `${plain} crossed /me in the clear`);
      assert.equal(JSON.stringify(who.carried.filter((c) => c.path === 'POST /api/vault')).includes('debbie'), false, 'whose vault a request is for is inside the seal');
    }
    assert.deepEqual([...new Set(eli.carried.map((c) => c.path))].sort(), ['GET /api/hosts/enrolled', 'GET /api/members', 'POST /api/github/device', 'POST /api/intent', 'POST /api/vault']);
    await eli.context.close();
    await dana.context.close();
    if (failed) throw failed;
  } finally {
    m.restore();
    await b.close();
  }
});
