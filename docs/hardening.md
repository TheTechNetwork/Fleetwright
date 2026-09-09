# Hardening a host

> Let's work on ensuring a host doesn't get compromised and then the risk boils
> down to what a session has.

That is the right decomposition, and it is also why the GitHub App stays
installable by **any account** — see [github-app.md](./github-app.md). The
private key's blast radius is bounded by the host it sits on, so the host is
where the work goes.

## Measured, not recommended

**On Linux.** Every directive below is a systemd one and every number is from
`systemd-analyze`; a Mac host has neither. See [None of this is a Mac](#none-of-this-is-a-mac)
before following any of it.

Every directive below was tested with `systemd-run`, one property at a time,
against the thing that unit actually has to do. The **rejected** list is the
valuable half: this repo runs rootless podman and a tmux server a person
attaches to from their own shell, and most of what a hardening guide recommends
breaks one of those *silently*.

```sh
# what agent-hub must survive
systemd-run --quiet --wait --pipe --property=<DIRECTIVE> \
  podman run --rm docker.io/library/alpine:latest true

# what the sidecar must survive: write+chmod 0600 in the state dir, ed25519,
# listen on loopback, make a request
systemd-run --quiet --wait --pipe --working-directory=$PWD <PROPERTIES> \
  node ./sidecar-probe.mjs
```

## Result

| unit | before | after |
|---|---|---|
| `agent-hub` | **9.0 UNSAFE** | **7.2 MEDIUM** |
| `agent-fleet-sidecar` | 8.8 EXPOSED | **3.4 OK** |

`systemd-analyze security --offline=true install/<unit>.service` reproduces
these. The gap between the two is not an inconsistency — it is the difference
between a process that spawns containers and one that spawns nothing.

## None of this is a Mac

`install.sh` installs a Mac host — it detects `Darwin`, installs through
Homebrew, and writes launchd daemons to `/Library/LaunchDaemons`. Somebody who
does that and then reads this page gets a hundred lines about a service manager
their box does not run.

**The units are launchd, and none of these properties exist there.**
`NoNewPrivileges`, `ProtectSystem`, `PrivateTmp` and the rest are systemd
directives. launchd has its own, far fewer, and not a mapping of these. The two
scores above come from `systemd-analyze security`, which has no equivalent to
run — so there is no number for a Mac host and this page does not have one to
give.

**And the session half is different too, which matters more.** The premise at
the top of this page is that hardening the host narrows what a compromised
agent-hub or sidecar reaches, while what a SESSION can do is bounded by the
container. On a Mac there is usually no container. `install.sh` says so as it
goes:

    sandboxing is off — podman on macOS needs a Linux VM, which this does not set up

Rootless podman on macOS is not rootless podman: there is no user namespace to
be root in, so podman runs a Linux VM, and the installer declines to set one up
rather than doing it silently. Until somebody runs `podman machine init &&
podman machine start`, a session on a Mac host is an ordinary process running as
the service user on the real machine — not root in a filesystem that is thrown
away on stop. Everything [`trust.md`](./trust.md) says about what a session
holds still applies; what does not apply is the containment either side of it.

**What this page would need to be true of a Mac** is the launchd equivalent of
the table below, measured the same way rather than recommended — and the
`podman machine` question answered one way or the other. Neither is done.
[`ROADMAP.md`](../ROADMAP.md) carries the macOS host as **partial** for related
reasons: unsandboxed sessions, and no `StateDirectory`/`RuntimeDirectory`
equivalent yet.

## What breaks agent-hub, and how

| directive | measured result |
|---|---|
| `NoNewPrivileges` | `newuidmap`/`newgidmap` are setuid-root and are how rootless podman gets a user namespace. A setuid binary under this reports **euid 65534 instead of 0** — it does not fail, it silently does nothing |
| `RestrictSUIDSGID` | podman does not start: crun dies with ``cannot resolve `null` under rootfs``. It also stops a session running `apt install sudo` |
| `PrivateTmp` | tmux's socket is `/tmp/tmux-<uid>`. A tmux server started under this is **invisible to `tmux ls` from the user's shell** — every `agent-hub attach` stops working |
| `ProtectHome` | rootless podman stores images in `~/.local/share/containers`; the Claude credential is in `~/.claude` |
| `ProtectSystem=strict` | podman run fails. `full` is what fits: read-only `/usr`, `/boot`, `/etc` — nothing writes to `/etc`, the two files named in messages are only read |
| `ProtectKernelTunables` | podman run fails |
| `ProtectControlGroups` | podman run fails; it writes its own cgroup |
| `ProtectHostname` | podman run fails |
| `PrivateDevices` | podman run fails, and it implies `NoNewPrivileges` |
| `RestrictNamespaces` | a container *is* namespaces |
| `SystemCallFilter` | not attempted: the filter applies to every child, and here that includes crun and whatever a session installs and runs |

**`RestrictSUIDSGID` is the one worth reading twice.** The obvious reason to
reject it — "it blocks setuid, and rootless podman needs setuid" — is wrong:
measured, a setuid binary under `RestrictSUIDSGID=yes` still reaches euid 0. It
blocks *creating* setuid files, not executing them. It is rejected for a
different, larger reason, and an assumption would have got the right answer for
the wrong cause and then been applied wrongly somewhere else.

## The sidecar takes everything agent-hub cannot

It is a single Node process: WebSocket to the coordinator, HTTP to
`127.0.0.1:8790`, and files in its own state directory. It **spawns nothing**,
and it never touches the credential store directly — connect, link and unlink
all go through agent-hub's API. So every directive rejected above is available
here, including the full seccomp filter.

```ini
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
```

**That second line is why the filter is usable at all.** With the default
action, `@system-service` kills Node outright — `status=31/SYS`, before it
prints anything. Node makes a call outside that set and tolerates being
*refused* but not being *shot*. The syscall is denied either way; this chooses
which of "denied" and "dead" the process gets.

## The sandbox escape hatch, checked

`AGENT_HUB_SANDBOX_ARGS` is spliced straight into `podman run`. Most of what it
is asked to do is ordinary — an extra mount, `--device=/dev/kvm` for an
emulator — but a handful of options do not *extend* the sandbox, they **remove**
it, while every document here goes on describing a session as contained.

Refused by name at startup: `--privileged`, `--userns=host`, `--network=host`,
`--pid=host`, `--ipc=host`, `--uts=host`, `--cap-add=ALL|SYS_ADMIN|…`,
`--security-opt seccomp=unconfined|apparmor=unconfined|label=disable`, and any
bind mount whose host side is the root, the podman or docker socket, `/etc`,
`/root`, `/proc`, `/sys`, `/dev`, `/run`, or a `.ssh`, `.gnupg`, `.aws`,
`.claude`, `.config`, `.kube` or `.docker` directory wherever it lives.

The first version refused only `/`, which is the mount nobody types. The one
that actually gets pasted is the container socket — "let the agent build
images" — and inside a root-capable container that is the whole box, with no
warning. The list is matched by path segment, so `/etcetera` is still yours;
and it is a list of names, so a mount that hands over the box some other way
is refused by nothing here. `AGENT_HUB_SANDBOX_ARGS` is split like a command
line — quotes group, a backslash escapes — so a path with a space reaches
podman as one argument and the check sees the argument the operator meant.

The refusal is escapable, deliberately:

```sh
AGENT_HUB_SANDBOX_ALLOW_UNSAFE_ARGS=1
```

A refusal somebody cannot act on gets worked around by deleting the check. With
the override the box starts and **warns on every start** — somebody who typed it
knows, somebody who inherited the box does not.

This is not a defence against whoever can write the env file; they own the box.
It is a defence against the option somebody pasted from a forum three months ago
that nobody has re-read since.

## What is deliberately still true

A session gets **root inside its container** — on a box that has one; see
[None of this is a Mac](#none-of-this-is-a-mac) — and that is the product.
Hardening the host does not narrow what a session can do to itself, and is not
meant to.
What it narrows is what a compromised *agent-hub* or *sidecar* reaches — which is
the half of the risk that is not the session's by design.

## Still open

- **A separate unix user for the sidecar**, so a compromised sidecar cannot read
  `~/.claude`, `accounts/*.json` or `connections/*.env` at all. It is a pure API
  client, so nothing structural prevents this — the cost is ownership migration
  on hosts that are already running.
- **Distroless or containerised sidecar**, for the same reason and further.
- The credential-terminating proxy in [trust.md](./trust.md), which is the only
  thing that changes what a session holds.
