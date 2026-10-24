// The sessions already running when a person's Claude login on this box
// changes, given the new one.
//
// WHY THIS EXISTS. A box is given a Claude sign-in's access token and never
// its refresh token (src/fleet/minter/claude-login.js), and asks the vault
// again every ten minutes; the vault renews it when it is close to running
// out. A session that started with Tuesday's access token would stop when it
// ran out, hours into its work. Claude Code with no refresh token does not try
// to renew: it reads its credentials file again. So the file is what has to
// change, in every running session on that person's account: a sandboxed
// session's conversation volume, written the way a start writes it
// (podman.js, refreshSeededCredentials), or a direct session's staged copy.
//
// The same is right for a setup-token replaced, or a sign-in replacing one,
// and for a login forgotten: the session keeps what it has rather than being
// handed nothing, because stopping someone's work mid-flight is the
// operator's call, not this file's.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { log } from '../log.js';
import { normaliseEmail } from './accounts.js';
import { directConfigDir } from './direct-config.js';
import { refreshSeededCredentials } from './podman.js';
import { vaultClaudeSource } from './vault-store.js';

/**
 * @param {import('../config.js').Config} cfg
 * @param {{ running: () => Array<{ name: string, account?: string|null, createdBy?: string|null }> }} sessions
 * @param {string[]} emails  whose Claude login changed (vault-store.js, applyVault)
 * @param {{ reseed?: typeof refreshSeededCredentials }} [io]
 * @returns {Array<{ name: string, refreshed: boolean, why?: string }>}
 */
export function refreshVaultSessions(cfg, sessions, emails, { reseed = refreshSeededCredentials } = {}) {
  const changed = new Set(emails.map((e) => normaliseEmail(e)).filter(Boolean));
  /** @type {Array<{ name: string, refreshed: boolean, why?: string }>} */
  const done = [];
  if (!changed.size) return done;
  for (const rec of sessions.running()) {
    const account = normaliseEmail(rec.account);
    if (!account || !changed.has(account)) continue;
    const picked = vaultClaudeSource(cfg, account);
    if (!picked) {
      done.push({ name: rec.name, refreshed: false, why: 'their vault gives this box no Claude login now; the session keeps the one it has' });
      continue;
    }
    // A DIRECT SESSION reads the copy staged for it (direct-config.js). A
    // sign-in replaces that copy; a token is in the session's environment,
    // fixed at start, and is not something a running process can be handed.
    const staged = path.join(directConfigDir(cfg, rec.name), '.credentials.json');
    if (existsSync(staged)) {
      if (!picked.source) {
        done.push({ name: rec.name, refreshed: false, why: 'a direct session takes a token at start; it is given the new one when it is resumed' });
        continue;
      }
      try {
        writeFileSync(staged, readFileSync(picked.source), { mode: 0o600 });
        done.push({ name: rec.name, refreshed: true });
      } catch (e) {
        done.push({ name: rec.name, refreshed: false, why: /** @type {Error} */ (e).message });
      }
      continue;
    }
    const r = reseed(cfg, rec.name, { account, actor: rec.createdBy ?? null });
    done.push({ name: rec.name, refreshed: r.refreshed, ...(r.why ? { why: r.why } : {}) });
  }
  for (const d of done) {
    if (d.refreshed) log.info(`vault: gave ${d.name} its owner's new Claude login`);
    else log.warn(`vault: ${d.name} keeps the Claude login it has: ${d.why}`);
  }
  return done;
}
