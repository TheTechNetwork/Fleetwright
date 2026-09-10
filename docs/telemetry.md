# Telemetry: what a fleet could know about its own sessions

**Status: wanted, not built.** Nothing here is scheduled, no code has been
written, and the privacy text this would have to change has not been changed.
This file exists so the research is not done a third time — and because the
first answer given to the question was wrong in a way worth recording.

Read as of 10 September 2026. Every claim about Anthropic's behaviour below is
from their documentation, which is a statement by the party being asked about;
the last section says what to do about that.

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

`AGENT_HUB_SANDBOX_ARGS` is spliced into `podman run` and its refusal list
(`src/core/sandbox-args.js`) names sandbox-defeating options only — `--env` is
not among them, and should not be. So a single box can be pointed at a collector
today, by an operator with a shell, without a line of code or a protocol
version:

```
AGENT_HUB_SANDBOX_ARGS="--env CLAUDE_CODE_ENABLE_TELEMETRY=1 --env OTEL_METRICS_EXPORTER=otlp --env OTEL_EXPORTER_OTLP_ENDPOINT=..."
```

That answers the reachability question above and produces a real sample of what
the metrics look like on this workload, which is what the "what would the
console use" decision needs and does not have. It is not the feature, and it is
deliberately not on the roadmap as one — it is the thing to do first if this
ever moves.

## Not decided

Whether to do any of it. The reason to write it down now is that the research
cost more than the conclusion, and the conclusion — **the data exists, at a
finer grain than the API sells, on machines we already own, and the price is a
privacy promise that has to be rewritten first** — is the kind that gets
rediscovered from scratch in six months.
