# The host sidecar

What runs on a fleet host. It dials the coordinator, validates every intent that
arrives against the verb allowlist, and drives a **stock agent-hub** through its
loopback HTTP API.

```
coordinator ──ws──▶ sidecar ──http──▶ 127.0.0.1:8790 (agent-hub) ──▶ tmux ──▶ claude
                      │
                      └── validates · translates · repairs
```

agent-hub is not modified, not forked, and not aware of any of this. From its
side the sidecar is one more HTTP client holding its token — the same interface
its own CLI uses.

## Why out-of-process

The alternative was `src/adapters/fleet.js` inside agent-hub, which §6 of
`design.md` proposes and which is a genuinely clean fit for its adapter seam.
The sidecar wins on one thing that outweighs the rest: **it works against an
agent-hub you have not changed.** No PR has to land, no version has to match, and
a host can be running whatever agent-hub it was already running. Upstreaming
becomes a separate, unblocking conversation instead of a dependency.

The cost is one round trip of latency per action on loopback, which is nothing
next to the ~20s a session start spends waiting for Remote Control anyway.

## What it enforces

**The coordinator sends intents, never commands.** A fixed verb set, an
idempotency key on every mutating one, no way to express a path or a login. The
full contract is in [`intents.md`](./intents.md).

Running out-of-process *sharpens* that rather than softening it, and this is the
single most important thing to understand about the sidecar:

> `POST /api/command` will run **any** command line it is handed, `/login`
> included, and the sidecar is the only thing holding agent-hub's token.

So the verb allowlist here is not defence in depth — it is the defence. That is
why `toCommandLine()` assembles the line from literals in its own source plus
values already charset-checked, and why nothing from the wire is ever
concatenated into it.

## The three things agent-hub's API imposes

Each shows up as a deliberate compromise, and each is worth knowing before
reading the code.

### 1. `createdBy` cannot reflect who asked — and this is a real regression

agent-hub hardcodes `actor: 'web'` for every HTTP caller (`http.js:142`). Every
token holder is anonymous and indistinguishable to it, so a session the fleet
starts is recorded as started by "web", not by `telegram:12345`.

The sidecar knows the real actor and puts it in its own logs and replies. It
**cannot** make agent-hub record it. This is exactly the flat-allowlist gap
`design.md` §1 lists, and it is not fixable from out here — only upstream, or in
the coordinator, which is where §5 argues per-session ownership belongs anyway
(one chokepoint instead of N hosts).

An in-process adapter would not have this problem. It is the price of the
no-modifications property, stated plainly rather than discovered later.

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

The sidecar runs on that same box, so it can forward hook reports there. That is
what lets the **per-session hook socket** ([`hook-socket.md`](./hook-socket.md))
work against an unmodified agent-hub: the sidecar owns the socket, so it knows
which session a report came from, and supplies the name the container was never
given. The container posts `{uuid, cwd}` to `/run/hub.sock` and can name nothing.

## What it fixes

The sidecar re-derives Remote Control URLs from the pane itself rather than
trusting the ones agent-hub recorded.

agent-hub's `extractRcUrl` matches the raw `capture-pane` output with no
de-wrapping — unlike its own login flow, which has `dewrapPane` for exactly this
failure. A pane is a fixed-width grid, and the RC URL is one long token.
Measured against the verbatim CLI 2.1.233 capture in `design.md` §10:

| pane width | agent-hub records |
|---|---|
| 80 | correct — which is why this was never noticed |
| 100 | `https://claude.ai/code/session_016zf` — truncated, well-formed, and dead |
| 70 | **`null`** — the `https://` prefix straddles the break, so the session is reported online with no URL to reach it by |

`src/host/pane.js` ports the de-wrapping and adds an explicit URL character
class (de-wrapping can only ever join *more* text onto the end, and in a TUI
that is as likely to be a box border as a path segment). `reconcileRcUrl()` then
prefers the live pane over the record and names which failure it repaired —
`missing`, `truncated` or `mismatch` — because the truncated one is the
dangerous one: it looks fine in a log.

Any reply carrying sessions gets running ones enriched, and single-session
replies hoist the URL to the top level, because §7 asks for flat JSON and one
round trip per action — the consumer is a Shortcut as often as it is an app.

## Validated against a real agent-hub — 2026-08-17

Not just against the stub. A real `agent-hub serve` on a scratch state dir, real
tmux, this box.

| | |
|---|---|
| `doctor` reports config, reachability, token, login state | ✅ |
| `health`, `list`, `peek` over the stdio transport | ✅ |
| `login` intent refused (`unknown_verb`), never reaches the hub | ✅ |
| A session named `--dangerous` refused (`bad_params`), never reaches the hub | ✅ |
| An `issuedAt` outside the freshness window refused (`stale`) | ✅ caught a real test invocation using `issuedAt: 0` |
| Hook socket → `/internal/session-start` → uuid recorded by a stock hub | ✅ `hook: demo → a1b2c3d4-…` in agent-hub's own log |
| A container posting a *different* session's name refused 403, never forwarded | ✅ |

The RC-URL repair was confirmed on real `capture-pane` output rather than a
fixture. A tmux session 70 columns wide showing the §10 banner wraps as:

```
/remote-control is active · Continue here, on your phone, or at https:
//claude.ai/code/session_016zfBs7LYmQwg7WqfD6dY3M
```

agent-hub's unguarded matcher returns `null` on that. The sidecar returns
`https://claude.ai/code/session_016zfBs7LYmQwg7WqfD6dY3M` with
`remoteControl: true`.

## Running it

```sh
export AGENT_FLEET_COORDINATOR_URL=https://coord.example.workers.dev
export AGENT_FLEET_HUB_URL=http://127.0.0.1:8790
export AGENT_FLEET_HUB_TOKEN=…            # agent-hub's AGENT_HUB_TOKEN, if it has one
export AGENT_FLEET_LABELS=gpu,debian13

node bin/agent-fleet-sidecar doctor       # check this box can drive its agent-hub
node bin/agent-fleet-sidecar              # run
```

Every setting is in `src/host/config.js`. Two are worth calling out:

- **`AGENT_FLEET_COORDINATOR_URL` is required.** §5: the agent pins the origin
  it will talk to. A transport that will talk to whoever answers is the same
  shape of mistake as accepting command strings, so the sidecar refuses to start
  without one.
- **`AGENT_FLEET_MAX_SKEW_MS` must stay below the replay cache TTL** (10
  minutes), and the constructor throws if it does not. Otherwise there is a band
  — older than the cache, younger than the skew limit — where a replayed `start`
  passes the freshness check against a cache that has already forgotten it, and
  runs a second time. That is the exact failure the idempotency key exists to
  prevent, reintroduced by two constants drifting apart.

## Transport

`stdio` is the only one implemented, because the coordinator does not exist yet.
It speaks newline-delimited JSON, which makes the whole path drivable by hand:

```sh
echo '{"v":1,"kind":"intent","id":"idem-0000001","verb":"health","issuedAt":'$(date +%s000)'}' \
  | node bin/agent-fleet-sidecar
```

It is also the shape the WebSocket transport will have — dial, hand messages to
a handler, send replies, stop. Swapping one for the other is a constructor
argument in `bin/agent-fleet-sidecar` and nothing else, which is §4's "build the
host agent so transport is one swappable module".

## Still to build

- The WebSocket transport, once there is a coordinator to dial.
- Host → coordinator **events** — a session hit a prompt, finished, errored
  (§3's third meaning of "wake"). The sidecar can already see this by polling
  `peek`, but nothing pushes it yet.
- The sandbox launch path, which is what will call `HookSocketServer.open()` and
  `close()` around a `podman run`.
