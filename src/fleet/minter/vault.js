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
//    to this Worker's deposit key (the pin they were given), with the GitHub
//    token that device signed in for inside. Whose vault it is comes from
//    GitHub, asked with that token, and the token must be one this minter
//    finished a sign-in for on a device (github.js, deviceSignedIn): never
//    the GitHub token this vault hands the boxes it approves, which GitHub
//    would also call the person's. The answer is sealed to a key the device
//    made for that one request.
//  - A BOX is approved by its person, from their phone: the approval names the
//    box's own P-256 public key, the one it already proves itself with on every
//    connect (src/fleet/host/identity.js), and the phone works out the
//    fingerprint from that key itself, for the person to compare with what
//    `fleetwright-sidecar identity` prints on the box. A box then asks with a
//    request SIGNED by that key, and gets the credentials of every person who
//    approved that exact key, sealed to a one-request key of its own.
//
// AND ONLY WHILE THEY ARE IN THE FLEET, which is the coordinator's to say. A
// person is removed there, by revoking their last credential, and nothing of
// that reached this Worker: every box they had approved went on being given
// their items, OAuth tokens renewed here every ten minutes for as long as the
// refresh token lasted, and the removed person could not withdraw a grant,
// because their requests need a credential that works (eighth audit,
// r8-leads-1). So the coordinator lists who is in the fleet beside each box's
// request, and a grant gives nothing while its fleet account is not on the
// list (answerVaultBox). Asked on every request rather than told once at the
// removal, because a removal made while this Worker was unreachable would
// have been missed for good, and filtered rather than deleted, so a person
// who signs in again is served again with nothing to approve twice.
//
// That list is the coordinator's word, and it can only take away: listing
// somebody removed gives what every request was given before the list, and
// leaving a member off denies, which dropping the request already could.
//
// So a compromised coordinator can drop and delay, and can offer a phone a key
// of its own to approve, which is why the phone shows a fingerprint and the
// docs say to compare it. What it cannot do is approve a key, read a vault, or
// sign as a box, short of getting the person to finish a GitHub sign-in it
// started with a verifier of its own. See docs/vault.md and security.md §4.1.
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
import { verify, sign, signingInput } from '../crypto.js';
import { githubUser } from '../../core/repo-tokens.js';
import { refreshGithubToken, refreshCloudflareToken, exchangeCode } from '../../core/oauth-refresh.js';
import { DEPOSIT_MAX_AGE_MS, checkBeforeKeeping } from './claude.js';
import { probeClaude } from '../../core/claude-token-probe.js';
import { claudeSignIn, claudeRenewals, describeRenewals, freshClaude, checkClaude } from './claude-login.js';
import { SIGNIN_PREFIX, deviceSignedIn } from './github.js';

/** The OAuth providers a vault keeps, and how each is renewed. One entry is the whole of adding one. */
export const OAUTH_PROVIDERS = Object.freeze({
  github: { label: 'GitHub', refresh: refreshGithubToken },
  cloudflare: { label: 'Cloudflare', refresh: refreshCloudflareToken },
});

/** A named secret's name, as a box already names them (src/core/secret-store.js). */
export const SECRET_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Items a box approved for part of a vault may be named for (`grant` with `only`). */
export const MAX_GRANT_ONLY = 8;

/**
 * Where a fleet address's signing keys are kept: `dk:<address>`, one row an
 * address, beside the GitHub account it belongs to (docs/signed-intents.md).
 * Keyed by the address and not the account because a box checks an intent by
 * the address it names, and one row is what makes "this address is already
 * somebody's" a single read.
 */
export const DEVICE_KEYS_PREFIX = 'dk:';
/** Signing keys one person may keep listed: a phone, a tablet, a console or two. */
export const MAX_DEVICE_KEYS = 8;
/** Removed keys remembered, so a replayed older add cannot bring one back. */
const MAX_DEVICE_TOMBSTONES = 24;
/**
 * Delegations a person has revoked and that have not yet run out, kept in the
 * same row as their keys: a box refuses one of these from the next key list.
 */
export const MAX_REVOKED_DELEGATIONS = 64;
const DELEGATION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** The longest a delegation runs (intent-signature.js, DELEGATION_MAX_MS), so a revocation kept past it guards nothing. */
const DELEGATION_LIFE_MS = 31 * 24 * 60 * 60_000;

/** The prefix a named secret's item carries, so it cannot be mistaken for a provider. */
export const SECRET_PREFIX = 'secret:';

/**
 * The prefix a hypervisor's item carries: `hypervisor:<address>`, the limited
 * Xen Orchestra token onboarding made for that address, as the record the
 * phone was handed (src/fleet/host/xo-setup.js, hand-off). Its own kind and
 * not a named secret, because a named secret is handed to SESSIONS by name
 * (`fleet-secret`), and a pool's token is for the box that makes machines on
 * it and nothing it runs. A box keeps it in memory only
 * (src/fleet/host/xo-pools.js).
 */
export const HYPERVISOR_PREFIX = 'hypervisor:';

/** A Xen Orchestra address as onboarding takes one: a host name or address, and a port. */
export const HYPERVISOR_ADDRESS_RE = /^(?:\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252})(?::\d{1,5})?$/;

/** How large a named secret may be. A key file, not a database. */
const MAX_SECRET = 8192;

/**
 * How many fleet accounts the coordinator may list as members beside a box's
 * request. It holds at most 150 live credentials (clients.js, MAX_LIVE), so
 * this never binds an honest one; it bounds what one request makes this
 * Worker read, at an address's 320 characters each.
 */
const MAX_MEMBERS = 512;
const MEMBER_MAX_LENGTH = 320;

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
 * @property {(o: { prefix: string }) => Promise<Map<string, any>>} [list]  every row under a prefix, for the check of each sign-in
 */

/** When every kept sign-in was last asked after, so asking again sooner is answered with nothing. */
const CHECKED_ROW = 'claude-checked';

/**
 * How often the sign-ins are asked after, at most, whoever asks. The
 * coordinator asks every fifteen minutes (core.js); this is the floor that
 * holds if it asked every second, which a compromised one could.
 */
export const CLAUDE_CHECK_MIN_MS = 10 * 60_000;

/**
 * @typedef {object} VaultConfig
 * @property {(() => Promise<{ privateKey: CryptoKey, publicKey: string }>)|null} depositKey
 * @property {VaultStore|null} store
 * @property {(() => Promise<{ privateJwk: any, publicJwk: any }>)|null} [signingKey]  what the key list a box is
 *   given is signed with, made beside the deposit key (worker/src/minter.js)
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
 * @returns {'claude'|'oauth'|'secret'|'hypervisor'|null}
 */
export function itemKind(name) {
  if (name === 'claude') return 'claude';
  if (Object.hasOwn(OAUTH_PROVIDERS, name)) return 'oauth';
  if (name.startsWith(SECRET_PREFIX) && SECRET_NAME_RE.test(name.slice(SECRET_PREFIX.length))) return 'secret';
  if (name.startsWith(HYPERVISOR_PREFIX) && HYPERVISOR_ADDRESS_RE.test(name.slice(HYPERVISOR_PREFIX.length))) return 'hypervisor';
  return null;
}

/**
 * Is this the record onboarding hands a phone, for the address it is kept
 * under? Checked when it is put, so a vault never hands a box something
 * that names one pool and is filed under another.
 *
 * @param {string} name @param {string} value
 */
function isHypervisorRecord(name, value) {
  /** @type {any} */
  let record;
  try {
    record = JSON.parse(value);
  } catch {
    return false;
  }
  return Boolean(record) && typeof record === 'object' && typeof record.token === 'string' && record.token.length > 0 &&
    record.address === name.slice(HYPERVISOR_PREFIX.length);
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

/** Said to a vault request carrying a GitHub token no device signed in for here. */
const notADevice = refuse(
  'not_a_device',
  'That GitHub token is not one this phone signed in for through the fleet, so it opens no vault. If this phone signed in to GitHub before the fleet checked for that, sign out of GitHub under Runners from this phone and sign in again.',
);

/**
 * A person's Claude sign-in, renewed if it is due, for a runner's hand-out
 * (claude.js, answerLogin), which runs in the Worker in front of this object
 * and so cannot hold the lock a renewal needs. The bearer only: the refresh
 * token does not leave this object.
 *
 * @param {unknown} ask  `{ id }`, the GitHub account id
 * @param {VaultConfig} config
 */
export async function answerClaudeFresh(ask, config) {
  const missing = notConfigured(config);
  if (missing) return missing;
  const id = String(/** @type {any} */ (ask)?.id || '');
  if (!/^[0-9]{1,20}$/.test(id)) return refuse('bad_params', 'That is not a GitHub account id.');
  const loaded = await loadKey(config);
  if (!loaded.ok) return /** @type {any} */ (loaded).refusal;
  const { fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = config;
  const store = /** @type {VaultStore} */ (config.store);
  const { held, problem } = await withLock(`row:${id}`, () => freshClaude(store, /** @type {any} */ (loaded).key, id, { fetchImpl, now, by: 'a runner' }));
  if (!held) return refuse('no_claude_login', problem ?? 'No Claude login is kept for that account.');
  // AND WHAT A CREDENTIALS FILE IS WRITTEN FROM, for a sign-in, as a box is
  // given it (itemsFor): the runner writes the file its sessions read again
  // when the token is refused, so a renewal does not stop them. Still never
  // the refresh token.
  const signIn = held.kind === 'login' && held.oauth
    ? { login: { scopes: held.oauth.scopes, subscriptionType: held.oauth.subscriptionType, rateLimitTier: held.oauth.rateLimitTier }, account: held.account ?? {} }
    : {};
  return { ok: true, token: held.bearer, expiresAt: held.expiresAt, ...signIn, text: problem ?? '' };
}

/**
 * Every kept Claude sign-in asked after (claude-login.js, checkClaude), for
 * the coordinator to tell the people whose sign-in Anthropic has ended.
 *
 * WHAT THE COORDINATOR CAN DO WITH IT is ask, and be answered at most every
 * ten minutes: the asking is done here, against Anthropic, so it cannot make
 * a sign-in look ended, and the answer is a fleet account, a GitHub login and
 * a time, which it already knows, and what Anthropic said, which holds no
 * token. Each ended sign-in is in one answer only, and so is each one whose
 * access token is refused even after renewing (`refused`).
 *
 * @param {unknown} _ask  nothing is read from it
 * @param {VaultConfig} config
 */
export async function answerClaudeCheck(_ask, config) {
  const missing = notConfigured(config);
  if (missing) return missing;
  const store = /** @type {VaultStore} */ (config.store);
  if (!store.list) return refuse('no_store', 'This storage cannot list the sign-ins it keeps.');
  const { fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = config;
  const last = Number(await store.get(CHECKED_ROW)) || 0;
  if (now() - last < CLAUDE_CHECK_MIN_MS) return { ok: true, ended: [], refused: [], text: 'The sign-ins were asked after less than ten minutes ago.' };
  await store.put(CHECKED_ROW, now());
  const loaded = await loadKey(config);
  if (!loaded.ok) return /** @type {any} */ (loaded).refusal;
  const key = /** @type {any} */ (loaded).key;
  /** @type {import('./claude-login.js').ClaudeEnded[]} */
  const ended = [];
  /** @type {import('./claude-login.js').ClaudeRefused[]} */
  const refused = [];
  for (const k of (await store.list({ prefix: 'gh:' })).keys()) {
    const userId = k.slice(3);
    if (!/^[0-9]{1,20}$/.test(userId)) continue;
    // ONE AT A TIME, each under its person's lock: a check renewing alongside
    // a box renewing the same sign-in would rotate one refresh token twice.
    const one = await withLock(`row:${userId}`, () => checkClaude(store, key, userId, { fetchImpl, now })).catch(() => null);
    if (one && 'refusedAccess' in one) refused.push(one);
    else if (one) ended.push(one);
  }
  // `refused` beside `ended`, not in it: a coordinator from before it would
  // tell those people their sign-in was ended, and it was not.
  return { ok: true, ended, refused, text: '' };
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
  const github = String(inside.github || '');
  const who = await githubUser({ token: github, fetchImpl });
  if (!who.ok) return refuse('not_github', `The minter could not tell whose vault this is: ${who.message}.`);
  // A DEVICE'S OWN SIGN-IN, or nothing. GitHub calls any token of the
  // person's theirs, including the one itemsFor hands every box they approve,
  // which a box they later removed, or a session on it, still holds.
  if (!(await deviceSignedIn(await config.store?.get(`${SIGNIN_PREFIX}${who.userId}`), github, now()))) return notADevice;

  const result = await withLock(`row:${who.userId}`, () => runDeviceOp(inside, { ...config, fetchImpl, now }, key, who, email, at));
  if (!result.ok) return result;
  const sealedBack = await seal({ to: reply, aad: VAULT_REPLY_AAD, payload: result.answer ?? {} });
  // WHETHER IT CHANGED ANYTHING A BOX HOLDS, outside the seal, so the
  // coordinator can tell the boxes to ask now rather than at their next ten
  // minutes. A list changes nothing; everything else may (a test renews what
  // is due, and a box's key list rides the same ask). Never what changed.
  return { ok: true, sealed: sealedBack, text: result.text, ...(inside.op === 'list' ? {} : { changed: true }) };
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
    const devices = await store.get(`${DEVICE_KEYS_PREFIX}${email}`);
    return {
      ok: true,
      answer: { ...(await describe(row, store, who.userId)), devices: liveKeys(devices).map((k) => ({ ...k, yours: devices?.github === who.userId })) },
      text: `${who.login}’s vault.`,
    };
  }

  // A DEVICE'S SIGNING KEY, filed under the fleet address the request names
  // (docs/signed-intents.md). A box takes a person's signature only with a key
  // this lists for them, so a key under the wrong address is a forged actor:
  // the address belongs to the first GitHub account that files a key under it,
  // and another account's key for it is refused while that one keeps any.
  if (inside.op === 'devicekey') {
    const jwk = boxKey(inside.key);
    if (!jwk) return refuse('bad_key', 'That is not a device’s signing key.');
    const kid = await boxKeyHash(jwk);
    const deviceLabel = String(inside.label ?? '').replace(/[^\w .@:'’()-]/g, '').trim().slice(0, 60);
    const remove = inside.remove === true;
    return withLock(`${DEVICE_KEYS_PREFIX}${email}`, async () => {
      const kept = await store.get(`${DEVICE_KEYS_PREFIX}${email}`);
      if (kept && kept.github !== who.userId && liveKeys(kept).length) {
        return refuse('address_taken', `Signing keys for ${email} are filed by another GitHub account than ${who.login}. Nothing was changed. If that is not you, tell whoever runs the fleet.`);
      }
      /** @type {Array<{ kid: string, key: any, label: string, at: number, removed?: boolean }>} */
      const keys = kept?.github === who.userId && Array.isArray(kept.keys) ? kept.keys : [];
      const prior = keys.find((k) => k.kid === kid);
      if (prior && Number(prior.at) >= at) return refuse('stale', 'That key has a newer change than this one, so this could be a replay. Nothing was changed.');
      const others = keys.filter((k) => k.kid !== kid);
      if (!remove && others.filter((k) => !k.removed).length >= MAX_DEVICE_KEYS) {
        return refuse('too_many', `You keep ${MAX_DEVICE_KEYS} signing keys already. Remove one from a device you no longer use first.`);
      }
      const next = [...others, remove ? { kid, key: jwk, label: prior?.label ?? deviceLabel, at, removed: true } : { kid, key: jwk, label: deviceLabel, at }];
      const tombstones = next.filter((k) => k.removed).sort((x, y) => x.at - y.at);
      const dropped = new Set(tombstones.slice(0, Math.max(0, tombstones.length - MAX_DEVICE_TOMBSTONES)).map((k) => k.kid));
      await store.put(`${DEVICE_KEYS_PREFIX}${email}`, {
        github: who.userId, login: who.login, keys: next.filter((k) => !dropped.has(k.kid)),
        ...(kept?.github === who.userId && Array.isArray(kept.revoked) ? { revoked: kept.revoked } : {}),
      });
      return {
        ok: true,
        answer: { kid },
        text: remove
          ? `Removed the signing key ${kid.slice(0, 16)}. Boxes stop taking it when they next ask.`
          : `Listed ${deviceLabel || 'this device'}’s signing key (${kid.slice(0, 16)}) for ${email}.`,
      };
    });
  }

  // A DELEGATION THE PERSON TAKES BACK (docs/signed-intents.md, "Delegations").
  // The coordinator carries delegations, so it cannot be the one told: a
  // dishonest one would go on carrying it. The minter lists the id beside the
  // person's keys, signed, and a box refuses it from the next list it takes.
  // Kept in the keys' own row, under the same GitHub account, until the
  // delegation would have run out anyway.
  if (inside.op === 'revokedelegation') {
    const id = String(inside.id ?? '');
    const until = Number(inside.until);
    if (!DELEGATION_ID_RE.test(id) || !Number.isSafeInteger(until)) return refuse('bad_params', 'That is not a delegation to revoke: it needs its id and when it runs out.');
    return withLock(`${DEVICE_KEYS_PREFIX}${email}`, async () => {
      const kept = await store.get(`${DEVICE_KEYS_PREFIX}${email}`);
      if (!kept || kept.github !== who.userId) {
        return refuse('address_taken', `No signing key for ${email} is filed by ${who.login}, so no delegation of theirs could be signed by it. Nothing was changed.`);
      }
      const t = config.now();
      const end = Math.min(until, t + DELEGATION_LIFE_MS);
      const live = (Array.isArray(kept.revoked) ? kept.revoked : []).filter((/** @type {any} */ r) => Number(r?.until) >= t && r.id !== id);
      if (end >= t) live.push({ id, until: end });
      if (live.length > MAX_REVOKED_DELEGATIONS) {
        return refuse('too_many', `${MAX_REVOKED_DELEGATIONS} revoked delegations are still inside their time. Remove the device that signed them instead, which ends every one.`);
      }
      await store.put(`${DEVICE_KEYS_PREFIX}${email}`, { ...kept, revoked: live });
      return { ok: true, answer: { id }, text: 'Revoked. Boxes refuse it from the next key list they take, within ten minutes.' };
    });
  }

  if (inside.op === 'put' || inside.op === 'forget') {
    const kind = itemKind(name);
    if (kind === 'claude') {
      const what = inside.op === 'forget' ? null : inside.signIn !== undefined ? { signIn: inside.signIn } : String(inside.value ?? '');
      return putClaude(store, key, who, email, at, what, config.fetchImpl);
    }
    if (inside.op === 'put' && kind !== 'secret' && kind !== 'hypervisor') {
      return refuse('bad_name', 'A value put in a vault is a named secret (secret:NAME), a hypervisor’s token or a Claude token. GitHub and Cloudflare are kept by signing in.');
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
    if (kind === 'hypervisor' && !isHypervisorRecord(name, value)) {
      return refuse('bad_value', 'That is not the token record a hypervisor’s setup hands back, for that address.');
    }
    row.items[name] = { at, sealed: await seal({ to: key.publicKey, aad: vaultAtRestAad(who.userId, name), payload: { value } }) };
    await save();
    return {
      ok: true,
      text: kind === 'hypervisor'
        ? `Kept ${label(name)}. The boxes you approved can make machines on it, and hold its token in memory only.`
        : `Kept ${label(name)}. Sessions you start on a box you approved can be given it by name.`,
    };
  }

  if (inside.op === 'test') return testItem(name, row, config, key, who, save);

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
    // ONLY THESE, when named: a pool's own machine is approved for its pool's
    // record and nothing else of the person's (docs/vault.md). Absent is the
    // whole vault, as approving a box always was.
    /** @type {string[]|null} */
    const only = inside.only === undefined ? null : Array.isArray(inside.only) ? inside.only.map(String) : [];
    if (only && (!only.length || only.length > MAX_GRANT_ONLY || only.some((n) => !itemKind(n)))) {
      return refuse('bad_params', 'A box approved for some of your vault is approved for items it names, by their names.');
    }
    row.grants[hash] = { at, jwk, email, label: boxLabel, ...(only ? { only: [...new Set(only)] } : {}) };
    await save();
    await withLock(`box:${hash}`, async () => {
      const index = (await store.get(`box:${hash}`)) || { accounts: {} };
      index.accounts = { ...(index.accounts || {}), [who.userId]: { at } };
      await store.put(`box:${hash}`, index);
    });
    const what = only ? only.map(label).join(', ') : 'your credentials';
    return { ok: true, answer: { fingerprint: hash.slice(0, 16) }, text: `Approved ${boxLabel || 'that box'} (${hash.slice(0, 16)}) to hold ${what}.` };
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

/**
 * Renew one OAuth item with its refresh token, and the item to store in its
 * place. ROTATED: the old refresh token is dead the moment the provider
 * answers, so the caller stores the new one before anything else can fail.
 *
 * @param {string} userId @param {string} name @param {{ at: number }} item @param {any} inside
 * @param {{ privateKey: CryptoKey, publicKey: string }} key
 * @param {VaultConfig & { fetchImpl: typeof fetch, now: () => number }} config
 * @returns {Promise<{ ok: true, inside: any, item: { at: number, sealed: any } } | { ok: false, message: string }>}
 */
async function renewItem(userId, name, item, inside, key, config) {
  const p = OAUTH_PROVIDERS[/** @type {keyof typeof OAUTH_PROVIDERS} */ (name)];
  const client = config.clients?.[name];
  const renewed = client?.clientId && client?.secret
    ? await p.refresh({ refresh: String(inside.refreshToken), client: client.secret, clientId: client.clientId, fetchImpl: config.fetchImpl })
    : { ok: false, message: `the minter holds no ${p.label} client to renew with` };
  if (!renewed.ok) return { ok: false, message: String(renewed.message) };
  const next = {
    ...inside,
    accessToken: renewed.accessToken,
    refreshToken: renewed.refreshToken ?? inside.refreshToken,
    expiresAt: renewed.expiresIn ? config.now() + renewed.expiresIn * 1000 : null,
  };
  return { ok: true, inside: next, item: { at: item.at, sealed: await seal({ to: key.publicKey, aad: vaultAtRestAad(userId, name), payload: next }) } };
}

/**
 * WHETHER A KEPT CREDENTIAL STILL WORKS, asked of the service it is for, by
 * this Worker, which is the one place that can open it. Before this a vault
 * said what it held and never whether any of it worked, so a revoked Claude
 * token or a GitHub sign-in that had lapsed was found by the runner or box
 * that was given it, as a session stopping at its first message.
 *
 *  - Claude: the one-token request a session makes (claude-token-probe.js).
 *  - GitHub: who the token belongs to, renewed first if it is due, as a box
 *    would be handed it.
 *  - Cloudflare: renewed, because a refresh Cloudflare accepts is the one
 *    answer a sign-in of any scope can get, and a vault renews it anyway.
 *
 * A named secret and a hypervisor's token have no service this Worker could
 * ask (a pool is on someone's own network), so they are not tested, and the
 * phones offer the button only for the three that are.
 *
 * Said as accepted, rejected, or cannot tell, never the value.
 *
 * @param {string} name @param {ReturnType<typeof emptyRow>} row
 * @param {VaultConfig & { fetchImpl: typeof fetch, now: () => number }} config
 * @param {{ privateKey: CryptoKey, publicKey: string }} key @param {{ userId: string, login: string }} who
 * @param {() => Promise<void>} save
 * @returns {Promise<{ ok: true, answer: { name: string, state: 'accepted'|'rejected'|'unknown' }, text: string } | ReturnType<typeof refuse>>}
 */
async function testItem(name, row, config, key, who, save) {
  const store = /** @type {VaultStore} */ (config.store);
  /** @param {'accepted'|'rejected'|'unknown'} state @param {string} text */
  const said = (state, text) => /** @type {const} */ ({ ok: true, answer: { name, state }, text });
  if (name === 'claude') {
    const row = await store.get(`gh:${who.userId}`);
    if (!row?.sealed || row.forgotten) return refuse('not_kept', 'Your vault holds no Claude login to test. Keep one first.');
    // A SIGN-IN IS RENEWED FIRST if it is due, as a box would be handed it,
    // so a refresh token Claude no longer takes is found here and not by a
    // box once the access token runs out.
    const { held, problem, refused } = await freshClaude(store, key, who.userId, { ...config, by: 'a test' });
    // AND HOW IT HAS BEEN RENEWED, for a sign-in: the record is what says
    // whether a sign-in that stopped was renewed here or ended elsewhere
    // (claude-login.js, describeRenewals). A setup-token is never renewed.
    const history = row.kind === 'login' ? ` ${describeRenewals(await claudeRenewals(store, who.userId, Number(row.at)), Number(row.at), config.now())}` : '';
    /** @param {'accepted'|'rejected'|'unknown'} state @param {string} text */
    const told = (state, text) => said(state, `${text}${history}`);
    if (!held) return told('rejected', problem ?? 'Your Claude login does not open with this minter’s key, so nothing could be given it. Keep it again.');
    if (problem) return told(refused ? 'rejected' : 'unknown', problem);
    const token = held.bearer;
    const r = await probeClaude({ token }, { fetchImpl: config.fetchImpl });
    if (r.state === 'accepted') {
      return told('accepted', r.status === 429 || r.status === 529
        ? `Your Claude login was accepted just now, though Claude said it is busy (${r.status}).`
        : 'Your Claude login works: Claude answered a one-token request with it just now.');
    }
    if (r.state === 'rejected') {
      return told('rejected', `Claude refused your login just now (401${r.why ? `: ${r.why}` : ''}). Runners and boxes given it stop at their first message. Keep a new one from claude setup-token.`);
    }
    return told('unknown', `Whether your Claude login works could not be told just now: ${r.why ?? `the API answered ${r.status}`}.`);
  }
  if (itemKind(name) !== 'oauth') {
    return refuse('not_testable', `${label(name)} is handed over as it is, and there is no service this Worker could ask about it.`);
  }
  const item = row.items[name];
  if (!item?.sealed || item.forgotten) return refuse('not_kept', `Your vault holds no ${label(name)} sign-in to test. Keep one first.`);
  /** @type {any} */
  let inside;
  try {
    inside = await open({ privateKey: key.privateKey, publicKey: key.publicKey, aad: vaultAtRestAad(who.userId, name), sealed: item.sealed });
  } catch {
    return said('rejected', `${label(name)} does not open with this minter’s key, so nothing could be given it. Sign in again from your phone or the signing page.`);
  }
  const due = inside.expiresAt !== null && Number(inside.expiresAt) - config.now() < REFRESH_AHEAD_MS;
  if (inside.refreshToken && (due || name === 'cloudflare')) {
    const r = await renewItem(who.userId, name, item, inside, key, config);
    if (!r.ok) {
      const refused = /refused|rejected|invalid|expired/i.test(r.message);
      return said(refused ? 'rejected' : 'unknown', refused
        ? `${label(name)} would not renew your sign-in just now (${r.message}). Boxes stop being given it once it runs out. Sign in again from your phone or the signing page.`
        : `Whether your ${label(name)} sign-in works could not be told just now: ${r.message}.`);
    }
    row.items[name] = r.item;
    await save();
    inside = r.inside;
    if (name === 'cloudflare') return said('accepted', 'Cloudflare renewed your sign-in just now, so it works.');
  }
  if (inside.expiresAt !== null && Number(inside.expiresAt) <= config.now()) {
    return said('rejected', `Your ${label(name)} sign-in has run out and has nothing to renew it with. Sign in again from your phone or the signing page.`);
  }
  if (name === 'cloudflare') {
    return said('unknown', 'Your Cloudflare sign-in has not run out, and has no renewal to ask Cloudflare with, so whether it still works cannot be told from here.');
  }
  const whose = await githubUser({ token: String(inside.accessToken), fetchImpl: config.fetchImpl });
  if (whose.ok) return said('accepted', `GitHub works: it answered as ${whose.login} just now.`);
  return /\(401\)/.test(whose.message)
    ? said('rejected', `GitHub refused your sign-in just now. Boxes given it cannot reach your repositories. Sign in again from your phone or the signing page.`)
    : said('unknown', `Whether your GitHub sign-in works could not be told just now: ${whose.message}.`);
}

/** @param {string} name */
function label(name) {
  if (name === 'claude') return 'your Claude login';
  if (Object.hasOwn(OAUTH_PROVIDERS, name)) return OAUTH_PROVIDERS[/** @type {keyof typeof OAUTH_PROVIDERS} */ (name)].label;
  if (name.startsWith(HYPERVISOR_PREFIX)) return `the hypervisor at ${name.slice(HYPERVISOR_PREFIX.length)}`;
  return name.startsWith(SECRET_PREFIX) ? `the secret ${name.slice(SECRET_PREFIX.length)}` : name;
}

/**
 * The Claude item, in the row claude.js keeps it in, so a runner's hand-out
 * and a box's read the same token. The same checks as a deposit, and the same
 * fleet account kept beside it, which a runner's hand-out matches against the
 * runner's owner (claude.js, answerLogin).
 *
 * A whole sign-in a machine made (`{ signIn }`, claude-login.js) is kept in
 * the same row as a setup-token, and replaces it: one Claude login a person.
 *
 * @param {VaultStore} store @param {{ publicKey: string }} key
 * @param {{ userId: string, login: string }} who @param {string} email
 * @param {number} at @param {string|{ signIn: unknown }|null} what @param {typeof fetch} fetchImpl
 */
async function putClaude(store, key, who, email, at, what, fetchImpl) {
  const signIn = what !== null && typeof what === 'object' ? claudeSignIn(what.signIn) : null;
  if (what !== null && typeof what === 'object' && !signIn) return refuse('bad_token', 'That is not a Claude sign-in. Make it on a machine again.');
  const token = signIn ? signIn.oauth.accessToken : /** @type {string|null} */ (what);
  if (token !== null && !CLAUDE_RE.test(token)) {
    return refuse('bad_token', 'That is not a Claude token. Paste the one line `claude setup-token` printed.');
  }
  const prior = await store.get(`gh:${who.userId}`);
  if (prior && Number(prior.at) >= at) return refuse('stale', 'Your Claude login has a newer change than this one. Nothing was changed.');
  if (token === null) {
    await store.put(`gh:${who.userId}`, { at, login: who.login, forgotten: true });
    return /** @type {const} */ ({ ok: true, text: 'Forgot your Claude login. Boxes and runners stop being given it.' });
  }
  // ASKED FIRST, as a deposit asks (claude.js, checkBeforeKeeping).
  const checked = await checkBeforeKeeping(token, fetchImpl, signIn ? 'login' : 'token');
  if ('refusal' in checked) return checked.refusal;
  await store.put(`gh:${who.userId}`, {
    at, login: who.login, email, kind: signIn ? 'login' : 'token',
    sealed: await seal({ to: key.publicKey, aad: atRestAad(who.userId), payload: signIn ?? { token } }),
  });
  return /** @type {const} */ ({
    ok: true,
    text: signIn
      ? `Kept your Claude sign-in for your runners and the boxes you approve, with Remote Control. It is renewed here and nowhere else.${checked.said}`
      : `Kept your Claude login for your runners and the boxes you approve.${checked.said}`,
  });
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
  /** @type {Array<{ name: string, at: number, kind?: string }>} */
  const items = Object.entries(row.items)
    .filter(([, v]) => v && !v.forgotten && v.sealed)
    .map(([n, v]) => ({ name: n, at: Number(v.at) }));
  // WHICH KIND, because only a sign-in opens Remote Control, and a phone that
  // said "Kept" over a setup-token let a person think it did.
  if (claude?.sealed && !claude.forgotten) items.push({ name: 'claude', at: Number(claude.at), kind: claude.kind === 'login' ? 'login' : 'token' });
  items.sort((x, y) => (x.name < y.name ? -1 : 1));
  const grants = Object.entries(row.grants)
    .filter(([, g]) => g && !g.revoked && g.jwk)
    .map(([hash, g]) => ({ key: hash, fingerprint: hash.slice(0, 16), label: String(g.label || ''), email: String(g.email || ''), at: Number(g.at), ...(Array.isArray(g.only) ? { only: g.only.map(String) } : {}) }))
    .sort((x, y) => (x.label < y.label ? -1 : 1));
  return { login: row.login, items, grants };
}

/**
 * A box asks for everything it has been approved to hold, from the people
 * still in the fleet.
 *
 * `members` is the coordinator's, beside the box's signed request, which the
 * box cannot make: every fleet account with a credential that still works
 * (core.js, #onHostVault). A grant whose account is not among them gives
 * nothing and renews nothing, and its person drops out of the answer, which
 * is what makes an honest box delete what it held for them (vault-store.js,
 * applyVault). ABSENT, it is a coordinator from before the list, and every
 * grant counts as it always did, so the two Workers deploy in either order;
 * this repository's coordinator always sends it. Present and not a list of
 * addresses is refused: guessing at it either way is the wrong one.
 *
 * @param {unknown} ask  `{ request: { v: 1, hostKey, at, reply }, signature, members? }`,
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
  const listed = /** @type {any} */ (ask)?.members;
  /** @type {Set<string>|null} */
  let members = null;
  if (listed !== undefined) {
    if (!Array.isArray(listed) || listed.length > MAX_MEMBERS || listed.some((e) => typeof e !== 'string' || e.length > MEMBER_MAX_LENGTH)) {
      return refuse('bad_params', 'The fleet’s list of who is in it is not in the shape one takes.');
    }
    members = new Set(listed.map(normaliseEmail).filter(Boolean));
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
    const one = await withLock(`row:${userId}`, () => itemsFor(userId, hash, jwk, store, key, { ...config, fetchImpl, now }, members));
    if (one) accounts.push(one);
  }
  const sealed = await seal({ to: String(req.reply), aad: VAULT_BOX_AAD, payload: { at: now(), accounts } });
  return { ok: true, sealed, text: accounts.length ? `This box holds credentials for ${accounts.length} ${accounts.length === 1 ? 'person' : 'people'}.` : 'Nobody has approved this box to hold their credentials.' };
}

/**
 * One person's items for one box, renewing what is close to running out. Null
 * when their approval of this box is gone or is for a different key, or when
 * the fleet account that made it is no longer in the fleet.
 *
 * @param {string} userId @param {string} hash @param {{ x: string, y: string }} jwk
 * @param {VaultStore} store @param {{ privateKey: CryptoKey, publicKey: string }} key
 * @param {VaultConfig & { fetchImpl: typeof fetch, now: () => number }} config
 * @param {Set<string>|null} members  who is in the fleet, or null from a
 *   coordinator that does not say (answerVaultBox)
 */
async function itemsFor(userId, hash, jwk, store, key, config, members) {
  const row = emptyRow(await store.get(`v:${userId}`));
  const grant = row.grants[hash];
  if (!grant || grant.revoked || grant.jwk?.x !== jwk.x || grant.jwk?.y !== jwk.y) return null;
  // BEFORE ANYTHING IS OPENED OR RENEWED: a removed person's refresh token is
  // not rotated for a box that will not be given the result. A grant has
  // named its fleet account since grants began, so one naming nobody is
  // nobody's on the list.
  if (members && !members.has(normaliseEmail(grant.email))) return null;
  /** @type {Array<{ name: string, value: string, expiresAt: number|null, login?: Record<string, unknown>, account?: Record<string, unknown> }>} */
  const items = [];
  /** @type {string[]} */
  const problems = [];
  let changed = false;
  const only = Array.isArray(grant.only) ? new Set(grant.only.map(String)) : null;
  for (const [name, item] of Object.entries(row.items)) {
    if (!item?.sealed || item.forgotten) continue;
    if (only && !only.has(name)) continue;
    const kind = itemKind(name);
    /** @type {any} */
    let inside;
    try {
      inside = await open({ privateKey: key.privateKey, publicKey: key.publicKey, aad: vaultAtRestAad(userId, name), sealed: item.sealed });
    } catch {
      problems.push(`${label(name)} does not open with this minter’s key; it was kept under a key that has since changed.`);
      continue;
    }
    if (kind === 'secret' || kind === 'hypervisor') {
      items.push({ name, value: String(inside.value), expiresAt: null });
      continue;
    }
    if (kind !== 'oauth') continue;
    const due = inside.expiresAt !== null && Number(inside.expiresAt) - config.now() < REFRESH_AHEAD_MS;
    if (due && inside.refreshToken) {
      const r = await renewItem(userId, name, item, inside, key, config);
      if (r.ok) {
        inside = r.inside;
        row.items[name] = r.item;
        changed = true;
      } else {
        problems.push(`${label(name)} could not be renewed: ${r.message}. Sign in again from your phone or the signing page.`);
      }
    }
    if (inside.expiresAt === null || Number(inside.expiresAt) > config.now()) {
      items.push({ name, value: String(inside.accessToken), expiresAt: inside.expiresAt === null ? null : Number(inside.expiresAt) });
    }
  }
  if (changed) await store.put(`v:${userId}`, row);
  if (!only || only.has('claude')) {
    // A SIGN-IN GOES OUT AS ITS ACCESS TOKEN, renewed first if it is due, and
    // never with its refresh token (claude-login.js). `value` is the bearer
    // either way, so a box from before sign-ins uses it as the token it
    // always took; `login` and `account` are what a newer box writes a
    // credentials file from, which is what Remote Control needs.
    const { held, problem } = await freshClaude(store, key, userId, { ...config, by: 'a box' });
    if (problem) problems.push(problem);
    if (held?.kind === 'login' && held.oauth) {
      const { scopes, subscriptionType, rateLimitTier } = held.oauth;
      items.push({ name: 'claude', value: held.bearer, expiresAt: held.expiresAt, login: { scopes, subscriptionType, rateLimitTier }, account: held.account ?? {} });
    } else if (held) {
      items.push({ name: 'claude', value: held.bearer, expiresAt: null });
    }
  }
  return { email: String(grant.email || ''), login: row.login, items, problems };
}

/**
 * The keys a row lists, without the ones removed.
 *
 * @param {any} row
 * @returns {Array<{ kid: string, key: { kty: string, crv: string, x: string, y: string }, label: string, at: number }>}
 */
function liveKeys(row) {
  if (!row || !Array.isArray(row.keys)) return [];
  return row.keys
    .filter((/** @type {any} */ k) => k && !k.removed && KEY_HASH_RE.test(String(k.kid)) && boxKey(k.key))
    .map((/** @type {any} */ k) => ({ kid: String(k.kid), key: /** @type {any} */ (boxKey(k.key)), label: String(k.label || ''), at: Number(k.at) }));
}

/**
 * The signing keys a box checks intents with, for the people in the fleet,
 * signed with this minter's signing key so a box can tell this answer from
 * one the coordinator that carried it made up (docs/signed-intents.md). The
 * box pins that key from the well-known address the coordinator never serves.
 *
 * Public keys, so nothing is sealed: what the signature adds is who said it.
 * `members` is the coordinator's and can only take away, as it does for the
 * vault: a person it leaves off has no keys listed, and nobody it adds has
 * any a person did not file.
 *
 * @param {unknown} ask  `{ request: { v: 1, hostKey, at }, signature, members }`,
 *   the signature being the box's key over signingInput('vault-keys', request)
 * @param {VaultConfig} config
 */
export async function answerVaultKeys(ask, config) {
  if (!config.store || !config.signingKey) {
    return refuse('no_signing_key', 'The minting Worker holds no signing key, so it lists no device keys. See docs/signed-intents.md.');
  }
  const { now = () => Date.now() } = config;
  const req = /** @type {any} */ (ask)?.request;
  const signature = String(/** @type {any} */ (ask)?.signature || '');
  const jwk = boxKey(req?.hostKey);
  const at = Number(req?.at);
  const listed = /** @type {any} */ (ask)?.members;
  if (req?.v !== 1 || !jwk || !Number.isFinite(at) || !SIGNATURE_RE.test(signature)) {
    return refuse('bad_params', 'That is not a box’s request for the fleet’s device keys.');
  }
  if (!Array.isArray(listed) || listed.length > MAX_MEMBERS || listed.some((e) => typeof e !== 'string' || e.length > MEMBER_MAX_LENGTH)) {
    return refuse('bad_params', 'The fleet’s list of who is in it is not in the shape one takes.');
  }
  if (Math.abs(now() - at) > DEPOSIT_MAX_AGE_MS) return refuse('stale', 'That request is more than ten minutes old. The box’s clock is wrong, or it is a replay.');
  if (!(await verify(jwk, signature, signingInput('vault-keys', { v: 1, hostKey: jwk, at })))) {
    return refuse('bad_signature', 'That request is not signed by the key it names.');
  }
  /** @type {{ privateJwk: any, publicJwk: any }} */
  let signing;
  try {
    signing = await config.signingKey();
  } catch (e) {
    return refuse('bad_signing_key', `The signing key does not load: ${/** @type {Error} */ (e).message}.`);
  }
  const store = /** @type {VaultStore} */ (config.store);
  // EVERYBODY WHO EVER FILED A KEY, with none when they removed them all:
  // a box that has taken a person's signature before refuses their unsigned
  // requests until the minter says, signed, that they keep no key now. A
  // person left out of this list says nothing either way, which is all a
  // coordinator that leaves somebody off the members list can make it say.
  /** @type {Array<{ email: string, keys: Array<{ kid: string, key: any, label: string }>, revoked?: string[] }>} */
  const people = [];
  const t = now();
  for (const email of [...new Set(listed.map(normaliseEmail).filter(Boolean))].sort()) {
    const row = await store.get(`${DEVICE_KEYS_PREFIX}${email}`);
    if (!row) continue;
    const keys = liveKeys(row).map(({ kid, key, label: l }) => ({ kid, key, label: l }));
    const revoked = (Array.isArray(row.revoked) ? row.revoked : []).filter((/** @type {any} */ r) => Number(r?.until) >= t).map((/** @type {any} */ r) => String(r.id));
    people.push({ email, keys, ...(revoked.length ? { revoked } : {}) });
  }
  const payload = { v: 1, at: now(), host: await boxKeyHash(jwk), people };
  return {
    ok: true,
    payload,
    signature: await sign(signing.privateJwk, signingInput('vault-keys-answer', payload)),
    text: people.some((p) => p.keys.length) ? `Signing keys for ${people.filter((p) => p.keys.length).length} ${people.filter((p) => p.keys.length).length === 1 ? 'person' : 'people'}.` : 'Nobody in the fleet has listed a signing key.',
  };
}
