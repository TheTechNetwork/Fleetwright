// Which machines are in this fleet, and how each one proves it.
//
// Separate from registry.js on purpose, and the distinction is the oldest rule
// in this project: registry.js is a CACHE of what hosts report and is never the
// authority. This file is the opposite — it is the authority on which hosts
// exist at all, it is written only by enrolment and revocation, and nothing a
// host says can change it.
//
// Before this, every host presented the same AGENT_FLEET_HOST_TOKEN. That one
// string meant the fleet could not tell two machines apart, could not remove
// one without re-keying all of them, and had nothing to encrypt a secret to.
// Three separate problems with one cause: hosts had no identity.
//
// A host now has a keypair. It keeps the private half in a file only it can
// read; the coordinator keeps the public half and a name. Connecting means
// signing a challenge, so nothing reusable crosses the wire — a captured
// connection yields a signature over a nonce that will never be accepted again.

import { fingerprint, verify, signingInput } from '../crypto.js';
import { randomInt } from './random.js';

/** How long a challenge is worth answering. Generous for a slow link, far
 *  short of anything worth replaying. */
const CHALLENGE_TTL_MS = 120_000;

/**
 * @typedef {object} EnrolledHost
 * @property {string} hostId
 * @property {any} publicJwk
 * @property {string} fingerprint    short, for humans reading a list
 * @property {string|null} enrolledBy
 * @property {number} enrolledAt
 * @property {number|null} lastSeenAt
 * @property {number|null} revokedAt
 */

export class HostIdentities {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    /** @type {Map<string, EnrolledHost>} */
    this.hosts = new Map();
    /** @type {Map<string, { nonce: string, at: number }>} */
    this.challenges = new Map();
    this.now = now;
  }

  /**
   * Admit a machine.
   *
   * The host chooses its own id, which is its hostname — a name a person
   * already uses for that box beats one the coordinator invents, and this is
   * the identifier that appears in every log line and every session record.
   * Enrolling a name that exists REPLACES the key, which is what re-enrolling a
   * rebuilt machine should do; the alternative is a fleet slowly filling with
   * dead entries nobody dares delete.
   *
   * @param {{ hostId: string, publicJwk: any, enrolledBy?: string|null }} spec
   */
  async enrol({ hostId, publicJwk, enrolledBy = null }) {
    const id = String(hostId || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
      return { ok: false, error: 'a host id is letters, digits, dot, dash and underscore' };
    }
    if (!publicJwk || publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256' || !publicJwk.x || !publicJwk.y) {
      return { ok: false, error: 'expected a P-256 public key' };
    }
    // A private key arriving here is a mistake somewhere upstream, and storing
    // it would turn the coordinator into the thing it must never be.
    if (publicJwk.d) return { ok: false, error: 'that is a private key — send only the public half' };

    const previous = this.hosts.get(id);
    /** @type {EnrolledHost} */
    const host = {
      hostId: id,
      publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
      fingerprint: await fingerprint(publicJwk),
      enrolledBy,
      enrolledAt: this.now(),
      lastSeenAt: null,
      revokedAt: null,
    };
    this.hosts.set(id, host);
    return { ok: true, host, replaced: Boolean(previous && !previous.revokedAt) };
  }

  /**
   * A nonce for a host to sign.
   *
   * Issued per connection attempt and spent on use. The point is that nothing
   * a host sends can be replayed: a signature is over a value this coordinator
   * chose, moments ago, once.
   *
   * @param {string} hostId
   */
  challenge(hostId) {
    this.#sweep();
    const nonce = `${this.now().toString(36)}.${randomInt(0, 2 ** 32).toString(36)}${randomInt(0, 2 ** 32).toString(36)}`;
    this.challenges.set(hostId, { nonce, at: this.now() });
    return nonce;
  }

  /**
   * Does this signature prove the host it claims to be?
   *
   * @param {string} hostId
   * @param {string} signature
   * @returns {Promise<{ ok: true, host: EnrolledHost } | { ok: false, reason: string }>}
   */
  async prove(hostId, signature) {
    this.#sweep();
    const host = this.hosts.get(String(hostId || ''));
    if (!host) return { ok: false, reason: 'that host is not enrolled' };
    if (host.revokedAt) return { ok: false, reason: 'that host has been revoked' };

    const challenge = this.challenges.get(host.hostId);
    if (!challenge) return { ok: false, reason: 'no challenge is outstanding — ask for one first' };
    // Spent whether or not it verifies. A nonce that survives a failed attempt
    // is a nonce somebody can grind against.
    this.challenges.delete(host.hostId);

    const ok = await verify(host.publicJwk, signature, signingInput('host-connect', { hostId: host.hostId, nonce: challenge.nonce }));
    if (!ok) return { ok: false, reason: 'the signature does not match the enrolled key' };

    host.lastSeenAt = this.now();
    return { ok: true, host };
  }

  /**
   * Remove a machine from the fleet.
   *
   * Marked rather than deleted: a revoked host that reconnects should be told
   * it was revoked, and an entry that simply vanishes reads as "never enrolled",
   * which sends somebody to re-enrol the machine they just removed.
   *
   * @param {string} hostId
   */
  revoke(hostId) {
    const host = this.hosts.get(String(hostId || ''));
    if (!host || host.revokedAt) return false;
    host.revokedAt = this.now();
    this.challenges.delete(host.hostId);
    return true;
  }

  /** Without keys — this is what a person reads. */
  list() {
    return [...this.hosts.values()]
      .map(({ publicJwk, ...rest }) => rest)
      .sort((a, b) => b.enrolledAt - a.enrolledAt);
  }

  /** @param {EnrolledHost[]} hosts */
  restore(hosts) {
    for (const h of hosts || []) if (h?.hostId) this.hosts.set(h.hostId, h);
  }

  serialise() {
    return [...this.hosts.values()];
  }

  #sweep() {
    const cutoff = this.now() - CHALLENGE_TTL_MS;
    for (const [id, c] of this.challenges) if (c.at < cutoff) this.challenges.delete(id);
  }
}
