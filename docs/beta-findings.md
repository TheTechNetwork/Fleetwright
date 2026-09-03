# Beta findings, round one

Two testers, told nothing about the design and asked not to be reasonable about
effort. The returning-user run is complete (`RETURNING-USER-REPORT.md` on
`claude/fleetwright-returning-user-3z0b2m`); the first-run tester is still going.

This file exists so none of it is lost. Every row has an owner, a severity and
enough detail to act on cold. **Nothing here is fixed unless it says so.**

The verdict worth keeping at the top:

> "I got my output by ignoring what the screens said and interrogating a
> verification tool." — returning-user report, §6

17 tool calls, 8 of them errors or dead ends, for a job that should have been
four: list → status → read → stop.

---

## A. Mine, in the MCP layer

Introduced in this branch's own work. Listed first because they are the ones I
put there, and three of the four are wrong *text* rather than wrong behaviour —
which is the kind that survives a test suite.

| # | Finding | Severity | Evidence |
|---|---|---|---|
| **A1** | **The MCP server never validates arguments against its own tool schema.** The schema declares `required: ['name']` and `additionalProperties: false`; nothing enforces either. An unknown parameter is forwarded silently and a missing required one becomes the string `"undefined"` in a refusal. | **high** | Reproduced locally: `fleet_peek {session:'x'}` → `No host reports a session named "undefined"`. Cost the tester their only documentation lookup. |
| **A2** | **`fleet_health` reports a host's health without naming the host.** `describeHealth` renders capacity, load, tags and login state and never says which box. Useless on a two-host fleet. | **high** | Report §1 step 2. |
| **A3** | **The login banner is wrong, and it is the most expensive text in the product.** `describeHealth` renders `loggedIn === false` as "NOT LOGGED IN — a session here cannot do anything". The health frame's own comment says the opposite: `claudeAccounts` replaced `loggedIn` as the thing to judge a host on, because *"a machine has no Claude account of its own any more, so `loggedIn: false` is the ordinary state of every box"*. I read the field and ignored the paragraph beside it. | **critical** | Report §1 steps 12–13: both hosts showed NOT LOGGED IN; `fleet_verify` then reported the credential valid and sessions working. A returning user who trusted the front screen walks away from a working recovery path. |
| **A4** | **`describeFailure` diagnoses a non-JSON response as a network problem.** A body that fails to parse produced *"The fleet may be down or this coordinator unreachable; retrying is reasonable"* — for a client-side error where retrying could never work. | **high** | Report §1 step 3. Same mistake as the bug `describeFailure` was written to fix: naming the wrong layer. |

## B. Product bugs

| # | Finding | Severity | Evidence |
|---|---|---|---|
| **B1** | **A Worker exception on `/api/intent`.** `Unexpected token 'e', "error code: 1101" is not valid JSON` — Cloudflare 1101 is *"Worker threw a JavaScript exception"*. An unknown parameter should be refused as `bad_params`, which is JSON. **Not reproduced locally**; the Node coordinator answers cleanly. Production-only, and unexplained. | **critical** | Report §1 step 3. Needs a real reproduction against the deployed Worker before any fix. |
| **B2** | **`fleet_read_log` reports "printed nothing" while `peek` shows a full pane.** After a resume, the output is in the pane and the transcript; `read_log` reads container stderr and finds nothing. The tool the product names for durable capture is the one that fails on exactly the sessions a returning user has. | **high** | Report §1 step 16. |
| **B3** | **`fleet_read_log` asks "Which box?" when its siblings do not.** `fleet_status` and `fleet_stop` resolve a session name fleet-wide; `read_log` demands the host. | **medium** | Report §1 steps 8, 41–43. |
| **B4** | **The "output is gone" error states the loss and withholds the recovery.** Resuming a stopped session restores the transcript, which usually contains the output. The error knows the loss and not the remedy — against this project's own rule that a refusal names what to do next. | **high** | Report §1 step 10, §4. The tester found the path by inference. |
| **B5** | **`peek` is documented as "how you find out whether work is done" and is useless on a stopped session.** Which is every session a returning user has. | **medium** | Report §1 step 7. |

## C. What the product cannot tell you

The theme of the whole report: every fact below already exists somewhere in the
system and is absent from the screen where the decision is made.

| # | Finding | Severity | Evidence |
|---|---|---|---|
| **C1** | **`fleet_list` answers "what exists", not "what state are things in".** Twelve sessions, one identical glyph, no dates, no owner. Finished, dead and abandoned share a symbol. | **critical** | Report §5 item 1: fixing this one screen removes steps 2, 6, 9 and a three-way guess. |
| **C2** | **No timestamps on sessions, anywhere.** Three sessions named "disk usage report"; no way to tell which was the real attempt. | **high** | Report §2. |
| **C3** | **`started by` exists in `status` and not in `list`** — the screen where the choosing happens. | **high** | Report §2. |
| **C4** | **The credential countdown is only in `fleet_verify`.** "Signed in (11m left)" was decisive and reachable only from a tool called out of desperation. | **high** | Report §1 step 13. |
| **C5** | **Host drift is not announced.** `deb13-staging` was two versions behind and rejected `fleet_files`; nothing said so until the tester tripped over it. | **medium** | Report §1 step 11. The error itself is the best in the product — it names the fix. |
| **C6** | **"Stopping discards output" lives in a tool description, not in the product.** It is the single most important fact for a returning user, and `fleet_stop`'s confirmation does not mention it. | **high** | Report §3. |

## D. The deny list blocks recovery

Not a bug in any one place — a pattern, and the one I would think hardest about.

`DEFAULT_DENY` withholds `forget`, `purge`, `update`, `answer` and the mutating
file verbs from MCP. I wrote it as *"a policy about what an agent reaches for
unasked, not a lock"*, which is right for an agent and wrong for a person
driving through an app.

| # | Finding | Severity |
|---|---|---|
| **D1** | **Stale sessions have no exit.** Twelve resumables accumulated in three weeks; `forget` and `purge` are denied, so the pile grows every visit and compounds C1. | **high** |
| **D2** | **A drifted host cannot be fixed from the product.** The error names `agent-hub update --restart`; `update` is denied, and the product provides no shell. | **high** |
| **D3** | **Nothing tells you a lift exists.** The refusal says "ask the person running it to allow that verb explicitly" — but the tester *is* the person running it, and `AGENT_FLEET_MCP_ALLOW` is named nowhere they would look. | **medium** |

---

## Suggested order

Ranked by friction removed per unit of work, which is not the order of severity.

1. **A1–A4** — mine, small, and three of the four are text. A3 first: a false
   "NOT LOGGED IN" is the most expensive sentence in the product.
2. **B4 and C6** — one sentence each, in the two places the tester needed them.
   The recovery already exists; only the telling is missing.
3. **C1–C3** — one screen. The report says fixing it alone removes four of the
   seventeen calls.
4. **B2, B3, B5** — the `read_log` / `peek` split does not survive contact with
   a stopped session. Worth one design pass rather than three patches.
5. **D1–D3** — needs a decision, not a fix: what an operator may lift, and how
   they find out they can.
6. **B1** — first a reproduction against the deployed Worker. No fix without one.

## Not yet in this list

The first-run beta tester is still going. Expect overlap on C1 and D3, and
expect at least one thing neither of us predicted — first-run friction and
re-entry friction fail in different places, which is why both were run.
