# Connecting credentials: Claude, GitHub, Cloudflare

What a session needs to do its work, connected from a phone, by the person who
owns it. Three verbs — `connect`, `link`, `unlink` — and a table of providers.

Written when the last verb landed. It is also the thing guest onboarding was
blocked on, and the reason is worth stating first because it drove every choice
below: **a guest brings their own accounts and has no shell on any box.** For
them "SSH in and run `claude login`" is not a smaller inconvenience. It is the
feature missing.

## The shape every provider shares

1. A URL that opens the provider's **own** page, with the scopes pre-filled.
2. The person creates the credential, on their account, under their own eyes.
3. They paste it back once.
4. It is **verified with the provider before it is stored**, so a typo fails
   there and then rather than four hours into a session.

No OAuth app of ours, no client secret, no callback URL, and nothing of ours in
the middle of their consent screen. The cost of that simplicity is that the
credential is a real token sitting on a real box — see "What this is not",
below.

## Why three generic verbs and not `login`/`code`

The roadmap called this "the `login`/`code` verb", after the two chat commands.
Building it that way would have been wrong, and the ask said so first:

> Cloudflare api can be generated via a custom url so created in app, same with
> GitHub, **same with many others**.

So providers are **data**, not protocol. Adding one is a row in
`src/core/connectors.js`. It costs no verb, no protocol version, no App Store
release and no Play release — because both apps render their picker from the
catalogue the **host** publishes, and neither contains the word "GitHub"
outside a comment.

| verb | what it does |
|---|---|
| `connect` | bare: what could be connected and what is. With a provider: begin, and return a URL |
| `link` | finish, with the token or the authorization code |
| `unlink` | forget it here. **Does not revoke it at the provider** |

Each maps onto a chat command that already existed, so a fleet command still
cannot behave differently from the same command typed into chat:

```
connect claude scope=me    → /login for <email>
connect claude scope=host  → /login force
connect github             → /connect github
link claude <code>         → /code <code>
link github <token>        → /link github <token>
unlink claude scope=me     → /accounts remove <email>
unlink claude scope=host   → /login logout
```

**No version bump.** These are new verbs, and an old host answers `unknown_verb`
— a named refusal that strands nothing. Adding a *parameter* would have been the
flag day. That rule was written down last round and this is it paying for
itself.

## Whose credential, and why that is not a parameter

`intents.js` used to carry a note explaining why `login` must not be reachable
from the coordinator: a compromised Worker could point a box at an attacker's
Claude account, or harvest a code mid-flow. **Half of that was answered and half
of it is still true**, and being clear about which is which is the whole
security story here.

**Answered — the aiming.** There is no `email`, `account`, `user` or `owner`
parameter anywhere in the verb set. `scope: me` means *the verified actor*, an
identity the **host** derives from the actor string the coordinator resolved
against an ID token. A caller can say *what* to connect and never *whose*. A
test refuses any identity-shaped parameter name on any verb, because the way
this property would be lost is somebody adding an innocent-looking convenience.

**Still true — the page.** A compromised coordinator can show somebody a
different authorization page and harvest what they paste into it. That is real.
What bounds it is that the same compromised coordinator can already `start` a
session on that box in dangerous mode, and read `~/.claude/.credentials.json`
out of it. `connect` does not widen the blast radius; it is inside it. The
credential-terminating proxy in [trust.md](./trust.md) is the answer that
actually removes this, and it has not been built.

**`scope: host` is admin-only**, checked at the coordinator — the host receives
an actor, not a role, and a role it cannot verify is a role it must not act on.
Being precise about what that buys: it stops a **member** from replacing the
shared Claude account every other session on that box runs on. It is not a
defence against a compromised coordinator, which is the party performing the
check.

## A member gets their own tokens or none

Deliberately **not** the same rule as the Claude credential, and the difference
is the point.

| | fallback when nothing is linked |
|---|---|
| Claude | the **shared** org account |
| GitHub, Cloudflare | **nothing** |

A shared Claude plan is a licence somebody chose to share. A GitHub token is one
person's access to their own repositories, and handing it to a guest because
they happen not to have connected their own is exactly the thing that was ruled
out:

> To clarify the guests will be bringing their own GitHub Cloudflare Claude
> creds — no shared creds to them.

The box's own row exists and is used by actors with **no email** — the CLI,
Telegram, the web UI — all of which are somebody operating the box itself.

## What the first audit found, and what changed

Two real defects, both authorization rather than injection, both found by a
security review of the merged round. Written down because the *shape* of each
recurs.

**1. The host could not tell who was asking.** `emailFromActor` answers only
for `fleet:<email>` — the prefix is the marker of *"the coordinator verified
this against an ID token"*, and `/api/command` accepts a caller-supplied actor
otherwise, so a bare email there is a claim rather than a fact. The sidecar
built that prefixed form and spent it **only on a log string**, passing the
bare value to everything downstream. So every consumer that asked "who is
this" got `null`.

That had been quietly true for a while and had failed *safe* every time: a
member's linked Claude account silently fell back to the shared one, and the
coordinator's ownership filters simply never matched. Connectors was the first
consumer where the same `null` failed **open** — the store read `null` as *"the
box's shared row"*, so a member's pasted GitHub token overwrote the operator's
and was seeded into every other member's sessions.

The fix is one line at the sidecar. The *defence* is that `null` no longer
means the box: `rowForActor` returns three answers — a person, `HOST_ROW`, or
`null` meaning **refuse** — so "I could not tell who this is" can never again
resolve to a row other people read.

**2. A pending login could be finished by anyone.** `/code` completes whichever
flow is open on the box, and `startedBy` was recorded and never read. Survivable
while `/code` was reachable only from surfaces that already had the machine;
not survivable once `link` made it reachable by any member. An admin starts a
box login, a member sends their own authorization code, and every session on
that machine afterwards runs on an account the member controls.

Worse, `start()` refused a second login *with the first one's authorization URL
in the message* — which is what turned a race into a plan, since PKCE binds the
code to the pane on that box and without the URL there is nothing an outsider
can produce.

Both are now bound to the actor that started the flow, and the refusal is
**byte-identical** to "nothing is waiting" — a distinct "not your login" would
tell a member that somebody else's flow is open right now, which is the timing
half of the attack given away for free.

**And one gate that was not a gate.** `scope: host` is admin-only at the
coordinator, but the scope was never placed on the command line for token
providers — so `scope: host` and no scope produced an identical `/link github
<token>`, and the gate could be stepped around by omitting a parameter that
changed nothing. A permission check on a value the enforcing end never sees is
not a permission check.

## Where a secret lives

Exactly one file, `${stateDir}/accounts/<email>.env`, mode 0600.

What a phone asks for — *is GitHub connected, as whom* — is read from a
**separate** metadata file that has no token in it. Two files is not tidiness.
It is the difference between "we are careful when we serialise" and "there is
nothing there to serialise". Both apps' picker is built from that second file
and from a catalogue of public URLs.

**Seeded like the Claude credential**: at volume creation, so a resume keeps
what it began with and a rotation reaches the next session rather than reaching
backwards into a running one. The sandbox entrypoint exports it with `set -a`.
It is **not** passed as `-e` flags, because the podman command line is the tmux
pane's process and readable from `ps` by anyone on the box.

**A token that would need escaping is refused, not escaped.** The env file has
two readers with different quoting rules — `sh` understands `'\''` and systemd's
`EnvironmentFile` parser does not — so escaping correctly for one is escaping
wrongly for the other, and *which one mangles it* would depend on where the file
is being read. Refusing quotes, backslashes and whitespace removes the
disagreement rather than picking a side. A token with a space in it was a paste
that caught half the page anyway, which is what `login.js` already says about
the authorization code.

## The credential is not logged, and now that is true

`login.js` has always been scrupulous — "the code is never logged: it is a live
credential for the account being attached" — and three surfaces above it logged
the whole command line before the flow ever saw it:

```
http.js      log.info(`http: … → ${line.slice(0, 120)}`)
telegram.js  log.info(`telegram: … → ${text.slice(0, 120)}`)
sidecar.js   log.info(`sidecar: ${actor} → ${line}`)
```

So `/code <authorization-code>` had been landing in the journal since login
shipped. Nobody wrote a bug: the care was real and it was in the one file that
thinks about credentials, undone by three that think about logging. The same
shape as every outage in this repo — **true where it was written, quietly false
one layer up.**

It matters more since `logs` shipped. "Only somebody who already has the box can
read that journal" stopped being available as a fallback argument the moment a
journal became readable from a phone.

Redaction now lives in one table next to the command names
(`src/core/redact.js`), a tripwire test reads all three files for a `→ ${line}`
that skipped it, and it happens **before** the 120-character truncation —
slicing a secret short logs a shorter secret, not a safer one.

## Pinned to one box

`connect` and `link` are a **pair**: `connect` starts a login in a pane on one
host and `link` types the code into that same pane. A second step landing
elsewhere would type a live credential into a box that never asked for one, and
a fan-out would copy one paste to every host in the fleet. So they behave like
`logs`, `update` and `reboot` — one named box, and `ambiguous_host` when the
fleet has several and nobody said which. Both apps carry the host through.

## What this is not, said plainly

**It is not the proxy.** [trust.md](./trust.md) argues for terminating
credentials at a proxy that mints them per session, and that is still the right
long-term answer. This does not compete with it and does not delay it. What it
buys today is that a guest never holds anybody else's credential and never
needs a shell — which was the blocking constraint, not the ideal end state.

**Unlinking does not revoke.** Forgetting a token here removes it from this box.
It stays live on the person's account until they revoke it with the provider,
and the reply says so rather than implying otherwise.

**A session already running keeps what it was seeded with.** Same as `logout`,
which deliberately leaves running sessions alone: killing work as a side effect
of an account change is worse than the inconsistency.

**Classic GitHub tokens, for now.** Fine-grained tokens are the better
credential and their creation page **cannot be pre-filled**, so choosing them
today would mean handing somebody a bare settings page and a list of steps to
follow by hand. When GitHub supports pre-filling those, the table row changes
and nothing else does.
