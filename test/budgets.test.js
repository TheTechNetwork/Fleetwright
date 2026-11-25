// What a member has spent, what a start needs approval for, and an
// approval's life (docs/budgets.md), as rules.
//
// The coordinator's use of these is test/budgets-coordinator.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBudgetSettings, newSpend, startCounting, resumeCounting, countSpend, readSpend, spendWords, overBudget, dollars, monthOf,
  approvalNeeded, newApproval, aged, covers, answerApproval, approvalWords, readApproval,
  MAX_SESSIONS_SEEN, MAX_RISKY_WORK_TYPES, APPROVAL_WAIT_MS, APPROVAL_USE_MS, MAX_APPROVAL_NOTE,
} from '../src/fleet/protocol/budgets.js';

const NOV = Date.UTC(2026, 10, 24, 12);
const DEC = Date.UTC(2026, 11, 1, 0, 5);
const key = 'deb132\ncc-1';
const said = (/** @type {number|null} */ usd, complete = true) => ({ usd, complete });

test('a session the fleet started counts from nothing: each higher figure adds the difference', () => {
  let row = startCounting(newSpend(NOV), key, NOV);
  row = countSpend(row, key, said(1.25), NOV);
  row = countSpend(row, key, said(1.25), NOV);
  row = countSpend(row, key, said(4), NOV);
  assert.deepEqual([row.month, row.usd, row.unknown, row.seen[key]], ['2026-11', 4, [], 4]);
  // The same report again changes nothing, and says so by being the same object.
  assert.equal(countSpend(row, key, said(4), NOV), row);
});

test('a resumed conversation counts only what it spends after it is first heard from', () => {
  let row = resumeCounting(newSpend(NOV), key, NOV);
  row = countSpend(row, key, said(12.4), NOV);
  assert.equal(row.usd, 0, 'nobody saw the first twelve dollars being spent');
  row = countSpend(row, key, said(13), NOV);
  assert.equal(row.usd, 0.6);
  // Resuming a session already being counted does not start it over.
  assert.equal(resumeCounting(row, key, NOV), row);
});

test('a session the fleet did not start or resume as the member is not that member’s spending', () => {
  const row = startCounting(newSpend(NOV), key, NOV);
  const other = countSpend(row, 'deb132\nsomebody-elses', said(900), NOV);
  assert.equal(other, row);
  assert.deepEqual([other.usd, other.unknown], [0, []], 'not counted, and not counted as unknown either');
});

test('a figure that goes down is a new conversation in the same session, counted from nothing again', () => {
  let row = startCounting(newSpend(NOV), key, NOV);
  row = countSpend(row, key, said(5), NOV);
  row = countSpend(row, key, said(0.75), NOV);
  assert.deepEqual([row.usd, row.seen[key]], [5.75, 0.75]);
});

test('at the turn of the month the total starts again and a running session counts only what it spends after', () => {
  let row = startCounting(newSpend(NOV), key, NOV);
  row = countSpend(row, key, said(40), NOV);
  row = { ...row, told: { warn: true, over: true } };
  row = countSpend(row, key, said(41.5), DEC);
  assert.deepEqual([row.month, row.usd, row.told], ['2026-12', 1.5, {}]);
  assert.equal(monthOf(Date.UTC(2026, 11, 31, 23, 59)), '2026-12');
});

test('a session that reports no dollars, or says its dollars are not all of them, is one whose cost is unknown, never free', () => {
  let row = startCounting(startCounting(newSpend(NOV), key, NOV), 'deb132\ncodex-1', NOV);
  row = countSpend(row, 'deb132\ncodex-1', null, NOV);
  row = countSpend(row, 'deb132\ncodex-1', { usd: null, complete: false }, NOV);
  assert.deepEqual([row.usd, row.unknown], [0, ['deb132\ncodex-1']], 'once, however often it reports');
  // Dollars that are not all of them are counted, and the session is still unknown.
  row = countSpend(row, key, said(3, false), NOV);
  assert.deepEqual([row.usd, row.unknown.length], [3, 2]);
  assert.equal(spendWords(row, 50), 'At least $3.00 of $50.00 this month, at API prices as each session counted it. 2 sessions reported no cost, so the real figure is higher by an amount nobody counted.');
  // Nonsense is no dollars.
  for (const junk of [{ usd: -4 }, { usd: 'lots' }, { usd: Infinity }, 'x', 7]) assert.equal(countSpend(startCounting(newSpend(NOV), key, NOV), key, junk, NOV).usd, 0);
});

test('one report adds at most a hundred dollars for one session, and the row says the rest was not counted', () => {
  // A box's word is all there is for what a session cost. One report of
  // $99,999 was counted whole, and at a budget that refuses it locked the
  // member's manager out.
  let row = countSpend(startCounting(newSpend(NOV), key, NOV), key, said(99_999), NOV);
  assert.deepEqual([row.usd, row.capped], [100, [key]]);
  assert.equal(spendWords(row, 50), 'At least $100.00 of $50.00 this month, at API prices as each session counted it. One session reported more than $100.00 spent between two reports. The fleet counts at most that much from one report, so the rest was not counted.');
  // What was left out is left out once: the next report counts from the figure the box gave.
  row = countSpend(row, key, said(100_004), NOV);
  assert.deepEqual([row.usd, row.capped], [105, [key]]);
  // A hundred dollars exactly is counted whole, and nothing is said about it.
  assert.deepEqual([countSpend(startCounting(newSpend(NOV), key, NOV), key, said(100), NOV).capped], [undefined]);
  // It is the month's, and it reads back.
  assert.deepEqual(readSpend(JSON.parse(JSON.stringify(row)))?.capped, [key]);
  assert.equal(countSpend(row, key, said(100_005), DEC).capped, undefined);
});

test('a member’s row keeps the last figure of sixty sessions and reads back only what it wrote', () => {
  let row = newSpend(NOV);
  for (let i = 0; i < MAX_SESSIONS_SEEN + 5; i++) row = startCounting(row, `deb132\ncc-${i}`, NOV);
  assert.equal(Object.keys(row.seen).length, MAX_SESSIONS_SEEN);
  assert.equal('deb132\ncc-0' in row.seen, false, 'the oldest goes');
  const back = /** @type {any} */ (readSpend(JSON.parse(JSON.stringify({ ...countSpend(row, 'deb132\ncc-64', said(2), NOV), junk: 1, told: { warn: true, over: 'yes' } }))));
  assert.deepEqual([back.month, back.usd, Object.keys(back.seen).length, back.told, back.junk], ['2026-11', 2, MAX_SESSIONS_SEEN, { warn: true }, undefined]);
  assert.equal(readSpend({ month: 'November', usd: 1 }), null);
  assert.equal(readSpend(null), null);
});

test('spend is said in one sentence, with the budget when there is one', () => {
  assert.equal(spendWords({ usd: 12.345, unknown: [] }, 50), '$12.35 of $50.00 this month, at API prices as each session counted it.');
  assert.equal(spendWords(null, null), '$0.00 this month, at API prices as each session counted it.');
  assert.equal(spendWords({ usd: 1, unknown: ['a'] }, null), 'At least $1.00 this month, at API prices as each session counted it. One session reported no cost, so the real figure is higher by an amount nobody counted.');
  assert.equal(dollars(0.005), '$0.01');
  assert.deepEqual([overBudget({ usd: 50 }, 50), overBudget({ usd: 49.99 }, 50), overBudget({ usd: 900 }, null), overBudget(null, 0)], [true, false, false, true]);
});

const debbie = { id: 'debbie', name: 'Debbie', budgetUsdMonth: 50 };
const on = { budgets: 'ask', dangerous: true, workTypes: ['deploy'] };
const quiet = { dangerous: false, workType: null, task: null };

test('a fleet that set nothing asks about nothing, whatever a member has spent', () => {
  const need = approvalNeeded({ settings: { budgets: 'off', dangerous: false, workTypes: [] }, member: debbie, spend: { usd: 900, unknown: [] }, start: { dangerous: true, workType: 'deploy', task: 't1' } });
  assert.deepEqual(need, { reasons: [] });
});

test('each reason a start needs approval for is named with its own sentence', () => {
  const kinds = (/** @type {any} */ q) => /** @type {any} */ (approvalNeeded(q)).reasons.map((/** @type {any} */ r) => r.kind);
  assert.deepEqual(kinds({ settings: on, member: debbie, spend: { usd: 49.99, unknown: [] }, start: quiet }), []);
  assert.deepEqual(kinds({ settings: on, member: debbie, spend: { usd: 50, unknown: [] }, start: quiet }), ['over-budget']);
  assert.deepEqual(kinds({ settings: on, member: debbie, spend: null, start: { ...quiet, dangerous: true } }), ['dangerous']);
  assert.deepEqual(kinds({ settings: on, member: debbie, spend: null, start: { ...quiet, workType: 'deploy', task: 't4' } }), ['risky-work']);
  assert.deepEqual(kinds({ settings: on, member: debbie, spend: null, start: { ...quiet, workType: 'backend', task: 't4' } }), []);
  // A member with no budget is never over one.
  assert.deepEqual(kinds({ settings: on, member: { id: 'loose', name: 'Loose', budgetUsdMonth: null }, spend: { usd: 9000, unknown: [] }, start: quiet }), []);
  const all = /** @type {any} */ (approvalNeeded({ settings: on, member: debbie, spend: { usd: 52.1, unknown: [] }, start: { dangerous: true, workType: 'deploy', task: 't4' } }));
  assert.deepEqual(all.reasons.map((/** @type {any} */ r) => r.text), [
    'Debbie has spent $52.10 of a budget of $50.00 this month.',
    'This session would not ask before it runs commands, on Debbie’s sign-ins.',
    't4 is deploy work, which this fleet asks about first.',
  ]);
  // A session whose cost is unknown does not block: a budget is enforced on what was counted.
  assert.deepEqual(kinds({ settings: on, member: debbie, spend: { usd: 10, unknown: ['a', 'b', 'c'] }, start: quiet }), []);
});

test('in refuse mode a start past the budget is refused outright, and nobody is asked', () => {
  const need = approvalNeeded({ settings: { ...on, budgets: 'refuse' }, member: debbie, spend: { usd: 60, unknown: [] }, start: { ...quiet, dangerous: true } });
  assert.deepEqual(need, { refused: 'Debbie has spent $60.00 of a budget of $50.00 this month. The fleet refuses a start past a budget: it can start again when the month turns, or when the budget is raised.' });
});

test('the setting holds a mode, a flag and a short list, and says what is wrong with one that does not read', () => {
  assert.deepEqual(checkBudgetSettings({ budgets: 'ask', dangerous: true, workTypes: [' Deploy ', 'deploy', 'prod-data'] }), { ok: true, budgets: 'ask', dangerous: true, paidApi: true, workTypes: ['deploy', 'prod-data'] });
  // A field left out keeps what it was.
  assert.deepEqual(checkBudgetSettings({ dangerous: false }, { budgets: 'refuse', dangerous: true, workTypes: ['deploy'] }), { ok: true, budgets: 'refuse', dangerous: false, paidApi: true, workTypes: ['deploy'] });
  const refused = (/** @type {any} */ input) => /** @type {any} */ (checkBudgetSettings(input)).text;
  assert.match(refused({ budgets: 'always' }), /off, ask or refuse/);
  assert.match(refused({ dangerous: 'yes' }), /true or false/);
  assert.match(refused({ workTypes: ['Deploy to prod!'] }), /short slug/);
  assert.match(refused({ workTypes: Array.from({ length: MAX_RISKY_WORK_TYPES + 1 }, (_, i) => `k${i}`) }), new RegExp(`at most ${MAX_RISKY_WORK_TYPES}`));
});

const asked = () => newApproval({ id: 'a7', member: 'debbie', task: 't4', reasons: [{ kind: 'over-budget', text: 'Debbie has spent $52.10 of a budget of $50.00 this month.' }], by: 'dana@example.com', at: NOV });

test('an approval covers the same person, member and task, and every reason the start has now', () => {
  const a = asked();
  const start = { member: 'debbie', task: 't4', kinds: ['over-budget'], by: 'dana@example.com' };
  assert.equal(covers(a, start), true);
  assert.equal(covers(a, { ...start, by: 'sam@example.com' }), false, 'somebody else’s start');
  assert.equal(covers(a, { ...start, member: 'ines' }), false);
  assert.equal(covers(a, { ...start, task: 't5' }), false);
  assert.equal(covers(a, { ...start, task: null }), false);
  assert.equal(covers(a, { ...start, kinds: ['over-budget', 'dangerous'] }), false, 'a start that has gained a reason needs a new approval');
  // One that named more than the start now needs still covers it.
  assert.equal(covers({ ...a, reasons: [...a.reasons, { kind: 'dangerous', text: 'x' }] }, start), true);
});

test('an approval is answered once, by approve or decline, with a short note', () => {
  const yes = /** @type {any} */ (answerApproval(asked(), 'approve', { by: 'eli@example.com', at: NOV + 1000, note: 'Finish the migration.' }));
  assert.deepEqual([yes.approval.state, yes.approval.decidedBy, yes.approval.decidedAt, yes.approval.note], ['approved', 'eli@example.com', NOV + 1000, 'Finish the migration.']);
  assert.equal(/** @type {any} */ (answerApproval(yes.approval, 'decline', { by: 'eli@example.com', at: NOV + 2000 })).code, 'approval_closed');
  assert.equal(/** @type {any} */ (answerApproval(asked(), 'decline', { by: 'eli@example.com', at: NOV + 1000 })).approval.state, 'declined');
  assert.equal(/** @type {any} */ (answerApproval(asked(), 'maybe', { by: 'e', at: NOV })).code, 'bad_answer');
  assert.equal(/** @type {any} */ (answerApproval(asked(), 'approve', { by: 'e', at: NOV, note: 'é'.repeat(MAX_APPROVAL_NOTE) })).code, 'bad_note');
});

test('a waiting approval is over after a day, and a given one after its hour', () => {
  const a = asked();
  assert.equal(aged(a, NOV + APPROVAL_WAIT_MS - 1).state, 'waiting');
  assert.equal(aged(a, NOV + APPROVAL_WAIT_MS).state, 'expired');
  assert.equal(/** @type {any} */ (answerApproval(a, 'approve', { by: 'e', at: NOV + APPROVAL_WAIT_MS })).code, 'approval_closed', 'and cannot be answered late');
  const given = /** @type {any} */ (answerApproval(a, 'approve', { by: 'eli@example.com', at: NOV })).approval;
  assert.equal(aged(given, NOV + APPROVAL_USE_MS - 1).state, 'approved');
  assert.equal(aged(given, NOV + APPROVAL_USE_MS).state, 'expired');
  // A used or declined one stays what it is.
  assert.equal(aged({ ...given, state: 'used' }, NOV + 10 * APPROVAL_USE_MS).state, 'used');
});

test('an approval is said in one sentence at each point of its life, and reads back only as one', () => {
  const name = (/** @type {string} */ id) => (id === 'debbie' ? 'Debbie' : id);
  const a = asked();
  assert.equal(approvalWords(a, name), 'a7 is waiting: dana@example.com to start a session as Debbie on t4. Debbie has spent $52.10 of a budget of $50.00 this month.');
  const given = /** @type {any} */ (answerApproval(a, 'approve', { by: 'eli@example.com', at: NOV, note: 'Go on.' })).approval;
  assert.equal(approvalWords(given, name), 'a7 was approved by eli@example.com: dana@example.com to start a session as Debbie on t4. It is good for one start within the hour. Debbie has spent $52.10 of a budget of $50.00 this month. Note: Go on.');
  assert.match(approvalWords({ ...a, state: 'expired' }, name), /^a7 ran out before it was answered/);
  assert.match(approvalWords({ ...given, state: 'expired' }, name), /^a7 ran out before it was used/);
  assert.deepEqual(readApproval(JSON.parse(JSON.stringify({ ...given, junk: 1 }))), given);
  assert.equal(readApproval({ ...a, reasons: [{ kind: 'vibes', text: 'x' }] }), null, 'an approval for no reason this knows is not one');
  assert.equal(readApproval({ ...a, id: 'seven' }), null);
  assert.equal(readApproval({ ...a, state: 'sort-of' }), null);
});
