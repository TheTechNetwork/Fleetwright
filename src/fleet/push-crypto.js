// Notification content the relay — and Apple, and Google — cannot read.
//
// WHY THIS EXISTS. docs/relay-terms.md promises that nothing about a
// notification is written down, and that promise is CONTRACTUAL: it is kept by
// not adding a log line, which is a thing people do during incidents. This
// module makes it STRUCTURAL instead. The payload is encrypted on the
// coordinator to a key held by one phone, so a relay forwards bytes it cannot
// read and neither APNs nor FCM sees what a session is asking.
//
// That last part is the bit worth noticing: this is not only about a relay we
// have not built. Every push this project sends today goes through Apple or
// Google in the clear, carrying a session name and — since prompts started
// carrying the question — the question. Encrypting it is an improvement to what
// already ships, and the relay merely inherits it.
//
// THE SCHEME, and it is deliberately small.
//
//   ECDH on P-256  →  HKDF-SHA256  →  AES-256-GCM
//
// Every piece is in WebCrypto, which is the reason for the choice: this file
// has to run in the Workers runtime and in Node with no dependency, and both
// apps have to implement the other half natively — CryptoKit on iOS, the
// Android Keystore on Android. A scheme neither phone can do without a library
// is a scheme that does not ship.
//
// NOT RFC 8291 (Web Push) exactly, and the difference is worth stating rather
// than leaving somebody to discover. The key derivation below follows its
// shape — a per-message ephemeral key, both public keys bound into the KDF
// info — because that part is reviewed and the reasoning is public. What is
// dropped is the `aes128gcm` content coding: record sizes, padding and a
// framing header that exist so a push service can chunk a body, which buys
// interop with libraries this project does not use and adds three ways to be
// subtly wrong. There is one record here and it is small.
//
// WHAT THIS DOES NOT HIDE. That a notification was sent, when, and to which
// device address. A push service necessarily knows all three, and no
// arrangement of keys changes it. The claim is about CONTENT and it is worth
// keeping exact — see docs/push-encryption.md.

/** The envelope's first byte. A version that is checked is a version that can
 * change; one that is merely written is decoration. */
const VERSION = 1;

/** Uncompressed X9.62 point: 0x04 || X(32) || Y(32). The only encoding both
 * CryptoKit and the Android Keystore agree on without a helper. */
const PUBLIC_KEY_BYTES = 65;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

/** Domain separation. Bumped with VERSION, never edited in place — two peers
 * deriving different keys from the same secret fail with "decryption failed"
 * and nothing that names the cause. */
const INFO_PREFIX = new TextEncoder().encode('fleetwright-push-v1');

/**
 * The subtle crypto to use.
 *
 * Taken from the global rather than imported from `node:crypto`, because this
 * module is bundled into the Worker and a `node:` import there is a build
 * failure — the one thing worker.yml's dry-run exists to catch.
 */
function subtle() {
  const c = /** @type {any} */ (globalThis).crypto;
  if (!c?.subtle) throw new Error('push encryption needs WebCrypto (Node 24+, or the Workers runtime)');
  return c.subtle;
}

/** @param {number} n */
function randomBytes(n) {
  const out = new Uint8Array(n);
  /** @type {any} */ (globalThis).crypto.getRandomValues(out);
  return out;
}

/**
 * A device's public key, as it arrives from a phone.
 *
 * VALIDATED BEFORE IT IS STORED, not at send time. A key that cannot be
 * imported is a registration that will fail on every notification forever, and
 * the moment to say so is while somebody is looking at a settings screen — not
 * silently, hours later, when a session needs an answer.
 *
 * @param {unknown} value base64 (standard or url-safe) of an uncompressed point
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function checkPublicKey(value) {
  if (typeof value !== 'string' || !value) return { ok: false, error: 'a push key must be a base64 string' };
  let bytes;
  try {
    bytes = fromBase64(value);
  } catch {
    return { ok: false, error: 'a push key must be base64' };
  }
  if (bytes.length !== PUBLIC_KEY_BYTES || bytes[0] !== 0x04) {
    return { ok: false, error: `a push key must be a ${PUBLIC_KEY_BYTES}-byte uncompressed P-256 point` };
  }
  try {
    await importPublicKey(bytes);
  } catch {
    // Not on the curve. WebCrypto checks this on import, which is exactly where
    // it should be caught: an invalid-curve point is the classic way to learn
    // somebody else's private key one bit at a time.
    return { ok: false, error: 'that push key is not a point on P-256' };
  }
  return { ok: true };
}

/** @param {Uint8Array} raw */
function importPublicKey(raw) {
  return subtle().importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

/**
 * Encrypt one notification to one device.
 *
 * A FRESH EPHEMERAL KEY PER MESSAGE, which is what makes two notifications to
 * the same phone unlinkable to anyone holding only the ciphertexts, and what
 * means a compromised message reveals nothing about the next one. Generating it
 * once and reusing it would be the obvious optimisation and would throw both
 * properties away for a millisecond.
 *
 * @param {string} recipientKey base64 of the device's public key
 * @param {unknown} payload anything JSON-serialisable — the real title, body and options
 * @returns {Promise<string>} base64url envelope, safe in a JSON push payload
 */
export async function sealTo(recipientKey, payload) {
  const recipientRaw = fromBase64(String(recipientKey));
  const recipient = await importPublicKey(recipientRaw);

  const ephemeral = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ephemeralRaw = new Uint8Array(await subtle().exportKey('raw', ephemeral.publicKey));

  const shared = new Uint8Array(
    await subtle().deriveBits({ name: 'ECDH', public: recipient }, ephemeral.privateKey, 256),
  );

  const salt = randomBytes(SALT_BYTES);
  const { key, nonce } = await derive(shared, salt, recipientRaw, ephemeralRaw);

  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const sealed = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, plaintext),
  );

  // VERSION FIRST so a future scheme is a different first byte rather than a
  // guess about length. Then the salt and the ephemeral key, because the
  // recipient needs both before it can derive anything.
  const out = new Uint8Array(1 + SALT_BYTES + PUBLIC_KEY_BYTES + sealed.length);
  out[0] = VERSION;
  out.set(salt, 1);
  out.set(ephemeralRaw, 1 + SALT_BYTES);
  out.set(sealed, 1 + SALT_BYTES + PUBLIC_KEY_BYTES);
  return toBase64Url(out);
}

/**
 * The other half, for tests and for anything running this in Node.
 *
 * THE APPS DO NOT CALL THIS — they implement it in CryptoKit and in the Android
 * Keystore, because the private key must never leave the secure element to be
 * usable. It is here so the scheme can be exercised end to end in this
 * repository rather than only in two places nothing here can run, which is
 * precisely the gap that let push ship unproven for months.
 *
 * @param {CryptoKey} privateKey an ECDH P-256 private key
 * @param {string} recipientKey base64 of the matching public key
 * @param {string} envelope base64url, as produced by sealTo
 */
export async function openWith(privateKey, recipientKey, envelope) {
  const bytes = fromBase64(envelope);
  if (bytes.length < 1 + SALT_BYTES + PUBLIC_KEY_BYTES + 16) throw new Error('envelope is too short');
  if (bytes[0] !== VERSION) throw new Error(`unsupported push envelope version ${bytes[0]}`);

  const salt = bytes.slice(1, 1 + SALT_BYTES);
  const ephemeralRaw = bytes.slice(1 + SALT_BYTES, 1 + SALT_BYTES + PUBLIC_KEY_BYTES);
  const sealed = bytes.slice(1 + SALT_BYTES + PUBLIC_KEY_BYTES);

  const ephemeral = await importPublicKey(ephemeralRaw);
  const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: ephemeral }, privateKey, 256));
  const { key, nonce } = await derive(shared, salt, fromBase64(String(recipientKey)), ephemeralRaw);

  const plain = new Uint8Array(
    await subtle().decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, sealed),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * Key and nonce from the shared secret.
 *
 * BOTH PUBLIC KEYS GO INTO `info`, which is the part that is easy to leave out
 * and expensive to leave out. Without them a ciphertext is not bound to the
 * pair it was made for, and an attacker who can choose one of the keys can make
 * two different exchanges derive the same secret. RFC 8291 does the same thing
 * for the same reason.
 *
 * ONE EXPAND FOR BOTH, split by offset, rather than two calls. The nonce is not
 * a secret and does not need its own derivation — what it needs is to be unique
 * per key, and it is: the key is derived from a per-message ephemeral, so the
 * pair is never repeated.
 *
 * @param {Uint8Array} shared @param {Uint8Array} salt
 * @param {Uint8Array} recipientRaw @param {Uint8Array} ephemeralRaw
 */
async function derive(shared, salt, recipientRaw, ephemeralRaw) {
  const info = new Uint8Array(INFO_PREFIX.length + recipientRaw.length + ephemeralRaw.length);
  info.set(INFO_PREFIX, 0);
  info.set(recipientRaw, INFO_PREFIX.length);
  info.set(ephemeralRaw, INFO_PREFIX.length + recipientRaw.length);

  const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const okm = new Uint8Array(
    await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, ikm, (KEY_BYTES + NONCE_BYTES) * 8),
  );
  const key = await subtle().importKey('raw', okm.slice(0, KEY_BYTES), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, nonce: okm.slice(KEY_BYTES, KEY_BYTES + NONCE_BYTES) };
}

/**
 * base64 in either alphabet, because three platforms disagree about which one
 * they hand you and none of them is wrong.
 *
 * @param {string} value
 */
export function fromBase64(value) {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** @param {Uint8Array} bytes */
export function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
