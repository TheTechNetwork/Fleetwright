// OAuth 2.1 for the remote MCP endpoint, delegating identity to Apple and Google.
//
// WHY THERE IS AN AUTHORIZATION SERVER HERE AT ALL, when the coordinator already
// turns an Apple or Google ID token into a device credential: because a CLIENT
// cannot do that. `/api/session` is for an app that has already run Sign in with
// Apple itself and holds an ID token. An MCP client has no relationship with
// Apple, does not know this fleet exists until it is pointed at it, and cannot
// be given a credential except by a person copying one. OAuth is the standard
// way to say "send them to a page, and give me back a token" — and following it
// is what makes this reachable from a client nobody has configured.
//
// APPLE AND GOOGLE STAY THE IDENTITY. Nothing here decides who anybody is: the
// authorize page runs their sign-in, `verifyIdToken` checks the result against
// the same issuers and audiences the apps use, and the same two allowlists
// decide admission. This layer only carries that answer to a client in the
// shape a client understands.
//
// WHAT AN ACCESS TOKEN IS: a device credential. The same `fwk_…` an app gets,
// from the same registry, revocable in the same list. A remote MCP client is
// one more device belonging to a person — which is the whole reason the
// visibility rules already work for it.

// WebCrypto directly, rather than the coordinator's helpers. `hashSecret` there
// returns HEX; PKCE requires BASE64URL, and reusing it would reject every valid
// verifier — a mistake that looks like a client bug from both ends.

/** How long an authorization code lives. Short: it is exchanged immediately. */
export const CODE_TTL_MS = 5 * 60_000;

/**
 * The protected-resource document.
 *
 * A client that gets a 401 from `/mcp` reads `WWW-Authenticate`, fetches this,
 * and learns which authorization server to talk to. It is the entry point to
 * everything below, and the reason a client needs no configuration beyond a URL.
 *
 * @param {string} origin
 */
export function protectedResourceMetadata(origin) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: ['fleet'],
  };
}

/**
 * The authorization-server document.
 *
 * `registration_endpoint` is not optional in practice. A client that has never
 * seen this fleet has no client_id and no way to be given one by hand — dynamic
 * registration is what makes "paste a URL" the whole setup.
 *
 * @param {string} origin
 */
export function authorizationServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    // PKCE ONLY, and S256 only. A public client without it is an authorization
    // code anybody who can see the redirect can spend.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['fleet'],
  };
}

/**
 * Pending authorizations: one per person who has started signing in.
 *
 * Deliberately not persisted. A code lives five minutes and is spent once; a
 * coordinator that restarts mid-sign-in costs somebody one retry, and keeping
 * them at rest would mean a store of live credentials-in-waiting for no gain.
 */
export class Authorizations {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, { email: string, name: string|null, clientId: string, redirectUri: string, challenge: string, expiresAt: number }>} */
    this.codes = new Map();
    /** @type {Map<string, { redirectUris: string[], name: string }>} */
    this.clients = new Map();
  }

  /**
   * Register a client that has never been seen.
   *
   * RFC 7591, and open by design: registration grants nothing. The client_id it
   * returns cannot read anything, cannot start anything, and is useless without
   * a person completing a sign-in against an allowlist. Refusing to register is
   * refusing to be discoverable, which is the one thing this endpoint is for.
   *
   * @param {{ redirect_uris?: string[], client_name?: string }} request
   * @returns {{ ok: true, clientId: string, redirectUris: string[] } | { ok: false, error: string }}
   */
  register(request) {
    const redirectUris = (request?.redirect_uris || []).map(String).filter(Boolean);
    if (!redirectUris.length) return { ok: false, error: 'invalid_redirect_uri' };
    // Every redirect must be something a browser can be sent back to safely.
    for (const uri of redirectUris) {
      if (!isSafeRedirect(uri)) return { ok: false, error: 'invalid_redirect_uri' };
    }
    const clientId = `mcp_${randomHex(16)}`;
    this.clients.set(clientId, { redirectUris, name: String(request?.client_name || 'an MCP client').slice(0, 80) });
    return { ok: true, clientId, redirectUris };
  }

  /**
   * Start an authorization: the person has signed in and been allowed.
   *
   * @param {{ email: string, name?: string|null, clientId: string, redirectUri: string, challenge: string }} spec
   * @returns {{ ok: true, code: string } | { ok: false, error: string }}
   */
  issueCode({ email, name = null, clientId, redirectUri, challenge }) {
    const client = this.clients.get(clientId);
    // THE REDIRECT IS CHECKED AGAINST WHAT WAS REGISTERED, not merely for
    // being a URL. Without this, anybody who knows a client_id can send the
    // code to themselves.
    if (!client || !client.redirectUris.includes(redirectUri)) return { ok: false, error: 'invalid_redirect_uri' };
    if (!challenge) return { ok: false, error: 'invalid_request' };
    const code = randomHex(24);
    this.codes.set(code, { email, name, clientId, redirectUri, challenge, expiresAt: this.now() + CODE_TTL_MS });
    return { ok: true, code };
  }

  /**
   * Spend a code.
   *
   * SINGLE USE, and deleted before anything else can fail — a code that
   * survives a failed exchange is one somebody can retry.
   *
   * @param {{ code: string, clientId: string, redirectUri: string, verifier: string }} spec
   * @returns {Promise<{ ok: true, email: string, name: string|null } | { ok: false, error: string }>}
   */
  async redeem({ code, clientId, redirectUri, verifier }) {
    const entry = this.codes.get(code);
    this.codes.delete(code);
    if (!entry) return { ok: false, error: 'invalid_grant' };
    if (entry.expiresAt < this.now()) return { ok: false, error: 'invalid_grant' };
    if (entry.clientId !== clientId || entry.redirectUri !== redirectUri) return { ok: false, error: 'invalid_grant' };
    // PKCE. The verifier proves the caller is the one that started the flow,
    // which is what stops a stolen code being spent by whoever stole it.
    const expected = await s256(verifier);
    if (expected !== entry.challenge) return { ok: false, error: 'invalid_grant' };
    return { ok: true, email: entry.email, name: entry.name };
  }

  /** Drop what has expired. Called on write, so it needs no timer. */
  sweep() {
    const now = this.now();
    for (const [code, entry] of this.codes) if (entry.expiresAt < now) this.codes.delete(code);
  }
}

/**
 * A redirect a browser may be sent to.
 *
 * `http://127.0.0.1:<port>/…` is how every local client receives a code, and
 * refusing it would refuse the ordinary case. Anything else must be https —
 * an authorization code on a cleartext hop is one anybody on the path can read,
 * which is SEC-NET-1 in another costume.
 *
 * @param {string} uri
 */
export function isSafeRedirect(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  // A custom scheme, which is how a desktop app receives one. No host to
  // reason about, so the registration is the only check there can be.
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && url.protocol !== 'javascript:' && url.protocol !== 'data:';
}

/**
 * The PKCE challenge for a verifier: base64url(SHA-256(verifier)), unpadded.
 *
 * RFC 7636 is specific about the encoding, and hex — which is what this
 * repository's other hash helper returns — would never match a client's
 * challenge. The failure would look like a wrong verifier from both ends.
 *
 * @param {string} verifier
 */
export async function s256(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(verifier || '')));
  return base64url(new Uint8Array(digest));
}

/** @param {Uint8Array} bytes */
function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {number} n */
function randomHex(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
