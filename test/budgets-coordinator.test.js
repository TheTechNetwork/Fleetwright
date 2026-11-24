// Budgets and approvals in the coordinator (docs/budgets.md): spend counted
// from what boxes report, a start as a member refused for want of approval
// and then let through, who may answer, the routes and who sees what, the
// notices, and the Durable Object's rows.
//
// The rules are test/budgets.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { OrgMembers } from '../src/fleet/coordinator/org-members.js';
import { budgetsRoute, SPEND_PREFIX, APPROVALS_PREFIX } from '../src/fleet/coordinator/org-budgets.js';
import { APPROVAL_USE_MS, APPROVAL_WAIT_MS, MAX_APPROVALS } from '../src/fleet/protocol/budgets.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { Fleet } from '../worker/src/fleet-do.js';

const admin = { email: 'eli@example.com', admin: true };
const dana = { email: 'dana@example.com', admin: false };
const sam = { email: 'sam@example.com', admin: false };

/** Eli; Dana under Eli; Sam, a person on no team; the agent Debbie under Dana with fifty dollars a month; Loose with no budget. */
function org(/** @type {() => number} */ now) {
  const o = new OrgMembers({ now });
  const add = (/** @type {string} */ id, /** @type {any} */ m) => assert.equal(o.set(admin, id, m).ok, true, id);
  add('eli', { name: 'Eli', kind: 'person', email: admin.email, role: 'owner' });
  add('dana', { name: 'Dana', kind: 'person', email: dana.email, role: 'team lead', reportsTo: 'eli' });
  add('sam', { name: 'Sam', kind: 'person', email: sam.email, role: 'engineer' });
  add('debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer', reportsTo: 'dana', budgetUsdMonth: 50 });
  add('loose', { name: 'Loose', kind: 'agent', role: 'researcher' });
  return o;
}

/**
 * A fleet with one box, a clock a test moves, a box that answers a start
 * with a session's name, every push sent, and a way to say what the box's
 * sessions have cost.
 */
function fleet() {
  let clock = Date.UTC(2026, 10, 24, 12);
  const now = () => clock;
  /** @type {any[]} */
  const pushes = [];
  const core = new CoordinatorCore({ now, push: /** @type {any} */ ({ send: async (/** @type {any} */ devices, /** @type {any} */ m) => void pushes.push({ to: devices.map((/** @type {any} */ d) => String(d.actor).replace('fleet:', '')).sort(), title: m.title, body: m.body, data: m.data }) }) });
  core.org = org(now);
  for (const who of [admin, dana, sam]) {
    core.devices.set(`dev-${who.email}`, { token: `t-${who.email}`, platform: 'ios', actor: `fleet:${who.email}`, clientId: `c-${who.email}` });
    core.clients.clients.set(`c-${who.email}`, /** @type {any} */ ({ id: `c-${who.email}`, admin: who.admin }));
  }
  core.registry.connect('deb132', () => {});
  /** What each session on the box has cost, as the box reports it. @type {Map<string, any>} */
  const costs = new Map();
  /** @type {Map<string, string>} session → member, as the box reports it */
  const as = new Map();
  const reports = () => core.onHostMessage('deb132', {
    kind: 'health',
    health: {
      hub: { reachable: true }, protocol: PROTOCOL_VERSION, maxSessions: 9, running: as.size, free: 9, labels: [], sandboxed: true,
      sessions: [...as].map(([name, member]) => ({ name, status: 'running', createdBy: null, member, spent: costs.get(name) ?? null })),
    },
  });
  /** @type {any[]} */
  const sent = [];
  /** @type {(spec: any) => any} */
  let answer = (spec) => ({ ok: true, text: 'Started.', sessions: [{ name: `cc-${sent.length}`, status: 'running', member: spec.params.member }] });
  core.send = /** @type {any} */ (async (/** @type {any} */ host, /** @type {any} */ spec) => {
    sent.push({ verb: spec.verb, params: spec.params });
    const r = answer(spec);
    if (spec.verb === 'start' && r.ok !== false) as.set(r.sessions[0].name, spec.params.member);
    return r;
  });
  const start = (/** @type {any} */ who, /** @type {string} */ member, /** @type {any} */ params = {}) =>
    /** @type {Promise<any>} */ (core.dispatch({ verb: 'start', params: { member, task: 'Do the thing.', ...params }, actor: who.email, requester: who, preferHost: 'deb132' }));
  /** The box says a session has cost this much, and reports. */
  const cost = async (/** @type {string} */ name, /** @type {number|null} */ usd, complete = true) => {
    costs.set(name, usd === null ? null : { usd, complete });
    await reports();
  };
  const set = (/** @type {any} */ s) => assert.equal(/** @type {any} */ (core.setBudgetSettings(admin, s)).ok, true);
  const spendOf = (/** @type {string} */ member, /** @type {any} */ who = admin) => /** @type {any} */ (core.budgetsFor(who)).members.find((/** @type {any} */ m) => m.member === member);
  return { core, sent, pushes, as, reports, start, cost, set, spendOf, tick: (/** @type {number} */ ms) => { clock += ms; }, answers: (/** @type {(spec: any) => any} */ fn) => { answer = fn; } };
}

test('what a member’s sessions cost is counted from what the box reports, and said against its budget', async () => {
  const f = fleet();
  await f.reports();
  assert.equal((await f.start(dana, 'debbie')).ok, true);
  await f.cost('cc-1', 3.2);
  await f.cost('cc-1', 7.85);
  assert.equal((await f.start(dana, 'debbie')).ok, true);
  await f.cost('cc-2', 1);
  const row = f.spendOf('debbie');
  assert.deepEqual([row.usd, row.budgetUsdMonth, row.month, row.unknownSessions, row.over], [8.85, 50, '2026-11', 0, false]);
  assert.equal(row.words, '$8.85 of $50.00 this month, at API prices as each session counted it.');
  // A member nothing was started as has spent nothing that was counted.
  assert.deepEqual([f.spendOf('loose').usd, f.spendOf('loose').budgetUsdMonth], [0, null]);
});

test('a box cannot put spending on a member by naming it for a session the fleet did not start as that member', async () => {
  const f = fleet();
  f.as.set('rogue', 'debbie');
  await f.cost('rogue', 900);
  assert.deepEqual([f.spendOf('debbie').usd, f.spendOf('debbie').unknownSessions], [0, 0]);
});

test('a session that reports no cost is counted as unknown, and does not stop a start', async () => {
  const f = fleet();
  f.set({ budgets: 'ask' });
  await f.reports();
  await f.start(dana, 'debbie');
  await f.cost('cc-1', null);
  assert.deepEqual([f.spendOf('debbie').usd, f.spendOf('debbie').unknownSessions], [0, 1]);
  assert.match(f.spendOf('debbie').words, /^At least \$0\.00 of \$50\.00 this month.* One session reported no cost/);
  assert.equal((await f.start(dana, 'debbie')).ok, true);
});

test('with enforcing off, a member past its budget starts as before and nobody is asked', async () => {
  const f = fleet();
  await f.reports();
  await f.start(dana, 'debbie');
  await f.cost('cc-1', 75);
  assert.equal(f.spendOf('debbie').over, true);
  assert.equal((await f.start(dana, 'debbie', { mode: 'dangerous' })).ok, true);
  assert.deepEqual(/** @type {any} */ (f.core.approvalsFor(admin)).approvals, []);
});

test('a start past the budget is refused with the numbers and an approval, and goes through once somebody who manages the member approves', async () => {
  const f = fleet();
  f.set({ budgets: 'ask' });
  await f.reports();
  await f.start(sam.admin ? sam : admin, 'debbie');
  await f.cost('cc-1', 52.1);
  f.pushes.length = 0;
  // Eli started the first; now an admin's own start is over budget too.
  const refused = await f.start(admin, 'debbie');
  assert.equal(refused.error.code, 'needs_approval');
  assert.equal(refused.text, 'Debbie has spent $52.10 of a budget of $50.00 this month. That needs approval, which you may give yourself: a1. Start it again once it is approved; nothing was sent.');
  assert.deepEqual([refused.approval.id, refused.approval.state, refused.approval.mayAnswer, refused.approval.reasons.map((/** @type {any} */ r) => r.kind)], ['a1', 'waiting', true, ['over-budget']]);
  assert.equal(f.sent.length, 1, 'nothing reached the box');
  // Told to the people who manage Debbie, and to admins: not to Sam.
  assert.deepEqual(f.pushes.map((p) => [p.to, p.title, p.data.approval]), [[['dana@example.com', 'eli@example.com'], 'Approve a start as Debbie?', 'a1']]);
  // Trying again is the same approval, and the phones are not told twice.
  assert.equal((await f.start(admin, 'debbie')).approval.id, 'a1');
  assert.equal(f.pushes.length, 1);

  const given = /** @type {any} */ (await f.core.answerApproval(dana, 'a1', 'approve', 'Finish the migration.'));
  assert.deepEqual([given.ok, given.approval.state, given.approval.decidedBy, given.approval.note], [true, 'approved', dana.email, 'Finish the migration.']);
  assert.deepEqual(f.pushes.at(-1), { to: ['eli@example.com'], title: 'a1 was approved', body: 'dana@example.com approved your start as Debbie. Start it again within the hour.', data: { event: 'approval.answered', kind: 'approval', name: '', hostId: '', url: '', approval: 'a1', member: 'debbie' } });
  assert.equal((await f.start(admin, 'debbie')).ok, true);
  assert.equal(f.sent.length, 2);
  // One start. The next is asked about again.
  const next = await f.start(admin, 'debbie');
  assert.deepEqual([next.error.code, next.approval.id], ['needs_approval', 'a2']);
  assert.equal(/** @type {any} */ (f.core.approvalsFor(admin)).approvals.find((/** @type {any} */ a) => a.id === 'a1').state, 'used');
});

test('somebody who does not manage the member is told who can approve, sees their own ask, and cannot answer it', async () => {
  const f = fleet();
  f.set({ dangerous: true });
  await f.reports();
  const refused = await f.start(sam, 'debbie', { mode: 'dangerous' });
  assert.equal(refused.error.code, 'needs_approval');
  assert.equal(refused.text, 'This session would not ask before it runs commands, on Debbie’s sign-ins. dana@example.com or eli@example.com, or a fleet admin, must approve it first: a1. Start it again once it is approved; nothing was sent.');
  assert.equal(refused.approval.mayAnswer, false);
  // It is his to see and not his to answer.
  assert.deepEqual(/** @type {any} */ (f.core.approvalsFor(sam)).approvals.map((/** @type {any} */ a) => [a.id, a.mayAnswer]), [['a1', false]]);
  const tried = /** @type {any} */ (await f.core.answerApproval(sam, 'a1', 'approve'));
  assert.equal(tried.error.code, 'not_manager');
  assert.equal(tried.text, 'a1 is yours to ask for and not yours to answer: it waits on somebody who manages Debbie, or a fleet admin.');
  // Somebody it is neither's is told it is not there.
  const stranger = { email: 'stranger@example.com', admin: false };
  assert.deepEqual(/** @type {any} */ (f.core.approvalsFor(stranger)).approvals, []);
  assert.equal(/** @type {any} */ (await f.core.answerApproval(stranger, 'a1', 'approve')).error.code, 'no_approval');
  // Dana manages Debbie: she sees it, may answer it, and her own start is hers to approve.
  assert.deepEqual(/** @type {any} */ (f.core.approvalsFor(dana)).approvals.map((/** @type {any} */ a) => [a.id, a.mayAnswer, a.memberName]), [['a1', true, 'Debbie']]);
  const own = await f.start(dana, 'debbie', { mode: 'dangerous' });
  assert.match(own.text, /That needs approval, which you may give yourself: a2\./);
  // Sam's approval, given, is for Sam's start and not for Dana's.
  await f.core.answerApproval(dana, 'a1', 'approve');
  assert.equal((await f.start(dana, 'debbie', { mode: 'dangerous' })).approval.id, 'a2');
  assert.equal((await f.start(sam, 'debbie', { mode: 'dangerous' })).ok, true);
  // A safe start as the same member needs no approval at all.
  assert.equal((await f.start(dana, 'debbie')).ok, true);
});

test('a declined approval lets nothing through, and the next try asks afresh', async () => {
  const f = fleet();
  // Loose reports to Sam, with five dollars a month. Sam manages it; Dana and Eli are not above it.
  assert.equal(f.core.org.set(admin, 'loose', { name: 'Loose', kind: 'agent', role: 'researcher', reportsTo: 'sam', budgetUsdMonth: 5 }).ok, true);
  f.set({ budgets: 'ask' });
  await f.reports();
  await f.start(sam, 'loose');
  await f.cost('cc-1', 6);
  assert.match((await f.start(sam, 'loose')).text, /which you may give yourself: a1/);
  // Only Sam is named for Dana, because only Sam manages Loose. And Dana,
  // who may not see what Loose has spent, is not told it by being refused.
  const danas = await f.start(dana, 'loose');
  assert.equal(danas.text, 'Loose is past its budget for this month. sam@example.com, or a fleet admin, must approve it first: a2. Start it again once it is approved; nothing was sent.');
  const mine = (/** @type {any} */ who) => /** @type {any} */ (f.core.approvalsFor(who)).approvals.find((/** @type {any} */ a) => a.id === 'a2');
  for (const told of [danas.text, JSON.stringify(danas.approval), JSON.stringify(mine(dana)), JSON.stringify(f.core.snapshot(dana).events)]) assert.ok(!told.includes('$6.00'), told);
  // Sam, who manages Loose and is the one asked, reads the figure on the same approval.
  assert.match(mine(sam).words, /Loose has spent \$6\.00 of a budget of \$5\.00 this month\./);
  // An admin answers as an admin.
  assert.equal(/** @type {any} */ (await f.core.answerApproval(admin, 'a1', 'decline', 'Not this month.')).approval.state, 'declined');
  assert.deepEqual(f.pushes.at(-1).title, 'a1 was declined');
  assert.equal(f.pushes.at(-1).body, 'eli@example.com declined your start as Loose. Not this month.');
  const again = await f.start(sam, 'loose');
  assert.deepEqual([again.error.code, again.approval.id], ['needs_approval', 'a3']);
});

test('an approval is for the task it was asked about, and a start that has gained a reason needs a new one', async () => {
  const f = fleet();
  f.set({ workTypes: ['deploy'] });
  await f.reports();
  const task = /** @type {any} */ (f.core.createTask(dana, { title: 'Ship it', brief: 'Deploy the API.', assignee: 'debbie', workType: 'deploy' }));
  const other = /** @type {any} */ (f.core.createTask(dana, { title: 'Ship the other', brief: 'Deploy the site.', assignee: 'debbie', workType: 'deploy' }));
  const refused = await f.start(dana, 'debbie', task.start);
  assert.deepEqual([refused.error.code, refused.approval.task], ['needs_approval', 't1']);
  assert.equal(refused.approval.reasons[0].text, 't1 is deploy work, which this fleet asks about first.');
  assert.equal(/** @type {any} */ (f.core.tasks.get('t1')).lock, null, 'and no lock was taken for a start that waits');
  await f.core.answerApproval(admin, 'a1', 'approve');
  // The approval for t1 does not start t2.
  assert.deepEqual([(await f.start(dana, 'debbie', other.start)).approval.id], ['a2']);
  // And t1 asked for dangerously has a reason a1 did not name.
  f.set({ dangerous: true });
  assert.deepEqual([(await f.start(dana, 'debbie', { ...task.start, mode: 'dangerous' })).approval.reasons.map((/** @type {any} */ r) => r.kind)], [['dangerous', 'risky-work']]);
  // As asked, it goes through, on a1.
  assert.equal((await f.start(dana, 'debbie', task.start)).ok, true);
  assert.equal(/** @type {any} */ (f.core.tasks.get('t1')).lock.session, 'cc-1');
});

test('a start the box refuses gives its approval back; one that never reaches a box does not spend it', async () => {
  const f = fleet();
  f.set({ dangerous: true });
  await f.reports();
  await f.start(dana, 'debbie', { mode: 'dangerous' });
  await f.core.answerApproval(dana, 'a1', 'approve');
  const state = () => /** @type {any} */ (f.core.approvalsFor(admin)).approvals.find((/** @type {any} */ a) => a.id === 'a1').state;
  // Refused on the way, for a reason of its own: a machine that is not there.
  const nowhere = /** @type {any} */ (await f.core.dispatch({ verb: 'start', params: { member: 'debbie', task: 'Do it.', mode: 'dangerous' }, actor: dana.email, requester: dana, preferHost: 'no-such-box' }));
  assert.equal(nowhere.ok, false);
  assert.equal(state(), 'approved');
  // Sent, and the box says no.
  f.answers(() => ({ ok: false, error: { code: 'no_room' }, text: 'This machine is full.' }));
  assert.equal((await f.start(dana, 'debbie', { mode: 'dangerous' })).ok, false);
  assert.equal(state(), 'approved', 'the box started nothing, so the approval is good again');
  f.answers((spec) => ({ ok: true, text: 'Started.', sessions: [{ name: 'cc-9', status: 'running', member: spec.params.member }] }));
  assert.equal((await f.start(dana, 'debbie', { mode: 'dangerous' })).ok, true);
  assert.equal(state(), 'used');
});

test('an approval nobody uses within the hour, or answers within the day, lets nothing through', async () => {
  const f = fleet();
  f.set({ dangerous: true });
  await f.reports();
  await f.start(dana, 'debbie', { mode: 'dangerous' });
  await f.core.answerApproval(dana, 'a1', 'approve');
  f.tick(APPROVAL_USE_MS);
  const late = await f.start(dana, 'debbie', { mode: 'dangerous' });
  assert.deepEqual([late.error.code, late.approval.id], ['needs_approval', 'a2']);
  f.tick(APPROVAL_WAIT_MS);
  assert.equal(/** @type {any} */ (await f.core.answerApproval(dana, 'a2', 'approve')).error.code, 'approval_closed');
  assert.deepEqual(/** @type {any} */ (f.core.approvalsFor(admin)).approvals.map((/** @type {any} */ a) => a.state), ['expired', 'expired']);
});

test('in refuse mode a start past the budget is refused in words, with no approval to wait for', async () => {
  const f = fleet();
  f.set({ budgets: 'refuse' });
  await f.reports();
  await f.start(dana, 'debbie');
  await f.cost('cc-1', 50);
  const refused = await f.start(admin, 'debbie');
  assert.deepEqual([refused.error.code, refused.approval], ['over_budget', undefined]);
  assert.match(refused.text, /^Debbie has spent \$50\.00 of a budget of \$50\.00 this month\. The fleet refuses a start past a budget/);
  // Raising the budget is how it starts again.
  assert.equal(f.core.setMember(admin, 'debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer', reportsTo: 'dana', budgetUsdMonth: 80 }).ok, true);
  assert.equal((await f.start(admin, 'debbie')).ok, true);
});

test('a budget is a month’s: a member refused at it in one month starts in the next, with nothing counted since', async () => {
  // Counting rolls a member's row to the new month, but only a session
  // reports a cost, and a member refused at its budget has none. Read as it
  // was kept, last month's total refused it for good.
  const f = fleet();
  f.set({ budgets: 'refuse' });
  await f.reports();
  await f.start(dana, 'debbie');
  await f.cost('cc-1', 60);
  f.as.clear();
  await f.reports();
  assert.equal((await f.start(dana, 'debbie')).error.code, 'over_budget');
  f.tick(8 * 86_400_000); // into December
  await f.reports();
  assert.equal(f.spendOf('debbie').over, false);
  assert.equal((await f.start(dana, 'debbie')).ok, true, 'the month turned');
  // And where the fleet asks first, it does not ask about a month that is over.
  const g = fleet();
  g.set({ budgets: 'ask' });
  await g.reports();
  await g.start(dana, 'debbie');
  await g.cost('cc-1', 60);
  g.tick(8 * 86_400_000);
  await g.reports();
  assert.equal((await g.start(sam, 'debbie')).ok, true);
});

test('an approval is for a member and not for its id: one removed takes its open approvals with it', async () => {
  const f = fleet();
  f.set({ dangerous: true });
  await f.reports();
  const asked = await f.start(sam, 'loose', { mode: 'dangerous' });
  assert.equal(/** @type {any} */ (await f.core.answerApproval(admin, asked.approval.id, 'approve')).ok, true);
  assert.equal(f.core.removeMember(admin, 'loose').ok, true);
  assert.equal(f.core.org.set(admin, 'loose', { name: 'Loose', kind: 'agent', role: 'somebody else entirely' }).ok, true);
  const again = await f.start(sam, 'loose', { mode: 'dangerous' });
  assert.equal(again.error?.code, 'needs_approval', 'the approval given for the member that was removed lets nothing through');
  assert.notEqual(again.approval.id, asked.approval.id);
  assert.equal(/** @type {any} */ (f.core.approvalsFor(admin)).approvals.find((/** @type {any} */ a) => a.id === asked.approval.id).state, 'expired');
});

test('a member’s managers are told once when it nears its budget and once when it passes it, and its sessions go on', async () => {
  const f = fleet();
  f.set({ budgets: 'ask' });
  await f.reports();
  await f.start(dana, 'debbie');
  f.pushes.length = 0;
  await f.cost('cc-1', 39);
  assert.deepEqual(f.pushes, []);
  await f.cost('cc-1', 41);
  await f.cost('cc-1', 45);
  assert.deepEqual(f.pushes.map((p) => [p.to, p.title, p.body]), [[['dana@example.com', 'eli@example.com'], 'Debbie is near its budget', '$41.00 of $50.00 this month, at API prices as each session counted it.']]);
  await f.cost('cc-1', 55);
  await f.cost('cc-1', 60);
  assert.deepEqual(f.pushes.slice(1).map((p) => [p.title, p.body, p.data]), [[
    'Debbie is over budget',
    '$55.00 of $50.00 this month, at API prices as each session counted it. Its sessions go on. Its next start waits for approval.',
    { event: 'budget.over', kind: 'budget', name: '', hostId: '', url: '', member: 'debbie' },
  ]]);
  assert.deepEqual(f.core.recentEvents(admin).filter((/** @type {any} */ e) => String(e.event).startsWith('budget.')).map((/** @type {any} */ e) => e.event), ['budget.warn', 'budget.over']);
  // A jump straight past the budget says "over" and not "near" after it.
  const g = fleet();
  await g.reports();
  await g.start(dana, 'debbie');
  g.pushes.length = 0;
  await g.cost('cc-1', 70);
  await g.cost('cc-1', 71);
  assert.deepEqual(g.pushes.map((p) => p.title), ['Debbie is over budget']);
});

test('a resumed session counts from the first figure heard, and a removed member takes its spend with it', async () => {
  const f = fleet();
  await f.reports();
  await f.start(dana, 'debbie');
  await f.cost('cc-1', 4);
  // The coordinator forgets, as a rebuilt one with no row would; the session is resumed as Debbie.
  f.core.budgets.forget('debbie');
  await f.cost('cc-1', 9);
  assert.equal(f.spendOf('debbie').usd, 0, 'a session it has no record of starting is not counted');
  assert.equal(/** @type {any} */ (await f.core.dispatch({ verb: 'resume', params: { name: 'cc-1' }, actor: dana.email, requester: dana, preferHost: 'deb132' })).ok, true);
  await f.cost('cc-1', 9);
  await f.cost('cc-1', 11.5);
  assert.equal(f.spendOf('debbie').usd, 2.5);
  // WHICH MEMBER A SESSION IS, ON A RESUME, IS ITS BOX'S WORD. Sam's session,
  // which his box calls Debbie's, is his to resume and not hers to pay for:
  // he could not have started as her.
  f.core.registry.connect('sam-box', () => {}, { actsFor: sam.email });
  const sams = (/** @type {number} */ usd) => f.core.onHostMessage('sam-box', {
    kind: 'health',
    health: {
      hub: { reachable: true }, protocol: PROTOCOL_VERSION, maxSessions: 9, running: 1, free: 8, labels: [], sandboxed: true, resumable: ['mine'],
      sessions: [{ name: 'mine', status: 'stopped', createdBy: `fleet:${sam.email}`, startedBy: sam.email, member: 'debbie', spent: { usd, complete: true } }],
    },
  });
  await sams(500);
  assert.equal(/** @type {any} */ (await f.core.dispatch({ verb: 'resume', params: { name: 'mine' }, actor: sam.email, requester: sam, preferHost: 'sam-box' })).ok, true);
  await sams(500);
  await sams(600);
  assert.equal(f.spendOf('debbie').usd, 2.5, 'a box naming a member does not spend that member’s budget');
  assert.equal(f.core.removeMember(admin, 'debbie').ok, true);
  assert.equal(f.core.budgets.spendOf('debbie'), null);
});

test('who sees whose spend: an admin everybody, a manager their team, a person their own member', async () => {
  const f = fleet();
  const seen = (/** @type {any} */ who) => /** @type {any} */ (f.core.budgetsFor(who)).members.map((/** @type {any} */ m) => m.member).sort();
  assert.deepEqual(seen(admin), ['dana', 'debbie', 'eli', 'loose', 'sam']);
  assert.deepEqual(seen(dana), ['dana', 'debbie']);
  assert.deepEqual(seen(sam), ['sam']);
  assert.deepEqual(seen({ email: 'stranger@example.com', admin: false }), []);
  assert.deepEqual([/** @type {any} */ (f.core.budgetsFor(dana)).you.admin, /** @type {any} */ (f.core.budgetsFor(dana)).settings.budgets], [false, 'off']);
});

test('the routes: the setting is an admin’s, an approval is answered by POST, and a path this does not serve is nobody’s', async () => {
  const f = fleet();
  const call = async (/** @type {string} */ method, /** @type {string} */ path, /** @type {any} */ who, /** @type {any} */ body) => /** @type {any} */ (await budgetsRoute(f.core, method, path, who, async () => body));
  assert.equal((await call('GET', '/api/budgets', sam)).status, 200);
  assert.equal((await call('PUT', '/api/budgets/settings', dana, { budgets: 'ask' })).status, 403);
  assert.equal((await call('PUT', '/api/budgets/settings', admin, { budgets: 'sometimes' })).status, 400);
  const set = await call('PUT', '/api/budgets/settings', admin, { budgets: 'ask', dangerous: true, workTypes: ['deploy'] });
  assert.deepEqual([set.status, set.body.text], [200, 'A start past a member’s budget waits for approval. A member start that skips permission prompts waits for approval. A start on deploy work waits for approval.']);
  await f.reports();
  await f.start(dana, 'debbie', { mode: 'dangerous' });
  assert.deepEqual((await call('GET', '/api/approvals', dana)).body.approvals.map((/** @type {any} */ a) => a.id), ['a1']);
  assert.equal((await call('POST', '/api/approvals/a1', sam, { answer: 'approve' })).status, 404);
  assert.equal((await call('POST', '/api/approvals/a1', dana, { answer: 'perhaps' })).status, 400);
  assert.equal((await call('POST', '/api/approvals/a99', dana, { answer: 'approve' })).status, 404);
  assert.equal((await call('POST', '/api/approvals/%E0%A4%A', dana, { answer: 'approve' })).status, 404);
  assert.equal((await call('POST', '/api/approvals/a1', dana, { answer: 'approve' })).status, 200);
  assert.equal((await call('POST', '/api/approvals/a1', dana, { answer: 'decline' })).status, 409);
  assert.equal(await call('DELETE', '/api/approvals/a1', dana), null);
  assert.equal(await call('POST', '/api/approvals/a1/extra', dana, {}), null);
  assert.equal(await call('POST', '/api/budgets', admin, {}), null);
});

test('a fleet keeps two hundred approvals: the oldest finished one makes room', async () => {
  const f = fleet();
  f.set({ dangerous: true });
  await f.reports();
  for (let i = 0; i < MAX_APPROVALS + 3; i++) {
    const r = await f.start(dana, 'debbie', { mode: 'dangerous' });
    await f.core.answerApproval(dana, r.approval.id, 'decline');
  }
  const kept = /** @type {any} */ (f.core.approvalsFor(admin)).approvals;
  assert.equal(kept.length, MAX_APPROVALS);
  assert.deepEqual([kept[0].id, kept.at(-1).id], [`a${MAX_APPROVALS + 3}`, 'a4']);
});

/** Durable Object state with the calls these rows use. */
function fakeState() {
  /** @type {Map<string, any>} */
  const rows = new Map();
  return {
    storage: {
      get: async (/** @type {string} */ k) => rows.get(k),
      put: async (/** @type {string} */ k, /** @type {any} */ v) => void rows.set(k, JSON.parse(JSON.stringify(v))),
      delete: async (/** @type {string} */ k) => rows.delete(k),
      list: async (/** @type {{ prefix: string }} */ { prefix }) => new Map([...rows].filter(([k]) => k.startsWith(prefix))),
    },
    blockConcurrencyWhile: (/** @type {() => Promise<any>} */ fn) => fn(),
    getWebSockets: () => [],
    setAlarm: () => {},
    waitUntil: () => {},
    rows,
  };
}
const settle = () => new Promise((r) => setImmediate(r));

test('spend, approvals and the setting survive the Durable Object being rebuilt, one row a member and one an approval', async () => {
  const state = fakeState();
  const first = new Fleet(/** @type {any} */ (state), {});
  await settle();
  assert.equal(first.core.org.set(admin, 'debbie', { name: 'Debbie', kind: 'agent', role: 'engineer', budgetUsdMonth: 50 }).ok, true);
  assert.equal(/** @type {any} */ (first.core.setBudgetSettings(admin, { budgets: 'ask', workTypes: ['deploy'] })).ok, true);
  first.core.budgets.started('debbie', 'deb132\ncc-1');
  first.core.budgets.count('debbie', 'deb132\ncc-1', { usd: 61.25, complete: true }, 50);
  const asked = first.core.budgets.ask({ member: 'debbie', task: null, reasons: [{ kind: 'over-budget', text: 'Debbie has spent $61.25 of a budget of $50.00 this month.' }], by: admin.email });
  first.core.onStateChanged?.();
  await settle();
  assert.deepEqual([...state.rows.keys()].filter((k) => k.startsWith(SPEND_PREFIX) || k.startsWith(APPROVALS_PREFIX)).sort(), ['approvals:a1', 'spend:debbie']);
  assert.deepEqual([state.rows.get('budgetSettings').budgets, state.rows.get('approvalSeq')], ['ask', 1]);

  const revived = new Fleet(/** @type {any} */ (state), {});
  await settle();
  const back = /** @type {any} */ (revived.core.budgetsFor(admin));
  assert.deepEqual([back.settings.budgets, back.settings.workTypes, back.members.find((/** @type {any} */ m) => m.member === 'debbie').usd], ['ask', ['deploy'], 61.25]);
  assert.deepEqual(/** @type {any} */ (revived.core.approvalsFor(admin)).approvals.map((/** @type {any} */ a) => [a.id, a.state]), [[asked.approval.id, 'waiting']]);
  // The session it was counting is still counted from where it was, not from nothing.
  revived.core.budgets.count('debbie', 'deb132\ncc-1', { usd: 62.25, complete: true }, 50);
  assert.equal(revived.core.budgets.spendOf('debbie')?.usd, 62.25);
  // And the next approval is a2, not a1 again.
  assert.equal(revived.core.budgets.ask({ member: 'debbie', task: 't9', reasons: [{ kind: 'dangerous', text: 'x' }], by: admin.email }).approval.id, 'a2');
});
