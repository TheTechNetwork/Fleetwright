# agent-fleet

A multi-host control plane for Claude Code sessions: ephemeral root-capable
sandboxes, session wake, and a phone that can reach any of it from a cold radio.

It drives [`agent-hub`](https://github.com/ambersecurityinc/agent-hub) rather
than forking or modifying it. On each host a **sidecar** dials the coordinator
and speaks to a stock agent-hub over its loopback HTTP API — so a host can run
whatever agent-hub it was already running, and nothing here waits on a PR
landing upstream.

Everything else lives here too: the coordinator (Cloudflare Worker + Durable
Objects), the scheduler, the mobile API, the container image, and the iOS and
Android apps.

`docs/design.md` is the complete design and the record of what has been
validated on hardware. Start there.

## Where things are

| | |
|---|---|
| `docs/design.md` | the design, and §10's hardware validation log |
| `docs/sidecar.md` | the host process, what it fixes, and what agent-hub's API imposes on it |
| `docs/intents.md` | the coordinator↔host wire protocol |
| `docs/hook-socket.md` | the per-session hook transport, and what proving it turned up |
| `src/protocol/` | the intent protocol — built by the coordinator, enforced by the sidecar |
| `src/host/` | the sidecar: hub client, pane parsing, hook sockets, transports |
| `bin/agent-fleet-sidecar` | the host entrypoint (`doctor` checks a box before you trust it) |

## Running the tests

No runtime dependencies, no build step — the same posture as agent-hub. The only
install is the TypeScript devDependency used to check the JSDoc annotations.

```sh
npm install
npm test        # node --test
npm run typecheck
```

## The three things worth knowing before reading the code

**The coordinator sends intents, never commands.** A fixed verb set, an
idempotency key on every mutating one, and no way to express a path or a login.
The failure that shapes it is not a bug in the coordinator but the coordinator
being compromised while it drives root-capable boxes: with a verb set the blast
radius is "someone started and stopped some sessions", with command strings it
is every box in the fleet. See `docs/intents.md`.

**The sidecar's allowlist is not defence in depth — it is the defence.**
agent-hub's `POST /api/command` runs any command line it is handed, `/login`
included, and the sidecar is the only thing holding its token. So the command
line is assembled from literals and charset-checked values, never received.
See `docs/sidecar.md`.

**The coordinator's registry is a cache with provenance, never the authority.**
Each host stays the sole authority on its own tmux. Multi-host reintroduces the
two-plane split agent-hub was extracted specifically to remove; treating the
Durable Object's view as truth rebuilds the exact failure already paid for.
`unknown` is a state with a reason attached, never a default that reads as
healthy.
