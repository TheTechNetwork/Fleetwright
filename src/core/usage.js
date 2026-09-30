// How much of each linked Claude account's limit is used, from the account's
// own point of view.
//
// THE QUESTION THIS ANSWERS is the one the account page in the app could not:
// "sessions are failing — is that the box, or is the plan out?" Health has
// carried whose account a box runs on for a while (email, plan, org) and said
// nothing about how much of it was left, because nothing on the box knew.
//
// WHERE THE ANSWER COMES FROM, and why that is worth writing down. Claude Code's
// own `/usage` asks `GET https://api.anthropic.com/api/oauth/usage` with the
// account's OAuth access token and the `oauth-2025-04-20` beta header, and draws
// what comes back: one block per rate-limit window, each with `utilization` as
// a percentage of the window used (0-100) and `resets_at` as an ISO timestamp.
// That is the CLI's own endpoint, not a documented API, and it is read here on
// exactly those terms: the shape it answered with in September 2026 is what
// `normaliseUsage` recognises, anything else is CANNOT TELL, and the `why` says
// which. A version of this that guessed at an unfamiliar answer would draw a
// confident number about somebody's plan from a field that meant something else.
//
// PER ACCOUNT, NOT PER BOX. A box has no Claude account of its own any more
// (docs/one-account-per-person.md); the credentials it holds are the linked
// people's, so the answer is a list — one row per linked account, each with
// its own windows or its own reason for none.
//
// WHAT LEAVES THE BOX: the email (already on health), four percentages and
// four timestamps per account. Never the token, and never the raw answer.

import { readFileSync } from 'node:fs';
import { Accounts } from './accounts.js';
import { readCredentialState } from './claude-credential.js';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** The windows this reads, in the endpoint's names → the frame's. */
export const WINDOWS = Object.freeze({
  five_hour: 'fiveHour',
  seven_day: 'sevenDay',
  seven_day_opus: 'sevenDayOpus',
  seven_day_sonnet: 'sevenDaySonnet',
});

/**
 * @typedef {object} UsageWindow
 * @property {number|null} used      percent of the window used, 0-100 as the endpoint gave it
 * @property {number|null} resetsAt  epoch ms when the window resets, or null when it did not say
 */

/**
 * @typedef {object} AccountUsage
 * @property {UsageWindow|null} fiveHour
 * @property {UsageWindow|null} sevenDay
 * @property {UsageWindow|null} sevenDayOpus
 * @property {UsageWindow|null} sevenDaySonnet
 */

/**
 * The endpoint's answer, in the frame's words — or null when no window this
 * reads was present in a shape it reads.
 *
 * @param {unknown} body
 * @returns {AccountUsage|null}
 */
export function normaliseUsage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = /** @type {Record<string, unknown>} */ (body);
  /** @type {Record<string, UsageWindow|null>} */
  const out = {};
  let any = false;
  for (const [theirs, ours] of Object.entries(WINDOWS)) {
    const w = b[theirs];
    if (!w || typeof w !== 'object' || Array.isArray(w)) {
      out[ours] = null;
      continue;
    }
    const win = /** @type {Record<string, unknown>} */ (w);
    const used = typeof win.utilization === 'number' && Number.isFinite(win.utilization) ? win.utilization : null;
    let resetsAt = null;
    if (typeof win.resets_at === 'string') {
      const t = Date.parse(win.resets_at);
      resetsAt = Number.isFinite(t) ? t : null;
    } else if (typeof win.resets_at === 'number' && Number.isFinite(win.resets_at)) {
      // Not what the endpoint sends today; the header-derived shape elsewhere
      // in the CLI uses epoch seconds, and a number here can only be that.
      resetsAt = win.resets_at * 1000;
    }
    // A window with neither field is one this did not understand.
    if (used === null && resetsAt === null) {
      out[ours] = null;
      continue;
    }
    out[ours] = { used, resetsAt };
    any = true;
  }
  return any ? /** @type {AccountUsage} */ (out) : null;
}

/**
 * The access token in a credential file, or null. The two shapes are the ones
 * src/core/claude-credential.js reads, for the same reason: the file format is
 * somebody else's.
 *
 * @param {string|null} file
 * @returns {string|null}
 */
export function accessTokenFrom(file) {
  if (!file) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const oauth = parsed?.claudeAiOauth && typeof parsed.claudeAiOauth === 'object' ? parsed.claudeAiOauth : parsed;
  const token = oauth?.accessToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Ask the endpoint once, for one account.
 *
 * @param {string} accessToken
 * @param {{ fetch?: typeof globalThis.fetch, url?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true, usage: AccountUsage } | { ok: false, why: string }>}
 */
export async function readUsage(accessToken, { fetch = globalThis.fetch, url = USAGE_URL, timeoutMs = 10_000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, why: `could not reach the usage endpoint: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, why: `the account's token was refused (HTTP ${res.status})` };
  if (!res.ok) return { ok: false, why: `the usage endpoint answered HTTP ${res.status}` };
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, why: 'the usage endpoint did not answer with JSON' };
  }
  const usage = normaliseUsage(body);
  if (!usage) {
    const keys = body && typeof body === 'object' ? Object.keys(body).slice(0, 12).join(', ') : typeof body;
    return { ok: false, why: `the usage endpoint answered in a shape this version does not read (${keys || 'empty'})` };
  }
  return { ok: true, usage };
}

/**
 * @typedef {object} UsageSnapshot
 * @property {number} checkedAt  epoch ms of the last refresh
 * @property {Array<{ account: string, usage: AccountUsage|null, why: string|null }>} accounts
 */

/**
 * Asks per linked account on a timer the hub owns, and keeps the last answer
 * for /api/state to publish. Nothing here writes to disk: what an account has
 * used is the endpoint's to remember, and a stale copy of it is worse than none.
 */
export class UsageMonitor {
  /**
   * @param {import('../config.js').Config} cfg
   * @param {{ fetch?: typeof globalThis.fetch, now?: () => number, accounts?: Accounts,
   *   readState?: typeof readCredentialState, tokenFrom?: typeof accessTokenFrom,
   *   read?: typeof readUsage, log?: { info: Function, warn: Function } }} [deps]
   */
  constructor(cfg, {
    fetch = globalThis.fetch,
    now = Date.now,
    accounts = new Accounts(cfg.stateDir),
    readState = readCredentialState,
    tokenFrom = accessTokenFrom,
    read = readUsage,
    log = console,
  } = {}) {
    this.cfg = cfg;
    this.fetch = fetch;
    this.now = now;
    this.accounts = accounts;
    this.readState = readState;
    this.tokenFrom = tokenFrom;
    this.read = read;
    this.log = log;
    /** @type {UsageSnapshot|null} */
    this.last = null;
  }

  /** The last answer, or null before the first refresh — CANNOT TELL, not "no accounts". */
  snapshot() {
    return this.last;
  }

  /**
   * Ask once for every linked account. Never throws: an account that cannot be
   * asked gets a `why`, and the rest are still answered.
   * @returns {Promise<UsageSnapshot>}
   */
  async refresh() {
    /** @type {string[]} */
    let emails = [];
    try {
      emails = this.accounts.list();
    } catch (e) {
      this.log.warn(`usage: could not list linked accounts: ${e instanceof Error ? e.message : String(e)}`);
    }
    /** @type {UsageSnapshot['accounts']} */
    const rows = [];
    for (const email of emails) {
      const file = this.accounts.credentialPathFor(email);
      const state = file ? this.readState(file, this.now()) : null;
      if (!file || !state) {
        rows.push({ account: email, usage: null, why: 'no credential file' });
        continue;
      }
      if (state.state === 'expired') {
        // The endpoint would only say 401. The keepalive is what renews it;
        // saying so is more useful than asking and being refused.
        rows.push({ account: email, usage: null, why: 'the credential has expired and has not renewed yet' });
        continue;
      }
      const token = this.tokenFrom(file);
      if (!token) {
        rows.push({ account: email, usage: null, why: 'the credential file has no access token' });
        continue;
      }
      const r = await this.read(token, { fetch: this.fetch });
      rows.push(r.ok ? { account: email, usage: r.usage, why: null } : { account: email, usage: null, why: r.why });
    }
    for (const row of rows) {
      if (row.why) this.log.info(`usage: ${row.account}: ${row.why}`);
    }
    this.last = { checkedAt: this.now(), accounts: rows };
    return this.last;
  }
}
