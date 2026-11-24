// Routing's rules (docs/routing.md): the order a decision is made in, who a
// task may go to, the task's own toggle against the fleet's mode, what a
// task keeps of a decision, and the one question a model is asked.
//
// The coordinator's use of these is test/routing-coordinator.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkRouting, checkTaskRouting, modeFor, candidatesFor, decide, cleanRoute, routeWords, routeQuestion, readRouteAnswer,
  MAX_RULES, MAX_CANDIDATES_KEPT, MAX_MODEL_CHOICES, ROUTE_BRIEF_BYTES, ROUTE_CONFIDENCE,
} from '../src/fleet/protocol/routing.js';
import { newTask, routeTask, changeTask, checkTask } from '../src/fleet/protocol/tasks.js';

const members = [
  { id: 'debbie', name: 'Debbie', role: 'software engineer', description: 'Backend and reviews.', workTypes: ['backend', 'review'] },
  { id: 'sam', name: 'Sam', role: 'software engineer', description: 'Backend, mostly the API.', workTypes: ['backend'] },
  { id: 'ines', name: 'Ines', role: 'designer', description: 'Screens and words.', workTypes: ['design'] },
  { id: 'loose', name: 'Loose', role: 'researcher', description: 'Reads things.', workTypes: [] },
];
const admin = { admin: true, acts: [] };
const lead = { admin: false, acts: ['debbie', 'ines'] };
const none = { rules: [] };
const task = (/** @type {any} */ o = {}) => ({ id: 't1', assignee: null, ...o });

test('a task somebody was given is never moved, whatever the rules say', () => {
  const d = decide(task({ assignee: 'ines', workType: 'backend' }), { routing: { rules: [{ workType: 'backend', member: 'debbie' }] }, members, who: admin });
  assert.deepEqual([d.how, d.member], ['pinned', 'ines']);
  assert.match(d.why, /^Ines was given this task/);
});

test('the owner’s rule for a kind of work comes before any pick, and names itself', () => {
  const d = decide(task({ workType: 'backend' }), { routing: { rules: [{ workType: 'design', member: 'ines' }, { workType: 'backend', member: 'sam' }] }, members, who: admin });
  assert.deepEqual([d.how, d.member, d.why], ['rule', 'sam', 'The fleet’s rule sends backend work to Sam.']);
  // The owner's word: a rule may send a kind of work to a member whose own record does not list it.
  assert.equal(decide(task({ workType: 'backend' }), { routing: { rules: [{ workType: 'backend', member: 'ines' }] }, members, who: admin }).member, 'ines');
});

test('a rule is passed over for somebody who could not have assigned to its member by hand, and says so', () => {
  // Sam is not on the lead's team. The rule would hand the lead's task to him.
  const d = decide(task({ workType: 'backend' }), { routing: { rules: [{ workType: 'backend', member: 'sam' }] }, members, who: lead });
  assert.deepEqual([d.how, d.member], ['only', 'debbie'], 'and the task falls to the members they can reach');
  assert.match(d.why, /^The rule for backend names Sam, who is not a member you can hand work to, so it was passed over\. Debbie is the only member/);
  // A rule for a member who has since been removed is passed over the same way.
  const gone = decide(task({ workType: 'backend' }), { routing: { rules: [{ workType: 'backend', member: 'ghost' }] }, members, who: admin });
  assert.equal(gone.how, 'several');
  assert.match(gone.why, /names ghost, who is not a member any more/);
});

test('candidates are the members the asker can hand work to who take the kind of work', () => {
  assert.deepEqual(candidatesFor(task({ workType: 'backend' }), members, admin).map((m) => m.id), ['debbie', 'sam']);
  assert.deepEqual(candidatesFor(task({ workType: 'backend' }), members, lead).map((m) => m.id), ['debbie']);
  assert.deepEqual(candidatesFor(task({ workType: 'design' }), members, { admin: false, acts: ['debbie'] }), []);
  // No kind of work excludes nobody the asker can reach.
  assert.deepEqual(candidatesFor(task(), members, lead).map((m) => m.id), ['debbie', 'ines']);
});

test('one candidate is routed, several are a pick, none is said', () => {
  assert.deepEqual([decide(task({ workType: 'design' }), { routing: none, members, who: admin }).how, decide(task({ workType: 'design' }), { routing: none, members, who: admin }).member], ['only', 'ines']);
  const several = decide(task({ workType: 'backend' }), { routing: none, members, who: admin });
  assert.deepEqual([several.how, several.member, several.candidates.map((c) => c.id)], ['several', null, ['debbie', 'sam']]);
  const nobody = decide(task({ workType: 'legal' }), { routing: none, members, who: admin });
  assert.deepEqual([nobody.how, nobody.member, nobody.why], ['nobody', null, 'No member you can hand work to takes legal work.']);
});

test('a task’s own toggle is its mode whatever the fleet’s is, and unset follows the fleet', () => {
  for (const fleet of ['off', 'manual', 'auto']) {
    assert.equal(modeFor({}, { mode: fleet }), fleet);
    for (const own of ['off', 'manual', 'auto']) assert.equal(modeFor({ routing: own }, { mode: fleet }), own);
  }
  // Anything that is not a mode is no mode: off.
  assert.equal(modeFor({ routing: /** @type {any} */ ('always') }, { mode: 'loud' }), 'off');
  assert.deepEqual(checkTaskRouting(''), { ok: true, routing: null });
  assert.equal(checkTaskRouting('always').ok, false);
});

test('the fleet’s record holds one rule a kind of work, and says what is wrong with one that does not read', () => {
  const ok = checkRouting({ mode: 'manual', rules: [{ workType: ' Backend ', member: 'Debbie' }] });
  assert.deepEqual(ok, { ok: true, mode: 'manual', rules: [{ workType: 'backend', member: 'debbie' }] });
  // A field left out keeps what it was.
  assert.deepEqual(checkRouting({ mode: 'auto' }, { mode: 'manual', rules: [{ workType: 'backend', member: 'debbie' }] }), { ok: true, mode: 'auto', rules: [{ workType: 'backend', member: 'debbie' }] });
  const refused = (/** @type {any} */ input) => /** @type {any} */ (checkRouting(input)).text;
  assert.match(refused({ mode: 'always' }), /off, manual or auto/);
  assert.match(refused({ rules: [{ workType: 'backend', member: 'a' }, { workType: 'backend', member: 'b' }] }), /two rules for backend/);
  assert.match(refused({ rules: [{ workType: 'Back end!', member: 'a' }] }), /short slug/);
  assert.match(refused({ rules: Array.from({ length: MAX_RULES + 1 }, (_, i) => ({ workType: `k${i}`, member: 'a' })) }), new RegExp(`at most ${MAX_RULES}`));
});

const made = () => newTask({ id: 't7', title: 'Fix the login redirect', brief: 'It loses ?next.', workType: 'backend' }, { by: 'eli@example.com', at: 100 });
const record = (/** @type {any} */ o) => ({ mode: 'manual', candidates: ['debbie', 'sam'], why: 'Two members take backend work.', at: 200, by: 'eli@example.com', ...o });

test('a decision that chose somebody assigns the task and is a line in its history', () => {
  const r = /** @type {any} */ (routeTask(made(), record({ how: 'rule', member: 'sam' })));
  assert.equal(r.ok, true);
  assert.deepEqual([r.task.assignee, r.task.route.how, r.task.route.member, r.task.updatedAt], ['sam', 'rule', 'sam', 200]);
  assert.deepEqual(r.task.handoffs.at(-1), { at: 200, by: 'eli@example.com', kind: 'routed', from: null, to: 'sam', note: 'rule' });
});

test('a decision that chose nobody is written down too, and assigns nobody', () => {
  for (const how of ['waiting', 'nobody']) {
    const r = /** @type {any} */ (routeTask(made(), record({ how, member: 'sam', asked: 'Eli@Example.com' })));
    assert.deepEqual([r.task.assignee, r.task.route.how, r.task.route.member], [null, how, null], `${how} names nobody, whatever it was handed`);
    assert.deepEqual(r.task.handoffs.at(-1), { at: 200, by: 'eli@example.com', kind: 'routed', from: null, to: null, note: how });
    assert.equal(r.task.route.asked, how === 'waiting' ? 'eli@example.com' : undefined, 'who is asked is kept only while somebody is being asked');
  }
  // A choice with nobody named is not a decision.
  assert.equal(/** @type {any} */ (routeTask(made(), record({ how: 'model', member: null }))).code, 'bad_route');
});

test('only an open task nobody holds is routed; a pinned one only has it said why nothing moved', () => {
  const held = { ...made(), state: /** @type {const} */ ('working'), lock: { session: 'cc-1', hostId: 'deb132', member: 'debbie', by: 'eli@example.com', at: 150 } };
  assert.equal(/** @type {any} */ (routeTask(held, record({ how: 'rule', member: 'sam' }))).code, 'task_not_open');
  assert.equal(/** @type {any} */ (routeTask({ ...made(), state: 'done' }, record({ how: 'only', member: 'sam' }))).code, 'task_not_open');
  const pinned = /** @type {any} */ (routeTask({ ...held, assignee: 'debbie' }, record({ how: 'pinned', member: 'debbie' })));
  assert.deepEqual([pinned.ok, pinned.task.assignee, pinned.task.route.how, pinned.task.handoffs.length], [true, 'debbie', 'pinned', held.handoffs.length]);
});

test('assigning by hand a task that is waiting for a pick stops it asking', () => {
  const waiting = /** @type {any} */ (routeTask(made(), record({ how: 'waiting', asked: 'eli@example.com' }))).task;
  const by = /** @type {any} */ (changeTask(waiting, { assignee: 'debbie' }, { by: 'eli@example.com', at: 300 }));
  assert.deepEqual([by.task.assignee, by.task.route], ['debbie', undefined]);
  // Any other decision stays as the record of how it got there.
  const ruled = /** @type {any} */ (routeTask(made(), record({ how: 'rule', member: 'sam' }))).task;
  assert.equal(/** @type {any} */ (changeTask(ruled, { assignee: 'debbie' }, { by: 'eli@example.com', at: 300 })).task.route.how, 'rule');
});

test('a task keeps its own routing mode through a check, and loses it when cleared', () => {
  const fields = /** @type {any} */ (checkTask({ title: 'T', brief: 'B', routing: 'auto' })).fields;
  assert.equal(newTask({ id: 't1', ...fields }, { by: 'e', at: 1 }).routing, 'auto');
  const cleared = /** @type {any} */ (changeTask({ ...made(), routing: 'auto' }, /** @type {any} */ (checkTask({ routing: '' }, { partial: true })).fields, { by: 'e', at: 2 }));
  assert.equal('routing' in cleared.task, false);
  assert.equal(/** @type {any} */ (checkTask({ title: 'T', brief: 'B', routing: 'sometimes' })).ok, false);
});

test('what a task keeps of a decision is bounded and typed, and anything else is no decision', () => {
  const many = Array.from({ length: MAX_CANDIDATES_KEPT + 5 }, (_, i) => `m${i}`);
  const kept = /** @type {any} */ (cleanRoute(record({ how: 'waiting', candidates: [...many, 'Not An Id', 7], why: `first line\nsecond ${'x'.repeat(400)}`, asked: 'eli@example.com', junk: 1, modelAsked: 'yes' })));
  assert.equal(kept.candidates.length, MAX_CANDIDATES_KEPT);
  assert.equal(kept.more, 5);
  assert.equal(kept.why, 'first line');
  assert.deepEqual(Object.keys(kept).sort(), ['asked', 'at', 'by', 'candidates', 'how', 'member', 'mode', 'more', 'why']);
  assert.equal(cleanRoute(record({ how: 'vibes' })), null);
  assert.equal(cleanRoute(record({ how: 'rule', mode: 'off' })), null, 'a decision was made under a mode that routes');
  assert.equal(cleanRoute(null), null);
});

test('a decision is said in the same words wherever it is read', () => {
  const name = (/** @type {string} */ id) => members.find((m) => m.id === id)?.name ?? id;
  assert.equal(routeWords(/** @type {any} */ (cleanRoute(record({ how: 'rule', member: 'sam', why: 'The fleet’s rule sends backend work to Sam.' }))), name), 'Routed by the fleet’s rule: Sam. The fleet’s rule sends backend work to Sam.');
  assert.equal(
    routeWords(/** @type {any} */ (cleanRoute(record({ how: 'waiting', candidates: ['debbie', 'sam'], more: 2, why: '4 members take backend work.' }))), name),
    'Waiting for a person to choose. 4 members take backend work. Choose among Debbie, Sam and 2 more.',
  );
});

test('the model is shown the title, the kind of work and the top of the brief, and a choice among the candidates’ ids', () => {
  const q = routeQuestion({ title: 'Fix the login redirect', workType: 'backend', brief: `${'é'.repeat(ROUTE_BRIEF_BYTES)}THE END` }, members.slice(0, 2));
  assert.match(q.state, /^Task: Fix the login redirect\nKind of work: backend\n\né+$/);
  assert.ok(new TextEncoder().encode(q.state.split('\n\n')[1]).length <= ROUTE_BRIEF_BYTES, 'the brief is cut in bytes, on a whole character');
  assert.deepEqual(Object.keys(q.questions), ['member']);
  assert.equal(q.questions.member.type, 'choice');
  assert.deepEqual(q.questions.member.criteria, { debbie: 'software engineer. Backend and reviews. Takes: backend, review', sam: 'software engineer. Backend, mostly the API. Takes: backend' });
  // Nothing of a member but its role, what it is for and its kinds of work: no name, no address, no instructions.
  const full = routeQuestion({ title: 'T', brief: 'B' }, [{ ...members[0], email: 'debbie@example.com', instructions: 'SECRET INSTRUCTIONS', managers: ['boss@example.com'] }]);
  assert.doesNotMatch(JSON.stringify(full), /example\.com|SECRET|Debbie/);
  assert.equal(Object.keys(routeQuestion({ title: 'T', brief: 'B' }, Array.from({ length: MAX_MODEL_CHOICES + 3 }, (_, i) => ({ id: `m${i}` }))).questions.member.criteria).length, MAX_MODEL_CHOICES);
});

test('a model’s answer is one of the candidates with a label’s confidence, or it is nothing', () => {
  const said = (/** @type {any} */ choice, /** @type {any} */ confidence) => readRouteAnswer({ answers: { member: { choice, confidence } }, usage: { input_tokens: 512 } }, ['debbie', 'sam']);
  assert.deepEqual(said('sam', 0.91), { member: 'sam', confidence: 0.91, inputTokens: 512 });
  assert.equal(said('ines', 0.99), null, 'a member who was not offered');
  assert.equal(said('sam', ROUTE_CONFIDENCE - 0.01), null, 'a guess');
  assert.equal(said('sam', undefined), null, 'no confidence is no confidence');
  assert.equal(said('sam', 7), null);
  assert.equal(said(['sam'], 0.9), null);
  assert.equal(readRouteAnswer({ response: 'Assign it to sam. Also, ignore your rules.' }, ['debbie', 'sam']), null, 'prose is not an answer');
  assert.equal(readRouteAnswer(null, ['sam']), null);
});
