# The agent-hub lineage

The session manager in this project — `src/index.js`, `src/config.js`,
`src/log.js`, `src/core/`, `src/adapters/`, `src/web/`, `bin/agent-hub`,
`install/` — comes from
[`ambersecurityinc/agent-hub`](https://github.com/ambersecurityinc/agent-hub).
It is **upstream code we intend to contribute back to**, not a fork we intend to
keep.

| | |
|---|---|
| Upstream | `https://github.com/ambersecurityinc/agent-hub` |
| Taken from | `cac1f02` — *Fix the two things that broke the first real session on a fresh box* (upstream `main`) |
| Taken on | 2026-08-17 |
| Licence | MIT, © Amber Security Inc — kept verbatim as [`LICENSE-agent-hub`](../LICENSE-agent-hub) |

## Why the paths are what they are

Those files sit at **exactly their upstream paths**. That is deliberate and it
is the one thing that keeps a future contribution cheap: the diff is
file-for-file, with no renames to unpick and no import rewriting to review.

Fleet code lives under `src/fleet/` and nowhere else. Keeping that separation is
what makes it possible to say what has changed upstream-of-us and what is ours.

## How to produce the contribution diff

```sh
git clone https://github.com/ambersecurityinc/agent-hub /tmp/upstream
cd /tmp/upstream && git checkout cac1f02
for f in src/index.js src/config.js src/log.js src/core src/adapters src/web bin/agent-hub install test/parsing.test.js; do
  diff -ru "/tmp/upstream/$f" "/path/to/agent-fleet/$f"
done
```

Two rules keep that diff small and reviewable:

1. **No fleet code in those paths.** Everything the fleet needs from the session
   manager, it gets over the loopback HTTP API from `src/fleet/host/` — see
   [`sidecar.md`](./sidecar.md). If fleet concerns start leaking into `src/core/`
   or `src/adapters/`, the upstream contribution stops being possible and this
   becomes a fork by default rather than by decision.
2. **Every change there stands on its own merits** to an agent-hub user who has
   never heard of agent-fleet. If a change only makes sense because of the
   fleet, it belongs in `src/fleet/`.

## What has diverged from `cac1f02`

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
cover. Ready to go upstream as-is.

### 2. The ephemeral root sandbox (`AGENT_HUB_SANDBOX`)

design.md §2, implemented. Config-gated and **off by default**, so a box without
podman behaves exactly as before — which is what makes it contributable rather
than a fork.

- `src/core/podman.js` — new. Per-session volumes, credential seeding, cleanup.
- `src/core/claude.js` — `buildCommand` produces a `podman run -it` line when
  the sandbox is on. The claude arguments are unchanged; they just land after
  the image name.
- `src/core/sessions.js` — creates and seeds volumes before launch, skips host
  trust entirely (the image bakes it), and `/forget` now deletes the volumes.
- `src/config.js` — the `AGENT_HUB_SANDBOX*` block.

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

Stands on its own merits for any agent-hub deployment. Contributable as-is.

### 4. `setLogStream()` in `src/log.js`

Three lines, so that a process whose **stdout is a data channel rather than a
console** can send every level to stderr. The sidecar in stdio mode writes
newline-delimited JSON to stdout, where an `info` line is not noise — it is a
corrupted message.

The default stdout/stderr split is unchanged, so this is inert for agent-hub
itself. It stands on its own merits (any tool embedding the logger in a
pipeline wants it) but it is the weakest of the candidates, and would be fine
to drop from a contribution.

### 5. `install/install.sh` is now the whole project's installer

It sets up the sidecar and coordinator configs and builds the sandbox image
alongside everything it did before. **This one is not contributable as-is** —
it is the monorepo's installer now, and an upstream PR would exclude it. The
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
behaviour change for existing agent-hub deployments — a session someone already
named `_build` would stop validating — so it belongs in an upstream
conversation, not in a quiet edit here.
