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
| Claude | a `claude setup-token`, the same one runners use | the token |
| named secrets | `secret:NAME`, any value up to 8 KiB | the value, by name |

A box never holds a refresh token. Renewing happens in one place, inside the
minter's single Durable Object, under a lock per person, so however many boxes
ask at once a refresh token is rotated once (`test/vault.test.js` asks from two
boxes at the same moment and counts one renewal).

## Who may ask, and how each one is checked

None of it is the coordinator's word. The coordinator relays ciphertext both
ways and adds one fact the minter checks against something else.

**A person**, from their phone, under *Runners from this phone*, *Your vault*.
Every request is sealed on the phone to the minter's key, which the phone asks
the minter for itself (see [The minter's key](#the-minters-key) below), with
the phone's own GitHub token inside. The
minter asks GitHub whose that token is, and that GitHub account is whose vault
it is. The request also names the fleet account it is for, and the coordinator
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
                                    checks the box key is the one it enrolled
                                                         │
                                                         ▼
                        minting Worker, one Durable Object:
                          v:<github id>   items, sealed at rest; approvals by key
                          box:<key hash>  which people approved this key
                          gh:<github id>  the Claude login, as runners read it
```

## On the box

The sidecar asks (`Sidecar#syncVault`) and hands the answer to fleetwright,
which writes it under `vault/` in its state directory: one 0600 file per
person, and the Claude token as a file of its own so a session's command reads
it with `$(cat …)` and never carries it. Written whole on every answer, so a
person who removed the box, or emptied their vault, is gone from it on the
next pass.

Every reader already there reads it, and **a link made on the box wins**,
because something a person connected on this machine with their own hands is
the more specific decision:

| reader | from the vault when |
|---|---|
| the broker (`git`, `gh`, `wrangler`, `fleet-cred`) | nothing for that provider is linked here |
| a session's Claude login | no Claude account is linked here: a direct session gets `CLAUDE_CODE_OAUTH_TOKEN` with `ANTHROPIC_API_KEY` unset, a sandboxed one is seeded `.claude-token` for its entrypoint to export |
| `fleet-secret NAME` | the box has no secret of that name |

A runner is not a box anyone approves: its key is new every run. It goes on
getting its owner's Claude login and its repository tokens the way it did
([runner-central.md](./runner-central.md)), and the Claude login it gets is the
vault's, read from the same row.

## What it cannot do, said plainly

**Remote Control on a vault Claude login.** A setup-token can only make model
requests. A session that needs Remote Control needs a full login linked on that
box, which still works and still wins.

**Revoking on the spot.** Removing a box stops it being given anything from the
next ask, and the box deletes what it holds when it asks, within ten minutes.
An access token it already handed a session lasts until it expires, which for
GitHub is up to eight hours. Revoke the token at the provider for anything
faster.

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

## For whoever runs the fleet

The deposit key needs nothing from you. The vault needs the OAuth clients it
signs people in and renews with:

| secret | where | without it |
|---|---|---|
| `FLEETWRIGHT_GITHUB_CLIENT_SECRET` | repository secret or `github-app-key` | no GitHub in vaults, and no phone sign-in |
| `FLEETWRIGHT_CLOUDFLARE_CLIENT_SECRET` | repository secret or `github-app-key` (the old `AGENT_FLEET_` name is read too) | no Cloudflare in vaults |

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
