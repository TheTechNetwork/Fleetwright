// What the fleet's admin jobs made on a pool, recorded where nobody below an
// admin of Xen Orchestra can write. docs/hypervisors.md, "Machines from your
// pool" and "The edge router".
//
// WHY A RECORD AT ALL. The policy job, signed in as an admin, keeps the
// published OPNsense and cloud images on the pool as templates and builds the
// edge router and the machine image from copies of them (edge-router.js and
// vm-image.js, THE KEPT DISK and THE BASE DISK). It used to find them again
// by their tags and nothing else, and a tag is something anybody who can make
// a template can give theirs: a template so tagged on the right storage was
// taken for the published image, the digest-checked download was skipped,
// and its disk became the router. The same went for the machine images,
// found by `fleetwright-image` on any pool and written into the fleet's
// resource set, which is what every approved box's token can clone.
//
// WHERE IT IS KEPT, and why there. Two resource sets, read by name:
//
//   `fleetwright` (FLEET_SET), the set the fleet's limited user works in.
//   What is in it is what the fleet may use, and its machine images are in it
//   because a policy job put them there.
//
//   `fleetwright-made` (MADE_SET), a set with nobody in it: the ids of what
//   the policy job made, the kept disks and the machine images. It grants
//   nothing to anyone; it is only a list.
//
// Xen Orchestra lets only its admins create, change or add to a resource set
// (resourceSet.create, .set, .delete, .addObject, .removeObject, .addSubject
// and .removeSubject are all `permission = 'admin'` in xo-server; measured on
// 5.211.0, each refused to the fleet's user and to a plain one with "not
// enough permissions"), so the fleet's limited user cannot write either list.
// It can read both: resourceSet.getAll lists only a user's own sets, but
// resourceSet.get answers any set by its id to anybody signed in. Nothing in
// them is secret: ids, of objects xo.getAllObjects shows it anyway.
//
// Tags were the other candidate and were not taken: tag.add asks only for
// `administrate` on the object (measured: granted on a VM it was given, refused
// on every template, network, storage and host), which
// a principal below the admin can hold, and the fleet's own user holds it on
// every VM it makes. A list in Xen Orchestra rather than on the box running
// the job, because the next job may run on another box.
//
// MADE IN NO RESOURCE SET (outsideSets) is the weaker reading, for a VM the
// job made before there was a record. Xen Orchestra refuses vm.create without
// a resource set to anyone without `administrate` on the pool, and only an
// admin can move a VM out of one (vm.set's `resourceSet`), so a VM with none
// was never made by the fleet's limited user. Not only by an admin, though:
// somebody given administrate on one VM that is in no set can clone it, and
// copy a snapshot of it to a template, outside every set (vm.clone,
// vm.snapshot and vm.copyToTemplate; measured on 5.211.0). Which is why
// nothing takes this reading alone: every caller pairs it with the list.

/** The resource set the fleet's limited user works in, by name. */
export const FLEET_SET = 'fleetwright';
/** The list of what the policy job made, by name. A resource set with no subjects. */
export const MADE_SET = 'fleetwright-made';

/**
 * What is in each list: every set by the name, should there be two.
 *
 * @param {{ call: (method: string, params?: any) => Promise<any> }} admin  signed in as an admin
 * @returns {Promise<{ fleet: Set<string>, made: Set<string> }>}
 */
export async function setsOf(admin) {
  const answer = await admin.call('resourceSet.getAll');
  const sets = /** @type {any[]} */ (Array.isArray(answer) ? answer : []);
  const of = (/** @type {string} */ name) => new Set(sets.filter((s) => s?.name === name).flatMap((s) => (Array.isArray(s.objects) ? s.objects.map(String) : [])));
  return { fleet: of(FLEET_SET), made: of(MADE_SET) };
}

/**
 * `id` written into the list of what the job made, the list made first when
 * there is none. Called with the admin session the thing was made with, as
 * soon as it exists and before anything trusts it.
 *
 * @param {{ call: (method: string, params?: any) => Promise<any> }} admin @param {string} id
 */
export async function recordMade(admin, id) {
  const answer = await admin.call('resourceSet.getAll');
  const set = (Array.isArray(answer) ? answer : []).find((/** @type {any} */ s) => s?.name === MADE_SET);
  if (set) await admin.call('resourceSet.addObject', { id: set.id, object: id });
  else await admin.call('resourceSet.create', { name: MADE_SET, subjects: [], objects: [id] });
}

/**
 * `id` taken off the list once it is deleted. Best effort: an id left on it
 * names nothing, and XAPI does not give an id twice.
 *
 * @param {{ call: (method: string, params?: any) => Promise<any> }} admin @param {string} id
 */
export async function forgetMade(admin, id) {
  try {
    const answer = await admin.call('resourceSet.getAll');
    for (const s of /** @type {any[]} */ (Array.isArray(answer) ? answer : [])) {
      if (s?.name === MADE_SET && Array.isArray(s.objects) && s.objects.includes(id)) await admin.call('resourceSet.removeObject', { id: s.id, object: id });
    }
  } catch {
    /* the list is tidied, not relied on to be tidy */
  }
}

/**
 * Made in no resource set: by somebody at the pool's admin or above (see the
 * top of this file). Xen Orchestra reads `resourceSet` out of the VM's
 * other_config, and a template keeps it from the VM it was.
 *
 * @param {any} o  a VM or VM-template as xo.getAllObjects gave it
 */
export const outsideSets = (o) => o?.resourceSet === undefined || o?.resourceSet === null;
