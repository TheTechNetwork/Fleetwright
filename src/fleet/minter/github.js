// A device's GitHub sign-in, finished by the minting Worker.
//
// WHY HERE. A phone that has signed in to GitHub can start its owner's
// runners itself (GitHub's dispatch, as them) and prove who they are when it
// deposits their Claude login, so no permanent box has to hold their GitHub
// connection. Getting it that sign-in needs the GitHub App's client secret,
// because GitHub's web flow requires it to exchange a code even with PKCE, and
// there were two wrong places for it:
//
//  - the PHONE: every member's device would carry a secret that lets anybody
//    who extracts it act as this App in the OAuth flow;
//  - the COORDINATOR: it has the secret, but the person's token would then
//    come back through the part of the fleet treated as compromised.
//
// So the phone runs GitHub's page with its own PKCE verifier and state, gets
// the code back, and seals { code, verifier } to this Worker's deposit key —
// the key it already pins for Claude logins. This opens it, makes the
// exchange with its own copy of the client secret, and seals the token to a
// one-request key the phone sent inside the request. Renewal is the same with
// the refresh token. The coordinator relays two ciphertexts.
//
// NOTHING IS KEPT. The token goes back to the device that asked and is not
// stored here; this is an exchange desk, not a store. And it hands nobody
// more than they brought: a code is only exchangeable with its verifier, a
// refresh token only by whoever already holds it.
//
// NEVER THROWS. Every refusal is a code and a sentence.

import { SEAL_KEY_RE, GITHUB_REQUEST_AAD, GITHUB_REPLY_AAD, seal, open } from '../seal.js';
import { DEPOSIT_MAX_AGE_MS } from './claude.js';

/** What GitHub's token endpoint is asked with and answers with, as far as this checks. */
const CODE_RE = /^[A-Za-z0-9_-]{8,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const REFRESH_RE = /^[A-Za-z0-9_]{20,512}$/;
const GITHUB_TIMEOUT_MS = 15_000;

/**
 * @typedef {object} GithubConfig
 * @property {(() => Promise<{ privateKey: CryptoKey, publicKey: string }>)|null} depositKey
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {typeof globalThis.fetch} [fetchImpl]
 * @property {() => number} [now]
 */

/** @param {string} code @param {string} text */
const refuse = (code, text) => ({ ok: false, error: { code }, text });

/**
 * @param {unknown} ask  `{ sealed }`, opened here to `{ v: 1, grant: 'code'|'refresh',
 *   code?, verifier?, redirectUri?, refreshToken?, reply, at }`
 * @param {GithubConfig} config
 */
export async function answerGithubToken(ask, config) {
  const { fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = config;
  if (!config.depositKey || !config.clientId || !config.clientSecret) {
    return refuse(
      'not_configured',
      'The minting Worker cannot finish a GitHub sign-in: it needs its deposit key and the GitHub App client id and secret.',
    );
  }
  const sealed = /** @type {any} */ (ask)?.sealed;
  if (!sealed || typeof sealed !== 'object') return refuse('bad_params', 'That is not a sealed GitHub sign-in.');
  let key;
  try {
    key = await config.depositKey();
  } catch (e) {
    return refuse('bad_deposit_key', `The deposit key does not load: ${/** @type {Error} */ (e).message}.`);
  }
  /** @type {any} */
  let inside;
  try {
    inside = await open({ privateKey: key.privateKey, publicKey: key.publicKey, aad: GITHUB_REQUEST_AAD, sealed });
  } catch {
    return refuse('unsealed', 'That sign-in does not open with this minter’s key. It was sealed to a different key, or changed on the way.');
  }
  const at = Number(inside?.at);
  const reply = String(inside?.reply || '');
  if (inside?.v !== 1 || !Number.isFinite(at) || !SEAL_KEY_RE.test(reply)) {
    return refuse('bad_params', 'That sign-in is not in the shape one takes.');
  }
  // FRESH, because a code lives ten minutes at GitHub anyway and a captured
  // refresh request replayed later should find nothing to do.
  if (Math.abs(now() - at) > DEPOSIT_MAX_AGE_MS) return refuse('stale', 'That sign-in is more than ten minutes old. Start it again.');

  /** @type {Record<string, string>} */
  let form;
  if (inside.grant === 'code') {
    const code = String(inside.code || '');
    const verifier = String(inside.verifier || '');
    const redirectUri = String(inside.redirectUri || '');
    if (!CODE_RE.test(code) || !VERIFIER_RE.test(verifier) || !/^https:\/\/[^\s]+\/oauth\/github\/callback$/.test(redirectUri)) {
      return refuse('bad_params', 'That sign-in is missing its code, its PKCE verifier or its callback.');
    }
    form = { client_id: config.clientId, client_secret: config.clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri };
  } else if (inside.grant === 'refresh') {
    const refreshToken = String(inside.refreshToken || '');
    if (!REFRESH_RE.test(refreshToken)) return refuse('bad_params', 'That renewal has no refresh token in it.');
    form = { client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken };
  } else {
    return refuse('bad_params', 'A GitHub sign-in is a code or a renewal, and that was neither.');
  }

  /** @type {any} */
  let body;
  try {
    const res = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'fleetwright' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) return refuse('github_refused', `GitHub refused the sign-in (${res.status}).`);
  } catch (e) {
    return refuse('github_unreachable', `Could not reach GitHub: ${/** @type {Error} */ (e).message}.`);
  }
  // GitHub answers 200 with an `error` for a bad code, an expired one, or a
  // verifier that does not match: said as GitHub said it.
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    const why = typeof body?.error_description === 'string' ? body.error_description : String(body?.error || 'no token in the answer');
    return refuse('github_refused', `GitHub did not sign you in: ${why}.`);
  }
  // WHOSE, asked of GitHub with the token, so the device can say "signed in
  // as …" from GitHub's own answer rather than from anything relayed.
  let login = '';
  let userId = '';
  try {
    const me = await fetchImpl('https://api.github.com/user', {
      headers: {
        authorization: `Bearer ${body.access_token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'fleetwright',
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    const who = me.ok ? /** @type {any} */ (await me.json()) : null;
    login = String(who?.login || '');
    userId = who?.id === undefined ? '' : String(who.id);
  } catch { /* the token is still good; the name is a nicety */ }

  const t = now();
  const expiresIn = Number(body.expires_in);
  const refreshIn = Number(body.refresh_token_expires_in);
  const sealedBack = await seal({
    to: reply,
    aad: GITHUB_REPLY_AAD,
    payload: {
      accessToken: body.access_token,
      expiresAt: Number.isFinite(expiresIn) ? t + expiresIn * 1000 : null,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      refreshExpiresAt: Number.isFinite(refreshIn) ? t + refreshIn * 1000 : null,
      login,
      userId,
    },
  });
  return { ok: true, sealed: sealedBack, text: login ? `Signed in to GitHub as ${login}.` : 'Signed in to GitHub.' };
}
