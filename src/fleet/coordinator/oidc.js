// Verifying an identity token from somebody else's identity provider.
//
// The coordinator does not have accounts. It reads an OIDC ID token, checks
// the signature against the issuer's published keys, and decides whether the
// email in it is on a list. That is the whole of "sign in" here — see
// docs/identity.md for why it is not more than that.
//
// PORTABLE, like everything else in this directory: fetch and WebCrypto, so it
// runs unchanged in a Worker and on a box. No JWT library, which would be a
// dependency carried for what is mostly base64 and one crypto.subtle.verify.
//
// Writing signature verification by hand is usually a mistake. It is not one
// here for a narrow reason: the hard parts of a JWT library are the algorithm
// zoo and the ways to be talked out of checking things. This accepts two
// algorithms, requires every claim it depends on, and refuses anything it does
// not recognise — which is a smaller surface than the configuration needed to
// make a library do the same.

const ALLOWED_ALGS = new Set(['RS256', 'ES256']);
const JWKS_TTL_MS = 60 * 60_000;

/** @type {Map<string, { keys: any[], at: number }>} */
const jwksCache = new Map();

/** @param {string} s */
function b64urlToBytes(s) {
  const binary = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** @param {string} s */
function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

/**
 * The issuer's signing keys.
 *
 * Cached for an hour: providers rotate keys on the order of days and a fetch
 * per sign-in would make every login depend on Google being reachable at that
 * instant. A `kid` that misses the cache refetches once, which is what makes
 * rotation self-healing rather than an outage.
 *
 * @param {string} issuer
 * @param {string} kid
 * @param {typeof fetch} fetchImpl
 * @param {() => number} now
 */
async function keyFor(issuer, kid, fetchImpl, now) {
  const cached = jwksCache.get(issuer);
  const fresh = cached && now() - cached.at < JWKS_TTL_MS;
  if (fresh) {
    const hit = cached.keys.find((k) => k.kid === kid);
    if (hit) return hit;
  }

  // Discovery rather than a hardcoded JWKS URL, so adding an issuer is one
  // configuration entry rather than two.
  const discovery = await fetchImpl(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!discovery.ok) throw new Error(`could not read ${issuer} discovery: ${discovery.status}`);
  const { jwks_uri: jwksUri } = /** @type {any} */ (await discovery.json());
  if (!jwksUri) throw new Error(`${issuer} published no jwks_uri`);

  const res = await fetchImpl(jwksUri);
  if (!res.ok) throw new Error(`could not read ${issuer} keys: ${res.status}`);
  const { keys } = /** @type {any} */ (await res.json());
  jwksCache.set(issuer, { keys: keys || [], at: now() });

  const key = (keys || []).find((/** @type {any} */ k) => k.kid === kid);
  if (!key) throw new Error(`${issuer} has no key ${kid}`);
  return key;
}

/** @param {any} jwk @param {string} alg */
function importParams(jwk, alg) {
  return alg === 'ES256'
    ? { name: 'ECDSA', namedCurve: 'P-256' }
    : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
}

/** @param {string} alg */
function verifyParams(alg) {
  return alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
}

/**
 * Verify an ID token and return the identity in it.
 *
 * Throws with a reason rather than returning null: every failure here is
 * something an operator may need to act on — a misconfigured audience, an
 * issuer nobody allowed, a clock — and "sign-in failed" tells them none of it.
 *
 * @param {string} token
 * @param {{ issuers: string[], audiences: string[], now?: () => number, fetchImpl?: typeof fetch, skewSec?: number }} opts
 * @returns {Promise<{ email: string, sub: string, name: string|null, issuer: string }>}
 */
export async function verifyIdToken(token, { issuers, audiences, now = () => Date.now(), fetchImpl, skewSec = 60 }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  const [rawHeader, rawClaims, rawSignature] = parts;

  const header = b64urlToJson(rawHeader);
  if (!ALLOWED_ALGS.has(header.alg)) throw new Error(`unsupported algorithm ${header.alg}`);
  if (!header.kid) throw new Error('no key id in the token header');

  const claims = b64urlToJson(rawClaims);

  // Issuer BEFORE fetching anything. Otherwise a token naming an attacker's
  // issuer makes the coordinator go and fetch that attacker's keys, and the
  // signature check then passes against them.
  const issuer = String(claims.iss || '');
  if (!issuers.includes(issuer)) throw new Error(`issuer ${issuer || '(none)'} is not configured`);

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((/** @type {unknown} */ a) => audiences.includes(String(a)))) {
    throw new Error('this token was issued for a different application');
  }

  const seconds = Math.floor(now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + skewSec < seconds) throw new Error('the token has expired');
  if (typeof claims.nbf === 'number' && claims.nbf - skewSec > seconds) throw new Error('the token is not valid yet');

  const jwk = await keyFor(issuer, header.kid, doFetch, now);
  const key = await crypto.subtle.importKey('jwk', jwk, importParams(jwk, header.alg), false, ['verify']);
  const ok = await crypto.subtle.verify(
    verifyParams(header.alg),
    key,
    b64urlToBytes(rawSignature),
    new TextEncoder().encode(`${rawHeader}.${rawClaims}`),
  );
  if (!ok) throw new Error('the signature does not verify');

  const email = String(claims.email || '').toLowerCase();
  if (!email) throw new Error('the token carries no email, so there is nothing to check against the allowlist');
  // Providers send this as a boolean or the string "true" depending on the
  // provider and the decade.
  if (claims.email_verified !== true && claims.email_verified !== 'true') {
    throw new Error(`${email} is not verified with ${issuer}`);
  }

  return { email, sub: String(claims.sub || ''), name: claims.name ? String(claims.name) : null, issuer };
}

/**
 * Is this address allowed in?
 *
 * Entries are either a whole address or `@domain`. Empty allows nobody, which
 * is the right default for something that grants control of every machine in a
 * fleet — a coordinator with no list configured should refuse everyone rather
 * than everyone.
 *
 * @param {string} email
 * @param {string[]} allow
 */
export function isAllowed(email, allow) {
  const address = String(email || '').toLowerCase().trim();
  if (!address.includes('@')) return false;
  const domain = address.slice(address.lastIndexOf('@'));

  return (allow || []).some((entry) => {
    const rule = String(entry || '').toLowerCase().trim();
    if (!rule) return false;
    return rule.startsWith('@') ? rule === domain : rule === address;
  });
}

/**
 * Apple's Hide My Email produces a real, stable address that can never match a
 * company domain. Refusing it as "not on the list" would send somebody to ask
 * why they are missing from a list they are on.
 *
 * @param {string} email
 */
export function isPrivateRelay(email) {
  return /@privaterelay\.appleid\.com$/i.test(String(email || ''));
}

/** Visible for tests: key rotation is otherwise untestable without waiting an hour. */
export function forgetJwks() {
  jwksCache.clear();
}
