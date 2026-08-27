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

**It is barely authorisation.** There are exactly two levels: the first person
to sign in to a fresh fleet gets an `admin` bit on their credential, and
removing machines or other people's devices requires it. Everyone else can drive
sessions and mint enrolment pins.

Two levels, not a role system. Before it existed, every allowed address could
revoke every machine and every other person's phone — and on a fleet whose
allowlist is a *domain*, that is every colleague.

**And it is a guardrail, not a security control.** It is enforced inside the
coordinator, which `trust.md` assumes compromised; it protects against mistakes
and against a colleague having a bad day, and against nothing else. The
break-glass `AGENT_FLEET_API_TOKEN` always passes it, because the case it exists
for is the admin's phone being the thing that got lost.

**It is not how hosts authenticate.** A host is a machine, not a person: it
holds a keypair and signs a nonce per connection, and it joins with a pin
rather than by signing in. Same registry, different kind of thing — see
[`trust.md`](./trust.md).

## What exists now

Server side, working and tested:

| | |
|---|---|
| `POST /api/session` | ID token in, device credential out. Reachable without a fleet credential, because it is where one comes from |
| `POST /api/enroll/host`, `/api/host/challenge`, `/api/host/verify` | Also reachable without a fleet credential — a pin or a host signature gates these instead, since a host is not a person signing in |
| `GET /api/clients` | which devices can reach this fleet |
| `DELETE /api/clients/{id}` | revoke one |
| every other route | accepts a device credential, **or** the break-glass admin token |

An intent from a device credential is attributed to the verified email it was
issued to, and a caller-supplied `actor` cannot override it — an actor the
caller chooses is a label, not an attribution.

Both coordinators — the Worker and the Node one — implement these identically,
because an app must not be able to tell which one it is talking to.

Configure with three settings; the sample is commented in `worker/wrangler.toml`:

```
AGENT_FLEET_AUTH_ISSUERS    https://appleid.apple.com https://accounts.google.com
AGENT_FLEET_AUTH_AUDIENCES  network.thetech.fleetwright  654943059314-kosvngt4ggmdguksogppoiglo48nvm2i.apps.googleusercontent.com
AGENT_FLEET_AUTH_ALLOW      @thetech.network
```

## In the apps

**iOS** uses Sign in with Apple; **Android** uses the system account picker via
Credential Manager. Different providers, one allowlist: it is keyed on the
verified email address, so the same person signs in on both and appears as the
same person.

Two things that will refuse a sign-in for reasons worth stating in advance:

- **Hide My Email.** Apple's relay address is real and stable and can never
  match a company domain. The coordinator detects it and says "choose Share My
  Email" rather than "you are not on the list", which would send somebody to ask
  why they are missing from a list they are on.
- **Audiences.** Apple issues its ID tokens for the **iOS bundle id**; Google
  issues them for the OAuth **web** client id the Android app names as its
  server client. `AGENT_FLEET_AUTH_AUDIENCES` needs both, and a token for
  another application is refused.

  The Google half is the **web** client (`client_type: 3`) from
  `google-services.json` — *not* either of the Android clients listed beside it.
  This trips people because the Android client is the one that looks like it
  belongs to the app. It is the one the request is authorised *by*; the web
  client is the one the token is issued *for*, and `aud` is what gets checked.

### The signing certificate has to match, and this is where it fails silently

Google ties each Android OAuth client to a package name **and a signing
certificate SHA-1**. Present an ID token request from a build signed with a
different key and Credential Manager refuses — with a generic failure, not a
sentence naming the certificate.

So each build type needs its own registered fingerprint: the debug keystore's
for `network.thetech.fleetwright.debug`, and the release keystore's
(`ANDROID_KEYSTORE_BASE64` in CI) for `network.thetech.fleetwright`. **If both
entries in `google-services.json` carry the same hash, one of them is wrong**,
and the build type it belongs to is the one that will fail. Check with:

```
python3 -c "import json;[print(c['client_info']['android_client_info']['package_name'], o.get('android_info',{}).get('certificate_hash')) for c in json.load(open('apps/android/app/google-services.json'))['client'] for o in c['oauth_client'] if o['client_type']==1]"
keytool -list -v -keystore ~/.android/debug.keystore -storepass android -alias androiddebugkey | grep SHA1
```

If the app is ever distributed through Play, the fingerprint that matters is the
**app signing certificate** from the Play Console rather than the upload key —
Play re-signs, so the key that built the artefact is not the key that ships.

Both apps also have a collapsed **"use a credential instead"** field. It exists
for two things sign-in cannot cover: App Review, whose reviewers are on nobody's
allowlist and use the public demo credential, and getting back in when sign-in
itself is what is broken.

## The hardening this stops short of

**The ID token carries no nonce.** Both providers support one — you generate a
value, pass it with the request, and it comes back as a claim — and it binds a
token to the sign-in attempt that asked for it, so a captured token cannot be
exchanged a second time somewhere else.

It is not here, and the reason is proportion rather than principle. A token is
only reachable over TLS to this coordinator, is only issued for this app's
audience, and lives ten minutes to an hour. The two providers also disagree
about the convention — Apple wants the SHA-256 of the value in the request and
compares the digest; Google wants the value itself — which is a bug waiting in
a flow that cannot be exercised without two real phones.

Worth doing. Worth doing *after* the flow has been driven end to end once,
because an extra required round trip in an untested sign-in is a way to have
neither.

## What is left

- **Roles.** Every allowed address gets the same access. The client record is
  where a role would go, and adding a field beats retrofitting identity.
- **Session secrets.** Signing in proves who is asking. It does not yet decide
  what a *session* may hold — see [`trust.md`](./trust.md) for the custody half
  of this, which is the larger unfinished piece.
