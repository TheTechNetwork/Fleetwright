// Whether the Claude login a session with nothing linked would run on is still
// accepted, asked of the API rather than read off a file.
//
// THE GAP THIS CLOSES. `verify claude` on a runner said "no linked account" and
// stopped: it read files, and a runner's sessions run on something that is not
// a linked account's file — the owner's kept `claude setup-token` token, a
// token from the person's vault, or the runner repository's API key. One of
// those tokens was revoked, every session the runner started answered "401
// OAuth access token is invalid" at its first message, and the check that
// exists to catch exactly that had nothing to say. A setup-token carries no
// expiry the box can read, so the only way to know is to use it.
//
// ONE REAL REQUEST, the kind a session makes: a message of one output token on
// the cheapest model, sent the way Claude Code sends it (the OAuth beta header
// and its own system line for a token; the key header for a key). It costs a
// token. A cheaper probe that a token's narrow scope could refuse while
// sessions still worked — the profile or usage endpoints, which a setup-token
// is not allowed to read — would report a working login as broken, which is
// worse than the gap.
//
// WHAT IS SAID: accepted, rejected, or cannot tell, and which. Never the token,
// never the raw answer — only the status and the API's own short reason for a
// refusal, cut to a line.

import { readFileSync } from 'node:fs';
import { probeClaude } from './claude-token-probe.js';

export { MESSAGES_URL, CHECK_MODEL } from './claude-token-probe.js';

/** @typedef {import('./claude-token-probe.js').TokenCheck} TokenCheck */

/**
 * @param {import('./runner-login.js').RunnerAuth} auth  a token (read from its file now) or a key
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<TokenCheck>}
 */
export async function checkClaudeAuth(auth, opts = {}) {
  if (auth.kind === 'token') {
    let token = '';
    try {
      token = readFileSync(auth.file, 'utf8').trim();
    } catch (e) {
      return { state: 'unknown', status: null, why: `the kept login could not be read here (${/** @type {NodeJS.ErrnoException} */ (e).code || 'unreadable'})` };
    }
    if (!token) return { state: 'unknown', status: null, why: 'the kept login is empty' };
    return probeClaude({ token }, opts);
  }
  if (auth.kind === 'key') return probeClaude({ key: auth.key }, opts);
  return { state: 'unknown', status: null, why: 'a linked login is checked from its file, not here' };
}

/**
 * The check, as the sentence `verify claude` ends with.
 *
 * @param {import('./runner-login.js').RunnerAuth} auth
 * @param {TokenCheck} r
 */
export function describeTokenCheck(auth, r) {
  const what = auth.kind === 'key' ? 'The runner repository’s API key' : 'That login';
  if (r.state === 'accepted') {
    return r.status === 429 || r.status === 529
      ? `${what} was accepted just now, though Claude said it is busy (${r.status}): sessions will start, and may wait.`
      : `${what} was accepted just now: Claude answered a one-token request with it.`;
  }
  if (r.state === 'rejected') {
    const fix = auth.kind === 'key'
      ? 'Replace the ANTHROPIC_API_KEY secret in the runner repository.'
      : 'Keep a new one from the app (Claude for runners, Make it on a machine) or paste a fresh `claude setup-token`.';
    return `${what} was rejected just now (401${r.why ? `: ${r.why}` : ''}), so every session here would stop at its first message. ${fix}`;
  }
  return `Whether ${what.toLowerCase()} still works cannot be told from here: ${r.why ?? `the API answered ${r.status}`}.`;
}
