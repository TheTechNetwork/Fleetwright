# Tasks: work that outlives a session

> Fleetwright hands whole tasks to the right member, the way a session hands
> work to subagents, but with full agents.

A session is a conversation on one box. It has no idea what it is for, who
asked, or whether it came back with anything. Before this, the only record of
a job handed over was `tasked: true` on the session and whatever its log said.

A **task** is a record above sessions. It has a title, a short brief, one
assignee, a branch of its own, a lock that says which session is working on it
now, a result when one comes back, and a list of every time it changed hands.
A session is started **on** a task, as the task's assignee
([members.md](./members.md)), and the box reports what the session wrote down
when it stopped.

This is step 3 of the organization work. Engines other than Claude Code and
the handoff when one hits a limit are step 4, choosing the assignee by rule or
by model is step 5, and budgets are step 6 ([ROADMAP.md](../ROADMAP.md)).
Nothing here runs unless somebody makes a task.

## A task

| field | what it holds | bound |
|---|---|---|
| `id` | `t` and a number, counted up by the coordinator | never reused |
| `title` | one line | at most 120 characters |
| `brief` | what to do, where, and what to hand back, as markdown | at most 2400 bytes |
| `note` | why it was reopened, told to the next session | at most 300 bytes |
| `workType` | the kind of work, a slug as on a member | optional |
| `repo` | `owner/repo` the work is in | optional |
| `assignee` | one member's id, or nobody | one, never a list |
| `state` | `open`, `working`, `returned`, `done` or `cancelled` | |
| `branch` | `task/<id>-<the title as a slug>` | set when the task is made, never changed |
| `parent` | the task this one was delegated from | optional |
| `lock` | the session working on it: `{ session, hostId, member, by, at }`, with `readyAt` once that session is back at its prompt with no result, `unheardSince` on a start nobody answered once the wait for it is over and its machine has not been heard from, and, as a screen is sent it, `connected`: whether its machine is connected now | one, or none |
| `result` | what came back: `{ outcome, summary, session, hostId, member, at, truncated }` | the summary is at most 4000 bytes |
| `routing` | this task's own routing mode, `auto`, `manual` or `off` ([routing.md](./routing.md)) | optional; absent follows the fleet's |
| `route` | the last routing decision about it: how, who, among whom, and why | set by the coordinator |
| `handoffs` | every change of hands, oldest first, every change of the kind of work (`work-type`, where `from` and `to` are kinds of work), and every change of the title or brief (`words`, where `note` says which) | the last 50 |
| `createdBy`, `createdAt`, `updatedAt` | who made it, and when | set by the coordinator |

**No credential is ever in a task.** A brief and a result are words a person
or a session wrote, and the record has no field for anything else.

Tasks are kept by the coordinator (`src/fleet/coordinator/org-tasks.js`), one
Durable Object value a task under `tasks:<id>`, for the reason members are:
a value holds 128 KiB. A fleet keeps 500. Past that the oldest task that is
`done` or `cancelled` goes, and a fleet with 500 unfinished tasks is refused a
new one. The refusal says who made how many of them, how many are on the
asker's own list to accept or cancel, and who can clear the rest: whoever
made a task, whoever acts for its assignee, or a fleet admin, whose list
shows every task.

The brief is short on purpose. A task is handed over as a fresh brief and
never as a transcript: the largest member's instructions (4 KiB) and the
largest brief fit one first message (8000 bytes) with the lines the box adds,
and `test/tasks.test.js` measures that they do.

## Who sees and changes one

- **Sees it**: whoever made it, a fleet admin, and anybody who acts for its
  assignee: the members the tree puts under them, and the ones they may start
  a session as (members.md). A task somebody may not see answers as one that
  does not exist.
- **Makes one**: anybody signed in. Assigning it to a member needs that
  standing over the member, because an assignment is the step before a start.
- **Changes, reassigns, releases, accepts, reopens or cancels it**: the same
  people who see it.
- **Its title and brief do not change while it is being worked on**
  (`task_locked`), from the start until what came back is accepted or
  reopened: they are what its session was told. A start carries the task's
  own words, and that was true at the start only. A brief was started,
  rewritten while its session worked, and the result came back under words
  the session had never seen, with nothing in the history to say so. At any
  other time a change to them is a line in `handoffs` (`words`, with which
  of the two changed).
- **Changes its kind of work, where the fleet asks about that kind**
  ([budgets.md](./budgets.md), `risky-work`): somebody who manages its
  assignee, or a fleet admin, which is who could approve a start on it. With
  no assignee, a fleet admin. The same holds for a task that was of such a
  kind, as its history shows. Taken off by anybody who could see the task,
  the kind of work was no gate: clear it, start, put it back. Every change
  of it is a line in `handoffs`.

## One assignee, one lock

A task has one assignee. Reassigning it is a handoff, written down with who
did it and their note, and it is refused while a session holds the lock: the
work in flight is released or comes back first.

**The lock is one session.** `start` takes `taskId`. The coordinator takes the
lock before it sends the start to a box, so of two people who press Start at
once the second is refused, in words that name the session, the box and since
when. The lock is confirmed with the session's name when the box answers, and
dropped if the box refuses, or if the start could not be sent to it at all
(its connection closed as the start was written), so the task is not held
for a box that was never asked. A box that does not answer in time leaves it held
for five minutes past the time its answer was waited for: its session is
taken up the moment the box speaks of it. When the hold runs out the
coordinator looks at that box's own list of sessions, the one in every report
it sends. A session running there on this task, begun since the start was
sent, is the start's, and the lock becomes that session's. Only when the box
lists none, in a list made since the start, is the start taken not to have
happened, and the task can be started again. The list used not to be looked
at: a task was offered again while its box listed the session working on it,
a second session was started on the same branch, and the first one's result
was dropped when it came back.

**A box that is away when the hold runs out is cannot-tell, and the lock is
kept.** Not connected, or connected and sending no list of its sessions, it
has said nothing either way about the start it was sent. That was read as
*lists none*: the connection that lost a start's answer is often the one
still down ten minutes later, so the task was offered again with its session
running, a second was started on another box, and the first one's result was
dropped when its box came back. The lock now stays, with `unheardSince` on
it, until that box reports (a session on the task takes the lock; a list
without one ends it) or a person releases it. While it is kept the task is
not offered to start, and a start on it is refused `task_locked` in words
that say what is not known and that Release frees it: *t12 is held for a
start that was not answered: … deb132 did not answer and has not been heard
from since, so whether a session is working on it there is not known. It is
kept until deb132 reports, which settles it either way. Release it to start
it again now. Releasing does not stop a session, if one did start there.*
A box that never comes back holds its task until somebody releases it.
Release was already there for this, on both phones wherever a task has a
lock, so nothing new had to be offered.

**Only the box a start was sent to is heard about a task.** After that hold
the coordinator still keeps which box the unanswered start went to, for a
day, and that box alone can take the task up: a session that did start may
work for hours before it first comes back. No other box's word about a task
is taken, with or without a result. Any connected box's used to be, so one
that had never been sent a task could name it (ids count up) and have its
own words filed as the assignee's result.

**The lock follows the box's word.** It ends when that box says the session
ended or failed, when the box's own list of sessions no longer has it, when
somebody releases it by hand, or when the task is accepted, reopened or
cancelled. None of those stops a session: that is `stop`, asked of its box. A box that has not been heard from is
*cannot tell*, never *released*: the task page says its box is not connected
and keeps the lock, and Release is how a person overrides it.

| from | what happens | to |
|---|---|---|
| `open` | a session is started on it | `working` |
| `working` | the session stops and its box reports a result | `returned` |
| `working` | the session ends with no result, or the lock is released | `open` |
| `returned` | the lock is released | `returned`, with its result kept |
| `returned` | somebody accepts the result | `done` |
| `returned`, `done` | somebody reopens it, with a note | `open` |
| any but `done` | somebody cancels it | `cancelled` |

## The branch

A task names one branch, `task/t12-fix-the-login-redirect`, when it is made.
Every session started on the task is told that branch and, when the task has
one, the repository. A second session on a reopened task, and in step 4 a
second engine, continue on the same branch.

**The box tells the session; it does not check the push.** A session's
workspace is its own, and whether it is a checkout of anything is the
session's business. So the branch is an instruction and a record. A task page
shows the branch as what was asked for and never as something that exists.

## Starting on a task

`start` takes `taskId`, `taskBranch`, `taskRepo` and, as it already did, the
words as `task` and the assignee as `member`. All four are signed by the
person who asks. `GET /api/tasks/{id}` returns them ready to send, so a phone
shows the brief it is about to sign and signs exactly that.

**The coordinator refuses first**, in the person's words: no such task; not
assigned; assigned to somebody else than `member` names; not open; locked; a
branch that is not the task's; words that are not the task's (`task_words`).
The words are the person's to sign, so the coordinator cannot write them. It
compares them with the task's title and brief as they are now, and a start
that carries anything else is refused before a machine is chosen. A task
changed after somebody opened it is refused the same way, and the refusal
says where the words as they are now can be read.

**And compares them again where the lock is taken.** Choosing a machine can
wait: for an approval, and in the seconds after a coordinator deploy for a
box's first report. Nothing holds the task in that wait, so it could be
rewritten in it, and a start that had passed the first comparison went on to
lock a record that no longer said what its session was told. Every one of
those refusals is made a second time in the same step as the lock, and a
start that no longer matches is refused `task_words` with nothing sent.

**The box composes the first message** (`composeTaskMessage`,
`src/fleet/protocol/tasks.js`):

```
<the member's instructions>

----------

Task t12. Branch task/t12-fix-the-login-redirect in acme/app.

<the task's title and brief>

----------

When you stop, write RESULT.md at the top of your workspace. Start its first
line with DONE, BLOCKED or FAILED. Then say what you did, what you did not do
or test, the branch and commits, and what the next person should check.
```

and refuses past 8000 bytes, as it does for a member's instructions. The
session's record keeps the task's id and branch and none of the words.

**Protocol 20.** A host older than 20 is refused a start on a task. It would
run the session, never say which task it was for, and never report a result:
a lock nothing ends and a task that never comes back.

## The result packet

When a session started on a task comes back to its prompt after working, its
box reads `RESULT.md` from the top of the session's workspace and sends it
with the event it already sent (`session.ready`). The coordinator keeps the
first 4000 bytes as the task's result, says so when it cut any, reads the
outcome off the first line, and moves the task to `returned`.

| first line starts | outcome |
|---|---|
| `DONE` | `done` |
| `BLOCKED` | `blocked` |
| `FAILED` | `failed` |
| anything else | `unstated` |

**Back at its prompt is not a result.** A session that stops with no
`RESULT.md` leaves the task `working` and its page says the session is back
at its prompt and wrote no result. Nothing is made up from its log.

**The result is the session's own account.** `returned` means it stopped and
said something, not that the work is right. Accept is a person's judgement,
or the delegating agent's.

The result is not put in the fleet's event feed. The feed gets one line: the
task's id, its title, who it came back from and the outcome. That line is
filed under the task's maker, so it is shown to them and to the fleet's
admins and to nobody else.

The person who made the task and everybody who may start as its assignee are
told when it returns, as `task.returned`.

## Delegating

`fleet_delegate` (`src/mcp/tools.js`) is the whole loop as one tool, for an
agent that wants a piece of work done by another member:

1. it makes a task from `to`, `title` and `brief`, with `parent` when the
   caller is working on a task of its own;
2. starts a session on it as the assignee, on the member's own box or tag;
3. waits for the task to return, the way `fleet_await` waits;
4. answers with the result packet: the outcome, the summary, the branch, the
   session and its box.

A wait that runs out is not a failure. The tool says the task is still being
worked on, and `fleet_delegate` with `task` set to its id picks the wait back
up. The session it started is left at its prompt: `fleet_stop` ends it, and
`fleet_task` accepts or reopens the task.

**A start that is refused takes its task with it.** The tool made the task
for that start, so when the fleet or the box refuses the start it cancels the
task and says so. Left open, each refused start was one more unfinished task,
and an agent retrying a start that could not work filled the fleet's 500.
Two answers are not a refusal, and the task stays:

- **the start waits for approval** ([budgets.md](./budgets.md)). The approval
  names the task, and `fleet_start` with `taskId` starts it once a person has
  given it;
- **the box did not answer in time.** It may have started the session all the
  same. The tool says that it cannot tell, and how to look.

The brief is all the other member gets. Nothing of the caller's conversation
travels, which is the point: a brief that only makes sense with the
transcript beside it is a brief to rewrite.

**It acts as the person the MCP connection belongs to.** They must be allowed
to start as the member, and the start is signed or delegated as any member
start is (members.md, "Starting as a member"). A member's own session
delegates onward only where that session has the fleet's MCP connected, and
then with that person's rights.

## Where it shows

```
GET    /api/tasks              { tasks }             the ones you may see
POST   /api/tasks              { title, brief, assignee?, workType?, repo?, parent?, routing? }
GET    /api/tasks/{id}         { task, start }       start is what to sign, or null
PUT    /api/tasks/{id}         { title?, brief?, workType?, repo?, assignee?, note?, routing? }
POST   /api/tasks/{id}/act     { action: release | accept | reopen | cancel, note? }
POST   /api/tasks/{id}/route   { member? }           routing.md
```

- **MCP**: `fleet_tasks` lists or reads, `fleet_task` makes, changes and acts,
  `fleet_delegate` is above, and `fleet_start` takes `taskId`.
- **Both phones**: a **Tasks** screen, with the ones that have come back
  first, because those are asking a question; a task's page with its brief,
  assignee, branch, the session that holds it, its result and its handoffs;
  New task; and Start, Reassign, Release, Accept, Reopen and Cancel, each
  offered only where it would be taken.

## What it does not stop

- **The coordinator keeps briefs and results**, as it keeps members'
  instructions. A session told to write a secret into `RESULT.md` will, and
  the coordinator will hold it.
- **The words a person signs are the words their device showed.** A
  compromised coordinator can show a phone a brief that is not the one on
  record. It cannot change the words after they are signed.
- **A result is unchecked.** A session can write `DONE` over work it did not
  do, and a `RESULT.md` left in a resumed session's workspace from an earlier
  run is reported as this run's until the session writes a new one.
- **The lock is the coordinator's.** A compromised coordinator can start two
  sessions on one task. Each is still a signed member start.

## Tests

`test/tasks.test.js` (records, the branch, the changes a task goes through,
the first message and its size, the outcome line),
`test/tasks-coordinator.test.js` (who sees and changes what, the lock under
two starts, the lock following the box, the result, the routes, the Durable
Object round trip, the protocol 19 refusal), "a session on a task" in
`test/vault.test.js` (a signed start through a real box, and what it hands
the session manager), `test/tasks-host.test.js` (the session manager's door
and record), the two task tests in `test/watcher.test.js` (what is read and
sent when a session comes back), `test/tasks-mcp.test.js` (the tools,
against the real routes), and `test/tasks-in-apps.test.js`.
