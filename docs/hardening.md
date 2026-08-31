# Hardening a host

> Let's work on ensuring a host doesn't get compromised and then the risk boils
> down to what a session has.

That is the right decomposition, and it is also why the GitHub App stays
installable by **any account** — see [github-app.md](./github-app.md). The
private key's blast radius is bounded by the host it sits on, so the host is
where the work goes.

## Measured, not recommended

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
bind mount whose host side is `/`.

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

A session gets **root inside its container**, and that is the product. Hardening
the host does not narrow what a session can do to itself, and is not meant to.
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
