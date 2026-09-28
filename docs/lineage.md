# Where Fleetwright came from

Fleetwright began from [`ambersecurityinc/agent-hub`](https://github.com/ambersecurityinc/agent-hub),
a single-box Claude Code session manager. The session manager here — the hub,
`src/core/`, `src/adapters/`, `src/web/`, `bin/fleetwright` — started as that
code. Everything around it (the fleet, the coordinator, the apps, the sandbox,
packaging) was built here.

**It is a spin-off, not a fork that tracks upstream.** It was first kept at
agent-hub's own paths and names so that changes could be contributed back file
for file. That stopped being the plan: the project renamed everything to
Fleetwright — commands, units, files, settings — and does not track upstream.

| | |
|---|---|
| Began from | `cac1f02` — *Fix the two things that broke the first real session on a fresh box* (agent-hub `main`) |
| On | 2026-08-17 |
| Licence | MIT, © Amber Security Inc — kept verbatim as [`LICENSE-agent-hub`](../LICENSE-agent-hub), as the licence requires |

## The rename, and what still says agent-hub

Before the rename a box was made of agent-hub and agent-fleet names:
`agent-hub.service`, `/etc/agent-hub.env` with `AGENT_HUB_*` settings,
`/var/lib/agent-fleet/host-key.json`. Existing boxes move onto the new names the
next time an installer runs on them, which the next update does — see
`install/install.sh`, "the names from before the rename". Until then, and for
anything written by hand with the old names, `src/fleet/legacy-names.js` reads
them under the new ones.

Four things keep their old names on purpose:

| | why |
|---|---|
| the coordinator Worker's script name, `agent-fleet-coordinator` | its Durable Object namespace — the whole fleet — belongs to the script name; a renamed Worker starts empty |
| the signing context, `agent-fleet/v1/…` | it is inside every signature a host makes and the coordinator checks; changing it would split the fleet in two |
| `agent-hub`, `agent-fleet-sidecar`, `agent-fleet-mcp` in `bin/` and a release's `lib/` | one-line aliases, because an unmigrated box's units name them for the one update that migrates it |
| `agent-fleet` as a GitHub Actions OIDC audience | accepted beside `fleetwright`, because runner repositories copied before the rename ask for it |

The history in `CHANGELOG.md` keeps the names it was written with.

## What changed first, from `cac1f02`

These were the first changes made to the session manager after it was taken,
recorded when the plan was still to send them upstream. They are kept as the
record of why the code is shaped the way it is.

### 1. De-wrap the pane before reading the Remote Control URL

`extractRcUrl` matched raw `capture-pane` output with no de-wrapping, unlike the
login flow, which has `dewrapPane` for exactly this failure. A pane is a
fixed-width grid, and the RC URL is one long token. At 80 columns it lands on a
line of its own and nothing goes wrong — which is why this was never noticed.
Measured against the verbatim CLI 2.1.233 capture in
[`design.md`](./design.md) §10, and confirmed on a real 70-column tmux pane:

| pane width | before |
|---|---|
| 80 | correct |
| 100 | `https://claude.ai/code/session_016zf` — truncated, well-formed, and dead |
| 70 | `null` — the `https://` prefix straddles the break, so the session is reported online with no URL to reach it by |

Three parts:

- `dewrapPane` moved from `src/core/login.js` to `src/core/pane.js`. Importing it
  from `login.js` into `claude.js` would be a cycle (`login.js` already imports
  `sleep` from `claude.js`), and with `export const sleep` that is a TDZ error
  rather than a warning.
- `extractRcUrl` de-wraps first, and matches an explicit URL character set
  instead of `\S+`. De-wrapping can only ever join *more* text onto the end of
  the URL, and the pane is a TUI, so what follows is as likely to be a box
  border as a path segment.
- `verifyRemoteControl` tests its marker against de-wrapped text too — one of
  the markers *is* the URL, and a pane narrow enough to wrap it splits
  `claude.ai/code` across two rows and matches nothing.

No behaviour change at 80 columns, which is the only width the existing captures
cover.

### 2. The ephemeral root sandbox (`FLEETWRIGHT_SANDBOX`)

design.md §2, implemented. Config-gated and **off by default**, so a box without
podman behaves exactly as before — which is what makes it contributable rather
than a fork.

- `src/core/podman.js` — new. Per-session volumes, credential seeding, cleanup.
- `src/core/claude.js` — `buildCommand` produces a `podman run -it` line when
  the sandbox is on. The claude arguments are unchanged; they just land after
  the image name.
- `src/core/sessions.js` — creates and seeds volumes before launch, skips host
  trust entirely (the image bakes it), and `/forget` now deletes the volumes.
- `src/config.js` — the `FLEETWRIGHT_SANDBOX*` block.

Nothing in `tmux.js`, `registry.js` or the reconcile logic changed, which is the
point: it is still one tmux session per agent, and `--rm` plus
pane-process-is-podman means a dead container ends the tmux session that
reconcile already knows how to handle.

Validated end to end on this hardware — image built, session launched through
tmux into a container, Claude TUI rendering, Remote Control attached, a real
conversation uuid delivered over the per-session hook socket, and `/forget`
deleting both volumes. One bug only a live run could find: `IS_SANDBOX=1` on the
outer command sets it for *podman*, not for the container, so Claude refused
`--dangerously-skip-permissions` as root and the container died instantly. It is
now passed with `-e` and baked into the image.

Contributable in principle. Realistically it wants the rootless-podman work
finished first, since running the sandbox as root is the posture this is
supposed to fix.

### 3. `/update` — pull the deployment from chat

`src/core/update.js` plus one entry in the command registry, so it works from
Telegram, the web UI and the CLI alike.

The same argument as `/login`: a box you can only fix by SSHing into it is a box
that does not get fixed. What it refuses to do is the interesting part —
`--ff-only` so a diverged deployment fails loudly rather than creating a merge
commit nobody reviewed, and a dirty tree is left alone entirely, because
somebody editing files on the box is mid-something and discarding that from a
chat message is not recoverable.

`--restart` applies the update by **exiting**: systemd's `Restart=always` brings
the process back with the new code, which needs no privilege the service user
does not already have (`systemctl restart` from an unprivileged unit would need
polkit rules). Sessions are untouched, which is exactly what `KillMode=process`
in the unit is for.

Stands on its own merits for any deployment of the session manager.

### 4. `setLogStream()` in `src/log.js`

Three lines, so that a process whose **stdout is a data channel rather than a
console** can send every level to stderr. The sidecar in stdio mode writes
newline-delimited JSON to stdout, where an `info` line is not noise — it is a
corrupted message.

The default stdout/stderr split is unchanged, so this is inert for fleetwright
itself. It stands on its own merits (any tool embedding the logger in a
pipeline wants it) but it is the weakest of the candidates, and would be fine
to drop from a contribution.

### 5. `install/install.sh` is now the whole project's installer

It sets up the sidecar and coordinator configs and builds the sandbox image
alongside everything it did before. It became the monorepo's installer, the first sign
this was going to be a project of its own. The
systemd unit and the env example it copies are untouched.

## Not carried over

`src/adapters/fleet.js`, the in-process fleet adapter from an earlier iteration
of this design. It was superseded by the sidecar; shipping both would be two
implementations of one thing.

## A latent bug found while wiring the two together, and NOT fixed here

`NAME_RE` in `src/core/names.js` is `/^[A-Za-z0-9_-]{1,40}$/`, which accepts a
**leading dash**. So `--dangerous` is a legal session name.

Inside the session manager that is harmless: names travel as argv entries to
tmux, never through a shell. It stops being harmless wherever a command *line*
is re-parsed, because `parse()` in `src/adapters/commands.js` reads any token
beginning with `--` as a flag — so `/new --dangerous` is a permission override
with no name at all, and `/stop --safe` is a stop with no target.

The fleet protocol closes this on its own side by anchoring the first character
(`src/fleet/protocol/intents.js`), and `test/intents.test.js` pins both halves so
nobody removes the anchor as redundant. Fixing `core/names.js` itself is a
behaviour change for existing deployments — a session someone already named
`_build` would stop validating — so it was left for a deliberate change rather
than a quiet edit.
