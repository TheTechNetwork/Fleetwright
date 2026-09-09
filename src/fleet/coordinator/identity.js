// Who is this, and are they allowed — asked once, for every way in.
//
// This was written twice, verbatim, in `server.js` and in `worker/src/fleet-do.js`:
// verify the token, refuse a private relay address, then check the env allowlist
// OR the invite list. Two copies of a security check is one that will be fixed
// in one place, and the copy nobody remembers is the one still admitting people
// six months later.
//
// The remote MCP endpoint was about to be a THIRD copy, which is what finally
// made this a function. Nothing here is new behaviour — it is the same four
// steps, moved.

import { verifyIdToken, isAllowed, isPrivateRelay } from './oidc.js';

/**
 * @typedef {{ ok: true, email: string, name: string|null }} Identified
 * @typedef {{ ok: false, status: number, code: string, text: string }} Refused
 */

/**
 * @param {string} idToken             an ID token from Apple or Google
 * @param {object} against
 * @param {string[]} against.issuers   AGENT_FLEET_AUTH_ISSUERS
 * @param {string[]} against.audiences AGENT_FLEET_AUTH_AUDIENCES
 * @param {string[]} against.allow     AGENT_FLEET_AUTH_ALLOW
 * @param {{ has: (email: string) => boolean }} against.invites
 * @param {{ spend: (token: string, expiresAt: number) => Promise<boolean> }|null} [against.spent]
 *   where a token that has bought a credential is remembered, so it cannot buy
 *   a second one. Optional only so the function stays callable from a test
 *   that is about the other four checks.
 * @returns {Promise<Identified|Refused>}
 */
export async function identify(idToken, { issuers, audiences, allow, invites, spent = null }) {
  if (!issuers.length || !audiences.length) {
    return { ok: false, status: 503, code: 'not_configured', text: 'This coordinator has no sign-in configured.' };
  }

  let who;
  try {
    who = await verifyIdToken(String(idToken || ''), { issuers, audiences });
  } catch (e) {
    // The reason is returned rather than swallowed: every failure here is
    // something an operator may need to act on, and "sign-in failed" tells them
    // none of it. It reveals nothing a holder of the token does not already have.
    return { ok: false, status: 401, code: 'unauthorised', text: String(/** @type {Error} */ (e).message) };
  }

  if (isPrivateRelay(who.email)) {
    return {
      ok: false,
      status: 403,
      code: 'private_relay',
      text:
        'Sign in again and choose "Share My Email". This coordinator allows people by email domain, ' +
        'and a hidden Apple address can never match one.',
    };
  }

  // EITHER LIST. The env one says who this deployment belongs to and survives
  // losing all state; the invited one says who they have let in since, and
  // needs no deploy. See invites.js for why they stay separate.
  if (!isAllowed(who.email, allow) && !invites.has(who.email)) {
    return { ok: false, status: 403, code: 'not_allowed', text: `${who.email} is not on this fleet's list.` };
  }

  // SPENT LAST, once every other check has passed. A token refused above was
  // never going to buy anything, and burning it would only turn "you are not
  // on the list" into "already used" for the person who tries again after
  // being added. A token that gets here is about to become a credential, and
  // this is what stops it becoming two.
  if (spent && !(await spent.spend(idToken, who.expiresAt))) {
    return {
      ok: false,
      status: 401,
      code: 'token_reused',
      text: 'That sign-in token has already been used. Sign in again.',
    };
  }

  return { ok: true, email: who.email, name: who.name };
}
