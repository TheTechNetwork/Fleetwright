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

**The pre-filled permissions err toward the work succeeding.** The first pass
ticked the minimum that came to mind — `repo,workflow,read:org` and
`workers_scripts,workers_kv_storage` — and that set would not have let a
session do the week it was written in: a custom domain needs DNS on the zone,
deploying the Worker needs routes, and `wrangler tail`, which is how this fleet
gets debugged, needs its own read.

A missing permission fails **inside a session, hours later**, with a provider
error nobody reading it has the context to interpret. An unused permission
costs nothing until it leaks — and it is the person's own token, on their own
account, revocable by them, which is the whole reason this design was chosen
over holding credentials ourselves. Both screens say the list can be unticked,
because an unstated trade is just a broad token.

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

## A token is the person's, not the box's

The first version stored a token per person **on one host**, and the screen it
produced said *"Credentials on deb13-staging"*. That was an honest description
of what the code did and the wrong model — corrected in one line:

> Creds should be per user not per host.

A GitHub token belongs to a person. Connecting it again on every box, and again
on each box enrolled later, is exactly the bookkeeping a fleet exists to
remove. So `link` and `unlink` for a **token** provider now fan out to every
reachable host, and the screen says *"Your credentials"*.

**Claude stays per machine, and the difference is a fact rather than a
preference.** Claude's flow is an OAuth login the CLI drives *in a pane on one
box*: `connect` starts it there and `link` types the code into that same pane.
A second step landing elsewhere would type a live credential into a box that
never asked for one. GitHub and Cloudflare have no such state — the token is
minted on the provider's page and the host only stores it — so the same paste
is correct everywhere at once.

An explicitly named host still wins. Fanning out is the default, not a rule.

**Still open:** a host enrolled *later* does not get tokens connected before it
joined, because nothing holds them centrally to replay — and nothing should,
under the custody argument in [trust.md](./trust.md). The right fix is envelope
custody: the coordinator holds a copy encrypted to each host's public key,
which the host keys make possible and which is already on that document's list.
Until then, connecting again after adding a box is the gap, and it is one tap
rather than the old one-per-box.

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

## A provider app would delete this flow rather than improve it

Asked: with a GitHub App — or a Cloudflare equivalent — would this be more
streamlined? Yes, and the size of the difference is worth being exact about,
because it is not "fewer taps".

| | pasting a token today | a GitHub App |
|---|---|---|
| 1 | open the token page | open the install page |
| 2 | review scopes, set an expiry | pick repositories, Install |
| 3 | generate, **copy** | — |
| 4 | come back to the app | — |
| 5 | **paste** | — |
| 6 | we verify and store | GitHub redirects back; done |

**The person never sees a credential.** Every piece of design in this document
that exists because of the paste — the numbered steps, the one-tap paste
button, "replace means delete the old one first", the stored scope list so we
can say a token is short — is scaffolding around a step that an app removes.

Three other problems go with it:

- **Revocation becomes real.** Uninstalling the app, or changing which
  repositories it can see, happens in one place on GitHub and we are *told*.
  Today neither provider will let us revoke on somebody's behalf, so "replace"
  is an instruction rather than an action.
- **Permission drift becomes GitHub's job.** When the asked-for list grows,
  GitHub prompts existing installations to approve the change. That is a
  first-class mechanism replacing the `missing:` line this repo had to invent.
- **Scope stops being account-wide.** A classic PAT with `repo` can reach every
  repository the person can. An installation sees the ones they chose.

### But the private key is the catch, and it is the same catch as before

A GitHub App's private key mints installation tokens **for every installation of
that app** — every member, every org that installed it. One key, everybody's
repositories. Replicating that to each host would be strictly worse than the N
copies of a per-person token we have today: a single host compromise would
reach every member rather than that host's.

So installation tokens want ONE holder, which under
[trust.md](./trust.md) cannot be the coordinator and does not yet exist. That
is the broker, again, and it is why the order there is broker first.

**The shape that works before the broker exists is user-to-server OAuth on the
App.** The person authorizes; what comes back is an eight-hour access token and
a refresh token, and the refresh token is stored per person exactly where the
PAT lives today. The blast radius is then the same as today's — one person's
credential per host — while the access token is eight hours instead of
indefinite, scoped to chosen repositories, and revocable from a screen they
already know. The client secret required to refresh is not a credential to
anything on its own, which is what makes it tolerable on a host in a way a
minting private key is not.

### Claude: redirecting to the HOST, checked rather than assumed

The suggestion was sharper than the one answered below: not "redirect the token
to the app", but **redirect it back to the host** — which is where it has to end
up anyway, since the PKCE verifier lives in the pane there. That would remove
the paste AND the round trip, which is the whole prize.

It cannot be done, and the reason is now checked rather than reasoned about.
On **Claude Code 2.1.234**:

```
$ claude auth login --help
Options:
  --claudeai       Use Claude subscription (default)
  --console        Use Anthropic Console (API usage billing) instead
  --email <email>  Pre-populate email address on the login page
  --sso            Force SSO login flow
```

**There is no redirect flag.** And the URL the CLI mints, observed live, is
`https://claude.com/cai/oauth/authorize?code=true&client_id=…` — `code=true` is
the CLI asking for the out-of-band flow, which is *by definition* the one that
ends in a code somebody carries back by hand.

So there is nowhere to redirect to and no way to ask for one: the redirect
target belongs to Claude Code's OAuth client, not to us. Worth re-running that
`--help` after a CLI upgrade rather than trusting this paragraph — it is one
command, and a flag appearing is exactly the kind of change that would make
this section wrong.

### Claude: the same idea, blocked by not owning the client

Suggested: pass the token back to the app in a URL, the way the App flow does.
That is exactly the right instinct — an OAuth redirect to a scheme the app
registers is precisely what removes a paste, and it is what makes the GitHub
flow above a two-step.

**It does not work for Claude, and the reason is worth writing down so nobody
re-derives it.** The authorize URL is not ours:

```
https://claude.com/cai/oauth/authorize?code=true&client_id=…
```

That `client_id` is Claude Code's. **A redirect target belongs to the OAuth
client**, and we are not it — we cannot register `fleetwright://` against
somebody else's client, and asking Anthropic's page to send a code to an app it
has never heard of is the thing OAuth exists to prevent.

The second half is harder still. The **PKCE verifier lives on the host**, in
the pane the CLI is running in. Even if the app received the code by URL, it
would still have to hand it to that host — which is what it does today after a
paste. So the redirect would remove the copy, not the round trip.

Removing the copy is a real win and worth having. It is just a smaller one than
the GitHub App's, and it is gated on something Anthropic controls.

**A device-authorization flow (RFC 8628) is the obvious next suggestion, and it
is worse than the paste.** This document recommended it for about an hour;
the correction is kept rather than edited away, because the reasoning that
produced it is the reasoning somebody else will produce.

The appeal is real: the page shows a short user code, the person confirms
there, the CLI polls, and nobody copies anything back. What it costs is the
property that makes the paste safe.

**Device-code phishing is an active attack class, not a theoretical one.** An
attacker starts the flow, sends the victim the genuine verification URL and the
genuine user code, and the victim approves. Every signal anybody is taught to
check passes — real domain, real TLS, real provider page — and the thing being
approved is *an authorization somebody else initiated*. It has been used at
scale against Entra and Google, and there is no version of the screen that
fixes it, because the screen is not lying.

A pasted token has no such step. The person navigates to the page themselves,
creates a credential, sees the scopes, and hands it over deliberately. **Consent
is bound to an action they started.** That is a stronger property than a shorter
lifetime.

And the premise does not even hold here. RFC 8628 exists for devices that
*cannot show a browser* — a television, a CLI on a headless box. The person
using this app is holding a phone with a browser in it. Adopting device flow
would import its attack surface without needing the thing it was invented for.

So the ranking, for this product:

1. **A provider app** (GitHub). No credential crosses a person at all, and
   consent is bound to an install they initiated.
2. **A pasted token.** They created it, they saw the scopes, they chose to hand
   it over.
3. **Device flow.** Shorter-lived, and approvable by someone who was phished
   into it.

Which means the paste is not a wart waiting for a better mechanism. For Claude,
where no app program exists, it is the correct end state — and the work worth
doing is making it clear and quick, not removing it.

### Cloudflare has no equivalent, and that keeps being the pattern

There is no public program for a third party to be a Cloudflare "app" the way
there is for GitHub. `wrangler login` is OAuth against Cloudflare's *own*
client, which is not a door open to us. So Cloudflare stays paste-a-token —
which is the same asymmetry [trust.md](./trust.md) already records for minting:
GitHub hands out an authority weaker than an account credential, and Cloudflare
does not hand one out at all.

**Worth verifying before building rather than taking from here**, since a
provider adding a program is exactly the kind of thing that changes quietly.

So the paste flow is not wasted work: it is what Cloudflare keeps, and what
GitHub uses until the App exists.

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
