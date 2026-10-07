// The OAuth flows a person finishes in a browser, shared by both coordinators.
//
// This file was `github-oauth.js` until Cloudflare grew from "no third-party
// app program" to a registered OAuth client (the correction is in
// docs/connectors.md) — at which point the GitHub shape transferred whole:
// Authorization Code with a client secret, a callback at the coordinator,
// `state` binding host and person, the result relayed down the socket. Two
// providers, one flow, so one file.
//
// WHY THE COORDINATOR AND NOT THE HOST. The provider redirects a browser, and
// a browser cannot reach a host — hosts dial out and have no inbound route.
// The coordinator is the only publicly addressable part of this system, so the
// callback lands there and the result is relayed down the socket the host
// already holds open. That is the same shape as everything else here: the
// public edge holds no state and the host holds no port.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not mint installation tokens,
// which would need the GitHub App's private key — an object that mints for
// EVERY installation of the App and therefore cannot live in a party this
// design treats as compromised. See docs/github-app.md. What it does is the
// half that works without it: a short-lived user access token, scoped to what
// the person chose, with a refresh token that belongs to them alone.

import * as oauth from 'oauth4webapi';

/**
 * The two providers, as the authorization-server documents oauth4webapi wants.
 *
 * Written down rather than discovered: neither publishes an OAuth discovery
 * document at its issuer, and both have had these endpoints for a decade. The
 * `issuer` values are labels the library keys on; nothing here validates an
 * ID token against them, because neither flow issues one.
 *
 * WHY A LIBRARY FOR THIS, when the two exchanges were ~100 lines of fetch:
 * docs/auth-and-join.md applies the test that took `jose` — a protocol with
 * negotiation and a silent failure mode is not worth owning — and a token
 * endpoint is one: content types, error shapes, `WWW-Authenticate`
 * challenges, the `token_type` check, and two providers that disagree about
 * all of it. oauth4webapi is panva's, like jose, has no dependencies, and runs
 * on WebCrypto and fetch, so the Worker bundle and the sidecar carry the same
 * code. What stays ours is the URL each person is sent to and the words they
 * read on the way back.
 */
/** @type {oauth.AuthorizationServer} */
const GITHUB = Object.freeze({
  issuer: 'https://github.com',
  authorization_endpoint: 'https://github.com/login/oauth/authorize',
  token_endpoint: 'https://github.com/login/oauth/access_token',
});
/** @type {oauth.AuthorizationServer} */
const CLOUDFLARE = Object.freeze({
  issuer: 'https://dash.cloudflare.com',
  authorization_endpoint: 'https://dash.cloudflare.com/oauth2/auth',
  token_endpoint: 'https://dash.cloudflare.com/oauth2/token',
});

/** How long somebody has to finish authorizing before the state is refused. */
const STATE_TTL_MS = 10 * 60_000;

/** Bounded, because an abandoned flow costs memory until it expires. */
const MAX_PENDING = 200;

/**
 * A pending authorization, and the whole security of the callback.
 *
 * `state` is the only thing tying a request arriving from the open internet to
 * a flow this coordinator started. It therefore has to be:
 *
 *  - **unguessable** — a uuid, not a counter
 *  - **single-use** — redeemed exactly once, so a replayed callback is refused
 *  - **short-lived** — ten minutes is longer than anybody takes and shorter
 *    than a link left open in a tab
 *  - **bound to both the host and the person**, so the token that comes back
 *    can only be delivered where the flow started and stored under the
 *    identity that asked
 *
 * Without those four the callback is an open door for anyone who can guess a
 * URL — and the thing behind the door writes a credential onto a machine.
 */
export class PendingAuthorizations {
  /** @param {{ now?: () => number, ttlMs?: number }} [opts] */
  constructor({ now = () => Date.now(), ttlMs = STATE_TTL_MS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    /** @type {Map<string, { hostId: string, email: string|null, pkce: boolean, relayed: boolean, at: number }>} */
    this.pending = new Map();
  }

  /** Drop everything past its window. Called on both paths, not on a timer. */
  sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [state, rec] of this.pending) if (rec.at <= cutoff) this.pending.delete(state);
  }

  /**
   * @param {{ state: string, hostId: string, email: string|null, pkce?: boolean, relayed?: boolean }} flow
   */
  mint({ state, hostId, email, pkce = false, relayed = false }) {
    this.sweep();
    // Oldest first, so a flood of abandoned flows cannot evict a live one that
    // somebody is in the middle of.
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    // `pkce`: the host offered a challenge, so the code goes BACK TO IT to be
    // exchanged rather than being exchanged here. See `exchange` in
    // src/fleet/protocol/intents.js.
    // `relayed`: GitHub sends the person to the OAuth relay, which exchanges
    // the code, so the only way this flow finishes is sealed, through
    // finishRelayedGithubAuthorization, and never by a code arriving here.
    this.pending.set(state, { hostId, email, pkce: Boolean(pkce), relayed: Boolean(relayed), at: this.now() });
    return state;
  }

  /**
   * Redeem once. Returns the flow, or null for unknown, expired or replayed.
   * @param {unknown} state
   */
  redeem(state) {
    this.sweep();
    const key = typeof state === 'string' ? state : '';
    const found = this.pending.get(key);
    if (!found) return null;
    // Deleted before the caller does anything with it: a callback that arrives
    // twice, or is replayed from a browser history entry, must not exchange a
    // second time.
    this.pending.delete(key);
    return found;
  }
}

/**
 * The origin, parsed rather than trimmed.
 *
 * This was `origin.replace(/\/+$/, '')`, which CodeQL flagged the day after
 * CodeQL started running, and it was right twice over.
 *
 * **The regex backtracks.** `\/+$` against a long run of slashes that does not
 * end the string is polynomial: 60,000 slashes with one character after them
 * took three seconds, measured. Anchoring at the end is what makes it
 * quadratic rather than linear.
 *
 * **And the input is not ours.** The Node coordinator built its origin from
 * `req.headers.host`, which is whatever the client sent. So the slow string
 * was one header away, and — separately — a forged Host would have been
 * assembled into a `redirect_uri`. GitHub refuses a redirect that is not on the
 * App's registered list, so that was never a token leak, but building a URL out
 * of an attacker's header and sending it to a provider is not a thing to leave
 * standing because the provider happens to catch it.
 *
 * `new URL(...).origin` is linear, and cannot produce a trailing slash at all —
 * so the trimming this replaced is not merely faster, it is unnecessary.
 *
 * @param {unknown} value
 * @returns {string|null} the normalised origin, or null if it is not one
 */
export function normaliseOrigin(value) {
  const raw = String(value ?? '');
  // A bound before parsing: a megabyte of Host header is not a URL anybody
  // meant to send, and refusing it costs nothing.
  if (!raw || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Where to send somebody to authorize.
 *
 * `redirect_uri` is sent explicitly rather than relying on the App's default,
 * so a deployment on a different origin cannot silently send its users to
 * somebody else's coordinator — GitHub matches it against the registered list
 * and refuses a mismatch, which is the behaviour we want to depend on.
 *
 * @param {{ clientId: string, origin: string, state: string, codeChallenge?: string|null }} args
 */
export function authorizeUrl({ clientId, origin, state, codeChallenge = null }) {
  const base = normaliseOrigin(origin);
  if (!base) return null;
  const url = new URL(/** @type {string} */ (GITHUB.authorization_endpoint));
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', `${base}/oauth/github/callback`);
  url.searchParams.set('state', state);
  // PKCE, when the host minted a verifier: only the challenge leaves the
  // host, and the code that comes back is worth nothing without the verifier
  // — including to this coordinator. S256 and never `plain`, which would
  // hand the relay the verifier itself.
  if (codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

/**
 * Where to send somebody to authorize, for a coordinator that signs in to
 * GitHub through the OAuth relay (src/fleet/relay/relay.js) because it has
 * the App's id and not its secret.
 *
 * The `redirect_uri` is the RELAY'S, which is on the App's registered list
 * where this coordinator's never will be, and the state is `<fleet>.<state>`:
 * the fleet tells the relay where to send the person back, and the rest is
 * this coordinator's own, redeemed once here.
 *
 * @param {{ clientId: string, relay: string, fleet: string, state: string }} args
 */
export function relayAuthorizeUrl({ clientId, relay, fleet, state }) {
  const base = normaliseOrigin(relay);
  if (!base) return null;
  const url = new URL(/** @type {string} */ (GITHUB.authorization_endpoint));
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', `${base}/relay/v1/github/callback`);
  url.searchParams.set('state', `${fleet}.${state}`);
  return url.toString();
}

/**
 * Where to send somebody to authorize with Cloudflare.
 *
 * The same three properties as the GitHub URL above, plus one that GitHub does
 * not need: `scope`. A GitHub App's reach is chosen on GitHub's own consent
 * screen; a Cloudflare OAuth client's reach is the scopes the AUTHORIZE
 * REQUEST asks for, drawn from the list registered on the client. They are
 * dot-delimited API-token permission names (`workers-scripts.edit`,
 * `account-settings.read` — never a colon form, which Cloudflare rejects),
 * plus `offline_access` for a refresh token — and they are
 * configuration rather than a constant here, because only whoever registered
 * the client knows what it was registered with. A request for a scope the
 * client does not have is refused by Cloudflare with `invalid_scope`, which is
 * the visible failure we want over a token quietly granted less than the work
 * needs.
 *
 * @param {{ clientId: string, origin: string, state: string, scopes: string, codeChallenge?: string|null }} args
 */
export function cloudflareAuthorizeUrl({ clientId, origin, state, scopes, codeChallenge = null }) {
  const base = normaliseOrigin(origin);
  if (!base) return null;
  const url = new URL(/** @type {string} */ (CLOUDFLARE.authorization_endpoint));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', `${base}/oauth/cloudflare/callback`);
  // Space-separated per RFC 6749; commas tolerated on the way in because a
  // list in an environment variable gets written both ways.
  url.searchParams.set('scope', String(scopes).split(/[\s,]+/).filter(Boolean).join(' '));
  url.searchParams.set('state', state);
  if (codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

/**
 * One exchange, for either provider.
 *
 * Never throws: a provider that is down, slow, or answering something
 * unexpected must produce a message somebody can act on rather than a stack
 * trace in a Worker log and a blank page in a browser.
 *
 * `codeVerifier` is what a HOST passes, exchanging a code the coordinator
 * relayed to it: the verifier never left the host, so the same function serves
 * both places and only one of them can ever fill this in. Without one, the
 * library is told so explicitly (`nopkce`) rather than being left to infer it.
 *
 * The request is what RFC 6749 says: form-encoded, `client_secret_post`. Both
 * providers accept that, and only Cloudflare insists on it — GitHub takes JSON
 * too, which is what this used to send, and the point of a library is not to
 * have a dialect per provider.
 *
 * @param {{ as: oauth.AuthorizationServer, label: string, clientId: string, clientSecret: string, code: string, redirectUri: string, codeVerifier: string|null, fetch: typeof globalThis.fetch }} args
 * @returns {Promise<{ ok: true, accessToken: string, refreshToken: string|null, expiresIn: number|null } | { ok: false, message: string }>}
 */
async function exchange({ as, label, clientId, clientSecret, code, redirectUri, codeVerifier, fetch: doFetch }) {
  /** @type {oauth.Client} */
  const client = { client_id: clientId };
  let response;
  try {
    // The callback's parameters, validated the way the library wants them
    // before it will build a token request from them. `state` was redeemed by
    // PendingAuthorizations before this was called, and a host exchanging a
    // relayed code never sees one — so none is expected here.
    const params = oauth.validateAuthResponse(as, client, new URLSearchParams({ code }), oauth.expectNoState);
    response = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      oauth.ClientSecretPost(clientSecret),
      params,
      redirectUri,
      codeVerifier ?? oauth.nopkce,
      { [oauth.customFetch]: doFetch, signal: AbortSignal.timeout(15_000) },
    );
  } catch (e) {
    return { ok: false, message: `Could not reach ${label} to finish signing in: ${/** @type {Error} */ (e).message}` };
  }

  // GITHUB ANSWERS 200 WITH AN `error` FIELD rather than a status code, which
  // the library reads as a token response missing its token — true, and it
  // loses the one sentence GitHub bothered to send. Looked at first, so the
  // person reads "bad_verification_code: expired" and not "no access token".
  /** @type {any} */
  const peek = await response.clone().json().catch(() => null);
  if (peek && typeof peek === 'object' && peek.error) {
    return { ok: false, message: `${label} refused the authorization: ${peek.error_description || peek.error}` };
  }

  try {
    const tokens = await oauth.processAuthorizationCodeResponse(as, client, response);
    return {
      ok: true,
      accessToken: tokens.access_token,
      // GitHub sends one only when "Expire user authorization tokens" is on;
      // Cloudflare only when the authorize request carried `offline_access`
      // and the client has the grant. Absent is a fact the caller says to the
      // person — an access token that never expires is the PAT problem with
      // extra steps — rather than an error here.
      refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null,
      expiresIn: Number(tokens.expires_in) || null,
    };
  } catch (e) {
    return { ok: false, message: `${label} ${describeRefusal(/** @type {any} */ (e))}` };
  }
}

/**
 * The library's error, as the sentence the person reads.
 *
 * Three shapes: the provider said no (a body with `error`), the provider
 * answered something that is not a token response (a 200 with no token in it,
 * a wrong content type), or a `WWW-Authenticate` challenge. Each gets the one
 * thing an operator can act on.
 *
 * @param {{ error?: string, error_description?: string, message?: string, status?: number, cause?: any }} e
 */
function describeRefusal(e) {
  if (e instanceof oauth.ResponseBodyError) {
    return `refused the authorization: ${e.error_description || e.error}`;
  }
  if (e instanceof oauth.WWWAuthenticateChallengeError) {
    const first = e.cause?.[0];
    return `refused the authorization: ${first?.parameters?.error_description || first?.parameters?.error || first?.scheme || 'challenge'}`;
  }
  if (/access_token/.test(String(e.message))) return 'returned no access token.';
  return `refused the authorization: ${e.message || 'no reason given'}`;
}

/**
 * Exchange a GitHub code for tokens.
 *
 * @param {{ clientId: string, clientSecret: string, code: string, origin: string, codeVerifier?: string|null, fetch?: typeof globalThis.fetch }} args
 * @returns {Promise<{ ok: true, accessToken: string, refreshToken: string|null, expiresIn: number|null } | { ok: false, message: string }>}
 */
export async function exchangeCode({ clientId, clientSecret, code, origin, codeVerifier = null, fetch: doFetch = globalThis.fetch }) {
  const base = normaliseOrigin(origin);
  if (!base) return { ok: false, message: 'This coordinator could not work out its own address.' };
  return exchange({ as: GITHUB, label: 'GitHub', clientId, clientSecret, code, redirectUri: `${base}/oauth/github/callback`, codeVerifier, fetch: doFetch });
}

/**
 * Exchange a Cloudflare authorization code for tokens.
 *
 * Same function as GitHub's with a different server document, which is what a
 * library buys: the two token endpoints used to disagree about everything
 * except the grant, and each disagreement was a parameter or a second
 * function. The redirect URI must byte-match the authorize request's, or the
 * exchange is refused — which is the property the redirect binding depends on.
 *
 * @param {{ clientId: string, clientSecret: string, code: string, origin: string, codeVerifier?: string|null, fetch?: typeof globalThis.fetch }} args
 * @returns {Promise<{ ok: true, accessToken: string, refreshToken: string|null, expiresIn: number|null } | { ok: false, message: string }>}
 */
export async function exchangeCloudflareCode({ clientId, clientSecret, code, origin, codeVerifier = null, fetch: doFetch = globalThis.fetch }) {
  const base = normaliseOrigin(origin);
  if (!base) return { ok: false, message: 'This coordinator could not work out its own address.' };
  return exchange({ as: CLOUDFLARE, label: 'Cloudflare', clientId, clientSecret, code, redirectUri: `${base}/oauth/cloudflare/callback`, codeVerifier, fetch: doFetch });
}

/**
 * The page a browser lands on afterwards.
 *
 * Deliberately plain and self-closing in tone: the person is in a browser they
 * opened from an app, and the useful thing is to tell them it worked and that
 * they can go back. No styling, no script, nothing to load — this is served by
 * the coordinator and must not become a page that fetches anything.
 *
 * @param {{ ok: boolean, text: string }} result
 */
/**
 * The scheme both apps register, so the browser can hand control back.
 *
 * A person who taps Connect leaves the app, authorizes, and lands on a page
 * telling them to close it — which is a tab they have to notice, and a return
 * they have to perform. Redirecting finishes the job the flow started.
 *
 * Deliberately a fixed literal rather than anything the request can influence:
 * a redirect target that a query parameter could steer is an open redirect,
 * and this page is reached by following a link from GitHub.
 */
const APP_SCHEME = 'fleetwright://connected';

/** @param {{ ok: boolean, provider?: string }} result */
export function appReturnUrl({ ok, provider = 'github' }) {
  // Only two values, both ours. Nothing from the request reaches this.
  return `${APP_SCHEME}?provider=${encodeURIComponent(provider)}&ok=${ok ? '1' : '0'}`;
}

/**
 * A GitHub sign-in a DEVICE started: the phone made the state and the PKCE
 * verifier itself, and only it can finish the exchange, through the minting
 * Worker, which holds the App's client secret (src/fleet/minter/github.js).
 *
 * The prefix is how the callback tells one from a box's, which the coordinator
 * minted and stored. A device's is never stored here: there is nothing to look
 * up, because all the coordinator does with it is hand the code straight back
 * to the app, and the code is worthless without the verifier that never left
 * the phone. The app checks the state is the one it made.
 */
export const DEVICE_STATE_RE = /^d\.[A-Za-z0-9_-]{22,128}$/;

/** What an authorization code looks like, as far as this will pass one on. Cloudflare's carry dots. */
const CODE_RE = /^[A-Za-z0-9._-]{8,256}$/;

/**
 * Where a device's sign-in goes back to: the app, with the code and its own
 * state, and nothing from the request but those two values, each checked
 * against its shape and percent-encoded. The scheme and path are fixed here,
 * so this cannot be steered anywhere else.
 *
 * @param {{ code: unknown, state: unknown, provider?: 'github'|'cloudflare' }} q
 * @returns {string|null}  null when either does not look like one
 */
export function deviceReturnUrl({ code, state, provider = 'github' }) {
  const c = String(code ?? '');
  const st = String(state ?? '');
  if (!CODE_RE.test(c) || !DEVICE_STATE_RE.test(st)) return null;
  // The host part says which provider came back, from a fixed pair, so a
  // phone waiting for one sign-in cannot be handed the other's code.
  const host = provider === 'cloudflare' ? 'cloudflare' : 'github';
  return `fleetwright://${host}?code=${encodeURIComponent(c)}&state=${encodeURIComponent(st)}`;
}

/**
 * The page a browser lands on afterwards.
 *
 * `provider` picks the heading and travels on the return URL. From a fixed
 * two-value vocabulary, never from the request — the words on this page and
 * the scheme it redirects to must not be steerable by whoever crafted the URL.
 *
 * @param {{ ok: boolean, text: string, installed?: boolean, provider?: string, device?: string|null }} result
 */
export function callbackPage({ ok, text, installed, provider = 'github', device = null }) {
  const which = provider === 'cloudflare' ? 'cloudflare' : 'github';
  const label = which === 'cloudflare' ? 'Cloudflare' : 'GitHub';
  const safe = String(text).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] || c);
  // A device's sign-in goes back with its code; everything else with a yes or no.
  const back = device || appReturnUrl({ ok, provider: which });
  // The redirect is attempted immediately AND offered as a link. A custom
  // scheme fails silently when the app is not installed — on a desktop
  // browser, or in a private window — so the page has to work on its own
  // afterwards rather than being a blank screen that redirected nowhere.
  //
  // EXCEPT AFTER AN INSTALLATION, which is the one outcome with something left
  // to do. Bouncing straight back into the app would hide the sentence saying
  // the account is not connected yet, and the app has no way to know it should
  // say it — the install did not come from there, so nothing was waiting for an
  // answer. The person reads it or nobody does.
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${installed ? 'App installed' : ok ? 'Connected' : 'Not connected'}</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem}
a.back{display:inline-block;margin-top:1rem}</style>
<h1>${installed ? 'GitHub App installed' : ok ? `${label} connected` : 'Not connected'}</h1>
<p>${safe}</p>
<p><a class="back" href="${back}">Back to Fleetwright</a></p>
${installed ? '' : `<script>location.replace(${JSON.stringify(back)})</script>`}`;
}

/**
 * What a person is told once a provider is connected.
 *
 * One function for both places an exchange can finish — the coordinator, or a
 * host that minted a PKCE verifier — because the sentence carries a promise
 * ("renews it by itself") that has to mean the same thing wherever it was
 * decided. Honest about the hours rather than quiet about them, and honest
 * about which of the two situations this is: a token that stops working
 * tomorrow, from a screen that said "connected", is worse than one that said
 * so.
 *
 * @param {{ label: string, expiresIn: number|null|undefined, renewable: boolean }} args
 */
export function connectedText({ label, expiresIn, renewable }) {
  if (!expiresIn) return `Your sessions can use ${label} now.`;
  const hours = Math.round(expiresIn / 3600);
  return renewable
    ? `Your sessions can use ${label} now. The token lasts ${hours} hours and that machine renews it by itself from here on.`
    : `Your sessions can use ${label} now. This token lasts ${hours} hours, and that machine could not store what it ` +
      'needs to renew it — connect again when it expires.';
}
