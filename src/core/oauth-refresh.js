// Renewing an OAuth token, for a box and for the minting Worker's vault.
//
// PURE: fetch and nothing else, because the minting Worker is bundled for a
// platform with no filesystem and connectors.js reads and writes several
// files. The code is the box's renewal as it was, moved so there is one copy
// of each provider's wire rather than two that drift.

/** How long a provider's token endpoint gets to answer. */
const VERIFY_TIMEOUT_MS = 10_000;

/**
 * Trade a GitHub refresh token for a new access token.
 *
 * NOT THE SAME SHAPE AS CLAUDE'S RENEWAL, and the difference is why the host
 * keepalive does nothing for this. A Claude credential renews when it is USED;
 * exercising it is enough. A GitHub App user token is not renewed by use at
 * all — it lasts eight hours and is replaced only by an explicit exchange
 * against `POST /login/oauth/access_token`, which needs the App's client
 * secret. Using the token more often does not extend it by a second.
 *
 * THE REFRESH TOKEN IS ROTATED BY THIS CALL. GitHub returns a new one and
 * invalidates the old, so a caller that does not store what comes back has
 * renewed once and broken every renewal after it. That is the failure mode
 * worth naming here rather than discovering in eight hours' time.
 *
 * @param {{ refresh: string, client: string, clientId: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ ok: boolean, message: string, accessToken?: string, refreshToken?: string, expiresIn?: number|null }>}
 */
export async function refreshGithubToken({ refresh, client, clientId, fetchImpl = fetch }) {
  /** @type {any} */
  let body;
  try {
    const res = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: client,
        grant_type: 'refresh_token',
        refresh_token: refresh,
      }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    body = await res.json();
  } catch (e) {
    // A network failure is not a dead refresh token, and the difference
    // decides whether somebody has to go and reconnect. Keeping them apart is
    // the same argument verifyToken makes below.
    return { ok: false, message: `Could not reach GitHub to renew: ${/** @type {Error} */ (e).message}` };
  }
  // GitHub answers 200 with an `error` field rather than a status code.
  if (!body || body.error) {
    return { ok: false, message: `GitHub refused the renewal: ${body?.error_description || body?.error || 'no reason given'}` };
  }
  if (typeof body.access_token !== 'string' || !body.access_token) {
    return { ok: false, message: 'GitHub returned no access token.' };
  }
  return {
    ok: true,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresIn: Number(body.expires_in) || null,
    message: 'GitHub renewed the token.',
  };
}

/**
 * Trade a Cloudflare refresh token for a new access token.
 *
 * The same contract as `refreshGithubToken` — same rotation warning included:
 * Cloudflare invalidates the spent refresh token and returns a new one, so a
 * caller that does not store what comes back has renewed once and broken every
 * renewal after it.
 *
 * Where it differs is the wire, because Cloudflare's token endpoint is RFC
 * 6749 as written and GitHub's is not: the request is FORM-ENCODED (a JSON
 * body is a 400), and a refusal is a non-200 status carrying
 * `error`/`error_description` rather than GitHub's 200-with-an-error.
 *
 * @param {{ refresh: string, client: string, clientId: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ ok: boolean, message: string, accessToken?: string, refreshToken?: string, expiresIn?: number|null }>}
 */
export async function refreshCloudflareToken({ refresh, client, clientId, fetchImpl = fetch }) {
  /** @type {any} */
  let body;
  let status = 0;
  try {
    const res = await fetchImpl('https://dash.cloudflare.com/oauth2/token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: clientId,
        client_secret: client,
      }).toString(),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (e) {
    // A network failure is not a dead refresh token, and the difference
    // decides whether somebody has to go and reconnect.
    return { ok: false, message: `Could not reach Cloudflare to renew: ${/** @type {Error} */ (e).message}` };
  }
  if (status < 200 || status >= 300 || !body || body.error) {
    return { ok: false, message: `Cloudflare refused the renewal: ${body?.error_description || body?.error || `it answered ${status}`}` };
  }
  if (typeof body.access_token !== 'string' || !body.access_token) {
    return { ok: false, message: 'Cloudflare returned no access token.' };
  }
  return {
    ok: true,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresIn: Number(body.expires_in) || null,
    message: 'Cloudflare renewed the token.',
  };
}

/** Each provider's token endpoint. The authorize pages are the coordinator's business (oauth.js). */
export const TOKEN_URLS = Object.freeze({
  github: 'https://github.com/login/oauth/access_token',
  cloudflare: 'https://dash.cloudflare.com/oauth2/token',
});

/**
 * Trade an authorization code, and the PKCE verifier that goes with it, for a
 * token. For a device's sign-in finished by the minting Worker, which holds
 * the client secret: the code arrived through somebody's browser, the
 * verifier through a seal, and neither is any use without the other.
 *
 * Form-encoded for both, which GitHub accepts and Cloudflare requires, and
 * read the way each refuses: GitHub with a 200 carrying `error`, Cloudflare
 * with a status. Never throws.
 *
 * @param {{ provider: 'github'|'cloudflare', code: string, verifier: string, redirectUri: string, clientId: string, client: string, fetchImpl?: typeof fetch }} o
 * @returns {Promise<{ ok: boolean, message: string, accessToken?: string, refreshToken?: string|null, expiresIn?: number|null }>}
 */
export async function exchangeCode({ provider, code, verifier, redirectUri, clientId, client, fetchImpl = fetch }) {
  const label = provider === 'github' ? 'GitHub' : 'Cloudflare';
  /** @type {any} */
  let body;
  let status = 0;
  try {
    const res = await fetchImpl(TOKEN_URLS[provider], {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'fleetwright' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: client,
      }).toString(),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (e) {
    return { ok: false, message: `Could not reach ${label}: ${/** @type {Error} */ (e).message}` };
  }
  if (status < 200 || status >= 300 || !body || body.error || typeof body.access_token !== 'string' || !body.access_token) {
    return { ok: false, message: `${label} did not sign you in: ${body?.error_description || body?.error || `it answered ${status}`}` };
  }
  return {
    ok: true,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresIn: Number(body.expires_in) || null,
    message: `${label} signed you in.`,
  };
}
