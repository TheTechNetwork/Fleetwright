<!-- Design record. Copied from the planning session so a fresh clone carries it; the implementation PRs are the ones that make it true. -->

# Decision models in Fleetwright: landscape and closed design

## Context

The question began as "how could Jev help build and test this", moved through
on-device models for phones, and settled on Cloudflare's Clef-flash on Workers
AI because the coordinator already lives there. This file is the landscape
(what the codebase decides and under what rules), then the design, closed as
far as design can close it. Three findings drove everything:

1. **The phones decide nothing.** Every judgement a phone shows is computed
   on the host or coordinator and sent as fields. The only on-device model in
   either app names a session (`apps/ios/Fleetwright/Naming.swift`); the
   Android twin is a deliberate stub awaiting Gemini Nano.
2. **The judgements that have gone wrong are host-side regexes reading the
   terminal pane**, and most had structural fixes. The one class with
   repeat history is Claude Code rewording a dialog so the matchers go blind.
3. **The coordinator is a Cloudflare Worker**, so Workers AI is an `[ai]`
   binding, not a new vendor; and the account is on Workers Paid, so a
   runaway bills.

## Landscape

### What a Jev-class model is

An input plus a fixed set of typed questions, one forward pass, calibrated
probabilities back. No text. A low probability maps to `null` (*cannot
tell*), which is what C-5 demands of any reader. Hosted Jev
(`typesafe/jev-1.13`) is the reference; open-weights reproductions exist
(JevK5 4B Apache-2.0, MiniCPM5-2B-Jev, OpenJev-8B Apache-2.0; OpenJev-Flash-9B
is non-commercial, unusable). Apple ships no Jev; `fmev` proxies the API shape
onto Apple's on-device model on macOS 27. Android's only on-device route is
Gemini Nano via ML Kit's Prompt API, prompt-based not typed.

### Where a decision is made today

Host (`src/fleet/host`), the only observer of a session:

| Decision | By | Known failures |
|---|---|---|
| Person being asked? | `watcher.js:41` `AWAITING_RE`, OR hook phase `awaiting` | Trust dialog reworded, both matchers blind, session restarted back onto the dialog (`prompt.js:48-62`) |
| Which question, which options? | `prompt.js:130` `readPrompt`, `KINDS`, `OPTION_RE` | `/cd` misread as trust; pinned release draws trust options unnumbered (`prompt.js:63-87`) |
| Ready vs working | `watcher.js:96-121`, hooks win | 2.1.284 draws the same chrome both ways; `fleet_await` called a 40 s build "finished" |
| Wedged vs quiet vs done | `watcher.js:543` pane hash + timeout | Finished sessions restarted twice and declared stuck; `docs/sidecar.md:236-275`: no reader of a still pane can tell |
| RC URL, login state, resume dialog | `pane.js`, `login.js`, `claude.js` regexes | Width-dependent truncation; token cut at 79/108; resume sat two days |

Hooks (`src/core/activity.js`) win over the pane when present; the pane stays
an independent witness because any local process can POST a hook
(`docs/plan.md:108`). The resume dialog appears before hooks exist.

Coordinator: push triage (`NOTIFIABLE`, `worth`, `#mayPush` quiet windows and
hourly cap after 610 frames made 598 pushes), host health state machine,
placement sort. Deterministic, incident-tuned. MCP: `fleet_await` reports
*back at its prompt*; done-ness is the caller's reading of the log
(`docs/mcp.md:325-360`). CI: `scripts/claude-dialog-check.mjs` finds listed
dialogs in the pinned binary by anchor string; `verify.sh` classifies
nothing; the labeler is path-glob only. Phones: fixed rules over fields,
server ordering, raw pane and log, one on-device namer.

### Constraints

- **C-5**: a screen may not report what it does not know; `null` is *cannot
  tell*, never *nothing needs you*.
- **Pane text does not leave the box** (`docs/plan.md:110`, `prompt.js:13-23`):
  only fleet-authored questions and capped labels travel, labels only with
  `FLEETWRIGHT_PROMPT_TEXT=1`; the prompt subject never leaves, only its hash.
- **Answering is policy, not perception**: `answer` withheld from agents
  (`src/mcp/tools.js:47-123`); the console refuses to classify option text.
- **Phones cannot claim session state** they did not observe.
- **Hosts are Node-only**, Linux and macOS, no Python, no GPU, no local
  inference runtime; ephemeral runners are VMs without Apple Intelligence.
- **The coordinator is treated as compromised for custody**
  (`docs/security.md`; `worker/src/sentry.js` header).
- **CI on a pull request needs no secrets**; secret-dependent jobs skip with
  a notice (`docs/ci.md`).
- **Caps must persist**: an in-memory cap in a Durable Object is per rebuild
  (`core.js` ~1095); and **fire on transitions, never states**
  (`watcher.js:15-19`).

### Where a model is the wrong tool

Done vs wedged (liveness, structural). Ready vs working (hooks). Push
triage, placement, health (deterministic, and a wrong probability costs a
missed buzz or a misrouted job). Anything on a phone claiming session state.
Choosing an answer to a dialog.

### Where it fits, ranked

1. **CI dialog drift**: classify every dialog-shaped component in the pinned
   binary; report an unlisted one on the version-bump PR. Public input.
2. **Host last-resort pane reader**: when hooks, `AWAITING_RE` and
   `readPrompt` all say nothing and the pane is still, ask once whether a
   person is being asked something. Enters only through the door
   `watcher.js:655` already has: "Recognised as waiting, not recognised as a
   question. Honest about it."
3. Report-only CI failure labelling; a junk-test sweep against
   `test-audit`'s patterns. Later, cheap, advisory.
4. Phones: finish Android naming via Gemini Nano; nothing new.

## Clef-flash: the facts the design rests on

From Cloudflare's model page and its input/output JSON schemas, Oct 2026:

- Model `@cf/cloudflare/clef-flash`, 9B, Apache-2.0 weights on Hugging Face.
- Request: `{ model: "clef-flash", state, questions, images? }`. `state` is a
  string or structured data, truncated to fit. `questions` is 1–64 keyed
  entries; types `noul` (yes/no: `instructions`, optional `criteria.true/false`),
  `choice` (`instructions`, `criteria` map of 2–255 options), `score`.
  Mixed types in one call.
- Response: `answers` keyed by id. `noul` → `{ type, noul: 0..1 }` (probability
  of yes; **no confidence field**). `choice` → `{ type, choice, probabilities,
  confidence }`. Plus `usage.input_tokens` and `usage.output_tokens`.
- Context 24,576 tokens. Images accepted (data URLs, ≤4). Output not billed.
- Price $0.038 per M input tokens = 3,455 neurons per M; 10,000 neurons/day
  free; $0.011 per 1,000 after.
- REST: `POST https://api.cloudflare.com/client/v4/accounts/{id}/ai/run/@cf/cloudflare/clef-flash`
  with a bearer token works outside a Worker (harness, CI).
- **No retention or logging policy on the model page.** Operator reads the
  Hugging Face card and Cloudflare's Workers AI data terms before enabling.

Cost at ~1,000 tokens per call: CI check per Claude Code bump ~100k tokens,
free. Host fallback as designed (~5/hour/host, 10 hosts) ~1.2M tokens/day,
free. Naive every-poll classification (30 panes, every 20 s) ~130M
tokens/day, ~$150/month. The design makes the naive shape impossible.

## Closed design

### A. The host side: when, what, and what happens to the answer

**Trigger**, in `watcher.js`, evaluated per running pane per 20 s tick, all
of these true:
1. `activity` is null or its phase is not `awaiting`/`ready` from a hook
   newer than the pane's last change (hooks win; the model never overrides
   a hook).
2. `AWAITING_RE` false and `readPrompt(pane)` null.
3. Pane hash unchanged for `DECIDE_AFTER_MS` (default 90 s: longer than the
   two polls that make a transition, shorter than any idle-restart window).
4. This pane hash has not been asked about before on this host
   (`#askedHashes`, a bounded Set of 256, FIFO). A still pane is asked about
   once. A host restart forgets the set; the DO's caps bound the re-ask.
5. The session is `running`, not already awaiting.
6. `decide.enabled` is on for this host (`FLEETWRIGHT_DECIDE=1`, default off,
   `src/fleet/host/config.js` beside `promptText`).

**What leaves the host**: `maskPane(dewrapPane(pane))`, section C, cut to
the last 40 lines and 4,096 bytes, and the pane hash. Never the raw pane,
never a screenshot, never `images`.

**Frame**: `{ v, kind: 'decide', hostId, id, name, hash, state }` over the
existing transport; answer `{ kind: 'decided', id, ok, asked: bool,
kind?: 'resume'|'trust'|'permission'|'directory'|'api-key'|'other', p?,
why? }`, the `vault`/`minted` shape (`core.js:6054`). Unanswered after 10 s
→ treated as `ok: false`. A reply with an unknown `id` is dropped.

**What the answer may do**, and the only thing it may do:
- `ok && asked && p ≥ DECIDE_P_AWAITING` → the pane is marked
  `modelAwaiting = { hash, since: now }`. While the current hash equals
  that hash, `awaiting` is true for this pane exactly as if `AWAITING_RE`
  had matched, with `prompt` null. So: `awaitingSince` set (a floor, as
  today), `session.awaiting-input` fired once via `#awaiting(name, session,
  null)`, idle-restart blocked (the restart-onto-the-dialog incident cannot
  recur), `fleet_await` returns "waiting for an answer". The event text is
  fleet-authored: "is waiting for you; the fleet could not read what it is
  asking, open it to see". No `prompt`, so no `promptId`, no buttons, no
  `answer` possible from the app (C-2). The `kind`, if any, goes to the
  journal only, as evidence for `DIALOGS`.
- Hash changes → `modelAwaiting` cleared. Pane moved on; the claim expires
  with its evidence.
- Anything else (`asked` false, `p` below threshold, `ok` false, timeout,
  feature off) → nothing. The pane stays exactly what it was: unrecognised,
  which is `null`, *cannot tell*.
- The model never sets `ready`, never clears `awaiting` a regex or hook set,
  never feeds idle detection, never writes to `prompt`.

**Threshold** `DECIDE_P_AWAITING`: starts at 0.90 and is set by the harness
(section F), not by taste. Calibration is the model's claim, and the
fixtures are the check.

**Injection**: a session's own output can be crafted to make the model say
yes (a printed numbered list looks like a dialog). Worst case: one
`awaiting-input` push (quiet-windowed and capped like any other), and
idle-restart withheld for that pane until the hash changes, which is the
pre-feature status quo. It cannot answer anything, send text, or change
policy. Accepted and written down.

### B. The coordinator: one spender, every wall

Only the Durable Object holds `env.AI`, through one method `#decide()`.
A test greps the Worker bundle for `env.AI` and fails on a second site.

On `kind: 'decide'` from an enrolled, connected host, in order:
1. **Feature on**: `FLEETWRIGHT_DECIDE=1` on the Worker and the binding
   present, else `{ ok: false, why: 'off' }`. The fork-safe `wrangler.toml`
   has no `[ai]` binding; `wrangler.production.toml` adds it, so a fork can
   never spend.
2. **Shape gate**, section C, refuse on any hit: `{ ok: false, why:
   'refused:<pattern>' }`, log host and pattern name, never the text.
3. **Platform rate limit**: `[[ratelimits]] name = "DECIDE_RATE_LIMIT"
   namespace_id = "1003" simple = { limit = 30, period = 60 }`, keyed on a
   constant. Enforced by Cloudflare, approximate per location, independent
   of DO memory. Fail → `why: 'ratelimited'`.
4. **Per-host and per-session windows**, `#mayPush`'s shape and persistence:
   one decision per `(host, session)` per 10 minutes, 20 per host per hour,
   stored via `serialisePushLimits`'s sibling so a rebuild keeps them.
5. **Daily neuron budget**, persisted in DO storage as
   `decideSpend: { day: 'YYYY-MM-DD' (UTC), neurons, calls, refused }`:
   - pre-charge `ceil(bytes / 3) × 0.003455` neurons (bytes/3 over-estimates
     tokens for masked text; conservative on purpose);
   - refuse if `neurons + estimate > budget`, `why: 'budget'`;
   - after the call, reconcile with `usage.input_tokens × 0.003455`;
   - `DECIDE_NEURONS_PER_DAY` from `[vars]`, default 8,000 (inside the free
     10,000); hard ceiling `MAX_DECIDE_NEURONS_PER_DAY = 100_000` in code
     (≈ $1/day, ≈ $30/month, the worst case with every other wall down);
   - reset when `day` changes, matching Cloudflare's 00:00 UTC.
6. **The call**: `env.AI.run('@cf/cloudflare/clef-flash', { model:
   'clef-flash', state, questions })`, model id a constant, no `images`
   field ever, 8 s timeout, no retry (a retry is a second spend for the same
   evidence). Error → `why: 'error'`.
7. **Reply** `{ ok: true, asked, kind, p }`; the masked state is dropped;
   nothing of it is stored. The DO keeps counters and nothing else.

**Questions** (one call, two questions; `questions` id keys fixed):
- `asked` (`noul`): "This is the bottom of a terminal running a coding
  assistant. Is it currently stopped, waiting for a person to pick one of
  several offered options or to confirm before it continues?" with
  `criteria.true`: "A dialog or prompt with numbered or listed choices,
  waiting." `criteria.false`: "Output still being produced, a finished
  result, an ordinary shell prompt, or a list that is part of the
  assistant's own text rather than a question to the person."
- `kind` (`choice`): "If it is waiting, what is it asking?" with criteria
  `resume`, `trust`, `permission`, `directory`, `api-key`, `other`. Used for
  the journal and CI evidence only; never acts.

Wording is pinned in one module and tested as a literal, because the
threshold is calibrated against this wording and a reworded question is a
new model.

**Visible spend**: `decide: { today, budget, calls, refused }` on the
coordinator health surface and in `fleet_health`'s prose; a warn line at
80 % of budget once per day. The Cloudflare billing usage alert is the
operator's to set; `docs/ci.md` and `docs/decide.md` say so.

### C. The mask and the gate

**Host mask** (`src/core/mask-pane.js`, one module, beside `redact.js` for
the same reason: the knowledge of what is a secret lives in one place):
- Input: de-wrapped pane (`core/pane.js` `dewrapPane`), last 40 lines, then
  cut to 4,096 bytes from the end.
- Tokenise on whitespace. For each run, strip leading and trailing
  punctuation and box-drawing characters (kept as-is); the core is **kept**
  only if it is a natural-language word (`/^[A-Z]?[a-z']{1,19}$/` or
  all-caps `/^[A-Z]{1,8}$/`) or a number of at most 3 digits
  (`/^\d{1,3}$/`). Everything else becomes the fixed mask `▮▮▮▮`.
- Allowlist-shaped, as `scrubUrl` is. Removes: `sk-ant-…` setup tokens,
  `fwk_` keys, auth URLs and codes, Remote Control URLs (a credential),
  ssh keys, env dumps, paths, hostnames, emails, hashes, CamelCase
  identifiers, version strings. Keeps: dialog prose, "1.", "Yes", "No",
  "Do you want to proceed", option labels made of words.
- Known loss: a secret that is a dictionary word survives, as it would in
  any mask; a filename that is a word survives. Neither is a credential
  shape the fleet issues.

**Worker gate** (`#refuseUnlessMasked(state)`), refuses the whole request
on any hit, in order of cheapness:
- length > 4,096 bytes, or > 40 lines;
- `/[A-Za-z0-9_-]{20,}/` (any long run: the mask cannot have produced one);
- `/sk-ant-|fwk_|https?:\/\/|@[a-z0-9-]+\.[a-z]{2,}|-----BEGIN/i`;
- any `images` field present.
A hit is logged as `decide refused from <host>: <pattern-name>` and counted
in `decideSpend.refused`. The host is told `why` so an operator can see a
host whose mask is wrong. The text is never logged, never stored.

### D. CI: dialog drift, advisory not gating

`scripts/claude-dialog-check.mjs` already extracts every string literal of
each dialog component it can anchor. Extend it:
- Walk every minified function in the binary that contains a numbered-option
  pattern or a question mark followed by a choice-like literal (the existing
  `enclosingFunction` and a widened anchor set), and collect its literals.
- For each cluster not already named in `DIALOGS`, POST to the REST endpoint
  with the same two questions, `state` = the joined literals.
- `asked ≥ DECIDE_P_AWAITING` and `kind` with `confidence ≥ 0.7` → a GitHub
  **warning annotation** and one PR comment quoting the literals and the
  kind. The deterministic `DIALOGS` check stays the gate; the model's label
  is a claim, and a claim does not make a required check red.
- Needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_TOKEN` (Workers AI read
  only). Absent, as on a fork PR, the step **skips with a notice**, like
  `apt-repo.yml`. Renovate's bump PRs are in-repo, so they get it.
- Budget: one bump a week, a few hundred clusters, free.

### E. Documentation and tests

- `docs/decide.md`: why, the trigger, the mask, the gate, every cap with its
  number, what the answer may and may not do, the injection acceptance, the
  retention question for the operator, how to turn it on (host env, Worker
  var, binding), how to read the spend.
- `docs/ci.md`: the new step and its secrets; the billing alert note.
- `docs/push.md`: the new `awaiting-input` text.
- `ROADMAP.md`: the item, and that Android naming stays its own track.
- Tests (each passing the `test-audit` gate: a contract, a credible
  regression, not covered elsewhere):
  - `mask-pane.test.js`: fixtures masked contain no long run, no URL, no
    token; planted `sk-ant-…`, `fwk_…`, RC URL, email, ssh key all gone;
    "Do you want to proceed", "1. Yes", "2. No" survive.
  - `decide-gate.test.js`: each gate pattern refuses; a masked fixture
    passes; `images` refuses.
  - `decide-budget.test.js`: refuses over budget; reconciles from `usage`;
    survives a simulated DO rebuild (the push-limit test's shape); resets
    on day change; ceiling clamps a too-large `[vars]` value; storage rows
    inside the 128 KiB DO value (`do-key-bounds.test.js` shape).
  - `watcher.test.js` additions: regex miss + still + `p ≥ threshold` →
    `awaitingSince` set, event fired once, `prompt` null, restart blocked;
    hash change clears; `p` below threshold → nothing; feature off → no
    frame sent; a hook `awaiting` newer than the pane is never second-
    guessed; the same hash is asked once.
  - `worker-ai-sites.test.js`: exactly one `env.AI` call site in the bundle.
  - `decide-questions.test.js`: the question literals are the pinned ones.

### F. The harness, first and deciding

`scripts/decide-harness.mjs`, local, needs the two REST env vars, never
runs in CI:
- Corpus: `test/fixtures/claude-2.1.*.txt`; the historical rewording
  ("Quick safety check: Is this a project you created or one you trust?");
  ten hand-written rewordings per dialog kind; **negatives that matter**:
  a working pane whose output is a numbered plan, a ready pane with a
  numbered list in scrollback, a shell prompt, a pane of build output, the
  2.1.284 bypass capture. Each labelled by hand.
- Runs each masked and unmasked; reports per item `asked`, `kind`,
  `confidence`, latency; then agreement with the labels, false-`asked` rate
  on negatives, recall on reworded dialogs, and the masked-vs-unmasked
  delta.
- **Decides**: `DECIDE_P_AWAITING` as the lowest threshold with zero false
  `asked` on negatives; and whether to proceed at all. If recall on the
  reworded dialogs at that threshold is below the regexes' own (which is 0),
  there is nothing to ship.
- Backend interface so the same corpus can later run against local
  Clef-flash weights, a small ONNX classifier, or hosted Jev, but none of
  those is promised; only Workers AI is built first.

### G. Order of work

1. Harness (F). Needs an account token; nothing else touches production.
2. Mask and gate (C) with tests; they are pure functions.
3. Coordinator spender and walls (B) with tests; binding only in
   `wrangler.production.toml`; `FLEETWRIGHT_DECIDE` unset, so deployed off.
4. Host trigger and effect (A) with tests; `FLEETWRIGHT_DECIDE` unset, off.
5. CI drift step (D), skipping without secrets.
6. Docs (E). Turn on for one host; watch `decide` on the health surface
   for a week; set the Cloudflare billing alert.

### What stays open, and why

- **The threshold and whether the mask costs accuracy**: only the harness
  can answer; design cannot.
- **Retention**: Cloudflare's model page says nothing; the operator reads
  the Hugging Face card and Workers AI data terms before step 6.
- **Local Clef-flash**: 9B needs a GPU or a Mac; whether GGUF weights exist
  and run under `llama-server` is unverified, so no host-local path is
  promised. The mask and gate make the hosted path acceptable per host;
  a fleet that refuses even masked text leaves the feature off.
- **Android naming**: a separate track, blocked on building the ML Kit
  dependency, unrelated to decisions.
- **Whether `kind` ever earns a role beyond the journal**: not until CI
  evidence shows it agrees with `DIALOGS` for a few release bumps.
