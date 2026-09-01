// Who is asking, and how to stop them.
//
// The coordinator had one API token. Every phone shared it, which meant three
// things that only look small while there is one phone:
//
//   REVOCATION      losing a phone meant rotating the token and re-entering it
//                   on every other device, so in practice nobody would
//   ATTRIBUTION     `createdBy` on a session read "web", because there was
//                   nothing better to write. Two people, one identity
//   SCOPE           an app that can list sessions can also stop every one of
//                   them, forever, because there is only one level
//
// A client is a credential issued to one device. It can be revoked on its own,
// it names who holds it, and every intent it sends carries that name through to
// the session record.
//
// TOKENS ARE STORED HASHED. A coordinator's storage is not a place to keep
// bearer credentials in plain text: anything that can read the Durable Object
// — a bug, a backup, a support session — would otherwise walk away with every
// phone's access. The token exists in full exactly once, in the response that
// mints it.

/** `fwk_<id>_<secret>`: the id makes lookup O(1), the secret is what is proven. */
const PREFIX = 'fwk';

/**
 * A SECOND KIND OF TOKEN, in a separate store rather than a flag on this one.
 *
 * Runner tokens live in their own ClientRegistry instance with their own
 * prefix. They could have been a `kind` field here, which is less code — and
 * one forgotten check away from a token that grants nothing becoming a
 * credential that grants everything. The authenticator only ever consults the
 * device store, so a runner token is structurally incapable of authenticating
 * rather than merely refused. That difference is the whole reason for the
 * duplication.
 */
export const RUNNER_PREFIX = 'fwr';
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
 * SHA-256 of the secret. Not a password hash, and deliberately not one: a
 * token is 24 random bytes, so there is nothing to brute-force and nothing for
 * a slow KDF to protect. Argon2 here would be cargo cult.
 *
 * @param {string} secret
 */
export async function hashSecret(secret) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))));
}

/** @param {string} a @param {string} b */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * @typedef {object} Client
 * @property {string} id
 * @property {string} name        what a person calls this device
 * @property {string} secretHash
 * @property {number} createdAt
 * @property {number|null} lastSeenAt
 * @property {number|null} revokedAt
 * @property {string} [email]     the verified address this was issued to
 * @property {boolean} [admin]    may this credential remove machines and other
 *                                people's devices
 */

export class ClientRegistry {
  /** @param {{ now?: () => number, prefix?: string }} [opts] */
  constructor({ now = () => Date.now(), prefix = PREFIX } = {}) {
    this.prefix = prefix;
    /** @type {Map<string, Client>} */
    this.clients = new Map();
    this.now = now;
  }

  /**
   * Mint a credential for one device.
   *
   * The token is returned once and never stored, so this is the only moment it
   * exists in full. Losing it means issuing another, which is the correct cost
   * — a coordinator that can tell you an existing token is a coordinator that
   * can be made to.
   *
   * @param {string} name
   * @param {{ admin?: boolean }} [opts]
   * @returns {Promise<{ client: Client, token: string }>}
   */
  async issue(name, { admin = false } = {}) {
    const id = randomHex(ID_BYTES);
    const secret = randomHex(SECRET_BYTES);
    /** @type {Client} */
    const client = {
      id,
      name: String(name || '').slice(0, 60) || 'unnamed device',
      secretHash: await hashSecret(secret),
      createdAt: this.now(),
      lastSeenAt: null,
      revokedAt: null,
      admin,
    };
    this.clients.set(id, client);
    return { client, token: `${this.prefix}_${id}_${secret}` };
  }

  /**
   * The client this token belongs to, or null.
   *
   * Returns null for a revoked client rather than throwing: from the caller's
   * side "revoked" and "never existed" should be the same answer, or the 401
   * becomes an oracle for which tokens used to be real.
   *
   * @param {string} token
   * @returns {Promise<Client|null>}
   */
  async verify(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('_');
    if (parts.length !== 3 || parts[0] !== this.prefix) return null;
    const [, id, secret] = parts;

    const client = this.clients.get(id);
    if (!client || client.revokedAt) return null;
    if (!timingSafeEqual(await hashSecret(secret), client.secretHash)) return null;

    client.lastSeenAt = this.now();
    return client;
  }

  /**
   * Revoke one credential, leaving every other device alone. That is the whole
   * point of there being more than one.
   *
   * @param {string} id
   */
  revoke(id) {
    const client = this.clients.get(id);
    if (!client || client.revokedAt) return false;
    client.revokedAt = this.now();
    return true;
  }

  /** Is anybody an admin yet? The first person to sign in becomes one. */
  hasAdmin() {
    return [...this.clients.values()].some((c) => c.admin && !c.revokedAt);
  }

  /**
   * Has the admin seat EVER been assigned, on any row, revoked or not?
   *
   * This is what the first-person-in rule must consult — not hasAdmin(). With
   * hasAdmin(), revoking the owner's lost phone reopened the founding moment:
   * the next person to sign in, whoever they were, inherited the fleet. The
   * founding of a fleet happens once.
   */
  everHadAdmin() {
    return [...this.clients.values()].some((c) => c.admin);
  }

  /**
   * Does this verified email hold admin anywhere — on ANY row, revoked or not?
   *
   * Revoked rows count, deliberately: revocation is for lost devices, and a
   * person whose every phone was revoked is still the person. Demotion is a
   * different act — removal from the allowlist — after which they cannot sign
   * in and this is never consulted.
   *
   * @param {string} email
   */
  emailHasAdmin(email) {
    const wanted = String(email || '').toLowerCase().trim();
    if (!wanted) return false;
    return [...this.clients.values()].some((c) => c.admin && String(c.email || '').toLowerCase() === wanted);
  }

  /** Without secrets, obviously — this is what an app renders. */
  list() {
    return [...this.clients.values()]
      .map(({ secretHash, ...rest }) => rest)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** @param {Client[]} clients */
  restore(clients) {
    for (const c of clients || []) if (c?.id) this.clients.set(c.id, c);
  }

  /** For persistence. Includes the hashes, which is what makes them worth hashing. */
  serialise() {
    return [...this.clients.values()];
  }
}
