// Keys, signatures and fingerprints, for everything in the fleet that needs an
// identity rather than a shared password.
//
// ECDSA P-256, and not Ed25519 — which is the nicer algorithm and the wrong
// choice here. Ed25519 is still flagged experimental in Node's WebCrypto and
// prints a warning on use; P-256 is stable in Node, in Workers, in the iOS
// Secure Enclave and in the Android Keystore. That last pair decides it: a
// signature scheme the phones cannot hold in hardware is not a signature
// scheme this design can use, and the enclaves do P-256.
//
// It is also the same family oidc.js already verifies for ES256, so the
// codebase has one curve and one hash rather than a collection.
//
// PORTABLE. WebCrypto and nothing else, so this runs in a Worker, on a box,
// and in tests without a branch.

const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

/** @param {Uint8Array} bytes */
export function toB64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} s */
export function fromB64Url(s) {
  const padded = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * A new identity.
 *
 * Returns JWKs rather than raw keys because they survive being written to a
 * file, put in an env var and read back — which is what a host has to do with
 * one, and what a CryptoKey cannot do.
 */
export async function generateKeyPair() {
  const pair = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const [publicJwk, privateJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', pair.publicKey),
    crypto.subtle.exportKey('jwk', pair.privateKey),
  ]);
  // `d` is the private scalar. Stripping it from the public half is not
  // paranoia — exportKey on a public key never includes it, but these two
  // objects get passed around together and confusing them is the sort of
  // mistake that ships.
  delete publicJwk.d;
  return { publicJwk, privateJwk };
}

/** @param {any} jwk @param {'sign'|'verify'} use */
async function importKey(jwk, use) {
  return crypto.subtle.importKey('jwk', jwk, ALG, false, [use]);
}

/**
 * Sign a message.
 *
 * @param {any} privateJwk
 * @param {string} message
 * @returns {Promise<string>} base64url
 */
export async function sign(privateJwk, message) {
  const key = await importKey(privateJwk, 'sign');
  const sig = await crypto.subtle.sign(SIGN, key, new TextEncoder().encode(message));
  return toB64Url(new Uint8Array(sig));
}

/**
 * Check a signature. False rather than throwing, on anything: a malformed key
 * from a registry and a wrong signature are the same answer to the caller, and
 * a verifier that throws is a verifier somebody wraps in a try/catch that
 * swallows the failure.
 *
 * @param {any} publicJwk
 * @param {string} signature base64url
 * @param {string} message
 */
export async function verify(publicJwk, signature, message) {
  try {
    const key = await importKey(publicJwk, 'verify');
    return await crypto.subtle.verify(SIGN, key, fromB64Url(signature), new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

/**
 * A short, stable name for a public key.
 *
 * For humans: it goes in `/hosts` output and next to a device in a revocation
 * list, so somebody can tell two entries apart and read one over the phone.
 * Sixteen hex characters of SHA-256 over the canonical key — not the whole
 * digest, because nobody compares 64 characters, and long enough that nobody
 * is going to collide two of them by accident.
 *
 * @param {any} publicJwk
 */
export async function fingerprint(publicJwk) {
  // x and y only: the same key exported twice can differ in `alg`, `ext` or
  // `key_ops`, and a fingerprint that changes when nothing changed is worse
  // than no fingerprint.
  const canonical = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The exact bytes a signature covers.
 *
 * Every signed thing in the fleet goes through here, so that a signature made
 * for one purpose cannot be replayed as another. The context string is what
 * separates them — a host proving itself and a device authorising an intent
 * produce signatures over different domains even when the payload is identical.
 *
 * Keys are sorted so that two encoders of the same object agree. JSON.stringify
 * preserves insertion order, which means the same intent built in two places
 * would otherwise sign differently and verify nowhere.
 *
 * @param {string} context
 * @param {Record<string, unknown>} payload
 */
export function signingInput(context, payload) {
  return `agent-fleet/v1/${context}\n${canonical(payload)}`;
}

/** @param {unknown} value @returns {string} */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(/** @type {Record<string, unknown>} */ (value))
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
