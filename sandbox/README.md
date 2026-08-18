# The sandbox image

The container a sandboxed session runs in. design.md §2: give a session full
root, and delete everything it did afterwards.

```sh
podman build -t localhost/agent-session:latest -f sandbox/Containerfile sandbox/
```

`install/install.sh` does this for you when podman is present.

## What is in it, and what deliberately is not

Debian 13 slim, Node, the Claude Code CLI, and the two settings that stop a
session hanging on a dialog nobody is there to answer. That is all.

It is **not** a place for your toolchain. The session has real root inside, so
it can install whatever it needs — and all of that is discarded when the
container stops, which is the entire point. Baking tools in trades that away for
a faster start.

## The three things that would otherwise hang a session

All observed on hardware, all confirmed fixed by pre-seeding (design.md §10):

1. **Folder trust.** A credentials file copied from a host keys `projects` by
   *host* paths, so `/work` is untrusted and the session stops at "Is this a
   project you created or one you trust?". `/root/.claude.json` in the image
   answers it for `/work` — and is also why `trust.js` no longer has to mutate
   the host's `~/.claude.json`.
2. **Dangerous-mode confirmation.** `skipDangerousModePermissionPrompt`.
3. **`IS_SANDBOX`.** Claude refuses `--dangerously-skip-permissions` as root
   unless it is told it is in a sandbox. Setting it on the outer command sets it
   for *podman*, which the container never sees — the session then dies
   instantly with "cannot be used with root/sudo privileges". It is both baked
   in here and passed with `-e` by the launcher, so neither half depends on the
   other being right.

## Why `entrypoint.sh` exists

`/root/.claude` is a per-session volume, so it is EMPTY on first run and a mount
shadows anything the image put at that path. Files that belong to the session
rather than to the image — `settings.json`, the SessionStart hook registration —
have to be copied in at start rather than baked. The entrypoint does that, then
`exec`s claude so the container's lifetime is the session's lifetime.

## The hook

`hook.mjs` posts the conversation uuid to `/run/hub.sock` — a unix socket
bind-mounted from the host, belonging to exactly one session. It sends **no
session name**: the socket already determines which session this is, so a
container cannot report against a neighbour's. See `docs/hook-socket.md`.

## Image rot is now yours

You own a base image with node, git and a CLI in it. Both are pinned by `ARG`
(`NODE_MAJOR`, `CLAUDE_VERSION`) so a rebuild is reproducible and an upgrade is a
deliberate one-line change. Point Renovate at them.
