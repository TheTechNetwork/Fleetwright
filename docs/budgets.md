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
- **Only for somebody the minter lists as able to start as that member.** A
  start is where counting begins, on the word of the box it went to, and
  that can be a box of the starter's own. So the coordinator keeps the
  minter's last list of who may start as whom, across a restart, and
  refuses anybody not on it ([members.md](./members.md), "Starting as a
  member"). A fleet whose minter has never been asked has no list. It then
  cannot tell, and refuses a start as a member by anybody but an admin, in
  words that say when to try again.
- **One report adds at most $100 for one session.** What a session cost is
  its box's word, with nothing to check it against. A session does not
  spend that between two reports, which come every half minute or so. A box
  back from hours away can honestly report more: the rest is left
  uncounted, and the member's spend says "at least" and that a session
  reported more at once than the fleet counts.
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

**A start no box answered is unknown too.** A start as a member is sent to a
box and waited for. A box too busy to answer in time may have started the
session all the same, and nothing was then counting it: the member's month
read "$0.00 of $50.00" while its box reported the cost. So a start that
times out is kept as one whose spend is not known, and the member's spend
says so: "At least", and that a start got no answer from its machine. When
that box next reports a session as that member which the fleet is not
already counting, and which did not begin before the start was sent, it is
that start's: counted from nothing, like any session the fleet started, and
no longer unknown. One session a start. Like every unknown it blocks
nothing, in `ask` and in `refuse`: what stops the next start is the figure
once the box reports it. A start nobody ever answers stays unknown for the
month. A start the coordinator could not send at all, because the machine's
connection closed as it was written to, is not one of these: nothing left,
so nothing ran, and the row says nothing of it.

One row a member (`spend:<id>`): the month, the total, the last figure
seen for at most 60 of its sessions, and the starts nobody answered. One row a member for who may start as
it (`custody:<id>`), as the minter last signed it.

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
| `risky-work` | the start is on a task whose `workType` is in `workTypes`. Changing the kind of work on such a task, or on one that was such a task, takes the standing that could approve the start ([tasks.md](./tasks.md), "Who sees and changes one") |
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
| `reasons` | `over-budget`, `dangerous`, `risky-work`, `paid-api`, each with its sentence. As a client is sent it, the last sentence ends with what the session is to be told: the start of its words on one line, at most 160 characters |
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
  went over budget while a risky-work approval waited) needs a new one. A
  start its machine refused, and one the coordinator could not send at all
  (the machine's connection closed as it was written to), started nothing,
  and the approval is good again within its hour. One that was sent and
  never answered keeps it: the machine may have started the session.
- **And for what its session is to be told.** The coordinator keeps a
  SHA-256 digest of the words the start carried when the approval was asked
  for (or of the profile it named), and the approval covers only a start
  with the same digest. A task whose title or brief was rewritten since, or
  other words on a start with no task, is another start: it is refused, in
  words that say the approval was for something else, and asks for a new
  one. **A profile is approved on one machine.** A profile is a name, and
  what it says is a file on the machine the start goes to, so the machine is
  in the digest and in the sentence (*as ops-box holds it*); a start that
  names a profile and needs approval names its machine, or is refused
  (`ambiguous_host`) saying so. An approval for the name alone started that
  name on the asker's own machine, where the file was theirs to write. **A
  named secret is part of it too**, on any start: it is what the session may
  fetch while it follows those words, and the sentence names it. **An
  approval from before the machine and the secret were part of one no
  longer covers a start that names either**, though it was given for that
  very start: the refusal says so beside the other two ways the two can
  differ (other words; another machine or secret), because the digest cannot
  tell which it is, and asks for a new one. The words themselves are not kept. Whoever is asked reads the start
  of them, after the last reason, in the list, on their phone and in the
  push. The digest is the coordinator's own check and is sent to nobody.
- **A second ask for the same thing is the same approval**, so trying again
  does not fill a manager's phone.
- A waiting approval nobody answers expires after a day.
- **An approval is for a member, not for an id.** Removing a member ends
  every approval still open for it, so a member made later under the same id
  is not started on an approval given for the one that was removed.
- **What a member spent this month stays under its id until the month
  turns**, whether or not the member is removed. Removed and added back in
  the same month, it has spent what it had: removing a member is not how its
  month starts again. A member made later that month under the same id
  starts with that figure too, which is the price of the first.
- **Its budget stays under its id too, until somebody is made under it.**
  A member removed and made again has the budget it had, unless the request
  that makes it names another, which only a person's does. The spend was
  kept and the budget was not: a member past a budget that refuses was
  removed and made again with none, by the one tool an agent holds for a
  member's record, and nothing is past no budget. The answer says the
  budget came back. A person who wants it gone takes it off the record
  afterwards, in the app.
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
GET  /api/budgets                 { settings, members: [{ member, name, budgetUsdMonth, month, usd, unknownSessions, over, words }], you }
PUT  /api/budgets/settings        { budgets?, dangerous?, paidApi?, workTypes? }   an admin
GET  /api/approvals               { approvals }      the ones you asked for, and the ones you may answer
POST /api/approvals/{id}          { answer: approve | decline, note? }
```

`GET /api/budgets` shows an admin every member, a manager their team, and a
person member themselves. `unknownSessions` counts every session whose cost
is not all counted: one that reported none, one that reported more at once
than is counted, and a start no box answered. `words` is the sentence that
says which, and it is what a screen draws.

- **MCP**: `fleet_budgets` reads what each member has spent against its
  budget, and the setting. `fleet_approvals` lists approvals. **No MCP tool
  answers one, changes the setting, or sets a member's budget**: an approval
  exists so that a person looks, and the tools an agent holds do not include
  the one that says a person looked. `fleet_member` writes the rest of a
  member's record and carries its budget as it is. Sent a budget, or a
  member's file that would set, change or leave out the one it has, it
  refuses and says a budget is set by a person in the app. A start refused
  for want of approval says so in words an agent can relay.
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
  under-report. It can do that only for sessions on itself. A box could
  over-report too, for a session somebody the minter lists started on it,
  at most $100 a report. That bounds a report and nothing longer: a box
  reports every half minute, and a figure that falls is counted again from
  nothing, so a box that means to can still take a member past any budget,
  $100 at a time.
- **`risky-work` is a label, and whoever makes a task puts it on.** The
  fleet asks about a start on a task that carries a kind of work it names.
  Taking the label off such a task needs the standing that could approve
  it. Leaving it off needs nothing: the same words on a task made without
  it, or on a start with no task, are not asked about. It is a way for a
  team to mark its own risky work, not a way to stop somebody who may start
  as the member from doing that work unasked.
- **An approval is as strong as the credential that gives it.** The
  coordinator checks who is answering, not what they are holding. A program
  with a manager's credential that calls the route directly has approved.
  The MCP server offers no tool for it, which is a policy and not a lock.
  The same is true of a budget: the route that writes a member's record
  takes one from whoever manages the member, and it is the MCP server that
  does not send it.
- **Dollars at API prices are not a subscription's bill**, and engines that
  report no price are not counted at all.
- **A session already running goes on past the budget**, as above, and so
  does one that is resumed.
- **Anybody who may start as a member can cause an approval to be asked
  for**, and that is whoever the minter lists, who need not manage the
  member. The same ask twice is one approval, so it is one notice.
- **`dangerous` reads what the start asks for.** A box whose own default is
  to skip permission prompts starts such a session with nothing in the
  request saying so, and that start is not asked about.

## Tests

`test/budgets.test.js` (the ledger: growth, a first sighting, a figure that
goes down, the month's turn, unknown cost, the most one report adds, a start
nobody answered; what needs approval; an approval's life and what it is
bound to), `test/budgets-coordinator.test.js` (spend counted from health
frames, a start that timed out, a start refused and then let through, each
reason, an approval for other words, the kind of work, who may answer, one
use, the same ask twice, refuse mode, the routes and who sees what, the
pushes, the Durable Object's rows),
`test/members-coordinator.test.js` (the custody list kept across a rebuilt
Durable Object, and the refusal while there is none), `test/budgets-mcp.test.js`
(`fleet_budgets`, `fleet_approvals`, and that no tool answers one), and
`test/budgets-in-apps.test.js`.
