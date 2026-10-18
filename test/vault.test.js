// Each person's credentials, kept once, for the boxes they approve.
//
//   node --test test/vault.test.js
//
// Driven through the minting Worker's real entry and its Durable Object, with
// GitHub and Cloudflare stood in, a box played by a real P-256 key, and a
// phone played by seal.js. What it holds the vault to is the design in
// src/fleet/minter/vault.js: only the person changes their vault, only a box
// they approved by its key is given anything, a box is never given a refresh
// token, and two boxes asking at once rotate one refresh token once.
import test from 'node:test';
import assert from 'node:assert/strict';

import { newDepositKey, newSealKey, seal, open, VAULT_REQUEST_AAD, VAULT_REPLY_AAD, VAULT_BOX_AAD, GITHUB_REQUEST_AAD, GITHUB_REPLY_AAD, DEPOSIT_AAD } from '../src/fleet/seal.js';
import { generateKeyPair, sign, signingInput, fingerprint } from '../src/fleet/crypto.js';
import minterWorker, { ClaudeLogins, KEY_PATH } from '../worker/src/minter.js';
import { boxKeyHash } from '../src/fleet/minter/vault.js';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { Fleet } from '../worker/src/fleet-do.js';
import { Sidecar } from '../src/fleet/host/sidecar.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken } from '../src/core/api-token.js';
import { vaultEnvFor, vaultSecret, vaultClaudeFile, vaultExpiryFor } from '../src/core/vault-store.js';
import { runnerAuthFor } from '../src/core/runner-login.js';
import { pickCredentialSource } from '../src/core/podman.js';
import { buildCommand } from '../src/core/claude.js';

const json = (/** @type {number} */ status, /** @type {any} */ body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ELI = 'eli@example.com';
/** A second person, whose GitHub sign-in is due for renewal on every ask, so a renewal skipped is a renewal counted. */
const DANA = 'dana@example.com';
const DANA_REFRESH = `ghr_dana${'5'.repeat(60)}`;
const REFRESH_1 = `ghr_one${'1'.repeat(60)}`;
const REFRESH_2 = `ghr_two${'2'.repeat(60)}`;
const PHONE_REFRESH = `ghr_phone${'3'.repeat(60)}`;
const COORDINATOR_REFRESH = `ghr_coordinator${'4'.repeat(60)}`;

/** A minter with its own storage, and GitHub and Cloudflare stood in. @param {Record<string, string>} [extra] */
async function minter(extra = {}) {
  const deposit = await newDepositKey();
  const rows = new Map();
  /** @type {Record<string, any>} */
  const env = {
    FLEETWRIGHT_MINTER_DEPOSIT_KEY: deposit.secret,
    FLEETWRIGHT_GITHUB_CLIENT_ID: 'Iv23liTEST',
    FLEETWRIGHT_GITHUB_CLIENT_SECRET: 'gh-secret',
    FLEETWRIGHT_CLOUDFLARE_CLIENT_ID: 'cf-client',
    FLEETWRIGHT_CLOUDFLARE_CLIENT_SECRET: 'cf-secret',
    ...extra,
  };
  const storage = { get: async (/** @type {string} */ k) => rows.get(k), put: async (/** @type {string} */ k, /** @type {any} */ v) => { rows.set(k, structuredClone(v)); } };
  let instance = new ClaudeLogins({ storage }, env);
  env.LOGINS = { idFromName: () => 'logins', get: () => ({ fetch: (/** @type {string} */ u, /** @type {any} */ i) => instance.fetch(new Request(u, i)) }) };

  /** Who each token belongs to, as GitHub would say. @type {Record<string, { id: number, login: string }>} */
  const users = { ghu_eli_phone: { id: 42, login: 'eli' }, ghu_eli_phone2: { id: 42, login: 'eli' }, ghu_eli_coordinator: { id: 42, login: 'eli' }, ghu_eli_box: { id: 42, login: 'eli' }, gho_eli_other_app: { id: 42, login: 'eli' }, ghu_mallory: { id: 7, login: 'mallory' }, ghu_dana_phone: { id: 43, login: 'dana' }, ghu_dana_box: { id: 43, login: 'dana' } };
  const calls = { refresh: 0, dana: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    const u = new URL(String(url));
    if (u.href === 'https://api.github.com/user') {
      const who = users[String(init.headers?.authorization || '').replace(/^Bearer /, '')];
      return who ? json(200, who) : json(401, {});
    }
    if (u.href === 'https://github.com/login/oauth/access_token') {
      // A renewal is sent as JSON (connectors.js has always), a code exchange as a form.
      const raw = String(init.body);
      const f = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw).entries());
      if (f.client_secret !== 'gh-secret') return json(200, { error: 'incorrect_client_credentials' });
      // The phone renewing, and a refresh token the coordinator's own exchange kept.
      if (f.grant_type === 'refresh_token' && f.refresh_token === PHONE_REFRESH) return json(200, { access_token: 'ghu_eli_phone2', expires_in: 28800, refresh_token: REFRESH_2 });
      if (f.grant_type === 'refresh_token' && f.refresh_token === COORDINATOR_REFRESH) return json(200, { access_token: 'ghu_eli_coordinator', expires_in: 28800 });
      if (f.grant_type === 'refresh_token' && f.refresh_token === DANA_REFRESH) {
        calls.dana += 1;
        return json(200, { access_token: 'ghu_dana_box', expires_in: 60 });
      }
      if (f.grant_type === 'refresh_token') {
        calls.refresh += 1;
        // Slow on purpose, so two boxes asking at once are both inside it.
        await new Promise((r) => setTimeout(r, 20));
        return f.refresh_token === REFRESH_1
          ? json(200, { access_token: 'ghu_eli_box', expires_in: 28800, refresh_token: REFRESH_2 })
          : json(200, { error: 'bad_refresh_token' });
      }
      if (f.code === 'mallorycode1') return json(200, { access_token: 'ghu_mallory', expires_in: 28800, refresh_token: REFRESH_2 });
      // The phone's own sign-in (src/fleet/minter/github.js), not the vault's.
      if (f.code === 'phonecode12' && f.code_verifier === 'p'.repeat(64)) return json(200, { access_token: 'ghu_eli_phone', expires_in: 28800, refresh_token: PHONE_REFRESH });
      if (f.code === 'danaphone12' && f.code_verifier === 'p'.repeat(64)) return json(200, { access_token: 'ghu_dana_phone', expires_in: 28800 });
      if (f.code === 'danacode123' && f.code_verifier === 'v'.repeat(64)) return json(200, { access_token: 'ghu_dana_box', expires_in: 60, refresh_token: DANA_REFRESH });
      return f.code === 'goodcode123' && f.code_verifier === 'v'.repeat(64)
        ? json(200, { access_token: 'ghu_eli_box', expires_in: 60, refresh_token: REFRESH_1 })
        : json(200, { error: 'bad_verification_code' });
    }
    if (u.href === 'https://dash.cloudflare.com/oauth2/token') {
      const f = Object.fromEntries(new URLSearchParams(String(init.body)).entries());
      return f.client_secret === 'cf-secret' && f.code === 'cfcode1234'
        ? json(200, { access_token: 'cf_access', expires_in: 3600, refresh_token: 'cf_refresh' })
        : json(400, { error: 'invalid_grant' });
    }
    return real(url, init);
  });

  /** @param {string} path @param {unknown} body */
  const call = async (path, body) =>
    /** @type {any} */ (await (await minterWorker.fetch(new Request(`https://minter.internal${path}`, { method: 'POST', body: JSON.stringify(body) }), env)).json());

  /** Each person's phone's GitHub sign-in, finished through the minter as PhoneGitHub does it, once. @type {Map<string, string>} */
  const signedIn = new Map();
  /** @param {string} to @param {string} [email] */
  const signIn = async (to, email = ELI) => {
    const held = signedIn.get(email);
    if (held) return held;
    const reply = await newSealKey();
    const code = email === DANA ? 'danaphone12' : 'phonecode12';
    const sealed = await seal({ to, aad: GITHUB_REQUEST_AAD, payload: { v: 1, grant: 'code', code, verifier: 'p'.repeat(64), redirectUri: 'https://fleet.test/oauth/github/callback', at: Date.now(), reply: reply.publicKey } });
    const r = await call('/github/token', { sealed });
    assert.equal(r.ok, true, r.text);
    const token = String((await open({ privateKey: reply.privateKey, publicKey: reply.publicKey, aad: GITHUB_REPLY_AAD, sealed: r.sealed })).accessToken);
    signedIn.set(email, token);
    return token;
  };
  /** A renewal through the minter, as PhoneGitHub makes one. @param {string} refreshToken */
  const renew = async (refreshToken) => {
    const reply = await newSealKey();
    const sealed = await seal({ to: deposit.publicKey, aad: GITHUB_REQUEST_AAD, payload: { v: 1, grant: 'refresh', refreshToken, at: Date.now(), reply: reply.publicKey } });
    const r = await call('/github/token', { sealed });
    assert.equal(r.ok, true, r.text);
    return String((await open({ privateKey: reply.privateKey, publicKey: reply.publicKey, aad: GITHUB_REPLY_AAD, sealed: r.sealed })).accessToken);
  };

  /** A phone's request, sealed as the phone seals it: Eli's, or `person`'s. @param {Record<string, unknown>} body @param {{ email?: string, as?: string, at?: number, to?: string, github?: string, person?: string }} [o] */
  const phone = async (body, o = {}) => {
    const reply = await newSealKey();
    const person = o.person ?? ELI;
    const github = o.github ?? (await signIn(o.to ?? deposit.publicKey, person));
    const sealed = await seal({ to: o.to ?? deposit.publicKey, aad: VAULT_REQUEST_AAD, payload: { v: 1, github, email: person, at: o.at ?? Date.now(), reply: reply.publicKey, ...body } });
    const r = await call('/vault/device', { sealed, email: o.as ?? o.email ?? person });
    if (r.ok) r.answer = await open({ privateKey: reply.privateKey, publicKey: reply.publicKey, aad: VAULT_REPLY_AAD, sealed: r.sealed });
    return r;
  };

  /** A box asking, signed with its key, with who is in the fleet beside it when `members` is given. @param {{ publicJwk: any, privateJwk: any }} keys @param {{ at?: number, tamper?: boolean, members?: unknown }} [o] */
  const box = async (keys, o = {}) => {
    const reply = await newSealKey();
    const request = { v: 1, hostKey: { kty: 'EC', crv: 'P-256', x: keys.publicJwk.x, y: keys.publicJwk.y }, at: o.at ?? Date.now(), reply: reply.publicKey };
    const signature = await sign(keys.privateJwk, signingInput('vault-box', o.tamper ? { ...request, at: request.at + 1 } : request));
    const r = await call('/vault/box', { request, signature, ...('members' in o ? { members: o.members } : {}) });
    if (r.ok) r.answer = await open({ privateKey: reply.privateKey, publicKey: reply.publicKey, aad: VAULT_BOX_AAD, sealed: r.sealed });
    return r;
  };

  /** A Claude login deposited as fleetwright-claude-login and the phones seal one, and the coordinator relays it. @param {string} github @param {string|null} claude */
  const deposit_ = async (github, claude) =>
    call('/claude/deposit', { sealed: await seal({ to: deposit.publicKey, aad: DEPOSIT_AAD, payload: { v: 1, github, claude, at: Date.now() } }), email: ELI });

  /** The coordinator's minter binding, as fleet-do.js makes it. */
  const binding = { vault: (/** @type {string} */ route, /** @type {any} */ ask) => call(`/vault/${route}`, ask) };
  /** The key, as a phone looks it up at the fleet's address. */
  const lookup = async () => /** @type {any} */ (await (await minterWorker.fetch(new Request(`https://fleet.test${KEY_PATH}`), env)).json());
  /** The object starting again on the storage it had, as after an eviction. */
  const restart = () => { instance = new ClaudeLogins({ storage }, env); };
  /** The minting Worker as a coordinator's service binding reaches it (fleet-do.js, env.MINTER). */
  const service = { fetch: (/** @type {string} */ u, /** @type {any} */ i) => minterWorker.fetch(new Request(u, i), env) };
  return { phone, box, deposit: deposit_, signIn: () => signIn(deposit.publicKey), renew, rows, calls, binding, service, lookup, restart, restore: () => { globalThis.fetch = real; } };
}

test('a person keeps their credentials once, and only a box they approved by its key is given them', async (t) => {
  const m = await minter();
  t.after(m.restore);
  const office = await generateKeyPair();
  const stranger = await generateKeyPair();

  // KEPT: a named secret, the Claude login, and GitHub by signing in.
  assert.equal((await m.phone({ op: 'put', name: 'secret:NPM_TOKEN', value: 'npm_abc' })).ok, true);
  assert.equal((await m.phone({ op: 'put', name: 'claude', value: `sk-ant-oat01-${'c'.repeat(40)}` })).ok, true);
  const signedIn = await m.phone({ op: 'connect', provider: 'github', code: 'goodcode123', verifier: 'v'.repeat(64), redirectUri: 'https://fleet.test/oauth/github/callback' });
  assert.equal(signedIn.ok, true, signedIn.text);
  assert.equal(signedIn.answer.account, 'eli');
  assert.equal((await m.phone({ op: 'connect', provider: 'cloudflare', code: 'cfcode1234', verifier: 'w'.repeat(64), redirectUri: 'https://fleet.test/oauth/cloudflare/callback' })).ok, true);

  // NOTHING YET: a box nobody approved is given nothing, and says so.
  const before = await m.box(office);
  assert.equal(before.ok, true);
  assert.deepEqual(before.answer.accounts, []);

  // APPROVED BY ITS KEY, and the fingerprint the phone shows is the one the box prints.
  const granted = await m.phone({ op: 'grant', hostKey: office.publicJwk, label: 'office-box' });
  assert.equal(granted.ok, true, granted.text);
  assert.equal(granted.answer.fingerprint, await fingerprint(office.publicJwk));

  // THE LIST NAMES, AND NEVER SHOWS A VALUE.
  const list = await m.phone({ op: 'list' });
  assert.deepEqual(list.answer.items.map((/** @type {any} */ i) => i.name), ['claude', 'cloudflare', 'github', 'secret:NPM_TOKEN']);
  assert.equal(list.answer.grants.length, 1);
  assert.equal(list.answer.grants[0].label, 'office-box');
  assert.equal(list.answer.grants[0].email, ELI);
  assert.ok(!JSON.stringify(list).includes('npm_abc') && !JSON.stringify(list).includes(REFRESH_1));

  // AT REST, nothing readable.
  assert.ok(![...m.rows.values()].some((v) => JSON.stringify(v).includes('npm_abc') || JSON.stringify(v).includes(REFRESH_1)));

  // THE APPROVED BOX gets every item for that person, access tokens only.
  const given = await m.box(office);
  assert.equal(given.ok, true, given.text);
  assert.equal(given.answer.accounts.length, 1);
  const eli = given.answer.accounts[0];
  assert.equal(eli.email, ELI);
  const byName = Object.fromEntries(eli.items.map((/** @type {any} */ i) => [i.name, i.value]));
  assert.equal(byName['secret:NPM_TOKEN'], 'npm_abc');
  assert.equal(byName.cloudflare, 'cf_access');
  assert.match(byName.claude, /^sk-ant-oat01-/);
  assert.ok(byName.github.startsWith('ghu_'));
  assert.ok(!JSON.stringify(given.answer).includes(REFRESH_1) && !JSON.stringify(given.answer).includes('cf_refresh'), 'a box is never given a refresh token');

  // ANOTHER BOX, a forged signature, an old request: nothing.
  assert.deepEqual((await m.box(stranger)).answer.accounts, []);
  assert.equal((await m.box(office, { tamper: true })).error?.code, 'bad_signature');
  assert.equal((await m.box(office, { at: Date.now() - 11 * 60_000 })).error?.code, 'stale');

  // REVOKED: the box is given nothing from then on, and a replayed approval
  // older than the removal cannot put it back.
  const grantedAt = Date.now() - 1000;
  const key = await boxKeyHash({ kty: 'EC', crv: 'P-256', x: office.publicJwk.x, y: office.publicJwk.y });
  assert.equal((await m.phone({ op: 'revoke', key })).ok, true);
  assert.deepEqual((await m.box(office)).answer.accounts, []);
  assert.equal((await m.phone({ op: 'grant', hostKey: office.publicJwk, label: 'office-box' }, { at: grantedAt })).error?.code, 'stale');
});

test('only the person changes their vault, and not by replaying what they sent', async (t) => {
  const m = await minter();
  t.after(m.restore);
  // The fleet account the coordinator says sent it must be the one inside the seal.
  assert.equal((await m.phone({ op: 'list' }, { as: 'mallory@example.com' })).error?.code, 'not_you');
  // A GitHub sign-in to somebody else's account is not filed under this one.
  const theirs = await m.phone({ op: 'connect', provider: 'github', code: 'mallorycode1', verifier: 'v'.repeat(64), redirectUri: 'https://fleet.test/oauth/github/callback' });
  assert.equal(theirs.error?.code, 'not_yours');
  // A change older than the one held is refused, so a replay cannot undo a forget.
  const at = Date.now();
  assert.equal((await m.phone({ op: 'put', name: 'secret:A', value: 'one' }, { at })).ok, true);
  assert.equal((await m.phone({ op: 'forget', name: 'secret:A' }, { at: at + 1 })).ok, true);
  assert.equal((await m.phone({ op: 'put', name: 'secret:A', value: 'one' }, { at })).error?.code, 'stale');
  // Names a vault does not keep, and values that are not values.
  assert.equal((await m.phone({ op: 'put', name: 'github', value: 'ghp_x' })).error?.code, 'bad_name');
  assert.equal((await m.phone({ op: 'put', name: 'secret:has space', value: 'x' })).error?.code, 'bad_name');
  assert.equal((await m.phone({ op: 'put', name: 'claude', value: 'not a token' })).error?.code, 'bad_token');
  assert.equal((await m.phone({ op: 'grant', hostKey: { kty: 'RSA' } })).error?.code, 'bad_key');
});

test('the GitHub token the vault hands a box opens no vault and changes no Claude login, after the box is removed', async (t) => {
  // FOUND IN AUDIT (minter/vault-identity-any-github-token). Whose vault a
  // request opened was whoever GitHub said owned the token inside it, and the
  // vault hands its GitHub token to every box it approves. So a box removed
  // from the phone, or a session on it, approved a key of its own with that
  // token and was given the whole vault again, for good.
  const m = await minter();
  t.after(m.restore);
  const claude = `sk-ant-oat01-${'c'.repeat(40)}`;
  await m.phone({ op: 'put', name: 'secret:NPM_TOKEN', value: 'npm_abc' });
  await m.phone({ op: 'put', name: 'claude', value: claude });
  assert.equal((await m.phone({ op: 'connect', provider: 'github', code: 'goodcode123', verifier: 'v'.repeat(64), redirectUri: 'https://fleet.test/oauth/github/callback' })).ok, true);
  const removed = await generateKeyPair();
  await m.phone({ op: 'grant', hostKey: removed.publicJwk, label: 'old-box' });
  const handed = (await m.box(removed)).answer.accounts[0].items.find((/** @type {any} */ i) => i.name === 'github').value;
  assert.equal((await m.phone({ op: 'revoke', key: await boxKeyHash({ kty: 'EC', crv: 'P-256', x: removed.publicJwk.x, y: removed.publicJwk.y }) })).ok, true);

  // ANOTHER MEMBER, and the person's own fleet account, sealing that token.
  const planted = await generateKeyPair();
  for (const as of ['mallory@example.com', ELI]) {
    const r = await m.phone({ op: 'grant', hostKey: planted.publicJwk, label: 'planted', email: as }, { github: handed, as });
    assert.equal(r.error?.code, 'not_a_device', r.text);
  }
  // A token of the person's from another app opens nothing either.
  assert.equal((await m.phone({ op: 'list' }, { github: 'gho_eli_other_app' })).error?.code, 'not_a_device');
  assert.deepEqual((await m.box(planted)).answer.accounts, [], 'no key was approved');
  assert.deepEqual((await m.phone({ op: 'list' })).answer.grants, []);

  // NOR THE CLAUDE LOGIN: not replaced, not forgotten.
  assert.equal((await m.deposit(handed, null)).error?.code, 'not_a_device');
  assert.equal((await m.deposit(handed, `sk-ant-oat01-${'m'.repeat(40)}`)).error?.code, 'not_a_device');
  assert.ok((await m.phone({ op: 'list' })).answer.items.some((/** @type {any} */ i) => i.name === 'claude'));
  // The phone's own sign-in still deposits, and its renewal is still the phone's.
  assert.equal((await m.deposit(await m.signIn(), claude)).ok, true);
  assert.equal((await m.phone({ op: 'list' }, { github: await m.renew(PHONE_REFRESH) })).ok, true);
  // A refresh token kept anywhere else still renews here, into no device's token.
  assert.equal((await m.phone({ op: 'list' }, { github: await m.renew(COORDINATOR_REFRESH) })).error?.code, 'not_a_device');
});

test('a box finishing somebody’s GitHub sign-in cannot make it their device, before an eviction or after (G11)', async (t) => {
  // FOUND IN THE EIGHTH AUDIT. A box holding the client secret mints its own
  // PKCE verifier for a person's Connect and is handed the code to finish
  // with. One of the operator's boxes, where everybody's connects can be
  // placed, sealed that code and its verifier to the minter as a phone's
  // sign-in instead, with a fleet credential of its own, and the minter
  // recorded it as the person's device: from there it approved a key of its
  // own against their vault.
  const m = await minter();
  t.after(m.restore);
  const OPS = 'ops@example.com';
  const ORIGIN = 'https://fleet.test';
  const rows = new Map();
  const state = {
    storage: {
      get: async (/** @type {string} */ k) => rows.get(k),
      put: async (/** @type {string} */ k, /** @type {any} */ v) => rows.set(k, JSON.parse(JSON.stringify(v))),
    },
    blockConcurrencyWhile: (/** @type {() => any} */ fn) => fn(),
    getWebSockets: () => [],
    setAlarm: () => {},
  };
  const env = { FLEETWRIGHT_API_TOKEN: 'a-token-at-least-16ch', FLEETWRIGHT_GITHUB_CLIENT_ID: 'Iv23liTEST', FLEETWRIGHT_GITHUB_CLIENT_SECRET: 'gh-secret', MINTER: m.service };
  const fleet = new Fleet(/** @type {any} */ (state), /** @type {any} */ (env));
  await new Promise((r) => setTimeout(r, 10)); // its own restore, first

  // Eli connects GitHub on the operator's box, which offered its challenge.
  const offered = fleet.core.offerOauth({ ok: true, connections: { catalogue: [{ provider: 'github', codeChallenge: 'c'.repeat(43) }] } }, 'ops-box', ELI, ORIGIN);
  const flowState = new URL(offered.connections.catalogue[0].url).searchParams.get('state');
  /** @type {any[]} */
  const handed = [];
  fleet.core.dispatch = /** @type {any} */ (async (/** @type {any} */ intent) => { handed.push(intent); return { ok: true, text: 'Connected GitHub.' }; });
  assert.equal((await fleet.core.finishGithubAuthorization({ code: 'goodcode123', state: flowState, origin: ORIGIN, requester: { email: ELI } })).ok, true);
  assert.equal(handed[0]?.verb, 'exchange');

  // The box, with the code it was handed and the verifier it minted, as
  // somebody else's fleet account.
  const key = String((await m.lookup()).key);
  /** @param {any} core @param {string} code @param {string} verifier @param {string} as */
  const deviceSignIn = async (core, code, verifier, as) => {
    const reply = await newSealKey();
    const sealed = await seal({ to: key, aad: GITHUB_REQUEST_AAD, payload: { v: 1, grant: 'code', code, verifier, redirectUri: `${ORIGIN}/oauth/github/callback`, at: Date.now(), reply: reply.publicKey } });
    return /** @type {any} */ (await core.githubDeviceToken({ email: as }, { sealed }));
  };
  const now = await deviceSignIn(fleet.core, handed[0].params.code, 'v'.repeat(64), OPS);
  assert.equal(now.error?.code, 'box_sign_in', now.text);

  // AND AFTER AN EVICTION, which the box can simply wait for: constructed
  // over the same storage, as the object is.
  await new Promise((r) => setImmediate(r));
  const after = new Fleet(/** @type {any} */ (state), /** @type {any} */ (env));
  await new Promise((r) => setTimeout(r, 10));
  const later = await deviceSignIn(after.core, handed[0].params.code, 'v'.repeat(64), OPS);
  assert.equal(later.error?.code, 'box_sign_in', later.text);

  // A phone's own sign-in still finishes, through the same coordinator.
  const own = await deviceSignIn(after.core, 'phonecode12', 'p'.repeat(64), ELI);
  assert.equal(own.ok, true, own.text);
});

test('two boxes asking at once renew one refresh token once', async (t) => {
  const m = await minter();
  t.after(m.restore);
  // The sign-in's token lasts a minute, so the first ask renews it.
  assert.equal((await m.phone({ op: 'connect', provider: 'github', code: 'goodcode123', verifier: 'v'.repeat(64), redirectUri: 'https://fleet.test/oauth/github/callback' })).ok, true);
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  await m.phone({ op: 'grant', hostKey: a.publicJwk, label: 'a' });
  await m.phone({ op: 'grant', hostKey: b.publicJwk, label: 'b' });
  const [one, two] = await Promise.all([m.box(a), m.box(b)]);
  assert.equal(m.calls.refresh, 1, 'one rotation, however many boxes asked');
  for (const r of [one, two]) {
    const github = r.answer.accounts[0].items.find((/** @type {any} */ i) => i.name === 'github');
    assert.equal(github.value, 'ghu_eli_box');
    assert.ok(github.expiresAt > Date.now() + 60 * 60_000);
  }
  // And the rotated refresh token is what is kept: asking again renews nothing.
  await m.box(a);
  assert.equal(m.calls.refresh, 1);
});

test('a box is given nothing of somebody the fleet has removed, and nothing of theirs is renewed', async (t) => {
  // FOUND IN THE EIGHTH AUDIT (r8-leads-1). A removal is the coordinator's,
  // and the minter never heard of one: every box Dana had approved went on
  // being given her sign-ins and her Claude login, GitHub renewed here on
  // each ask, for as long as her refresh token lasted. The coordinator now
  // lists who is in the fleet beside each box's request (core.js,
  // #onHostVault), and the minter holds a grant to it.
  const m = await minter();
  t.after(m.restore);
  const office = await generateKeyPair();
  const dana = { person: DANA };
  await m.phone({ op: 'put', name: 'secret:NPM_TOKEN', value: 'npm_eli' });
  await m.phone({ op: 'grant', hostKey: office.publicJwk, label: 'office-box' });
  await m.phone({ op: 'put', name: 'secret:NPM_TOKEN', value: 'npm_dana' }, dana);
  await m.phone({ op: 'put', name: 'claude', value: `sk-ant-oat01-${'d'.repeat(40)}` }, dana);
  assert.equal((await m.phone({ op: 'connect', provider: 'github', code: 'danacode123', verifier: 'v'.repeat(64), redirectUri: 'https://fleet.test/oauth/github/callback' }, dana)).ok, true);
  assert.equal((await m.phone({ op: 'grant', hostKey: office.publicJwk, label: 'office-box' }, dana)).ok, true);
  const whose = (/** @type {any} */ r) => r.answer.accounts.map((/** @type {any} */ a) => a.email).sort();

  // DANA REMOVED: Eli's items come, none of Dana's, and her GitHub sign-in, a
  // minute from running out, is not renewed for a box that will not get it.
  const removed = await m.box(office, { members: ['boss@example.com', ELI] });
  assert.equal(removed.ok, true, removed.text);
  assert.deepEqual(whose(removed), [ELI]);
  assert.equal(removed.answer.accounts[0].items.find((/** @type {any} */ i) => i.name === 'secret:NPM_TOKEN')?.value, 'npm_eli');
  assert.ok(!/npm_dana|sk-ant-oat01-d|ghu_dana/.test(JSON.stringify(removed.answer)), 'something of Dana’s was handed to the box');
  assert.equal(m.calls.dana, 0, 'a removed person’s refresh token was rotated');

  // STILL IN THE FLEET: given, and renewed, so the zero above is a renewal skipped.
  assert.deepEqual(whose(await m.box(office, { members: ['boss@example.com', DANA, ELI] })), [DANA, ELI]);
  assert.equal(m.calls.dana, 1);

  // A COORDINATOR FROM BEFORE THE LIST says nothing, and every grant counts as it did.
  assert.deepEqual(whose(await m.box(office)), [DANA, ELI]);
  // A list that is not one is refused, never read as no list at all.
  for (const members of [DANA, Array(513).fill(ELI)]) {
    assert.equal((await m.box(office, { members })).error?.code, 'bad_params');
  }
});

test('a minter nobody gave a key makes its own once, and a phone finds it at the fleet address', async (t) => {
  // No operator step: the first ask makes the key, every later ask, from any
  // route and after the object restarts, gets that same key, and what a phone
  // seals to the looked-up key the vault opens.
  const m = await minter({ FLEETWRIGHT_MINTER_DEPOSIT_KEY: '' });
  t.after(m.restore);
  const [a, b] = await Promise.all([m.lookup(), m.lookup()]);
  assert.equal(a.ok, true, a.text);
  assert.equal(b.key, a.key, 'two first asks at once made two keys');
  assert.deepEqual(Object.keys(a).sort(), ['key', 'ok', 'v'], 'the public answer says nothing but the key');
  m.restart();
  assert.equal((await m.lookup()).key, a.key, 'the key did not survive the object starting again');
  const kept = await m.phone({ op: 'put', name: 'secret:NPM_TOKEN', value: 'npm_abc' }, { to: a.key });
  assert.equal(kept.ok, true, kept.text);
  assert.deepEqual((await m.phone({ op: 'list' }, { to: a.key })).answer.items.map((/** @type {any} */ i) => i.name), ['secret:NPM_TOKEN']);
});

test('the one public path answers a key and nothing else, and a minter with no storage says it has none', async () => {
  const env = { FLEETWRIGHT_MINTER_DEPOSIT_KEY: '' };
  const r = await minterWorker.fetch(new Request(`https://fleet.test${KEY_PATH}`), env);
  assert.equal(r.status, 503);
  assert.equal((/** @type {any} */ (await r.json())).error?.code, 'no_deposit_key');
  // Every other way in is still only what the coordinator's binding sends.
  for (const req of [new Request('https://fleet.test/vault/box'), new Request(`https://fleet.test${KEY_PATH}`, { method: 'POST', body: '{}' })]) {
    assert.equal((await minterWorker.fetch(req, env)).status, 404, `${req.method} ${new URL(req.url).pathname}`);
  }
});

test('a box asks for its vault through the coordinator, and its sessions use what it was given', async (t) => {
  const m = await minter();
  t.after(m.restore);
  await m.phone({ op: 'put', name: 'secret:NPM_TOKEN', value: 'npm_abc' });
  await m.phone({ op: 'put', name: 'claude', value: `sk-ant-oat01-${'c'.repeat(40)}` });
  await m.phone({ op: 'connect', provider: 'cloudflare', code: 'cfcode1234', verifier: 'w'.repeat(64), redirectUri: 'https://fleet.test/oauth/cloudflare/callback' });
  // A POOL'S TOKEN, which a box holds in memory and never writes down.
  await m.phone({ op: 'put', name: 'hypervisor:xo.invalid', value: JSON.stringify({ v: 1, address: 'xo.invalid', pin: 'a'.repeat(64), token: 'xo-limited-token', resourceSet: 'set-1' }) });
  const keys = await generateKeyPair();
  await m.phone({ op: 'grant', hostKey: keys.publicJwk, label: 'office-box' });

  // The coordinator, with this box enrolled under that key, and Eli in the
  // fleet: the minter serves a grant only to a box of somebody who is.
  const core = new CoordinatorCore({ minter: /** @type {any} */ (m.binding) });
  await core.issueClient({ email: ELI }, 'phone');
  const hostId = 'office-box';
  assert.equal((await core.hostIds.enrol({ hostId, publicJwk: keys.publicJwk, enrolledBy: ELI })).ok, true);

  // The box's own fleetwright, over its real loopback API.
  const stateDir = mkdtempSync(join(tmpdir(), 'fw-vault-hub-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cfg = /** @type {any} */ ({ stateDir, bind: '127.0.0.1', port: 0, token: '', hostname: hostId, workdir: join(stateDir, 'work'), maxSessions: 1, sandbox: false, claudeBin: 'claude', remoteControl: false, skipPermissions: false });
  const hubToken = ensureApiToken(cfg);
  const adapter = new HttpAdapter(cfg, { sessions: /** @type {any} */ ({ list: () => [], running: () => [] }), login: /** @type {any} */ ({}), token: hubToken });
  await adapter.start();
  t.after(() => adapter.server?.close());
  const port = /** @type {any} */ (adapter.server).address().port;

  /** @param {any} vaultKey */
  const sidecarWith = (vaultKey) => {
    const sidecar = new Sidecar({
      hub: new HubClient({ baseUrl: `http://127.0.0.1:${port}`, token: hubToken }),
      transport: /** @type {any} */ ({
        origin: 'https://fleet.test',
        onMessage() {},
        start: async () => true,
        stop: async () => {},
        send: (/** @type {any} */ frame) => {
          void core.onHostMessage(hostId, frame);
          return true;
        },
      }),
      hostId,
      watch: false,
      healthIntervalMs: 0,
      renewIntervalMs: 0,
      vaultIntervalMs: 0,
      vaultKey,
    });
    core.registry.connect(hostId, (/** @type {any} */ frame) => void sidecar.handle(frame), {});
    return sidecar;
  };
  const sidecar = sidecarWith({ publicJwk: keys.publicJwk, sign: (/** @type {string} */ msg) => sign(keys.privateJwk, msg) });
  const next = await sidecar.syncVault();
  assert.ok(next >= 60_000 && next <= 10 * 60_000, `the next ask is due within ten minutes, not ${next}`);

  // HELD WHERE THE READERS LOOK, privately.
  assert.equal(vaultSecret(cfg, ELI, 'NPM_TOKEN'), 'npm_abc');
  assert.equal(vaultEnvFor(cfg, ELI).CLOUDFLARE_API_TOKEN, 'cf_access');
  assert.ok(Number(vaultExpiryFor(cfg, ELI, 'cloudflare')) > Date.now());
  assert.equal(statSync(join(stateDir, 'vault', `${ELI}.json`)).mode & 0o777, 0o600);
  assert.equal(statSync(join(stateDir, 'vault')).mode & 0o777, 0o700);
  assert.ok(!readFileSync(join(stateDir, 'vault', `${ELI}.json`), 'utf8').includes('cf_refresh'), 'a box holds no refresh token');
  // THE POOL'S TOKEN went to this process and not to the hub's files, and
  // the box says it holds that pool (never the token) in its health.
  assert.ok(!readFileSync(join(stateDir, 'vault', `${ELI}.json`), 'utf8').includes('xo-limited-token'), 'a pool token is never written down');
  assert.equal([...sidecar.pools.held.values()][0]?.record.token, 'xo-limited-token');
  const health = await sidecar.health();
  assert.deepEqual(health.xo.map((/** @type {any} */ e) => [e.address, e.owner]), [['xo.invalid', ELI]]);
  assert.ok(!JSON.stringify(health).includes('xo-limited-token'));

  // A SESSION ON THIS PERMANENT BOX, with nothing linked here, runs on the
  // vault's Claude login, read at exec time and never in the command line;
  // a sandboxed one is seeded with it.
  const auth = runnerAuthFor(cfg, ELI, {});
  assert.equal(auth?.kind, 'token');
  const command = buildCommand(cfg, { name: 'one', runnerAuth: auth });
  assert.match(command, /unset ANTHROPIC_API_KEY; CLAUDE_CODE_OAUTH_TOKEN="\$\(cat '[^']+\.claude'\)"/);
  assert.ok(!command.includes('sk-ant-oat01'));
  assert.equal(pickCredentialSource(cfg, `fleet:${ELI}`).tokenFile, vaultClaudeFile(cfg, ELI));
  // …and somebody who approved nothing gets none of it.
  assert.equal(runnerAuthFor(cfg, 'bob@example.com', {}), null);
  assert.deepEqual(vaultEnvFor(cfg, 'bob@example.com'), {});

  // REMOVED FROM THE PHONE, forgotten on the next pass.
  const key = await boxKeyHash({ kty: 'EC', crv: 'P-256', x: keys.publicJwk.x, y: keys.publicJwk.y });
  assert.equal((await m.phone({ op: 'revoke', key })).ok, true);
  await sidecar.syncVault();
  assert.equal(vaultSecret(cfg, ELI, 'NPM_TOKEN'), null);
  assert.equal(vaultClaudeFile(cfg, ELI), null);
  assert.equal(sidecar.pools.held.size, 0, 'and the pool is no longer held');
  assert.ok(!existsSync(join(stateDir, 'vault', `${ELI}.json`)));

  // A BOX PRESENTING ANOTHER KEY is refused by the coordinator before the minter.
  const other = await generateKeyPair();
  await m.phone({ op: 'grant', hostKey: other.publicJwk, label: 'impostor' });
  const impostor = sidecarWith({ publicJwk: other.publicJwk, sign: (/** @type {string} */ msg) => sign(other.privateJwk, msg) });
  await impostor.syncVault();
  assert.equal(vaultSecret(cfg, ELI, 'NPM_TOKEN'), null);

  // AND THE PERSON'S OWN VAULT REQUESTS go through the coordinator too, with who sent them beside.
  const relayed = await core.vaultDevice({ email: 'mallory@example.com' }, { sealed: { epk: 'x', iv: 'y', ct: 'z' } });
  assert.equal(relayed.ok, false);
  assert.equal((await core.vaultDevice(null, { sealed: {} })).error?.code, 'not_signed_in');
});

test('removing somebody from the fleet ends what their vault gives the fleet’s boxes, and signing in again brings it back', async (t) => {
  // FOUND IN THE EIGHTH AUDIT (r8-leads-1). Removing Dana asked the fleet's
  // boxes to unlink her sign-ins, which reaches a box's own links: the next
  // vault ask, every ten minutes, wrote her vault's copies back.
  const m = await minter();
  t.after(m.restore);
  const keys = await generateKeyPair();
  await m.phone({ op: 'put', name: 'secret:NPM_TOKEN', value: 'npm_eli' });
  await m.phone({ op: 'grant', hostKey: keys.publicJwk, label: 'ops-box' });
  await m.phone({ op: 'put', name: 'secret:NPM_TOKEN', value: 'npm_dana' }, { person: DANA });
  await m.phone({ op: 'grant', hostKey: keys.publicJwk, label: 'ops-box' }, { person: DANA });

  const core = new CoordinatorCore({ minter: /** @type {any} */ (m.binding) });
  await core.issueClient({ email: 'boss@example.com' }, 'phone');
  await core.issueClient({ email: ELI }, 'phone');
  const danaPhone = /** @type {any} */ (await core.issueClient({ email: DANA }, 'phone'));
  await core.hostIds.enrol({ hostId: 'ops-box', publicJwk: keys.publicJwk, enrolledBy: 'boss@example.com' });
  /** @type {any[]} */
  const handed = [];
  const sidecar = new Sidecar({
    hub: /** @type {any} */ ({ vault: async (/** @type {any} */ b) => { handed.push(b); return { ok: true, text: 'held' }; } }),
    transport: /** @type {any} */ ({ origin: 'https://fleet.test', onMessage() {}, start: async () => true, stop: async () => {}, send: (/** @type {any} */ f) => { void core.onHostMessage('ops-box', f); return true; } }),
    hostId: 'ops-box',
    watch: false,
    healthIntervalMs: 0,
    renewIntervalMs: 0,
    vaultIntervalMs: 600_000,
    vaultKey: { publicJwk: keys.publicJwk, sign: (/** @type {string} */ msg) => sign(keys.privateJwk, msg) },
  });
  // Only the vault's answers reach it: the hand-back's own requests are the hub's.
  core.registry.connect('ops-box', (/** @type {any} */ f) => { if (f.kind === 'minted') void sidecar.handle(f); }, {});
  const held = async () => {
    await sidecar.syncVault();
    return handed.at(-1).accounts.map((/** @type {any} */ a) => a.email).sort();
  };

  assert.deepEqual(await held(), [DANA, ELI]);
  core.revokeClient(danaPhone.client.id);
  assert.deepEqual(await held(), [ELI], 'the box was handed Dana’s vault after she was removed');
  // NOT DELETED: signed in again, she is served again, with nothing to approve twice.
  await core.issueClient({ email: DANA }, 'phone');
  assert.deepEqual(await held(), [DANA, ELI]);
});

test('the coordinator refuses what it should before the minter is asked, and says why', async () => {
  // A DEVICE: not signed in, not sealed, no minter, too many, and a minter that is down.
  const none = new CoordinatorCore({});
  assert.equal((await none.vaultDevice({ email: ELI }, { sealed: { epk: 'a', iv: 'b', ct: 'c' } })).error?.code, 'no_minter');
  assert.equal((await none.vaultDevice({ email: ELI }, {})).error?.code, 'bad_params');
  const down = new CoordinatorCore({ minter: /** @type {any} */ ({ vault: async () => { throw new Error('connection reset'); } }) });
  assert.equal((await down.vaultDevice({ email: ELI }, { sealed: { epk: 'a', iv: 'b', ct: 'c' } })).error?.code, 'minter_unreachable');
  const busy = new CoordinatorCore({ minter: /** @type {any} */ ({ vault: async () => ({ ok: false, error: { code: 'stale' }, text: 'old' }) }) });
  let last;
  for (let i = 0; i < 31; i += 1) last = await busy.vaultDevice({ email: ELI }, { sealed: { epk: 'a', iv: 'b', ct: 'c' } });
  assert.equal(last?.error?.code, 'too_many');
  assert.ok(busy.events.some((e) => e.event === 'vault.refused' && e.actor === ELI));

  // CLOUDFLARE for a device: what it needs to open the page, never the secret,
  // and the callback hands a device's code back to the app and exchanges nothing.
  const cf = new CoordinatorCore({ cloudflareOauth: { clientId: 'cf-client', clientSecret: 'cf-secret', scopes: 'account-settings.read offline_access' } });
  const start = cf.cloudflareDeviceStart('https://fleet.test');
  assert.deepEqual(start, { ok: true, clientId: 'cf-client', redirectUri: 'https://fleet.test/oauth/cloudflare/callback', authorizeUrl: 'https://dash.cloudflare.com/oauth2/auth', scopes: 'account-settings.read offline_access', statePrefix: 'd.' });
  assert.ok(!JSON.stringify(start).includes('cf-secret'));
  assert.equal(new CoordinatorCore({}).cloudflareDeviceStart('https://fleet.test').error?.code, 'not_configured');
  const state = `d.${'s'.repeat(32)}`;
  const back = cf.cloudflareCallback({ code: 'ory_ac_abc.def-ghi', state });
  assert.equal(back.device, `fleetwright://cloudflare?code=ory_ac_abc.def-ghi&state=${state}`);
  assert.equal(cf.cloudflareCallback({ code: '"><x', state }).ok, false);

  // A BOX: no id, the wrong shape, a key it did not enrol with, no minter, and too many.
  const keys = await generateKeyPair();
  const request = { v: 1, hostKey: { kty: 'EC', crv: 'P-256', x: keys.publicJwk.x, y: keys.publicJwk.y }, at: Date.now(), reply: 'r'.repeat(87) };
  /** @param {CoordinatorCore} core @param {any} frame */
  const ask = async (core, frame) => {
    /** @type {any[]} */
    const sent = [];
    core.registry.connect('box', (/** @type {any} */ f) => sent.push(f), {});
    await core.onHostMessage('box', { v: 6, kind: 'vault', ...frame });
    return sent.find((f) => f.kind === 'minted');
  };
  const noMinter = new CoordinatorCore({});
  await noMinter.hostIds.enrol({ hostId: 'box', publicJwk: keys.publicJwk });
  assert.equal(await ask(noMinter, { request, signature: 's'.repeat(80) }), undefined, 'no id, no answer');
  assert.equal((await ask(noMinter, { id: 'vault-1234567890', request: 'nope', signature: '' }))?.error?.code, 'bad_params');
  assert.equal((await ask(noMinter, { id: 'vault-1234567890', request, signature: 's'.repeat(80) }))?.error?.code, 'no_minter');
  const other = await generateKeyPair();
  const elsewhere = { ...request, hostKey: { kty: 'EC', crv: 'P-256', x: other.publicJwk.x, y: other.publicJwk.y } };
  assert.equal((await ask(noMinter, { id: 'vault-1234567890', request: elsewhere, signature: 's'.repeat(80) }))?.error?.code, 'not_this_box');
  const flooded = new CoordinatorCore({ minter: /** @type {any} */ ({ vault: async () => ({ ok: true, sealed: {}, text: '' }) }) });
  await flooded.hostIds.enrol({ hostId: 'box', publicJwk: keys.publicJwk });
  let answer;
  for (let i = 0; i < 13; i += 1) answer = await ask(flooded, { id: `vault-12345678${i}`, request, signature: 's'.repeat(80) });
  assert.equal(answer?.error?.code, 'too_many');
});

test('a box keeps what it holds through a blip, and forgets it on an answer that says to', async () => {
  const keys = await generateKeyPair();
  /** @type {any[]} */
  const handed = [];
  /** @param {(frame: any) => any} send @param {any} [vaultKey] */
  const sidecar = (send, vaultKey) => {
    const s = new Sidecar({
      hub: /** @type {any} */ ({ vault: async (/** @type {any} */ b) => { handed.push(b); return { ok: true, text: 'held' }; } }),
      transport: /** @type {any} */ ({ origin: 'https://fleet.test', onMessage() {}, start: async () => true, stop: async () => {}, send: (/** @type {any} */ f) => send(f) }),
      hostId: 'box',
      watch: false,
      healthIntervalMs: 0,
      renewIntervalMs: 0,
      vaultIntervalMs: 600_000,
      mintTimeoutMs: 50,
      vaultKey: vaultKey ?? { publicJwk: keys.publicJwk, sign: (/** @type {string} */ m) => sign(keys.privateJwk, m) },
    });
    return s;
  };
  // Not connected, no answer, an answer that does not open, a key that will not sign: all kept.
  assert.equal(await sidecar(() => false).syncVault(), 600_000);
  assert.equal(await sidecar(() => true).syncVault(), 600_000);
  /** @type {Sidecar} */
  let garbled;
  garbled = sidecar((f) => { queueMicrotask(() => void garbled.handle({ kind: 'minted', id: f.id, ok: true, sealed: { epk: 'a', iv: 'b', ct: 'c' } })); return true; });
  await garbled.syncVault();
  await sidecar(() => true, { publicJwk: keys.publicJwk, sign: async () => { throw new Error('no key'); } }).syncVault();
  assert.deepEqual(handed, [], 'nothing held was cleared by a blip');
  // "Not the key this box enrolled with" is an answer, and clears what was held.
  /** @type {Sidecar} */
  let told;
  told = sidecar((f) => { queueMicrotask(() => void told.handle({ kind: 'minted', id: f.id, ok: false, error: { code: 'not_this_box' }, text: 'no' })); return true; });
  await told.syncVault();
  assert.deepEqual(handed, [{ accounts: [] }]);
});

test('a hypervisor’s token is kept as its own kind, checked against its address, and handed only to approved boxes', async (t) => {
  // ASKED FOR: "Why not the coordinator hold the token". The fleet keeps it,
  // in the vault, and the boxes the person approved make machines with it.
  const m = await minter();
  t.after(m.restore);
  const office = await generateKeyPair();
  const record = JSON.stringify({ v: 1, address: 'xo.lan', pin: 'a'.repeat(64), user: 'fleetwright', resourceSet: 'set-1', token: 'xo-limited-token', plain: false });

  // FILED UNDER THE ADDRESS IT NAMES, or refused.
  const wrong = await m.phone({ op: 'put', name: 'hypervisor:other.lan', value: record });
  assert.equal(wrong.error?.code, 'bad_value');
  assert.equal((await m.phone({ op: 'put', name: 'hypervisor:xo.lan', value: 'not json' })).error?.code, 'bad_value');
  assert.equal((await m.phone({ op: 'put', name: 'hypervisor:bad name', value: record })).error?.code, 'bad_name');
  const kept = await m.phone({ op: 'put', name: 'hypervisor:xo.lan', value: record });
  assert.equal(kept.ok, true, kept.text);
  assert.match(kept.text, /memory only/);
  assert.ok(![...m.rows.values()].some((v) => JSON.stringify(v).includes('xo-limited-token')), 'sealed at rest');

  assert.deepEqual((await m.box(office)).answer.accounts, [], 'a box nobody approved is given nothing');
  assert.equal((await m.phone({ op: 'grant', hostKey: office.publicJwk, label: 'office-box' })).ok, true);
  const given = await m.box(office);
  const item = given.answer.accounts[0].items.find((/** @type {any} */ i) => i.name === 'hypervisor:xo.lan');
  assert.equal(JSON.parse(item.value).token, 'xo-limited-token');

  // FORGOTTEN, it stops being handed out.
  assert.equal((await m.phone({ op: 'forget', name: 'hypervisor:xo.lan' })).ok, true);
  assert.ok(!(await m.box(office)).answer.accounts[0]?.items.some((/** @type {any} */ i) => i.name === 'hypervisor:xo.lan'));
});

test('a pool’s own machine approved for its pool is given that record and nothing else of the person’s', async (t) => {
  // ASKED FOR: "If I approve why shouldn't it approve both?" One approval
  // lets the holder join and hold its pool; it is not one of the boxes a
  // person works on, so it is not given the rest of their vault.
  const m = await minter();
  t.after(m.restore);
  const holder = await generateKeyPair();
  const record = JSON.stringify({ v: 1, address: 'xo.lan', pin: 'a'.repeat(64), user: 'fleetwright', resourceSet: 'set-1', token: 'xo-limited-token', plain: false });
  assert.equal((await m.phone({ op: 'put', name: 'hypervisor:xo.lan', value: record })).ok, true);
  assert.equal((await m.phone({ op: 'put', name: 'secret:NPM_TOKEN', value: 'npm_abc' })).ok, true);
  assert.equal((await m.phone({ op: 'put', name: 'claude', value: `sk-ant-oat01-${'c'.repeat(40)}` })).ok, true);

  // Named items, by their names, or refused.
  for (const only of [[], ['not an item'], 'hypervisor:xo.lan', Array.from({ length: 9 }, (_, i) => `secret:S${i}`)]) {
    assert.equal((await m.phone({ op: 'grant', hostKey: holder.publicJwk, label: 'holder-0a0b0c', only })).error?.code, 'bad_params', JSON.stringify(only));
  }
  const granted = await m.phone({ op: 'grant', hostKey: holder.publicJwk, label: 'holder-0a0b0c', only: ['hypervisor:xo.lan'] });
  assert.equal(granted.ok, true, granted.text);
  assert.match(granted.text, /to hold the hypervisor at xo\.lan\./, 'the phone is told what it approved');
  assert.deepEqual((await m.phone({ op: 'list' })).answer.grants.map((/** @type {any} */ g) => [g.label, g.only]), [['holder-0a0b0c', ['hypervisor:xo.lan']]]);

  const given = await m.box(holder);
  assert.deepEqual(given.answer.accounts[0].items.map((/** @type {any} */ i) => i.name), ['hypervisor:xo.lan'], 'not the Claude login, not a secret');
  assert.equal(JSON.parse(given.answer.accounts[0].items[0].value).token, 'xo-limited-token');

  // Approved again without `only`, as an ordinary box is, it holds the vault.
  assert.equal((await m.phone({ op: 'grant', hostKey: holder.publicJwk, label: 'holder-0a0b0c' })).ok, true);
  assert.deepEqual((await m.box(holder)).answer.accounts[0].items.map((/** @type {any} */ i) => i.name).sort(), ['claude', 'hypervisor:xo.lan', 'secret:NPM_TOKEN']);
});
