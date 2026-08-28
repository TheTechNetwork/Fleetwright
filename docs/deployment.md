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
| **Android app** | ⚠️ builds, signs, installs; push wired to FCM, untested against a real device |
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
curl -fsSL https://fleet.thetech.network/install | sudo sh
```

That fetches the repository to `/opt/agent-fleet` — the repo is Fleetwright,
the install path is not — and runs `install/install.sh` from it. Arguments go
after `-s --`, which is how `sh` is told the rest belongs to the script:

```sh
curl -fsSL https://fleet.thetech.network/install | sudo sh -s -- --check
```

`/install` is a redirect to `install/bootstrap.sh` in this repository, served by
the coordinator so the URL is short and the script has exactly one home. Read it
before you run it; it is forty lines and it does three things — get git, clone,
hand over.

The same thing by hand, which is all the one-liner does:

```sh
git clone https://github.com/TheTechNetwork/Fleetwright /opt/agent-fleet
sudo /opt/agent-fleet/install/install.sh --check    # prerequisites only, changes nothing
sudo /opt/agent-fleet/install/install.sh

sudo /opt/agent-fleet/install/uninstall.sh         # take this box out of the fleet
sudo /opt/agent-fleet/install/uninstall.sh --purge # and remove /opt/agent-fleet
```

### Cloning a box that is already installed

**Do not, without reading this.** `/var/lib/agent-fleet/host-key.json` is the
machine's identity in the fleet — whoever holds it *is* that host. Clone the
disk and two machines hold the same private key, so the coordinator sees one
host: they take turns proving the same identity and disconnecting each other,
for ever, with nothing in either box's logs to explain it.

The installer detects this now. It fingerprints the machine next to the key
(`/etc/machine-id`, or the IOPlatformUUID on macOS) and if the key turns up on
different hardware it sets the key aside, says so, and makes a new one — so the
clone needs enrolling again, which is the correct outcome.

It sets the key aside rather than deleting it because there is one case where
the clone is meant to *replace* the original: move the file back, and then
destroy the original rather than leaving it running.

Either way, remove the stale entry from the coordinator:

```sh
curl -sX DELETE -H "Authorization: Bearer $TOKEN" https://COORDINATOR/api/hosts/HOSTID
```

To take a box out properly, `install/uninstall.sh` removes the services, the
config, the sudoers rules, the CLIs, the `SessionStart` hook and the identity —
and deliberately leaves `~/agent-runs`, running tmux sessions, and
node/tmux/podman/claude alone. Those are work and dependencies, not this.

Three environment variables change where it comes from and where it goes, which
is what you want for a fork or a branch under test:

| | |
|---|---|
| `FLEETWRIGHT_REPO` | default `https://github.com/TheTechNetwork/Fleetwright` |
| `FLEETWRIGHT_REF` | default `main` |
| `FLEETWRIGHT_DIR` | default `/opt/agent-fleet` |

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
| Enrolment pin — **only when joining** someone else's coordinator | six digits from the app, or from anyone with the admin token | not enrolled yet; run `agent-fleet-sidecar enrol <pin>` or send `/enroll <pin>` later |
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

### Credentials

**Hosts do not have a token.** This box generates a keypair on first run, keeps
the private half at `/var/lib/agent-fleet/host-key.json` (0600), and signs a
nonce on every connection. Joining is a six-digit pin, spent once.

On the box that **runs the coordinator**, that enrolment is silent: the
installer holds the admin token, so it mints a pin and spends it rather than
making you copy six digits from one terminal into the same terminal.

`AGENT_FLEET_API_TOKEN` is generated rather than asked, and **printed when the
install finishes** — it is break-glass, not the everyday credential:

```
  The coordinator on this box:
      URL          http://10.0.0.5:8791   (or your Worker, if you deploy one)
      Admin token  623ad69f979bdf7a7b5253d94fde3202ea1dd1438a06868e
```

The app does not want that token. It signs in — Sign in with Apple, or the
system account picker on Android — and is issued a credential of its own, which
can be revoked without disturbing any other device. Sign-in needs
`AGENT_FLEET_AUTH_ISSUERS`, `AGENT_FLEET_AUTH_AUDIENCES` and
`AGENT_FLEET_AUTH_ALLOW`; see [`identity.md`](./identity.md).

On a box **joining a coordinator that already exists** — the Worker, or another
machine — the enrolment pin is *asked for*, because it has to come from that
coordinator: minted with the admin token, handed out by the app (Fleet → Add
a host), or sent as `/enroll <pin>` in Telegram. Leave it blank and the box
stays unenrolled — the sidecar keeps connecting and getting refused until
someone runs `agent-fleet-sidecar enrol <pin>`, as the service user.

Either way, to read one back later:

```sh
sudo grep AGENT_FLEET_API_TOKEN /etc/agent-fleet-coordinator.env
```

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
the admin token is generated, this box is enrolled, and the services are
running as `agent-fleet-coordinator` and `agent-fleet-sidecar`. Skip to the
check below.

```sh
systemctl status agent-fleet-coordinator agent-fleet-sidecar
```

To do it by hand, or to point this host at a coordinator somewhere else, the
whole configuration is two lines in `/etc/agent-fleet-sidecar.env`:

```
AGENT_FLEET_COORDINATOR_URL=https://fleet.thetech.network   # or http://127.0.0.1:8791
AGENT_FLEET_TRANSPORT=websocket
```

There is no token to add. The sidecar refuses to start without a pinned origin
— §5: the agent pins the coordinator it will talk to, so a compromised
coordinator cannot redirect it — and it refuses to *connect* until it has been
enrolled:

```sh
agent-fleet-sidecar enrol 123456     # a pin from the app
agent-fleet-sidecar doctor           # says whether the coordinator accepts it
```

or, without an SSH session, send `/enroll 123456` to this box's bot.

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

The sidecar's unit carries `StateDirectory=agent-fleet`, which is what creates
`/var/lib/agent-fleet` 0700 owned by the service user before the process
starts. That is where this box's private key lives — the whole of its identity
in the fleet. Deliberately not under `/etc` with the env file: an env file is a
config file people copy between boxes, and this must never be copied.

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
3. **Settings → coordinator URL, then sign in.** There is no token to type: the
   app hands the coordinator an Apple or Google ID token and is issued a
   credential for that device, kept in the keychain or behind a keystore key.
   Nothing is baked into the binary — §5, a credential in an APK is public the
   moment somebody unzips it — and nothing is shared between phones either, so
   losing one is a single revocation.

   This needs `AGENT_FLEET_AUTH_ISSUERS`, `AGENT_FLEET_AUTH_AUDIENCES` and
   `AGENT_FLEET_AUTH_ALLOW` set on the coordinator, with your address on the
   allowlist. See [`identity.md`](./identity.md).
4. **Push** needs a Firebase project and, on Android, `google-services.json`.
   [`push.md`](./push.md) and the app READMEs have the steps.

Siri and Shortcuts need none of this beyond step 3 — §7 designed the API so a
Shortcut could call it directly.

## 5. Verify the whole path

```sh
agent-hub doctor                      # can this box run sessions at all
SVC="$(stat -c %U /opt/agent-fleet/bin/agent-hub)"
sudo -u "$SVC" agent-fleet-sidecar doctor    # can the sidecar drive it, and does the coordinator know it
agent-hub list                        # the session manager answers
sudo -u "$SVC" agent-fleet-sidecar identity  # this box's key and fingerprint
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

By hand — and **not with `sudo git pull`**, which is the one way to break this:

```sh
sudo -u "$(stat -c %U /opt/agent-fleet/bin/agent-hub)" git -C /opt/agent-fleet pull
sudo /opt/agent-fleet/install/install.sh   # idempotent; never overwrites config
sudo systemctl restart agent-hub
```

### Why the pull is not sudo, when everything else is

Creating `/opt/agent-fleet` needs root. Living in it does not: the installer
ends with `chown -R $RUN_USER` over the whole checkout, precisely so the service
can fast-forward itself without being given sudo — `/update` from a phone is the
whole point, and a service that can run `sudo git` is a service that can run
anything.

So after the install the directory belongs to the **service user**, and pulling
as root writes root-owned objects into `.git/objects` that the service can then
never add to:

```
error: insufficient permission for adding an object to repository database .git/objects
fatal: failed to write object
```

Either fix puts it right — the installer, because it re-chowns every run:

```sh
sudo /opt/agent-fleet/install/install.sh
# or just the ownership:
sudo chown -R "$(stat -c %U /opt/agent-fleet/bin/agent-hub)" /opt/agent-fleet
```

Re-running the installer is worth doing after a pull rather than just
restarting: new steps get asked about (push was added this way), anything
already set is left alone, and it repairs exactly this.

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
token and which coordinator this box belongs to. Merging them would put the
fleet's configuration in the session manager's environment for no reason.

**The host key is in neither of them.** It lives in `/var/lib/agent-fleet`,
because an env file is a thing people copy to the next box and an identity is
the one thing that must not be copied.

**Containers do not fix credential scope.** Egress stays open — `claude` needs the API and the work needs npm and GitHub. A
contained agent can still push with whatever credential it holds. Containers
remove the "trashed the box" failure mode, not the "used its credentials badly"
one.

## What is genuinely not done

Not "undocumented" — not built, or built and never proven:

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
