# The credential broker

A session **asks** for a token instead of being handed one.

```
container                      host
─────────                      ────
git push  ──▶ git-credential-fleet ─┐
gh pr list ─▶ /usr/local/bin/gh ────┼─▶ /run/hub.sock ─▶ answerCredentialRequest
anything  ──▶ fleet-cred github ────┘   (this session's         │
                                         socket, and only it)   ▼
                                                        <email>.env, read now
```

## What it replaces

Every connected token used to be copied into the session's volume as
`.secrets.env` and exported by the entrypoint with `set -a`.

That was already the careful version — **not** `-e` flags on the podman command
line, because that line is the tmux pane's process and readable from `ps` by
anyone on the box. Two things still followed from it:

1. The token sat in `environ` for every process in the container: readable from
   `/proc`, inherited by every child, present in anything that dumps an
   environment on the way to a crash report.
2. **It was frozen at start.** A session held whatever was current when it
   began. Rotating a token reached the *next* session and could not reach into a
   running one — so the remedy for "my GitHub token expired" was to stop working
   and restart the session.

The second is the one people actually hit, and the socket is what makes it go
away: the file is read at the moment of the request.

## Why it is a route on the hook socket

Because the hook socket already has the property this needs. One socket per
session, bind-mounted into exactly that container, so **which socket a request
arrives on is what identifies the session**. The request carries no identity,
because nothing in it could be believed. See [hook-socket.md](./hook-socket.md).

A second socket would mean a second lifecycle, a second mount, and a second
place to get that reasoning wrong. This is the same door with another thing
behind it.

## The three ways in

| caller | mechanism | why |
|---|---|---|
| `git` | credential helper (`git-credential-fleet`) | git has a protocol for exactly this; no shim needed |
| `gh`, `wrangler` | PATH shim in `/usr/local/bin` | they read a variable and speak no helper protocol, so the token enters **one process's** environment at the moment it runs |
| anything else | `eval "$(fleet-cred github)"` | the escape hatch, and what the shims use |

The git helper is registered **per host** (`credential.https://github.com.helper`)
rather than globally. A global helper is consulted for every host a session ever
clones from, which would hand it the hostname of anything the session was told
to fetch. It refuses those on its own, and not being asked is better than
refusing.

### The shim resolves itself out of PATH

It finds the real binary by walking `PATH` and skipping **its own directory,
taken from `$0`** — not a hardcoded `/usr/local/bin`. That constant works right
up until the shim is somewhere else, and the failure it produces is a shim that
finds itself, execs itself, and spins forever: a hang with no error. There is a
second guard for the symlink case, because one more "surely not" is cheaper than
a session that stops responding.

It also **refuses to pretend**. If the tool is not installed, the shim says so
and exits 127 rather than silently succeeding — otherwise `command -v gh` reports
a `gh` that does not exist, and somebody spends an afternoon looking for a bug in
`gh`.

A missing *credential*, by contrast, is not fatal: plenty of `gh` commands need
no token, and the ones that do will complain in their own words.

## Named secrets, granted at start

The broker began as connected-provider tokens (`github`, `cloudflare`). It also
serves **named secrets** — arbitrary values the operator placed on the box —
under the same socket and the same authority.

```
container                         host
─────────                         ────
fleet-secret github-deploy ─▶ /run/hub.sock ─▶ /internal/secret
                                  (this session's socket)     │
                                                              ▼
                                          AGENT_HUB_SECRETS_DIR/github-deploy
                                                    read now, if GRANTED
```

The difference from a provider token is where the permission comes from. A
provider token is scoped to whoever owns the session. A named secret is scoped
to what `start --secret <name>` **granted** that session, recorded on its
record: the grant decides, not the ask, so a session cannot name a secret it
was not given and cannot probe which secrets exist by asking — a name it was not
granted never touches the store. The value is read at the moment of the request,
logged by name, and never enters the container's environment or filesystem.

`secrets` (the verb) lists the names a box holds, so the phones and the CLI
offer a picker instead of blind entry — the value is never in that listing. See
`docs/trust.md`.

Its refusals mirror the five above: `not_granted` (this session was not given
that name), `no_secret` (granted, but this box does not hold it — an operator
gap on this host), and `no_name` (nothing asked for).

## What this is not

**It is not the credential-terminating proxy** in [trust.md](./trust.md). The
session still receives the real token and can copy it anywhere. What changed is
that it must ask, that asking is logged, and that it gets the current one — the
order trust.md argues for:

> minting without the broker is a shorter fuse on the same bomb; the broker
> without minting is already an improvement.

**It does not narrow what a session can reach.** A session that asks for
`github` gets the same token it used to be handed. Narrowing is what per-session
minting is for, and that waits on the private-key question in
[github-app.md](./github-app.md).

**It does not defend against the session.** A root-capable container that wants
to keep a copy can keep one. The broker's audience is everything that *isn't*
deliberately exfiltrating: crash dumps, child processes, logs, and the gap
between a rotation and a restart.

## What is logged

Every grant and every refusal, by session name and provider. **Never the value** —
what makes the broker better than an environment variable is partly that asking
leaves a trace, and a trace that quoted the token would undo the rest of it.

```
credential-broker: served github to sunlit-harbor
credential-broker: refused github for quiet-anchor — not_connected
```

## Refusals, and why there are five

| error | means |
|---|---|
| `unknown_provider` | a typo, or a provider this host does not know — named back, so nobody concludes the fleet has no GitHub |
| `no_row` | the session's owner could not be identified. **Not** the same as having nothing connected |
| `not_connected` | that person has connected nothing for this provider. Fixable from the app, and the message says so — *nothing needs restarting* |
| `expired` | the token is there and is dead, with nothing to renew it — refused rather than served, because a credential that fails at the provider is a worse answer than one that says why here |
| `404 not found` | not one of the broker's answers at all: the socket has no broker route, which means an older sidecar or a session outside a sandbox (`hook-socket.js`) |

`no_row` and `not_connected` are deliberately different. `null` is *cannot tell*;
empty is *nothing there*. The case that used to collapse them resolved a
cannot-tell into the box's shared row, which is how a member's pasted GitHub
token once overwrote the operator's.

## Upgrading a running fleet

Nothing to do. A resumed session's volume may still hold a `.secrets.env` from
before; the entrypoint deletes it. A stale token that nothing refreshes is worse
than none — it fails in a way that looks like the broker is broken.
