// What each member has spent this month, the fleet's setting for what a
// budget does, and the approvals a start waits on (docs/budgets.md).
//
// The rules are src/fleet/protocol/budgets.js, which counts and decides.
// This keeps the rows, for the Durable Object and the Node coordinator alike,
// and serves them.
//
// ONE VALUE A MEMBER (`spend:<id>`) AND ONE AN APPROVAL (`approvals:<id>`),
// for the reason members and tasks are: a value holds 128 KiB. A member's
// row is its month, its total and the last figure of at most sixty sessions;
// two hundred members in one value would not fit. The setting and the
// counter that numbers approvals are a value each.
//
// NEVER THROWS. Every refusal is a code and a sentence.

import {
  checkBudgetSettings, NO_BUDGET_SETTINGS, newSpend, startCounting, resumeCounting, countSpend, readSpend, overBudget,
  newApproval, aged, covers, answerApproval, readApproval, APPROVAL_ID_RE, MAX_APPROVALS, BUDGET_WARN_AT,
} from '../protocol/budgets.js';

export const SPEND_PREFIX = 'spend:';
export const APPROVALS_PREFIX = 'approvals:';
export const APPROVAL_SEQ_KEY = 'approvalSeq';
export const BUDGET_SETTINGS_KEY = 'budgetSettings';

/** @typedef {import('../protocol/budgets.js').Spend} Spend */
/** @typedef {import('../protocol/budgets.js').Approval} Approval */

/** @param {string} code @param {string} text */
const refuse = (code, text) => /** @type {const} */ ({ ok: false, error: { code }, text });

export class OrgBudgets {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {import('../protocol/budgets.js').BudgetSettings} */
    this.settings = { budgets: 'off', dangerous: false, workTypes: [], updatedBy: null, updatedAt: 0 };
    /** @type {Map<string, Spend>} member id → its month */
    this.spend = new Map();
    /** @type {Map<string, Approval>} in the order they were asked */
    this.approvals = new Map();
    this.seq = 0;
    /** @type {Set<string>} */
    this.dirtySpend = new Set();
    /** @type {Set<string>} */
    this.dirtyApprovals = new Set();
    this.settingsDirty = false;
    this.seqDirty = false;
  }

  /** @param {{ email: string, admin: boolean }} who @param {unknown} input */
  setSettings(who, input) {
    if (!who.admin) return refuse('not_admin', 'What a budget does is set by a fleet admin. Anybody can read it.');
    const checked = checkBudgetSettings(input, this.settings);
    if (!checked.ok) return refuse(checked.code, checked.text);
    this.settings = { budgets: checked.budgets, dangerous: checked.dangerous, workTypes: checked.workTypes, updatedBy: who.email || 'an admin', updatedAt: this.now() };
    this.settingsDirty = true;
    const at = { off: 'Budgets are counted and stop nothing.', ask: 'A start past a member’s budget waits for approval.', refuse: 'A start past a member’s budget is refused.' }[checked.budgets];
    const more = [
      checked.dangerous ? 'A member start that skips permission prompts waits for approval.' : '',
      checked.workTypes.length ? `A start on ${checked.workTypes.join(', ')} work waits for approval.` : '',
    ].filter(Boolean).join(' ');
    return { ok: true, settings: this.settings, text: `${at}${more ? ` ${more}` : ''}` };
  }

  /** A member's row, as the month `now` is in. @param {string} member @returns {Spend|null} */
  spendOf(member) {
    return this.spend.get(member) ?? null;
  }

  /** @param {string} member @param {Spend} next */
  #keepSpend(member, next) {
    if (this.spend.get(member) === next) return;
    this.spend.set(member, next);
    this.dirtySpend.add(member);
  }

  /** The fleet started a session as this member: it counts from nothing. @param {string} member @param {string} key */
  started(member, key) {
    this.#keepSpend(member, startCounting(this.spend.get(member) ?? newSpend(this.now()), key, this.now()));
  }

  /** The fleet resumed a session as this member: it counts from the first figure heard. @param {string} member @param {string} key */
  resumed(member, key) {
    this.#keepSpend(member, resumeCounting(this.spend.get(member) ?? newSpend(this.now()), key, this.now()));
  }

  /**
   * One report of what a session has cost, counted. Answers which of the
   * month's two notices this report is the first to earn, if either: the
   * budget nearly spent, or spent. Each goes out once a month.
   *
   * @param {string} member @param {string} key @param {unknown} spent @param {number|null|undefined} budget
   * @returns {'warn'|'over'|null}
   */
  count(member, key, spent, budget) {
    const was = this.spend.get(member);
    if (!was) return null;
    let next = countSpend(was, key, spent, this.now());
    /** @type {'warn'|'over'|null} */
    let crossed = null;
    if (typeof budget === 'number' && budget > 0) {
      if (!next.told.over && overBudget(next, budget)) {
        crossed = 'over';
        next = { ...next, told: { ...next.told, warn: true, over: true } };
      } else if (!next.told.warn && next.usd >= budget * BUDGET_WARN_AT) {
        crossed = 'warn';
        next = { ...next, told: { ...next.told, warn: true } };
      }
    }
    this.#keepSpend(member, next);
    return crossed;
  }

  /** A member was removed: its row goes with it. @param {string} member */
  forget(member) {
    if (this.spend.delete(member)) this.dirtySpend.add(member);
  }

  /** @param {Approval} a */
  #keepApproval(a) {
    this.approvals.set(a.id, a);
    this.dirtyApprovals.add(a.id);
  }

  /** One approval as time has left it, written back when time changed it. @param {string} id @returns {Approval|null} */
  get(id) {
    const a = this.approvals.get(id);
    if (!a) return null;
    const now = aged(a, this.now());
    if (now !== a) this.#keepApproval(now);
    return now;
  }

  /** Every approval, oldest first, as time has left each. @returns {Approval[]} */
  all() {
    return [...this.approvals.keys()].map((id) => /** @type {Approval} */ (this.get(id)));
  }

  /**
   * An approval already given that covers this start, or null. Looked for
   * when the start is first read, and taken only once it is about to be
   * sent (`take`): a start refused on the way for some other reason, a
   * machine that is full, has not spent it.
   *
   * @param {{ member: string, task?: string|null, kinds: string[], by: string }} start
   * @returns {Approval|null}
   */
  given(start) {
    return this.all().find((a) => a.state === 'approved' && covers(a, start)) ?? null;
  }

  /**
   * Take an approval for the one start it is for. False when it is no longer
   * there to take: used by another start a moment ago, or run out.
   *
   * @param {string} id
   */
  take(id) {
    const a = this.get(id);
    if (a?.state !== 'approved') return false;
    this.#keepApproval({ ...a, state: 'used' });
    return true;
  }

  /** The start an approval was taken for did not happen: it is good again, within its hour. @param {string} id */
  giveBack(id) {
    const a = this.approvals.get(id);
    if (a?.state === 'used') this.#keepApproval(aged({ ...a, state: 'approved' }, this.now()));
  }

  /**
   * Ask for an approval, or find the one already waiting for the same thing.
   *
   * @param {{ member: string, task?: string|null, reasons: import('../protocol/budgets.js').Reason[], by: string }} q
   * @returns {{ approval: Approval, fresh: boolean }}
   */
  ask({ member, task = null, reasons, by }) {
    const kinds = reasons.map((r) => r.kind);
    const waiting = this.all().find((a) => a.state === 'waiting' && covers(a, { member, task, kinds, by }));
    if (waiting) return { approval: waiting, fresh: false };
    if (this.approvals.size >= MAX_APPROVALS) {
      // The oldest that is finished goes; with none finished, the oldest of all.
      const all = this.all();
      const drop = all.find((a) => a.state !== 'waiting' && a.state !== 'approved') ?? all[0];
      this.approvals.delete(drop.id);
      this.dirtyApprovals.add(drop.id);
    }
    this.seq += 1;
    this.seqDirty = true;
    const approval = newApproval({ id: `a${this.seq}`, member, task, reasons, by, at: this.now() });
    this.#keepApproval(approval);
    return { approval, fresh: true };
  }

  /**
   * A person's answer. Whether they may give it is the caller's to say: this
   * does not hold the tree.
   *
   * @param {unknown} id @param {unknown} answer @param {{ by: string, note?: unknown }} who
   */
  answer(id, answer, { by, note }) {
    const key = String(id ?? '').toLowerCase();
    const a = APPROVAL_ID_RE.test(key) ? this.get(key) : null;
    if (!a) return refuse('no_approval', 'There is no approval by that id that you can see.');
    const next = answerApproval(a, answer, { by, at: this.now(), note });
    if (!next.ok) return refuse(next.code, next.text);
    this.#keepApproval(next.approval);
    return { ok: true, approval: next.approval };
  }

  /** What changed since this was last asked: rows to put and keys to delete, the setting, and the counter. */
  takeChanges() {
    /** @type {Record<string, unknown>} */
    const put = {};
    /** @type {string[]} */
    const del = [];
    for (const m of this.dirtySpend) {
      const row = this.spend.get(m);
      if (row) put[`${SPEND_PREFIX}${m}`] = row;
      else del.push(`${SPEND_PREFIX}${m}`);
    }
    for (const id of this.dirtyApprovals) {
      const a = this.approvals.get(id);
      if (a) put[`${APPROVALS_PREFIX}${id}`] = a;
      else del.push(`${APPROVALS_PREFIX}${id}`);
    }
    const settings = this.settingsDirty ? this.settings : null;
    const seq = this.seqDirty ? this.seq : null;
    this.dirtySpend.clear();
    this.dirtyApprovals.clear();
    this.settingsDirty = false;
    this.seqDirty = false;
    return { put, del, settings, seq };
  }

  /** Everything, as one value: the Node coordinator's file. */
  serialise() {
    return { settings: this.settings, spend: Object.fromEntries(this.spend), approvals: [...this.approvals.values()], seq: this.seq };
  }

  /**
   * Back from storage, each row read as if a stranger wrote it.
   *
   * @param {{ settings?: unknown, spend?: Iterable<[string, unknown]>|Record<string, unknown>|null, approvals?: Iterable<unknown>|null, seq?: unknown }} [saved]
   */
  restore(saved = {}) {
    const s = /** @type {any} */ (saved.settings);
    const checked = checkBudgetSettings(s && typeof s === 'object' ? { budgets: s.budgets, dangerous: s.dangerous, workTypes: s.workTypes } : null, NO_BUDGET_SETTINGS);
    if (checked.ok) this.settings = { budgets: checked.budgets, dangerous: checked.dangerous, workTypes: checked.workTypes, updatedBy: typeof s.updatedBy === 'string' ? s.updatedBy.slice(0, 200) : null, updatedAt: Number(s.updatedAt) || 0 };
    const rows = saved.spend instanceof Map ? [...saved.spend] : saved.spend && typeof saved.spend === 'object' && !(Symbol.iterator in saved.spend) ? Object.entries(saved.spend) : [...(saved.spend ?? [])];
    for (const [key, row] of rows) {
      const member = String(key).startsWith(SPEND_PREFIX) ? String(key).slice(SPEND_PREFIX.length) : String(key);
      const read = readSpend(row);
      if (read && member) this.spend.set(member, read);
    }
    /** @type {Approval[]} */
    const read = [];
    for (const row of saved.approvals instanceof Map ? saved.approvals.values() : (saved.approvals ?? [])) {
      const a = readApproval(row);
      if (a) read.push(a);
    }
    read.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    for (const a of read.slice(-MAX_APPROVALS)) this.approvals.set(a.id, a);
    const highest = read.length ? Number(read[read.length - 1].id.slice(1)) : 0;
    const kept = Number.isSafeInteger(Number(saved.seq)) && Number(saved.seq) > 0 ? Number(saved.seq) : 0;
    this.seq = Math.max(highest, kept);
  }
}

/** What each refusal answers with. Anything not here is a 400. */
const STATUS = Object.freeze({ not_admin: 403, not_manager: 403, not_signed_in: 403, no_approval: 404, approval_closed: 409 });

/**
 * The budget and approval routes, for both coordinators.
 *
 *   GET  /api/budgets              { settings, members, you }
 *   PUT  /api/budgets/settings     { budgets?, dangerous?, workTypes? }, an admin
 *   GET  /api/approvals            { approvals }
 *   POST /api/approvals/{id}       { answer: approve | decline, note? }
 *
 * Returns null for a path or method that is not one of these.
 *
 * @param {{ budgetsFor: Function, setBudgetSettings: Function, approvalsFor: Function, answerApproval: Function }} core
 * @param {string} method @param {string} pathname
 * @param {{ email?: string|null, admin?: boolean }|null} requester
 * @param {() => Promise<any>} readBody
 * @returns {Promise<{ status: number, body: any }|null>}
 */
export async function budgetsRoute(core, method, pathname, requester, readBody) {
  /** @param {any} r */
  const said = (r) => ({ status: r.ok ? 200 : (STATUS[/** @type {keyof typeof STATUS} */ (r.error?.code)] ?? 400), body: r });
  if (pathname === '/api/budgets' && method === 'GET') return said(core.budgetsFor(requester));
  if (pathname === '/api/budgets/settings' && method === 'PUT') return said(core.setBudgetSettings(requester, await readBody()));
  if (pathname === '/api/approvals' && method === 'GET') return said(core.approvalsFor(requester));
  if (pathname.startsWith('/api/approvals/') && method === 'POST') {
    const rest = pathname.slice('/api/approvals/'.length);
    if (!rest || rest.includes('/')) return null;
    let id;
    try {
      id = decodeURIComponent(rest);
    } catch {
      return said(refuse('no_approval', 'That is not an approval’s id.'));
    }
    const body = await readBody();
    return said(await core.answerApproval(requester, id, body?.answer, body?.note));
  }
  return null;
}
