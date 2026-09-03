# agent-fleet

A self-hosted Claude Code session manager, and the multi-host control plane
around it: ephemeral root-capable sandboxes, session wake, and a phone that can
reach any of it from a cold radio.

> **On the two names.** The repository and the phone app are called
> **Fleetwright**; the software inside it is `agent-fleet` — the package, the
> binaries (`agent-fleet-sidecar`, `agent-fleet-coordinator`), the systemd
> units, the `AGENT_FLEET_*` environment variables and `/opt/agent-fleet`.
> That is deliberate, not drift. Those names are load-bearing on machines that
> are already running: renaming them would mean reinstalling every host and
> re-entering every secret. The App Store needed a unique name, so it got one.
> See [docs/naming.md](docs/naming.md).

**New box?** [docs/first-session.md](docs/first-session.md) is ten steps from
clone to a running session, with no digressions. The essays are linked at the
bottom of it.

## Get the app

> **What is proven, and what is not:**
> [docs/app-parity.md](docs/app-parity.md#what-is-actually-proven-about-the-apps)
> is the single table. Push is confirmed on both platforms as of 3 Sep 2026.

| | |
|---|---|
| **iPhone / iPad** | [TestFlight beta](https://testflight.apple.com/join/FyQnP8T9) — install Apple's TestFlight app first, and open the link on the device itself |
| **Android** | [Google Play](https://play.google.com/store/apps/details?id=network.thetech.fleetwright) |

Neither is any use on its own: the app is a client for a coordinator, and it
asks for one on first launch. **It holds no credential of yours** — you sign in
as yourself with Apple or Google, and the fleet recognises the address. See
[docs/accounts.md](docs/accounts.md).

These same two links are what an invitation email carries, set as
`AGENT_FLEET_APP_IOS` and `AGENT_FLEET_APP_ANDROID`.

One project, two processes:

```
coordinator ──ws──▶ sidecar ──http──▶ session manager ──▶ tmux ──▶ claude
                  (src/fleet/)      (src/core, src/adapters)
```

The **session manager** is `agent-hub` — start, resume and stop tmux-backed
Claude Code sessions from Telegram, a web UI or a CLI. It came from
[`ambersecurityinc/agent-hub`](https://github.com/ambersecurityinc/agent-hub),
sits at its upstream paths, and is code we intend to contribute back to. See
[`docs/upstream-agent-hub.md`](./docs/upstream-agent-hub.md).

The **fleet** is everything that makes a group of those boxes one system:
the sidecar that speaks to a coordinator, the intent protocol between them, and
the per-session sandbox plumbing.

**Setting up a box:** [`docs/deployment.md`](./docs/deployment.md) — one
installer, what it asks, what is deployable today and what is not.

```sh
curl -fsSL https://fleet.thetech.network/prereq  | sudo sh   # once, if node is old
curl -fsSL https://fleet.thetech.network/install | sudo sh
```

The first line is separate on purpose, and is a no-op if this box already has
Node 24. It is the one thing the installer will not do on your behalf: closing
the gap between what Debian ships and what this needs means changing how the
machine gets software, which is a different kind of act from installing a
package. The installer refuses *before it changes anything* and points at it,
so a box is never taken apart and then turned away.

It uses **nvm**, into the run user's home — no apt repository, no signing key,
nothing system-wide, and `rm -rf ~/.nvm` undoes it. The units bake an absolute
node path, so nothing needs to be on `PATH` and no shell profile is touched.
The cost is that nothing patches it afterwards: re-run that line to move to a
newer Node.

**Curling a coordinator is how you join it.** That URL is a fleet's address, and
`/install` serves a script that carries it through — so the installer never asks
which fleet, because you already said. It installs what is missing, asks for the
six-digit pin you mint in the app, enrols the box and starts the services.

The pin is the only thing it asks for. Nothing else is needed to join a fleet,
and the questions that were in the way — Telegram, whether to run a coordinator
here — are for somebody setting one up rather than joining one, so they are
asked only when there is no fleet in the URL.

Already installed and joined? `install.sh --upgrade` brings a box onto new code
with no questions at all, restarts the services, and tells you whether its
protocol still matches the coordinator's — which is the one thing that silently
takes a fleet down.

The one-liner fetches the repository to `/opt/agent-fleet` and runs the
installer from there, so the clone is still what ends up on the box and
`git -C /opt/agent-fleet log` still answers "what is this running". To do those
two steps yourself, or to see what the prerequisites are first:

```sh
git clone https://github.com/TheTechNetwork/Fleetwright /opt/agent-fleet
sudo /opt/agent-fleet/install/install.sh --check    # changes nothing
sudo /opt/agent-fleet/install/install.sh
```

[`docs/design.md`](./docs/design.md) is the complete design and the record of
what has been validated on hardware. Start there for the why.
[`docs/wanted.md`](./docs/wanted.md) is what is not built yet, and what makes
each of those hard. [`docs/psychology.md`](./docs/psychology.md) is why the interfaces are shaped
the way they are — interruption cost, what may be decided from a lock screen,
and why "nothing needs you" is the most important state in the system.
[`docs/plan.md`](./docs/plan.md) is the sequenced plan that
came out of reviewing all of it, including the argument that the obvious next
step — letting the app type a reply into a session — is the one thing that must
never be built.

## Layout

| | |
|---|---|
| `src/core/`, `src/adapters/`, `src/index.js` | the session manager — at upstream paths, on purpose |
| `src/fleet/protocol/` | the intent protocol: built by the coordinator, enforced by the sidecar |
| `src/fleet/host/` | the sidecar: hub client, pane parsing, hook sockets, transports |
| `src/fleet/coordinator/` | the coordinator: host registry, scheduler, HTTP + WebSocket |
| `src/fleet/ws.js` | a hand-rolled RFC 6455 WebSocket, because zero dependencies |
| `sandbox/` | the container image a sandboxed session runs in |
| `bin/agent-hub` | the session manager's CLI and SessionStart hook |
| `bin/agent-fleet-sidecar` | the fleet host process (`doctor` checks a box before you trust it) |
| `bin/agent-fleet-coordinator` | the coordinator |
| `install/` | one installer for all of it, plus the systemd unit |
| `.github/workflows/` | CI: tests, the iOS build, the Android APK, the Worker deploy — see [`docs/ci.md`](./docs/ci.md) |
| `apps/` | [Android](./apps/android/README.md) and [iOS](./apps/ios/README.md) clients — [testing handoff](./docs/app-testing.md) |
| `worker/` | the coordinator on Cloudflare — see [`docs/coordinator-deploy.md`](./docs/coordinator-deploy.md) |
| `docs/` | [deployment](./docs/deployment.md), [coordinator on Cloudflare](./docs/coordinator-deploy.md), [ci](./docs/ci.md), [push](./docs/push.md), [design](./docs/design.md), [protocol](./docs/intents.md), [sidecar](./docs/sidecar.md), [coordinator](./docs/coordinator.md), [hook socket](./docs/hook-socket.md), [session manager manual](./docs/agent-hub.md), [naming](./docs/naming.md), [upstream lineage](./docs/upstream-agent-hub.md) |

Still to come: rootless podman (the sandbox has only run as root), Wake-on-LAN,
and Telegram on the Worker.
The apps and the Cloudflare deployment exist — see
[`docs/deployment.md`](./docs/deployment.md) for what is proven and what is
merely built.

## Running things

One runtime dependency — `jose`, for verifying the ID tokens sign-in relies on
— and no build step. `npm install` also pulls in the TypeScript devDependency
used to check the JSDoc annotations.

```sh
npm install
# The Worker has its own dependencies, and the tests import it — three test
# files assert the two coordinators agree, so they load worker/src/worker.js.
# Skipping this gets you three failures that look like a broken clone.
npm install --prefix worker
npm test
npm run typecheck

npm start                          # the session manager
npm run sidecar -- doctor          # check this box can drive it
node bin/agent-fleet-coordinator   # the coordinator
```

`mise` pins the dev environment and carries the tasks that need more than node —
`mise trust && mise install`, then `mise run android-sdk`, `apk`, `keystore`,
`worker-deploy`. Deployment deliberately does not use it: a service must not
depend on a version manager in somebody's home directory.

To deploy rather than hack on it, see [`docs/deployment.md`](./docs/deployment.md) —
`sudo ./install/install.sh` sets up the session manager as a systemd service.

## The three things worth knowing before reading the code

**The coordinator sends intents, never commands.** A fixed verb set, an
idempotency key on every mutating one, and no way to express a path or a login.
The failure that shapes it is not a bug in the coordinator but the coordinator
being compromised while it drives root-capable boxes: with a verb set the blast
radius is "someone started and stopped some sessions", with command strings it
is every box in the fleet. See [`docs/intents.md`](./docs/intents.md).

**The sidecar's allowlist is not defence in depth — it is the defence.**
`POST /api/command` runs any command line it is handed, `/login` included, and
the sidecar is the only thing holding the token. So the command line is
assembled from literals and charset-checked values, never received. See
[`docs/sidecar.md`](./docs/sidecar.md).

**The coordinator's registry is a cache with provenance, never the authority.**
Each host stays the sole authority on its own tmux. Multi-host reintroduces the
two-plane split the session manager was extracted specifically to remove;
treating the Durable Object's view as truth rebuilds the exact failure already
paid for. `unknown` is a state with a reason attached, never a default that
reads as healthy.

## Licence

MIT. The session manager portions listed in
[`docs/upstream-agent-hub.md`](./docs/upstream-agent-hub.md) are MIT © Amber
Security Inc — see [`LICENSE-agent-hub`](./LICENSE-agent-hub); everything else is
[`LICENSE`](./LICENSE).
