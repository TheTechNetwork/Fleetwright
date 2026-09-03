# Beta report — Fleetwright / agent-fleet

Written by a beta tester with access to the repo at `707ecb7`, a Linux box
(node 22, tmux 3.4, `claude` 2.1.259 logged in, no podman), the live beta fleet
(`deb132`, `deb13-staging`) through the MCP server, and no phone. Everything
below was either run or read as a user would run or read it. I did not fix
anything.

---

## 1. First run

In order, with the exact places I stalled.

1. **README** — good. The two-names note up front saved me a confusion I would
   otherwise definitely have had. I followed "To do those two steps yourself"
   and ran the check the README itself recommends.

2. **`sudo ./install/install.sh --check` — dead on arrival.** Output, in full:

   ```
   agent-fleet installer
     source : /home/user/Fleetwright
     user   : root
     mode   : --check (nothing will be changed)
   ```

   Exit code 1. Nothing else. No prerequisite was checked, nothing said what
   failed. This is the very first command a careful new user runs, on the
   mode advertised as "changes nothing", and it exits silently.

   I traced it (details in Bugs below): `previous_install()` ends with
   `[ -f /etc/sudoers.d/agent-hub-reboot ] && FOUND+=(…)`, which returns 1 on
   any box that has never had this installed, and `set -e` kills the script.
   **The full install dies at the same line.** As far as I can tell, a fresh
   box cannot install from `main` at all right now. This would have been the
   end of my first run if I couldn't read bash.

3. **`npm install && npm test` — 3 failing test files on a fresh clone.**
   `test/mcp-remote.test.js`, `test/openapi.test.js` and
   `test/worker-routes.test.js` all die with
   `Cannot find package '@sentry/cloudflare' imported from worker/src/worker.js`.
   The fix is `cd worker && npm install`, which nothing in the README's
   "Running things" section mentions — the section that says "One runtime
   dependency — `jose` … `npm install` / `npm test`". After the worker
   install: 1074/1075 pass. First impressions matter and "clone, install,
   test, 3 failures" is a bad one.

4. **Node version, three answers.** `package.json` says `>=24`,
   `docs/deployment.md` says the installer installs "node (>= 24, which
   `package.json` requires)", `docs/agent-hub.md` says "**Dependencies:
   `node` (18+)**". My node 22 ran everything, tests included. I never found
   out which claim to believe.

5. **`agent-hub doctor`** — worked, clear output. One oddity:
   `ok claude logged in — ? (oauth_token)`. A literal `?` where an account
   should be (the hub log says `logged in as unknown`). It set up the wall I
   hit at step 8.

6. **Standing up the loop by hand** (hub, coordinator, sidecar — since the
   installer was dead): genuinely smooth. The coordinator's startup lines tell
   you exactly where hosts dial and where clients POST. The sidecar refused to
   start without a pinned coordinator URL and *said so usefully*, `enrol`
   worked first try, and its output ("The sidecar will connect the next time it
   dials") was exactly right.

7. **Minting the enrolment pin — undocumented.** `docs/deployment.md` says a
   pin is "minted with the admin token, handed out by the app (Fleet → Add a
   host), or sent as `/enroll <pin>` in Telegram". I have no app and no
   Telegram. No doc shows the curl. I found `POST /api/enroll` by reading
   `openapi.json`. It worked, but I should not have needed the OpenAPI spec to
   join my own box to my own coordinator.

8. **The wall: the coordinator refuses to schedule on a logged-in box.**

   ```
   $ curl -X POST localhost:8791/api/intent -d '{"verb":"start","params":{"name":"beta1"}}'
   {"ok":false,"error":{"code":"no_hosts"},
    "text":"vm: degraded (nobody has linked a Claude account on this host)"}
   ```

   Meanwhile, on the same box, at the same minute:

   ```
   $ agent-hub accounts
   Nobody has linked a personal account — every session uses the shared one. Link with /login for <email>.
   $ agent-hub new beta1
   Started "beta1" in /root/agent-runs …
   ```

   The hub says the shared account covers everyone and starts sessions
   happily; the coordinator says nobody can run anything. I now know (from
   `docs/one-account-per-person.md`) that the shared fallback was removed and
   the hub's message is stale — but as a user I had two components on one box
   telling me opposite stories, and the setup doc (`deployment.md`) never
   mentions that **linking a Claude account is now a required post-install
   step for fleet scheduling**. It still says logging the box in is "the one
   step that genuinely needs a person". I read `accounts.md` twice — it opens
   with "Superseded in part by…" — and still did not know how to link an
   account from a box with no phone and no Telegram. This is where my
   local-fleet first run ended.

9. **The MCP server against the real fleet** — this part mostly delighted me,
   and then quietly wasted my session; see Bugs #3–4 and Wanted #1–2.

---

## 2. Bugs

### 2.1 Fresh install is broken on `main` — silently

`install/install.sh` line ~297: `previous_install()`'s last statement is a
`[ -f … ] && FOUND+=(…)` loop over `/etc/sudoers.d/agent-hub-upgrade` and
`/etc/sudoers.d/agent-hub-reboot`. On any box where the last file doesn't
exist — i.e. **every box that has never installed this** — the function
returns 1 and `set -euo pipefail` (line 19) exits the script. Minimal repro:

```sh
bash -c 'set -e; f(){ A=(); for x in /nope1 /nope2; do [ -f "$x" ] && A+=("$x"); done; }; f; echo survived'
# exits 1, no "survived"
```

Both `--check` and the real install die there, before any prerequisite check,
with no message. Expected: `--check` prints the prerequisite table; the
install proceeds. This also means the advertised
`curl -fsSL https://fleet.thetech.network/install | sudo sh` one-liner
currently takes a bare box to four lines of output and a silent failure.

### 2.2 `fleet_status` / `fleet_health` say the fleet is unusable while it works fine

Against the live fleet, `fleet_status` reported, for **both** hosts:

```
claude: NOT LOGGED IN — run /login
```

and `fleet_health`:

```
claude: NOT LOGGED IN — a session here cannot do anything until somebody runs /login on it
```

Then `fleet_start` worked immediately, and `fleet_verify claude` said, of the
same box:

```
This box has no Claude account of its own, which is normal. Sessions run on the
account of whoever starts them.
```

Under one-account-per-person, "the box is not logged in" is the *normal,
healthy* state, and the status surfaces still describe it as fatal
("cannot do anything"). If I hadn't tried starting anyway, I'd have filed the
whole fleet as down. `verify` has the correct post-migration sentence; `status`
and `health` need it too.

Same family, local flavor: `agent-hub accounts` still says "every session uses
the shared one" — the fallback that no longer exists (see First run #8), and
`agent-hub doctor` prints `logged in — ?`.

### 2.3 `fleet_health` doesn't say which host it's describing

The fleet has two hosts. `fleet_health` returned one host's numbers and the
"NOT LOGGED IN" line with **no host name anywhere in the reply**. I could not
tell which box it was talking about. `fleet_status` names hosts; `health`
must too.

### 2.4 The start → await → read_log loop completes "successfully" having done nothing

I did what the server's own instructions describe ("1. fleet_start …
2. fleet_await … 3. fleet_read_log to collect what it produced"):

- `fleet_start name=beta-taster brief="List the files in the workspace and summarise…"` → "Started".
- `fleet_await` twice → "still running after 25s. That is not a failure…"
- `fleet_peek` → Claude Code sitting at an **empty prompt**. The brief is a
  label, never typed in (I know that's deliberate — see Wanted #1).
- `fleet_read_log` → "The container for beta-taster has printed nothing."

Nothing errored, nothing warned, and the workflow the instructions teach
produced an idle REPL and an empty log. The `brief` schema even predicts this
exact trap ("the worst shape a parameter can have, because silence looks like
success") — and I fell into it anyway, because the instruction text
("collect what it produced") implies sessions produce things. On a paid
ephemeral runner this loop burns money until the 15-minute prose deadline.
At minimum, `fleet_start`'s reply for a session that will start idle should
say so: "Started idle — a person drives it from <RC link>."

### 2.5 Fresh-clone `npm test` fails

See First run #3. Either `npm install` should install worker deps, or the
README should say two installs are needed, or the three worker-importing test
files should skip with a message naming the fix.

### 2.6 Docs disagree about app maturity, and the store listing sells the untested part

- `README.md`: "Get the app" — live TestFlight and Play links, first thing on the page.
- `ROADMAP.md` §3: "Sign in, hosts list, pins, revocation, sessions, push — **done** | shipped".
- `docs/deployment.md`: "no notification has been delivered to a real phone,
  and no app has been run by a person" / "Neither has been driven by a person."
- `docs/app-testing.md`: "Both apps have now been run" (emulator/simulator);
  push "built and unit-tested. Nothing has ever reached a phone."

Four documents, four maturity levels. And
`apps/android/store/store-listing.md` promises "Get a push notification the
moment a session stops and waits on you — **the point of carrying this in a
pocket at all**" — the one feature every internal doc agrees has never been
proven end-to-end. As a user deciding whether to install the beta, I could
not tell what I'd get; as a store reviewer I'd call the listing overdrawn.

---

## 3. Annoyances

Not broken. I would grumble every single time.

1. **`fleet_start` doesn't say which host it picked.** "Started 'beta-taster'
   in /home/user/agent-runs" — on *which* of my two boxes? I had to run
   `fleet_list` and scan for it.

2. **…and then `fleet_read_log`/`fleet_logs` demand a host** ("Which box?
   deb132, deb13-staging.") while `fleet_peek`, `fleet_stop` and
   `fleet_verify` resolve the session without one (and `fleet_verify` answers
   for an unnamed box, which host is it?). One addressing rule, please:
   if a tool can find my session by name, they all can; and whatever started
   it should have told me where.

3. **I can't clean up my own mess from the MCP.** My `beta-taster` test
   session now sits in the shared resumable list indefinitely — next to
   twelve stale `cc-*` sessions that suggest everyone on this fleet has the
   same problem. `forget` is withheld by policy ("destroy a conversation that
   cannot be recovered") — but there's a 7-day recycle bin now, so `forget`
   is no longer unrecoverable, and the surface that lets me create clutter
   should let me bin it.

4. **`fleet_files` answered `(empty)`.** Is that "the workspace has no files",
   "no workspace exists yet", or a failure? Three different situations, one
   shrug.

5. **`fleet_await` caps at 25s and returns "still running — call again".** I
   understand the Worker ceiling. It still turns every wait into a re-call
   loop I have to manage, and combined with 2.4 ("await cannot detect a
   session parked at a prompt") the tool named `await` mostly can't await the
   two states I care about: *needs me* and *done*.

6. **Session titles truncate mid-command in `fleet_list`:**
   `cc-eli-diskreport · Please run 'df -h' for overall disk usage, then run 'du -x…`.
   Someone pasted the task as the title/brief and the list renders the first
   line of it. The naming design (recognition, not recall) is good; the list
   view undercuts it.

7. **The setup docs are essays.** They're *good* essays — but
   `deployment.md` interleaves "type this" with 40-line design digressions,
   `accounts.md` opens by declaring part of itself superseded, and the current
   truth about "what must I do after install so the fleet will schedule work"
   exists in no single place (see First run #8). I want a ten-line
   "fresh box to first fleet session" checklist that stays current, with the
   essays linked underneath.

8. **`agent-hub.md` is upstream's README with upstream's install
   instructions, node "18+", and "no npm install"** — all contradicted
   elsewhere in this repo. The banner says the install section doesn't apply;
   the version claims aren't banner'd.

9. **"Requires Android 16 or later."** That excludes the majority of Android
   phones alive in 2026, including mine. If there's a real reason, the listing
   should say it; if it's just `targetSdk` conservatism, it's giving up most
   of the install base for nothing.

10. **`sh install/install.sh` fails with `Illegal option -o pipefail`.**
    Self-inflicted (the docs say to execute it), but people *will* type
    `sh install.sh`, and the error explains nothing. A
    two-line `#!/bin/sh` guard that says "run this with bash" would save the
    next person the confusion.

---

## 4. What I wanted and couldn't have

Ranked by how often it would bite × how much it hurts. Difficulty ignored, as
instructed.

### 4.1 Give a session its task when I start it — every single use

**What I was doing:** starting a session from the MCP to do a small, concrete
job ("list the workspace and summarise it").
**What I reached for:** `brief` on `fleet_start`.
**What stopped me:** the brief is stored, never delivered; "the session starts
idle and this protocol has no way to send it a prompt — a person drives it."
The only channel into the session is the Remote Control link — i.e. leave the
product and go be that person.

**How often:** literally every time the fleet is driven by anything that isn't
a human with a phone in hand. It is the first thing every MCP user will try;
I tried it within two minutes of connecting.

I have read the rationale — `docs/plan.md`'s thesis ("we should deliberately
never build free-text input"), `docs/intents.md`'s "no way to express a path
or a login". It is a serious argument about a compromised coordinator driving
root-capable boxes, and about answering stale prompts. **I understand why,
and I still want it.** Two observations from the user's chair:

- The never-build argument is strongest about *mid-session* free text —
  answering a question the model asked twenty minutes ago, blind. A prompt
  supplied **at creation, before the session exists**, has none of the
  staleness problem and answers a question nobody asked the verb set to
  refuse: "what is this session for". The threat model still applies (it is
  text into a `--dangerously-skip-permissions` shell), so gate it however you
  like — off by default, admin-only, per-fleet switch, hash it into the audit
  log. But right now the product's own MCP pitch ("hand a job to a Mac that
  did not exist five minutes ago, watch it, collect the output") is not
  achievable through the product.
- Your own roadmap §6 already contains the compromise: **host-side named
  profiles / "prompt-efficiency helpers injected at session start"**. A
  `kind` that carries a *stored, host-configured* prompt is task-at-start
  without free text ever crossing the intent protocol. Promote it; it's
  currently one row above "wanted".

### 4.2 A "done / needs-me / idle" state I don't have to divine — every session

**What I was doing:** waiting for my session to finish.
**What I reached for:** `fleet_await`.
**What stopped me:** await detects ended-or-errored only; "a finished session
looks exactly like an idle one"; parked-at-prompt is best-effort. I peeked in
a loop like everyone will.

**How often:** every session, several times per session.

`docs/mcp.md` argues completion is "told, not signalled" — deciding a session
is finished is a judgement, so the model driving it owns the deadline. I
understand why, and I still want it. The fleet already watches panes well
enough to answer resume dialogs and to push "stopped and waiting on you" to
phones; the same watcher could publish *its observation* — "pane unchanged
for 9m, at an empty prompt" — as a field on status, without anyone pretending
it's truth. Judgement stays mine; today even the evidence is manual.

### 4.3 Link a Claude account from a shell — once per person, but it's a wall

**What I was doing:** getting my hand-built single box to schedule work.
**What I reached for:** anything — `agent-hub login`, curl, the docs.
**What stopped me:** linking lives in the apps and Telegram; `/login for
<email>` appears in design docs but no user doc says it works from the CLI, and
`deployment.md` doesn't mention linking at all. The refusal
("nobody has linked a Claude account on this host") names no remedy.

**How often:** once per person per fleet — but it's positioned exactly at
first run, the moment you decide whether this project is for you. The refusal
text should carry the remedy, and `deployment.md` needs a "then link an
account, like this, from this box" step.

### 4.4 Delete my own session from the MCP — weekly

Covered as Annoyance #3. Wanted here because it's a missing capability, not a
rough edge: with the recycle bin shipped, "forget is unrecoverable" is no
longer true, and the withhold-list rationale ("what an agent reaches for
unasked") is satisfied by scoping it to sessions this conversation started —
exactly how `stop` was rehabilitated.

### 4.5 Context-window usage per session — most resume decisions

`/resume` asks summary-vs-full precisely because full "can consume a serious
share of a usage limit" — and gives me a token count but no sense of my
remaining budget. ROADMAP §3 already wants this ("the one fact of this group
the host does not yet know"). Agreed; it would inform roughly every resume of
a long session, plus the "should I stop and restart this thing" call.

### 4.6 An Android I can install — once, fatally

Android 16 minimum (Annoyance #9). For me this is the difference between
being a phone-app beta tester and reading the screenshots.

---

## 5. The roadmap I would want

In order. Where this disagrees with `ROADMAP.md`'s "The order I'd build it",
I say so.

1. **Fix the installer, and make a CI job run `install.sh --check` in a clean
   container.** Nothing else on any roadmap matters while a fresh box can't
   install from `main` and the failure is silent. The bug class (last
   `[ -f ] &&` in a function under `set -e`) will recur without the CI check.

2. **Make the readouts stop lying (one-account-per-person fallout sweep).**
   `fleet_status`/`fleet_health` "NOT LOGGED IN — cannot do anything",
   `agent-hub accounts`' shared-account message, `doctor`'s `?`, health
   replies with no host name, refusals that don't name the remedy. This
   product's entire pitch is trustworthy state from a pocket; today the two
   most-read surfaces contradict `verify`. Cheap, high-trust wins.
   *(ROADMAP's list has no equivalent item; I'd put it second.)*

3. **Task-at-start via named kinds (the §6 "prompt profiles" row), plus the
   watcher's idleness evidence on `status`.** This is the gap between
   "remote control for a terminal I still have to drive" and "a fleet I hand
   work to" — items 4.1 and 4.2, the two I'd hit daily. *(Disagreement:
   ROADMAP's next steps are guest onboarding, coordinator-level TG bot, the
   proxy, Mac hosts. All defensible, but they extend reach while the core
   loop still dead-ends at an idle REPL. The MCP + ephemeral-runner story
   you're most excited about is the story 4.1/4.2 block.)*

4. **An MCP ergonomics pass:** start replies name the host; one addressing
   rule across tools; scoped `forget`; `fleet_files` distinguishes empty from
   absent from failed. Small, and every MCP conversation touches all of them.

5. **Prove push on one real phone before adding any further app surface.**
   The store listing already sells it as the point of the product; every doc
   admits it's never happened. One Firebase project, one device, one
   afternoon of truth. *(ROADMAP treats push as done-ish under §3 "shipped";
   deployment.md says otherwise — whichever is right, make them agree.)*

6. **Then guest onboarding** (ROADMAP 4b) — agreed it's unblocked and
   valuable; it just shouldn't ship in front of readouts people can trust.

7. **Then the proxy (`trust.md`)** — agreed with ROADMAP that it's the
   highest long-term value; nothing above competes with it on importance,
   only on urgency.

8. Mac host completion, Windows-as-WSL2, filesystem-in-apps — as ROADMAP has
   them. No disagreement.

---

## 6. What is genuinely good

Protect these when you change things.

- **Refusals that name a reason, everywhere.** "No connected host carries
  every tag: macos. No host reports any tags at all … a host gets its tags
  from AGENT_FLEET_LABELS in its sidecar config" is the best refusal message
  I have ever received from a tool. The enrol flow, the sidecar's
  config-missing message, and the pin lifecycle all have this quality. It's
  the protocol's central promise and it survives all the way to the MCP
  client.

- **`fleet_verify`.** It told me whose account a session would run on, how
  long the token had left, that the box having no account is normal, and that
  two of its own signals disagreed — "That is a fault in the reporting rather
  than in the credential — sessions here will work. Restarting agent-hub
  clears it." A diagnostic that distrusts its own instruments out loud is a
  rare and precious thing. (It's also the standard Bugs 2.2 should be held to.)

- **The honesty of the documentation.** The "what is deployable today" table
  with ⚠️ rows, "Compiled, not run", "compiling is a much weaker claim than
  working", the MCP support matrix whose rows say *how they were established*
  and record that the test harness once certified a bug. I trusted this
  project quickly because it kept telling me what it didn't know. (Which is
  why the README/ROADMAP/store-listing app-status contradictions in 2.6 stand
  out — they're off-brand.)

- **Zero-dependency discipline.** One runtime dep, no build step, 1075 tests
  in ~20 seconds, and every piece I started by hand (hub, coordinator,
  sidecar, hand-rolled WebSocket) came up first try and logged exactly what it
  was doing. The stdio intent transport (`echo '{"kind":"intent"…}' | sidecar`)
  is a gift for debugging.

- **The security shape is legible to a non-maintainer.** Intents-not-commands,
  the sidecar's assembled-from-literals rule, per-device revocable
  credentials, pins spent once, host keys that must never be copied, "a
  credential in an APK is public". I could reason about what losing my phone
  costs without reading source. The reboot flow (pin issued by the *host*,
  plus typed hostname) is exactly how a destructive remote action should feel.

- **The session-naming design.** name/title/brief as identity/label/context,
  suggestion never on the critical path, "recognition, not recall" — the
  thinking is right even where the list rendering (Annoyance #6) hasn't
  caught up.

- **Operational care where it counts:** `KillMode=process` with the comment
  that explains the outage it prevents; the update marker compared against
  service start time; resume-by-uuid-or-refuse; the recycle-bin `/forget`.
  These read like scars, and they're the reason the parts that work feel
  solid.
