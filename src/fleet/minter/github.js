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
// NOTHING IS KEPT but a hash. The token goes back to the device that asked
// and is not stored here; this is an exchange desk, not a store. And it hands
// nobody more than they brought: a code is only exchangeable with its
// verifier, a refresh token only by whoever already holds it.
//
// THE HASH IS WHAT MAKES IT A DEVICE'S. A person's vault and Claude login are
// changed with a GitHub token sealed inside the request, and the vault hands
// a GitHub token of this same App to every box the person approves. GitHub
// says both are the person's, so asking GitHub whose a token is could not
// tell a phone from a box they removed (minter/vault-identity-any-github-
// token). What can is where the token came from: a sign-in finished here,
// from a code and a verifier only the person's device had, is recorded under
// their account id by the token's SHA-256, and so is its refresh token. A
// renewal carries the record on only when the refresh token it spent was
// recorded, so a refresh token from anywhere else still renews and is still
// not a device's. `deviceSignedIn` is the check (vault.js, claude.js).
//
// NOT A BOX'S CODE. "Only the person's device had" stopped being true for a
// sign-in a box finishes: a box that holds the GitHub client secret mints its
// own PKCE verifier for a person's Connect (sidecar.js, #offerChallenges) and
// is handed the code to finish with (#exchange). The root or sidecar account
// of one of the operator's boxes, where every member's connects can be
// placed, sealed that code and its own verifier here instead, with any fleet
// credential it held, and the sign-in was recorded as the person's device:
// enough to approve a key of the box's own against their vault (eighth audit,
// G11). Nothing in a code or a verifier says which flow made it, and the
// coordinator, which made the box's authorize URL and relayed its code, is
// the one place that knows. So it lists, beside every device's sign-in, the
// SHA-256 of each code it handed a box in the last ten minutes
// (core.js, #rememberBoxSignIn), and a code on that list is refused before
// GitHub is asked. Operator boxes are not inside a member's vault boundary:
// only a sign-in the person's own phone started can become their device.
//
// The list is the coordinator's word and can only take away, as the members
// list beside a box's vault ask is (vault.js): naming a phone's code refuses
// a sign-in, which dropping the request already could. ABSENT, it is a
// coordinator from before the list, served as before, so the two Workers
// deploy in either order.
//
// NEVER THROWS. Every refusal is a code and a sentence.

import { SEAL_KEY_RE, GITHUB_REQUEST_AAD, GITHUB_REPLY_AAD, seal, open } from '../seal.js';
import { DEPOSIT_MAX_AGE_MS } from './claude.js';

/** What GitHub's token endpoint is asked with and answers with, as far as this checks. */
const CODE_RE = /^[A-Za-z0-9_-]{8,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const REFRESH_RE = /^[A-Za-z0-9_]{20,512}$/;
const GITHUB_TIMEOUT_MS = 15_000;

/** Where a person's device sign-ins are recorded, under their GitHub account id. */
export const SIGNIN_PREFIX = 'signin:';

/** How many live sign-ins of each kind one person keeps on record: a few phones, renewing. */
const MAX_SIGNINS = 16;

/**
 * How many codes handed to boxes the coordinator may list beside a device's
 * sign-in. It keeps at most this many (core.js, MAX_BOX_SIGN_INS), which a
 * fleet of friends finishing box sign-ins over ten minutes never reaches, and
 * it keeps the request well inside this Worker's body limit.
 */
export const MAX_BOX_CODES = 64;
const CODE_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * @typedef {object} GithubConfig
 * @property {(() => Promise<{ privateKey: CryptoKey, publicKey: string }>)|null} depositKey
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {{ get: (key: string) => Promise<any>, put: (key: string, value: any) => Promise<void> }|null} [store]
 *   where device sign-ins are recorded; without one, a sign-in still finishes and opens no vault
 * @property {typeof globalThis.fetch} [fetchImpl]
 * @property {() => number} [now]
 */

/** @param {string} code @param {string} text */
const refuse = (code, text) => ({ ok: false, error: { code }, text });

/** A token's SHA-256, hex: what is recorded, so the record holds nothing that signs in. A code is compared by the same. @param {string} token */
async function tokenHash(token) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The entries of a record that have not run out, newest last, at most MAX_SIGNINS. @param {unknown} kept @param {number} now */
function live(kept, now) {
  const entries = Object.entries(kept && typeof kept === 'object' ? kept : {}).filter(([, at]) => at === null || Number(at) > now);
  return Object.fromEntries(entries.slice(-MAX_SIGNINS));
}

/**
 * Is this token one a device signed in for through this minter, for this
 * account, and not yet expired?
 *
 * @param {any} row  what is kept under SIGNIN_PREFIX + the account id
 * @param {string} token @param {number} now
 */
export async function deviceSignedIn(row, token, now) {
  const at = live(row?.access, now)[await tokenHash(token)];
  return at !== undefined;
}

/**
 * Record a device's sign-in. For a renewal, only when the refresh token it
 * spent was a device's: that is the whole of what stops a refresh token the
 * coordinator or a box holds from being renewed here into a device's token.
 *
 * Hashed before the read, so nothing but storage runs between it and the
 * write, and two phones of one person renewing at once both land.
 *
 * @param {NonNullable<GithubConfig['store']>} store @param {string} userId
 * @param {{ accessToken: string, expiresAt: number|null, refreshToken: string|null, refreshExpiresAt: number|null, spent: string|null }} signIn
 * @param {number} now
 */
async function recordSignIn(store, userId, { accessToken, expiresAt, refreshToken, refreshExpiresAt, spent }, now) {
  const access = await tokenHash(accessToken);
  const refresh = refreshToken ? await tokenHash(refreshToken) : null;
  const spentHash = spent ? await tokenHash(spent) : null;
  const key = `${SIGNIN_PREFIX}${userId}`;
  const row = (await store.get(key)) || {};
  const refreshes = live(row.refresh, now);
  if (spentHash) {
    if (!Object.hasOwn(refreshes, spentHash)) return;
    delete refreshes[spentHash];
  }
  const accesses = live(row.access, now);
  accesses[access] = expiresAt;
  if (refresh) refreshes[refresh] = refreshExpiresAt;
  await store.put(key, { access: live(accesses, now), refresh: live(refreshes, now) });
}

/**
 * @param {unknown} ask  `{ sealed, boxCodes? }`: the request, opened here to
 *   `{ v: 1, grant: 'code'|'refresh', code?, verifier?, redirectUri?, refreshToken?, reply, at }`,
 *   and the coordinator's SHA-256 of each code it handed a box lately
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
  // Present and not a list of hashes is refused, as a malformed members list
  // is: guessing at it either way is the wrong one.
  const listed = /** @type {any} */ (ask)?.boxCodes;
  /** @type {Set<string>|null} */
  let boxCodes = null;
  if (listed !== undefined) {
    if (!Array.isArray(listed) || listed.length > MAX_BOX_CODES || listed.some((h) => typeof h !== 'string' || !CODE_HASH_RE.test(h))) {
      return refuse('bad_params', 'The fleet’s list of sign-ins finished on boxes is not in the shape one takes.');
    }
    boxCodes = new Set(listed);
  }
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
    // BEFORE GITHUB IS ASKED, so the code is not spent: the box it was handed
    // to can still finish the sign-in it was started for, there.
    if (boxCodes?.has(await tokenHash(code))) {
      return refuse('box_sign_in', 'That GitHub sign-in was started for a box, so it is finished on that box and not by a device. Sign in to GitHub from your phone instead.');
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
    // A SPENT RENEWAL IS ITS OWN CODE. GitHub's refresh tokens work once: each
    // renewal hands back the next one, and a phone that renewed twice at once,
    // or lost the answer on the way, holds one GitHub will never take again.
    // Nothing retries its way out of that, so the device is told to drop the
    // sign-in and ask for a new one, rather than shown GitHub's sentence on
    // every screen that needs a token.
    if (inside.grant === 'refresh' && body?.error === 'bad_refresh_token') {
      return refuse('sign_in_again', 'This phone’s GitHub sign-in has run out. Sign in to GitHub again.');
    }
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
  const signIn = {
    accessToken: String(body.access_token),
    expiresAt: Number.isFinite(expiresIn) ? t + expiresIn * 1000 : null,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    refreshExpiresAt: Number.isFinite(refreshIn) ? t + refreshIn * 1000 : null,
  };
  // NOT RECORDED IS NOT REFUSED: GitHub has already spent a renewal's refresh
  // token, so the device is given what replaced it whatever the storage did,
  // and the vault refuses that token until the device signs in again.
  if (config.store && userId) {
    try {
      await recordSignIn(config.store, userId, { ...signIn, spent: inside.grant === 'refresh' ? String(inside.refreshToken) : null }, t);
    } catch { /* see above */ }
  }
  const sealedBack = await seal({ to: reply, aad: GITHUB_REPLY_AAD, payload: { ...signIn, login, userId } });
  return { ok: true, sealed: sealedBack, text: login ? `Signed in to GitHub as ${login}.` : 'Signed in to GitHub.' };
}
