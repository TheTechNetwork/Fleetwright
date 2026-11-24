// A task: the record above sessions, its lock, its branch and its result
// (docs/tasks.md).
//
// WHY IT IS HERE AND NOT IN THE COORDINATOR. Three parties read a task's
// rules and must agree: the coordinator, which keeps the record and takes the
// lock; the box, which composes a task session's first message and reads the
// result back; and the MCP server, which builds a brief an agent hands on.
// No imports beyond text.js and members.js, which have none of their own, so
// the Worker bundles and the stdio MCP server can all take this file.
//
// THE STATE MACHINE IS PURE. Every change of a task is a function from the
// task to the next one, taking the clock and the person as arguments, so the
// table in the doc is the code and a test reads both.
//
// WHAT A TASK NEVER HOLDS is a credential. `checkTask` keeps the fields it
// lists and drops the rest.
//
// NEVER THROWS. Every refusal is `{ ok: false, code, text }`, in words the
// person who asked can act on.

import { oneLine } from '../../core/text.js';
import { MEMBER_ID_RE, MAX_FIRST_MESSAGE, FIRST_MESSAGE_SEPARATOR } from './members.js';

/** A task's id: `t` and a number the coordinator counts up. Typed in commands, and part of a branch's name. */
export const TASK_ID_RE = /^t[1-9][0-9]{0,8}$/;
/** A task's branch: `task/<id>` and, when the title leaves one, a slug. */
export const TASK_BRANCH_RE = /^task\/t[1-9][0-9]{0,8}(?:-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)?$/;
/** `owner/repo`, as GitHub spells one. */
export const TASK_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const WORK_TYPE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** How many tasks a fleet keeps. One Durable Object value each (org-tasks.js). */
export const MAX_TASKS = 500;
/** Characters. */
export const MAX_TASK_TITLE = 120;
/**
 * Bytes, as UTF-8. Short on purpose: a task is handed over as a fresh brief,
 * and the largest member's instructions, the largest brief and the lines a
 * box adds have to fit one first message (test/tasks.test.js measures it).
 */
export const MAX_TASK_BRIEF = 2400;
/** Bytes: why a task was reopened, or a handoff's note. It travels in the next session's first message. */
export const MAX_TASK_NOTE = 300;
/** Bytes of a result the coordinator keeps. */
export const MAX_RESULT = 4000;
/** How many changes of hands a task keeps, newest last. */
export const MAX_HANDOFFS = 50;

export const TASK_STATES = Object.freeze(['open', 'working', 'returned', 'done', 'cancelled']);
export const TASK_ACTIONS = Object.freeze(['release', 'accept', 'reopen', 'cancel']);
export const TASK_OUTCOMES = Object.freeze(['done', 'blocked', 'failed', 'unstated']);

/** The file a task session writes when it stops, at the top of its workspace. */
export const RESULT_FILE = 'RESULT.md';

/**
 * What a box adds after a task's words. It names the file the box reads back,
 * and the three words the coordinator reads the outcome off.
 */
export const RESULT_FOOTER =
  `When you stop, write ${RESULT_FILE} at the top of your workspace. Start its first line with DONE, BLOCKED or FAILED. ` +
  'Then say what you did, what you did not do or test, the branch and commits, and what the next person should check.';

/**
 * @typedef {object} TaskLock
 * @property {string|null} session  null until the box has answered with the session's name
 * @property {string} hostId
 * @property {string} member
 * @property {string} by     who started it
 * @property {number} at
 * @property {number} [readyAt]  when its session last came back to its prompt with no result written
 */
/**
 * @typedef {object} TaskResult
 * @property {'done'|'blocked'|'failed'|'unstated'} outcome
 * @property {string} summary
 * @property {boolean} truncated
 * @property {string} session
 * @property {string} hostId
 * @property {string} member
 * @property {number} at
 */
/** @typedef {{ at: number, by: string, kind: string, from?: string|null, to?: string|null, note?: string, session?: string, hostId?: string, task?: string }} Handoff */
/**
 * @typedef {object} Task
 * @property {string} id
 * @property {string} title
 * @property {string} brief
 * @property {string} [workType]
 * @property {string} [repo]
 * @property {string|null} assignee
 * @property {'open'|'working'|'returned'|'done'|'cancelled'} state
 * @property {string} branch
 * @property {string|null} parent
 * @property {string} [note]  why it was reopened, told to the next session
 * @property {TaskLock|null} lock
 * @property {TaskResult|null} result
 * @property {Handoff[]} handoffs
 * @property {string} createdBy
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/** @param {string} code @param {string} text */
const refuse = (code, text) => /** @type {const} */ ({ ok: false, code, text });
const bytes = (/** @type {string} */ s) => new TextEncoder().encode(s).length;
// Control characters but tab and newline, and the marks that reorder or hide text on a line.
const UNPRINTABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** The first `max` bytes of a string, never half a character. */
export function firstBytes(/** @type {string} */ text, /** @type {number} */ max) {
  const all = new TextEncoder().encode(text);
  if (all.length <= max) return { text, cut: false };
  // A decoder that is not fatal turns a split character into U+FFFD, which is
  // dropped: the cut lands on the character before it.
  const kept = new TextDecoder('utf-8').decode(all.slice(0, max)).replace(/\ufffd+$/, '');
  return { text: kept, cut: true };
}

/**
 * A task's branch, from its id and title. The slug is for the person reading
 * a list of branches; the id is what makes it this task's and no other's.
 *
 * @param {string} id @param {string} title
 */
export function branchFor(id, title) {
  const slug = String(title ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return slug ? `task/${id}-${slug}` : `task/${id}`;
}

/**
 * The fields a person writes, checked. Used for a new task and for a change:
 * a change passes the fields it means to change and no others.
 *
 * @param {any} input
 * @param {{ partial?: boolean }} [opts]
 * @returns {{ ok: true, fields: { title?: string, brief?: string, workType?: string, repo?: string, assignee?: string|null, parent?: string|null } } | { ok: false, code: string, text: string }}
 */
export function checkTask(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse('bad_task', 'A task is an object with a title and a brief.');
  /** @type {{ title?: string, brief?: string, workType?: string, repo?: string, assignee?: string|null, parent?: string|null }} */
  const out = {};

  if (input.title !== undefined || !partial) {
    const title = oneLine(input.title, MAX_TASK_TITLE + 1);
    if (!title) return refuse('bad_task', 'A task needs a title: one line that says what it is.');
    if (title.length > MAX_TASK_TITLE) return refuse('bad_task', `A task’s title is at most ${MAX_TASK_TITLE} characters. The detail goes in the brief.`);
    out.title = title;
  }
  if (input.brief !== undefined || !partial) {
    const brief = typeof input.brief === 'string' ? input.brief.replace(/\r\n?/g, '\n').trim() : '';
    if (!brief) return refuse('bad_task', 'A task needs a brief: what to do, where, and what to hand back. It is all the session gets.');
    if (UNPRINTABLE.test(brief)) return refuse('bad_task', 'The brief holds a control character or a mark that hides text. Take it out and send it again.');
    const size = bytes(brief);
    if (size > MAX_TASK_BRIEF) {
      return refuse('bad_task', `The brief is ${size} bytes, and a task’s brief is at most ${MAX_TASK_BRIEF}. A brief is short on purpose: say what to do and where, and leave the history out.`);
    }
    out.brief = brief;
  }
  if (input.workType !== undefined && input.workType !== null && input.workType !== '') {
    const workType = String(input.workType).trim().toLowerCase();
    if (!WORK_TYPE_RE.test(workType)) return refuse('bad_task', 'A kind of work is a short slug: lowercase letters, digits and hyphens.');
    out.workType = workType;
  } else if (input.workType !== undefined) out.workType = '';
  if (input.repo !== undefined && input.repo !== null && input.repo !== '') {
    const repo = String(input.repo).trim();
    if (!TASK_REPO_RE.test(repo)) return refuse('bad_task', 'A repository is written owner/repo.');
    out.repo = repo;
  } else if (input.repo !== undefined) out.repo = '';
  if (input.assignee !== undefined) {
    if (input.assignee === null || input.assignee === '') out.assignee = null;
    else {
      const assignee = String(input.assignee).trim().toLowerCase();
      if (!MEMBER_ID_RE.test(assignee)) return refuse('bad_task', 'An assignee is a member’s id.');
      out.assignee = assignee;
    }
  }
  if (input.parent !== undefined && input.parent !== null && input.parent !== '') {
    const parent = String(input.parent).trim().toLowerCase();
    if (!TASK_ID_RE.test(parent)) return refuse('bad_task', 'A parent is a task’s id, like t12.');
    out.parent = parent;
  }
  return { ok: true, fields: out };
}

/**
 * A note somebody wrote beside a change of hands: one paragraph, bounded in
 * bytes because it travels in a first message.
 *
 * @param {unknown} note
 * @returns {{ ok: true, note: string } | { ok: false, code: string, text: string }}
 */
export function checkNote(note) {
  const text = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim() : '';
  if (UNPRINTABLE.test(text)) return refuse('bad_note', 'The note holds a control character or a mark that hides text.');
  const size = bytes(text);
  if (size > MAX_TASK_NOTE) return refuse('bad_note', `The note is ${size} bytes, and a note is at most ${MAX_TASK_NOTE}.`);
  return { ok: true, note: text };
}

/** @param {Task} task @param {Handoff} entry @returns {Handoff[]} */
const handed = (task, entry) => [...(task.handoffs ?? []), entry].slice(-MAX_HANDOFFS);

/**
 * A new task, open and unlocked.
 *
 * @param {{ id: string, title: string, brief: string, workType?: string, repo?: string, assignee?: string|null, parent?: string|null }} fields
 * @param {{ by: string, at: number }} who
 * @returns {Task}
 */
export function newTask(fields, { by, at }) {
  /** @type {Task} */
  const task = {
    id: fields.id,
    title: fields.title,
    brief: fields.brief,
    ...(fields.workType ? { workType: fields.workType } : {}),
    ...(fields.repo ? { repo: fields.repo } : {}),
    assignee: fields.assignee ?? null,
    state: 'open',
    branch: branchFor(fields.id, fields.title),
    parent: fields.parent ?? null,
    lock: null,
    result: null,
    handoffs: [],
    createdBy: by,
    createdAt: at,
    updatedAt: at,
  };
  task.handoffs = handed(task, { at, by, kind: 'created', to: task.assignee, ...(task.parent ? { task: task.parent } : {}) });
  return task;
}

/** How a lock is said to the person it refuses. */
export function lockWords(/** @type {Task} */ task) {
  const lock = task.lock;
  if (!lock) return '';
  const since = new Date(lock.at).toISOString().replace('T', ' ').slice(0, 16);
  return lock.session
    ? `${lock.session} on ${lock.hostId} has been working on it since ${since} UTC, started by ${lock.by}`
    : `${lock.by} started a session on it at ${since} UTC, and ${lock.hostId} has not answered yet`;
}

/**
 * A change to what a task says or whose it is. Reassigning is a handoff, and
 * is refused while a session holds the lock: the work in flight comes back,
 * or is released, first.
 *
 * @param {Task} task
 * @param {{ title?: string, brief?: string, workType?: string, repo?: string, assignee?: string|null }} fields  already through checkTask
 * @param {{ by: string, at: number, note?: string }} who
 * @returns {{ ok: true, task: Task } | { ok: false, code: string, text: string }}
 */
export function changeTask(task, fields, { by, at, note = '' }) {
  if (task.state === 'done' || task.state === 'cancelled') {
    return refuse('task_closed', `${task.id} is ${task.state}. Reopen it to change it.`);
  }
  const next = { ...task, updatedAt: at };
  if (fields.title !== undefined) next.title = fields.title;
  if (fields.brief !== undefined) next.brief = fields.brief;
  if (fields.workType !== undefined) {
    if (fields.workType) next.workType = fields.workType;
    else delete next.workType;
  }
  if (fields.repo !== undefined) {
    if (fields.repo) next.repo = fields.repo;
    else delete next.repo;
  }
  if (fields.assignee !== undefined && fields.assignee !== task.assignee) {
    if (task.lock) return refuse('task_locked', `${task.id} cannot change hands while it is being worked on: ${lockWords(task)}. Release it, or wait for it to come back.`);
    next.assignee = fields.assignee;
    next.handoffs = handed(task, { at, by, kind: 'assigned', from: task.assignee, to: fields.assignee, ...(note ? { note } : {}) });
  }
  return { ok: true, task: next };
}

/**
 * Take the lock for a start that is about to be sent to a box. The session's
 * name is not known yet: `confirmLock` writes it when the box answers.
 *
 * @param {Task} task
 * @param {{ member: string, branch: string, hostId: string, by: string, at: number }} start
 * @returns {{ ok: true, task: Task } | { ok: false, code: string, text: string }}
 */
export function lockTask(task, { member, branch, hostId, by, at }) {
  if (!task.assignee) return refuse('task_unassigned', `${task.id} is assigned to nobody. Assign it to a member first.`);
  if (task.assignee !== member) return refuse('task_not_theirs', `${task.id} is assigned to ${task.assignee}, and this would start it as ${member || 'nobody'}. A task is started as its assignee.`);
  if (branch !== task.branch) return refuse('task_branch', `${task.id} is worked on the branch ${task.branch}, and this names ${branch || 'none'}.`);
  if (task.lock) return refuse('task_locked', `${task.id} is already being worked on: ${lockWords(task)}.`);
  if (task.state !== 'open') {
    return refuse('task_not_open', task.state === 'returned'
      ? `${task.id} has come back and is waiting for somebody to accept it or reopen it.`
      : `${task.id} is ${task.state}.`);
  }
  return { ok: true, task: { ...task, lock: { session: null, hostId, member, by, at }, updatedAt: at } };
}

/**
 * The box answered a start: the lock is this session's and the task is being
 * worked on. Also how a session the coordinator did not hear start (a reply
 * that timed out) is taken up when its box next speaks of it.
 *
 * @param {Task} task
 * @param {{ session: string, hostId: string, member?: string, by?: string, at: number }} held
 * @returns {Task}
 */
export function confirmLock(task, { session, hostId, member, by, at }) {
  const lock = task.lock ?? { session: null, hostId, member: member ?? task.assignee ?? '', by: by ?? '', at };
  return {
    ...task,
    state: 'working',
    lock: { ...lock, session, hostId },
    handoffs: handed(task, { at, by: lock.by, kind: 'started', to: lock.member, session, hostId }),
    updatedAt: at,
  };
}

/**
 * The lock ends with no result: a start a box refused, a session that ended,
 * or a person's Release. A task that was being worked on is open again; one
 * that had already returned keeps its result.
 *
 * @param {Task} task
 * @param {{ by: string, at: number, note?: string, quiet?: boolean, byHand?: boolean }} why
 *   `quiet` for a start that never ran, which is not a change of hands;
 *   `byHand` for a person's Release, which is written down whatever state
 *   the task is in: somebody took a session off a task, and the history
 *   says who. A session that merely ended after it had returned is not.
 * @returns {Task}
 */
export function releaseLock(task, { by, at, note = '', quiet = false, byHand = false }) {
  if (!task.lock) return task;
  const { session, hostId } = task.lock;
  return {
    ...task,
    state: task.state === 'working' || task.state === 'open' ? 'open' : task.state,
    lock: null,
    handoffs: quiet || (task.state !== 'working' && !byHand)
      ? task.handoffs
      : handed(task, { at, by, kind: 'released', ...(session ? { session } : {}), hostId, ...(note ? { note } : {}) }),
    updatedAt: at,
  };
}

/**
 * What a result's first line says of the work. Read off the first line that
 * holds anything, past the marks a markdown heading or emphasis puts first.
 *
 * @param {string} text
 * @returns {'done'|'blocked'|'failed'|'unstated'}
 */
export function parseOutcome(text) {
  const first = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const word = /^[#>*_`\s-]*([A-Za-z]+)/.exec(first)?.[1]?.toUpperCase() ?? '';
  return word === 'DONE' ? 'done' : word === 'BLOCKED' ? 'blocked' : word === 'FAILED' ? 'failed' : 'unstated';
}

/**
 * A session came back to its prompt and its box read a result. The task
 * returns; the lock stays with the session until the session ends.
 *
 * @param {Task} task
 * @param {{ text: string, truncated?: boolean, session: string, hostId: string, at: number }} came
 * @returns {Task}
 */
export function returnTask(task, { text, truncated = false, session, hostId, at }) {
  const kept = firstBytes(String(text ?? '').replace(/\r\n?/g, '\n').replace(UNPRINTABLE_ALL, '').trim(), MAX_RESULT);
  const member = task.lock?.member ?? task.assignee ?? '';
  /** @type {TaskResult} */
  const result = { outcome: parseOutcome(kept.text), summary: kept.text, truncated: truncated || kept.cut, session, hostId, member, at };
  return {
    ...task,
    state: 'returned',
    result,
    handoffs: handed(task, { at, by: member, kind: 'returned', from: member, session, hostId, note: result.outcome }),
    updatedAt: at,
  };
}
const UNPRINTABLE_ALL = new RegExp(UNPRINTABLE.source, 'g');

/**
 * Release, accept, reopen or cancel (the table in docs/tasks.md).
 *
 * @param {Task} task
 * @param {string} action
 * @param {{ by: string, at: number, note?: string }} who
 * @returns {{ ok: true, task: Task } | { ok: false, code: string, text: string }}
 */
export function actOn(task, action, { by, at, note = '' }) {
  switch (action) {
    case 'release':
      if (!task.lock) return refuse('task_not_locked', `No session holds ${task.id}. There is nothing to release.`);
      return { ok: true, task: releaseLock(task, { by, at, note: note || 'released by hand', byHand: true }) };
    case 'accept':
      if (task.state !== 'returned') return refuse('task_not_returned', `${task.id} is ${task.state}. Only a task that has come back can be accepted.`);
      {
        const { note: _was, ...rest } = task;
        // Done is done: the lock goes with it, and the session that returned
        // is its starter's to stop.
        return { ok: true, task: { ...rest, state: 'done', lock: null, handoffs: handed(task, { at, by, kind: 'accepted', ...(note ? { note } : {}) }), updatedAt: at } };
      }
    case 'reopen':
      if (task.state !== 'returned' && task.state !== 'done') return refuse('task_not_returned', `${task.id} is ${task.state}. Only a task that has come back, or is done, can be reopened.`);
      if (!note) return refuse('note_required', 'Say why it is reopened. The note is what the next session is told.');
      // The lock goes with it: the next session starts from the brief and the
      // note, and the one that returned is its starter's to stop.
      return { ok: true, task: { ...task, state: 'open', lock: null, note, handoffs: handed(task, { at, by, kind: 'reopened', note }), updatedAt: at } };
    case 'cancel':
      if (task.state === 'done' || task.state === 'cancelled') return refuse('task_closed', `${task.id} is already ${task.state}.`);
      return { ok: true, task: { ...task, state: 'cancelled', lock: null, handoffs: handed(task, { at, by, kind: 'cancelled', ...(note ? { note } : {}) }), updatedAt: at } };
    default:
      return refuse('bad_action', `A task is released, accepted, reopened or cancelled. “${oneLine(action, 40)}” is none of those.`);
  }
}

/**
 * The words a task's session is given, which the person who starts it signs
 * as `task`: the title, the brief and, on a reopened task, why.
 *
 * @param {{ title: string, brief: string, note?: string }} task
 */
export function wordsFor(task) {
  return `${task.title}\n\n${task.brief}${task.note ? `\n\nReopened: ${task.note}` : ''}`;
}

/**
 * What to send to start a session on a task, ready to sign: `start`'s own
 * parameters. Null for a task nobody can start now.
 *
 * @param {Task} task
 * @returns {{ member: string, taskId: string, taskBranch: string, taskRepo?: string, task: string } | null}
 */
export function startFor(task) {
  if (task.state !== 'open' || task.lock || !task.assignee) return null;
  return { member: task.assignee, taskId: task.id, taskBranch: task.branch, ...(task.repo ? { taskRepo: task.repo } : {}), task: wordsFor(task) };
}

/**
 * The first message of a task's session, composed on the box: the member's
 * instructions, which task and branch this is, the words the person signed,
 * and where to write the result. Refused past a first message's cap, because
 * a brief cut short is a task the session was never given.
 *
 * @param {{ instructions?: string, taskId: string, branch: string, repo?: string, words: string }} parts
 * @returns {{ ok: true, text: string } | { ok: false, code: string, text: string }}
 */
export function composeTaskMessage({ instructions = '', taskId, branch, repo = '', words }) {
  const brief = String(instructions ?? '').trim();
  const asked = String(words ?? '').trim();
  if (!asked) return refuse('bad_params', 'A session on a task needs the task’s words.');
  const header = `Task ${taskId}. Branch ${branch}${repo ? ` in ${repo}` : ''}.`;
  const body = `${header}\n\n${asked}${FIRST_MESSAGE_SEPARATOR}${RESULT_FOOTER}`;
  const text = brief ? `${brief}${FIRST_MESSAGE_SEPARATOR}${body}` : body;
  const size = bytes(text);
  if (size > MAX_FIRST_MESSAGE) {
    return refuse('too_long', `This member’s instructions and the task come to ${size} bytes, and a session’s first message is at most ${MAX_FIRST_MESSAGE}. Shorten the brief, or the member’s instructions.`);
  }
  return { ok: true, text };
}

/** A result, said in a few lines: what `fleet_delegate` answers with and a push carries the first line of. */
export function packetWords(/** @type {Task} */ task) {
  const r = task.result;
  if (!r) return '';
  const said = { done: 'DONE', blocked: 'BLOCKED', failed: 'FAILED', unstated: 'came back without saying DONE, BLOCKED or FAILED' }[r.outcome];
  return [
    `${task.id} “${task.title}”, worked on by ${r.member}: ${said}.`,
    `Session ${r.session} on ${r.hostId}. Branch ${task.branch}${task.repo ? ` in ${task.repo}` : ''}, as the session was told: nothing here checked that it exists.`,
    '',
    r.summary + (r.truncated ? `\n\n(The result was longer than ${MAX_RESULT} bytes and is cut here. The whole of it is ${RESULT_FILE} in the session’s workspace.)` : ''),
  ].join('\n');
}
