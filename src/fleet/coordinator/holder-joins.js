// A pool's own machine asking to join, kept until its owner answers.
// docs/hypervisors.md, "A machine of its own"; the proof is in
// src/fleet/protocol/holder-join.js.
//
// A RESERVATION is made when the box running a policy job is about to clone
// the machine (core.js, #onHolderPin): the name the coordinator chose, whose
// it is and which Xen Orchestra it holds, for a day. A day rather than the ten
// minutes a pin lasts, because the pin running out before the first boot
// finished is how a holder sat outside the fleet for good.
//
// A REQUEST is the machine asking under that name with the key it made and a
// proof only the person's phone can check. Anyone can send one, since the
// machine has no credential yet, so a request is taken only for a name
// reserved and not yet joined, and only the latest few are kept per name: a
// stranger who learned the name can add rubbish beside the real request, which
// the phone shows as not proven, but cannot push the real one out.
//
// APPROVING is the owner's, on the phone, after the phone has checked the
// proof and Face ID. Nothing here can do it on their behalf.

import { HOLDER_ID_RE, HOLDER_PROOF_RE, KEY_HASH_RE, keyHashOf } from '../protocol/holder-join.js';

/** How long a reservation waits for its machine to ask and its owner to answer. */
export const HOLDER_JOIN_TTL_MS = 24 * 60 * 60_000;
/** Reservations held at once, fleet-wide: a policy job makes at most one per pool. */
export const MAX_RESERVATIONS = 32;
/** Requests kept per name, newest first. */
export const MAX_REQUESTS = 3;

const B64_COORD_RE = /^[A-Za-z0-9_-]{43}$/;
const ADDRESS_RE = /^[A-Za-z0-9.:[\]-]{1,253}$/;

/**
 * @typedef {{ kty: 'EC', crv: 'P-256', x: string, y: string }} Jwk
 * @typedef {{ key: string, publicJwk: Jwk, proof: string, at: number }} JoinRequest
 * @typedef {{ hostId: string, owner: string, address: string, job: string|null, madeAt: number, until: number, requests: JoinRequest[] }} Reservation
 */

/** @param {unknown} jwk @returns {Jwk|null} */
export function holderKey(jwk) {
  const k = /** @type {any} */ (jwk);
  if (!k || k.kty !== 'EC' || k.crv !== 'P-256' || !B64_COORD_RE.test(String(k.x)) || !B64_COORD_RE.test(String(k.y))) return null;
  return { kty: 'EC', crv: 'P-256', x: String(k.x), y: String(k.y) };
}

export class HolderJoins {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, Reservation>} */
    this.byName = new Map();
  }

  /**
   * Hold a name for a machine about to be made.
   *
   * @param {{ hostId: string, owner: string, address: string, job?: string|null }} spec
   * @returns {Reservation|null} null when the name, owner or address is not one, or there is no room
   */
  reserve({ hostId, owner, address, job = null }) {
    this.sweep();
    if (!HOLDER_ID_RE.test(hostId) || !owner || !ADDRESS_RE.test(address)) return null;
    if (!this.byName.has(hostId) && this.byName.size >= MAX_RESERVATIONS) return null;
    /** @type {Reservation} */
    const rec = { hostId, owner: owner.toLowerCase(), address, job, madeAt: this.now(), until: this.now() + HOLDER_JOIN_TTL_MS, requests: [] };
    this.byName.set(hostId, rec);
    return rec;
  }

  /**
   * A machine asking to join under a reserved name.
   *
   * @param {unknown} body
   * @returns {Promise<{ ok: true, fresh: boolean, reservation: Reservation } | { ok: false, code: string, text: string }>}
   */
  async ask(body) {
    this.sweep();
    const b = /** @type {any} */ (body || {});
    const hostId = String(b.hostId || '');
    const publicJwk = holderKey(b.publicJwk);
    const proof = String(b.proof || '');
    if (!HOLDER_ID_RE.test(hostId) || !publicJwk || !HOLDER_PROOF_RE.test(proof)) {
      return { ok: false, code: 'bad_request', text: 'A join request names a holder, its key and its proof.' };
    }
    const rec = this.byName.get(hostId);
    if (!rec) return { ok: false, code: 'not_reserved', text: `${hostId} is not a name this fleet is waiting on. The policy job that made it ran too long ago, or it already joined.` };
    const key = await keyHashOf(publicJwk);
    const same = rec.requests.find((r) => r.key === key && r.proof === proof);
    if (same) {
      same.at = this.now();
      return { ok: true, fresh: false, reservation: rec };
    }
    rec.requests = [{ key, publicJwk, proof, at: this.now() }, ...rec.requests.filter((r) => r.key !== key)].slice(0, MAX_REQUESTS);
    return { ok: true, fresh: true, reservation: rec };
  }

  /**
   * One person's reservations, as their phone reads them.
   *
   * @param {string} owner
   */
  forOwner(owner) {
    this.sweep();
    const who = String(owner || '').toLowerCase();
    return [...this.byName.values()]
      .filter((r) => r.owner === who)
      .map((r) => ({ hostId: r.hostId, address: r.address, madeAt: r.madeAt, until: r.until, requests: r.requests.map((q) => ({ key: q.key, publicJwk: q.publicJwk, proof: q.proof, at: q.at })) }));
  }

  /**
   * The request a person is answering, if it is theirs and still waiting.
   *
   * @param {string} owner @param {string} hostId @param {string} key
   * @returns {{ ok: true, request: JoinRequest, reservation: Reservation } | { ok: false, code: string, text: string }}
   */
  find(owner, hostId, key) {
    this.sweep();
    const rec = this.byName.get(String(hostId || ''));
    if (!rec || rec.owner !== String(owner || '').toLowerCase()) {
      return { ok: false, code: 'not_found', text: `${hostId} is not waiting on you to let it join.` };
    }
    if (!KEY_HASH_RE.test(String(key || ''))) return { ok: false, code: 'bad_request', text: 'Say which of its requests you are answering, by its key.' };
    const request = rec.requests.find((r) => r.key === key);
    if (!request) return { ok: false, code: 'not_found', text: `${hostId} has not asked with that key.` };
    return { ok: true, request, reservation: rec };
  }

  /** The machine joined: its name is not waited on any more. @param {string} hostId */
  joined(hostId) {
    this.byName.delete(hostId);
  }

  /**
   * A person said no to one request. The name stays reserved, because the one
   * declined may have been a stranger's beside the real machine's.
   *
   * @param {string} owner @param {string} hostId @param {string} key
   */
  decline(owner, hostId, key) {
    const found = this.find(owner, hostId, key);
    if (!found.ok) return found;
    found.reservation.requests = found.reservation.requests.filter((r) => r.key !== key);
    return { ok: true };
  }

  /** Drop what has waited its day. */
  sweep() {
    const now = this.now();
    for (const [id, r] of this.byName) if (r.until <= now) this.byName.delete(id);
  }

  serialise() {
    this.sweep();
    return [...this.byName.values()];
  }

  /** @param {unknown} saved */
  restore(saved) {
    this.byName.clear();
    for (const r of Array.isArray(saved) ? saved.slice(0, MAX_RESERVATIONS) : []) {
      if (!r || !HOLDER_ID_RE.test(String(r.hostId)) || !r.owner || !ADDRESS_RE.test(String(r.address)) || !Number.isFinite(r.until)) continue;
      const requests = (Array.isArray(r.requests) ? r.requests : [])
        .map((/** @type {any} */ q) => ({ key: String(q?.key || ''), publicJwk: holderKey(q?.publicJwk), proof: String(q?.proof || ''), at: Number(q?.at) || 0 }))
        .filter((/** @type {{ key: string, publicJwk: Jwk|null, proof: string }} */ q) => KEY_HASH_RE.test(q.key) && q.publicJwk && HOLDER_PROOF_RE.test(q.proof))
        .slice(0, MAX_REQUESTS);
      this.byName.set(r.hostId, {
        hostId: r.hostId,
        owner: String(r.owner).toLowerCase(),
        address: String(r.address),
        job: typeof r.job === 'string' ? r.job : null,
        madeAt: Number(r.madeAt) || 0,
        until: Number(r.until),
        requests: /** @type {JoinRequest[]} */ (requests),
      });
    }
    this.sweep();
  }
}
