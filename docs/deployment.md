# Deployment

How to stand this up on a real box, and — just as important — what is not
standable-up yet.

## What is deployable today

| | status |
|---|---|
| **Session manager** (`agent-hub`) — sessions from Telegram, web UI, CLI | ✅ installer, systemd unit, hook |
| **Sidecar** — validates intents, drives the session manager | ✅ websocket transport, `doctor`, config |
| **Coordinator** — hosts dial in, scheduler places work, HTTP API out | ✅ runs as a plain Node process |
| **Sandboxes** — real root per session, discarded on stop | ✅ image builds, launch path, `/forget` deletes volumes |
| **Cloudflare deployment** (Worker + Durable Objects) | ❌ the coordinator runs on a box for now |
| **Mobile apps** | ❌ the HTTP API is Shortcut-ready; no app yet |

A box you set up today runs the whole loop: a coordinator, this box as a fleet
host, and sandboxed sessions with real root inside a container whose filesystem
is thrown away on every stop. All of it validated on this hardware — see
[§10 of `design.md`](./design.md) and the notes below.

## Prerequisites

- **Node 18 or newer** — global `fetch` is required.
- **tmux** — `apt install tmux`. Not optional; it is what holds the sessions.
- **claude** — the Claude Code CLI, on `PATH`, logged in (or log it in later
  from chat with `/login`).
- **A Linux host.** §9 of `design.md` explains why validating any of the sandbox
  work on macOS proves less than it looks like it does.

**podman** is needed only for sandboxed sessions. Without it everything else
works and sessions run directly on the box.

## 1. Install the session manager

```sh
git clone https://github.com/TheTechNetwork/agent-fleet /opt/agent-fleet
sudo /opt/agent-fleet/install/install.sh
```

One script does everything:

- checks prerequisites (node, tmux, claude, podman)
- creates `/etc/agent-hub.env`, `/etc/agent-fleet-sidecar.env` and
  `/etc/agent-fleet-coordinator.env`, all `0600`
- **copies the hub URL and token into the sidecar's config**, so there is no
  secret to hand-copy between files — the step people get wrong
- installs the systemd unit and registers the Claude Code **SessionStart hook**
- builds the sandbox image (`agent-session:latest`) if podman is present
- links `agent-hub`, `agent-fleet-sidecar` and `agent-fleet-coordinator`

It is idempotent — re-run it after `git pull` and it will never overwrite a
config that already exists. `AGENT_FLEET_REBUILD_IMAGE=1` forces an image
rebuild; `AGENT_FLEET_BUILD_IMAGE=0` skips it.

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

## 2. Run the fleet

The installer already wrote `/etc/agent-fleet-coordinator.env` and
`/etc/agent-fleet-sidecar.env` with the hub URL and token filled in. Two things
are left.

**Start a coordinator.** On the same box for a single-machine test, or wherever
the fleet should meet:

```sh
set -a; . /etc/agent-fleet-coordinator.env; set +a
agent-fleet-coordinator
```

Generate tokens with `openssl rand -hex 24` and put the same
`AGENT_FLEET_HOST_TOKEN` in both files. Loopback with no tokens is fine for a
local test and the process says so; binding wider without them is refused.

**Point the sidecar at it** in `/etc/agent-fleet-sidecar.env`:

```
AGENT_FLEET_COORDINATOR_URL=http://127.0.0.1:8791
AGENT_FLEET_TRANSPORT=websocket
```

The sidecar refuses to start without a pinned origin (§5: the agent pins the
coordinator it will talk to). Check it:

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

Then run it, and drive the fleet through the coordinator:

```sh
agent-fleet-sidecar &                       # dials the coordinator, holds it open

curl -s localhost:8791/api/hosts            # who is in the fleet, and why not
curl -s localhost:8791/api/list             # every session, attributed by host
curl -s localhost:8791/api/status/bigjob
curl -s -X POST localhost:8791/api/intent \
  -H 'content-type: application/json' \
  -d '{"verb":"start","params":{"name":"api"}}'
```

`AGENT_FLEET_TRANSPORT=stdio` speaks the same protocol over stdin/stdout instead,
for driving one sidecar by hand with no coordinator:

```sh
echo '{"v":1,"kind":"intent","id":"idem-0000001","verb":"health","issuedAt":'$(date +%s000)'}' \
  | agent-fleet-sidecar
```

Replies come back on **stdout** as newline-delimited JSON; logs go to
**stderr**. That split is deliberate and enforced — an `info` line landing on
stdout would not be noise, it would be a corrupted message.

### Why there is still no sidecar systemd unit

The reason it was omitted before — the stdio transport ends when stdin does, so
a unit would crash-loop — no longer applies now that the websocket transport
exists and holds its connection open. What is left is the credential: a unit
wants `AGENT_FLEET_HOST_TOKEN` to be a per-host key from an enrollment flow, not
the one shared token every host currently presents. Writing the unit now would
mean writing it twice.

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

## 3. Sandbox the sessions

Off by default, because it needs podman and a built image and a box without
either must keep working exactly as before. Turn it on in `/etc/agent-hub.env`:

```
AGENT_HUB_SANDBOX=1
```

and `systemctl restart agent-hub`. Every new session's pane process becomes
`podman run -it` instead of `claude`, which is the whole of design.md §2:

| state | where | lifetime |
|---|---|---|
| conversation (`~/.claude`) | volume `claude-<name>` | survives stop, deleted on `/forget` |
| workspace (`/work`) | volume `work-<name>` | survives stop, deleted on `/forget` |
| system (packages, `/etc`, anything root did) | container fs | **gone on every stop** |

The session gets real root. It can `apt install` whatever it needs, and all of
it is discarded when the container stops — which is why the image is deliberately
minimal rather than pre-loaded with a toolchain.

tmux does not move: `capture-pane` reads the TUI podman is drawing and
`send-keys` types into it, so resume-dialog detection, the Remote Control retry
and `peek` all keep working untouched.

Two things to know:

- **Credentials are seeded once per session.** A fresh `claude-<name>` volume is
  empty, so the first launch copies `.credentials.json` in — without it the
  session comes up unauthenticated and hangs at a login prompt nobody can
  answer. `AGENT_HUB_SANDBOX_CREDENTIALS` points at the source; set it empty to
  manage credentials yourself.
- **Run the sidecar too, or sessions are not resumable.** The conversation uuid
  arrives over the per-session hook socket, which the sidecar owns. agent-hub
  warns loudly and starts anyway if the socket is missing, because a session you
  can use now beats no session — but it will have no uuid, and `/resume` will
  refuse it.

Resource limits are podman flags — `AGENT_HUB_SANDBOX_MEMORY` (8g),
`AGENT_HUB_SANDBOX_CPUS` (2), `AGENT_HUB_SANDBOX_PIDS_LIMIT` (512), and
`AGENT_HUB_SANDBOX_ARGS` for anything else.

### Still to do here

Everything above ran as **root**, so podman's container-root → unprivileged-host-user
mapping is unproven and is the correct deployment posture. Until it is done, an
escape lands as root on the host rather than as a nobody user. Run rootless
before trusting this with anything you care about.

## 3. Verify the whole path

```sh
agent-hub doctor                      # can this box run sessions at all
agent-fleet-sidecar doctor            # can the sidecar drive it
agent-hub list                        # the session manager answers
curl -s localhost:8791/api/hosts      # the coordinator sees this box
systemctl status agent-hub
journalctl -u agent-hub -f
```

A host that has connected but not yet reported reads as `unknown` with a
reason, never as healthy — that is deliberate (§3), and `/api/hosts` always
tells you which it is and why.

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

Because none of it exists: deploying the coordinator to Cloudflare (Workers +
Durable Objects — it runs as a plain Node process today), host enrollment and
per-host keys (there is one shared host token for now), rootless podman,
Wake-on-LAN, and the iOS/Android apps. `design.md` §§2–7 describes all of it;
`design.md` §10 records what has been validated on hardware.

There is also still no systemd unit for the coordinator or the sidecar. Both
run fine in the foreground or under any supervisor; writing the units is a
small job that is worth doing once the enrollment story replaces the shared
token, so the unit and the credential arrive together.
