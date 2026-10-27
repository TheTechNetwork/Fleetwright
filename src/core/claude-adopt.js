// A Claude login made on a box, taken into the vault.
//
// `claude auth login` writes a new refresh token and Anthropic invalidates
// the one it replaces. When that login is for an account the vault already
// renews, two refreshers would be sharing one rotating token: the next one
// to refresh signs the other out. The vault is the one refresher. This reads
// the login the CLI just wrote, and once the minter has kept it, deletes the
// refresh token from the file. The access token stays, which is what Claude
// Code reads, and each later answer from the vault writes the new one into
// the same file (vault-store.js).
//
// An account the file does not name is not this, and neither is an account
// the vault does not hold. Cannot tell is not a match.

import { chmodSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The account fields a sign-in keeps, and the spellings Claude Code has used. */
const ACCOUNT_FIELDS = [
  ['accountUuid', 'uuid'],
  ['emailAddress', 'email_address'],
  ['organizationUuid', 'organization_uuid'],
  ['organizationName', 'organization_name'],
  ['organizationRole', 'organization_role'],
  ['workspaceRole', 'workspace_role'],
  ['displayName', 'display_name'],
  ['billingType', 'billing_type'],
  ['hasExtraUsageEnabled', 'has_extra_usage_enabled'],
];

/**
 * Whether the vault on this box holds a Claude sign-in for `email`.
 * The account file is the one applyVault writes; the address inside it is
 * the Claude account. A file that does not parse is not a match.
 *
 * @param {string} stateDir @param {string} email
 */
export function vaultHoldsClaudeAccount(stateDir, email) {
  const want = email.trim().toLowerCase();
  if (!want) return false;
  let names;
  try {
    names = readdirSync(path.join(stateDir, 'vault'));
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith('.claude-account.json')) continue;
    const parsed = readJson(path.join(stateDir, 'vault', name));
    const theirs = typeof parsed?.emailAddress === 'string' ? parsed.emailAddress.trim().toLowerCase() : '';
    if (theirs && theirs === want) return true;
  }
  return false;
}

/**
 * The sign-in `claude auth login` wrote, when it is a refreshable login for
 * an account the vault on this box already renews. Null otherwise: nothing
 * to adopt, and the file is left as it is.
 *
 * @param {{ stateDir: string, sandboxCredentialsFile?: string|null }} cfg
 * @returns {{ oauth: Record<string, unknown>, account: Record<string, unknown> }|null}
 */
export function pendingLocalSignIn(cfg) {
  const file = cfg.sandboxCredentialsFile;
  if (!file) return null;
  const signIn = readLocalSignIn(file);
  const email = typeof signIn?.account?.emailAddress === 'string' ? signIn.account.emailAddress : '';
  if (!signIn || !email || !vaultHoldsClaudeAccount(cfg.stateDir, email)) return null;
  return signIn;
}

/**
 * Drop the refresh token from the login on this box, once the vault has
 * kept that same one. A different token in the file is a newer login and
 * stays, so the next pass can adopt it. A file that already has none is
 * done.
 *
 * @param {{ sandboxCredentialsFile?: string|null }} cfg
 * @param {unknown} refreshToken  the one the vault just accepted
 * @returns {{ ok: boolean, text: string }}
 */
export function takeLocalSignIn(cfg, refreshToken) {
  const file = cfg.sandboxCredentialsFile;
  if (!file || typeof refreshToken !== 'string' || !refreshToken) {
    return { ok: false, text: 'There is no Claude login here to hand to the vault.' };
  }
  const parsed = readJson(file);
  const block = oauthBlock(parsed);
  if (!parsed || !block) return { ok: false, text: 'The Claude login on this box is not in a shape this version reads, so it was left as it is.' };
  const current = typeof block.refreshToken === 'string' ? block.refreshToken : '';
  if (!current) return { ok: true, text: 'The login on this box already has no refresh token.' };
  if (current !== refreshToken) return { ok: false, text: 'A newer Claude login is in the file, so this one was left there.' };
  delete block.refreshToken;
  delete block.refreshTokenExpiresAt;
  writePrivate(file, `${JSON.stringify(parsed)}\n`);
  return { ok: true, text: 'The vault holds the refresh token. This box keeps the access token.' };
}

/**
 * Write the vault's latest access token into the CLI's own file, when that
 * file is the same account and has already given up its refresh token.
 * Claude Code re-reads a file with no refresh token; without this it would
 * keep the access token from the login until that one expired.
 *
 * A file that still has a refresh token is a login not yet adopted, and is
 * not overwritten.
 *
 * @param {{ sandboxCredentialsFile?: string|null }} cfg
 * @param {any} account @param {string} accessToken @param {number} expiresAt
 */
export function mirrorLocalClaudeAccess(cfg, account, accessToken, expiresAt) {
  const file = cfg.sandboxCredentialsFile;
  const want = typeof account?.emailAddress === 'string' ? account.emailAddress.trim().toLowerCase() : '';
  if (!file || !want || typeof accessToken !== 'string' || !accessToken || !Number.isFinite(expiresAt)) return;
  const parsed = readJson(file);
  const block = oauthBlock(parsed);
  if (!parsed || !block) return;
  if (typeof block.refreshToken === 'string' && block.refreshToken) return;
  const email = localEmail(file, block);
  if (!email || email.trim().toLowerCase() !== want) return;
  if (block.accessToken === accessToken && block.expiresAt === expiresAt) return;
  block.accessToken = accessToken;
  block.expiresAt = expiresAt;
  delete block.refreshToken;
  delete block.refreshTokenExpiresAt;
  writePrivate(file, `${JSON.stringify(parsed)}\n`);
}

/**
 * @param {string} file
 * @returns {{ oauth: Record<string, unknown>, account: Record<string, unknown> }|null}
 */
function readLocalSignIn(file) {
  const parsed = readJson(file);
  const block = oauthBlock(parsed);
  if (!block) return null;
  const accessToken = typeof block.accessToken === 'string' ? block.accessToken : '';
  const refreshToken = typeof block.refreshToken === 'string' ? block.refreshToken : '';
  const expiresAt = Number(block.expiresAt);
  if (!accessToken || !refreshToken || !Number.isFinite(expiresAt)) return null;
  const beside = accountBeside(file);
  const account = accountFrom(block.account, beside);
  if (!account.emailAddress) {
    const email = typeof block.emailAddress === 'string' ? block.emailAddress : '';
    if (email) account.emailAddress = email;
  }
  if (typeof account.emailAddress !== 'string' || !account.emailAddress) return null;
  const scopes = Array.isArray(block.scopes) ? block.scopes.filter((/** @type {unknown} */ s) => typeof s === 'string') : [];
  /** @type {Record<string, unknown>} */
  const oauth = {
    accessToken, refreshToken, expiresAt, scopes,
    subscriptionType: typeof block.subscriptionType === 'string' ? block.subscriptionType : null,
    rateLimitTier: typeof block.rateLimitTier === 'string' ? block.rateLimitTier : null,
  };
  if (Number.isFinite(Number(block.refreshTokenExpiresAt)) && Number(block.refreshTokenExpiresAt) > 0) {
    oauth.refreshTokenExpiresAt = Number(block.refreshTokenExpiresAt);
  }
  return { oauth, account };
}

/**
 * The email the CLI file names, from the oauth block or the account file
 * beside it. Empty when it names none.
 *
 * @param {string} file @param {any} block
 */
function localEmail(file, block) {
  const fromAccount = accountFrom(block?.account, accountBeside(file));
  if (typeof fromAccount.emailAddress === 'string' && fromAccount.emailAddress) return fromAccount.emailAddress;
  return typeof block?.emailAddress === 'string' ? block.emailAddress : '';
}

/** @param {any} primary @param {any} fallback */
function accountFrom(primary, fallback) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [camel, snake] of ACCOUNT_FIELDS) {
    const v = pick(primary, camel, snake) ?? pick(fallback, camel, snake);
    if (v !== undefined) out[camel] = v;
  }
  return out;
}

/** @param {any} source @param {string} camel @param {string} snake */
function pick(source, camel, snake) {
  if (!source || typeof source !== 'object') return undefined;
  const v = source[camel] ?? source[snake];
  if (typeof v === 'string' && v.length > 0 && v.length <= 256) return v;
  if (typeof v === 'boolean') return v;
  return undefined;
}

/** @param {string} file */
function accountBeside(file) {
  const dir = path.dirname(file);
  /** @type {string[]} */
  const names = [path.join(dir, '.claude.json')];
  if (path.basename(dir) === '.claude') names.push(path.join(path.dirname(dir), '.claude.json'));
  for (const name of names) {
    const parsed = readJson(name);
    if (parsed?.oauthAccount && typeof parsed.oauthAccount === 'object') return parsed.oauthAccount;
  }
  return null;
}

/** @param {any} parsed */
function oauthBlock(parsed) {
  const block = parsed?.claudeAiOauth && typeof parsed.claudeAiOauth === 'object' ? parsed.claudeAiOauth : null;
  return block;
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string} file @param {string} text */
function writePrivate(file, text) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
