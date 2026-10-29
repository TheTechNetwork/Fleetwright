// One Xen Orchestra user per box, and what happens to a machine whose box is gone.
//
// The shared `fleetwright` user is what every approved box signs in as today,
// and vm.create gives that user admin on every machine any of them makes
// (docs/hypervisors.md, measured on 5.211.0). A user per box keeps a machine
// to the box that made it. This mints those users when a policy choice names
// the boxes. The shared user is withdrawn only when the choice says so, which
// a phone says once every named box already has a token of its own: the
// machines still on that user are handed to the first box, and its token
// stops being put in the vault. The user itself stays, because the phone
// still signs in as it to look at the pool.
//
// A machine of a box that is not on the list is not left with nobody who can
// reach it. One that has stopped, or run past its end, is removed by the
// admin job. One that is still in its time is given to the first box on the
// list, which is then the only limited user that can work it, and the gone
// user's own access is taken off before that user is deleted. A machine
// marked busy is left with the user that has it, and that user stays, because
// deleting the user in the middle of a resize is how a machine gets stranded.

import { randomBytes } from 'node:crypto';

import { HYPERVISOR_BOX_RE } from '../protocol/hypervisor-name.js';
import { VM_IMAGE } from './vm-image.js';

/** The tag a machine wears naming the box whose user may work it. */
export const BOX_TAG_PREFIX = 'fleetwright-box:';

/** A resize in progress wears this, and the sweep leaves it (xo-pools.js). */
const BUSY_TAG = 'fleetwright-busy';

/** How long past its end a machine may still be running before it is removed. The same minute as xo-pools.js. */
const GRACE_MS = 60_000;

const USER_PREFIX = 'fleetwright-box-';

/** The shared user, and the user the edge keys are kept on. Neither is a box. */
const SHARED = new Set(['fleetwright', 'fleetwright-edge-keys']);

/**
 * @param {string} box
 * @returns {string}
 */
export function boxUserEmail(box) {
  return `${USER_PREFIX}${box}`;
}

/**
 * @param {string} box
 * @returns {string}
 */
export function boxTag(box) {
  return `${BOX_TAG_PREFIX}${box}`;
}

/**
 * @param {string} email
 * @returns {string|null}
 */
function boxOfEmail(email) {
  if (typeof email !== 'string' || !email.startsWith(USER_PREFIX)) return null;
  const box = email.slice(USER_PREFIX.length);
  return HYPERVISOR_BOX_RE.test(box) ? box : null;
}

/**
 * @param {string[]} tags
 * @returns {string|null}
 */
function boxOfTags(tags) {
  const tag = tags.find((t) => t.startsWith(BOX_TAG_PREFIX));
  if (!tag) return null;
  const box = tag.slice(BOX_TAG_PREFIX.length);
  return HYPERVISOR_BOX_RE.test(box) ? box : null;
}

/**
 * Whether this record may work that machine.
 *
 * A box's own token works the machines tagged for it. The shared token works
 * the machines that have no box, which are the ones it made, and does not
 * try the others: it was measured to be refused on a machine another user
 * made, and a sweep that asks anyway is a warning every two minutes.
 *
 * @param {{ box?: string }} record
 * @param {any} vm
 */
export function operates(record, vm) {
  const tags = Array.isArray(vm?.tags) ? vm.tags : [];
  const box = boxOfTags(tags);
  if (record.box) return box === record.box;
  return box === null;
}

/**
 * Give each named box a user and a token, and do not leave a gone box's
 * machines with nobody who can reach them.
 *
 * Nothing here is done unless `boxes` names someone. `retireShared` hands
 * every session machine that still has no box to the first named box and
 * takes the shared user's access off those machines. It does not delete
 * that user or its tokens: the phone keeps one, and a box is simply no
 * longer given it.
 *
 * @param {{
 *   admin: { call: (method: string, params?: any) => Promise<any> },
 *   methods: Record<string, unknown>,
 *   setId: string,
 *   boxes: string[],
 *   now: number,
 *   retireShared?: boolean,
 *   signInAs: (email: string, password: string) => Promise<{ call: (method: string, params?: any) => Promise<any>, close: () => void }>,
 *   tokenLifetimeMs: number,
 * }} ask
 * @returns {Promise<{ text: string, handoff: { v: 1, boxTokens: Array<{ box: string, user: string, token: string, tokenExpires: string|null }>, retiredShared?: boolean }|null }>}
 */
export async function settleBoxUsers(ask) {
  const need = ['acl.add', 'acl.remove', 'tag.add', 'tag.remove', 'user.create', 'user.set', 'user.getAll', 'user.delete', 'resourceSet.addSubject', 'resourceSet.getAll', 'vm.delete', 'vm.stop', 'xo.getAllObjects'];
  const missing = need.filter((m) => !Object.hasOwn(ask.methods, m));
  if (missing.length) {
    return {
      text: `This Xen Orchestra cannot give each box its own user (${missing.join(', ')}), so machines stay on the shared user. Nothing about who may reach them was changed.`,
      handoff: null,
    };
  }

  const live = [...new Set(ask.boxes)];
  const successor = live.slice().sort()[0];
  const users = (await ask.admin.call('user.getAll')) || [];
  /** @type {Map<string, { id: string, email: string }>} */
  const byBox = new Map();
  for (const u of users) {
    if (SHARED.has(u?.email)) continue;
    const box = boxOfEmail(u?.email);
    if (box) byBox.set(box, { id: String(u.id), email: String(u.email) });
  }

  const sets = (await ask.admin.call('resourceSet.getAll')) || [];
  const set = sets.find((/** @type {any} */ s) => s?.id === ask.setId);
  const subjects = new Set((Array.isArray(set?.subjects) ? set.subjects : []).map(String));

  /** @type {Array<{ box: string, user: string, token: string, tokenExpires: string|null }>} */
  const boxTokens = [];
  for (const box of live) {
    const email = boxUserEmail(box);
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
      try {
        token = await rpc.call('token.create', { description: `fleetwright ${box}`, expiresIn: ask.tokenLifetimeMs });
        tokenExpires = new Date(ask.now + ask.tokenLifetimeMs).toISOString();
      } catch {
        token = await rpc.call('token.create', { description: `fleetwright ${box}` });
      }
      if (typeof token !== 'string' || !token) throw new Error(`Xen Orchestra did not hand back a token for ${box}.`);
      boxTokens.push({ box, user: email, token, tokenExpires });
    } finally {
      try {
        rpc?.close();
      } catch {
        /* closing */
      }
      // THE PASSWORD WAS FOR MINTING. Replaced, so it is not a credential
      // anybody holds, the same way the shared user's is.
      await ask.admin.call('user.set', { id: user.id, password: randomBytes(24).toString('base64url') });
    }
  }

  const succ = byBox.get(successor);
  const vms = /** @type {any[]} */ (Object.values((await ask.admin.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {}));
  let removed = 0;
  let handed = 0;
  /** @type {string[]} */
  const staying = [];
  for (const [box, user] of byBox) {
    if (live.includes(box)) continue;
    const tag = boxTag(box);
    const tagged = vms.filter((v) => (Array.isArray(v?.tags) ? v.tags : []).includes(tag));
    // Anything that is not a session machine is not this job's to delete or
    // to hand over, and the user stays so it is not left with nobody.
    if (tagged.some((v) => !(Array.isArray(v.tags) && v.tags.includes(VM_IMAGE.sessionTag)))) {
      staying.push(box);
      continue;
    }
    const theirs = tagged;
    let busy = false;
    for (const vm of theirs) {
      const tags = /** @type {string[]} */ (vm.tags);
      if (tags.includes(BUSY_TAG)) {
        busy = true;
        continue;
      }
      const until = Number(tags.find((t) => t.startsWith(VM_IMAGE.untilPrefix))?.slice(VM_IMAGE.untilPrefix.length)) * 1000;
      const overdue = Number.isFinite(until) && ask.now > until + GRACE_MS;
      if (vm.power_state === 'Halted' || overdue) {
        if (vm.power_state !== 'Halted') await ask.admin.call('vm.stop', { id: vm.id, force: true });
        await ask.admin.call('vm.delete', { id: vm.id, deleteDisks: true });
        removed += 1;
        continue;
      }
      // THE SUCCESSOR FIRST, then the gone user's access off, then the tag.
      // The other order deletes the only user who can reach a machine the
      // hand-over did not finish.
      await ask.admin.call('acl.add', { subject: succ?.id, object: vm.id, action: 'admin' });
      await ask.admin.call('tag.add', { id: vm.id, tag: boxTag(successor) });
      await ask.admin.call('tag.remove', { id: vm.id, tag });
      await ask.admin.call('acl.remove', { subject: user.id, object: vm.id, action: 'admin' });
      handed += 1;
    }
    if (busy) {
      staying.push(box);
      continue;
    }
    await ask.admin.call('user.delete', { id: user.id });
  }

  let retiredShared = false;
  /** @type {number} */
  let fromShared = 0;
  if (ask.retireShared && succ) {
    const shared = users.find((/** @type {any} */ u) => u?.email === 'fleetwright');
    const loose = vms.filter((v) => {
      const tags = Array.isArray(v?.tags) ? v.tags : [];
      return tags.includes(VM_IMAGE.sessionTag) && !boxOfTags(tags);
    });
    if (loose.some((v) => (Array.isArray(v.tags) ? v.tags : []).includes(BUSY_TAG))) {
      staying.push('the shared user');
    } else {
      for (const vm of loose) {
        await ask.admin.call('acl.add', { subject: succ.id, object: vm.id, action: 'admin' });
        await ask.admin.call('tag.add', { id: vm.id, tag: boxTag(successor) });
        if (shared?.id) await ask.admin.call('acl.remove', { subject: shared.id, object: vm.id, action: 'admin' });
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
  if (!handed && !removed && !staying.length) parts.push('No machine was left on a box that is gone.');
  parts.push(retiredShared
    ? 'The shared user stays on this phone. Boxes stop being given its token once the phone drops it, and a machine that was still on it now belongs to ' + successor + '.'
    : 'The shared user was left as it was. These tokens reach a box only once a phone keeps each one for that box alone.');
  return { text: parts.join(' '), handoff: { v: 1, boxTokens, ...(retiredShared ? { retiredShared: true } : {}) } };
}
