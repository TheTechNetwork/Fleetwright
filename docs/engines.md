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
container, with a real engine. The image with the engines in it is built and
run in CI (`.github/workflows/sandbox.yml`), which this change added and
which has not run yet: nothing here could build a container.

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
    model: github-copilot/claude-sonnet-5.5
```

`model` is optional for `claude-code` and `codex`, and required for
`opencode`, whose model also says whose account pays (`github-copilot/…`, or
since step 7 an API key's provider: [api-engines.md](./api-engines.md)). A
model from any other OpenCode provider is refused by name: those run on API
keys, which are step 7.

**The account's own list decides which models there are.** The one above is
in OpenCode's catalog for Copilot; whether a member's Copilot plan has it is
the plan's to say. A name the account does not have is found before a turn
(below) and ends as `model`, so the member's next engine takes over.

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
| `limit` | the account's limit, or its money | `StopFailure` with `rate_limit` or `billing_error` | `usageLimitExceeded`, or a failed turn while a rate-limit window stands at 100% | an error naming a rate limit, a quota, or credits that ran out |
| `auth` | not signed in, or the sign-in ended | `StopFailure` with `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold` or `cloud_credential_error` | `account/read` with no account, or `unauthorized` | error `-32000`, Authentication required |
| `model` | not the model that was asked for | `StopFailure` with `model_not_found` | `thread/start` answers another model, `model/rerouted`, `modelNotFound` | the session reports another model, or none, or the agent says it has no such model |
| `refused` | the provider declined the work | | a policy error | `stopReason: refusal` |
| `cut` | the turn ran out of room | `StopFailure` with `max_output_tokens` | `contextWindowExceeded` | `max_tokens`, `max_turn_requests`, a context that overflowed |
| `cancelled` | somebody stopped it | | status `interrupted` | `stopReason: cancelled` |
| `error` | anything else, with the engine's first line as `detail` | `StopFailure` otherwise | status `failed` otherwise | any other error |

**Running out of money is a limit.** A metered key does not usually stop at a
rate limit, it stops when its credits are gone: OpenRouter answers 402, "Your
account or API key has insufficient credits", and other providers say
insufficient funds or balance, payment required, or an allowance exceeded.
Each is read as `limit`, and the member's next engine takes over.

**A limit may be reported late.** OpenCode retries a rate limit itself, up to
five times, waiting as long as the provider's `retry-after` says, and answers
with the error only when it gives up. The runner waits for that answer with
no deadline of its own, as it waits for any turn. So a session on OpenCode
can sit at a rate limit for as long as the provider asked before the box
hears of it and hands on.

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

**OpenCode is told to ask.** Its permissions default to allow, so left alone
it never asks and there is nothing for the runner to decline. In a `safe`
session the runner writes OpenCode's machine settings
(`/etc/opencode/opencode.json`, inside the container) before it starts the
engine: every permission asks, except reading a file and the two searches.
OpenCode's machine settings override a project's, so an `opencode.json` in
the workspace cannot turn the asking off. A `safe` session on OpenCode
therefore looks and answers, and each edit and each command is asked about,
declined, and said in the pane. If the settings cannot be written the engine
is not started. This is OpenCode's documented configuration
([config](https://opencode.ai/docs/config/),
[permissions](https://opencode.ai/docs/permissions/)), tested against a
stand-in that reads the file. It has not been run against a real OpenCode.
Codex is told on `thread/start`, as it always was.

**Not restarted for being still.** The watcher stops and resumes a Claude
Code session whose pane has not moved for an hour. A session on another
engine has no conversation to resume, so it is left alone: a stop would be
the end of it.

**What the runner will not say, and how much it will read.** Anything it was
handed is taken out of what it prints and reports: a key, a Copilot token,
and each token inside a Codex sign-in file, as handed over and as Codex
renews it. A line of an engine's error output is passed on up to 64 KiB and
the rest of that line is dropped. A message from an engine longer than 8 MiB
ends the conversation with it, says so as the turn's error, and the next
line typed starts the engine again.

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
has no option to read, must list the model and accept being set to it).
OpenCode's own server refuses a model the account does not have ("model not
found"), and that refusal is the same ending. An
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
   the workspace is a checkout, and the last of what the engine said. It does
   not hold what the session was asked: those words are in no file on the
   box, and the note says the next engine is given them again and that the
   task's page has the brief;
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
vault gives a member's `codex` item to the first approved machine that runs
Codex and asks for it, and to no other, says which machine holds it, and
gives it to another only after a custodian deposits it again. A Copilot token does not rotate
and goes to every machine approved for the vault.

**Nothing renews these from the vault**, unlike a Claude sign-in, and Test
answers that it is not tried from there. Whether one still works is found by
the check before a turn, on the machine. An ended one is a TurnEnded with
reason `auth`: it is said on the session, to whoever that session's events
reach, and the member's next engine takes over if there is one.

A box asks the vault for them by saying it takes them and which engines it
runs (`accepts: ["codex", "engines", "members", "opencode"]`, from what its
hub reports, so from `FLEETWRIGHT_ENGINES`). A box that runs Claude Code
alone says neither and is handed none; one that runs OpenCode and no Codex
is handed the Copilot token and never the Codex sign-in. Every box used to
say `engines` whatever it ran, so the one machine a Codex sign-in goes to
was whichever asked first, a box that could not run it included. A box from
before the engines were named still says `engines` alone and is handed every
engine's item, as it was; one from before engines says nothing and is never
handed a file it would leave lying where nothing reads it.

**A session is handed one only through its own socket.** The runner asks the
hub (`/internal/engine-credential`) for the item its engine runs on. The hub
answers only for the session whose socket it is, only for an item one of
that session's engines runs on, and only from that member's vault on this
box. The runner writes it where the engine reads its sign-in, inside the
container. The runner looks at Codex's file every couple of seconds while
the engine is live and hands a renewed one back the same way when it sees
one, and once more as the session is stopped, so a session stopped in the
middle of the turn that renewed does not leave the box with a used-up
sign-in. The box keeps the copy that was renewed later, by the file's own
`last_refresh`, and refuses an older one: two sessions of one member each
hand back their own copy, and the last to arrive is not always the newest.

## What a machine reports

`health.engines` lists the engines a machine runs. `claude-code` is always
there. `codex` and `opencode` are there when the operator says so
(`FLEETWRIGHT_ENGINES=codex,opencode`) on a machine whose sessions run in a
container with the session's socket. A box cannot see into its image
cheaply, so the operator's word is the whole of it, and a wrong word is a
session that says the command was not found. The stock image has neither;
`WITH_ENGINES=1` at build time adds both, at pinned versions
(`sandbox/Containerfile`).

### Turning them on, on a box

Three things, in `/etc/fleetwright.env`, and all three are needed. Naming the
engines without the image is the wrong word above.

1. **The image.** `FLEETWRIGHT_SANDBOX_IMAGE` names the image sessions run
   in, and the default one has no engines. Either the published one,

   ```
   FLEETWRIGHT_SANDBOX_IMAGE=ghcr.io/thetechnetwork/fleetwright-session:engines
   ```

   which the `Sandbox image` workflow builds and publishes beside `:latest`
   and `:web` from the first push that carries it, or one built on the box:

   ```
   podman build --build-arg WITH_ENGINES=1 -t localhost/fleetwright-session:engines -f sandbox/Containerfile sandbox/
   FLEETWRIGHT_SANDBOX_IMAGE=localhost/fleetwright-session:engines
   ```

   Either is an image the box was told by name, so the browser picker
   ([intents.md](./intents.md), `sandbox`) reports it as `custom` and cannot
   switch it. A box that wants a browser and the engines builds its own with
   both arguments (`--build-arg WITH_CHROMIUM=1 --build-arg WITH_ENGINES=1`).
2. **The engines.** `FLEETWRIGHT_ENGINES=codex,opencode`, or one of them.
   Sessions must already run in a container with the session's socket
   (`FLEETWRIGHT_SANDBOX=1`, and the socket not turned off).
3. **The providers, for an API key.** `FLEETWRIGHT_API_PROVIDERS`, as
   [api-engines.md](./api-engines.md) describes. Not needed for a
   subscription.

Then `systemctl restart fleetwright`. Running sessions keep the image they
started in; the next new one uses the new image. `fleet_health` shows what
the box now reports, and a member's sign-ins are kept under its Credentials
as below.

**On a box behind an egress allowlist** (`FLEETWRIGHT_SANDBOX_EGRESS=allowlist`,
[security.md](./security.md)) no engine but Claude Code reaches its provider
until the provider's hosts are added to `FLEETWRIGHT_SANDBOX_EGRESS_ALLOW`:

| engine | hosts |
|---|---|
| `codex`, on a ChatGPT sign-in | `chatgpt.com`, `auth.openai.com` |
| `opencode`, on Copilot | `api.githubcopilot.com` (`api.github.com` is already allowed), `models.dev` |
| `opencode`, on OpenRouter | `openrouter.ai`, `models.dev` |
| `opencode`, on Vercel AI Gateway | `ai-gateway.vercel.sh`, `models.dev` |

These are read from each engine's documentation and source and have not been
measured on a box behind a list. An engine that cannot reach its provider
ends its turn as `error`, with the engine's own words, and hands nothing on.

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
  the session had on its screen. It is quoted in a fence the text cannot
  close, so it stays a quotation, and it is still the session's own words in
  a file the next engine is told to read.
- **Two sessions of one member share one Codex sign-in.** Each is handed its
  own copy of the file, and when one renews, the other's copy is used up: its
  next renewal fails and its turn ends as `auth`. The box keeps the newer
  file, so the next session started is signed in. Signing in on the machine
  itself, which ends this, is not built yet.
- **A session on OpenCode or Codex that sits still is not restarted**, and
  nothing says it is stuck. An engine waiting out a provider's rate limit
  looks the same from the pane.
- **A session can say its own turn ended any way it likes.** TurnEnded comes
  over the session's socket from a process inside the session. A lie there
  puts a wrong word on a screen, or starts the member's own next engine in
  the same workspace. It names no other session and reaches no other vault.
- **A member's custodians are not told separately that an engine's sign-in
  ended.** The session says so; the fifteen-minute check that tells
  custodians about a Claude sign-in does not look at these.
- **Limit detection for an ACP agent reads the error's words**, because the
  protocol has no field for it. A limit worded in a way nobody has seen is an
  `error`, and hands nothing on. Claude Code names the error in its
  `StopFailure` hook (`rate_limit`, `billing_error` and the rest) and is read
  by that name; its words are read only where a version sends no name.

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
handed back when it changes and as the session stops, OpenCode told to ask,
the tokens in a sign-in withheld, a line and a message bounded),
`test/engines-hub.test.js` (TurnEnded and the sign-in on a
session's socket, the launch command, what the watcher says as a session
moves), `test/engines-coordinator.test.js` (the list a start carries, the
protocol 20 refusal, the task's handoff), the engine items in
`test/vault.test.js` (kept, one machine for a Codex sign-in, only to a box
that takes them), and `test/engines-in-apps.test.js`.
