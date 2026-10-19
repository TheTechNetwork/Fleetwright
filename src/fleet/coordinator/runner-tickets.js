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
// held for minutes instead of for ever. Nor does the starter's Claude login go
// with a runner attributed to somebody else: the minter gives one only to the
// runner of the fleet account that deposited it (src/fleet/minter/claude.js).
// Their repository reach does, because the minting Worker mints a ticket's
// runner for whoever started its job (CoordinatorCore#onRunnerMint): the
// spender's own, lent by their own act, to a runner only its owner can use.
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
/**
 * Spent tickets remembered, for the ones redeemed with `remember` (a
 * machine's, core.js enrolVm). A second presentation of one of these is not
 * a typo or a slow job: the value was read by two parties, so it is told
 * apart from "unknown" and said (`spentFor`). Kept until the ticket would
 * have expired, which is as long as anybody could have spent it, and the
 * oldest goes first past the cap, as an unclaimed ticket's memory does.
 */
const MAX_SPENT = 100;
/** And per person, so one person's dispatches are only ever paid for by their own. */
const MAX_TICKETS_PER_OWNER = 20;
/** What a person is told when the fleet-wide backstop refuses their ticket. */
export const TICKETS_FULL = 'This fleet is waiting on as many new machines as it can keep track of. Try again in a few minutes.';

export const TICKET_PREFIX = 'fwt';

const ID_BYTES = 6;
const SECRET_BYTES = 24;

/** @param {Uint8Array} bytes */
function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {number} n */
export function randomHex(n) {
  return hex(crypto.getRandomValues(new Uint8Array(n)));
}

/**
 * SHA-256, and deliberately not a password hash: a ticket is 24 random bytes,
 * so there is nothing to brute-force and nothing a slow KDF would protect.
 * Same reasoning, same function, as clients.js.
 *
 * @param {string} secret
 */
export async function hashSecret(secret) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))));
}

/** @param {string} a @param {string} b */
export function constantTimeEqual(a, b) {
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
 * @property {string} platform   what was asked for — the audit line, and since
 *   a runner can come from a person's own repository, which workflow file in
 *   it may admit the job
 * @property {string|null} [repository]  where the run was dispatched, as GitHub
 *   spells it. Binds the ticket to that repository: a job from anywhere else
 *   presenting it is refused, and a repository nobody put on the operator's
 *   allowlist can admit a machine ONLY with a ticket naming it. Absent on a
 *   ticket minted before this existed, which binds nothing, as before
 * @property {{ title?: string, brief?: string, mode?: string, task?: string }|null} [start]
 *   a session to start on the runner once it joins, for the person who asked:
 *   its task, prose and a mode. A runner has no task profiles and no secrets
 *   of its own, so a ticket cannot carry a reference to either
 * @property {number} mintedAt
 * @property {number} expiresAt
 */

/**
 * @typedef {{ id: string, secretHash: string, owner: string, platform: string, spentAt: number, expiresAt: number }} Spent
 */

export class RunnerTickets {
  /** @param {{ now?: () => number, ttlMs?: number }} [opts] */
  constructor({ now = () => Date.now(), ttlMs = TICKET_TTL_MS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    /** @type {Map<string, Ticket>} */
    this.tickets = new Map();
    /** Spent with `remember`, by id, until each would have expired. @type {Map<string, Spent>} */
    this.spent = new Map();
  }

  /**
   * Mint one for a dispatch that is about to happen.
   *
   * @param {{ owner: string, platform: string, repository?: string|null, start?: Ticket['start'], ttlMs?: number }} spec
   *   `ttlMs` shorter than the default for a ticket whose spender is known to
   *   be quick: a machine on somebody's pool, which spends it as it boots
   * @returns {Promise<{ id: string, token: string, expiresAt: number } | null>}
   *   null when the fleet holds as many tickets as it can, none of them this person's
   */
  async mint({ owner, platform, repository = null, start = null, ttlMs }) {
    this.#sweep();
    // A PERSON'S OWN OLDEST TICKET MAKES ROOM FOR THEIR NEXT, AND NOBODY
    // ELSE'S EVER DOES. This used to drop the fleet's oldest ticket whoever
    // held it, under a comment saying that stopped a flood of abandoned
    // dispatches evicting a live ticket; it did the opposite, and a member
    // minting two hundred dispatches pushed out every job on its way to
    // enrol. The fleet-wide cap is the storage backstop behind the per-person
    // one, and it refuses rather than evicting somebody else's.
    const who = String(owner || '').toLowerCase();
    const mine = [...this.tickets.values()].filter((t) => t.owner === who);
    if (mine.length >= MAX_TICKETS_PER_OWNER) this.tickets.delete(mine[0].id);
    else if (this.tickets.size >= MAX_TICKETS) return null;
    const id = randomHex(ID_BYTES);
    const secret = randomHex(SECRET_BYTES);
    const expiresAt = this.now() + Math.min(this.ttlMs, Number(ttlMs) > 0 ? Number(ttlMs) : this.ttlMs);
    this.tickets.set(id, {
      id,
      secretHash: await hashSecret(secret),
      owner: who,
      platform: String(platform || ''),
      repository: repository ? String(repository) : null,
      start: start && typeof start === 'object' ? { ...start } : null,
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
   * REMEMBER, for a ticket that travels where somebody else might read it
   * before its spender does (a machine's cloud-init drive): the spending is
   * kept, hash and all, until the ticket would have expired, so a second
   * presentation can be recognised for what it is (`spentFor`).
   *
   * @param {unknown} token
   * @param {{ remember?: boolean }} [opts]
   * @returns {Promise<Ticket|null>}
   */
  async redeem(token, { remember = false } = {}) {
    const found = await this.peek(token);
    if (!found) return null;
    // Deleted before the caller does anything with it. A redemption that fails
    // downstream must not leave the ticket spendable, because the safe failure
    // is "ask for another runner" and the unsafe one is "try it again".
    this.tickets.delete(found.id);
    if (remember) {
      while (this.spent.size >= MAX_SPENT) {
        const oldest = this.spent.keys().next().value;
        if (oldest === undefined) break;
        this.spent.delete(oldest);
      }
      const { id, secretHash, owner, platform, expiresAt } = found;
      this.spent.set(id, { id, secretHash, owner, platform, spentAt: this.now(), expiresAt });
    }
    return found;
  }

  /**
   * A ticket redeemed with `remember` and presented again: the whole value,
   * secret and all, so whoever holds it read it where it travelled. Null for
   * anything else, including the id alone with a wrong secret, because the
   * id is a machine's name and not a secret (`vm-<id>`).
   *
   * @param {unknown} token
   * @returns {Promise<Spent|null>}
   */
  async spentFor(token) {
    this.#sweep();
    const raw = typeof token === 'string' ? token : '';
    const parts = raw.split('_');
    if (parts.length !== 3 || parts[0] !== TICKET_PREFIX) return null;
    const found = this.spent.get(parts[1]);
    if (!found) return null;
    if (!constantTimeEqual(found.secretHash, await hashSecret(parts[2]))) return null;
    return found;
  }

  /**
   * Look at one without spending it. The same checks as redeem — unknown,
   * expired and wrong all answer null — and nothing is consumed.
   *
   * WHY THIS EXISTS: which repositories may admit a job has to be decided
   * BEFORE GitHub's token is verified, because verification is against that
   * list, and a ticket for somebody's own repository is what puts that
   * repository on it. Spending the ticket first would burn it on a job whose
   * token then fails; the enrolment route peeks, verifies, and only then
   * redeems.
   *
   * @param {unknown} token
   * @returns {Promise<Ticket|null>}
   */
  async peek(token) {
    this.#sweep();
    const raw = typeof token === 'string' ? token : '';
    const parts = raw.split('_');
    if (parts.length !== 3 || parts[0] !== TICKET_PREFIX) return null;
    const found = this.tickets.get(parts[1]);
    if (!found) return null;
    if (!constantTimeEqual(found.secretHash, await hashSecret(parts[2]))) return null;
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
    // THE SPENT ONES IN THE SAME LIST, marked, so the storage key and its
    // shape stay what they were: a spending forgotten by an eviction would
    // make the drive's second reader an unknown ticket again.
    return [...this.tickets.values(), ...[...this.spent.values()].map((t) => ({ ...t, spent: true }))];
  }

  /** @param {Array<Ticket|(Spent & { spent: true })>} entries */
  restore(entries) {
    for (const t of entries || []) {
      if (!(t?.id && t.secretHash && t.expiresAt > this.now())) continue;
      if ('spent' in t && t.spent === true) {
        const { id, secretHash, owner, platform, spentAt, expiresAt } = /** @type {Spent} */ (t);
        this.spent.set(id, { id, secretHash, owner, platform, spentAt, expiresAt });
      } else this.tickets.set(t.id, /** @type {Ticket} */ (t));
    }
  }

  #sweep() {
    const now = this.now();
    for (const [id, t] of this.tickets) if (t.expiresAt <= now) this.tickets.delete(id);
    for (const [id, t] of this.spent) if (t.expiresAt <= now) this.spent.delete(id);
  }
}
