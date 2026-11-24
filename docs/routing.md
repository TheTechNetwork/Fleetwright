# Routing: which member a task goes to

> A pinned member, then the owner's rules by kind of work, then a pick among
> the members allowed: by a model, or by a person on their phone.

Before this a task had the assignee somebody gave it, or nobody
([tasks.md](./tasks.md)). A task with nobody stayed that way until a person
opened it and chose.

Now a task with no assignee can be **routed**: the fleet works out which
member it should go to, in a fixed order, and writes down how it decided.
Routing chooses a member and nothing else. It starts no session, signs
nothing and moves no credential.

This is step 5 of the organization work ([ROADMAP.md](../ROADMAP.md)). It is
**off until an admin turns it on**: a fleet that sets nothing has no rules,
asks nobody and calls no model, and its tasks behave exactly as before.
Budgets, which will take a member out of the running when its month is
spent, are step 6.

## The order

For a task with no assignee, in this order, stopping at the first that
answers:

1. **Pinned.** A task somebody gave an assignee is that member's. Routing
   never moves it, in any mode.
2. **The owner's rule for this kind of work.** The task's `workType` against
   the fleet's rules, one member a kind.
3. **The only one.** Among the members allowed (below), exactly one takes
   this kind of work.
4. **A pick among several.** In `auto`, the fleet's model chooses one of
   them. In `manual`, or when the model is off, refuses, or answers with
   anybody who is not on the list, the person who made the task is asked on
   their phone.
5. **Nobody.** No member allowed takes this kind of work. The task stays
   unassigned and says so.

## Who is allowed

**Only a member the task's maker could have assigned it to by hand**: one
they manage or may start as, or anybody for a fleet admin
([members.md](./members.md), "The tree, and who manages whom"). Routing is a
shortcut for a choice that person already has. It is never a way to put work
on a member they could not have given it to, so a rule naming a member
outside the maker's reach is passed over for that task, and the record says
it was.

Among those, **a member takes a kind of work when its `workTypes` names
it**. A task with no `workType` has no rule to match, and every allowed
member is a candidate for it.

## The setting, and the toggle on a task

The fleet has one routing record, written by an admin and read by everybody:

| field | what it holds | bound |
|---|---|---|
| `mode` | `off`, `manual` or `auto` | `off` until set |
| `rules` | `{ workType, member }`, one a kind of work | at most 40 |
| `updatedBy`, `updatedAt` | who changed it last, and when | set by the coordinator |

A task may carry its own `routing`: `auto`, `manual` or `off`. Left unset,
the task follows the fleet's mode. Set, it is that task's mode whatever the
fleet's is, because a person asked for it on that one task. So a fleet that
is `off` routes only the tasks somebody marked, and a fleet that is `auto`
leaves alone the one task marked `off`.

- `off`: nothing is routed. A task with nobody stays with nobody.
- `manual`: the rules and the only-one case assign by themselves. A pick
  among several is always a person's.
- `auto`: the same, and a pick among several is the model's when the fleet
  has one.

## When it runs

- When a task is made with no assignee and its mode is not `off`.
- When somebody asks: `POST /api/tasks/{id}/route` with no body routes it
  now, under its mode. Only an open task that nobody holds can be routed.
- When the person who was asked answers: the same route with
  `{ member }`. That is an assignment by hand, checked as one, and written
  down as the answer to the question.

Routing does not run again by itself. A task released or reopened keeps its
assignee, and one unassigned by hand stays unassigned until somebody asks.

## What is written on the task

Every decision, including the ones that assigned nobody.

`task.route` is the last one:

| field | what it holds |
|---|---|
| `how` | `pinned`, `rule`, `only`, `model`, `person`, `waiting` or `nobody` |
| `member` | who it chose, or nobody |
| `mode` | the mode it ran under |
| `candidates` | the members it chose among, at most 12 |
| `more` | how many candidates are not listed, when there were more than 12 |
| `why` | one sentence: the rule that matched, why a rule was passed over, what the model said in its own short words (marked as the model's), or what a person is being asked |
| `asked` | the address that was asked, while `how` is `waiting` |
| `at`, `by` | when, and who asked for the routing or answered it |

And each one is a line in the task's `handoffs`, kind `routed`, so the
history shows a task that was asked about twice, or that a model's pick was
later changed by hand.

## The model's pick

**Off unless the fleet's operator turns it on**, beside the decision model
the fleet already has ([decide.md](./decide.md)): the same binding, the same
one call site in the Worker, the same day's budget, and a switch of its own
(`FLEETWRIGHT_ROUTE_MODEL=1`). With it off, `auto` is `manual` and the task
says why a person was asked.

What is sent: the task's title, its kind of work and the first 600 bytes of
its brief; and for each candidate its id, role, description and kinds of
work. Nothing else: no instructions, no session, no sign-in, nobody's
address.

**A brief that reads as holding a credential is not sent.** It is held to
the same patterns a pane is before the decision model sees it
(`GATE_PATTERNS`), and a match means the person is asked instead. The brief
is not cleaned and sent.

**The answer is one of the candidates, or it is not an answer.** The model
is asked a multiple-choice question whose choices are the candidates' ids.
Anything else that comes back, and any choice below the confidence a label
needs, is no answer: the person is asked. A model cannot name a member who
was not on the list, and cannot leave a sentence of its own on the task:
`why` is the fleet's words around the member's id and the confidence as a
number.

**One ask a task, and a cap a day.** A task is put to the model once. A
second routing of the same task asks a person. At most 50 routing asks a
day reach the model, inside the decision model's own daily budget, and past
either the person is asked.

## Asking a person

`how: waiting`. The task's maker is told on their phone, with the candidates
by name. The task's page lists them, each with its role and what it is for,
and choosing one is the answer. Anybody else who could assign the task by
hand can answer too. Until somebody does, the task is open with no assignee,
which is what it would have been with routing off.

An agent that made the task through MCP is not a phone. The person it acts
for is asked, and the tool's reply says a person is being asked and names
the candidates, so the agent can also answer if it may.

## Where it shows

```
GET  /api/routing              { routing, model, you: { admin } }    model: whether a pick can be the model's
PUT  /api/routing              { mode?, rules? }                     an admin
POST /api/tasks                …, routing?                           the task's own toggle
PUT  /api/tasks/{id}           …, routing?
POST /api/tasks/{id}/route     {} to route now, { member } to answer
```

- **MCP**: `fleet_routing` reads the setting and, for an admin, changes it.
  `fleet_task` takes `routing`, and `action: "route"` with an optional
  `member`. `fleet_delegate` no longer needs a member: with none it makes
  the task, routes it, and starts the member routing chose; when a person is
  being asked it says so and starts nothing.
- **Both phones**: **Routing** under Organization, the mode in three plain
  choices and the rules, edited by an admin and read by everybody; on New
  task, "Let the fleet choose" beside the members; on a task's page, how it
  was routed in a sentence, and the candidates as choices while it waits.
- **No host is involved.** Routing happens in the coordinator before any
  start, so no protocol version changes and an old host is no different.

## What it does not stop

- **A compromised coordinator can route a task anywhere.** It keeps the
  tasks, so it could always have written any assignee. What it cannot do is
  start a session as that member: a start is signed by a person who may
  start as it, and the box checks that against the minter's list
  ([members.md](./members.md), "Starting as a member").
- **The model's pick is a guess among members a person allowed.** It reads
  a title and the top of a brief. A wrong pick costs a reassignment, which
  is why the record says the pick was the model's.
- **`workTypes` are whatever members were given.** A member whose record
  names every kind of work is a candidate for every task.
- **The top of a brief is sent to the model's provider** when the pick is
  the model's, under the same account as the coordinator. A fleet that does
  not want that leaves the switch off, or uses `manual`.

## Tests

`test/routing.test.js` (the order, who is allowed, a rule passed over, the
per-task toggle against the fleet's mode, what is written down),
`test/routing-coordinator.test.js` (the routes and who may write the
setting, the Durable Object round trip, the model's pick against a stand-in:
a candidate, a stranger, low confidence, a brief that holds a credential,
the cap, off; the person asked and their answer), `test/routing-mcp.test.js`
(`fleet_routing`, `fleet_task`'s route, `fleet_delegate` with no member),
`test/routing-in-apps.test.js`, and the one-call-site test the Worker
already has (`test/worker-ai-sites.test.js`).
