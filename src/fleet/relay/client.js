// The relays, from a coordinator's side: where they are, which fleet this
// is, and the key a GitHub token comes back sealed to. The relays themselves
// are in relay.js, and what they keep is in docs/relay-terms.md.
//
// FOR A COORDINATOR THAT IS NOT OURS. Ours sends with its own APNs key and
// Firebase account and exchanges GitHub codes with the App's secret, and sets
// none of this. A fork has none of those, registers with the relay once
// (scripts/relay-register.mjs), and sets four values:
//
//   FLEETWRIGHT_RELAY_URL      where the relays answer, e.g. https://fleet.thetech.network
//   FLEETWRIGHT_RELAY_FLEET    the fleet id the relay issued
//   FLEETWRIGHT_RELAY_SECRET   SECRET. The fleet's secret, for the push relay
//   FLEETWRIGHT_RELAY_KEY      SECRET. The private half of the key GitHub
//                              tokens are sealed to, as a P-256 JWK. Only the
//                              OAuth relay needs it.
//
// PORTABLE, like push.js: the Worker coordinator runs this.

import { toBase64Url, fromBase64 } from '../push-crypto.js';

/**
 * The relay configuration in this environment, or null when there is none.
 * Push needs the url, fleet and secret; the OAuth relay also needs the key,
 * and `privateJwk`/`publicKey` are null without it.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ url: string, fleet: string, secret: string, privateJwk: import('node:crypto').webcrypto.JsonWebKey|null, publicKey: string|null }|null}
 */
export function relayFromEnv(env) {
  const url = String(env.FLEETWRIGHT_RELAY_URL || '').trim().replace(/\/+$/, '');
  const fleet = String(env.FLEETWRIGHT_RELAY_FLEET || '').trim();
  const secret = String(env.FLEETWRIGHT_RELAY_SECRET || '').trim();
  if (!/^https:\/\/[^/\s]+$/.test(url) || !fleet || !secret) return null;
  const jwk = parseJwk(env.FLEETWRIGHT_RELAY_KEY);
  return { url, fleet, secret, privateJwk: jwk, publicKey: jwk ? publicOf(jwk) : null };
}

/**
 * A P-256 private JWK, or null. Parsed, not trusted: a key that is not one
 * is no OAuth relay, said once at boot by whoever reads the null, rather than
 * a sign-in that fails after the person has authorised it.
 *
 * @param {string|undefined} raw
 * @returns {import('node:crypto').webcrypto.JsonWebKey|null}
 */
function parseJwk(raw) {
  if (!raw) return null;
  try {
    const jwk = JSON.parse(raw);
    if (jwk?.kty !== 'EC' || jwk?.crv !== 'P-256' || typeof jwk.d !== 'string' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
    return { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y };
  } catch {
    return null;
  }
}

/**
 * The public half as push-crypto.js takes it: the uncompressed point,
 * 0x04 || x || y, base64url. The same form a phone registers its push key in.
 *
 * @param {import('node:crypto').webcrypto.JsonWebKey} jwk
 */
export function publicOf(jwk) {
  const x = fromBase64(String(jwk.x));
  const y = fromBase64(String(jwk.y));
  const raw = new Uint8Array(1 + x.length + y.length);
  raw[0] = 0x04;
  raw.set(x, 1);
  raw.set(y, 1 + x.length);
  return toBase64Url(raw);
}
