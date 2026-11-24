// Engines in the coordinator (docs/engines.md): the list a member's start
// carries to a machine, the refusals when a machine cannot run it as the
// record says, and what a box's word about an engine handing on writes on
// the task.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { wordsFor } from '../src/fleet/protocol/tasks.js';

const eli = { email: 'eli@example.com', admin: true };

/** A fleet with the boxes given, each speaking a protocol and reporting engines, and the agent Debbie. */
function fleet(/** @type {Array<[string, number, string[]|undefined]>} */ boxes, /** @type {any} */ engines) {
  const core = new CoordinatorCore({});
  assert.equal(core.setMember(eli, 'eli', { name: 'Eli', kind: 'person', email: eli.email, role: 'owner' }).ok, true);
  const debbie = core.setMember(eli, 'debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer', reportsTo: 'eli', ...(engines ? { engines } : {}) });
  assert.equal(debbie.ok, true, /** @type {any} */ (debbie).text);
  for (const [hostId, protocol, runs] of boxes) {
    core.registry.connect(hostId, () => {});
    core.registry.recordHealth(hostId, { hub: { reachable: true }, protocol, maxSessions: 5, running: 0, free: 5, labels: [], sandboxed: true, sessions: [], ...(runs ? { engines: runs } : {}) });
  }
  /** @type {Array<{ hostId: string, params: any }>} */
  const sent = [];
  core.send = /** @type {any} */ (async (/** @type {any} */ host, /** @type {any} */ spec) => {
    sent.push({ hostId: host.hostId, params: spec.params });
    return { ok: true, text: 'Started "cc-1".', sessions: [{ name: 'cc-1', status: 'running' }] };
  });
  const start = (/** @type {string} */ host, /** @type {any} */ params = {}) => core.dispatch({ verb: 'start', params: { member: 'debbie', task: 'Fix it.', ...params }, actor: eli.email, requester: eli, preferHost: host });
  return { core, sent, start };
}
const three = [{ engine: 'claude-code' }, { engine: 'codex', model: 'gpt-5.1-codex' }, { engine: 'opencode', model: 'github-copilot/gpt-5' }];

test('a start carries the member’s engines in order, written by the fleet, cut to what the machine runs, and says what was left out', async () => {
  const { sent, start } = fleet([['all', PROTOCOL_VERSION, ['claude-code', 'codex', 'opencode']], ['some', PROTOCOL_VERSION, ['claude-code', 'codex']]], three);
  const whole = await start('all', { memberEngines: 'opencode=github-copilot/whatever-the-caller-likes' });
  assert.equal(whole.ok, true, whole.text);
  assert.equal(sent[0].params.memberEngines, 'claude-code,codex=gpt-5.1-codex,opencode=github-copilot/gpt-5', 'the record’s, whatever a caller sent');
  assert.doesNotMatch(String(whole.text), /does not run/);
  const cut = await start('some');
  assert.equal(sent[1].params.memberEngines, 'claude-code,codex=gpt-5.1-codex');
  assert.match(String(cut.text), /some does not run opencode, so Debbie has fewer engines to fall back to there: Claude Code, then Codex \(gpt-5\.1-codex\)\./);
});

test('a machine that runs none of a member’s engines is refused, naming both lists', async () => {
  const { sent, start } = fleet([['plain', PROTOCOL_VERSION, ['claude-code']]], [{ engine: 'codex' }]);
  const r = await start('plain');
  assert.equal(r.error?.code, 'no_engine');
  assert.match(String(r.text), /^Debbie runs on Codex, and plain runs claude-code\. Start it on a machine that runs one of its engines/);
  assert.deepEqual(sent, []);
});

test('a host older than protocol 21 is sent a member who is Claude Code alone as before, and refused any other', async () => {
  // Claude Code, no model: exactly what a host from before engines runs.
  const plain = fleet([['box-20', 20, undefined]], null);
  assert.equal((await plain.start('box-20')).ok, true);
  assert.equal(plain.sent[0].params.memberEngines, undefined);
  // Any other list would be dropped there and the session run on Claude regardless.
  for (const engines of [three, [{ engine: 'claude-code', model: 'opus' }], [{ engine: 'codex' }]]) {
    const { sent, start } = fleet([['box-20', 20, undefined]], engines);
    const r = await start('box-20');
    assert.equal(r.error?.code, 'host_outdated', JSON.stringify(engines));
    assert.match(String(r.text), /box-20 is too old to run Debbie as its record says .* speaks protocol 20, and this needs 21\./);
    assert.deepEqual(sent, []);
  }
  // A current host that reports no engines runs Claude Code alone, and is told the list cut to that.
  const silent = fleet([['quiet', PROTOCOL_VERSION, undefined]], three);
  assert.equal((await silent.start('quiet')).ok, true);
  assert.equal(silent.sent[0].params.memberEngines, 'claude-code');
});

test('a start as nobody carries no engines, whatever was sent', async () => {
  const { core, sent } = fleet([['all', PROTOCOL_VERSION, ['claude-code', 'codex']]], three);
  const r = await core.dispatch({ verb: 'start', params: { task: 'Just me.', memberEngines: 'codex' }, actor: eli.email, requester: eli, preferHost: 'all' });
  assert.equal(r.ok, true, r.text);
  assert.equal(sent[0].params.memberEngines, undefined);
});

/** A task for Debbie, started on the box, with the session the box named holding its lock. */
async function working(/** @type {ReturnType<typeof fleet>} */ f) {
  const made = /** @type {any} */ (f.core.createTask(eli, { title: 'Fix the login redirect', brief: 'It loses ?next.', assignee: 'debbie' }));
  const r = await f.start('all', { ...made.start, task: wordsFor(made.task) });
  assert.equal(r.ok, true, r.text);
  return (/** @type {any} */ event) => f.core.onHostMessage('all', { kind: 'event', name: 'cc-1', taskId: 't1', ...event });
}

test('an engine handing on is written on the task as a change of hands, and said in words in the feed', async () => {
  const f = fleet([['all', PROTOCOL_VERSION, ['claude-code', 'codex']]], three);
  const says = await working(f);
  await says({ event: 'session.engine', from: 'claude-code', to: 'codex', reason: 'limit', text: 'whatever the box wrote' });
  const task = /** @type {any} */ (f.core.tasks.get('t1'));
  assert.deepEqual(task.handoffs.at(-1), { at: task.updatedAt, by: 'debbie', kind: 'engine', from: 'claude-code', to: 'codex', session: 'cc-1', hostId: 'all', note: 'limit' });
  assert.deepEqual([task.state, task.lock.session], ['working', 'cc-1'], 'the same session still holds it');
  const event = f.core.recentEvents(null).find((/** @type {any} */ e) => e.event === 'session.engine');
  assert.equal(event?.text, 'Claude Code stopped at its account’s limit. Continuing on Codex, from a handoff note in the workspace.');
  // Engine names the fleet does not know are not an event, and not the session's own to invent.
  await says({ event: 'session.engine', from: 'claude-code', to: 'gemini', reason: 'limit' });
  await f.core.onHostMessage('all', { kind: 'event', event: 'session.engine', name: 'cc-other', taskId: 't1', from: 'codex', to: 'opencode', reason: 'limit' });
  assert.equal(/** @type {any} */ (f.core.tasks.get('t1')).handoffs.filter((/** @type {any} */ h) => h.kind === 'engine').length, 1);
});

test('a task whose session stopped at a limit with nothing left says so, and is working again once an engine takes over', async () => {
  const f = fleet([['all', PROTOCOL_VERSION, ['claude-code', 'codex']]], three);
  const says = await working(f);
  const limit = { engine: 'codex', reason: 'limit', detail: 'usage limit', model: null, usage: null, resetsAt: Date.UTC(2026, 10, 24, 18, 30) };
  await says({ event: 'session.ready', tasked: true, turn: limit });
  const task = /** @type {any} */ (f.core.tasks.get('t1'));
  assert.equal(task.state, 'working', 'no result came back, so it has not returned');
  assert.deepEqual(task.lock.stopped, { engine: 'codex', reason: 'limit', resetsAt: limit.resetsAt });
  assert.match(JSON.stringify(f.core.recentEvents(null)), /is back at its prompt and wrote no result for t1: Codex stopped at its account’s limit\. It says the limit lifts at 2026-11-24 18:30 UTC\./);
  // A turn that simply ended, with no result, says nothing of an engine.
  await says({ event: 'session.engine', from: 'codex', to: 'opencode', reason: 'limit' });
  const after = /** @type {any} */ (f.core.tasks.get('t1'));
  assert.deepEqual([after.lock.stopped, after.lock.readyAt], [undefined, undefined]);
});
