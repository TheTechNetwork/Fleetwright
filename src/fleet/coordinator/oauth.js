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
 * How many flows one person may have waiting in one provider's store.
 *
 * PER PERSON, because the store is the whole fleet's. It used to have only
 * the aggregate bound above, evicting the oldest entry whoever's it was, and
 * every connect reply with a catalogue minted a state — so one member with a
 * box that answers `connect` sent two hundred of them and every other
 * person's sign-in, half-way through GitHub's consent page, came back
 * "expired". Now a person's new flow makes room by retiring their OWN oldest,
 * and when the store is full of other people's live flows the new one is
 * refused (no offer; the paste route still works) rather than evicting theirs.
 *
 * NOT ONE, though one would be the tidy number. The screen a flow starts on
 * asks for the catalogue again when the app comes back to the front — Android
 * reloads on resume, which is the same moment the provider hands the code
 * back — and with a single slot that reload would replace the state the
 * person was in the middle of a moment before they finish with it. A few
 * slots keep the flow they started alive through their own refreshes and
 * still bound what one person can hold to a rounding error of the whole.
 */
const MAX_PENDING_PER_PERSON = 4;

/**
 * Whose a flow is, as one comparable string. The admin token's flows carry no
 * email and share the empty key, which no signed-in person can have.
 * @param {string|null|undefined} email
 */
const whoseFlow = (email) => (email ? String(email).trim().toLowerCase() : '');

/**
 * A pending authorization, and what it does and does not prove.
 *
 * `state` ties a request back to a flow this coordinator started. It has to be:
 *
 *  - **unguessable** — a uuid, not a counter
 *  - **single-use** — redeemed exactly once, so a replayed finish is refused
 *  - **short-lived** — ten minutes is longer than anybody takes and shorter
 *    than a link left open in a tab
 *  - **bound to both the host and the person who started it**, so the token
 *    that comes back can only be delivered where the flow started and stored
 *    under the identity that asked
 *
 * WHAT IT DOES NOT PROVE is who finished it. The state is in the authorize
 * URL, the authorize URL is a link, and a link can be forwarded: a member
 * kept the github.com page from their own Connect, sent it to somebody else,
 * and when that person authorized, the callback — which took no credential
 * and checked only that the state was live — exchanged THEIR code and filed
 * the token under the member who started it, on a box that member had root
 * on. So a flow is now redeemed only by the person who started it, proved by
 * their own fleet credential on an authenticated request (`redeem`'s
 * `requester`), and the provider's redirect only hands the code back to the
 * app or page that holds one. See finishGithubAuthorization in core.js.
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
   * @returns {string|null} the state, or null when the store is full of other
   *   people's live flows and this one was not kept — the caller makes no offer
   */
  mint({ state, hostId, email, pkce = false, relayed = false }) {
    this.sweep();
    const who = whoseFlow(email);
    // Their own oldest first, so a person's fresh attempt displaces only their
    // stale ones. Map order is insertion order, which is oldest first.
    const theirs = [];
    for (const [s, rec] of this.pending) if (whoseFlow(rec.email) === who) theirs.push(s);
    while (theirs.length >= MAX_PENDING_PER_PERSON) this.pending.delete(/** @type {string} */ (theirs.shift()));
    // NEVER SOMEBODY ELSE'S. Refusing costs this person the sign-in offer on
    // one reply; evicting would cost another person the flow they are in.
    if (this.pending.size >= MAX_PENDING) return null;
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
   * Redeem once, for the person who started it. Returns the flow, or null for
   * unknown, expired, replayed, or somebody else's.
   *
   * `requester` is the VERIFIED caller finishing it, from its fleet
   * credential: null is the admin token, which finishes only a flow the admin
   * token started. Omitted is not null — a caller that forgot to pass one is
   * refused, because reading a missing requester as "anybody" is the
   * fail-open direction.
   *
   * SOMEBODY ELSE'S IS LEFT PENDING. Spending it would let whoever holds a
   * forwarded link cancel the starter's flow; leaving it lets the starter
   * still finish, and they are the only one who can.
   *
   * @param {unknown} state
   * @param {{ email?: string|null, admin?: boolean }|null|undefined} requester
   */
  redeem(state, requester) {
    this.sweep();
    const key = typeof state === 'string' ? state : '';
    const found = this.pending.get(key);
    if (!found || requester === undefined) return null;
    const starter = whoseFlow(found.email);
    const ok = requester === null ? starter === '' : starter !== '' && whoseFlow(requester.email) === starter;
    if (!ok) return null;
    // Deleted before the caller does anything with it: a finish that arrives
    // twice, or is replayed, must not exchange a second time.
    this.pending.delete(key);
    return found;
  }

  /**
   * Whether a state is live — after a refused `redeem`, the difference between
   * "expired or used" and "started by somebody else", which only a caller
   * holding the state and a fleet credential is ever told.
   * @param {unknown} state
   */
  isPending(state) {
    this.sweep();
    return typeof state === 'string' && this.pending.has(state);
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
 * THE RELAY'S PAGE, NOT GITHUB'S. The relay names this coordinator to the
 * person and then sends them to GitHub with its own client id and its own
 * `redirect_uri`, which is on the App's registered list where this
 * coordinator's never will be. It finishes only a sign-in started on that
 * page, because registering a fleet is open and a github.com link naming a
 * stranger's fleet would otherwise send somebody's token to the stranger.
 * The state is `<fleet>.<state>`: the fleet tells the relay where to send the
 * person back, and the rest is this coordinator's own, redeemed once here.
 *
 * @param {{ relay: string, fleet: string, state: string }} args
 */
export function relayAuthorizeUrl({ relay, fleet, state }) {
  const base = normaliseOrigin(relay);
  if (!base) return null;
  const url = new URL(`${base}/relay/v1/github/start`);
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
 * A sign-in the browser's signing page started (src/fleet/minter/sign-page.js),
 * on the minter's own hostname. The same arrangement as a device's: the page
 * made the state and holds the PKCE verifier, nothing is stored here, and the
 * code goes back to the page, which finishes the exchange through the minter.
 * Its own prefix because it goes back to a different place: the signing
 * origin this coordinator was configured with, never one from the request.
 */
export const SIGNER_STATE_RE = /^s\.[A-Za-z0-9_-]{22,128}$/;

/**
 * Where a signing page's sign-in goes back to: that page's callback for the
 * provider on the configured signing origin, with the code and the state, each
 * checked against its shape and percent-encoded. GitHub to list the browser
 * and open the vault, and either provider to keep a sign-in in it.
 *
 * @param {{ code: unknown, state: unknown, signingOrigin: string|null, provider?: 'github'|'cloudflare' }} q
 * @returns {string|null}  null when either does not look like one, or there is no signing page
 */
export function signerReturnUrl({ code, state, signingOrigin, provider = 'github' }) {
  const c = String(code ?? '');
  const st = String(state ?? '');
  const base = normaliseOrigin(signingOrigin);
  if (!base || !base.startsWith('https://') || !CODE_RE.test(c) || !SIGNER_STATE_RE.test(st)) return null;
  return `${base}/oauth/${provider === 'cloudflare' ? 'cloudflare' : 'github'}/callback?code=${encodeURIComponent(c)}&state=${encodeURIComponent(st)}`;
}

/** What a state this coordinator minted looks like (a uuid), as far as a page will carry one. */
const BOX_STATE_RE = /^[A-Za-z0-9-]{16,64}$/;

/** What the relay's sealed token looks like: base64url, and never larger than a page should carry. */
const SEALED_RE = /^[A-Za-z0-9_-]{16,4096}$/;

/**
 * Where the browser's fleet credential lives on this origin. The `/me` page
 * writes it (member-page.js); the finishing page below reads it. One name in
 * one place, because a page that looked under a different key would quietly
 * fall back to the app every time.
 */
export const BROWSER_CREDENTIAL_KEY = 'fleetwright.credential';

/**
 * Where `/me` leaves the delegation its signing page signed for one
 * provider's sign-in, `<this><provider>`, for the finishing page below to
 * carry with the finish and then forget. Without one the finish goes as it
 * did, unsigned, which a box that takes only signed requests refuses.
 */
export const FINISH_DELEGATION_KEY = 'fleetwright.finish.';

/**
 * What the provider's redirect hands back for a box's flow, checked and
 * fixed in shape: the provider, the state, and the code (or the relay's
 * sealed token). Nothing else from the request reaches the page.
 *
 * @param {{ provider: 'github'|'cloudflare', state: unknown, code?: unknown, sealed?: unknown }} q
 * @returns {{ provider: 'github'|'cloudflare', state: string, code?: string, sealed?: string }|null}
 */
export function handBack({ provider, state, code, sealed }) {
  const which = provider === 'cloudflare' ? 'cloudflare' : 'github';
  const st = String(state ?? '');
  if (!BOX_STATE_RE.test(st)) return null;
  if (sealed !== undefined && sealed !== null) {
    const s = String(sealed);
    return which === 'github' && SEALED_RE.test(s) ? { provider: which, state: st, sealed: s } : null;
  }
  const c = String(code ?? '');
  return CODE_RE.test(c) ? { provider: which, state: st, code: c } : null;
}

/**
 * The same, as the app's own return: `fleetwright://<provider>?…`, the hosts
 * a device's sign-in already comes back on, so neither app needs a new scheme
 * registered. A device's state starts `d.` and a box's never does, which is
 * how the screen waiting for each tells them apart.
 *
 * @param {{ provider: 'github'|'cloudflare', state: string, code?: string, sealed?: string }} finish  from handBack
 */
export function handBackUrl(finish) {
  const query = new URLSearchParams({ state: finish.state, ...(finish.sealed ? { sealed: finish.sealed } : { code: /** @type {string} */ (finish.code) }) });
  return `fleetwright://${finish.provider === 'cloudflare' ? 'cloudflare' : 'github'}?${query}`;
}

/** JSON for inside a `<script>` element: a `</script>` in a value would close it. @param {unknown} value */
const scriptJson = (value) =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** One stylesheet for both pages, inline: they load nothing. */
const PAGE_STYLE = 'body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem}\na.back{display:inline-block;margin-top:1rem}';

/**
 * The page a browser lands on afterwards.
 *
 * `provider` picks the heading and travels on the return URL. From a fixed
 * two-value vocabulary, never from the request — the words on this page and
 * the scheme it redirects to must not be steerable by whoever crafted the URL.
 *
 * `finish` is a box's flow coming back (handBack), and that page connects
 * nothing by itself; see finishingPage.
 *
 * @param {{ ok: boolean, text: string, installed?: boolean, provider?: string, device?: string|null,
 *   finish?: { provider: 'github'|'cloudflare', state: string, code?: string, sealed?: string }|null }} result
 */
export function callbackPage({ ok, text, installed, provider = 'github', device = null, finish = null }) {
  if (finish) return finishingPage(finish, text);
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
<style>${PAGE_STYLE}</style>
<h1>${installed ? 'GitHub App installed' : ok ? `${label} connected` : 'Not connected'}</h1>
<p>${safe}</p>
<p><a class="back" href="${back}">Back to Fleetwright</a></p>
${installed ? '' : `<script>location.replace(${JSON.stringify(back)})</script>`}`;
}

/**
 * The page a box's flow lands on: it hands the code back, and connects
 * nothing itself.
 *
 * THE BROWSER THAT COMES BACK HERE IS NOT KNOWN TO BE THE PERSON WHO STARTED
 * THE FLOW — a forwarded authorize link brings somebody else's browser, with
 * somebody else's code. So this page only passes what came back to something
 * that holds a fleet credential, which finishes it with POST /api/oauth/finish,
 * and the coordinator finishes only for the person who started it:
 *
 *  - **This origin's own credential**, which `/me` keeps in localStorage, is
 *    the same-origin case: the page posts the finish with it. A browser
 *    signed in as somebody else is told the sign-in was not theirs.
 *  - **The app**, otherwise: the code and state go to `fleetwright://`, where
 *    the screen that opened the provider's page is waiting, and it posts the
 *    finish with its own credential.
 *
 * A browser holding neither — the forwarded link's usual victim — ends here
 * with nothing sent anywhere.
 *
 * NOTHING EXTERNAL, as before: the one request is to this origin.
 *
 * @param {{ provider: 'github'|'cloudflare', state: string, code?: string, sealed?: string }} finish
 * @param {string} text
 */
function finishingPage(finish, text) {
  const label = finish.provider === 'cloudflare' ? 'Cloudflare' : 'GitHub';
  const safe = String(text).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] || c);
  const back = handBackUrl(finish);
  const done = appReturnUrl({ ok: true, provider: finish.provider });
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Finishing</title>
<style>${PAGE_STYLE}</style>
<h1 id="head">Finishing the ${label} connection</h1>
<p id="say" role="status">${safe}</p>
<p><a class="back" href="${back.replace(/&/g, '&amp;')}">Back to Fleetwright</a></p>
<script>
(function () {
  var finish = ${scriptJson(finish)};
  var back = ${scriptJson(back)};
  var token = null;
  var delegation = null;
  try { token = localStorage.getItem(${scriptJson(BROWSER_CREDENTIAL_KEY)}); } catch (e) { token = null; }
  if (!token) { location.replace(back); return; }
  // What this browser's signing page signed for this sign-in, used once.
  try {
    var held = localStorage.getItem(${scriptJson(FINISH_DELEGATION_KEY)} + finish.provider);
    localStorage.removeItem(${scriptJson(FINISH_DELEGATION_KEY)} + finish.provider);
    delegation = held ? JSON.parse(held) : null;
  } catch (e) { delegation = null; }
  var say = document.getElementById('say');
  var body = {};
  for (var k in finish) body[k] = finish[k];
  if (delegation && typeof delegation === 'object') body.delegation = delegation;
  fetch('/api/oauth/finish', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body)
  }).then(function (res) {
    return res.json().then(function (body) { return { status: res.status, body: body || {} }; });
  }).then(function (r) {
    // A credential this fleet no longer accepts is no credential: the app may
    // still hold a good one.
    if (r.status === 401) { location.replace(back); return; }
    say.textContent = r.body.text || (r.body.ok ? 'Connected.' : 'Nothing was connected.');
    document.getElementById('head').textContent = r.body.ok ? ${scriptJson(`${label} connected`)} : 'Not connected';
    // Somebody else's flow, as far as this browser's credential can tell.
    // The words stay on screen, and the app is still offered the code: an app
    // signed in as the person who started it can finish where this cannot.
    if (r.body.error && r.body.error.code === 'not_yours') { location.replace(back); return; }
    if (r.body.ok) location.replace(${scriptJson(done)});
  }, function () {
    location.replace(back);
  });
})();
</script>`;
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
