// A member's engine home on a box (docs/engines.md, "Credentials"): the
// Podman volume an engine keeps its own sign-in in, one a member on each
// machine, and how it is put into a container.
//
// A LEAF, with nothing of Podman in it, because both the launcher
// (claude.js) and the sign-in (engine-signin.js) name the volume and must
// name the same one.

import { MEMBER_ID_RE, memberOfAccount } from '../fleet/protocol/members.js';
import { emailFromActor, normaliseEmail, ownerTag } from './accounts.js';

/** Where the volume is mounted in a container. The runner is told by name, never by guessing. */
export const ENGINE_HOME = '/engine-home';

/** What every engine home's name begins with: an agent's id follows it, or `person.` and a person's tag. */
const HOME_PREFIX = 'fw-engine-';

/**
 * The volume holding one member's engine sign-ins on this box, or null for a
 * session with nobody behind it.
 *
 * `fw-engine-<member id>` for an agent member, whose account here is
 * `<id>@members.invalid` (protocol/members.js), and
 * `fw-engine-person.<tag>` for a person, by the hash this box already names
 * a person's download cache and egress network with (accounts.js ownerTag).
 *
 * NEVER AN ADDRESS. An address is not a Podman name, and a volume list need
 * not spell out who uses the box. A member's id is checked against its own
 * pattern, letters, digits and hyphens, before it is used.
 *
 * THE TWO CANNOT COLLIDE: a member's id cannot hold a full stop. Without it
 * an agent filed under an id shaped like a person's tag would have been
 * handed that person's sign-ins.
 *
 * @param {unknown} owner  an actor (`fleet:<email>`) or an account
 * @returns {string|null}
 */
export function engineHomeVolume(owner) {
  const account = emailFromActor(owner) ?? normaliseEmail(String(owner ?? ''));
  if (!account) return null;
  const member = memberOfAccount(account);
  return member ? `${HOME_PREFIX}${member}` : `${HOME_PREFIX}person.${ownerTag(account)}`;
}

/**
 * The agent member a volume's name says it is the engine home of, or null:
 * a person's home, or a volume that is not an engine home at all.
 *
 * The other way round from engineHomeVolume, for a box looking through its
 * own volumes for the homes of members who are gone (engine-signin.js,
 * keepMembers). A person's home never reads as an agent's: its name holds a
 * full stop, and an id cannot.
 *
 * @param {unknown} volume  a Podman volume's name
 * @returns {string|null}
 */
export function memberOfEngineHome(volume) {
  const name = String(volume ?? '');
  const id = name.startsWith(HOME_PREFIX) ? name.slice(HOME_PREFIX.length) : '';
  return MEMBER_ID_RE.test(id) ? id : null;
}

/**
 * The `podman run` arguments that give a container its owner's engine home,
 * and tell the runner where it is. None for a session with nobody behind it.
 *
 * Not created first: Podman makes a named volume on its first mount, owned
 * by whichever user the container's root is, as it does the download cache.
 *
 * @param {unknown} owner
 * @returns {string[]}
 */
export function engineHomeArgs(owner) {
  const volume = engineHomeVolume(owner);
  return volume ? ['-v', `${volume}:${ENGINE_HOME}`, '-e', `FLEETWRIGHT_ENGINE_HOME=${ENGINE_HOME}`] : [];
}
