// Verifying an identity token from somebody else's identity provider.
//
// The coordinator has no accounts. It reads an OIDC ID token, checks it, and
// decides whether the email in it is on a list — see docs/identity.md for why
// it is not more than that.
//
// VERIFICATION IS `jose`, NOT OURS. This file hand-rolled it first, and the
// hand-rolled version was defensible — two algorithms, every claim checked,
// tests for alg:none and for a tampered payload. It still went. JWT
// verification is the canonical place where being nearly right has produced
// CVEs for a decade, and the failure mode is silent acceptance rather than a
// crash, which is the worst kind of thing to be nearly right about.
//
// jose was audited before it was taken: zero dependencies, MIT, ~100M downloads
// a week, written by an author of the specifications it implements, and built
// on WebCrypto so it runs in a Worker unchanged. Single-maintainer risk is real
// and is why the version is pinned rather than floated.
//
// What stays here is the part that is not cryptography: which issuers count,
// which addresses are allowed, and what to say when Apple hides one.

import { jwtVerify, createRemoteJWKSet } from 'jose';

/** Providers whose key set is not at the conventional well-known path. */
const JWKS_URLS = {
  'https://accounts.google.com': 'https://www.googleapis.com/oauth2/v3/certs',
  'https://appleid.apple.com': 'https://appleid.apple.com/auth/keys',
};

/** @type {Map<string, any>} */
const jwks = new Map();

/**
 * The key set for an issuer.
 *
 * jose handles rotation, cooldowns and concurrent misses inside this object,
 * which is most of why it is worth having: a `kid` that misses refetches once
 * rather than once per request, and a provider rotating keys does not become an
 * outage.
 *
 * @param {string} issuer
 */
function keysFor(issuer) {
  let set = jwks.get(issuer);
  if (!set) {
    const url =
      JWKS_URLS[/** @type {keyof typeof JWKS_URLS} */ (issuer)] ||
      `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
    set = createRemoteJWKSet(new URL(url), { cacheMaxAge: 3_600_000, cooldownDuration: 30_000 });
    jwks.set(issuer, set);
  }
  return set;
}

/**
 * Verify an ID token and return the identity in it.
 *
 * Throws with a reason rather than returning null: every failure here is
 * something an operator may need to act on — a misconfigured audience, an
 * issuer nobody allowed, a clock — and "sign-in failed" tells them none of it.
 *
 * @param {string} token
 * @param {{ issuers: string[], audiences: string[] }} opts
 * @returns {Promise<{ email: string, sub: string, name: string|null, issuer: string }>}
 */
export async function verifyIdToken(token, { issuers, audiences }) {
  const raw = String(token || '');
  const parts = raw.split('.');
  if (parts.length !== 3) throw new Error('not a JWT');

  // THE ISSUER IS CHECKED BEFORE ANY KEY IS FETCHED, and that ordering is the
  // whole security of this function. jose checks `iss` too — but only after
  // fetching the key named in the token's header. A token naming an attacker's
  // issuer would therefore send the coordinator off to fetch that attacker's
  // keys, and the signature would verify perfectly against them.
  let unverified;
  try {
    unverified = JSON.parse(new TextDecoder().decode(fromB64Url(parts[1])));
  } catch {
    throw new Error('not a JWT');
  }
  const issuer = String(unverified?.iss || '');
  if (!issuers.includes(issuer)) throw new Error(`issuer ${issuer || '(none)'} is not configured`);

  let payload;
  try {
    ({ payload } = await jwtVerify(raw, keysFor(issuer), {
      issuer,
      audience: audiences,
      // Named explicitly. Left open, `alg` is chosen by the token, which is
      // how algorithm confusion works.
      algorithms: ['RS256', 'ES256'],
      clockTolerance: 60,
    }));
  } catch (e) {
    throw new Error(reasonFor(/** @type {any} */ (e)));
  }

  const email = String(payload.email || '').toLowerCase();
  if (!email) throw new Error('the token carries no email, so there is nothing to check against the allowlist');
  // Providers send this as a boolean or the string "true", depending on the
  // provider and the decade.
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new Error(`${email} is not verified with ${issuer}`);
  }

  return { email, sub: String(payload.sub || ''), name: payload.name ? String(payload.name) : null, issuer };
}

/**
 * jose's error codes, as something an operator can act on. Its own messages are
 * accurate and terse; these say what to do next.
 *
 * @param {{ code?: string, message?: string }} e
 */
function reasonFor(e) {
  switch (e.code) {
    case 'ERR_JWT_EXPIRED':
      return 'the token has expired — sign in again';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      return `this token was issued for a different application (${e.message})`;
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return 'the signature does not verify';
    case 'ERR_JWKS_NO_MATCHING_KEY':
      return 'the issuer has no such signing key — the token may be from a different provider';
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return `unsupported algorithm (${e.message})`;
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
      return 'the issuer published more than one matching key';
    default:
      return String(e.message || 'the token could not be verified');
  }
}

/** @param {string} s */
function fromB64Url(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Is this address allowed in?
 *
 * Entries are either a whole address or `@domain`. Empty allows NOBODY, which
 * is the right default for something that grants control of every machine in a
 * fleet — a coordinator that has not been told who is allowed should refuse
 * everyone rather than everyone.
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

/** Visible for tests. */
export function forgetJwks() {
  jwks.clear();
}
