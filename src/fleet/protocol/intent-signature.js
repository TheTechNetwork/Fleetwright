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

// A DELEGATION: what a person signs on their phone to let the coordinator
// send something in their name later, when they are not there to sign it
// (docs/signed-intents.md, "Delegations"). Keeping machines ready, finishing a
// sign-in the phone started, an MCP client acting for them, a start held until
// a runner joins: each is the coordinator asking a box with nobody holding the
// phone at that moment, and each is bounded by what the person signed.
//
// WHAT IT NAMES, all of it signed: the person (`actor`), the verbs, the boxes
// (`hosts`, or `['*']` for whichever box the fleet places it on), parameters the
// intent must carry exactly (`match`), and a window (`issuedAt` to `expires`).
// The box checks every one, against the same key list it checks a signature
// with, so a delegation is worth no more than the phone that made it.
//
// WHAT A COORDINATOR CAN STILL DO WITH ONE is exactly that, as many times as it
// likes inside the window: it is a standing permission, not a single request,
// and that is the whole reason a phone keeps them short and narrow. `id` is what
// the person revokes it by: the minter lists revoked ids beside the keys, and a
// box refuses a revoked one from the next list it takes.

/** The longest a delegation may run, whatever its maker asked for. */
export const DELEGATION_MAX_MS = 31 * 24 * 60 * 60_000;
/** How far ahead of a box's clock a delegation may say it was made. */
export const DELEGATION_SKEW_MS = 5 * 60_000;
/** Size bounds a box holds a delegation to before it checks anything. */
export const DELEGATION_LIMITS = Object.freeze({ verbs: 32, hosts: 32, match: 16, value: 8192, bytes: 16 * 1024 });

const DELEGATION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const DELEGATION_HOST_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * @typedef {object} Grant
 * @property {1} v
 * @property {string} id
 * @property {string} actor
 * @property {string[]} verbs
 * @property {string[]} hosts  box ids, or exactly ['*']
 * @property {Record<string, string|number>} match
 * @property {number} issuedAt
 * @property {number} expires
 */

/**
 * The grant in a delegation, if it is in the shape one takes, else null.
 * Shape only: whether it holds is checkDelegation's to say.
 *
 * @param {unknown} raw
 * @returns {Grant|null}
 */
export function grantShape(raw) {
  const g = /** @type {any} */ (raw);
  if (!g || typeof g !== 'object' || Array.isArray(g) || g.v !== 1) return null;
  if (typeof g.id !== 'string' || !DELEGATION_ID_RE.test(g.id)) return null;
  if (!actorEmail(g.actor)) return null;
  const verbs = Array.isArray(g.verbs) ? g.verbs : null;
  if (!verbs || !verbs.length || verbs.length > DELEGATION_LIMITS.verbs) return null;
  if (verbs.some((/** @type {unknown} */ v) => typeof v !== 'string' || !Object.hasOwn(VERBS, v) || !needsSignature(/** @type {string} */ (v)))) return null;
  const hosts = Array.isArray(g.hosts) ? g.hosts : null;
  if (!hosts || !hosts.length || hosts.length > DELEGATION_LIMITS.hosts) return null;
  if (!(hosts.length === 1 && hosts[0] === '*') && hosts.some((/** @type {unknown} */ h) => typeof h !== 'string' || !DELEGATION_HOST_RE.test(h))) return null;
  const match = g.match ?? {};
  if (!match || typeof match !== 'object' || Array.isArray(match) || Object.keys(match).length > DELEGATION_LIMITS.match) return null;
  for (const v of Object.values(match)) {
    if (typeof v === 'number' ? !Number.isFinite(v) : typeof v !== 'string' || v.length > DELEGATION_LIMITS.value) return null;
  }
  if (!Number.isSafeInteger(g.issuedAt) || !Number.isSafeInteger(g.expires)) return null;
  if (g.expires <= g.issuedAt || g.expires - g.issuedAt > DELEGATION_MAX_MS) return null;
  return {
    v: 1, id: g.id, actor: String(g.actor), verbs: [...verbs], hosts: [...hosts],
    match: /** @type {Record<string, string|number>} */ ({ ...match }), issuedAt: g.issuedAt, expires: g.expires,
  };
}

/**
 * The delegation an envelope carries, whole and in shape, or null. The size is
 * held before anything else, because a box takes this from the coordinator.
 *
 * @param {unknown} raw
 * @returns {{ grant: Grant, sig: string, kid: string }|null}
 */
export function delegationShape(raw) {
  const d = /** @type {any} */ (raw);
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  let bytes = 0;
  try {
    bytes = JSON.stringify(d).length;
  } catch {
    return null;
  }
  if (bytes > DELEGATION_LIMITS.bytes) return null;
  if (typeof d.sig !== 'string' || !SIG_RE.test(d.sig) || typeof d.kid !== 'string' || !KID_RE.test(d.kid)) return null;
  const grant = grantShape(d.grant);
  return grant ? { grant, sig: d.sig, kid: d.kid } : null;
}

/**
 * The bytes a device signs for a delegation.
 *
 * @param {Grant} grant
 */
export function delegationSigningInput(grant) {
  return signingInput('delegation', {
    actor: grant.actor, expires: grant.expires, hosts: grant.hosts, id: grant.id,
    issuedAt: grant.issuedAt, match: grant.match, v: 1, verbs: grant.verbs,
  });
}

/**
 * Why a grant does not cover this intent to this box at this time, or null when
 * it does. The coordinator asks this to choose which delegation to carry, and a
 * box asks it again before it takes one.
 *
 * @param {Grant} grant
 * @param {{ actor?: string, verb: string, params?: Record<string, unknown> }} intent
 * @param {string} host
 * @param {number} now
 * @returns {string|null}
 */
export function delegationGap(grant, intent, host, now) {
  if (actorEmail(intent.actor) !== actorEmail(grant.actor)) return `it was signed by ${grant.actor}, not ${intent.actor ?? 'nobody'}`;
  if (!grant.verbs.includes(intent.verb)) return `it does not cover ${intent.verb}`;
  if (!(grant.hosts[0] === '*' || grant.hosts.includes(host))) return `it does not cover ${host}`;
  const params = intent.params ?? {};
  for (const [k, v] of Object.entries(grant.match)) {
    if (!Object.hasOwn(params, k) || String(params[k]) !== String(v)) return `it covers ${intent.verb} only with ${k} as signed`;
  }
  if (now > grant.expires) return 'it has run out';
  if (grant.issuedAt - now > DELEGATION_SKEW_MS) return 'it says it was made in the future';
  return null;
}

/**
 * @typedef {'delegated'|'unknown-key'|'bad-signature'|'no-directory'|'not-covered'|'revoked'} DelegationVerdict
 */

/**
 * What a box finds when it checks a delegation an unsigned intent carries.
 *
 *   delegated     signed by a key the minter lists for the person, covering this intent, here, now
 *   not-covered   a real delegation that does not cover this intent (verb, box, parameters or time)
 *   revoked       its maker revoked it, and the minter's list says so
 *   unknown-key, bad-signature, no-directory  as checkIntentSignature
 *
 * @param {{ intent: { actor?: string, verb: string, params?: Record<string, unknown> }, delegation: unknown, host: string,
 *   directory: Map<string, DirectoryKey[]>|null, revoked?: Map<string, Set<string>>|null, now: number }} args
 * @returns {Promise<{ verdict: DelegationVerdict, label?: string, gap?: string, id?: string }>}
 */
export async function checkDelegation({ intent, delegation, host, directory, revoked = null, now }) {
  const d = delegationShape(delegation);
  if (!d) return { verdict: 'bad-signature' };
  if (!directory) return { verdict: 'no-directory', id: d.grant.id };
  const person = actorEmail(d.grant.actor);
  const listed = person ? (directory.get(person) ?? []).find((k) => k.kid === d.kid) : undefined;
  if (!listed) return { verdict: 'unknown-key', id: d.grant.id };
  if (!(await verify(listed.key, d.sig, delegationSigningInput(d.grant)))) return { verdict: 'bad-signature', label: listed.label, id: d.grant.id };
  if (person && revoked?.get(person)?.has(d.grant.id)) return { verdict: 'revoked', label: listed.label, id: d.grant.id };
  const gap = delegationGap(d.grant, intent, host, now);
  return gap ? { verdict: 'not-covered', label: listed.label, gap, id: d.grant.id } : { verdict: 'delegated', label: listed.label, id: d.grant.id };
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
