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

// NONCES ARE NOT STORED. They are minted, and the coordinator recognises its own.
//
// They were stored, in a ring of eight per host, and that was wrong in a way
// that took a reproduction to see. The challenge endpoint cannot be
// authenticated — asking for a nonce is what an unauthenticated party does in
// order to authenticate — so anybody could ask for one, and every ask pushed
// an entry into the ring of whichever host id they named. Nine asks evicted the
// nonce an honest host was in the middle of signing. The machine then failed
// its handshake, retried, and was evicted again, for as long as the flood
// lasted; and because the eviction is indistinguishable from a bad answer, it
// was told "the signature does not match the enrolled key" — which sends an
// operator to re-key a machine whose key is perfectly good.
//
// A ring made that cost nine requests instead of one. It did not make it
// impossible, and the comment claiming it did was wrong.
//
// So: a nonce carries its own proof that we issued it. `<issuedAt>.<random>.<mac>`,
// where the mac is HMAC-SHA-256 over the first two parts and the host id, under
// a secret this coordinator generates and keeps. Verifying is recomputing it.
// There is no per-host state, so there is nothing to evict, nothing to grow,
// and no index into an array to go stale across an await.
//
// Replay still has to be stopped, and that DOES need memory — but only of
// nonces that were actually SPENT, which requires the private key. An attacker
// cannot make that set grow; only real hosts connecting can, and they connect
// on the order of once a minute.
const NONCE_SECRET_BYTES = 32;

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
    /** Nonces that have been SPENT, and when. Bounded by real connections,
     *  because getting into it requires a valid signature. */
    /** @type {Map<string, number>} */
    this.spent = new Map();
    /** The key this coordinator recognises its own nonces by, as a promise so
     *  it is made once. Regenerated if lost, which invalidates outstanding
     *  challenges — harmless, because a host asks for a new one on its next
     *  dial. */
    /** @type {Promise<CryptoKey>|null} */
    this.nonceSecret = null;
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
  async challenge(hostId) {
    this.#sweep();
    const id = String(hostId || '');
    const issuedAt = this.now();
    const random = `${randomInt(0, 2 ** 32).toString(36)}${randomInt(0, 2 ** 32).toString(36)}`;
    // Issued to ANYONE, for any name, and it costs this coordinator nothing to
    // do so: there is no entry to make. A nonce for a host that does not exist
    // is useless, because nothing can produce a signature over it that will
    // verify — and refusing one would answer "does this host exist" to whoever
    // asked.
    return `${issuedAt.toString(36)}.${random}.${await this.#mac(issuedAt, random, id)}`;
  }

  /** The signing key, made once and kept. @returns {Promise<CryptoKey>} */
  async #secret() {
    if (!this.nonceSecret) {
      this.nonceSecret = crypto.subtle.importKey(
        'raw',
        crypto.getRandomValues(new Uint8Array(NONCE_SECRET_BYTES)),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
    }
    return this.nonceSecret;
  }

  /** @param {number} issuedAt @param {string} random @param {string} hostId */
  async #mac(issuedAt, random, hostId) {
    return hmac(await this.#secret(), `${issuedAt.toString(36)}.${random}.${hostId}`);
  }

  /**
   * Is this a nonce we issued, for this host, recently, and unspent?
   *
   * @param {string} nonce
   * @param {string} hostId
   */
  async #nonceState(nonce, hostId) {
    const parts = String(nonce || '').split('.');
    if (parts.length !== 3) return 'malformed';
    const [stamp, random, mac] = parts;
    const issuedAt = parseInt(stamp, 36);
    if (!Number.isFinite(issuedAt)) return 'malformed';
    // Constant-time-ish: compare the whole string rather than short-circuiting
    // on the first differing character. There is nothing to learn from the
    // timing of a mac that is not ours, but it costs nothing to not leak it.
    if (!equalStrings(mac, await this.#mac(issuedAt, random, hostId))) return 'not-ours';
    if (this.now() - issuedAt > CHALLENGE_TTL_MS) return 'expired';
    if (this.spent.has(nonce)) return 'spent';
    return 'live';
  }

  /**
   * Does this signature prove the host it claims to be?
   *
   * @param {string} hostId
   * @param {string} signature
   * @param {string} presentedNonce the challenge this signature answers
   * @returns {Promise<{ ok: true, host: EnrolledHost } | { ok: false, reason: string }>}
   */
  async prove(hostId, signature, presentedNonce) {
    this.#sweep();
    const host = this.hosts.get(String(hostId || ''));
    if (!host) return { ok: false, reason: 'that host is not enrolled' };
    if (host.revokedAt) return { ok: false, reason: 'that host has been revoked' };

    // The nonce comes back WITH the proof now, rather than being looked up.
    // The host has it — it was just handed to them — and carrying it means the
    // coordinator holds no per-host state that a stranger can churn.
    const nonce = String(presentedNonce || '');
    const state = await this.#nonceState(nonce, host.hostId);
    if (state === 'malformed' || state === 'not-ours') {
      return { ok: false, reason: 'that challenge was not issued by this coordinator — ask for one first' };
    }
    if (state === 'expired') return { ok: false, reason: 'that challenge has expired — ask for another' };
    if (state === 'spent') return { ok: false, reason: 'that challenge has already been used' };

    const ok = await verify(
      host.publicJwk,
      signature,
      signingInput('host-connect', { hostId: host.hostId, nonce }),
    );
    if (!ok) return { ok: false, reason: 'the signature does not match the enrolled key' };

    // Spent only on SUCCESS, so a wrong answer costs an attacker nothing to
    // make and gains them nothing either — and the set only grows for parties
    // holding the private key.
    this.spent.set(nonce, this.now());

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
    // A spent nonce only has to be remembered until it would expire anyway.
    const cutoff = this.now() - CHALLENGE_TTL_MS;
    for (const [nonce, at] of this.spent) if (at < cutoff) this.spent.delete(nonce);
  }
}

/**
 * HMAC-SHA-256, hex, through WebCrypto.
 *
 * NOT node:crypto's createHmac, which would have been synchronous and simpler
 * and would also have broken the Worker — this file is shared verbatim with it,
 * and the rule that the coordinator core imports nothing from `node:` is the
 * only reason there is one implementation rather than two.
 *
 * @param {CryptoKey} key @param {string} message
 */
async function hmac(key, message) {
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Length-safe comparison that does not stop at the first difference.
 *  @param {string} a @param {string} b */
function equalStrings(a, b) {
  const as = String(a);
  const bs = String(b);
  if (as.length !== bs.length) return false;
  let diff = 0;
  for (let i = 0; i < as.length; i++) diff |= as.charCodeAt(i) ^ bs.charCodeAt(i);
  return diff === 0;
}
