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

import { VM_IMAGE, imageKeyOf } from './vm-image.js';

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
 * The cloud-init a pool's own machine boots with: its name, and one file
 * holding the coordinator, the pin, the name the pin is bound to and the
 * Xen Orchestra it holds. The same join script as a session's machine reads
 * it (install/fleetwright-vm-join), and does not power this one off.
 *
 * @param {{ hostId: string, pin: string, coordinatorUrl: string, address: string }} spec
 */
export function holderCloudConfig({ hostId, pin, coordinatorUrl, address }) {
  if (!HOLDER.id.test(hostId)) throw new Error(`${hostId} is not a name the coordinator gives a pool's own machine`);
  if (!/^\d{6}$/.test(pin)) throw new Error('that is not an enrolment pin');
  const join = JSON.stringify({ v: 1, coordinator: new URL(coordinatorUrl).origin, pin, hostId, holder: address });
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
    '  - [/opt/fleetwright/current/install/fleetwright-vm-join, /run/fleetwright/join.json]',
    '',
  ].join('\n');
}

/**
 * The pool's own machine on `pool`: the one there, started if it was off, or
 * a new one cloned from the pool's machine image onto the way out.
 *
 * @param {{
 *   admin: { call: (method: string, params?: any) => Promise<any> },
 *   pool: string,
 *   egress: { id: string, name: string },
 *   address: string,
 *   coordinatorUrl: string,
 *   askPin: () => Promise<{ ok: boolean, pin?: string, hostId?: string, text?: string }|null>,
 *   say?: (text: string) => void,
 * }} spec
 * @returns {Promise<string>} what was done, in a sentence for the phone
 */
export async function ensureHolder({ admin, pool, egress, address, coordinatorUrl, askPin, say = () => {} }) {
  const vms = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {}));
  const there = vms.find((v) => v?.$pool === pool && Array.isArray(v.tags) && v.tags.includes(HOLDER.tag));
  if (there) {
    if (there.power_state === 'Halted') {
      await admin.call('vm.start', { id: there.id });
      return `The pool’s own machine, ${String(there.name_label).slice(0, 40)}, was off and has been started.`;
    }
    return `The pool’s own machine, ${String(there.name_label).slice(0, 40)}, is already there.`;
  }
  // FROM THE POOL'S MACHINE IMAGE: Debian where there is one, else any.
  const templates = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM-template' } })) || {}))
    .filter((t) => t?.$pool === pool && Array.isArray(t.tags) && t.tags.includes(VM_IMAGE.tag));
  const template = templates.find((t) => imageKeyOf(t) === HOLDER.image) ?? templates[0];
  if (!template) throw new Error('this pool has no machine image to make its own machine from. Build one with it.');
  say('Asking the fleet for the pin the pool’s own machine joins with.');
  const given = await askPin();
  if (!given?.ok || typeof given.pin !== 'string' || typeof given.hostId !== 'string' || !HOLDER.id.test(given.hostId)) {
    throw new Error(`the fleet gave no pin for the pool’s own machine: ${given?.text || 'it did not answer, which a coordinator from before this does not'}`);
  }
  say(`Making ${given.hostId} from ${String(template.name_label || 'the machine image').slice(0, 60)}.`);
  await admin.call('vm.create', {
    template: template.id,
    name_label: given.hostId,
    name_description: `This pool’s own Fleetwright machine. It holds the pool for the fleet once its owner approves it, and stays up. Made by Fleetwright.`,
    VIFs: [{ network: egress.id }],
    tags: [HOLDER.tag, `${HOLDER.forPrefix}${address}`],
    cloudConfig: holderCloudConfig({ hostId: given.hostId, pin: given.pin, coordinatorUrl, address }),
    // The drive holds the pin: gone once the machine has booted, and wiped
    // from inside before that (the join script), whichever comes first.
    destroyCloudConfigVdiAfterBoot: true,
    bootAfterCreate: true,
  });
  return `${given.hostId} is starting on ${egress.name}. Approve it under Machines once it joins, and it holds this pool from then on.`;
}
