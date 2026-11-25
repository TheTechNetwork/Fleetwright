// Who may start a session as each member, as the minter last signed it for a
// box, kept so a coordinator that has just started still knows it
// (docs/members.md, "Starting as a member"; docs/budgets.md, "Only sessions
// the fleet itself started").
//
// READ OFF THE ANSWER ON ITS WAY TO A BOX, NEVER WRITTEN BY ANYBODY HERE. The
// minter holds custody and a box checks the signed list itself. This copy
// lets the coordinator refuse first in a person's words, and it is what the
// coordinator counts spend on: a start as a member is where that member's
// month begins to be spent, on the word of whichever box the start went to.
//
// WHY IT IS KEPT. It used to live in memory, null from every start of this
// object until a box next asked for keys, and while it was null nobody was
// refused. In that window anybody signed in could start "as Debbie" on a
// box of their own, which then reported any cost it liked as hers. A
// Durable Object is rebuilt often, so the window was most of the time.
//
// UNKNOWN IS NOT EMPTY. `list` is null until a list has been heard, ever,
// and a start by somebody who is not an admin is then refused as
// cannot-tell (core.js, #startAs). A list that names nobody for a member is
// an answer: that member's custody has not been filed.
//
// ONE DURABLE OBJECT VALUE A MEMBER, under `custody:<id>`, as members,
// tasks and spend are: a member may have sixty-four custodians, and every
// member's in one value would not fit. `custodyAt` is when the list was last
// seen to change, and its presence is what says a list was heard at all.
//
// NEVER THROWS.

import { MEMBER_ID_RE } from '../protocol/members.js';

/** The prefix a member's custodians are stored under. */
export const CUSTODY_PREFIX = 'custody:';
/** How many members' custodians are kept: more than a fleet may have members, so a list is never cut short. */
export const MAX_CUSTODY_MEMBERS = 512;
/** How many addresses are kept for one member. */
export const MAX_CUSTODIANS = 64;
/** The longest address kept, in characters: what an email address may be. */
export const MAX_CUSTODIAN_ADDRESS = 254;

/** A member's custodians as stored or sent, read as if a stranger wrote them. @param {unknown} may @returns {string[]|null} */
function addresses(may) {
  if (!Array.isArray(may)) return null;
  return may.slice(0, MAX_CUSTODIANS).map((a) => String(a).toLowerCase()).filter((a) => a && a.length <= MAX_CUSTODIAN_ADDRESS);
}

export class OrgCustody {
  constructor() {
    /** Member id → the addresses that may start as it. Null until a list has been heard. @type {Map<string, string[]>|null} */
    this.list = null;
    /** When the list was last seen to change. */
    this.at = 0;
    /** @type {Set<string>} ids whose row changed since takeChanges was last called */
    this.dirty = new Set();
    this.atDirty = false;
  }

  /**
   * The list the minter just signed for a box: `[{ id, may }]`. Answers
   * whether anything is different from what was held, so the caller writes
   * only then: a box asks every ten minutes and the answer is nearly always
   * the same one.
   *
   * @param {unknown} members @param {number} at
   */
  heard(members, at) {
    if (!Array.isArray(members)) return false;
    /** @type {Map<string, string[]>} */
    const next = new Map();
    for (const m of members.slice(0, MAX_CUSTODY_MEMBERS)) {
      const may = addresses(m?.may);
      if (!m || !MEMBER_ID_RE.test(String(m.id)) || !may) continue;
      next.set(String(m.id), may);
    }
    return this.replace(next, at);
  }

  /**
   * Hold this list in place of the one held, or none (`null`: nothing has
   * been heard). True when it differs.
   *
   * @param {Map<string, string[]>|null} next @param {number} at
   */
  replace(next, at) {
    const was = this.list;
    let changed = (was === null) !== (next === null);
    for (const id of new Set([...(was?.keys() ?? []), ...(next?.keys() ?? [])])) {
      if (JSON.stringify(was?.get(id) ?? null) === JSON.stringify(next?.get(id) ?? null)) continue;
      this.dirty.add(id);
      changed = true;
    }
    this.list = next;
    if (changed) {
      this.at = next ? at : 0;
      this.atDirty = true;
    }
    return changed;
  }

  /** What changed since this was last asked: rows to put, keys to delete, and the time when it moved. */
  takeChanges() {
    /** @type {Record<string, string[]>} */
    const put = {};
    /** @type {string[]} */
    const del = [];
    for (const id of this.dirty) {
      const may = this.list?.get(id);
      if (may) put[`${CUSTODY_PREFIX}${id}`] = may;
      else del.push(`${CUSTODY_PREFIX}${id}`);
    }
    // Null is nothing to write. A list put aside writes 0, which `restore`
    // reads as nothing heard.
    const at = this.atDirty ? (this.list ? this.at : 0) : null;
    this.dirty.clear();
    this.atDirty = false;
    return { put, del, at };
  }

  /** Everything, as one value: the Node coordinator's file. Null while nothing has been heard. */
  serialise() {
    return this.list ? { at: this.at, members: Object.fromEntries(this.list) } : null;
  }

  /**
   * Back from storage. With no time kept, nothing was ever heard, and rows
   * found without one are not a list: they are left unread.
   *
   * @param {{ at?: unknown, members?: Iterable<[string, unknown]>|Record<string, unknown>|null }|null} [saved]
   */
  restore(saved) {
    const at = Number(saved?.at);
    if (!saved || !(at > 0)) return;
    const rows = saved.members instanceof Map ? [...saved.members] : saved.members && typeof saved.members === 'object' && !(Symbol.iterator in saved.members) ? Object.entries(saved.members) : [...(saved.members ?? [])];
    /** @type {Map<string, string[]>} */
    const list = new Map();
    for (const [key, row] of rows.slice(0, MAX_CUSTODY_MEMBERS)) {
      const id = String(key).startsWith(CUSTODY_PREFIX) ? String(key).slice(CUSTODY_PREFIX.length) : String(key);
      const may = addresses(row);
      if (MEMBER_ID_RE.test(id) && may) list.set(id, may);
    }
    this.list = list;
    this.at = at;
  }
}
