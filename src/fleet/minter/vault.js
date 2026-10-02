// Each person's credentials, kept once, in the minting Worker, for the boxes
// they approve.
//
// WHAT IT REPLACES. Before this a person connected GitHub, Cloudflare and
// Claude again on every permanent box, and each box kept its own copy of the
// refresh token and renewed it on its own clock. Three boxes was three copies
// of the same credential at rest, two boxes racing to rotate one refresh token
// was a person signed out of one of them, and a box enrolled tomorrow had
// nothing. Now there is one copy, here, and a box asks for what it has been
// approved to hold.
//
// WHO MAY ASK, which is the whole design, and none of it is the coordinator's
// word:
//
//  - A PERSON reaches their vault with a request sealed on their own device
//    to this Worker's deposit key (the pin they were given), with a GitHub
//    token of theirs inside. Whose vault it is comes from GitHub, asked with
//    that token, exactly as a Claude deposit is decided (claude.js). The answer
//    is sealed to a key the device made for that one request.
//  - A BOX is approved by its person, from their phone: the approval names the
//    box's own P-256 public key, the one it already proves itself with on every
//    connect (src/fleet/host/identity.js), and the phone works out the
//    fingerprint from that key itself, for the person to compare with what
//    `fleetwright-sidecar identity` prints on the box. A box then asks with a
//    request SIGNED by that key, and gets the credentials of every person who
//    approved that exact key, sealed to a one-request key of its own.
//
// So a compromised coordinator can drop and delay, and can offer a phone a key
// of its own to approve, which is why the phone shows a fingerprint and the
// docs say to compare it. What it cannot do is approve a key, read a vault, or
// sign as a box. See docs/vault.md and security.md §4.1.
//
// WHAT A BOX IS GIVEN is never a refresh token. An OAuth item is renewed here
// and only here, under a lock, so one rotation happens however many boxes ask
// at once; a box gets the access token, which lasts hours, and asks again
// before it runs out. A named secret and a Claude token have no shorter form
// and are handed over as they are.
//
// AT REST everything is sealed to the deposit key under the account id and the
// item's name (seal.js, vaultAtRestAad), so the storage holds ciphertext, and
// a row moved under another account or an item copied over another does not
// open. A Claude token stays where claude.js has always kept it, so a runner's
// hand-out and a box's read the same row.
//
// ADDING A PROVIDER is one entry in OAUTH_PROVIDERS (and the client id and
// secret in the Worker's environment); a new kind of value is a new name in
// itemKind. Nothing else here knows the list.
//
// NEVER THROWS. Every refusal is a code and a sentence.

import { SEAL_KEY_RE, VAULT_REQUEST_AAD, VAULT_REPLY_AAD, VAULT_BOX_AAD, atRestAad, vaultAtRestAad, seal, open } from '../seal.js';
import { verify, signingInput } from '../crypto.js';
import { githubUser } from '../../core/repo-tokens.js';
import { refreshGithubToken, refreshCloudflareToken, exchangeCode } from '../../core/oauth-refresh.js';
import { DEPOSIT_MAX_AGE_MS } from './claude.js';

/** The OAuth providers a vault keeps, and how each is renewed. One entry is the whole of adding one. */
export const OAUTH_PROVIDERS = Object.freeze({
  github: { label: 'GitHub', refresh: refreshGithubToken },
  cloudflare: { label: 'Cloudflare', refresh: refreshCloudflareToken },
});

/** A named secret's name, as a box already names them (src/core/secret-store.js). */
export const SECRET_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** The prefix a named secret's item carries, so it cannot be mistaken for a provider. */
export const SECRET_PREFIX = 'secret:';

/** How large a named secret may be. A key file, not a database. */
const MAX_SECRET = 8192;

/** Renewed when it has less than this left, so a box that asks every ten minutes is never handed a dying token. */
export const REFRESH_AHEAD_MS = 30 * 60_000;

/** A Claude token's shape, as claude.js accepts one. */
const CLAUDE_RE = /^[A-Za-z0-9._~+/=-]{20,2048}$/;
const CODE_RE = /^[A-Za-z0-9_.-]{8,256}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const B64_COORD_RE = /^[A-Za-z0-9_-]{43}$/;
const KEY_HASH_RE = /^[0-9a-f]{64}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{40,200}$/;

/**
 * @typedef {object} VaultStore  this Worker's Durable Object storage, or a Map in a test
 * @property {(key: string) => Promise<any>} get
 * @property {(key: string, value: any) => Promise<void>} put
 */

/**
 * @typedef {object} VaultConfig
 * @property {(() => Promise<{ privateKey: CryptoKey, publicKey: string }>)|null} depositKey
 * @property {VaultStore|null} store
 * @property {Record<string, { clientId: string, secret: string }>} [clients]  each OAuth provider's client, from the environment
 * @property {typeof globalThis.fetch} [fetchImpl]
 * @property {() => number} [now]
 */

/** @param {string} code @param {string} text */
const refuse = (code, text) => ({ ok: false, error: { code }, text });

/**
 * What a vault item is, from its name. Null for a name a vault does not keep.
 *
 * @param {string} name
 * @returns {'claude'|'oauth'|'secret'|null}
 */
export function itemKind(name) {
  if (name === 'claude') return 'claude';
  if (Object.hasOwn(OAUTH_PROVIDERS, name)) return 'oauth';
  if (name.startsWith(SECRET_PREFIX) && SECRET_NAME_RE.test(name.slice(SECRET_PREFIX.length))) return 'secret';
  return null;
}

/**
 * A box's public key, reduced to the four fields that make it, or null when it
 * is not a P-256 key. The same reduction the coordinator makes when a box
 * enrols (coordinator/hosts.js), so the phone, the coordinator and this agree.
 *
 * @param {unknown} jwk
 */
export function boxKey(jwk) {
  const k = /** @type {any} */ (jwk);
  if (!k || k.kty !== 'EC' || k.crv !== 'P-256' || !B64_COORD_RE.test(String(k.x)) || !B64_COORD_RE.test(String(k.y))) return null;
  return { kty: 'EC', crv: 'P-256', x: String(k.x), y: String(k.y) };
}

/**
 * The whole SHA-256 of a box key, hex, which is what a grant is filed under.
 * Its first sixteen characters are the fingerprint crypto.js prints and the
 * phone shows; the rest is what makes two keys that share a fingerprint
 * different keys here.
 *
 * @param {{ kty: string, crv: string, x: string, y: string }} key
 */
export async function boxKeyHash(key) {
  const canonical = JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ONE LOCK PER ACCOUNT, held in this isolate. The vault runs inside the
// Worker's single Durable Object, so this isolate is the only writer, and a
// lock here is what stops two boxes renewing one refresh token at once, or a
// renewal and a phone's change both writing the row and one of them losing.
/** @type {Map<string, Promise<unknown>>} */
const held = new Map();

/**
 * @template T
 * @param {string} key @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withLock(key, fn) {
  const before = held.get(key) ?? Promise.resolve();
  /** @type {() => void} */
  let release = () => {};
  const mine = new Promise((resolve) => { release = () => resolve(undefined); });
  const chained = before.then(() => mine);
  held.set(key, chained);
  await before;
  try {
    return await fn();
  } finally {
    release();
    if (held.get(key) === chained) held.delete(key);
  }
}

/** @param {VaultConfig} config */
function notConfigured(config) {
  return !config.depositKey || !config.store
    ? refuse('no_deposit_key', 'The minting Worker holds no deposit key, so it keeps no vault. See docs/vault.md.')
    : null;
}

/** @param {VaultConfig} config */
async function loadKey(config) {
  try {
    return { ok: true, key: await /** @type {() => Promise<{ privateKey: CryptoKey, publicKey: string }>} */ (config.depositKey)() };
  } catch (e) {
    return { ok: false, refusal: refuse('bad_deposit_key', `The deposit key does not load: ${/** @type {Error} */ (e).message}.`) };
  }
}

/** @param {any} row */
function emptyRow(row) {
  return { login: String(row?.login || ''), items: { ...(row?.items || {}) }, grants: { ...(row?.grants || {}) } };
}

/** @param {unknown} s */
const normaliseEmail = (s) => String(s ?? '').trim().toLowerCase();

/**
 * A person's request to their vault.
 *
 * @param {unknown} ask  `{ sealed, email }`: the request as the device sealed
 *   it, and the fleet account the coordinator says sent it. Opened here to
 *   `{ v: 1, github, email, op, at, reply, ... }`
 * @param {VaultConfig} config
 */
export async function answerVaultDevice(ask, config) {
  const missing = notConfigured(config);
  if (missing) return missing;
  const { fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = config;
  const a = /** @type {any} */ (ask);
  if (!a?.sealed || typeof a.sealed !== 'object') return refuse('bad_params', 'That is not a sealed vault request.');
  const loaded = await loadKey(config);
  if (!loaded.ok) return /** @type {any} */ (loaded).refusal;
  const key = /** @type {{ privateKey: CryptoKey, publicKey: string }} */ (loaded.key);

  /** @type {any} */
  let inside;
  try {
    inside = await open({ privateKey: key.privateKey, publicKey: key.publicKey, aad: VAULT_REQUEST_AAD, sealed: a.sealed });
  } catch {
    return refuse('unsealed', 'That request does not open with this minter’s key. It was sealed to a different key, or changed on the way.');
  }
  const at = Number(inside?.at);
  const reply = String(inside?.reply || '');
  if (inside?.v !== 1 || !Number.isFinite(at) || !SEAL_KEY_RE.test(reply) || typeof inside?.op !== 'string') {
    return refuse('bad_params', 'That vault request is not in the shape one takes.');
  }
  if (Math.abs(now() - at) > DEPOSIT_MAX_AGE_MS) return refuse('stale', 'That request is more than ten minutes old, so it could be a replay. Make it again.');
  // WHICH FLEET ACCOUNT, twice: the device says inside the seal, and the
  // coordinator says who sent it. Both must agree before a grant can name a
  // fleet account, so an honest coordinator stops one member filing their
  // credentials under another member's name. A dishonest one could only file
  // a person's own credentials under the wrong name, which is no more than
  // forging an intent's actor already gives it.
  const email = normaliseEmail(a.email);
  if (!email || normaliseEmail(inside.email) !== email) {
    return refuse('not_you', 'That request was made for a different fleet account than the one sending it, so nothing was changed.');
  }
  const who = await githubUser({ token: String(inside.github || ''), fetchImpl });
  if (!who.ok) return refuse('not_github', `The minter could not tell whose vault this is: ${who.message}.`);

  const result = await withLock(`row:${who.userId}`, () => runDeviceOp(inside, { ...config, fetchImpl, now }, key, who, email, at));
  if (!result.ok) return result;
  const sealedBack = await seal({ to: reply, aad: VAULT_REPLY_AAD, payload: result.answer ?? {} });
  return { ok: true, sealed: sealedBack, text: result.text };
}

/**
 * @param {any} inside @param {VaultConfig & { fetchImpl: typeof fetch, now: () => number }} config
 * @param {{ privateKey: CryptoKey, publicKey: string }} key
 * @param {{ userId: string, login: string }} who @param {string} email @param {number} at
 * @returns {Promise<{ ok: true, answer?: any, text: string } | { ok: false, error: { code: string }, text: string }>}
 */
async function runDeviceOp(inside, config, key, who, email, at) {
  const store = /** @type {VaultStore} */ (config.store);
  const row = emptyRow(await store.get(`v:${who.userId}`));
  row.login = who.login || row.login;
  const save = () => store.put(`v:${who.userId}`, row);
  const name = String(inside.name ?? '');

  if (inside.op === 'list') {
    return { ok: true, answer: await describe(row, store, who.userId), text: `${who.login}’s vault.` };
  }

  if (inside.op === 'put' || inside.op === 'forget') {
    const kind = itemKind(name);
    if (kind === 'claude') return putClaude(store, key, who, at, inside.op === 'forget' ? null : String(inside.value ?? ''));
    if (inside.op === 'put' && kind !== 'secret') {
      return refuse('bad_name', 'A value put in a vault is a named secret (secret:NAME) or a Claude token. GitHub and Cloudflare are kept by signing in.');
    }
    if (!kind) return refuse('bad_name', `${name.slice(0, 80) || 'That'} is not something a vault keeps.`);
    const prior = row.items[name];
    if (prior && Number(prior.at) >= at) return refuse('stale', `${name} has a newer change than this one, so this could be a replay. Nothing was changed.`);
    if (inside.op === 'forget') {
      // A TOMBSTONE, for the reason claude.js keeps one: a replayed older
      // request inside its ten minutes cannot bring the item back.
      row.items[name] = { at, forgotten: true };
      await save();
      return { ok: true, text: `Forgot ${label(name)}. Boxes stop being given it when they next ask.` };
    }
    const value = String(inside.value ?? '');
    if (!value || value.length > MAX_SECRET) return refuse('bad_value', `A named secret is between 1 and ${MAX_SECRET} characters.`);
    row.items[name] = { at, sealed: await seal({ to: key.publicKey, aad: vaultAtRestAad(who.userId, name), payload: { value } }) };
    await save();
    return { ok: true, text: `Kept ${label(name)}. Sessions you start on a box you approved can be given it by name.` };
  }

  if (inside.op === 'connect') {
    const provider = String(inside.provider || '');
    if (!Object.hasOwn(OAUTH_PROVIDERS, provider)) return refuse('bad_name', 'A vault signs in to GitHub or Cloudflare.');
    const client = config.clients?.[provider];
    const p = OAUTH_PROVIDERS[/** @type {keyof typeof OAUTH_PROVIDERS} */ (provider)];
    if (!client?.clientId || !client?.secret) {
      return refuse('not_configured', `The minting Worker holds no ${p.label} client, so it cannot keep a ${p.label} sign-in. See docs/vault.md.`);
    }
    const code = String(inside.code || '');
    const verifier = String(inside.verifier || '');
    const redirectUri = String(inside.redirectUri || '');
    if (!CODE_RE.test(code) || !VERIFIER_RE.test(verifier) || !new RegExp(`^https://[^\\s/]+/oauth/${provider}/callback$`).test(redirectUri)) {
      return refuse('bad_params', 'That sign-in is missing its code, its PKCE verifier or its callback.');
    }
    const prior = row.items[provider];
    if (prior && Number(prior.at) >= at) return refuse('stale', `${p.label} has a newer sign-in here than this one. Nothing was changed.`);
    const got = await exchangeCode({ provider: /** @type {'github'|'cloudflare'} */ (provider), code, verifier, redirectUri, clientId: client.clientId, client: client.secret, fetchImpl: config.fetchImpl });
    if (!got.ok) return refuse(`${provider}_refused`, `${got.message}.`);
    let account = '';
    if (provider === 'github') {
      // THE SAME PERSON, or it is not kept: a vault is filed under the GitHub
      // account that asked, and a sign-in to somebody else's account under it
      // would hand their access to this person's boxes.
      const whose = await githubUser({ token: String(got.accessToken), fetchImpl: config.fetchImpl });
      if (!whose.ok) return refuse('not_github', `GitHub would not say whose that sign-in is: ${whose.message}.`);
      if (whose.userId !== who.userId) {
        return refuse('not_yours', `That sign-in is to ${whose.login}, and this vault is ${who.login}’s. Sign in to GitHub as ${who.login}.`);
      }
      account = whose.login;
    }
    const t = config.now();
    row.items[provider] = {
      at,
      sealed: await seal({
        to: key.publicKey,
        aad: vaultAtRestAad(who.userId, provider),
        payload: { accessToken: got.accessToken, refreshToken: got.refreshToken ?? null, expiresAt: got.expiresIn ? t + got.expiresIn * 1000 : null, account },
      }),
    };
    await save();
    return { ok: true, answer: { account }, text: `Kept ${p.label}${account ? ` as ${account}` : ''} for the boxes you approve.` };
  }

  if (inside.op === 'grant') {
    const jwk = boxKey(inside.hostKey);
    if (!jwk) return refuse('bad_key', 'That is not a box’s key.');
    const hash = await boxKeyHash(jwk);
    const prior = row.grants[hash];
    if (prior && Number(prior.at) >= at) return refuse('stale', 'That box has a newer approval or removal than this one. Nothing was changed.');
    const boxLabel = String(inside.label ?? '').replace(/[^\w.@:-]/g, '').slice(0, 64);
    row.grants[hash] = { at, jwk, email, label: boxLabel };
    await save();
    await withLock(`box:${hash}`, async () => {
      const index = (await store.get(`box:${hash}`)) || { accounts: {} };
      index.accounts = { ...(index.accounts || {}), [who.userId]: { at } };
      await store.put(`box:${hash}`, index);
    });
    return { ok: true, answer: { fingerprint: hash.slice(0, 16) }, text: `Approved ${boxLabel || 'that box'} (${hash.slice(0, 16)}) to hold your credentials.` };
  }

  if (inside.op === 'revoke') {
    const hash = String(inside.key || '');
    if (!KEY_HASH_RE.test(hash)) return refuse('bad_key', 'That is not an approved box.');
    const prior = row.grants[hash];
    if (prior && Number(prior.at) >= at) return refuse('stale', 'That box has a newer approval or removal than this one. Nothing was changed.');
    const boxLabel = prior?.label || hash.slice(0, 16);
    row.grants[hash] = { at, revoked: true };
    await save();
    await withLock(`box:${hash}`, async () => {
      const index = (await store.get(`box:${hash}`)) || { accounts: {} };
      const accounts = { ...(index.accounts || {}) };
      delete accounts[who.userId];
      await store.put(`box:${hash}`, { accounts });
    });
    return { ok: true, text: `${boxLabel} is no longer approved. It stops being given your credentials when it next asks, and forgets what it holds then.` };
  }

  return refuse('bad_params', `A vault does not do “${String(inside.op).slice(0, 40)}”.`);
}

/** @param {string} name */
function label(name) {
  if (name === 'claude') return 'your Claude login';
  if (Object.hasOwn(OAUTH_PROVIDERS, name)) return OAUTH_PROVIDERS[/** @type {keyof typeof OAUTH_PROVIDERS} */ (name)].label;
  return name.startsWith(SECRET_PREFIX) ? `the secret ${name.slice(SECRET_PREFIX.length)}` : name;
}

/**
 * The Claude item, in the row claude.js keeps it in, so a runner's hand-out
 * and a box's read the same token. The same checks as a deposit.
 *
 * @param {VaultStore} store @param {{ publicKey: string }} key
 * @param {{ userId: string, login: string }} who @param {number} at @param {string|null} token
 */
async function putClaude(store, key, who, at, token) {
  if (token !== null && !CLAUDE_RE.test(token)) {
    return refuse('bad_token', 'That is not a Claude token. Paste the one line `claude setup-token` printed.');
  }
  const prior = await store.get(`gh:${who.userId}`);
  if (prior && Number(prior.at) >= at) return refuse('stale', 'Your Claude login has a newer change than this one. Nothing was changed.');
  if (token === null) {
    await store.put(`gh:${who.userId}`, { at, login: who.login, forgotten: true });
    return /** @type {const} */ ({ ok: true, text: 'Forgot your Claude login. Boxes and runners stop being given it.' });
  }
  await store.put(`gh:${who.userId}`, { at, login: who.login, sealed: await seal({ to: key.publicKey, aad: atRestAad(who.userId), payload: { token } }) });
  return /** @type {const} */ ({ ok: true, text: 'Kept your Claude login for your runners and the boxes you approve.' });
}

/**
 * What a person's vault holds, by name and never by value, and which boxes may
 * hold it.
 *
 * @param {{ login: string, items: Record<string, any>, grants: Record<string, any> }} row
 * @param {VaultStore} store @param {string} userId
 */
async function describe(row, store, userId) {
  const claude = await store.get(`gh:${userId}`);
  /** @type {Array<{ name: string, at: number }>} */
  const items = Object.entries(row.items)
    .filter(([, v]) => v && !v.forgotten && v.sealed)
    .map(([n, v]) => ({ name: n, at: Number(v.at) }));
  if (claude?.sealed && !claude.forgotten) items.push({ name: 'claude', at: Number(claude.at) });
  items.sort((x, y) => (x.name < y.name ? -1 : 1));
  const grants = Object.entries(row.grants)
    .filter(([, g]) => g && !g.revoked && g.jwk)
    .map(([hash, g]) => ({ key: hash, fingerprint: hash.slice(0, 16), label: String(g.label || ''), email: String(g.email || ''), at: Number(g.at) }))
    .sort((x, y) => (x.label < y.label ? -1 : 1));
  return { login: row.login, items, grants };
}

/**
 * A box asks for everything it has been approved to hold.
 *
 * @param {unknown} ask  `{ request: { v: 1, hostKey, at, reply }, signature }`,
 *   the signature being the box's key over signingInput('vault-box', request)
 * @param {VaultConfig} config
 */
export async function answerVaultBox(ask, config) {
  const missing = notConfigured(config);
  if (missing) return missing;
  const { fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = config;
  const req = /** @type {any} */ (ask)?.request;
  const signature = String(/** @type {any} */ (ask)?.signature || '');
  const jwk = boxKey(req?.hostKey);
  const at = Number(req?.at);
  if (req?.v !== 1 || !jwk || !Number.isFinite(at) || !SEAL_KEY_RE.test(String(req?.reply || '')) || !SIGNATURE_RE.test(signature)) {
    return refuse('bad_params', 'That is not a box’s vault request.');
  }
  if (Math.abs(now() - at) > DEPOSIT_MAX_AGE_MS) return refuse('stale', 'That request is more than ten minutes old. The box’s clock is wrong, or it is a replay.');
  // SIGNED BY THE KEY IT NAMES. Replaying a genuine request gets an answer
  // sealed to the box's own one-request key, which only the box can open.
  const payload = { v: 1, hostKey: jwk, at, reply: String(req.reply) };
  if (!(await verify(jwk, signature, signingInput('vault-box', payload)))) {
    return refuse('bad_signature', 'That request is not signed by the key it names.');
  }
  const loaded = await loadKey(config);
  if (!loaded.ok) return /** @type {any} */ (loaded).refusal;
  const key = /** @type {{ privateKey: CryptoKey, publicKey: string }} */ (loaded.key);
  const store = /** @type {VaultStore} */ (config.store);
  const hash = await boxKeyHash(jwk);
  const index = (await store.get(`box:${hash}`)) || { accounts: {} };

  /** @type {Array<{ email: string, login: string, items: Array<{ name: string, value: string, expiresAt: number|null }>, problems: string[] }>} */
  const accounts = [];
  for (const userId of Object.keys(index.accounts || {})) {
    if (!/^[0-9]{1,20}$/.test(userId)) continue;
    const one = await withLock(`row:${userId}`, () => itemsFor(userId, hash, jwk, store, key, { ...config, fetchImpl, now }));
    if (one) accounts.push(one);
  }
  const sealed = await seal({ to: String(req.reply), aad: VAULT_BOX_AAD, payload: { at: now(), accounts } });
  return { ok: true, sealed, text: accounts.length ? `This box holds credentials for ${accounts.length} ${accounts.length === 1 ? 'person' : 'people'}.` : 'Nobody has approved this box to hold their credentials.' };
}

/**
 * One person's items for one box, renewing what is close to running out. Null
 * when their approval of this box is gone or is for a different key.
 *
 * @param {string} userId @param {string} hash @param {{ x: string, y: string }} jwk
 * @param {VaultStore} store @param {{ privateKey: CryptoKey, publicKey: string }} key
 * @param {VaultConfig & { fetchImpl: typeof fetch, now: () => number }} config
 */
async function itemsFor(userId, hash, jwk, store, key, config) {
  const row = emptyRow(await store.get(`v:${userId}`));
  const grant = row.grants[hash];
  if (!grant || grant.revoked || grant.jwk?.x !== jwk.x || grant.jwk?.y !== jwk.y) return null;
  /** @type {Array<{ name: string, value: string, expiresAt: number|null }>} */
  const items = [];
  /** @type {string[]} */
  const problems = [];
  let changed = false;
  for (const [name, item] of Object.entries(row.items)) {
    if (!item?.sealed || item.forgotten) continue;
    const kind = itemKind(name);
    /** @type {any} */
    let inside;
    try {
      inside = await open({ privateKey: key.privateKey, publicKey: key.publicKey, aad: vaultAtRestAad(userId, name), sealed: item.sealed });
    } catch {
      problems.push(`${label(name)} does not open with this minter’s key; it was kept under a key that has since changed.`);
      continue;
    }
    if (kind === 'secret') {
      items.push({ name, value: String(inside.value), expiresAt: null });
      continue;
    }
    if (kind !== 'oauth') continue;
    const due = inside.expiresAt !== null && Number(inside.expiresAt) - config.now() < REFRESH_AHEAD_MS;
    if (due && inside.refreshToken) {
      const p = OAUTH_PROVIDERS[/** @type {keyof typeof OAUTH_PROVIDERS} */ (name)];
      const client = config.clients?.[name];
      const renewed = client?.clientId && client?.secret
        ? await p.refresh({ refresh: String(inside.refreshToken), client: client.secret, clientId: client.clientId, fetchImpl: config.fetchImpl })
        : { ok: false, message: `the minter holds no ${p.label} client to renew with` };
      if (renewed.ok) {
        // ROTATED: the old refresh token is dead the moment this returns, so
        // the new one is stored before anything else can fail.
        inside = {
          ...inside,
          accessToken: renewed.accessToken,
          refreshToken: renewed.refreshToken ?? inside.refreshToken,
          expiresAt: renewed.expiresIn ? config.now() + renewed.expiresIn * 1000 : null,
        };
        row.items[name] = { at: item.at, sealed: await seal({ to: key.publicKey, aad: vaultAtRestAad(userId, name), payload: inside }) };
        changed = true;
      } else {
        problems.push(`${p.label} could not be renewed: ${renewed.message}. Sign in again from your phone.`);
      }
    }
    if (inside.expiresAt === null || Number(inside.expiresAt) > config.now()) {
      items.push({ name, value: String(inside.accessToken), expiresAt: inside.expiresAt === null ? null : Number(inside.expiresAt) });
    }
  }
  if (changed) await store.put(`v:${userId}`, row);
  const claude = await store.get(`gh:${userId}`);
  if (claude?.sealed && !claude.forgotten) {
    try {
      const inside = /** @type {any} */ (await open({ privateKey: key.privateKey, publicKey: key.publicKey, aad: atRestAad(userId), sealed: claude.sealed }));
      items.push({ name: 'claude', value: String(inside.token), expiresAt: null });
    } catch {
      problems.push('Your Claude login does not open with this minter’s key; deposit it again.');
    }
  }
  return { email: String(grant.email || ''), login: row.login, items, problems };
}
