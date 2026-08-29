// Keeping a credential alive on a box nobody is using.
//
// "Something has to ask." An OAuth credential renews when it is USED, and
// nothing on an idle host uses the Claude credential — no session is running,
// which is the definition of idle. So the credential goes stale exactly when
// you most need it not to be: the moment somebody reaches for their phone and
// starts a session on a box that has been quiet since yesterday.
//
// That is the second half of "deb13-staging wouldn't work until I clicked sign
// in again". Signing in worked because signing in is a use.
//
// A LADDER, CHEAPEST RUNG FIRST, and every rung measured the same way.
//
//   1. `claude auth status` — free. It may renew as a side effect of asking,
//      and if it does there is nothing further to do.
//   2. a one-shot prompt — costs a few tokens, and unambiguously exercises the
//      credential against the API, which is the thing that renews it.
//
// It stops at the first rung that works, so an idle box normally pays nothing.
//
// THE VERDICT COMES FROM THE CREDENTIAL FILE, NOT FROM THE EXIT CODE, and that
// is the whole reason this is safe to ship. Every one of these commands can
// succeed without renewing anything — that is precisely what `auth status` was
// doing for weeks while the watcher called it every twenty seconds. So the
// expiry is read before and after and the answer is whether it MOVED. If a CLI
// release changes what renews, this reports "ran, and the expiry did not move"
// rather than reporting success and being quietly wrong for a month.
//
// NOT A SESSION, deliberately, though a session would also work. A session is a
// container, a volume, a tmux pane, a registry record, a watcher entry, a bin
// entry and an idle-restart candidate — every one of them blast radius for
// something whose entire job is to make one HTTPS request. A one-shot
// invocation exercises the same credential by the same route and leaves
// nothing behind to explain.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { log } from '../log.js';
import { readCredentialState } from './claude-credential.js';
import { Accounts } from './accounts.js';

/** How long a one-shot prompt gets. Generous: a cold CLI start is seconds. */
const PROMPT_TIMEOUT_MS = 90_000;
/** `auth status` is a local read plus at most one token exchange. */
const STATUS_TIMEOUT_MS = 20_000;

/**
 * Short enough to cost almost nothing, explicit enough that a person reading
 * their own usage log can tell what it was.
 *
 * It is a real request and it does consume a real, tiny amount of quota. That
 * is not a side effect to be minimised away — it IS the mechanism. A keepalive
 * that costs nothing is one that did nothing.
 */
const PROBE_PROMPT = 'Reply with exactly: ok';

/**
 * @typedef {object} Renewal
 * @property {'renewed'|'already-fresh'|'unchanged'|'no-credential'} outcome
 * @property {string} account
 * @property {number|null} before   expiry before, epoch ms
 * @property {number|null} after    expiry after, epoch ms
 * @property {string} [rung]        which step moved it
 * @property {string} [detail]
 */

/**
 * Renew one account's credential if it needs it.
 *
 * @param {import('../config.js').Config} cfg
 * @param {{ account?: string, within?: number, now?: () => number }} [opts]
 *   `within` — renew when this much or less is left. Default four hours, which
 *   is longer than the gap between health checks by a wide margin and shorter
 *   than a token's life, so a box is never found holding one that expires in
 *   minutes.
 * @returns {Renewal}
 */
export function renewClaudeCredential(cfg, { account = 'shared', within = 4 * 3_600_000, now = Date.now } = {}) {
  const file = credentialFileFor(cfg, account);
  if (!file || !existsSync(file)) {
    return { outcome: 'no-credential', account, before: null, after: null };
  }

  const before = readCredentialState(file, now());
  // ALREADY FRESH IS A REASON NOT TO SPEND ANYTHING. The expensive rung costs
  // quota, so it must only ever run when there is something to gain.
  if (before.state === 'fresh' && before.expiresAt !== null && before.expiresAt - now() > within) {
    return { outcome: 'already-fresh', account, before: before.expiresAt, after: before.expiresAt };
  }
  // Unknown is not a licence to spend either. A shape this code does not read
  // is one where "did the expiry move" cannot be answered, so the measurement
  // that makes this safe is unavailable and the honest thing is to do nothing.
  if (before.state === 'unknown') {
    return {
      outcome: 'unchanged',
      account,
      before: null,
      after: null,
      detail: 'the credential is in a shape this version does not read, so a renewal could not be verified',
    };
  }

  return withCredentialDir(cfg, account, file, (dir) => {
    for (const rung of rungs(cfg)) {
      const r = spawnSync(cfg.claudeBin, rung.args, {
        env: dir ? { ...process.env, CLAUDE_CONFIG_DIR: dir } : process.env,
        encoding: 'utf8',
        timeout: rung.timeout,
      });
      // A failed rung is not a failure of the ladder — the next one may be the
      // one that works, and reporting the first non-zero exit would hide it.
      if (r.error) log.debug(`keepalive: ${rung.name} for ${account}: ${r.error.message}`);

      const after = readCredentialState(dir ? path.join(dir, '.credentials.json') : file, now());
      if (moved(before, after)) {
        return {
          outcome: /** @type {const} */ ('renewed'),
          account,
          before: before.expiresAt,
          after: after.expiresAt,
          rung: rung.name,
        };
      }
    }
    const after = readCredentialState(dir ? path.join(dir, '.credentials.json') : file, now());
    return {
      outcome: /** @type {const} */ ('unchanged'),
      account,
      before: before.expiresAt,
      after: after.expiresAt,
      detail: 'every step ran and the expiry did not move',
    };
  });
}

/**
 * Renew everything this box holds: the shared credential and every linked
 * account.
 *
 * A GUEST'S ACCOUNT GOES STALE THE SAME WAY, and worse — the shared credential
 * at least gets used whenever anybody on the box works, while a linked account
 * belonging to somebody who has not started a session this week is used by
 * nothing at all. Skipping them would fix this for the person least likely to
 * hit it.
 *
 * @param {import('../config.js').Config} cfg
 * @param {{ within?: number }} [opts]
 * @returns {Renewal[]}
 */
export function renewAllCredentials(cfg, { within } = {}) {
  const accounts = ['shared', ...new Accounts(cfg.stateDir).list()];
  /** @type {Renewal[]} */
  const results = [];
  for (const account of accounts) {
    try {
      const r = renewClaudeCredential(cfg, { account, ...(within ? { within } : {}) });
      results.push(r);
      if (r.outcome === 'renewed') {
        log.info(`keepalive: renewed ${account}'s credential via ${r.rung}`);
      } else if (r.outcome === 'unchanged') {
        // WARN, not debug. This is the case where the mechanism has stopped
        // working, and it is invisible from everywhere else — the credential
        // simply expires later and a session comes up logged out, four hours
        // and one screen away from the cause.
        log.warn(`keepalive: ${account}'s credential did not renew — ${r.detail}`);
      }
    } catch (e) {
      // Never fatal. This runs on a timer beside everything else on the box.
      log.warn(`keepalive: ${account} could not be renewed: ${/** @type {Error} */ (e).message}`);
    }
  }
  return results;
}

/** @param {import('../config.js').Config} cfg */
function rungs(cfg) {
  return [
    // Free. Whether it renews is a CLI implementation detail we do not control
    // and must not assume either way — which is exactly why the answer is
    // measured rather than believed.
    { name: 'auth status', args: ['auth', 'status', '--json'], timeout: STATUS_TIMEOUT_MS },
    // Costs a few tokens and unambiguously exercises the credential against the
    // API. Only reached when the free rung did not move the expiry.
    { name: 'a one-shot prompt', args: ['-p', PROBE_PROMPT], timeout: PROMPT_TIMEOUT_MS },
  ].filter(() => Boolean(cfg.claudeBin));
}

/**
 * Did anything actually change?
 *
 * A LATER EXPIRY, not merely a different one. A CLI that rewrote the file with
 * the same token would produce a different mtime and no more life, and the
 * whole point of this function is that it cannot be fooled by activity.
 *
 * @param {import('./claude-credential.js').CredentialState} before
 * @param {import('./claude-credential.js').CredentialState} after
 */
function moved(before, after) {
  if (after.expiresAt === null) return false;
  if (before.expiresAt === null) return after.state === 'fresh';
  return after.expiresAt > before.expiresAt;
}

/**
 * Where a named account's credential lives.
 * @param {import('../config.js').Config} cfg @param {string} account
 */
function credentialFileFor(cfg, account) {
  if (account === 'shared') return cfg.sandboxCredentialsFile || null;
  return new Accounts(cfg.stateDir).credentialPathFor(account);
}

/**
 * Run `work` with the account's credential where the CLI will find it.
 *
 * The shared credential already IS the box's, so the CLI reads it where it
 * lives and `dir` is null. A linked account is a file in our store that the CLI
 * has never heard of, so it is staged into an isolated CLAUDE_CONFIG_DIR — the
 * same trick the link flow uses — and copied back if it changed.
 *
 * THE BOX'S OWN LOGIN IS NEVER TOUCHED BY A LINKED ACCOUNT'S RENEWAL. Running
 * `claude` in the host's home on somebody else's credential would overwrite the
 * shared one, which is a way to lose an org login while trying to preserve a
 * guest's.
 *
 * @template T
 * @param {import('../config.js').Config} cfg
 * @param {string} account
 * @param {string} file
 * @param {(dir: string|null) => T} work
 * @returns {T}
 */
function withCredentialDir(cfg, account, file, work) {
  if (account === 'shared') return work(null);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'renew-'));
  try {
    writeFileSync(path.join(dir, '.credentials.json'), readFileSync(file, 'utf8'), { mode: 0o600 });
    // The identity has to travel with the credential here for the same reason
    // it does into a sandbox: the CLI decides logged-in-ness from the pair, and
    // one without the other is a login that fails while both files are genuine.
    const meta = new Accounts(cfg.stateDir).accountMetaPathFor(account);
    if (meta && existsSync(meta)) {
      writeFileSync(path.join(dir, '.claude.json'), `{"oauthAccount":${readFileSync(meta, 'utf8')}}`, { mode: 0o600 });
    }
    const result = work(dir);
    const renewed = path.join(dir, '.credentials.json');
    // Written back only when it grew life. A blind copy-back would happily
    // overwrite a good stored credential with whatever a failed run left.
    const after = readCredentialState(renewed);
    if (after.state === 'fresh') writeFileSync(file, readFileSync(renewed, 'utf8'), { mode: 0o600 });
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
