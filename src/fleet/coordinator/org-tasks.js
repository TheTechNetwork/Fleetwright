// The fleet's tasks: the record above sessions, who may change one, and the
// lock that says which session is working on it (docs/tasks.md).
//
// THE RULES ARE NOT HERE. What a task is, and every change one can go
// through, is src/fleet/protocol/tasks.js, as pure functions. This file is
// the store around them: ids, who may see and change what, and which rows to
// write.
//
// WHO. Whoever made a task, a fleet admin, and anybody who acts for its
// assignee: the members the tree puts under them and the ones they may start
// as (`acts`, which the core works out from org-members.js and the minter's
// list). Assigning a task to a member needs the same standing over that
// member, because an assignment is the step before a start.
//
// WHAT THIS IS NOT IS THE CHECK A BOX RELIES ON. A session on a task is a
// member start, signed by a custodian and checked by the box against the
// minter's list (docs/members.md). The lock here keeps two people from
// starting the same work; it is this coordinator's word and no more.
//
// ONE DURABLE OBJECT VALUE A TASK, under `tasks:<id>`, for the reason members
// are: a value holds 128 KiB, and a task with its brief, result and handoffs
// is up to about 20. The counter that numbers them is its own value, so an
// id is never used twice whatever was trimmed.
//
// NEVER THROWS. Every refusal is a code and a sentence.

import {
  checkTask, checkNote, newTask, changeTask, routeTask, lockTask, confirmLock, expireLock, releaseLock, returnTask, actOn, startFor,
  TASK_ID_RE, TASK_STATES, MAX_TASKS,
} from '../protocol/tasks.js';
import { cleanTurn } from '../protocol/engines.js';
import { cleanRoute } from '../protocol/routing.js';

/**
 * How long the box an unanswered start was sent to may still take the task
 * up (onSession). A day: a session that did start may work for hours before
 * it first comes back to its prompt, and past this the start is somebody's
 * to make again.
 */
export const TASK_SENT_KEPT_MS = 24 * 60 * 60_000;

/** The prefix a task's row is stored under. */
export const TASKS_PREFIX = 'tasks:';
/** The key the counter that numbers tasks is stored under. Not under the prefix, so a listing of rows is rows. */
export const TASKS_SEQ_KEY = 'taskSeq';

/** @typedef {import('../protocol/tasks.js').Task} Task */
/**
 * Who is asking, as the core hands it over: their address, whether they
 * administer the fleet, and the members they act for.
 *
 * @typedef {{ email: string, admin: boolean, acts: string[] }} Who
 */

/** @param {string} code @param {string} text */
const refuse = (code, text) => /** @type {const} */ ({ ok: false, error: { code }, text });
/** @param {{ ok: false, code: string, text: string }} r */
const refused = (r) => refuse(r.code, r.text);

export class OrgTasks {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, Task>} in the order they were made */
    this.byId = new Map();
    /** The last number given out. */
    this.seq = 0;
    /** @type {Set<string>} ids written or removed since takeChanges was last called */
    this.dirty = new Set();
    this.seqDirty = false;
  }

  /** @param {unknown} id @returns {Task|null} */
  get(id) {
    return this.byId.get(String(id ?? '').trim().toLowerCase()) ?? null;
  }

  /** @returns {Task[]} */
  all() {
    return [...this.byId.values()];
  }

  /** @param {Who} who @param {Task} task */
  maySee(who, task) {
    return who.admin || (Boolean(who.email) && task.createdBy === who.email) || (task.assignee !== null && who.acts.includes(task.assignee));
  }

  /**
   * The tasks this person may see, newest first, and those of one state when
   * asked.
   *
   * @param {Who} who @param {{ state?: string|null }} [filter]
   */
  visibleTo(who, { state = null } = {}) {
    const wanted = state && TASK_STATES.includes(/** @type {any} */ (state)) ? state : null;
    return this.all().filter((t) => this.maySee(who, t) && (!wanted || t.state === wanted)).reverse();
  }

  /**
   * One task, for somebody who may see it. A task they may not see answers
   * as one that does not exist, so a number cannot be tried for whether
   * somebody else's work is there.
   *
   * @param {Who} who @param {unknown} id
   * @returns {{ ok: true, task: Task } | { ok: false, error: { code: string }, text: string }}
   */
  find(who, id) {
    const task = this.get(id);
    if (!task || !this.maySee(who, task)) return refuse('no_task', `There is no task ${TASK_ID_RE.test(String(id ?? '').toLowerCase()) ? String(id).toLowerCase() : 'by that id'} that you can see.`);
    return { ok: true, task };
  }

  /** @param {Task} task */
  #keep(task) {
    this.byId.set(task.id, task);
    this.dirty.add(task.id);
  }

  /**
   * Room for one more: past the cap the oldest finished task goes, and a
   * fleet whose every task is unfinished is refused.
   */
  #makeRoom() {
    if (this.byId.size < MAX_TASKS) return true;
    const oldest = this.all().find((t) => t.state === 'done' || t.state === 'cancelled');
    if (!oldest) return false;
    this.byId.delete(oldest.id);
    this.dirty.add(oldest.id);
    return true;
  }

  /**
   * What somebody refused at the cap is told: whose the tasks are, how many
   * of them this person can clear, and who can clear the rest.
   *
   * "Accept or cancel some first" was all it said, to somebody who could see
   * none of them: one person with no team made five hundred, and a manager
   * was then told to clear tasks her own list did not show. A task is seen
   * by whoever made it, whoever acts for its assignee, and an admin, so
   * those are the people named.
   *
   * @param {Who} who
   */
  #fullWords(who) {
    /** @type {Map<string, number>} */
    const made = new Map();
    for (const t of this.all()) made.set(t.createdBy || 'nobody named', (made.get(t.createdBy || 'nobody named') ?? 0) + 1);
    const most = [...made].sort((a, b) => b[1] - a[1]);
    const named = most.slice(0, 3).map(([by, n]) => `${by} made ${n}`);
    const rest = most.slice(3).reduce((sum, [, n]) => sum + n, 0);
    const yours = this.all().filter((t) => this.maySee(who, t)).length;
    return (
      `The fleet keeps ${MAX_TASKS} tasks and every one of them is unfinished, so there is no room for another. ` +
      `${named.join(', ')}${rest ? `, and others made ${rest}` : ''}. ` +
      `${yours ? `${yours === MAX_TASKS ? 'All of them are' : `${yours} of them ${yours === 1 ? 'is' : 'are'}`} on your own list, to accept or cancel. ` : 'None of them is on your list. '}` +
      'A task is accepted or cancelled by whoever made it, by whoever acts for its assignee, or by a fleet admin, whose list shows every task.'
    );
  }

  /**
   * @param {Who} who @param {unknown} input
   * @param {(id: string) => { name: string }|null} member  the member by that id, or null
   * @returns {{ ok: true, task: Task, text: string } | { ok: false, error: { code: string }, text: string }}
   */
  create(who, input, member) {
    if (!who.email) return refuse('not_signed_in', 'Making a task needs a signed-in identity: a task says who made it.');
    const checked = checkTask(input);
    if (!checked.ok) return refused(checked);
    const fields = checked.fields;
    const standing = this.#mayAssign(who, fields.assignee ?? null, member);
    if (!standing.ok) return standing;
    if (fields.parent) {
      // A parent the person cannot see is one they cannot hang work off.
      const parent = this.find(who, fields.parent);
      if (!parent.ok) return refuse('no_task', `There is no task ${fields.parent} that you can see, so nothing can be delegated from it.`);
    }
    if (!this.#makeRoom()) return refuse('too_many', this.#fullWords(who));
    const at = this.now();
    this.seq += 1;
    this.seqDirty = true;
    const task = newTask({ id: `t${this.seq}`, title: fields.title ?? '', brief: fields.brief ?? '', ...fields }, { by: who.email, at });
    this.#keep(task);
    if (task.parent) {
      const parent = this.byId.get(task.parent);
      if (parent) this.#keep({ ...parent, handoffs: [...parent.handoffs, { at, by: who.email, kind: 'delegated', to: task.assignee, task: task.id }].slice(-50), updatedAt: at });
    }
    return { ok: true, task, text: `Made ${task.id}${task.assignee ? `, assigned to ${task.assignee}` : ', assigned to nobody yet'}. Its branch is ${task.branch}.` };
  }

  /**
   * @param {Who} who @param {string|null} assignee
   * @param {(id: string) => { name: string }|null} member
   * @returns {{ ok: true } | { ok: false, error: { code: string }, text: string }}
   */
  #mayAssign(who, assignee, member) {
    if (assignee === null) return { ok: true };
    const m = member(assignee);
    if (!m) return refuse('no_member', `There is no member called ${assignee}. fleet_members lists them.`);
    if (!who.admin && !who.acts.includes(assignee)) {
      return refuse('not_manager', `${m.name} is not on your team and is not a member you may start as, so you cannot hand them work. Whoever manages them can.`);
    }
    return { ok: true };
  }

  /**
   * A change to what a task says, or whose it is.
   *
   * @param {Who} who @param {unknown} id @param {any} input
   * @param {(id: string) => { name: string }|null} member
   * @returns {{ ok: true, task: Task, moved: boolean, text: string } | { ok: false, error: { code: string }, text: string }}
   */
  change(who, id, input, member) {
    const found = this.find(who, id);
    if (!found.ok) return found;
    const checked = checkTask(input, { partial: true });
    if (!checked.ok) return refused(checked);
    const { parent: _never, ...fields } = checked.fields;
    const note = checkNote(input?.note);
    if (!note.ok) return refused(note);
    if (fields.assignee !== undefined && fields.assignee !== found.task.assignee) {
      const standing = this.#mayAssign(who, fields.assignee, member);
      if (!standing.ok) return standing;
    }
    const next = changeTask(found.task, fields, { by: who.email || 'an admin', at: this.now(), note: note.note });
    if (!next.ok) return refused(next);
    this.#keep(next.task);
    const moved = next.task.assignee !== found.task.assignee;
    return { ok: true, task: next.task, moved, text: moved ? `${next.task.id} is ${next.task.assignee ? `now ${next.task.assignee}’s` : 'assigned to nobody'}.` : `Saved ${next.task.id}.` };
  }

  /**
   * Write a routing decision on a task the person can see (docs/routing.md).
   * The core made the decision; this holds it to a decision's shape and to
   * the task's state, and keeps it.
   *
   * @param {Who} who @param {unknown} id @param {unknown} decision
   * @returns {{ ok: true, task: Task } | { ok: false, error: { code: string }, text: string }}
   */
  route(who, id, decision) {
    const found = this.find(who, id);
    if (!found.ok) return found;
    const next = routeTask(found.task, decision);
    if (!next.ok) return refused(next);
    this.#keep(next.task);
    return { ok: true, task: next.task };
  }

  /**
   * A person's answer to "which member": an assignment by hand, checked as
   * one, and written down as the answer to the question.
   *
   * @param {Who} who @param {unknown} id @param {string} memberId
   * @param {(id: string) => { name: string }|null} member
   * @param {Record<string, unknown>} decision  the rest of the route record
   * @returns {{ ok: true, task: Task } | { ok: false, error: { code: string }, text: string }}
   */
  answer(who, id, memberId, member, decision) {
    const found = this.find(who, id);
    if (!found.ok) return found;
    const standing = this.#mayAssign(who, memberId, member);
    if (!standing.ok) return standing;
    const next = routeTask(found.task, { ...decision, how: 'person', member: memberId });
    if (!next.ok) return refused(next);
    this.#keep(next.task);
    return { ok: true, task: next.task };
  }

  /**
   * Release, accept, reopen or cancel.
   *
   * @param {Who} who @param {unknown} id @param {unknown} action @param {unknown} note
   * @returns {{ ok: true, task: Task, text: string } | { ok: false, error: { code: string }, text: string }}
   */
  act(who, id, action, note) {
    const found = this.find(who, id);
    if (!found.ok) return found;
    const said = checkNote(note);
    if (!said.ok) return refused(said);
    const next = actOn(found.task, String(action ?? ''), { by: who.email || 'an admin', at: this.now(), note: said.note });
    if (!next.ok) return refused(next);
    this.#keep(next.task);
    const t = next.task;
    const text = {
      // A task that had come back keeps its result and its state: saying
      // "open again" beside "Came back: done" would be two answers.
      release: t.state === 'open'
        ? `Released ${t.id}. It is open again; the session that held it is not stopped by this.`
        : `Released ${t.id} from its session, which is not stopped by this. It is still ${t.state === 'returned' ? 'back with its result, to accept or reopen' : t.state}.`,
      accept: `${t.id} is done.`,
      reopen: `${t.id} is open again, and its next session is told why.`,
      cancel: `${t.id} is cancelled. A session still working on it is not stopped by this.`,
    }[String(action)] ?? `Saved ${t.id}.`;
    return { ok: true, task: t, text };
  }

  /**
   * Take the lock for a start about to be sent to a box.
   *
   * @param {Who} who @param {unknown} id
   * @param {{ member: string, branch: string, hostId: string }} start
   * @returns {{ ok: true, task: Task } | { ok: false, error: { code: string }, text: string }}
   */
  lock(who, id, { member, branch, hostId }) {
    const found = this.find(who, id);
    if (!found.ok) return found;
    const next = lockTask(found.task, { member, branch, hostId, by: who.email || 'an admin', at: this.now() });
    if (!next.ok) return refused(next);
    this.#keep(next.task);
    return { ok: true, task: next.task };
  }

  /**
   * The box answered: the session is this one. Null when the lock is no
   * longer the start's to confirm (released by hand while the box thought).
   *
   * @param {string} id @param {{ session: string, hostId: string }} held
   * @returns {Task|null}
   */
  confirm(id, { session, hostId }) {
    const task = this.byId.get(id);
    if (!task?.lock || task.lock.hostId !== hostId || task.lock.session) return null;
    const next = confirmLock(task, { session, hostId, at: this.now() });
    this.#keep(next);
    return next;
  }

  /**
   * A start that a box refused, or that never reached one: the lock it took
   * is dropped and nothing is written down as a change of hands.
   *
   * @param {string} id @param {string} hostId
   */
  unlock(id, hostId) {
    const task = this.byId.get(id);
    if (!task?.lock || task.lock.session || task.lock.hostId !== hostId) return;
    this.#keep(releaseLock(task, { by: task.lock.by, at: this.now(), quiet: true }));
  }

  /**
   * A start whose box never answered, past the time its lock is held for.
   * Not `unlock`: that box was sent the task and may be running it, so which
   * box it was is kept, and its word alone can take the task up again.
   *
   * @param {string} id @param {string} hostId
   */
  expire(id, hostId) {
    const task = this.byId.get(id);
    if (!task?.lock || task.lock.session || task.lock.hostId !== hostId) return;
    this.#keep(expireLock(task, { at: this.now() }));
  }

  /**
   * A box said something about a session it holds for a task.
   *
   *  - Back at its prompt with a result: the task returns.
   *  - Back at its prompt with none: the lock notes when, so a page can say
   *    the session stopped and wrote nothing. That is not a result.
   *  - Ended or failed: the lock ends. A task still being worked on is open
   *    again.
   *
   * A session the coordinator never heard start (its reply timed out) is
   * taken up here: the box holds it, and the box's word is what a lock
   * follows. ONLY THE BOX THE START WAS SENT TO. A task with no lock is
   * taken up by nobody else, whatever they say they hold: that was any
   * connected box, which could name a task it had never been sent and have
   * its own words filed as the assignee's result.
   *
   * @param {string} hostId @param {string} session
   * @param {{ event: string, task: string, result?: { text: string, truncated?: boolean }|null, turn?: import('../protocol/engines.js').TurnEnded|null }} said
   *   `turn` is how the session's engine said its turn ended, when it said (docs/engines.md)
   * @returns {{ task: Task, returned: boolean, released: boolean }|null}  null when it changes nothing
   */
  onSession(hostId, session, { event, task: id, result = null, turn = null }) {
    let task = this.byId.get(id);
    if (!task || task.state === 'done' || task.state === 'cancelled') return null;
    const at = this.now();
    const lock = task.lock;
    if (lock && (lock.hostId !== hostId || (lock.session && lock.session !== session))) return null;
    if (event === 'session.ended' || event === 'session.error') {
      if (!lock) return null;
      const was = task.state;
      task = releaseLock(lock.session ? task : { ...task, lock: { ...lock, session } }, {
        by: lock.member,
        at,
        note: event === 'session.error' ? 'its session failed with no result' : 'its session ended with no result',
      });
      this.#keep(task);
      return { task, returned: false, released: was === 'working' };
    }
    if (event !== 'session.ready') return null;
    if (!lock) {
      // NO LOCK: the box an unanswered start went to, while the task is
      // still open and still its member's, and nobody else.
      const sent = task.sent;
      if (task.state !== 'open' || !sent || sent.hostId !== hostId || sent.member !== task.assignee || at - sent.at > TASK_SENT_KEPT_MS) return null;
      task = confirmLock(task, { session, hostId, member: sent.member, by: sent.by, at });
    } else if (!lock.session) {
      task = confirmLock(task, { session, hostId, at });
    }
    if (task.state !== 'working') return null;
    if (result && typeof result.text === 'string' && result.text.trim()) {
      task = returnTask(task, { text: result.text, truncated: result.truncated === true, session, hostId, at });
      this.#keep(task);
      return { task, returned: true, released: false };
    }
    // And why it stopped, when its engine said and it was not simply done:
    // which engine, the reason, and when a limit lifts.
    const stopped = turn && turn.reason !== 'done' ? { stopped: { engine: turn.engine, reason: turn.reason, ...(turn.resetsAt ? { resetsAt: turn.resetsAt } : {}) } } : {};
    task = { ...task, lock: { .../** @type {NonNullable<Task['lock']>} */ (task.lock), readyAt: at, ...stopped }, updatedAt: at };
    this.#keep(task);
    return { task, returned: false, released: false };
  }

  /**
   * The box moved a task's session from one of its member's engines to the
   * next (docs/engines.md, "At a limit"). Written on the task as a change of
   * hands: the work is the same member's, on another provider's account.
   * Only the lock's own session, on its own box, may say so.
   *
   * @param {string} hostId @param {string} session
   * @param {{ task: string, from: string, to: string, reason: string }} moved
   * @returns {boolean} whether the task changed
   */
  onEngine(hostId, session, { task: id, from, to, reason }) {
    const task = this.byId.get(id);
    const lock = task?.lock;
    if (!task || !lock || lock.hostId !== hostId || lock.session !== session) return false;
    const at = this.now();
    // The session is working again, so a note that it had stopped goes.
    const { readyAt: _r, stopped: _s, ...held } = /** @type {any} */ (lock);
    this.#keep({
      ...task,
      lock: held,
      handoffs: [...task.handoffs, { at, by: lock.member, kind: 'engine', from, to, session, hostId, ...(reason ? { note: reason } : {}) }].slice(-50),
      updatedAt: at,
    });
    return true;
  }

  /**
   * Locks whose session its box no longer lists. A box that is not connected,
   * or has not listed its sessions since the lock was taken, is cannot-tell
   * and its lock is kept.
   *
   * @param {(hostId: string) => { names: Set<string>, at: number }|null} listed  the box's last list of sessions and when it sent it, or null
   * @param {number} graceMs  how long after a start a list may still be the one from before it
   * @returns {Task[]} the tasks released
   */
  sweep(listed, graceMs) {
    /** @type {Task[]} */
    const released = [];
    for (const task of this.all()) {
      const lock = task.lock;
      if (!lock?.session) continue;
      const seen = listed(lock.hostId);
      if (!seen || seen.at < lock.at + graceMs || seen.names.has(lock.session)) continue;
      const next = releaseLock(task, { by: lock.member, at: this.now(), note: `${lock.hostId} no longer lists its session` });
      this.#keep(next);
      released.push(next);
    }
    return released;
  }

  /**
   * What changed since this was last asked, as Durable Object rows.
   *
   * @returns {{ put: Record<string, Task>, del: string[], seq: number|null }}
   */
  takeChanges() {
    /** @type {Record<string, Task>} */
    const put = {};
    /** @type {string[]} */
    const del = [];
    for (const id of this.dirty) {
      const t = this.byId.get(id);
      if (t) put[`${TASKS_PREFIX}${id}`] = t;
      else del.push(`${TASKS_PREFIX}${id}`);
    }
    this.dirty.clear();
    const seq = this.seqDirty ? this.seq : null;
    this.seqDirty = false;
    return { put, del, seq };
  }

  /** Every task and the counter, for a store that keeps one value (the Node coordinator's state file). */
  serialise() {
    return { seq: this.seq, tasks: this.all() };
  }

  /**
   * Anything that does not read as a task is dropped. The counter is never
   * taken below the highest id that came back.
   *
   * @param {unknown} rows  an array, or what `storage.list({ prefix })` gives
   * @param {unknown} [seq]
   */
  restore(rows, seq) {
    const list = rows instanceof Map ? [...rows.values()] : Array.isArray(rows) ? rows : [];
    /** @type {Task[]} */
    const read = [];
    for (const row of list) {
      const task = readTask(row);
      if (task) read.push(task);
    }
    read.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    for (const task of read.slice(-MAX_TASKS)) this.byId.set(task.id, task);
    const highest = read.length ? Number(read[read.length - 1].id.slice(1)) : 0;
    const kept = Number.isSafeInteger(Number(seq)) && Number(seq) > 0 ? Number(seq) : 0;
    this.seq = Math.max(highest, kept);
  }
}

/**
 * A stored row, read back as a task or not at all. The fields a person wrote
 * go through the checks a new task does; the rest are taken only in the
 * shapes this file writes.
 *
 * @param {any} row
 * @returns {Task|null}
 */
function readTask(row) {
  if (!row || typeof row !== 'object' || !TASK_ID_RE.test(String(row.id ?? ''))) return null;
  const checked = checkTask(row);
  if (!checked.ok) return null;
  if (!TASK_STATES.includes(row.state)) return null;
  const made = newTask({ id: row.id, title: checked.fields.title ?? '', brief: checked.fields.brief ?? '', ...checked.fields }, { by: String(row.createdBy || ''), at: Number(row.createdAt) || 0 });
  const text = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '');
  const lock = row.lock && typeof row.lock === 'object' && typeof row.lock.hostId === 'string'
    ? { session: typeof row.lock.session === 'string' ? row.lock.session : null, hostId: row.lock.hostId, member: text(row.lock.member), by: text(row.lock.by), at: Number(row.lock.at) || 0, ...(Number(row.lock.readyAt) ? { readyAt: Number(row.lock.readyAt) } : {}), ...(cleanTurn(row.lock.stopped) ? { stopped: { engine: row.lock.stopped.engine, reason: row.lock.stopped.reason, ...(Number(row.lock.stopped.resetsAt) > 0 ? { resetsAt: Number(row.lock.stopped.resetsAt) } : {}) } } : {}) }
    : null;
  const result = row.result && typeof row.result === 'object' && typeof row.result.summary === 'string'
    ? {
        outcome: ['done', 'blocked', 'failed'].includes(row.result.outcome) ? row.result.outcome : 'unstated',
        summary: row.result.summary,
        truncated: row.result.truncated === true,
        session: text(row.result.session),
        hostId: text(row.result.hostId),
        member: text(row.result.member),
        at: Number(row.result.at) || 0,
      }
    : null;
  const note = checkNote(row.note);
  return {
    ...made,
    // The branch is the one it was made with, whatever its title is now.
    branch: typeof row.branch === 'string' && row.branch.startsWith(`task/${row.id}`) ? row.branch : made.branch,
    state: row.state,
    ...(note.ok && note.note ? { note: note.note } : {}),
    // The last routing decision, read back as one or not at all (routing.js).
    ...(cleanRoute(row.route) ? { route: /** @type {import('../protocol/routing.js').Route} */ (cleanRoute(row.route)) } : {}),
    lock: row.state === 'done' || row.state === 'cancelled' ? null : lock,
    ...(row.state === 'open' && !lock && row.sent && typeof row.sent === 'object' && typeof row.sent.hostId === 'string'
      ? { sent: { hostId: row.sent.hostId, member: text(row.sent.member), by: text(row.sent.by), at: Number(row.sent.at) || 0 } }
      : {}),
    result,
    handoffs: Array.isArray(row.handoffs) ? row.handoffs.filter((/** @type {any} */ h) => h && typeof h === 'object' && typeof h.kind === 'string').slice(-50) : made.handoffs,
    updatedAt: Number(row.updatedAt) || made.createdAt,
  };
}

/** What each refusal answers with. Anything not here is a 400. */
const STATUS = Object.freeze({ not_signed_in: 403, not_manager: 403, no_task: 404, no_member: 404, task_locked: 409, task_not_open: 409, task_not_returned: 409, task_not_locked: 409, task_closed: 409, too_many: 409, task_pinned: 409, routing_off: 409 });

/**
 * The `/api/tasks` routes, for both coordinators, so the Worker's and the
 * Node one's cannot come to differ:
 *
 *   GET    /api/tasks            the ones the person may see; ?state= narrows it
 *   POST   /api/tasks            { title, brief, assignee?, workType?, repo?, parent? }
 *   GET    /api/tasks/{id}       the task, and what to sign to start it
 *   PUT    /api/tasks/{id}       { title?, brief?, workType?, repo?, assignee?, note? }
 *   POST   /api/tasks/{id}/act   { action, note? }
 *   POST   /api/tasks/{id}/route { member? }   route it now, or answer who it goes to (docs/routing.md)
 *
 * @param {{ tasksFor: Function, taskFor: Function, createTask: Function, changeTask: Function, actOnTask: Function, routeTask: Function }} core
 * @param {string|undefined} method @param {string} pathname @param {URLSearchParams|null} query
 * @param {{ email?: string|null, admin?: boolean }|null} requester
 * @param {() => Promise<any>} readBody
 * @returns {Promise<{ status: number, body: any }|null>} null for a path or method this does not serve
 */
export async function tasksRoute(core, method, pathname, query, requester, readBody) {
  /** @param {any} r */
  const said = (r) => ({ status: r.ok ? 200 : (STATUS[/** @type {keyof typeof STATUS} */ (r.error?.code)] ?? 400), body: r });
  if (pathname === '/api/tasks') {
    if (method === 'GET') return said(core.tasksFor(requester, { state: query?.get('state') ?? null }));
    if (method === 'POST') {
      // A task whose routing left a pick for the model is answered once the
      // model has been asked, so the reply says who it went to, or who is
      // being asked (docs/routing.md).
      const made = core.createTask(requester, await readBody());
      if (!made.ok || !made.routePending) return said(made);
      const { routePending: _pending, ...rest } = made;
      const routed = await core.routeTask(requester, made.task.id, {});
      return said(routed.ok ? { ...rest, task: routed.task, start: routed.start, text: `${rest.text} ${routed.text}`.trim() } : rest);
    }
    return null;
  }
  const rest = pathname.slice('/api/tasks/'.length).split('/');
  /** @type {string} */
  let id;
  try {
    id = decodeURIComponent(rest[0] ?? '');
  } catch {
    return said(refuse('no_task', 'That is not a task’s id.'));
  }
  if (rest.length === 1) {
    if (method === 'GET') return said(core.taskFor(requester, id));
    if (method === 'PUT') return said(core.changeTask(requester, id, await readBody()));
    return null;
  }
  if (rest.length === 2 && rest[1] === 'act' && method === 'POST') {
    const body = await readBody();
    return said(core.actOnTask(requester, id, body?.action, body?.note));
  }
  if (rest.length === 2 && rest[1] === 'route' && method === 'POST') {
    const body = await readBody();
    return said(await core.routeTask(requester, id, { member: body?.member }));
  }
  return null;
}

export { startFor };
