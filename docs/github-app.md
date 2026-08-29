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
removes. It stays for Cloudflare, which has no equivalent program.

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
| **Paste a token** | it does not. Also the only route for Cloudflare, which has no app program at all |

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

Cloudflare. There is no third-party app program, `wrangler login` is OAuth
against Cloudflare's own client, and that is not a door open to us. The paste
flow is Cloudflare's end state, which is why it was worth making clear rather
than treating as temporary.
