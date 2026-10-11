// How a pool's own machine asks to join, as every party computes it: the box
// that makes the machine, the machine itself, the coordinator that keeps the
// request, and the phone that approves it. docs/hypervisors.md, "A machine of
// its own".
//
// ASKED FOR: "Should it ask us for a pin we request it from the app it gets
// Face ID", after a holder sat running for hours outside the fleet: the pin it
// was booted with lasted ten minutes, and its first boot took longer.
//
// THE PHONE MAKES THE SECRET, when it starts the policy job, and seals it to
// the box running the job with the rest of the person's choice. The box puts
// it on the machine's cloud-init drive. The machine proves its request with it
// (`proofOf`), and the PHONE checks that proof before it asks for Face ID: the
// coordinator relays the request and never has the secret, so a coordinator
// that offered a key of its own under the holder's name has no proof to offer
// with it. That is the comparison docs/vault.md asks a person to make by eye
// for an ordinary box, made by the phone, because nobody can run a command on
// this machine to compare with.
//
// The same message and the same vector are in Fleet.swift and Fleet.kt, held
// to this file by test/fixtures/parity/holder-join.json.

/** The secret the phone makes: 32 random bytes, hex. */
export const HOLDER_SECRET_RE = /^[0-9a-f]{64}$/;
/** A proof: HMAC-SHA-256, hex. */
export const HOLDER_PROOF_RE = /^[0-9a-f]{64}$/;
/** The name the coordinator gives a pool's own machine. */
export const HOLDER_ID_RE = /^holder-[0-9a-f]{6}$/;
/** The whole SHA-256 of a box key, hex (src/fleet/minter/vault.js, boxKeyHash). */
export const KEY_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * What the proof is a MAC over: the name, the Xen Orchestra it holds and the
 * whole hash of its key, so a proof for one key under one name for one pool is
 * a proof of nothing else.
 *
 * @param {{ hostId: string, address: string, keyHash: string }} parts
 */
export function proofMessage({ hostId, address, keyHash }) {
  return `fleetwright-holder-join/1\n${hostId}\n${address}\n${keyHash}`;
}

/**
 * The proof, through WebCrypto so the coordinator's bundle could compute it
 * too (it never has the secret to).
 *
 * @param {string} secretHex @param {{ hostId: string, address: string, keyHash: string }} parts
 */
export async function proofOf(secretHex, parts) {
  if (!HOLDER_SECRET_RE.test(secretHex)) throw new Error('that is not a holder secret');
  const raw = new Uint8Array((secretHex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(proofMessage(parts))));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}
