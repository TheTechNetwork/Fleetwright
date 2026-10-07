# Telemetry: what a fleet could know about its own sessions

**Status: the three questions are answered, without any of the channels this
file researches.** What a session cost, how long it worked and whether it is
blocked on a person now come from what the machines already had — the hooks,
the watcher, and a line Claude Code writes into its own transcript — and
"What shipped" below says how. The OpenTelemetry route is still wanted and not
built, and the privacy decisions in front of it are unchanged. This file exists
so the research is not done a third time — and because the first answer given
to the question was wrong in a way worth recording.

Read as of 10 September 2026. Every claim about Anthropic's behaviour below is
from their documentation, which is a statement by the party being asked about;
the last section says what to do about that.

## What shipped, and what it took

Written 7 October 2026, against Claude Code 2.1.292; the research sections
after this one are as of the date above.

The row asked three things — what a session cost, how long it worked, and
whether it is blocked on a person right now — and none of the answers needed a
new channel. All three were already on the machines, in places this fleet
already read for something else.

| Question | Where the answer was | Field |
|---|---|---|
| Is it blocked on a person, and since when? | the watcher already saw it and raised `session.awaiting-input`, then kept the moment to itself; the `PermissionRequest` hook already said it with a timestamp | `awaitingSince` |
| How long has it worked, and how long has it waited? | every lifecycle hook already arrived with a moment (`docs/hook-socket.md`); nothing added them up | `phases` |
| What has it cost? | **Claude Code writes its own running total into the transcript**, as a `cost-state` line | `spent` |

All three ride on each session in health and in the `list` and `status`
replies, which is where both phones and fleet_await read sessions from. The
contract is `openapi.json`'s Session schema. Each is null for CANNOT TELL, and
every surface draws null as nothing rather than as zero.

### Blocked on a person: a floor, not a stopwatch

`src/fleet/host/watcher.js` `awaitingSince`. The earlier of two witnesses: the
hook's own moment, when the CLI said a dialog went up, and the first tick the
watcher saw one on the pane — which is all there is for the resume dialog (it
appears before any hook can fire) and for an image older than the hooks. So it
can be up to one watcher interval late, and a watcher that restarts begins
again at its first look. Every reader rounds coarsely or says "at least".

Finding it exposed a bug worth recording. `fleet_await` promised to return when
a session needs a person and read `session.awaiting` to find out — a key no
layer of the fleet had ever sent. The branch was unreachable on a live fleet
and passed its tests only because their fake fleet invented the key: the fourth
time that fake has certified a bug (`scripts/check-mcp-client.mjs` records the
other three). And the phones' "Waiting for you" keyed on a `prompt` that health
carried and the `list` reply — the one the phones actually read — never did.

### Working versus waiting: the hooks' moments, added up

`src/core/activity.js` `advancePhases`. Closed time per phase — working,
awaiting a person, at its own prompt — plus the moment the open stretch began,
so the phone adds the open part from its own clock (the reason `startedAt` is a
timestamp). It belongs to one run of a container: cleared at every launch,
resume and stop, and not by `SessionStart`, which fires again on `/clear` and
`/compact` inside one run. Runtime state on the hub, so a hub restart starts
counting again — `since` says when counting began, and the phones say "counted
for the last 2h" rather than let the lost hours read as none.

### Cost: Claude Code's own figure, never ours

`src/core/spent.js`. The tempting version sums the `usage` on each assistant
entry, and it is wrong three ways: Claude Code writes one entry per content
block with the same usage repeated on each (9,833 entries for 5,042 messages on
the transcript this was measured against), a subagent's turns are not all in the
file, and dollars would need a price table — a table about somebody else's
product, wrong the week a price changes.

It does not need to. Claude Code writes a `cost-state` line —
`totalCostUSD`, per-model token counts, `hasUnknownModelCost`, `startTime` and
`totalDuration` — the running total its own `/cost` draws, written so a resumed
conversation carries it on. That is the only figure this reads. Observed
against CLI 2.1.292; a transcript without one, or with one in a shape this does
not read, is null.

Two facts about it decide how it is read and how it is drawn:

- **It is written when a turn ends with nothing queued behind it**, after the
  Stop hooks. So a session in the middle of a long turn is reported as of its
  last pause, and `asOf` (`startTime + totalDuration`, the CLI's own clock)
  says when that was. The phones add "as of 12m ago" once it is five minutes
  old on a running session.
- **It is irregular in the file.** On the 131 MB transcript this was measured
  against the last one was 2.4 MB from the end and the widest gap was 16 MB, so
  the half-megabyte tail `context-usage.js` reads would miss it. The reader goes
  backwards from the end, stopping at the first figure or at what an earlier
  read already covered, and gives up at 32 MB; that took 35 ms on that file, and
  a second read of the same file reads nothing. The hook inside a sandbox keeps
  how far it got in its container's `/tmp`, so only the first hook of a run
  pays for the scan.

The figure is **at API prices**, which is what Claude Code computes; on a Pro
or Max sign-in it is not what anybody is billed, and every surface says "at API
prices" rather than drawing a bare dollar sign that reads as a bill. When
Claude Code says some model had no known price, the figure is a floor and is
drawn as "at least". A sandboxed session's figure is kept on its registry
record, written only when it changes, so what a session cost is still known
after the container and the hub that heard it are both gone.

### What this did not do, and why

- **No OpenTelemetry, no collector, no new destination.** Everything above
  travels host → your coordinator → your phone, on frames that already carried
  the session's title, directory, question and window size. It adds a dollar
  figure, four token counts and three durations to that frame, keeps no
  history (the coordinator holds the last health frame, as before), and
  aggregates nothing per person. None of the three privacy texts below is about
  that path, and none of them is made misleading by it. The OTel route would
  be a different class of data, and the decisions below still stand in front of
  it.
- **No status line.** Claude Code hands `cost.total_cost_usd` to a `statusLine`
  command each time the status line updates, which would be fresher than `cost-state`. It would
  also replace the status line of every session a person is driving through
  Remote Control with ours, to read a number the transcript already holds.
- **No price table, no summing.** For the reasons above, and because a number
  this fleet computed would be a claim C-5 asks it to prove.

## The question

A fleet runs Claude Code sessions on machines we own, and knows almost nothing
about what happened inside them. `fleet_read_log` returns a pane's scrollback,
the watcher notices a session coming back to its prompt, and that is the whole
of it. The obvious wish is per-session numbers: what it cost, how long it
worked, which tools it reached for, whether it got anywhere.

The first answer was that the data is not available. That is half right, and the
half that is wrong is the useful half.

## Three sources, and the wall in front of each

| Source | What it gives | The wall |
|---|---|---|
| Claude Code Analytics API (`/v1/organizations/usage_report/claude_code`) | One row per user per **day**: sessions, lines added/removed, commits, PRs, four tool accept/reject pairs, tokens and estimated cost per model | Admin API key. "The Admin API is unavailable for individual accounts" |
| Usage & Cost API (`/usage_report/messages`, `/cost_report`) | Token and dollar totals by model, workspace, service tier, bucketed to the minute | Same Admin API key |
| Enterprise Analytics API (`/v1/organizations/analytics/*`) | Per-user activity across chat, Claude Code and Cowork; adoption rates; cost | Claude Enterprise plan, and only the **primary owner** can mint the key |
| Compliance API (`/v1/compliance/*`) | Per-event activity feed, and full session transcripts | Enterprise, or Console for the feed alone |

All four are gated on organisation type, not on permission. If the fleet's
sessions run under a personal Pro or Max login there is no screen on which to
create any of these keys. One command settles which case a deployment is in:

```
curl https://api.anthropic.com/v1/organizations/me \
  -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01"
```

## OpenTelemetry is not a channel to Anthropic

This is the correction. `CLAUDE_CODE_ENABLE_TELEMETRY=1` reads like consent to
be tracked and is not: it turns on a stock OTLP exporter aimed at
`OTEL_EXPORTER_OTLP_ENDPOINT`, which is **our** address. Point it at a collector
on the host and the data lands there and stops. There is no Anthropic
destination in the OTel configuration and no way to add one.

It is also not gated on an organisation, and it is a finer grain than the
Analytics API sells:

- **8 metrics** — `session.count` (with `start_type`: fresh / resume / continue),
  `lines_of_code.count`, `commit.count`, `pull_request.count`, `cost.usage`,
  `token.usage`, `code_edit_tool.decision`, `active_time.total`.
- **13 event types** — `user_prompt`, `assistant_response`, `tool_result`
  (carrying `duration_ms`, `success`, `error_type` and input/output byte sizes),
  `api_request`, `api_error`, `api_refusal`, `tool_decision`,
  `permission_mode_changed`, `auth`, `mcp_server_connection`, `plugin_loaded`,
  and raw request/response bodies.
- **Traces**, in beta: `interaction` → `llm_request` / `hook` / `tool` →
  `tool.execution`, `tool.blocked_on_user`.
- Cost and token metrics attribute down to `agent.name`, `skill.name`,
  `plugin.name`, `mcp_server.name`, `mcp_tool.name`, `speed`, `effort`.

Two of those matter more than the rest here. `tool_result.duration_ms` with
`success` is the evidence C-5 keeps asking for — what a session *did*, arriving
while it is still running rather than aggregated the next day. And
`tool.blocked_on_user` is, for the first time, a machine-readable answer to the
question `docs/mcp.md` ends on: **a finished session looks exactly like an idle
one.** A session blocked on a person is not the same shape as one that stopped.

There is a third source that needs nothing at all: Claude Code already writes
plaintext session transcripts to `~/.claude/projects/` and keeps them for 30
days (`cleanupPeriodDays`). Those are on our machines now, unread.

## What does go to Anthropic, and what turns it off

Separate question, and the honest one. For a Pro or Max sign-in against the
Claude API these are on by default:

| Channel | Carries | Off switch |
|---|---|---|
| Metrics | latency, reliability, usage patterns, to Anthropic and a third-party logger. Documented as never including code, prompts or file paths | `DISABLE_TELEMETRY=1` |
| Error reports | stack traces from Claude Code's own internals, secrets and paths redacted first. On for Pro/Max on v2.1.198+ | `DISABLE_ERROR_REPORTING=1` |
| Session quality survey | the rating only; the transcript-share follow-up is a separate explicit Yes | `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1` |
| `/feedback`, `/bug`, `/share` | the conversation including code, retained five years | `DISABLE_FEEDBACK_COMMAND=1` |
| WebFetch preflight | the hostname only, to `api.anthropic.com`. **Not** covered by the master switch | `skipWebFetchPreflight: true` |

`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is the master switch.

And the part no switch reaches: every prompt and every model output goes to
`api.anthropic.com`, because that is the product rather than telemetry.
Retention on a personal Pro or Max account is five years with the training
toggle on and 30 days with it off; commercial is 30 days; zero data retention is
Enterprise-only and not in the standard plan.

## The switch costs us Remote Control

This is the part that is specific to this system and the reason the off switch
is not free:

> Setting `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` also
> disables the feature-flag evaluation that Remote Control depends on;
> `DISABLE_ERROR_REPORTING` doesn't.

Remote Control is load-bearing here. It is in `sidecar.js`, `pane.js`,
`watcher.js`, `hub-client.js` and `claude-credential.js`, it is in eight
documents, and the handoff the MCP server describes — start a session, give the
person its Remote Control URL because they can drive it and the model cannot —
is the whole of what a fleet does when no profile fits. Turning off
non-essential traffic turns that off.

So it is a three-way choice rather than a switch:

1. `DISABLE_ERROR_REPORTING=1` alone. Free, and Remote Control survives.
2. `DISABLE_TELEMETRY=1`. Kills the metrics channel and Remote Control with it.
3. **Default-deny egress at the container**, permitting `api.anthropic.com` and
   whatever Remote Control needs. Keeps the feature, and replaces a claim with a
   log — which is the shape `docs/trust.md` already argues for everywhere else.

Option 3 is the one that fits this project, and it is not a new idea here: the
credential-terminating proxy in `docs/trust.md` is already specified with
default-deny egress. This would ride on it rather than beside it.

## What would have to be decided before any of it ships

**Where the collector lives.** On each host is the easy answer and gives no
fleet-wide view; at the coordinator means session-level data keyed to a person
crossing the network to a machine that is *ours* in the hosted case. That is a
new class of data for this system and the reason the next item exists.

**What the privacy text becomes.** Being precise, because the earlier draft of
this paragraph overstated it: today's promises are about the app and the relay,
not about sessions. `worker/src/pages.js` says there is "no analytics,
advertising or tracking of any kind" of a *client for a coordinator you run
yourself*; `apps/store-listing.md` says the only traffic is between the app and
the coordinator you typed in; `docs/relay-terms.md` forbids analytics and
metrics keyed by device token in the *push relay*. None of the three is
literally falsified by a host-local collector. All three would read as
misleading beside a coordinator that collected per-session metrics per person,
and the fix is to say what is collected before it is collected, not to argue the
sentences still parse.

**What the console would actually use.** Collecting eight metrics because they
exist is how a fleet ends up with a dashboard nobody reads. The design system's
dials say the same thing — calm recedes, trouble comes forward — so the
question is which of these earns a place on a screen. The candidates are the
ones that answer a question the console cannot answer today: is this session
blocked on a person, what has it cost, and did it do anything.

**Whether the container can reach a collector at all.** Unverified. The session
network is a normal bridge, and the route from inside a container to a collector
on its host has not been tested here.

## The cheapest experiment, which needs no code

`FLEETWRIGHT_SANDBOX_ARGS` is spliced into `podman run` and its refusal list
(`src/core/sandbox-args.js`) names sandbox-defeating options only — `--env` is
not among them, and should not be. So a single box can be pointed at a collector
today, by an operator with a shell, without a line of code or a protocol
version:

```
FLEETWRIGHT_SANDBOX_ARGS="--env CLAUDE_CODE_ENABLE_TELEMETRY=1 --env OTEL_METRICS_EXPORTER=otlp --env OTEL_EXPORTER_OTLP_ENDPOINT=..."
```

That answers the reachability question above and produces a real sample of what
the metrics look like on this workload, which is what the "what would the
console use" decision needs and does not have. It is not the feature, and it is
deliberately not on the roadmap as one — it is the thing to do first if this
ever moves.

## Not decided

Whether to do the OpenTelemetry part of it. The three questions the row asked
are answered above without it; what it would add is the grain — per-tool
durations and results, lines and commits, per-skill cost — and that is the
part that would be a new class of data. The reason to write it down now is that the research
cost more than the conclusion, and the conclusion — **the data exists, at a
finer grain than the API sells, on machines we already own, and the price is a
privacy promise that has to be rewritten first** — is the kind that gets
rediscovered from scratch in six months.
