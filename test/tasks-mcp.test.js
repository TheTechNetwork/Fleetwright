// The task tools an agent has (docs/tasks.md): fleet_tasks, fleet_task,
// fleet_delegate, and fleet_start with a task's id.
//
// AGAINST THE REAL COORDINATOR, not a table of canned answers: the MCP
// server's fetch is routed to the same `tasksRoute` and `dispatch` both
// coordinators serve, so what these tools are told is what the fleet says.
// The only stand-in is the box, which answers a start with a session's name
// and reports when the test says it does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '../src/mcp/server.js';
import { toolsFor } from '../src/mcp/tools.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { tasksRoute } from '../src/fleet/coordinator/org-tasks.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

const eli = { email: 'eli@example.com', admin: true };
const rpc = (/** @type {number} */ id, /** @type {string} */ name, /** @type {any} */ args) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

/**
 * An agent's MCP server, acting as Eli, on a fleet with one box and the
 * agent member Debbie.
 *
 * @param {{ onSleep?: (f: ReturnType<typeof fleet>) => any, maxWaitMs?: number }} [opts]
 */
function fleet(opts = {}) {
  let clock = 1_000_000;
  const core = new CoordinatorCore({ now: () => clock });
  assert.equal(core.setMember(eli, 'eli', { name: 'Eli', kind: 'person', email: eli.email, role: 'owner' }).ok, true);
  assert.equal(core.setMember(eli, 'debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer', reportsTo: 'eli', instructions: 'Write small pull requests.' }).ok, true);
  core.registry.connect('deb132', () => {});
  core.registry.recordHealth('deb132', { hub: { reachable: true }, protocol: PROTOCOL_VERSION, maxSessions: 5, running: 0, free: 5, labels: [], sandboxed: true, sessions: [] });
  /** @type {any[]} */
  const started = [];
  /** What the box answers a start with; a test replaces it. @type {{ answer: (spec: any) => any }} */
  const box = { answer: () => ({ ok: true, text: 'Started "cc-1".', hostId: 'deb132', sessions: [{ name: 'cc-1', status: 'running', hostId: 'deb132' }] }) };
  core.send = /** @type {any} */ (async (/** @type {any} */ _host, /** @type {any} */ spec) => {
    if (spec.verb !== 'start') return { ok: true, text: '', sessions: [] };
    started.push(spec.params);
    return box.answer(spec);
  });
  /** @type {any[]} */
  const written = [];
  /** @type {string[]} */
  const asked = [];
  const self = { core, started, written, asked, box, says: (/** @type {any} */ event) => core.onHostMessage('deb132', { kind: 'event', ...event }), server: /** @type {McpServer} */ (/** @type {any} */ (null)) };
  self.server = new McpServer({
    coordinator: 'https://fleet.example',
    credential: 'fwk_test_secret',
    write: (line) => written.push(JSON.parse(line)),
    now: () => clock,
    watchMs: 0,
    ...(opts.maxWaitMs ? { maxWaitMs: opts.maxWaitMs } : {}),
    sleep: async (/** @type {number} */ ms) => {
      clock += ms;
      await opts.onSleep?.(self);
    },
    fetch: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
      const u = new URL(url);
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      asked.push(`${method} ${u.pathname}${u.search}`);
      if (u.pathname === '/api/intent') {
        const r = await core.dispatch({ verb: body.verb, params: body.params, actor: eli.email, requester: eli, ...(body.host ? { preferHost: body.host } : {}) });
        return { status: 200, json: async () => r };
      }
      const answer = await tasksRoute(core, method, u.pathname, u.searchParams, eli, async () => body);
      return answer ? { status: answer.status, json: async () => answer.body } : { status: 404, json: async () => { throw new Error('not json'); } };
    }),
  });
  return self;
}
const text = (/** @type {any} */ f) => String(f.written.at(-1).result.content[0].text);
const isError = (/** @type {any} */ f) => f.written.at(-1).result.isError === true;

test('fleet_delegate makes the task, starts its assignee on it, waits, and answers with the result packet', async () => {
  const f = fleet({
    // The box reports the session back, with its result, while the tool waits.
    onSleep: (self) => self.says({ event: 'session.ready', name: 'cc-1', tasked: true, taskId: 't1', result: { text: 'DONE\nFixed the redirect in 3f2a. Did not test Safari.' } }),
  });
  await f.server.handleLine(rpc(1, 'fleet_delegate', { to: 'debbie', title: 'Fix the login redirect', brief: 'It loses ?next. Fix it in app/auth.', repo: 'acme/app' }));
  assert.equal(isError(f), false, text(f));
  assert.equal(text(f), [
    'Handed t1 to debbie: cc-1 on deb132.',
    '',
    't1 “Fix the login redirect”, worked on by debbie: DONE.',
    'Session cc-1 on deb132. Branch task/t1-fix-the-login-redirect in acme/app, as the session was told: nothing here checked that it exists.',
    '',
    'DONE\nFixed the redirect in 3f2a. Did not test Safari.',
    '',
    'That is the session’s own account: it stopped and said this, and nothing checked the work. Accept it or reopen it with fleet_task. cc-1 is still at its prompt: stop it with fleet_stop when you have what you need.',
  ].join('\n'));
  // The brief is the whole handover: the task's words, and nothing else of the caller's.
  assert.deepEqual(f.started.map((p) => [p.member, p.taskId, p.taskBranch, p.taskRepo, p.task]), [['debbie', 't1', 'task/t1-fix-the-login-redirect', 'acme/app', 'Fix the login redirect\n\nIt loses ?next. Fix it in app/auth.']]);
  // What it started is this conversation's to stop.
  assert.ok(f.server.started.has('cc-1'));
  // And the task is accepted with the other tool.
  await f.server.handleLine(rpc(2, 'fleet_task', { id: 't1', action: 'accept' }));
  assert.match(text(f), /^t1 is done\./);
  assert.equal(f.core.tasks.get('t1')?.state, 'done');
});

test('a wait that runs out is not a failure, and `task` picks the wait back up', async () => {
  let reportNow = false;
  const f = fleet({ onSleep: (self) => (reportNow ? self.says({ event: 'session.ready', name: 'cc-1', tasked: true, taskId: 't1', result: { text: 'BLOCKED\nNo access to acme/app.' } }) : null) });
  await f.server.handleLine(rpc(1, 'fleet_delegate', { to: 'debbie', title: 'Fix it', brief: 'Do the thing.', seconds: 10 }));
  assert.equal(isError(f), false);
  assert.match(text(f), /^Handed t1 to debbie: cc-1 on deb132\.\n\nt1 is still being worked on after 10s, by cc-1 on deb132\. That is not a failure\. Call fleet_delegate again with `task: "t1"` to keep waiting\.$/);
  reportNow = true;
  await f.server.handleLine(rpc(2, 'fleet_delegate', { task: 't1', seconds: 10 }));
  assert.match(text(f), /^t1 “Fix it”, worked on by debbie: BLOCKED\./);
  assert.equal(isError(f), false, 'blocked is an answer');
  assert.equal(f.started.length, 1, 'waiting again starts nothing');
  assert.equal(f.core.tasks.all().length, 1, 'and makes nothing');
});

test('a delegation that produces no result says what is left behind, as an error', async () => {
  // THE START IS REFUSED: the task made for it is cancelled again. Each one
  // used to be left open, and five hundred unfinished tasks refuse everybody
  // a new one: an agent retrying a start that could not work filled the table.
  let f = fleet();
  f.box.answer = () => ({ ok: false, error: { code: 'not_custodian' }, text: 'eli@example.com may not start a session as Debbie. Nothing was started.' });
  await f.server.handleLine(rpc(1, 'fleet_delegate', { to: 'debbie', title: 'Fix it', brief: 'Do the thing.' }));
  assert.equal(isError(f), true);
  assert.equal(text(f), 'eli@example.com may not start a session as Debbie. Nothing was started.\n\nt1 was made for this and has been cancelled, since nothing was started on it. Call fleet_delegate again once that is put right.');
  assert.deepEqual([f.core.tasks.get('t1')?.state, f.core.tasks.get('t1')?.lock, f.core.tasks.get('t1')?.handoffs.at(-1)?.note], ['cancelled', null, 'its start was refused']);

  // WAITING ON A PERSON is not refused for good: the approval names the task, so it stays.
  f = fleet();
  assert.equal(/** @type {any} */ (f.core.setBudgetSettings(eli, { workTypes: ['deploy'] })).ok, true);
  await f.server.handleLine(rpc(1, 'fleet_delegate', { to: 'debbie', title: 'Ship it', brief: 'Deploy the API.', workType: 'deploy' }));
  assert.equal(isError(f), true);
  assert.match(text(f), /which you may give yourself: a1\. Start it again once it is approved; nothing was sent\.\n\nt1 was made and is open, waiting on that approval\. Once it is given, start it with fleet_start and `taskId: "t1"`\. The approval is for the task as it is now, so changing its title or brief asks for a new one\.$/);
  assert.equal(f.core.tasks.get('t1')?.state, 'open');

  // NO ANSWER IN TIME is not "nothing working on it": the box may have started the session, and nobody here knows.
  f = fleet();
  f.box.answer = () => {
    throw new Error('deb132 did not answer in time');
  };
  await f.server.handleLine(rpc(1, 'fleet_delegate', { to: 'debbie', title: 'Fix it', brief: 'Do the thing.' }));
  assert.equal(isError(f), true);
  assert.equal(text(f), 'deb132 did not answer in time\n\nt1 was made, and whether a session started on it is not known: no answer came back in time, and one may have started all the same. fleet_tasks with `id: "t1"` shows whether a session holds it. If none does in a few minutes, start it with fleet_start and `taskId`, or cancel it with fleet_task.');
  assert.deepEqual([f.core.tasks.get('t1')?.state, f.core.tasks.get('t1')?.lock?.hostId], ['open', 'deb132'], 'and the task is kept, with the lock its start took');

  // THE SESSION STOPS AND WROTE NOTHING: no result is made up from it.
  f = fleet({ onSleep: (self) => self.says({ event: 'session.ready', name: 'cc-1', tasked: true, taskId: 't1' }) });
  await f.server.handleLine(rpc(2, 'fleet_delegate', { to: 'debbie', title: 'Fix it', brief: 'Do the thing.' }));
  assert.equal(isError(f), true);
  assert.match(text(f), /cc-1 is back at its prompt on deb132 and wrote no RESULT\.md, so t1 has no result\. fleet_read_log shows what it did/);

  // THE SESSION ENDS: the task is open again, and the reply says why.
  f = fleet({ onSleep: (self) => self.says({ event: 'session.ended', name: 'cc-1', taskId: 't1' }) });
  await f.server.handleLine(rpc(3, 'fleet_delegate', { to: 'debbie', title: 'Fix it', brief: 'Do the thing.' }));
  assert.equal(isError(f), true);
  assert.match(text(f), /t1 is open and no session holds it \(its session ended with no result\), so no result is coming/);

  // FAILED, said by the session itself, is an error too.
  f = fleet({ onSleep: (self) => self.says({ event: 'session.ready', name: 'cc-1', tasked: true, taskId: 't1', result: { text: 'FAILED\nThe build is red.' } }) });
  await f.server.handleLine(rpc(4, 'fleet_delegate', { to: 'debbie', title: 'Fix it', brief: 'Do the thing.' }));
  assert.equal(isError(f), true);
  assert.match(text(f), /worked on by debbie: FAILED\./);

  // AND IT ASKS FOR WHAT IT NEEDS before it makes anything.
  f = fleet();
  await f.server.handleLine(rpc(5, 'fleet_delegate', { to: 'debbie', title: 'No brief' }));
  assert.equal(isError(f), true);
  assert.equal(f.core.tasks.all().length, 0);
});

test('fleet_start with a task’s id sends the task’s own words, assignee and branch', async () => {
  const f = fleet();
  await f.server.handleLine(rpc(1, 'fleet_task', { title: 'Fix the login redirect', brief: 'It loses ?next.', assignee: 'debbie' }));
  assert.match(text(f), /^Made t1, assigned to debbie\. Its branch is task\/t1-fix-the-login-redirect\./);
  await f.server.handleLine(rpc(2, 'fleet_start', { taskId: 't1', host: 'deb132' }));
  assert.equal(isError(f), false, text(f));
  assert.deepEqual([f.started[0].member, f.started[0].taskBranch, f.started[0].task], ['debbie', 'task/t1-fix-the-login-redirect', 'Fix the login redirect\n\nIt loses ?next.']);
  // A second start names the session that holds it, and reaches no box.
  await f.server.handleLine(rpc(3, 'fleet_start', { taskId: 't1', host: 'deb132' }));
  assert.equal(isError(f), true);
  assert.match(text(f), /Held by cc-1 on deb132 since .* UTC, started by eli@example\.com\.[\s\S]*Nobody can start a session on it as it is/);
  assert.equal(f.started.length, 1);
  await f.server.handleLine(rpc(4, 'fleet_start', { taskId: 't99', host: 'deb132' }));
  assert.equal(isError(f), true);
  assert.match(text(f), /There is no task t99 that you can see/);
});

test('fleet_tasks lists what the person may see and shows one in full; fleet_task changes hands and acts', async () => {
  const f = fleet();
  await f.server.handleLine(rpc(1, 'fleet_tasks', {}));
  assert.match(text(f), /^There are no tasks you can see\. fleet_task makes one, and fleet_delegate makes one and starts it\.$/);
  await f.server.handleLine(rpc(2, 'fleet_task', { title: 'Fix the login redirect', brief: 'It loses ?next.', assignee: 'debbie', repo: 'acme/app' }));
  await f.server.handleLine(rpc(3, 'fleet_task', { title: 'Write the changelog', brief: 'For 0.5.' }));
  await f.server.handleLine(rpc(4, 'fleet_tasks', {}));
  assert.equal(text(f), 't2 [open] Write the changelog → nobody\nt1 [open] Fix the login redirect → debbie');
  // A handoff, with its note, then one task in full.
  await f.server.handleLine(rpc(5, 'fleet_task', { id: 't2', assignee: 'debbie', note: 'she wrote most of it' }));
  assert.match(text(f), /^t2 is now debbie’s\./);
  await f.server.handleLine(rpc(6, 'fleet_tasks', { id: 't2' }));
  assert.match(text(f), /^t2 \[open\] Write the changelog → debbie\nBranch task\/t2-write-the-changelog, as its sessions are told\. Nothing here checked that it exists\.\n\nBrief:\nFor 0\.5\.\n\nHandoffs:\n {2}\S+ \S+ UTC {2}created by eli@example\.com\n {2}\S+ \S+ UTC {2}assigned \(to debbie\) by eli@example\.com: she wrote most of it$/);
  await f.server.handleLine(rpc(7, 'fleet_task', { id: 't2', action: 'cancel' }));
  await f.server.handleLine(rpc(8, 'fleet_tasks', { state: 'cancelled' }));
  assert.equal(text(f), 't2 [cancelled] Write the changelog → debbie');
  // A refusal is the fleet's own sentence.
  await f.server.handleLine(rpc(9, 'fleet_task', { id: 't1', action: 'accept' }));
  assert.equal(isError(f), true);
  assert.match(text(f), /t1 is open\. Only a task that has come back can be accepted\./);
  await f.server.handleLine(rpc(10, 'fleet_task', { action: 'accept' }));
  assert.match(text(f), /`action` needs the `id`/);
});

test('fleet_delegate is offered only where fleet_start is, and a coordinator with no tasks is said to have none', async () => {
  const names = (/** @type {any} */ o) => toolsFor(o).map((t) => t.name);
  assert.ok(names({}).includes('fleet_delegate'));
  const without = names({ deny: ['start'] });
  assert.ok(!without.includes('fleet_start') && !without.includes('fleet_delegate'));
  assert.ok(without.includes('fleet_tasks') && without.includes('fleet_task'), 'the record is still readable and writable');
  assert.ok(!('host' in /** @type {any} */ (toolsFor({}).find((t) => t.name === 'fleet_delegate')).inputSchema.properties), 'the member’s own machine places it');

  /** @type {any[]} */
  const written = [];
  const old = new McpServer({ coordinator: 'https://fleet.example', credential: 'x', write: (line) => written.push(JSON.parse(line)), fetch: /** @type {any} */ (async () => ({ status: 404, json: async () => { throw new Error('html'); } })) });
  await old.handleLine(rpc(1, 'fleet_tasks', {}));
  assert.match(written[0].result.content[0].text, /This coordinator does not keep tasks yet/);
});
