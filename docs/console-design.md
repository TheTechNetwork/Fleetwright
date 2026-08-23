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

### When nothing needs you

The console is quiet and it is *complete*. Every session on every box is on the
screen at once, one line each, with the machine it is on. The top strip says, in
one line and one line only:

> `○  Nothing is waiting on you.  ·  7 working, 4 stopped, across 3 hosts.`

That sentence is the product. Not "all systems operational" — a green tick that
aggregates four boxes into one number is precisely the benign-looking lie
`registry.js` was written to make unrepresentable. It is a *count you can
verify against the list beneath it*, and if a host is not reporting, the
sentence says so instead of averaging it away.

The rest of the screen is inventory: the host rail on the left with each box's
state **and its `reason` sentence rendered verbatim**, the session wall in the
middle, the detail pane, and the event ledger on the right. Nothing blinks.
Nothing animates. A console that is agitated when nothing is wrong has spent
the only attention budget it will ever get.

### The instant something does

One thing changes, and it changes hard. The top strip — which was always
there, occupying its own row, so nothing below it moves — expands into the
**Ask**: the oldest open prompt, expanded, with the question verbatim and its
options as numbered buttons. Its outer edge carries a diagonal hazard texture
that is a *shape*, not a colour. Its glyph is `◆`, used nowhere else in the
system. Its word is `WAITING FOR YOU`, from the Phase 2a vocabulary. The
browser tab title becomes `(1) Fleetwright`, which is the only signal the
console can send to a person who is looking at a different window without
asking for a permission or making a sound.

Simultaneously the session's row in the wall sorts to the top of its group and
grows the same `◆` and the same word.

The layout justifies itself directly from the thesis:

| Thesis question | Where it is answered | Why there |
|---|---|---|
| Which needs me right now | The Ask strip, full width, above everything | It is the only region whose *presence* is information. Full width because a prompt's question is pane text that must not reflow. |
| What is it asking | Inside the Ask, verbatim, monospace, `pre`, horizontally scrollable | The question is somebody else's TUI. Reflowing box-drawing at 70–100 columns turns a readable dialog into rubble (Phase 2b's rule, and it applies here harder because this screen is where the answer is given). |
| Who said yes | The ledger rail, permanently visible, never a modal or a tab | Attribution that lives behind a click is attribution nobody reads. It is a rail because it is *ambient* — you are not meant to go and look, you are meant to have already seen it. |

And the fourth region — the host rail — exists because of a bug this design is
partly a fix for. §2.2: a box whose Claude is merely logged out silently drops
every one of its sessions. After 0.2 the sessions come back; what still has to
happen is that the console *says why the box is unhappy*, in the sentence the
registry already went to the trouble of writing. Rendering `reason` is not a
nicety. It is the difference between "hazel is degraded" and "claude is not
logged in on hazel", and the second one tells you what to do.

### What this is not, so the layout can be judged

It is not a dashboard. There are no gauges, no sparklines, no percentages. The
fleet has no time-series store; anything that looked like a trend line would be
drawn from a single sample and would be a decoration that lies. It is not a
terminal — see §2. It is not a chat client — there is no text input anywhere on
this page that sends bytes to a host, and there never will be (§4 of the plan).

---

## 2. Information architecture

### On the page, in priority order

1. **Open prompts.** Everything else on the screen is context for these.
2. **Sessions that are broken or unreachable.** Not urgent the way a prompt is —
   nothing is blocked on you — but they are the things that will surprise you
   later, so they sort directly beneath the prompts and carry their own word.
3. **The session wall.** Every session, every host, one row: state glyph +
   state word + title (the work) + name (`cc-brave-otter`) + host + age.
   Grouped by host, sorted within a host by urgency then by age.
4. **The host rail.** Per host: state glyph, state word, `hostId`, the `reason`
   sentence *verbatim and never truncated*, then the consequence of that state
   in fleet-authored words, then capacity (`running of maxSessions`, `free`),
   `loadavg[0]`, `freeMemBytes` of `totalMemBytes`, `uptimeSec`, `labels`.
5. **The detail pane.** For the selected session: the state sentence, its
   prompt if it has one, the peek (≤ 60 lines, monospace, `pre`), and the
   Remote Control link.
6. **The ledger.** The last N events the coordinator still holds, newest first,
   with actor when the record has one.
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
- **A "don't ask me again" control**, on any action, including the theme. The
  plan excludes `always` from prompt options; a console that offers a global
  "stop confirming destructive things" re-adds it one layer up.
- **Aggregate health.** No score, no "3/4 healthy" pill. Four hosts is a list.
- **Charts.** See above — there is no history to chart.
- **Web Notifications and sound.** Argued in §6; this is the decision I am least
  sure about and it is flagged as such.
- **A service worker / offline cache.** Explicitly excluded by the plan, for the
  right reason: caching a console whose entire value is freshness is a
  mechanism for showing a stale fleet convincingly.
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

Eleven, and the console must be judgeable in all of them. The prototype ships a
scenario switcher (`0`) precisely so they can all be looked at.

### 3.1 No fleet yet — nothing has ever enrolled

`hosts` is empty and `hosts/enrolled` is empty. This is a first-run ceremony,
not an empty state, and it gets the whole centre column:

> **No machine has enrolled yet.**
> A host joins by dialling out to this coordinator with a pin you mint here.
> `[ Mint an enrolment pin ]` *(admin only — see 3.11)*

Minting shows the pin **large, grouped for speaking aloud**, with its expiry
counting down, and the exact one-line command to run on the box. It does not
auto-dismiss. There is no other content on the screen, because there is no
other true content.

Distinguish this from **enrolled but never connected** (`hosts/enrolled`
non-empty, `hosts` empty): "3 machines are enrolled. None of them is connected
right now." Those are different problems with different fixes and a shared
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
default (0.7 says this about the app; it is more true here, where the person is
sitting down and choosing).

### 3.3 Everything healthy, sessions working

The calm screen from §1. Ask strip is one line. Every host `●  HEALTHY` with
`reporting normally`. Rows are `●  WORKING`. Nothing is coloured except the
state glyphs and the focus ring.

### 3.4 A host is degraded

`state: 'degraded'`, `reason` is one of two sentences the registry writes:
`claude is not logged in on this host`, or `session manager unreachable: …`.

The card:

```
▲  DEGRADED     hazel                              health 4s ago
claude is not logged in on this host
New sessions will not be scheduled here. The 2 sessions already on it
are still listed, and can still be answered.
—
2 of 4 running · load 0.31 · 9.1 GB free of 16 · up 3d 4h · labels: arm64
```

Line 2 is the registry's `reason`, verbatim, never truncated, never turned into
a code. Line 3 is a **consequence**, authored by the console, mapped from
`state` in exactly one place:

| state | consequence sentence |
|---|---|
| `healthy` | Accepting new sessions. |
| `degraded` | New sessions will not be scheduled here. Sessions already on it are still listed, and can still be answered. |
| `unknown` | We have not heard from it recently. Everything shown for it may be out of date. |
| `offline` | Its socket is closed. Its sessions are unreachable, not stopped. |

The last one is `design.md` §3's sentence, and it is load-bearing: a session on
an offline box must never render as `STOPPED`, because `STOPPED` invites a
`Resume` that will be refused.

For `unknown`, the numbers on the card are **hatched and dimmed and their age
counter keeps ticking** — the one place a ticking counter is honest, because
what it is counting is the staleness itself.

Note `state` has four values, not three: `offline` exists in `registry.js` and
the console must render it. A UI that only knows healthy/degraded/unknown will
render a disconnected box as "unknown", which is a weaker and less actionable
claim than the registry actually makes.

### 3.5 A session is waiting

§6, in full. In the wall it is `◆  WAITING FOR YOU  ·  4m`, sorted first.

### 3.6 A session errored

`status: 'error'`. Row is `▲  BROKEN`. The detail pane leads with the most
recent `session.error` event's `text` for that `name` — real data, not
invented — attributed with its time, then the peek. Offered moves, in order:
**Peek** (read before acting), **Open in Remote Control** (`rcUrl`, the only
honest escape hatch), **Forget** (tier 2, typed confirmation).

Not offered: retry. There is no retry verb, and a button that maps to
`stop` + `start` is a workflow invented at the UI layer with a different
conversation on the other side.

### 3.7 A session is on a host we cannot reach

`△  UNREACHABLE`. Row is dimmed but **not removed** — removing it is exactly
the failure of §2.2, where a logged-out box silently swallowed its sessions.
Actions are disabled with a reason on hover *and* in the status bar, never
disabled silently.

### 3.8 The coordinator is unreachable

The most important non-prompt state, and the one most consoles get wrong.

On fetch failure the page does **not** clear and does **not** keep pretending:

- A fixed banner across the top, above the Ask: `✕ Not connected to the
  coordinator. Everything below is what we knew 47 s ago.` with `[Retry now] r`.
- All live data regions get a **diagonal hatch overlay** and drop to `--ink-dim`.
  The hatch is the shape; the dimming is the colour; the banner is the word.
- **Every age counter freezes.** A counter that keeps ticking over frozen data
  is the single most convincing lie a stale UI tells.
- Every action control is disabled, and the status bar says why.
- Reconnect backoff: 1s, 2s, 4s, 8s, capped at 15s, with the next attempt
  shown as a countdown so the person knows whether to keep waiting.

On reconnect, if the oldest event in the fresh snapshot is *newer* than the
newest event already held, the ledger inserts a `⋯ some events were missed`
divider. The ring is 200 (500 after 0.6) and it is not a log; the console
should say when it knows it has a hole rather than presenting a continuous
stream that is not one.

### 3.9 Partial fan-out failure

`dispatch()` returns `hosts: [{hostId, ok, text, error}]` and `ok` is
`some(r => r.ok)` after 0.7. When one host fails, the wall shows an inline row
in that host's group: `▲ bramble did not answer list within 8000 ms — its
sessions are missing from this list.` Absence is the thing that has to be
visible. A merged list that silently drops a box is how you conclude a session
is gone when it is running fine.

### 3.10 Signed out / credential expired

401 from any call. The console shows the sign-in screen and **keeps the last
snapshot behind it, hatched**, with the 3.8 treatment. It does not clear the
credential and it does not silently redirect — 0.7 names a headless 401 handler
that clears the credential as a foot-gun, and this page is the one holding the
cookie.

### 3.11 Not an admin

After 0.1, destructive routes need the admin capability. Non-admin: the
controls are **present and disabled with the reason shown** — "Revoking a host
needs the admin capability. You are signed in as sam@…" — not hidden. A hidden
control makes the person think the console is broken; a disabled one with a
sentence makes them think about who to ask. The console must also carry 0.1's
required sentence somewhere a person will read it, once, in the admin panel: *a
guardrail against colleagues and mistakes, not a security control.*

---

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

| Key | Does | Tier |
|---|---|---|
| `s` | Stop the selected session | 1 |
| `R` | Resume the selected session | 1 |
| `S` | Open the start panel | 1 |
| `F` | Forget the selected session | **2** |
| `X` | Revoke the selected host (rail focus) | **2** |

### The three tiers, and the rule that assigns them

- **Tier 0 — one keystroke, no confirmation.** Everything that only reads:
  navigation, filter, peek, refresh, following the Remote Control link.
- **Tier 1 — arm, then `Enter`.** Anything that changes state but leaves it
  recoverable: `stop` (the conversation survives), `resume`, `start`, and
  **answering a prompt**. Arming does not open a modal. It changes the control
  in place and rewrites one line beneath it in plain words:
  > `Enter sends option 2 — "Yes, and remember for this session" — to cc-brave-otter on bramble, as eli@example.com.  Esc cancels.`
  The restatement *is* the confirmation. A modal would cover the question you
  are answering, which is the one thing that must stay on screen.
- **Tier 2 — type the name out.** Anything that destroys state nothing can
  recreate: `forget` (which takes `work-<name>` with it), revoking a host,
  revoking a client. The field is empty, the match is exact and
  case-sensitive, and the button stays disabled until it matches. No paste
  shortcut is blocked — the point is deliberation, not hazing.

There is no tier 3 and there is no "don't ask me again."

### Every action names its actor before it happens

Each tier-1 restatement and each tier-2 dialog ends with **"as <your email>"**.
0.5 records `{verb, name, actor, hostId, at}`; the console shows the person
what the record is going to say *while they can still change their mind*. "Who
said yes" is a question about the past that the interface should answer in the
future tense as well.

### Mouse

Everything reachable. Rows are one click to select, double-click to open.
Option buttons are one click to arm and a second click on the same button to
send — same two-step, same restatement line. Hover targets ≥ 32 px tall in
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

The palette carries **four meanings**. The state vocabulary carries eleven. The
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

Solid means we know; hollow means we do not. `▲` versus `△` is that distinction
applied to trouble: a definite fault versus a fault we cannot confirm.

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
   been sitting untouched for an hour.
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
   visible in a window you are not focused on.
2. **The Ask region's own arrival** — height change, hazard edge, `◆`.
3. **Sound / Web Notification** — *not built.* The phone is the interrupt
   handler; the console is for someone sitting down. Making the console buzz
   too is how you end up with two half-designed interrupt surfaces and a person
   who mutes both.

I am least confident about (3). See the note at the end.

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

## Three decisions I am least sure about

**1. No sound, and no Web Notification.** Argued above from "the phone is the
interrupt handler". But the console is the *only* surface that knows about all
ten sessions, and a person supervising them will look at another window. If
this is wrong, the fix is small and should be exactly this and nothing more: one
soft tone, off by default, only for a prompt opening, never repeated, and never
for anything else.

**2. Building the wall from `health.sessions[]` rather than `GET /api/list`.**
It removes a fan-out per poll, which is real and worth a lot. The cost is that
the inventory is a cache of a cache — up to 15 s stale, aged at 45 — and it
carries neither `rcUrl` nor `uuid`, so selection triggers a second call anyway.
If the two lists can ever disagree, the console shows the wrong inventory and
nothing in the design catches it. A cheap hedge exists: on the periodic
fan-out `list` after any mutation, diff it against the health-derived wall and
say so when they differ, rather than silently preferring one.

**3. One uniform confirmation tier for answering.** `Yes, force-push` and
`No, tell Claude something else` cost exactly the same two keystrokes. The
console cannot escalate on the dangerous one without *classifying the option
text*, which is precisely what the plan refuses to do on the host side and for
good reasons (every TUI change becomes a correctness-critical parser edit). So
uniform is consistent — but it means the interface offers no help at all on the
one dimension the person most wants help with, and the 150 ms hold is doing a
lot of work that a real escalation would do better.
