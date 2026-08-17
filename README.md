# agent-fleet

A multi-host control plane for Claude Code sessions: ephemeral root-capable
sandboxes, session wake, and a phone that can reach any of it from a cold radio.

Host-side changes are contributed back to
[`agent-hub`](https://github.com/ambersecurityinc/agent-hub) as PRs — this repo
never forks it. What lives here is the coordinator (Cloudflare Worker + Durable
Objects), the scheduler, the mobile API, the container image, and the iOS and
Android apps.

`docs/design.md` is the complete design and the record of what has been
validated on hardware. Start there.

## Where things are

| | |
|---|---|
| `docs/design.md` | the design, and §10's hardware validation log |
| `docs/intents.md` | the coordinator↔host wire protocol |
| `docs/hook-socket.md` | the per-session hook transport, and what proving it turned up |
| `src/protocol/` | the coordinator side of the intent protocol |
| `src/host/` | host-side pieces staged for upstreaming into agent-hub |

## Running the tests

No runtime dependencies, no build step — the same posture as agent-hub. The only
install is the TypeScript devDependency used to check the JSDoc annotations.

```sh
npm install
npm test        # node --test
npm run typecheck
```

## The two things worth knowing before reading the code

**The coordinator sends intents, never commands.** A fixed verb set, an
idempotency key on every mutating one, and no way to express a path or a login.
The failure that shapes it is not a bug in the coordinator but the coordinator
being compromised while it drives root-capable boxes: with a verb set the blast
radius is "someone started and stopped some sessions", with command strings it
is every box in the fleet. See `docs/intents.md`.

**The coordinator's registry is a cache with provenance, never the authority.**
Each host stays the sole authority on its own tmux. Multi-host reintroduces the
two-plane split agent-hub was extracted specifically to remove; treating the
Durable Object's view as truth rebuilds the exact failure already paid for.
`unknown` is a state with a reason attached, never a default that reads as
healthy.
