// One Xen Orchestra user per box, and what becomes of a machine whose box is gone.
//
// The shared `fleetwright` user is what every approved box signed in as, and
// vm.create gives that user admin on every machine any of them makes
// (docs/hypervisors.md, measured on 5.211.0), so one compromised box could
// export another box's disk, the Claude login on it included
// (docs/security.md, G14). A user per box keeps a machine to the box that
// made it: a second user in the same resource set is refused the export, the
// start, the delete and the rest on a machine it did not make (measured).
//
// This mints those users when a policy choice names the boxes, each as
// `fleetwright-box-<host id>`, a subject of the fleet's set with permission
// `none`, and hands each box's token back sealed, for the phone to file as
// `hypervisor:<address>+<box>` (protocol/hypervisor-name.js). The shared
// user is withdrawn only when the choice says so (`retireShared`), which a
// phone says once every named box already holds a token of its own: the
// session machines still on that user are handed to the first named box, and
// the phone drops the shared item from the vault so boxes stop being given
// it. The user itself and its tokens stay, because the phone still signs in
// as it to look at the pool (docs/manage.md).
//
// A MACHINE OF A BOX THAT IS GONE is not left with nobody who can reach it.
// What the sweep would remove — stopped past its end, or running well past
// it — is removed here, by the admin, disks and all (machine-verdict.js says
// which, and it is the sweep's own rule: a machine just made is stopped while
// it clones, and one stopped before its end is started again, so neither is
// done). Anything else of that box's is given to the first named box, which
// is then the one limited user that can work it, and the gone user's own
// access is taken off before that user is deleted. A machine in the middle
// of a resize is left with the user that has it, and that user stays, because
// deleting a user in the middle of a resize is how a machine gets stranded.

import { randomBytes } from 'node:crypto';

import { HYPERVISOR_BOX_RE } from '../protocol/hypervisor-name.js';
import { EDGE_KEPT } from './edge-credentials.js';
import { machineDone, markedBusy } from './machine-verdict.js';
import { VM_IMAGE } from './vm-image.js';

/** The tag a machine wears naming the box whose user may work it. */
export const BOX_TAG_PREFIX = 'fleetwright-box:';

/** What a box's user is called, before its host id. */
export const BOX_USER_PREFIX = 'fleetwright-box-';

/**
 * The shared user onboarding makes (xo-setup.js, FLEET_USER, spelled here
 * rather than imported because that file imports this one), and the user the
 * edge keys are kept on. Neither is a box's.
 */
const SHARED_USER = 'fleetwright';
const NOBODYS = new Set([SHARED_USER, EDGE_KEPT.user]);

/**
 * @param {string} box
 * @returns {string}
 */
export function boxUserEmail(box) {
  return `${BOX_USER_PREFIX}${box}`;
}

/**
 * @param {string} box
 * @returns {string}
 */
export function boxTag(box) {
  return `${BOX_TAG_PREFIX}${box}`;
}

/**
 * @param {unknown} email
 * @returns {string|null}
 */
function boxOfEmail(email) {
  if (typeof email !== 'string' || !email.startsWith(BOX_USER_PREFIX)) return null;
  const box = email.slice(BOX_USER_PREFIX.length);
  return HYPERVISOR_BOX_RE.test(box) ? box : null;
}

/**
 * The box a machine is tagged for, or null for one on the shared user.
 *
 * @param {string[]} tags
 * @returns {string|null}
 */
export function boxOfTags(tags) {
  const tag = tags.find((t) => typeof t === 'string' && t.startsWith(BOX_TAG_PREFIX));
  if (!tag) return null;
  const box = tag.slice(BOX_TAG_PREFIX.length);
  return HYPERVISOR_BOX_RE.test(box) ? box : null;
}

/**
 * Whether the token in this record may work that machine.
 *
 * A box's own token works the machines tagged for it. The shared token works
 * the machines that have no box, which are the ones it made, and does not try
 * the others: it was measured to be refused on a machine another user made,
 * and a sweep that asks anyway is a warning every two minutes.
 *
 * @param {{ box?: string }} record
 * @param {any} vm
 */
export function operates(record, vm) {
  const box = boxOfTags(Array.isArray(vm?.tags) ? vm.tags : []);
  if (record.box) return box === record.box;
  return box === null;
}

/** The methods the admin job needs. One missing is the whole thing refused, before anything is changed. */
const NEEDED = ['acl.add', 'acl.remove', 'tag.add', 'tag.remove', 'user.create', 'user.set', 'user.getAll', 'user.delete', 'resourceSet.addSubject', 'resourceSet.getAll', 'token.create', 'vm.delete', 'vm.stop', 'xo.getAllObjects'];

/**
 * @typedef {{ box: string, user: string, token: string, tokenExpires: string|null }} BoxToken
 * @typedef {{ v: 1, boxTokens: BoxToken[], retiredShared?: true }} BoxHandoff
 */

/**
 * Give each named box a user and a token, and do not leave a gone box's
 * machines with nobody who can reach them.
 *
 * Nothing here is done unless `boxes` names someone. `retireShared` hands
 * every session machine that still has no box to the first named box and
 * takes the shared user's access off those machines; it does not delete that
 * user or its tokens, since the phone keeps one and a box is simply no longer
 * given it. A resize in progress on one of those machines holds the whole
 * withdrawal for this job: the next choice tries again.
 *
 * @param {{
 *   admin: { call: (method: string, params?: any) => Promise<any> },
 *   methods: Record<string, unknown>,
 *   setId: string,
 *   boxes: string[],
 *   retireShared?: boolean,
 *   now: number,
 *   signInAs: (email: string, password: string) => Promise<{ call: (method: string, params?: any) => Promise<any>, close: () => void }>,
 *   tokenLifetimeMs: number,
 * }} ask
 * @returns {Promise<{ text: string, handoff: BoxHandoff|null }>}
 */
export async function settleBoxUsers(ask) {
  const missing = NEEDED.filter((m) => !Object.hasOwn(ask.methods, m));
  if (missing.length) {
    return {
      text: `This Xen Orchestra cannot give each box its own user (${missing.join(', ')}), so machines stay on the shared user. Nothing about who may reach them was changed.`,
      handoff: null,
    };
  }

  const live = [...new Set(ask.boxes)].filter((b) => HYPERVISOR_BOX_RE.test(b));
  if (!live.length) return { text: '', handoff: null };
  const successor = live.slice().sort()[0];
  const users = /** @type {any[]} */ ((await ask.admin.call('user.getAll')) || []);
  /** @type {Map<string, { id: string, email: string }>} */
  const byBox = new Map();
  for (const u of users) {
    if (NOBODYS.has(u?.email)) continue;
    const box = boxOfEmail(u?.email);
    if (box) byBox.set(box, { id: String(u.id), email: String(u.email) });
  }

  const sets = (await ask.admin.call('resourceSet.getAll')) || [];
  const set = sets.find((/** @type {any} */ s) => s?.id === ask.setId);
  const subjects = new Set((Array.isArray(set?.subjects) ? set.subjects : []).map(String));

  /** @type {BoxToken[]} */
  const boxTokens = [];
  for (const box of live) {
    const email = boxUserEmail(box);
    // THE PASSWORD IS FOR MINTING, and replaced below: like the shared user's,
    // it is a credential nobody holds once the token exists.
    const password = randomBytes(24).toString('base64url');
    let user = byBox.get(box);
    if (!user) {
      const id = await ask.admin.call('user.create', { email, password, permission: 'none' });
      user = { id: String(id), email };
      byBox.set(box, user);
      await ask.admin.call('user.set', { id: user.id, preferences: { fleetwrightBox: box } });
    } else {
      await ask.admin.call('user.set', { id: user.id, password, permission: 'none', preferences: { fleetwrightBox: box } });
    }
    if (!subjects.has(user.id)) {
      await ask.admin.call('resourceSet.addSubject', { id: ask.setId, subject: user.id });
      subjects.add(user.id);
    }
    /** @type {{ call: (method: string, params?: any) => Promise<any>, close: () => void }|null} */
    let rpc = null;
    try {
      rpc = await ask.signInAs(email, password);
      /** @type {string|null} */
      let token = null;
      /** @type {string|null} */
      let tokenExpires = null;
      // With the same life the shared token is given, and without one where
      // this Xen Orchestra caps it lower than that (xo-setup.js, the token step).
      try {
        token = await rpc.call('token.create', { description: `fleetwright ${box}`, expiresIn: ask.tokenLifetimeMs });
        tokenExpires = new Date(ask.now + ask.tokenLifetimeMs).toISOString();
      } catch {
        token = await rpc.call('token.create', { description: `fleetwright ${box}` });
      }
      if (typeof token !== 'string' || !token) throw new Error(`Xen Orchestra did not hand back a token for ${box}.`);
      // EVERY EARLIER TOKEN OF THIS USER'S GOES, as the shared user's do when
      // it is minted again: a token a phone was handed and lost is not left
      // live for the life of the user. Where Xen Orchestra cannot, they stay.
      if (Object.hasOwn(ask.methods, 'token.deleteAll')) {
        await rpc.call('token.deleteAll', { except: token }).catch(() => {});
      }
      boxTokens.push({ box, user: email, token, tokenExpires });
    } finally {
      try {
        rpc?.close();
      } catch {
        /* closing */
      }
      await ask.admin.call('user.set', { id: user.id, password: randomBytes(24).toString('base64url') });
    }
  }

  const succ = /** @type {{ id: string, email: string }} */ (byBox.get(successor));
  const vms = /** @type {any[]} */ (Object.values((await ask.admin.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {}));
  const tagsOf = (/** @type {any} */ v) => /** @type {string[]} */ (Array.isArray(v?.tags) ? v.tags.filter((/** @type {unknown} */ t) => typeof t === 'string') : []);
  /** The successor is given the machine, then the tag says so, then the old user's access comes off. The other order deletes the only user who can reach a machine the hand-over did not finish. */
  const handOver = async (/** @type {any} */ vm, /** @type {{ id: string }|null} */ from, /** @type {string|null} */ oldTag) => {
    await ask.admin.call('acl.add', { subject: succ.id, object: vm.id, action: 'admin' });
    await ask.admin.call('tag.add', { id: vm.id, tag: boxTag(successor) });
    if (oldTag) await ask.admin.call('tag.remove', { id: vm.id, tag: oldTag });
    if (from) await ask.admin.call('acl.remove', { subject: from.id, object: vm.id, action: 'admin' });
  };

  let removed = 0;
  let handed = 0;
  /** @type {string[]} */
  const staying = [];
  for (const [box, user] of byBox) {
    if (live.includes(box)) continue;
    const tag = boxTag(box);
    const tagged = vms.filter((v) => tagsOf(v).includes(tag));
    // Anything that is not a session machine is not this job's to delete or
    // to hand over, and the user stays so it is not left with nobody.
    if (tagged.some((v) => !tagsOf(v).includes(VM_IMAGE.sessionTag))) {
      staying.push(box);
      continue;
    }
    let busy = false;
    for (const vm of tagged) {
      const tags = tagsOf(vm);
      if (markedBusy(tags, ask.now)) {
        busy = true;
        continue;
      }
      if (machineDone(vm, ask.now)) {
        if (vm.power_state !== 'Halted') await ask.admin.call('vm.stop', { id: vm.id, force: true });
        await ask.admin.call('vm.delete', { id: vm.id, deleteDisks: true });
        removed += 1;
        continue;
      }
      await handOver(vm, user, tag);
      handed += 1;
    }
    if (busy) {
      staying.push(box);
      continue;
    }
    await ask.admin.call('user.delete', { id: user.id });
  }

  let retiredShared = false;
  let fromShared = 0;
  if (ask.retireShared) {
    const shared = users.find((u) => u?.email === SHARED_USER);
    const loose = vms.filter((v) => tagsOf(v).includes(VM_IMAGE.sessionTag) && boxOfTags(tagsOf(v)) === null);
    if (loose.some((v) => markedBusy(tagsOf(v), ask.now))) {
      staying.push('the shared user');
    } else {
      for (const vm of loose) {
        await handOver(vm, shared?.id ? { id: String(shared.id) } : null, null);
        fromShared += 1;
      }
      retiredShared = true;
    }
  }

  const names = live.join(' and ');
  const parts = [`${names} ${live.length === 1 ? 'has a user of its own' : 'each have a user of their own'} on this Xen Orchestra.`];
  if (handed) parts.push(`${handed === 1 ? 'One machine' : `${handed} machines`} a box that is gone had made ${handed === 1 ? 'was' : 'were'} handed to ${successor}.`);
  if (fromShared) parts.push(`${fromShared === 1 ? 'One machine' : `${fromShared} machines`} still on the shared user ${fromShared === 1 ? 'was' : 'were'} handed to ${successor}.`);
  if (removed) parts.push(`${removed === 1 ? 'One machine' : `${removed} machines`} of a box that is gone ${removed === 1 ? 'was' : 'were'} removed, stopped or past ${removed === 1 ? 'its' : 'their'} end.`);
  if (staying.length) parts.push(`${staying.join(' and ')} ${staying.length === 1 ? 'is' : 'are'} in the middle of a resize, so that user stays until the machine is not.`);
  if (!handed && !removed && !fromShared && !staying.length) parts.push('No machine was left on a box that is gone.');
  parts.push(retiredShared
    ? `The shared user stays for this phone. Boxes stop being given its token once the phone drops it, and a machine that was still on it now belongs to ${successor}.`
    : 'The shared user was left as it was. These tokens reach a box only once a phone keeps each one for that box alone.');
  return { text: parts.join(' '), handoff: { v: 1, boxTokens, ...(retiredShared ? { retiredShared: true } : {}) } };
}
