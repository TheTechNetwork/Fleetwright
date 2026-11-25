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

**Signing in on the machine has not been run against anything real.** The
runner's sign-in mode is tested against stand-ins that answer as each
engine's source reads at the version the image pins (`codex app-server`
0.171.0, `account/login/start` with `chatgptDeviceCode`; `opencode serve`
1.19.6, `/provider/github-copilot/oauth/authorize` and `/callback`), and the
box's side of it with a script standing in for Podman. No device code has
been asked of OpenAI or GitHub, no real Codex or OpenCode has been started
for it, no account has been signed in, and no container has been run: that
the volume mounts as described under rootless Podman, that the pinned
engines answer as their sources read, and that a code can be approved for a
real account are each still to be seen on a box.

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
image and the socket is how it reports and how it is handed a pasted
sign-in, so a box whose sessions run outside a container, or without the
socket, runs Claude Code alone and reports that, whatever its operator
names.

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
answer. Neither is a turn, and neither spends anything. An engine that is
not signed in, or whose sign-in has ended, is a TurnEnded with reason `auth`
as before, and the pane and the turn's detail now say where it is signed in
again: the member's Credentials, *Sign in on a machine*, on this machine.

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

**An engine is signed in on the machine it runs on.** A custodian asks a
machine to sign Codex or OpenCode in for a member. The engine makes a short
code, the custodian enters it at OpenAI or GitHub from any browser, and the
engine writes its sign-in into that member's *engine home* on that machine.
Nothing is pasted, nothing secret crosses the fleet, and the vault holds
nothing for a sign-in made this way. How it is asked for and answered is the
next section.

This replaced pasting as the way in, after an outside review of the first
build. Pasting asked a phone to carry several kilobytes of secret by
clipboard, never said which Copilot token works, gave a Codex file to
whichever machine asked first, and left a copy on the computer it was
pasted from that ended the fleet's the next time either renewed. It stays
as the fallback, below, for an account where device code is switched off.

**The engine home** is a Podman named volume, one a member on each machine:
`fw-engine-<member id>` for an agent member, and `fw-engine-person.<tag>`
for a person, where the tag is the hash this box already names a person's
download cache and egress network by (`ownerTag`), never their address. A
member's id cannot hold a full stop, so the two cannot collide. It is
mounted at `/engine-home` into that member's sessions on an engine other
than Claude Code, and into the short container a sign-in runs in, and
nowhere else. Codex is started with `CODEX_HOME` as `codex/` inside it and
OpenCode with `XDG_DATA_HOME` as the home itself, so its files are
`opencode/` beside that. Both are set for the engine's own process and
nothing else in the session.

**Engines renew their own sign-ins there**, as they do on a person's
computer. A member's sessions on one machine share the one home, so nothing
is handed back to the box and no copy goes stale. A sign-in belongs to the
machine it was made on: a member that runs on two machines is signed in on
each.

**A session uses what is signed in on its machine first.** Before a turn
the runner looks in the engine home. With a sign-in there it asks the box
for nothing. With none, it asks for the member's pasted item as it always
did, and writes it into the home, so there is one place an engine reads.
A key for an engine on a metered API ([api-engines.md](./api-engines.md))
is asked for every time, as before, and is added to OpenCode's file beside
a Copilot sign-in without replacing it.

### A pasted sign-in, the fallback

Two kinds the vault reserved in step 2 are still kept
([vault.md](./vault.md)), for a member whose account cannot use a device
code:

- **`codex`**: the sign-in `codex login` leaves in `auth.json`, pasted into the
  member's Credentials by a custodian. Checked to be a ChatGPT sign-in with a
  refresh token. A file that holds only an API key is refused, as step 7's.
- **`copilot`**: the token OpenCode's own GitHub Copilot login makes, pasted
  the same way: the `refresh` value under `github-copilot` in OpenCode's
  `auth.json` (`~/.local/share/opencode/auth.json`) on a computer where
  `opencode auth login` signed in to Copilot. No other GitHub token works.
  A personal access token, or one another app made, is not one OpenCode
  can use, and the model check before a turn is where that is found.

Both are sealed, kept and listed as a `claude` item is: by name and state,
never read back. Neither is in a member's record or file.

**A pasted Codex sign-in is handed to one machine.** Codex renews its own
tokens on the machine it runs on, and a renewal ends the copy anywhere else.
So the vault gives a member's `codex` item to the first approved machine that
runs Codex and asks for it, and to no other, says which machine holds it, and
gives it to another only after a custodian deposits it again. A Copilot token
does not rotate and goes to every machine approved for the vault.

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

**A session is handed one only through its own socket**, and only when its
machine's engine home holds no sign-in. The runner asks the hub
(`/internal/engine-credential`) for the item its engine runs on. The hub
answers only for the session whose socket it is, only for an item one of
that session's engines runs on, and only from that member's vault on this
box. The runner writes it into the engine home. The session that was handed
a Codex file looks at it every couple of seconds while the engine is live
and hands a renewed one back the same way when it sees one, and once more
as the session is stopped, so the box's copy keeps up for as long as that
session runs. The box keeps the copy that was renewed later, by the file's
own `last_refresh`, and refuses an older one. A later session finds the
home signed in, asks for nothing and hands nothing back.

**Signing out does not forget a pasted item.** `signout` has the engine
remove what it holds in the home. A pasted item the vault still keeps for
the member is handed to its next session as above, so a member that is to
stop running on an account has the item forgotten in its Credentials too.

## Signing in on the machine

`enginesignin` is a verb a custodian signs and one machine answers
(protocol 22, [intents.md](./intents.md)).

| | |
|---|---|
| `member` | the member's id. Always given: engines are a member's, so a person signs their own in by naming their own record |
| `engine` | `codex` or `opencode`. OpenCode is signed in to GitHub Copilot. An engine on an API key has a key, not a sign-in ([api-engines.md](./api-engines.md)) |
| `action` | `start`, `status`, `cancel` or `signout` |
| `reply` | optional. A key the asking phone made for this one request, in the form a vault request's `reply` has (an uncompressed P-256 public key, 87 characters of base64url). With it, the machine seals what it says of the page, the code and the account to that key, and the coordinator carries ciphertext. It is in what the phone signs, so nobody between can change it |
| the machine | beside the intent, as `host`, never in it. Named whenever more than one machine could take it |

**Who may** is exactly who may start a session as that member on that
machine ([members.md](./members.md), "Starting as a member"), for all four
actions, `status` included, because its answer carries the code. The
coordinator refuses first, in the person's words. The box decides, against
the list the minter signed: the asker must be on it for that member, and
the request must be signed by them or delegated in a grant that names the
member, whatever the box's signature mode. Its refusals are a member
start's: `member_unchecked`, `no_member`, `not_custodian`,
`signature_required`, `member_not_delegated`.

**Only on a machine approved for that member's vault.** A sign-in made on a
machine is a credential on that machine, so a `start` is taken only by a
box a custodian approved to hold the member's credentials: the box whose
key is a grant in that member's vault ([vault.md](./vault.md)). For a
person signing in their own engines it is their own vault. The box knows
whose vaults it is approved for from what the vault last answered it with,
which names each of them. A box the answer did not name the member to
refuses (`not_approved`) and says to approve the machine from the member's
Credentials first, then sign in. A box the vault has not answered yet
cannot tell, and says that instead (`approval_unknown`); it is never said
as not approved. The other three actions are not held to this: a sign-in
is still signed out on a machine whose approval was removed.

The approval is what makes the code checkable. The grant's key reaches a
phone in the vault's `list` answer for that member, sealed by the minter,
so it is the one identity of a box a phone holds that the coordinator
could not have written.

**`start`** runs a short container from the session image with the member's
engine home mounted and the runner in its sign-in mode
(`fleetwright-engine --signin <engine>`), on the member's own network when
the box is behind an egress list. The runner asks the engine for a device
code and prints one line; the box answers as soon as it has it. Asked
with no `reply`, which a phone never does, the answer is in the clear:

```json
{ "ok": true, "state": "waiting", "member": "debbie", "engine": "codex",
  "url": "https://auth.openai.com/codex/device", "code": "ABCD-EFGH",
  "expiresAt": 1764000900000, "expiresInMinutes": 15,
  "signedAt": 1764000001000,
  "hostKey": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "signature": "…",
  "signedIn": null, "text": "Open … and enter ABCD-EFGH …" }
```

**The machine signs what it answers, and seals it to the phone that
asked.** Two things are done to an answer, and a phone asks for both.

*Signed.* The box signs with the P-256 key it signs its vault requests
with, by the same function, over

```
signingInput('engine-signin-answer',
  { v: 1, id, host, member, engine, url, code, at, signedIn })
```

where `id` is the id of the request being answered, which the phone chose
and signed; `host` is the whole SHA-256 of the box's key in hex, which is
what the vault names a grant by (`key`); `member` and `engine` are the
request's; `url` and `code` are the engine's, there while a code is out
and left out otherwise; `at` is when the box signed; and `signedIn` is
who is signed in there, `{ since, who }` or `null`, in a sealed answer
and left out of a clear one. Binding the id is what makes an older
genuine answer useless for a newer request, and a `status` asked under a
new id is signed over that id.

*Sealed.* A request that carries `reply` is answered with `sealed`: the
signed fields, the box's public key (`hostKey`) and the `signature`,
encrypted to `reply` as a vault's answer is (`seal`, under
`fleetwright-engine-signin/v1`). **The clear part of that answer then
says nothing of the page, the code or the account**: no `url`, no `code`,
`signedIn` cut down to `{ since }`, and a `text` that spells none of
them. The coordinator carries the state and the times, which it is told
anyway when an attempt ends, the engine's own sentence for an attempt
that failed (`detail`), and ciphertext. Every answer to a request
with `reply` that says where a sign-in stands is sealed, whatever the
state, so the account a sign-in ended on is the box's signed word and not
the coordinator's: a person who sees *Signed in as* an account that is
not theirs is seeing what the machine said.

```json
{ "ok": true, "state": "waiting", "member": "debbie", "engine": "codex",
  "startedAt": 1764000000000, "expiresAt": 1764000900000, "expiresInMinutes": 15,
  "signedIn": null,
  "sealed": { "epk": "…", "iv": "…", "ct": "…" },
  "text": "A code is out to sign Codex in for debbie on ops-box, …" }
```

and inside `sealed`, once the phone has opened it:

```json
{ "v": 1, "id": "…", "host": "9294…3866", "member": "debbie", "engine": "codex",
  "url": "https://auth.openai.com/codex/device", "code": "ABCD-EFGH",
  "at": 1764000001000, "signedIn": null,
  "hostKey": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "signature": "…" }
```

A `reply` that is not a key something can be sealed to is refused before
anything is started (`bad_params`). A box that cannot sign or seal passes
nothing on: it refuses (`answer_unsigned`) and says so.

**What a phone does before it shows a code or an account**, in this
order:

1. Makes a seal key for this one request, as it does for a vault
   request, and sends its public half as `reply`.
2. Opens `sealed` with that key. Only the phone that asked can.
3. Works out `host` from the `hostKey` inside, and finds it as the `key`
   of a grant for the whole vault in that member's vault `list` answer,
   under the name of the machine it asked. That answer is sealed by the
   minter, so this is the step a coordinator cannot stand in for: it can
   seal a payload of its own to `reply`, which is a public key, and it
   cannot make this hash one of the member's approved machines.
4. Checks `signature` under `hostKey` over the payload above, rebuilt
   with its own request's `id`, `member` and `engine` and the opened
   `url`, `code`, `at` and `signedIn`.
5. Only then shows `url` and `code`, or who is signed in, from the opened
   payload and from nowhere else.

A phone that finds a step failing shows nothing of the code or the
account and one sentence. The vectors both phones hold this to are in
`test/fixtures/parity/engine-signin-answer.json`: a signed answer, and a
sealed one with the key that opens it.

**Without `reply`** the answer is as it was before sealing: in the clear,
with `url`, `code`, `hostKey`, `signature` and `signedAt` (the `at` that
was signed) beside them while a code is out, and `signedIn` with its
`who`, unsigned. That is what the MCP tool gets, and what it is told is
unverified ("What it does not stop").

The page and the code are not secrets, and they are for whoever asked and
nobody else: they are in the answer to `start` and to `status`, and in no
file, no log line, no event, no health frame and no push. They are held in
memory in one place for as long as they are of use, the hub's attempt.
**The sidecar's cache of replies does not keep them.** It remembers every
mutating request by its id for ten minutes, to answer a retry with what
the first attempt was told. For an answer that carried a code, or was
sealed, it remembers only that the id was answered, and a retry of that
id is answered afresh with where the sign-in stands now, signed over the
same id and sealed to the retry's own `reply`: the attempt in flight
while one is, and never a second attempt.
The container then waits, for as long as the code lasts, for the engine to
say how it ended. **One attempt a member and engine at a time**: a second `start`
while one waits answers with the one in flight (`already: true`) and
starts nothing. A start that gets no code within 45 seconds is stopped and
refused, with the engine's sentence when it gave one.

**`status`** says where it stands, and never more than the box knows:

| `state` | what the box knows |
|---|---|
| `none` | no attempt and no sign-in was ever made here for this member and engine |
| `waiting` | a code is out, with `url`, `code`, `expiresAt` and `expiresInMinutes` |
| `signed_in` | the engine said the sign-in succeeded, at `at` |
| `expired` | the 15 minutes passed with nobody approving it |
| `failed` | the engine refused or failed; `detail` is its own sentence |
| `cancelled` | somebody cancelled it |
| `lost` | the hub restarted while a code was out, so that attempt is gone and its container was removed. Never reported as waiting |
| `signed_out` | the engine was asked to sign out here, and did |
| `ended` | a session of this member found the sign-in no longer works |

Beside `state`, every answer carries `signedIn`: `{ since, who }` when this
machine holds a sign-in it was told of, else `null`. They are two facts. A
new attempt that expires leaves the sign-in before it in place, and the
answer then says `expired` and still says who is signed in. `who` is what
the engine itself says of the account, `{ email, plan }` for Codex
(`account/read`), and `null` for OpenCode, which keeps a token and no name.
In a sealed answer `who` is inside `sealed`, signed with the rest, and the
clear `signedIn` says only `since`. No token is in any answer.

**`cancel`** stops the container. **`signout`** cancels an attempt that is
waiting, then has the engine sign out in a container of the same kind
(`--signout`): Codex is asked `account/logout`, and OpenCode's server is
asked to remove its `github-copilot` entry (`DELETE /auth/github-copilot`).

**What the box keeps** is in memory for an attempt that is waiting, and in
`engine-signins.json` in its state directory for the rest: for each member
and engine, how the last attempt ended, when, who is signed in and since
when, and who asked. No token, no code and no page.

**When an attempt ends** the machine says so to the coordinator
(`engine.signin`, with the member's id, the engine, the state and the
time). The coordinator tells the phones of that member's custodians, in
its own sentence and by name only: which member, which engine, which
machine, how it ended. A cancel is told to nobody; whoever cancelled is
looking at it. The same event is sent when a sign-in is signed out and
when a session finds one ended. Nothing is written to the fleet's feed.

**What each engine is asked**, read from its source at the version the
image pins:

- **Codex** (`codex app-server`, the process a session's turns go through):
  `account/login/start` with `{ "type": "chatgptDeviceCode" }` answers the
  page and the code; `account/login/completed` says how it ended, and
  Codex gives up by itself after 15 minutes; `account/read` then says who.
  A workspace or account with device code switched off answers the start
  with "device code login is not enabled", which is refused as
  `device_code_off` in Codex's words.
- **OpenCode** (`opencode serve` on loopback inside the container, behind a
  password made for that one run; `opencode acp` has no sign-in and its
  command-line login needs a terminal):
  `POST /provider/github-copilot/oauth/authorize` answers the page and
  "Enter code: XXXX-XXXX"; `POST …/oauth/callback` is held open while
  OpenCode asks GitHub, and answers `true` or
  `ProviderAuthOauthCallbackFailed`. That failure does not say why, so it
  is reported as `failed` in those words, and only the runner's own 15
  minutes are reported as `expired`. This is OpenCode's own login in its
  own binary. Fleetwright does not speak GitHub's device flow itself and
  uses no other app's client id.

**Refused before anything is sent**, by the coordinator, where it can
tell: no member named at all (`bad_params`, in words that say whose to
name), no such member (`no_member`), an asker who may not act for it
(`not_custodian`, `custody_unknown`, `not_signed_in`), a machine older than
the verb (`host_outdated`: "update fleetwright on …"), and a machine that
reported its engines and does not run this one (`no_engine`). The machine
is named and never chosen: with several permanent machines and none named
the refusal lists the ones that run the engine (`ambiguous_host`), and a
temporary machine or a box somebody else enrolled is refused
(`host_unavailable`), because a sign-in is kept where it is made. The
coordinator passes the machine's answer through, leaves `status` out of
its audit ring, and keeps nothing of a sign-in but what machines report.

**Refused by the machine**, each with a sentence: it is not approved for
the member's vault (`not_approved`, on `start`), or the vault has not told
it yet whose it is approved for (`approval_unknown`, on `start`); it could
not sign or seal its answer (`answer_unsigned`, with the code and the
account withheld), or was given a `reply` nothing can be sealed to
(`bad_params`, before anything is started); it does not run the
engine (`no_engine`, for every action); its session image is not fetched
yet (`no_image`); Podman is missing (`no_podman`) or the member's way out
behind an egress list could not be made (`no_egress`); the engine gave no
code within 45 seconds (`no_code`) or the container ended before one
(`signin_failed`); device code is off for the account (`device_code_off`);
a sign out is under way (`busy`) or the engine would not sign out
(`signout_failed`, which changes nothing the machine reports); the machine
cannot read its own record (`state_unreadable`, which is cannot tell and
is never answered as nobody signed in); its hub is older than its sidecar
(`hub_outdated`).

## What a machine reports

`health.engines` lists the engines a machine runs. `claude-code` is always
there. `codex` and `opencode` are there when the operator says so
(`FLEETWRIGHT_ENGINES=codex,opencode`) on a machine whose sessions run in a
container with the session's socket. A box cannot see into its image
cheaply, so the operator's word is the whole of it, and a wrong word is a
session that says the command was not found. The stock image has neither;
`WITH_ENGINES=1` at build time adds both, at pinned versions
(`sandbox/Containerfile`).

`health.engineSignins` lists the sign-ins this machine was told of: one
entry a member and engine, `{ member, engine, since }`, for each sign-in
made here with `enginesignin` that has not been signed out and that no
session has since found ended. Member ids and no account: who it is signed
in as is in the answer to `status`, for whoever may ask. The coordinator
shows each entry only to somebody who may act for that member, and only
from a machine that acts for them. It is what lets a screen say *Signed in
on ops-box* and offer the sign-in only on a machine whose `engines` names
the engine (C-2). **Absent is cannot tell**, never signed out: a machine
older than protocol 22 sends no list. A sign-in pasted into the vault is
not in it either, because no machine was told it works (C-5).

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
| signing `codex` in on the machine | `auth.openai.com` |
| signing `opencode` in to Copilot on the machine | `github.com` |

The container a sign-in runs in joins the member's own network behind the
list, as that member's sessions do, so the two sign-in rows are needed
before a code can be asked for at all.

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
  `fleet_engine_signin` is `enginesignin`, with the same four actions and
  the same refusals. It is withheld unless an operator allows it
  (`FLEETWRIGHT_MCP_ALLOW=enginesignin`), like the other tools that move a
  sign-in, and an MCP client acts on a delegation, so a box takes it only
  under a grant that carries `enginesignin` and names the member. Its
  caller cannot check the machine's signature, having no vault answer to
  check it against, and sends no `reply`, so its answers are in the clear:
  the tool's description and every answer that carries a code say the
  code is unverified.
- **Both phones**: Engines on a member's edit page, to add, remove, reorder
  and name a model; under a member's Credentials, for Codex and for
  Copilot, *Sign in on a machine* where a connected machine runs the
  engine, the code and its page, where each stands, and *Sign out*; the
  paste fields behind *Paste a sign-in instead*, with which machine holds
  a pasted Codex sign-in; the engine a session is on, and each handoff, on
  the session's page and the task's.
- **The signing page**: the two pasted items under a member's Credentials.
  It does not sign an engine in on a machine.

## What it does not stop

- **A code is only as checked as whoever shows it.** For a phone that
  sends `reply` and makes the checks, the coordinator cannot read the
  code, cannot put one of its own in its place, and cannot say who a
  sign-in ended on: the machine seals all three to the phone and signs
  them with the key a custodian approved for the member's vault ("The
  machine signs what it answers"). Two things are still open, and only
  these. **A phone that skips the checks** shows whatever arrived: one
  that sends no `reply` is answered in the clear, and one that opens
  `sealed` without holding the key to the member's approved machines, or
  without checking the signature, has only shown that somebody knew its
  public key. The checks are each app's to make, and the wire cannot make
  them for it. **The MCP path** has none of it: its caller holds no vault
  answer to compare a machine's key with and no key to seal to, so its
  answers are clear, the coordinator reads the code as it carries it and
  could change it or enter it first under an account of its own, and the
  tool says, in its description and after every code, that the code is
  unverified.
- **OpenCode names no account**, so for a Copilot sign-in there is no
  *Signed in as* for a person to find wrong, sealed or not.
- **A machine cannot tell a grant for some of a vault from one for all of
  it.** The vault's answer to a box does not say which it has, so a box
  approved for one named item of a member's vault takes a `start` for that
  member. A phone can tell, from the grant's `only`, and counts only a
  grant for the whole vault, as it does before sealing an admin's sign-in
  to a machine.
- **OpenAI's terms are the owner's to weigh.** OpenAI's page for the app
  server says "App-server authentication has never been permitted for
  commercial or hosted services." Signing Codex in on a fleet's machine
  is authentication through the app server. Whether a given fleet is such
  a service is not something this code can tell.
- **Device code can be switched off.** For a ChatGPT account or a whole
  workspace. Codex then answers that it is not enabled, the start says so
  in Codex's words, and what is left is the pasted file.
- **A pasted sign-in is a copy.** Whoever pasted a Codex `auth.json` still has
  the original on their own computer, and the first of the two to renew ends
  the other. Signing in on the machine does not have this: the sign-in is
  made there and exists nowhere else.
- **A machine says what it was told, not what is true now.** `engineSignins`
  and `status` report a sign-in from the moment the engine said it
  succeeded until somebody signs it out or a session of that member finds
  it ended. A sign-in revoked at the provider and not yet used by a session
  is still reported as signed in.
- **Two processes can spend one Codex refresh token.** Codex serializes its
  writes to a shared `CODEX_HOME` with lock files, and two sessions of one
  member renewing in the same moment can still both present the old token.
  One of them ends its turn as `auth`. Read from Codex's source, not seen.
- **Whose GitHub account OpenCode is signed in to is not known here.**
  OpenCode keeps a token and no name, so a Copilot sign-in is reported
  with no account beside it.
- **The model check believes the engine.** An agent that reports one model
  and runs another is not caught. What is caught is the case that was seen:
  an agent that says which model it fell back to.
- **`HANDOFF.md` holds what the engine printed last**, which may be anything
  the session had on its screen. It is quoted in a fence the text cannot
  close, so it stays a quotation, and it is still the session's own words in
  a file the next engine is told to read.
- **A removed member's engine home stays on the box.** Removing an agent
  empties its vault ([members.md](./members.md)); nothing removes
  `fw-engine-<id>` from each machine it was signed in on. It is mounted
  only into a session started as that member, which a removed member has
  none of, and a new member filed under the same id on that machine would
  find it. An operator removes it with `podman volume rm`.
- **A session on OpenCode or Codex that sits still is not restarted**, and
  nothing says it is stuck. An engine waiting out a provider's rate limit
  looks the same from the pane.
- **A session can say its own turn ended any way it likes.** TurnEnded comes
  over the session's socket from a process inside the session. A lie there
  puts a wrong word on a screen, or starts the member's own next engine in
  the same workspace. It names no other session and reaches no other vault.
- **A pasted sign-in ending is not told to a member's custodians.** The
  session says so; the fifteen-minute check that tells custodians about a
  Claude sign-in does not look at these. One made on the machine is told:
  the session that finds it ended is what marks it, and the machine's
  `engine.signin` reaches the custodians' phones.
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
that takes them), and `test/engines-in-apps.test.js`. Signing in on the
machine: `test/engine-signin-run.test.js` (the runner's sign-in mode
against stand-ins for `codex app-server` and `opencode serve`: a code, a
sign-in, a failure in the engine's words, the 15 minutes, device code not
enabled, a cancel, a sign out, the home used before the vault, and no token
in anything printed), `test/engine-signin-hub.test.js` (the box, through a
stand-in Podman and the real runner: the volume and its name, one attempt
at a time, what is kept and what a restart loses, who may and who may not,
a delegation that does not name the member, and no token in any answer,
file, event or log line), `test/engine-signin-answer.test.js` (the vectors
both phones check an answer against: a signed one with every field of it
changed in turn, and a sealed one with the key that opens it), the
sign-in tests in `test/vault.test.js` (a box not approved for the
member's vault, one the vault has not answered, the signature over a real
answer, a reply cache with no code in it, and a sealed answer as the
coordinator sees it and as the phone that asked opens and checks it),
`test/engine-signin-coordinator.test.js` (the
refusals before anything is sent, the protocol 21 refusal, who is shown
which machine's sign-ins, and who is told when an attempt ends).
