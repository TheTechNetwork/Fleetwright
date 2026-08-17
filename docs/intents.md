# The intent protocol, v1

The contract between the coordinator and a fleet host. This is the first thing
built, ahead of anything that would use it, because §5 of `design.md` flags it as
the one decision that cannot be retrofitted: cheap now, impossible once
something is passing strings.

Implementations:

| Side | File | Role |
|---|---|---|
| Coordinator | `agent-fleet/src/protocol/intents.js` | builds intents, rejects malformed ones early |
| Host | `agent-hub/src/adapters/fleet.js` | **enforces** — validates again on arrival, then dispatches |

## The principle

**The coordinator sends intents, never commands.** Down the socket goes

```json
{"v":1,"kind":"intent","id":"01J8…","verb":"resume","params":{"name":"bigjob","choice":"summary"}}
```

and never a shell string, never a command line, never a path.

The failure being designed against is not a bug in the coordinator. It is the
coordinator **compromised outright** — a bad deploy, a leaked API token, a
dependency — while it is driving boxes that run unsupervised shells with
`--dangerously-skip-permissions`. With a fixed verb set the blast radius of that
is *"someone started and stopped some sessions."* With command strings it is
every box in the fleet.

## Where the authority lives

The two implementations are separate on purpose, and the asymmetry is the point.

The coordinator's copy is a **convenience**: it builds well-formed intents and
catches mistakes before they hit the wire. It is not a control, because a
compromised coordinator would simply not call it.

The host's copy is the **enforcement**, and behind it agent-hub's command
registry is a second allowlist. It must not depend on the other end being
honest, which is why it re-validates everything rather than trusting a `checked`
flag or a signature over a payload it did not itself parse.

The two are allowed to drift. The failure mode when they do is safe in the
direction that matters: anything the host does not recognise is refused. `v` is
how they stay in step — **change the verb table, bump the version.**

## Envelope

Coordinator → host:

```json
{
  "v": 1,
  "kind": "intent",
  "id": "01J8ZK3QH4",
  "verb": "resume",
  "params": { "name": "bigjob", "choice": "summary" },
  "issuedAt": 1755400000000,
  "actor": "telegram:12345"
}
```

| Field | Rule |
|---|---|
| `v` | must equal `1`. A mismatch is refused, never guessed at. |
| `kind` | `"intent"`. |
| `id` | **idempotency key**, `[A-Za-z0-9._:-]{8,128}`. Required on every intent. |
| `verb` | one of the eight below. Checked with `hasOwnProperty`, so `toString` is not a verb. |
| `params` | object. **Unknown keys are refused, not ignored** — see below. |
| `issuedAt` | epoch ms. Bounds replay when the host passes `maxSkewMs`. |
| `actor` | optional, `[A-Za-z0-9._:@-]{1,128}`. Becomes `fleet:<actor>` in `createdBy`. |

Host → coordinator:

```json
{ "v": 1, "kind": "reply", "id": "01J8ZK3QH4", "ok": true, "text": "…", "sessions": [] }
```

`replayed: true` marks a reply served from the idempotency cache. A refused
intent also carries `error: {code}` — one of `bad_envelope`, `unsupported_version`,
`unknown_verb`, `bad_params`, `stale`, `internal`. A reply is always sent: a
coordinator that gets no answer cannot tell a refused intent from a dead host,
and "dead host" is the one it retries.

## The verb set

| Verb | Params | Mutating | Maps to |
|---|---|---|---|
| `list` | — | | `/list` |
| `status` | `name?` | | `/status [name]` |
| `peek` | `name`, `lines?` (1–500) | | adapter-local — `sessions.peek()` |
| `health` | — | | adapter-local — host telemetry |
| `start` | `name?`, `mode?` (`safe`\|`dangerous`) | ✅ | `/new [name] [--safe\|--dangerous]` |
| `resume` | `name`, `choice?` (`summary`\|`full`) | ✅ | `/resume <name> [summary\|full]` |
| `stop` | `name` | ✅ | `/stop <name>` |
| `forget` | `name` | ✅ | `/forget <name>` |

`peek` and `health` are the only two that do not route through `dispatch()`, because
they are reads of host state rather than actions on a session. Everything else
goes through the same registry Telegram and the web UI use, so a fleet command
cannot work differently from the same command typed into chat — or exist when
that one does not.

### Two deliberate exclusions

Both look like oversights. Neither is.

**No `login` / `code`.** agent-hub can authenticate its own box from chat, which
is genuinely useful there — it is what lets a coworker stand up an instance
without SSH. Reachable from the coordinator, it means a compromised coordinator
can point a box at an attacker's Claude account, or harvest an authorization
code mid-flow. That is far outside "started and stopped some sessions", and it
is not worth the blast radius to save one SSH session on a box that needs
re-authenticating.

**No path parameter anywhere.** agent-hub's `/new <name> <path>` accepts any path
with no validation (a known gap, §1), and a sandboxed session's working
directory is a fixed `/work` mount anyway (§2). Leaving the parameter out
*removes the question* rather than answering it: the coordinator has no way to
express "start a session in `/etc`", so no validator on the host has to be
correct about it.

Also not expressible: the resume dialog's third option, "Don't ask me again".
It flips a global preference for every future session, interactive ones
included. agent-hub refuses to offer it; the protocol cannot name it.

## Rules worth stating

**Unknown parameters are refused, not ignored.** Ignoring is the friendlier
default and the wrong one here. A parameter the host silently drops is a
coordinator and a host that disagree about what a command means — and a fixed
verb set exists precisely so that they cannot.

**A name can never become a flag.** The name charset is anchored at the first
character (`[A-Za-z0-9]`), which is load-bearing rather than cosmetic:
agent-hub's `parse()` treats any whitespace-separated token beginning with `--`
as a flag, so a session named `--dangerous` would turn `/stop --dangerous` into
a flag with no argument, and `/new --dangerous` into a permission override.
Anchoring makes this impossible by construction instead of by careful quoting
downstream. The same anchor is what stops `../escape` being a name.

**The command line is built, never received.** `toCommandLine()` assembles it
from literals in the host's own source plus values that have already been
charset-checked. There is no point at which a coordinator-supplied string
reaches a shell, a tmux argv, or even the command parser as anything but a
single token.

**The idempotency key belongs to whoever owns the retry.** `buildIntent()`
requires one rather than generating it — a key minted per call is a new key on
every attempt, which makes it decoration. The point is that the *retry* of a
`start` carries the key the first attempt did.

**A replayed `/stop` is harmless; a replayed `/new` is not** — it burns a slot
against the concurrency cap and starts work nobody asked for twice. So the host
caches mutating replies for 10 minutes, keyed by `id`. It caches the *promise*,
not the result, so a retry arriving while the first attempt is still in flight —
which is exactly when a retry arrives — waits for that attempt instead of
starting a second session. Read-only verbs are never cached: a stale session
list is worse than a re-read.

## What this does not cover

- **Origin pinning** is the transport's job (§5: "the agent pins the expected
  coordinator origin"). The adapter refuses to start without one, but does not
  itself verify it — that belongs where TLS and the credential live.
- **Authorization.** Authenticating the actor does not answer *which sessions
  this actor may touch*. The `actor` field carries the id through to
  `createdBy`, which is what makes per-session ownership buildable later; the
  policy itself belongs in the coordinator, where it is one chokepoint instead
  of N hosts.
- **Host → coordinator events** (a session hit a prompt, finished, errored —
  §3's third meaning of "wake"). `kind` is reserved for it; nothing implements
  it yet.
