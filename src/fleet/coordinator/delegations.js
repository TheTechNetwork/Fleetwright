// What people signed on their phones to let the fleet act in their name while
// they are not there to sign (docs/signed-intents.md, "Delegations").
//
// WHY THE COORDINATOR KEEPS THEM. A box that takes only what a person signed
// refuses anything the coordinator sends on its own: a machine kept ready, a
// sign-in finished after the phone handed over, an MCP client's call, a start
// held until a runner joins. Each of those has a person behind it who said yes
// earlier, and a delegation is that yes, signed. The coordinator keeps it and
// carries it with the intents it covers; the box checks it exactly as it checks
// a signature, against the minter's key list, so keeping one here gives the
// coordinator nothing the person did not sign.
//
// WHAT IS NOT CHECKED HERE is the signature: this side has no key list it could
// trust, and a delegation that does not hold is refused by the box anyway.
// What is checked is the shape, and that it is the asking person's own: one
// member cannot file a delegation in another's name, which matters to an honest
// coordinator because it would carry it.
//
// BOUNDED as every Durable Object value here is (test/do-key-bounds.test.js):
// MAX_DELEGATIONS_PER_PERSON live ones a person, MAX_DELEGATION_STORE_BYTES
// in all, refused past either rather than dropping a live one to make room, and
// a delegation that has run out is swept on every change.

import { actorEmail, delegationGap, delegationShape } from '../protocol/intent-signature.js';

/** Live delegations one person may keep here. */
export const MAX_DELEGATIONS_PER_PERSON = 8;
/** The whole store, serialised, stays under one Durable Object value. */
export const MAX_DELEGATION_STORE_BYTES = 100_000;
/** One that runs this long or less was signed for a moment, and gives way when a person's allowance is full. */
export const SHORT_DELEGATION_MS = 60 * 60_000;

/**
 * Do two grants cover the same thing: the same verbs, boxes and parameters,
 * and both with a list of members or both with none?
 *
 * WHETHER IT NAMES MEMBERS IS PART OF IT. That was left out, so the grant a
 * person made after picking a member took the place of the one that named
 * none, and the one that named none was the only one a box from before the
 * field could read (`cover`, below): every call to such a box then went with
 * a grant it called badly signed. A grant with no list and one with an empty
 * list are different grants too, because the list is in the bytes that were
 * signed.
 *
 * WHICH MEMBERS IT NAMES IS NOT. For a while it was, and allowing again with
 * fewer members stopped narrowing anything: a person who allowed Debbie and
 * Loose, turned Loose off and allowed again kept both grants, and a start
 * as Loose was still carried under the first. Every different selection was
 * also one more of the eight a person may keep, so the ninth was refused. A
 * newer list is the person saying who it is now, and takes the older one's
 * place, as it did before the field was compared at all.
 *
 * @param {import('../protocol/intent-signature.js').Grant} a @param {import('../protocol/intent-signature.js').Grant} b
 */
function sameCover(a, b) {
  const key = (/** @type {import('../protocol/intent-signature.js').Grant} */ g) => JSON.stringify([
    [...g.verbs].sort(), [...g.hosts].sort(), Object.entries(g.match).sort(([x], [y]) => (x < y ? -1 : 1)),
    g.members !== undefined,
  ]);
  return key(a) === key(b);
}

/**
 * @typedef {{ grant: import('../protocol/intent-signature.js').Grant, sig: string, kid: string }} Delegation
 */

export class Delegations {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, Delegation[]>} email → that person's, soonest to run out first */
    this.byPerson = new Map();
  }

  #sweep() {
    const t = this.now();
    for (const [email, list] of this.byPerson) {
      const live = list.filter((d) => d.grant.expires >= t);
      if (live.length) this.byPerson.set(email, live);
      else this.byPerson.delete(email);
    }
  }

  /**
   * Keep one a person sent. Replaces one with the same id.
   *
   * @param {string} email  who is asking, as their credential says
   * @param {unknown} raw
   * @returns {{ ok: true, id: string } | { ok: false, error: { code: string }, text: string }}
   */
  put(email, raw) {
    const who = actorEmail(email);
    const d = delegationShape(raw);
    if (!who || !d) return { ok: false, error: { code: 'bad_params' }, text: 'That is not a delegation in the shape a box takes.' };
    if (actorEmail(d.grant.actor) !== who) {
      return { ok: false, error: { code: 'not_yours' }, text: `That delegation is ${d.grant.actor}’s, and you are signed in as ${who}.` };
    }
    this.#sweep();
    if (d.grant.expires < this.now()) return { ok: false, error: { code: 'stale' }, text: 'That delegation has already run out.' };
    // A RENEWAL REPLACES WHAT IT RENEWS: one covering exactly the same verbs,
    // boxes and parameters as one kept already is the same permission for
    // longer, and keeping both would only fill the person's allowance. So
    // does one that names other members than the one it follows (sameCover).
    let others = (this.byPerson.get(who) ?? []).filter((x) => x.grant.id !== d.grant.id && !sameCover(x.grant, d.grant));
    if (others.length >= MAX_DELEGATIONS_PER_PERSON) {
      // A SHORT ONE GIVES WAY: a phone signs one for each request the fleet
      // places, for ten minutes, and the one nearest its end costs at worst a
      // request sent again. A standing one is never dropped to make room.
      const short = others.filter((x) => x.grant.expires - x.grant.issuedAt <= SHORT_DELEGATION_MS);
      if (!short.length) {
        return { ok: false, error: { code: 'too_many' }, text: `You keep ${MAX_DELEGATIONS_PER_PERSON} delegations already. Revoke one you no longer need first.` };
      }
      const nearest = short.reduce((a, b) => (a.grant.expires <= b.grant.expires ? a : b));
      others = others.filter((x) => x !== nearest);
    }
    const next = [...others, d].sort((a, b) => a.grant.expires - b.grant.expires);
    const prior = this.byPerson.get(who);
    this.byPerson.set(who, next);
    if (JSON.stringify(this.serialise()).length > MAX_DELEGATION_STORE_BYTES) {
      if (prior) this.byPerson.set(who, prior);
      else this.byPerson.delete(who);
      return { ok: false, error: { code: 'full' }, text: 'The fleet keeps as many delegations as it has room for. Ask whoever runs it, or revoke one first.' };
    }
    return { ok: true, id: d.grant.id };
  }

  /**
   * Stop carrying one. The box stops taking it only when the minter lists it as
   * revoked, which the phone asks for itself: this is the honest half.
   *
   * @param {string} email @param {string} id
   */
  remove(email, id) {
    const who = actorEmail(email);
    const list = who ? this.byPerson.get(who) : undefined;
    if (!who || !list) return false;
    const left = list.filter((d) => d.grant.id !== id);
    if (left.length === list.length) return false;
    if (left.length) this.byPerson.set(who, left);
    else this.byPerson.delete(who);
    return true;
  }

  /** @param {string} email */
  forget(email) {
    const who = actorEmail(email);
    return who ? this.byPerson.delete(who) : false;
  }

  /**
   * A person's, for their app to list.
   *
   * @param {string} email
   */
  listFor(email) {
    this.#sweep();
    const who = actorEmail(email);
    return who ? (this.byPerson.get(who) ?? []).map((d) => ({ ...d.grant })) : [];
  }

  /**
   * The delegation to carry with this intent to this box, or null. The one that
   * runs out soonest, which is the narrowest a phone made for the moment
   * before a standing one.
   *
   * NEVER ONE THAT NAMES MEMBERS, TO A BOX FROM BEFORE THE FIELD
   * (`readsMembers` false). `members` is in the bytes a phone signs, and a
   * box that has never heard of it rebuilds those bytes without it: it finds
   * the signature does not hold, for every verb, and says the request "was
   * changed after it was signed", which nobody did. Such a box is carried a
   * grant with no list or none at all, and the caller says why when the only
   * grant that covers is one it cannot read (core.js, `send`).
   *
   * AND FIRST ONE THAT NAMES THE MEMBER A SESSION RUNS AS (`asMember`), when
   * the intent is about such a session: a box that takes only signed requests
   * refuses a grant that does not name it (docs/members.md), and a person may
   * hold one of each.
   *
   * @param {{ actor?: string, verb: string, params?: Record<string, unknown> }} intent
   * @param {string} host
   * @param {{ readsMembers?: boolean, asMember?: string|null }} [box]
   * @returns {Delegation|null}
   */
  cover(intent, host, { readsMembers = true, asMember = null } = {}) {
    const who = actorEmail(intent.actor);
    if (!who) return null;
    const t = this.now();
    const covering = (this.byPerson.get(who) ?? []).filter((d) => delegationGap(d.grant, intent, host, t) === null && (readsMembers || d.grant.members === undefined));
    return (asMember ? covering.find((d) => (d.grant.members ?? []).includes(asMember)) : null) ?? covering[0] ?? null;
  }

  serialise() {
    return [...this.byPerson.entries()];
  }

  /** @param {unknown} rows */
  restore(rows) {
    this.byPerson.clear();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !Array.isArray(row[1])) continue;
      for (const d of row[1]) this.put(row[0], d);
    }
  }
}
