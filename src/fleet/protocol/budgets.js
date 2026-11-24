// What a member has spent this month, what a start needs approval for, and
// an approval's life (docs/budgets.md).
//
// WHY IT IS HERE AND NOT IN THE COORDINATOR. The coordinator counts and
// gates; the MCP server and both phones say the same figures and reasons in
// words. One file, so the sentence a refusal carries and the one a screen
// draws cannot come to differ. No imports beyond its neighbours here, so the
// Worker bundles take it.
//
// THE COUNT IS OF WHAT WAS SEEN BEING SPENT, and nothing else: a session's
// own running total goes up, and the difference is added. Nothing here
// prices a token, and a session that reports no dollars is counted as one
// whose cost is unknown, never as free (src/core/spent.js says why a price
// table is somebody else's product).
//
// NEVER THROWS. Every refusal is `{ ok: false, code, text }`.

import { MEMBER_ID_RE } from './members.js';
import { TASK_ID_RE } from './tasks.js';

export const BUDGET_MODES = Object.freeze(['off', 'ask', 'refuse']);
/** Why a start needs approval. */
export const APPROVAL_REASONS = Object.freeze(['over-budget', 'dangerous', 'risky-work']);
export const APPROVAL_STATES = Object.freeze(['waiting', 'approved', 'declined', 'used', 'expired']);
export const APPROVAL_ID_RE = /^a[1-9][0-9]{0,8}$/;
/** How many kinds of work an owner may name as needing approval. */
export const MAX_RISKY_WORK_TYPES = 20;
/** How many approvals a fleet keeps; past it the oldest finished one goes. */
export const MAX_APPROVALS = 200;
/** How many sessions' last figures a member's row keeps. */
export const MAX_SESSIONS_SEEN = 60;
/** A waiting approval nobody answers is over after a day. */
export const APPROVAL_WAIT_MS = 24 * 60 * 60_000;
/** A given approval is for a start within the hour. */
export const APPROVAL_USE_MS = 60 * 60_000;
/** A note beside an answer, in bytes of UTF-8. */
export const MAX_APPROVAL_NOTE = 300;
/** The share of a budget at which a member's managers are told it is nearly spent. */
export const BUDGET_WARN_AT = 0.8;

const WORK_TYPE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** @param {string} code @param {string} text */
const refuse = (code, text) => /** @type {const} */ ({ ok: false, code, text });

/** 'YYYY-MM' in UTC: the month a budget is for. */
export const monthOf = (/** @type {number} */ t) => new Date(t).toISOString().slice(0, 7);

/**
 * @typedef {{ budgets: 'off'|'ask'|'refuse', dangerous: boolean, workTypes: string[], updatedBy: string|null, updatedAt: number }} BudgetSettings
 * @typedef {object} Spend
 * @property {string} month                  'YYYY-MM', UTC
 * @property {number} usd                    what was seen being spent this month
 * @property {string[]} unknown              sessions this month whose cost is unknown, by key
 * @property {Record<string, number>} seen   the last figure seen for each session, by key, newest last
 * @property {{ warn?: boolean, over?: boolean }} told  which of the month's two notices went out
 * @typedef {{ kind: 'over-budget'|'dangerous'|'risky-work', text: string }} Reason
 * @typedef {object} Approval
 * @property {string} id
 * @property {string} member
 * @property {string|null} task
 * @property {Reason[]} reasons
 * @property {string} askedBy
 * @property {number} askedAt
 * @property {'waiting'|'approved'|'declined'|'used'|'expired'} state
 * @property {string} [decidedBy]
 * @property {number} [decidedAt]
 * @property {string} [note]
 */

/** A fleet that has set nothing: budgets stop nothing and nobody is asked. */
export const NO_BUDGET_SETTINGS = Object.freeze({ budgets: 'off', dangerous: false, workTypes: Object.freeze([]), updatedBy: null, updatedAt: 0 });

/**
 * The setting as an admin wrote it, checked. A field left out keeps what it
 * was.
 *
 * @param {unknown} input @param {{ budgets: string, dangerous: boolean, workTypes: readonly string[] }} [was]
 * @returns {{ ok: true, budgets: 'off'|'ask'|'refuse', dangerous: boolean, workTypes: string[] } | { ok: false, code: string, text: string }}
 */
export function checkBudgetSettings(input, was = NO_BUDGET_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse('bad_settings', 'The setting is what happens at a budget, whether a session that skips prompts needs approval, and the kinds of work that do.');
  const v = /** @type {Record<string, any>} */ (input);
  const budgets = v.budgets === undefined ? was.budgets : String(v.budgets);
  if (!BUDGET_MODES.includes(budgets)) return refuse('bad_settings', 'What happens at a budget is off, ask or refuse.');
  if (v.dangerous !== undefined && typeof v.dangerous !== 'boolean') return refuse('bad_settings', 'Whether a session that skips permission prompts needs approval is true or false.');
  const listed = v.workTypes === undefined ? [...was.workTypes] : v.workTypes;
  if (!Array.isArray(listed) || listed.length > MAX_RISKY_WORK_TYPES) return refuse('bad_settings', `The kinds of work that need approval are a list of at most ${MAX_RISKY_WORK_TYPES}.`);
  const workTypes = [...new Set(listed.map((t) => String(t).trim().toLowerCase()))];
  if (workTypes.some((t) => !WORK_TYPE_RE.test(t))) return refuse('bad_settings', 'A kind of work is a short slug: lowercase letters, digits and hyphens, like “deploy”.');
  return { ok: true, budgets: /** @type {'off'|'ask'|'refuse'} */ (budgets), dangerous: v.dangerous === undefined ? was.dangerous === true : v.dangerous, workTypes };
}

/** A member's row for a month in which nothing has been seen yet. @param {number} now @returns {Spend} */
export function newSpend(now) {
  return { month: monthOf(now), usd: 0, unknown: [], seen: {}, told: {} };
}

/** The same row in the month `now` is in: at the month's turn the total starts again and the last figures stay. */
function inMonth(/** @type {Spend} */ row, /** @type {number} */ now) {
  const month = monthOf(now);
  return row.month === month ? row : { month, usd: 0, unknown: [], seen: row.seen, told: {} };
}

/** `seen` with this session's figure newest, and no more than the row keeps. */
function remember(/** @type {Record<string, number>} */ seen, /** @type {string} */ key, /** @type {number} */ usd) {
  const { [key]: _was, ...rest } = seen;
  const next = { ...rest, [key]: usd };
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS_SEEN))) delete next[old];
  return next;
}

/**
 * A session the coordinator has just started as this member: it begins at
 * nothing, so everything its box reports afterwards is this member's.
 *
 * @param {Spend} row @param {string} key @param {number} now @returns {Spend}
 */
export function startCounting(row, key, now) {
  const r = inMonth(row, now);
  return { ...r, seen: remember(r.seen, key, 0) };
}

/** The figure a session is waiting to be first heard at (resumeCounting). */
const UNSEEN = -1;

/**
 * A session the coordinator has just resumed as this member. Its running
 * total already holds whatever the conversation cost before, which nobody
 * here saw being spent, so the first figure its box reports is where its
 * counting starts. A session already being counted is left as it is.
 *
 * @param {Spend} row @param {string} key @param {number} now @returns {Spend}
 */
export function resumeCounting(row, key, now) {
  const r = inMonth(row, now);
  return r.seen[key] === undefined ? { ...r, seen: remember(r.seen, key, UNSEEN) } : r;
}

/**
 * One report of what a session has cost so far, counted into its member's
 * month (docs/budgets.md, "What a member has spent").
 *
 * @param {Spend} row
 * @param {string} key    the session, as `<host>\n<name>`; one the fleet did not start or resume as this member is not counted
 * @param {unknown} spent what the box reported: `{ usd, complete }`, or nothing
 * @param {number} now
 * @returns {Spend} the same object when nothing changed
 */
export function countSpend(row, key, spent, now) {
  const r = inMonth(row, now);
  // ONLY A SESSION THE FLEET ITSELF STARTED OR RESUMED AS THIS MEMBER. Which
  // member a session is, in a health frame, is the box's word; counted on
  // that alone, a box could spend any member's budget by naming it.
  const last = r.seen[key];
  if (last === undefined) return r === row ? row : r;
  const s = /** @type {any} */ (spent);
  const usd = s && typeof s.usd === 'number' && Number.isFinite(s.usd) && s.usd >= 0 ? s.usd : null;
  // NO DOLLARS, OR DOLLARS IT SAYS ARE NOT ALL OF THEM: a session whose cost
  // is unknown. Whatever dollars it did report are still counted below.
  const unknown = (usd === null || s.complete === false) && !r.unknown.includes(key) ? [...r.unknown, key].slice(-MAX_SESSIONS_SEEN) : r.unknown;
  if (usd === null) return unknown === r.unknown && r === row ? row : { ...r, unknown };
  // RESUMED, AND FIRST HEARD OF WITH A FIGURE ALREADY ON IT: nobody saw that
  // being spent, or when. It is where this session's counting starts.
  const grew = last === UNSEEN ? 0 : usd >= last ? usd - last : usd;
  if (last === usd && unknown === r.unknown && r === row) return row;
  return { ...r, usd: Math.round((r.usd + grew) * 10_000) / 10_000, unknown, seen: remember(r.seen, key, usd) };
}

/** Dollars as a person reads them. */
export const dollars = (/** @type {number} */ usd) => `$${(Math.round(usd * 100) / 100).toFixed(2)}`;

/**
 * What a member has spent against its budget, as one sentence, the same on
 * every surface.
 *
 * @param {{ usd: number, unknown: string[] }|null} row @param {number|null|undefined} budget
 */
export function spendWords(row, budget) {
  const usd = row?.usd ?? 0;
  const unknown = row?.unknown.length ?? 0;
  const least = unknown ? 'At least ' : '';
  const of_ = typeof budget === 'number' ? ` of ${dollars(budget)}` : '';
  const more = unknown ? ` ${unknown === 1 ? 'One session' : `${unknown} sessions`} reported no cost, so the real figure is higher by an amount nobody counted.` : '';
  return `${least}${dollars(usd)}${of_} this month, at API prices as each session counted it.${more}`;
}

/** Is this member at or past its budget on what was counted? A member with no budget never is. */
export function overBudget(/** @type {{ usd: number }|null} */ row, /** @type {number|null|undefined} */ budget) {
  return typeof budget === 'number' && (row?.usd ?? 0) >= budget;
}

/**
 * Why a start as this member needs approval, or that it is refused outright,
 * or neither (docs/budgets.md, "What needs approval").
 *
 * @param {object} q
 * @param {{ budgets: string, dangerous: boolean, workTypes: readonly string[] }} q.settings
 * @param {{ id: string, name?: string, budgetUsdMonth?: number|null }} q.member
 * @param {{ usd: number, unknown: string[] }|null} q.spend
 * @param {{ dangerous: boolean, workType?: string|null, task?: string|null }} q.start
 * @returns {{ refused: string } | { reasons: Reason[] }}
 */
export function approvalNeeded({ settings, member, spend, start }) {
  const who = member.name || member.id;
  /** @type {Reason[]} */
  const reasons = [];
  if (settings.budgets !== 'off' && overBudget(spend, member.budgetUsdMonth)) {
    const said = `${who} has spent ${dollars(spend?.usd ?? 0)} of a budget of ${dollars(/** @type {number} */ (member.budgetUsdMonth))} this month.`;
    if (settings.budgets === 'refuse') return { refused: `${said} The fleet refuses a start past a budget: it can start again when the month turns, or when the budget is raised.` };
    reasons.push({ kind: 'over-budget', text: said });
  }
  if (settings.dangerous && start.dangerous) reasons.push({ kind: 'dangerous', text: `This session would not ask before it runs commands, on ${who}’s sign-ins.` });
  if (start.workType && settings.workTypes.includes(start.workType)) {
    reasons.push({ kind: 'risky-work', text: `${start.task ? `${start.task} is` : 'This is'} ${start.workType} work, which this fleet asks about first.` });
  }
  return { reasons };
}

/**
 * The same reasons for somebody who may not see what the member has spent.
 * Only one reason carries a figure, and it is said without it: that a start
 * needs approval, and of which kind, is no secret, since the person asking
 * is the one being told to wait. What the member has spent is its managers'
 * to read (docs/budgets.md, "An approval").
 *
 * @param {readonly Reason[]} reasons @param {string} who the member's name
 * @returns {Reason[]}
 */
export function withoutFigures(reasons, who) {
  return reasons.map((r) => (r.kind === 'over-budget' ? { kind: r.kind, text: `${who} is past its budget for this month.` } : { kind: r.kind, text: r.text }));
}

/** A refusal at a budget, for somebody who may not see what the member has spent. @param {string} who */
export function refusedWithoutFigures(who) {
  return `${who} is past its budget for this month. The fleet refuses a start past a budget: it can start again when the month turns, or when the budget is raised.`;
}

/** One printable paragraph, bounded in bytes. */
function note(/** @type {unknown} */ v) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return new TextEncoder().encode(s).length <= MAX_APPROVAL_NOTE ? s : null;
}

/**
 * A new approval, waiting.
 *
 * @param {{ id: string, member: string, task?: string|null, reasons: Reason[], by: string, at: number }} q
 * @returns {Approval}
 */
export function newApproval({ id, member, task = null, reasons, by, at }) {
  return { id, member, task: task || null, reasons: reasons.map((r) => ({ kind: r.kind, text: r.text })), askedBy: by, askedAt: at, state: 'waiting' };
}

/** The same approval as time has left it: a waiting one past a day, or a given one past its hour, is over. */
export function aged(/** @type {Approval} */ a, /** @type {number} */ now) {
  if (a.state === 'waiting' && now - a.askedAt >= APPROVAL_WAIT_MS) return { ...a, state: /** @type {const} */ ('expired') };
  if (a.state === 'approved' && now - (a.decidedAt ?? 0) >= APPROVAL_USE_MS) return { ...a, state: /** @type {const} */ ('expired') };
  return a;
}

/**
 * Is this approval about this start: the same person asking, as the same
 * member, on the same task or none, and naming every reason the start has
 * now? A start that has since gained a reason is not covered by an approval
 * that was given without it.
 *
 * @param {Approval} a @param {{ member: string, task?: string|null, kinds: string[], by: string }} start
 */
export function covers(a, { member, task = null, kinds, by }) {
  return a.member === member && (a.task ?? null) === (task || null) && a.askedBy === by && kinds.every((k) => a.reasons.some((r) => r.kind === k));
}

/**
 * A person's answer.
 *
 * @param {Approval} a @param {unknown} answer @param {{ by: string, at: number, note?: unknown }} who
 * @returns {{ ok: true, approval: Approval } | { ok: false, code: string, text: string }}
 */
export function answerApproval(a, answer, { by, at, note: said }) {
  const now = aged(a, at);
  if (now.state !== 'waiting') return refuse('approval_closed', `${a.id} is ${now.state}, so there is nothing to answer. A start that still needs approval asks for a new one.`);
  if (answer !== 'approve' && answer !== 'decline') return refuse('bad_answer', 'An approval is answered approve or decline.');
  const kept = said === undefined || said === null || said === '' ? '' : note(said);
  if (kept === null) return refuse('bad_note', `A note is at most ${MAX_APPROVAL_NOTE} bytes.`);
  return { ok: true, approval: { ...now, state: answer === 'approve' ? 'approved' : 'declined', decidedBy: by, decidedAt: at, ...(kept ? { note: kept } : {}) } };
}

/** An approval as its one sentence: who, as whom, on what, and where it stands. */
export function approvalWords(/** @type {Approval} */ a, /** @type {(id: string) => string} */ name = (id) => id) {
  const what = `${a.askedBy} to start a session as ${name(a.member)}${a.task ? ` on ${a.task}` : ''}`;
  const state = {
    waiting: `${a.id} is waiting: ${what}.`,
    approved: `${a.id} was approved by ${a.decidedBy}: ${what}. It is good for one start within the hour.`,
    declined: `${a.id} was declined by ${a.decidedBy}: ${what}.`,
    used: `${a.id} was approved by ${a.decidedBy} and has been used: ${what}.`,
    expired: `${a.id} ran out before it was ${a.decidedBy ? 'used' : 'answered'}: ${what}.`,
  }[a.state];
  return `${state} ${a.reasons.map((r) => r.text).join(' ')}${a.note ? ` Note: ${a.note}` : ''}`.trim();
}

/**
 * A stored approval, read back as one or not at all.
 *
 * @param {any} row @returns {Approval|null}
 */
export function readApproval(row) {
  if (!row || typeof row !== 'object' || !APPROVAL_ID_RE.test(String(row.id ?? ''))) return null;
  if (!MEMBER_ID_RE.test(String(row.member ?? '')) || !APPROVAL_STATES.includes(row.state)) return null;
  const reasons = (Array.isArray(row.reasons) ? row.reasons : [])
    .filter((/** @type {any} */ r) => r && APPROVAL_REASONS.includes(r.kind) && typeof r.text === 'string')
    .map((/** @type {any} */ r) => ({ kind: r.kind, text: r.text.slice(0, 400) }));
  if (!reasons.length) return null;
  const kept = row.note === undefined ? '' : note(row.note);
  return {
    id: row.id,
    member: row.member,
    task: typeof row.task === 'string' && TASK_ID_RE.test(row.task) ? row.task : null,
    reasons,
    askedBy: String(row.askedBy ?? '').slice(0, 200),
    askedAt: Number(row.askedAt) || 0,
    state: row.state,
    ...(typeof row.decidedBy === 'string' ? { decidedBy: row.decidedBy.slice(0, 200) } : {}),
    ...(Number(row.decidedAt) > 0 ? { decidedAt: Number(row.decidedAt) } : {}),
    ...(kept ? { note: kept } : {}),
  };
}

/**
 * A stored month of spend, read back as one or not at all.
 *
 * @param {any} row @returns {Spend|null}
 */
export function readSpend(row) {
  if (!row || typeof row !== 'object' || !/^\d{4}-\d{2}$/.test(String(row.month ?? ''))) return null;
  const usd = typeof row.usd === 'number' && Number.isFinite(row.usd) && row.usd >= 0 ? row.usd : 0;
  /** @type {Record<string, number>} */
  const seen = {};
  if (row.seen && typeof row.seen === 'object' && !Array.isArray(row.seen)) {
    for (const [k, v] of Object.entries(row.seen).slice(-MAX_SESSIONS_SEEN)) {
      if (k.length <= 300 && typeof v === 'number' && Number.isFinite(v) && (v >= 0 || v === UNSEEN)) seen[k] = v;
    }
  }
  const unknown = (Array.isArray(row.unknown) ? row.unknown : []).filter((/** @type {unknown} */ k) => typeof k === 'string' && k.length <= 300).slice(-MAX_SESSIONS_SEEN);
  return { month: row.month, usd, unknown, seen, told: { ...(row.told?.warn === true ? { warn: true } : {}), ...(row.told?.over === true ? { over: true } : {}) } };
}
