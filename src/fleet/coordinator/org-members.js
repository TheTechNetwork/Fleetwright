// The fleet's organization: who its members are, and who may change one
// (docs/members.md).
//
// NOT THE PEOPLE WHO MAY SIGN IN. "Member" already means somebody with a
// credential here (clients.js, invites.js, member-page.js), and that list
// decides who is in the fleet. This one says what the fleet is made of: a
// person or an agent, with a role, a place in a tree and standing
// instructions. A person member names somebody on the other list by their
// address; an agent member names nobody.
//
// WHO WRITES. A fleet admin writes anything. A manager writes inside their
// own team and nowhere else: the members the tree puts under them, moved only
// to places still under them, and never the fields that decide who manages
// whom from outside the tree (`managers`), or who a member is (`kind`,
// `email`). Everybody in the fleet reads all of it.
//
// WHAT THIS IS NOT IS CUSTODY. Who may sign a member in, or start a session
// as one, is held and checked by the minter, on a copy of the tree it was
// given by the people entitled to change it. This store is the coordinator's
// word, and the coordinator is the party a box does not believe. It refuses
// first, in a person's words, and decides nothing a box relies on.
//
// ONE DURABLE OBJECT VALUE A MEMBER, under `members:<id>`. Every other store
// here is one value, and a value holds 128 KiB: a member's instructions are
// 4 KiB before anything else, so one value would hold about a dozen members.
// `takeChanges` says which rows to write and which to delete since it was
// last asked, and the Durable Object does exactly that.
//
// NEVER THROWS. Every refusal is a code and a sentence.

import { checkMember, checkTree, manages, teamOf, toMarkdown, fromMarkdown, MAX_MEMBERS } from '../protocol/members.js';

/** The prefix a member's row is stored under. */
export const MEMBERS_PREFIX = 'members:';

/** @typedef {import('../protocol/members.js').Member} Member */
/** @typedef {{ email?: string|null, admin?: boolean }|null} Requester */

/** @param {string} code @param {string} text */
const refuse = (code, text) => /** @type {const} */ ({ ok: false, error: { code }, text });
/** @param {unknown} s */
const lower = (s) => String(s ?? '').trim().toLowerCase();

/** A null requester is the break-glass token, an admin everywhere (fleet-do.js). */
const isAdmin = (/** @type {Requester} */ requester) => !requester || Boolean(requester.admin);

export class OrgMembers {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, Member>} in the order they were made */
    this.byId = new Map();
    /** @type {Set<string>} ids written or removed since takeChanges was last called */
    this.dirty = new Set();
  }

  /** @param {unknown} id @returns {Member|null} */
  get(id) {
    return this.byId.get(String(id ?? '')) ?? null;
  }

  /** @returns {Member[]} */
  all() {
    return [...this.byId.values()];
  }

  /** @param {string|null|undefined} email @returns {Member|null} the person member at this address */
  personAt(email) {
    const address = lower(email);
    if (!address) return null;
    for (const m of this.byId.values()) if (m.kind === 'person' && m.email === address) return m;
    return null;
  }

  /**
   * May this person change this member? An admin may; so may anybody the
   * tree, or an admin's `managers`, puts above it.
   *
   * @param {Requester} requester @param {string} id
   */
  mayManage(requester, id) {
    return isAdmin(requester) || manages(this.byId, requester?.email, id);
  }

  /**
   * What the tree lets this person do, for the list every screen draws from:
   * which member is theirs, whom they manage, and whom they may ask to start
   * a session as. Custody the minter holds beyond the tree is not in here;
   * `custodians` is the last list the minter signed (core.js), when there is
   * one, and adds the members it names this person for.
   *
   * @param {Requester} requester
   * @param {Map<string, string[]>|null} [custodians]  member id → addresses that may start as it
   */
  standing(requester, custodians = null) {
    const email = lower(requester?.email);
    const admin = isAdmin(requester);
    const own = this.personAt(email);
    const byTree = teamOf(this.byId, email);
    const team = admin ? [...this.byId.keys()] : byTree;
    // WHOM THEY MAY START AS is custody, which an admin does not have by
    // being one. With the minter's list, it is the list. Without one yet, it
    // is the agents the tree puts under them, which the minter's own tree
    // will say too once it is filed; a person on their team is left out
    // until the list says that person allowed it.
    const startAs = new Set();
    if (own) startAs.add(own.id);
    if (custodians) {
      if (email) for (const [id, who] of custodians) if (this.byId.has(id) && who.includes(email)) startAs.add(id);
    } else {
      for (const id of byTree) if (this.byId.get(id)?.kind === 'agent') startAs.add(id);
    }
    return { admin, member: own?.id ?? null, manages: team, startAs: [...this.byId.keys()].filter((id) => startAs.has(id)) };
  }

  /**
   * Make a member, or change one.
   *
   * @param {Requester} requester
   * @param {unknown} id
   * @param {unknown} input  the record's fields; `id` is the route's
   * @returns {{ ok: true, member: Member, created: boolean, text: string } | { ok: false, error: { code: string }, text: string }}
   */
  set(requester, id, input) {
    const checked = checkMember({ .../** @type {any} */ (input && typeof input === 'object' ? input : {}), id });
    if (!checked.ok) return refuse('bad_params', checked.text);
    const next = checked.member;
    const prior = this.byId.get(next.id) ?? null;
    const admin = isAdmin(requester);
    const email = lower(requester?.email);

    if (!admin) {
      if (!email) return refuse('not_signed_in', 'Changing a member needs a signed-in identity.');
      const own = this.personAt(email);
      // WHERE IT WOULD SIT must be under this manager: their own member, or a
      // member they manage. That is "not outside their own team", for a new
      // member and for a move alike.
      const underThem = next.reportsTo !== null && (next.reportsTo === own?.id || manages(this.byId, email, next.reportsTo));
      if (prior ? !manages(this.byId, email, prior.id) : !underThem) {
        return refuse('not_manager', prior
          ? `${prior.name} is not on your team, so you cannot change them. An admin, or whoever they report to, can.`
          : 'You can add a member to your own team: somebody who reports to you, or to a member you manage. An admin can add one anywhere.');
      }
      if (!underThem) {
        return refuse('not_manager', `You can move ${prior?.name ?? next.name} within your own team. Moving them out of it is an admin’s to do.`);
      }
      // WHO MANAGES FROM OUTSIDE THE TREE, and who a member is, stay an
      // admin's. A manager who could write `managers` could name a friend
      // above their own team, and one who could write `email` could point a
      // person member at another person's vault.
      const same = (/** @type {string[]} */ a, /** @type {string[]} */ b) => a.length === b.length && a.every((x, i) => x === b[i]);
      if (!same(next.managers, prior?.managers ?? [])) return refuse('not_admin', 'Naming extra managers on a member is an admin’s to do.');
      if (prior && (next.kind !== prior.kind || lower(next.email) !== lower(prior.email))) {
        return refuse('not_admin', 'Whether a member is a person or an agent, and whose address it is, is an admin’s to change.');
      }
    }
    if (prior && next.kind !== prior.kind) {
      return refuse('bad_params', `${prior.name} is ${prior.kind === 'agent' ? 'an agent' : 'a person'}, and a member does not change kind: its vault is kept under what it is. Remove it and add it again.`);
    }
    const fits = checkTree(this.byId, next);
    if (!fits.ok) return refuse('bad_params', fits.text);

    const t = this.now();
    /** @type {Member} */
    const member = { ...next, createdBy: prior?.createdBy ?? (email || 'an admin'), createdAt: prior?.createdAt ?? t, updatedAt: t };
    this.byId.set(member.id, member);
    this.dirty.add(member.id);
    return { ok: true, member, created: !prior, text: prior ? `Saved ${member.name}.` : `Added ${member.name} as ${member.role}.` };
  }

  /**
   * @param {Requester} requester @param {unknown} id
   * @returns {{ ok: true, member: Member, text: string } | { ok: false, error: { code: string }, text: string }}
   */
  remove(requester, id) {
    const member = this.byId.get(String(id ?? ''));
    if (!member) return refuse('no_member', 'There is no member by that id.');
    if (!this.mayManage(requester, member.id)) {
      return refuse('not_manager', `${member.name} is not on your team, so you cannot remove them. An admin, or whoever they report to, can.`);
    }
    const reports = this.all().filter((m) => m.reportsTo === member.id);
    if (reports.length) {
      return refuse('has_reports', `${reports.map((m) => m.name).join(', ')} ${reports.length === 1 ? 'reports' : 'report'} to ${member.name}. Move ${reports.length === 1 ? 'them' : 'each of them'} first.`);
    }
    this.byId.delete(member.id);
    this.dirty.add(member.id);
    return { ok: true, member, text: `Removed ${member.name}. Its vault is not deleted by this: forget what it keeps from its Credentials first, or after, as one of its custodians.` };
  }

  /** Every member as a file (docs/members.md, "The file"). */
  exportFiles() {
    return this.all().map((m) => ({ name: `${m.id}.md`, text: toMarkdown(m) }));
  }

  /**
   * One file, made or changed under the same rules as any other write.
   *
   * @param {Requester} requester @param {unknown} text
   */
  importFile(requester, text) {
    const read = fromMarkdown(text);
    if (!read.ok) return refuse('bad_params', read.text);
    return this.set(requester, read.member.id, read.member);
  }

  /**
   * What changed since this was last asked, as Durable Object rows.
   *
   * @returns {{ put: Record<string, Member>, del: string[] }}
   */
  takeChanges() {
    /** @type {Record<string, Member>} */
    const put = {};
    /** @type {string[]} */
    const del = [];
    for (const id of this.dirty) {
      const m = this.byId.get(id);
      if (m) put[`${MEMBERS_PREFIX}${id}`] = m;
      else del.push(`${MEMBERS_PREFIX}${id}`);
    }
    this.dirty.clear();
    return { put, del };
  }

  /** Every member, for a store that keeps one value (the Node coordinator's state file). */
  serialise() {
    return this.all();
  }

  /**
   * Anything that does not read as a member is dropped, and so is one whose
   * manager did not come back: a record read from storage decides who may
   * edit whom, and a damaged one must not.
   *
   * @param {unknown} rows  an array, or what `storage.list({ prefix })` gives
   */
  restore(rows) {
    const list = rows instanceof Map ? [...rows.values()] : Array.isArray(rows) ? rows : [];
    /** @type {Member[]} */
    const read = [];
    for (const row of list) {
      const checked = checkMember(row);
      if (!checked.ok) continue;
      const r = /** @type {any} */ (row);
      read.push({ ...checked.member, createdBy: String(r.createdBy || ''), createdAt: Number(r.createdAt) || 0, updatedAt: Number(r.updatedAt) || 0 });
    }
    read.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.id < b.id ? -1 : 1));
    // Managers before their reports, so each is checked against a tree that
    // already holds whom it reports to. What is left over reports to nobody
    // that came back, or to a loop.
    let pending = read;
    while (pending.length && this.byId.size < MAX_MEMBERS) {
      const waiting = [];
      let placed = 0;
      for (const m of pending) {
        if (this.byId.size >= MAX_MEMBERS) break;
        if (checkTree(this.byId, m).ok) {
          this.byId.set(m.id, m);
          placed++;
        } else {
          waiting.push(m);
        }
      }
      if (!placed) break;
      pending = waiting;
    }
  }
}

/** What each refusal answers with. Anything not here is a 400. */
const STATUS = Object.freeze({ not_signed_in: 403, not_manager: 403, not_admin: 403, no_member: 404, has_reports: 409 });

/**
 * The `/api/members` routes, for both coordinators, so the Worker's and the
 * Node one's cannot come to differ:
 *
 *   GET    /api/members          everybody in the fleet
 *   GET    /api/members/export   every member as a file
 *   POST   /api/members/import   { text }: one file, made or changed
 *   PUT    /api/members/{id}     a record's fields
 *   DELETE /api/members/{id}
 *
 * @param {{ membersFor: Function, setMember: Function, removeMember: Function, exportMembers: Function, importMember: Function }} core
 * @param {string|undefined} method @param {string} pathname
 * @param {Requester} requester
 * @param {() => Promise<any>} readBody
 * @returns {Promise<{ status: number, body: any }|null>} null for a path or method this does not serve
 */
export async function membersRoute(core, method, pathname, requester, readBody) {
  /** @param {any} r */
  const said = (r) => ({ status: r.ok ? 200 : (STATUS[/** @type {keyof typeof STATUS} */ (r.error?.code)] ?? 400), body: r });
  if (pathname === '/api/members') return method === 'GET' ? said(core.membersFor(requester)) : null;
  if (pathname === '/api/members/export') return method === 'GET' ? said(core.exportMembers()) : null;
  if (pathname === '/api/members/import') return method === 'POST' ? said(core.importMember(requester, (await readBody())?.text)) : null;
  /** @type {string} */
  let id;
  try {
    id = decodeURIComponent(pathname.slice('/api/members/'.length));
  } catch {
    return said(refuse('bad_params', 'That is not a member’s id.'));
  }
  if (method === 'PUT') return said(core.setMember(requester, id, await readBody()));
  if (method === 'DELETE') return said(core.removeMember(requester, id));
  return null;
}
