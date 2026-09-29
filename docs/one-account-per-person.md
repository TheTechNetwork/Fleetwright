# The box has no Claude account

Asked for directly, after a host spent thirty hours signed out and the button
under the message signed in the wrong thing:

> The box's own login shouldn't exist, only users.

That is a simplification, and it is also the fix for a whole family of bug this
project kept producing. Writing down what it costs before it is built, because
three surfaces depend on the thing being removed.

> **Built.** `pickCredentialSource` has no fallback any more — a session whose
> actor has no linked account is refused, and says so — `operatorAccount()`
> answers for Telegram, the CLI and the web UI, and `adoptBoxAccount()` is the
> one-time migration that hands the box's old login to the person it belonged
> to. The sections below are left in their original tense because the cost
> accounting is why it was safe to do.

## What existed before this

Two kinds of Claude credential on a host:

| | where | who uses it |
|---|---|---|
| **shared** | the box's own `~/.claude/.credentials.json` | any session whose actor has no linked account |
| **linked** | `accounts/<email>.json` | that person's sessions |

`pickCredentialSource` falls back from the second to the first. So a member who
has not linked runs on the box's account, and so does every session started by
Telegram, the CLI, or the web UI.

## Why it goes

**It is a second identity for the same machine.** A host already has a keypair
that says which box it is; the Claude login says which *account* it is, and
those answer different questions that nothing needs asked together. Every
confusion this week came from the two being adjacent:

- A host row said *"NOT signed in — sessions will not start"* and its only
  action linked a person's account. Two logins, one button, and the button did
  the other one.
- `loggedIn: false` from the box's home directory marked a host degraded and
  unschedulable — while a perfectly good linked credential on the same box
  renewed itself every eight hours.
- `scope: host` existed, was admin-only, and was never reachable from any
  surface. Dead authority is worse than none: it looks like the answer.

**And it quietly shares a subscription.** `accounts.md` permits the fallback on
the grounds that "a shared org plan is a licence somebody chose to share". That
is true of an org and false of a guest — and the standing rule for guests is
that they bring their own everything. Removing the fallback makes that
structural instead of a policy nobody can see being applied.

**It also removes a whole failure mode from the fleet.** A host cannot be
"signed out" if it has no account to sign out of. What remains is a question
about a PERSON, which has a person-shaped remedy.

## What breaks, and the answer

Three surfaces produce an actor with no email, and today they all land on the
shared credential:

| actor | surface |
|---|---|
| `telegram:<id>` | the box's Telegram bot |
| `web` | the local web UI |
| `cli` | `fleetwright new` on the box |

These are all **somebody operating the box**, and the honest fix is to say who
rather than to invent a machine identity for them.

**The operator is the single linked account, when there is exactly one.** Zero
configuration, unambiguous, and it degrades into a clear question rather than a
wrong answer: with none linked, a local session refuses and says to link one;
with two or more, it refuses and says to name one. `FLEETWRIGHT_OPERATOR=<email>`
settles the ambiguous case and is needed only there.

That is not the shared account under a new name. It is a **named person's**
credential, attributed to them, revocable by them, and visible as theirs — which
is every property the box account did not have.

## Migration, which must be silent

A host running today has a working shared credential and possibly no linked
accounts at all. Breaking it on update would be the worst version of this.

So on first run: **if a shared credential exists, adopt it** into the account
row for the email it already names — `~/.claude.json`'s `oauthAccount` carries
it, and that is the same field already relied on for seeding. The credential
does not move or change; it acquires an owner.

After that the box's copy is never consulted again. A fleet where everybody was
already running on the org account keeps running on it, under the name of the
person it always belonged to.

## Direct sessions too

The first apt-installed box found the half that had not been built. Sessions
there run directly on the host (no podman), the app linked an account and
requested a session — and it came up on Claude's first-run wizard asking how
to log in. The sandbox path seeds the chosen credential into the session's
volume; the direct path had gone on reading the box's `~/.claude`, which this
document had already declared empty.

A direct session now gets its own Claude configuration, the way a sandboxed one
gets its own volume: `${stateDir}/direct/<name>`, pointed at with
`CLAUDE_CONFIG_DIR`. It holds the person's credential and identity (the CLI
decides logged-in-ness from the pair), onboarding declared complete, the trust
for the session's working directory, and the SessionStart hook copied from the
box's own `settings.json`. A resume keeps its account and takes today's
credential. Nobody linked is the same refusal the sandbox gives, naming the
box. The box's `~/.claude` is not read for a session and not written by one.

So `fleetwright doctor` no longer has a "claude logged in" row: it has "a
Claude account to run sessions as", which is any linked person. The box's own
login is one way to get one — it is adopted into a linked row at start-up —
and not a requirement.

## What this does not change

- **Sandbox seeding**, which already copies a chosen credential into a volume.
  Only the choosing changes.
- **The renewal ladder**, which already renews per account and, on a real box,
  renews linked accounts fine while failing on the shared one.
- **`scope: host` on the wire.** The parameter keeps being accepted and starts
  being refused with a reason. Removing an enum value is the flag-day
  direction — an older coordinator sending it would get `bad_params` after the
  handshake had already agreed — so it is accepted and answered instead.
