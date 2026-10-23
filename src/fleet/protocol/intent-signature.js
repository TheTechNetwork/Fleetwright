// What a person's device signs when it asks a box for something, and the check
// a box makes of it. docs/signed-intents.md.
//
// WHY A BOX NEEDS THIS AT ALL. The actor on an intent is a string the
// coordinator writes, and the coordinator is the party this system is built to
// distrust (docs/trust.md, "coordinator → host: trusted absolutely"). A box
// that checks a signature made on the person's own device, against a key it
// learned from the minter rather than from the coordinator, obeys that person
// and not whoever relayed the request.
//
// WHAT IS SIGNED is everything the person decides: the verb, the parameters
// they gave, the box it is for, the person asking, the idempotency key and the
// time. NOT the parameters the protocol marks `setBy: 'fleet'` (a start's
// `archive` and `boxSecrets`, a provision's `ticket` and `repo`): the
// coordinator writes those after the person asked, from what it knows about
// them, and replaces anything a caller sent. They stay the coordinator's
// word, as membership and admin do (docs/signed-intents.md), and leaving them
// out is what lets a signature made on the phone still hold at the box. Signing the box stops a signature for one
// box running on another; signing the actor stops one person's signature being
// filed under another's name; the id and the time are what the box's replay
// cache and its clock check already hold (sidecar.js, REPLAY_TTL_MS).
//
// ONE FUNCTION FOR THE BYTES, here, so a phone, the console, a test and the
// box can never disagree about them: signingInput('intent', …) in the form
// every other signature in the fleet takes (src/fleet/crypto.js).
//
// ENFORCED ONLY WHERE A BOX ASKS FOR IT. checkIntentSignature says what it
// found and the sidecar counts it everywhere; a box run with
// FLEETWRIGHT_REQUIRE_SIGNED=1 also refuses an intent `needsSignature` names
// that is not signed by a key the minter lists (phase 3).

import { signingInput, verify } from '../crypto.js';
import { VERBS, SIG_RE, KID_RE } from './intents.js';

export { SIG_RE, KID_RE };

/** Verbs a box answers whoever asks, because what they say a box reports by itself. */
export const UNSIGNED_VERBS = Object.freeze(['list', 'status', 'health', 'updates', 'profiles']);

/**
 * What the coordinator sends with nobody asking at that moment, and a box that
 * enforces still takes unsigned (docs/signed-intents.md, "What the coordinator
 * still says alone"). `forgetperson` can only take away, which a coordinator
 * that stopped relaying could do anyway; a box checks `vmlogin` against the
 * machines it made itself, and the minter checks GitHub's own job token behind
 * `mint`. Nothing else the coordinator says alone is on this list: each of
 * those waits for the delegations and signed sign-ins phase 3 describes, and
 * an enforcing box refuses it until then.
 */
export const COORDINATOR_UNSIGNED_VERBS = Object.freeze(['forgetperson', 'vmlogin', 'mint']);

/**
 * Whether a box that enforces refuses this verb unless a person signed it.
 *
 * @param {string} verb
 */
export function needsSignature(verb) {
  return !UNSIGNED_VERBS.includes(verb) && !COORDINATOR_UNSIGNED_VERBS.includes(verb);
}

/**
 * The bytes a device signs for one intent to one box.
 *
 * @param {{ actor?: string, id: string, issuedAt: number, params?: Record<string, unknown>, verb: string }} intent
 * @param {string} host  the box's id
 */
export function intentSigningInput(intent, host) {
  return signingInput('intent', {
    actor: String(intent.actor ?? ''),
    host: String(host),
    id: intent.id,
    issuedAt: intent.issuedAt,
    params: Object.fromEntries(Object.entries(intent.params ?? {}).filter(([k]) => VERBS[intent.verb]?.params?.[k]?.setBy !== 'fleet')),
    verb: intent.verb,
  });
}

/**
 * A key's id, the same for the same key however it was exported.
 *
 * @param {{ kty: string, crv: string, x: string, y: string }} key
 */
export async function keyId(key) {
  const canonical = JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @typedef {object} DirectoryKey
 * @property {string} kid
 * @property {{ kty: string, crv: string, x: string, y: string }} key
 * @property {string} [label]
 */

/**
 * @typedef {'signed'|'unsigned'|'not-needed'|'unknown-key'|'bad-signature'|'no-directory'} Verdict
 */

/**
 * What a box finds when it checks one intent.
 *
 *   signed        made by a key the minter lists for the person named as actor
 *   not-needed    unsigned, and a verb a box answers whoever asks
 *   unsigned      no signature, on a verb that will need one
 *   unknown-key   signed, by a key the minter does not list for that person
 *   bad-signature signed by a listed key, over something other than this intent
 *   no-directory  signed, and this box has no key list from the minter to check it with
 *
 * @param {{ intent: { actor?: string, id: string, issuedAt: number, params?: Record<string, unknown>, verb: string }, sig?: string, kid?: string,
 *   host: string, directory: Map<string, DirectoryKey[]>|null }} args
 * @returns {Promise<{ verdict: Verdict, label?: string }>}
 */
export async function checkIntentSignature({ intent, sig, kid, host, directory }) {
  if (!sig || !kid) return { verdict: UNSIGNED_VERBS.includes(intent.verb) ? 'not-needed' : 'unsigned' };
  if (!SIG_RE.test(sig) || !KID_RE.test(kid)) return { verdict: 'bad-signature' };
  if (!directory) return { verdict: 'no-directory' };
  const person = actorEmail(intent.actor);
  const listed = person ? (directory.get(person) ?? []).find((k) => k.kid === kid) : undefined;
  if (!listed) return { verdict: 'unknown-key' };
  const ok = await verify(listed.key, sig, intentSigningInput(intent, host));
  return ok ? { verdict: 'signed', label: listed.label } : { verdict: 'bad-signature', label: listed.label };
}

/**
 * The person an intent's actor names: the address as the intent carries it,
 * which the sidecar turns into `fleet:<address>` for the hub (sidecar.js), in
 * lower case as the box keeps people everywhere (src/core/accounts.js). Null
 * for an intent with nobody behind it.
 *
 * @param {unknown} actor
 */
export function actorEmail(actor) {
  const s = String(actor ?? '').trim().toLowerCase();
  return s.includes('@') ? s : null;
}
