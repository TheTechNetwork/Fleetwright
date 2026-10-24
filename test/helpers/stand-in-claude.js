// Claude's Messages API, stood in for the minter's check of a token before it
// keeps one and when a vault tests it (src/core/claude-token-probe.js), so no
// test sends a made-up token to the real API. A token with `revoked` in it, or
// one a test revoked after it was kept (revokeClaude), is refused as the API
// refuses one; any other is answered.

import { MESSAGES_URL } from '../../src/core/claude-token-probe.js';

/** Tokens revoked after they were kept, as a person revoking one at claude.ai would. */
const revoked = new Set();

/** @param {string} token */
export function revokeClaude(token) {
  revoked.add(token);
}

/**
 * Claude's answer to this request, or null when it is not a request to Claude.
 *
 * @param {unknown} url @param {any} [init]
 * @returns {Response|null}
 */
export function standInClaude(url, init = {}) {
  if (String(url) !== MESSAGES_URL) return null;
  const token = String(init.headers?.authorization || '').replace(/^Bearer /, '') || String(init.headers?.['x-api-key'] || '');
  const refused = token.includes('revoked') || revoked.has(token);
  const body = refused
    ? { type: 'error', error: { type: 'authentication_error', message: 'Invalid bearer token' } }
    : { type: 'message', content: [{ type: 'text', text: 'o' }] };
  return new Response(JSON.stringify(body), { status: refused ? 401 : 200, headers: { 'content-type': 'application/json' } });
}
