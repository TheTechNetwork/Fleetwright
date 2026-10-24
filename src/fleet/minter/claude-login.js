// A person's whole Claude sign-in, kept by the minter and renewed only here.
//
// WHY A SIGN-IN AND NOT ONLY A SETUP-TOKEN. A `claude setup-token` runs
// sessions and nothing else: Remote Control, which is how a phone watches a
// session on a box, needs the login `claude auth login` makes. That login was
// made on each box from its page ("Sign in to Claude"), so every box held its
// own copy with its own refresh token, renewing it on its own clock, which is
// the race the vault exists to end (docs/vault.md): two boxes renewing one
// refresh token, and the loser signed out.
//
// SO THE REFRESH TOKEN LIVES HERE AND NOWHERE ELSE. A box is given the access
// token, its expiry and the account it belongs to, never the refresh token,
// and asks again before it runs out, as it already does every ten minutes. A
// Claude Code with no refresh token in its credentials file does not try to
// renew: it reads the file again, which is where the box has written a fresh
// one (src/core/vault-store.js).
//
// RENEWED THE WAY CLAUDE CODE RENEWS IT, against the same address with the
// same public client and the scopes the sign-in was granted: read off Claude
// Code's own code (2.1.42, and again on 2.1.306, the version the session
// image pins), not guessed, because a renewal that is wrong signs the person
// out everywhere at once. If Anthropic moves it, renewing fails with a sentence, and the boxes
// keep the access token they have until it runs out.
//
// The row it lives in is the one a runner reads (claude.js), sealed at rest to
// the deposit key under the person's GitHub id, the same as a setup-token.

import { atRestAad, seal, open } from '../seal.js';

export const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/**
 * Asked for only when a sign-in names no scopes of its own. A renewal asks
 * for the scopes the sign-in was granted, which is what Claude Code falls back
 * to when its own wider ask is refused (2.1.306): asking for one it was never
 * granted is `invalid_scope`, a 400 that would read here as Claude refusing
 * the sign-in, and asking for fewer would hand boxes a narrower token than
 * the person signed in for.
 */
export const CLAUDE_SCOPES = ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers'];

/** Renewed when less than this is left, as the vault's other sign-ins are. */
export const CLAUDE_REFRESH_AHEAD_MS = 30 * 60_000;

/** One printable word of a sane length: the format is Anthropic's and undocumented. */
const TOKEN_WORD_RE = /^[A-Za-z0-9._~+/=-]{20,4096}$/;

/** The account fields a box's Claude Code reads beside the credential, and nothing else. */
const ACCOUNT_FIELDS = ['accountUuid', 'emailAddress', 'organizationUuid', 'organizationName', 'organizationRole', 'workspaceRole', 'displayName', 'billingType', 'hasExtraUsageEnabled'];

/**
 * @typedef {object} ClaudeOauth  what `claude auth login` writes as `claudeAiOauth`
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} expiresAt   epoch ms
 * @property {string[]} scopes
 * @property {string|null} subscriptionType
 * @property {string|null} rateLimitTier
 */

/**
 * A sign-in as a machine read it off `claude auth login` and a phone sent it,
 * held to the fields this keeps and no more: anything else in the file stays
 * on the machine that made it.
 *
 * @param {unknown} v  `{ oauth: { accessToken, refreshToken, expiresAt, scopes, ... }, account: {...} }`
 * @returns {{ oauth: ClaudeOauth, account: Record<string, unknown> } | null}
 */
export function claudeSignIn(v) {
  const o = /** @type {any} */ (v)?.oauth;
  if (!o || typeof o !== 'object') return null;
  const accessToken = String(o.accessToken ?? '');
  const refreshToken = String(o.refreshToken ?? '');
  const expiresAt = Number(o.expiresAt);
  if (!TOKEN_WORD_RE.test(accessToken) || !TOKEN_WORD_RE.test(refreshToken) || !Number.isFinite(expiresAt)) return null;
  const scopes = Array.isArray(o.scopes) ? o.scopes.map(String).filter((/** @type {string} */ s) => /^[a-z_:]{1,64}$/.test(s)).slice(0, 16) : [];
  const short = (/** @type {unknown} */ s) => (typeof s === 'string' && s.length <= 64 ? s : null);
  /** @type {Record<string, unknown>} */
  const account = {};
  const a = /** @type {any} */ (v)?.account;
  if (a && typeof a === 'object') {
    for (const f of ACCOUNT_FIELDS) {
      const x = a[f];
      if ((typeof x === 'string' && x.length <= 256) || typeof x === 'boolean') account[f] = x;
    }
  }
  return {
    oauth: { accessToken, refreshToken, expiresAt, scopes, subscriptionType: short(o.subscriptionType), rateLimitTier: short(o.rateLimitTier) },
    account,
  };
}

/**
 * Renew a sign-in, the request Claude Code makes.
 *
 * `refused` is Anthropic saying no (the refresh token was revoked, or used
 * already), which only signing in again mends; anything else is cannot tell,
 * and the access token held is still good until it runs out.
 *
 * @param {ClaudeOauth} oauth
 * @param {{ fetchImpl: typeof fetch, now: () => number }} io
 * @returns {Promise<{ ok: true, oauth: ClaudeOauth } | { ok: false, refused: boolean, message: string }>}
 */
export async function renewClaudeSignIn(oauth, { fetchImpl, now }) {
  let res;
  try {
    res = await fetchImpl(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: CLAUDE_CLIENT_ID, scope: (oauth.scopes?.length ? oauth.scopes : CLAUDE_SCOPES).join(' ') }),
    });
  } catch (e) {
    return { ok: false, refused: false, message: `Claude could not be reached to renew it (${/** @type {Error} */ (e).message})` };
  }
  /** @type {any} */
  const body = await res.json().catch(() => null);
  if (res.status === 400 || res.status === 401) {
    const why = typeof body?.error_description === 'string' ? body.error_description : typeof body?.error === 'string' ? body.error : `${res.status}`;
    return { ok: false, refused: true, message: `Claude refused to renew it (${why.slice(0, 160)})` };
  }
  if (!res.ok || typeof body?.access_token !== 'string' || !Number.isFinite(Number(body?.expires_in))) {
    return { ok: false, refused: false, message: `Claude answered ${res.status} to the renewal` };
  }
  return {
    ok: true,
    oauth: {
      ...oauth,
      accessToken: body.access_token,
      // KEPT WHEN NOT GIVEN, as Claude Code does: a renewal may or may not
      // rotate the refresh token.
      refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : oauth.refreshToken,
      expiresAt: now() + Number(body.expires_in) * 1000,
      scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : oauth.scopes,
    },
  };
}

/**
 * @typedef {object} HeldClaude
 * @property {'token'|'login'} kind
 * @property {string} bearer     what a session authenticates with: the setup-token, or the access token
 * @property {number|null} expiresAt
 * @property {ClaudeOauth|null} oauth
 * @property {Record<string, unknown>|null} account
 */

/**
 * The person's Claude row opened, and renewed first if it is a sign-in that is
 * due. Call it under the person's lock (vault.js, withLock): renewing rotates
 * the refresh token, and two renewals at once sign the person out.
 *
 * WRITTEN BACK ONLY OVER THE ROW IT READ. A deposit is kept by the Worker in
 * front of the vault's object, outside that lock, so the row is read again
 * after the renewal and left alone if a newer one arrived meanwhile.
 *
 * @param {{ get: (k: string) => Promise<any>, put: (k: string, v: any) => Promise<void> }} store
 * @param {{ privateKey: CryptoKey, publicKey: string }} key
 * @param {string} userId
 * @param {{ fetchImpl: typeof fetch, now: () => number }} io
 * @returns {Promise<{ held: HeldClaude|null, problem: string|null, refused?: boolean }>}
 */
export async function freshClaude(store, key, userId, io) {
  const row = await store.get(`gh:${userId}`);
  if (!row?.sealed || row.forgotten) return { held: null, problem: null };
  /** @type {any} */
  let inside;
  try {
    inside = await open({ privateKey: key.privateKey, publicKey: key.publicKey, aad: atRestAad(userId), sealed: row.sealed });
  } catch {
    return { held: null, problem: 'Your Claude login does not open with this minter’s key; keep it again.' };
  }
  if (!inside?.oauth) {
    return { held: { kind: 'token', bearer: String(inside?.token || ''), expiresAt: null, oauth: null, account: null }, problem: null };
  }
  /** @type {ClaudeOauth} */
  let oauth = inside.oauth;
  const account = inside.account && typeof inside.account === 'object' ? inside.account : {};
  /** @type {string|null} */
  let problem = null;
  let refused = false;
  if (Number(oauth.expiresAt) - io.now() < CLAUDE_REFRESH_AHEAD_MS) {
    const r = await renewClaudeSignIn(oauth, io);
    if (r.ok) {
      oauth = r.oauth;
      const now = await store.get(`gh:${userId}`);
      if (now && Number(now.at) === Number(row.at) && now.sealed === row.sealed) {
        await store.put(`gh:${userId}`, { ...row, sealed: await seal({ to: key.publicKey, aad: atRestAad(userId), payload: { oauth, account } }) });
      }
    } else {
      refused = r.refused;
      problem = r.refused
        ? `${r.message}. Sign in to Claude again from your phone or the signing page; until then nothing can be given your login once it runs out.`
        : `${r.message}; the login held is good until it runs out.`;
    }
  }
  if (Number(oauth.expiresAt) <= io.now()) {
    return { held: null, problem: problem ?? 'Your Claude sign-in has run out. Sign in to Claude again from your phone or the signing page.', refused: true };
  }
  return { held: { kind: 'login', bearer: oauth.accessToken, expiresAt: Number(oauth.expiresAt), oauth, account }, problem, refused };
}
