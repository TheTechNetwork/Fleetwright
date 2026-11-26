// What the minter signs when it answers a box's vault request, and so what a
// box checks before it believes the answer. docs/vault.md, "On the box".
//
// WHY AN ANSWER IS SIGNED AT ALL. The vault's answer to a box was sealed to a
// key the box made for that one request, and checked by opening it and by
// nothing else. But a box's request is signed, not sealed: the key the
// answer is sealed to travels in it in the clear, through the coordinator.
// Sealing to a public key says nothing about who sealed, so a coordinator
// could answer a box's request itself, with a vault of its own making. An
// outside review did exactly that: a box nobody had approved for a member's
// vault believed it was approved for it, and a box was handed a Codex
// sign-in for a member that no custodian had kept. The coordinator is the
// party this design does not believe (docs/trust.md), so the answer now
// carries the minter's signature, by the key a box already pins for the
// signed key list (src/fleet/host/intent-keys.js), and a box takes nothing
// from an answer without one that holds.
//
// WHAT IS SIGNED, under a context of its own so it is no other signature:
//
//   host    the whole SHA-256 of the box's key, hex (keyId): the box the
//           answer is for, so one box's answer is not another's.
//   at      the `at` of the box's own request, as it signed it.
//   reply   the key that request asked to be answered to. With `at` it ties
//           the answer to one request, so an older genuine answer is not an
//           answer to a newer one.
//   sealed  the SHA-256, hex, of the sealed part: its three strings joined
//           by full stops, `epk.iv.ct`, which base64url cannot contain. A
//           digest and not the strings themselves, so what is signed stays
//           one short line however much a box holds.
//
// ONE FUNCTION FOR THE BYTES, here, so the minter that signs and the box that
// checks can never disagree about them (as intent-signature.js is for an
// intent). It is in a file of its own because both import it, and neither
// the minter nor the sidecar imports the other.
//
// WHERE THE SIGNATURE TRAVELS: inside `sealed`, beside `epk`, `iv` and `ct`,
// as `signature`. The coordinator hands a box `sealed` and a sentence and
// nothing else of the minter's answer (core.js, #onHostVault), so that is
// the one place every coordinator, old or new, carries it untouched. A box
// from before it opens `sealed` by its three strings and ignores a fourth.

import { signingInput } from '../crypto.js';

/** The context the minter's answer to a box is signed under. */
export const VAULT_BOX_ANSWER_CONTEXT = 'vault-box-answer';

/**
 * The digest of a sealed part: SHA-256, in lowercase hex, of `epk.iv.ct`.
 *
 * @param {{ epk?: unknown, iv?: unknown, ct?: unknown }|null|undefined} sealed
 * @returns {Promise<string>}
 */
export async function sealedDigest(sealed) {
  const text = `${String(sealed?.epk ?? '')}.${String(sealed?.iv ?? '')}.${String(sealed?.ct ?? '')}`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The exact bytes the minter signs for one answer to one box, and a box
 * checks.
 *
 * @param {{ host: string, at: number, reply: string, sealed: { epk?: unknown, iv?: unknown, ct?: unknown } }} answer
 *   `host` the box key's id, `at` and `reply` the box's own request's, `sealed` the sealed part being answered with
 * @returns {Promise<string>}
 */
export async function vaultBoxAnswerInput({ host, at, reply, sealed }) {
  return signingInput(VAULT_BOX_ANSWER_CONTEXT, { v: 1, host, at, reply, sealed: await sealedDigest(sealed) });
}
