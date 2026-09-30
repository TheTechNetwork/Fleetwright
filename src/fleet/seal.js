// Sealing a repository token to the one runner that asked for it.
//
// WHY THIS EXISTS AT ALL. A runner asks for git credentials for one
// repository; a permanent box mints them; and the only path between the two is
// the coordinator, which this project treats as compromised (docs/trust.md,
// docs/security.md §4.1). Relaying the token in the clear would make the
// coordinator a place a minted token passes through, which is the thing the
// whole minting design is meant to avoid. So the runner makes a key pair for
// the request, the box encrypts the token to the public half, and the
// coordinator carries bytes it cannot open.
//
// WHY THE COORDINATOR CANNOT SWAP THE KEY. It carries the public key too, so
// on its own it could substitute one of its own. What stops that is the
// BINDING: a hash of the repository and the public key, which the runner puts
// into the AUDIENCE of the GitHub Actions job token it sends alongside. GitHub
// signs that token, so the box that mints checks the binding against the key
// and repository it was handed and refuses a mismatch. A coordinator that
// changes either one invalidates GitHub's signature over the pair; one that
// changes neither delivers something only the runner can read.
//
// WHAT IT IS: ECDH on P-256, HKDF-SHA-256, AES-256-GCM, with the binding as
// the additional data — the shape of HPKE's base mode, built from WebCrypto so
// the same file runs on a host and would run in a Worker. The sender's key is
// ephemeral too, one per seal, so nothing here is long-lived on either side.
//
// WHAT IT IS NOT: a defence against the runner. The runner is the person's
// own machine for the length of one job, and it is the thing the token is FOR.
//
// THE SAME CONSTRUCTION CARRIES A CLAUDE LOGIN, in both directions. A person
// deposits their `claude setup-token` sealed to the minter's long-lived
// deposit key, so the coordinator relaying it cannot read it; the minter keeps
// it sealed to that same key, under their GitHub account id; and hands it to
// their runner sealed to the runner's one-request key, bound to the job token
// exactly as a repository token is. src/fleet/minter/claude.js is that path.

import { toB64Url, fromB64Url } from './crypto.js';

/** HKDF's `info`, and the version of this whole construction. */
const INFO = 'fleetwright-mint/v1';

/** What every binding starts with, so a job token for this cannot be one for anything else. */
export const BINDING_PREFIX = 'fleetwright-mint:';

/**
 * An uncompressed P-256 public key, base64url without padding: 65 bytes is 87
 * characters, and nothing else is.
 */
export const SEAL_KEY_RE = /^[A-Za-z0-9_-]{87}$/;

const ECDH = /** @type {const} */ ({ name: 'ECDH', namedCurve: 'P-256' });
const enc = new TextEncoder();

/**
 * A key pair for one request. The private half never leaves the process that
 * made it and is not extractable, so it cannot be written anywhere by mistake.
 *
 * @returns {Promise<{ privateKey: CryptoKey, publicKey: string }>}
 */
export async function newSealKey() {
  const pair = /** @type {{ privateKey: CryptoKey, publicKey: CryptoKey }} */ (await crypto.subtle.generateKey(ECDH, false, ['deriveBits']));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toB64Url(raw) };
}

/**
 * The string a runner asks GitHub to put in its job token's audience, and the
 * additional data the token is sealed under.
 *
 * The repository is lowercased because GitHub treats `Acme/App` and `acme/app`
 * as one repository, and a binding that did not would refuse a clone for its
 * capitalisation.
 *
 * @param {{ repo: string, key: string }} what
 * @returns {Promise<string>}
 */
export async function bindingFor({ repo, key }) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${INFO}\n${String(repo).toLowerCase()}\n${key}`));
  return BINDING_PREFIX + toB64Url(new Uint8Array(digest));
}

/** What a job token asking for its owner's Claude login carries as its audience. */
export const CLAUDE_BINDING_PREFIX = 'fleetwright-claude:';

/**
 * The audience for a runner's ask for its owner's Claude login: the same
 * trick as `bindingFor`, with no repository, because a Claude login is not
 * for one. A distinct prefix and a distinct line in the hash, so a job token
 * minted for a repository token can never be presented for a Claude login, or
 * the other way round.
 *
 * @param {string} key
 * @returns {Promise<string>}
 */
export async function claudeBindingFor(key) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${INFO}\nclaude-login\n${key}`));
  return CLAUDE_BINDING_PREFIX + toB64Url(new Uint8Array(digest));
}

/** The additional data a Claude login is sealed under on its way INTO the minter. */
export const DEPOSIT_AAD = 'fleetwright-claude-deposit/v1';

/**
 * The additional data a Claude login is kept under AT REST in the minter: the
 * GitHub account it belongs to. A stored row moved under another account does
 * not open, so storage that could be rearranged still could not hand one
 * person's login to another person's runner.
 *
 * @param {string} userId  GitHub's numeric user id, as a string
 */
export function atRestAad(userId) {
  return `fleetwright-claude-login/v1\n${userId}`;
}

/**
 * A long-lived key pair for the minter to be deposited to: the private half as
 * a JWK, which is what goes into the Worker secret, and the public half in the
 * same 87-character form every seal key here takes, which is what a depositor
 * pins. Extractable on purpose, and ONLY here: this is the one key that has to
 * be written down, once, by the operator making it.
 *
 * @returns {Promise<{ secret: string, publicKey: string }>}
 */
export async function newDepositKey() {
  const pair = /** @type {{ privateKey: CryptoKey, publicKey: CryptoKey }} */ (await crypto.subtle.generateKey(ECDH, true, ['deriveBits']));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { secret: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }), publicKey: toB64Url(raw) };
}

/**
 * The minter's deposit key, from the JWK `newDepositKey` wrote. Its public
 * half is derived from the private half rather than configured beside it, so
 * the key a depositor is told to pin cannot drift from the key that opens what
 * they send.
 *
 * @param {string} secret
 * @returns {Promise<{ privateKey: CryptoKey, publicKey: string }>}
 */
export async function importDepositKey(secret) {
  /** @type {any} */
  let jwk;
  try {
    jwk = JSON.parse(String(secret || ''));
  } catch {
    throw new Error('the deposit key is not JSON; it is the JWK scripts/minter-deposit-key.mjs printed');
  }
  if (jwk?.kty !== 'EC' || jwk?.crv !== 'P-256' || typeof jwk?.d !== 'string') {
    throw new Error('the deposit key is not a P-256 private key');
  }
  const privateKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, ECDH, false, ['deriveBits']);
  const pub = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, ECDH, true, []);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pub));
  return { privateKey, publicKey: toB64Url(raw) };
}

/**
 * @param {CryptoKey} privateKey @param {CryptoKey} publicKey @param {Uint8Array} salt
 * @returns {Promise<CryptoKey>}
 */
async function aeadKey(privateKey, publicKey, salt) {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: /** @type {any} */ (salt), info: enc.encode(INFO) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** @param {string} key */
function importPublic(key) {
  if (!SEAL_KEY_RE.test(String(key))) throw new Error('not a P-256 public key');
  return crypto.subtle.importKey('raw', /** @type {any} */ (fromB64Url(key)), ECDH, false, []);
}

/**
 * Encrypt `payload` so that only the holder of `to`'s private half can read it.
 *
 * @param {{ to: string, aad: string, payload: Record<string, unknown> }} args
 * @returns {Promise<{ epk: string, iv: string, ct: string }>}
 */
export async function seal({ to, aad, payload }) {
  const recipient = await importPublic(to);
  const eph = /** @type {{ privateKey: CryptoKey, publicKey: CryptoKey }} */ (await crypto.subtle.generateKey(ECDH, true, ['deriveBits']));
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  // The salt is both public keys, so a key derived for one pair can never be
  // the key for another.
  const key = await aeadKey(eph.privateKey, recipient, concat(epk, fromB64Url(to)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(JSON.stringify(payload)),
  );
  return { epk: toB64Url(epk), iv: toB64Url(iv), ct: toB64Url(new Uint8Array(ct)) };
}

/**
 * Decrypt what `seal` produced. Throws on anything that does not open under
 * this key and this binding — a changed byte, a different repository, a key
 * somebody substituted — because a token that arrived tampered is not one to
 * hand to git.
 *
 * @param {{ privateKey: CryptoKey, publicKey: string, aad: string, sealed: { epk?: unknown, iv?: unknown, ct?: unknown } }} args
 * @returns {Promise<Record<string, any>>}
 */
export async function open({ privateKey, publicKey, aad, sealed }) {
  const epk = String(sealed?.epk || '');
  const iv = fromB64Url(String(sealed?.iv || ''));
  const ct = fromB64Url(String(sealed?.ct || ''));
  if (iv.length !== 12 || !ct.length) throw new Error('not a sealed token');
  const key = await aeadKey(privateKey, await importPublic(epk), concat(fromB64Url(epk), fromB64Url(publicKey)));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: /** @type {any} */ (iv), additionalData: enc.encode(aad) },
    key,
    /** @type {any} */ (ct),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
