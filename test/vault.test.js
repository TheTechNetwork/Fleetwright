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
import { generateKeyPair, sign, signingInput, fingerprint, verify } from '../src/fleet/crypto.js';
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
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { intentSigningInput } from '../src/fleet/protocol/intent-signature.js';
import { startStubHub } from './helpers/stub-hub.js';
import { standInClaude, revokeClaude, claudeRenewals, claudeSignInFor } from './helpers/stand-in-claude.js';

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
    const claude = standInClaude(url, init);
    if (claude) return claude;
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
      if (f.client_secret === 'cf-secret' && f.grant_type === 'refresh_token' && f.refresh_token === 'cf_refresh') {
        return json(200, { access_token: 'cf_access2', expires_in: 3600, refresh_token: 'cf_refresh2' });
      }
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

  /** A box asking for the fleet's device keys, signed with its key, with who is in the fleet beside it. @param {{ publicJwk: any, privateJwk: any }} keys @param {{ members?: unknown, tamper?: boolean }} [o] */
  const keysFor = async (keys, o = {}) => {
    const request = { v: 1, hostKey: { kty: 'EC', crv: 'P-256', x: keys.publicJwk.x, y: keys.publicJwk.y }, at: Date.now() };
    const signature = await sign(keys.privateJwk, signingInput('vault-keys', o.tamper ? { ...request, at: request.at + 1 } : request));
    return call('/vault/keys', { request, signature, members: o.members ?? [ELI] });
  };

  /** A Claude login deposited as fleetwright-claude-login and the phones seal one, and the coordinator relays it. @param {string} github @param {string|null} claude @param {Record<string, unknown>} [extra] */
  const deposit_ = async (github, claude, extra = {}) =>
    call('/claude/deposit', { sealed: await seal({ to: deposit.publicKey, aad: DEPOSIT_AAD, payload: { v: 1, github, claude, at: Date.now(), ...extra } }), email: ELI });

  /** The coordinator's minter binding, as fleet-do.js makes it. */
  const binding = { vault: (/** @type {string} */ route, /** @type {any} */ ask) => call(`/vault/${route}`, ask) };
  /** The key, as a phone looks it up at the fleet's address. */
  const lookup = async () => /** @type {any} */ (await (await minterWorker.fetch(new Request(`https://fleet.test${KEY_PATH}`), env)).json());
  /** The object starting again on the storage it had, as after an eviction. */
  const restart = () => { instance = new ClaudeLogins({ storage }, env); };
  /** The minting Worker as a coordinator's service binding reaches it (fleet-do.js, env.MINTER). */
  const service = { fetch: (/** @type {string} */ u, /** @type {any} */ i) => minterWorker.fetch(new Request(u, i), env) };
  /** The vault's object renewing a sign-in for a runner's hand-out, as claude.js asks it to. @param {string} id */
  const fresh = (id) => instance.fetch(new Request('https://logins.internal/claude/fresh', { method: 'POST', body: JSON.stringify({ id }) })).then((r) => r.json());
  return { phone, box, keys: keysFor, deposit: deposit_, fresh, signIn: () => signIn(deposit.publicKey), signInAs: (/** @type {string} */ email) => signIn(deposit.publicKey, email), renew, rows, calls, binding, service, lookup, restart, restore: () => { globalThis.fetch = real; } };
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

test('a sign-in recorded before G11 was closed is no device’s, nor is its renewal, until the phone signs in again (G11)', async (t) => {
  // A record holds token hashes and nothing about which flow made them, so one
  // a box forged before the fix cannot be told from a phone's. Every record
  // from before is ended instead; the vault itself is not touched.
  const m = await minter();
  t.after(m.restore);
  await m.phone({ op: 'put', name: 'secret:NPM_TOKEN', value: 'npm_abc' });
  const kept = await generateKeyPair();
  assert.equal((await m.phone({ op: 'grant', hostKey: kept.publicJwk, label: 'eli-box' })).ok, true);
  const phoneToken = await m.signIn();

  // The record as it was written before the epoch: the same, unmarked.
  const { v: _epoch, ...before } = m.rows.get('signin:42');
  m.rows.set('signin:42', before);
  assert.equal((await m.phone({ op: 'list' }, { github: phoneToken })).error?.code, 'not_a_device');
  assert.equal((await m.deposit(phoneToken, `sk-ant-oat01-${'m'.repeat(40)}`)).error?.code, 'not_a_device');
  // Renewing its refresh token still renews, into no device's token.
  assert.equal((await m.phone({ op: 'list' }, { github: await m.renew(PHONE_REFRESH) })).error?.code, 'not_a_device');

  // The phone signs in once more, and is a device again.
  const reply = await newSealKey();
  const key = String((await m.lookup()).key);
  const sealed = await seal({ to: key, aad: GITHUB_REQUEST_AAD, payload: { v: 1, grant: 'code', code: 'phonecode12', verifier: 'p'.repeat(64), redirectUri: 'https://fleet.test/oauth/github/callback', at: Date.now(), reply: reply.publicKey } });
  const fresh = /** @type {any} */ (await (await m.service.fetch('https://minter.internal/github/token', { method: 'POST', body: JSON.stringify({ sealed }) })).json());
  assert.equal(fresh.ok, true, fresh.text);
  const again = String((await open({ privateKey: reply.privateKey, publicKey: reply.publicKey, aad: GITHUB_REPLY_AAD, sealed: fresh.sealed })).accessToken);
  const listed = await m.phone({ op: 'list' }, { github: again });
  assert.equal(listed.ok, true, listed.text);

  // And nothing in the vault moved: the item, the approval, and what the box is given.
  assert.deepEqual(listed.answer.items.map((/** @type {any} */ i) => i.name), ['secret:NPM_TOKEN']);
  assert.deepEqual(listed.answer.grants.map((/** @type {any} */ g) => g.label), ['eli-box']);
  assert.deepEqual((await m.box(kept)).answer.accounts[0].items.map((/** @type {any} */ i) => i.value), ['npm_abc']);
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
  assert.deepEqual(Object.keys(a).sort(), ['key', 'ok', 'signing', 'v'], 'the public answer says nothing but the two public keys');
  assert.equal(a.signing.d, undefined, 'the signing key’s private half left the minter');
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
    hub: /** @type {any} */ ({
      vault: async (/** @type {any} */ b) => { handed.push(b); return { ok: true, text: 'held' }; },
      // Removing Dana asks the box to forget her too (forget-person.test.js
      // has that end to end). Answered here, or the coordinator waits out the
      // whole intent timeout for it and this file takes five minutes to exit.
      forgetPerson: async () => ({ ok: true, text: 'forgotten', forgot: { sessions: 0, claude: false, providers: [], vault: false, login: false } }),
    }),
    transport: /** @type {any} */ ({ origin: 'https://fleet.test', onMessage() {}, start: async () => true, stop: async () => {}, send: (/** @type {any} */ f) => { void core.onHostMessage('ops-box', f); return true; } }),
    hostId: 'ops-box',
    watch: false,
    healthIntervalMs: 0,
    renewIntervalMs: 0,
    vaultIntervalMs: 600_000,
    vaultKey: { publicJwk: keys.publicJwk, sign: (/** @type {string} */ msg) => sign(keys.privateJwk, msg) },
  });
  core.registry.connect('ops-box', (/** @type {any} */ f) => {
    void sidecar.handle(f).then((reply) => { if (reply?.kind === 'reply') void core.onHostMessage('ops-box', reply); });
  }, {});
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

test('a phone lists its signing key under its own address, and a box is given the list signed by a key it pins from the fleet’s address', async (t) => {
  // docs/signed-intents.md. A box checks a person's signature only with a key
  // this lists for them, so the list has to be the minter's and nobody
  // else's: signed with a key the box pins from the well-known address, which
  // the coordinator that carries the answer never serves.
  const m = await minter();
  t.after(m.restore);
  const iphone = await generateKeyPair();
  const office = await generateKeyPair();
  const jwk = (/** @type {any} */ k) => ({ kty: 'EC', crv: 'P-256', x: k.publicJwk.x, y: k.publicJwk.y });

  const added = await m.phone({ op: 'devicekey', key: iphone.publicJwk, label: 'Eli’s iPhone' });
  assert.equal(added.ok, true, added.text);
  const kid = await boxKeyHash(jwk(iphone));
  assert.equal(added.answer.kid, kid);
  const list = await m.phone({ op: 'list' });
  assert.deepEqual(list.answer.devices.map((/** @type {any} */ d) => [d.kid, d.label, d.yours]), [[kid, 'Eli’s iPhone', true]]);

  // THE BOX'S LIST, signed by the key the well-known address names.
  const pinned = (await m.lookup()).signing;
  assert.ok(pinned?.x && pinned?.y && !pinned.d, 'the well-known address gives the signing key’s public half and nothing more');
  const answer = await m.keys(office, { members: [ELI, DANA] });
  assert.equal(answer.ok, true, answer.text);
  assert.equal(await verify(pinned, answer.signature, signingInput('vault-keys-answer', answer.payload)), true);
  assert.equal(answer.payload.host, await boxKeyHash(jwk(office)));
  assert.deepEqual(answer.payload.people, [{ email: ELI, keys: [{ kid, key: jwk(iphone), label: 'Eli’s iPhone' }] }]);
  // Changed on the way, it no longer checks.
  assert.equal(await verify(pinned, answer.signature, signingInput('vault-keys-answer', { ...answer.payload, people: [] })), false);
  // The same key across a restart of the object, or every box pinned the first.
  m.restart();
  assert.deepEqual((await m.lookup()).signing, pinned);

  // ONLY PEOPLE IN THE FLEET, and only a box that signed its own request.
  assert.deepEqual((await m.keys(office, { members: [DANA] })).payload.people, []);
  assert.equal((await m.keys(office, { tamper: true })).error?.code, 'bad_signature');
  assert.equal((await m.keys(office, { members: 'everyone' })).error?.code, 'bad_params');

  // ANOTHER GITHUB ACCOUNT cannot file a key under Eli's address, whatever the coordinator says.
  const mallet = await generateKeyPair();
  const dana = await m.signInAs(DANA);
  const taken = await m.phone({ op: 'devicekey', key: mallet.publicJwk }, { github: dana, person: ELI });
  assert.equal(taken.error?.code, 'address_taken', taken.text);
  assert.deepEqual((await m.keys(office)).payload.people[0].keys.map((/** @type {any} */ k) => k.kid), [kid]);

  // REMOVED, and an older add replayed inside its ten minutes does not bring it back.
  const at = Date.now() - 60_000;
  assert.equal((await m.phone({ op: 'devicekey', key: iphone.publicJwk, remove: true })).ok, true);
  assert.deepEqual((await m.keys(office)).payload.people, []);
  assert.equal((await m.phone({ op: 'devicekey', key: iphone.publicJwk, label: 'Eli’s iPhone' }, { at })).error?.code, 'stale');
  assert.deepEqual((await m.keys(office)).payload.people, []);
});

/**
 * The real minter, coordinator and sidecar for one box, `ops-box`, with Eli's
 * iPhone key listed and the box asking through the coordinator for the list and
 * fetching the minter's key from the fleet's address itself
 * (docs/signed-intents.md). The coordinator is not told whether the box
 * enforces, so what the box does with an unsigned intent is the box's own.
 *
 * @param {import('node:test').TestContext} t @param {{ requireSigned?: boolean }} [opts]
 */
async function signingFleet(t, { requireSigned = false } = {}) {
  const m = await minter();
  t.after(m.restore);
  const real = globalThis.fetch;
  /** What the fleet's address serves for the minter's key, when a test changes it. @type {{ value: any }} */
  const served = { value: null };
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    if (String(url) !== `https://fleet.test${KEY_PATH}`) return real(url, init);
    return served.value ? json(200, served.value) : m.service.fetch(String(url), init);
  });
  const iphone = await generateKeyPair();
  assert.equal((await m.phone({ op: 'devicekey', key: iphone.publicJwk, label: 'Eli’s iPhone' })).ok, true);
  const kid = await boxKeyHash({ kty: 'EC', crv: 'P-256', x: iphone.publicJwk.x, y: iphone.publicJwk.y });

  const boxKeys = await generateKeyPair();
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const core = new CoordinatorCore({ minter: /** @type {any} */ (m.binding), intentTimeoutMs: 2_000, logger: quiet });
  await core.issueClient({ email: ELI }, 'phone');
  await core.hostIds.enrol({ hostId: 'ops-box', publicJwk: boxKeys.publicJwk, enrolledBy: ELI });
  const stub = await startStubHub({ host: 'ops-box' });
  t.after(() => stub.close());
  const dir = mkdtempSync(join(tmpdir(), 'fw-intent-keys-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sidecarOn = () => new Sidecar({
    hub: new HubClient({ baseUrl: stub.baseUrl, token: null }),
    transport: /** @type {any} */ ({ origin: 'https://fleet.test', onMessage() {}, start: async () => true, stop: async () => {}, send: (/** @type {any} */ f) => { void core.onHostMessage('ops-box', f); return true; } }),
    hostId: 'ops-box', watch: false, healthIntervalMs: 0, renewIntervalMs: 0, vaultIntervalMs: 600_000, xoStateDir: dir, logger: quiet, requireSigned,
    vaultKey: { publicJwk: boxKeys.publicJwk, sign: (/** @type {string} */ msg) => sign(boxKeys.privateJwk, msg) },
  });
  /** The box as it runs now; `restart` replaces it, as a restarted sidecar would be. */
  const box = { sidecar: sidecarOn(), restart() { this.sidecar = sidecarOn(); } };
  core.registry.connect('ops-box', (/** @type {any} */ f) => {
    void box.sidecar.handle(f).then((reply) => { if (reply?.kind === 'reply') void core.onHostMessage('ops-box', reply); });
  }, {});
  await core.onHostMessage('ops-box', { v: PROTOCOL_VERSION, kind: 'health', hostId: 'ops-box', health: { hostId: 'ops-box', protocol: PROTOCOL_VERSION, labels: [], maxSessions: 5, running: 0, free: 5, resumable: [], sessions: [], loadavg: [0, 0, 0], loggedIn: true, claudeAccounts: 1, hub: { reachable: true }, sandboxed: true } });

  let n = 0;
  /** A start from Eli's phone, signed over `signed` and sent with `params`. @param {{ signed?: any, params?: any, key?: any, keyId?: string, unsigned?: boolean }} [o] */
  const start = async (o = {}) => {
    const id = `sig-intent-${String(++n).padStart(4, '0')}`;
    const params = o.params ?? { name: `job-${n}` };
    const issuedAt = Date.now();
    const sig = await sign((o.key ?? iphone).privateJwk, intentSigningInput({ actor: ELI, id, issuedAt, params: o.signed ?? params, verb: 'start' }, 'ops-box'));
    return core.dispatch({ verb: 'start', params, id, actor: ELI, requester: { email: ELI, admin: true }, preferHost: 'ops-box', ...(o.unsigned ? {} : { sig, kid: o.keyId ?? kid, issuedAt }) });
  };
  /** A coordinator that adds a key of its own to the list it carries. */
  const poisonList = async () => {
    const mallet = await generateKeyPair();
    const malletKey = { kty: 'EC', crv: 'P-256', x: String(mallet.publicJwk.x), y: String(mallet.publicJwk.y) };
    const malletId = await boxKeyHash(malletKey);
    core.minter = /** @type {any} */ ({
      vault: async (/** @type {string} */ route, /** @type {any} */ ask) => {
        const r = await m.binding.vault(route, ask);
        if (route === 'keys' && r.ok) r.payload.people[0].keys.push({ kid: malletId, key: malletKey, label: 'not a phone' });
        return r;
      },
    });
    return { mallet, malletKey, malletId, heal: () => { core.minter = /** @type {any} */ (m.binding); } };
  };
  return { m, core, box, dir, served, start, poisonList };
}

test('a box checks the signature on an intent with keys the minter signed, which the coordinator carries and cannot add to', async (t) => {
  // Phase 1: counted and reported, and nothing refused on a box that does not
  // enforce.
  const { m, box, dir, served, start, poisonList } = await signingFleet(t);

  // THE LIST, through the coordinator, taken because the minter signed it.
  assert.equal(await box.sidecar.intentKeys?.refresh(), true, box.sidecar.intentKeys?.problem ?? '');
  assert.ok(existsSync(join(dir, 'minter-signing.json')), 'the minter’s key is kept on the box');

  assert.equal((await start()).ok, true);
  // Changed on the way: run, because this box refuses nothing, and counted.
  const changed = await start({ signed: { name: 'job-a' }, params: { name: 'job-b' } });
  assert.equal(changed.ok, true, 'a box that does not enforce refused something');
  assert.equal((await start({ unsigned: true })).ok, true);
  let seen = /** @type {any} */ (await box.sidecar.health()).signatures;
  assert.equal(seen.keys, 1);
  assert.deepEqual([seen.checked.signed, seen.checked['bad-signature'], seen.checked.unsigned], [1, 1, 1]);
  assert.equal(seen.problem, undefined);
  assert.equal(seen.enforcing, undefined);

  // A COORDINATOR ADDING A KEY OF ITS OWN to the list: the list is not taken,
  // so an intent signed with that key is a key the box does not know.
  const { mallet, malletKey, malletId, heal } = await poisonList();
  assert.equal(await box.sidecar.intentKeys?.refresh(), false);
  assert.match(String(box.sidecar.intentKeys?.problem), /not signed by the minter’s key/);
  assert.equal((await start({ key: mallet, keyId: malletId })).ok, true);
  seen = /** @type {any} */ (await box.sidecar.health()).signatures;
  assert.equal(seen.checked['unknown-key'], 1, 'a key the coordinator slipped into the list was taken');
  heal();

  // THE FLEET'S ADDRESS SERVING ANOTHER KEY, after a restart of the box: the
  // kept one stays, and no list is taken until somebody deletes it.
  box.restart();
  served.value = { ...(await m.lookup()), signing: malletKey };
  assert.equal(await box.sidecar.intentKeys?.refresh(), false);
  assert.match(String(/** @type {any} */ (await box.sidecar.health()).signatures.problem), /different signing key/);
  rmSync(join(dir, 'minter-signing.json'));
  served.value = null;
  assert.equal(await box.sidecar.intentKeys?.refresh(), true, 'the minter’s own key, kept again once the old one was deleted');
});

test('a box run with FLEETWRIGHT_REQUIRE_SIGNED refuses what a person did not sign, whatever the coordinator says', async (t) => {
  // Phase 3, on the box. The coordinator here is not told the box enforces,
  // so everything below reaches the box and the box alone decides.
  const { core, box, start, poisonList } = await signingFleet(t, { requireSigned: true });

  // BEFORE THE BOX HAS A KEY LIST: refused, even signed. Enforcement that
  // lapsed until the list arrived would be enforcement a coordinator could
  // lapse by holding the list back.
  const early = await start();
  assert.equal(early.error?.code, 'signature_required');
  assert.match(early.text, /ops-box takes only requests a person signed, and this box has no key list from the minter/);

  assert.equal(await box.sidecar.intentKeys?.refresh(), true, box.sidecar.intentKeys?.problem ?? '');
  assert.equal((await start()).ok, true, 'a start Eli’s phone signed was refused');

  const unsigned = await start({ unsigned: true });
  assert.equal(unsigned.error?.code, 'signature_required');
  assert.match(unsigned.text, /this start from eli@example\.com was not signed\. Nothing was done/);

  const changed = await start({ signed: { name: 'job-a' }, params: { name: 'job-b' } });
  assert.equal(changed.error?.code, 'signature_required');
  assert.match(changed.text, /does not hold for what arrived/);

  // A key the coordinator slipped in is not one the box takes, and the list
  // carrying it is not taken: the box keeps the last list the minter signed,
  // and that list does not have the key.
  const { mallet, malletId, heal } = await poisonList();
  assert.equal(await box.sidecar.intentKeys?.refresh(), false);
  const forged = await start({ key: mallet, keyId: malletId });
  assert.equal(forged.error?.code, 'signature_required');
  assert.match(forged.text, /signed by a key the minter does not list for eli@example\.com/);
  heal();

  // WHAT NEEDS NO SIGNATURE STILL WORKS: a read every box answers, and one of
  // the three things the coordinator says alone.
  const host = core.registry.get('ops-box');
  const listed = await core.send(host, { verb: 'list', params: {} });
  assert.notEqual(listed.error?.code, 'signature_required');
  const forget = await core.send(host, { verb: 'forgetperson', params: {}, actor: ELI });
  assert.notEqual(forget.error?.code, 'signature_required');

  const seen = /** @type {any} */ (await box.sidecar.health()).signatures;
  assert.equal(seen.enforcing, true, 'the box does not say it enforces');
});

test('a Claude token Claude refuses is not kept, by the vault or by a deposit, and nothing it replaced is lost', async (t) => {
  const m = await minter();
  t.after(m.restore);
  const good = `sk-ant-oat01-${'g'.repeat(40)}`;
  assert.equal((await m.phone({ op: 'put', name: 'claude', value: good })).ok, true);
  const kept = await m.phone({ op: 'put', name: 'claude', value: `sk-ant-oat01-revoked-${'r'.repeat(30)}` });
  assert.equal(kept.ok, false);
  assert.equal(kept.error?.code, 'rejected_token');
  assert.match(kept.text, /Claude refused that token just now \(401: Invalid bearer token\)\. Nothing was kept/);
  const deposited = await m.deposit(await m.signIn(), `sk-ant-oat01-revoked-${'d'.repeat(30)}`);
  assert.equal(deposited.error?.code, 'rejected_token');
  // The good one is still what runners and boxes are given.
  const tested = await m.phone({ op: 'test', name: 'claude' });
  assert.equal(tested.answer.state, 'accepted', tested.text);
  assert.match(tested.text, /Your Claude login works/);
});

test('a vault tests what it keeps with the service each is for, and says when there is nothing to ask', async (t) => {
  const m = await minter();
  t.after(m.restore);
  // NOTHING KEPT: nothing to test, and it says so rather than "works".
  const none = await m.phone({ op: 'test', name: 'claude' });
  assert.equal(none.error?.code, 'not_kept');

  // GITHUB: renewed first, as a box would be handed it, then asked whose it is.
  assert.equal((await m.phone({ op: 'connect', provider: 'github', code: 'goodcode123', verifier: 'v'.repeat(64), redirectUri: 'https://fleet.test/oauth/github/callback' })).ok, true);
  const github = await m.phone({ op: 'test', name: 'github' });
  assert.equal(github.answer.state, 'accepted', github.text);
  assert.equal(github.text, 'GitHub works: it answered as eli just now.');

  // CLOUDFLARE: a renewal Cloudflare accepts, stored, so the next ask uses the new one.
  assert.equal((await m.phone({ op: 'connect', provider: 'cloudflare', code: 'cfcode1234', verifier: 'w'.repeat(64), redirectUri: 'https://fleet.test/oauth/cloudflare/callback' })).ok, true);
  const cf = await m.phone({ op: 'test', name: 'cloudflare' });
  assert.equal(cf.answer.state, 'accepted', cf.text);
  // Renewed again, the stored refresh token is the rotated one, which the
  // stand-in refuses: what is kept is what was handed back, and a refusal is
  // said as one.
  const again = await m.phone({ op: 'test', name: 'cloudflare' });
  assert.equal(again.answer.state, 'rejected', again.text);
  assert.match(again.text, /Cloudflare would not renew your sign-in just now/);

  // CLAUDE, revoked after it was kept: the test says so, which is the one
  // thing that would have told a person before their runner did.
  const token = `sk-ant-oat01-${'k'.repeat(40)}`;
  assert.equal((await m.phone({ op: 'put', name: 'claude', value: token })).ok, true);
  assert.equal((await m.phone({ op: 'test', name: 'claude' })).answer.state, 'accepted');
  revokeClaude(token);
  const gone = await m.phone({ op: 'test', name: 'claude' });
  assert.equal(gone.answer.state, 'rejected');
  assert.match(gone.text, /^Claude refused your login just now \(401: Invalid bearer token\)\. Runners and boxes given it stop at their first message/);

  // A NAMED SECRET has no service to ask.
  assert.equal((await m.phone({ op: 'put', name: 'secret:NPM_TOKEN', value: 'npm_abc' })).ok, true);
  assert.equal((await m.phone({ op: 'test', name: 'secret:NPM_TOKEN' })).error?.code, 'not_testable');

});

test('a whole Claude sign-in is kept once, renewed by the minter alone, and no box is given its refresh token', async (t) => {
  const m = await minter();
  t.after(m.restore);
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  // TEN MINUTES LEFT, so the first box to ask renews it. Granted the scopes
  // Claude Code 2.1.306 signs in for, which a renewal keeps: asking for fewer
  // would hand every box a narrower token than the person signed in for.
  const signedInFor = ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'];
  const made = claudeSignInFor('eli', 10 * 60_000, signedInFor);
  const kept = await m.phone({ op: 'put', name: 'claude', signIn: made });
  assert.equal(kept.ok, true, kept.text);
  assert.match(kept.text, /Kept your Claude sign-in .* with Remote Control\. It is renewed here and nowhere else\. Claude accepted it just now\./);
  const listed = await m.phone({ op: 'list' });
  assert.deepEqual(listed.answer.items.find((/** @type {any} */ i) => i.name === 'claude'), { name: 'claude', at: listed.answer.items.find((/** @type {any} */ i) => i.name === 'claude').at, kind: 'login' });
  assert.ok(![...m.rows.values()].some((v) => JSON.stringify(v).includes(made.oauth.refreshToken)), 'nothing readable at rest');

  await m.phone({ op: 'grant', hostKey: a.publicJwk, label: 'a' });
  await m.phone({ op: 'grant', hostKey: b.publicJwk, label: 'b' });
  const before = claudeRenewals.count;
  const [one, two] = await Promise.all([m.box(a), m.box(b)]);
  assert.equal(claudeRenewals.count - before, 1, 'one renewal however many boxes asked');
  for (const r of [one, two]) {
    const claude = r.answer.accounts[0].items.find((/** @type {any} */ i) => i.name === 'claude');
    assert.match(claude.value, /^sk-ant-oat01-renewed/);
    assert.ok(claude.expiresAt > Date.now() + 7 * 3_600_000);
    assert.equal(claude.login.subscriptionType, 'max');
    assert.deepEqual(claude.login.scopes, signedInFor);
    assert.equal(claude.account.emailAddress, 'eli@example.com');
    assert.equal(claude.account.notAField, undefined, 'only the account fields Claude Code reads are kept');
    assert.ok(!JSON.stringify(r.answer).includes('sk-ant-ort01'), 'a box is never given a refresh token');
    assert.deepEqual(r.answer.accounts[0].problems, []);
  }
  // The rotated pair is what is kept: asking again renews nothing.
  await m.box(a);
  assert.equal(claudeRenewals.count - before, 1);

  // A RUNNER'S HAND-OUT renews through the vault's object, under its lock,
  // and is the bearer alone.
  const forRunner = await m.fresh('42');
  assert.equal(forRunner.ok, true, forRunner.text);
  assert.match(forRunner.token, /^sk-ant-oat01-renewed/);
  assert.equal(Object.keys(forRunner).includes('refreshToken'), false);

  const tested = await m.phone({ op: 'test', name: 'claude' });
  assert.equal(tested.answer.state, 'accepted', tested.text);
});

test('a Claude sign-in Claude will not renew says so, and is given out only until it runs out', async (t) => {
  const m = await minter();
  t.after(m.restore);
  const office = await generateKeyPair();
  const made = claudeSignInFor('eli', 5 * 60_000);
  made.oauth.refreshToken = `sk-ant-ort01-revoked-${'x'.repeat(40)}`;
  // BY A DEPOSIT this time, the phones' other route to the same row.
  const deposited = await m.deposit(await m.signIn(), null, { signIn: made });
  assert.equal(deposited.ok, true, deposited.text);
  assert.match(deposited.text, /Kept eli’s Claude sign-in\. .*Remote Control works on them/);
  await m.phone({ op: 'grant', hostKey: office.publicJwk, label: 'office' });

  const given = await m.box(office);
  const claude = given.answer.accounts[0].items.find((/** @type {any} */ i) => i.name === 'claude');
  assert.equal(claude.value, made.oauth.accessToken, 'still good for five minutes, so still given');
  assert.match(given.answer.accounts[0].problems.join(' '), /Claude refused to renew it \(Refresh token not found or invalid\)\. Sign in to Claude again from your phone/);
  const tested = await m.phone({ op: 'test', name: 'claude' });
  assert.equal(tested.answer.state, 'rejected');
  assert.match(tested.text, /Claude refused to renew it/);

  // A sign-in with no refresh token, or a malformed one, is not kept at all.
  const bad = await m.phone({ op: 'put', name: 'claude', signIn: { oauth: { accessToken: made.oauth.accessToken } } });
  assert.equal(bad.error?.code, 'bad_token');
});
