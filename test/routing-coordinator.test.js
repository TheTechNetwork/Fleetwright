// Routing in the coordinator (docs/routing.md): who may set it, a task routed
// as it is made, the model's pick behind its walls, the person asked and
// their answer, the routes, and the Durable Object's row.
//
// The rules themselves are test/routing.test.js. The model here is a
// stand-in function: nothing in this file calls one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { OrgMembers } from '../src/fleet/coordinator/org-members.js';
import { tasksRoute } from '../src/fleet/coordinator/org-tasks.js';
import { routingRoute } from '../src/fleet/coordinator/org-routing.js';
import { ROUTE_ASKS_PER_DAY, MAX_MODEL_CHOICES } from '../src/fleet/protocol/routing.js';
import { Fleet } from '../worker/src/fleet-do.js';

const admin = { email: 'eli@example.com', admin: true };
const dana = { email: 'dana@example.com', admin: false };

/**
 * Eli; Dana under Eli; under Dana the agents Debbie (backend, review) and
 * Ines (design); and Sam (backend) under nobody, outside Dana's reach.
 */
function org(/** @type {() => number} */ now) {
  const o = new OrgMembers({ now });
  const add = (/** @type {string} */ id, /** @type {any} */ m) => assert.equal(o.set(admin, id, m).ok, true, id);
  add('eli', { name: 'Eli', kind: 'person', email: admin.email, role: 'owner' });
  add('dana', { name: 'Dana', kind: 'person', email: dana.email, role: 'team lead', reportsTo: 'eli' });
  add('debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer', description: 'Backend and reviews.', reportsTo: 'dana', workTypes: ['backend', 'review'] });
  add('ines', { name: 'Ines', kind: 'agent', role: 'designer', description: 'Screens and words.', reportsTo: 'dana', workTypes: ['design'] });
  add('sam', { name: 'Sam', kind: 'agent', role: 'software engineer', description: 'Backend, mostly the API.', workTypes: ['backend'] });
  return o;
}

/**
 * A coordinator with that org and, when `model` is given, a decision model
 * and a routing model that answer with it. `asked` is every question that
 * reached the model; `pushes` every notification sent.
 */
function fleet(/** @type {{ model?: (q: any) => any, budget?: number, rateLimit?: () => Promise<boolean> }} */ { model, budget, rateLimit } = {}) {
  let clock = Date.UTC(2026, 10, 24, 12);
  /** @type {any[]} */
  const asked = [];
  /** @type {any[]} */
  const pushes = [];
  const core = new CoordinatorCore({
    now: () => clock,
    push: /** @type {any} */ ({ send: async (/** @type {any} */ devices, /** @type {any} */ message) => void pushes.push({ to: devices.map((/** @type {any} */ d) => d.actor), ...message }) }),
    ...(model
      ? {
          decide: { ask: async () => null, rateLimit: rateLimit ?? (async () => true), ...(budget === undefined ? {} : { budget }) },
          route: { pick: async (/** @type {any} */ q) => { asked.push(q); return model(q); } },
        }
      : {}),
  });
  core.org = org(() => clock);
  // Each person's own phone.
  for (const who of [admin, dana]) core.devices.set(`dev-${who.email}`, { token: `t-${who.email}`, platform: 'ios', actor: `fleet:${who.email}`, clientId: `c-${who.email}` });
  core.clients.clients.set(`c-${admin.email}`, /** @type {any} */ ({ id: `c-${admin.email}`, admin: true }));
  core.clients.clients.set(`c-${dana.email}`, /** @type {any} */ ({ id: `c-${dana.email}`, admin: false }));
  const set = (/** @type {any} */ routing) => assert.equal(/** @type {any} */ (core.setRouting(admin, routing)).ok, true);
  /** Make a task as the routes do: through `tasksRoute`, so a pending pick is waited for. */
  const make = async (/** @type {any} */ who, /** @type {any} */ o = {}) =>
    /** @type {any} */ (await tasksRoute(core, 'POST', '/api/tasks', null, who, async () => ({ title: 'Fix the login redirect', brief: 'It loses ?next. Fix it in app/auth.', ...o }))).body;
  const answerWith = (/** @type {string} */ choice, confidence = 0.9) => ({ answers: { member: { choice, confidence } }, usage: { input_tokens: 600 } });
  return { core, asked, pushes, set, make, answerWith, tick: (/** @type {number} */ ms) => { clock += ms; } };
}

test('routing is off until an admin sets it: a task with nobody stays with nobody and nothing is written', async () => {
  const { core, make, pushes } = fleet({ model: () => { throw new Error('the model must not be asked'); } });
  assert.deepEqual(/** @type {any} */ (core.routingFor(dana)), { ok: true, routing: { mode: 'off', rules: [], updatedBy: null, updatedAt: 0 }, model: true, you: { admin: false } });
  const made = await make(dana, { workType: 'backend' });
  assert.deepEqual([made.ok, made.task.assignee, made.task.route, made.task.handoffs.length], [true, null, undefined, 1]);
  assert.match(made.text, /assigned to nobody yet/);
  assert.deepEqual(pushes, []);
  // And asking for it is refused in words that say how to turn it on for one task.
  const asked = /** @type {any} */ (await core.routeTask(dana, 't1'));
  assert.equal(asked.error.code, 'routing_off');
  assert.match(asked.text, /Set the task’s routing to manual or auto, or assign it by hand/);
});

test('only an admin sets the fleet’s routing, a rule names a member the fleet has, and the feed says who changed it', () => {
  const { core } = fleet();
  assert.equal(/** @type {any} */ (core.setRouting(dana, { mode: 'manual' })).error.code, 'not_admin');
  assert.equal(/** @type {any} */ (core.setRouting(admin, { mode: 'manual', rules: [{ workType: 'backend', member: 'ghost' }] })).error.code, 'no_member');
  const saved = /** @type {any} */ (core.setRouting(admin, { mode: 'manual', rules: [{ workType: 'backend', member: 'sam' }] }));
  assert.deepEqual([saved.ok, saved.routing.mode, saved.routing.rules, saved.routing.updatedBy], [true, 'manual', [{ workType: 'backend', member: 'sam' }], admin.email]);
  // A change of mode alone keeps the rules.
  assert.deepEqual(/** @type {any} */ (core.setRouting(admin, { mode: 'auto' })).routing.rules, [{ workType: 'backend', member: 'sam' }]);
  assert.ok(core.recentEvents(admin).some((/** @type {any} */ e) => e.event === 'routing.changed' && /eli@example\.com set the fleet’s routing/.test(e.text)));
});

test('a task made with nobody is routed as it is made: by the rule, by the only member, or to nobody, and says which', async () => {
  const { core, make, set } = fleet();
  set({ mode: 'manual', rules: [{ workType: 'backend', member: 'sam' }] });
  const ruled = await make(admin, { workType: 'backend' });
  assert.deepEqual([ruled.task.assignee, ruled.task.route.how, ruled.start.member], ['sam', 'rule', 'sam'], 'and what to sign names the member routing chose');
  assert.match(ruled.text, /^Made t1\. Its branch is task\/t1-fix-the-login-redirect\. Routed by the fleet’s rule: Sam\. The fleet’s rule sends backend work to Sam\.$/);
  const only = await make(admin, { workType: 'design' });
  assert.deepEqual([only.task.assignee, only.task.route.how], ['ines', 'only']);
  const nobody = await make(admin, { workType: 'legal' });
  assert.deepEqual([nobody.task.assignee, nobody.task.route.how, nobody.start], [null, 'nobody', null]);
  assert.match(nobody.text, /No member takes this kind of work\. No member you can hand work to takes legal work\./);
  // A task somebody was given says it was, and is not moved by a rule for its kind.
  const pinned = await make(admin, { workType: 'backend', assignee: 'debbie' });
  assert.deepEqual([pinned.task.assignee, pinned.task.route.how, pinned.task.handoffs.length], ['debbie', 'pinned', 1]);
  assert.equal(/** @type {any} */ (await core.routeTask(admin, 't4')).error.code, 'task_pinned');
  assert.deepEqual(core.recentEvents(admin).filter((/** @type {any} */ e) => e.event === 'task.routed').map((/** @type {any} */ e) => e.text.slice(0, 2)), ['t1', 't2']);
});

test('the rule does not hand a team lead’s task to a member outside their team', async () => {
  const { make, set } = fleet();
  set({ mode: 'manual', rules: [{ workType: 'backend', member: 'sam' }] });
  const made = await make(dana, { workType: 'backend' });
  assert.deepEqual([made.task.assignee, made.task.route.how], ['debbie', 'only']);
  assert.match(made.task.route.why, /The rule for backend names Sam, who is not a member you can hand work to, so it was passed over/);
});

test('in manual, several candidates are a question to the person who asked: on the task, in the feed and on their own phone', async () => {
  const { core, make, set, pushes } = fleet({ model: () => { throw new Error('manual never asks the model'); } });
  set({ mode: 'manual' });
  const made = await make(admin, { workType: 'backend' });
  assert.deepEqual([made.task.assignee, made.task.route.how, made.task.route.candidates, made.task.route.asked], [null, 'waiting', ['debbie', 'sam'], admin.email]);
  assert.equal(made.text, 'Made t1. Its branch is task/t1-fix-the-login-redirect. Waiting for a person to choose. 2 members take backend work. Choose among Debbie, Sam.');
  assert.deepEqual(pushes, [{ to: [`fleet:${admin.email}`], title: 't1 needs a member', body: '“Fix the login redirect”. Choose among Debbie, Sam.', data: { event: 'task.needs-member', kind: 'task', name: '', hostId: '', url: '', taskId: 't1' } }]);
  assert.ok(core.recentEvents(admin).some((/** @type {any} */ e) => e.event === 'task.needs-member'));
  // A second task inside the minute is on its page and in the feed, and the phone is not told again.
  await make(admin, { workType: 'backend', title: 'Another' });
  assert.equal(pushes.length, 1);
});

test('their answer is an assignment by hand, checked as one, and written as the answer', async () => {
  const { core, make, set } = fleet();
  set({ mode: 'manual' });
  await make(dana, { workType: 'review', title: 'Review the migration' });
  await make(admin, { workType: 'backend' });
  // Dana's task had one candidate; the admin's has two and waits.
  assert.equal(/** @type {any} */ (await core.routeTask(dana, 't2', { member: 'debbie' })).error.code, 'no_task', 'a task she cannot see');
  const refused = /** @type {any} */ (await core.routeTask(admin, 't2', { member: 'ghost' }));
  assert.equal(refused.error.code, 'no_member');
  const chose = /** @type {any} */ (await core.routeTask(admin, 't2', { member: 'Sam' }));
  assert.deepEqual([chose.ok, chose.task.assignee, chose.task.route.how, chose.task.route.candidates, chose.start.member], [true, 'sam', 'person', ['debbie', 'sam'], 'sam']);
  assert.equal(chose.text, 'Chosen by a person: Sam. eli@example.com chose Sam.');
  assert.deepEqual(chose.task.handoffs.map((/** @type {any} */ h) => [h.kind, h.to, h.note]).slice(1), [['routed', null, 'waiting'], ['routed', 'sam', 'person']]);
});

test('in auto, the model picks among the candidates and the task says the pick was the model’s', async () => {
  const f = fleet({ model: (q) => f.answerWith(Object.keys(q.questions.member.criteria)[1], 0.86) });
  f.set({ mode: 'auto' });
  const made = await f.make(admin, { workType: 'backend' });
  assert.deepEqual([made.task.assignee, made.task.route.how, made.task.route.modelAsked], ['sam', 'model', true]);
  assert.equal(made.task.route.why, '2 members take backend work. The fleet’s model chose Sam, with confidence 0.86.');
  assert.match(made.text, /Routed by the fleet’s model: Sam\./);
  // What reached the model: the title, the kind, the brief, and the two members by id.
  assert.equal(f.asked.length, 1);
  assert.equal(f.asked[0].state, 'Task: Fix the login redirect\nKind of work: backend\n\nIt loses ?next. Fix it in app/auth.');
  assert.deepEqual(Object.keys(f.asked[0].questions.member.criteria), ['debbie', 'sam']);
  assert.doesNotMatch(JSON.stringify(f.asked[0]), /example\.com/);
  assert.deepEqual(f.pushes, [], 'nobody is asked when the model answered');
});

test('a model’s answer that is not one of the candidates, or is a guess, is no answer: a person is asked, and the model is not asked about that task again', async () => {
  for (const [what, answer] of /** @type {Array<[string, any]>} */ ([
    ['a member who was not offered', { answers: { member: { choice: 'ines', confidence: 0.99 } } }],
    ['a guess', { answers: { member: { choice: 'sam', confidence: 0.4 } } }],
    ['prose', { response: 'Assign it to sam.' }],
  ])) {
    const f = fleet({ model: () => answer });
    f.set({ mode: 'auto' });
    const made = await f.make(admin, { workType: 'backend' });
    assert.deepEqual([made.task.assignee, made.task.route.how, made.task.route.modelAsked], [null, 'waiting', true], what);
    assert.match(made.task.route.why, /The fleet’s model was asked and did not name one of them with enough confidence\.$/, what);
    assert.equal(f.pushes.length, 1, what);
    // Routed again by hand, the same task is a person's: the model had its one ask.
    const again = /** @type {any} */ (await f.core.routeTask(admin, 't1'));
    assert.equal(again.task.route.how, 'waiting', what);
    assert.match(again.task.route.why, /The fleet’s model was already asked about this task once\./, what);
    assert.equal(f.asked.length, 1, what);
  }
});

test('a model that throws or never answers is a person’s pick, and is charged for', async () => {
  const f = fleet({ model: () => { throw new Error('upstream'); } });
  f.set({ mode: 'auto' });
  const made = await f.make(admin, { workType: 'backend' });
  assert.deepEqual([made.task.route.how, made.task.route.modelAsked], ['waiting', true]);
  assert.equal(f.core.decideLimits.snapshot().calls, 1);
});

test('the walls in front of the model each stop the ask, say why on the task, and leave it a person’s', async () => {
  // A brief that reads as holding a credential is not sent, and not cleaned and sent.
  const secret = fleet({ model: () => { throw new Error('must not be sent'); } });
  secret.set({ mode: 'auto' });
  const held = await secret.make(admin, { workType: 'backend', brief: 'Use the deploy key ghp_0123456789abcdefghijklmnopqrstuvwxyzAB to push.' });
  assert.deepEqual([held.task.route.how, held.task.route.modelAsked], ['waiting', undefined]);
  assert.match(held.task.route.why, /reads as holding a credential, so it was not sent to the model/);
  assert.equal(secret.asked.length, 0);

  // The day's budget on the decision model is the routing model's too.
  const broke = fleet({ model: () => { throw new Error('must not be sent'); }, budget: 0 });
  broke.set({ mode: 'auto' });
  assert.match((await broke.make(admin, { workType: 'backend' })).task.route.why, /The model’s budget for the day is spent\./);

  // The platform's rate limit is asked, and a no is a no.
  const limited = fleet({ model: () => { throw new Error('must not be sent'); }, rateLimit: async () => false });
  limited.set({ mode: 'auto' });
  assert.match((await limited.make(admin, { workType: 'backend' })).task.route.why, /The model is being asked too often just now\./);

  // More members than a model is given to choose among.
  const crowd = fleet({ model: () => { throw new Error('must not be sent'); } });
  for (let i = 0; i <= MAX_MODEL_CHOICES; i++) assert.equal(crowd.core.org.set(admin, `w${i}`, { name: `W${i}`, kind: 'agent', role: 'writer', workTypes: ['docs'] }).ok, true);
  crowd.set({ mode: 'auto' });
  const many = await crowd.make(admin, { workType: 'docs' });
  assert.match(many.task.route.why, new RegExp(`A model is given at most ${MAX_MODEL_CHOICES} members to choose among\\.`));
  assert.equal(many.task.route.more, 1);
});

test('at most fifty routing asks a day reach the model, and the count starts again at midnight UTC', async () => {
  const f = fleet({ model: (q) => f.answerWith(Object.keys(q.questions.member.criteria)[0]), budget: 100_000 });
  f.set({ mode: 'auto' });
  for (let i = 0; i < ROUTE_ASKS_PER_DAY; i++) assert.equal((await f.make(admin, { workType: 'backend', title: `Job ${i}` })).task.route.how, 'model', `ask ${i}`);
  const over = await f.make(admin, { workType: 'backend', title: 'One too many' });
  assert.equal(over.task.route.how, 'waiting');
  assert.match(over.task.route.why, /The day’s routing asks to the model are spent\./);
  assert.equal(f.asked.length, ROUTE_ASKS_PER_DAY);
  f.tick(13 * 60 * 60_000);
  assert.equal((await f.make(admin, { workType: 'backend', title: 'Tomorrow' })).task.route.how, 'model');
});

test('auto with no model on the fleet asks a person and says that is why', async () => {
  const { core, make, set } = fleet();
  set({ mode: 'auto' });
  assert.equal(/** @type {any} */ (core.routingFor(admin)).model, false);
  const made = await make(admin, { workType: 'backend' });
  assert.deepEqual([made.task.route.how, made.task.route.mode], ['waiting', 'auto']);
  assert.match(made.task.route.why, /The fleet has no model to pick with\./);
});

test('a task’s own toggle routes it on a fleet that is off, and leaves it alone on a fleet that is on', async () => {
  const off = fleet();
  const marked = await off.make(admin, { workType: 'design', routing: 'manual' });
  assert.deepEqual([marked.task.routing, marked.task.assignee, marked.task.route.how], ['manual', 'ines', 'only']);
  const on = fleet();
  on.set({ mode: 'manual' });
  const left = await on.make(admin, { workType: 'design', routing: 'off' });
  assert.deepEqual([left.task.assignee, left.task.route], [null, undefined]);
  // Turned on afterwards and asked for, it routes.
  assert.equal(/** @type {any} */ (on.core.changeTask(admin, 't1', { routing: '' })).ok, true);
  assert.equal(/** @type {any} */ (await on.core.routeTask(admin, 't1')).task.assignee, 'ines');
});

test('a task being worked on, or finished, is not routed', async () => {
  const { core, make, set } = fleet();
  set({ mode: 'manual' });
  await make(admin, { workType: 'legal' });
  assert.equal(/** @type {any} */ (core.actOnTask(admin, 't1', 'cancel', '')).ok, true);
  assert.equal(/** @type {any} */ (await core.routeTask(admin, 't1')).error.code, 'task_not_open');
  assert.equal(/** @type {any} */ (await core.routeTask(admin, 't1', { member: 'sam' })).error.code, 'task_not_open');
});

test('the routes: everybody reads the setting, an admin writes it, and a task is routed or answered by POST', async () => {
  const { core, set } = fleet();
  const routing = async (/** @type {string} */ method, /** @type {any} */ who, /** @type {any} */ body) => /** @type {any} */ (await routingRoute(core, method, '/api/routing', who, async () => body));
  assert.deepEqual([(await routing('GET', dana)).status, (await routing('GET', dana)).body.you.admin], [200, false]);
  assert.equal((await routing('PUT', dana, { mode: 'manual' })).status, 403);
  assert.equal((await routing('PUT', admin, { mode: 'sometimes' })).status, 400);
  assert.equal((await routing('PUT', admin, { rules: [{ workType: 'backend', member: 'ghost' }] })).status, 404);
  assert.equal((await routing('PUT', admin, { mode: 'manual' })).status, 200);
  assert.equal((await routing('DELETE', admin)).status, 405);
  assert.equal(await routingRoute(core, 'GET', '/api/routing/extra', admin, async () => ({})), null);
  set({ mode: 'manual' });
  const call = async (/** @type {string} */ path, /** @type {any} */ who, /** @type {any} */ body) => /** @type {any} */ (await tasksRoute(core, 'POST', path, null, who, async () => body));
  assert.equal((await call('/api/tasks', admin, { title: 'T', brief: 'B', workType: 'backend' })).body.task.route.how, 'waiting');
  assert.equal((await call('/api/tasks/t1/route', dana, {})).status, 404);
  const answered = await call('/api/tasks/t1/route', admin, { member: 'debbie' });
  assert.deepEqual([answered.status, answered.body.task.assignee], [200, 'debbie']);
  assert.equal((await call('/api/tasks/t1/route', admin, {})).status, 409, 'it has its member now');
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

test('the setting and a task’s routing survive the Durable Object being rebuilt, and a Worker with no switch has no model', async () => {
  const state = fakeState();
  const first = new Fleet(/** @type {any} */ (state), {});
  await settle();
  assert.equal(first.core.org.set(admin, 'ines', { name: 'Ines', kind: 'agent', role: 'designer', workTypes: ['design'] }).ok, true);
  assert.equal(/** @type {any} */ (first.core.setRouting(admin, { mode: 'manual', rules: [{ workType: 'design', member: 'ines' }] })).ok, true);
  assert.equal(/** @type {any} */ (first.core.createTask(admin, { title: 'A screen', brief: 'B', workType: 'design', routing: 'auto' })).task.assignee, 'ines');
  await settle();
  assert.deepEqual([state.rows.get('routing').mode, state.rows.get('routing').rules], ['manual', [{ workType: 'design', member: 'ines' }]]);
  const revived = new Fleet(/** @type {any} */ (state), {});
  await settle();
  const back = /** @type {any} */ (revived.core.routingFor(admin));
  assert.deepEqual([back.routing.mode, back.routing.rules, back.routing.updatedBy, back.model], ['manual', [{ workType: 'design', member: 'ines' }], admin.email, false]);
  const task = /** @type {any} */ (revived.core.taskFor(admin, 't1')).task;
  assert.deepEqual([task.routing, task.route.how, task.route.member], ['auto', 'rule', 'ines']);
  // A row somebody else wrote is a fleet that set nothing.
  state.rows.set('routing', { mode: 'always', rules: 'everyone' });
  const strange = new Fleet(/** @type {any} */ (state), {});
  await settle();
  assert.equal(/** @type {any} */ (strange.core.routingFor(admin)).routing.mode, 'off');
});

test('the Worker turns the model’s pick on only with its own switch on top of everything the decision model needs', async () => {
  const ai = { run: async () => ({ answers: { member: { choice: 'x', confidence: 1 } } }) };
  const limit = { limit: async () => ({ success: true }) };
  const has = async (/** @type {any} */ env) => {
    const f = new Fleet(/** @type {any} */ (fakeState()), env);
    await settle();
    return /** @type {any} */ (f.core.routingFor(admin)).model;
  };
  assert.equal(await has({ FLEETWRIGHT_ROUTE_MODEL: '1', FLEETWRIGHT_DECIDE: '1', AI: ai, DECIDE_RATE_LIMIT: limit }), true);
  assert.equal(await has({ FLEETWRIGHT_DECIDE: '1', AI: ai, DECIDE_RATE_LIMIT: limit }), false, 'the decision model alone does not route');
  assert.equal(await has({ FLEETWRIGHT_ROUTE_MODEL: '1', AI: ai, DECIDE_RATE_LIMIT: limit }), false);
  assert.equal(await has({ FLEETWRIGHT_ROUTE_MODEL: 'true', FLEETWRIGHT_DECIDE: '1', AI: ai, DECIDE_RATE_LIMIT: limit }), false, 'exactly "1"');
  assert.equal(await has({ FLEETWRIGHT_ROUTE_MODEL: '1', FLEETWRIGHT_DECIDE: '1', DECIDE_RATE_LIMIT: limit }), false);
});
