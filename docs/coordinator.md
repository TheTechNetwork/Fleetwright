# The coordinator

Where the fleet meets. Hosts dial **in** and hold the socket open; clients — a
phone, a Shortcut, curl — speak ordinary HTTP to the same origin.

```
host  ──ws──▶  /host/connect     persistent, the host dials out
phone ──http─▶ /api/intent       one round trip, flat JSON
```

Both on one port, because a host pins exactly one origin and adding a second
would mean pinning two.

It runs as a Cloudflare Worker — `worker/`, deployed per
[`coordinator-deploy.md`](./coordinator-deploy.md) — and nowhere else. The one
alternative kept open is that same Worker under `workerd` in a container, for
whoever will not have a Cloudflare account; it is a roadmap row rather than an
install-guide sentence until it has been run for a week
([`auth-and-join.md`](./auth-and-join.md)).

## There used to be two of it, and they were one design

§4 chose Cloudflare Workers + Durable Objects for the phone leg, and that is
what production has always run. For a long time the same design also ran as a
plain Node process — `src/fleet/coordinator/server.js` — so the whole loop
could be driven on one box with a breakpoint in it: `registry.js`,
`scheduler.js`, `core.js` and the intent plumbing carry all the decisions and
touch nothing runtime-specific, so the two were a transport swap rather than
two implementations, held to one contract by `openapi.json` executed as
`test/openapi.test.js` for the phone leg and by `worker/test/parity.test.js`
for the host socket leg.

That second implementation stopped being part of the package in
[`auth-and-join.md`](./auth-and-join.md): a release never shipped it, the
installer no longer offers it, and what is left of `server.js` is a test
harness until the tests that use it drive the Worker directly. The parity
tests stay, as conformance tests of the one that remains.

The WebSocket framing in `src/fleet/ws.js` was hand-rolled for the Node
coordinator's accept side and for the sidecar's dial. The accept side leaves
with the Node coordinator; the dial is Node's own `WebSocket` from 22 on.

## The rule it must not break

**The registry is a cache with provenance, never the authority.** Each host
stays the sole authority on its own tmux.

fleetwright's whole simplification was collapsing a two-plane design — a queue,
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
| `GET /healthz` | liveness only — the one unauthenticated surface on the *intent* path. The Worker also serves `/docs`, `/install`, `/prereq`, sign-in and the OAuth callback without a fleet credential, each 404 or 503 until its variable is set — see [`coordinator-deploy.md`](./coordinator-deploy.md) and `openapi.json` for the full surface |

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

## Both halves this section used to wait on are done

Cloudflare deployment is production ([`coordinator-deploy.md`](./coordinator-deploy.md)),
and host → coordinator **events** shipped: the watcher raises
`session.awaiting-input` / `session.ended` / `session.error`, the sidecar sends
them over the socket it already holds, and the coordinator pushes the
`NOTIFIABLE` ones to registered devices — §3's third meaning of "wake". What
that has been *proven* to do on a phone is
[`app-parity.md`](./app-parity.md#what-is-actually-proven-about-the-apps)'s
table to say, not this page's.
