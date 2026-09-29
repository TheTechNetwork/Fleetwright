// A direct session's Claude configuration, staged from the linked account.
//
// docs/one-account-per-person.md: THE BOX HAS NO CLAUDE ACCOUNT. A session runs
// on the account of whoever started it. That was built for sandboxed sessions,
// where the account is seeded into the session's own volume — and a session
// running directly on the box fell straight through to `~/.claude`, which on
// a fresh box holds nothing. The first apt install found it: the app linked an
// account, a session was requested, and it came up on Claude's first-run
// wizard asking how to log in, with nobody at that terminal to answer.
//
// So a direct session gets what a sandboxed one gets, in the one place the CLI
// lets a session be pointed at: CLAUDE_CONFIG_DIR. `${stateDir}/direct/<name>`
// is that session's config — its credential, its identity, the trust for its
// working directory and the SessionStart hook — and it is the per-session
// volume of the sandbox design, as a directory. The box's own `~/.claude` is
// never read for a session and never written by one.
//
// WHOSE, by the same two questions the sandbox asks (podman.js): a fresh start
// asks "whose is this actor's", a resume asks "whose was this session's" and
// refreshes that account's credential — same person, current token, so a
// session resumed a week later is not carrying a receipt for a login instead
// of one. It is a refusal, not a login prompt, when nobody's account is found.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { pickCredentialSource, credentialSourceForAccount, noAccountRefusal } from './podman.js';

/**
 * Where a direct session's Claude config lives.
 * @param {import('../config.js').Config} cfg @param {string} name
 */
export function directConfigDir(cfg, name) {
  return path.join(cfg.stateDir, 'direct', name);
}

/**
 * The account a config directory was staged for, read out of the directory —
 * so a session that predates the account field on its record can still say
 * whose it is, the way a volume does with `.oauth-account.json`.
 * @param {string} dir
 */
function dirAccount(dir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, '.oauth-account.json'), 'utf8'));
    const email = parsed?.emailAddress ?? parsed?.email_address;
    return typeof email === 'string' && email ? email : null;
  } catch {
    return null;
  }
}

/**
 * Stage (or refresh) a direct session's config directory.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} name
 * @param {string|null} actor         who is starting it
 * @param {{ account?: string|null, cwd: string }} o
 *   `account` is what the session's record says, on a resume; `cwd` is the
 *   directory the session works in, which has to be trusted or the TUI stops
 *   at "Do you trust the files in this folder?" with nobody to answer.
 * @returns {{ ok: true, dir: string, account: string|null, fresh: boolean } | { ok: false, message: string }}
 */
export function ensureDirectConfig(cfg, name, actor, { account: recorded = null, cwd }) {
  const dir = directConfigDir(cfg, name);
  const fresh = !existsSync(path.join(dir, '.credentials.json'));

  /** @type {{ source: string|null, accountMeta?: string|null, account: string, why?: string }|null} */
  let picked;
  if (fresh) {
    picked = pickCredentialSource(cfg, actor);
    if (!picked.source) return { ok: false, message: noAccountRefusal(cfg, picked) };
  } else {
    // A RESUME KEEPS ITS ACCOUNT AND TAKES TODAY'S CREDENTIAL. Failure here is
    // not fatal: resuming with the credential it had is the old behaviour, and
    // refusing to resume because a refresh could not happen would be worse
    // than the staleness being fixed.
    const owner = recorded ?? dirAccount(dir);
    picked = owner ? credentialSourceForAccount(cfg, owner) : null;
    if (!picked?.source) {
      log.warn(`direct: ${name} ${owner ? `belongs to ${owner}, who has no credential on this box any more` : 'does not say whose account it holds'}; keeping the one it has`);
      stageSettings(cfg, dir);
      trust(dir, cwd, null);
      return { ok: true, dir, account: owner, fresh: false };
    }
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let meta = null;
  try {
    writeFileSync(path.join(dir, '.credentials.json'), readFileSync(picked.source), { mode: 0o600 });
    if (picked.accountMeta) {
      const text = readFileSync(picked.accountMeta, 'utf8');
      writeFileSync(path.join(dir, '.oauth-account.json'), text, { mode: 0o600 });
      meta = JSON.parse(text);
    }
  } catch (e) {
    return { ok: false, message: `could not stage ${picked.account}'s credential for "${name}": ${/** @type {Error} */ (e).message}` };
  }
  trust(dir, cwd, meta);
  stageSettings(cfg, dir);
  log.info(`direct: ${fresh ? 'staged' : 'refreshed'} ${picked.account}'s credential for ${name}`);
  return { ok: true, dir, account: picked.account, fresh };
}

/**
 * The session's `.claude.json`: the identity beside the credential (the CLI
 * decides logged-in-ness from the PAIR), onboarding declared done (there is
 * an account, so the wizard has nothing to ask), and the working directory
 * trusted. Merged, never replaced: the CLI writes its own state into this file
 * and a resume must not lose it.
 * @param {string} dir @param {string} cwd @param {any} meta
 */
function trust(dir, cwd, meta) {
  const file = path.join(dir, '.claude.json');
  /** @type {any} */
  let state = {};
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch { /* first time, or the CLI has not written one yet */ }
  if (meta) state.oauthAccount = meta;
  state.hasCompletedOnboarding = true;
  if (state.theme === undefined) state.theme = 'dark';
  state.projects ||= {};
  state.projects[cwd] = { ...(state.projects[cwd] || {}), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The SessionStart hook. install.sh registers it in the service user's own
 * settings.json, which a session under CLAUDE_CONFIG_DIR would never read; so
 * that file is the template, copied in when the session has none or the
 * template is newer. An operator's edits to the box's settings reach the next
 * start of every session, and a session's own edits are kept until then.
 * @param {import('../config.js').Config} cfg @param {string} dir
 */
function stageSettings(cfg, dir) {
  if (!cfg.sandboxCredentialsFile) return;
  const template = path.join(path.dirname(cfg.sandboxCredentialsFile), 'settings.json');
  if (!existsSync(template)) return;
  const dest = path.join(dir, 'settings.json');
  try {
    if (existsSync(dest) && statSync(dest).mtimeMs >= statSync(template).mtimeMs) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    copyFileSync(template, dest);
  } catch (e) {
    log.warn(`direct: could not stage settings.json into ${dir}: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * Forget a session's config directory, with the session. A resume after this
 * stages a fresh one for whoever the record says.
 * @param {import('../config.js').Config} cfg @param {string} name
 */
export function removeDirectConfig(cfg, name) {
  rmSync(directConfigDir(cfg, name), { recursive: true, force: true });
}
