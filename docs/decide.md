# The decision model

When every deterministic reader of a session's pane has failed, the fleet can
ask one model one question about it: is a person being asked something? The
model is Cloudflare's Clef-flash on Workers AI, called only by the
coordinator. It is **off by default everywhere**, and turning it on takes three
deliberate steps, one of which only the operator of a production coordinator
can take.

The design, with the landscape that led to it, is
[`decide-design.md`](decide-design.md). This file is what shipped and how to
run it.

## Why

The matchers that notice a dialog are regexes over the pane (`AWAITING_RE` in
`src/fleet/host/watcher.js`, `readPrompt` in `src/fleet/host/prompt.js`), and
Claude Code rewords its dialogs. When the trust dialog was reworded, both went
blind: no notification, and the idle watchdog restarted the session straight
back onto the same question. Hooks cover most of that now, but the resume
dialog comes before any hook can fire, and a hook only exists where the session
reports them. The model covers the case where all of them say nothing.

## When the host asks

All of these, per running session, on the watcher's 20-second tick:

1. No hook newer than the pane's last change says `awaiting` or `ready`. Hooks
   win; the model never second-guesses one.
2. `AWAITING_RE` does not match and `readPrompt` reads nothing.
3. The pane has not changed for 90 seconds (`DECIDE_AFTER_MS`): longer than the
   two polls that make a transition, shorter than any idle-restart window.
4. This host has not asked about this pane hash before. The last 256 hashes are
   kept; a still pane is asked about once, whatever the answer.
5. The session is running and not already waiting.
6. `FLEETWRIGHT_DECIDE=1` on the host.

The ask does not hold up the tick. Its answer is read on a later tick, and that
is when the transition fires, once.

## What leaves the host

`maskPane` (`src/core/mask-pane.js`), and nothing else. It de-wraps the pane,
drops trailing blank rows, takes the last 40 lines and 4,096 bytes, and keeps a
whitespace-separated token only when its core is an ordinary word
(`/^[A-Z]?[a-z']{1,19}$/`), a short all-caps word (`/^[A-Z]{1,8}$/`) or a number
of at most three digits. Punctuation and box drawing at either end are kept.
Everything else becomes `▮▮▮▮`. That removes setup tokens, `fwk_` keys, OAuth
and Remote Control URLs, ssh keys, env dumps, paths, hostnames, emails, hashes,
identifiers and version strings without naming any of them, and keeps
"Do you want to proceed", "1. Yes", "2. No".

Known loss: a secret that is a dictionary word survives, as it would in any
mask, and so does a filename that is a word.

The mask also never produces anything the coordinator's gate refuses: it
re-checks every token it emits against the gate's own patterns and cuts again
after masking. `test/decide-gate.test.js` holds the two to each other over every
labelled pane in the repository.

Never the raw pane, never a screenshot, never `images`.

## The frames

```
host → coordinator  { v, kind: 'decide', hostId, id, name, hash, state }
coordinator → host  { v, kind: 'decided', id, ok, asked?, p?, dialog?, confidence?, why? }
```

The `vault`/`minted` shape. An answer with an id nobody is waiting for is
dropped, and no answer in 10 seconds is nothing. The design called the dialog
field `kind`; it is `dialog` here because `kind` is the frame's type.

## The coordinator's walls, in order

Every refusal is an answer with a `why`, so a host can tell them apart.

| wall | number | refusal |
|---|---|---|
| the switch and both bindings | `FLEETWRIGHT_DECIDE` exactly `"1"`, plus `AI` and `DECIDE_RATE_LIMIT`, which only `wrangler.production.toml` declares | `off` |
| the gate (`refuseUnlessMasked`) | `images` present; state empty; over 4,096 bytes or 40 lines; a run of 20+ `[A-Za-z0-9_-]`; `sk-ant-`, `fwk_`, `http(s)://`, an email, `-----BEGIN` | `refused:<rule>` |
| the platform rate limit | 30 a minute, namespace 1003, kept by Cloudflare | `ratelimited` |
| per session | one decision per session per 10 minutes | `ratelimited` |
| per host | 20 an hour | `ratelimited` |
| the day's budget | `DECIDE_NEURONS_PER_DAY`, default 8,000, clamped to 100,000 | `budget` |
| the call | one, 8-second timeout, no retry | `error` |

The gate refuses and never cleans. A refusal is logged as
`coordinator: decide refused from <host>: <rule>`, never with the text, and
counted. A host whose mask let something through logs the refusal too.

**Every cap is persisted.** The day's spend and both windows are stored under
the Durable Object key `decide` the moment they move, so a deploy or an
eviction does not hand out a fresh allowance. 128 rows of each window fit in a
DO value at their widest (`test/do-key-bounds.test.js`).

**The budget.** Each call is charged before it is made, at
`(450 + ceil(bytes / 3)) × 0.003455` neurons, and reconciled to
`usage.input_tokens × 0.003455` after. The 450 is measured, not assumed: the
questions themselves cost about 400 input tokens, so a 166-byte pane billed 423
tokens in the first harness run. A call that never comes back stays charged.
The day turns over at 00:00 UTC, with Cloudflare's free allowance. At 80% of the
budget the coordinator logs one warning a day.

The masked state is dropped after the call. The coordinator keeps counters and
nothing else.

## What the answer may do, and the one thing it may do

`ok && asked && p ≥ DECIDE_P_AWAITING` marks the pane as waiting, for as long
as the pane is exactly that pane. In effect:

- `awaiting` is true as if `AWAITING_RE` had matched, with no question read;
- `awaitingSince` is set and `fleet_await` returns "waiting for an answer";
- one `session.awaiting-input`, saying *is waiting for you; the fleet could not
  read what it is asking, open it to see*, with no `prompt`, so no `promptId`,
  no buttons, and nothing a phone can answer;
- idle restart is withheld, so the restart-onto-the-dialog incident cannot
  recur.

The pane changing clears it. Anything else, a `p` below the threshold, `asked`
false, a refusal, a timeout, the feature off, does nothing: the pane stays
unrecognised, which is *cannot tell*. The model never sets `ready`, never clears
a waiting a regex or a hook set, never feeds idle detection, and never writes a
prompt. `dialog` and its confidence go to the host's journal only, as evidence
for `DIALOGS`.

## The threshold, and the run that set it

`DECIDE_P_AWAITING = 0.8926`, in `src/core/decide-questions.js` beside the two
pinned questions it was measured against. It is the lowest value at which no
hand-labelled negative read as asked, on masked text. From
`scripts/decide-harness.mjs` on 2026-10-31, 76 panes, each masked and unmasked:

| | masked | unmasked |
|---|---|---|
| threshold with no false asked | 0.8926 | 0.9206 |
| recall, 60 reworded dialogs | 58/60 | 57/60 |
| false asked, 14 negatives | 0/14 | 0/14 |
| regexes' recall on the same 60 | 0/60 | 0/60 |
| latency p50 / p90 / max | 257 / 363 / 1,072 ms | 267 / 424 / 930 ms |

Masking cost nothing measurable: the mean difference in `p` was 0.015, and the
masked text separated slightly better. `kind` was right 49 times in 62, and 12
of 13 at confidence 0.7 or more, which is why it stays journal-only.

**The margin is thin, and it is set by one case.** The highest negative, at
0.8925, is the assistant asking its own question in prose above an empty
prompt; a yes/no question in prose came next at 0.8799. The two misses were
trust rewordings at 0.86. Re-run the harness when the questions, the model or
the mask change, and change the threshold and `test/decide-questions.test.js`
in the same pull request.

## Injection, accepted

A session's own output can be crafted to read as a dialog: a printed numbered
list is the obvious one, and the closest negatives above are that case. The
worst it can do is one `awaiting-input` push, quiet-windowed and capped like
any other, and idle restart withheld for that pane until it changes, which is
how every pane behaved before the watchdog existed. It cannot answer anything,
send text, or change policy.

## Retention: the operator's question

Cloudflare's model page says nothing about retention or logging of inputs.
Before turning this on, read the model's Hugging Face card and Cloudflare's
Workers AI data terms. A fleet that will not send even masked text leaves it
off; nothing else depends on it.

## Turning it on

1. **The coordinator:** `FLEETWRIGHT_DECIDE = "1"` in the `[vars]` of
   `wrangler.production.toml`, beside `DECIDE_NEURONS_PER_DAY`, and deploy. The
   `[ai]` binding and the `DECIDE_RATE_LIMIT` rate limit are already there. The
   fork-safe `wrangler.toml` has neither, so a fork cannot spend whatever it
   sets (`test/fork-safe-config.test.js`).
2. **One host:** `FLEETWRIGHT_DECIDE=1` in its sidecar env file, then restart
   the sidecar.
3. **Watch it for a week** on the health surface, then set Cloudflare's billing
   usage alert, which is the operator's to set and no code's.

## Reading the spend

`fleet_health` prints, when the coordinator has it on:

```
decide: 412 of 8000 neurons today, 37 calls
```

and adds `, N refused by the gate` when some host's mask let something
through; the coordinator's log names the host. The same numbers are
`health.decide: { enabled, today, budget, calls, refused }` on a health reply.

## In CI

`scripts/claude-dialog-drift.mjs` asks the same two questions about every
dialog-shaped component of the pinned Claude Code that `DIALOGS` does not
list. Advisory only; [`ci.md`](ci.md#unlisted-dialogs-read-by-a-model) has its
secrets.

## The harness

```sh
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node scripts/decide-harness.mjs --out report.json
```

Local only, never in CI. The token needs Account → Workers AI → Read. A full run
is about 150 calls and 63,000 input tokens, about 220 neurons. It exits 2 when
masked recall on the reworded dialogs is not clearly above the regexes', which
is the answer "nothing ships". The corpus is `scripts/decide-corpus.mjs`, every
item labelled by hand; a backend is one function, so the same corpus can run
against other weights later.
