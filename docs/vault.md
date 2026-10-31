# Your vault: each credential kept once

> I think we should centralize creds once and for all

Before this, a person connected GitHub, Cloudflare and Claude again on every
permanent box. Three boxes meant three copies of the same credential at rest.
Two boxes renewing one GitHub refresh token raced, and the loser signed the
person out. A box enrolled tomorrow had nothing.

Now each person keeps each credential once, in the fleet's **minting Worker**,
and approves the boxes that may hold it. A box asks for what it was approved to
hold, every ten minutes and before a token runs out, and loses it when the
person removes the box.

| what | kept as | a box is given |
|---|---|---|
| GitHub | the sign-in's access and refresh tokens | the access token, eight hours; renewed in the minter |
| Cloudflare | the sign-in's access and refresh tokens | the access token; renewed in the minter |
| Claude | the sign-in `claude auth login` makes, access and refresh token and the account, made on a machine and kept by the phone or the browser's signing page; or a `claude setup-token` | a sign-in's access token, its expiry and account, as the credentials file Claude Code reads; renewed in the minter. A setup-token as it is |
| named secrets | `secret:NAME`, any value up to 8 KiB | the value, by name |
| SSH keys | `secret:SSH_AUTHORIZED_KEYS`, public keys one a line, from You › Credentials › SSH keys | the value, as any named secret is; a machine made on the person's pool takes them on its `fleetwright` account ([hypervisors.md](./hypervisors.md), "Working a machine") |
| hypervisors | `hypervisor:ADDRESS`, the record a pool's setup handed the phone | the record, held in the sidecar's memory and never given to the hub or a session ([hypervisors.md](./hypervisors.md), "Machines from your pool") |

**Every credential a fleet person's session uses comes from here**, and from
nothing on the box: not a Claude account linked on it, not a GitHub token
linked on it. What is linked on a box is that box's operator's, for its own
command line. "Make every cred come from the minter" was asked after a person
forgot their Claude login in the vault and a runner lost it while a box went
on running on a copy of its own (see "On the box").

A box never holds a refresh token. Renewing happens in one place, inside the
minter's single Durable Object, under a lock per person, so however many boxes
ask at once a refresh token is rotated once (`test/vault.test.js` asks from two
boxes at the same moment and counts one renewal).

## From a browser

A member with no phone keeps their credentials from `/me`, which opens the
**signing page** the minter serves on a hostname of its own
([signed-intents.md](./signed-intents.md), "The browser"). Everything the
phone's Credentials screen does is there: what is kept and whether it works,
Forget, a named secret typed on that page, GitHub and Cloudflare kept by a
sign-in the page starts with a PKCE verifier only it holds, and the machines,
each with the fingerprint the page works out from the machine's key, to
approve or remove. A Claude sign-in is made on a machine the person picks:
the page signs both halves of `setuptoken` for that one machine, holds the key
the sign-in comes back sealed to, and keeps it here, so `/me` and the
coordinator carry ciphertext and a code a machine types, never the sign-in.

The page opens the vault with the GitHub sign-in it listed its key with, held
in that window's memory only; a window opened again signs in to GitHub again.
It offers Cloudflare only where the minter holds the client, its secret and
its registered scopes (`FLEETWRIGHT_CLOUDFLARE_SCOPES`, which the deploy
passes from the coordinator's config). `/me` used to link accounts on each
machine, which every machine now refuses; it carries the page's requests and
nothing else (`member-page.js`, `RELAYS`). A fleet with no signing page says
a browser cannot reach the vault, and its members keep credentials from the
app.

## Whether it still works

A vault used to say what it held and never whether any of it worked. A Claude
token that Claude had revoked, or one pasted with a character missing, sat
under *Kept* until a runner given it stopped at its first message, and that was
the first anyone heard of it.

**Test**, beside each kept Claude, GitHub and Cloudflare under You ›
Credentials, sends the op `test`. The minter opens the item and asks the
service it is for, and nobody else: the token goes only to whoever issued it.

| item | asked how | the answer |
|---|---|---|
| Claude | the one-token request a session makes, the same one `fleetwright verify claude` makes (`src/core/claude-token-probe.js`) | a 401 is rejected; an answer, a 429 or a 529 is accepted; anything else is cannot tell |
| GitHub | who the token belongs to, renewed first if it is due, as a box would be handed it | the login it answered as, or rejected on a 401 |
| Cloudflare | renewed, because a refresh is the one thing a sign-in of any scope can be asked; the new tokens are kept, as a box's ask would have kept them | renewed, or rejected when Cloudflare refuses the refresh |

A named secret and a hypervisor's record have no service the minter could ask
(a pool is on its owner's own network), so the minter refuses them as
`not_testable` and neither phone draws the button for them (C-2). The answer is
accepted, rejected or cannot tell, never the value, and a phone draws only
accepted as working: cannot tell is not evidence that it works (C-5).

**A Claude sign-in's test also says how it has been renewed.** Each renewal
leaves a note beside the sign-in (`claude-renewed:<id>`, the last twelve):
when it was asked for, by a box, a runner or a test, and what Anthropic said.
No token is in it. The note is written before Anthropic is asked and settled
after, so a renewal cut off in between is shown as cut off. Anthropic will
already have rotated the refresh token by then, so a cut-off renewal is this
fleet losing the sign-in itself. The test answer ends with the last renewal.
When a refusal follows a good renewal with nothing cut off or dropped in
between, it says the sign-in was ended outside the fleet: on claude.ai, or by
Anthropic. That is the question a sign-in on vnic-runner-oci raised with
"Refresh token not found or invalid", when nothing kept said when it had last
been renewed or by whom.

**A sign-in Anthropic has ended is told to its person, on their phone.**
Nothing told them before: the sign-in on vnic-runner-oci was found out when a
session would not start. Every fifteen minutes the coordinator's alarm asks
the minter (`POST /claude/check`), and the minter asks after every kept
sign-in itself (`checkClaude` in `src/fleet/minter/claude-login.js`):

- a renewal already refused, by a box, a runner or a test, is the answer;
- otherwise its access token is tried at the usage address, which costs
  nothing. A 401 there is renewed for at once instead of when due, and the
  token the renewal gave is tried in the same check: refused too, renewing
  will not mend it, so it is not renewed for again until it is due, and its
  person is told once. A 403 is never renewed for: it says the sign-in may
  not do this, not that the token ran out, and each renewal ends the token
  every box holds. Its person is told once for the sign-in. Both are listed
  in the check's answer as `refused`, with the status, apart from `ended`,
  because renewing still works;
- a sign-in that is due is renewed, as a box asking would renew it;
- nothing else is renewed.

**Why nothing is renewed before it is due.** For a while the check renewed a
sign-in ten minutes after keeping and hourly after that, to find a broken
refresh token in minutes rather than at the end of eight hours: two sign-ins
in a row had been refused at their first renewal, about 7.7 hours after
keeping. But a renewal ends the access token every box already holds
("Renewing revokes the token every holder has", below), and the boxes change
over together only because they all ask inside the same half hour before
expiry. A renewal at any other time cut every box off at once, hourly. So a
refresh token is tested when it is needed, and the access token is tried every
check, which costs nothing and ends nothing.

**A refresh token's own lifetime is kept.** Claude Code writes it beside the
sign-in as `refreshTokenExpiresAt`, and a renewal's answer may give it as
`refresh_token_expires_in`. The minter used to drop it. Now a sign-in is due
when either its access token or its refresh token is within thirty minutes of
running out. A renewal whose answer does not give it keeps it for a refresh
token that came back unchanged, and leaves it unknown for a new one. Claude
Code carries the old expiry over either way, but never renews because of it.
The minter does, and timing a new refresh token by the one it replaced renewed
again on every check and every box's ask. A refresh token a renewal gave back
unchanged, or new but ending as soon, is not renewed again for its own
expiry, since another renewal will not move it either. The Test's sentence says how long the refresh token is good for. A refusal
that comes after the refresh token ran out by its own lifetime is called this
fleet being late (`expired`), not something outside it.

Only Anthropic refusing the refresh token counts as ended. An access token can
be refused for reasons the refresh token survives, and the refresh token is
the one thing only signing in again mends. Anything else is cannot tell and
says nothing. Each ended sign-in is named once (`claude-ended:<id>`, keyed by
when it was kept), so the next sign-in kept is told about afresh. The
coordinator records `claude.ended` and pushes to the person's phones, and to
an admin's with whose sign-in it was. A sign-in whose access token Claude
refuses at the usage address, and which the minter is not renewing for, is
recorded as `claude.refused` and pushed the same way, once, saying what was
seen: the status, and whether renewing was tried. Renewing works, so it is
not called ended, and nothing is promised to mend it.

**The push says what the record says, and no more** (`renewalVerdict`). "Was
ended outside the fleet" is said only when nothing in the fleet renewed the
sign-in between its last good renewal (or its keeping) and the refusal. A
renewal Anthropic answered and this fleet never kept, because it was cut off
or dropped, ends a sign-in the same way. Then the push says this fleet lost it,
and when. The first notification said "outside" from the refusal alone, on
2026-10-26, with nothing checked.

The minter answers at most every ten minutes, whoever asks. A compromised
coordinator can ask more often and be told nothing new. It cannot make a
sign-in look ended, because the asking is done here against Anthropic. A
setup-token is not asked: it has no refresh token to end, and its scope does
not reach the usage address.

**A Claude token is asked before it is kept**, by the vault's `put` and by a
deposit alike (`checkBeforeKeeping` in `src/fleet/minter/claude.js`). A 401
keeps nothing and says `rejected_token`. An answer that cannot tell keeps it
and says so, rather than refusing a good token because the API was busy. The
tests answer for `api.anthropic.com` with a stand-in
(`test/helpers/stand-in-claude.js`), so no made-up token is sent to it.

**Forget asks first.** It was one tap, beside the buttons a person comes to
this screen for, and the Claude row's took the login out from under every
runner with nothing but a line of text afterwards. Both phones now open a
dialog that says what forgetting costs. The Claude rows on that screen are
Set up Claude's, so a machine can make the token there too
([runner-central.md](./runner-central.md), "Depositing one"), and the second
Forget button they had is gone.

## Who may ask, and how each one is checked

None of it is the coordinator's word. The coordinator relays ciphertext both
ways and adds one fact the minter checks against something else, and one it
can only take away with: who is still in the fleet ([below](#when-somebody-leaves-the-fleet)).

**A person**, from their phone, under *Runners from this phone*, *Your vault*,
or from a browser on the signing page (below, "From a browser"), which asks
exactly as a phone does.
Every request is sealed on the phone to the minter's key, which the phone asks
the minter for itself (see [The minter's key](#the-minters-key) below), with
the phone's own GitHub token inside. The
minter asks GitHub whose that token is, and that GitHub account is whose vault
it is. It must also be a token the phone signed in for through the minter
(Runners from this phone, *Sign in to GitHub*): the minter records each such
sign-in by the token's hash, and its renewals, and refuses any other token
with `not_a_device`. That is what keeps out the GitHub token the vault itself
hands every box you approve, which GitHub would also call yours, so a box you
removed, or a session on it, cannot approve a key of its own and hold your
vault again. A phone signed in before this was asked for signs out of GitHub
there and signs in again, once, and every phone did so once more when G11 was
closed (below): a sign-in recorded before then could not be told from one a box
had forged, so a record now carries a version (`SIGNIN_VERSION`), one without
it is no device's and renews into none, and the `not_a_device` sentence says to
sign out of GitHub under Runners from this phone and sign in again. Vault items
and approvals were not touched. A Claude deposit is held to the same rule,
except for the tokens a person's own command line has (`gho_`, `ghp_`,
`github_pat_`), which `fleetwright-claude-login` sends.

**Not a box's sign-in.** A device sign-in is recorded by the token's hash, not
by who finished it, and an operator box finishes the sign-ins it started for
people (the PKCE verifier is on the box; `#offerChallenges`, `#exchange`). So
the root or sidecar account of one of the operator's boxes could complete a
sign-in that the minter then recorded as a device of the person who signed in,
and approve a key of its own against that person's vault (the eighth audit,
`githubDeviceToken`, `vaultDevice`). Operator boxes are outside a member's vault
boundary, which is docs/security.md's G11 decided. Nothing in a code or a
verifier says which flow made it, and the coordinator is the one place that
knows which codes it relayed to a box: it keeps the SHA-256 of each for ten
minutes, at most 64, in Durable Object storage (`boxSignIns`), and lists them
beside every device's sign-in. The minter refuses a listed code before GitHub
is asked (`box_sign_in`), so the box can still finish there the sign-in it was
started for, and only a sign-in the person's own phone started becomes their
device. The list can only take away, as the members list does, and a
coordinator from before it sends none and is served as before. The request also names the fleet account it is for, and the coordinator
says which signed-in account sent it; the minter refuses unless the two agree.
The answer comes back sealed to a key the phone made for that one request.
Each change carries its time and is refused if it is older than ten minutes or
not newer than what is held, so a replay cannot undo a forget or a removal.

**A box**, approved by its person. Every box already has a P-256 key it proves
itself with on every connect (`src/fleet/host/identity.js`). Approving a box
names that key: the phone takes it from the fleet's list of boxes, works out
the fingerprint from the key itself, and shows it beside

> Approve a box only if fleetwright-sidecar identity on it prints the same fingerprint.

because a coordinator that wanted someone's credentials would list a key of its
own under a real box's name. The comparison is the one step that cannot be done
for the person. Once approved, the box asks with a request **signed by that
key**, and the minter gives it the items of every person who approved that
exact key (the whole SHA-256 of the key, not the sixteen characters shown),
sealed to a one-request key the box made. Replaying a box's request gets an
answer sealed to the box's own key.

```
phone ── sealed to the minter's own key: { github, email, op, at, reply } ──┐
                                                         POST /api/vault     │
box ──── signed by the box key: { hostKey, at, reply } ──┐                   │
                                         `vault` frame   │                   │
                                                         ▼                   ▼
                                    coordinator: relays, adds who sent it,
                                    checks the box key is the one it enrolled,
                                    lists who is still in the fleet
                                                         │
                                                         ▼
                        minting Worker, one Durable Object:
                          v:<github id>   items, sealed at rest; approvals by key
                          box:<key hash>  which people approved this key
                          gh:<github id>  the Claude login, as runners read it
```

**An approval can name what it holds.** A grant carries `only`, at most eight
item names, and the box is then given those items and nothing else of that
person's; the Claude login only when it is named. The phone writes one when it
lets a pool's own machine in: `only: ["hypervisor:<address>"]`, so the one
approval that lets it join lets it hold that pool's record and none of the
person's other credentials ([hypervisors.md](./hypervisors.md), "A machine of
its own"). The fingerprint step above is done by the phone there, against a
secret it made, because nobody can run a command on that machine to compare.
A grant without `only` is every item, as before.

**A grant with `only` is not approval for anything else.** When a phone checks
whether a box is already approved before it seals a sign-in to it, only a grant
without `only`, labelled with that box and carrying its whole key hash, counts.
A pool's own machine, let in for its one record, used to pass that check for
any sign-in, because the phone matched the first sixteen characters of the key
and ignored the scope (seventh audit, `PhoneVault`).

## When somebody leaves the fleet

A person is removed in the coordinator: their last credential is revoked, by
an admin or by their own withdrawal. The minter keeps their vault and their
approvals as they were, and beside every box's ask the coordinator lists each
fleet account that still holds a credential that works. A grant gives nothing
while the account that made it is not on that list: no item, no Claude login,
and no renewal, so their refresh token is not rotated again. The person drops
out of the box's answer, and the box deletes what it held for them on that
ask, as it does for a box removed from a phone. That is every box they
approved, their own included, within ten minutes. The fleet's own boxes do not
wait for that ask: a removal also sends each of them `forgetperson`, and the box
deletes what the vault gave it for them at once, with their sessions and
sign-ins there ([security.md](./security.md) G13).

Until the eighth audit the minter never heard of a removal. The hand-back
asked the fleet's boxes to `unlink` the person's sign-ins, which clears a
box's own links and not its copy from the vault, and the next ask wrote that
copy back, freshly renewed, for as long as the refresh token lasted. Nor
could the removed person withdraw a grant, because their vault requests need
a credential that works.

**Asked every time, not told once.** A forget sent to the minter at the
removal would be lost if the minter was unreachable then; a list sent with
every ask cannot be. **Filtered, not deleted.** A person who signs in again
is served again, with nothing to approve twice. **It can only take away.**
Leaving a member off denies, which dropping the request already could, and
listing somebody removed gives what every box was given before the list
existed. A coordinator from before the list sends none, and is served as
before.

What it does not do: delete anything. The refresh token stays sealed in the
minter, renewed by nothing, until the person signs in again or forgets it,
and an access token a box already handed a session lasts until it expires.
Revoking at GitHub or Cloudflare ends it there.

## On the box

The sidecar asks (`Sidecar#syncVault`) and hands the answer to fleetwright,
which writes it under `vault/` in its state directory: one 0600 file per
person, and the Claude token as a file of its own so a session's command reads
it with `$(cat …)` and never carries it. Written whole on every answer, so a
person who removed the box, or emptied their vault, is gone from it on the
next pass.

**A change reaches the boxes in a moment, not at their next ten minutes.**
When somebody keeps, forgets, approves or tests something, the minter's answer
says `changed` outside the seal, and so does a deposited Claude login. The
coordinator then sends every permanent box `vault-changed`, a frame with no
reply that says neither who nor what. Each box asks the vault two seconds
later. The vault answers each box only for the people who approved it, so a
box nobody's change touched is given what it already holds. Runners are not
sent it: they ask for their owner's login on their own clock. This came from
vnic-runner-oci, where a Claude login forgotten and kept again at 18:19 did
not reach the box until its next ask at 18:29, and no session could start
there in between.

Every reader there reads it, and **for a person the fleet started a session
for, it is the only source**. A link on the box used to win, so a box held a
second copy of a person's login, renewed on its own clock, and the vault was
read for GitHub only when a link file also existed, which left a person who
kept GitHub in their vault and linked nothing on the box with no token at all:

| reader | from the vault |
|---|---|
| a session's Claude login | always. A sign-in is the credentials file and account a sandboxed session is seeded and a direct one is staged with; a setup-token is seeded `.claude-token`, or `CLAUDE_CODE_OAUTH_TOKEN` in a direct session's environment |
| the broker (`git`, `gh`, `wrangler`, `fleet-cred`) | always, with the token's expiry |
| the box's own GitHub checks for that person (`runnerrepo`, `linkrepo`, `githubaccess`, `provision`, an archive's push) | always |
| the box's health (`claudeAccounts`) | counts the people whose vault gives it a Claude login, so a box holding only those is not called one nobody can start a session on |
| `fleet-secret NAME` | the box's own secrets answer only a session of somebody who administers the box ([security.md](./security.md) G12), and the person's vault otherwise |

**A sign-in, on the box, has no refresh token.** The minter gives a box a
sign-in's access token, expiry, scopes and account (`src/fleet/minter/claude-login.js`),
and the box writes them as the credentials file Claude Code reads. A Claude
Code with no refresh token does not try to renew; it reads the file again.
So when the minter renews the sign-in, which it does when a box asks with
under half an hour left, the box writes the new access token into every
session already running on that person's login (`src/core/vault-sessions.js`):
a sandboxed session's conversation volume, written the way a start writes it,
and a direct session's staged copy. A session that started yesterday keeps
running past the token it started with.

**Renewing revokes the token every holder has.** The minter renews on the
first ask inside its half hour, from whichever box, runner or Test asked, and
the access token every other box holds stops working then, not when it would
have run out. A box that asked only every ten minutes went on sending it, and
a session there stopped with "API Error: 401 OAuth access token has been
revoked · Please run /login". Every box holding a token holds the same expiry,
so each now asks a minute inside the minter's half hour, and they change over
within the same minute (`syncVault` in `src/fleet/host/sidecar.js`). Claude
Code reads the file again on that 401 and retries, so a session that meets the
revoked token in that minute carries on once its box has written the new one.
Running `/login` in it does not help: the box keeps no login of its own.

That is measured, not read off the code. Claude Code 2.1.306, the version the
session image pins, was run with only the files a box writes, against a
loopback stand-in for Anthropic's hosts (a lab certificate authority, a proxy
that answers for `anthropic.com`, `claude.ai` and `claude.com` and refuses
everything else, dummy tokens):

| What the box does | What Claude Code did |
|---|---|
| writes the sign-in, no refresh token | `claude auth status`: logged in, `claude.ai`, the account and its plan |
| — | `claude remote-control`: every eligibility check passed, registered with the access token, came up Ready and polled for work |
| rewrites the file between two turns of one running session | the next turn carried the new token |
| rewrites it while the old one has two minutes left | used the old one, then the new; no attempt to renew |
| rewrites it after Anthropic starts refusing the old one | the next turn carried the new token |
| has the new token in the file when Anthropic answers "OAuth access token has been revoked" | read the file again and retried in the same turn, with the new token |
| still has the revoked one | "Failed to authenticate: OAuth token revoked"; the next turn reads the file again |
| could not reach the minter, so the file stays expired | that turn failed with "Failed to authenticate. API Error: 401 OAuth token has expired.", and nothing hung |

Not once did it try to renew. One thing the lab found: a turn that read the
file while a reseed had emptied it answered "Not logged in", so a volume's
login is now written beside the file and renamed in (`seedScript`,
`src/core/podman.js`). What the lab cannot show is Anthropic's side, that a
renewed access token opens Remote Control on its real servers; it is the same
kind of token `claude auth login` writes, sent the same way.

**Asking a box to keep a person's credential is refused.** `connect` and `link`
for oneself, and a GitHub sign-in finished on a box, answer that credentials
are kept in the vault now. `unlink` still works, so a link made before this can
be taken off a box, and both phones list those under Linked on machines with
Forget. Neither phone has a "Sign in to Claude" on a machine's page any more.

**A volume that names a person stays theirs.** A conversation volume names the
account it was seeded for. One that named somebody this box held no link for
used to be read as the box's own, and resumed on the operator's login; now it
is that person's, and a resume that finds nothing in their vault for this box
keeps the credential the volume has.

A hypervisor's record is the exception to all of this: the sidecar takes it
out of the answer before fleetwright sees it, holds it in memory, and uses it
to make machines on the pool (`src/fleet/host/xo-pools.js`). Nothing on the
box writes it down.

A runner is not a box anyone approves: its key is new every run, so it does not
ask the vault, whose answer would always be empty. It goes on getting its
owner's Claude login and its repository tokens the way it did
([runner-central.md](./runner-central.md)), and the Claude login it gets is the
vault's, read from the same row. A sign-in comes with its expiry, scopes and
account, never its refresh token, and the runner keeps it as a box does: the
credentials file its owner's sessions are staged with, which Claude Code reads
again when the token is refused. It asks again at the minute the vault renews
it (`askAgainIn` in `src/fleet/host/sidecar.js`), so a renewal during a job no
longer stops every session on the runner, as a token fixed in each session's
environment did. A setup-token is still that token, which does not renew.

## What it cannot do, said plainly

**Remote Control on a setup-token.** A setup-token can only make model
requests. Remote Control needs the whole sign-in, which a machine makes for the
vault (*Make it on <machine>* in the app, `setuptoken` with `kind: login`), and
the vault says which of the two it keeps. A sign-in handed to a box without
its refresh token opens Remote Control in Claude Code 2.1.306 against a
stand-in (above); against Anthropic itself it has not been seen yet, so say so
if a session on a box comes up without a link.

**Renewing if Anthropic changes how.** The minter renews a sign-in the way
Claude Code 2.1.42 does, at `platform.claude.com/v1/oauth/token` with Claude
Code's public client. If that moves, renewing fails with Claude's words in the
vault's problems and in Test, and boxes keep the access token they have until
it runs out.

**Revoking on the spot.** Removing a box stops it being given anything from the
next ask, and the box deletes what it holds when it asks, within ten minutes.
An access token it already handed a session lasts until it expires, which for
GitHub is up to eight hours. Revoke the token at the provider for anything
faster.

**A sign-in the coordinator started.** A sign-in a phone starts uses the
phone's own verifier, which the coordinator never sees. A GitHub link the
coordinator starts for a box is its own page, so a compromised coordinator
could begin one with a verifier of its own, and if you finished it, have the
minter record it as a device's sign-in. The list of codes it handed boxes is
its word too, so the same coordinator could leave one off. Closing that needs
the phone to sign vault requests with a key of its own, which it does not yet.

**A box you did not check.** Approving without comparing the fingerprint trusts
the coordinator's list for which key that box has, which is the one thing this
design otherwise never does.

**The minter's own bound** is the Cloudflare account and whoever can deploy to
it: new code there runs with the deposit key and the client secrets, and can
read every vault. That is the bound the App key and the Claude logins already
had ([security.md §4.1](./security.md)).

## The minter's key

Everything a phone or `fleetwright-claude-login` sends the minter is sealed to
the minter's deposit key, so the one thing that must not come from the
coordinator is which key that is. Nobody hunts for it:

- **The minter makes it.** The first time anything asks, the minter's Durable
  Object makes a P-256 key and keeps it beside the vaults it protects. Two
  first asks at once share one key (`test/vault.test.js`). A key the operator
  made by hand, as `FLEETWRIGHT_MINTER_DEPOSIT_KEY`, is used instead when set.
- **The minter answers for it** at `https://<the fleet>/.well-known/fleetwright-minter`.
  The deploy gives the minting Worker a route for that one path on the
  coordinator's own hostname, and a route runs before the coordinator's Custom
  Domain, so the coordinator never sees the request. The answer is the public
  half and nothing else.
- **The phone asks there**, from the fleet address it already has, every time
  it seals something, so a rotated key reaches every phone with nothing to
  paste. Only when nothing answers there, which is a fleet whose deploy gave
  the minter no route, does the phone show a field to paste the key whoever
  runs the fleet gave you, checked against what the coordinator says before it
  is saved, and only then is a saved key used.

What this trusts is the Cloudflare account that serves both Workers, which is
already the minter's bound (below): code deployed there could read every vault
whatever key a phone held.

### Kept a second time, outside the minter

The deposit key, the signing key and every vault sit in one Durable Object.
Lose that object and every vault is gone, along with the one key that could
open a copy of it. So two things can be kept elsewhere. Each is optional, and
each is off until the deploy binds it (`src/fleet/minter/backup.js`):

- **The rows, in R2.** The deploy makes a private bucket,
  `fleetwright-minter-backup` unless the repository variable
  `FLEETWRIGHT_MINTER_BACKUP_BUCKET` names another, and binds it as `BACKUP`.
  Five minutes after anything is written, the minter writes every row but its
  keys to `latest.json`, and to that day's file, sealed to the deposit key.
  Dated copies are kept thirty days. Copies are filed under the deposit key's
  fingerprint, so a minter that lost its key and made a new one writes beside
  the old copies and never over them.
- **The keys, in Secrets Store.** When the object holds no key, it reads
  `fleetwright-minter-deposit-key` and `fleetwright-minter-signing-key` from
  the account's Secrets Store and keeps them again. When the object holds a
  key and Secrets Store holds a different one, the object's key is used and
  the log says so: every vault here is sealed to the object's key. A
  secret that is bound but cannot be read stops the object answering. It does
  not make a new key, because a new key would lose every vault sealed to the
  unread one.

**An empty object is filled from its copy** before it answers anything, and
only when the deposit key comes from outside it (Secrets Store, or
`FLEETWRIGHT_MINTER_DEPOSIT_KEY`), because a copy opens with that key alone. A
copy that is there and does not open stops the object with `restore_failed`.
It does not start empty, because the first row written would mean the copy
was never read again. Unbind `BACKUP` to start empty anyway.
A restore cut off part way is finished at the next ask. The rows go back one
at a time with a `restore:pending` marker, which is removed only once the last
row is in, so an object holding some of the rows still knows to go on.

A copy is asked for only after something was written. Reads ask for none. Each
copy's row count and size go to the log, and the log warns past 16 MiB. The
deploy warns while `FLEETWRIGHT_MINTER_EXPORT_TO` is still set.

**Getting the keys into Secrets Store** is done once, by hand, because a
Worker cannot write there and nobody can read a value back out:

```sh
node scripts/minter-key-export.mjs new ./minter-keys        # your key; prints the next command
echo '<printed key>' | npx wrangler secret put FLEETWRIGHT_MINTER_EXPORT_TO --config wrangler.minter.toml
node scripts/minter-key-export.mjs open https://<the fleet> ./minter-keys
npx wrangler secrets-store secret create <store-id> --name fleetwright-minter-deposit-key --scopes workers --remote
npx wrangler secrets-store secret create <store-id> --name fleetwright-minter-signing-key --scopes workers --remote
npx wrangler secret delete FLEETWRIGHT_MINTER_EXPORT_TO --config wrangler.minter.toml
```

Then set the repository variable `FLEETWRIGHT_MINTER_SECRETS_STORE` to the
store's id. The deploy binds each of the two names it finds there, and warns
about each one it does not find. The `open` step asks the public address with
the header `x-fleetwright-export: keys`. The minter answers that only while
`FLEETWRIGHT_MINTER_EXPORT_TO` is set, and only with the keys sealed to it, so
anyone else who asks gets something they cannot open. Delete the files in
`./minter-keys` once the secrets are in the store.

## For whoever runs the fleet

The deposit key needs nothing from you. The vault needs the OAuth clients it
signs people in and renews with:

| secret | where | without it |
|---|---|---|
| `FLEETWRIGHT_GITHUB_CLIENT_SECRET` | repository secret or `github-app-key` | no GitHub in vaults, and no phone sign-in |
| `FLEETWRIGHT_CLOUDFLARE_CLIENT_SECRET` | repository secret or `github-app-key` (under this name only; the old `AGENT_FLEET_` one is not read) | no Cloudflare in vaults |

Both are synced by running the Worker workflow by hand on `main` with
**sync_app_key** ticked ([ci.md](./ci.md)). The Cloudflare client id is read
from the coordinator's own config at deploy, and so is the hostname the
minter's key path is routed on. If the deploy's Cloudflare token cannot edit
Workers Routes on that zone, the deploy says so in a warning and carries on,
and phones on that fleet ask for the key to be pasted.

## Adding a provider

One entry in `OAUTH_PROVIDERS` in `src/fleet/minter/vault.js` (its label and
how it renews, in `src/core/oauth-refresh.js`), its client in the minter's
environment, and its row in `PROVIDERS` in `src/core/connectors.js` so the box
knows which variables it is read under. A new kind of value is a name in
`itemKind`. Nothing else knows the list.
