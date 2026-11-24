// A member's record, the tree and the file (docs/members.md), at the one
// module the coordinator, the minter and the box all read them through.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkMember, checkTree, chainAbove, manages, teamOf, principalOf, memberOfPrincipal, composeFirstMessage,
  toMarkdown, fromMarkdown, MAX_INSTRUCTIONS, MAX_FIRST_MESSAGE, FIRST_MESSAGE_SEPARATOR,
} from '../src/fleet/protocol/members.js';

const agent = (/** @type {any} */ o = {}) => ({ id: 'debbie', name: 'Debbie', kind: 'agent', role: 'software engineer', ...o });
const person = (/** @type {any} */ o = {}) => ({ id: 'eli', name: 'Eli', kind: 'person', email: 'eli@example.com', role: 'owner', ...o });
/** @param {any} input */
const made = (input) => {
  const r = checkMember(input);
  assert.equal(r.ok, true, r.ok ? '' : r.text);
  return /** @type {any} */ (r).member;
};

test('a record keeps the fields it lists, and nothing else a caller sent', () => {
  const m = made(agent({ token: 'sk-ant-nope', credentials: { claude: 'x' }, workTypes: ['backend', 'backend'], hosts: { tag: 'linux', secret: 'y' } }));
  assert.deepEqual(Object.keys(m).sort(), ['budgetUsdMonth', 'description', 'engines', 'hosts', 'id', 'instructions', 'kind', 'managers', 'name', 'reportsTo', 'role', 'title', 'workTypes']);
  assert.deepEqual(m.hosts, { tag: 'linux' });
  assert.deepEqual(m.workTypes, ['backend']);
  assert.deepEqual(m.engines, [{ engine: 'claude-code' }]);
  assert.doesNotMatch(JSON.stringify(m), /sk-ant|credentials/);
});

test('each field is refused in words that say what it takes', () => {
  /** @type {Array<[any, RegExp]>} */
  const cases = [
    [agent({ id: 'Debbie' }), /lowercase letters, digits and hyphens/],
    [agent({ id: 'x'.repeat(41) }), /at most 40/],
    [agent({ kind: 'robot' }), /a person or an agent/],
    [agent({ name: '' }), /needs a name/],
    [agent({ name: 'two\nlines' }), /one line/],
    [agent({ role: 'r'.repeat(61) }), /at most 60/],
    [agent({ description: 'd'.repeat(301) }), /at most 300/],
    [agent({ email: 'debbie@example.com' }), /no address of its own/],
    [person({ email: '' }), /fleet address/],
    [agent({ reportsTo: 'debbie' }), /cannot report to itself/],
    [agent({ managers: ['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io', 'e@x.io'] }), /at most 4/],
    [agent({ workTypes: Array.from({ length: 13 }, (_, i) => `t${i}`) }), /at most 12/],
    [agent({ workTypes: ['Back End'] }), /short names/],
    [agent({ instructions: 'x'.repeat(MAX_INSTRUCTIONS + 1) }), /at most 4096 bytes/],
    [agent({ engines: [{ engine: 'codex' }] }), /claude-code for now/],
    [agent({ engines: [{ engine: 'claude-code' }, { engine: 'claude-code' }] }), /exactly one engine/],
    [agent({ hosts: { tag: 'two words' } }), /host tag/],
    [agent({ budgetUsdMonth: -1 }), /dollars a month/],
  ];
  for (const [input, words] of cases) {
    const r = checkMember(input);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.match(/** @type {any} */ (r).text, words);
  }
});

test('instructions are measured in bytes, not characters', () => {
  assert.equal(checkMember(agent({ instructions: 'é'.repeat(MAX_INSTRUCTIONS / 2) })).ok, true);
  assert.equal(checkMember(agent({ instructions: 'é'.repeat(MAX_INSTRUCTIONS / 2 + 1) })).ok, false);
});

test('the tree refuses a missing manager, a loop, and one person as two members', () => {
  const tree = [made(person()), made(agent({ reportsTo: 'eli' })), made(agent({ id: 'jason', name: 'Jason', reportsTo: 'debbie' }))];
  assert.equal(checkTree(tree, made(agent({ id: 'new', reportsTo: 'jason' }))).ok, true);
  assert.match(/** @type {any} */ (checkTree(tree, made(agent({ id: 'new', reportsTo: 'ghost' })))).text, /ghost is not a member/);
  // debbie → eli today; eli → jason would close eli → jason → debbie → eli.
  assert.match(/** @type {any} */ (checkTree(tree, made(person({ reportsTo: 'jason' })))).text, /already reports up to eli/);
  assert.match(/** @type {any} */ (checkTree(tree, made(person({ id: 'eli-two' })))).text, /already the member eli/);
  // Editing a member in place is not a clash with itself.
  assert.equal(checkTree(tree, made(person({ title: 'Founder' }))).ok, true);
});

test('managing comes from the tree and from named managers, never from a role', () => {
  const tree = [
    made(person()),
    made(person({ id: 'dana', name: 'Dana', email: 'dana@example.com', role: 'manager of everything', reportsTo: 'eli' })),
    made(agent({ reportsTo: 'dana' })),
    made(agent({ id: 'jason', name: 'Jason', role: 'designer', reportsTo: 'debbie', managers: ['sam@example.com'] })),
    made(agent({ id: 'loose', name: 'Loose' })),
  ];
  assert.deepEqual(chainAbove(tree, 'jason').map((n) => n.id), ['debbie', 'dana', 'eli']);
  // Above it in the chain, at any distance.
  assert.equal(manages(tree, 'dana@example.com', 'debbie'), true);
  assert.equal(manages(tree, 'DANA@example.com', 'jason'), true);
  assert.equal(manages(tree, 'eli@example.com', 'jason'), true);
  // A role that says "manager" gives nothing outside the tree.
  assert.equal(manages(tree, 'dana@example.com', 'loose'), false);
  // Nobody manages their own member, or anybody above them.
  assert.equal(manages(tree, 'dana@example.com', 'dana'), false);
  assert.equal(manages(tree, 'dana@example.com', 'eli'), false);
  // Named on a member: that member and what reports to it, and no further up.
  assert.equal(manages(tree, 'sam@example.com', 'jason'), true);
  assert.equal(manages(tree, 'sam@example.com', 'debbie'), false);
  assert.deepEqual(teamOf(tree, 'dana@example.com'), ['debbie', 'jason']);
  assert.deepEqual(teamOf(tree, 'nobody@example.com'), []);
  assert.equal(manages(tree, '', 'debbie'), false);
});

test('a principal is the member for an agent and the address for a person', () => {
  assert.equal(principalOf(made(agent())), 'member:debbie');
  assert.equal(principalOf(made(person({ email: 'Eli@Example.com' }))), 'eli@example.com');
  assert.equal(memberOfPrincipal('member:debbie'), 'debbie');
  assert.equal(memberOfPrincipal('eli@example.com'), null);
  assert.equal(memberOfPrincipal('member:../etc'), null);
});

test('the first message is the instructions, a line, the task, and is refused past the cap', () => {
  const both = composeFirstMessage('Write small pull requests.', 'Fix the login bug.');
  assert.deepEqual(both, { ok: true, text: `Write small pull requests.${FIRST_MESSAGE_SEPARATOR}Fix the login bug.` });
  assert.equal(/** @type {any} */ (composeFirstMessage('', 'Just the task.')).text, 'Just the task.');
  assert.equal(/** @type {any} */ (composeFirstMessage('Only instructions.', '')).text, 'Only instructions.');
  const over = composeFirstMessage('i'.repeat(4000), 't'.repeat(MAX_FIRST_MESSAGE - 4000));
  assert.equal(over.ok, false);
  assert.match(over.text, /at most 8000/);
});

test('a member goes out as a file and comes back the same member', () => {
  const full = made(agent({
    title: 'Senior: "the" engineer', reportsTo: 'eli', managers: ['sam@example.com'], description: 'Takes backend work, and reviews.',
    workTypes: ['backend', 'code-review'], instructions: 'You write small pull requests.\n\n---\n\nSay what you did not test.',
    engines: [{ engine: 'claude-code', model: 'opus' }], hosts: { tag: 'linux' }, budgetUsdMonth: 250.5,
  }));
  const file = toMarkdown(full);
  assert.match(file, /^---\nid: debbie\n/);
  assert.match(file, /title: "Senior: \\"the\\" engineer"/);
  const back = fromMarkdown(file);
  assert.equal(back.ok, true);
  assert.deepEqual(made(/** @type {any} */ (back).member), full);
  // A person, and the least a member can be.
  for (const m of [made(person()), made(agent())]) assert.deepEqual(made(/** @type {any} */ (fromMarkdown(toMarkdown(m))).member), m);
});

test('a hand-written file is read, and what it cannot read is refused by name', () => {
  const read = fromMarkdown('---\nid: jason\nname: Jason\nkind: agent\nrole: designer\nworkTypes:\n  - design\n  - "ui review"\nengines:\n  - engine: claude-code\n    model: sonnet\nhosts:\n  tag: macos\nbudgetUsdMonth: 40\n---\nYou draw first.\n');
  assert.equal(read.ok, true);
  const m = /** @type {any} */ (read).member;
  assert.deepEqual(m.workTypes, ['design', 'ui review']);
  assert.deepEqual(m.engines, [{ engine: 'claude-code', model: 'sonnet' }]);
  assert.deepEqual(m.hosts, { tag: 'macos' });
  assert.equal(m.budgetUsdMonth, 40);
  assert.equal(m.instructions, 'You draw first.');
  assert.match(/** @type {any} */ (fromMarkdown('no front matter')).text, /two lines of three dashes/);
  assert.match(/** @type {any} */ (fromMarkdown('---\nid: x\napiKey: sk-1\n---\n')).text, /no field called “apiKey”/);
  assert.match(/** @type {any} */ (fromMarkdown('---\nid: x\nid: y\n---\n')).text, /“id” twice/);
  assert.match(/** @type {any} */ (fromMarkdown('---\nid: x\nname: &anchor y\n---\n')).text, /“name” is not written in a way this reads/);
});
