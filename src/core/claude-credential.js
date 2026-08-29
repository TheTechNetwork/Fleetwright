// What a Claude credential file actually says about itself.
//
// Everywhere else in this repo a `.credentials.json` is opaque bytes we copy
// from one place to another, and that was fine right up until somebody had to
// answer "why did this session come up logged out". The bytes were genuine.
// They were also expired, and nothing between the file and the phone was in a
// position to say so — the session said "Remote Control did not come online",
// which is four steps downstream of the cause.
//
// So: one place that reads the file, and THREE ANSWERS RATHER THAN TWO.
//
//   fresh     — there is an expiry and it is in the future
//   expired   — there is an expiry and it has passed
//   unknown   — the file is missing, unreadable, or a shape this code does
//               not recognise
//
// UNKNOWN IS NOT EXPIRED, and collapsing them would be the more dangerous
// mistake of the two. This parser is reading a file format owned by somebody
// else, which is free to grow a new shape in any release; a version of this
// code that treated "I did not recognise it" as "it is dead" would refuse to
// start sessions on a perfectly good box, and the refusal would look exactly
// like the bug it was written to fix.

import { readFileSync } from 'node:fs';

/**
 * @typedef {object} CredentialState
 * @property {'fresh'|'expired'|'unknown'} state
 * @property {number|null} expiresAt     epoch ms, or null when it does not say
 * @property {boolean} refreshable       there is a refresh token to renew with
 * @property {string|null} account       the email the credential belongs to
 * @property {string|null} plan          subscriptionType, when it says
 */

/**
 * Read a `.credentials.json` and say what state it is in.
 *
 * The oauth block is looked for under `claudeAiOauth` and then at the top
 * level, because those are the two shapes the CLI has written, and a file that
 * is one release old is not a file that should stop a session.
 *
 * @param {string} file
 * @param {number} [now]
 * @returns {CredentialState}
 */
export function readCredentialState(file, now = Date.now()) {
  /** @type {CredentialState} */
  const unknown = { state: 'unknown', expiresAt: null, refreshable: false, account: null, plan: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return unknown;
  }
  const oauth = pickObject(parsed?.claudeAiOauth) ?? pickObject(parsed);
  if (!oauth) return unknown;

  const expiresAt = typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt)
    ? oauth.expiresAt
    : null;
  const refreshable = typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0;
  const account = typeof oauth.account?.email_address === 'string'
    ? oauth.account.email_address
    : typeof oauth.emailAddress === 'string' ? oauth.emailAddress : null;
  const plan = typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null;

  // No expiry field at all is UNKNOWN, not fresh. A credential that does not
  // say when it dies has told us nothing, and "we could not tell" is the
  // honest report — the alternative is a green tick derived from a missing
  // field, which is the most confident kind of wrong.
  if (expiresAt === null) return { ...unknown, refreshable, account, plan };

  return { state: expiresAt > now ? 'fresh' : 'expired', expiresAt, refreshable, account, plan };
}

/** @param {unknown} value @returns {Record<string, any>|null} */
function pickObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = /** @type {Record<string, any>} */ (value);
  // Only counts as the oauth block if it carries at least one field we know.
  const known = ['accessToken', 'refreshToken', 'expiresAt', 'subscriptionType'];
  return known.some((k) => k in obj) ? obj : null;
}

/**
 * One sentence about a credential, for a person rather than for a log.
 *
 * Written to be true on a phone with no shell: every branch either says the
 * thing is fine or names the single action that fixes it. "Signed out" with no
 * next step is how the current message reads, and it is why somebody spent an
 * evening restarting sessions.
 *
 * @param {CredentialState} state
 * @param {string} [subject]  what to call it — "this box", "your account"
 * @param {number} [now]
 * @returns {string}
 */
export function describeCredential(state, subject = 'this box', now = Date.now()) {
  if (state.state === 'unknown') {
    return `Could not tell whether ${subject} is signed in — the credential file is missing or in a shape this version does not read.`;
  }
  if (state.state === 'expired') {
    return state.refreshable
      ? `${cap(subject)} has an expired access token. It can renew itself, but has not — sign in again if a session comes up logged out.`
      : `${cap(subject)} is signed out: the credential expired and there is nothing to renew it with. Sign in again.`;
  }
  const left = /** @type {number} */ (state.expiresAt) - now;
  return `${cap(subject)} is signed in${state.account ? ` as ${state.account}` : ''} (${humanise(left)} left on the token).`;
}

/** @param {string} s */
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** @param {number} ms */
function humanise(ms) {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${Math.max(mins, 1)}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
