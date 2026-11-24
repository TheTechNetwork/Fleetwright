// Tasks in the coordinator (docs/tasks.md): who sees and changes one, the
// lock under two starts, the lock following the box's word, the result a
// box sends back, the routes, and the Durable Object's rows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { OrgMembers } from '../src/fleet/coordinator/org-members.js';
import { OrgTasks, TASKS_PREFIX, tasksRoute } from '../src/fleet/coordinator/org-tasks.js';
import { wordsFor, MAX_TASKS, MAX_TASK_TITLE, MAX_TASK_BRIEF, MAX_TASK_NOTE, MAX_RESULT, MAX_HANDOFFS } from '../src/fleet/protocol/tasks.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { Fleet } from '../worker/src/fleet-do.js';

const admin = { email: 'eli@example.com', admin: true };
const dana = { email: 'dana@example.com', admin: false };
const sam = { email: 'sam@example.com', admin: false };

/** Eli; Dana under Eli; the agents Debbie under Dana and Loose under nobody. */
function org(/** @type {() => number} */ now) {
  const o = new OrgMembers({ now });
  const add = (/** @type {string} */ id, /** @type {any} */ m) => assert.equal(o.set(admin, id, m).ok, true, id);
  add('eli', { name: 'Eli', kind: 'person', email: admin.email, role: 'owner' });
  add('dana', { name: 'Dana', kind: 'person', email: dana.email, role: 'team lead', reportsTo: 'eli' });
  add('debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer', reportsTo: 'dana', instructions: 'Write small pull requests.' });
  add('loose', { name: 'Loose', kind: 'agent', role: 'researcher' });
  return o;
}

/**
 * A fleet with one box at the current protocol, a clock a test moves, what
 * was sent to boxes, and a box that answers a start with a session's name.
 */
function fleet(/** @type {Array<[string, number]>} */ boxes = [['deb132', PROTOCOL_VERSION]]) {
  let clock = 1_000_000;
  const now = () => clock;
  const core = new CoordinatorCore({ now });
  core.org = org(now);
  const health = (/** @type {number} */ protocol, /** @type {string[]|null} */ sessions = []) => ({
    hub: { reachable: true }, protocol, maxSessions: 5, running: 0, free: 5, labels: [], sandboxed: true,
    sessions: sessions && sessions.map((name) => ({ name, status: 'running', createdBy: null })),
  });
  for (const [hostId, protocol] of boxes) {
    core.registry.connect(hostId, () => {});
    core.registry.recordHealth(hostId, health(protocol));
  }
  /** @type {Array<{ hostId: string, params: any }>} */
  const sent = [];
  /** What the box answers a start with; a test replaces it. @type {(spec: any) => any} */
  let answer = () => ({ ok: true, text: 'Started.', sessions: [{ name: `cc-${sent.length}`, status: 'running' }] });
  core.send = /** @type {any} */ (async (/** @type {any} */ host, /** @type {any} */ spec) => {
    sent.push({ hostId: host.hostId, params: spec.params });
    return answer(spec);
  });
  const make = (/** @type {any} */ who, /** @type {any} */ o = {}) => /** @type {any} */ (core.createTask(who, { title: 'Fix the login redirect', brief: 'It loses ?next. Fix it in app/auth.', assignee: 'debbie', ...o }));
  /**
   * Start a session on a task with the parameters a phone signs for it. Built
   * from the record whatever its state, so a start on a task that is held is
   * still a start on that task, which is the case the lock exists for.
   */
  const start = async (/** @type {any} */ who, /** @type {string} */ id, /** @type {any} */ over = {}) => {
    const t = core.tasks.get(id);
    const params = { ...(t ? { member: t.assignee, taskId: t.id, taskBranch: t.branch, ...(t.repo ? { taskRepo: t.repo } : {}), task: wordsFor(t) } : {}), ...over };
    for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];
    return core.dispatch({ verb: 'start', params, actor: who.email, requester: who, preferHost: boxes[0][0] });
  };
  const says = (/** @type {string} */ hostId, /** @type {any} */ event) => core.onHostMessage(hostId, { kind: 'event', ...event });
  const reports = (/** @type {string} */ hostId, /** @type {string[]|null} */ sessions) => core.onHostMessage(hostId, { kind: 'health', health: health(PROTOCOL_VERSION, sessions) });
  return {
    core, sent, make, start, says, reports,
    task: (/** @type {string} */ id) => /** @type {any} */ (core.tasks.get(id)),
    pass: (/** @type {number} */ ms) => void (clock += ms),
    answers: (/** @type {(spec: any) => any} */ fn) => void (answer = fn),
  };
}

test('whoever made a task, an admin, and whoever acts for its assignee see it; anybody else is told it is not there', () => {
  const { core, make } = fleet();
  const mine = make(sam, { assignee: null });
  assert.equal(mine.ok, true, mine.text);
  const debbies = make(dana);
  assert.equal(debbies.ok, true, debbies.text);
  const seen = (/** @type {any} */ who) => /** @type {any} */ (core.tasksFor(who)).tasks.map((/** @type {any} */ t) => t.id);
  assert.deepEqual(seen(sam), ['t1']);
  assert.deepEqual(seen(dana), ['t2'], 'Debbie is on Dana’s team');
  assert.deepEqual(seen(admin), ['t2', 't1'], 'newest first');
  // Not there, in the words a task that does not exist gets: a number cannot
  // be tried for whether somebody else's work is behind it.
  const hidden = /** @type {any} */ (core.taskFor(sam, 't2'));
  const absent = /** @type {any} */ (core.taskFor(sam, 't99'));
  assert.equal(hidden.error.code, 'no_task');
  assert.equal(hidden.text.replace('t2', 'tN'), absent.text.replace('t99', 'tN'));
  for (const refused of [core.changeTask(sam, 't2', { title: 'Mine now' }), core.actOnTask(sam, 't2', 'cancel', '')]) {
    assert.equal(/** @type {any} */ (refused).error.code, 'no_task');
  }
  // The break-glass token names nobody, and a task says who made it.
  assert.equal(/** @type {any} */ (core.createTask(null, { title: 'T', brief: 'B' })).error.code, 'not_signed_in');
});

test('handing work to a member needs standing over that member, at making and at reassigning', () => {
  const { core, make } = fleet();
  const refused = make(sam);
  assert.equal(refused.error.code, 'not_manager');
  assert.match(refused.text, /Debbie is not on your team and is not a member you may start as/);
  assert.equal(make(sam, { assignee: 'nobody-here' }).error.code, 'no_member');
  // Dana manages Debbie and not Loose.
  const made = make(dana);
  const moved = /** @type {any} */ (core.changeTask(dana, made.task.id, { assignee: 'loose', note: 'more her thing' }));
  assert.equal(moved.error.code, 'not_manager');
  // An admin moves it, and the handoff is written down with the note.
  const ok = /** @type {any} */ (core.changeTask(admin, made.task.id, { assignee: 'loose', note: 'more her thing' }));
  assert.equal(ok.ok, true, ok.text);
  assert.deepEqual(ok.task.handoffs.at(-1), { at: ok.task.updatedAt, by: admin.email, kind: 'assigned', from: 'debbie', to: 'loose', note: 'more her thing' });
});

test('a start on a task is sent as the signed words, the fleet’s instructions and the task’s own branch, and takes the lock', async () => {
  const { core, sent, make, start, task } = fleet();
  const made = make(dana, { repo: 'acme/app' });
  assert.deepEqual(made.start, { member: 'debbie', taskId: 't1', taskBranch: 'task/t1-fix-the-login-redirect', taskRepo: 'acme/app', task: 'Fix the login redirect\n\nIt loses ?next. Fix it in app/auth.' });
  const r = await start(dana, 't1');
  assert.equal(r.ok, true, r.text);
  const { member, taskId, taskBranch, taskRepo, task: words, memberBrief } = sent[0].params;
  assert.deepEqual({ member, taskId, taskBranch, taskRepo, task: words, memberBrief }, { ...made.start, memberBrief: 'Write small pull requests.' });
  const held = task('t1');
  assert.equal(held.state, 'working');
  assert.deepEqual(held.lock, { session: 'cc-1', hostId: 'deb132', member: 'debbie', by: dana.email, at: held.lock.at });
  assert.equal(/** @type {any} */ (core.taskFor(dana, 't1')).start, null, 'nothing to sign while it is held');
});

test('of two starts on one task the second is refused and never reaches a box', async () => {
  const { sent, make, start, answers } = fleet();
  make(dana);
  // A box that takes a moment, so both starts are in flight together.
  answers(() => new Promise((r) => setTimeout(() => r({ ok: true, text: 'Started.', sessions: [{ name: 'cc-first', status: 'running' }] }), 5)));
  const both = await Promise.all([start(dana, 't1'), start(admin, 't1')]);
  assert.deepEqual(both.map((r) => r.ok), [true, false]);
  assert.equal(both[1].error?.code, 'task_locked');
  assert.match(String(both[1].text), /t1 is already being worked on: dana@example\.com started a session on it .* and deb132 has not answered yet/);
  assert.equal(sent.length, 1);
  // And once the box has answered, in words that name the session.
  const later = await start(admin, 't1');
  assert.equal(later.error?.code, 'task_locked');
  assert.match(String(later.text), /cc-first on deb132 has been working on it since/);
  assert.equal(sent.length, 1);
});

test('a start the box refuses leaves the task open and unmarked; one the box never answers keeps the lock until its session speaks or five minutes pass', async () => {
  const { sent, make, start, task, answers, says, reports, pass } = fleet();
  make(dana);
  answers(() => ({ ok: false, error: { code: 'not_custodian' }, text: 'dana@example.com may not start a session as Debbie.' }));
  assert.equal((await start(dana, 't1')).ok, false);
  assert.deepEqual([task('t1').state, task('t1').lock, task('t1').handoffs.length], ['open', null, 1]);

  // No answer in time: cannot tell, so the lock is kept and a second start waits.
  answers(() => { throw new Error('deb132 did not answer in 60s'); });
  assert.equal((await start(dana, 't1')).error?.code, 'host_timeout');
  assert.equal(task('t1').lock.session, null);
  assert.equal((await start(admin, 't1')).error?.code, 'task_locked');
  // The session did start, and its box's word takes the lock up.
  await says('deb132', { event: 'session.ready', name: 'cc-late', taskId: 't1', tasked: true, result: { text: 'DONE\nIt was quick.' } });
  assert.deepEqual([task('t1').state, task('t1').result.session], ['returned', 'cc-late']);

  // The other ending: nothing ever speaks of it, and the lock is let go.
  make(dana, { title: 'Second' });
  assert.equal((await start(dana, 't2')).error?.code, 'host_timeout');
  pass(4 * 60_000);
  await reports('deb132', []);
  assert.notEqual(task('t2').lock, null, 'four minutes is still inside the wait');
  pass(2 * 60_000);
  await reports('deb132', []);
  assert.deepEqual([task('t2').state, task('t2').lock, task('t2').handoffs.length], ['open', null, 1]);
  assert.equal(sent.length, 3, 'the start refused for the lock reached no box');
});

test('a start that breaks the task’s own terms is refused before a machine is chosen', async () => {
  const { core, sent, make, start } = fleet();
  make(admin, { repo: 'acme/app' });
  const code = async (/** @type {any} */ over) => (await start(admin, 't1', over)).error?.code;
  assert.equal(await code({ member: 'loose' }), 'task_not_theirs');
  assert.equal(await code({ taskBranch: 'task/t1-something-else' }), 'task_branch');
  assert.equal(await code({ taskRepo: 'acme/other' }), 'task_repo');
  assert.equal(await code({ task: '   ' }), 'bad_params');
  assert.equal(await code({ member: undefined }), 'task_needs_member');
  assert.equal(await code({ taskId: 't99' }), 'no_task');
  // Words that fit beside the instructions alone, and not with the lines a
  // box adds for a task: said here, before a machine is woken for it.
  assert.equal(await code({ task: 'x'.repeat(7700) }), 'too_long');
  assert.deepEqual(sent, []);
  assert.equal(core.tasks.get('t1')?.lock, null);
  // With no task named, a stray branch is not carried to a box as if it meant something.
  const plain = await core.dispatch({ verb: 'start', params: { task: 'Just a session.', taskBranch: 'task/t1-fix-the-login-redirect', taskRepo: 'acme/app' }, actor: admin.email, requester: admin, preferHost: 'deb132' });
  assert.equal(plain.ok, true, plain.text);
  assert.deepEqual([sent[0].params.taskBranch, sent[0].params.taskRepo], [undefined, undefined]);
});

test('a host older than protocol 20 is refused a start on a task, nothing is sent, and no lock is taken', async () => {
  const { sent, make, start, task } = fleet([['box-19', 19]]);
  make(dana);
  const old = await start(dana, 't1');
  assert.equal(old.error?.code, 'host_outdated');
  assert.match(String(old.text), /box-19 is too old to run a session on a task .* speaks protocol 19, and this needs 20\. It would never say which task the session was for, or send its result back/);
  assert.deepEqual(sent, []);
  assert.equal(task('t1').lock, null);
});

test('a result the box read comes back onto the task, and only its outcome reaches the feed', async () => {
  const { core, make, start, task, says } = fleet();
  make(dana);
  await start(dana, 't1');
  await says('deb132', { event: 'session.ready', name: 'cc-1', text: 'is back at its prompt', tasked: true, taskId: 't1', result: { text: 'BLOCKED\nThe registry key ACME_TOKEN is missing on this box.' } });
  const t = task('t1');
  assert.equal(t.state, 'returned');
  assert.deepEqual(t.result, { outcome: 'blocked', summary: 'BLOCKED\nThe registry key ACME_TOKEN is missing on this box.', truncated: false, session: 'cc-1', hostId: 'deb132', member: 'debbie', at: t.result.at });
  // The feed and the push line get the id and the outcome. What the session
  // wrote stays on the task, which fewer people may see.
  const feed = JSON.stringify(core.recentEvents(null));
  assert.match(feed, /is back with a result for t1: BLOCKED/);
  assert.match(feed, /t1 “Fix the login redirect” came back from debbie: BLOCKED/);
  assert.ok(!feed.includes('ACME_TOKEN'));
  // The person who made it reads that it came back; somebody else does not.
  const kinds = (/** @type {any} */ who) => core.recentEvents(who).map((/** @type {any} */ e) => e.event);
  assert.ok(kinds(dana).includes('task.returned'));
  assert.ok(!kinds(sam).includes('task.returned'));
});

test('back at its prompt with nothing written is not a result, and the page can say so', async () => {
  const { core, make, start, task, says } = fleet();
  make(dana);
  await start(dana, 't1');
  for (const result of [undefined, null, { text: '   ' }, 'DONE']) await says('deb132', { event: 'session.ready', name: 'cc-1', tasked: true, taskId: 't1', result });
  const t = task('t1');
  assert.deepEqual([t.state, t.result], ['working', null]);
  assert.equal(typeof t.lock.readyAt, 'number');
  assert.match(JSON.stringify(core.recentEvents(null)), /is back at its prompt and wrote no result for t1/);
});

test('the coordinator cuts a result again itself: a box’s word for how much it sent is not a bound', async () => {
  const { make, start, task, says } = fleet();
  make(dana);
  await start(dana, 't1');
  await says('deb132', { event: 'session.ready', name: 'cc-1', tasked: true, taskId: 't1', result: { text: `DONE\n${'x'.repeat(50_000)}`, truncated: false } });
  assert.equal(new TextEncoder().encode(task('t1').result.summary).length, MAX_RESULT);
  assert.equal(task('t1').result.truncated, true);
});

test('the lock ends on the box’s word: its session ended, and only that box and that session may say so', async () => {
  const { core, make, start, task, says } = fleet([['deb132', PROTOCOL_VERSION], ['other', PROTOCOL_VERSION]]);
  make(dana);
  await start(dana, 't1');
  // Another box, and another session on the right box, naming the task: neither holds it.
  await says('other', { event: 'session.ended', name: 'cc-1', taskId: 't1' });
  await says('deb132', { event: 'session.ended', name: 'cc-imposter', taskId: 't1' });
  await says('other', { event: 'session.ready', name: 'cc-1', taskId: 't1', tasked: true, result: { text: 'DONE\nnot really' } });
  assert.deepEqual([task('t1').state, task('t1').lock.session, task('t1').result], ['working', 'cc-1', null]);
  await says('deb132', { event: 'session.ended', name: 'cc-1', taskId: 't1' });
  assert.deepEqual([task('t1').state, task('t1').lock], ['open', null]);
  assert.deepEqual(task('t1').handoffs.at(-1).note, 'its session ended with no result');
  assert.ok(core.recentEvents(dana).some((/** @type {any} */ e) => e.event === 'task.released'));
  // Open again means startable again, on the same branch.
  assert.equal(/** @type {any} */ (core.taskFor(dana, 't1')).start.taskBranch, 'task/t1-fix-the-login-redirect');
});

test('a session its box no longer lists releases the task; a box that is away or cannot list is cannot-tell and keeps it', async () => {
  const { core, make, start, task, reports, pass } = fleet();
  make(dana);
  await start(dana, 't1');
  // A list from inside the grace after the start may be the one from before it.
  pass(60_000);
  await reports('deb132', []);
  assert.equal(task('t1').lock?.session, 'cc-1');
  pass(2 * 60_000);
  // Too busy to list its sessions: null is cannot-tell, never "none".
  await reports('deb132', null);
  assert.equal(task('t1').lock?.session, 'cc-1');
  await reports('deb132', ['cc-1', 'cc-other']);
  assert.equal(task('t1').lock?.session, 'cc-1');
  // Away: kept, and the task says its box is not connected.
  core.registry.disconnect('deb132');
  assert.equal(/** @type {any} */ (core.taskFor(dana, 't1')).task.lock.connected, false);
  core.registry.connect('deb132', () => {});
  assert.equal(task('t1').lock?.session, 'cc-1');
  // Back, listing its sessions, and this one is not among them.
  await reports('deb132', ['cc-other']);
  assert.deepEqual([task('t1').state, task('t1').lock], ['open', null]);
  assert.equal(task('t1').handoffs.at(-1).note, 'deb132 no longer lists its session');
});

test('release, accept, reopen and cancel go through the coordinator with the task’s rules, and a reopened task is started on its note', async () => {
  const { core, sent, make, start, task, says } = fleet();
  make(dana);
  await start(dana, 't1');
  assert.equal(/** @type {any} */ (core.actOnTask(dana, 't1', 'accept', '')).error.code, 'task_not_returned');
  await says('deb132', { event: 'session.ready', name: 'cc-1', tasked: true, taskId: 't1', result: { text: 'DONE' } });
  const reopened = /** @type {any} */ (core.actOnTask(dana, 't1', 'reopen', 'Still drops ?next on Safari.'));
  assert.equal(reopened.ok, true, reopened.text);
  assert.match(reopened.start.task, /\n\nReopened: Still drops \?next on Safari\.$/);
  assert.equal((await start(dana, 't1')).ok, true);
  assert.match(sent[1].params.task, /Reopened: Still drops \?next on Safari\./);
  assert.equal(task('t1').lock.session, 'cc-2');
  const released = /** @type {any} */ (core.actOnTask(dana, 't1', 'release', ''));
  assert.match(released.text, /^Released t1\. It is open again; the session that held it is not stopped by this\.$/);
  // RELEASED AFTER IT CAME BACK: it keeps its result and its state, the
  // answer says that and not "open again", and the history says who did it.
  await start(dana, 't1');
  await says('deb132', { event: 'session.ready', name: 'cc-3', tasked: true, taskId: 't1', result: { text: 'DONE' } });
  const kept = /** @type {any} */ (core.actOnTask(dana, 't1', 'release', ''));
  assert.deepEqual([kept.task.state, kept.task.lock, kept.task.result.outcome], ['returned', null, 'done']);
  assert.equal(kept.text, 'Released t1 from its session, which is not stopped by this. It is still back with its result, to accept or reopen.');
  assert.deepEqual(kept.task.handoffs.at(-1), { at: kept.task.updatedAt, by: dana.email, kind: 'released', session: 'cc-3', hostId: 'deb132', note: 'released by hand' });
  assert.equal(/** @type {any} */ (core.actOnTask(dana, 't1', 'cancel', '')).task.state, 'cancelled');
});

test('the routes answer the same way on both coordinators: one function, and its status codes', async () => {
  const { core, make, start } = fleet();
  const call = async (/** @type {string} */ method, /** @type {string} */ path, /** @type {any} */ who, /** @type {any} */ body) => {
    const [pathname, query = ''] = path.split('?');
    return /** @type {any} */ (await tasksRoute(core, method, pathname, new URLSearchParams(query), who, async () => body));
  };
  assert.equal((await call('POST', '/api/tasks', dana, { title: 'T', brief: 'B', assignee: 'debbie' })).status, 200);
  assert.equal((await call('POST', '/api/tasks', dana, { title: 'T' })).status, 400);
  assert.equal((await call('POST', '/api/tasks', sam, { title: 'T', brief: 'B', assignee: 'debbie' })).status, 403);
  assert.equal((await call('POST', '/api/tasks', null, { title: 'T', brief: 'B' })).status, 403);
  assert.equal((await call('GET', '/api/tasks/t1', sam)).status, 404);
  assert.equal((await call('GET', '/api/tasks/%E0%A4%A', dana)).status, 404);
  const one = await call('GET', '/api/tasks/t1', dana);
  assert.deepEqual([one.status, one.body.task.id, one.body.start.taskId], [200, 't1', 't1']);
  make(dana, { title: 'Other' });
  await start(dana, 't1');
  assert.deepEqual((await call('GET', '/api/tasks?state=working', dana)).body.tasks.map((/** @type {any} */ t) => t.id), ['t1']);
  // A state nobody has is refused: answered with everything, a screen drew every task under one heading.
  const nonsense = await call('GET', '/api/tasks?state=nonsense', dana);
  assert.deepEqual([nonsense.status, nonsense.body.error.code, nonsense.body.tasks], [400, 'bad_state', undefined]);
  assert.equal((await call('PUT', '/api/tasks/t1', admin, { assignee: 'loose' })).status, 409, 'held');
  assert.equal((await call('POST', '/api/tasks/t1/act', dana, { action: 'accept' })).status, 409);
  assert.equal((await call('POST', '/api/tasks/t1/act', dana, { action: 'reopen' })).status, 409);
  assert.equal((await call('POST', '/api/tasks/t1/act', dana, { action: 'explode' })).status, 400);
  assert.equal((await call('POST', '/api/tasks/t1/act', dana, { action: 'release' })).status, 200);
  // A path or method this does not serve is nobody's, so the caller's 404 stands.
  assert.equal(await call('DELETE', '/api/tasks/t1', dana), null);
  assert.equal(await call('POST', '/api/tasks/t1/act/extra', dana, {}), null);
});

test('a fleet keeps five hundred tasks: the oldest finished one makes room, and five hundred unfinished refuse another', () => {
  let t = 1;
  const tasks = new OrgTasks({ now: () => t++ });
  const who = { email: 'eli@example.com', admin: true, acts: [] };
  for (let i = 0; i < MAX_TASKS; i++) assert.equal(tasks.create(who, { title: `Task ${i}`, brief: 'B' }, () => null).ok, true);
  const full = /** @type {any} */ (tasks.create(who, { title: 'One more', brief: 'B' }, () => null));
  assert.equal(full.error.code, 'too_many');
  assert.match(full.text, /keeps 500 tasks and every one of them is unfinished/);
  assert.equal(tasks.act(who, 't7', 'cancel', '').ok, true);
  const made = /** @type {any} */ (tasks.create(who, { title: 'One more', brief: 'B' }, () => null));
  assert.equal(made.task.id, `t${MAX_TASKS + 1}`, 'a number is never used twice');
  assert.equal(tasks.get('t7'), null);
  assert.equal(tasks.all().length, MAX_TASKS);
});

/** Durable Object state with the calls the task rows use. */
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

test('tasks survive the Durable Object being rebuilt, one row each, with the counter that numbers them', async () => {
  const state = fakeState();
  const first = new Fleet(/** @type {any} */ (state), {});
  await settle();
  assert.equal(/** @type {any} */ (first.core.createTask(admin, { title: 'One', brief: 'B' })).ok, true);
  assert.equal(/** @type {any} */ (first.core.createTask(admin, { title: 'Two', brief: 'B', parent: 't1' })).ok, true);
  assert.equal(/** @type {any} */ (first.core.actOnTask(admin, 't2', 'cancel', 'not needed')).ok, true);
  await settle();
  assert.deepEqual([...state.rows.keys()].filter((k) => k.startsWith(TASKS_PREFIX)).sort(), ['tasks:t1', 'tasks:t2']);
  assert.equal(state.rows.get('taskSeq'), 2);

  // The highest-numbered row lost, as a trim or a damaged row would lose it:
  // the counter still knows the number was given out.
  state.rows.delete('tasks:t2');
  state.rows.set('tasks:t9', { id: 't9', title: '', brief: 'no title: not a task' });
  state.rows.set('tasks:bad', { id: 'bad', title: 'T', brief: 'B', state: 'open' });
  const revived = new Fleet(/** @type {any} */ (state), {});
  await settle();
  assert.deepEqual(revived.core.tasks.all().map((t) => t.id), ['t1']);
  assert.deepEqual(revived.core.tasks.get('t1'), first.core.tasks.get('t1'));
  assert.equal(/** @type {any} */ (revived.core.createTask(admin, { title: 'Three', brief: 'B' })).task.id, 't3');
});

test('the widest task fits a Durable Object value several times over', () => {
  let t = 1;
  const tasks = new OrgTasks({ now: () => t++ });
  const who = { email: `${'e'.repeat(64)}@${'d'.repeat(63)}`, admin: true, acts: [] };
  const made = /** @type {any} */ (tasks.create(who, { title: '字'.repeat(MAX_TASK_TITLE), brief: '字'.repeat(MAX_TASK_BRIEF / 3), repo: `${'a'.repeat(39)}/${'r'.repeat(100)}`, workType: 'w'.repeat(40) }, () => null));
  assert.equal(made.ok, true, made.text);
  // Every handoff slot filled with the longest note, then a full result.
  for (let i = 0; i < MAX_HANDOFFS + 5; i++) {
    tasks.byId.set('t1', { ...tasks.byId.get('t1'), assignee: 'x'.repeat(40) });
    tasks.onSession('h'.repeat(128), 's'.repeat(40), { event: 'session.ready', task: 't1', result: { text: `DONE${'字'.repeat(2000)}` } });
    assert.equal(tasks.act(who, 't1', 'reopen', '字'.repeat(MAX_TASK_NOTE / 3)).ok, true);
  }
  tasks.onSession('h'.repeat(128), 's'.repeat(40), { event: 'session.ready', task: 't1', result: { text: `DONE${'字'.repeat(2000)}` } });
  const widest = new TextEncoder().encode(JSON.stringify(tasks.get('t1'))).length;
  assert.ok(tasks.get('t1')?.handoffs.length === MAX_HANDOFFS && tasks.get('t1')?.result);
  assert.ok(widest * 3 < 128 * 1024, `${widest} bytes`);
});
