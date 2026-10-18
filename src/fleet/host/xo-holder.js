// A machine of the pool's own, to hold it: a permanent fleet host cloned on
// the pool from its machine image, so the boxes that can reach Xen Orchestra
// are not only whatever laptop set the pool up. docs/hypervisors.md, "A
// machine of its own".
//
// MADE BY THE POLICY JOB, with the admin sign-in, and outside the fleet's
// resource set: it is not one of the fleet's machines and does not count
// against their limits, and the limited user the fleet works with can neither
// see it nor remove it. It goes on the way out, the network the edge router's
// WAN is on, because it has to reach Xen Orchestra and the coordinator, and
// the uplink behind the router reaches neither by design.
//
// IT JOINS WITH A PIN, not a ticket: a single-use pin the coordinator binds
// to a name of its choosing (core.js, #onHolderPin), asked for just before
// the clone, so the ten minutes a pin lasts cover the boot. It enrols as a
// permanent host of nobody's, and is never swept (it carries none of the
// session tags xo-pools.js sweeps by).
//
// IT HOLDS NOTHING UNTIL ITS OWNER SAYS SO. The pool's token reaches a box
// only as a vault item the person approved for that box's key on the phone,
// and nothing in this file or the coordinator can approve. What it brings is
// a box that is up when the laptop is asleep, and asked first once approved
// (`holder` in its health, core.js #vmHolders).

import { JOIN_RUNCMD, VM_IMAGE, imageKeyOf, isFleetImage } from './vm-image.js';
import { outsideSets, recordMade, setsOf } from './xo-made.js';
import { HOLDER_SECRET_RE } from '../protocol/holder-join.js';
import { machineGrantsOf } from '../../core/grants.js';

export const HOLDER = Object.freeze({
  /** On the VM, which is how the next policy job finds it rather than making another. */
  tag: 'fleetwright-holder',
  /** The Xen Orchestra it holds, as a tag beside it. */
  forPrefix: 'fleetwright-holder-for:',
  /** The name the coordinator gives it: `holder-` and six hex. */
  id: /^holder-[0-9a-f]{6}$/,
  /** The image it is preferred to be made from, of the catalogue's. */
  image: 'debian-13',
});

/**
 * WHETHER A VM IS THE POOL'S OWN MACHINE for the Xen Orchestra at `address`:
 * on the list of what the policy job made (xo-made.js, recordMade), with both
 * of the tags it is made with, and made in no resource set. The first tag
 * alone was all it took, and the job, signed in as an admin, starts what it
 * finds or, made again, deletes it with its disks; a VM somebody else tagged
 * was one it would have started or deleted.
 *
 * THE LIST, BECAUSE THE TAGS AND THE SET SAY WHO MADE THE VM AND NOT WHO
 * TAGGED IT. tag.add asks only for `administrate` on the object, so anybody
 * given that on one VM an admin made, which is in no set, could plant both
 * tags; the edge router then sent its logs to that VM's guest-reported
 * address ahead of the box watching it, the job started it and called it
 * "already there", and the phone showed it in place of the real one. The list
 * is written only by an admin of Xen Orchestra, which is what the machine
 * images already rest on (vm-image.js, isFleetImage).
 *
 * A MACHINE MADE BEFORE THE LIST IS NOT TAKEN FOR ONE. Nothing tells it from
 * a planted VM: both have the tags and no set, and recording whichever is
 * there at the first job after this change would record a planted one as
 * readily, with no end to the window — a VM planted on a pool that never had
 * one would be recorded by the next job too. So the job passes it over: it is
 * not started, its logs stop at the next edge build, the phone does not show
 * it and offers to make one, and making one makes a new machine and lists
 * it. The old one stays an enrolled host until somebody deletes it in Xen
 * Orchestra; whether it holds the pool was always its owner's approval, which
 * this does not touch (docs/hypervisors.md, "A machine of its own").
 *
 * Also what the phone is shown, and where the edge router sends its logs
 * (xo-setup.js).
 *
 * @param {any} v  a VM as xo.getAllObjects gave it @param {string} address
 * @param {{ made: Set<string> }} sets  as xo-made.js reads them
 */
export function isHolder(v, address, sets) {
  return (
    Array.isArray(v?.tags) &&
    v.tags.includes(HOLDER.tag) &&
    v.tags.includes(`${HOLDER.forPrefix}${address}`) &&
    outsideSets(v) &&
    sets.made.has(String(v?.id))
  );
}

/**
 * The cloud-init a pool's own machine boots with: its name, and one file
 * holding the coordinator, the pin, the name the pin is bound to and the
 * Xen Orchestra it holds, and the secret the person's phone gave the job when
 * there is one, which it asks to join with instead of spending the pin
 * (src/fleet/host/vm-join.js). The same join script as a session's machine
 * reads it (install/fleetwright-vm-join), and does not power this one off.
 * `grants` is what it may do from chat, as its owner chose on the pool's
 * policy, which the join script applies before anything starts.
 *
 * @param {{ hostId: string, pin: string, coordinatorUrl: string, address: string, secret?: string|null, grants?: { upgrades?: boolean, reboot?: boolean }|null }} spec
 */
export function holderCloudConfig({ hostId, pin, coordinatorUrl, address, secret = null, grants = null }) {
  if (!HOLDER.id.test(hostId)) throw new Error(`${hostId} is not a name the coordinator gives a pool's own machine`);
  if (!/^\d{6}$/.test(pin)) throw new Error('that is not an enrolment pin');
  if (secret !== null && !HOLDER_SECRET_RE.test(secret)) throw new Error('that is not the secret a phone makes for a pool’s own machine');
  const allowed = machineGrantsOf(grants);
  const join = JSON.stringify({ v: 1, coordinator: new URL(coordinatorUrl).origin, pin, hostId, holder: address, ...(secret ? { secret } : {}), ...(allowed ? { grants: allowed } : {}) });
  return [
    '#cloud-config',
    `hostname: ${hostId}`,
    'write_files:',
    '  - path: /run/fleetwright/join.json',
    "    permissions: '0600'",
    '    owner: root:root',
    '    content: |',
    `      ${join}`,
    'runcmd:',
    JOIN_RUNCMD,
    '',
  ].join('\n');
}

/**
 * The pool's own machine on `pool`: the one there, started if it was off, or
 * a new one cloned from the pool's machine image onto the way out. `again`
 * removes the one there first and makes a new one: asked for from the phone
 * for a machine that never joined. `secret`, from the person's phone, is what
 * the new one asks to join with, and `grants` what it may do from chat. The
 * one there is left as it is: a running machine's grants are changed on it.
 *
 * @param {{
 *   admin: { call: (method: string, params?: any) => Promise<any> },
 *   pool: string,
 *   egress: { id: string, name: string },
 *   address: string,
 *   coordinatorUrl: string,
 *   askPin: () => Promise<{ ok: boolean, pin?: string, hostId?: string, text?: string }|null>,
 *   secret?: string|null,
 *   again?: boolean,
 *   grants?: { upgrades?: boolean, reboot?: boolean }|null,
 *   say?: (text: string) => void,
 * }} spec
 * @returns {Promise<string>} what was done, in a sentence for the phone
 */
export async function ensureHolder({ admin, pool, egress, address, coordinatorUrl, askPin, secret = null, again = false, grants = null, say = () => {} }) {
  const sets = await setsOf(admin);
  const vms = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {}));
  const theirs = vms.filter((v) => v?.$pool === pool && isHolder(v, address, sets));
  const there = theirs[0];
  if (there && !again) {
    if (there.power_state === 'Halted') {
      await admin.call('vm.start', { id: there.id });
      return `The pool’s own machine, ${String(there.name_label).slice(0, 40)}, was off and has been started.`;
    }
    return `The pool’s own machine, ${String(there.name_label).slice(0, 40)}, is already there.`;
  }
  // MADE AGAIN: the one that never joined goes, disk and all, before its
  // replacement is cloned, so the pool never has two answering for it.
  for (const v of again ? theirs : []) {
    say(`Removing ${String(v.name_label).slice(0, 40)} to make the pool’s own machine again.`);
    if (v.power_state !== 'Halted') await admin.call('vm.stop', { id: v.id, force: true });
    await admin.call('vm.delete', { id: v.id, deleteDisks: true });
  }
  // FROM THE POOL'S MACHINE IMAGE: Debian where there is one, else any of
  // the fleet's, and only the fleet's (vm-image.js, isFleetImage): it boots
  // on the way out with a pin, and stays up as a permanent host.
  const templates = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM-template' } })) || {}))
    .filter((t) => t?.$pool === pool && Array.isArray(t.tags) && t.tags.includes(VM_IMAGE.tag) && isFleetImage(t, sets));
  const template = templates.find((t) => imageKeyOf(t) === HOLDER.image) ?? templates[0];
  if (!template) throw new Error('this pool has no machine image to make its own machine from. Build one with it.');
  say('Asking the fleet for the pin the pool’s own machine joins with.');
  const given = await askPin();
  if (!given?.ok || typeof given.pin !== 'string' || typeof given.hostId !== 'string' || !HOLDER.id.test(given.hostId)) {
    throw new Error(`the fleet gave no pin for the pool’s own machine: ${given?.text || 'it did not answer, which a coordinator from before this does not'}`);
  }
  say(`Making ${given.hostId} from ${String(template.name_label || 'the machine image').slice(0, 60)}.`);
  const made = await admin.call('vm.create', {
    template: template.id,
    name_label: given.hostId,
    name_description: `This pool’s own Fleetwright machine. It holds the pool for the fleet once its owner approves it, and stays up. Made by Fleetwright.`,
    VIFs: [{ network: egress.id }],
    tags: [HOLDER.tag, `${HOLDER.forPrefix}${address}`],
    cloudConfig: holderCloudConfig({ hostId: given.hostId, pin: given.pin, coordinatorUrl, address, secret, grants }),
    // The drive holds the pin: gone once the machine has booted, and wiped
    // from inside before that (the join script), whichever comes first.
    destroyCloudConfigVdiAfterBoot: true,
    bootAfterCreate: true,
  });
  // ON THE LIST as soon as it exists, which is what makes it the pool's own
  // machine to the next job (isHolder). Xen Orchestra answers vm.create with
  // the new VM's id; anything else is a machine that would never be found.
  if (typeof made !== 'string' || !made) throw new Error(`Xen Orchestra made ${given.hostId} without saying its id, so it cannot be listed as the pool’s own machine.`);
  await recordMade(admin, made);
  return secret
    ? `${given.hostId} is starting on ${egress.name}. Once it is up it asks to join, and your phone asks you to let it in and hold this pool.`
    : `${given.hostId} is starting on ${egress.name}. Approve it under Machines once it joins, and it holds this pool from then on.`;
}
