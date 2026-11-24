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

import { newDepositKey, newSealKey, seal, open, atRestAad, VAULT_REQUEST_AAD, VAULT_REPLY_AAD, VAULT_BOX_AAD, GITHUB_REQUEST_AAD, GITHUB_REPLY_AAD, DEPOSIT_AAD } from '../src/fleet/seal.js';
import { generateKeyPair, sign, signingInput, fingerprint, verify } from '../src/fleet/crypto.js';
import minterWorker, { ClaudeLogins, KEY_PATH } from '../worker/src/minter.js';
import { boxKeyHash } from '../src/fleet/minter/vault.js';
import { describeRenewals, renewalVerdict, freshClaude, claudeRenewals as renewalsKept, CLAUDE_USAGE_URL } from '../src/fleet/minter/claude-login.js';
import { USAGE_URL } from '../src/core/usage.js';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { Fleet } from '../worker/src/fleet-do.js';
import { Sidecar, VAULT_CHANGED_ASK_MS } from '../src/fleet/host/sidecar.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken } from '../src/core/api-token.js';
import { vaultEnvFor, vaultSecret, vaultClaudeFile, vaultExpiryFor } from '../src/core/vault-store.js';
import { runnerAuthFor } from '../src/core/runner-login.js';
import { pickCredentialSource } from '../src/core/podman.js';
import { buildCommand } from '../src/core/claude.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { delegationSigningInput, intentSigningInput } from '../src/fleet/protocol/intent-signature.js';
import { RESULT_FOOTER } from '../src/fleet/protocol/tasks.js';
import { startStubHub } from './helpers/stub-hub.js';
import { standInClaude, revokeClaude, forbidClaude, claudeRenewals, claudeSignInFor, cancelClaudeSignIns, claudeUsageAsks } from './helpers/stand-in-claude.js';

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
  // A COPY ON EVERY READ, as a Durable Object's storage gives: the same row
  // read twice is two objects, so nothing here can compare rows by reference.
  // The renewal did, and every renewal looked like one a deposit overtook.
  const storage = {
    get: async (/** @type {string} */ k) => structuredClone(rows.get(k)),
    put: async (/** @type {string} */ k, /** @type {any} */ v) => { rows.set(k, structuredClone(v)); },
    // As a Durable Object's storage lists, in key order.
    list: async (/** @type {{ prefix: string }} */ o) => new Map([...rows.entries()].filter(([k]) => k.startsWith(o.prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
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

  /** A phone's request, sealed as the phone seals it: Eli's, or `person`'s. @param {Record<string, unknown>} body @param {{ email?: string, as?: string, at?: number, to?: string, github?: string, person?: string, admin?: boolean }} [o] */
  const phone = async (body, o = {}) => {
    const reply = await newSealKey();
    const person = o.person ?? ELI;
    const github = o.github ?? (await signIn(o.to ?? deposit.publicKey, person));
    const sealed = await seal({ to: o.to ?? deposit.publicKey, aad: VAULT_REQUEST_AAD, payload: { v: 1, github, email: person, at: o.at ?? Date.now(), reply: reply.publicKey, ...body } });
    // `admin` is the coordinator's word for who administers the fleet, beside the seal.
    const r = await call('/vault/device', { sealed, email: o.as ?? o.email ?? person, ...(o.admin === undefined ? {} : { admin: o.admin }) });
    if (r.ok) r.answer = await open({ privateKey: reply.privateKey, publicKey: reply.publicKey, aad: VAULT_REPLY_AAD, sealed: r.sealed });
    return r;
  };

  /** A box asking, signed with its key, with who is in the fleet beside it when `members` is given. @param {{ publicJwk: any, privateJwk: any }} keys @param {{ at?: number, tamper?: boolean, members?: unknown, accepts?: string[] }} [o] */
  const box = async (keys, o = {}) => {
    const reply = await newSealKey();
    const request = { v: 1, hostKey: { kty: 'EC', crv: 'P-256', x: keys.publicJwk.x, y: keys.publicJwk.y }, at: o.at ?? Date.now(), reply: reply.publicKey, ...(o.accepts ? { accepts: o.accepts } : {}) };
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
  const binding = { vault: (/** @type {string} */ route, /** @type {any} */ ask) => call(`/vault/${route}`, ask), claude: (/** @type {string} */ route, /** @type {any} */ ask) => call(`/claude/${route}`, ask) };
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
  // AND SAYS, OUTSIDE THE SEAL, WHICH ANSWERS CHANGED SOMETHING A BOX HOLDS,
  // so the coordinator can tell the boxes to ask now: a list changed nothing.
  assert.equal(list.changed, undefined);
  assert.equal(granted.changed, true);
  assert.equal(signedIn.changed, true);
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

test('a box told somebody’s vault changed asks the vault in a moment, not at its next ten minutes', async (t) => {
  const m = await minter();
  t.after(m.restore);
  const keys = await generateKeyPair();
  await m.phone({ op: 'grant', hostKey: keys.publicJwk, label: 'ops-box' });
  const core = new CoordinatorCore({ minter: /** @type {any} */ (m.binding) });
  await core.issueClient({ email: ELI }, 'phone');
  await core.hostIds.enrol({ hostId: 'ops-box', publicJwk: keys.publicJwk, enrolledBy: ELI });
  /** @param {any} vaultKey @param {any[]} handed */
  const box = (vaultKey, handed) => new Sidecar({
    hub: /** @type {any} */ ({ vault: async (/** @type {any} */ b) => { handed.push(b); return { ok: true, text: 'held' }; } }),
    transport: /** @type {any} */ ({ origin: 'https://fleet.test', onMessage() {}, start: async () => true, stop: async () => {}, send: (/** @type {any} */ f) => { void core.onHostMessage('ops-box', f); return true; } }),
    hostId: 'ops-box',
    watch: false,
    healthIntervalMs: 0,
    renewIntervalMs: 0,
    vaultIntervalMs: 600_000,
    vaultKey,
  });
  /** @type {any[]} */
  const handed = [];
  const sidecar = box({ publicJwk: keys.publicJwk, sign: (/** @type {string} */ msg) => sign(keys.privateJwk, msg) }, handed);
  core.registry.connect('ops-box', (/** @type {any} */ f) => {
    void sidecar.handle(f).then((reply) => { if (reply?.kind === 'reply') void core.onHostMessage('ops-box', reply); });
  }, {});
  /** @type {any[]} */
  const unkeyed = [];
  const noVault = box(undefined, unkeyed);
  t.after(() => Promise.all([sidecar.stop(), noVault.stop()]));

  await sidecar.syncVault();
  assert.ok(!JSON.stringify(handed).includes('npm_now'));
  await m.phone({ op: 'put', name: 'secret:NPM_TOKEN', value: 'npm_now' });
  // THE FRAME AS THE COORDINATOR SENDS IT (core.js, #vaultChanged), with no reply.
  assert.deepEqual(await sidecar.handle({ v: PROTOCOL_VERSION, kind: 'vault-changed' }), { kind: 'none' });
  assert.deepEqual(await noVault.handle({ v: PROTOCOL_VERSION, kind: 'vault-changed' }), { kind: 'none' });
  await new Promise((r) => setTimeout(r, VAULT_CHANGED_ASK_MS + 600));
  assert.ok(JSON.stringify(handed.at(-1)).includes('npm_now'), 'asked within a moment, not at the next ten minutes');
  assert.equal(unkeyed.length, 0, 'a box with no vault key asks nothing');
});

test('a vault change tells every permanent box to ask the vault now, and a list tells none', () => {
  // SEEN ON vnic-runner-oci: a Claude login forgotten and kept again at 18:19
  // reached the box at its next ten-minute ask, 18:29.
  const minterSays = { changed: true };
  const core = new CoordinatorCore({
    minter: /** @type {any} */ ({
      vault: async () => ({ ok: true, sealed: { epk: 'e', iv: 'i', ct: 'c' }, text: 'done', ...minterSays }),
      claude: async () => ({ ok: true, login: 'eli', text: 'kept' }),
    }),
  });
  /** @type {Record<string, any[]>} */
  const sent = { office: [], runner: [] };
  core.registry.connect('office', (/** @type {any} */ f) => sent.office.push(f), {});
  core.registry.connect('runner', (/** @type {any} */ f) => sent.runner.push(f), { ephemeral: true, owner: ELI });
  const asked = (/** @type {any[]} */ frames) => frames.filter((f) => f.kind === 'vault-changed').length;
  return (async () => {
    await core.vaultDevice({ email: ELI }, { sealed: { epk: 'a', iv: 'b', ct: 'c' } });
    assert.equal(asked(sent.office), 1);
    assert.equal(asked(sent.runner), 0, 'a runner asks for its owner’s login on its own clock');
    delete minterSays.changed;
    await core.vaultDevice({ email: ELI }, { sealed: { epk: 'a', iv: 'b', ct: 'c' } });
    assert.equal(asked(sent.office), 1, 'a list changed nothing');
    // A CLAUDE LOGIN DEPOSITED, the phones' other route to the same row.
    await core.depositClaudeLogin({ email: ELI }, { sealed: { epk: 'a', iv: 'b', ct: 'c' } });
    assert.equal(asked(sent.office), 2);
  })();
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

test('every box holding a Claude token asks for the next one at the minute the minter renews it', async () => {
  // RENEWING REVOKES THE TOKEN EVERY HOLDER HAS, so a box that asked only on
  // its own ten-minute clock went on sending a revoked one after another box
  // had renewed it, and a session there stopped with "Please run /login".
  // Every holder has the same expiry, so the ask is timed from it.
  const keys = await generateKeyPair();
  /** @param {number} left  how long the token the vault gives has */
  const nextAsk = async (left) => {
    /** @type {Sidecar} */
    let box;
    box = new Sidecar({
      hub: /** @type {any} */ ({ vault: async () => ({ ok: true, text: 'held' }) }),
      transport: /** @type {any} */ ({
        origin: 'https://fleet.test', onMessage() {}, start: async () => true, stop: async () => {},
        send: (/** @type {any} */ f) => {
          const payload = { accounts: [{ email: ELI, items: [{ name: 'claude', value: 'sk-ant-oat01-held', expiresAt: Date.now() + left }], problems: [] }] };
          void seal({ to: f.request.reply, aad: VAULT_BOX_AAD, payload }).then((sealed) => box.handle({ kind: 'minted', id: f.id, ok: true, sealed }));
          return true;
        },
      }),
      hostId: 'box', watch: false, healthIntervalMs: 0, renewIntervalMs: 0, vaultIntervalMs: 600_000, mintTimeoutMs: 2_000,
      vaultKey: { publicJwk: keys.publicJwk, sign: (/** @type {string} */ m) => sign(keys.privateJwk, m) },
    });
    return box.syncVault();
  };
  const near = (/** @type {number} */ got, /** @type {number} */ want) => assert.ok(Math.abs(got - want) < 5_000, `asked in ${got}ms, not ${want}ms`);
  // Hours left: the usual ten minutes.
  assert.equal(await nextAsk(8 * 3_600_000), 600_000);
  // Thirty-five minutes left: a minute inside the half hour the minter renews
  // in, which is when every other box holding it asks too.
  near(await nextAsk(35 * 60_000), 6 * 60_000);
  // Just past that minute and not renewed (a clock that disagrees, a box that
  // renewed first): again in a minute.
  assert.equal(await nextAsk(28 * 60_000), 60_000);
  // Well inside it, renewing has failed: ten minutes before it runs out, as before.
  near(await nextAsk(22 * 60_000), 600_000);
  near(await nextAsk(15 * 60_000), 5 * 60_000);
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
  // A PER-BOX TOKEN UNDER THE SHARED NAME would be handed to every approved
  // box, and the shared one under a box's name would be that box's alone
  // while saying it is another user's (xo-box-users.js).
  const boxed = JSON.stringify({ ...JSON.parse(record), box: 'deb14', user: 'fleetwright-box-deb14', token: 'xo-box-token' });
  assert.equal((await m.phone({ op: 'put', name: 'hypervisor:xo.lan', value: boxed })).error?.code, 'bad_value');
  assert.equal((await m.phone({ op: 'put', name: 'hypervisor:xo.lan+deb14', value: record })).error?.code, 'bad_value');
  assert.equal((await m.phone({ op: 'put', name: 'hypervisor:xo.lan+not a box', value: boxed })).error?.code, 'bad_name');
  const filed = await m.phone({ op: 'put', name: 'hypervisor:xo.lan+deb14', value: boxed });
  assert.equal(filed.ok, true, filed.text);
  assert.match(filed.text, /the hypervisor at xo\.lan, as deb14/);
  const kept = await m.phone({ op: 'put', name: 'hypervisor:xo.lan', value: record });
  assert.equal(kept.ok, true, kept.text);
  assert.match(kept.text, /memory only/);
  assert.ok(![...m.rows.values()].some((v) => JSON.stringify(v).includes('xo-limited-token')), 'sealed at rest');

  assert.deepEqual((await m.box(office)).answer.accounts, [], 'a box nobody approved is given nothing');
  assert.equal((await m.phone({ op: 'grant', hostKey: office.publicJwk, label: 'office-box' })).ok, true);
  const given = await m.box(office);
  const item = given.answer.accounts[0].items.find((/** @type {any} */ i) => i.name === 'hypervisor:xo.lan');
  assert.equal(JSON.parse(item.value).token, 'xo-limited-token');
  assert.ok(!given.answer.accounts[0].items.some((/** @type {any} */ i) => i.name === 'hypervisor:xo.lan+deb14'), 'a full grant is not another box’s user');
  // THE BOX THE TOKEN IS FOR is given it, by the label its approval carries,
  // beside the shared one while that is kept.
  const deb14 = await generateKeyPair();
  assert.equal((await m.phone({ op: 'grant', hostKey: deb14.publicJwk, label: 'deb14' })).ok, true);
  assert.deepEqual((await m.box(deb14)).answer.accounts[0].items.map((/** @type {any} */ i) => i.name).sort(), ['hypervisor:xo.lan', 'hypervisor:xo.lan+deb14']);

  // FORGOTTEN, it stops being handed out.
  assert.equal((await m.phone({ op: 'forget', name: 'hypervisor:xo.lan' })).ok, true);
  assert.ok(!(await m.box(office)).answer.accounts[0]?.items.some((/** @type {any} */ i) => i.name === 'hypervisor:xo.lan'));
  // And the shared item leaving does not take a box's own user with it.
  assert.deepEqual((await m.box(deb14)).answer.accounts[0].items.map((/** @type {any} */ i) => i.name), ['hypervisor:xo.lan+deb14']);
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

  // THE POOL'S OWN MACHINE gets its own user, and not a sibling's, because
  // the grant names the shared item and the label is the machine
  // (xo-box-users.js; a holder is one of the boxes a policy names).
  const own = JSON.stringify({ ...JSON.parse(record), box: 'holder-0a0b0c', user: 'fleetwright-box-holder-0a0b0c', token: 'xo-holder-token' });
  const other = JSON.stringify({ ...JSON.parse(record), box: 'deb14', user: 'fleetwright-box-deb14', token: 'xo-deb14-token' });
  assert.equal((await m.phone({ op: 'put', name: 'hypervisor:xo.lan+holder-0a0b0c', value: own })).ok, true);
  assert.equal((await m.phone({ op: 'put', name: 'hypervisor:xo.lan+deb14', value: other })).ok, true);
  assert.deepEqual((await m.box(holder)).answer.accounts[0].items.map((/** @type {any} */ i) => i.name).sort(), ['hypervisor:xo.lan', 'hypervisor:xo.lan+holder-0a0b0c']);

  // Approved again without `only`, as an ordinary box is, it holds the vault,
  // and still not the other box's user.
  assert.equal((await m.phone({ op: 'grant', hostKey: holder.publicJwk, label: 'holder-0a0b0c' })).ok, true);
  assert.deepEqual((await m.box(holder)).answer.accounts[0].items.map((/** @type {any} */ i) => i.name).sort(), ['claude', 'hypervisor:xo.lan', 'hypervisor:xo.lan+holder-0a0b0c', 'secret:NPM_TOKEN']);

  // THE SHARED ITEM LEAVING does not take this machine's user with it. The
  // approval was the shared name; the item itself is what the phone drops.
  assert.equal((await m.phone({ op: 'forget', name: 'hypervisor:xo.lan' })).ok, true);
  assert.equal((await m.phone({ op: 'grant', hostKey: holder.publicJwk, label: 'holder-0a0b0c', only: ['hypervisor:xo.lan'] })).ok, true);
  assert.deepEqual((await m.box(holder)).answer.accounts[0].items.map((/** @type {any} */ i) => i.name), ['hypervisor:xo.lan+holder-0a0b0c']);
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
  // Listed with no key, which is what tells a box he signs nothing now.
  assert.equal((await m.phone({ op: 'devicekey', key: iphone.publicJwk, remove: true })).ok, true);
  assert.deepEqual((await m.keys(office)).payload.people, [{ email: ELI, keys: [] }]);
  assert.equal((await m.phone({ op: 'devicekey', key: iphone.publicJwk, label: 'Eli’s iPhone' }, { at })).error?.code, 'stale');
  assert.deepEqual((await m.keys(office)).payload.people, [{ email: ELI, keys: [] }]);

  // A DELEGATION REVOKED is listed beside his keys until it would have run
  // out, and only the account that files his keys can revoke one.
  assert.equal((await m.phone({ op: 'devicekey', key: office.publicJwk, label: 'Eli’s iPad' })).ok, true);
  const until = Date.now() + 3_600_000;
  assert.equal((await m.phone({ op: 'revokedelegation', id: 'mcp-claude-desktop-01', until })).ok, true);
  assert.deepEqual((await m.keys(office)).payload.people[0].revoked, ['mcp-claude-desktop-01']);
  assert.equal((await m.phone({ op: 'revokedelegation', id: 'mcp-claude-desktop-02', until }, { github: dana, person: ELI })).error?.code, 'address_taken');
  assert.equal((await m.phone({ op: 'revokedelegation', id: 'short', until })).error?.code, 'bad_params');
  // A key added afterwards keeps the revocations.
  assert.equal((await m.phone({ op: 'devicekey', key: iphone.publicJwk, label: 'Eli’s iPhone' })).ok, true);
  assert.deepEqual((await m.keys(office)).payload.people[0].revoked, ['mcp-claude-desktop-01']);
});

/**
 * The real minter, coordinator and sidecar for one box, `ops-box`, with Eli's
 * iPhone key listed and the box asking through the coordinator for the list and
 * fetching the minter's key from the fleet's address itself
 * (docs/signed-intents.md). The coordinator is not told whether the box
 * enforces, so what the box does with an unsigned intent is the box's own.
 *
 * @param {import('node:test').TestContext} t @param {{ requireSigned?: boolean|'off'|'signers'|'all' }} [opts]
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
    // NOT ITS HEALTH: the coordinator is not told whether this box enforces, so
    // what the box does with an unsigned intent is the box's own to decide. A
    // box pushes health after a verb that changes it, and under load that push
    // landed before the next request, so the coordinator refused it first and
    // the test read the coordinator's sentence instead of the box's.
    transport: /** @type {any} */ ({ origin: 'https://fleet.test', onMessage() {}, start: async () => true, stop: async () => {}, send: (/** @type {any} */ f) => { if (f?.kind !== 'health') void core.onHostMessage('ops-box', f); return true; } }),
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
  /**
   * What Eli's phone signs to let the fleet send something in his name later.
   * @param {Record<string, any>} over
   */
  const delegate = async (over = {}) => {
    const grant = {
      v: 1, id: `dlg-${Math.random().toString(36).slice(2, 14)}-0000`, actor: ELI, verbs: ['start'], hosts: ['ops-box'], match: { name: 'held' },
      issuedAt: Date.now(), expires: Date.now() + 3_600_000, ...over,
    };
    return { grant, sig: await sign(iphone.privateJwk, delegationSigningInput(grant)), kid };
  };
  return { m, core, box, dir, served, start, poisonList, delegate, iphone, stub, kid };
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
  // Asked about again, and the list that came back is the coordinator's too.
  assert.match(forged.text, /signed by a key the minter does not list for eli@example\.com, and this box could not ask the minter again just now \(the key list is not signed by the minter’s key[^)]*\)\. A phone added in the last few minutes can try again shortly\./);
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

// A NEW PHONE'S FIRST REQUEST. The phone signs only once the minter lists its
// key, but the box took its list up to ten minutes before that, and refused
// the phone until its next one: "signed by a key the minter does not list", on
// a phone that had just been listed. Reported from a new iPhone.
test('a box asks the minter again when a signature is by a key its list does not have, at most every two minutes', async (t) => {
  const { m, core, box, start } = await signingFleet(t, { requireSigned: true });
  assert.equal(await box.sidecar.intentKeys?.refresh(), true, box.sidecar.intentKeys?.problem ?? '');
  let asks = 0;
  core.minter = /** @type {any} */ ({
    vault: (/** @type {string} */ route, /** @type {any} */ ask) => {
      if (route === 'keys') asks += 1;
      return m.binding.vault(route, ask);
    },
  });

  // LISTED AFTER THE BOX'S LIST: taken, on the list the box asks for then.
  const iPad = await generateKeyPair();
  assert.equal((await m.phone({ op: 'devicekey', key: iPad.publicJwk, label: 'Eli’s iPad' })).ok, true);
  const iPadId = await boxKeyHash({ kty: 'EC', crv: 'P-256', x: iPad.publicJwk.x, y: iPad.publicJwk.y });
  const first = await start({ key: iPad, keyId: iPadId });
  assert.equal(first.ok, true, first.text);
  assert.equal(asks, 1);

  // A KEY THE MINTER DOES NOT HAVE, moments later: not asked about again, and
  // the refusal says when asking again is worth it.
  const stranger = await generateKeyPair();
  const strangerId = await boxKeyHash({ kty: 'EC', crv: 'P-256', x: stranger.publicJwk.x, y: stranger.publicJwk.y });
  const held = await start({ key: stranger, keyId: strangerId });
  assert.equal(held.error?.code, 'signature_required');
  assert.match(held.text, /does not list for eli@example\.com, and this box asked the minter for a new list moments ago\. A phone added since then can try again in two minutes\. Nothing was done\./);
  assert.equal(asks, 1, 'a second unknown key within two minutes asked the minter again');
  assert.equal(/** @type {any} */ (await box.sidecar.health()).signatures.checked['unknown-key'], 1, 'an intent asked about again was counted twice');
});

test('a key still missing from the list the box asked for again is refused as one the minter does not have', async (t) => {
  const { box, start } = await signingFleet(t, { requireSigned: true });
  assert.equal(await box.sidecar.intentKeys?.refresh(), true, box.sidecar.intentKeys?.problem ?? '');
  const stranger = await generateKeyPair();
  const strangerId = await boxKeyHash({ kty: 'EC', crv: 'P-256', x: stranger.publicJwk.x, y: stranger.publicJwk.y });
  const refused = await start({ key: stranger, keyId: strangerId });
  assert.equal(refused.error?.code, 'signature_required');
  assert.match(refused.text, /does not list for eli@example\.com, even on the list this box asked the minter for just now\. Nothing was done\./);
});

// WHAT THE FLEET SENDS IN SOMEBODY'S NAME WHILE THEY ARE AWAY, on a box that
// takes only what a person signed: taken with a delegation Eli's phone signed,
// checked against the minter's list as a signature is, and refused from the
// next list once he revokes it, which goes to the minter and not to the
// coordinator that carries it.
test('a box that enforces takes what a person delegated, until the minter lists it as revoked', async (t) => {
  const { m, core, box, start, delegate } = await signingFleet(t, { requireSigned: 'all' });
  assert.equal(await box.sidecar.intentKeys?.refresh(), true, box.sidecar.intentKeys?.problem ?? '');

  const held = await delegate();
  assert.equal(core.keepDelegation(ELI, held).ok, true);
  assert.equal((await start({ params: { name: 'held' }, unsigned: true })).ok, true, 'a start Eli delegated was refused');
  // Covers what it names and nothing else: another session name is refused.
  const other = await start({ params: { name: 'other' }, unsigned: true });
  assert.equal(other.error?.code, 'signature_required');

  // A delegation the coordinator changed on the way does not hold.
  core.delegations.forget(ELI);
  core.delegations.byPerson.set(ELI, [{ ...held, grant: { ...held.grant, match: { name: 'other' } } }]);
  const tampered = await start({ params: { name: 'other' }, unsigned: true });
  assert.equal(tampered.error?.code, 'signature_required');
  assert.match(tampered.text, /signature on this start does not hold/);
  core.delegations.forget(ELI);

  // Revoked from the phone, through the minter: refused from the next list.
  assert.equal(core.keepDelegation(ELI, held).ok, true);
  assert.equal((await m.phone({ op: 'revokedelegation', id: held.grant.id, until: held.grant.expires })).ok, true);
  assert.equal(await box.sidecar.intentKeys?.refresh(), true);
  const revoked = await start({ params: { name: 'held' }, unsigned: true });
  assert.equal(revoked.error?.code, 'signature_required');
  assert.match(revoked.text, /revoked the delegation this start carries/);

  // A COORDINATOR CHOOSING ONE THAT DOES NOT COVER, which an honest one never
  // does: a real delegation of Eli's, for another box, sent straight to this
  // one. The box checks the cover itself rather than trusting the choice.
  const elsewhere = await delegate({ hosts: ['build-box'] });
  const wrong = await box.sidecar.handle({
    v: PROTOCOL_VERSION, kind: 'intent', id: 'dlg-elsewhere-0001', verb: 'start', params: { name: 'held' },
    actor: ELI, issuedAt: Date.now(), delegation: elsewhere,
  });
  assert.equal(wrong.error?.code, 'signature_required');
  assert.match(wrong.text, /what eli@example\.com delegated does not cover this start here, now/);

  // Counted. The start for another name arrived with no delegation at all,
  // because the coordinator carries only one that covers what it sends.
  const seen = /** @type {any} */ (await box.sidecar.health()).signatures;
  assert.deepEqual(
    [seen.checked.delegated, seen.checked.unsigned, seen.checked['bad-signature'], seen.checked.revoked, seen.checked['not-covered']],
    [1, 1, 1, 1, 1],
  );
});

// THE DEFAULT THE FLEET IS MOVING TO: refuse unsigned work in the name of a
// person who signs, and anything with nobody named, which the box would run as
// itself. A person with no key is still taken at their word, and a person
// the box has seen a key for stays a signer across a restart and a list that
// leaves them out, until the minter says, signed, that they removed every key.
test('a box that enforces for signers refuses unsigned work for people with keys and for nobody, and remembers who signs', async (t) => {
  const { m, core, box, start, iphone } = await signingFleet(t, { requireSigned: 'signers' });
  const host = core.registry.get('ops-box');

  // Nobody named: refused before any list, because the box runs it as itself.
  const anon = await core.send(host, { verb: 'start', params: { name: 'anon' } });
  assert.equal(anon.error?.code, 'signature_required');
  assert.match(anon.text, /this start from nobody named was not signed/);

  // Before the box has seen Eli's key, his word is taken as it always was.
  assert.equal((await start({ unsigned: true })).ok, true);

  assert.equal(await box.sidecar.intentKeys?.refresh(), true);
  assert.equal((await start()).ok, true, 'a start Eli signed was refused');
  assert.equal((await start({ unsigned: true })).error?.code, 'signature_required');
  // Somebody with no key is still taken at their word.
  assert.notEqual((await core.send(host, { verb: 'start', params: { name: 'kims' }, actor: 'kim@example.com' })).error?.code, 'signature_required');

  // A restarted box with no list yet, and then a list that leaves Eli out (a
  // coordinator dropping him from the members it sends): still a signer.
  box.restart();
  assert.equal((await start({ unsigned: true })).error?.code, 'signature_required', 'a restart forgot who signs');
  const kept = core.minter;
  core.minter = /** @type {any} */ ({ vault: (/** @type {string} */ r, /** @type {any} */ a) => kept.vault(r, r === 'keys' ? { ...a, members: [] } : a) });
  assert.equal(await box.sidecar.intentKeys?.refresh(), true);
  assert.equal((await start({ unsigned: true })).error?.code, 'signature_required', 'a list leaving Eli out stopped the box enforcing for him');
  core.minter = kept;

  // Eli removes his only key: the minter lists him with none, and he is taken at his word again.
  assert.equal((await m.phone({ op: 'devicekey', key: iphone.publicJwk, remove: true })).ok, true);
  assert.equal(await box.sidecar.intentKeys?.refresh(), true);
  assert.equal((await start({ unsigned: true })).ok, true);

  assert.equal(/** @type {any} */ (await box.sidecar.health()).signatures.enforcing, 'signers');
});

// THE SWITCH IS READ, NOT GUESSED: a box's operator sets it in an env file,
// and a value the sidecar does not know is a typo in a setting that exists to
// refuse things, so it stops the start rather than reading as off.
test('FLEETWRIGHT_REQUIRE_SIGNED is off, signers or all, signers when unset, and anything else is refused at start', async () => {
  const { loadSidecarConfig, validateSidecarConfig } = await import('../src/fleet/host/config.js');
  const read = (/** @type {string|undefined} */ v) => loadSidecarConfig({
    FLEETWRIGHT_COORDINATOR_URL: 'stdio:local', ...(v === undefined ? {} : { FLEETWRIGHT_REQUIRE_SIGNED: v }),
  });
  for (const [raw, mode] of [['0', 'off'], ['off', 'off'], ['1', 'all'], ['all', 'all'], ['signers', 'signers'], ['Signers', 'signers']]) {
    assert.equal(read(raw).requireSigned, mode, raw);
  }
  assert.equal(read(undefined).requireSigned, 'signers');
  const typo = read('singers');
  assert.equal(typo.requireSigned, null);
  assert.ok(validateSidecarConfig(typo).errors.some((e) => /FLEETWRIGHT_REQUIRE_SIGNED is not one of off, signers or all/.test(e)));
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
  // With what a credentials file is written from, as a box is given it, so a
  // runner's sessions read the next token as a box's do; still not the
  // refresh token, anywhere in the answer.
  assert.ok(forRunner.expiresAt > Date.now() + 7 * 3_600_000);
  assert.deepEqual(forRunner.login, { scopes: signedInFor, subscriptionType: 'max', rateLimitTier: forRunner.login.rateLimitTier });
  assert.equal(forRunner.account.emailAddress, 'eli@example.com');
  assert.ok(!JSON.stringify(forRunner).includes('sk-ant-ort01'));

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

test('a sign-in ended outside the fleet is told from one this fleet renewed, by the record each renewal leaves', async (t) => {
  // SEEN ON vnic-runner-oci: "Refresh token not found or invalid", and
  // nothing kept said when the sign-in was last renewed or by whom.
  const m = await minter();
  t.after(m.restore);
  t.after(() => { claudeRenewals.expiresIn = 28800; });
  const office = await generateKeyPair();
  const kept = await m.phone({ op: 'put', name: 'claude', signIn: claudeSignInFor('ended', 10 * 60_000) });
  assert.equal(kept.ok, true, kept.text);

  // Renewed by a box, to a token that is due again at once.
  claudeRenewals.expiresIn = 600;
  await m.phone({ op: 'grant', hostKey: office.publicJwk, label: 'office' });
  await m.box(office);
  const renewed = await m.phone({ op: 'test', name: 'claude' });
  assert.equal(renewed.answer.state, 'accepted', renewed.text);
  // The expiry is ten minutes out, so in the last ten minutes of a UTC day it
  // carries tomorrow's date. The renewal itself is always "now".
  assert.match(renewed.text, /Last renewed at \d\d:\d\d UTC, asked for by a test; that access token is good until (?:\d{4}-\d{2}-\d{2} )?\d\d:\d\d UTC\./);

  // Then signed out on claude.ai: the next renewal is refused, and nothing in
  // the fleet renewed it between the last good one and the refusal.
  cancelClaudeSignIns();
  const ended = await m.phone({ op: 'test', name: 'claude' });
  assert.equal(ended.answer.state, 'rejected');
  assert.match(ended.text, /The last renewal, at \d\d:\d\d UTC, asked for by a test, was refused: Claude refused to renew it \(Refresh token not found or invalid\)\./);
  assert.match(ended.text, /Nothing in the fleet renewed it between the last good renewal at \d\d:\d\d UTC and then, so it was ended outside the fleet/);
  // Holding no token: the record is kept in the clear.
  const record = [...m.rows.entries()].find(([k]) => k.startsWith('claude-renewed:'));
  assert.ok(record, 'each renewal is noted');
  assert.ok(!JSON.stringify(record).includes('sk-ant-'), 'no token in the record');
  assert.deepEqual(record[1].map((/** @type {any} */ n) => [n.by, n.ok]), [['a box', true], ['a test', true], ['a test', false]]);
});

test('a renewal this fleet lost is not blamed on anything outside it', () => {
  const kept = Date.parse('2026-10-25T10:00:00Z');
  const now = Date.parse('2026-10-25T18:20:00Z');
  const good = { at: Date.parse('2026-10-25T10:19:00Z'), by: 'a box', ok: true, until: Date.parse('2026-10-25T18:19:00Z') };
  const refused = { at: Date.parse('2026-10-25T18:19:00Z'), by: 'a test', ok: false, refused: true, why: 'Claude refused to renew it (Refresh token not found or invalid)' };
  // CUT OFF: asked for and never settled, a deploy restarting the object
  // between Anthropic's answer and the write-back.
  const cut = { at: Date.parse('2026-10-25T17:50:00Z'), by: 'a box', ok: false, pending: true };
  const told = describeRenewals([good, cut, refused], kept, now);
  assert.match(told, /A renewal at 17:50 UTC, asked for by a box, was cut off before its answer was kept, which loses the refresh token Claude had just issued\./);
  assert.doesNotMatch(told, /outside the fleet/);
  // NOT WRITTEN BACK because a new sign-in was being kept at that moment.
  const dropped = { ...good, at: Date.parse('2026-10-25T17:50:00Z'), dropped: true };
  assert.match(describeRenewals([good, dropped, refused], kept, now), /The renewal at 17:50 UTC was not kept, because a new sign-in was being kept at the same moment\./);
  assert.equal(describeRenewals([], kept, now), 'It has not been renewed since it was kept at 10:00 UTC.');
  // An earlier day is dated.
  assert.match(describeRenewals([good, refused], kept, Date.parse('2026-10-26T09:00:00Z')), /between the last good renewal at 2026-10-25 10:19 UTC and then/);
});

test('a sign-in Anthropic ended is found by the minter and its person told on their phone, once', async (t) => {
  // SEEN ON vnic-runner-oci: a sign-in ended outside the fleet at 18:19 was
  // found out when a session would not start, and nobody was told.
  assert.equal(CLAUDE_USAGE_URL, USAGE_URL, 'the check asks the address /usage reads');
  const m = await minter();
  t.after(m.restore);
  /** @type {any[]} */
  const sends = [];
  const clock = { now: Date.now() };
  const core = new CoordinatorCore({
    minter: /** @type {any} */ (m.binding),
    push: /** @type {any} */ ({ async send(/** @type {any[]} */ devices, /** @type {any} */ message) { sends.push({ to: devices.map((d) => d.actor), message }); return { sent: devices.length, dead: [] }; } }),
    now: () => clock.now,
  });
  for (const [email, admin] of [[ELI, false], ['ops@example.com', true]]) {
    const { client } = /** @type {any} */ (await core.clients.issue(`phone (${email})`, { admin, email }));
    await core.registerDevice({ platform: 'ios', token: (admin ? 'b' : 'a').repeat(64), clientId: client.id, actor: `fleet:${email}` });
  }
  /** The minter's own floor, stepped past as ten minutes passing would. */
  const later = () => { m.rows.delete('claude-checked'); clock.now += 16 * 60_000; };

  // WORKING, and not due: its access token is asked after and nothing is renewed.
  const made = claudeSignInFor('checked');
  assert.equal((await m.phone({ op: 'put', name: 'claude', signIn: made })).ok, true);
  const renewed = claudeRenewals.count;
  const asked = claudeUsageAsks.count;
  assert.equal(await core.checkClaudeSignIns(), 0);
  assert.equal(claudeUsageAsks.count - asked, 1);
  assert.equal(claudeRenewals.count, renewed, 'a sign-in that works is not renewed early');
  assert.equal(sends.length, 0);
  // Asked again within fifteen minutes, the coordinator does not ask; asked
  // past it within the minter's ten, the minter does not either.
  assert.equal(await core.checkClaudeSignIns(), 0);
  assert.equal(claudeUsageAsks.count - asked, 1);
  clock.now += 16 * 60_000;
  assert.deepEqual((await m.binding.claude('check', {})).ended, []);
  assert.equal(claudeUsageAsks.count - asked, 1, 'the minter answers at most every ten minutes, whoever asks');

  // ENDED ON claude.ai, access token and refresh token both: the access token
  // is refused, so it is renewed at once, and that renewal being refused is
  // what says it is over.
  revokeClaude(made.oauth.accessToken);
  cancelClaudeSignIns();
  later();
  assert.equal(await core.checkClaudeSignIns(), 1);
  assert.equal(claudeRenewals.count - renewed, 1, 'renewed at once when its access token was refused');
  const mine = sends.find((s) => s.to.includes(`fleet:${ELI}`));
  assert.equal(mine.message.title, 'Your Claude sign-in was ended');
  assert.match(mine.message.body, /^It was ended outside the fleet: Claude refused to renew it at \d\d:\d\d UTC, and the record shows nothing in the fleet renewing it before that\. Sessions cannot start with it\. Sign in to Claude again from your phone or the signing page\.$/);
  assert.equal(mine.message.data.kind, 'claude-ended');
  assert.equal(mine.message.drawnByApp, undefined, 'drawn by the system tray');
  const admin = sends.find((s) => s.to.includes('fleet:ops@example.com'));
  assert.equal(admin.message.title, `${ELI}’s Claude sign-in was ended`);
  assert.match(admin.message.body, /from their phone/);
  assert.ok(core.events.some((e) => e.event === 'claude.ended' && e.actor === ELI && /Refresh token not found or invalid/.test(e.text)));
  assert.ok(!JSON.stringify(sends).includes('sk-ant-'), 'no token reaches a phone');

  // ONCE: asked again, nothing more is said about the same sign-in.
  later();
  assert.equal(await core.checkClaudeSignIns(), 0);
  assert.equal(sends.length, 2);

  // A RENEWAL A BOX ASKED FOR, refused, is the answer without asking again;
  // and a new sign-in kept is told about afresh.
  const office = await generateKeyPair();
  const next = claudeSignInFor('next', 5 * 60_000);
  assert.equal((await m.phone({ op: 'put', name: 'claude', signIn: next })).ok, true);
  await m.phone({ op: 'grant', hostKey: office.publicJwk, label: 'office' });
  cancelClaudeSignIns();
  await m.box(office);
  later();
  const before = claudeUsageAsks.count;
  assert.equal(await core.checkClaudeSignIns(), 1);
  assert.equal(claudeUsageAsks.count, before, 'a refusal already noted is not asked about again');
  assert.equal(sends.length, 4);
});

test('the phone is told what the record says ended a sign-in, and a renewal this fleet lost is not blamed on anything outside it', async () => {
  // SEEN ON 2026-10-26: "It was ended outside the fleet at 02:00 UTC" was
  // said from the refusal alone. A renewal Anthropic answered and this fleet
  // never kept ends a sign-in the same way, and only the record tells them apart.
  /** @type {any[]} */
  let ended = [];
  /** @type {any[]} */
  const sends = [];
  const clock = { now: Date.parse('2026-10-26T02:00:55Z') };
  const core = new CoordinatorCore({
    minter: /** @type {any} */ ({ claude: async () => ({ ok: true, ended }) }),
    push: /** @type {any} */ ({ async send(/** @type {any[]} */ _d, /** @type {any} */ message) { sends.push(message); return { sent: 1, dead: [] }; } }),
    now: () => clock.now,
  });
  const { client } = /** @type {any} */ (await core.clients.issue('phone', { admin: false, email: ELI }));
  await core.registerDevice({ platform: 'ios', token: 'a'.repeat(64), clientId: client.id, actor: `fleet:${ELI}` });
  const refused = { email: ELI, login: 'eli', at: Date.parse('2026-10-26T02:00:10Z'), why: 'Claude refused to renew it (Refresh token not found or invalid)' };
  /** @param {any} verdict */
  const tell = async (verdict) => {
    ended = [{ ...refused, ...(verdict ? { verdict } : {}) }];
    clock.now += 16 * 60_000;
    await core.checkClaudeSignIns();
    return sends.at(-1);
  };

  const cut = await tell({ kind: 'cut', at: Date.parse('2026-10-26T01:49:50Z') });
  assert.equal(cut.title, 'Your Claude sign-in stopped working');
  assert.match(cut.body, /^A renewal at 01:49 UTC was cut off before its answer was kept, so this fleet lost it\. Claude refused the next one at 02:00 UTC\./);
  assert.doesNotMatch(cut.body, /outside/);
  const dropped = await tell({ kind: 'dropped', at: Date.parse('2026-10-26T01:49:50Z') });
  assert.match(dropped.body, /^A renewal at 01:49 UTC was not kept, because a new sign-in was being kept at the same moment, so this fleet lost it\./);
  const expired = await tell({ kind: 'expired', at: Date.parse('2026-10-26T01:30:00Z') });
  assert.equal(expired.title, 'Your Claude sign-in stopped working');
  assert.match(expired.body, /^Its refresh token ran out at 01:30 UTC, before this fleet renewed it\. Claude refused the next renewal at 02:00 UTC\./);
  // A MINTER FROM BEFORE THE VERDICT says only what it knows.
  const unsaid = await tell(null);
  assert.equal(unsaid.title, 'Your Claude sign-in stopped working');
  assert.match(unsaid.body, /^Claude refused to renew it at 02:00 UTC\. Sessions cannot start with it\./);
  assert.ok(core.events.some((e) => e.event === 'claude.ended' && /cut off before its answer was kept/.test(e.text)), 'the event says the same');
});

// THE WRITE-BACK GUARD, on storage that gives a copy on every read, as a
// Durable Object's does. Compared by reference, the row read again was never
// the row read first, so every renewal was thrown away as overtaken and the
// sign-in died at the next one: "Refresh token not found or invalid", ten to
// twenty minutes after it was kept. Reported from a phone, twice in a day.
test('a renewal is written back unless a new sign-in was kept while it was asked for', async () => {
  const key = await newSealKey();
  const rows = new Map();
  const store = {
    get: async (/** @type {string} */ k) => structuredClone(rows.get(k)),
    put: async (/** @type {string} */ k, /** @type {any} */ v) => { rows.set(k, structuredClone(v)); },
  };
  const now = Date.now();
  /** @param {string} refresh @param {number} at */
  const keep = async (refresh, at) => rows.set('gh:7', {
    at, login: 'eli', kind: 'login',
    sealed: await seal({ to: key.publicKey, aad: atRestAad('7'), payload: { oauth: { accessToken: 'sk-ant-oat01-old', refreshToken: refresh, expiresAt: now + 60_000, scopes: ['user:inference'] }, account: {} } }),
  });
  const kept = async () => (await open({ privateKey: key.privateKey, publicKey: key.publicKey, aad: atRestAad('7'), sealed: rows.get('gh:7').sealed })).oauth;
  /** @type {(() => Promise<void>)|null} */
  let during = null;
  const fetchImpl = /** @type {any} */ (async () => {
    if (during) await during();
    return new Response(JSON.stringify({ access_token: 'sk-ant-oat01-new', refresh_token: 'sk-ant-ort01-rotated', expires_in: 28_800 }), { status: 200 });
  });

  // NOTHING KEPT MEANWHILE: the rotated refresh token is what the row holds.
  await keep('sk-ant-ort01-first', now - 1000);
  const first = await freshClaude(store, key, '7', { fetchImpl, now: () => now, force: true });
  assert.equal(first.held?.bearer, 'sk-ant-oat01-new');
  assert.equal((await kept()).refreshToken, 'sk-ant-ort01-rotated', 'the renewal was not written back, so its refresh token was lost');
  assert.equal((await renewalsKept(store, '7', now - 1000)).at(-1)?.dropped, undefined);

  // A NEW SIGN-IN KEPT WHILE CLAUDE WAS ASKED: it stands, and the renewal is
  // noted as the one that was not kept.
  await keep('sk-ant-ort01-second', now - 500);
  during = async () => { during = null; await keep('sk-ant-ort01-deposited', now); };
  await freshClaude(store, key, '7', { fetchImpl, now: () => now, force: true });
  assert.equal((await kept()).refreshToken, 'sk-ant-ort01-deposited', 'a renewal overwrote a sign-in kept while it was asked for');
  assert.equal((await renewalsKept(store, '7', now - 500)).at(-1)?.dropped, true);
});

test('a refresh token that runs out before its access token is renewed before it does, and its lifetime is kept', async (t) => {
  // TWO SIGN-INS IN A ROW were refused at their first renewal, 7.7 hours
  // after keeping, with nothing in the fleet using them. A refresh token that
  // lasts fewer than eight hours looks exactly like that, and its lifetime,
  // which Claude Code writes beside it, was dropped when it was kept.
  //
  // THE SENTENCE IS DATED WHEN THE INSTANT IS NOT TODAY. describeRenewals
  // prints HH:MM for a time on the same UTC day as now, and YYYY-MM-DD HH:MM
  // otherwise. An eight-hour access token kept at 21:35 UTC runs out at 05:35
  // the next day, so a matcher that only accepts HH:MM fails from 16:00 UTC
  // until midnight — which is when this test was red on a wall clock. Both
  // hours are frozen here, and each expects the sentence that hour produces.
  const cases = [
    {
      name: 'shortlived-morning',
      now: Date.parse('2026-10-26T10:00:00Z'),
      until: 'that access token is good until 18:00 UTC, and its refresh token until 16:00 UTC.',
    },
    {
      name: 'shortlived-evening',
      now: Date.parse('2026-10-26T21:35:00Z'),
      until: 'that access token is good until 2026-10-27 05:35 UTC, and its refresh token until 2026-10-27 03:35 UTC.',
    },
  ];
  t.after(() => { claudeRenewals.refreshExpiresIn = undefined; });
  for (const { name, now, until } of cases) {
    t.mock.timers.enable({ apis: ['Date'], now });
    const m = await minter();
    t.after(m.restore);
    try {
      const office = await generateKeyPair();
      const made = /** @type {any} */ (claudeSignInFor(name));
      made.oauth.refreshTokenExpiresAt = Date.now() + 20 * 60_000;
      assert.equal((await m.phone({ op: 'put', name: 'claude', signIn: made })).ok, true, name);
      await m.phone({ op: 'grant', hostKey: office.publicJwk, label: 'office' });
      claudeRenewals.refreshExpiresIn = 6 * 3600;
      const before = claudeRenewals.count;
      const given = await m.box(office);
      assert.equal(claudeRenewals.count - before, 1, `${name}: renewed with seven hours of access left, because the refresh token had twenty minutes`);
      assert.match(given.answer.accounts[0].items.find((/** @type {any} */ i) => i.name === 'claude').value, /^sk-ant-oat01-renewed/);
      const tested = await m.phone({ op: 'test', name: 'claude' });
      assert.ok(tested.text.includes(until), `${name}: ${tested.text}`);
    } finally {
      claudeRenewals.refreshExpiresIn = undefined;
      t.mock.timers.reset();
    }
  }
});

test('the check renews a kept sign-in only when it is due, not ten minutes after keeping and hourly', async (t) => {
  // It renewed ten minutes after keeping and hourly after that, and each of
  // those renewals ended the access token every box held, outside the half
  // hour in which the boxes change over together.
  const m = await minter();
  t.after(m.restore);
  const start = Date.now();
  assert.equal((await m.phone({ op: 'put', name: 'claude', signIn: claudeSignInFor('early') })).ok, true);
  /** The check `minutes` after keeping, past the minter's own ten-minute floor. @param {number} minutes */
  const checkAt = async (minutes) => {
    t.mock.timers.enable({ apis: ['Date'], now: start + minutes * 60_000 });
    try {
      m.rows.delete('claude-checked');
      return await m.binding.claude('check', {});
    } finally {
      t.mock.timers.reset();
    }
  };
  const before = claudeRenewals.count;
  for (const minutes of [11, 72, 200, 420]) {
    assert.deepEqual((await checkAt(minutes)).ended, []);
    assert.equal(claudeRenewals.count, before, `not renewed ${minutes} minutes after keeping, with its access token still good`);
  }
  // Inside the half hour before its eight hours run out, it is due.
  assert.deepEqual((await checkAt(8 * 60 - 20)).ended, []);
  assert.equal(claudeRenewals.count - before, 1, 'renewed once it was due');
});

test('a renewal that does not say how long the new refresh token lasts is not timed by the old one', async (t) => {
  // The old expiry was carried over onto the rotated token, so once it was
  // inside the half hour every box's ask renewed again.
  const m = await minter();
  t.after(m.restore);
  const office = await generateKeyPair();
  const made = /** @type {any} */ (claudeSignInFor('carried'));
  made.oauth.refreshTokenExpiresAt = Date.now() + 20 * 60_000;
  assert.equal((await m.phone({ op: 'put', name: 'claude', signIn: made })).ok, true);
  await m.phone({ op: 'grant', hostKey: office.publicJwk, label: 'office' });
  const before = claudeRenewals.count;
  await m.box(office);
  assert.equal(claudeRenewals.count - before, 1, 'renewed: its refresh token had twenty minutes');
  await m.box(office);
  await m.box(office);
  assert.equal(claudeRenewals.count - before, 1, 'the new refresh token is not due just because the old one was');
});

test('a refresh token a renewal gave back unchanged keeps its expiry, and is not renewed again for it', async (t) => {
  // Dropping the expiry of a token that was kept called a refusal after it
  // "ended outside the fleet"; renewing again for it would cut every box off
  // on every ask, since renewing cannot move it.
  const m = await minter();
  t.after(m.restore);
  t.after(() => { claudeRenewals.rotate = true; });
  const office = await generateKeyPair();
  const made = /** @type {any} */ (claudeSignInFor('kept-refresh'));
  const refreshUntil = Date.now() + 20 * 60_000;
  made.oauth.refreshTokenExpiresAt = refreshUntil;
  assert.equal((await m.phone({ op: 'put', name: 'claude', signIn: made })).ok, true);
  await m.phone({ op: 'grant', hostKey: office.publicJwk, label: 'office' });
  claudeRenewals.rotate = false;
  const before = claudeRenewals.count;
  await m.box(office);
  assert.equal(claudeRenewals.count - before, 1, 'renewed: its refresh token had twenty minutes');
  await m.box(office);
  await m.box(office);
  assert.equal(claudeRenewals.count - before, 1, 'not again for a refresh token renewing cannot move');
  const notes = await m.rows.get([...m.rows.keys()].find((k) => k.startsWith('claude-renewed:')));
  assert.equal(notes.at(-1).refreshUntil, refreshUntil, 'the expiry of the refresh token it kept is still known');
});

test('a new refresh token that ends as soon as the old one is not renewed again for it', async (t) => {
  // A rotated answer that gave a refresh token under half an hour renewed on
  // every ask, as an unchanged one did.
  const m = await minter();
  t.after(m.restore);
  t.after(() => { claudeRenewals.refreshExpiresIn = undefined; });
  const office = await generateKeyPair();
  const made = /** @type {any} */ (claudeSignInFor('short-session'));
  made.oauth.refreshTokenExpiresAt = Date.now() + 20 * 60_000;
  assert.equal((await m.phone({ op: 'put', name: 'claude', signIn: made })).ok, true);
  await m.phone({ op: 'grant', hostKey: office.publicJwk, label: 'office' });
  claudeRenewals.refreshExpiresIn = 15 * 60;
  const before = claudeRenewals.count;
  await m.box(office);
  await m.box(office);
  await m.box(office);
  assert.equal(claudeRenewals.count - before, 1, 'once: a second renewal would not move it either');
});

test('a 401 is renewed for once and the new token tried at once; refused again, it is told once and not renewed for again', async (t) => {
  // A refusal that stayed forced a renewal at every check, and each one ended
  // the token every box held, for nothing.
  const m = await minter();
  t.after(m.restore);
  const start = Date.now();
  const made = claudeSignInFor('refused-twice');
  assert.equal((await m.phone({ op: 'put', name: 'claude', signIn: made })).ok, true);
  /** The check `minutes` after keeping, past the minter's own ten-minute floor. @param {number} minutes */
  const checkAt = async (minutes) => {
    t.mock.timers.enable({ apis: ['Date'], now: start + minutes * 60_000 });
    try {
      m.rows.delete('claude-checked');
      return await m.binding.claude('check', {});
    } finally {
      t.mock.timers.reset();
    }
  };
  revokeClaude(made.oauth.accessToken);
  // The token the next renewal will give is refused too.
  revokeClaude(`sk-ant-oat01-renewed${claudeRenewals.count + 1}-${'b'.repeat(40)}`);
  const before = claudeRenewals.count;
  const first = await checkAt(11);
  assert.equal(claudeRenewals.count - before, 1, 'renewed once, because its access token was refused');
  assert.deepEqual(first.ended, [], 'renewing works, so it is not ended');
  assert.equal(first.refused.length, 1, 'told at once: the renewed token was tried in the same check');
  assert.deepEqual([first.refused[0].status, first.refused[0].renewed, first.refused[0].email], [401, true, 'eli@example.com']);
  for (const minutes of [27, 43, 120]) {
    const later = await checkAt(minutes);
    assert.deepEqual([later.ended, later.refused], [[], []], `told once (${minutes} minutes)`);
  }
  assert.equal(claudeRenewals.count - before, 1, 'not renewed for it again');
});

test('a renewal that mends a 401 says nothing, and a later 401 is renewed for once more', async (t) => {
  // Deciding "renewing will not mend it" from a refusal hours later, not
  // from the token the renewal gave, told a person something false.
  const m = await minter();
  t.after(m.restore);
  const start = Date.now();
  const made = claudeSignInFor('mended');
  assert.equal((await m.phone({ op: 'put', name: 'claude', signIn: made })).ok, true);
  /** @param {number} minutes */
  const checkAt = async (minutes) => {
    t.mock.timers.enable({ apis: ['Date'], now: start + minutes * 60_000 });
    try {
      m.rows.delete('claude-checked');
      return await m.binding.claude('check', {});
    } finally {
      t.mock.timers.reset();
    }
  };
  revokeClaude(made.oauth.accessToken);
  const before = claudeRenewals.count;
  const first = await checkAt(11);
  assert.deepEqual([first.ended, first.refused], [[], []], 'the renewed token works');
  assert.equal(claudeRenewals.count - before, 1);
  revokeClaude(`sk-ant-oat01-renewed${claudeRenewals.count}-${'b'.repeat(40)}`);
  const later = await checkAt(180);
  assert.deepEqual([later.ended, later.refused], [[], []]);
  assert.equal(claudeRenewals.count - before, 2, 'a new refusal is renewed for once more');
});

test('a 403 is never renewed for, and is told to its person once for the sign-in', async (t) => {
  // A 403 says the sign-in may not do this, not that the token ran out:
  // renewing does not change it, and each renewal ends every box's token.
  const m = await minter();
  t.after(m.restore);
  const start = Date.now();
  const made = claudeSignInFor('forbidden');
  assert.equal((await m.phone({ op: 'put', name: 'claude', signIn: made })).ok, true);
  /** @param {number} minutes */
  const checkAt = async (minutes) => {
    t.mock.timers.enable({ apis: ['Date'], now: start + minutes * 60_000 });
    try {
      m.rows.delete('claude-checked');
      return await m.binding.claude('check', {});
    } finally {
      t.mock.timers.reset();
    }
  };
  forbidClaude(made.oauth.accessToken);
  const before = claudeRenewals.count;
  const first = await checkAt(11);
  assert.equal(first.refused.length, 1);
  assert.deepEqual([first.refused[0].status, first.refused[0].renewed], [403, false]);
  for (const minutes of [27, 43, 120]) assert.deepEqual((await checkAt(minutes)).refused, [], `told once (${minutes} minutes)`);
  assert.equal(claudeRenewals.count - before, 0, 'never renewed for a 403');
});

test('a refusal after the refresh token ran out by its own lifetime is this fleet being late, not anything outside it', () => {
  const kept = Date.parse('2026-10-25T18:19:00Z');
  const good = { at: Date.parse('2026-10-25T18:30:00Z'), by: 'a check', ok: true, until: Date.parse('2026-10-26T02:30:00Z'), refreshUntil: Date.parse('2026-10-26T00:30:00Z') };
  const refused = { at: Date.parse('2026-10-26T02:00:00Z'), by: 'a box', ok: false, refused: true, why: 'Claude refused to renew it (Refresh token not found or invalid)' };
  assert.deepEqual(renewalVerdict([good, refused]), { kind: 'expired', at: good.refreshUntil });
  const told = describeRenewals([good, refused], kept, Date.parse('2026-10-26T02:05:00Z'));
  assert.match(told, /Its refresh token ran out at 00:30 UTC, the lifetime Anthropic gave it, before anything renewed it\./);
  assert.doesNotMatch(told, /outside the fleet/);
  // Still good when refused: something else ended it.
  assert.equal(renewalVerdict([{ ...good, refreshUntil: Date.parse('2026-10-27T00:00:00Z') }, refused])?.kind, 'outside');
});

// ── Members' vaults (docs/members.md) ───────────────────────────────────────

/**
 * A minter with Eli and Dana signed in on a phone each, a signing key filed
 * for each (which is what makes an address somebody's here), and Eli the
 * organization's first admin. `at` hands out request times in order, since
 * the tree refuses a change not newer than the one it holds.
 */
async function orgMinter(/** @type {import('node:test').TestContext} */ t) {
  const m = await minter();
  t.after(m.restore);
  let clock = Date.now() - 60_000;
  const at = () => (clock += 10);
  /** @param {string} person @param {Record<string, unknown>} body @param {Record<string, unknown>} [o] */
  const as = (person, body, o = {}) => m.phone(body, { person, at: at(), ...o });
  for (const person of [ELI, DANA]) {
    assert.equal((await as(person, { op: 'devicekey', key: (await generateKeyPair()).publicJwk, label: 'a phone' })).ok, true);
  }
  assert.equal((await as(ELI, { op: 'orgadmin', address: ELI }, { admin: true })).ok, true);
  /** Eli, Dana under Eli, and the agent Debbie under Dana, as Eli files them. */
  const tree = async () => {
    assert.equal((await as(ELI, { op: 'orgmember', id: 'eli', kind: 'person', address: ELI })).ok, true);
    assert.equal((await as(ELI, { op: 'orgmember', id: 'dana', kind: 'person', address: DANA, reportsTo: 'eli' })).ok, true);
    assert.equal((await as(ELI, { op: 'orgmember', id: 'debbie', kind: 'agent', reportsTo: 'dana' })).ok, true);
  };
  return { m, as, tree };
}

test('the first org admin files themselves, only with the fleet’s word and a key of their own, and the last one stays', async (t) => {
  const m = await minter();
  t.after(m.restore);
  // No signing key filed: the address is nobody's here yet, whatever the coordinator says.
  const unbound = await m.phone({ op: 'orgadmin', address: ELI }, { admin: true });
  assert.equal(unbound.error?.code, 'not_bound');
  assert.equal((await m.phone({ op: 'devicekey', key: (await generateKeyPair()).publicJwk, label: 'iPhone' })).ok, true);
  // Bound, and the coordinator does not say they administer the fleet.
  assert.equal((await m.phone({ op: 'orgadmin', address: ELI }, { admin: false })).error?.code, 'not_admin');
  assert.equal((await m.phone({ op: 'orgadmin', address: ELI })).error?.code, 'not_admin');
  // Nor somebody else in their name.
  assert.equal((await m.phone({ op: 'orgadmin', address: DANA }, { admin: true })).error?.code, 'not_admin');
  const first = await m.phone({ op: 'orgadmin', address: ELI }, { admin: true });
  assert.equal(first.ok, true, first.text);
  assert.deepEqual(first.answer.admins, [ELI]);

  // AFTER THAT THE COORDINATOR'S WORD GIVES NOTHING: Dana, vouched for as an
  // admin, is not one here, and is added only once her address is hers.
  assert.equal((await m.phone({ op: 'devicekey', key: (await generateKeyPair()).publicJwk, label: 'Pixel' }, { person: DANA })).ok, true);
  assert.equal((await m.phone({ op: 'orgadmin', address: DANA }, { person: DANA, admin: true })).error?.code, 'not_admin');
  assert.equal((await m.phone({ op: 'orgadmin', address: 'nobody@example.com' })).error?.code, 'not_bound');
  assert.equal((await m.phone({ op: 'orgadmin', address: ELI, remove: true })).error?.code, 'last_admin');
  assert.equal((await m.phone({ op: 'orgadmin', address: DANA })).ok, true);
  assert.equal((await m.phone({ op: 'orgadmin', address: ELI, remove: true }, { person: DANA })).ok, true);
  const seen = await m.phone({ op: 'org' });
  assert.deepEqual(seen.answer.admins, [DANA]);
  assert.deepEqual(seen.answer.you, { admin: false, bound: true });
});

test('the tree is changed by an org admin anywhere and by a manager inside their own team, and not by replay', async (t) => {
  const { m, as, tree } = await orgMinter(t);
  await tree();
  // Eli filed Debbie, so he is its first custodian; Dana manages it by the tree.
  const seen = (await as(DANA, { op: 'org' })).answer;
  assert.deepEqual(seen.members.find((/** @type {any} */ x) => x.id === 'debbie'), { id: 'debbie', kind: 'agent', reportsTo: 'dana', managers: [], custodians: [ELI], may: [ELI, DANA] });
  assert.deepEqual(seen.members.find((/** @type {any} */ x) => x.id === 'dana').may, [DANA], 'a person is theirs alone until they allow it');
  assert.deepEqual(seen.you, { admin: false, bound: true });

  // A MANAGER, inside her team: a new member under hers, and a move within it.
  const filed = await as(DANA, { op: 'orgmember', id: 'jason', kind: 'agent', reportsTo: 'debbie' });
  assert.equal(filed.ok, true, filed.text);
  assert.deepEqual(filed.answer.may, [DANA, ELI], 'whoever files an agent is its first custodian');
  assert.equal((await as(DANA, { op: 'orgmember', id: 'jason', kind: 'agent', reportsTo: 'dana' })).ok, true);
  // AND REFUSED AT ITS EDGE: out of the team, a root, her own place, her manager's, extra managers.
  for (const [body, code] of /** @type {Array<[any, string]>} */ ([
    [{ id: 'jason', kind: 'agent', reportsTo: null }, 'not_manager'],
    [{ id: 'jason', kind: 'agent', reportsTo: 'eli' }, 'not_manager'],
    [{ id: 'solo', kind: 'agent' }, 'not_manager'],
    [{ id: 'dana', kind: 'person', address: DANA, reportsTo: null }, 'not_manager'],
    [{ id: 'eli', kind: 'person', address: ELI, reportsTo: 'dana' }, 'not_manager'],
    [{ id: 'debbie', kind: 'agent', reportsTo: 'dana', managers: ['friend@example.com'] }, 'not_admin'],
    [{ id: 'jason', remove: true, kind: 'agent' }, undefined],
  ])) {
    const r = await as(DANA, { op: 'orgmember', ...body });
    assert.equal(r.error?.code, code, JSON.stringify(body));
  }
  // The tree's own rules hold for an admin too.
  assert.match((await as(ELI, { op: 'orgmember', id: 'eli', kind: 'person', address: ELI, reportsTo: 'debbie' })).text, /already reports up to eli/);
  assert.match((await as(ELI, { op: 'orgmember', id: 'debbie', kind: 'person', address: 'd@example.com' })).text, /does not change kind/);
  assert.equal((await as(ELI, { op: 'orgmember', id: 'dana', remove: true })).error?.code, 'has_reports');
  // A change older than the one held is a replay, and so is a removed member's older add.
  const old = Date.now() - 5 * 60_000;
  assert.equal((await m.phone({ op: 'orgmember', id: 'debbie', kind: 'agent', reportsTo: null }, { at: old })).error?.code, 'stale');
  assert.equal((await m.phone({ op: 'orgmember', id: 'jason', kind: 'agent', reportsTo: 'debbie' }, { at: old })).error?.code, 'stale');
});

test('custody of an agent follows the tree at once, and its own custodians are changed only by one of them', async (t) => {
  const { as, tree } = await orgMinter(t);
  await tree();
  // Dana manages Debbie, so she opens its vault. A member the vault has not been told about opens for nobody.
  assert.equal((await as(DANA, { op: 'list', for: 'debbie' })).ok, true);
  assert.equal((await as(DANA, { op: 'list', for: 'ghost' })).error?.code, 'no_member');
  // MOVED OUT OF HER TEAM: her custody ends with the change, not at some later sweep.
  assert.equal((await as(ELI, { op: 'orgmember', id: 'debbie', kind: 'agent', reportsTo: 'eli' })).ok, true);
  const out = await as(DANA, { op: 'list', for: 'debbie' });
  assert.equal(out.error?.code, 'not_custodian');
  assert.match(out.text, /They are eli@example.com; one of them can add you/);
  assert.equal((await as(DANA, { op: 'put', name: 'secret:TOKEN', value: 'x', for: 'debbie' })).error?.code, 'not_custodian');
  // And she cannot name herself.
  assert.equal((await as(DANA, { op: 'custodian', member: 'debbie', address: DANA })).error?.code, 'not_custodian');

  // A CUSTODIAN ADDS ONE, who then holds it whatever the tree says.
  assert.equal((await as(ELI, { op: 'custodian', member: 'debbie', address: 'nobody@example.com' })).error?.code, 'not_bound');
  assert.equal((await as(ELI, { op: 'custodian', member: 'debbie', address: DANA })).ok, true);
  assert.equal((await as(DANA, { op: 'list', for: 'debbie' })).ok, true);
  // The last one stays; with two, either removes the other.
  assert.equal((await as(DANA, { op: 'custodian', member: 'debbie', address: ELI, remove: true })).ok, true);
  assert.equal((await as(DANA, { op: 'custodian', member: 'debbie', address: DANA, remove: true })).error?.code, 'last_custodian');
  // Eli still manages it by the tree (it reports to him), and that custody is the tree's to end.
  assert.equal((await as(ELI, { op: 'list', for: 'debbie' })).ok, true);
  assert.match((await as(DANA, { op: 'custodian', member: 'debbie', address: ELI, remove: true })).text, /comes from the tree/);
  assert.match((await as(ELI, { op: 'custodian', member: 'dana', address: ELI })).text, /Nobody is made a custodian of a person after whoever added them/);
});

test('a custodian keeps things in the member’s vault and not their own, and a box is given it only when approved for it and able to file it', async (t) => {
  const { m, as, tree } = await orgMinter(t);
  await tree();
  const kept = await as(ELI, { op: 'put', name: 'claude', value: `sk-ant-oat01-${'d'.repeat(40)}`, for: 'debbie' });
  assert.equal(kept.ok, true, kept.text);
  assert.match(kept.text, /Kept debbie’s Claude login/);
  assert.equal((await as(DANA, { op: 'put', name: 'secret:DEPLOY_KEY', value: 'debbie-deploy', for: 'debbie' })).ok, true);
  assert.equal((await as(ELI, { op: 'put', name: 'secret:MINE', value: 'elis-own' })).ok, true);
  // FILED UNDER THE MEMBER'S PRINCIPAL, and nothing of it under either custodian.
  assert.ok(m.rows.get('gh:member:debbie')?.sealed);
  assert.equal(m.rows.get('gh:42'), undefined, 'Eli’s own vault holds no Claude login');
  assert.deepEqual(Object.keys(m.rows.get('v:member:debbie').items), ['secret:DEPLOY_KEY']);
  assert.deepEqual((await as(ELI, { op: 'list', for: 'debbie' })).answer.items.map((/** @type {any} */ i) => i.name), ['claude', 'secret:DEPLOY_KEY']);
  assert.deepEqual((await as(ELI, { op: 'list' })).answer.items.map((/** @type {any} */ i) => i.name), ['secret:MINE']);
  // A provider nobody has heard of is not something a vault keeps.
  const key = await as(ELI, { op: 'put', name: 'apikey:nobody', value: 'sk-nobody-0123456789abcdef', for: 'debbie' });
  assert.equal(key.error?.code, 'bad_name');
  // A custodian holds the vault's items and machines, and none of what is a person's alone.
  assert.equal((await as(ELI, { op: 'custody', allow: true, for: 'debbie' })).error?.code, 'bad_params');

  // APPROVED PER VAULT: this box for Debbie's, and for nothing of Eli's.
  const boxKeys = await generateKeyPair();
  const granted = await as(ELI, { op: 'grant', hostKey: boxKeys.publicJwk, label: 'ops-box', for: 'debbie' });
  assert.equal(granted.ok, true, granted.text);
  assert.equal(m.rows.get('v:42').grants[await boxKeyHash(boxKeys.publicJwk)], undefined);
  // A box from before members is handed none, which it would file under no name.
  assert.deepEqual((await m.box(boxKeys, { members: [ELI, DANA] })).answer.accounts, []);
  const given = await m.box(boxKeys, { members: [ELI, DANA], accepts: ['members'] });
  assert.equal(given.ok, true, given.text);
  assert.equal(given.answer.accounts.length, 1);
  const account = given.answer.accounts[0];
  assert.deepEqual({ email: account.email, principal: account.principal, member: account.member }, { email: '', principal: 'member:debbie', member: 'debbie' });
  assert.deepEqual(account.items.map((/** @type {any} */ i) => [i.name, i.value]), [['secret:DEPLOY_KEY', 'debbie-deploy'], ['claude', `sk-ant-oat01-${'d'.repeat(40)}`]]);
  assert.doesNotMatch(JSON.stringify(given.answer), /elis-own/);
  // Served while somebody who may act for it is in the fleet, and not after.
  assert.equal((await m.box(boxKeys, { members: [DANA], accepts: ['members'] })).answer.accounts.length, 1);
  assert.deepEqual((await m.box(boxKeys, { members: ['someone-else@example.com'], accepts: ['members'] })).answer.accounts, []);
  // `accepts` is signed with the rest: adding it on the way is a bad signature.
  const reply = await newSealKey();
  const request = { v: 1, hostKey: { kty: 'EC', crv: 'P-256', x: boxKeys.publicJwk.x, y: boxKeys.publicJwk.y }, at: Date.now(), reply: reply.publicKey };
  const signature = await sign(boxKeys.privateJwk, signingInput('vault-box', request));
  assert.equal((await m.binding.vault('box', { request: { ...request, accepts: ['members'] }, signature, members: [ELI] })).error?.code, 'bad_signature');
  // Removed from the box, by a custodian.
  assert.equal((await as(DANA, { op: 'revoke', key: await boxKeyHash(boxKeys.publicJwk), for: 'debbie' })).ok, true);
  assert.deepEqual((await m.box(boxKeys, { members: [ELI, DANA], accepts: ['members'] })).answer.accounts, []);
});

test('a member’s API key is kept, never read back, and handed only to a box that asks for keys', async (t) => {
  // docs/api-engines.md, "The key".
  const { m, as, tree } = await orgMinter(t);
  await tree();
  const put = (/** @type {string} */ name, /** @type {string} */ value) => as(ELI, { op: 'put', name, value, for: 'debbie' });
  // What is not a key is refused in words; a provider nobody has heard of is not something a vault keeps.
  assert.match((await put('apikey:openrouter', 'two words')).text, /That is not an API key: one is a single run of letters, digits and punctuation with no spaces/);
  assert.equal((await put('apikey:openrouter', 'short')).error?.code, 'bad_value');
  assert.equal((await put('apikey:acme', 'sk-acme-0123456789abcdef')).error?.code, 'bad_name');
  const kept = await put('apikey:openrouter', '  sk-or-v1-0123456789abcdef\n');
  assert.equal(kept.ok, true, kept.text);
  assert.equal(kept.text, 'Kept the OpenRouter API key. It is given only to approved machines whose operator turned that provider on, for sessions whose engine bills to it. What it may spend is set at the provider, not here.');
  assert.equal((await put('apikey:ai-gateway', 'vck_0123456789abcdef')).ok, true);
  const listed = (await as(ELI, { op: 'list', for: 'debbie' })).answer;
  assert.deepEqual(listed.items.map((/** @type {any} */ i) => i.name), ['apikey:ai-gateway', 'apikey:openrouter']);
  assert.ok(!JSON.stringify(listed).includes('sk-or-v1'), 'listed by name, never by value');
  const tested = await as(ELI, { op: 'test', name: 'apikey:openrouter', for: 'debbie' });
  assert.equal(tested.answer?.state, 'unknown');
  assert.match(tested.text, /^the OpenRouter API key is not tried from here\./);

  const box = await generateKeyPair();
  assert.equal((await as(ELI, { op: 'grant', hostKey: box.publicJwk, label: 'box-one', for: 'debbie' })).ok, true);
  const names = (/** @type {any} */ r) => (r.answer.accounts[0]?.items ?? []).map((/** @type {any} */ i) => i.name).sort();
  // A BOX FROM STEP 4 takes sign-ins and not keys: it is handed nothing that bills.
  assert.deepEqual(names(await m.box(box, { members: [ELI], accepts: ['engines', 'members'] })), []);
  // Keys alone are not enough either: they are an engine's, and a box that takes no engines has no use for one.
  assert.deepEqual(names(await m.box(box, { members: [ELI], accepts: ['apikeys', 'members'] })), []);
  const given = await m.box(box, { members: [ELI], accepts: ['apikeys', 'engines', 'members'] });
  assert.deepEqual(names(given), ['apikey:ai-gateway', 'apikey:openrouter']);
  assert.equal(given.answer.accounts[0].items.find((/** @type {any} */ i) => i.name === 'apikey:openrouter').value, 'sk-or-v1-0123456789abcdef', 'trimmed, and whole');
  // Forgotten, it is gone from the next answer.
  assert.equal((await as(ELI, { op: 'forget', name: 'apikey:openrouter', for: 'debbie' })).ok, true);
  assert.deepEqual(names(await m.box(box, { members: [ELI], accepts: ['apikeys', 'engines', 'members'] })), ['apikey:ai-gateway']);
});

test('a sandbox provider’s key is kept with the templates to offer, never read back, and handed only to a box that asks for sandboxes', async (t) => {
  // docs/api-engines.md, "The item".
  const m = await minter();
  t.after(m.restore);
  const KEY = 'e2b_0123456789abcdef0123456789abcdef';
  const record = (/** @type {any} */ templates) => JSON.stringify({ key: KEY, templates });
  const linux = [{ id: 'fleetwright-linux', name: 'Linux, with the fleet' }];
  // WHAT IS NOT ONE IS REFUSED IN WORDS: not a record, a provider nobody
  // has heard of, and a key with nothing to make a machine from.
  assert.match((await m.phone({ op: 'put', name: 'sandbox:e2b', value: KEY })).text, /it is the provider’s API key and the templates to offer, each an id and a name/);
  assert.equal((await m.phone({ op: 'put', name: 'sandbox:acme', value: record(linux) })).error?.code, 'bad_name');
  const none = await m.phone({ op: 'put', name: 'sandbox:e2b', value: record([]) });
  assert.equal(none.error?.code, 'bad_value');
  assert.match(none.text, /kept with at least one template to offer/);
  // WHAT IS KEPT IS WHAT WAS SENT. A template the vault would have to leave
  // out, a list it would have to cut, or a key that is not one, is refused
  // saying which, and never answered with "Kept".
  const said = async (/** @type {string} */ value) => (await m.phone({ op: 'put', name: 'sandbox:e2b', value })).text;
  assert.match(await said(record([...linux, { id: 'has space', name: 'x' }])), /^“has space” is not a template’s id/);
  assert.match(await said(record(Array.from({ length: 13 }, (_, i) => ({ id: `t${i}`, name: `T${i}` })))), /at most 12 templates, and that is 13/);
  assert.match(await said(record([{ id: 'fleetwright-linux', name: 'n'.repeat(61) }])), /name for fleetwright-linux is too long/);
  assert.match(await said(record([...linux, ...linux])), /listed twice/);
  assert.match(await said(JSON.stringify({ key: 'short', templates: linux })), /^That is not a provider’s API key/);
  assert.ok(!(await m.phone({ op: 'list' })).answer.items.some((/** @type {any} */ i) => i.name === 'sandbox:e2b'), 'none of those was kept');

  const kept = await m.phone({ op: 'put', name: 'sandbox:e2b', value: record(linux) });
  assert.equal(kept.ok, true, kept.text);
  assert.equal(kept.text, 'Kept your E2B account’s key and templates. Approved machines whose operator turned that provider on can make machines there, and hold its key in memory only. The key is that whole account: what it may spend is set at the provider.');
  assert.ok(![...m.rows.values()].some((v) => JSON.stringify(v).includes(KEY)), 'sealed at rest');
  const listed = (await m.phone({ op: 'list' })).answer;
  assert.ok(listed.items.some((/** @type {any} */ i) => i.name === 'sandbox:e2b'));
  assert.ok(!JSON.stringify(listed).includes(KEY), 'listed by name, never by value');

  const box = await generateKeyPair();
  assert.equal((await m.phone({ op: 'grant', hostKey: box.publicJwk, label: 'box-one' })).ok, true);
  const names = (/** @type {any} */ r) => (r.answer.accounts[0]?.items ?? []).map((/** @type {any} */ i) => i.name);
  // A BOX FROM BEFORE THIS, and one whose operator turned no provider on,
  // says nothing about sandboxes and is handed no provider's account.
  assert.deepEqual(names(await m.box(box)), []);
  assert.deepEqual(names(await m.box(box, { accepts: ['apikeys', 'engines', 'members'] })), []);
  const given = await m.box(box, { accepts: ['sandboxes'] });
  assert.deepEqual(names(given), ['sandbox:e2b']);
  assert.deepEqual(JSON.parse(given.answer.accounts[0].items[0].value), { key: KEY, templates: linux });
  // Forgotten, it is gone from the next answer.
  assert.equal((await m.phone({ op: 'forget', name: 'sandbox:e2b' })).ok, true);
  assert.deepEqual(names(await m.box(box, { accepts: ['sandboxes'] })), []);
});

test('a member’s Codex sign-in and Copilot token are kept, handed only to a box that takes them, and the Codex one to one machine', async (t) => {
  // docs/engines.md, "Credentials".
  const { m, as, tree } = await orgMinter(t);
  await tree();
  const signIn = JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'i', access_token: 'a', refresh_token: 'r-1', account_id: 'acct' }, last_refresh: '2026-11-24T00:00:00Z' });
  const put = (/** @type {string} */ name, /** @type {string} */ value) => as(ELI, { op: 'put', name, value, for: 'debbie' });

  // WHAT IS NOT ONE IS REFUSED IN WORDS THAT SAY WHAT IS.
  assert.match((await put('codex', 'not json')).text, /does not read as JSON\. Paste the whole file/);
  assert.match((await put('codex', JSON.stringify({ OPENAI_API_KEY: 'sk-x' }))).text, /holds an API key and no ChatGPT sign-in\. For Codex a vault keeps the sign-in that codex login makes, and no OpenAI key\./);
  assert.match((await put('codex', JSON.stringify({ tokens: {} }))).text, /holds no ChatGPT sign-in\. Run codex login/);
  assert.match((await put('copilot', 'two words')).text, /not a GitHub Copilot token/);
  const kept = await put('codex', signIn);
  assert.equal(kept.ok, true, kept.text);
  assert.match(kept.text, /handed to one approved machine, the first that asks/);
  assert.equal((await put('copilot', `  ${'gho_'}${'c'.repeat(36)}\n`)).ok, true);
  // Listed by name, never read back; and not tried from the vault, said as that.
  const listed = (await as(ELI, { op: 'list', for: 'debbie' })).answer;
  assert.deepEqual(listed.items.map((/** @type {any} */ i) => i.name), ['codex', 'copilot']);
  assert.ok(!JSON.stringify(listed).includes('r-1'));
  const tested = await as(ELI, { op: 'test', name: 'codex', for: 'debbie' });
  assert.equal(tested.answer?.state, 'unknown');
  assert.match(tested.text, /is not tried from here\. The machine that runs the engine asks whether it is signed in before each turn/);

  const one = await generateKeyPair();
  const two = await generateKeyPair();
  for (const [keys, label] of /** @type {const} */ ([[one, 'box-one'], [two, 'box-two']])) {
    assert.equal((await as(ELI, { op: 'grant', hostKey: keys.publicJwk, label, for: 'debbie' })).ok, true);
  }
  const names = (/** @type {any} */ r) => (r.answer.accounts[0]?.items ?? []).map((/** @type {any} */ i) => i.name).sort();
  // A box that takes members and not engines is handed neither.
  assert.deepEqual(names(await m.box(one, { members: [ELI], accepts: ['members'] })), []);
  // THE FIRST THAT ASKS HOLDS THE CODEX SIGN-IN; the second gets the token that does not rotate, and is told why not the other.
  const first = await m.box(two, { members: [ELI], accepts: ['engines', 'members'] });
  assert.deepEqual(names(first), ['codex', 'copilot']);
  assert.equal(first.answer.accounts[0].items.find((/** @type {any} */ i) => i.name === 'codex').value, signIn);
  const second = await m.box(one, { members: [ELI], accepts: ['engines', 'members'] });
  assert.deepEqual(names(second), ['copilot']);
  assert.match(second.answer.accounts[0].problems.join(' '), /The Codex sign-in is held by box-two, and a sign-in is held by one machine\. Deposit it again to move it here\./);
  assert.equal((await as(ELI, { op: 'list', for: 'debbie' })).answer.items.find((/** @type {any} */ i) => i.name === 'codex').heldBy, 'box-two');
  // And still the same one on the next ask.
  assert.deepEqual(names(await m.box(two, { members: [ELI], accepts: ['engines', 'members'] })), ['codex', 'copilot']);

  // DEPOSITED AGAIN, it is nobody's until a machine asks, and then that machine's.
  const again = signIn.replace('r-1', 'r-2');
  assert.equal((await put('codex', again)).ok, true);
  assert.equal((await as(ELI, { op: 'list', for: 'debbie' })).answer.items.find((/** @type {any} */ i) => i.name === 'codex').heldBy, undefined);
  assert.deepEqual(names(await m.box(one, { members: [ELI], accepts: ['engines', 'members'] })), ['codex', 'copilot']);
  assert.deepEqual(names(await m.box(two, { members: [ELI], accepts: ['engines', 'members'] })), ['copilot']);
});

test('two boxes asking at once renew a member’s refresh token once, under the member’s own lock', async (t) => {
  const { m, as, tree } = await orgMinter(t);
  await tree();
  // A member's GitHub sign-in is whichever account its custodians choose: there is no "same person" to hold it to.
  const connected = await as(ELI, { op: 'connect', provider: 'github', code: 'goodcode123', verifier: 'v'.repeat(64), redirectUri: 'https://fleet.test/oauth/github/callback', for: 'debbie' });
  assert.equal(connected.ok, true, connected.text);
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  await as(ELI, { op: 'grant', hostKey: a.publicJwk, label: 'a', for: 'debbie' });
  await as(ELI, { op: 'grant', hostKey: b.publicJwk, label: 'b', for: 'debbie' });
  const before = m.calls.refresh;
  const [one, two] = await Promise.all([m.box(a, { accepts: ['members'] }), m.box(b, { accepts: ['members'] })]);
  assert.equal(m.calls.refresh - before, 1, 'one rotation, however many boxes asked');
  for (const r of [one, two]) assert.equal(r.answer.accounts[0].principal, 'member:debbie');
  await m.box(a, { accepts: ['members'] });
  assert.equal(m.calls.refresh - before, 1);
});

test('whoever adds a person the vault has not met manages their credentials, with no switch, and nobody gets that by filing a record for somebody already there', async (t) => {
  // ASKED FOR: "if a manager created the member they should be able to
  // manage it." docs/members.md, "Custodians of a person member".
  const m = await minter();
  t.after(m.restore);
  let clock = Date.now() - 60_000;
  /** @param {string} person @param {Record<string, unknown>} body @param {Record<string, unknown>} [o] */
  const as = (person, body, o = {}) => m.phone(body, { person, at: (clock += 10), ...o });
  const listKey = async (/** @type {string} */ person) => {
    const key = (await generateKeyPair()).publicJwk;
    assert.equal((await as(person, { op: 'devicekey', key, label: 'a phone' })).ok, true);
    return key;
  };
  await listKey(ELI);
  assert.equal((await as(ELI, { op: 'orgadmin', address: ELI }, { admin: true })).ok, true);
  assert.equal((await as(ELI, { op: 'orgmember', id: 'eli', kind: 'person', address: ELI })).ok, true);

  // ELI ADDS DANA, who has never signed in here: he is her custodian, and is told so.
  const added = await as(ELI, { op: 'orgmember', id: 'dana', kind: 'person', address: DANA, reportsTo: 'eli' });
  assert.equal(added.ok, true, added.text);
  assert.equal(added.text, `Filed dana. You added ${DANA}, so you manage their credentials from their first sign-in, and they are shown that before they keep anything. Their other managers wait until ${DANA} allows it.`);
  assert.deepEqual(added.answer.may, [DANA, ELI], 'the list a box checks a start as her against');
  // There is no vault to hold until she has signed in.
  assert.equal((await as(ELI, { op: 'list', for: 'dana' })).error?.code, 'no_vault');

  // SHE SIGNS IN, and is shown who manages what she keeps before she keeps anything.
  const danaKey = await listKey(DANA);
  const first = (await as(DANA, { op: 'list' })).answer.custody;
  assert.deepEqual([first.custodians, first.managers, first.allow], [[ELI], [], false]);
  // NO SWITCH: he keeps, lists and approves a machine for her vault, and she reads what he did.
  const kept = await as(ELI, { op: 'put', name: 'secret:FOR_DANA', value: 'v1', for: 'dana' });
  assert.equal(kept.ok, true, kept.text);
  assert.ok(m.rows.get('v:43').items['secret:FOR_DANA'], 'in her vault and not his');
  assert.deepEqual((await as(DANA, { op: 'list' })).answer.custody.log.map((/** @type {any} */ e) => [e.by, e.op, e.name]), [[ELI, 'put', 'secret:FOR_DANA']]);
  const boxKeys = await generateKeyPair();
  assert.equal((await as(ELI, { op: 'grant', hostKey: boxKeys.publicJwk, label: 'ops-box', for: 'dana' })).ok, true);
  // THE VAULT IS STILL HERS: she forgets what it keeps, and her switch is hers and not his.
  assert.equal((await as(DANA, { op: 'forget', name: 'secret:FOR_DANA' })).ok, true);
  assert.equal((await as(ELI, { op: 'custody', allow: true, for: 'dana' })).error?.code, 'bad_params');
  // Her record filed again later, he is still the one who added her.
  assert.equal((await as(ELI, { op: 'orgmember', id: 'dana', kind: 'person', address: DANA, reportsTo: 'eli' })).ok, true);
  assert.deepEqual((await as(ELI, { op: 'org' })).answer.members.find((/** @type {any} */ x) => x.id === 'dana').custodians, [ELI]);

  // IT ENDS WITH WHOEVER HOLDS IT, OR AN ORG ADMIN, and nobody is added after the first.
  assert.match((await as(ELI, { op: 'custodian', member: 'dana', address: 'sam@example.com' })).text, /Nobody is made a custodian of a person after whoever added them/);
  assert.equal((await as(DANA, { op: 'custodian', member: 'dana', address: ELI, remove: true })).error?.code, 'not_admin', 'not hers to end: she forgets what she keeps instead');
  const gave = await as(ELI, { op: 'custodian', member: 'dana', address: ELI, remove: true });
  assert.equal(gave.text, `${ELI} no longer manages ${DANA}’s credentials. Their managers hold them only once ${DANA} allows it.`);
  assert.equal((await as(ELI, { op: 'list', for: 'dana' })).error?.code, 'custody_not_allowed');
  assert.deepEqual((await as(DANA, { op: 'list' })).answer.custody.custodians, []);

  // SOMEBODY ALREADY HERE IS NOT REACHED BY A RECORD THAT NAMES THEM. Taking
  // her record out and filing it again is the cheapest way to try, and she
  // keeps her own sign-ins by now, so it makes him nothing. Not even in the
  // gap after a lost phone, when no key of hers is listed.
  assert.equal((await as(DANA, { op: 'devicekey', key: danaKey, remove: true })).ok, true);
  assert.equal((await as(ELI, { op: 'orgmember', id: 'dana', remove: true })).ok, true);
  const again = await as(ELI, { op: 'orgmember', id: 'dana', kind: 'person', address: DANA, reportsTo: 'eli' });
  assert.equal(again.text, `Filed dana. ${DANA} already keeps their own sign-ins here, so managing them is theirs to allow, under You › Credentials.`);
  assert.deepEqual(again.answer.may, [DANA]);
  await listKey(DANA);
  assert.equal((await as(ELI, { op: 'list', for: 'dana' })).error?.code, 'custody_not_allowed');
  // And it is whoever adds them, admin or not: a person Dana adds to her own team is hers to manage.
  const sam = await as(DANA, { op: 'orgmember', id: 'sam', kind: 'person', address: 'sam@example.com', reportsTo: 'dana' });
  assert.deepEqual(sam.answer.may, ['sam@example.com', DANA]);

  // NOR BY A RECORD FOR AN ADDRESS THEY HAVE NOT USED YET. Eli keeps his own
  // sign-ins already. Dana, a team lead, files a member at a second address
  // of his before he has listed a key under it. When his account does, the
  // vault has met him, and what he kept is not hers.
  assert.equal((await as(ELI, { op: 'put', name: 'secret:ELIS_OWN', value: 'his' })).ok, true);
  const WORK = 'eli.work@example.com';
  const pre = await as(DANA, { op: 'orgmember', id: 'eli-work', kind: 'person', address: WORK, reportsTo: 'dana' });
  assert.deepEqual(pre.answer.may, [WORK, DANA], 'nobody is there yet, so the record says she added them');
  await listKey(WORK);
  assert.equal((await as(DANA, { op: 'list', for: 'eli-work' })).error?.code, 'custody_not_allowed');
  assert.equal((await as(ELI, { op: 'org' })).answer.members.find((/** @type {any} */ x) => x.id === 'eli-work').custodians.length, 0);
  // A RECORD POINTED AT SOMEBODY ELSE names a different person: Dana, who
  // added Sam, is not thereby the custodian of whoever the record names next.
  const moved = await as(ELI, { op: 'orgmember', id: 'sam', kind: 'person', address: 'pat@example.com', reportsTo: 'dana' });
  assert.deepEqual(moved.answer.may, ['pat@example.com', ELI]);
});

test('a manager holds a person’s vault only once that person allows it, and the person reads what was done', async (t) => {
  const { m, as, tree } = await orgMinter(t);
  await tree();
  // Eli manages Dana by the tree, and she was here before he filed her. Her
  // vault is hers until she says otherwise.
  const before = await as(ELI, { op: 'put', name: 'secret:FOR_DANA', value: 'v1', for: 'dana' });
  assert.equal(before.error?.code, 'custody_not_allowed');
  assert.match(before.text, /has not let their managers manage their credentials/);
  // Nobody but her turns it on: before, he is refused like any other request for her vault.
  assert.equal((await as(ELI, { op: 'custody', allow: true, for: 'dana' })).error?.code, 'custody_not_allowed');
  const on = await as(DANA, { op: 'custody', allow: true });
  assert.equal(on.ok, true, on.text);
  // And after, the switch itself is still hers alone.
  assert.equal((await as(ELI, { op: 'custody', allow: false, for: 'dana' })).error?.code, 'bad_params');
  // Her own request "for" her own member is just her own.
  assert.equal((await as(DANA, { op: 'list', for: 'dana' })).answer.custody.allow, true);

  const kept = await as(ELI, { op: 'put', name: 'secret:FOR_DANA', value: 'v1', for: 'dana' });
  assert.equal(kept.ok, true, kept.text);
  // IN HER VAULT, and she is told: outside the seal for her phone, and beside the vault where she reads it.
  assert.ok(m.rows.get('v:43').items['secret:FOR_DANA']);
  assert.deepEqual(kept.notify, { email: DANA, text: `${ELI} kept secret:FOR_DANA in your vault, as one of your managers.` });
  const hers = (await as(DANA, { op: 'list' })).answer;
  assert.deepEqual(hers.custody.managers, [ELI]);
  assert.equal(hers.custody.member, 'dana');
  assert.deepEqual(hers.custody.log.map((/** @type {any} */ e) => [e.by, e.op, e.name]), [[ELI, 'put', 'secret:FOR_DANA']]);
  // A box he approves for her vault files it under HER address, and is served while SHE is in the fleet.
  const boxKeys = await generateKeyPair();
  assert.equal((await as(ELI, { op: 'grant', hostKey: boxKeys.publicJwk, label: 'ops-box', for: 'dana' })).ok, true);
  assert.equal((await m.box(boxKeys, { members: [ELI, DANA] })).answer.accounts[0].email, DANA);
  assert.deepEqual((await m.box(boxKeys, { members: [ELI] })).answer.accounts, []);
  // Her signing keys and delegations stay hers alone.
  assert.equal((await as(ELI, { op: 'devicekey', key: (await generateKeyPair()).publicJwk, for: 'dana' })).error?.code, 'bad_params');
  // She manages nobody above her: Eli's vault is not hers to open, allowed or not.
  assert.equal((await as(ELI, { op: 'custody', allow: true })).ok, true);
  assert.equal((await as(DANA, { op: 'list', for: 'eli' })).error?.code, 'not_custodian');

  // TURNED OFF, by her: refused again at the next request, and what was kept stays hers.
  assert.equal((await as(DANA, { op: 'custody', allow: false })).ok, true);
  assert.equal((await as(ELI, { op: 'forget', name: 'secret:FOR_DANA', for: 'dana' })).error?.code, 'custody_not_allowed');
  assert.ok(m.rows.get('v:43').items['secret:FOR_DANA'].sealed);
});

test('the signed key list says who may start as each member, and the coordinator’s list can only take away', async (t) => {
  const { m, as, tree } = await orgMinter(t);
  await tree();
  const boxKeys = await generateKeyPair();
  const pinned = (await m.lookup()).signing;
  const listed = async (/** @type {string[]} */ members) => {
    const r = await m.keys(boxKeys, { members });
    assert.equal(r.ok, true, r.text);
    assert.equal(await verify(pinned, r.signature, signingInput('vault-keys-answer', r.payload)), true, 'signed by the key a box pins');
    return r.payload.members;
  };
  assert.deepEqual(await listed([ELI, DANA]), [
    { id: 'dana', kind: 'person', email: DANA, may: [DANA] },
    { id: 'debbie', kind: 'agent', may: [DANA, ELI] },
    { id: 'eli', kind: 'person', email: ELI, may: [ELI] },
  ]);
  // Once Dana allows it, her manager is on her list.
  assert.equal((await as(DANA, { op: 'custody', allow: true })).ok, true);
  assert.deepEqual((await listed([ELI, DANA])).find((/** @type {any} */ x) => x.id === 'dana').may, [DANA, ELI]);
  // Left off the fleet's list, a custodian is on nobody's: the member stays listed, with whoever is left.
  assert.deepEqual((await listed([DANA])).find((/** @type {any} */ x) => x.id === 'debbie').may, [DANA]);
  assert.deepEqual((await listed(['someone-else@example.com'])).find((/** @type {any} */ x) => x.id === 'debbie').may, []);
});

test('a member’s ended sign-in is told to every custodian, on their own phones, and a manager’s change to a person’s vault to that person', async (t) => {
  const { m, as, tree } = await orgMinter(t);
  await tree();
  /** @type {any[]} */
  const sends = [];
  const clock = { now: Date.now() };
  const core = new CoordinatorCore({
    minter: /** @type {any} */ (m.binding),
    push: /** @type {any} */ ({ async send(/** @type {any[]} */ devices, /** @type {any} */ message) { sends.push({ to: devices.map((d) => d.actor), message }); return { sent: devices.length, dead: [] }; } }),
    now: () => clock.now,
  });
  for (const [email, admin, token] of /** @type {Array<[string, boolean, string]>} */ ([[ELI, true, 'a'], [DANA, false, 'b'], ['ops@example.com', true, 'c']])) {
    const { client } = /** @type {any} */ (await core.clients.issue(`phone (${email})`, { admin, email }));
    await core.registerDevice({ platform: 'ios', token: token.repeat(64), clientId: client.id, actor: `fleet:${email}` });
  }
  core.setMember(null, 'debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer' });

  // A whole sign-in in Debbie's vault, then ended on claude.ai.
  const made = claudeSignInFor('debbie-ended');
  assert.equal((await as(ELI, { op: 'put', name: 'claude', signIn: made, for: 'debbie' })).ok, true);
  assert.equal(await core.checkClaudeSignIns(), 0);
  revokeClaude(made.oauth.accessToken);
  cancelClaudeSignIns();
  m.rows.delete('claude-checked');
  clock.now += 16 * 60_000;
  assert.equal(await core.checkClaudeSignIns(), 1);
  assert.equal(sends.length, 1);
  // Its custodians' own phones: Eli and Dana, and not the other admin, who is neither.
  assert.deepEqual(sends[0].to.sort(), [`fleet:${DANA}`, `fleet:${ELI}`]);
  assert.match(sends[0].message.title, /^Debbie’s Claude sign-in /);
  assert.match(sends[0].message.body, /Sign it in to Claude again from your phone or the signing page\./);
  assert.ok(core.events.some((e) => e.event === 'claude.ended' && /^member:debbie: /.test(String(e.text))));

  // AND A MANAGER'S CHANGE TO A PERSON'S VAULT is told to that person alone,
  // through the coordinator's own relay, which also says who administers the fleet.
  sends.length = 0;
  assert.equal((await as(DANA, { op: 'custody', allow: true })).ok, true);
  const reply = await newSealKey();
  const sealed = await seal({ to: (await m.lookup()).key, aad: VAULT_REQUEST_AAD, payload: { v: 1, github: await m.signIn(), email: ELI, at: Date.now(), reply: reply.publicKey, op: 'put', name: 'secret:FROM_ELI', value: 'x', for: 'dana' } });
  const relayed = await core.vaultDevice({ email: ELI, admin: true }, { sealed });
  assert.equal(relayed.ok, true, relayed.text);
  assert.equal('notify' in relayed, false, 'who was told is not handed back to the asker');
  assert.deepEqual(sends.map((s) => [s.to, s.message.title]), [[[`fleet:${DANA}`], 'A manager changed your vault']]);
  assert.match(sends[0].message.body, /eli@example\.com kept secret:FROM_ELI in your vault, as one of your managers\./);
  assert.ok(core.events.some((e) => e.event === 'vault.custody'));
});

test('a box starts a session as a member only for somebody the minter lists, who signed for it, and runs it on the member’s sign-ins', async (t) => {
  // The whole path: the tree and the custodians in the minter, the member in
  // the coordinator, a signed start from a phone, the box's own check, and
  // what it hands the session manager. On a box that takes unsigned work, so
  // every refusal below is the member check's own.
  const { m, core, box, stub, iphone, kid } = await signingFleet(t);
  // Eli's phone listed its key in signingFleet. Dana's lists one now.
  const pixel = await generateKeyPair();
  assert.equal((await m.phone({ op: 'devicekey', key: pixel.publicJwk, label: 'Dana’s Pixel' }, { person: DANA })).ok, true);
  const danaKid = await boxKeyHash({ kty: 'EC', crv: 'P-256', x: pixel.publicJwk.x, y: pixel.publicJwk.y });
  await core.issueClient({ email: DANA }, 'phone');
  let clock = Date.now() - 30_000;
  const filed = async (/** @type {Record<string, unknown>} */ body) => assert.equal((await m.phone(body, { at: (clock += 10), admin: true })).ok, true, JSON.stringify(body));
  await filed({ op: 'orgadmin', address: ELI });
  await filed({ op: 'orgmember', id: 'eli', kind: 'person', address: ELI });
  await filed({ op: 'orgmember', id: 'debbie', kind: 'agent', reportsTo: 'eli' });
  await filed({ op: 'put', name: 'claude', value: `sk-ant-oat01-${'d'.repeat(40)}`, for: 'debbie' });
  assert.equal(core.setMember(null, 'debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer', instructions: 'Write small pull requests.' }).ok, true);

  let n = 0;
  /** A start from a phone. @param {{ who?: string, key?: any, keyId?: string, params: any, unsigned?: boolean }} o */
  const start = async (o) => {
    const who = o.who ?? ELI;
    const id = `member-intent-${String(++n).padStart(4, '0')}`;
    const issuedAt = Date.now();
    const sig = await sign((o.key ?? iphone).privateJwk, intentSigningInput({ actor: who, id, issuedAt, params: o.params, verb: 'start' }, 'ops-box'));
    return core.dispatch({ verb: 'start', params: o.params, id, actor: who, requester: { email: who, admin: false }, preferHost: 'ops-box', ...(o.unsigned ? {} : { sig, kid: o.keyId ?? kid, issuedAt }) });
  };

  // NO LIST YET, so the coordinator passes it on, and the box, which holds none, starts nobody as a member.
  const early = await start({ params: { name: 'too-early', member: 'debbie', task: 'Fix the login bug.' } });
  assert.equal(early.error?.code, 'member_unchecked');
  assert.match(String(early.text), /holds no list from the vault of who may start a session as a member/);
  assert.equal(await box.sidecar.intentKeys?.refresh(), true, box.sidecar.intentKeys?.problem ?? '');
  assert.deepEqual(core.memberCustody?.get('debbie'), [ELI], 'the coordinator read the list on its way to the box');

  // SIGNED BY A CUSTODIAN: started as the member's own account, with the instructions and the task as one first message.
  stub.bodies.length = 0;
  const ok = await start({ params: { name: 'as-debbie', member: 'debbie', task: 'Fix the login bug.' } });
  assert.equal(ok.ok, true, ok.text);
  const sent = stub.bodies.at(-1);
  assert.equal(sent.actor, 'fleet:debbie@members.invalid', 'who it runs as is the member, never the asker');
  assert.equal(sent.startedBy, `fleet:${ELI}`);
  assert.deepEqual([sent.member, sent.memberName, sent.memberRole], ['debbie', 'Debbie', 'software engineer']);
  assert.equal(sent.task, 'Write small pull requests.\n\n----------\n\nFix the login bug.');
  assert.match(String(sent.command), /^\/new as-debbie\b/);
  assert.doesNotMatch(String(sent.command), /--archive|members\.invalid/);

  // NOT ON THE MINTER'S LIST: Dana signs with her own listed key, and is refused by the box, with who is.
  core.memberCustody = null; // the coordinator's copy aside, so this is the box's answer
  const stranger = await start({ who: DANA, key: pixel, keyId: danaKid, params: { name: 'danas-try', member: 'debbie', task: 'x' } });
  assert.equal(stranger.error?.code, 'not_custodian');
  assert.match(String(stranger.text), /dana@example\.com may not start a session as Debbie\. The vault lists eli@example\.com\. Nothing was started\./);
  // UNSIGNED, naming a custodian: this box takes unsigned work, and not this.
  const unsigned = await start({ params: { name: 'forged', member: 'debbie', task: 'x' }, unsigned: true });
  assert.equal(unsigned.error?.code, 'signature_required');
  assert.match(String(unsigned.text), /runs on Debbie’s sign-ins, so ops-box starts one only when eli@example\.com signed for it or delegated it/);
  // Eli again, so the count below is of two starts that ran and none of the refused ones.
  const again = await start({ params: { name: 'again', member: 'debbie', task: 'x' } });
  assert.equal(again.ok, true);
  // A MEMBER THE VAULT WAS NEVER TOLD ABOUT, though the coordinator has a record of it.
  core.setMember(null, 'ghost', { name: 'Ghost', kind: 'agent', role: 'x' });
  assert.equal((await start({ params: { name: 'ghostly', member: 'ghost', task: 'x' } })).error?.code, 'no_member');
  // AND NOBODY ASKS AS THE MEMBER'S OWN ACCOUNT, signed or not, member start or not.
  const impostor = await core.dispatch({ verb: 'start', params: { name: 'impostor' }, actor: 'debbie@members.invalid', preferHost: 'ops-box' });
  assert.equal(impostor.error?.code, 'not_a_person');
  assert.equal(stub.bodies.filter((b) => /^\/new /.test(String(b.command))).length, 2, 'only the two custodian-signed starts reached the session manager');

  // ADDED AS A CUSTODIAN, Dana starts one once the box has the next list.
  await filed({ op: 'custodian', member: 'debbie', address: DANA });
  assert.equal(await box.sidecar.intentKeys?.refresh(), true);
  const now = await start({ who: DANA, key: pixel, keyId: danaKid, params: { name: 'danas-own', member: 'debbie', task: 'Review the fix.' } });
  assert.equal(now.ok, true, now.text);
  assert.equal(stub.bodies.at(-1).startedBy, `fleet:${DANA}`);
  assert.equal(stub.bodies.at(-1).actor, 'fleet:debbie@members.invalid');
});

test('a session on a task is the assignee’s, opens on the task’s own branch and words, and says where the result goes', async (t) => {
  // docs/tasks.md, "Starting on a task", through a real box: the task in the
  // coordinator, the custodian's signature over the task's id, branch and
  // words, the box's own composition, and what the session manager is handed.
  const { m, core, box, stub, iphone, kid } = await signingFleet(t);
  let clock = Date.now() - 30_000;
  const filed = async (/** @type {Record<string, unknown>} */ body) => assert.equal((await m.phone(body, { at: (clock += 10), admin: true })).ok, true, JSON.stringify(body));
  await filed({ op: 'orgadmin', address: ELI });
  await filed({ op: 'orgmember', id: 'eli', kind: 'person', address: ELI });
  await filed({ op: 'orgmember', id: 'debbie', kind: 'agent', reportsTo: 'eli' });
  await filed({ op: 'put', name: 'claude', value: `sk-ant-oat01-${'d'.repeat(40)}`, for: 'debbie' });
  assert.equal(core.setMember(null, 'debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer', instructions: 'Write small pull requests.' }).ok, true);
  assert.equal(await box.sidecar.intentKeys?.refresh(), true, box.sidecar.intentKeys?.problem ?? '');
  const eli = { email: ELI, admin: false };

  const made = /** @type {any} */ (core.createTask(eli, { title: 'Fix the login redirect', brief: 'It loses ?next. Fix it in app/auth.', assignee: 'debbie', repo: 'acme/app' }));
  assert.equal(made.ok, true, made.text);
  let n = 0;
  /** A start from Eli's phone, signed over exactly the parameters given. */
  const start = async (/** @type {any} */ params) => {
    const id = `task-intent-${String(++n).padStart(4, '0')}`;
    const issuedAt = Date.now();
    const sig = await sign(iphone.privateJwk, intentSigningInput({ actor: ELI, id, issuedAt, params, verb: 'start' }, 'ops-box'));
    return core.dispatch({ verb: 'start', params, id, actor: ELI, requester: eli, preferHost: 'ops-box', sig, kid, issuedAt });
  };

  stub.bodies.length = 0;
  const ok = await start({ name: 'on-t1', ...made.start });
  assert.equal(ok.ok, true, ok.text);
  const sent = stub.bodies.at(-1);
  assert.equal(sent.task, [
    'Write small pull requests.',
    'Task t1. Branch task/t1-fix-the-login-redirect in acme/app.\n\nFix the login redirect\n\nIt loses ?next. Fix it in app/auth.',
    RESULT_FOOTER,
  ].join('\n\n----------\n\n'));
  assert.deepEqual([sent.taskId, sent.taskBranch, sent.member, sent.actor], ['t1', 'task/t1-fix-the-login-redirect', 'debbie', 'fleet:debbie@members.invalid']);
  assert.doesNotMatch(String(sent.command), /task\/t1|acme\/app/, 'none of it rides the command line');
  // The words, the task and the branch are what Eli signed: one signed for
  // this task does not start another, and the branch cannot be swapped.
  const asked = { actor: ELI, id: 'i', issuedAt: 1, verb: 'start' };
  for (const swap of [{ taskId: 't2' }, { taskBranch: 'task/t1-elsewhere' }, { taskRepo: 'evil/app' }]) {
    assert.notEqual(intentSigningInput({ ...asked, params: { ...made.start, ...swap } }, 'ops-box'), intentSigningInput({ ...asked, params: made.start }, 'ops-box'), JSON.stringify(swap));
  }
  // The coordinator holds the lock on this box for Eli's start. This stand-in
  // session manager names no session in its answer, so the lock waits for
  // the box to speak of one, and takes it up when it does.
  assert.deepEqual([core.tasks.get('t1')?.lock?.hostId, core.tasks.get('t1')?.lock?.by, core.tasks.get('t1')?.lock?.session], ['ops-box', ELI, null]);
  await core.onHostMessage('ops-box', { v: PROTOCOL_VERSION, kind: 'event', event: 'session.ready', name: 'on-t1', tasked: true, taskId: 't1', result: { text: 'DONE\nFixed in 3f2a.' } });
  assert.deepEqual([core.tasks.get('t1')?.state, core.tasks.get('t1')?.result?.session, core.tasks.get('t1')?.result?.outcome], ['returned', 'on-t1', 'done']);

  // THE BOX'S OWN REFUSALS, asked of it directly: a coordinator that would
  // send these is the one it does not believe.
  const direct = (/** @type {any} */ params) => box.sidecar.handle({ v: PROTOCOL_VERSION, kind: 'intent', id: `direct-task-${String(++n).padStart(4, '0')}`, verb: 'start', params, issuedAt: Date.now(), actor: ELI });
  const nobody = /** @type {any} */ (await direct({ name: 'no-member', taskId: 't1', taskBranch: 'task/t1-fix-the-login-redirect', task: 'x' }));
  assert.equal(nobody.error?.code, 'bad_params');
  assert.match(String(nobody.text), /A session on t1 is started as the task’s assignee, and this names no member\. Nothing was started\./);
  const before = stub.bodies.filter((b) => /^\/new /.test(String(b.command))).length;
  assert.equal(before, 1, 'only the signed start reached the session manager');
});

test('a box asks for members’ vaults by saying it takes them, files one under the member’s own account, and nothing else answers for it', async (t) => {
  const { m, as, tree } = await orgMinter(t);
  await tree();
  assert.equal((await as(ELI, { op: 'put', name: 'claude', value: `sk-ant-oat01-${'d'.repeat(40)}`, for: 'debbie' })).ok, true);
  assert.equal((await as(ELI, { op: 'put', name: 'secret:DEPLOY_KEY', value: 'debbie-deploy', for: 'debbie' })).ok, true);
  assert.equal((await as(ELI, { op: 'put', name: 'claude', value: `sk-ant-oat01-${'e'.repeat(40)}` })).ok, true);
  const boxKeys = await generateKeyPair();
  for (const whose of [{ for: 'debbie' }, {}]) assert.equal((await as(ELI, { op: 'grant', hostKey: boxKeys.publicJwk, label: 'ops-box', ...whose })).ok, true);

  const stateDir = mkdtempSync(join(tmpdir(), 'fw-member-vault-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cfg = /** @type {any} */ ({ stateDir, sandbox: true });
  // What this version of a box signs: `accepts`, with the rest.
  const given = await m.box(boxKeys, { members: [ELI, DANA], accepts: ['members'] });
  const { applyVault } = await import('../src/core/vault-store.js');
  assert.equal(applyVault(cfg, given.answer).ok, true);

  // THE MEMBER'S ACCOUNT, and its own token: never the custodian's, who approved the same box for his own.
  const asDebbie = pickCredentialSource(cfg, 'fleet:debbie@members.invalid');
  assert.equal(asDebbie.account, 'debbie@members.invalid');
  assert.equal(readFileSync(String(asDebbie.tokenFile), 'utf8').trim(), `sk-ant-oat01-${'d'.repeat(40)}`);
  assert.equal(readFileSync(String(pickCredentialSource(cfg, `fleet:${ELI}`).tokenFile), 'utf8').trim(), `sk-ant-oat01-${'e'.repeat(40)}`);
  assert.equal(vaultSecret(cfg, 'debbie@members.invalid', 'DEPLOY_KEY'), 'debbie-deploy');
  assert.equal(vaultSecret(cfg, ELI, 'DEPLOY_KEY'), null);

  // NO FALLBACK: a member with nothing on this box is refused by name, and is not run on anybody else's.
  const none = pickCredentialSource(cfg, 'fleet:jason@members.invalid');
  assert.equal(none.source, null);
  assert.equal(none.tokenFile, undefined);
  assert.match(String(none.why), /jason@members\.invalid keeps no Claude login in their vault that this box was given/);

  // An answer that names the members' domain as a PERSON's address is not believed: only a principal files there.
  applyVault(cfg, { accounts: [{ email: 'debbie@members.invalid', login: 'x', items: [{ name: 'claude', value: `sk-ant-oat01-${'x'.repeat(40)}`, expiresAt: null }], problems: [] }] });
  assert.equal(pickCredentialSource(cfg, 'fleet:debbie@members.invalid').source, null);
  assert.equal(pickCredentialSource(cfg, 'fleet:debbie@members.invalid').tokenFile, undefined);
});
