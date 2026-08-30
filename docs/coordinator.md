# The coordinator

Where the fleet meets. Hosts dial **in** and hold the socket open; clients — a
phone, a Shortcut, curl — speak ordinary HTTP to the same origin.

```
host  ──ws──▶  /host/connect     persistent, the host dials out
phone ──http─▶ /api/intent       one round trip, flat JSON
```

Both on one port, because a host pins exactly one origin and adding a second
would mean pinning two.

```sh
set -a; . /etc/agent-fleet-coordinator.env; set +a
agent-fleet-coordinator
```

## It runs as a plain Node process, for now

§4 chose Cloudflare Workers + Durable Objects for the phone leg, and that is
still the plan. This is the same design running somewhere you can put a
breakpoint in: `registry.js`, `scheduler.js` and the intent plumbing carry all
the decisions and touch nothing runtime-specific, so the Worker version is a
transport swap rather than a rewrite.

The WebSocket is hand-rolled (`src/fleet/ws.js`) because this project has zero
runtime dependencies, and a dependency on the one code path every host holds
open permanently is a poor trade for ~200 lines of well-specified framing.

## The rule it must not break

**The registry is a cache with provenance, never the authority.** Each host
stays the sole authority on its own tmux.

agent-hub's whole simplification was collapsing a two-plane design — a queue,
a heartbeat protocol, a stale-row reaper — into one process that asks tmux
directly, every time. Multi-host reintroduces that split unavoidably. What is
avoidable is *believing* the cache. So:

- every fact carries when it was learned and from whom;
- a host we have not heard from is `unknown` **with a reason**, never `healthy`
  by omission;
- a host whose own session manager is unreachable is `degraded`, not healthy —
  its socket being fine says nothing about whether it can start anything;
- capacity from an unreachable host is `null`, never `0`. A scheduler seeing 0
  quietly skips a host; one seeing null can say why.

`GET /api/hosts` always shows the state and the reason together.

## Scheduling

In order (§3):

1. **Resume is pinned.** `claude-<name>` is a host-local volume, so anything
   naming an existing session goes to the box holding it. If no host reports
   that session, the intent is **refused** — never redirected. Redirecting would
   start an empty conversation under a name someone believes is their
   long-running one.
2. **New work is filtered, then ranked.** Round robin is the wrong default:
   hosts differ in capacity and sessions differ wildly in weight. Labels filter
   (a constraint, not a preference), free capacity ranks, load breaks ties, and
   round robin breaks what is left.

A placement claim older than two minutes is refused as `stale_placement` rather
than acted on. Knowing where a session *was* is not knowing where it *is*.

## The API

| | |
|---|---|
| `POST /api/intent` | `{verb, params, actor?, id?}` — the full surface |
| `GET /api/<verb>/<name>` | Shortcut-friendly shorthand, one round trip |
| `GET /api/hosts` | the fleet, with state and reason per host |
| `GET /healthz` | liveness only — the one deliberately unauthenticated surface |

An `id` you supply is honoured as an idempotency key, so a phone that retries a
`start` gets the original outcome rather than a second session. One the
coordinator mints is unique per call, which is right for a first attempt and
useless for a retry — that is the caller's to own.

## What it cannot do

It sends intents, never commands, and it cannot express a shell string even to
itself: `place()` routes verbs, and the host validates the verb set again on
arrival. A compromised coordinator is bounded by the VERB SET — which since v2
includes credential writes, so the old "it can start and stop sessions" line
here understated it; see [security.md](./security.md) §4.1. It still cannot run
anything. That is the whole point of §5, and it is why the verb set is small and
boring.

## Not done yet

Deploying to Cloudflare; host → coordinator **events**, so a session that hits a prompt or finishes can
push rather than be polled — §3's third meaning of "wake", and the one that
makes the phone app worth having.
