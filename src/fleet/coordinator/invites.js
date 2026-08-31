// People an admin has let in, without a deploy.
//
// `AGENT_FLEET_AUTH_ALLOW` is an environment variable, so adding somebody to
// the fleet meant editing wrangler.toml, committing, and waiting for a deploy —
// a CODE CHANGE PER PERSON, performed by the one person who can already do
// everything. For a fleet whose whole premise is "nothing to ssh into", that is
// the one remaining thing you had to be at a keyboard to do.
//
// So the env list stays and gains a companion. The two answer different
// questions and keeping them apart is the point:
//
//   the env list   WHO THIS DEPLOYMENT BELONGS TO. Survives losing all state,
//                  which is what makes it the bootstrap: a coordinator whose
//                  storage is empty still knows its owner, so there is always
//                  somebody who can let everybody else back in.
//   invites        WHO THAT PERSON HAS SINCE INVITED. Stored, revocable, and
//                  never able to grant more than the inviter has.
//
// AN INVITE IS NOT A CREDENTIAL. It is permission to attempt a sign-in, and
// the sign-in still has to produce a verified email from a provider we trust.
// Nothing here can be redeemed, replayed or stolen into an account: the worst
// an leaked invite list does is tell you who was invited.
//
// AND AN INVITE IS NEVER ADMIN. The first person to sign in becomes admin and
// that seat is assigned once (clients.js); an invited person is a member, sees
// their own work, and cannot invite anybody else. Otherwise "invite" would be
// a way to hand out the fleet, one step removed.

/** @typedef {{ email: string, invitedBy: string, at: number, note: string|null }} Invite */

/** An address is at most this long. Longer is not an address, it is a payload. */
const MAX_EMAIL = 320;

/**
 * The people an admin has invited.
 *
 * Deliberately NOT a general key/value store on the coordinator: it holds
 * addresses and nothing else, so a compromised coordinator that rewrites it can
 * admit somebody — which it can already do by minting a client credential — and
 * cannot use it to reach anything.
 */
export class Invites {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    /** @type {Map<string, Invite>} */
    this.byEmail = new Map();
    this.now = now;
  }

  /**
   * Invite somebody, or update the note on an existing invitation.
   *
   * @param {string} email
   * @param {{ invitedBy: string, note?: string|null }} by
   * @returns {{ ok: boolean, message: string, invite?: Invite }}
   */
  add(email, { invitedBy, note = null }) {
    const address = normalise(email);
    if (!address) return { ok: false, message: `"${String(email).slice(0, 60)}" is not an email address.` };
    // ALREADY INVITED IS NOT AN ERROR. Somebody re-inviting a person is
    // answering "did that work?", and a refusal there reads as a fault.
    const existing = this.byEmail.get(address);
    const invite = {
      email: address,
      invitedBy,
      at: existing?.at ?? this.now(),
      note: note ? String(note).slice(0, 200) : existing?.note ?? null,
    };
    this.byEmail.set(address, invite);
    return {
      ok: true,
      invite,
      message: existing
        ? `${address} was already invited. They can sign in with the app.`
        : `${address} can now sign in. Send them the app; there is nothing else to set up.`,
    };
  }

  /**
   * Withdraw an invitation.
   *
   * DOES NOT SIGN ANYBODY OUT. A credential already issued keeps working until
   * it is revoked, which is a separate act on a separate object — see
   * clients.js. Conflating them would make "un-invite" quietly mean "revoke
   * every device they hold", which is a bigger action than the word suggests.
   *
   * @param {string} email
   */
  remove(email) {
    const address = normalise(email);
    if (!address || !this.byEmail.delete(address)) {
      return { ok: false, message: `${address || 'that address'} was not on the invited list.` };
    }
    return {
      ok: true,
      message:
        `${address} can no longer sign in. Any device they have already signed in on keeps working until you `
        + 'revoke it under Devices.',
    };
  }

  /** @returns {Invite[]} newest first, because the last one added is the one being checked on. */
  list() {
    return [...this.byEmail.values()].sort((a, b) => b.at - a.at);
  }

  /** @param {string} email */
  has(email) {
    const address = normalise(email);
    return Boolean(address && this.byEmail.has(address));
  }

  /** For persistence. @returns {Invite[]} */
  toJSON() {
    return this.list();
  }

  /** @param {unknown} rows */
  load(rows) {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const address = normalise(/** @type {any} */ (row)?.email);
      if (!address) continue;
      this.byEmail.set(address, {
        email: address,
        invitedBy: String(/** @type {any} */ (row).invitedBy || 'unknown'),
        at: Number(/** @type {any} */ (row).at) || this.now(),
        note: /** @type {any} */ (row).note ? String(/** @type {any} */ (row).note).slice(0, 200) : null,
      });
    }
  }
}

/**
 * A bare address, lowercased, or null.
 *
 * NO `@domain` ENTRIES, deliberately, though the env list allows them. Inviting
 * a whole domain from a phone is a decision whose blast radius nobody can see
 * at the moment they make it — every future address at that company, admitted
 * by a tap. The env list keeps that power because editing it is already a
 * deliberate act with review attached.
 *
 * @param {unknown} value
 */
function normalise(value) {
  const email = String(value || '').toLowerCase().trim();
  if (email.length > MAX_EMAIL) return null;
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return null;
  return email;
}
