# agent-fleet

A multi-host control plane for Claude Code sessions: ephemeral root-capable
sandboxes, session wake, and a phone that can reach any of it from a cold radio.

One monorepo. It contains both the fleet control plane and
[`agent-hub`](https://github.com/ambersecurityinc/agent-hub), the session manager
that actually drives tmux on each host.

On each host a **sidecar** dials the coordinator and speaks to agent-hub over
its loopback HTTP API. They stay separate processes on purpose even though they
now live in one repo: agent-hub is upstream code we intend to contribute back
to, and keeping fleet concerns out of that tree is what keeps that possible.
See [`agent-hub/UPSTREAM.md`](./agent-hub/UPSTREAM.md).

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
| `agent-hub/` | vendored upstream session manager — see `agent-hub/UPSTREAM.md` |

Still to come: the coordinator (Cloudflare Worker + Durable Objects), the
scheduler, the mobile API, the container image, and the iOS and Android apps.

## Running things

No runtime dependencies and no build step in either package — the only install
is the TypeScript devDependency used to check the JSDoc annotations, and Node
resolves it up the tree for both.

```sh
npm install
npm test              # both packages
npm run test:fleet    # or one at a time
npm run test:hub
npm run typecheck

npm run hub           # agent-hub itself
npm run sidecar -- doctor
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
