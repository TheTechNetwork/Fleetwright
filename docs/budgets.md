# Budgets and approvals

> Enforce a member's monthly budget, and ask a person before work that is
> over budget or risky.

Before this a member's `budgetUsdMonth` was a number on a record
([members.md](./members.md)). Nothing counted against it and nothing read it.
A session that skips permission prompts, on a member's own sign-ins, started
the same way as any other.

Now the fleet **counts what each member's sessions cost this month**, and a
start that would take a member past its budget, or that the owner has named
as risky, **waits for a person who manages that member to approve it**.

This is step 6 of the organization work ([ROADMAP.md](../ROADMAP.md)). The
counting is always on, because it only reads what boxes already report.
**The enforcing is off until an admin turns it on**: a fleet that sets
nothing refuses nothing and asks nobody, whatever budgets its members have.

## What a member has spent

Each box already reports what each session has cost, as that session's
engine counted it ([hook-socket.md](./hook-socket.md), `spent`): for Claude
Code, the running total its own `/cost` draws, in dollars **at API prices**.
For a member on a subscription that is not a bill. It is the same yardstick
for every member, which is what a budget needs.

The coordinator adds up, for each member, **what it saw being spent this
month**:

- A session started as a member begins at nothing. Each time its box reports
  a higher figure, the difference is added to that member's month.
- **It never counts what it did not see.** A conversation resumed as a
  member already has a total on it from before. The first figure its box
  reports is where its counting starts, and only growth after it counts. So
  the total can be under, and is never over.
- **Only sessions the fleet itself started or resumed as that member.** Which
  member a session belongs to, in a box's report, is the box's word. Counted
  on that alone, a box could spend any member's budget by naming it. For
  the same reason a resume counts only when the person resuming could have
  started as that member: a person's own box may call a session of theirs
  any member's, and their resuming it then spends nobody else's budget.
- A figure that goes down is a new conversation in the same session, and
  counts from nothing again.
- The month is the calendar month in UTC. At its turn every member's total
  starts again, and sessions still running count only what they spend after.
  A total from an earlier month is never read as this month's, by the gate
  or by a screen, whether or not anything has been counted since.

**What it cannot tell, it says.** A session that reports no dollar figure
(Codex and OpenCode report tokens and no price; an older image reports
nothing; Claude Code marks a total as incomplete when a model had no price
it knew) is counted as a session **whose cost is unknown**. A member's
spend is then shown as "at least" its total, with how many sessions that is
about. Unknown is never read as nothing, and never blocks a start: a budget
is enforced on what was counted.

One row a member (`spend:<id>`): the month, the total, and the last figure
seen for at most 60 of its sessions.

## The setting

One record, written by an admin and read by everybody:

| field | what it holds | default |
|---|---|---|
| `budgets` | what happens to a start as a member whose month is spent: `off`, `ask` or `refuse` | `off` |
| `dangerous` | whether a member start that skips permission prompts (`mode: dangerous`) needs approval | `false` |
| `workTypes` | kinds of work whose tasks need approval before a session starts on one | none, at most 20 |
| `paidApi` | whether a start as a member with an engine that bills an API key needs approval ([api-engines.md](./api-engines.md), "What it costs, and who is asked") | `true`, the one guard that starts on: it guards spending no budget counts, and changes nothing for a fleet with no such engine |

- `off`: budgets are counted and shown, and stop nothing.
- `ask`: an over-budget start needs approval.
- `refuse`: an over-budget start is refused until the month turns or the
  budget is raised. Nobody is asked.

A member with no `budgetUsdMonth` has no budget, in every mode.

## What needs approval

A start **as a member** (and so every start on a task) is looked at before a
machine is chosen. It needs approval when any of these is true, and the
approval names each one that is:

| reason | when |
|---|---|
| `over-budget` | `budgets` is `ask`, the member has a budget, and its counted spend this month is at or past it |
| `dangerous` | `dangerous` is on and the start asks for a session that does not ask before it runs commands |
| `risky-work` | the start is on a task whose `workType` is in `workTypes` |
| `paid-api` | `paidApi` is on and any engine in the member's list bills an API key, whichever machine the start goes to |

A start as yourself, with no member, is not looked at: it runs on your own
sign-ins and no member's budget is its. A **resume** is not looked at
either: it is counted, and it is not gated.

## An approval

A start that needs one is **refused, with a reason a person can act on**:
who it is as, why it needs approval in numbers and words, the approval's id,
and who can give it. Nothing is held and nothing is queued. When the
approval is given, the same start is sent again and goes through.

| field | what it holds |
|---|---|
| `id` | `a` and a number |
| `member`, `task` | who the start is as, and the task when there is one |
| `reasons` | `over-budget`, `dangerous`, `risky-work`, `paid-api`, each with its sentence |
| `askedBy`, `askedAt` | who tried to start it |
| `state` | `waiting`, `approved`, `declined`, `used` or `expired` |
| `decidedBy`, `decidedAt`, `note` | who answered, when, and what they said, at most 300 bytes |

- **Who may answer**: anybody who manages the member (the tree,
  [members.md](./members.md)) and any fleet admin. They are told on their
  own phones when one is asked for.
- **Somebody who manages the member may approve their own start.** The
  question is then a confirmation with the numbers in front of them, which
  is what was missing.
- **An approval is for one start.** It covers the member, the task if there
  was one, and the reasons it names, for the person who asked, once, within
  an hour of being given. A start that has since gained a reason (the member
  went over budget while a risky-work approval waited) needs a new one.
- **A second ask for the same thing is the same approval**, so trying again
  does not fill a manager's phone.
- A waiting approval nobody answers expires after a day.
- **An approval is for a member, not for an id.** Removing a member ends
  every approval still open for it, so a member made later under the same id
  is not started on an approval given for the one that was removed.
- **The figure is for whoever may see it.** What a member has spent is read
  by an admin, its managers and the person it is. Somebody else whose start
  is refused is told that the member is past its budget and who can approve,
  without the amount, in the refusal, in their own list of asks and in the
  record of it. The managers read the amount on the same approval.

At most 200 are kept, the oldest finished ones going first.

## While a session runs

Nothing here stops a session. Stopping work in flight because a counter
crossed a line loses the work and saves little. Instead the member's
managers are told, once each a month, when its spend passes four fifths of
its budget and when it passes the budget. The next start is where the
budget bites.

## Where it shows

```
GET  /api/budgets                 { settings, members: [{ member, budgetUsdMonth, month, usd, unknownSessions, over }], you }
PUT  /api/budgets/settings        { budgets?, dangerous?, paidApi?, workTypes? }   an admin
GET  /api/approvals               { approvals }      the ones you asked for, and the ones you may answer
POST /api/approvals/{id}          { answer: approve | decline, note? }
```

`GET /api/budgets` shows an admin every member, a manager their team, and a
person member themselves.

- **MCP**: `fleet_budgets` reads what each member has spent against its
  budget, and the setting. `fleet_approvals` lists approvals. **No MCP tool
  answers one or changes the setting**: an approval exists so that a person
  looks, and the tools an agent holds do not include the one that says a
  person looked. A start refused for want of approval says so in words an
  agent can relay.
- **Both phones**: a member's page shows this month's spend against its
  budget; **Approvals** under Organization lists the ones waiting on you,
  with Approve and Decline, and the setting for an admin; a start refused
  for want of approval shows why and, when you may give it, offers Approve
  and start; a push when an approval is asked of you.
- **No host is involved.** Boxes report what they already reported. No
  protocol version changes, and an old host is counted like any other.

## What it does not stop

- **This is the coordinator's arithmetic and the coordinator's gate.** A
  compromised coordinator can ignore both. It still cannot start a session
  as a member without a signature from somebody the minter lists
  ([members.md](./members.md)). A budget is a cost control, not custody.
- **A box says what its sessions cost.** A box a member enrolled could
  under-report. It can do that only for sessions on itself.
- **An approval is as strong as the credential that gives it.** The
  coordinator checks who is answering, not what they are holding. A program
  with a manager's credential that calls the route directly has approved.
  The MCP server offers no tool for it, which is a policy and not a lock.
- **Dollars at API prices are not a subscription's bill**, and engines that
  report no price are not counted at all.
- **A session already running goes on past the budget**, as above, and so
  does one that is resumed.
- **Anybody in the fleet can cause an approval to be asked for.** Until the
  minter has signed its list of who may start as whom, the coordinator does
  not know that somebody may not start as a member, and leaves that refusal
  to the box. Such a person's start is still looked at here, so the member's
  managers can be asked about a start that the box would have refused
  anyway. The same ask twice is one approval, so it is one notice.
- **`dangerous` reads what the start asks for.** A box whose own default is
  to skip permission prompts starts such a session with nothing in the
  request saying so, and that start is not asked about.

## Tests

`test/budgets.test.js` (the ledger: growth, a first sighting, a figure that
goes down, the month's turn, unknown cost; what needs approval; an
approval's life), `test/budgets-coordinator.test.js` (spend counted from
health frames, a start refused and then let through, each reason, who may
answer, one use, the same ask twice, refuse mode, the routes and who sees
what, the pushes, the Durable Object's rows), `test/budgets-mcp.test.js`
(`fleet_budgets`, `fleet_approvals`, and that no tool answers one), and
`test/budgets-in-apps.test.js`.
