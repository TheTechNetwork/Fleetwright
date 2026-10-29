// Claude's Messages API, stood in for the minter's check of a token before it
// keeps one and when a vault tests it (src/core/claude-token-probe.js), so no
// test sends a made-up token to the real API. A token with `revoked` in it, or
// one a test revoked after it was kept (revokeClaude), is refused as the API
// refuses one; any other is answered.
//
// And Claude's token address, for the minter renewing a whole sign-in
// (src/fleet/minter/claude-login.js): a refresh token is answered once with a
// new pair, slowly so two renewals at once overlap, and refused after that, as
// a rotated refresh token is. Counted, so a renewal made twice is seen. A
// renewal may ask for the scopes the sign-in was granted or fewer, and one
// asking for a scope it was never granted is refused with `invalid_scope`, as
// an OAuth server refuses it.
//
// And the usage address, which the minter asks with a sign-in's access token
// to see whether it still works (claude-login.js, checkClaude): refused for
// the same tokens the Messages API refuses, answered for any other, counted.

import { MESSAGES_URL } from '../../src/core/claude-token-probe.js';
import { CLAUDE_TOKEN_URL, CLAUDE_CLIENT_ID, CLAUDE_USAGE_URL } from '../../src/fleet/minter/claude-login.js';

/**
 * Renewals asked for, and refresh tokens already used. `expiresIn` is how
 * long a renewed access token lasts, in seconds: Claude's eight hours unless a
 * test wants the next renewal due at once.
 */
export const claudeRenewals = { count: 0, used: new Set(), expiresIn: 28800, /** @type {number|undefined} */ refreshExpiresIn: undefined, rotate: true };

/** How many times the usage address was asked. */
export const claudeUsageAsks = { count: 0 };

/**
 * Every sign-in made so far ended, as signing out of Claude Code on claude.ai
 * ends them: each refresh token issued until now is refused from here on.
 */
export function cancelClaudeSignIns() {
  for (const t of granted.keys()) claudeRenewals.used.add(t);
}

/** The scopes each refresh token was granted, carried to the one it is rotated to. @type {Map<string, string[]>} */
const granted = new Map();

/** A sign-in as `claude auth login` writes one, `expiresIn` ms from now. @param {string} name @param {number} [expiresIn] */
export function claudeSignInFor(name, expiresIn = 8 * 3_600_000, scopes = ['user:inference', 'user:profile', 'user:sessions:claude_code']) {
  const refreshToken = `sk-ant-ort01-${name}-${'r'.repeat(40)}`;
  granted.set(refreshToken, scopes);
  return {
    oauth: {
      accessToken: `sk-ant-oat01-${name}-${'a'.repeat(40)}`,
      refreshToken,
      expiresAt: Date.now() + expiresIn,
      scopes,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    },
    account: { accountUuid: `uuid-${name}`, emailAddress: `${name}@example.com`, organizationUuid: 'org-1', billingType: 'stripe_subscription', notAField: 'dropped' },
  };
}

/**
 * Claude's token address, or null when this is not a request to it.
 *
 * @param {unknown} url @param {any} [init]
 * @returns {Promise<Response>|null}
 */
function standInClaudeToken(url, init) {
  if (String(url) !== CLAUDE_TOKEN_URL) return null;
  return (async () => {
    const f = JSON.parse(String(init.body || '{}'));
    claudeRenewals.count += 1;
    await new Promise((r) => setTimeout(r, 20));
    const reply = (/** @type {number} */ status, /** @type {any} */ body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (f.grant_type !== 'refresh_token' || f.client_id !== CLAUDE_CLIENT_ID) return reply(400, { error: 'invalid_request' });
    const old = String(f.refresh_token || '');
    if (!old.startsWith('sk-ant-ort01-') || old.includes('revoked') || claudeRenewals.used.has(old)) {
      return reply(400, { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' });
    }
    const asked = String(f.scope || '').split(' ').filter(Boolean);
    const allowed = granted.get(old) ?? [];
    if (asked.some((x) => !allowed.includes(x))) return reply(400, { error: 'invalid_scope', error_description: 'The requested scope is invalid, unknown, or malformed.' });
    const n = claudeRenewals.count;
    // ROTATED unless a test says not: Anthropic may give the same one back.
    const rotated = claudeRenewals.rotate ? `sk-ant-ort01-rotated${n}-${'s'.repeat(40)}` : old;
    if (rotated !== old) claudeRenewals.used.add(old);
    granted.set(rotated, allowed);
    return reply(200, {
      access_token: `sk-ant-oat01-renewed${n}-${'b'.repeat(40)}`, refresh_token: rotated, expires_in: claudeRenewals.expiresIn, scope: (asked.length ? asked : allowed).join(' '),
      ...(claudeRenewals.refreshExpiresIn !== undefined ? { refresh_token_expires_in: claudeRenewals.refreshExpiresIn } : {}),
    });
  })();
}

/** Tokens revoked after they were kept, as a person revoking one at claude.ai would. */
const revoked = new Set();

/** @param {string} token */
export function revokeClaude(token) {
  revoked.add(token);
}

/** Tokens the usage address answers 403: good, but not allowed to do this. */
const forbidden = new Set();

/** @param {string} token */
export function forbidClaude(token) {
  forbidden.add(token);
}

/**
 * Claude's answer to this request, or null when it is not a request to Claude.
 *
 * @param {unknown} url @param {any} [init]
 * @returns {Response|Promise<Response>|null}
 */
export function standInClaude(url, init = {}) {
  const token = standInClaudeToken(url, init);
  if (token) return /** @type {any} */ (token);
  const usage = String(url) === CLAUDE_USAGE_URL;
  if (!usage && String(url) !== MESSAGES_URL) return null;
  const bearer = String(init.headers?.authorization || '').replace(/^Bearer /, '') || String(init.headers?.['x-api-key'] || '');
  const refused = bearer.includes('revoked') || revoked.has(bearer);
  if (usage) {
    claudeUsageAsks.count += 1;
    if (!refused && forbidden.has(bearer)) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'OAuth token does not meet scope requirement user:profile' } }), { status: 403, headers: { 'content-type': 'application/json' } });
    }
    const said = refused ? { type: 'error', error: { type: 'authentication_error', message: 'OAuth token has been revoked.' } } : { five_hour: { utilization: 12, resets_at: null } };
    return new Response(JSON.stringify(said), { status: refused ? 401 : 200, headers: { 'content-type': 'application/json' } });
  }
  const body = refused
    ? { type: 'error', error: { type: 'authentication_error', message: 'Invalid bearer token' } }
    : { type: 'message', content: [{ type: 'text', text: 'o' }] };
  return new Response(JSON.stringify(body), { status: refused ? 401 : 200, headers: { 'content-type': 'application/json' } });
}
