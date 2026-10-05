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

export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
/** The cheapest model a check can ask, one token of it. */
export const CHECK_MODEL = 'claude-haiku-4-5-20251001';

/**
 * @typedef {{ state: 'accepted'|'rejected'|'unknown', status: number|null, why: string|null }} TokenCheck
 */

/**
 * @param {import('./runner-login.js').RunnerAuth} auth  a token (read from its file now) or a key
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<TokenCheck>}
 */
export async function checkClaudeAuth(auth, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  /** @type {Record<string, any>} */
  const body = { model: CHECK_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] };
  if (auth.kind === 'token') {
    let token = '';
    try {
      token = readFileSync(auth.file, 'utf8').trim();
    } catch (e) {
      return { state: 'unknown', status: null, why: `the kept login could not be read here (${/** @type {NodeJS.ErrnoException} */ (e).code || 'unreadable'})` };
    }
    if (!token) return { state: 'unknown', status: null, why: 'the kept login is empty' };
    headers.authorization = `Bearer ${token}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
    // How Claude Code identifies itself, which a subscription login is
    // allowed to be used for.
    body.system = "You are Claude Code, Anthropic's official CLI for Claude.";
  } else if (auth.kind === 'key') {
    headers['x-api-key'] = auth.key;
  } else {
    return { state: 'unknown', status: null, why: 'a linked login is checked from its file, not here' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(MESSAGES_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (e) {
    const err = /** @type {Error} */ (e);
    return { state: 'unknown', status: null, why: err.name === 'AbortError' ? 'the API did not answer in time' : `the API could not be reached (${err.message})` };
  } finally {
    clearTimeout(timer);
  }
  const reason = await reasonOf(res);
  // ACCEPTED: it answered, or it knew who was asking and said not now.
  if (res.ok || res.status === 429 || res.status === 529) return { state: 'accepted', status: res.status, why: res.ok ? null : reason };
  if (res.status === 401) return { state: 'rejected', status: 401, why: reason };
  return { state: 'unknown', status: res.status, why: reason };
}

/**
 * The API's own reason, one line of it.
 *
 * @param {Response} res
 */
async function reasonOf(res) {
  try {
    const j = /** @type {any} */ (await res.json());
    const m = j?.error?.message;
    return typeof m === 'string' ? m.replace(/\s+/g, ' ').slice(0, 160) : null;
  } catch {
    return null;
  }
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
