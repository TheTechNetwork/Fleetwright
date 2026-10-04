# The host sidecar

What runs on a fleet host. It dials the coordinator, validates every intent that
arrives against the verb allowlist, and drives **fleetwright** through its loopback
HTTP API.

```
coordinator ──ws──▶ sidecar ──http──▶ 127.0.0.1:8790 (fleetwright) ──▶ tmux ──▶ claude
                      │
                      └── validates · translates · repairs
```

fleetwright carries no fleet code and is not aware of any of this. From its side
the sidecar is one more HTTP client holding its token — the same interface its
own CLI uses.

## Why out-of-process, now that it is all one project

The alternative was `src/adapters/fleet.js` inside the session manager, which §6
of `design.md` proposes and which is a genuinely clean fit for its adapter seam.
Bringing both into one project removes the original argument for the sidecar —
no PR has to land for either approach now — but the one that remains is the one
that matters:

**The session manager is one process and the fleet another.** It began as
upstream code meant to go back to agent-hub, and that is no longer the plan —
Fleetwright is a spin-off ([`lineage.md`](./lineage.md)) — but the boundary
stays: the sidecar restarts without disturbing a session, and a box that is not
in a fleet runs the session manager alone.

Two smaller things it buys: the sidecar restarts without disturbing sessions
(fleetwright's own shutdown deliberately leaves tmux alone, and this preserves
that), and a host can run a session manager other than the one in this tree.

The cost is one round trip of latency per action on loopback, which is nothing
next to the ~20s a session start spends waiting for Remote Control anyway.

## What it enforces

**The coordinator sends intents, never commands.** A fixed verb set, an
idempotency key on every mutating one, no way to express a path or a login. The
full contract is in [`intents.md`](./intents.md).

Running out-of-process *sharpens* that rather than softening it, and this is the
single most important thing to understand about the sidecar:

> `POST /api/command` will run **any** command line it is handed, `/login`
> included, and the sidecar is the only thing holding fleetwright's token.

So the verb allowlist here is not defence in depth — it is the defence. That is
why `toCommandLine()` assembles the line from literals in its own source plus
values already charset-checked, and why nothing from the wire is ever
concatenated into it.

## The three things fleetwright's API imposes

Each shows up as a deliberate compromise, and each is worth knowing before
reading the code.

### 1. `createdBy` used to be unattributable — fixed, and worth keeping the shape of

fleetwright used to hardcode `actor: 'web'` for every HTTP caller, so a session
the fleet started was recorded as started by "web", not by the person who
asked. It accepts a claimed actor now — charset-validated, falling back to
`web` only when none is claimed (`src/adapters/http.js`) — and the sidecar
posts the verified `fleet:<email>`, which lands in `createdBy`
(`src/core/sessions.js`).

The honest caveat travels with it: the attribution is exactly as trustworthy
as the token that carried it — anything holding the sidecar's token can claim
any actor on the commands that token runs — so it is a label for honest
surfaces, not an audit trail.
Authorization still belongs in the coordinator, which is where §5 argues
per-session ownership lives (one chokepoint instead of N hosts).

### 2. `/api/peek` is fixed at 60 lines

`sessions.peek(name, 60)` is hardcoded; there is no `lines` parameter on the
wire. The protocol still accepts `lines` up to 500, and the sidecar trims
client-side — so `lines` can narrow what comes back and never widen it. Asking
for 500 gets 60. Trimming client-side rather than pretending the parameter
reached the hub keeps the limitation visible instead of silently ignored.

### 3. `/internal/session-start` is loopback-only and untokened — which is useful

It is deliberately not token-gated: the SessionStart hook runs as a child of a
`claude` process on the same box, and giving it the operator token would mean
writing that token into a world-readable hook script.

The **per-session hook socket** ([`hook-socket.md`](./hook-socket.md)) is the
sandboxed form of the same report, and fleetwright serves it itself: the socket
says which session a report came from, so the container posts `{uuid, cwd}` to
`/run/hub/hub.sock` and can name nothing. The sidecar is not in that path.

## What it fixes

The sidecar re-derives Remote Control URLs from the pane itself rather than
trusting the ones fleetwright recorded.

fleetwright's `extractRcUrl` matched the raw `capture-pane` output with no
de-wrapping — unlike its own login flow, which has `dewrapPane` for exactly this
failure. A pane is a fixed-width grid, and the RC URL is one long token.
Measured against the verbatim CLI 2.1.233 capture in `design.md` §10, and
confirmed on a real 70-column tmux pane:

| pane width | fleetwright recorded |
|---|---|
| 80 | correct — which is why this was never noticed |
| 100 | `https://claude.ai/code/session_016zf` — truncated, well-formed, and dead |
| 70 | **`null`** — the `https://` prefix straddles the break, so the session is reported online with no URL to reach it by |

**The session manager now carries the fix** (`src/core/pane.js` — see
[`lineage.md`](./lineage.md)), so all three widths are
correct at source. The sidecar's own
layer stays anyway, for two reasons:

- A host may be running a session manager older than this tree, and the repair
  costs a `peek` it would already be doing.
- It turns a silent failure into a loud one. With both layers in place
  `reconcileRcUrl()` should report `repaired: false` in normal operation, so a
  `truncated` or `missing` in the logs now means fleetwright's extraction has
  regressed — which is precisely the failure that went unnoticed the first time,
  because nothing was checking.

`src/fleet/host/pane.js` reuses `core/pane.js`'s de-wrapping rather than copying
it, and adds an explicit URL character class (de-wrapping can only ever join
*more* text onto the end, and in a TUI that is as likely to be a box border as a
path segment). `reconcileRcUrl()` then
prefers the live pane over the record and names which failure it repaired —
`missing`, `truncated` or `mismatch` — because the truncated one is the
dangerous one: it looks fine in a log.

Any reply carrying sessions gets running ones enriched, and single-session
replies hoist the URL to the top level, because §7 asks for flat JSON and one
round trip per action — the consumer is a Shortcut as often as it is an app.

## Validated against a real fleetwright — 2026-08-17

Not just against the stub. A real `fleetwright serve` on a scratch state dir, real
tmux, this box.

| | |
|---|---|
| `doctor` reports config, reachability, token, login state | ✅ |
| `health`, `list`, `peek` over the stdio transport | ✅ |
| `login` intent refused (`unknown_verb`), never reaches the hub | ✅ |
| A session named `--dangerous` refused (`bad_params`), never reaches the hub | ✅ |
| An `issuedAt` outside the freshness window refused (`stale`) | ✅ caught a real test invocation using `issuedAt: 0` |
| Hook socket → `/internal/session-start` → uuid recorded by a stock hub | ✅ `hook: demo → a1b2c3d4-…` in fleetwright's own log |
| A container posting a *different* session's name refused 403, never forwarded | ✅ |

The RC-URL repair was confirmed on real `capture-pane` output rather than a
fixture. A tmux session 70 columns wide showing the §10 banner wraps as:

```
/remote-control is active · Continue here, on your phone, or at https:
//claude.ai/code/session_016zfBs7LYmQwg7WqfD6dY3M
```

fleetwright's unguarded matcher returns `null` on that. The sidecar returns
`https://claude.ai/code/session_016zfBs7LYmQwg7WqfD6dY3M` with
`remoteControl: true`.

## Running it

```sh
export FLEETWRIGHT_COORDINATOR_URL=https://coord.example.workers.dev
export FLEETWRIGHT_HUB_URL=http://127.0.0.1:8790
export FLEETWRIGHT_HUB_TOKEN=…            # the sidecar's token the hub minted (<state dir>/sidecar-token)
export FLEETWRIGHT_LABELS=gpu,debian13

node bin/fleetwright-sidecar doctor       # check this box can drive its fleetwright
node bin/fleetwright-sidecar              # run
```

Every setting is in `src/fleet/host/config.js`. Three are worth calling out:

- **`FLEETWRIGHT_COORDINATOR_URL` is required.** §5: the agent pins the origin
  it will talk to. A transport that will talk to whoever answers is the same
  shape of mistake as accepting command strings, so the sidecar refuses to start
  without one.
- **`FLEETWRIGHT_MAX_SKEW_MS` must stay below the replay cache TTL** (10
  minutes), and the constructor throws if it does not. Otherwise there is a band
  — older than the cache, younger than the skew limit — where a replayed `start`
  passes the freshness check against a cache that has already forgotten it, and
  runs a second time. That is the exact failure the idempotency key exists to
  prevent, reintroduced by two constants drifting apart.
- **`FLEETWRIGHT_IDLE_RESTART_MINUTES` defaults to 60, and 0 turns it off.** A
  session whose pane has not changed at all for that long is stopped and
  resumed. The useful case is one that wedged overnight, where the fix is
  mechanical and nobody was awake to do it.

  The generous default is the interesting part. **The two mistakes do not cost
  the same:** a wedged session that recovers an hour later than it might have
  costs an hour, and a working session restarted mid-build loses the work. So
  the threshold errs long, a session parked at a prompt is never touched
  however long it waits — that pane is still because somebody has to answer it
  — and it gives up after two restarts that did not help rather than looping.

  **"Still" is not one fact, which is what broke this in production.** It
  shipped, and a session on a real box was stopped and resumed twice and then
  declared beyond help — because it had *finished*. A session that completed
  its work sits at the input prompt forever, and a pane at an input prompt does
  not change, so by the only measurement available "done" and "wedged" were the
  same thing. They are opposites: done is the most common state in the fleet
  and needs nothing, and restarting it puts it back at the same prompt, which
  is exactly what *"went straight back to idle"* was reporting.

  **And the first fix for that was also wrong, which is the more useful half of
  this story.** It keyed on the permission-mode name, on the stated premise that
  Claude Code draws that line when it is ready for input and not while working.
  Captured from tmux against CLI 2.1.234, the premise is false — the mode line
  is drawn in both states and only the parenthetical changes:

  ```
  ready     ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
  working   ⏵⏵ auto mode on · 1 shell · ← for agents · ↓ to manage
  ```

  So in `bypass permissions`, which is what this fleet runs by default, a
  session mid-tool-call matched "at rest": never restarted however wedged, and
  shown in the apps as "ready · idle" while it was actively working. Two
  unverified sentences about somebody else's TUI, two bugs.

  **What the pane can actually tell you** is whether the CLI is drawing at all.
  It cannot separate "working quietly" from "wedged" — a frozen process keeps
  whatever it last painted, footer included — and no regex over pane text will.
  That is a property of the measurement, not a gap in the pattern.

  So the trigger is deliberately narrow: restart only when the pane carries none
  of the CLI's chrome. Working, waiting and finished all keep theirs and are all
  left alone, and left alone is right for every one of them. **If this needs to
  fire more often the signal is process liveness** — is the container burning
  CPU, does the pane's process respond — not more clever reading of text.

  Two signals travel to the phones, because one could not answer both questions:
  the restart gate wants "is it wedged" (working and waiting are both *no*),
  while the app wants "finished or busy" (opposite answers). The app says
  **"ready · idle 3h"** only for the narrower one.

  `test/real-panes.test.js` holds captures from a real CLI and asserts the
  matchers against them, with instructions for refreshing them. Every earlier
  test here used a pane somebody invented, which is how both bugs shipped: the
  fixtures agreed with the regexes because the same person wrote both, from the
  same wrong idea of what the screen says.

  Both the restart and the giving-up are notifiable events. A fleet that
  quietly restarts things is one nobody can debug: the session's own
  conversation history will not explain a gap it did not cause.

## Transport

Two, selected by `FLEETWRIGHT_TRANSPORT`, and swapping them is a constructor
argument in `bin/fleetwright-sidecar` and nothing else — §4's "build the host
agent so transport is one swappable module".

`websocket` is what a deployed host uses: it dials the coordinator and holds the
connection open, so nothing listens on the host and there is no port to open.
The socket is Node's own `WebSocket`, opened with the two proof headers on the
upgrade and kept honest with the heartbeat frame above; the hand-rolled framing
that used to sit beside it is a test harness now, outside the package.

`stdio` speaks the same newline-delimited JSON over stdin/stdout, which makes
the whole path drivable by hand with no coordinator at all:

```sh
echo '{"v":3,"kind":"intent","id":"idem-0000001","verb":"health","issuedAt":'$(date +%s000)'}' \
  | node bin/fleetwright-sidecar
```

Replies go to **stdout**, logs to **stderr**. That split is enforced: an `info`
line landing on stdout would not be noise, it would be a corrupted message.

## Identity

This box has a **keypair**, not a token. The private half lives at
`/var/lib/fleetwright-sidecar/host-key.json` — 0600, in a directory systemd creates
0700 for this service's own account, `fleetwright-sidecar`, which is not the
user the sessions run as — and is generated the first time anything needs it,
not only by `run`. Connecting means asking the coordinator for a nonce and signing
it:

```
POST /api/host/challenge   {hostId}            -> {nonce}
GET  /host/connect?hostId=…  x-fleet-nonce: <the nonce>  x-fleet-proof: <signature over it>
```

Both headers travel back, not just the proof: a nonce is `<issuedAt>.<random>.<HMAC>`
and nothing is stored server-side, so the coordinator keeps no record of what
it issued and needs the nonce back to check the signature against it.

Nothing reusable crosses the wire. A captured connection yields a signature
over a value that will never be accepted again.

**Liveness is a heartbeat frame, not a protocol ping.** A dead TCP connection
behind a NAT looks exactly like an idle healthy one until somebody writes to
it, so every twenty seconds the sidecar sends `{"kind":"ping"}` and expects
`{"kind":"pong"}`; any frame at all counts as proof of life, and only total
silence past the grace period drops the socket for a reconnect. It is a text
frame rather than the WebSocket control frame it used to be because Node's own
`WebSocket` cannot send a ping, and carrying four hundred lines of hand-rolled
framing for one control frame was the wrong trade. On Cloudflare the Durable
Object answers it with `setWebSocketAutoResponse`, so a heartbeat never wakes
the object — the same cost the protocol ping had, which was none. The two
strings live once, in `src/fleet/protocol/heartbeat.js`, because that match is
on bytes.

**A challenge, not a self-issued JWT** — which is a deliberate departure from
design.md §5, and the cheaper of the two. A JWT the host signs for itself is
replayable for as long as it is valid, so its window has to be short; and a
short window means the two clocks have to agree, on boxes that may have been
asleep. A nonce the coordinator issued is replayable for exactly zero seconds
and needs no clock at all. The cost is one extra round trip per connection,
which happens on the order of minutes at worst.

Joining, once:

```sh
fleetwright-sidecar enrol 123456     # a pin from the app, or /enroll in Telegram
fleetwright-sidecar identity         # host id, key fingerprint, coordinator
fleetwright-sidecar doctor           # ...and whether the coordinator accepts it
```

`doctor` asks the coordinator rather than reading the file, because a key that
was never presented and one that has since been revoked look identical on disk.

Do not copy the key file to another machine. Two boxes with one identity is the
problem this replaced — the whole point is that they are distinguishable and
revocable one at a time.

## Still to build

- **Verifying the rootless mapping.** The fleet deploys rootless podman
  ([`hardening.md`](./hardening.md)); what is unverified is the property it is
  deployed for — that uid 0 in a container maps to the unprivileged service
  user on the host, so an escape lands as nobody. `security.md` SEC-SESSION-5
  is the honest statement, and nothing yet asserts it.
- **Wake-on-LAN.** §3's second meaning of "wake" — a box that is asleep cannot
  be a host, and nothing sends the magic packet yet.
