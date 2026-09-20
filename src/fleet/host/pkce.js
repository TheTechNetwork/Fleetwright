// PKCE, RFC 7636: the verifier this host keeps and the challenge it lets out.
//
// WHAT IT BUYS, in one sentence from docs/recommendations-review.md §4: the
// coordinator relays every authorization and used to perform the exchange, so
// a compromised coordinator saw the access and refresh tokens at link time;
// with the verifier here and only the challenge on the authorize URL, a
// coordinator that captured the code cannot spend it, even though it holds
// the client secret. The exchange moves to this host, which already holds the
// secret for renewal (github-app.md), so custody does not change — only what
// the middle sees.
//
// The verifier is 32 random bytes, base64url, which is 43 characters: inside
// RFC 7636's 43–128 and made of exactly its unreserved set. The challenge is
// S256 — the only method worth offering, since `plain` gives the relay the
// verifier back.

import { createHash, randomBytes } from 'node:crypto';

/** A fresh verifier. Kept on this host, spent once, never on the wire. */
export function newVerifier() {
  return randomBytes(32).toString('base64url');
}

/**
 * The S256 challenge for a verifier: what the authorize URL carries.
 * @param {string} verifier
 */
export function challengeFor(verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** What a challenge looks like on the way OUT of a host and INTO a URL, so a
 * coordinator can refuse anything else before it builds a URL around it. */
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

/** Ten minutes, the same window the coordinator gives a `state`, and for the
 * same reason: longer than anybody takes to press Authorize, shorter than a
 * verifier should sit in memory for. */
export const VERIFIER_TTL_MS = 10 * 60_000;

/**
 * The verifiers a host is holding, one per provider per person, each spent
 * exactly once. Mirrors the coordinator's PendingAuthorizations for `state`:
 * single-use, short-lived, bounded.
 */
export class PendingVerifiers {
  /** @param {{ now?: () => number, ttlMs?: number }} [opts] */
  constructor({ now = () => Date.now(), ttlMs = VERIFIER_TTL_MS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    /** @type {Map<string, { verifier: string, at: number }>} */
    this.pending = new Map();
  }

  /** @param {string} provider @param {string|null} who */
  static key(provider, who) {
    return `${provider}:${who || 'host'}`;
  }

  sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, rec] of this.pending) if (rec.at <= cutoff) this.pending.delete(key);
  }

  /**
   * Mint a verifier for one provider and one person, returning the challenge.
   * A second `connect` before the first is spent replaces it: the newer URL
   * is the one the person is looking at.
   * @param {string} provider @param {string|null} who
   */
  mint(provider, who) {
    this.sweep();
    const verifier = newVerifier();
    this.pending.set(PendingVerifiers.key(provider, who), { verifier, at: this.now() });
    return challengeFor(verifier);
  }

  /**
   * Take the verifier back, once. Null when there is none, it expired, or it
   * was already spent — one answer for all three, because which of them it
   * was is not something the caller needs to act on differently.
   * @param {string} provider @param {string|null} who
   */
  spend(provider, who) {
    this.sweep();
    const key = PendingVerifiers.key(provider, who);
    const found = this.pending.get(key);
    if (!found) return null;
    this.pending.delete(key);
    return found.verifier;
  }
}
