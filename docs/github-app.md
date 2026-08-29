# The GitHub App, and what has to exist before code does

Chosen over the two alternatives, for the reason in
[connectors.md](./connectors.md): **no credential crosses a person at all**, and
consent is bound to an install they initiated. A pasted token comes second; a
device flow comes third and is worse than the paste, not better.

This document is the build order and the exact configuration, because half of
it is a thing only the account owner can do and getting it wrong is a round
trip through a settings page.

## What it replaces, precisely

| today | with the App |
|---|---|
| open the token page, review scopes, set expiry | open the install page |
| generate, **copy**, come back, **paste** | pick repositories, Install |
| we verify the token and store it | GitHub redirects back; done |
| `repo` reaches every repository the person can | the installation sees the ones they chose |
| "replace" is an instruction — we cannot revoke | uninstall is a revocation, and we are told |
| we invented a `missing:` line for scope drift | GitHub prompts installations to approve changes |

Every piece of the paste UI — numbered steps, the one-tap paste, "delete the
old one first", the stored scope list — is scaffolding around a step this
removes. It stays for Cloudflare until an OAuth client is registered there —
see the correction in connectors.md, which found that Cloudflare does publish
one after this document claimed otherwise.

## Who creates it: once per DEPLOYMENT, not once per person

Worth stating plainly, because the opposite is the natural reading and it is
what makes the App look unusable:

> that way doesn't work very well as every user must create the app

**A user never sees the create form.** The App is created once, by whoever runs
the fleet. Everybody else clicks **Install**, picks their repositories, and is
done — one App, many installations, which is the entire shape of the thing.

Where that instinct is right is one level up: **anyone who self-hosts
Fleetwright needs their own App**, because the callback URL points at their own
coordinator. That is real friction for a project meant to be cloned and run,
and it is why there are two routes rather than one.

## Two routes, and neither is a fallback for the other

| | when |
|---|---|
| **GitHub App** | the deployment has one configured. No credential crosses a person, per-repository scope, uninstall is a revocation we are told about |
| **Paste a token** | it does not — and, for now, Cloudflare, which has an OAuth client program this document originally said it lacked |

The paste route is not a degraded mode kept for compatibility — it is the
correct answer for a fleet whose operator has not registered an App, and the
only answer for a provider that offers none. Both are first-class, the app
shows whichever the host reports, and neither screen apologises for being the
other one.

That also settles what happens on a fresh clone: it works, with pasting, and
registering an App is an upgrade rather than a prerequisite.

## The part only the account owner can do

Create the App at **Settings → Developer settings → GitHub Apps → New**.

| field | value | why |
|---|---|---|
| Name | `Fleetwright` | appears on the consent screen. **Globally unique across GitHub** — if it is taken, the name is the only field here that has to change |
| Homepage URL | `https://fleet.thetech.network` | |
| Callback URL | `https://fleet.thetech.network/oauth/github/callback` | the coordinator already serves public routes; this is one more |
| Expire user authorization tokens | **on** | this is what makes the access token eight hours instead of indefinite. Off by default, and off is the whole point missed |
| Request user authorization (OAuth) during installation | **on** | so one flow both installs and identifies the person |
| Webhook | **off** for now | nothing consumes it yet; turn it on when uninstall-detection is built |
| Setup URL | blank | with OAuth-during-install on, GitHub returns to the callback anyway |
| Redirect on update | off | until something consumes it |
| Allow wildcard matching | **off** | a wildcard sends tokens to any subdomain and additional path of the redirect. This is the field where "convenient" and "hands your token to a neighbour" are the same checkbox |
| Enable Device Flow | **off** | deliberately — see the phishing note in connectors.md |
| Where can this be installed | **Any account** | guests bring their own GitHub accounts |

**Repository permissions**, mirroring what the PAT scopes were doing:

| permission | level | replaces |
|---|---|---|
| Contents | Read & write | `repo` |
| Pull requests | Read & write | `repo` |
| Issues | Read & write | `repo` |
| Workflows | Read & write | `workflow` |
| Actions | Read | reading run logs, which this project does constantly |
| Metadata | Read | mandatory |

**Account permissions:** none needed yet. `read:org` was doing work `gh` can
now get from the installation itself.

Then: **Generate a private key**, and note the **App ID** and **Client ID**,
and generate a **Client secret**.

## Where each piece may live, which is the whole design

This is the part to get right, and it follows directly from
[trust.md](./trust.md):

- **The private key mints installation tokens for EVERY installation** — every
  member, every org. It is the most dangerous object in this system. It may not
  live on hosts (N copies, one compromise reaches everybody) and may not live
  in the coordinator (which is treated as compromised). **It waits for the
  broker.**
- **The client secret** is not a credential to anything on its own — it is
  useless without a refresh token. It may live where hosts already keep
  configuration.
- **The per-person refresh token** goes exactly where the PAT lives today:
  `${stateDir}/accounts/<email>.env`, 0600, one file per person. Same blast
  radius as now, with an access token that expires in eight hours instead of
  never.

So the first build is **user-to-server OAuth**, not installation tokens. That
is not a compromise; it is the half that does not require the broker, and it
already beats a PAT on lifetime, scope and revocability.

## Registered, and what each value is

| | value | where it lives |
|---|---|---|
| App ID | `4758006` | `[vars]` — an identifier |
| Client ID | `Iv23liR4EwdP1xDxLt5E` | `[vars]` — appears in every authorize URL |
| Client secret | *(to generate)* | `wrangler secret put AGENT_FLEET_GITHUB_CLIENT_SECRET` |
| Private key | *(not yet needed)* | nowhere, until the broker exists |

**The first build needs only the Client ID and the secret.** User-to-server
OAuth authorizes against
`https://github.com/login/oauth/authorize?client_id=…`, which needs no app
slug, no private key, and no installation. That is a useful accident of
ordering: the half that works before the broker is also the half that needs the
least.

GitHub's own note on the settings page — *"Using your App ID to get
installation tokens? You can now use your Client ID instead"* — means the App
ID may end up unused entirely. It is recorded anyway, because an id that is
hard to find again costs more than a line of config.

**The slug is `fleetwright-agents`** — the name "Fleetwright" was taken, so the
App is "Fleetwright Agents", and GitHub slugified it with a hyphen. Confirmed
rather than guessed: `https://github.com/apps/fleetwright-agents` answers 200,
which also confirms the App is public and installable by anybody.

The install URL is therefore
`https://github.com/apps/fleetwright-agents/installations/new`. The OAuth path
needs no slug at all.

## The private key: received, and deliberately not installed anywhere

The key exists and is a 2048-bit RSA key. It has not been written to a secret
store, a host, the coordinator, or this repository, and that is the design
rather than an oversight — [above](#where-each-piece-may-live-which-is-the-whole-design)
and [trust.md](./trust.md): it mints installation tokens for **every**
installation of this App, so it may not live on hosts (N copies, one compromise
reaches everybody) and may not live in the coordinator (treated as
compromised). **It waits for the broker**, and the broker does not exist.

**This particular key should be revoked and a fresh one generated when the
broker is built.** It arrived through a chat transcript and an upload
directory — channels whose retention nobody in this repository controls. That
is not a claim it has leaked; it is that a key which mints for every
installation is exactly the wrong thing to keep because rotating it is
inconvenient. GitHub allows several private keys per App and deleting one is a
button, so the cost of regenerating at the moment of use is approximately zero
and the cost of not doing so is unbounded.

Deleting it now is also free: nothing uses it, and the OAuth build does not
need it.

### Where the CLIENT SECRET goes, which is a different answer

The secret is needed by whatever performs an OAuth exchange, and there are two
of those:

| exchange | who does it | needs the secret |
|---|---|---|
| `code` → access + refresh | the **coordinator**, because GitHub redirects the browser to its callback | yes |
| `refresh` → a new access token, every eight hours | the **host**, because that is where the refresh token lives | yes |

So it goes in two places, and both are deliberate:

**1. A GitHub Actions secret, which the deploy pushes to Cloudflare.**

`AGENT_FLEET_GITHUB_CLIENT_SECRET`, exactly like the APNs key and the FCM
service account before it. `worker.yml` already has a "Sync the Worker's
runtime secrets" step whose entire purpose is that **GitHub is the one place
these are managed** — adding a name to that list is the whole of it, and
`wrangler secret put` by hand becomes the thing nobody has to remember.

It must not be a `[vars]` entry, for the reason `wrangler.toml` already records
about the APNs key: **Cloudflare keeps vars and secrets in one namespace, so a
deploy carrying a var of that name CLOBBERS the secret.** One place per name,
and for this one the place is GitHub.

**2. Nowhere on the host. The coordinator sends it down the socket.**

The first version of this said "each host, in its environment file, 0600" — and
that is a file somebody has to place on every machine, which is the exact thing
this project exists to remove. *"nothing to run, and nothing to ssh into"* is
the promise; a config file that has to be copied to each box, and re-copied
whenever the secret rotates, is not a small exception to it.

**The channel already exists.** Every host holds an authenticated websocket to
the coordinator — it dialled out, proved possession of its P-256 key against a
nonce, and keeps that socket open. The coordinator already has the client
secret, because it performs the code exchange. So it sends it on connect, and
the host keeps it **in memory**.

That is better than a file in three ways rather than one:

- **Nothing to place.** A host enrolled tomorrow gets it by connecting.
- **Nothing to steal at rest.** There is no file, so there is no file to read
  out of a backup, a snapshot, or a stolen disk.
- **Rotation is a deploy.** Change the secret in Cloudflare, and every host has
  the new one the next time it connects. No fan-out, no stale copy on the box
  somebody forgot.

The cost is honest and small: a host that cannot reach the coordinator cannot
refresh a token. A host in that state also cannot be asked to do anything, and
sessions already holding a valid access token keep working for up to eight
hours.

### The config frame is a FIXED SET, for the same reason intents are

This is the guardrail, and it matters more than the feature. "The coordinator
can push configuration to hosts" is a command channel wearing a different hat —
arbitrary key/value delivery from the party this system treats as compromised
is exactly what `design.md` §5 refuses when it refuses shell strings.

So the frame carries **named values from a fixed list**, validated on arrival by
the host, and a key the host does not recognise is dropped rather than stored.
Same shape as the verb set: the coordinator can send what the protocol names,
and cannot invent a new thing to send.

Today that list is one entry, the GitHub client secret. It should grow slowly
and never become a map.

### Why this may be delivered at all, when the private key may not

Because the client secret authorises **nothing on its own**:

> The client secret authorises **nothing on its own**. It cannot read a
> repository, mint a token, or name a person. It is useful only together with
> an authorization code somebody just produced, or a refresh token they already
> granted — and the host holding it already has that person's refresh token.

So a host compromise yields what it already yielded: that host's refresh
tokens. The secret adds no reach beyond them, and in memory it does not even
survive a restart. Contrast the private key, which adds *every installation of
the App* — that is the difference, and it is why one of these may be
distributed and the other may not.

The alternative would be hosts asking the coordinator to refresh for them,
which sends a refresh token **up** through the coordinator every eight hours.
That is worse in the direction that matters: it makes the coordinator a
credential path on a schedule, in order to avoid sending down a value that
grants nothing by itself.

**And keep a copy in a password manager**, because GitHub shows a client secret
exactly once. Losing it means generating another and updating both places —
recoverable, and avoidable.

### What the key is actually for, which is one call

There is exactly one thing a GitHub App's private key does here:

```
sign a JWT with it  (RS256, iss = client id, 10 minutes)
POST /app/installations/{installation_id}/access_tokens
  → a one-hour installation token, scoped to that installation
```

That is the whole list. It is **not** used for webhook verification (that is the
webhook secret), not for the OAuth exchange (that is the client secret), and not
for anything a session does. So the question "where does the pem need to live"
has a single answer: **wherever installation tokens are minted, and nowhere
else.**

### Which is a service that does not exist, and might never

Three candidate holders, and two are already ruled out:

| holder | verdict |
|---|---|
| every host | **no** — N copies of a key that mints for every installation. One host compromise reaches every member and every org that ever installed the App |
| the coordinator | **no** — treated as compromised by design; this would make it the highest-value target in the system |
| a separate minting service, asked by hosts over their existing keys | the only shape that works, and it is the broker |

And the fourth option, which is the one to hold open: **user-to-server OAuth may
simply be enough.** An eight-hour access token, scoped to chosen repositories,
revocable from a screen the person already knows, with a refresh token whose
blast radius is one person. If that turns out to be sufficient in practice, the
private key is never needed at all and this section stays a note.

### So where should the .pem be saved

**In a password manager, and nowhere in this system.** `trust.md` already names
1Password as the custody answer for exactly this class of thing. Not the
repository, not GitHub Actions secrets, not Cloudflare, not a host — none of
those are places it is needed, and every one of them is a place it could be
found.

The stronger option, and the recommended one: **do not save it.** Delete the key
in GitHub, and generate a fresh one at the moment a minting service first needs
one. Regeneration is a button; a key sitting unused for months in a place
somebody has to remember is the failure mode this whole document is arguing
against.

## Build order

1. **The callback route** on the coordinator: `/oauth/github/callback` takes
   `code` and `state`, exchanges it for an access + refresh token, and relays
   the result to the host the flow started from — over the socket that host
   already holds open. Nothing is stored at the coordinator.
2. **`state` is the binding**, and it is the security of the whole flow: it
   names the host and the person, it is single-use, it expires in minutes, and
   a callback whose state does not match a flow this coordinator started is
   refused. Without that, the callback is an open door for anybody who can
   guess a URL.
3. **Host-side storage and refresh**: the refresh token beside the other
   credentials, and a token refreshed on demand rather than at start-up.
4. **The apps**: one button, one redirect, no paste field.
5. **Installation tokens behind the broker**, when the broker exists — at which
   point the refresh token stops being needed at all.

## What stays as it is

Cloudflare, **for now and not for ever**. This section originally said there was
no third-party app program; there is one, and the correction lives in
connectors.md. The paste flow is Cloudflare's route until a client is
registered — private first, because public visibility requires domain
verification and cannot be reversed.

The work spent making the paste flow clear is not wasted either way: it is what
every provider without a program uses, and what any provider uses before its
client exists.
