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

import { API_PROVIDERS, API_KEY_ITEMS, ENGINES, ENGINE_IDS, DEFAULT_ENGINE } from '../protocol/engines.js';
import { SANDBOX_PROVIDER_NAMES, sandboxProviderOf, sandboxDepositProblem } from '../protocol/sandboxes.js';
import { SEAL_KEY_RE, VAULT_REQUEST_AAD, VAULT_REPLY_AAD, VAULT_BOX_AAD, atRestAad, vaultAtRestAad, seal, open } from '../seal.js';
import { verify, sign, signingInput } from '../crypto.js';
import { githubUser } from '../../core/repo-tokens.js';
import { refreshGithubToken, refreshCloudflareToken, exchangeCode } from '../../core/oauth-refresh.js';
import { DEPOSIT_MAX_AGE_MS, checkBeforeKeeping } from './claude.js';
import { probeClaude } from '../../core/claude-token-probe.js';
import { claudeSignIn, claudeRenewals, describeRenewals, freshClaude, checkClaude } from './claude-login.js';
import { SIGNIN_PREFIX, deviceSignedIn } from './github.js';
import { HYPERVISOR_PREFIX, HYPERVISOR_ADDRESS_RE, splitHypervisorItem } from '../protocol/hypervisor-name.js';
import { MEMBER_PREFIX, memberOfPrincipal } from '../protocol/members.js';
import { ORG_OPS, runOrgOp, resolveFor, logCustody, ownCustody, membersForBoxes, loadTree, mayActFor, dropAddedBy } from './org.js';

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
 * phone was handed (src/fleet/host/xo-setup.js, hand-off), and
 * `hypervisor:<address>+<box>` for one box's own user on that Xen Orchestra
 * (src/fleet/host/xo-box-users.js), which the vault hands to that box alone.
 * Its own kind and not a named secret, because a named secret is handed to
 * SESSIONS by name (`fleet-secret`), and a pool's token is for the box that
 * makes machines on it and nothing it runs. A box keeps it in memory only
 * (src/fleet/host/xo-pools.js). The grammar is protocol/hypervisor-name.js's,
 * which the box reads with too.
 */
export { HYPERVISOR_PREFIX, HYPERVISOR_ADDRESS_RE, splitHypervisorItem };

/**
 * The items an engine runs on (docs/engines.md, "Credentials"): a Codex
 * sign-in, as the text of the `auth.json` that `codex login` leaves, and a
 * GitHub Copilot token. Pasted by a custodian, sealed and kept like a named
 * secret, listed by name and never read back.
 */
export const ENGINE_ITEM_KINDS = /** @type {readonly string[]} */ (Object.freeze(['codex', 'copilot', ...API_KEY_ITEMS]));
/**
 * A metered API key (docs/api-engines.md): one unbroken run of printable
 * characters, of a length a key has. Never tried against its provider from
 * here, so this is all that is known of it.
 */
const API_KEY_RE = /^[\x21-\x7e]{16,512}$/;
/** A Copilot token: one GitHub hands out, by its alphabet and length. Never tried against GitHub from here. */
const COPILOT_TOKEN_RE = /^[A-Za-z0-9_-]{20,400}$/;

/**
 * Is this the sign-in `codex login` writes: a ChatGPT sign-in, with a
 * refresh token? A file that holds only an API key is not kept: Codex runs
 * here on a ChatGPT sign-in, and the keys a vault keeps are the ones in
 * API_PROVIDERS (docs/api-engines.md).
 *
 * @param {string} value
 * @returns {{ ok: true } | { ok: false, text: string }}
 */
export function checkCodexSignIn(value) {
  /** @type {any} */
  let read;
  try {
    read = JSON.parse(value);
  } catch {
    return { ok: false, text: 'That is not the auth.json that codex login writes: it does not read as JSON. Paste the whole file.' };
  }
  if (!read || typeof read !== 'object' || Array.isArray(read)) return { ok: false, text: 'That is not the auth.json that codex login writes. Paste the whole file.' };
  if (typeof read.tokens?.refresh_token !== 'string' || !read.tokens.refresh_token) {
    return {
      ok: false,
      text: read.OPENAI_API_KEY
        ? 'That auth.json holds an API key and no ChatGPT sign-in. For Codex a vault keeps the sign-in that codex login makes, and no OpenAI key.'
        : 'That auth.json holds no ChatGPT sign-in. Run codex login, sign in with ChatGPT, and paste the file it writes.',
    };
  }
  return { ok: true };
}

/**
 * A vault's id: a person's GitHub account id, or an agent member's principal
 * (`member:<id>`). Every row a vault has is keyed by it.
 *
 * @param {string} id
 */
const isVaultId = (id) => /^[0-9]{1,20}$/.test(id) || memberOfPrincipal(id) !== null;

/** What a custodian's request changes in a vault, and so what is written to its log. */
const CUSTODY_LOGGED = Object.freeze(['put', 'forget', 'connect', 'grant', 'revoke']);

/**
 * A vault's sentences say "your". Said to a custodian about a member's vault
 * they are the member's, so the few nouns those sentences use are renamed.
 *
 * @param {string} text @param {string} whose
 */
function forMember(text, whose) {
  return String(text ?? '').replace(/\b[Yy]our (Claude login|Claude sign-in|vault|credentials|sign-in|login|runners|repositories)\b/g, `${whose}’s $1`);
}

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
 * @property {boolean} [takesEngines]  set per box request: whether that box said it takes the sign-ins an engine runs on (answerVaultBox)
 * @property {string[]|null} [boxEngines]  set per box request: the engines that box said it runs, or null from a box that says only that it takes engines
 * @property {boolean} [takesApiKeys]  set per box request: whether that box said it takes metered API keys (docs/api-engines.md)
 * @property {boolean} [takesSandboxes]  set per box request: whether that box said it takes a sandbox provider's record
 * @property {() => number} [now]
 */

/** @param {string} code @param {string} text */
const refuse = (code, text) => ({ ok: false, error: { code }, text });

/**
 * What a vault item is, from its name. Null for a name a vault does not keep.
 *
 * @param {string} name
 * @returns {'claude'|'oauth'|'secret'|'sandbox'|'hypervisor'|'engine'|null}
 */
export function itemKind(name) {
  if (name === 'claude') return 'claude';
  if (ENGINE_ITEM_KINDS.includes(name)) return 'engine';
  if (Object.hasOwn(OAUTH_PROVIDERS, name)) return 'oauth';
  if (name.startsWith(SECRET_PREFIX) && SECRET_NAME_RE.test(name.slice(SECRET_PREFIX.length))) return 'secret';
  if (splitHypervisorItem(name)) return 'hypervisor';
  // A sandbox provider's record (docs/api-engines.md): its key and the
  // templates the person offers, for a provider this fleet has a driver for.
  if (sandboxProviderOf(name)) return 'sandbox';
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
  const split = splitHypervisorItem(name);
  if (!split || !record || typeof record !== 'object' || typeof record.token !== 'string' || !record.token) return false;
  if (record.address !== split.address) return false;
  // A PER-BOX TOKEN FILED UNDER THE SHARED NAME would be handed to every
  // approved box, and a shared token filed under a box's name would be that
  // box's alone while saying it is the user the name says. Neither files.
  // A Proxmox cluster's record (`kind`, pve-pools.js) has no users of its
  // own to be filed per box.
  if (split.box === null) return record.box === undefined || record.box === null;
  return record.box === split.box && record.kind === undefined;
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
  const tree = await loadTree(store);
  for (const k of (await store.list({ prefix: 'gh:' })).keys()) {
    const userId = k.slice(3);
    if (!isVaultId(userId)) continue;
    // ONE AT A TIME, each under its person's lock: a check renewing alongside
    // a box renewing the same sign-in would rotate one refresh token twice.
    const one = await withLock(`row:${userId}`, () => checkClaude(store, key, userId, { fetchImpl, now })).catch((/** @type {any} */ e) => {
      console.warn(`minter: could not ask after ${userId}'s Claude sign-in: ${e?.message || e}`);
      return null;
    });
    // A MEMBER'S SIGN-IN IS TOLD TO EVERY CUSTODIAN: it has no address of its
    // own, so `tell` is who to tell, as this Worker holds them now.
    const member = memberOfPrincipal(userId);
    const said = one && member ? { ...one, member, tell: await mayActFor(store, tree, member) } : one;
    if (said && 'refusedAccess' in said) refused.push(said);
    else if (said) ended.push(said);
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

/**
 * Everything an agent member's vault keeps and every machine approved for
 * it, forgotten at once (org.js, a removal). Called under the vault's `row:`
 * lock.
 *
 * WHEN IT WAS EMPTIED IS KEPT ON THE ROW (`emptied`), and nothing asked at or
 * before then is taken afterwards (runDeviceOp). The row used to be written
 * as nothing at all, which also dropped the time of every change it had
 * held: an approval sealed for the member that was removed, sent again
 * inside its ten minutes once the id had been filed again, was not "older
 * than a newer change" any more, and the old member's box was handed the new
 * member's sign-ins. One time for the whole vault and not a tombstone an
 * item, because a request the coordinator held back and never delivered
 * names an item the vault never had.
 *
 * @param {VaultStore} store @param {string} vaultId  `member:<id>` @param {number} at
 * @param {{ always?: boolean }} [o]  `always` writes the row though the vault never had one: a removal, which a held-back request must not outlive
 * @returns {Promise<{ items: number, grants: number }>} how much there was
 */
async function emptyMemberVault(store, vaultId, at, { always = false } = {}) {
  const kept = await store.get(`v:${vaultId}`);
  const claude = await store.get(`gh:${vaultId}`);
  const items = Object.values(kept?.items ?? {}).filter((v) => v && !v.forgotten && v.sealed).length + (claude?.sealed && !claude.forgotten ? 1 : 0);
  const grants = Object.values(kept?.grants ?? {}).filter((g) => g && !g.revoked && g.jwk).length;
  if (kept || always) await store.put(`v:${vaultId}`, { login: vaultId, items: {}, grants: {}, emptied: Math.max(at, Number(kept?.emptied) || 0) });
  if (claude) await store.put(`gh:${vaultId}`, { at: Math.max(at, Number(claude.at) || 0), login: vaultId, forgotten: true });
  return { items, grants };
}

/**
 * Take back every approval one account's vault made under an address that is
 * no longer that account's (org.js, `releaseaddress`). Each is left as a
 * removal, as the person's own would be, so an older approval sent again
 * cannot bring it back. Nothing the vault keeps is touched: it is still that
 * account's, and is approved again under whatever address they hold next.
 * Called under the vault's own lock.
 *
 * @param {VaultStore} store @param {string} account @param {string} address @param {number} at
 * @returns {Promise<number>} how many approvals went
 */
async function unfileAddress(store, account, address, at) {
  const kept = await store.get(`v:${account}`);
  if (!kept) return 0;
  const row = emptyRow(kept);
  let gone = 0;
  for (const [hash, grant] of Object.entries(row.grants)) {
    if (!grant || grant.revoked || !grant.jwk || normaliseEmail(grant.email) !== address) continue;
    row.grants[hash] = { at: Math.max(at, Number(grant.at) || 0), revoked: true };
    gone += 1;
    await withLock(`box:${hash}`, async () => {
      const index = (await store.get(`box:${hash}`)) || { accounts: {} };
      const accounts = { ...(index.accounts || {}) };
      delete accounts[account];
      await store.put(`box:${hash}`, { accounts });
    });
  }
  if (gone) await store.put(`v:${account}`, row);
  return gone;
}

/** @param {any} row */
function emptyRow(row) {
  return {
    login: String(row?.login || ''), items: { ...(row?.items || {}) }, grants: { ...(row?.grants || {}) },
    // Whether this person's managers may manage it (org.js), kept with the row it is about.
    ...(row?.custody && typeof row.custody === 'object' ? { custody: { allow: row.custody.allow === true, at: Number(row.custody.at) || 0 } } : {}),
    // When an agent member's vault was last emptied (emptyMemberVault).
    ...(Number(row?.emptied) > 0 ? { emptied: Number(row.emptied) } : {}),
  };
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

  const store = /** @type {VaultStore} */ (config.store);
  // THE ORGANIZATION'S TREE AND ITS CUSTODIANS (org.js), one change at a
  // time. `admin` is the coordinator's word for who administers the fleet,
  // read at one moment only: when nobody administers the organization here
  // yet and the first admin files themselves.
  if (ORG_OPS.includes(inside.op)) {
    const done = await withLock('org', () => runOrgOp(inside, { store, email, who, at, fleetAdmin: a.admin === true }));
    if (!done.ok) return done;
    // AN AGENT MEMBER'S VAULT, EMPTIED: when it is removed, and before a new
    // one is filed under an id something was left under (org.js says which).
    // Under the vault's own lock and after the tree's is let go, the order
    // every request for a member takes them in, so neither waits on the other.
    let text = done.text;
    if (done.empty) {
      const memberVault = `${MEMBER_PREFIX}${done.empty}`;
      const gone = await withLock(`row:${memberVault}`, () => emptyMemberVault(store, memberVault, at, { always: inside.remove === true }));
      if (inside.remove === true) {
        // IN NUMBERS, since it cannot be undone and nobody can look after.
        const what = [
          ...(gone.items ? [`${gone.items} thing${gone.items === 1 ? '' : 's'} it kept`] : []),
          ...(gone.grants ? [`${gone.grants} approved machine${gone.grants === 1 ? '' : 's'}`] : []),
        ];
        text += what.length
          ? ` Its vault went with it: ${what.join(' and ')} ${gone.items + gone.grants === 1 ? 'is' : 'are'} forgotten, and a box stops being given anything of it when it next asks.`
          : ' Its vault kept nothing.';
        if (gone.items || gone.grants) await logCustody(store, memberVault, { at, by: email, op: 'forget', name: 'everything, with the member' });
      } else if (gone.items || gone.grants) {
        text += ` A member removed before left a vault under this id. It was emptied first, so nothing of it is ${done.empty}’s.`;
        await logCustody(store, memberVault, { at, by: email, op: 'forget', name: 'what an earlier member left' });
      }
    }
    // AN ADDRESS RELEASED (org.js, `releaseaddress`): the machines its old
    // account approved under it stop being given that account's sign-ins.
    // A box files what it is handed by the address, so without this whoever
    // signs in under the address next would start sessions on them.
    if (done.released) {
      const { address, account } = done.released;
      const machines = await withLock(`row:${account}`, () => unfileAddress(store, account, address, at));
      if (machines) {
        text += ` ${machines} machine${machines === 1 ? '' : 's'} approved under it ${machines === 1 ? 'is' : 'are'} no longer approved, and ${machines === 1 ? 'stops' : 'stop'} being given anything when ${machines === 1 ? 'it next asks' : 'they next ask'}. What that account keeps is still its own.`;
      }
      await logCustody(store, account, { at, by: email, op: 'release', name: address });
    }
    return { ok: true, sealed: await seal({ to: reply, aad: VAULT_REPLY_AAD, payload: done.answer ?? {} }), text, ...(inside.op === 'org' ? {} : { changed: true }) };
  }
  // FOR A MEMBER'S VAULT, when the request names one (docs/members.md): an
  // agent's own, or a person's whose manager this is and who allowed it.
  // Whose vault is opened is decided here, from the tree and the custodians
  // this Worker holds, and from nothing the coordinator said.
  /** @type {{ userId: string, login: string }} */
  let vault = who;
  /** @type {Acting|null} */
  let acting = null;
  if (inside.for !== undefined && inside.for !== null && inside.for !== '') {
    const whose = await resolveFor(store, inside.for, email, who);
    if (!whose.ok) return whose;
    if (!whose.own) ({ vault, acting } = whose);
  }

  const result = await withLock(`row:${vault.userId}`, () => runDeviceOp(inside, { ...config, fetchImpl, now }, key, vault, email, at, acting));
  if (!result.ok) return acting ? { ...result, text: forMember(result.text, acting.member) } : result;
  const sealedBack = await seal({ to: reply, aad: VAULT_REPLY_AAD, payload: result.answer ?? {} });
  // WHAT A CUSTODIAN CHANGED, written beside the vault for its owner to read,
  // and for a person's vault said outside the seal too, so the coordinator
  // can tell their phone. The log is this Worker's; the push can be dropped
  // by a dishonest coordinator, which is why the log exists.
  /** @type {{ notify?: { email: string, text: string } }} */
  let told = {};
  if (acting && CUSTODY_LOGGED.includes(inside.op)) {
    // NAMED BY WHAT THE OP DID (`did`, runDeviceOp), never by a field of the
    // request. It used to be `name`, then `provider`, as sent: a sign-in to
    // Cloudflare takes `provider` and reads no `name`, so a custodian who
    // sent both replaced a person's Cloudflare sign-in and had it written
    // here, and pushed to their phone, as a note they kept.
    const name = String(result.did ?? '').slice(0, 96);
    await logCustody(store, vault.userId, { at, by: acting.by, op: inside.op, name });
    if (acting.kind === 'person') told = { notify: { email: acting.owner, text: custodySentence(acting.by, inside.op, name) } };
  }
  // WHETHER IT CHANGED ANYTHING A BOX HOLDS, outside the seal, so the
  // coordinator can tell the boxes to ask now rather than at their next ten
  // minutes. A list changes nothing; everything else may (a test renews what
  // is due, and a box's key list rides the same ask). Never what changed.
  return { ok: true, sealed: sealedBack, text: acting ? forMember(result.text, acting.member) : result.text, ...(inside.op === 'list' ? {} : { changed: true }), ...told };
}

/** @typedef {{ by: string, member: string, kind: 'person'|'agent', owner: string }} Acting  a custodian, and whose vault they opened */

/**
 * What a person is told a custodian did to their vault. Names, never values.
 *
 * @param {string} by @param {string} op @param {string} name
 */
function custodySentence(by, op, name) {
  const what = name === 'claude' ? 'your Claude login' : name || 'something';
  if (op === 'put' || op === 'connect') return `${by} kept ${what} in your vault, as one of your managers.`;
  if (op === 'forget') return `${by} removed ${what} from your vault, as one of your managers.`;
  if (op === 'grant') return `${by} approved a machine to hold your credentials, as one of your managers.`;
  return `${by} removed a machine from the ones that hold your credentials, as one of your managers.`;
}

/**
 * @param {any} inside @param {VaultConfig & { fetchImpl: typeof fetch, now: () => number }} config
 * @param {{ privateKey: CryptoKey, publicKey: string }} key
 * @param {{ userId: string, login: string }} who  WHOSE VAULT: the asker's own, or the member's a custodian opened
 * @param {string} email  the asker's fleet address
 * @param {number} at
 * @param {Acting|null} [acting]  set when a custodian opened somebody else's vault (org.js, resolveFor)
 * @returns {Promise<{ ok: true, answer?: any, text: string, did?: string } | { ok: false, error: { code: string }, text: string }>}
 *   `did` is what a change was made to, as the op itself read it: the item
 *   kept or forgotten, the provider signed in to, the machine's fingerprint.
 *   It is what the custody log names (answerVaultDevice).
 */
async function runDeviceOp(inside, config, key, who, email, at, acting = null) {
  const store = /** @type {VaultStore} */ (config.store);
  const row = emptyRow(await store.get(`v:${who.userId}`));
  row.login = who.login || row.login;
  const save = () => store.put(`v:${who.userId}`, row);
  const name = String(inside.name ?? '');
  // THE FLEET ACCOUNT THE VAULT IS FILED UNDER: the asker's own, a person's
  // whose manager opened it, or none for an agent, which has no address.
  const owner = acting ? acting.owner : email;

  // A MEMBER'S VAULT THAT WAS EMPTIED takes nothing asked before it was
  // (emptyMemberVault): the member that request was made for is gone, and
  // the one under its id now is another. A list changes nothing and is
  // answered.
  if (inside.op !== 'list' && row.emptied && at <= row.emptied) {
    const whose = acting?.member ?? 'This member';
    return refuse('stale', `${whose} was removed, or filed again, after this was asked, so this could be a request made for the member that was there before. Nothing was changed. Ask again.`);
  }

  if (inside.op === 'list') {
    if (acting) {
      // A MEMBER'S, for its custodian: what it keeps and which machines hold
      // it. No device keys, which are the asker's own and listed there.
      return { ok: true, answer: { ...(await describe(row, store, who.userId)), for: acting.member }, text: `${acting.member}’s vault.` };
    }
    const devices = await store.get(`${DEVICE_KEYS_PREFIX}${email}`);
    return {
      ok: true,
      answer: {
        ...(await describe(row, store, who.userId)),
        devices: liveKeys(devices).map((k) => ({ ...k, yours: devices?.github === who.userId })),
        // WHO ELSE MAY MANAGE THIS VAULT, and what they did (org.js).
        custody: await ownCustody(store, email, who.userId, row),
      },
      text: `${who.login}’s vault.`,
    };
  }

  // WHAT IS THE ASKER'S ALONE: their signing keys, their delegations, and the
  // switch that lets managers in. A custodian of somebody's vault holds its
  // items and its machines, and none of these.
  if (acting && ['devicekey', 'revokedelegation', 'custody'].includes(inside.op)) {
    return refuse('bad_params', 'Signing keys, delegations and who may manage a vault belong to the person themselves, and are changed from their own device.');
  }

  // WHETHER THIS PERSON'S MANAGERS MAY MANAGE THEIR VAULT (org.js). Off until
  // they turn it on, from their own device, and theirs to turn off again.
  if (inside.op === 'custody') {
    if (row.custody && Number(row.custody.at) >= at) return refuse('stale', 'That setting has a newer change than this one. Nothing was changed.');
    row.custody = { allow: inside.allow === true, at };
    await save();
    return {
      ok: true,
      answer: { allow: row.custody.allow },
      text: row.custody.allow
        ? 'Your managers can now keep, test and remove what your vault holds, approve machines for it, and start sessions as you. Each thing they change is listed here.'
        : 'Your managers can no longer manage your vault. What they kept stays until you remove it.',
    };
  }

  // A DEVICE'S SIGNING KEY, filed under the fleet address the request names
  // (docs/signed-intents.md). A box takes a person's signature only with a key
  // this lists for them, so a key under the wrong address is a forged actor:
  // the address belongs to the first GitHub account that files a key under it.
  //
  // FOR GOOD, whether or not that account still lists a key. It used to be
  // "while that one keeps any", and the gap was the moment a person is least
  // able to notice: Dana loses her phone and removes its key, and a
  // coordinator that lies about who is signing in vouches her address for
  // another GitHub account, which is then Dana to every box she approved and
  // to every vault the tree gives her. An address changes hands only when an
  // org admin releases it (org.js, `releaseaddress`), which is somebody with
  // a name deciding it, written where the people it touches read it.
  if (inside.op === 'devicekey') {
    const jwk = boxKey(inside.key);
    if (!jwk) return refuse('bad_key', 'That is not a device’s signing key.');
    const kid = await boxKeyHash(jwk);
    const deviceLabel = String(inside.label ?? '').replace(/[^\w .@:'’()-]/g, '').trim().slice(0, 60);
    const remove = inside.remove === true;
    return withLock(`${DEVICE_KEYS_PREFIX}${email}`, async () => {
      const kept = await store.get(`${DEVICE_KEYS_PREFIX}${email}`);
      if (kept && typeof kept.github === 'string' && kept.github !== who.userId) {
        return refuse('address_taken', `${email} belongs to another GitHub account than ${who.login}: the first that listed a signing key under it, whether or not it lists one now. Nothing was changed. If the address is yours and you sign in to GitHub as somebody else now, an org admin releases it for you. If it is not yours, tell whoever runs the fleet.`);
      }
      // AN ADDRESS AN ORG ADMIN RELEASED takes no change made before the
      // release: a request the account it was taken from sealed a minute
      // earlier, sent again, would otherwise take it straight back.
      if (kept?.released && Number(kept.released.at) >= at) return refuse('stale', `${email} was released after this was asked, so this could be a replay. Nothing was changed.`);
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
        ...(kept?.released ? { released: kept.released } : {}),
      });
      // THIS ACCOUNT'S FIRST KEY UNDER THIS ADDRESS, and it has a vault
      // already: whoever added a person member at this address did not add
      // somebody new, and does not get what this account kept before
      // (org.js, dropAddedBy; docs/members.md, "Custodians of a person member").
      // A Claude login kept for runners is a vault too. It is filed by the
      // GitHub account alone (`gh:`), with no key and no `v:` row, so asking
      // after `v:` only handed it to whoever filed its owner's address.
      if (!remove && kept?.github !== who.userId && ((await store.get(`v:${who.userId}`)) || (await store.get(`gh:${who.userId}`))?.sealed)) {
        await withLock('org', () => dropAddedBy(store, email));
      }
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
      const kept = await putClaude(store, key, who, owner, at, what, config.fetchImpl);
      return kept.ok ? { ...kept, did: 'claude' } : kept;
    }
    if (inside.op === 'put' && kind !== 'secret' && kind !== 'hypervisor' && kind !== 'engine' && kind !== 'sandbox') {
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
      return { ok: true, did: name, text: `Forgot ${label(name)}. Boxes stop being given it when they next ask.` };
    }
    const value = String(inside.value ?? '');
    if (!value || value.length > MAX_SECRET) {
      return refuse('bad_value', kind === 'engine' ? `That is ${value.length} characters, and a vault keeps at most ${MAX_SECRET}. Paste the file or the token alone.` : `A named secret is between 1 and ${MAX_SECRET} characters.`);
    }
    if (name === 'codex') {
      const reads = checkCodexSignIn(value);
      if (!reads.ok) return refuse('bad_value', reads.text);
    }
    if (API_KEY_ITEMS.includes(name) && !API_KEY_RE.test(value.trim())) {
      return refuse('bad_value', 'That is not an API key: one is a single run of letters, digits and punctuation with no spaces. Paste the key alone.');
    }
    if (name === 'copilot' && !COPILOT_TOKEN_RE.test(value.trim())) {
      return refuse('bad_value', 'That is not a GitHub Copilot token: one is a single run of letters, digits, hyphens and underscores.');
    }
    if (kind === 'sandbox') {
      // WHAT IS KEPT IS WHAT WAS SENT, or it is refused saying which part is
      // not right. A box reads a record leniently; a deposit is not.
      const problem = sandboxDepositProblem(name, value);
      if (problem) return refuse('bad_value', problem);
    }
    if (kind === 'hypervisor' && !isHypervisorRecord(name, value)) {
      return refuse('bad_value', 'That is not the token record a hypervisor’s setup hands back, for that address.');
    }
    // A NEW DEPOSIT, so whichever machine held the last Codex sign-in holds
    // nothing of this one: `box` is not carried over (itemsFor).
    row.items[name] = { at, sealed: await seal({ to: key.publicKey, aad: vaultAtRestAad(who.userId, name), payload: { value: name === 'copilot' || API_KEY_ITEMS.includes(name) ? value.trim() : value } }) };
    await save();
    if (kind === 'engine') {
      return {
        ok: true,
        did: name,
        text: name === 'codex'
          ? 'Kept the Codex sign-in. It is handed to one approved machine, the first that runs Codex and asks for it, because Codex renews it there and a renewal ends every other copy, the one on the computer it was pasted from included.'
          : API_KEY_ITEMS.includes(name)
            ? `Kept ${label(name)}. It is given only to approved machines whose operator turned that provider on, for sessions whose engine bills to it. What it may spend is set at the provider, not here.`
            : 'Kept the GitHub Copilot token. The machines approved for this vault are given it for sessions whose engine runs on it.',
      };
    }
    return {
      ok: true,
      did: name,
      text: kind === 'sandbox'
        ? `Kept ${label(name)}. Approved machines whose operator turned that provider on can make machines there, and hold its key in memory only. The key is that whole account: what it may spend is set at the provider.`
        : kind === 'hypervisor'
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
      // A member's own vault is not a GitHub account, so there is no "same
      // person" to hold it to: its custodians choose the account it works as.
      if (!memberOfPrincipal(who.userId) && whose.userId !== who.userId) {
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
    return { ok: true, did: provider, answer: { account }, text: `Kept ${p.label}${account ? ` as ${account}` : ''} for the boxes you approve.` };
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
    // `email` is the fleet account the vault is filed under, which is what a
    // box files it under too; `by` is the custodian who approved it, when it
    // was not the vault's own person.
    row.grants[hash] = { at, jwk, email: owner, label: boxLabel, ...(only ? { only: [...new Set(only)] } : {}), ...(acting ? { by: acting.by } : {}) };
    await save();
    await withLock(`box:${hash}`, async () => {
      const index = (await store.get(`box:${hash}`)) || { accounts: {} };
      index.accounts = { ...(index.accounts || {}), [who.userId]: { at } };
      await store.put(`box:${hash}`, index);
    });
    const what = only ? only.map(label).join(', ') : 'your credentials';
    return { ok: true, did: hash.slice(0, 16), answer: { fingerprint: hash.slice(0, 16) }, text: `Approved ${boxLabel || 'that box'} (${hash.slice(0, 16)}) to hold ${what}.` };
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
    return { ok: true, did: hash.slice(0, 16), text: `${boxLabel} is no longer approved. It stops being given your credentials when it next asks, and forgets what it holds then.` };
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
  if (itemKind(name) === 'engine') {
    // SAID AS WHAT IT IS: not checked here, and where it is checked. Asking
    // the provider from this Worker would mean renewing a Codex sign-in away
    // from the machine that holds it, which ends that machine's copy.
    return said('unknown', `${label(name)} is not tried from here. The machine that runs the engine asks whether it is signed in before each turn, and a sign-in that has ended is said on that session then.`);
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
  if (name === 'codex') return 'the Codex sign-in';
  if (name === 'copilot') return 'the GitHub Copilot token';
  for (const p of Object.values(API_PROVIDERS)) if (p.item === name) return `the ${p.says} API key`;
  const sandbox = sandboxProviderOf(name);
  if (sandbox) return `your ${SANDBOX_PROVIDER_NAMES[/** @type {keyof typeof SANDBOX_PROVIDER_NAMES} */ (sandbox)]} account’s key and templates`;
  if (Object.hasOwn(OAUTH_PROVIDERS, name)) return OAUTH_PROVIDERS[/** @type {keyof typeof OAUTH_PROVIDERS} */ (name)].label;
  const hypervisor = splitHypervisorItem(name);
  if (hypervisor) return hypervisor.box ? `the hypervisor at ${hypervisor.address}, as ${hypervisor.box}` : `the hypervisor at ${hypervisor.address}`;
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
    // WHICH MACHINE HOLDS A CODEX SIGN-IN, by the label its approval has,
    // once one does (itemsFor): it is handed to one machine and no other.
    .map(([n, v]) => ({ name: n, at: Number(v.at), ...(n === 'codex' && v.box ? { heldBy: String(row.grants[v.box]?.label || v.box.slice(0, 16)) } : {}) }));
  // WHICH KIND, because only a sign-in opens Remote Control, and a phone that
  // said "Kept" over a setup-token let a person think it did.
  if (claude?.sealed && !claude.forgotten) items.push({ name: 'claude', at: Number(claude.at), kind: claude.kind === 'login' ? 'login' : 'token' });
  items.sort((x, y) => (x.name < y.name ? -1 : 1));
  const grants = Object.entries(row.grants)
    .filter(([, g]) => g && !g.revoked && g.jwk)
    // WHO APPROVED IT, when that was a custodian and not the vault's own
    // person (`by`, kept on the grant since custodians could approve one):
    // the log of what a custodian did is a hundred lines, and a machine that
    // holds a person's sign-ins should say whose doing that is for as long
    // as it holds them.
    .map(([hash, g]) => ({ key: hash, fingerprint: hash.slice(0, 16), label: String(g.label || ''), email: String(g.email || ''), at: Number(g.at), ...(Array.isArray(g.only) ? { only: g.only.map(String) } : {}), ...(typeof g.by === 'string' && g.by ? { by: g.by } : {}) }))
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
  // WHAT THE BOX SAYS IT UNDERSTANDS, signed with the rest: `members` is a
  // member's vault, filed under a principal and no address. A box from before
  // them sends none and is never handed one, which it would file under no
  // name (docs/members.md).
  const accepts = Array.isArray(req.accepts) ? [...new Set(req.accepts.map(String))].filter((x) => /^[a-z]{1,24}$/.test(x)).sort().slice(0, 8) : null;
  const payload = { v: 1, hostKey: jwk, at, reply: String(req.reply), ...(accepts ? { accepts } : {}) };
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
  // WHICH ENGINES IT RUNS, named beside `engines` by a box that knows
  // (sidecar.js, #askVault): `codex`, `opencode`. A box from before the
  // names says `engines` alone, and is handed every engine's item as it
  // always was.
  const runs = (accepts ?? []).filter((x) => x !== DEFAULT_ENGINE && ENGINE_IDS.includes(x));
  const tree = accepts?.includes('members') ? await loadTree(store) : null;
  for (const userId of Object.keys(index.accounts || {})) {
    if (!isVaultId(userId)) continue;
    const member = memberOfPrincipal(userId);
    /** @type {string[]|null} */
    let custodians = null;
    if (member) {
      // A MEMBER'S VAULT, for a box that takes one, while the member is still
      // in the tree held here.
      if (!tree?.has(member)) continue;
      custodians = await mayActFor(store, tree, member);
    }
    const one = await withLock(`row:${userId}`, () => itemsFor(userId, hash, jwk, store, key, { ...config, fetchImpl, now, takesEngines: accepts?.includes('engines') === true, boxEngines: runs.length ? runs : null, takesApiKeys: accepts?.includes('apikeys') === true, takesSandboxes: accepts?.includes('sandboxes') === true }, members, custodians));
    if (one) accounts.push(one);
  }
  const sealed = await seal({ to: String(req.reply), aad: VAULT_BOX_AAD, payload: { at: now(), accounts } });
  return { ok: true, sealed, text: accounts.length ? `This box holds credentials for ${accounts.length} ${accounts.length === 1 ? 'person' : 'people'}.` : 'Nobody has approved this box to hold their credentials.' };
}

/**
 * The engine an engine's item is for (protocol/engines.js): a Codex sign-in
 * is Codex's, and a Copilot token and every metered API key are OpenCode's,
 * which is the engine that speaks to those providers.
 *
 * @param {string} name @returns {string}
 */
function engineOfItem(name) {
  return Object.entries(ENGINES).find(([, e]) => e.credential === name)?.[0] ?? 'opencode';
}

/**
 * Whether this grant may be handed this item.
 *
 * A per-box hypervisor token (`hypervisor:<address>+<box>`) is that box's
 * alone: a full grant gets it only when the grant's label is that box, and
 * an `only` grant naming the shared item gets that same box's own token too,
 * because the shared name is the approval for the pool, and a pool's own
 * machine is approved that way (docs/vault.md). Another box's token is not
 * handed over either way. A full grant used to mean every item, and that is
 * how one box would have been given the user that can export the others'
 * disks (docs/security.md, G14).
 *
 * @param {string} name
 * @param {{ label?: string }} grant
 * @param {Set<string>|null} only
 */
function hypervisorItemForGrant(name, grant, only) {
  const split = splitHypervisorItem(name);
  if (!split?.box) return !only || only.has(name);
  if (split.box !== String(grant.label || '')) return false;
  if (!only) return true;
  return only.has(name) || only.has(`${HYPERVISOR_PREFIX}${split.address}`);
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
 * @param {string[]|null} [custodians]  for an agent member's vault, who may act for it now
 */
async function itemsFor(userId, hash, jwk, store, key, config, members, custodians = null) {
  const row = emptyRow(await store.get(`v:${userId}`));
  const grant = row.grants[hash];
  if (!grant || grant.revoked || grant.jwk?.x !== jwk.x || grant.jwk?.y !== jwk.y) return null;
  // BEFORE ANYTHING IS OPENED OR RENEWED: a removed person's refresh token is
  // not rotated for a box that will not be given the result. A grant has
  // named its fleet account since grants began, so one naming nobody is
  // nobody's on the list. AN AGENT MEMBER has no account of its own to be in
  // the fleet: it is served while somebody who may act for it is.
  if (custodians) {
    if (members && !custodians.some((a) => members.has(a))) return null;
  } else if (members && !members.has(normaliseEmail(grant.email))) return null;
  /** @type {Array<{ name: string, value: string, expiresAt: number|null, login?: Record<string, unknown>, account?: Record<string, unknown> }>} */
  const items = [];
  /** @type {string[]} */
  const problems = [];
  let changed = false;
  const only = Array.isArray(grant.only) ? new Set(grant.only.map(String)) : null;
  for (const [name, item] of Object.entries(row.items)) {
    if (!item?.sealed || item.forgotten) continue;
    if (!hypervisorItemForGrant(name, grant, only)) continue;
    const kind = itemKind(name);
    /** @type {any} */
    let inside;
    try {
      inside = await open({ privateKey: key.privateKey, publicKey: key.publicKey, aad: vaultAtRestAad(userId, name), sealed: item.sealed });
    } catch {
      problems.push(`${label(name)} does not open with this minter’s key; it was kept under a key that has since changed.`);
      continue;
    }
    if (kind === 'engine') {
      // ONLY TO A BOX THAT TAKES THEM (`accepts`, signed in its request): a
      // box from before engines would file it where nothing reads it.
      if (!config.takesEngines) continue;
      // AND ONLY FOR AN ENGINE IT RUNS, when it says which. Every box used
      // to say `engines` whatever it ran, so the one machine a Codex sign-in
      // goes to (below) was whichever asked first, and a box with no Codex
      // on it held the sign-in while the machine that could run it was told
      // to have it deposited again, which was the same race run once more.
      if (config.boxEngines && !config.boxEngines.includes(engineOfItem(name))) continue;
      // AND A KEY ONLY TO A BOX THAT ASKS FOR KEYS (`apikeys`), which it does
      // only while its operator has an API provider turned on. A box from
      // step 4 takes sign-ins and is never handed something that bills.
      if (API_KEY_ITEMS.includes(name) && !config.takesApiKeys) continue;
      if (name === 'codex') {
        // ONE MACHINE (docs/engines.md, "Credentials"). Codex renews its own
        // tokens where it runs, and a renewal ends every other copy, so the
        // first approved box to ask holds it and no other is given it until
        // it is deposited again.
        if (item.box && item.box !== hash) {
          problems.push(`The Codex sign-in is held by ${String(row.grants[item.box]?.label || 'another machine')}, and a sign-in is held by one machine. Deposit it again to move it here.`);
          continue;
        }
        if (!item.box) {
          row.items[name] = { ...item, box: hash };
          changed = true;
        }
      }
      items.push({ name, value: String(inside.value), expiresAt: null });
      continue;
    }
    // A SANDBOX PROVIDER'S RECORD ONLY TO A BOX THAT ASKS FOR THEM, which
    // it does only while its operator has a provider turned on. The record
    // is the provider's whole account.
    if (kind === 'sandbox' && !config.takesSandboxes) continue;
    if (kind === 'secret' || kind === 'hypervisor' || kind === 'sandbox') {
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
  // A MEMBER'S, filed on the box under its principal and no address.
  if (custodians) return { email: '', principal: userId, member: memberOfPrincipal(userId), login: row.login || userId, items, problems };
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
  // AND WHO MAY START A SESSION AS EACH MEMBER (org.js): what a box checks a
  // member start against, in the same signed answer and for the same reason,
  // so a coordinator cannot name a custodian. Every member, with nobody
  // listed for one whose custodians have all left the fleet.
  const orgMembers = await membersForBoxes(store, new Set(listed.map(normaliseEmail).filter(Boolean)));
  const payload = { v: 1, at: now(), host: await boxKeyHash(jwk), people, members: orgMembers };
  return {
    ok: true,
    payload,
    signature: await sign(signing.privateJwk, signingInput('vault-keys-answer', payload)),
    text: people.some((p) => p.keys.length) ? `Signing keys for ${people.filter((p) => p.keys.length).length} ${people.filter((p) => p.keys.length).length === 1 ? 'person' : 'people'}.` : 'Nobody in the fleet has listed a signing key.',
  };
}
