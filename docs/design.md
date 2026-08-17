# agent-fleet — design handoff

Carried over from a prior session that read `ambersecurityinc/agent-hub` end to end.
Nothing has been built yet. No commits, no pushes were made to agent-hub.

**Goal:** a multi-host control plane for Claude Code sessions, with ephemeral root-capable
sandboxes, session wake, and iOS/Android apps — Siri/Shortcuts being the highest priority.
Host-side changes are intended to be contributed back upstream to agent-hub.

---

## 1. What agent-hub already is (don't re-derive this)

~3,800 lines of Node, zero runtime dependencies (`node` 18+, `tmux`, `claude`). State is one
JSON file. Telegram, a web UI, and a CLI all route through one command registry
(`src/adapters/commands.js:401` — `dispatch(ctx, line)`), so no surface can drift from another.

**The three hard-won behaviours** (`src/core/claude.js`), each documented as having cost a real
outage. Preserve all three; they are the actual value:

1. **`--resume` does not always resume.** On a large/stale conversation `claude` shows a blocking
   "summary or full?" dialog and waits forever. agent-hub watches the pane and answers *only when
   the dialog is on screen*, so a clean resume never receives a stray Enter.
2. **Never `--continue`.** In a shared workdir it resumes *that directory's* latest conversation,
   so restoring several sessions collides them all onto one. Resume by uuid or refuse
   (`RESUME_REQUIRES_UUID`).
3. **Remote Control fails silently.** Pane alive, no RC status line, session unreachable. Poll for
   the marker and re-issue `/remote-control` once before giving up.

Plus: the concurrency cap counts **every** live tmux session, not just ones it launched
(`sessions.js:144`) — a cap that only counts its own launches is not a cap. And
`KillMode=process` in the systemd unit is load-bearing: without it a routine `systemctl restart`
reaps the tmux server's cgroup and kills every live session.

Conversation uuids come from the **SessionStart hook**, which posts to `/internal/session-start`
(loopback-only, deliberately never token-gated). That's what makes resume authoritative rather
than scraped.

### Known gaps in agent-hub as it stands

- Tests cover pure string functions only (arg parsing, name charset, dialog text, URL de-wrapping).
  Reconcile, restore, cap accounting, and the tmux lifecycle are untested.
- `/new <name> <path>` accepts any path with no validation (`sessions.js:200`).
- **Live bug:** `#launch` calls `ensureWorkdirTrusted(this.cfg)`, which only trusts `cfg.workdir`.
  A session started in a custom path is not pre-trusted and hangs at exactly the trust dialog that
  function exists to prevent.
- `actor: 'web'` is hardcoded (`http.js:142`) — all HTTP token holders are anonymous and
  indistinguishable, so per-actor authorization is impossible without per-user tokens.
- `createdBy` is recorded but never enforced. Any allowlisted user can `/stop`, `/resume`,
  `/forget`, or `/peek` (read the pane of) anyone else's session.

---

## 2. Isolation: ephemeral root sandboxes

**Requirement:** give a session full root, and delete everything it did afterwards.

The apparent conflict with resume dissolves once you split state by lifetime:

| State | Where | Lifetime |
|---|---|---|
| Conversation (`~/.claude`: transcript + creds) | named volume | survives stop; deleted on `/forget` |
| Workspace (checkout, `node_modules`, build output) | named volume | survives stop; deleted on `/forget` |
| System (packages, `/etc`, anything root did) | container fs | **gone on every stop** |

### The shape: tmux stays on the host, the container runs in the pane

Do **not** replace tmux. Make the pane's process `podman run -it`:

```
IS_SANDBOX=1 exec podman run --rm -it \
  --name agent-<name> \
  -v claude-<name>:/root/.claude \
  -v work-<name>:/work -w /work \
  -v /run/agent-hub/<name>.sock:/run/hub.sock \
  --memory=8g --cpus=2 --pids-limit=512 \
  agent-session:latest \
  claude --remote-control <name> --dangerously-skip-permissions --resume <uuid>
```

Why this works:

- **`src/core/tmux.js` does not change.** `capture-pane` still reads the TUI podman is drawing;
  `send-keys` still types into it. Resume-dialog detection, RC retry, and `peek` keep working.
- **`reconcile`, the cap, adoption and boot restore keep working** — still one tmux session per
  agent. `--rm` plus pane-process-is-podman means a dead container ends the tmux session, which
  reconcile already handles as `ended → resumeOnBoot: true`.
- **Run podman rootless.** Container-root maps through a user namespace to the unprivileged hub
  user on the host: full root inside, nobody outside. `IS_SANDBOX=1` stops being a lie told to
  bypass a safety check.
- **`trust.js` leaves the host.** Bake `hasTrustDialogAccepted` for `/work` into the image; the
  host's `~/.claude.json` is never mutated again.
- **Resource limits become podman flags** — one mechanism instead of a separate cgroup layer.

### Two required changes

1. **Hook transport.** Have the HTTP adapter also listen on a unix socket (Node's `listen()` takes
   a path) and bind-mount a per-session socket into only that container. This *solves* the
   unauthenticated-hook problem rather than complicating it: today any local process can POST any
   name+uuid; with a per-session socket, only that container can reach `<name>.sock`. Isolation
   supplies the authentication — no nonce needed.
2. **`/forget` should `podman volume rm`.** It already means "no longer resumable"; make that true
   on disk.

**Verify in the prototype:** Claude keys transcripts under `~/.claude/projects/` by a slug derived
from the working directory. A fixed `/work` mount makes that slug stable across runs — likely more
reliable than the host setup, but confirm before building on it.

**First thing to test:** does the TvY pass cleanly through tmux → podman → the Claude TUI?
Everything above depends on it.

### What containers do NOT fix

- **Network.** `claude` needs the API; the work needs npm and GitHub. Egress stays open. A
  contained agent can still push with whatever credential it holds and still exfiltrate.
  **Credential scoping remains exactly as necessary as before.** Containers remove the
  "trashed the box" failure mode, not the "used its credentials badly" one.
- **Image rot.** You now own a base image with node/git/claude. Point Renovate at it.
- **Escape isn't zero.** Rootless + userns means an escape lands as the unprivileged host user
  rather than root. Good posture, not a guarantee.

### Bonus

Per-session `~/.claude` volumes give per-session (or per-fork) credentials **without** N Unix
users, N logins, and N `settings.json` files. Containers reach that goal more cheaply than the
per-user-account path.

---

## 3. Multi-host

**Hosts dial out. Nothing you own ever listens.** A persistent outbound WebSocket from each host
preserves the property that makes agent-hub deployable at all (no inbound rule, works behind NAT
on a Pi), and it gives wake for free — the coordinator pushes down an already-open socket.

**Resume is pinned; only new sessions get scheduled.** `claude-<name>` is a host-local volume, so
`/resume bigjob` must land on the box holding it. Round robin applies to *placement of new
sessions only*.

**Scheduling:** round robin is the wrong default — hosts differ in capacity and sessions differ
wildly in weight. Filter by constraints (labels, memory, cached repo) → rank by free capacity →
tie-break round robin. Hosts report `maxSessions`, current count, load average, free memory, labels.

**`unknown` is a state, not a default.** A host that hasn't reported in is `unknown` with a reason,
never `healthy`. A session whose host is offline is `unreachable`, not `stopped`. This is recon's
principle — make "we don't know" unrepresentable as a benign value — and it applies directly.

**The warning:** multi-host reintroduces the two-plane split agent-hub's README explicitly
celebrates having removed (a Worker + D1 request queue that needed a heartbeat protocol and a
stale-row reaper). Unavoidable with more than one box, but it means **the coordinator's registry is
a cache with provenance, never the authority.** Each host stays the sole authority on its own tmux.
If the Durable Object caches session state as truth, we rebuild the exact failure already paid for.

### "Wake" — three meanings, build all three

1. Wake a stopped **session** — that's resume; exists.
2. Wake a sleeping **host** — WoL magic packet or a cloud start API, then wait for it to dial home.
3. **Push when a session needs you** — hit a prompt, finished, errored. This is what makes the
   phone app worth having; the pane-scraping already detects the resume-dialog case.

---

## 4. Transport

Hosts are the easy part — every option has them dialing out. **The phone is the binding
constraint:** "Hey Siri, resume bigjob" must work from cellular, on a cold radio, in under a
second.

- **A — Serverless edge (Cloudflare Workers + Durable Objects).** You own no port, no VM, no cert,
  no tunnel daemon. Hosts open an outbound WebSocket; a DO per host pins it. Phone speaks HTTPS to
  the same origin. Not a tunnel — no `cloudflared`, nothing aimed at your box; hosts are ordinary
  clients. **Recommended for the phone leg.**
- **B — Tailscale / WireGuard mesh.** Zero ports, zero tunnels, no third party in the data path,
  best auth story (node identity + ACLs). Purest fit for "no tunnels or open ports". **Problem is
  Siri:** a Shortcut hitting a tailnet name works only when the VPN is up *and* connected, and Siri
  fires right after unlock on a cold radio. Always-on VPN mitigates but doesn't kill it.
- **C — Shared broker (MQTT / ntfy / Telegram).** Nothing you own listens; Telegram is already
  proven in agent-hub. But request/response is awkward, the scheduler has nowhere to live, and it's
  a weak foundation for a native app API.

**Decision: A for the phone leg, B available as a deployment mode for host↔coordinator.** Build the
host agent so transport is one swappable module — then "Tailscale mode" is just
`COORDINATOR_URL=http://coord.tailnet.ts.net:8790` with nothing else changing.

---

## 5. Auth model

Worker is the edge. Agents check in with it. Reachable by agent with service auth and by app with
service auth, so no unauthenticated surface — except Telegram. `/healthz` is the one deliberate
exception, returning liveness only.

### Telegram — the correction that matters

**Validating the user id is authorization, not authentication.** The user id arrives in the request
*body*, which an attacker controls; anyone who learns the Worker URL can forge an update claiming
any id. The bot name is likewise payload data, not a signal.

- **Webhook mode (preferred):** set a `secret_token` at `setWebhook`; Telegram returns it on every
  request as `X-Telegram-Bot-Api-Secret-Token`. *That* authenticates the request. Then the user-id
  allowlist does its actual job — authorization. Order: authenticate, then authorize.
- **Long-poll mode:** dial legram reoutbound, no inbound surface, forgery question doesn't exist.
  But Workers are request-scoped and can't hold a long poll cheaply — needs a DO with alarms, or
  legram repolling stays on a host that speaks to the Worker as an agent.

### Two credential classes, two mechanisms

- **Host:** long-lived, headless, one per box, can hold a secret at `0600`. Don't put the secret on
  the wire — sign a short-lived JWT per connection so replay is bounded and the durable secret
  never leaves disk.
- **App:** per-user *and* per-device, independently revocable, refresh-token shaped.
  **Never bake a credential into the app binary** — it's public the moment someone pulls the IPA.
  Mint per device at enrollment; store in iOS Keychain / Android Keystore. A lost phone is then one
  revocation, not a fleet-wide rotation.

### Enrollment — Telegram is already your identity provider

You're authenticated there, so reuse it and skip building an account system:

- **Phone:** `/enroll` in Telegram returns a one-time code or deep link; the app exchanges it once
  for a device credential.
- **Host:** a one-time enrollment token pasted into `/etc/agent-fleet.env`, exchanged at first
  check-in for a long-lived per-host key. This is agent-hub's `/whoami` bootstrap, generalized.

### The principle to enforce from day one

**The Worker sends intents, not commands.** Down the socket goes
`{action: "resume", name: "bigjob", choice: "summary"}` — never a shell string, never a raw command
line. The agent's own command registry is the allowlist.

The failure to design against: the Worker is compromised (bad deploy, leaked API token, supply
chain) and is now driving root-capable boxes. With a fixed verb set the blast radius is "someone
started and stopped some sessions." With command strings it's every box you own. Cheap now,
impossible to retrofit once something is passing strings.

Corollaries: the agent pins the expected coordinator origin, and every command carries an
idempotency key (a replayed `/stop` is harmless; a replayed `/new` is not).

### What service auth still doesn't give you

Authenticating the actor doesn't answer *which sessions this actor may touch*. That's agent-hub's
flat-allowlist problem — and the Worker is the right place to fix it, since it's one chokepoint
instead of N hosts. Roles and per-session ownership are far cheaper to build here than to retrofit
upstream.

---

## 6. Host-side code structure

> **Superseded 2026-08-17 — see §8.5.** The host side is a **sidecar process in agent-fleet**
> driving agent-hub over its loopback HTTP API, not an adapter inside agent-hub. The
> reasoning below still holds and is why the sidecar translates intents into the same command
> lines `dispatch()` takes; what changed is that it reaches that seam through `POST /api/command`
> instead of by being loaded into the process. `docs/sidecar.md` has the detail, including the two
> things the HTTP boundary costs.

**The coordinator client is just another adapter.** `dispatch()` already takes
`{sessions, login, cfg, actor}` plus a command line, and agent-hub's README advertises exactly this
seam: "Slack and WhatsApp are each one file; nothing in `src/core/` needs to change."

So the host side is `src/adapters/fleet.js` — roughly 200 lines that dial the coordinator,
translate intents into command lines, and render replies back. Small, testable, and upstreamable as
a **new adapter rather than a fork**, which is the stated goal.

The new repo then owns: coordinator (Worker + DOs), scheduler, mobile API, the container image,
and both apps.

---

## 7. Mobile

**Build constraint:** an iOS app cannot be compiled or tested in the Claude Code remote environment
— no macOS, no Xcode, no signing identity. Swift/SwiftUI/App Intents sources and an Xcode project
can be written, but that code is reviewed-but-unrun until it's built on a Mac.

**Decision: both tracks in parallel.**

- **Shortcuts first.** Siri does not wait for the app: the "Get Contents of URL" action plus a
  spoken phrase gives "Hey Siri, resume bigjob" with **zero app code**, as soon as the API exists.
  Ship a documented set of Shortcuts and phrases. This is also the permanent fallback path.
- **Native app alongside.** App Intents for parameterized Siri phrases (session name as a resolved
  entity), widgets, Live Activities for a running session, and push for the wake-when-needed case.

API design implication: keep endpoints Shortcut-friendly — flat JSON, single round trip per action,
no multi-step handshakes on the hot path.

---

## 8. Open decisions

1. **Session setup — settled, not open.** Repo is `TheTechNetwork/agent-fleet`. A session can hold
   repos from multiple orgs; the only restriction is *adding* an org mid-session that wasn't a
   source at start. Open the new session with **both `TheTechNetwork/agent-fleet` and
   `ambersecurityinc/agent-hub` as initial sources.** Having agent-hub attached matters — the fleet
   adapter is a patch against its existing seam, not code written blind.
2. **Workspace lifetime.** Volume that survives stop (recommended — a multi-day migration keeps
   uncommitted work) vs. fully ephemeral with a fresh clone every start (stronger, but `/stop`
   destroys uncommitted work).
3. **Telegram webhook vs. long poll** on the Worker.
4. ~~**First milestone.**~~ **Done 2026-08-17.** *Build* the intent protocol + the host side (§6) —
   it's the contract both the Worker and the sandbox launch path depend on, and §5 flags it as
   impossible to retrofit. *Validate* the TTY passthrough separately, on hardware (§9). These are
   different tasks in different places; conflating them is what sent the first session looking for
   a container runtime it didn't have.

   Landed: `docs/intents.md` + `src/protocol/intents.js` (the protocol, built by the coordinator
   and enforced by the host), and `src/host/` + `bin/agent-fleet-sidecar` (the host side). Eight
   verbs, no `login`/`code`, no path parameter anywhere. 112 tests, plus an end-to-end run against
   a real `agent-hub serve` — see `docs/sidecar.md`.

5. **Host side is a sidecar, not an in-process adapter — settled 2026-08-17.** §6 proposes
   `src/adapters/fleet.js` inside agent-hub, which is a clean fit for its adapter seam. We are
   doing it as a separate process instead, driving agent-hub over its loopback HTTP API
   (`POST /api/command`, `GET /api/state`, `GET /api/peek`).

   The reason: **agent-hub is upstream code we intend to contribute back to.** Every line of
   fleet logic added to that tree is a line that has to be untangled before any of it can go
   upstream, and a tree that accumulates them becomes a fork by default rather than by decision.
   The HTTP boundary keeps `agent-hub/UPSTREAM.md`'s diff small enough to actually contribute.
   Two smaller things it buys: the sidecar restarts without disturbing sessions, and a host can
   run an agent-hub other than the vendored one. The cost is one loopback round trip per action,
   which is nothing against the ~20s a start already spends on the Remote Control check.

   Two consequences worth carrying forward:

   - **`actor` cannot reach `createdBy`.** `http.js:142` hardcodes `actor: 'web'`, so a session
     the fleet starts is recorded as started by "web". The gap §1 already lists, now load-bearing.
     Fixable upstream or in the coordinator, not from the sidecar.
   - **The verb allowlist is the only gate.** `/api/command` runs any line it is given, `/login`
     included, and the sidecar holds the token. In-process there was a second allowlist to fall
     back on; here there is not.

---

## 9. Where to run what

Not every part of this can be built in the same place. Match the work to the environment or you
will write code nobody can verify.

### Needs a real Linux host — use a local CLI session

Run it on the box that will actually be a fleet host. Everything here depends on kernel and
service behaviour that cannot be mocked usefully:

- TvY passthrough: tmux → podman → the Claude TUI, including a real resume dialog rendering and
  accepting keys.
- Rootless podman: container-root mapping through a user namespace to an unprivileged host user.
- The bind-mounted per-session hook socket.
- The systemd unit, including `KillMode=process` surviving a `systemctl restart` with live
  sessions.
- The container image build, and Wake-on-LAN.

**Validate on Linux, not macOS.** On a Mac, `podman run -it` talks to a Linux VM over a socket.
TvY passthrough will likely still look fine, but the userns mapping we actually care about happens
inside that VM, not on the machine. A green test on macOS proves less than it appears to.

Quick plumbing check (~5 minutes) before building anything on the assumption:

```sh
tmux new-session -d -s ttytest -c /tmp \
  "exec podman run --rm -it alpine sh -c 'echo TvY=\$(tty); read -p \"type: \" x; echo got=\$x'"
tmux capture-pane -t '=ttytest:' -p -S -40      # did podman get a TvY, and can we read it?
tmux send-keys -t '=ttytest:' -l hello
tmux send-keys -t '=ttytest:' Enter
tmux capture-pane -t '=ttytest:' -p -S -40      # did the keystrokes reach the container?
```

`TvY=/dev/pts/N` plus `got=hello` means the mechanism holds. Real confirmation is running `claude`
in there and watching a resume dialog render.

### Runs anywhere — remote sessions are fine

Pure logic, testable with `node:test` and fakes:

- The intent protocol / verb set.
- The host sidecar against agent-hub's HTTP API, with a fake transport and a stub hub. (Better
  than expected: a real `agent-hub serve` runs fine here on a scratch state dir, so the sidecar
  was validated against the actual API rather than only a stub — see §8.5.)
- Scheduler: constraint filter, capacity ranking, sticky-placement rules.
- Worker + Durable Object code (unit-testable with mocks; end-to-end needs a Cloudflare account).
- API surface and the Shortcuts definitions.

### Cannot be verified anywhere in Claude Code

- **iOS app.** No macOS, no Xcode, no signing identity. Swift/SwiftUI/App Intents sources and an
  Xcode project can be written, but stay reviewed-but-unrun until built on a Mac.
- **Anything needing a container runtime.** Claude Code remote containers have no container daemon.
  lhe `docker` CLI may be on `PATH` while `/var/run/docker.sock` does not exist, and systemd is not
  running (PID 1 is `process_api`). Verified, not assumed.

---

## 10. Validated on hardware — 2026-08-17

Host `unabandoned`: Debian 13, running as root. podman 5.4.2, tmux 3.5a, node 20.19.2,
claude 2.1.233. Every result below was directly observed, not inferred.

### §2's sandbox design is confirmed end to end

| Property | Result |
|---|---|
| podman gets a real TvY inside a tmux pane | ✅ `TvY=/dev/pts/0` |
| `capture-pane` reads what the container drew | ✅ line-oriented and full-screen TUI both |
| `send-keys` reaches the container's stdin | ✅ drove a shell `read` and the trust dialog |
| Container exit ends the tmux session (`exec` + `--rm`) | ✅ — this is what lets reconcile see "ended" |
| `claude` runs on bare `debian:13-slim` | ✅ no missing libs; Containerfile can be minimal |
| Mounted credentials work | ✅ `~/.claude` + `~/.claude.json` bind-mounted from copies |
| `--dangerously-skip-permissions` inside the container | ✅ `⏵⏵ bypass permissions on` |
| Remote Control attaches from inside a container | ✅ full banner + `claude.ai/code/...` URL |

**`capture-pane` handles the full-screen TUI cleanly**, including `❯ 1.` / `2.` selection markers —
the same shape `parseResumeDialog` already matches (`/^[❯>»*]?\s*\d\.\s+\S/`). No new parsing needed.

### Two blocking dialogs confirmed mandatory to pre-empt

Both were observed hanging a container session, and both were confirmed fixed by pre-seeding:

1. **Folder trust.** A copied `.claude.json` keys `projects` by *host* paths, so `/work` is untrusted
   and the session stops at "Is this a project you created or one you trust?". Bake
   `projects["/work"] = {hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true}` into
   the image. Confirmed: with it pre-seeded, the session goes straight to the UI.
2. **Dangerous-mode confirmation.** `skipDangerousModePermissionPrompt: true` in
   `~/.claude/settings.json`.

### Remote Control detection — checked, no change needed

`RC_ONLINE_RE` (`claude.js:51`) matches CLI 2.1.233 output three ways over, and `extractRcUrl`
pulls the URL. Observed pane text:

```
/remote-control is active · Continue here, on your phone, or at
https://claude.ai/code/session_016zfBs7LYmQwg7WqfD6dY3M
```

Note: **the flag matters.** Launched *without* `--remote-control <name>` (RC coming up via
`remoteControlAtStartup` instead), the pane shows only `/rc active` in the status line, which
matches none of the patterns. agent-hub always passes the flag (`claude.js:33`), so this is not a
live bug — but do not remove that flag thinking the setting covers it.

### Latent risk found, not yet hit — now fixed

`extractRcUrl` ran on raw `capturePane` output with no de-wrapping, unlike the login flow which
has `dewrapPane` for exactly this failure. At 80 columns the RC URL landed on its own line, but a
narrower pane or a longer session id would wrap it mid-token and produce a truncated URL.

Confirmed worse than that once measured against the verbatim capture above: at 100 columns it
truncates to `…/session_016zf` (well-formed enough that nobody suspects it), and at 70–80 the
`https://` prefix straddles the break so **nothing matches at all** — the session comes up
reported online with no URL to reach it by. Confirmed again on a real 70-column tmux pane, not
just a fixture.

**Worked around rather than fixed**, since agent-hub is not being modified: `src/host/pane.js`
ports `dewrapPane` and adds an explicit URL character set (de-wrapping can only ever join *more*
text onto the end, and in a TUI that is as likely to be a box border as a path segment). The
sidecar re-derives the URL from `GET /api/peek` and repairs what agent-hub recorded, naming which
failure it found — `missing`, `truncated` or `mismatch`. This is the reason `peek` is in the verb
set at all.

**Also fixed at source.** Now that agent-hub is vendored into this repo (`agent-hub/`), the fix
is applied there too: `dewrapPane` moves to `src/core/pane.js` (importing it from `login.js` into
`claude.js` would be a cycle), and `extractRcUrl` de-wraps first. It is the one divergence from
upstream `cac1f02` and is ready to contribute as-is — see `agent-hub/UPSTREAM.md`.

The sidecar's own layer stays regardless, and its role changes: with both in place
`reconcileRcUrl` should report `repaired: false` in normal operation, so a `truncated` or
`missing` in the logs now means agent-hub's extraction has regressed. That is exactly the failure
that went unnoticed the first time, because nothing was watching for it.

### Still unvalidated

- ~~**The unix-socket hook transport** (§2).~~ **Validated 2026-08-17** — see
  `docs/hook-socket.md`, 19 tests over real unix sockets. Two things it turned up that were not
  obvious from the design: reclaiming a stale socket is a hijack primitive if done naively (probe
  before unlinking), and the socket's mode has a `listen()`→`chmod()` race that a `0700` directory
  closes. Fully proven only once rootless podman is, since the userns mapping is what makes a
  `0600` socket reachable from inside the container — but that failure is loud (`EACCES`), not
  silent.
- **Rootless podman.** All tests ran as root, so container-root → unprivileged-host-user mapping is
  unproven. Needs a dedicated non-root user, which is the correct deployment posture anyway.
- **systemd behaviour** — `KillMode=process` surviving a restart with live sessions.
