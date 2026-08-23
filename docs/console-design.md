> **Status: this is the specification. The implementation is
> `src/web/console/*.jsx`, rendered by Preact and tested in
> `test/console.test.jsx`.**
>
> This document was written alongside a self-contained `console.html`
> prototype, which has been removed. Two implementations of one page is the
> parity problem this branch spent days fixing in the coordinators, and it was
> going to end the same way — the prototype and the components would have
> drifted, and nobody would have known which was true.
>
> The prototype lost for one reason: it could not be tested. It was 2,000 lines
> of hand-rolled DOM, and the only checks available were "does it parse" and
> "does it mention innerHTML" — both of which it passed while being broken, and
> it shipped that way. A component returns a value, so every state below can be
> rendered to a string and asserted on.
>
> What is described here that the components do not yet do — the detail pane,
> the keymap, the confirmation model, the twelve-state switcher — is the work
> queue, not a second design.

# The operator console — design

**Status:** design, not built. The prototype at `src/web/console.html` is a
static rendering of everything below with fake data; wiring it to the live API
is a separate job.

**Scope:** Phase 5's console (`plan.md` §3). Not the phone. Not
`src/web/index.html`, which stays exactly as it is and keeps doing the one job
the console cannot do — bootstrap a box that is not in any fleet yet.

**What it is for, in one sentence, taken from §1:** this is the decision surface
for agents you own, and it answers three questions nothing else answers —
*which of my sessions needs me right now*, *what is it asking*, and *who said
yes*. Every argument below reduces to one of those three.

---

## 1. The one-screen argument

### Start from the feeling, because the product does

`docs/psychology.md` states the fact this console exists inside, and it is not a
technical one:

> Running autonomous agents on machines you own produces a specific, low-grade,
> continuous anxiety: *what is it doing right now, has it broken something, is
> it stuck waiting on me, has it been stuck for an hour.*
>
> That anxiety is unbounded because the information is unavailable. The
> product's real job is to **convert unbounded anxiety into bounded knowledge**.

The consequence for this design is structural and it inverts the usual order of
work: **"nothing needs you" is the most important state on this console, not the
least.** It is where a person is ninety-five percent of the time. A console that
only becomes useful when something is wrong has left the anxiety exactly where
it found it — the person still has to go and look, and going to look is the
cost the product was supposed to remove.

So the calm screen is not an empty state and it is not the throat-clearing
before the interesting ones. It is the deliverable.

### When nothing needs you: the assurance panel

The console is quiet and it is *complete*. Every session on every box is on the
screen at once, one line each, led by the work it is doing. And across the top —
in the same region a prompt will later take — is a positive assertion with its
evidence attached:

```
✓  Nothing needs you.                                    checked 2s ago

   ✓  All 4 enrolled hosts are connected.
   ✓  Every host reported in the last 11s.
   ✓  Every host can start work.
   ✓  Notifications are reaching 2 devices.   Send a test →
   ✓  This page is talking to the coordinator.

   ·  Longest silence: cc-warm-vole, working 3h 04m, last event 3h 04m ago.
```

Five claims and one fact. Every one of them is derived from `GET /api/hosts`
alone — `enrolled` versus `connected`, `healthAt` against `HEALTH_STALE_MS`,
`state` and `reason`, `devices`, and whether this page's own last fetch
succeeded. Nothing here is invented and nothing here is a metric for its own
sake: each line is a **specific way the console could be lying to you**, stated
as the reason it is not.

That is what makes the headline sayable. `Nothing needs you.` is not a mood and
it is not an aggregate green tick; it is licensed by the five lines beneath it
and by nothing else.

### Why the panel is trustworthy: the claims are the alarms

`psychology.md` §7 is the sharpest constraint in the document:

> If the fleet can be quiet because everything is fine, and *also* quiet because
> a host dropped, a token expired or push broke, then quiet means nothing and
> the anxiety comes straight back.

The design answer is that **the assurance panel and the alarm panel are the same
panel.** A claim that fails does not vanish and is not replaced by a different
component in a different place. It changes its glyph from `✓` to `▲` or `△`, and
its sentence from the affirmative to the specific negative, in the row it was
already occupying:

```
△  Nothing is asking you — but this screen is not seeing the whole fleet.

   ▲  3 of 4 enrolled hosts are connected.
      quarry stopped dialling in. Sessions on it cannot be seen from here.
      It reappears on its own when it dials back in. Nothing needs re-enrolling.
   △  thistle's last health report was 71s ago.
      What is shown for it may be out of date.
   ✓  Every connected host can start work.
   ✓  Notifications are reaching 2 devices.   Send a test →
   ✓  This page is talking to the coordinator.
```

Three things happen at once and all three matter. The headline stops saying
*nothing needs you* — because that would be a claim the console cannot support.
It says what it *can* support (nothing is asking) and then immediately says what
it cannot see. And each failing claim carries its remedy, because
`psychology.md` §6 says a message that ends at the diagnosis makes a frustrated
person go and find the cure in that state.

This is also, concretely, the fix for the gap Phase 5 names. `registry.js` goes
out of its way to make *"we don't know"* unrepresentable — it writes
`claude is not logged in on this host` and `last health report was 71s ago` —
and **nothing renders it.** The assurance panel is where those sentences finally
surface at fleet scale, and the host rail is where they surface per box.

### The instant something does need you

One region changes and it changes hard. The assurance panel yields its space to
the **Ask**: the oldest open prompt, expanded, with the question verbatim and
its options as numbered buttons. Its outer edge carries a diagonal hazard
texture that is a *shape*, not a colour. Its glyph is `◆`, used nowhere else.
Its word is `WAITING FOR YOU`. The tab title becomes `(1) Fleetwright`.

The claims do not disappear — they condense to one line beneath the prompt:
`✓ 4 of 4 hosts reporting · notifications reaching 2 devices`. They yield
priority; they never yield existence. If they vanished whenever something else
was happening, the person would have no way to know whether the one prompt they
can see is the only one there is.

Simultaneously the session's row in the wall sorts to the top of its group and
grows the same `◆` and the same word. And — `psychology.md` §1 — the prompt
**announces itself exactly once**. It slides in the first time its id is seen
and never again, because re-announcing a fact you acknowledged four minutes ago
is the screen version of a phone that cries wolf.

### The layout, justified from the thesis

| Thesis question | Where it is answered | Why there |
|---|---|---|
| Which needs me right now | The Ask strip, full width, above everything | It is the only region whose *presence* is information — and when nothing needs you, the same region is the reason you can believe that. |
| What is it asking | Inside the Ask, verbatim, monospace, `pre`, horizontally scrollable | The question is somebody else's TUI. Reflowing box-drawing at 70–100 columns turns a readable dialog into rubble, and the options are ordinals into that rendering. |
| Who said yes | The ledger rail, permanently visible, never a modal or a tab | Attribution behind a click is attribution nobody reads. It is *ambient*: you are not meant to go and look, you are meant to have already seen it. |
| *(and the fourth question, which is the anxiety)* Is anything wrong that I have not noticed | The assurance panel and the host rail's `reason` | Because the honest answer is sometimes "I cannot tell", and there has to be somewhere that says so. |

### What this is not, so the layout can be judged

It is not a dashboard. No gauges, no sparklines, no percentages — the fleet has
no time-series store and anything resembling a trend would be drawn from a
single sample. It is not a terminal. It is not a chat client: there is no text
input on this page that sends bytes to a host, and there never will be. And
nothing on it exists to bring anybody back to it.
## 2. Information architecture

### On the page, in priority order

0. **The standing claims** (§1). They are numbered zero because they are not
   *content* — they are the licence for believing everything else on the page,
   and they are the only region that is never absent.
1. **Open prompts.** Everything else on the screen is context for these. When
   one exists it takes the region the claims were in, and the claims condense to
   a single line beneath it rather than disappearing.
2. **Sessions that are broken or unreachable.** Not urgent the way a prompt is —
   nothing is blocked on you — but they are the things that will surprise you
   later, so they sort directly beneath the prompts and carry their own word.
3. **The session wall.** Every session, every host, one row: state glyph +
   state word + **title (the work) leading**, `name` (`cc-brave-otter`) beneath
   it, host, age. Grouped by host, sorted within a host by urgency then by age.
   Leading with the title is `psychology.md` §3 — nobody remembers what
   `cc-brave-otter` is, everybody remembers *"the billing importer refactor"* —
   and keeping the name visible is why support stays possible.
4. **The host rail.** Per host: state glyph, state word, `hostId`, the `reason`
   sentence *verbatim and never truncated*, the consequence of that state, the
   **remedy** for it, then capacity (`running of maxSessions`, `free`),
   `loadavg[0]`, `freeMemBytes` of `totalMemBytes`, `uptimeSec`, `labels`.
5. **The detail pane.** For the selected session: the state sentence, its prompt
   if it has one, the peek (≤ 60 lines, monospace, `pre`), and the Remote
   Control link.
6. **The ledger.** The last N events the coordinator still holds, newest first,
   with actor when the record has one — and **joined to the session list so each
   line leads with the work**, not the animal.
7. **Fleet facts, in the footer, small:** `protocol`, `devices` count, how many
   hosts are enrolled vs connected, and how old this page's data is.

### Deliberately not on the page

- **Any free-text field that reaches a host.** The `/` filter is client-side
  only, over data already fetched. This is not squeamishness; it is §4 of the
  plan applied to the surface that would find it easiest to cheat.
- **A terminal, or anything that looks like one.** Peek is a *snapshot* with a
  hard 60-line ceiling (the API's own cap) and a polling schedule that
  deliberately stops. A console left open on a desk must not fork
  `tmux capture-pane` on a production box forever.
- **Reboot.** `src/core/reboot.js` is a three-step ceremony whose third step
  works *because* it must be typed into a transcript. A three-button wizard is
  three taps, which is one decision made three times. Rebooting a box stays
  where its ceremony works. See §4.
- **A "don't ask me again" control**, on any action, including the theme. The
  plan excludes `always` from prompt options; a console that offers a global
  "stop confirming destructive things" re-adds it one layer up.
- **Aggregate health.** No score, no "3/4 healthy" pill. Four hosts is a list,
  and a single number is precisely the benign-looking lie `registry.js` was
  written to make unrepresentable.
- **Charts.** There is no history to chart; a trend line drawn from one sample
  is a decoration that lies.
- **Anything that manufactures engagement** — no streaks, no badge that exists
  to be cleared, no metric on the page because it moves rather than because a
  decision turns on it. The interruption budget belongs to the sessions.
- **Web Notifications and sound.** Argued in §6 and in the closing note; this is
  the decision I am least sure about.
- **A service worker / offline cache.** Excluded by the plan, for the right
  reason: caching a console whose entire value is freshness is a mechanism for
  showing a stale fleet convincingly.
- **`innerHTML`, anywhere.** Not a policy note, an architectural one: there is
  one `el()` helper in the file and it only ever sets `textContent`.
### Where the data comes from, which is a design decision and not plumbing

The wall is built from **`GET /api/hosts` alone** — the `health.sessions[]`
array each host already reports every 15 seconds, tagged with the `hostId` of
the entry it came from. Polling it at 5s costs one request to the coordinator
and *zero* round trips to any box.

`GET /api/list` is a fan-out. Every poll of it is a routed message down every
host's single outbound socket. So the console calls it **once on load, on an
explicit `r`, and after any mutating action** — never on a timer. The only
fields it adds are `rcUrl` and `uuid`, and those are needed at the moment you
select a session, not at the moment you scan the list.

The consequence, stated so it is not discovered: the wall is a view of a cache
of a cache, up to 15 seconds behind the box, aged out at 45. That is why every
host card shows `healthAt` as an age, and why a host that goes `unknown` has
its numbers frozen and hatched rather than left sitting there looking current.

---

## 3. The states

Twelve, and the console must be judgeable in all of them. The prototype ships a
scenario switcher (`0`) precisely so they can all be looked at.

Two rules run through every one of them, from `psychology.md`:

- **Say what is wrong *and* what to do about it.** `sidecar doctor` does not say
  `unauthorised`; it says the host is not enrolled and prints the command that
  enrols it. Every failing state below carries a remedy line in that voice. A
  person reading an error has less working memory available than usual, and the
  remedy is cheap for us to include and expensive for them to look up.
- **A failure never removes anything.** Whatever goes wrong, the row, the host
  card and the claim stay on screen and change what they say. Vanishing is how
  silence stops meaning anything.

### 3.1 No fleet yet — nothing has ever enrolled

`hosts` is empty and `hosts/enrolled` is empty. This is a first-run ceremony,
not an empty state, and it gets the whole centre column:

> **No machine has enrolled yet.**
> A host joins by dialling out to this coordinator with a pin you mint here.
> Nothing you own ever listens — the box opens the socket, not the other way round.
> `[ Mint an enrolment pin ]` *(admin only — see 3.12)*

Minting shows the pin **large, grouped for speaking aloud**, with its expiry
counting down, and the exact one-line command to run on the box. It does not
auto-dismiss. There is no other content on the screen, because there is no other
true content.

Distinguish this from **enrolled but never connected** (`hosts/enrolled`
non-empty, `hosts` empty): "3 machines are enrolled. None of them is connected
right now." Those are different problems with different fixes, and a shared
empty list is how you end up debugging the wrong one.

### 3.2 Fleet, no sessions

Hosts render normally in the rail. The wall says:

> **Nothing is running.** 3 hosts connected, 14 free slots.
> `[ Start a session ]` `S`

The start panel names the host explicitly rather than saying "somewhere",
because 0.3 makes ambiguity refusable and a UI that hides placement makes the
refusal unexplainable. It also states the mode in words — if `skipPermissions`
is on, the panel says **"permissions bypassed"** on the button itself. An
interface that cannot tell you permissions are off is unacceptable at any
default.

Note the assurance panel is fully populated here: an empty wall is *not* an
absence of information, and this screen should feel as settled as 3.3.

### 3.3 Everything healthy, sessions working — **the most important state**

This is where a person is ninety-five percent of the time, and it is the state
the whole console is for. §1 argues the layout; this is what is on it.

The Ask region is the **assurance panel**: a headline, five standing claims,
and one standing fact. Nothing blinks. The five claims are each a thing that
*can fail*, and when one does it changes its glyph and its sentence in place —
it is never removed, and the panel is never replaced by a different panel.

```
✓  Nothing needs you.                                    checked 2s ago

   ✓  All 4 enrolled hosts are connected.
   ✓  Every host reported in the last 11s.
   ✓  Every host can start work.
   ✓  Notifications are reaching 2 devices.   Send a test →
   ✓  This page is talking to the coordinator.

   ·  Longest silence: cc-warm-vole, working 3h 04m, last event 3h 04m ago.
```

The headline is `Nothing needs you.` — not "all systems operational", and not a
green tick over an aggregate. It is licensed by the five lines under it and by
nothing else.

**The one rule that makes the panel worth having:** if any claim fails, the
headline changes, even though nothing is asking. It becomes

> `△ Nothing is asking you — but this screen is not seeing the whole fleet.`

That sentence is the design. Quiet-because-fine and quiet-because-blind must
never look the same, and the console says which without being asked.

The standing fact is deliberately not a claim. The console cannot tell a session
thinking hard for three hours from a session wedged for three hours, so it
reports the number and passes no judgement — no threshold, no colour, no
warning. It exists because *"has it been stuck for an hour"* is the anxiety in
`psychology.md`'s own words, and a number answers it where a silence does not.

### 3.4 Silence you cannot trust — nothing is registered for push

Everything is healthy, nothing is asking, and `devices` is `0`. On the old
design this screen was indistinguishable from 3.3. It must not be.

> `△ Nothing is asking you — but nothing would reach you if it did.`
> `▲  No device is registered for notifications.`
> `   Nothing here can tell you a session is waiting while you are away from this screen.`
> `   Sign in on the phone app and enable notifications, then send a test from here.`

`0.4` made `Device` require a `clientId` and `ClientRegistry.revoke` drop the
registration — which means a revoked phone silently stops receiving, and this
claim is the only place a person would find out. The **Send a test** control is
`POST /api/devices/test`, which already exists, and it is here rather than
buried in a settings page for the reason `psychology.md` §7 gives: push breaking
produces exactly the same silence as everything being fine.

### 3.5 A host is degraded

`state: 'degraded'`, `reason` is one of two sentences the registry writes:
`claude is not logged in on this host`, or `session manager unreachable: …`.

```
▲  DEGRADED     hazel                              health 4s ago
claude is not logged in on this host
New sessions will not be scheduled here. The 2 sessions already on it
are still listed, and can still be answered.
Log in on the box: agent-hub's own page on that machine, or
`agent-fleet login` over SSH.
—
2 of 4 running · load 0.31 · 9.1 GB free of 16 · up 3d 4h · labels: arm64
```

Line 2 is the registry's `reason`, verbatim, never truncated, never turned into
a code. Line 3 is the **consequence**; line 4 is the **remedy**. Both are
authored by the console and mapped from `state` in exactly one place:

| state | consequence | remedy |
|---|---|---|
| `healthy` | Accepting new sessions. | — |
| `degraded` | New sessions will not be scheduled here. Sessions already on it are still listed, and can still be answered. | Depends on `reason`: log in on the box, or restart `agent-hub` on it. |
| `unknown` | We have not heard from it recently. Everything shown for it may be out of date. | If it stays unknown, check `systemctl status agent-fleet-sidecar` on that box. |
| `offline` | Its socket is closed. Its sessions are unreachable, not stopped. | It will reappear here on its own when it dials back in. Nothing here needs re-enrolling. |

The last consequence is `design.md` §3's sentence, and it is load-bearing: a
session on an offline box must never render as `STOPPED`, because `STOPPED`
invites a `Resume` that will be refused.

For `unknown`, the numbers on the card are **hatched and dimmed and their age
counter keeps ticking** — the one place a ticking counter is honest, because
what it is counting is the staleness itself.

Note `state` has four values, not three: `offline` exists in `registry.js` and
the console must render it. A UI that only knows healthy/degraded/unknown will
render a disconnected box as "unknown", which is a weaker and less actionable
claim than the registry actually makes.

### 3.6 A session is waiting

§6, in full. In the wall it is `◆  WAITING FOR YOU  ·  4m`, sorted first.

### 3.7 A session errored

`status: 'error'`. Row is `▲  BROKEN`. The detail pane leads with the most
recent `session.error` event's `text` for that `name` — real data, not
invented — attributed with its time, then the peek. Offered moves, in order:
**Peek** (read before acting), **Open in Remote Control** (`rcUrl`, the only
honest escape hatch), **Forget** (type the name).

Not offered: retry. There is no retry verb, and a button that maps to
`stop` + `start` is a workflow invented at the UI layer with a different
conversation on the other side.

### 3.8 A session is on a host we cannot reach

`△  UNREACHABLE`. The row is dimmed but **not removed** — removing it is exactly
the failure of §2.2, where a logged-out box silently swallowed its sessions.
Actions are disabled with a reason on hover *and* in the status bar, never
disabled silently. The remedy line is the host's: it will reappear on its own,
and nothing needs re-enrolling.

### 3.9 The coordinator is unreachable

The most important non-prompt failure, and the one most consoles get wrong.

On fetch failure the page does **not** clear and does **not** keep pretending:

- A fixed banner across the top, above the Ask: `✕ Not connected to the
  coordinator. Everything below is what we knew 47 s ago.` with `[Retry now] r`
  and the next attempt as a countdown, so the person knows whether to keep
  waiting.
- **And the reassurance, which is true and which nobody would otherwise know:**
  *"Your hosts keep running and keep their sessions. Each box is the authority
  on its own tmux — this page being blind does not stop the work."* That
  sentence is `design.md` §3's architecture doing psychological work, and
  leaving it out means the person infers the worst.
- All live data regions get a **diagonal hatch overlay** and drop to
  `--ink-dim`. The hatch is the shape; the dimming is the colour; the banner is
  the word.
- **Every age counter freezes.** A counter that keeps ticking over frozen data
  is the single most convincing lie a stale UI tells.
- Every action control is disabled, and the status bar says why.
- The assurance panel's fifth claim is the one that failed, and it says so
  rather than the panel disappearing.
- Backoff 1s, 2s, 4s, 8s, capped at 15s.

On reconnect, if the oldest event in the fresh snapshot is *newer* than the
newest event already held, the ledger inserts a `⋯ some events were missed`
divider. The ring is 200 (500 after 0.6) and it is not a log; the console should
say when it knows it has a hole rather than presenting a continuous stream that
is not one.

### 3.10 Partial fan-out failure

`dispatch()` returns `hosts: [{hostId, ok, text, error}]` and `ok` is
`some(r => r.ok)` after 0.7. When one host fails, the wall shows an inline row
in that host's group: `▲ bramble did not answer list within 8000 ms — its
sessions are missing from this list.` Absence is the thing that has to be
visible. A merged list that silently drops a box is how you conclude a session
is gone when it is running fine.

### 3.11 Signed out / credential expired

401 from any call. The console shows the sign-in screen and **keeps the last
snapshot behind it, hatched**, with the 3.9 treatment. It does not clear the
credential and it does not silently redirect — 0.7 names a headless 401 handler
that clears the credential as a foot-gun, and this page is the one holding the
cookie.

### 3.12 Not an admin

After 0.1, destructive routes need the admin capability. Non-admin: the controls
are **present and disabled with the reason shown** — "Revoking a host needs the
admin capability. You are signed in as sam@…" — not hidden. A hidden control
makes the person think the console is broken; a disabled one with a sentence
makes them think about who to ask. The console must also carry 0.1's required
sentence somewhere a person will read it, once, in the admin panel: *a guardrail
against colleagues and mistakes, not a security control.*
## 4. Interaction

Keyboard first, mouse complete. Every keystroke has a visible equivalent; no
capability exists only as a shortcut. The status bar at the bottom shows the
keys that are live *right now*, contextual to what is selected — which is how
the keymap gets learned without anybody reading this document.

### The keymap

**Navigate — free, instant, no confirmation**

| Key | Does |
|---|---|
| `j` / `k` | Next / previous session in the wall |
| `g` / `G` | First / last session |
| `n` | Jump to the next session that **needs you** — asking, then broken, then unreachable |
| `a` | Jump to and focus the oldest open prompt |
| `h` / `l` | Move focus between panes (hosts → wall → detail → ledger) |
| `Enter` | Open the selected session in the detail pane |
| `p` | Toggle the live peek for the selected session |
| `/` | Filter the wall (client-side only). `Esc` clears |
| `e` | Toggle the ledger pane |
| `r` | Refresh now, including the fan-out `list` |
| `t` | Cycle theme: system → light → dark |
| `d` | Toggle density: comfortable ↔ compact |
| `?` | Keymap overlay |
| `Esc` | Cancel, close, disarm — at every level, always |

**Answer — the only two-keystroke write**

| Key | Does |
|---|---|
| `1`–`9` | **Arm** option N of the focused prompt. Nothing is sent. |
| `Enter` | Send the armed option |
| `Esc` | Disarm |

Digits do nothing when no prompt is focused. They are never repurposed for
anything else on this page — a digit that means "jump to pane 3" in one context
and "approve a force-push" in another is a bug waiting for a tired operator.

**Act**

| Key | Does | The question it asks |
|---|---|---|
| `s` | Stop the selected session | Restatement |
| `R` | Resume the selected session | Restatement |
| `S` | Open the start panel | Restatement |
| `F` | Forget the selected session | Type the session name |
| `X` | Revoke the selected host (rail focus) | Type the hostId |

### Confirmations differ in kind, and never repeat in number

This is `src/core/reboot.js`'s argument, and it is the house rule:

> Tapping yes three times is one decision made three times; a person who
> misread the first prompt misreads all three.

So the console has **no escalation ladder**. There is never more than one
question. What varies is *what the one question asks for*, and it is chosen
against the mistake actually worth preventing:

| Class | The one question | Why that question | Applies to |
|---|---|---|---|
| **Free** | none | Nothing is changed. A confirmation here is noise that teaches people to click through the real ones. | Navigate, filter, peek, refresh, follow the Remote Control link |
| **Restated** | The action, echoed back in words you did not type, then `Enter` | The mistake worth preventing is *"I did not mean to press that"*. Reading a sentence you did not author is the cheapest thing that catches it. | `stop`, `resume`, `start`, and **answering a prompt** |
| **Named** | Type the identifier | The mistake worth preventing is *"wrong session"* / *"wrong box"*. Typing the name is the only step that requires having read which one you are talking to — reboot.js's step 3, which is why a button cannot finish it: a button carries its payload with it. | `forget`, revoke a host, revoke a client |

The restatement is not a modal. It changes the control in place and rewrites one
line beneath it:

> `Enter sends option 2 — "Yes, and remember for this session" — to cc-brave-otter on bramble, as eli@example.com.  Esc cancels.`

A modal would cover the question you are answering, which is the one thing that
must stay on screen.

**Proportionality, explicitly, because escalating everything is the failure
mode.** Revoking a host is disruptive and *recoverable* — it can be enrolled
again. So it asks **once**, and the once is "type the hostId" because that is
the kind of question that prevents the wrong box. It does not ask three times.
`psychology.md` §4 names this exact case, and the reason is that a console which
escalates everything trains people to click through everything, which is how the
reboot ceremony stops working too.

There is no "don't ask me again," on any control, including the theme. The plan
excludes `always` from prompt options; a console offering a global "stop
confirming destructive things" re-adds it one layer up.

### Reversibility scales with the context available — and this is the high-context surface

`psychology.md` §2 states the rule for the lock screen: it is the lowest-context
surface we have, so only reversible things belong on it. The console is the
*other end of that scale*. Here you can see the pane, the host's health, the
reason it is degraded, and who did what, in one glance without navigating.

That is a positive licence, not just a restriction, and the design uses it:

- `forget` exists **here and nowhere else**. It destroys `work-<name>`; it does
  not belong on a phone and it does not belong in a notification action.
- Host and client revocation exist here and nowhere else, for the same reason.
- When the phone cannot express something — an option list it cannot render, a
  prompt it must not answer with the least context anyone will ever have — the
  right move is **to send the person here**, not to build a smaller version of
  this there.

And the converse, written down so a future PR cannot quietly cross it: **the
console does not offer reboot.** `reboot.js` is a three-step ceremony whose
third step only works because it must be typed into a transcript. Rendering it
as a wizard with three buttons is three taps, which is one decision made three
times — the exact thing the file was written to prevent. Rebooting a box stays
where its ceremony works.

### Every action names its actor before it happens

Each restatement and each typed confirmation ends with **"as <your email>"**.
0.5 records `{verb, name, actor, hostId, at}`; the console shows the person what
the record is going to say *while they can still change their mind*. "Who said
yes" is a question about the past that the interface should also answer in the
future tense.

### Mouse

Everything reachable. Rows are one click to select, double-click to open.
Option buttons are one click to arm and a second click on the same button to
send — same one question, same restatement line. Hover targets ≥ 32 px tall in
comfortable density. No hover-only information anywhere: every tooltip's
content also appears in the detail pane or the status bar.
### Focus

`Tab` order is never overridden and the focus ring is never removed. The `j/k`
selection cursor is visually distinct from focus: selection is a 3 px left bar
plus a `▸` gutter caret plus a raised surface; focus is a 2 px offset ring in
`--accent`. Both can be on the same row at once and still be told apart.

---

## 5. Visual language

One family (system UI), one mono, no webfonts, no icon font, no SVG sprites.
Glyphs are single characters that exist in every system font we will meet.

### Type scale

Root 16 px. Five sizes and no others.

| Token | Size | Line | Use |
|---|---|---|---|
| `--t-micro` | 0.6875rem / 11px | 1.3 | Column heads, host meta labels. Uppercase, `letter-spacing: .08em`. Never for anything a person must read to make a decision. |
| `--t-meta` | 0.8125rem / 13px | 1.45 | Ages, hostIds, ledger lines |
| `--t-body` | 0.9375rem / 15px | 1.5 | Rows, reasons, consequences — the default |
| `--t-lead` | 1.0625rem / 17px | 1.4 | Session title, the prompt question |
| `--t-head` | 1.375rem / 22px | 1.25 | The Ask headline, empty-state headings |

Mono is `0.8125rem / 1.5` for pane text, `tab-size: 8`. Mono is used for
`hostId`, session `name`, timestamps, and anything captured from a pane — that
is, for **things that are identifiers or evidence**. Prose is never mono.

Prose blocks are capped at `68ch` even on a 3440 screen. The extra width goes
to the detail pane, not to longer lines.

### Spacing

4 px base. Steps: `4 · 8 · 12 · 16 · 24 · 32 · 48`. Pane gutters 16 px below
1600 px, 24 px above. Row height 44 px comfortable, 32 px compact. Nothing is
allowed a value off the scale.

### Colour tokens

The palette carries **four meanings**. The vocabulary carries fourteen. The
difference is deliberate: distinguishing `DEGRADED` from `BROKEN` is done with a
word and a glyph, not with two reds a person has to remember the order of.

| Token | Meaning | Dark | Light |
|---|---|---|---|
| `--bg` | page ground | `#0d0f13` | `#f4f6f8` |
| `--surface` | panes | `#14171d` | `#ffffff` |
| `--surface-2` | selected row, insets | `#1b1f27` | `#eaeef3` |
| `--line` | hairlines | `#252b34` | `#dfe4ea` |
| `--line-strong` | pane borders | `#39414e` | `#c2cad4` |
| `--ink` | body text | `#e6e9ee` | `#14171c` |
| `--ink-dim` | meta, stopped, unknown | `#98a2b0` | `#59626f` |
| `--ink-faint` | disabled, hairline labels | `#6a7482` | `#8b94a1` |
| `--ok` | healthy, working | `#46c08b` | `#0f7a52` |
| `--ask` | **waiting for you, and nothing else** | `#ffb340` | `#8a4f00` |
| `--ask-fill` | the Ask's ground | `rgba(255,179,64,.10)` | `rgba(255,179,64,.16)` |
| `--bad` | broken, degraded, offline, refused | `#f0736c` | `#b3261e` |
| `--accent` | interactive only — links, focus, selection. **Never a state.** | `#7aa2ff` | `#2159c9` |

Dark is the default and the one tuned for a dark room: the ground is `#0d0f13`,
not `#000`, so a bright pane inset does not punch a hole in the retina, and body
ink is `#e6e9ee`, not `#fff`, so a wall of text is not glare. Body text is ≥ 7:1
on its own surface in both themes; `--ink-dim` is ≥ 4.5:1. `--ask` on
`--ask-fill` clears 4.5:1 in both.

Light and dark are both defined up front on `:root`, with the dark block
repeated under `@media (prefers-color-scheme: dark)` *and* under
`:root[data-theme="dark"]`, so the toggle wins in both directions and the page
never borrows a ground it did not choose. (`src/web/index.html` already does
this correctly; keep it.)

### What carries meaning besides colour

Five redundant encodings. Any two of them removed and the screen still reads.
`psychology.md` §5 puts the reason better than the accessibility framing does:
colour is pre-attentive, which makes it excellent reinforcement and useless as
the sole carrier — a person glancing at a screen reads the shape and the word
before they have consciously processed the hue.

**1 — Glyph.** One character, unambiguous at 11 px, present in every system font.

| Object | State | Glyph | Word |
|---|---|---|---|
| Session | has an open prompt | `◆` | WAITING FOR YOU |
| Session | `running` | `●` | WORKING |
| Session | `stopped` | `○` | STOPPED |
| Session | `stopped`, last event `session.ended` | `✓` | FINISHED |
| Session | `error` | `▲` | BROKEN |
| Session | host not connected | `△` | UNREACHABLE |
| Host | `healthy` | `●` | HEALTHY |
| Host | `degraded` | `▲` | DEGRADED |
| Host | `unknown` | `△` | UNKNOWN |
| Host | `offline` | `✕` | OFFLINE |
| Standing claim | holds | `✓` | (the claim, in the affirmative) |
| Standing claim | fails | `▲` | (the failure, as a sentence) |
| Standing claim | cannot be checked | `△` | (what we cannot see, as a sentence) |
| Standing fact | neither good nor bad | `·` | (a number, never a judgement) |

Solid means we know; hollow means we do not. `▲` versus `△` is that distinction
applied to trouble: a definite fault versus a fault we cannot confirm. The
assurance panel reuses exactly this alphabet rather than inventing a second one,
which is the point — the calm screen and the alarm screen are the same object
speaking the same language.

**2 — Word.** The Phase 2a vocabulary — `working / waiting for you / stopped /
finished / broken` — plus `unreachable` for the host-offline case that 2a does
not name and design.md §3 does. It lives in **one map in one file** and the
badge, the sort key, the detail header and the status bar all read from it.
Left as five separate strings, five places will drift.

**3 — Position.** Urgency sorts. Asking first, broken second, unreachable
third, then working, then stopped. A person scanning top-down is scanning by
priority whether they know it or not.

**4 — Texture.** The Ask carries a 6 px repeating 45° hazard edge. `unknown`
data carries a diagonal hatch overlay. Both survive a monochrome screen, a
colour-blind reader, and a bad projector.

**5 — Weight and border.** Asking: 4 px left bar. Broken: 4 px left bar. Normal:
none. Selection: 3 px `--accent` bar plus `▸`.
### Motion

Two transitions, both ≤ 200 ms, both inside `@media (prefers-reduced-motion:
no-preference)`: the Ask's height change, and the arm/disarm of an option.
**Nothing on this page animates indefinitely.** A perpetual pulse is a thing
you learn to stop seeing, which makes it worse than nothing at exactly the
moment it matters.

### Pane text is hostile input, and is treated as such

`textContent` only, everywhere, without exception. On top of that, before any
captured text or option label is set:

- strip C0 control characters except `\n` and `\t` — a bare `\r` in captured
  output can overwrite a line in place and make the pane show something the
  session never printed;
- strip or visibly render Unicode bidi overrides (`U+202A`–`U+202E`,
  `U+2066`–`U+2069`) in **option labels**. A right-to-left override inside a
  label can make a button read `Deny` and mean `Approve`, six pixels from an
  irreversible action, on the origin that holds every credential in the fleet.

`white-space: pre`, no wrapping, `overflow-x: auto` on its own container. The
page body never scrolls sideways; the pane does.

---

## 6. The prompt treatment

The hardest problem on the page, and the one the product is for.

### What it has to do

1. Be unmissable without being agitating, in a room where the console may have
   been sitting untouched for an hour — and announce itself **once**, not on
   every poll. `psychology.md` §1: the expensive part of an interruption is
   reacquiring context, and a surface that re-announces spends that cost again
   for nothing.
1b. **Carry enough that nothing has to be reacquired.** The card holds the work
   title, the pane verbatim, the host and the age. That is the whole reason
   `prompt.js` exists: a notification saying `resumed (summary)` forces a person
   to go and find out what is being asked, and so does a console card that only
   says a session is waiting.
2. Show the question **exactly as the session rendered it**, because the
   options are ordinals into that rendering and a reflowed dialog is a
   different dialog.
3. Make answering fast enough to be worth doing at 2am and deliberate enough
   that a wrong key does not force-push.
4. Handle two or three at once without ever putting two live "Yes" buttons on
   screen at the same time.
5. Fail honestly. Answering is the one write this product owns and it sits on
   top of `plan.md` §5.1 — a screen-scrape, a hash, and a TOCTOU window. The UI
   cannot close that window. It can refuse to hide it.

### Anatomy

```
╔═ hazard edge, 6px, 45° stripes ═══════════════════════════════════════════╗
║ ◆ WAITING FOR YOU · 4m 12s              cc-brave-otter · bramble · [RC ↗] ║
║                                                                           ║
║ Rewrite the auth middleware                             ← title, the work ║
║                                                                           ║
║ ┌───────────────────────────────────────────────────────────────────────┐ ║
║ │ Do you want to proceed?                                               │ ║
║ │ ╭───────────────────────────────────────────╮       ← verbatim, mono, │ ║
║ │ │ git push --force origin main              │          pre, x-scroll  │ ║
║ │ ╰───────────────────────────────────────────╯                         │ ║
║ └───────────────────────────────────────────────────────────────────────┘ ║
║                                                                           ║
║   ⟦1⟧  Yes                                                                ║
║   ⟦2⟧  Yes, and remember for this session                                 ║
║   ⟦3⟧  No, tell Claude what to do differently                             ║
║                                                                           ║
║   Press 1–3 to choose. Nothing is sent until you press Enter.             ║
╚═══════════════════════════════════════════════════════════════════════════╝
        ◆ 2 more asking     cc-quiet-heron · hazel · 11m   ›
                            cc-plain-lark  · bramble · 26m ›
```

The age ticks. It is the one live number on a calm screen and it is the number
that decides whether you deal with this now — four minutes is a pause, twenty-six
is a session that has been parked all afternoon.

`Remote Control ↗` is present on every prompt, top right, not hidden. Phase 2c
is right about the phone and it is right here: the option list can only express
what the option list can express, and the honest escape hatch is a link that
leaves the console.

### Answering, keystroke by keystroke

**Press `2`.** The option arms. Three things change at once: its ordinal chip
inverts (fill), it gains a 2 px `--accent` border, and the footer line is
replaced with the restatement —

> `Enter sends option 2 — "Yes, and remember for this session" — to cc-brave-otter on bramble, as eli@example.com.   Esc cancels.`

The label is echoed back as words. This is the whole confirmation and it is
better than a modal, because the question is still on screen while you read it.

**Press `Enter`.** The card goes to `sending…`, all options disable, the
restatement is replaced by `sent — waiting for bramble`.

**Then one of four things.** All four are designed; none is a generic error.

| Outcome | The card says | Then |
|---|---|---|
| Answered | `✓ answered · option 2 · by you · 14:02:11` | Card collapses over 200 ms and the same line appears at the top of the ledger. The answer *becomes* the audit record in front of you. |
| Already answered | `✓ already answered by sam@example.com at 14:02` | Not an error, not red. It is 0.5 doing its job and it is the correct outcome of a stale tap. Card retires the same way. |
| The screen moved | `△ The screen changed while you were reading. Nothing was sent.` | The new prompt is fetched and rendered fresh, **disarmed**. Never auto-retried. This is §5.1's hash-mismatch refusal, surfaced instead of swallowed. |
| No answer from the host | `▲ bramble did not answer within 8 s. We do not know whether it landed.` | Offers **Peek**, not Retry. `design.md` §3's rule applied to a write: an unknown is not a failure and must not be presented as one. |

### The double-Enter guard

When a prompt retires and another is queued, the next one is promoted
immediately — but its options are **inert for 150 ms**, and the ordinal chips
render at half opacity during that window. Somebody clearing a backlog will
press `2 Enter 2 Enter` faster than they read. Without the hold, the second
`Enter` lands on a prompt that appeared under the cursor 40 ms earlier. This is
the single cheapest safety measure on the page and it is invisible when it is
not needed.

### Two or three at once

**One expanded, ever.** The oldest — the one that has been blocking longest —
is expanded. The rest are a queue rail under it: glyph, count, then one line
each (`name · host · age ›`). `a` cycles. Clicking a queue line promotes it.

The alternative — a wall of expanded cards — was rejected because it puts
several live `Yes` buttons in the same visual field with near-identical
labels, which is the exact condition under which people click the wrong one.

### When the console must refuse to offer buttons

- `options` is empty or absent → no buttons. Show the question and Remote
  Control. A prompt we cannot express is still worth *telling* you about.
- `options.length > 9` → no buttons, same treatment. The wire format is
  `option: int 1..9`; a tenth option is not addressable and the console must
  not render an unreachable row next to nine reachable ones.
- The host has not advertised `answer` in its `health` verb list (Phase 3.5) →
  buttons render **disabled**, with the reason: `bramble is on protocol 1 and
  cannot be answered from here.` Grey out rather than offer a button that will
  fail — that is what the advertisement is for.

### Announcing to a person who is not looking at the screen

Three signals, in ascending intrusiveness, and the console uses the first two:

1. **The tab title** — `(2) Fleetwright`. No permission, no sound, no network,
   visible in a window you are not focused on. It is a badge, and it answers to
   §7's rule against badges: it counts outstanding decisions that exist whether
   or not it renders them, and it reaches zero by being acted on.
2. **The Ask region's own arrival** — height change, hazard edge, `◆`.
3. **Sound / Web Notification** — *not built.* See the closing note; this is the
   decision I am least sure about, and `psychology.md` §7 sharpens the argument
   against me rather than for me.

### Announce once, never again

`watcher.js` already states the rule for the notification path: *an event fires
on a transition, never on a state. A session sitting at a prompt for an hour is
one notification, not 180.* The console is a state surface, so it renders the
prompt continuously — but it must **animate it exactly once**. A card that
re-slides on every 5-second poll is 720 announcements an hour of a fact you
acknowledged in the first second, and it is the screen equivalent of crying
wolf.

Concretely: the console holds the set of prompt ids it has already shown. A
prompt animates in the first time its id appears and never again — not on
re-render, not on refresh, not when the one above it retires. The age keeps
ticking, because that is new information every second. Nothing else moves.
### The privacy line, which belongs here

`plan.md` §5.4: pane text leaving the fleet is opt-in per fleet, default off,
and the flagship improvement therefore ships switched off with nobody knowing
to turn it on. The mitigation is a line in the console. It goes in the **host
rail footer** — fleet-level, not per host, because the switch is per fleet:

> `Prompt text is not sent to phones on this fleet. Notifications say a session
> is waiting; they do not say what it asked.  [ Change ]`

That sentence is the entire discoverability plan for Phase 1's headline
feature, which is a good argument for it not being small grey text at the
bottom of a settings page.

---

## 7. Where each principle lands

`docs/psychology.md` states seven principles. A design that agrees with them in
spirit and nowhere in particular is not a design. This table is the audit: each
row names the concrete thing on screen, so a future change can be argued against
it.

| Principle | Where it is, concretely |
|---|---|
| 1. An interruption costs more than the time it takes to answer | The prompt card carries the work title, the verbatim pane and the host, so nothing has to be reacquired (§6). And the console **announces a prompt once** — a re-render never re-animates one you have already seen (§6). |
| 2. Reversibility scales with the context available | The console is the *highest*-context surface in the system, which is why `forget` and host revocation exist here and on no other surface, and why the phone's job is to send you here (§4). |
| 3. Recognition beats recall | Every surface leads with `title` and keeps `name` beneath it — the wall, the prompt card, the detail header, **and the ledger**, which joins events to the session list so a line reads *"answered — Rewrite the auth middleware · cc-brave-otter"* rather than making you translate (§2). |
| 4. Confirmations differ in kind, not in number | Never more than one question, and the question is chosen for the mistake worth preventing: restatement for reversible things, typing the identifier for "wrong session"/"wrong box" (§4). The console does not offer reboot at all (§2). |
| 5. Never colour alone | Five redundant encodings — glyph, word, position, texture, weight. Four colours carry meaning; the vocabulary carries fourteen (§5). |
| 6. Say what is wrong **and** what to do | Every failing state carries a remedy line, in the same voice as `sidecar doctor`: not `unauthorised` but the command that fixes it (§3). |
| 7. Silence must be trustworthy before it is comfortable | The assurance panel (§1) — five standing claims, each of which can fail, none of which can quietly disappear. It is the same object as the alarm panel. |

And the negative list: no streaks, no badges that exist to be cleared, no metric
on the page because it moves rather than because a decision turns on it, and
nothing whose purpose is to bring somebody back. The interruption budget belongs
to the sessions.

**One thing on the page has to answer to that rule directly:** the tab title
counter, `(2) Fleetwright`. It is a badge and it is cleared by acting. It earns
its place because it counts *outstanding decisions that exist whether or not it
renders them* — it is a readout, not a generator — and it reaches zero honestly
and stays there. If it ever counted anything else, it would be the first thing
to delete.

---

## Three decisions I am least sure about

**1. That the console still makes no sound and raises no Web Notification.**
I argued this from "the phone is the interrupt handler". `psychology.md` §7 is
the counter-argument and it is a strong one: if the console is quiet because
nothing needs you, and also quiet because you walked to the kitchen, then the
console's silence means nothing either — which is the exact failure the
assurance panel was built to prevent, reappearing one layer up. The honest
position is that the assurance panel fixes trustworthy silence *for a person
looking at the screen* and does nothing at all for a person who is not. If this
is wrong, the fix is one soft tone, off by default, only on a prompt opening,
never repeated — and the assurance panel grows a sixth claim: *"this screen
will make a sound when something asks."*

**2. Building the wall from `health.sessions[]` rather than `GET /api/list`.**
It removes a fan-out per poll, which is real. The cost is that the inventory is
a cache of a cache — up to 15 s stale, aged at 45 — and it carries neither
`rcUrl` nor `uuid`, so selecting a session triggers a second call anyway. The
assurance panel's freshness claim makes the staleness *visible*, which is
better than hiding it, but visible is not the same as absent. The hedge: on the
fan-out `list` that follows any mutation, diff it against the health-derived
wall and say so when they disagree, rather than silently preferring one.

**3. That answering a prompt is one restatement and nothing more, whatever the
option says.** `Yes, force-push` and `No, tell Claude something else` cost the
same two keystrokes. `psychology.md` §4 says escalating everything trains
click-through, which argues I am right; but it also says the question should be
chosen for *the mistake worth preventing*, and here the mistake worth
preventing is "approved the wrong option", which a restatement does address —
weakly. The console cannot escalate on the dangerous option without
*classifying the option text*, which the plan refuses on the host side for good
reasons. So this is consistent rather than confident, and the 150 ms hold is
doing work that a better-chosen question would do properly.