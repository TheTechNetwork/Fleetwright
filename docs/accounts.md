# Whose Claude account runs the work

> **Superseded in part by [one-account-per-person.md](./one-account-per-person.md).**
> The shared box credential described below is gone: a session runs on the
> account of whoever started it, and a local surface runs as a named operator.
> The fallback this document defends — "a shared org plan is a licence somebody
> chose to share" — is exactly what was removed, because it was true of an org
> and false of a guest. Everything here about SEEDING, refresh and custody still
> holds; only the choosing changed.

Asked for: a **shared org account at the coordinator**, **per-user accounts**
for people who bring their own, and a **fleet admin** who can see everything and
can let a friend or a client use the fleet under their own Claude account.

## The hinge is smaller than it looks

A sandboxed session already gets **its own `claude-<name>` volume**, and on
first creation the host copies `cfg.sandboxCredentialsFile` into it. So the
Claude account is *already* per-session at the filesystem level. It is simply
always seeded from the same file.

**Bringing your own account is therefore a change to which file gets seeded**,
not a new architecture. That is the whole feature, and everything below exists
to make that one choice safely.

```
   session starts
        │
        ├── who asked?           the verified email, from the coordinator
        ├── have they linked?    ~/.agent-fleet/accounts/<email>.json
        │        yes ──▶ seed that
        │        no  ──▶ seed the shared org credential
        └── record which was used, on the session
```

## Three layers, and they are not the same question

People conflate these, and every wrong answer here comes from doing so.

| | what it answers | where it lives today |
|---|---|---|
| **Fleet identity** | may you talk to this fleet at all | OIDC → `AGENT_FLEET_AUTH_ALLOW` → a per-device credential |
| **Role** | may you do destructive things, and whose sessions may you see | `client.admin`, set for the first person in |
| **Claude account** | which account the work is billed to and runs as | **new** — the file seeded into the session's volume |

A person can be on the fleet without having linked an account (they get the
shared one), and can have linked one without being an admin. Keeping the three
separate is what makes "a client can use my fleet with their own account"
expressible at all.

## What already exists

- **Fleet identity**: verified email, allowlist, per-device credentials. Done.
- **`admin`**: on the client record, gating `DELETE` on hosts and clients in
  both coordinators. Done, and deliberately two levels rather than a role
  system — see the comment in `core.js`.
- **Attribution**: `createdBy` on every session record. *Was* the literal
  string `web` for every HTTP caller, which made "whose session is this"
  unanswerable. **Fixed here**, because nothing else can be built on it.

## What this adds, in order

**1. Attribution — done in this change.** The sidecar already held the verified
identity and threw it away one hop from the record. It now travels as a field
beside the command, the same way `title` and `brief` do, and for the same
reason: an identity with an `@` in it must not be split on whitespace and read
as arguments.

**2. Linking an account — done.** `/login for <email>` runs the same OAuth flow
in an **isolated `CLAUDE_CONFIG_DIR`**, so the box's own login is never
touched — without the isolation, linking a client's account would log the whole
box out of the org account, the exact machine-wide blast radius accounts exist
to end. On success the credential moves into `accounts/<email>.json`; `/accounts`
lists and unlinks.

**3. Seeding from it — done, and it taught us something.** A credential alone is
**half a login**: the newer CLI decides logged-in-ness from the *pair* of
`.credentials.json` and the `oauthAccount` block in `.claude.json`. Seeding one
without the other produced sandboxes answering "not logged in" while holding a
perfectly valid token — diagnosed from a phone screenshot, because the RC
timeout message carries the pane's own diagnosis now. So the identity travels
with the credential everywhere: harvested at link time, derived from the shared
login's home for everyone else, seeded into the volume, and merged into the
container's state file **on every start** (that file is container-ephemeral;
a one-off merge survives exactly one run). Each session records which account
it was seeded with.

**And the copy goes stale, which is the second thing it taught us.** For a long
time this file said a resume never re-seeds, "which is what keeps a session on
the account it began with". The account had to be kept. **The bytes were never
the account.** An OAuth access token has hours on it and its refresh token gets
rotated when the host renews, so a copy taken on Tuesday is not a credential by
Thursday — it is a receipt for one. The symptom was a box where a brand new
session worked and a week-old one resumed logged out, on the same account, on
the same machine, with the only difference being *when* the copy was taken.

So the account is pinned and the credential is not: **a resume re-seeds, for
the account the volume already holds.** Whose that is has three answers and not
two — the registry record, or failing that the volume's own
`.oauth-account.json`, or failing both, nothing at all. Guessing would silently
move a session onto a different Claude subscription, which is worse than the
staleness. Two refusals are deliberate: an account unlinked since the session
started is *reported*, never substituted with the shared one; and a host
credential that is itself expired is not copied over the session's, which might
still hold a refresh token that works.

The provider tokens — GitHub, Cloudflare — ride along on a **separate key**,
because "whose Claude account" does not answer "whose GitHub token": a person
with no linked Claude account runs on the shared one and still gets their own
repositories. That key is the actor who *started* the session, off the record,
never the actor pressing resume — otherwise a colleague resuming somebody's
work quietly lends it their credentials.

**And something has to ask.** A credential renews when it is USED, and nothing
on an idle host uses one — no session is running, which is what idle means. So
it goes stale precisely when it must not: at the moment somebody starts a
session on a box that has been quiet since yesterday. That is the whole of
*"deb13-staging wouldn't work until I clicked sign in again"* — signing in
worked because signing in is a use.

`src/core/keepalive.js` runs hourly and is **a ladder, cheapest rung first**:
`claude auth status`, which is free and may renew as a side effect of asking,
and then a one-shot prompt, which costs a few tokens and unambiguously
exercises the credential against the API. It stops at the first rung that
works, so an idle box normally pays nothing, and it does not run at all on a
credential with hours left.

**Two windows, not one**, and the second was missing until it was tested on a
real box. `within` (four hours) is when it starts *asking*; `urgent`
(forty-five minutes) is when it starts *spending*. They have to differ because
**we do not decide when a token refreshes** — the CLI does, and an OAuth client
renews near expiry rather than whenever it is asked. Between the two, the
honest expectation is that nothing happens.

With one window that was two bugs at once: the paid rung fired every hour for
four hours buying nothing, and each of those logged a warning saying the
mechanism had failed. A warning that fires four times per token on a healthy
box is one nobody reads by the second day — and it was the same warning that
means something is genuinely wrong.

**A token six hours from expiry is healthy, not stale.** It cannot be topped up
early, by us or by anybody, so `/verify claude` says when the box will start
trying rather than leaving somebody watching a number that is not going to
move. And **a session can never renew the box's own credential**: a sandboxed
session works on a copy inside its volume, so any refresh the CLI does in there
updates the copy and never the original.

**The verdict comes from the credential file, never from an exit code**, and
that is the only reason this is safe to ship. Every one of those commands can
succeed without renewing anything — which is exactly what `auth status` was
doing for weeks, called every twenty seconds by the watcher, while credentials
expired underneath it. So the expiry is read before and after and the question
is whether it *moved*, and moved *later*: a CLI that rewrote the same token
would change the mtime and grant nothing. When nothing moves, the log says so,
which is a bug report rather than a silent success.

It is deliberately **not a session**, though a session would also work. A
session is a container, a volume, a tmux pane, a registry record, a watcher
entry, a bin entry and an idle-restart candidate — every one of them blast
radius for something whose entire job is to make one HTTPS request.

Linked accounts are renewed too, staged into an isolated `CLAUDE_CONFIG_DIR`
and written back only if they gained life. They go stale *worse* than the
shared credential: the shared one is exercised whenever anybody on the box
works, while a guest's account that has not started a session this week is used
by nothing at all.

**GitHub does not work this way, and building the same fix for it would have
achieved nothing.** A GitHub App user token is not renewed by being used; it is
renewed by exchanging a refresh token, explicitly, against
`POST /login/oauth/access_token`. A thousand API calls extend it by zero
seconds. We used to receive that refresh token at the end of the OAuth flow and
throw it away, because there was nowhere for it to live — so every App
connection was dead eight hours after it was made, and reconnecting was the
only remedy.

**The material now goes to the host, and that is `trust.md`'s rule rather than
a convenience:** *"spreading minting keys across hosts means a compromised host
costs that host's access; centralising them means a compromised coordinator
costs everything."* Keeping refresh tokens at the coordinator would make the
one internet-facing component hold every member's renewable GitHub credential,
which is the outcome that rule exists to refuse. A host already holds the
access token and already runs that person's sessions.

**Three files now, and the split is the whole custody argument:**

| file | who reads it |
|---|---|
| `<row>.env` | what a **session** gets — sourced into every container |
| `<row>.connections.json` | what a **phone** may see — no secret in it at all |
| `<row>.renewal.json` | what only the **host** may use — mounted nowhere |

A refresh token in the env file would be handed to every session on the box,
and a session that leaked one would have leaked something that re-mints after
every revocation. The access token a session holds expires in eight hours; the
thing that replaces it must not travel with it.

It is a **deposit, not a schedule**: `renew` is sent once, when the connection
is made, and the host renews on its own timer from then on — so nothing has to
be scheduled anywhere it could be missed. **The client id travels with it**
rather than being configured, because an install question is a thing somebody
has to be told and the standing goal is to have none of them.

**Both halves or neither.** GitHub rotates the refresh token on every exchange
and invalidates the old one, so storing the new access token without the new
refresh token renews exactly once and breaks every renewal after it — eight
hours later, with nothing to point at. And a refused renewal leaves what is
stored alone: the access token still has time on it, and overwriting it with
nothing would turn *"this expires later today"* into *"this is broken now"*.

A new **verb**, not two more parameters on `link` — adding a parameter is the
flag day and adding a verb is free. An older host answers `unknown_verb` and
its connections behave exactly as they did before.

**Two ways to be signed out, and only one of them was visible.** `claude auth
status` reports on the box's own home directory; a sandboxed session runs on a
copy of a file. A box can report itself signed in and hand every new session a
dead token. `/api/state` now publishes what a session *would* get beside what
the box says about itself, health carries it, and the coordinator degrades a
host on it — but only when the token has expired **and** there is no refresh
token to renew it with. Expired-but-refreshable is the ordinary state of a box
nobody has touched for an hour, and a warning that fires on the ordinary case
is one people stop reading.

## Inviting somebody — done

Adding a person meant editing `AGENT_FLEET_AUTH_ALLOW` and deploying: a code
change per person, made by the one person who could already do everything. It
is a screen now (`docs/../src/fleet/coordinator/invites.js`), and the two lists
answer two different questions:

| | |
|---|---|
| the env allow list | **who this deployment belongs to.** Survives losing all state, which is what makes it the bootstrap: a coordinator with empty storage still knows its owner, so somebody can always let everybody else back in |
| invitations | **who that person has since invited.** Stored, revocable, no deploy |

**An invitation is not a credential.** It is permission to *attempt* a sign-in,
and the sign-in still has to produce a verified email from a provider the
coordinator trusts. Nothing here can be redeemed, replayed or stolen into an
account — the worst a leaked list does is say who was invited. There is no link
to send; you send them the app.

**And an invitation is never admin.** The admin seat is assigned once, to the
first person to sign in. An invited person is a member: they see their own work
and cannot invite anybody else, or "invite" would be a way to hand out the fleet
one step removed. Whole domains cannot be invited from a phone either — that
blast radius is invisible at the moment somebody taps, and the env list keeps
that power because editing it is already deliberate.

**Withdrawing does not sign anybody out.** A device credential already issued
keeps working until it is revoked, which is a separate act on a separate object.
The reply says so, because the gap is exactly where somebody would assume
otherwise.

**4. Visibility — done.** Admin sees every session; a member sees the ones
their identity created. **Filtered at the coordinator, never at the host.** The
host does not know who is asking — it has one token and answers it — so a
host-side filter would be a check performed by the party with the least
information. Unattributed sessions (telegram, the CLI, pre-attribution work)
belong to the fleet, which is to say the admin — erring open would quietly
break "my client must not read my org's other work".

**5. Ownership — done.** Acting follows reading: a member's `stop`, `resume`
and `peek` land only on sessions their identity created, checked in the
scheduler against the `createdBy` the health lists now carry. The refusal is
**byte-identical to "unknown session"**, with a test asserting the strings
match: a distinct "not yours" would confirm that a guessed name exists on
somebody else's work — an existence oracle built out of an access control. The
two layers enforce one rule, not two similar ones.

## What this is NOT, said plainly

**It is not isolation between people who do not trust each other.** Sessions run
as the same OS user on the host. Two people's sessions are separated by
container filesystems, not by uid, and a container escape crosses that. If
somebody needs real isolation from another user of the same fleet, they need a
different host — and that is a fine answer, because a host is just a box that
dials in.

**The host still holds every linked credential at rest.** Per-person accounts
change *whose* account is used and *who is billed*; they do not remove the
durable secret. That is the same recursion `trust.md` describes, and the same
answer applies: fewer, better-protected places.

**Attribution is only as good as the hub token.** agent-hub does not verify the
actor and cannot — it has one token, and whoever holds it can already run any
command as anyone. So the record says what an already-trusted caller claimed.
That is strictly better than `web`, which was never informative, and it is **not
an audit trail**. The verified check happens at the coordinator, and the
coordinator's own event log — which records the OIDC identity before placement —
is the thing to trust.

**Two levels is not a role system**, and should not become one until somebody
needs a third. The existing comment in `core.js` makes that argument and it
still holds: the day there is a real second axis, the shape will be obvious, and
guessing at it now would produce a role system that fits nobody.

## The invitation flow, once the pieces are in

An admin mints a pin or adds an address to the allowlist; the person signs in
with Apple or Google and gets a device credential; they run `/login` and link
their own Claude account; their sessions bill to them and only they and the
admin can see them. Nothing in that sequence needs a new concept — it is the
three layers above, used in order.

**The `/login` step is no longer a shell step.** It was the last one that
needed SSH, which made the whole sequence untrue for the people it was written
for: a guest brings their own accounts and has no shell on any box. Both apps
now carry it, along with GitHub and Cloudflare, via
[connectors.md](./connectors.md).

One rule there differs from this document on purpose, and it is the guest
constraint made mechanical:

> To clarify the guests will be bringing their own GitHub Cloudflare Claude
> creds — no shared creds to them.

A member with no linked **Claude** account falls back to the shared one,
because a shared org plan is a licence somebody chose to share. A member with
no connected **GitHub or Cloudflare** token gets nothing at all — those are one
person's access to their own repositories and accounts, and inheriting them by
default is precisely what that sentence rules out.
