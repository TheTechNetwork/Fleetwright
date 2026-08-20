# Who is allowed, and how the coordinator knows

A design note, written before the code, because this is a decision rather than
a mechanism.

## What is actually being asked for

Small internal groups. Never strangers to the operator — but the project is
public, so anybody can install the app and point it at *their own*
coordinator. The people running a fleet want to say **these emails, or anyone
at this domain, and nobody else.**

That single requirement rules out the obvious cheap answer. A pairing code
proves *whoever holds the code*, which is a fine way to enrol a device and no
way at all to enforce a domain. Matching `@thetech.network` needs an email
somebody else vouched for.

So: federated sign-in, and the coordinator checks the email it gets.

## The shape

```
  app                     coordinator                    issuer
   │  platform sign-in         │                            │
   ├──────────────────────────▶│                            │
   │  ID token                 │   fetch JWKS, verify       │
   ├──────────────────────────▶├───────────────────────────▶│
   │                           │   check email against
   │                           │   the allowlist
   │  device credential  ◀─────┤
   │
   │  every later request uses the DEVICE credential, not the ID token
```

The ID token is used **once**, to obtain a credential. Everything after that is
the per-device token from `clients.js` — which means revoking one phone stays a
local act, and an intent can still say who sent it without re-verifying a third
party on every request.

## Provider-agnostic on purpose

The coordinator verifies an **OIDC ID token from a configured issuer**. Not "Sign
in with Google" and "Sign in with Apple" as two code paths — one verifier, and
config saying which issuers and which addresses count:

```sh
AGENT_FLEET_AUTH_ISSUERS=https://accounts.google.com,https://appleid.apple.com
AGENT_FLEET_AUTH_ALLOW=eli@thetech.network,@thetech.network
```

An entry with a local part is one person; an entry starting `@` is a domain.
Empty means nobody, which is the right default for a thing that grants control
of every machine in a fleet.

That generality is not speculative. These deployments are internal, and internal
means the identity provider is whatever the organisation already has — Google
Workspace for one, Microsoft 365 for the next, something self-hosted for the
third. A verifier that only knows two consumer providers would need extending on
first contact with a real customer; one that reads JWKS needs configuration.

Verification is JWKS, `aud`, `iss`, `exp`, and `email_verified`. All of it is
`fetch` and WebCrypto, so it runs unchanged in the Worker and on a box — the
same constraint the rest of `src/fleet/` holds to.

## Sign in with Apple will fight the allowlist

Apple lets a user **hide their email**, and then the ID token carries
`…@privaterelay.appleid.com`. That address is stable and real, and it will never
match `@thetech.network`. Domain allowlisting and Hide My Email are
fundamentally incompatible: the whole point of one is knowing where somebody
works, and of the other is not saying.

So a relay address is refused, with a message that says why and what to do —
sign in again and choose *Share My Email*. Silently rejecting it as
"unauthorised" would send a person to ask their admin why they are not on a
list they are on.

There is one more Apple constraint worth writing down: **App Store guideline
4.8** requires offering Sign in with Apple if the app offers third-party
sign-in. Apps that require an existing enterprise account are exempt, which
Fleetwright plausibly is — but "plausibly, if the reviewer agrees" is not a
plan, so the iOS app should offer both.

## Why not accounts of our own

A password database in the coordinator would mean storing password hashes,
building reset flows that need email delivery, and owning the consequences of
both. The operator already has an identity provider. Verifying its tokens is
a few hundred lines; being an identity provider is a product.

## What this does not do

**It is not authorisation.** Every allowed address gets the same access, because
a fleet of one operator and three colleagues does not need roles yet. When it
does, the client record is where a role belongs — it already carries a name and
a creation time, and adding a field is cheaper than retrofitting identity.

**It does not cover hosts.** A host presents `AGENT_FLEET_HOST_TOKEN`, still
shared by every host, and §5 wants a per-host key. Same registry, different
credential type, and worth doing after this rather than at the same time.

## What exists now

Server side, working and tested:

| | |
|---|---|
| `POST /api/session` | ID token in, device credential out. The only route reachable without a fleet credential, because it is where one comes from |
| `GET /api/clients` | which devices can reach this fleet |
| `DELETE /api/clients/{id}` | revoke one |
| every other route | accepts the shared API token **or** a device credential |

An intent from a device credential is attributed to the verified email it was
issued to, and a caller-supplied `actor` cannot override it — an actor the
caller chooses is a label, not an attribution.

Configure with three settings; the sample is commented in `worker/wrangler.toml`:

```
AGENT_FLEET_AUTH_ISSUERS    https://accounts.google.com
AGENT_FLEET_AUTH_AUDIENCES  the OAuth client id the app uses
AGENT_FLEET_AUTH_ALLOW      @thetech.network
```

## What is left

- **The apps.** Neither has a sign-in button yet: they still take a coordinator
  URL and the shared token typed into Settings, which keeps working and should
  keep working for a single-operator fleet.
- **The Node coordinator** has the registry but not the routes. The Worker is
  the deployment that faces phones; the Node one is for a single machine, where
  the shared token is proportionate.
- **Roles.** Every allowed address gets the same access. The client record is
  where a role would go, and adding a field beats retrofitting identity.
- **Hosts.** Still one shared `AGENT_FLEET_HOST_TOKEN`. Same registry, different
  credential type, and worth doing next.
