// What a member has spent this month, what a start needs approval for, and
// an approval's life (docs/budgets.md).
//
// WHY IT IS HERE AND NOT IN THE COORDINATOR. The coordinator counts and
// gates; the MCP server and both phones say the same figures and reasons in
// words. One file, so the sentence a refusal carries and the one a screen
// draws cannot come to differ. No imports beyond its neighbours here and
// text.js, which has none, so the Worker bundles take it.
//
// THE COUNT IS OF WHAT WAS SEEN BEING SPENT, and nothing else: a session's
// own running total goes up, and the difference is added. Nothing here
// prices a token, and a session that reports no dollars is counted as one
// whose cost is unknown, never as free (src/core/spent.js says why a price
// table is somebody else's product).
//
// NEVER THROWS. Every refusal is `{ ok: false, code, text }`.

import { oneLine } from '../../core/text.js';
import { MEMBER_ID_RE } from './members.js';
import { TASK_ID_RE } from './tasks.js';

export const BUDGET_MODES = Object.freeze(['off', 'ask', 'refuse']);
/** Why a start needs approval. */
export const APPROVAL_REASONS = Object.freeze(['over-budget', 'dangerous', 'risky-work', 'paid-api']);
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
/** How much of what a session is to be told an approval shows, in characters. Its digest is of all of it. */
export const MAX_TOLD_SHOWN = 160;
/** The share of a budget at which a member's managers are told it is nearly spent. */
export const BUDGET_WARN_AT = 0.8;
/**
 * The most one report may add to a member's month for one session, in
 * dollars. What a session has cost is its box's word and there is nothing to
 * check it against, so a single report of $99,999 was counted whole and, at
 * a budget that refuses, locked the member's own manager out. A box reports
 * every half minute or so and a session does not spend this in that time. A
 * box back from hours away can honestly report more: the rest is then left
 * uncounted and the row says so, which is the same "at least" it says about
 * a session that reported no cost.
 */
export const MAX_USD_PER_REPORT = 100;
/**
 * How far before a start was sent a session may say it began and still be
 * that start's (countSpend): the two clocks are a box's and this
 * coordinator's, and they need not agree to the second.
 */
export const UNANSWERED_SKEW_MS = 5 * 60_000;
/** How long a start nobody answered is still waited for across the turn of a month. */
export const UNANSWERED_KEPT_MS = 24 * 60 * 60_000;

const WORK_TYPE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** @param {string} code @param {string} text */
const refuse = (code, text) => /** @type {const} */ ({ ok: false, code, text });

/** 'YYYY-MM' in UTC: the month a budget is for. */
export const monthOf = (/** @type {number} */ t) => new Date(t).toISOString().slice(0, 7);

/**
 * @typedef {{ budgets: 'off'|'ask'|'refuse', dangerous: boolean, paidApi: boolean, workTypes: string[], updatedBy: string|null, updatedAt: number }} BudgetSettings
 * @typedef {object} Spend
 * @property {string} month                  'YYYY-MM', UTC
 * @property {number} usd                    what was seen being spent this month
 * @property {string[]} unknown              sessions this month whose cost is unknown, by key
 * @property {string[]} [capped]             sessions this month that reported more at once than is counted (MAX_USD_PER_REPORT), by key
 * @property {Array<{ host: string, at: number }>} [unanswered]  starts as this member sent to a box that never answered: which box, and when
 * @property {Record<string, number>} seen   the last figure seen for each session, by key, newest last
 * @property {{ warn?: boolean, over?: boolean }} told  which of the month's two notices went out
 * @property {boolean} [gone]                its member was removed this month; the row is kept so the month's spend is not reset by removing and adding back (org-budgets.js, forget)
 * @property {number} [budget]               on a row whose member is gone: the monthly budget it had when it was removed, which a member made under the id again takes back (org-budgets.js, back)
 * @typedef {{ kind: 'over-budget'|'dangerous'|'risky-work'|'paid-api', text: string }} Reason
 * @typedef {object} Approval
 * @property {string} id
 * @property {string} member
 * @property {string|null} task
 * @property {Reason[]} reasons
 * @property {string} [digest]  SHA-256, hex, of what the session was to be told when this was asked for (startDigest)
 * @property {string} [told]    the start of that, as one sentence for whoever answers (toldWords)
 * @property {string} askedBy
 * @property {number} askedAt
 * @property {'waiting'|'approved'|'declined'|'used'|'expired'} state
 * @property {string} [decidedBy]
 * @property {number} [decidedAt]
 * @property {string} [note]
 */

/**
 * A fleet that has set nothing: budgets stop nothing, and nobody is asked
 * about a session that skips prompts or about any kind of work.
 *
 * `paidApi` IS THE ONE THAT STARTS ON (docs/api-engines.md). It guards a
 * start on an engine that bills by the token, which a budget cannot see and
 * which no fleet had before the step that added this. So on by default
 * changes nothing for a fleet with no such engine, and for one that adds
 * one the first start is a question and not a bill.
 */
export const NO_BUDGET_SETTINGS = Object.freeze({ budgets: 'off', dangerous: false, paidApi: true, workTypes: Object.freeze([]), updatedBy: null, updatedAt: 0 });

/**
 * The setting as an admin wrote it, checked. A field left out keeps what it
 * was.
 *
 * @param {unknown} input @param {{ budgets: string, dangerous: boolean, paidApi?: boolean, workTypes: readonly string[] }} [was]
 * @returns {{ ok: true, budgets: 'off'|'ask'|'refuse', dangerous: boolean, paidApi: boolean, workTypes: string[] } | { ok: false, code: string, text: string }}
 */
export function checkBudgetSettings(input, was = NO_BUDGET_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse('bad_settings', 'The setting is what happens at a budget, whether a session that skips prompts needs approval, and the kinds of work that do.');
  const v = /** @type {Record<string, any>} */ (input);
  const budgets = v.budgets === undefined ? was.budgets : String(v.budgets);
  if (!BUDGET_MODES.includes(budgets)) return refuse('bad_settings', 'What happens at a budget is off, ask or refuse.');
  if (v.dangerous !== undefined && typeof v.dangerous !== 'boolean') return refuse('bad_settings', 'Whether a session that skips permission prompts needs approval is true or false.');
  if (v.paidApi !== undefined && typeof v.paidApi !== 'boolean') return refuse('bad_settings', 'Whether a session on a metered API key needs approval is true or false.');
  const listed = v.workTypes === undefined ? [...was.workTypes] : v.workTypes;
  if (!Array.isArray(listed) || listed.length > MAX_RISKY_WORK_TYPES) return refuse('bad_settings', `The kinds of work that need approval are a list of at most ${MAX_RISKY_WORK_TYPES}.`);
  const workTypes = [...new Set(listed.map((t) => String(t).trim().toLowerCase()))];
  if (workTypes.some((t) => !WORK_TYPE_RE.test(t))) return refuse('bad_settings', 'A kind of work is a short slug: lowercase letters, digits and hyphens, like “deploy”.');
  return {
    ok: true,
    budgets: /** @type {'off'|'ask'|'refuse'} */ (budgets),
    dangerous: v.dangerous === undefined ? was.dangerous === true : v.dangerous,
    // On unless somebody turned it off: a record from before it existed has none.
    paidApi: v.paidApi === undefined ? was.paidApi !== false : v.paidApi,
    workTypes,
  };
}

/** A member's row for a month in which nothing has been seen yet. @param {number} now @returns {Spend} */
export function newSpend(now) {
  return { month: monthOf(now), usd: 0, unknown: [], seen: {}, told: {} };
}

/**
 * The same row in the month `now` is in: at the month's turn the total
 * starts again and the last figures stay. So does a start nobody has
 * answered in the last day, whose session may yet be heard from.
 */
function inMonth(/** @type {Spend} */ row, /** @type {number} */ now) {
  const month = monthOf(now);
  if (row.month === month) return row;
  const unanswered = (row.unanswered ?? []).filter((u) => now - u.at < UNANSWERED_KEPT_MS);
  // A removed member's budget is kept across the turn, with what says the row is nobody's now.
  const left = row.gone && typeof row.budget === 'number' ? { gone: true, budget: row.budget } : {};
  return { month, usd: 0, unknown: [], ...(unanswered.length ? { unanswered } : {}), ...left, seen: row.seen, told: {} };
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

/**
 * A start as this member was sent to a box, and the box never answered. It
 * may have started the session all the same, and then nothing was counting
 * it: the row read "$0.00 of $50.00" while the box reported $180, and a
 * budget that refuses let the next start through. So the start is kept as
 * one whose spend is not known, which the row says, until its box speaks of
 * the session (countSpend).
 *
 * @param {Spend} row @param {string} host @param {number} at when the start was sent @param {number} now
 * @returns {Spend}
 */
export function startUnanswered(row, host, at, now) {
  const r = inMonth(row, now);
  return { ...r, unanswered: [...(r.unanswered ?? []), { host, at }].slice(-MAX_SESSIONS_SEEN) };
}

/**
 * The start nobody answered that this session is, if it is one: sent to the
 * box now reporting it, and not after the session says it began. A box that
 * gives no time for a session says nothing against it.
 *
 * @param {Spend} row @param {string} key @param {unknown} startedAt
 * @returns {number} its place in `unanswered`, or -1
 */
function unansweredFor(row, key, startedAt) {
  const host = key.slice(0, Math.max(0, key.indexOf('\n')));
  const began = typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : null;
  return (row.unanswered ?? []).findIndex((u) => u.host === host && (began === null || began >= u.at - UNANSWERED_SKEW_MS));
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
 * @param {{ startedAt?: unknown }} [session]  when the box says the session began, if it says
 * @returns {Spend} the same object when nothing changed
 */
export function countSpend(row, key, spent, now, session = {}) {
  let r = inMonth(row, now);
  // ONLY A SESSION THE FLEET ITSELF STARTED OR RESUMED AS THIS MEMBER. Which
  // member a session is, in a health frame, is the box's word; counted on
  // that alone, a box could spend any member's budget by naming it.
  let last = r.seen[key];
  if (last === undefined) {
    // OR ONE IT STARTED AND WAS NEVER TOLD OF: a start sent to this box that
    // got no answer. The session is that start's, counted from nothing like
    // any other the fleet started, and the start is no longer unknown. One
    // session a start, on the box the start went to, so a box gains nothing
    // by it that the answer it never sent would not have given.
    const at = unansweredFor(r, key, session.startedAt);
    if (at < 0) return r === row ? row : r;
    const unanswered = (r.unanswered ?? []).filter((_, i) => i !== at);
    const { unanswered: _was, ...rest } = r;
    r = { ...rest, ...(unanswered.length ? { unanswered } : {}), seen: remember(r.seen, key, 0) };
    last = 0;
  }
  const s = /** @type {any} */ (spent);
  const usd = s && typeof s.usd === 'number' && Number.isFinite(s.usd) && s.usd >= 0 ? s.usd : null;
  // NO DOLLARS, OR DOLLARS IT SAYS ARE NOT ALL OF THEM: a session whose cost
  // is unknown. Whatever dollars it did report are still counted below.
  const unknown = (usd === null || s.complete === false) && !r.unknown.includes(key) ? [...r.unknown, key].slice(-MAX_SESSIONS_SEEN) : r.unknown;
  if (usd === null) return unknown === r.unknown && r === row ? row : { ...r, unknown };
  // RESUMED, AND FIRST HEARD OF WITH A FIGURE ALREADY ON IT: nobody saw that
  // being spent, or when. It is where this session's counting starts.
  const rose = last === UNSEEN ? 0 : usd >= last ? usd - last : usd;
  if (last === usd && unknown === r.unknown && r === row) return row;
  // NO MORE THAN A REPORT MAY ADD (MAX_USD_PER_REPORT). The figure is kept
  // as the box gave it, so the next report counts from there and the part
  // left out is left out once.
  const grew = Math.min(rose, MAX_USD_PER_REPORT);
  const capped = rose > MAX_USD_PER_REPORT && !(r.capped ?? []).includes(key) ? [...(r.capped ?? []), key].slice(-MAX_SESSIONS_SEEN) : r.capped;
  return { ...r, usd: Math.round((r.usd + grew) * 10_000) / 10_000, unknown, ...(capped ? { capped } : {}), seen: remember(r.seen, key, usd) };
}

/**
 * How many of a member's sessions this month have a cost that is not all
 * counted: ones that reported none, ones that reported more at once than is
 * counted, and starts no box answered, each of which may be a session. A
 * session that is two of these is one session.
 *
 * @param {{ unknown: string[], capped?: string[], unanswered?: unknown[] }|null|undefined} row
 */
export function uncounted(row) {
  return row ? new Set([...row.unknown, ...(row.capped ?? [])]).size + (row.unanswered?.length ?? 0) : 0;
}

/** Dollars as a person reads them. */
export const dollars = (/** @type {number} */ usd) => `$${(Math.round(usd * 100) / 100).toFixed(2)}`;

/**
 * What a member has spent against its budget, as one sentence, the same on
 * every surface.
 *
 * @param {{ usd: number, unknown: string[], capped?: string[], unanswered?: unknown[] }|null} row @param {number|null|undefined} budget
 */
export function spendWords(row, budget) {
  const usd = row?.usd ?? 0;
  const unknown = row?.unknown.length ?? 0;
  const capped = row?.capped?.length ?? 0;
  const unanswered = row?.unanswered?.length ?? 0;
  const least = unknown || capped || unanswered ? 'At least ' : '';
  const of_ = typeof budget === 'number' ? ` of ${dollars(budget)}` : '';
  /** @param {number} n */
  const sessions = (n) => (n === 1 ? 'One session' : `${n} sessions`);
  const more = unknown ? ` ${sessions(unknown)} reported no cost, so the real figure is higher by an amount nobody counted.` : '';
  const over = capped ? ` ${sessions(capped)} reported more than ${dollars(MAX_USD_PER_REPORT)} spent between two reports. The fleet counts at most that much from one report, so the rest was not counted.` : '';
  const silent = unanswered
    ? unanswered === 1
      ? ' One start got no answer from its machine, so whether it ran, and what it cost, is not known.'
      : ` ${unanswered} starts got no answer from their machines, so whether they ran, and what they cost, is not known.`
    : '';
  return `${least}${dollars(usd)}${of_} this month, at API prices as each session counted it.${more}${over}${silent}`;
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
 * @param {{ budgets: string, dangerous: boolean, paidApi?: boolean, workTypes: readonly string[] }} q.settings
 * @param {{ id: string, name?: string, budgetUsdMonth?: number|null }} q.member
 * @param {{ usd: number, unknown: string[] }|null} q.spend
 * @param {{ dangerous: boolean, workType?: string|null, task?: string|null, paid?: boolean }} q.start
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
  if (settings.paidApi !== false && start.paid) reasons.push({ kind: 'paid-api', text: `${who} has an engine that bills an API key by the token, which no budget here counts.` });
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
 * What a start's session is to be told, as the one thing an approval is
 * bound to: the words it carries, or the profile it names.
 *
 * WHY A DIGEST. An approval covered a member, a task's id, the asker and the
 * kinds of reason, and none of what the session would be told. One given for
 * a docs deploy started "force-push main to production" under the same id,
 * and one given for a session that skips prompts to tidy a README started
 * any words at all. The words are not kept: a start's first message is up
 * to 8000 bytes and is the asker's, and two hundred of them are not this
 * record's to hold. Their digest is enough to tell the same start from
 * another, and nobody can find other words that give the same one.
 *
 * AND THE TWO THINGS A START CARRIES THAT DECIDE WHAT ITS WORDS CAN DO.
 * A profile is a name, and what it says is a file on the machine the start
 * goes to: approved as "the profile tidy-readme", the same approval started
 * that name on the asker's own machine, where the file said whatever they
 * had written. So a profile is approved on one machine (`host`). And a
 * named secret is what the session may fetch while it follows those words,
 * so it is part of what was approved, on any start. A start with neither is
 * the digest it always was, and an approval given before this still covers
 * it.
 *
 * @param {{ task?: unknown, profile?: unknown, secret?: unknown, host?: unknown }} start
 *   `host` is the machine the person named, read only beside a profile
 * @returns {Promise<string>} SHA-256, hex
 */
export async function startDigest({ task, profile, secret, host }) {
  const words = [typeof task === 'string' ? task : '', typeof profile === 'string' ? profile : ''];
  const fetches = typeof secret === 'string' ? secret : '';
  const on = words[1] && typeof host === 'string' ? host : '';
  const said = JSON.stringify(fetches || on ? [...words, fetches, on] : words);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(said)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The same, as a sentence for the person asked to approve: the start of the
 * words on one line. They approve a start, and a start is what it says.
 *
 * @param {{ task?: unknown, profile?: unknown, secret?: unknown, host?: unknown }} start
 */
export function toldWords({ task, profile, secret, host }) {
  const words = typeof task === 'string' ? oneLine(task, MAX_TOLD_SHOWN + 1) : '';
  // The secret by name, which is all anybody here knows of it.
  const fetches = typeof secret === 'string' && secret ? ` It may fetch the secret ${oneLine(secret, 64)}.` : '';
  if (words) return `The session is told: “${words.length > MAX_TOLD_SHOWN ? `${words.slice(0, MAX_TOLD_SHOWN - 1)}…` : words}”${fetches}`;
  if (typeof profile === 'string' && profile) {
    return `The session is given the profile ${oneLine(profile, 40)}, as ${typeof host === 'string' && host ? oneLine(host, 64) : 'its machine'} holds it.${fetches}`;
  }
  return `The session is told nothing, and starts idle.${fetches}`;
}

/**
 * A new approval, waiting.
 *
 * @param {{ id: string, member: string, task?: string|null, reasons: Reason[], digest?: string, told?: string, by: string, at: number }} q
 * @returns {Approval}
 */
export function newApproval({ id, member, task = null, reasons, digest, told, by, at }) {
  return { id, member, task: task || null, reasons: reasons.map((r) => ({ kind: r.kind, text: r.text })), ...(digest ? { digest } : {}), ...(told ? { told } : {}), askedBy: by, askedAt: at, state: 'waiting' };
}

/** The same approval as time has left it: a waiting one past a day, or a given one past its hour, is over. */
export function aged(/** @type {Approval} */ a, /** @type {number} */ now) {
  if (a.state === 'waiting' && now - a.askedAt >= APPROVAL_WAIT_MS) return { ...a, state: /** @type {const} */ ('expired') };
  if (a.state === 'approved' && now - (a.decidedAt ?? 0) >= APPROVAL_USE_MS) return { ...a, state: /** @type {const} */ ('expired') };
  return a;
}

/**
 * Is this approval about a start like this one: the same person asking, as
 * the same member, on the same task or none, and naming every reason the
 * start has now? A start that has since gained a reason is not covered by an
 * approval that was given without it.
 *
 * @param {Approval} a @param {{ member: string, task?: string|null, kinds: string[], by: string }} start
 */
export function sameAsk(a, { member, task = null, kinds, by }) {
  return a.member === member && (a.task ?? null) === (task || null) && a.askedBy === by && kinds.every((k) => a.reasons.some((r) => r.kind === k));
}

/**
 * Is this approval for this start: all of the above, and the session is to
 * be told what it was to be told when the approval was asked for
 * (startDigest)? A task whose brief was rewritten since, or other words on a
 * start with no task, is another start. An approval from before digests
 * were kept names none and covers nothing.
 *
 * @param {Approval} a @param {{ member: string, task?: string|null, kinds: string[], by: string, digest: string }} start
 */
export function covers(a, start) {
  return sameAsk(a, start) && Boolean(start.digest) && a.digest === start.digest;
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
  return `${state} ${a.reasons.map((r) => r.text).join(' ')}${a.told ? ` ${a.told}` : ''}${a.note ? ` Note: ${a.note}` : ''}`.trim();
}

/**
 * An approval's reasons as a screen draws them, with what the session is to
 * be told said after the last. Both phones draw each reason's sentence as
 * sent and nothing else of an approval's, so this is where the person asked
 * to approve reads what they are approving.
 *
 * @param {readonly Reason[]} reasons @param {string|undefined} told
 * @returns {Reason[]}
 */
export function withTold(reasons, told) {
  return reasons.map((r, i) => (told && i === reasons.length - 1 ? { kind: r.kind, text: `${r.text} ${told}` } : { kind: r.kind, text: r.text }));
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
    ...(typeof row.digest === 'string' && /^[0-9a-f]{64}$/.test(row.digest) ? { digest: row.digest } : {}),
    ...(typeof row.told === 'string' && row.told ? { told: oneLine(row.told, MAX_TOLD_SHOWN + 200) } : {}),
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
  /** A list of session keys, read as if a stranger wrote it. @param {unknown} list */
  const keys = (list) => (Array.isArray(list) ? list : []).filter((/** @type {unknown} */ k) => typeof k === 'string' && k.length <= 300).slice(-MAX_SESSIONS_SEEN);
  const unknown = keys(row.unknown);
  const capped = keys(row.capped);
  const unanswered = (Array.isArray(row.unanswered) ? row.unanswered : [])
    .filter((/** @type {any} */ u) => u && typeof u.host === 'string' && u.host.length <= 200 && Number(u.at) > 0)
    .map((/** @type {any} */ u) => ({ host: u.host, at: Number(u.at) }))
    .slice(-MAX_SESSIONS_SEEN);
  const budget = row.gone === true && typeof row.budget === 'number' && Number.isFinite(row.budget) && row.budget >= 0 ? { budget: row.budget } : {};
  return { month: row.month, usd, unknown, ...(capped.length ? { capped } : {}), ...(unanswered.length ? { unanswered } : {}), ...(row.gone === true ? { gone: true } : {}), ...budget, seen, told: { ...(row.told?.warn === true ? { warn: true } : {}), ...(row.told?.over === true ? { over: true } : {}) } };
}
