// Whose runner this is, decided before the runner exists.
//
// A ticket is minted when somebody asks for a machine and spent when the job
// that machine runs on enrols itself. It answers one question — WHO ASKED —
// and it answers nothing else: it does not admit a host, does not authenticate
// a request, and buys nothing at all on its own. GitHub's OIDC token is what
// admits the machine, cryptographically, before a ticket is looked at.
//
// WHY THIS EXISTS WHEN `FLEETWRIGHT_RUNNER_TOKEN` ALREADY DID.
//
// That token is reusable on purpose: it lives in a repository or organisation
// secret and is spent on every run, because nothing was dispatching runs on a
// person's behalf and the workflow had to be able to say whose runner it was
// with whatever it had been given once. It works, and it is kept.
//
// It also means one value in one secret decides who every runner from that
// repository belongs to. The moment the fleet dispatches the run ITSELF, it
// already knows who asked — before the job exists — and a stored reusable
// secret is a worse answer to a question that has just become easy. So a
// dispatch mints one of these instead:
//
//   SINGLE USE     redeemed once, gone. A second job presenting it is refused,
//                  which also means two runners can never share an owner record
//                  by sharing a value out of a log
//   SHORT LIVED    a queued job has to reach its enrol step; an abandoned
//                  dispatch must not leave a live attribution lying around
//   BOUND          to the verified person the coordinator resolved at dispatch
//                  time, never to anything the job says about itself
//
// WHAT A LEAKED ONE COSTS, precisely, because it travels as a workflow input
// and workflow inputs are readable by anybody who can read the run. Somebody
// who can already start a job in an allowlisted repository could have that
// job's runner attributed to the person who asked for a different one. They
// cannot admit a machine (the OIDC token does that), cannot call the API as
// anybody, and cannot use the runner — placement gives an ephemeral host to its
// owner. The cost is "a fleet member is given a free machine they did not ask
// for", once, within the window. That is the same bound the reusable claim has,
// held for minutes instead of for ever.
//
// Not stored in full, for the same reason a device credential is not: the hash
// is enough to recognise the one value that matters, and a store that can hand
// a ticket back is a store that can be made to.

/** How long a ticket lives.
 *
 * Long enough for a queued job to reach its enrol step — a macOS runner can sit
 * in a queue for several minutes before it starts, and a ticket that expires
 * while GitHub is still finding hardware turns a slow morning into an
 * unattributed host. Short enough that an abandoned dispatch does not leave a
 * live attribution lying around all afternoon. */
const TICKET_TTL_MS = 45 * 60_000;

/** Bounded, because an unclaimed dispatch costs memory until it expires. */
const MAX_TICKETS = 200;

export const TICKET_PREFIX = 'fwt';

const ID_BYTES = 6;
const SECRET_BYTES = 24;

/** @param {Uint8Array} bytes */
function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {number} n */
function randomHex(n) {
  return hex(crypto.getRandomValues(new Uint8Array(n)));
}

/**
 * SHA-256, and deliberately not a password hash: a ticket is 24 random bytes,
 * so there is nothing to brute-force and nothing a slow KDF would protect.
 * Same reasoning, same function, as clients.js.
 *
 * @param {string} secret
 */
async function hashSecret(secret) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))));
}

/** @param {string} a @param {string} b */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * @typedef {object} Ticket
 * @property {string} id
 * @property {string} secretHash
 * @property {string} owner      the verified email this runner will belong to
 * @property {string} platform   what was asked for, for the audit line
 * @property {number} mintedAt
 * @property {number} expiresAt
 */

export class RunnerTickets {
  /** @param {{ now?: () => number, ttlMs?: number }} [opts] */
  constructor({ now = () => Date.now(), ttlMs = TICKET_TTL_MS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    /** @type {Map<string, Ticket>} */
    this.tickets = new Map();
  }

  /**
   * Mint one for a dispatch that is about to happen.
   *
   * @param {{ owner: string, platform: string }} spec
   * @returns {Promise<{ id: string, token: string, expiresAt: number }>}
   */
  async mint({ owner, platform }) {
    this.#sweep();
    // Oldest first, so a flood of abandoned dispatches cannot evict a live
    // ticket somebody's job is on its way to spend.
    while (this.tickets.size >= MAX_TICKETS) {
      const oldest = this.tickets.keys().next().value;
      if (oldest === undefined) break;
      this.tickets.delete(oldest);
    }
    const id = randomHex(ID_BYTES);
    const secret = randomHex(SECRET_BYTES);
    const expiresAt = this.now() + this.ttlMs;
    this.tickets.set(id, {
      id,
      secretHash: await hashSecret(secret),
      owner: String(owner || '').toLowerCase(),
      platform: String(platform || ''),
      mintedAt: this.now(),
      expiresAt,
    });
    return { id, token: `${TICKET_PREFIX}_${id}_${secret}`, expiresAt };
  }

  /** Does this value even claim to be one? Checked before the runner-token
   * registry is asked, so the two credentials cannot be confused for each
   * other by a typo in either direction.
   * @param {unknown} token */
  static looksLikeTicket(token) {
    return typeof token === 'string' && token.startsWith(`${TICKET_PREFIX}_`);
  }

  /**
   * Spend one. Null for unknown, expired, replayed or malformed — the caller
   * turns that into one sentence, because a job reading it cannot act on the
   * difference and an attacker should not be told which it was.
   *
   * @param {unknown} token
   * @returns {Promise<Ticket|null>}
   */
  async redeem(token) {
    this.#sweep();
    const raw = typeof token === 'string' ? token : '';
    const parts = raw.split('_');
    if (parts.length !== 3 || parts[0] !== TICKET_PREFIX) return null;
    const found = this.tickets.get(parts[1]);
    if (!found) return null;
    if (found.expiresAt <= this.now()) {
      this.tickets.delete(found.id);
      return null;
    }
    if (!constantTimeEqual(found.secretHash, await hashSecret(parts[2]))) return null;
    // Deleted before the caller does anything with it. A redemption that fails
    // downstream must not leave the ticket spendable, because the safe failure
    // is "ask for another runner" and the unsafe one is "try it again".
    this.tickets.delete(found.id);
    return found;
  }

  /**
   * Tickets survive a restart, for the same reason enrolment codes do: a
   * coordinator can be evicted between dispatching a run and that run reaching
   * its enrol step, and a ticket that silently stops working because the
   * coordinator went to sleep is indistinguishable from one that was never
   * minted. The TTL still applies on the way back in.
   */
  serialise() {
    this.#sweep();
    return [...this.tickets.values()];
  }

  /** @param {Ticket[]} entries */
  restore(entries) {
    for (const t of entries || []) {
      if (t?.id && t.secretHash && t.expiresAt > this.now()) this.tickets.set(t.id, t);
    }
  }

  #sweep() {
    const now = this.now();
    for (const [id, t] of this.tickets) if (t.expiresAt <= now) this.tickets.delete(id);
  }
}
