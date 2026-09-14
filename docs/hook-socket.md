# The per-session hook socket — validated 2026-08-17

Closes the first of the three items §10 of `design.md` left open. Node 20.19.2,
same box as the rest of §10. Everything below is a passing test in
`test/hook-socket.test.js`, run over real unix sockets — nothing is mocked.

    npm test    # 19 tests, all green

## What it is

One unix socket per session on the host:

    /run/agent-fleet/<name>.sock

bind-mounted into that session's container and nowhere else, always at the same
path inside:

    -v /run/agent-fleet/<name>.sock:/run/hub.sock

## Why it is the fix rather than a complication

agent-hub's `/internal/session-start` is loopback-only and deliberately never
token-gated — the hook runs as a child of a `claude` process on the same box,
and making it carry the operator token would mean writing that token into a
world-readable hook script. The cost is that any local process can post any
`name`+`uuid`, and a conversation uuid is what makes a session resumable. So any
local process can repoint any session's resume target.

Inside a sandbox that stops being acceptable, because §2 hands the session real
root. The obvious patch — a per-session nonce — has to be generated, delivered
into the container, and rotated, and the container can read it.

**The socket replaces it at no cost.** The session name becomes a property of
*which socket the request arrived on*, not of anything in the request. A
container cannot name a session other than its own because it cannot reach
another session's socket. The trust relationship inverts: the body used to be
the authority and was forgeable; the socket is the authority and is not.

The container is not even told its own name — it posts `{uuid, cwd}` to
`/run/hub.sock` and the host fills in the rest.

## What was confirmed

| Property | Result |
|---|---|
| A uuid posted on `<name>.sock` records against `<name>` | ✅ |
| The client sends no name; the socket supplies it | ✅ |
| A body naming a *different* session is refused (403) and records nothing | ✅ |
| A body naming its *own* session is accepted | ✅ tolerated, so agent-hub's existing HTTP payload shape is not a hard failure |
| Two sessions' sockets are fully independent | ✅ |
| Socket directory is `0700`, socket is `0600` | ✅ |
| A name that would escape the directory (`../escape`) is refused | ✅ same charset as agent-hub's `names.js` |
| Malformed uuid → 400, nothing recorded | ✅ including uppercase, which agent-hub also rejects |
| Non-object JSON body → 400 | ✅ `[]`, `null`, `"str"`, `` |
| A 2 MB body is dropped and the listener survives | ✅ |
| Only `POST /internal/session-start` is answered | ✅ 405 / 404 otherwise |
| A `{ok: false}` from the hub reaches the client | ✅ the hook can tell "refused" from "unreachable" |
| `close()` unlinks the socket | ✅ |
| A socket left by a crashed container is reclaimed | ✅ no EADDRINUSE on the next start |
| A socket with a **live** listener is never stolen | ✅ probed first — see below |
| `open()` twice is idempotent; `close()` of an unknown name is not an error | ✅ |
| An unreachable socket returns a failure instead of throwing | ✅ the hook must never block a session |

### Two things that were not obvious before writing it

**Reclaiming a stale socket is a hijack primitive if done naively.** `--rm` plus
a container that died hard leaves the socket file behind with nothing listening,
so `listen()` fails `EADDRINUSE` and the session can never restart. The fix is to
unlink it — but unlinking *unconditionally* means anything that can ask the hub
to open a session can drop a live session's socket, listen on the same path, and
receive its next report. So the path is probed first (`connect` → `ECONNREFUSED`
means stale) and a live listener is an error, not a takeover.

**The socket's mode has a race that the directory closes.** Node creates a unix
socket with a mode derived from the process umask, and there is an unavoidable
window between `listen()` and `chmod()`. A `0700` directory makes that window
unreachable rather than merely short. Both layers are asserted.

## How this works without changing agent-hub

No agent-hub change is required, which was not obvious at first. The
[sidecar](./sidecar.md) owns the sockets and forwards what arrives to agent-hub's
existing `POST /internal/session-start` — the endpoint the ordinary hook already
posts to, which is loopback-only and deliberately untokened:

```js
const hooks = new HookSocketServer({
  dir: cfg.hookSocketDir,
  onSessionStart: (r) => hub.recordSessionStart(r),   // → POST /internal/session-start
  logger: log,
});
await hooks.open(name);   // before podman run, to get the path to mount
await hooks.close(name);  // when the container exits
```

The sidecar knows which session a report came from, because it knows which
socket it arrived on, so it supplies the `name` the container was never given.
agent-hub sees an ordinary hook report and records the uuid exactly as it always
has.

That is the whole trick: **the untokened endpoint stops being a weakness once
the only thing that can reach it is a process that already knows who is
calling.** A container reaches its own socket and nothing else; the sidecar
reaches loopback; the endpoint itself is unchanged.

Confirmed end to end against a real `agent-hub serve` on 2026-08-17 — a uuid
posted on `demo.sock` with no name in the body appeared in agent-hub's own log
as `hook: demo → a1b2c3d4-…`, and a post naming a different session was refused
403 and never forwarded. See [`sidecar.md`](./sidecar.md).

The container-side half is `postSessionStart()`. In a sandbox, `agent-hub hook`
runs it instead of its HTTP POST — detected by the socket existing at
`/run/hub.sock`. The spool fallback is unchanged and still applies: a transport
failure returns `{ok: false, error}` rather than throwing, so the hook can spool
and exit 0.

The loopback HTTP endpoint does **not** go away. Sessions that are not sandboxed
keep using it directly, and it remains the reason agent-hub's HTTP server starts
even in a Telegram-only deployment.

## Still unvalidated from §10

- **Rootless podman.** All of §10 ran as root, so container-root →
  unprivileged-host-user mapping is unproven. It is what makes the `0600` socket
  reachable from inside the container while staying private on the host, so this
  transport is only *fully* proven once that is. The failure mode if the mapping
  is wrong is loud (`EACCES` on connect), not silent.
- **systemd `KillMode=process`** surviving a restart with live sessions.

## The second thing on this socket

The credential broker serves `/internal/credential` on the same socket, for the
same reason the hook uses it: **which socket a request arrives on is what
identifies the session**, and nothing in the request could be believed.

A second socket would have meant a second lifecycle, a second mount, and a
second place to get that reasoning wrong. See
[credential-broker.md](./credential-broker.md).

## The third thing on this socket: what the session is doing

Until now the only witness to a session's state was its pane, and
`src/fleet/host/watcher.js` records what that cost: the permission-mode line
is drawn whether the CLI is working or waiting, so "ready for input" matched a
session mid-tool-call and the apps showed "ready · idle" over a build. No
regex over pane text can tell "working quietly" from "wedged". The CLI can,
and its hooks say so — every hook receives the session's own `session_id`,
`transcript_path`, `cwd` and `permission_mode` on stdin, which is the shape
`sandbox/hook.mjs` already consumed for `SessionStart`.

So `sandbox/entrypoint.sh` registers the rest, each as `agent-session-hook
<event> [matcher]`, and they post to `/internal/session-event` on the same
socket with the same authority: the socket names the session, the body says
only what happened.

| Hook | What it means for a person | Phase |
|---|---|---|
| `UserPromptSubmit` | somebody typed | working |
| `PostToolUse` | a tool ran, so any permission prompt before it was answered | working |
| `PermissionRequest` | a dialog is up and needs an answer | awaiting |
| `Notification` `permission_prompt`, `agent_needs_input` | the same, said the other way | awaiting |
| `Notification` `idle_prompt` | at its prompt with nobody typing | ready |
| `Stop`, `StopFailure` | the turn ended; back at its prompt | ready |
| `SessionEnd` | the CLI exited | ended |

`src/core/activity.js` is the one table; `SessionManager.recordEvent` keeps
the last phase per running session and drops it on every launch, resume and
stop, so nothing said in one life of a container answers a question about the
next. `/api/state` carries it as `activity` on each running record, and the
watcher reads it there: where a record exists it decides `ready` and
`awaiting`; the pane still decides whether the CLI is painting (the idle
restart's gate, which no hook reports) and still catches the resume dialog,
which appears before the CLI has a session and so before any hook can fire.
A session from an older image sends nothing and is read off the pane exactly
as before.

A session can lie about its phase. It could already do everything that
decides — a notification, an "is it done" answer, the restart's exclusions —
by painting its pane, which is what these events replace, so nothing here
widens what a hostile session reaches. `test/activity.test.js`,
`test/hook-socket.test.js`, `test/watcher.test.js`.
