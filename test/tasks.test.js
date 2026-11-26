// A task's rules (docs/tasks.md): the record, its branch, the lock, the
// changes it can go through, the first message a box composes for it, and
// what a result's first line says. All of it is src/fleet/protocol/tasks.js,
// which the coordinator, the box and the MCP server share.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkTask, checkNote, newTask, changeTask, lockTask, confirmLock, releaseLock, returnTask, actOn, startFor, wordsFor,
  composeTaskMessage, parseOutcome, branchFor, packetWords,
  MAX_TASK_TITLE, MAX_TASK_BRIEF, MAX_TASK_NOTE, MAX_RESULT, MAX_HANDOFFS, RESULT_FILE, RESULT_FOOTER, TASK_BRANCH_RE,
} from '../src/fleet/protocol/tasks.js';
import { MAX_INSTRUCTIONS, MAX_FIRST_MESSAGE, FIRST_MESSAGE_SEPARATOR } from '../src/fleet/protocol/members.js';
import { checkParams } from '../src/fleet/protocol/intents.js';

const bytes = (/** @type {string} */ s) => new TextEncoder().encode(s).length;
const eli = 'eli@example.com';
/** A task for Debbie, made at 1000. */
const made = (/** @type {any} */ o = {}) => newTask({ id: 't12', title: 'Fix the login redirect', brief: 'The redirect after sign-in loses ?next. Fix it in app/auth.', assignee: 'debbie', ...o }, { by: eli, at: 1000 });
/** That task with a start sent to a box, and then with the box's session working on it. */
const locked = () => /** @type {any} */ (lockTask(made(), { member: 'debbie', branch: made().branch, hostId: 'deb132', by: eli, at: 2000 })).task;
const working = () => confirmLock(locked(), { session: 'cc-a', hostId: 'deb132', at: 2100 });

test('the largest member and the largest task fit one first message, with the lines a box adds', () => {
  // Every field at its cap, and at its widest in UTF-8: a title of three-byte
  // characters, the longest repository and id, and a reopen note.
  const task = { ...made({ id: 't999999999', title: '字'.repeat(MAX_TASK_TITLE), brief: 'b'.repeat(MAX_TASK_BRIEF), repo: `${'a'.repeat(39)}/${'r'.repeat(100)}` }), note: 'n'.repeat(MAX_TASK_NOTE) };
  const first = composeTaskMessage({ instructions: 'i'.repeat(MAX_INSTRUCTIONS), taskId: task.id, branch: task.branch, repo: task.repo, words: wordsFor(task) });
  assert.equal(first.ok, true, /** @type {any} */ (first).text);
  assert.ok(bytes(/** @type {any} */ (first).text) <= MAX_FIRST_MESSAGE);
  // And the start a phone would sign for it is one the protocol takes.
  const start = startFor(task);
  assert.equal(checkParams('start', /** @type {any} */ (start)).ok, true);
});

test('a box composes instructions, then which task and branch, then the signed words, then where the result goes', () => {
  const first = composeTaskMessage({ instructions: 'Write small pull requests.', taskId: 't12', branch: 'task/t12-fix-the-login-redirect', repo: 'acme/app', words: 'Fix the login redirect\n\nIt loses ?next.' });
  assert.equal(/** @type {any} */ (first).text, [
    'Write small pull requests.',
    'Task t12. Branch task/t12-fix-the-login-redirect in acme/app.\n\nFix the login redirect\n\nIt loses ?next.',
    RESULT_FOOTER,
  ].join(FIRST_MESSAGE_SEPARATOR));
  assert.match(RESULT_FOOTER, new RegExp(`write ${RESULT_FILE.replace('.', '\\.')} at the top of your workspace.*DONE, BLOCKED or FAILED`));
  // No instructions and no repository: neither leaves a gap or a dangling "in".
  const bare = /** @type {any} */ (composeTaskMessage({ taskId: 't12', branch: 'task/t12', words: 'Do it.' })).text;
  assert.ok(bare.startsWith('Task t12. Branch task/t12.\n\nDo it.'));
  // Past the cap it is refused whole, never cut: a brief cut short is a task
  // the session was never given.
  const over = composeTaskMessage({ instructions: 'i'.repeat(MAX_INSTRUCTIONS), taskId: 't12', branch: 'task/t12', words: 'w'.repeat(4000) });
  assert.equal(over.ok, false);
  assert.match(/** @type {any} */ (over).text, /come to \d+ bytes, and a session’s first message is at most 8000/);
  assert.equal(composeTaskMessage({ taskId: 't12', branch: 'task/t12', words: '  ' }).ok, false);
});

test('a branch is the task’s id and its title as a slug, and a new title does not move it', () => {
  assert.equal(branchFor('t12', 'Fix the login redirect!'), 'task/t12-fix-the-login-redirect');
  assert.equal(branchFor('t7', '修复登录'), 'task/t7', 'a title that leaves no slug still has a branch');
  assert.equal(branchFor('t7', 'x'.repeat(200)).length, 'task/t7-'.length + 40);
  for (const title of ['Fix the login redirect!', '修复登录', '--- a ---', 'x'.repeat(200), 'Ünïcödé title']) assert.match(branchFor('t7', title), TASK_BRANCH_RE, title);
  const task = made();
  const renamed = /** @type {any} */ (changeTask(task, { title: 'Something else entirely' }, { by: eli, at: 3000 })).task;
  assert.equal(renamed.title, 'Something else entirely');
  assert.equal(renamed.branch, task.branch);
});

test('a task goes open, working, returned, done, and each step is written down', () => {
  let task = made();
  assert.deepEqual([task.state, task.lock, task.result], ['open', null, null]);
  task = locked();
  assert.equal(task.state, 'open', 'a start that has not been answered is not work yet');
  task = confirmLock(task, { session: 'cc-a', hostId: 'deb132', at: 2100 });
  assert.deepEqual([task.state, task.lock?.session], ['working', 'cc-a']);
  task = returnTask(task, { text: 'DONE\nFixed in 3f2a.', session: 'cc-a', hostId: 'deb132', at: 3000 });
  assert.equal(task.state, 'returned');
  assert.deepEqual(task.result, { outcome: 'done', summary: 'DONE\nFixed in 3f2a.', truncated: false, session: 'cc-a', hostId: 'deb132', member: 'debbie', at: 3000 });
  assert.equal(task.lock?.session, 'cc-a', 'the session is still there, and still holds it');
  const accepted = /** @type {any} */ (actOn(task, 'accept', { by: eli, at: 4000 })).task;
  assert.equal(accepted.state, 'done');
  assert.deepEqual(accepted.handoffs.map((/** @type {any} */ h) => h.kind), ['created', 'started', 'returned', 'accepted']);
  assert.deepEqual(accepted.handoffs[1], { at: 2100, by: eli, kind: 'started', to: 'debbie', session: 'cc-a', hostId: 'deb132' });
});

test('a session that ends with no result leaves the task open, and a start that never ran leaves no trace', () => {
  const ended = releaseLock(working(), { by: 'debbie', at: 3000, note: 'its session ended with no result' });
  assert.deepEqual([ended.state, ended.lock], ['open', null]);
  assert.deepEqual(ended.handoffs.at(-1), { at: 3000, by: 'debbie', kind: 'released', session: 'cc-a', hostId: 'deb132', note: 'its session ended with no result' });
  // A start a box refused: the lock goes, and nothing says hands changed.
  const refused = releaseLock(locked(), { by: eli, at: 2050, quiet: true });
  assert.deepEqual([refused.state, refused.lock, refused.handoffs.length], ['open', null, 1]);
  // A task that had already returned keeps its result when its session ends.
  const back = returnTask(working(), { text: 'BLOCKED on a missing key', session: 'cc-a', hostId: 'deb132', at: 3000 });
  const after = releaseLock(back, { by: 'debbie', at: 3500 });
  assert.deepEqual([after.state, after.lock, after.result?.outcome], ['returned', null, 'blocked']);
});

test('one lock: a second start is refused in words that name the session, and so is a start as anybody else', () => {
  const task = working();
  const again = /** @type {any} */ (lockTask(task, { member: 'debbie', branch: task.branch, hostId: 'box-2', by: 'dana@example.com', at: 5000 }));
  assert.equal(again.code, 'task_locked');
  assert.match(again.text, /^t12 is already being worked on: cc-a on deb132 has been working on it since 1970-01-01 00:00 UTC, started by eli@example\.com\.$/);
  // Two starts before any box answered: the second still loses.
  const racing = /** @type {any} */ (lockTask(locked(), { member: 'debbie', branch: made().branch, hostId: 'box-2', by: 'dana@example.com', at: 2001 }));
  assert.equal(racing.code, 'task_locked');
  assert.match(racing.text, /eli@example\.com started a session on it .* and deb132 has not answered yet/);

  const open = made();
  const as = (/** @type {any} */ o) => /** @type {any} */ (lockTask(open, { member: 'debbie', branch: open.branch, hostId: 'deb132', by: eli, at: 2000, ...o }));
  assert.equal(as({ member: 'jason' }).code, 'task_not_theirs');
  assert.equal(as({ branch: 'task/t12-other' }).code, 'task_branch');
  assert.equal(/** @type {any} */ (lockTask(made({ assignee: null }), { member: 'debbie', branch: 'task/t12-fix-the-login-redirect', hostId: 'x', by: eli, at: 1 })).code, 'task_unassigned');
  const done = /** @type {any} */ (actOn(returnTask(working(), { text: 'DONE', session: 'cc-a', hostId: 'deb132', at: 1 }), 'accept', { by: eli, at: 2 })).task;
  assert.equal(/** @type {any} */ (lockTask(done, { member: 'debbie', branch: done.branch, hostId: 'x', by: eli, at: 3 })).code, 'task_not_open');
});

test('a task changes hands only while nobody is working on it, and the handoff says who, to whom and why', () => {
  const moved = /** @type {any} */ (changeTask(made(), { assignee: 'jason' }, { by: eli, at: 3000, note: 'Debbie is out this week' })).task;
  assert.equal(moved.assignee, 'jason');
  assert.deepEqual(moved.handoffs.at(-1), { at: 3000, by: eli, kind: 'assigned', from: 'debbie', to: 'jason', note: 'Debbie is out this week' });
  const refused = /** @type {any} */ (changeTask(working(), { assignee: 'jason' }, { by: eli, at: 3000 }));
  assert.equal(refused.code, 'task_locked');
  assert.match(refused.text, /cannot change hands while it is being worked on: cc-a on deb132/);
  // Nor are its words corrected while it is worked on. They could be, and a
  // brief rewritten under a working session was a record of words that
  // session was never told (test/tasks-coordinator.test.js has the whole of it).
  assert.equal(/** @type {any} */ (changeTask(working(), { brief: 'A better brief.' }, { by: eli, at: 3000 })).code, 'task_locked');
});

test('reopening needs a note, the next session is told it, and accepting clears it', () => {
  const back = returnTask(working(), { text: 'DONE', session: 'cc-a', hostId: 'deb132', at: 3000 });
  assert.equal(/** @type {any} */ (actOn(back, 'reopen', { by: eli, at: 4000 })).code, 'note_required');
  const reopened = /** @type {any} */ (actOn(back, 'reopen', { by: eli, at: 4000, note: 'The redirect still drops ?next on Safari.' })).task;
  assert.deepEqual([reopened.state, reopened.lock], ['open', null]);
  assert.equal(startFor(reopened)?.task, 'Fix the login redirect\n\nThe redirect after sign-in loses ?next. Fix it in app/auth.\n\nReopened: The redirect still drops ?next on Safari.');
  assert.equal(startFor(reopened)?.taskBranch, back.branch, 'the same branch as the first time');
  const second = returnTask(confirmLock(/** @type {any} */ (lockTask(reopened, { member: 'debbie', branch: reopened.branch, hostId: 'deb132', by: eli, at: 5000 })).task, { session: 'cc-b', hostId: 'deb132', at: 5100 }), { text: 'DONE', session: 'cc-b', hostId: 'deb132', at: 6000 });
  assert.equal(/** @type {any} */ (actOn(second, 'accept', { by: eli, at: 7000 })).task.note, undefined);
});

test('each action is taken only from the states the table gives it', () => {
  const by = { by: eli, at: 9000, note: 'why' };
  const states = { open: made(), working: working(), returned: returnTask(working(), { text: 'DONE', session: 'cc-a', hostId: 'deb132', at: 1 }) };
  const done = /** @type {any} */ (actOn(states.returned, 'accept', by)).task;
  const cancelled = /** @type {any} */ (actOn(states.open, 'cancel', by)).task;
  const all = { ...states, done, cancelled };
  const taken = (/** @type {string} */ action) => Object.entries(all).filter(([, t]) => actOn(t, action, by).ok).map(([s]) => s);
  assert.deepEqual(taken('accept'), ['returned']);
  assert.deepEqual(taken('reopen'), ['returned', 'done']);
  assert.deepEqual(taken('cancel'), ['open', 'working', 'returned']);
  assert.deepEqual(taken('release'), ['working', 'returned']);
  assert.equal(/** @type {any} */ (actOn(states.open, 'delete', by)).code, 'bad_action');
  // Nothing starts on a task that is not open and unlocked.
  assert.deepEqual(Object.entries(all).filter(([, t]) => startFor(t)).map(([s]) => s), ['open']);
  assert.equal(startFor(made({ assignee: null })), null);
});

test('the outcome is read off the first line that says anything, and nothing else is', () => {
  assert.equal(parseOutcome('DONE\nall of it'), 'done');
  assert.equal(parseOutcome('\n\n# **Blocked**: no access to the repo'), 'blocked');
  assert.equal(parseOutcome('> failed — tests red'), 'failed');
  assert.equal(parseOutcome('I finished everything.\nDONE'), 'unstated', 'a DONE further down is not the first line');
  assert.equal(parseOutcome('DONEish'), 'unstated');
  assert.equal(parseOutcome(''), 'unstated');
});

test('a result is kept to its cap on a character boundary, and says when it was cut', () => {
  const long = `DONE\n${'字'.repeat(2000)}`;
  const task = returnTask(working(), { text: long, session: 'cc-a', hostId: 'deb132', at: 3000 });
  assert.ok(bytes(String(task.result?.summary)) <= MAX_RESULT);
  assert.equal(task.result?.truncated, true);
  assert.ok(!String(task.result?.summary).includes('�'), 'no half character at the cut');
  assert.match(packetWords(task), /longer than 4000 bytes and is cut here\. The whole of it is RESULT\.md/);
  // What the box said it cut is kept even when what arrived fits.
  assert.equal(returnTask(working(), { text: 'DONE', truncated: true, session: 'cc-a', hostId: 'deb132', at: 1 }).result?.truncated, true);
  // Marks that hide or reorder text do not reach a screen from a result.
  assert.equal(returnTask(working(), { text: 'DONE‮\u0007 ok', session: 'cc-a', hostId: 'deb132', at: 1 }).result?.summary, 'DONE ok');
});

test('a packet says the outcome, where it ran, and that the branch is only what was asked for', () => {
  const task = returnTask({ ...working(), repo: 'acme/app' }, { text: 'BLOCKED\nNo key for the registry.', session: 'cc-a', hostId: 'deb132', at: 3000 });
  assert.equal(packetWords(task), [
    't12 “Fix the login redirect”, worked on by debbie: BLOCKED.',
    'Session cc-a on deb132. Branch task/t12-fix-the-login-redirect in acme/app, as the session was told: nothing here checked that it exists.',
    '',
    'BLOCKED\nNo key for the registry.',
  ].join('\n'));
  assert.equal(packetWords(made()), '', 'a task with no result has no packet');
});

test('what a person writes is checked, and a field a task does not have is dropped', () => {
  const ok = /** @type {any} */ (checkTask({ title: '  Fix  it ', brief: 'Do the thing.\r\n', assignee: 'Debbie', workType: 'Backend', repo: 'acme/app', token: 'ghp_never', lock: { session: 'x' } }));
  assert.deepEqual(ok.fields, { title: 'Fix it', brief: 'Do the thing.', workType: 'backend', repo: 'acme/app', assignee: 'debbie' });
  const refused = (/** @type {any} */ o) => /** @type {any} */ (checkTask({ title: 'T', brief: 'B', ...o })).text;
  assert.match(refused({ title: 'x'.repeat(MAX_TASK_TITLE + 1) }), /at most 120 characters/);
  assert.match(refused({ brief: 'x'.repeat(MAX_TASK_BRIEF + 1) }), /is 2401 bytes, and a task’s brief is at most 2400/);
  assert.match(refused({ brief: 'do it‮' }), /a mark that hides text/);
  assert.match(refused({ brief: '' }), /It is all the session gets/);
  assert.match(refused({ repo: 'not a repo' }), /owner\/repo/);
  assert.match(refused({ assignee: 'Not An Id' }), /a member’s id/);
  assert.match(refused({ parent: '12' }), /like t12/);
  // A change names only what it changes, and an empty string clears.
  assert.deepEqual(/** @type {any} */ (checkTask({ repo: '', assignee: '' }, { partial: true })).fields, { repo: '', assignee: null });
  assert.equal(/** @type {any} */ (checkNote('n'.repeat(MAX_TASK_NOTE + 1))).code, 'bad_note');
});

test('a task keeps its last fifty changes of hands', () => {
  let task = made();
  for (let i = 0; i < MAX_HANDOFFS + 20; i++) task = /** @type {any} */ (changeTask(task, { assignee: i % 2 ? 'debbie' : 'jason' }, { by: eli, at: 2000 + i })).task;
  assert.equal(task.handoffs.length, MAX_HANDOFFS);
  assert.equal(task.handoffs.at(-1)?.at, 2000 + MAX_HANDOFFS + 19);
});
