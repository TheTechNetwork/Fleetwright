# Deployment

How to stand this up on a real box, and — just as important — what is not
standable-up yet.

## What is deployable today

| | status |
|---|---|
| **Session manager** (`agent-hub`) — sessions from Telegram, web UI, CLI | ✅ installer, systemd unit, hook |
| **Sidecar** — validates intents, drives the session manager | ✅ websocket + stdio, systemd unit, `doctor` |
| **Coordinator** — hosts dial in, scheduler places work, HTTP API out | ✅ as a Node process **or** a Cloudflare Worker |
| **Sandboxes** — real root per session, discarded on stop | ✅ image, launch path, `/forget` deletes volumes |
| **Cloudflare deployment** (Worker + Durable Objects) | ✅ deployed by CI to `fleet.thetech.network` |
| **Push notifications** | ⚠️ server side done; needs a Firebase project, and untested against real FCM |
| **Android app** | ⚠️ builds, signs, installs; push not wired (needs Firebase) |
| **iOS app** | ⚠️ compiles in CI on macOS; never run on a device |

A box you set up today runs the whole loop: a coordinator, this box as a fleet
host, and sandboxed sessions with real root inside a container whose filesystem
is thrown away on every stop. That much is validated on hardware — see
[§10 of `design.md`](./design.md).

The ⚠️ rows are the honest ones. Each is built and each is unproven in the one
way that matters: no notification has been delivered to a real phone, and no app
has been run by a person. Treat them as ready to *test*, not as working.

## Prerequisites

**A Linux host**, and nothing else you have to install by hand. §9 of
`design.md` explains why validating any of the sandbox work on macOS proves less
than it looks like it does.

The installer installs what is missing — node (>= 24, which `package.json`
requires), tmux, podman, git, curl — from the distribution's own repositories.
It does not pipe a remote script into a shell. `AGENT_HUB_NO_INSTALL_DEPS=1`
turns that off for a box where package management is somebody else's job, and
then it tells you what to install instead.

**claude** — the Claude Code CLI — is the one thing it will not install for you.
Log in during the install, or later from chat with `/login`.

**podman** is needed only for sandboxed sessions. Without it everything else
works and sessions run directly on the box.

## 1. Install the session manager

```sh
git clone https://github.com/TheTechNetwork/Fleetwright /opt/agent-fleet   # the repo is Fleetwright; the install path is not
sudo /opt/agent-fleet/install/install.sh --check    # prerequisites only, changes nothing
sudo /opt/agent-fleet/install/install.sh
```

> **If it says node was not found but `node -v` works for you**, that is `sudo`.
> It replaces `PATH` with sudoers' `secure_path` — usually just `/usr/*` and
> `/bin` — so a node installed by nvm, fnm, volta or asdf lives somewhere the
> script cannot see. The installer now looks in all of those places and asks
> your login shell as well, so this should resolve itself; if it still cannot
> find it, point at it directly:
>
> ```sh
> sudo AGENT_HUB_NODE_BIN=$(command -v node) /opt/agent-fleet/install/install.sh
> ```
>
> Note that the systemd unit records whichever node it finds. If that is a
> version-manager path inside your home, a later `nvm install` will move it and
> the service will fail to start — the installer warns when this applies. A
> system-wide node (`apt install nodejs`, nodesource, `n`) avoids it.

One script does everything:

- checks prerequisites (node, tmux, claude, podman)
- creates `/etc/agent-hub.env`, `/etc/agent-fleet-sidecar.env` and
  `/etc/agent-fleet-coordinator.env`, all `0600`
- **copies the hub URL and token into the sidecar's config**, so there is no
  secret to hand-copy between files — the step people get wrong
- installs the systemd unit and registers the Claude Code **SessionStart hook**
- builds the sandbox image (`localhost/agent-session:latest`) if podman is present
- links `agent-hub`, `agent-fleet-sidecar` and `agent-fleet-coordinator`

It is idempotent — re-run it after `git pull` and it will never overwrite a
config that already exists. `AGENT_FLEET_REBUILD_IMAGE=1` forces an image
rebuild; `AGENT_FLEET_BUILD_IMAGE=0` skips it.

### What the wizard asks

Run on a terminal, `install.sh` asks rather than leaving you a checklist. In
order:

| it asks | what to have ready | blank means |
|---|---|---|
| Telegram bot token | [@BotFather](https://t.me/BotFather) → `/newbot` | no Telegram; web UI and CLI still work |
| Telegram user ids | leave blank if you do not know yours | nobody allowlisted yet — see below |
| Run the coordinator on this box? | `Y` for a single-machine setup | it asks for a coordinator URL to join instead |
| Firebase service-account JSON | **the path to the file**, already on the box | push is logged instead of sent |
| Sandbox sessions? | needs podman | sessions run directly on the box |
| Enable and start the services now? | | you start them yourself |

Then it offers to log Claude in, which is the one step that genuinely needs a
person.

Two of those are worth planning for before you start:

- **Your Telegram id.** You do not need it up front. Leave it blank, and once
  the bot is up message it **`/whoami`** — it answers with your id even though
  you are not on the allowlist yet. Put that in
  `AGENT_HUB_TELEGRAM_ALLOWED_USERS` in `/etc/agent-hub.env` and
  `systemctl restart agent-hub`.
- **The Firebase JSON.** `scp` it to the box first, because the installer wants
  a path, not a pasted value. Firebase console → Project settings → Service
  accounts → Generate new private key. It reads the file and base64-encodes it
  into the coordinator's env itself — see [`push.md`](./push.md) for why pasting
  the JSON cannot work.

Everything it does not ask about, it generates: `AGENT_FLEET_HOST_TOKEN` (shared
by the coordinator and this host), `AGENT_FLEET_API_TOKEN` (what a phone or
Shortcut presents), and the hub token. There is no decision in those, and a
blank one is how a coordinator ends up reachable with no credential at all.

It is idempotent. Re-run it after `git pull` and it will never overwrite a value
that is already set — which also means the way to *change* an answer is to edit
the env file, not to re-run.

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

If you answered the wizard, this is already done: both env files are written,
the tokens are generated and shared, and the services are running as
`agent-fleet-coordinator` and `agent-fleet-sidecar`. Skip to the check below.

```sh
systemctl status agent-fleet-coordinator agent-fleet-sidecar
```

To do it by hand, or to point this host at a coordinator somewhere else, the
whole configuration is two lines in `/etc/agent-fleet-sidecar.env`:

```
AGENT_FLEET_COORDINATOR_URL=https://fleet.thetech.network   # or http://127.0.0.1:8791
AGENT_FLEET_TRANSPORT=websocket
```

plus the same `AGENT_FLEET_HOST_TOKEN` the coordinator has. The sidecar refuses
to start without a pinned origin — §5: the agent pins the coordinator it will
talk to, so a compromised coordinator cannot redirect it.

**Where the coordinator runs is a real choice**, and both are supported:

| | when |
|---|---|
| **Cloudflare Worker** | you want it reachable from a phone on mobile data. No port, no cert, no tunnel — see [`coordinator-deploy.md`](./coordinator-deploy.md) |
| **Node process on a box** | single-machine testing, or a fleet that never leaves your network |

The same code runs in both. Check the host either way:

```sh
agent-fleet-sidecar doctor
```

```
 ok   configuration
 ok   agent-hub reachable at http://127.0.0.1:8790
 ok   agent-hub accepts the token  — 0/5 running on unabandoned
 ok   claude is logged in on the hub  — you@example.com (max)
 ok   host id unabandoned  — labels: gpu, debian13
```

Then drive the fleet through the coordinator. Against a local one:

```sh
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

### The units

`install/agent-fleet-sidecar.service` and
`install/agent-fleet-coordinator.service`, installed and started by the
installer. The sidecar's unit only became possible with the websocket transport:
under `stdio` the process ends when stdin does, so a unit would have
crash-looped.

The credential they carry is still the shared `AGENT_FLEET_HOST_TOKEN` — every
host presents the same one. §5 wants a per-host key so revoking one host does
not mean rotating all of them. That is the gap, not the unit.

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

`sessions.js` opens a socket per session as it starts one and closes it on
stop, so this is live rather than idle: it is how a sandboxed session's
conversation uuid gets out of the container at all.

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

## 4. The phone

Only worth doing once the coordinator is reachable from one — which in practice
means the Worker, since a phone on mobile data cannot see a box on your LAN.

1. **Deploy the Worker** — [`coordinator-deploy.md`](./coordinator-deploy.md).
   CI does it on every push to `main` that touches `worker/`.
2. **Install an app** — [Android](../apps/android/README.md) (build the APK, or
   take it from a GitHub release) or [iOS](../apps/ios/README.md) (Xcode, or
   TestFlight once the App Store Connect record exists).
3. **Settings → coordinator URL and API token.** The token is
   `AGENT_FLEET_API_TOKEN` from `/etc/agent-fleet-coordinator.env`, or whatever
   you set as the Worker secret. Nothing is baked into the binary: §5, a
   credential in an APK is public the moment somebody unzips it.
4. **Push** needs a Firebase project and, on Android, `google-services.json`.
   [`push.md`](./push.md) and the app READMEs have the steps.

Siri and Shortcuts need none of this beyond step 3 — §7 designed the API so a
Shortcut could call it directly.

## 5. Verify the whole path

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

From chat or the CLI, which is what `/update` is for — it fast-forwards, refuses
a dirty tree, and restarts by exiting under systemd:

```sh
agent-hub update
```

By hand:

```sh
git -C /opt/agent-fleet pull
sudo /opt/agent-fleet/install/install.sh   # idempotent; never overwrites config
systemctl restart agent-hub
```

Re-running the installer is worth doing after a pull rather than just
restarting: new steps get asked about (push was added this way), and anything
already set is left alone.

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

**Containers do not fix credential scope.** Egress stays open — `claude` needs the API and the work needs npm and GitHub. A
contained agent can still push with whatever credential it holds. Containers
remove the "trashed the box" failure mode, not the "used its credentials badly"
one.

## What is genuinely not done

Not "undocumented" — not built, or built and never proven:

- **Enrollment.** One shared `AGENT_FLEET_HOST_TOKEN` for every host. §5 wants a
  per-host key and a short-lived signed assertion, so revoking one host does not
  mean rotating all of them.
- **Rootless podman.** The sandbox has only ever run as root. That is the wrong
  posture and it is stated again under §3 above, because it is the one item here
  with a security consequence rather than a convenience one.
- **Push against real FCM.** The sender, the encoding and the installer step are
  all built and tested; no notification has ever been delivered to a phone.
- **The apps on a device.** Android builds and installs, iOS compiles in CI.
  Neither has been driven by a person.
- **Wake-on-LAN.** §3's second meaning of "wake". A sleeping box cannot be a
  host, and nothing sends the packet.
- **Telegram on the Worker.** Telegram works against a box today; the webhook
  path §5 describes does not exist.

`design.md` §§2–7 describes all of it; §10 records what has been validated on
hardware.
