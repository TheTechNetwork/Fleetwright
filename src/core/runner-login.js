// What a runner's sessions authenticate with, when nobody linked an account.
//
// docs/one-account-per-person.md: a session runs on the linked Claude account
// of whoever started it, and a box with none refuses rather than falling back
// to the machine's. On a permanent box that is the policy guests depend on. On
// a RUNNER it was a dead end: nobody links an account to a machine that lives
// for an hour, so every session there was refused — including on runners
// whose repository holds an ANTHROPIC_API_KEY for exactly this, which is what
// docs/runner-central.md said they would run on.
//
// So a runner has two more answers, in this order:
//
//  1. ITS OWNER'S CLAUDE LOGIN, when they deposited one with the minting
//     Worker (src/fleet/minter/claude.js). The sidecar fetches it when the
//     runner joins, sealed to this job, and hands it here. Only the owner's
//     sessions run on it — the email it was given for is the email a session
//     must be started by — because one person's subscription under somebody
//     else's work is account sharing whoever the somebody is.
//  2. THE RUNNER REPOSITORY'S API KEY, in this process's environment, for
//     anybody the fleet places here. An API key is made to be shared that way.
//
// WHAT MAKES THIS A RUNNER is that the sidecar said so, which it does only
// when it holds a GitHub Actions job token. A permanent box never gets this
// record, so the no-fallback rule there is untouched even with an API key in
// its environment.
//
// THE TOKEN IS A FILE, 0600, in the private state directory, and a session
// reads it at exec time (`$(cat …)`) so it never appears on a command line,
// in tmux's arguments or in `ps`. It is the person's whole subscription for as
// long as the job lives — stated in runner-central.md, because it is the one
// thing this cannot narrow.

import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { normaliseEmail } from './accounts.js';
import { vaultClaudeFile } from './vault-store.js';

/** @param {{ stateDir: string }} cfg */
const recordFile = (cfg) => path.join(cfg.stateDir, 'runner-login.json');
/** @param {{ stateDir: string }} cfg */
export const runnerTokenFile = (cfg) => path.join(cfg.stateDir, 'runner-login.token');

/**
 * Record what the sidecar was given for this runner.
 *
 * @param {{ stateDir: string }} cfg
 * @param {{ email?: unknown, login?: unknown, token?: unknown }} given
 *   `email` is the runner's owner, `token` their Claude login or null when
 *   they have none here, `login` the GitHub account it was deposited under
 * @returns {{ ok: true, text: string } | { ok: false, text: string }}
 */
export function saveRunnerLogin(cfg, { email, login, token }) {
  const owner = email == null || email === '' ? null : normaliseEmail(email);
  if (email != null && email !== '' && !owner) return { ok: false, text: 'email is not an email' };
  const value = token == null || token === '' ? null : String(token);
  if (value !== null && !/^[A-Za-z0-9._~+/=-]{20,2048}$/.test(value)) return { ok: false, text: 'that is not a Claude token' };
  if (value !== null && !owner) return { ok: false, text: 'a Claude login needs the email of the person it is for' };
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  if (value === null) rmSync(runnerTokenFile(cfg), { force: true });
  else writeFileSync(runnerTokenFile(cfg), value, { mode: 0o600 });
  const record = { runner: true, email: owner, login: login ? String(login).slice(0, 100) : null, token: value !== null };
  writeFileSync(recordFile(cfg), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return {
    ok: true,
    text: value !== null
      ? `sessions ${owner} starts here run on the Claude login deposited under ${record.login ?? 'their GitHub account'}`
      : 'this is a runner with no Claude login for its owner; sessions use ANTHROPIC_API_KEY',
  };
}

/**
 * @typedef {{ kind: 'token', file: string, login: string|null } | { kind: 'key', key: string } | { kind: 'linked' }} RunnerAuth
 *   `linked` is a session whose person linked an account, on a runner: its
 *   credential is the staged file, and the only thing to do is make sure the
 *   repository's API key in the environment does not outrank it.
 */

/**
 * Is this host a runner, by the record its sidecar wrote at join? A runner
 * starts with the runner repository's ANTHROPIC_API_KEY in its environment
 * whether or not anybody wants it used, which is what the answer is for.
 *
 * @param {{ stateDir: string }} cfg
 */
export function onRunner(cfg) {
  try {
    return JSON.parse(readFileSync(recordFile(cfg), 'utf8'))?.runner === true;
  } catch {
    return false;
  }
}

/**
 * How a session started for `email` authenticates when it has no linked
 * account: on a runner, or on any box the person's vault gave a Claude token
 * to — or null when there is no answer here, which is the refusal it always
 * was.
 *
 * @param {{ stateDir: string }} cfg
 * @param {string|null} email  the person starting (or whose session is resuming)
 * @param {Record<string, string|undefined>} [env]
 * @returns {RunnerAuth|null}
 */
export function runnerAuthFor(cfg, email, env = process.env) {
  /** @type {any} */
  let record = null;
  try {
    record = JSON.parse(readFileSync(recordFile(cfg), 'utf8'));
  } catch { /* not a runner, or one that has not been told yet */ }
  // THE PERSON'S VAULT, on any box they approved (vault-store.js): a token
  // they kept once, used when nothing is linked here. After a runner owner's
  // own deposit, which is the same token by another road, and before the
  // runner repository's API key, which bills somebody else.
  const vault = vaultClaudeFile(cfg, email);
  const fromVault = vault ? /** @type {RunnerAuth} */ ({ kind: 'token', file: vault, login: null }) : null;
  if (record?.runner !== true) return fromVault;
  const owner = typeof record.email === 'string' ? record.email : null;
  if (record.token && owner && email && owner === normaliseEmail(email) && existsSync(runnerTokenFile(cfg))) {
    return { kind: 'token', file: runnerTokenFile(cfg), login: record.login ?? null };
  }
  if (fromVault) return fromVault;
  const key = env.ANTHROPIC_API_KEY;
  return key ? { kind: 'key', key } : null;
}
