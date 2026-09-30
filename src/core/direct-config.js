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
//
// EXCEPT ON A RUNNER, where nobody links an account to a machine that lives
// for an hour: there the person's deposited Claude login, or the runner
// repository's API key, is the answer instead (./runner-login.js). The session
// still gets its own directory; what changes is that the credential is in its
// environment rather than in a `.credentials.json` beside it.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { pickCredentialSource, credentialSourceForAccount, noAccountRefusal } from './podman.js';
import { emailFromActor } from './accounts.js';
import { runnerAuthFor } from './runner-login.js';

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
 * @returns {{ ok: true, dir: string, account: string|null, fresh: boolean, auth?: import('./runner-login.js').RunnerAuth } | { ok: false, message: string }}
 *   `auth` is set only on a runner, for a session with no linked account: what
 *   buildCommand puts in its environment instead
 */
export function ensureDirectConfig(cfg, name, actor, { account: recorded = null, cwd }) {
  const dir = directConfigDir(cfg, name);
  // A runner session keeps no credential file, so its marker says it has
  // been staged — and for whom, which a resume asks.
  const fresh = !existsSync(path.join(dir, '.credentials.json')) && !existsSync(path.join(dir, RUNNER_MARK));

  /** @type {{ source: string|null, accountMeta?: string|null, account: string, why?: string }|null} */
  let picked;
  if (fresh) {
    picked = pickCredentialSource(cfg, actor);
    if (!picked.source) {
      const email = emailFromActor(actor);
      const auth = runnerAuthFor(cfg, email);
      if (!auth) return { ok: false, message: noAccountRefusal(cfg, picked) };
      return stageForRunner(cfg, dir, cwd, email, auth, true);
    }
  } else {
    // A RESUME KEEPS ITS ACCOUNT AND TAKES TODAY'S CREDENTIAL. Failure here is
    // not fatal: resuming with the credential it had is the old behaviour, and
    // refusing to resume because a refresh could not happen would be worse
    // than the staleness being fixed.
    const owner = recorded ?? dirAccount(dir) ?? runnerMarkAccount(dir);
    picked = owner ? credentialSourceForAccount(cfg, owner) : null;
    if (!picked?.source) {
      // A RESUME ON A RUNNER asks the same question a start did, of the same
      // person, so it comes back on the same credential.
      const auth = runnerAuthFor(cfg, owner);
      if (auth) return stageForRunner(cfg, dir, cwd, owner, auth, false);
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
 * A runner session's directory, with no credential file in it: the
 * credential goes in its environment, from `auth`.
 *
 * @param {import('../config.js').Config} cfg @param {string} dir @param {string} cwd
 * @param {string|null} account @param {import('./runner-login.js').RunnerAuth} auth @param {boolean} fresh
 * @returns {{ ok: true, dir: string, account: string|null, fresh: boolean, auth: import('./runner-login.js').RunnerAuth }}
 */
function stageForRunner(cfg, dir, cwd, account, auth, fresh) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, RUNNER_MARK), `${account ?? ''}\n`, { mode: 0o600 });
  trust(dir, cwd, null, auth.kind === 'key' ? auth.key : null);
  stageSettings(cfg, dir);
  log.info(`direct: ${path.basename(dir)} runs on ${auth.kind === 'token' ? `${auth.login ?? account}'s deposited Claude login` : 'the runner repository\'s API key'}`);
  return { ok: true, dir, account, fresh, auth };
}

/** Beside a runner session's config, in place of `.credentials.json`: whose it is. */
const RUNNER_MARK = '.runner-account';

/** @param {string} dir */
function runnerMarkAccount(dir) {
  try {
    return readFileSync(path.join(dir, RUNNER_MARK), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * The session's `.claude.json`: the identity beside the credential (the CLI
 * decides logged-in-ness from the PAIR), onboarding declared done (there is
 * an account, so the wizard has nothing to ask), and the working directory
 * trusted. Merged, never replaced: the CLI writes its own state into this file
 * and a resume must not lose it.
 * AND, ON A RUNNER WITH AN API KEY, the answer to the CLI's "use this API
 * key?" dialog. trust.js's approveApiKey writes it into the box's own
 * `~/.claude.json`, which a session under CLAUDE_CONFIG_DIR never reads, so
 * without this copy every runner session would sit at that dialog with "No"
 * focused — the bug #700 fixed, back again one directory over.
 *
 * @param {string} dir @param {string} cwd @param {any} meta @param {string|null} [apiKey]
 */
function trust(dir, cwd, meta, apiKey = null) {
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
  if (apiKey && apiKey.length >= 20) {
    // The CLI's own record: the key's last twenty characters (trust.js says
    // how that was established). Never the key.
    const suffix = apiKey.slice(-20);
    const responses = state.customApiKeyResponses && typeof state.customApiKeyResponses === 'object' ? state.customApiKeyResponses : {};
    const approved = Array.isArray(responses.approved) ? responses.approved : [];
    const rejected = Array.isArray(responses.rejected) ? responses.rejected : [];
    state.customApiKeyResponses = {
      approved: approved.includes(suffix) ? approved : [...approved, suffix],
      rejected: rejected.filter((/** @type {unknown} */ r) => r !== suffix),
    };
  }
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
