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

---

# Round two: the first-run tester

Same brief, opposite end of the funnel — a stranger following the README on a
clean Linux box, then driving the live fleet through MCP. Full text on
`claude/fleetwright-beta-report-bv9xl0`.

**It found something neither of us predicted, and it outranks everything above.**

## E. The installer is dead on main

| # | Finding | Severity |
|---|---|---|
| **E1** | **A fresh box cannot install.** `install.sh` exits 1 after five header lines, before any prerequisite check, with no message. `previous_install()` ends with `[ -f /etc/sudoers.d/agent-hub-reboot ] && FOUND+=(...)`; on a box that never had this installed the test is false, that `&&` list is the function's last command, so the function returns 1 and `set -euo pipefail` kills the script. Both `--check` and the real install die there, so the advertised one-liner takes a bare machine to four lines and a silent failure. | **blocking** |
| **E2** | **Fresh-clone `npm test` fails** — three files, `Cannot find package '@sentry/cloudflare'`. The fix is `cd worker && npm install`, which the README's "Running things" section does not mention: the section that says there is one runtime dependency. CI was fixed for this; a human following the README was not. | **high** |
| **E3** | **`sh install/install.sh` fails with `Illegal option -o pipefail`** and no explanation. People will type it. | **low** |

**E1 verified here rather than taken on trust:** `git archive main` into a
clean directory, `bash install/install.sh --check` -> exit **1**, five lines,
zero mentions of node, tmux or podman. Minimal repro:

```sh
bash -c 'set -e; f(){ A=(); for x in /nope1 /nope2; do [ -f "$x" ] && A+=("$x"); done; }; f; echo survived'
# no "survived", exit 1
```

The tester's own note is the important half: *"This would have been the end of
my first run if I couldn't read bash."*

## F. The one-account-per-person sweep stopped halfway

Round one found this from the MCP side (A3). Round two found the same fault in
three more surfaces, which makes it an unfinished migration rather than a
wrong string.

| # | Finding | Severity |
|---|---|---|
| **F1** | `fleet_status` / `fleet_health` say **"NOT LOGGED IN - a session here cannot do anything"** about hosts where `fleet_start` works immediately. `fleet_verify` gets it right: *"This box has no Claude account of its own, which is normal."* | **critical** |
| **F2** | `agent-hub accounts` still advertises the **shared-account fallback that was removed** - "every session uses the shared one" - while the coordinator on the same box refuses placement for the opposite reason. Two components, one machine, contradictory stories. | **high** |
| **F3** | `agent-hub doctor` prints `ok claude logged in - ? (oauth_token)`; the hub log says `logged in as unknown`. | **medium** |
| **F4** | **The refusal names no remedy.** `nobody has linked a Claude account on this host`, and linking from a shell is documented nowhere a user would look. `deployment.md` still calls logging the box in "the one step that genuinely needs a person" and never mentions linking. **This is where the tester's local first run ended.** | **critical** |

## G. First-run friction

| # | Finding | Severity |
|---|---|---|
| **G1** | **Minting an enrolment pin is undocumented.** `deployment.md` offers app, Telegram or admin token; with neither app nor Telegram the tester found `POST /api/enroll` by reading `openapi.json`. | **high** |
| **G2** | **Node version has three answers**: `package.json` `>=24`, `deployment.md` ">= 24", `agent-hub.md` "18+". Node 22 ran everything. | **medium** |
| **G3** | **No "fresh box to first session" checklist.** The setup docs are essays - good ones - with "type this" interleaved with 40-line digressions, and `accounts.md` opens by declaring part of itself superseded. | **high** |
| **G4** | **`agent-hub.md` is upstream's README**, with upstream's install steps and version claims, banner'd only on the install section. | **low** |

## H. Documents disagree about what is real

| # | Finding | Severity |
|---|---|---|
| **H1** | **Four documents, four app maturity levels.** README links live TestFlight/Play; ROADMAP section 3 says shipped; `deployment.md` says "no notification has been delivered to a real phone, and no app has been run by a person"; `app-testing.md` says both apps have been run in simulators. | **high** |
| **H2** | **The Play listing sells push** - "the point of carrying this in a pocket at all" - the one feature every internal doc agrees has never reached a phone. The tester, who praised this project's documentary honesty at length, called this **"off-brand"** and said as a reviewer they would call the listing overdrawn. | **high** |
| **H3** | **"Requires Android 16 or later"** excludes most Android phones alive in 2026, including the tester's. If there is a reason, say it; if it is targetSdk conservatism, it gives up the install base for nothing. | **medium** |

## I. MCP ergonomics (round two's additions to C)

| # | Finding | Severity |
|---|---|---|
| **I1** | **`fleet_start` does not say which host it picked.** Two boxes; finding out costs a `fleet_list` and a scan. | **high** |
| **I2** | **One addressing rule, please.** `peek`, `stop` and `verify` resolve a session by name; `read_log` and `logs` demand the host. Round one hit this too (B3). | **high** |
| **I3** | **`fleet_files` answers `(empty)`** for "no files", "no workspace" and "failed" alike. | **medium** |
| **I4** | **Session titles truncate mid-command** in `fleet_list` - somebody pasted a task as the title. The naming design is right; the rendering undercuts it. | **low** |

## J. The two things that block the product's own pitch

Ranked daily by the tester, and argued without being talked round by the
rationale - which was the point of the brief.

**J1 - task-at-start.** `brief` is stored and never delivered, so the MCP loop
the instructions teach ends at an idle REPL with an empty log and no error
anywhere. *"The product's own MCP pitch - hand a job to a Mac that did not
exist five minutes ago, watch it, collect the output - is not achievable
through the product."*

Their argument distinguishes itself from what `docs/plan.md` refuses:

> The never-build argument is strongest about *mid-session* free text -
> answering a question the model asked twenty minutes ago, blind. A prompt
> supplied **at creation, before the session exists**, has none of the
> staleness problem.

And they found the compromise on our own roadmap: **section 6's host-side named
profiles**. A `kind` carrying a stored, host-configured prompt is task-at-start
without free text ever crossing the intent protocol.

**J2 - a state nobody should have to divine.** `await` detects ended-or-errored
only; a finished session looks like an idle one. The proposal is not that the
fleet decide - publish the **watcher's observation**, "pane unchanged for 9m,
at an empty prompt", as a field. *"Judgement stays mine; today even the
evidence is manual."*

## K. What to protect

Recorded because the next change is as likely to break these as to fix
anything above.

- **Refusals that name a reason.** The tag-routing refusal was called *"the
  best refusal message I have ever received from a tool"*.
- **`fleet_verify`** - *"a diagnostic that distrusts its own instruments out
  loud is a rare and precious thing"*, and the standard F1 should be held to.
- **The documentation's honesty** about what is unproven - which is exactly why
  H1 and H2 stand out.
- **Zero-dependency discipline.** Everything hand-started came up first try.
- **The security shape being legible to a non-maintainer**, and the
  session-naming design.

---

## Revised order, both rounds

1. **E1, and a CI job that runs `install.sh --check` in a clean container.**
   Nothing else matters while a fresh box cannot install and fails silently.
   The bug class - a trailing `[ -f ] &&` as a function's last command under
   `set -e` - recurs without a check that would catch it.
2. **F1-F4 with A2-A4: one sweep.** Both rounds independently hit the same
   false "NOT LOGGED IN". The two most-read surfaces contradict `verify`,
   which already has the correct sentence.
3. **B4 / C6 / F4** - refusals that know the remedy and withhold it. One
   sentence each.
4. **C1-C3** - the list screen. Round one's biggest single win.
5. **J1 and J2** - the core loop dead-ends without them, and the compromise is
   already on our own roadmap.
6. **A1, I1-I4, B2, B3, B5** - the MCP ergonomics pass.
7. **D1-D3** - a decision about what an operator may lift.
8. **H1, H2** - make the four documents agree, and either prove push on one
   real phone or stop selling it.
9. **B1** - no fix without a reproduction against the deployed Worker.

The tester's disagreement with `ROADMAP.md`, worth keeping: *"All defensible,
but they extend reach while the core loop still dead-ends at an idle REPL."*
