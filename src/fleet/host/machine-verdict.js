// Whether a session machine is done, and whether a resize has it: the two
// questions the sweep answers before it removes anything (xo-pools.js,
// #sweep and #busy), in one place so that a second reader of the same
// machines — the admin job that hands a gone box's machines to another box
// (xo-box-users.js) — cannot drift from it. The first version of that job
// removed every stopped machine of a gone box, which is the rule the sweep
// gave up: a machine just made is stopped while it clones, and one a host
// reboot stopped before its end is started again, once. A box going away
// does not change what its machines are in the middle of.

import { VM_IMAGE } from './vm-image.js';

/** How long past its end a machine may still be running before it is removed. */
export const GRACE_MS = 60_000;

/**
 * A machine being resized is stopped on purpose, and the sweep leaves it be:
 * `fleetwright-busy:<seconds since the epoch>`, honoured for BUSY_MS from the
 * time in it. It used to be the bare tag, which a sidecar that died between
 * marking and unmarking left on for good, and the machine with it: stopped,
 * never swept, never started. A bare one found now (BUSY_TAG, from a box
 * older than this) is given the time it was first seen at, so that it runs
 * out like the rest and the sweep does not take a machine from under a
 * resize still going on an older box.
 */
export const BUSY_TAG = 'fleetwright-busy';
export const BUSY_PREFIX = 'fleetwright-busy:';
export const BUSY_MS = 30 * 60_000;

/**
 * How long after it was made a stopped machine may still be booting rather
 * than done: vm.create clones and tags it before it is started, and any box
 * that looked in that window took it for a stopped machine and removed it,
 * disk and all, before it had booted once.
 */
export const YOUNG_MS = 5 * 60_000;

/** The sweep started this machine again once, found stopped before its end. */
export const RESTARTED_PREFIX = 'fleetwright-restarted:';
/** When a machine was made, its image and its network, as tags beside its end. */
export const MADE_PREFIX = 'fleetwright-made:';

/**
 * The value after a tag's prefix, or null when the machine carries no such
 * tag. The first of them when it carries two, which nothing here writes.
 *
 * @param {any} vm @param {string} prefix
 * @returns {string|null}
 */
export function tagValue(vm, prefix) {
  const tags = Array.isArray(vm?.tags) ? vm.tags : [];
  const tag = tags.find((/** @type {unknown} */ t) => typeof t === 'string' && t.startsWith(prefix));
  return tag === undefined ? null : String(tag).slice(prefix.length);
}

/**
 * Whether a resize has this machine now: marked busy less than BUSY_MS ago,
 * or marked with the bare tag an older box writes, which the sweep stamps
 * with the time it first saw it and then honours like the rest. A reader
 * that cannot stamp it (this one) takes the bare tag as busy now, which is
 * what the sweep would conclude on first sight too.
 *
 * @param {string[]} tags @param {number} now
 */
export function markedBusy(tags, now) {
  if (tags.includes(BUSY_TAG)) return true;
  const stamp = tags.find((t) => t.startsWith(BUSY_PREFIX));
  if (stamp === undefined) return false;
  const since = Number(stamp.slice(BUSY_PREFIX.length)) * 1000;
  return since > 0 && now - since < BUSY_MS;
}

/**
 * Whether the sweep would remove this machine now, disks and all: running
 * well past the end it was given, or stopped once it is older than YOUNG_MS
 * and past its end (a machine with no end in its tags was never given one to
 * wait for, and goes as it did). Stopped before its end is not done: the
 * sweep starts it again once and then waits for its end. Busy is not asked
 * here: ask markedBusy first, as the sweep does.
 *
 * @param {any} vm @param {number} now
 */
export function machineDone(vm, now) {
  const untilTag = tagValue(vm, VM_IMAGE.untilPrefix);
  const until = untilTag === null ? NaN : Number(untilTag) * 1000;
  const overdue = Number.isFinite(until) && now > until + GRACE_MS;
  if (vm?.power_state !== 'Halted') return overdue;
  const made = Number(tagValue(vm, MADE_PREFIX)) * 1000;
  if (made > 0 && now - made < YOUNG_MS) return false;
  if (Number.isFinite(until) && now <= until) return false;
  return true;
}
