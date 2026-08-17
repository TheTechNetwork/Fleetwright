# Deployment

How to stand this up on a real box, and — just as important — what is not
standable-up yet.

## What is deployable today

| | status |
|---|---|
| **Session manager** (`agent-hub`) — sessions from Telegram, web UI, CLI | ✅ full installer, systemd unit, hook |
| **Sidecar** — validates intents, drives the session manager | ⚠️ runnable and configurable, but **no long-running service yet** — see [below](#why-there-is-no-sidecar-systemd-unit) |
| **Coordinator** (Worker + Durable Objects) | ❌ not built |
| **Sandboxes** (rootless podman, container image) | ❌ not built — §2 of `design.md` is validated, not implemented |
| **Mobile / Shortcuts** | ❌ not built |

So a box you set up today is a working single-host agent-hub, plus a sidecar you
can exercise by hand. It is not yet part of a fleet, because there is nothing to
be a fleet with.

## Prerequisites

- **Node 18 or newer** — global `fetch` is required.
- **tmux** — `apt install tmux`. Not optional; it is what holds the sessions.
- **claude** — the Claude Code CLI, on `PATH`, logged in (or log it in later
  from chat with `/login`).
- **A Linux host.** §9 of `design.md` explains why validating any of the sandbox
  work on macOS proves less than it looks like it does.

`podman` is only needed once the sandbox work exists.

## 1. Install the session manager

```sh
git clone https://github.com/TheTechNetwork/agent-fleet /opt/agent-fleet
sudo /opt/agent-fleet/install/install.sh
```

The installer checks prerequisites, creates `/etc/agent-hub.env`, installs the
systemd unit, registers the Claude Code **SessionStart hook**, and links the
`agent-hub` CLI. It is idempotent — re-run it after `git pull` and it will never
overwrite your config.

> This installer comes from upstream agent-hub unmodified, so it still speaks in
> terms of "agent-hub" throughout. It works unchanged from this repo's root —
> it derives its own directory — but it does not know about the sidecar.

Then:

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → put the token in
   `AGENT_HUB_TELEGRAM_TOKEN` in `/etc/agent-hub.env`.
2. `systemctl enable --now agent-hub`
3. Message your bot **`/whoami`** — it answers with your Telegram id even before
   you are on the allowlist. Put that id in
   `AGENT_HUB_TELEGRAM_ALLOWED_USERS`, then `systemctl restart agent-hub`.
4. `agent-hub doctor` — confirms tmux, claude, login state and reachability.

Not logged into Claude yet? Send the bot **`/login`** and follow the link.

`docs/agent-hub.md` is the full session-manager manual: commands, permission
modes, resume behaviour, exposing the web UI.

### The one thing not to change in the unit

`KillMode=process` in `install/agent-hub.service` is load-bearing. The tmux
server that holds every session is started by that service, so it lands in the
unit's cgroup. With the default `KillMode=control-group` a plain
`systemctl restart agent-hub` reaps the whole cgroup — including tmux — and
takes down every live session at once. That is not hypothetical; it is why the
comment is there.

## 2. Configure the sidecar

```sh
sudo install -m 0600 /opt/agent-fleet/install/agent-fleet-sidecar.env.example \
                     /etc/agent-fleet-sidecar.env
sudoedit /etc/agent-fleet-sidecar.env
```

Two lines usually need changing:

- `AGENT_FLEET_COORDINATOR_URL` — **required**. The sidecar refuses to start
  without a pinned origin (§5: the agent pins the coordinator it will talk to).
  With no coordinator yet, use `stdio:local`.
- `AGENT_FLEET_HUB_TOKEN` — must match `AGENT_HUB_TOKEN` in
  `/etc/agent-hub.env`. Leave empty if the hub is loopback-bound with no token,
  which is its default.

The installer links `agent-hub` into `/usr/local/bin` but knows nothing about
the sidecar, so link that yourself if you want it on `PATH`:

```sh
sudo ln -sf /opt/agent-fleet/bin/agent-fleet-sidecar /usr/local/bin/agent-fleet-sidecar
```

Check it:

```sh
set -a; . /etc/agent-fleet-sidecar.env; set +a
agent-fleet-sidecar doctor
```

```
 ok   configuration
 ok   agent-hub reachable at http://127.0.0.1:8790
 ok   agent-hub accepts the token  — 0/5 running on unabandoned
 ok   claude is logged in on the hub  — you@example.com (max)
 ok   host id unabandoned  — labels: gpu, debian13
```

Drive it by hand over the stdio transport:

```sh
echo '{"v":1,"kind":"intent","id":"idem-0000001","verb":"health","issuedAt":'$(date +%s000)'}' \
  | agent-fleet-sidecar
```

Replies come back on **stdout** as newline-delimited JSON; logs go to
**stderr**. That split is deliberate and enforced — an `info` line landing on
stdout would not be noise, it would be a corrupted message.

### Why there is no sidecar systemd unit

Deliberately omitted rather than forgotten. The only transport implemented is
stdio, which ends when its stdin does. A `Type=simple` unit with no stdin would
exit immediately, `Restart=always` would restart it, and you would have a
crash-loop that looks like a bug in the sidecar.

The unit lands with the WebSocket transport, when there is a connection to hold
open and something to hold it open to.

### Hook socket directory

When `AGENT_FLEET_HOOK_SOCKETS=1`, the sidecar serves one unix socket per
sandboxed session under `AGENT_FLEET_HOOK_SOCKET_DIR` (default
`/run/agent-fleet`). It creates the directory `0700` on demand and each socket
`0600` — see [`hook-socket.md`](./hook-socket.md) for why both layers matter.

`/run` is tmpfs, so the directory does not survive a reboot and does not need
cleaning up. A sidecar running as **root** creates it itself. A sidecar running
as an unprivileged user cannot create a directory in `/run`, so when the unit
arrives it will want:

```ini
RuntimeDirectory=agent-fleet
RuntimeDirectoryMode=0700
```

which makes systemd create and own it. Until then, either run the sidecar as
root or pre-create the directory with the right owner.

Nothing calls `HookSocketServer.open()` yet — that happens in the sandbox launch
path, which is not built. The sockets are proven (19 tests, plus an end-to-end
run against a real hub) and idle.

## 3. Verify the whole path

```sh
agent-hub doctor                      # can this box run sessions at all
agent-fleet-sidecar doctor            # can the sidecar drive it
agent-hub list                        # the session manager answers
systemctl status agent-hub
journalctl -u agent-hub -f
```

## Upgrading

```sh
git -C /opt/agent-fleet pull
sudo /opt/agent-fleet/install/install.sh   # idempotent; never overwrites config
systemctl restart agent-hub
```

Restarting is safe: the unit's `KillMode=process` leaves the tmux server alone,
sessions survive, and the next reconcile re-adopts them. Restarting the sidecar
is likewise safe — it holds no session state and deliberately does not stop
anything on shutdown.

## Security notes worth reading once

**A Telegram allowlist entry is a root allowlist entry.** Every id in
`AGENT_HUB_TELEGRAM_ALLOWED_USERS` can start sessions, which are unsupervised
shell access on this box, and can point the box at a Claude account. There is
deliberately no "open to everyone" mode.

**The HTTP port is loopback by default and needs no token there** — reaching it
already implies shell access. Bind it wider and `AGENT_HUB_TOKEN` becomes
mandatory; the process refuses to start otherwise. To publish the web UI, keep
the bind on `127.0.0.1` and put a Cloudflare Tunnel in front, so the port never
listens on a routable interface.

**The sidecar holds the hub token, and that is its whole privilege.**
`POST /api/command` runs any command line it is given, `/login` included. The
verb allowlist in the sidecar is the only thing between a coordinator and that
endpoint — which is why the command line is assembled from literals and
charset-checked values and never received from the wire. See
[`sidecar.md`](./sidecar.md).

**Two env files, two modes `0600`, on purpose.** `/etc/agent-hub.env` holds the
Telegram token and the hub token; `/etc/agent-fleet-sidecar.env` holds the hub
token and (later) the coordinator credential. Merging them would put the
coordinator credential in the session manager's environment for no reason.

**Containers do not fix credential scope.** When the sandbox work lands, egress
stays open — `claude` needs the API and the work needs npm and GitHub. A
contained agent can still push with whatever credential it holds. Containers
remove the "trashed the box" failure mode, not the "used its credentials badly"
one.

## What this document does not cover yet

Because none of it exists: coordinator deployment (Workers + Durable Objects),
host enrollment and per-host keys, the container image and rootless podman
setup, Wake-on-LAN, and the iOS/Android apps. `design.md` §§2–7 describes all of
it; `design.md` §10 records what has been validated on hardware so far.
