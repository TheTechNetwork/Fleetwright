// An ID token is exchanged once.
//
// `POST /api/session` takes an identity token from Apple or Google and hands
// back a device credential. The token is verified — signature, issuer,
// audience, expiry, allowlist — and until now nothing remembered having seen
// it. A token lives ten minutes at Apple and an hour at Google, and inside that
// window one that had been captured anywhere along the way could be presented
// again and mint a SECOND credential for the same person: a phone the admin
// did not know about, in the device list under a name the attacker chose.
//
// docs/identity.md says the ID token "is used once, to obtain a credential",
// and this is what makes that sentence true rather than descriptive. Each
// token's hash is kept until the token itself would have expired, and a second
// presentation is refused by name.
//
// WHAT THIS IS NOT. It is not the OIDC nonce, which binds a token to the
// sign-in attempt that asked for it and would refuse a captured token even on
// its FIRST presentation here. That needs both apps and the sign-in page to
// mint a value, carry it through two providers with two conventions, and send
// it back — identity.md records why it waits. This closes the half that needs
// no client at all: a token that has already bought a credential buys nothing
// more, on either coordinator, across a restart.
//
// THE HASH, NOT THE TOKEN. A token in the state file is a token in a backup,
// and the point of this store is that a token seen once is worthless — which
// is only true if seeing the store is not seeing the token.

/**
 * Nothing in this table is worth more than a few kilobytes: sign-in is rate
 * limited per address, and a token evicts itself when it expires. The cap is
 * for a coordinator that is being flooded through the limiter anyway, where
 * forgetting the OLDEST token — the one closest to expiring on its own — is
 * the least that can be lost.
 */
const MAX_SPENT = 5000;

/**
 * A ceiling on how long an entry is kept, in case a provider ever issues a
 * token with a distant `exp`: the table must not be made to remember one for
 * a year on the token's say-so.
 */
const MAX_TTL_MS = 24 * 3_600_000;

export class SpentTokens {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** Hash of the token → when it can be forgotten. Insertion-ordered, so
     *  the oldest is first. @type {Map<string, number>} */
    this.spent = new Map();
  }

  /**
   * Spend a token. True the first time, false on every presentation after.
   *
   * @param {string} token       the raw ID token as presented
   * @param {number} expiresAt   when the token itself expires, ms since epoch
   * @returns {Promise<boolean>}
   */
  async spend(token, expiresAt) {
    this.#sweep();
    const hash = await digest(String(token || ''));
    if (this.spent.has(hash)) return false;
    while (this.spent.size >= MAX_SPENT) {
      const oldest = this.spent.keys().next().value;
      if (oldest === undefined) break;
      this.spent.delete(oldest);
    }
    const until = Math.min(Number(expiresAt) || this.now(), this.now() + MAX_TTL_MS);
    // An already-expired token would not have verified, so `until` in the
    // past means a caller passed nothing; keep it for the maximum window rather
    // than for no time at all.
    this.spent.set(hash, until > this.now() ? until : this.now() + MAX_TTL_MS);
    return true;
  }

  /**
   * What to write down. Expired entries are dropped on the way out, so the
   * file never carries a hash the coordinator would ignore on the way back in.
   * @returns {Array<{ hash: string, until: number }>}
   */
  serialise() {
    this.#sweep();
    return [...this.spent].map(([hash, until]) => ({ hash, until }));
  }

  /** @param {Array<{ hash: string, until: number }>} entries */
  restore(entries) {
    const now = this.now();
    for (const e of entries || []) {
      if (typeof e?.hash === 'string' && e.hash && Number(e.until) > now) this.spent.set(e.hash, Number(e.until));
    }
  }

  #sweep() {
    const now = this.now();
    for (const [hash, until] of this.spent) if (until <= now) this.spent.delete(hash);
  }
}

/** @param {string} s */
async function digest(s) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
