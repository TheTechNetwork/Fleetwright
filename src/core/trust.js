// Getting ~/.claude.json into a state where an unattended session can actually
// start.
//
// Two separate first-run prompts will each hang a headless session forever, and
// neither is obvious until it happens:
//
//   1. Per directory: "Do you trust the files in this folder?"
//   2. Once per install: the onboarding wizard, which opens with "Select login
//      method" — shown even when the account IS authenticated, because
//      `claude auth login` writes credentials but never sets
//      hasCompletedOnboarding.
//
// (2) is the nastier one: /login reports success, `claude auth status` says
// loggedIn, and then the very next session sits on a login menu it does not
// need. Every fresh deployment hits it exactly once.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';

const claudeConfigPath = () => path.join(os.homedir(), '.claude.json');

/**
 * Read-modify-write ~/.claude.json atomically.
 *
 * A claude process may be writing this file at the same moment, and a torn
 * write here breaks every session on the box — hence temp + rename. `mutate`
 * returns true if it changed anything; when it returns false the file is left
 * completely untouched.
 *
 * @param {(cfg: any) => boolean} mutate
 * @param {string} what for the log line
 */
function editClaudeConfig(mutate, what) {
  const file = claudeConfigPath();
  try {
    let cfg = {};
    try {
      cfg = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      // Missing is fine — claude has simply never run as this user yet, and
      // creating it with the right flags is exactly what we want. A corrupt
      // file is NOT fine: overwriting it would destroy the operator's real
      // settings, so bail and let them fix it.
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
    }
    if (!mutate(cfg)) return true; // nothing to change
    const tmp = `${file}.tmp-agent-hub`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    renameSync(tmp, file);
    log.info(`claude config: ${what}`);
    return true;
  } catch (e) {
    log.warn(`claude config: could not ${what}: ${/** @type {Error} */ (e).message}`);
    return false;
  }
}

/**
 * Mark a directory trusted so sessions started there skip the trust dialog.
 * @param {string} dir absolute path
 */
export function trustDirectory(dir) {
  return editClaudeConfig((cfg) => {
    cfg.projects = cfg.projects || {};
    const project = cfg.projects[dir] || {};
    if (project.hasTrustDialogAccepted === true && project.hasCompletedProjectOnboarding === true) {
      return false;
    }
    cfg.projects[dir] = {
      ...project,
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    };
    return true;
  }, `trusted ${dir}`);
}

/** @param {import('../config.js').Config} cfg */
export function ensureWorkdirTrusted(cfg) {
  try {
    mkdirSync(cfg.workdir, { recursive: true });
  } catch {
    /* already exists */
  }
  return trustDirectory(cfg.workdir);
}

/**
 * Declare the install onboarded, so the interactive TUI goes straight to work.
 *
 * Only call this when the account is genuinely authenticated. Setting it on an
 * unauthenticated box would suppress the wizard that is the only way a person
 * at a terminal could log in — the flag would be a lie, and an unhelpful one.
 *
 * @param {import('../config.js').Config} cfg
 */
export function markOnboardingComplete(cfg) {
  const version = claudeVersion(cfg.claudeBin);
  return editClaudeConfig((cfg2) => {
    let changed = false;
    if (cfg2.hasCompletedOnboarding !== true) {
      cfg2.hasCompletedOnboarding = true;
      changed = true;
    }
    // The wizard also asks for a theme; recording one keeps it from being the
    // next thing that blocks. Only when absent — never override a choice.
    if (cfg2.theme === undefined) {
      cfg2.theme = 'dark';
      changed = true;
    }
    if (version && cfg2.lastOnboardingVersion !== version) {
      cfg2.lastOnboardingVersion = version;
      changed = true;
    }
    return changed;
  }, 'marked onboarding complete (sessions skip the first-run wizard)');
}

/** @param {string} bin */
function claudeVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) return null;
  const m = (r.stdout || '').match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/**
 * Validate a caller-supplied working directory.
 *
 * Worth being strict about: tmux does NOT fail when `-c` points at a
 * non-existent directory — it silently starts the session in the tmux server's
 * own cwd instead. A typo therefore produced a session that reported "Started
 * in 1" while actually running in /opt/agent-hub, untrusted, hanging on a trust
 * prompt. Better to refuse than to launch somewhere nobody asked for.
 *
 * @param {string} dir
 * @returns {{ ok: true, path: string } | { ok: false, message: string }}
 */
export function resolveWorkdir(dir) {
  // Resolve relative to the operator's home rather than the hub's own cwd,
  // which is wherever systemd happened to put it.
  const full = path.resolve(dir.startsWith('~') ? dir.replace(/^~/, os.homedir()) : dir);
  if (!existsSync(full)) {
    return { ok: false, message: `No such directory: ${full}` };
  }
  if (!statSync(full).isDirectory()) {
    return { ok: false, message: `Not a directory: ${full}` };
  }
  return { ok: true, path: full };
}
