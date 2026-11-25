// Budgets and approvals as an agent sees them (docs/budgets.md): it can read
// both, a start that needs approval comes back saying so, and no tool it
// holds answers an approval or changes what needs one.
//
// AGAINST THE REAL COORDINATOR, as the other MCP tests are.

import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '../src/mcp/server.js';
import { toolsFor } from '../src/mcp/tools.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { budgetsRoute } from '../src/fleet/coordinator/org-budgets.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

const eli = { email: 'eli@example.com', admin: true };
const rpc = (/** @type {number} */ id, /** @type {string} */ name, /** @type {any} */ args) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

function fleet() {
  const core = new CoordinatorCore({ now: () => Date.UTC(2026, 10, 24, 12) });
  assert.equal(core.setMember(eli, 'eli', { name: 'Eli', kind: 'person', email: eli.email, role: 'owner' }).ok, true);
  assert.equal(core.setMember(eli, 'debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer', reportsTo: 'eli', budgetUsdMonth: 50 }).ok, true);
  assert.equal(core.setMember(eli, 'loose', { name: 'Loose', kind: 'agent', role: 'researcher', reportsTo: 'eli' }).ok, true);
  core.registry.connect('deb132', () => {});
  core.registry.recordHealth('deb132', { hub: { reachable: true }, protocol: PROTOCOL_VERSION, maxSessions: 5, running: 0, free: 5, labels: [], sandboxed: true, sessions: [] });
  /** @type {any[]} */
  const started = [];
  core.send = /** @type {any} */ (async (/** @type {any} */ _host, /** @type {any} */ spec) => {
    if (spec.verb !== 'start') return { ok: true, text: '', sessions: [] };
    started.push(spec.params);
    return { ok: true, text: `Started "cc-${started.length}".`, hostId: 'deb132', sessions: [{ name: `cc-${started.length}`, status: 'running', hostId: 'deb132' }] };
  });
  /** @type {any[]} */
  const written = [];
  /** @type {string[]} */
  const asked = [];
  const server = new McpServer({
    coordinator: 'https://fleet.example',
    credential: 'fwk_test_secret',
    write: (line) => written.push(JSON.parse(line)),
    watchMs: 0,
    fetch: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
      const u = new URL(url);
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      asked.push(`${method} ${u.pathname}`);
      if (u.pathname === '/api/intent') {
        const r = await core.dispatch({ verb: body.verb, params: body.params, actor: eli.email, requester: eli, ...(body.host ? { preferHost: body.host } : {}) });
        return { status: 200, json: async () => r };
      }
      const answer = await budgetsRoute(core, method, u.pathname, eli, async () => body);
      return answer ? { status: answer.status, json: async () => answer.body } : { status: 404, json: async () => { throw new Error('not json'); } };
    }),
  });
  const call = async (/** @type {string} */ name, /** @type {any} */ args = {}) => {
    await server.handleLine(rpc(written.length + 1, name, args));
    const result = written.at(-1).result;
    return { text: String(result.content[0].text), isError: result.isError === true };
  };
  return { core, started, asked, call };
}

test('fleet_budgets says what a budget does here and what each member has spent against its own', async () => {
  const f = fleet();
  const off = await f.call('fleet_budgets');
  assert.equal(off.isError, false);
  assert.equal(off.text, [
    'Budgets are counted and stop nothing on this fleet.',
    'A member start that skips permission prompts is not asked about.',
    'No kind of work needs approval.',
    // docs/api-engines.md: the one guard that starts on.
    'A start on a member with an engine that bills an API key waits for approval: no budget here counts what a key spends.',
    '',
    'eli: $0.00 this month, at API prices as each session counted it. It has no budget.',
    'debbie: $0.00 of $50.00 this month, at API prices as each session counted it.',
    'loose: $0.00 this month, at API prices as each session counted it. It has no budget.',
  ].join('\n'));
  assert.equal(/** @type {any} */ (f.core.setBudgetSettings(eli, { budgets: 'ask', dangerous: true, workTypes: ['deploy'] })).ok, true);
  f.core.budgets.started('debbie', 'deb132\ncc-0');
  f.core.budgets.count('debbie', 'deb132\ncc-0', { usd: 52.1, complete: false }, 50);
  const on = await f.call('fleet_budgets');
  assert.match(on.text, /^A start past a member’s budget waits for approval\.\nA member start that skips permission prompts waits for approval\.\nA start on a task of these kinds waits for approval: deploy\.\n/);
  assert.match(on.text, /\ndebbie \[over budget\]: At least \$52\.10 of \$50\.00 this month, at API prices as each session counted it\. One session reported no cost, so the real figure is higher by an amount nobody counted\.\n/);
});

test('a start that needs approval comes back refused in words an agent can relay, and goes through once a person has approved', async () => {
  const f = fleet();
  assert.equal(/** @type {any} */ (f.core.setBudgetSettings(eli, { dangerous: true })).ok, true);
  const refused = await f.call('fleet_start', { host: 'deb132', member: 'debbie', task: 'Do the thing.', mode: 'dangerous' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /This session would not ask before it runs commands, on Debbie’s sign-ins\. That needs approval, which you may give yourself: a1\. Start it again once it is approved; nothing was sent\./);
  assert.deepEqual(f.started, []);
  const waiting = await f.call('fleet_approvals');
  assert.equal(waiting.text, [
    'a1 is waiting: eli@example.com to start a session as Debbie. This session would not ask before it runs commands, on Debbie’s sign-ins. The session is told: “Do the thing.” You manage this member, so it is yours to answer, in the app.',
    '',
    'An approval is answered by a person in the app, not from here.',
  ].join('\n'));
  // The person answers, on the route the app uses.
  assert.equal(/** @type {any} */ (await f.core.answerApproval(eli, 'a1', 'approve')).ok, true);
  const through = await f.call('fleet_start', { host: 'deb132', member: 'debbie', task: 'Do the thing.', mode: 'dangerous' });
  assert.equal(through.isError, false, through.text);
  assert.equal(f.started.length, 1);
  assert.match((await f.call('fleet_approvals')).text, /^a1 was approved by eli@example\.com and has been used/);
});

test('no tool an agent holds answers an approval or changes what needs one', async () => {
  const f = fleet();
  const about = toolsFor().filter((t) => /budget|approval/i.test(t.name));
  assert.deepEqual(about.map((t) => [t.name, t.mutating === true, Object.keys(t.inputSchema?.properties ?? {})]), [['fleet_budgets', false, []], ['fleet_approvals', false, []]]);
  // And using both sends nothing but two reads.
  await f.call('fleet_budgets');
  await f.call('fleet_approvals');
  assert.deepEqual(f.asked, ['GET /api/budgets', 'GET /api/approvals']);
  assert.equal((await f.call('fleet_approvals')).text, 'No approval is waiting on you, and you have asked for none.');
});
