// One real request to Claude with a token or a key, and what it said.
//
// THE REQUEST ITSELF, apart from where the credential came from, so the box's
// `verify claude` (claude-token-check.js, which reads a token from its file)
// and the minting Worker (which opens one from a person's vault and has no
// filesystem) ask the same question the same way. Everything else about why
// it is this request is in claude-token-check.js, which this was cut out of.

export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
/** The cheapest model a check can ask, one token of it. */
export const CHECK_MODEL = 'claude-haiku-4-5-20251001';

/**
 * @typedef {{ state: 'accepted'|'rejected'|'unknown', status: number|null, why: string|null }} TokenCheck
 */

/**
 * @param {{ token: string } | { key: string }} credential  a subscription token, or an API key
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<TokenCheck>}
 */
export async function probeClaude(credential, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  /** @type {Record<string, any>} */
  const body = { model: CHECK_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] };
  if ('token' in credential) {
    headers.authorization = `Bearer ${credential.token}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
    // How Claude Code identifies itself, which a subscription login is
    // allowed to be used for.
    body.system = "You are Claude Code, Anthropic's official CLI for Claude.";
  } else {
    headers['x-api-key'] = credential.key;
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
