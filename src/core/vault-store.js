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
// A LINK ON THE BOX WINS. Something a person connected on this box with their
// own hands is the more specific decision, and the vault fills only what is
// missing. Each reader below says so where it merges.
//
// WRITTEN WHOLE ON EVERY ANSWER: a person missing from the answer has removed
// this box, or emptied their vault, and their files go. That is what makes
// removing a box from a phone reach the box within one sidecar pass.

import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';

import { normaliseEmail } from './accounts.js';
import { PROVIDERS } from './connectors.js';

/** A named secret's name, as secret-store.js accepts one. */
const SECRET_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** @param {{ stateDir: string }} cfg */
export const vaultDir = (cfg) => path.join(cfg.stateDir, 'vault');

/**
 * @typedef {{ value: string, expiresAt: number|null }} HeldItem
 * @typedef {{ at: number, login: string, items: Record<string, HeldItem>, problems: string[] }} Held
 */

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
 * @param {unknown} bundle  `{ accounts: [{ email, login, items: [{ name, value, expiresAt }], problems }] }`
 * @returns {{ ok: boolean, text: string }}
 */
export function applyVault(cfg, bundle) {
  const accounts = /** @type {any} */ (bundle)?.accounts;
  if (!Array.isArray(accounts) || accounts.length > 200) return { ok: false, text: 'That is not what a vault answers.' };
  const dir = vaultDir(cfg);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  /** @type {Set<string>} */
  const kept = new Set();
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
    }
    /** @type {Held} */
    const held = {
      at: Date.now(),
      login: String(a.login || '').slice(0, 100),
      items,
      problems: (Array.isArray(a.problems) ? a.problems : []).map((/** @type {unknown} */ p) => String(p).slice(0, 300)).slice(0, 20),
    };
    writePrivate(path.join(dir, `${email}.json`), `${JSON.stringify(held)}\n`);
    // THE CLAUDE TOKEN ALSO AS A FILE OF ITS OWN, because that is how a
    // session is given one: read at exec time by `$(cat …)` (claude.js), so
    // it never appears on a command line.
    const claudeFile = path.join(dir, `${email}.claude`);
    if (items.claude) writePrivate(claudeFile, items.claude.value);
    else if (existsSync(claudeFile)) unlinkSync(claudeFile);
    kept.add(email);
  }
  for (const f of readdirSync(dir)) {
    const m = /^(.+)\.(json|claude)$/.exec(f);
    if (m && !kept.has(m[1])) unlinkSync(path.join(dir, f));
  }
  return { ok: true, text: kept.size ? `holding vault credentials for ${[...kept].join(', ')}` : 'holding no vault credentials' };
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
 * When a provider's vault token runs out, or null when it does not say.
 *
 * @param {{ stateDir: string }} cfg @param {string|null} email @param {string} provider
 */
export function vaultExpiryFor(cfg, email, provider) {
  const item = heldFor(cfg, email)?.items?.[provider];
  return item && item.expiresAt !== null ? item.expiresAt : null;
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
