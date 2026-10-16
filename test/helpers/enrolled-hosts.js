// Hosts admitted the way the routes admit them, for the tests of who a host
// may act for (hosts.js actsFor). A pin's actor, an owner and `ephemeral` are
// written exactly as /api/enroll/host writes them, and the host connects
// through hostConnected, which is where the enrolment is read. Shared because
// the same question is asked of five different paths, and five copies of the
// fixture would drift from the routes one at a time.
import { generateKeyPair } from '../../src/fleet/crypto.js';

/**
 * Enrol a host as a pin would, then connect it.
 *
 * @param {any} core a CoordinatorCore
 * @param {string} hostId
 * @param {{ enrolledBy?: string|null, owner?: string|null, ephemeral?: boolean, send?: (msg: any) => void }} [how]
 *   `enrolledBy` is the pin's actor: null for the admin token, a bare email for a person.
 */
export async function admit(core, hostId, { enrolledBy = null, owner = null, ephemeral = false, send = () => {} } = {}) {
  const key = await generateKeyPair();
  const r = await core.hostIds.enrol({ hostId, publicJwk: key.publicJwk, enrolledBy, owner, ephemeral });
  if (!r.ok) throw new Error(r.error);
  core.hostConnected(hostId, send);
}

/**
 * A person who is this fleet's admin, as a signed-in phone makes one.
 * @param {any} core @param {string} email
 */
export async function makeAdmin(core, email) {
  const issued = await core.clients.issue(`phone (${email})`, { admin: true });
  issued.client.email = email;
}
