# Engines: what runs a member, and what happens at a limit

> Each member can have several engines. When a member hits a limit, its next
> engine continues from a handoff note on the same branch.

Before this a member had one engine, Claude Code, and a session that ran into
its account's limit stopped where it stood. Nothing said why, and nothing
picked the work up.

Now a member's `engines` is an ordered list. A session starts on the first
one this machine has. Every engine reports the end of a turn the same way,
and when a turn ends on a limit the box writes down where things stand and
starts the member's next engine in the same workspace.

This is step 4 of the organization work ([ROADMAP.md](../ROADMAP.md)). Choosing
the member is step 5, budgets step 6, and engines paid for by an API key
step 7. **A machine runs only the engines it reports**, and none reports
`codex` or `opencode` until its operator installs them in the session image
and names them (`FLEETWRIGHT_ENGINES`), so a fleet that changes nothing runs
exactly as it did.

**What has and has not been run.** The two adapters are tested against
stand-in servers that speak each engine's published protocol, and the Codex
adapter's opening was checked against the real `codex app-server`, signed
out. No turn has been sent to a real Codex or OpenCode. The move from one
engine to the next is run in a test through the real launch, a real tmux pane
and the real runner, with a script standing in for podman and for each
engine (`test/engines-launch.test.js`). It has not been run on a box, in a
container, with a real engine.

## The engines

| engine | what it is | runs on | the member's vault item |
|---|---|---|---|
| `claude-code` | Claude Code, in the session's pane, as before | a Claude subscription | `claude` |
| `codex` | OpenAI's Codex, through `codex app-server` | a ChatGPT subscription | `codex` |
| `opencode` | OpenCode, through the Agent Client Protocol (`opencode acp`) | a GitHub Copilot subscription | `copilot` |

A member names up to three, each once, in the order to try them:

```yaml
engines:
  - engine: claude-code
  - engine: codex
    model: gpt-5.1-codex
  - engine: opencode
    model: github-copilot/gpt-5
```

`model` is optional for `claude-code` and `codex`, and required for
`opencode`, whose model also says whose account pays (`github-copilot/…`, or
since step 7 an API key's provider: [api-engines.md](./api-engines.md)). A
model from any other OpenCode provider is refused by name: those run on API
keys, which are step 7.

**Across providers, never across accounts.** A member has one vault and a
vault keeps one item of each kind, so there is no second account of the same
provider to rotate to. The list falls back from one provider to another and
that is all it can do.

`opencode` is one row in the runner's table (`RUNS` in `sandbox/engine.mjs`):
another agent that speaks the Agent Client Protocol is a row there, a row in
`ENGINES` (`src/fleet/protocol/engines.js`) and a credential rule, not a new
adapter.

## One event: TurnEnded

Three engines end a turn in three vocabularies. Everything above the adapter
sees one:

```
TurnEnded { engine, reason, detail, model, usage, resetsAt }
```

| reason | what happened | Claude Code | Codex | ACP |
|---|---|---|---|---|
| `done` | the turn ended | the `Stop` hook | `turn/completed`, status `completed` | `stopReason: end_turn` |
| `limit` | the account's limit | `StopFailure` naming a rate or usage limit | `usageLimitExceeded`, or a failed turn while a rate-limit window stands at 100% | an error naming a rate limit or quota |
| `auth` | not signed in, or the sign-in ended | `StopFailure` naming the sign-in | `account/read` with no account, or `unauthorized` | error `-32000`, Authentication required |
| `model` | not the model that was asked for | | `thread/start` answers another model, `model/rerouted`, `modelNotFound` | the session reports another model, or none |
| `refused` | the provider declined the work | | a policy error | `stopReason: refusal` |
| `cut` | the turn ran out of room | | `contextWindowExceeded` | `max_tokens`, `max_turn_requests` |
| `cancelled` | somebody stopped it | | status `interrupted` | `stopReason: cancelled` |
| `error` | anything else, with the engine's first line as `detail` | `StopFailure` otherwise | status `failed` otherwise | any other error |

`usage` is the tokens the engine counted, when it says. `resetsAt` is when a
limit lifts, when the engine says. Neither is worked out here.

The box keeps the last one on the session's record and sends it with the
event it already sent when a session comes back to its prompt
(`session.ready`), so a phone and an agent read why a session stopped and not
only that it did.

## Where an engine runs

**Claude Code runs as it always has**: its own process in the session's pane,
its hooks reporting to the session's socket ([hook-socket.md](./hook-socket.md)).
The hub reads `Stop` and `StopFailure` as a TurnEnded and nothing else about
it changes.

**Every other engine runs behind `fleetwright-engine`**
(`sandbox/engine.mjs`, one file with no imports, copied into the session
image), which is the pane's process where `claude` would have been: the same
tmux session, the same container, the same workspace, the same socket. It
starts the engine's own server on a pipe, speaks its protocol, prints what
the agent says to the pane, and reports to the socket with the events the
hooks use. So the list, the log, peek, stop and the result file
([tasks.md](./tasks.md)) work on these sessions with no change.

**Only in a container, with the session's socket.** The runner is in the
image and the socket is how it is handed a sign-in, so a box whose sessions
run outside a container, or without the socket, runs Claude Code alone and
reports that, whatever its operator names.

What these sessions do not have is said where it would be offered: no Remote
Control link, and no dialog a phone can answer. A start does not wait for a
link on one, and its reply names the engine the session is on. A session that
moves from Claude Code to another engine drops the link its last pane had.
A session that asks before it
runs commands (`safe`) declines what the engine asks to do and prints that it
did; one that does not (`dangerous`) allows it, inside the box's container as
Claude Code's are.

## Before a turn

The runner sends no prompt until two things are true, and says which was not.

**Signed in.** Codex is asked `account/read`, which answers at once; a
`codex exec` with no sign-in retries for 45 seconds before it says so. An ACP
agent is asked for a session, and an Authentication required error is the
answer. Neither is a turn, and neither spends anything.

**On the model that was asked for.** OpenCode, given a model it cannot reach,
uses another one and says nothing. So a turn runs only when the engine
itself reports the model it is on and that is the model the member names:
from `thread/start` for Codex, and for an ACP agent from the session's model
option, set and then read back (an older agent, which lists its models and
has no option to read, must list the model and accept being set to it). An
engine that does not say which model it is on is *cannot tell*, and cannot
tell is not a match. That is a TurnEnded with reason `model`, before anything
was asked of it. Codex is also stopped mid-turn if it says it was moved to
another model (`model/rerouted`).

## At a limit: HANDOFF.md, and the next engine

When a turn ends with `limit`, or an engine fails the checks above, and the
member's list has an engine after this one that the machine has, the box:

1. writes `HANDOFF.md` at the top of the session's workspace: the task and
   branch when the session is on one, which engine stopped, why, when it
   says its limit lifts, what `git status` and the last five commits say when
   the workspace is a checkout, and the last of what the engine said;
2. commits that file, and only that file, inside the checkout, when the
   session is on a task and the checkout is on that task's own branch. On
   any other branch, or with no task, the note is written and not committed.
   It does not push: a push is the session's to make;
3. ends the pane and starts the next engine in the same session, with the
   first message the session was given and one line more: read `HANDOFF.md`
   first. The box keeps that first message in memory only, so after a hub
   restart the next engine is handed the note and no first message.

The session keeps its name, its workspace and its task's lock. Its record
says which engine it is on and each change, and the box says so as it
happens (`session.engine`), which the coordinator writes on the task as a
handoff of kind `engine`.

**One move at a time, and no ending lost.** While a session is being moved
the box starts no second move for it. A turn's end that arrives in that time
(the next engine is not signed in, or Claude Code is at its limit while its
Remote Control link is still awaited) is kept and acted on when the move is
over, so the member's third engine is tried.

**The task is on the record from the start.** Which member a session runs as,
who asked, and its task and branch are written with the record's first write,
before the first engine can report, so a session whose first engine stops in
its first seconds still gets a note that names the task and is committed on
its branch.

**The note is mechanical.** An engine at its limit cannot be asked to
summarize, so the box writes what it can see and labels it as that. It is a
place to start reading, not an account of the work.

**With no engine left**, the session stays at its prompt and the task, if
there is one, is not returned: its page says the session stopped at a limit,
on which engine, and when the limit lifts if the engine said.

**`refused`, `cut`, `cancelled` and `error` hand nothing on.** Another
provider's model is not the answer to a refusal, and a failure nobody
understands is not retried on somebody else's account.

## Credentials

Two kinds the vault reserved in step 2 are kept now ([vault.md](./vault.md)):

- **`codex`**: the sign-in `codex login` leaves in `auth.json`, pasted into the
  member's Credentials by a custodian. Checked to be a ChatGPT sign-in with a
  refresh token. A file that holds only an API key is refused, as step 7's.
- **`copilot`**: a GitHub Copilot token, pasted the same way.

Both are sealed, kept and listed as a `claude` item is: by name and state,
never read back. Neither is in a member's record or file.

**A Codex sign-in is handed to one machine.** Codex renews its own tokens on
the machine it runs on, and a renewal ends the copy anywhere else. So the
vault gives a member's `codex` item to the first approved machine that asks
for it and to no other, says which machine holds it, and gives it to another
only after a custodian deposits it again. A Copilot token does not rotate
and goes to every machine approved for the vault.

**Nothing renews these from the vault**, unlike a Claude sign-in, and Test
answers that it is not tried from there. Whether one still works is found by
the check before a turn, on the machine. An ended one is a TurnEnded with
reason `auth`: it is said on the session, to whoever that session's events
reach, and the member's next engine takes over if there is one.

A box asks the vault for them by saying it takes them (`accepts: ["engines",
"members"]`), so a box from before this is never handed a file it would
leave lying where nothing reads it.

**A session is handed one only through its own socket.** The runner asks the
hub (`/internal/engine-credential`) for the item its engine runs on. The hub
answers only for the session whose socket it is, only for an item one of
that session's engines runs on, and only from that member's vault on this
box. The runner writes it where the engine reads its sign-in, inside the
container. When Codex has renewed its file by the end of a run, the runner
hands the new one back the same way and the box keeps it in place of the
old, so the next session on this machine is not signed out.

## What a machine reports

`health.engines` lists the engines a machine runs. `claude-code` is always
there. `codex` and `opencode` are there when the operator says so
(`FLEETWRIGHT_ENGINES=codex,opencode`) on a machine whose sessions run in a
container with the session's socket. A box cannot see into its image
cheaply, so the operator's word is the whole of it, and a wrong word is a
session that says the command was not found. The stock image has neither;
`WITH_ENGINES=1` at build time adds both, at pinned versions
(`sandbox/Containerfile`).

## Starting

`start` carries `memberEngines`, written by the coordinator from the
member's record and the machine's report: the member's list, in order, less
the engines this machine does not run.

- If none is left, the start is refused, naming the engines the member has
  and the ones the machine runs.
- If some were left out, the reply says which.
- **Protocol 21.** A host older than 21 runs Claude Code and nothing else. It
  is sent a member whose list is `claude-code` alone, with no model named,
  exactly as before. Any other list is refused for that host: it would run
  the session on Claude whatever the member says.

## Where it shows

- **MCP**: `fleet_member` takes `engines`, in order; `fleet_members` prints
  them; `fleet_health` prints what each machine runs.
- **Both phones**: Engines on a member's edit page, to add, remove, reorder
  and name a model; Codex sign-in and Copilot token under a member's
  Credentials, with which machine holds the Codex sign-in; the engine a
  session is on, and each handoff, on the session's page and the task's.
- **The signing page**: the same two items under a member's Credentials.

## What it does not stop

- **A pasted sign-in is a copy.** Whoever pasted a Codex `auth.json` still has
  the original on their own computer, and the first of the two to renew ends
  the other. Signing in on the machine itself is not built yet.
- **The model check believes the engine.** An agent that reports one model
  and runs another is not caught. What is caught is the case that was seen:
  an agent that says which model it fell back to.
- **`HANDOFF.md` holds what the engine printed last**, which may be anything
  the session had on its screen.
- **A session can say its own turn ended any way it likes.** TurnEnded comes
  over the session's socket from a process inside the session. A lie there
  puts a wrong word on a screen, or starts the member's own next engine in
  the same workspace. It names no other session and reaches no other vault.
- **A member's custodians are not told separately that an engine's sign-in
  ended.** The session says so; the fifteen-minute check that tells
  custodians about a Claude sign-in does not look at these.
- **Limit detection for Claude Code and ACP agents reads the error's words**,
  because neither has a field for it. A limit worded in a way nobody has seen
  is an `error`, and hands nothing on.

## Tests

`test/engines.test.js` (the list and the line a start carries, TurnEnded
from Claude Code's hooks, the choice of the next engine, the handoff note,
the commit on a real checkout and only on the task's branch, what the
session manager records, and that the runner's copies of the shared words
match), `test/engines-launch.test.js` (a start from the fleet through the
real launch, tmux and the runner: no wait for a link, the task on the first
note, and three engines in turn), `test/engines-run.test.js` (each adapter and the runner against a
stand-in server speaking the published protocol: sign-in, the model check,
a turn, a limit, a refusal, a permission request, the sign-in staged and
handed back), `test/engines-hub.test.js` (TurnEnded and the sign-in on a
session's socket, the launch command, what the watcher says as a session
moves), `test/engines-coordinator.test.js` (the list a start carries, the
protocol 20 refusal, the task's handoff), the engine items in
`test/vault.test.js` (kept, one machine for a Codex sign-in, only to a box
that takes them), and `test/engines-in-apps.test.js`.
