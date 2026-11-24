// Routing as an agent sees it (docs/routing.md): fleet_routing and
// fleet_set_routing, fleet_task's `route`, and fleet_delegate with nobody
// named.
//
// AGAINST THE REAL COORDINATOR, as test/tasks-mcp.test.js is: the server's
// fetch goes to the same route functions both coordinators serve. The only
// stand-in is the box.

import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '../src/mcp/server.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { tasksRoute } from '../src/fleet/coordinator/org-tasks.js';
import { routingRoute } from '../src/fleet/coordinator/org-routing.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

const eli = { email: 'eli@example.com', admin: true };
const dana = { email: 'dana@example.com', admin: false };
const rpc = (/** @type {number} */ id, /** @type {string} */ name, /** @type {any} */ args) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

/** An agent's MCP server acting as `who`, on a fleet with one box, Debbie and Sam (backend) and Ines (design). */
function fleet(/** @type {any} */ who = eli, { old = false } = {}) {
  let clock = 1_000_000;
  const core = new CoordinatorCore({ now: () => clock });
  const add = (/** @type {string} */ id, /** @type {any} */ m) => assert.equal(core.setMember(eli, id, m).ok, true, id);
  add('eli', { name: 'Eli', kind: 'person', email: eli.email, role: 'owner' });
  add('dana', { name: 'Dana', kind: 'person', email: dana.email, role: 'team lead', reportsTo: 'eli' });
  add('debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer', reportsTo: 'dana', workTypes: ['backend'] });
  add('sam', { name: 'Sam', kind: 'agent', role: 'software engineer', reportsTo: 'dana', workTypes: ['backend'] });
  add('ines', { name: 'Ines', kind: 'agent', role: 'designer', reportsTo: 'dana', workTypes: ['design'] });
  core.registry.connect('deb132', () => {});
  core.registry.recordHealth('deb132', { hub: { reachable: true }, protocol: PROTOCOL_VERSION, maxSessions: 5, running: 0, free: 5, labels: [], sandboxed: true, sessions: [] });
  /** @type {any[]} */
  const started = [];
  core.send = /** @type {any} */ (async (/** @type {any} */ _host, /** @type {any} */ spec) => {
    if (spec.verb !== 'start') return { ok: true, text: '', sessions: [] };
    started.push(spec.params);
    return { ok: true, text: 'Started "cc-1".', hostId: 'deb132', sessions: [{ name: 'cc-1', status: 'running', hostId: 'deb132' }] };
  });
  /** @type {any[]} */
  const written = [];
  const server = new McpServer({
    coordinator: 'https://fleet.example',
    credential: 'fwk_test_secret',
    write: (line) => written.push(JSON.parse(line)),
    now: () => clock,
    watchMs: 0,
    sleep: async (/** @type {number} */ ms) => {
      clock += ms;
      // The box reports the session back with a result while a tool waits.
      await core.onHostMessage('deb132', { kind: 'event', event: 'session.ready', name: 'cc-1', tasked: true, taskId: 't1', result: { text: 'DONE\nA settings screen.' } });
    },
    fetch: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
      const u = new URL(url);
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (u.pathname === '/api/intent') {
        const r = await core.dispatch({ verb: body.verb, params: body.params, actor: who.email, requester: who, ...(body.host ? { preferHost: body.host } : {}) });
        return { status: 200, json: async () => r };
      }
      // A COORDINATOR FROM BEFORE ROUTING, when `old`: it serves no routing
      // route, does not read a task's `routing`, and writes no `route`.
      if (old && body && typeof body === 'object') delete body.routing;
      const answer = (old ? null : await routingRoute(core, method, u.pathname, who, async () => body)) ?? (await tasksRoute(core, method, u.pathname, u.searchParams, who, async () => body));
      return answer ? { status: answer.status, json: async () => answer.body } : { status: 404, json: async () => { throw new Error('not json'); } };
    }),
  });
  const call = async (/** @type {string} */ name, /** @type {any} */ args = {}) => {
    await server.handleLine(rpc(written.length + 1, name, args));
    const result = written.at(-1).result;
    return { text: String(result.content[0].text), isError: result.isError === true };
  };
  return { core, started, call };
}

test('fleet_routing says the mode in words, the rules, and the order; fleet_set_routing changes it for an admin and nobody else', async () => {
  const f = fleet();
  assert.match((await f.call('fleet_routing')).text, /^Routing is off\. A task with no assignee stays with nobody, unless the task itself asks to be routed\.\nNo rules by kind of work\.\nA task somebody was given is never moved/);
  const set = await f.call('fleet_set_routing', { mode: 'auto', rules: ['backend=debbie', ' design = ines '] });
  assert.equal(set.isError, false, set.text);
  assert.match(set.text, /Routing is auto, and this fleet has no model to pick with, so a pick among several members is asked of a person\.\nRules, by kind of work:\n {2}backend → debbie\n {2}design → ines\n/);
  assert.match(set.text, /Last changed by eli@example\.com\.$/);
  assert.deepEqual(f.core.routing.record.rules, [{ workType: 'backend', member: 'debbie' }, { workType: 'design', member: 'ines' }]);
  // What does not read as a rule is refused here, by name, before anything is sent.
  const bad = await f.call('fleet_set_routing', { rules: ['backend:debbie'] });
  assert.deepEqual([bad.isError, bad.text], [true, '“backend:debbie” is not a rule. Write each as "kind-of-work=member-id", like "backend=debbie".']);
  assert.equal((await f.call('fleet_set_routing', {})).isError, true);
  // The fleet's own refusals come back as its words.
  assert.match((await f.call('fleet_set_routing', { rules: ['backend=ghost'] })).text, /there is no member called that/);
  const lead = fleet(dana);
  const refused = await lead.call('fleet_set_routing', { mode: 'manual' });
  assert.deepEqual([refused.isError, refused.text], [true, 'The fleet’s routing is set by an admin. Anybody can read it.']);
});

test('fleet_task routes an unassigned task, says a person is being asked, and takes the answer', async () => {
  const f = fleet();
  await f.call('fleet_set_routing', { mode: 'manual' });
  const made = await f.call('fleet_task', { title: 'Fix the login redirect', brief: 'It loses ?next.', workType: 'backend' });
  assert.equal(made.isError, false, made.text);
  assert.match(made.text, /Waiting for a person to choose\. 2 members take backend work\. Choose among Debbie, Sam\./);
  assert.match(made.text, /\nRouting: Waiting for a person to choose\. 2 members take backend work\. Choose among debbie, sam\.$/m);
  const answered = await f.call('fleet_task', { id: 't1', action: 'route', assignee: 'sam' });
  assert.equal(answered.isError, false, answered.text);
  assert.match(answered.text, /^Chosen by a person: Sam\. eli@example\.com chose Sam\.\n\nt1 \[open\] Fix the login redirect → sam/);
  // Asked again, it has its member, and the fleet says routing does not move it.
  const again = await f.call('fleet_task', { id: 't1', action: 'route' });
  assert.deepEqual([again.isError, /routing never moves a task somebody was given/.test(again.text)], [true, true]);
  // A task's own mode is sent with it, on a fleet that is off.
  const off = fleet();
  const marked = await off.call('fleet_task', { title: 'A screen', brief: 'B', workType: 'design', routing: 'manual' });
  assert.match(marked.text, /Routed to the only member who takes it: Ines\./);
  assert.match(marked.text, /\(this task’s own mode is manual\)/);
});

test('fleet_delegate with nobody named starts the member routing chose, and says routing chose', async () => {
  const f = fleet();
  await f.call('fleet_set_routing', { mode: 'manual', rules: ['design=ines'] });
  const r = await f.call('fleet_delegate', { title: 'A settings screen', brief: 'Draw it.', workType: 'design' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Handed t1 to ines, chosen by routing \(rule\): cc-1 on deb132\.\n\nt1 “A settings screen”, worked on by ines: DONE\./);
  assert.deepEqual(f.started.map((p) => [p.member, p.taskId]), [['ines', 't1']]);
});

test('fleet_delegate on a coordinator from before routing says the mode was not taken, and does not tell an agent to pass what it passed', async () => {
  const f = fleet(eli, { old: true });
  const r = await f.call('fleet_delegate', { title: 'Fix it', brief: 'Do the thing.', workType: 'backend', routing: 'manual' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Nothing was started: this fleet did not take `routing: "manual"` for the task, so its coordinator is from before routing and chose nobody\. Name a member with `to`, or give t1 to one with fleet_task\.$/);
  assert.doesNotMatch(r.text, /pass `routing/);
  assert.deepEqual(f.started, []);
});

test('fleet_delegate starts nothing when routing chose nobody, and says which of the three reasons it was', async () => {
  const f = fleet();
  // Routing off: nobody was chosen, and how to get somebody chosen.
  const off = await f.call('fleet_delegate', { title: 'Fix it', brief: 'Do the thing.', workType: 'backend' });
  assert.equal(off.isError, true);
  assert.match(off.text, /Nothing was started: the fleet’s routing is off, so no member was chosen\. Name one with `to`, pass `routing: "manual"` for this task, or give t1 to a member with fleet_task\.$/);
  // A person is being asked.
  const waiting = await f.call('fleet_delegate', { title: 'Fix it', brief: 'Do the thing.', workType: 'backend', routing: 'manual' });
  assert.equal(waiting.isError, true);
  assert.match(waiting.text, /Waiting for a person to choose\. 2 members take backend work\. Choose among Debbie, Sam\.\n\nNothing was started\. When somebody has chosen .* start it with fleet_start and `taskId: "t2"`\.$/);
  // No member takes it.
  const nobody = await f.call('fleet_delegate', { title: 'Read the contract', brief: 'And say what it binds us to.', workType: 'legal', routing: 'manual' });
  assert.equal(nobody.isError, true);
  assert.match(nobody.text, /No member you can hand work to takes legal work\.\n\nNothing was started\. Give it to a member with fleet_task and `assignee`, or cancel it\.$/);
  assert.deepEqual(f.started, []);
  // A member named is a member named: `routing` is not sent and nothing second-guesses it.
  const named = await f.call('fleet_delegate', { to: 'debbie', title: 'Fix it', brief: 'Do the thing.', workType: 'design', routing: 'manual' });
  assert.match(named.text, /^Handed t4 to debbie: cc-1 on deb132\./);
  assert.equal(f.core.tasks.get('t4')?.routing, undefined);
});
