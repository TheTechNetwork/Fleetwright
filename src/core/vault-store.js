// What the fleet's vault gave this box, for the people who approved it.
//
// THE VAULT IS THE MINTING WORKER'S (src/fleet/minter/vault.js): each person
// keeps their GitHub, Cloudflare and Claude sign-ins and named secrets there
// once, approves a box from their phone, and the box's sidecar asks for what
// it may hold, every ten minutes and before a token runs out. What comes back
// is written here, and read by the same readers every linked credential is
// read by, so the broker, a session's Claude login and `fleet-secret` need no
// second path.
//
// WHAT IS HERE, AND WHAT IS NOT. Access tokens, which last hours and are
// replaced on the next ask; a Claude token and named secrets, which have no
// shorter form. Never a refresh token: renewing is the vault's job, done in
// one place so two boxes cannot race to rotate one token. Everything is a 0600
// file in a 0700 directory, the same custody as `accounts/`.
//
// THE ONLY SOURCE FOR THE FLEET'S PEOPLE. A link on the box used to win, and
// the vault filled only what was missing: so a box held two copies of one
// person's credentials, one of them renewed on its own clock, and the copy in
// use was whichever the box happened to have. Now a session somebody started
// through the fleet takes its Claude login, GitHub, Cloudflare and named
// secrets from here and nowhere else (podman.js, pickCredentialSource;
// src/index.js, secretsFor). What is linked on a box is the box operator's,
// for the box's own command line.
//
// A CLAUDE SIGN-IN, the kind Remote Control needs, is written as the
// credentials file Claude Code reads, with its access token and no refresh
// token (src/fleet/minter/claude-login.js): a Claude Code with none reads the
// file again rather than renewing, which is how a running session takes the
// access token this box is given next (refreshVaultSessions in sidecar.js).
//
// WRITTEN WHOLE ON EVERY ANSWER: a person missing from the answer has removed
// this box, or emptied their vault, and their files go. That is what makes
// removing a box from a phone reach the box within one sidecar pass.
//
// A VAULT BOX is one that has taken one answer, and stays one. The sidecar
// hands the hub every answer the minter gives (sidecar.js, syncVault): the
// people who approved this box, which is an empty list when nobody has, and
// an empty list again when the minter says this is not the key the box
// enrolled with. It hands over nothing when the minter is silent, so a box in
// a fleet with no minter, or in no fleet, never becomes one. From the first
// answer the box's own command line runs as the person FLEETWRIGHT_OPERATOR
// names, who must be one whose vault gives it something and is never guessed
// (accounts.js, operatorAccount), and it links nothing of its own
// (commands.js, vaultLinkRefusal): a link made on the box is the second copy
// of somebody's login the vault exists to end, and a box that has been told
// what its people keep does not go back to keeping its own when one answer
// comes back empty.

import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';

import { normaliseEmail, emailFromActor, rowForActor, operatorAccount, HOST_ROW } from './accounts.js';
import { PROVIDERS } from './connectors.js';

/** A named secret's name, as secret-store.js accepts one. */
const SECRET_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** @param {{ stateDir: string }} cfg */
export const vaultDir = (cfg) => path.join(cfg.stateDir, 'vault');

/**
 * The record that this box has taken a vault answer. A dot-file, so the
 * sweep of people no longer in the answer never matches it.
 *
 * @param {{ stateDir: string }} cfg
 */
const vaultBoxMark = (cfg) => path.join(vaultDir(cfg), '.vault-box');

/**
 * Whether this box has taken a vault answer (see "A VAULT BOX" above). The
 * directory counts as well as the mark, because applyVault is the only thing
 * that makes it and a box that took answers before the mark existed has one.
 * Removing the directory is how a box goes back to standing alone.
 *
 * @param {{ stateDir: string }} cfg
 */
export function vaultBox(cfg) {
  return existsSync(vaultBoxMark(cfg)) || existsSync(vaultDir(cfg));
}

/**
 * The people whose vaults give this box something: everybody in the last
 * answer, which the minter makes of the people who approved this box and
 * nobody else (src/fleet/minter/vault.js). Sorted, so a sentence naming them
 * reads the same twice.
 *
 * @param {{ stateDir: string }} cfg
 * @returns {string[]}
 */
export function vaultPeople(cfg) {
  try {
    // The same reading of a file name as the sweep in applyVault, so a
    // person's Claude files are never taken for a person of their own.
    return readdirSync(vaultDir(cfg))
      .map((f) => /^(.+?)\.(json|claude|claude-credentials\.json|claude-account\.json)$/.exec(f))
      .flatMap((m) => (m && m[2] === 'json' && normaliseEmail(m[1]) === m[1] ? [m[1]] : []))
      .sort();
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * Whose vault a session's credentials come from, or null when they come from
 * the box: the fleet person who started it, and on a vault box the operator
 * for a session started on the box itself (accounts.js, operatorAccount),
 * whose `email` is null when nobody can be named. Null for that session on a
 * box that stands alone, which keeps its own row as before, and for a fleet
 * actor that does not parse, which the box's own readers refuse.
 *
 * @param {{ stateDir: string, operator?: string|null }} cfg @param {string|null|undefined} actor
 * @returns {{ email: string|null }|null}
 */
export function vaultHolder(cfg, actor) {
  const email = emailFromActor(actor ?? null);
  if (email) return { email };
  if (rowForActor(actor) !== HOST_ROW || !vaultBox(cfg)) return null;
  return { email: operatorAccount(/** @type {any} */ (cfg)).email };
}

/**
 * @typedef {{ value: string, expiresAt: number|null, signIn?: boolean, login?: Record<string, unknown>, account?: Record<string, unknown> }} HeldItem
 * @typedef {{ at: number, login: string, items: Record<string, HeldItem>, problems: string[] }} Held
 */

/** The account fields Claude Code reads beside its credential (claude-login.js keeps the same). */
const ACCOUNT_FIELDS = ['accountUuid', 'emailAddress', 'organizationUuid', 'organizationName', 'organizationRole', 'workspaceRole', 'displayName', 'billingType', 'hasExtraUsageEnabled'];

/**
 * The credentials file for a sign-in the vault gave this box: the access
 * token Claude Code reads, never a refresh token, because none is given.
 *
 * @param {string} accessToken @param {number} expiresAt @param {any} login
 */
function credentialsText(accessToken, expiresAt, login) {
  const short = (/** @type {unknown} */ v) => (typeof v === 'string' && v.length <= 64 ? v : null);
  const scopes = Array.isArray(login?.scopes) ? login.scopes.map(String).filter((/** @type {string} */ x) => /^[a-z_:]{1,64}$/.test(x)).slice(0, 16) : ['user:inference'];
  return `${JSON.stringify({ claudeAiOauth: { accessToken, expiresAt, scopes, subscriptionType: short(login?.subscriptionType), rateLimitTier: short(login?.rateLimitTier) } })}\n`;
}

/** @param {any} account */
function accountText(account) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const f of ACCOUNT_FIELDS) {
    const v = account?.[f];
    if ((typeof v === 'string' && v.length <= 256) || typeof v === 'boolean') out[f] = v;
  }
  return `${JSON.stringify(out)}\n`;
}

/** @param {string} name */
function knownItem(name) {
  if (name === 'claude') return true;
  if (Object.hasOwn(PROVIDERS, name)) return true;
  return name.startsWith('secret:') && SECRET_NAME_RE.test(name.slice('secret:'.length));
}

/** @param {string} file @param {string} text */
function writePrivate(file, text) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * Keep what the vault gave this box, and forget whatever it no longer gives.
 *
 * @param {{ stateDir: string }} cfg
 * @param {unknown} bundle  `{ accounts: [{ email, login, items: [{ name, value, expiresAt, login?, account? }], problems }] }`
 * @returns {{ ok: boolean, text: string, claudeChanged?: string[] }}
 *   `claudeChanged`, the people whose Claude login on this box is not what it
 *   was, for the sessions running on it to be given the new one
 */
export function applyVault(cfg, bundle) {
  const accounts = /** @type {any} */ (bundle)?.accounts;
  if (!Array.isArray(accounts) || accounts.length > 200) return { ok: false, text: 'That is not what a vault answers.' };
  const dir = vaultDir(cfg);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // WRITTEN FOR AN EMPTY ANSWER TOO: being told nobody approved this box is
  // still being told, and is what makes it a vault box.
  if (!existsSync(vaultBoxMark(cfg))) writePrivate(vaultBoxMark(cfg), `${new Date().toISOString()}\n`);
  /** @type {Set<string>} */
  const kept = new Set();
  /** @type {string[]} */
  const claudeChanged = [];
  for (const a of accounts) {
    const email = normaliseEmail(a?.email);
    if (!email || !Array.isArray(a?.items)) continue;
    /** @type {Record<string, HeldItem>} */
    const items = {};
    for (const i of a.items) {
      const name = String(i?.name || '');
      const value = typeof i?.value === 'string' ? i.value : '';
      if (!knownItem(name) || !value || value.length > 16_384) continue;
      const expiresAt = Number.isFinite(Number(i?.expiresAt)) && i.expiresAt !== null ? Number(i.expiresAt) : null;
      items[name] = { value, expiresAt };
      // A SIGN-IN, which only a vault that renews it gives with an expiry.
      if (name === 'claude' && expiresAt !== null && i?.login && typeof i.login === 'object') {
        items[name].signIn = true;
        items[name].login = { scopes: i.login.scopes, subscriptionType: i.login.subscriptionType, rateLimitTier: i.login.rateLimitTier };
        items[name].account = JSON.parse(accountText(i.account));
      }
    }
    const before = heldFor(cfg, email)?.items?.claude ?? null;
    if ((before?.value ?? null) !== (items.claude?.value ?? null)) claudeChanged.push(email);
    /** @type {Held} */
    const held = {
      at: Date.now(),
      login: String(a.login || '').slice(0, 100),
      items,
      problems: (Array.isArray(a.problems) ? a.problems : []).map((/** @type {unknown} */ p) => String(p).slice(0, 300)).slice(0, 20),
    };
    writePrivate(path.join(dir, `${email}.json`), `${JSON.stringify(held)}\n`);
    // THE CLAUDE LOGIN AS THE FILES A SESSION IS GIVEN. A setup-token as a
    // file of its own, read at exec time by `$(cat …)` (claude.js) so it never
    // appears on a command line; a sign-in as the credentials file and the
    // account beside it, which is what a session seeds and Remote Control
    // reads. One or the other, never both, because Claude Code would take the
    // token over the sign-in.
    const files = claudeFiles(cfg, email);
    const c = items.claude;
    const want = {
      token: c && !c.signIn ? c.value : null,
      credentials: c?.signIn ? credentialsText(c.value, /** @type {number} */ (c.expiresAt), /** @type {any} */ (c).login) : null,
      account: c?.signIn ? accountText(/** @type {any} */ (c).account) : null,
    };
    for (const [k, file] of Object.entries(files)) {
      const text = want[/** @type {keyof typeof want} */ (k)];
      if (text) writePrivate(file, text);
      else if (existsSync(file)) unlinkSync(file);
    }
    kept.add(email);
  }
  for (const f of readdirSync(dir)) {
    const m = /^(.+?)\.(json|claude|claude-credentials\.json|claude-account\.json)$/.exec(f);
    if (!m || kept.has(m[1])) continue;
    unlinkSync(path.join(dir, f));
    if (m[2] === 'json' && !claudeChanged.includes(m[1])) claudeChanged.push(m[1]);
  }
  return { ok: true, text: kept.size ? `holding vault credentials for ${[...kept].join(', ')}` : 'holding no vault credentials', claudeChanged };
}

/**
 * Forget what the vault gave this box for one person, now rather than on the
 * next ask: for somebody removed from the fleet (forget-person.js), whom the
 * minter gives nothing from then on anyway.
 *
 * @param {{ stateDir: string }} cfg @param {string|null} email
 * @returns {boolean} whether anything was there
 */
export function forgetVault(cfg, email) {
  const who = normaliseEmail(email);
  if (!who) return false;
  let had = false;
  for (const file of [path.join(vaultDir(cfg), `${who}.json`), ...Object.values(claudeFiles(cfg, who))]) {
    if (!existsSync(file)) continue;
    unlinkSync(file);
    had = true;
  }
  return had;
}

/**
 * What this box holds for one person, or null.
 *
 * @param {{ stateDir: string }} cfg @param {string|null} email
 * @returns {Held|null}
 */
export function heldFor(cfg, email) {
  const who = normaliseEmail(email);
  if (!who) return null;
  try {
    return JSON.parse(readFileSync(path.join(vaultDir(cfg), `${who}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The environment a provider's vault token is read under, for the broker:
 * `GH_TOKEN` and `GITHUB_TOKEN` for GitHub, as a link on the box would give.
 * A token that has run out is left out rather than handed over, because the
 * next sidecar pass replaces it and a dead one only produces a 401.
 *
 * @param {{ stateDir: string }} cfg @param {string|null} email @param {number} [now]
 * @returns {Record<string, string>}
 */
export function vaultEnvFor(cfg, email, now = Date.now()) {
  const held = heldFor(cfg, email);
  /** @type {Record<string, string>} */
  const env = {};
  if (!held) return env;
  for (const [name, item] of Object.entries(held.items || {})) {
    if (!Object.hasOwn(PROVIDERS, name)) continue;
    if (item.expiresAt !== null && item.expiresAt <= now) continue;
    for (const key of PROVIDERS[/** @type {keyof typeof PROVIDERS} */ (name)].env) env[key] = item.value;
  }
  return env;
}

/**
 * How many people's vaults give this box a Claude login: who can start a
 * session here, now that a person's comes from their vault and nowhere else.
 *
 * @param {{ stateDir: string }} cfg
 */
export function vaultClaudePeople(cfg) {
  try {
    return readdirSync(vaultDir(cfg)).filter((f) => /\.(claude|claude-credentials\.json)$/.test(f)).length;
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return 0;
    throw e;
  }
}

/**
 * One provider's token from a person's vault, or null when the vault gave
 * this box none for them or the one it gave has run out. What the box's own
 * GitHub checks for that person use (commands.js `runnerrepo`, `linkrepo`,
 * `githubaccess`, `provision`; archive.js), as the broker does.
 *
 * @param {{ stateDir: string }} cfg @param {string|null} email @param {string} provider @param {number} [now]
 */
export function vaultToken(cfg, email, provider, now = Date.now()) {
  const item = heldFor(cfg, email)?.items?.[provider];
  if (!item || !Object.hasOwn(PROVIDERS, provider)) return null;
  if (item.expiresAt !== null && item.expiresAt <= now) return null;
  return item.value || null;
}

/**
 * When a provider's vault token runs out, or null when it does not say.
 *
 * @param {{ stateDir: string }} cfg @param {string|null} email @param {string} provider
 */
export function vaultExpiryFor(cfg, email, provider) {
  const item = heldFor(cfg, email)?.items?.[provider];
  return item && item.expiresAt !== null ? item.expiresAt : null;
}

/**
 * Where a person's Claude login from the vault is written: a setup-token, or
 * a sign-in's credentials and account.
 *
 * @param {{ stateDir: string }} cfg @param {string} email  already normalised
 */
function claudeFiles(cfg, email) {
  const dir = vaultDir(cfg);
  return {
    token: path.join(dir, `${email}.claude`),
    credentials: path.join(dir, `${email}.claude-credentials.json`),
    account: path.join(dir, `${email}.claude-account.json`),
  };
}

/**
 * A person's Claude login from the vault, as a session is given one: a
 * sign-in's credentials file and account (`source`, `accountMeta`), or a
 * setup-token's file (`tokenFile`). Null when the vault gave this box none
 * for them. The shape pickCredentialSource answers in (podman.js).
 *
 * @param {{ stateDir: string }} cfg @param {string|null} email
 * @returns {{ source: string, accountMeta: string, account: string } | { source: null, tokenFile: string, accountMeta: null, account: string } | null}
 */
export function vaultClaudeSource(cfg, email) {
  const who = normaliseEmail(email);
  if (!who) return null;
  const files = claudeFiles(cfg, who);
  if (existsSync(files.credentials)) return { source: files.credentials, accountMeta: files.account, account: who };
  if (existsSync(files.token)) return { source: null, tokenFile: files.token, accountMeta: null, account: who };
  return null;
}

/**
 * The file a person's vault Claude token is in, for a session's command to
 * read, or null when the vault gave this box none for them.
 *
 * @param {{ stateDir: string }} cfg @param {string|null} email
 */
export function vaultClaudeFile(cfg, email) {
  const who = normaliseEmail(email);
  if (!who) return null;
  const file = path.join(vaultDir(cfg), `${who}.claude`);
  return existsSync(file) ? file : null;
}

/**
 * A named secret from a person's vault, or null.
 *
 * @param {{ stateDir: string }} cfg @param {string|null} email @param {string} name
 */
export function vaultSecret(cfg, email, name) {
  if (!SECRET_NAME_RE.test(String(name || ''))) return null;
  return heldFor(cfg, email)?.items?.[`secret:${name}`]?.value ?? null;
}
