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
import { Connections, refreshGithubToken } from './connectors.js';

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
 * @property {number|null} [left]   how long was on it when we looked, ms
 * @property {boolean} [pressing]   near enough to expiry that a failure matters
 * @property {string} [rung]        which step moved it
 * @property {string} [detail]
 */

/**
 * Renew one account's credential if it needs it.
 *
 * TWO WINDOWS, NOT ONE, and the second one was missing in the first version of
 * this file. Found by testing it against a real box, which is the only place
 * this could have been found:
 *
 *   `within` (4h)  start ASKING. The free rung runs from here down.
 *   `urgent` (45m) start SPENDING. The paid rung runs only from here down.
 *
 * The reason they have to be different is that WE DO NOT DECIDE WHEN A TOKEN
 * REFRESHES — the CLI does, and an OAuth client refreshes when a token is
 * expired or nearly so, not whenever it is asked. So between 4h and 45m the
 * honest expectation is that nothing happens: the credential is healthy and
 * there is nothing to renew.
 *
 * With one window, that produced two bugs at once. The paid rung would fire
 * every hour for four hours, buying nothing each time, and every one of those
 * would log a warning saying the mechanism had failed. A warning that fires
 * four times per token on a perfectly healthy box is one nobody reads by the
 * second day — and it would have been the same warning that means something is
 * genuinely wrong.
 *
 * @param {import('../config.js').Config} cfg
 * @param {{ account?: string, within?: number, urgent?: number, now?: () => number }} [opts]
 * @returns {Renewal}
 */
export function renewClaudeCredential(cfg, {
  account = 'shared',
  within = 4 * 3_600_000,
  urgent = 45 * 60_000,
  now = Date.now,
} = {}) {
  const file = credentialFileFor(cfg, account);
  if (!file || !existsSync(file)) {
    return { outcome: 'no-credential', account, before: null, after: null };
  }

  const before = readCredentialState(file, now());
  const left = before.expiresAt === null ? null : before.expiresAt - now();
  // ALREADY FRESH IS A REASON NOT TO SPEND ANYTHING, and not to ask either.
  // A token with most of its life left is not a problem to be solved; nothing
  // renews it because there is nothing wrong with it.
  if (before.state === 'fresh' && left !== null && left > within) {
    return { outcome: 'already-fresh', account, before: before.expiresAt, after: before.expiresAt, left };
  }
  // Is it close enough to justify spending quota? Expired counts, and so does
  // an expiry we could read but that is nearly here.
  const pressing = left === null || left <= urgent;
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
      // The paid rung waits for the tighter window. Asking costs nothing and
      // may work; spending quota every hour for four hours to buy nothing is
      // a bill for the privilege of being early.
      if (rung.costsQuota && !pressing) continue;
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
          left,
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
      left,
      // WHETHER THIS MATTERS, decided here and not at the log site. Nothing
      // moving with three hours left is the expected answer; nothing moving
      // with twenty minutes left is the mechanism failing, and they must not
      // share a log level or the real one is invisible.
      pressing,
      detail: pressing
        ? 'every step ran and the expiry did not move'
        : 'nothing to renew yet — the CLI renews near expiry, not on request',
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
      } else if (r.outcome === 'unchanged' && r.pressing) {
        // WARN ONLY WHEN IT MATTERS. This is the case where the mechanism has
        // stopped working and it is invisible from everywhere else — the
        // credential simply expires and a session comes up logged out, hours
        // and one screen away from the cause.
        //
        // Not when there is still time, though: an OAuth client renews near
        // expiry rather than on request, so "asked, nothing happened, three
        // hours left" is the expected answer and warning about it would bury
        // the case that is not.
        log.warn(`keepalive: ${account}'s credential did not renew — ${r.detail}`);
      } else if (r.outcome === 'unchanged') {
        log.debug(`keepalive: ${account} — ${r.detail}`);
      }
    } catch (e) {
      // Never fatal. This runs on a timer beside everything else on the box.
      log.warn(`keepalive: ${account} could not be renewed: ${/** @type {Error} */ (e).message}`);
    }
  }
  return results;
}

/**
 * Renew every stored provider token on this box that can renew itself.
 *
 * DELIBERATELY A DIFFERENT MECHANISM FROM THE CLAUDE LADDER ABOVE, because the
 * providers renew differently and pretending otherwise would build something
 * that runs, reports success and achieves nothing:
 *
 *   Claude  a credential renews when it is USED. Exercising it is the fix.
 *   GitHub  an App user token is NOT renewed by use. It lasts eight hours and
 *           is replaced only by an explicit exchange, which needs the App's
 *           client secret. A thousand API calls extend it by zero seconds.
 *
 * The material comes from the `renew` intent, deposited once when the
 * connection is made — see src/fleet/protocol/intents.js. A box with no
 * deposit does nothing here, which is every box that connected before this
 * shipped and every connection made by pasting a token.
 *
 * @param {import('../config.js').Config} cfg
 * @param {{ within?: number, now?: () => number }} [opts]
 * @returns {Promise<Array<{ row: string, provider: string, outcome: string, detail?: string }>>}
 */
export async function renewProviderTokens(cfg, { within = 2 * 3_600_000, now = Date.now } = {}) {
  /** @type {Array<{ row: string, provider: string, outcome: string, detail?: string }>} */
  const results = [];
  const store = new Connections(cfg.stateDir);

  for (const row of store.renewableRows()) {
    const label = typeof row === 'string' ? row : 'this box';
    for (const provider of ['github']) {
      const material = store.readRenewal(row, provider);
      if (!material) continue;
      // WHEN, from the metadata rather than from the token: the access token
      // is opaque to us and GitHub does not publish an introspection endpoint
      // we may call. `updatedAt` plus the lifetime GitHub told us at exchange
      // time is what we have, and it is enough — being early costs one HTTPS
      // request, and being late costs a session.
      const due = store.renewalDueAt(row, provider);
      if (due !== null && due - now() > within) {
        results.push({ row: label, provider, outcome: 'not-due' });
        continue;
      }
      try {
        // Everything the exchange needs came with the deposit — nothing here
        // is configured on the box, which is what keeps this off the list of
        // questions an install has to ask.
        const r = await refreshGithubToken(material);
        if (!r.ok) {
          log.warn(`keepalive: could not renew ${provider} for ${label} — ${r.message}`);
          results.push({ row: label, provider, outcome: 'failed', detail: r.message });
          continue;
        }
        // BOTH HALVES, OR NEITHER. GitHub rotates the refresh token on every
        // exchange and invalidates the old one, so storing the access token
        // without the new refresh token renews exactly once and breaks every
        // renewal after it — eight hours later, with nothing to point at.
        const stored = store.save(row, provider, /** @type {string} */ (r.accessToken));
        if (!stored.ok) {
          results.push({ row: label, provider, outcome: 'failed', detail: stored.message });
          continue;
        }
        if (r.refreshToken) {
          store.saveRenewal(row, provider, { ...material, refresh: r.refreshToken, expiresIn: r.expiresIn });
        }
        log.info(`keepalive: renewed ${provider} for ${label}`);
        results.push({ row: label, provider, outcome: 'renewed' });
      } catch (e) {
        log.warn(`keepalive: ${provider} for ${label}: ${/** @type {Error} */ (e).message}`);
        results.push({ row: label, provider, outcome: 'failed', detail: /** @type {Error} */ (e).message });
      }
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
    { name: 'auth status', args: ['auth', 'status', '--json'], timeout: STATUS_TIMEOUT_MS, costsQuota: false },
    // Costs a few tokens and unambiguously exercises the credential against the
    // API. Only reached when the free rung did not move the expiry.
    { name: 'a one-shot prompt', args: ['-p', PROBE_PROMPT], timeout: PROMPT_TIMEOUT_MS, costsQuota: true },
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
