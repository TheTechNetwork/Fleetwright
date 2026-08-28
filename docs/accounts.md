# Whose Claude account runs the work

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

**2. Linking an account.** `/login` already runs the Claude OAuth flow and lands
a credential; today it logs in *the box*. The same flow, run by a person holding
a device credential, writes to `accounts/<their-email>.json` instead. No new
protocol, no new consent screen, no new secret handling — the flow that exists
is the flow that is wanted, pointed somewhere else.

**3. Seeding from it.** `seedCredentials()` takes the per-person file when there
is one and the shared one when there is not. One `if`, in the place that already
does this.

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
