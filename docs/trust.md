# Trust: who is asking, and what they are allowed to hand a session

Written after stepping back, because three things had been treated as one and
they behave differently.

## The three questions

| | question | wrong answer looks like |
|---|---|---|
| **Enrolment** | should this person or machine exist at all? | a stranger joins the fleet |
| **Authentication** | is this the one we enrolled? | somebody replays a stolen credential |
| **Custody** | who may hold the material a session needs? | a compromised coordinator leaks a production key |

They were being answered by one shared bearer token, which is why the answers
were all the same and all weak. Separating them is most of the work; the
mechanisms then fall out.

## Enrolment is a human decision with a machine record

Somebody decides a person is in. That decision needs a durable, checkable
statement of who — which is why `docs/identity.md` reaches for an email from an
identity provider, and why an allowlist of addresses and domains is the right
shape for internal groups.

**Passkeys cannot answer this.** A passkey proves *the same key as last time*.
It carries no email, no domain, no organisation — by design, since that is the
privacy property people choose it for. So a passkey-only system still needs an
enrolment step where somebody vouches, and the allowlist requirement is
unchanged.

That is not an argument against passkeys. It is an argument that they answer
the next question, not this one.

## Authentication is where passkeys win

Once enrolled, every request has to prove it comes from that device. Today that
is a bearer token: the credential travels on every request, so anything that
sees a request sees the credential — a proxy log, a crash report, a screenshot
of a curl command.

A passkey never travels. The private key stays in the device's secure element
and each request carries a signature over a challenge. Stolen logs are worthless,
replay is defeated by the challenge, and phishing has nothing to catch — which
matters more here than in a typical app, because the thing being protected is
unsupervised shell on every machine in a fleet.

The cost is real and worth stating: WebAuthn verification is COSE and CBOR
rather than a JWT, both apps need platform credential APIs, and every request
gains a round trip for a challenge unless short-lived tokens are minted from a
passkey assertion — which is the usual arrangement and is what I would build.

**So: passkeys are the right end state for authentication, layered on the same
device-credential record that exists now.** `clients.js` already stores a
credential per device with revocation and attribution; a passkey changes what
is stored from a hash of a secret to a public key, and changes verification
from comparison to signature checking. The registry, the revocation and the
attribution do not move.

## Custody is a different problem, and the one that should shape the design

Sessions will need secrets that are not about identity at all: a deploy token, a
registry password, an API key for whatever the session is being asked to build.

The temptation is to put them where the app can manage them — in the
coordinator. **That is the one place they must not be.**

design.md §3 already says the coordinator's registry is a cache with
provenance, never the authority, and that each host stays the sole authority on
its own tmux. Secrets follow the same rule for the same reason: a coordinator
is an internet-facing service holding a socket to every box in the fleet, and
it is the single most attractive thing in the system to compromise. Today the
worst a compromised coordinator can do is start and stop sessions. If it also
held secrets, the worst it could do would be exfiltrate every credential the
fleet touches, silently, from anywhere.

So the rule, stated once so it can be checked against later:

> **The coordinator must never be able to read a session secret.**

Two arrangements satisfy it.

**Reference, not value.** Secrets live on the host, in whatever the operator
already uses — a file, a systemd credential, a vault agent. An intent names one:
`start --secret github-deploy`. The host resolves the name locally and seeds it
into the sandbox the way credentials are seeded today. The coordinator learns
that a secret named `github-deploy` was requested and nothing else. This needs
no cryptography, and it is where I would start.

**Envelope, when the value must travel.** If a secret genuinely has to come from
a phone — pasted once, never stored on a host — then it is encrypted to the
destination host's public key before it leaves the device. The coordinator
relays ciphertext it cannot read. This needs hosts to have keypairs.

## Unlocking it, which is the question that does not go away

Any store needs a key, and that key needs a key. The honest starting point is
that one pair of requirements cannot both hold:

- **a host recovers unattended** — it reboots at three in the morning and comes
  back with its sessions, which is most of why this project exists
- **a secret survives the host being owned** — root on the running machine
  cannot read it

If the machine can unlock without a person, then whoever owns the machine can
unlock too. Every scheme that claims otherwise has moved the key somewhere and
not said so. So the question is not "how do we make it unbreakable" but **what
are we defending against**, and the answers differ enough to be worth naming.

### Against a stolen disk, a copied VM, a backup: TPM sealing

`systemd-creds` is on the box already — systemd 257 with `+TPM2` — and it seals
a secret to *that machine in that boot state*:

```sh
systemd-creds encrypt --with-key=tpm2 --name=github-deploy plain.txt cred.enc
```

The unit reads it with `LoadCredentialEncrypted=`, systemd unseals it at start,
and the service sees a file under `$CREDENTIALS_DIRECTORY` that exists nowhere
else. The ciphertext is useless on another machine, in a backup, or to anyone
who takes the disk. No new infrastructure, no vault to run, no network
dependency at boot.

This is the default worth building. It matches how the host is already
deployed, and it turns "a file of secrets on a box" into "a file that is only a
secret on *this* box".

What it does not do is defend against root on the live host — and nothing
running on that host can. A vault agent, an encrypted store, a KMS client: all
of them can be asked by root to hand over what they just unlocked.

### Against the host itself: move the secret, because it cannot be removed

An earlier version of this section said "do not keep the secret", and that was
wrong in a way worth recording. **To mint a short-lived credential you need a
long-lived one**, and it has to live somewhere. Minting does not remove the
problem; it relocates it, and what it leaves behind is arguably worse — a
GitHub App private key is a factory, where a personal token is one item.

So the claim has to be smaller and more honest. Minting buys three things, and
protecting the host is not among them:

- **The session never holds it.** A session is an agent running code nobody
  reviewed, in a container with network access, which is by a wide margin the
  least trustworthy thing in this system. If it leaks what it has, it leaks ten
  minutes of scoped access rather than a permanent credential.
- **Scope.** An installation token can be one repository and three permissions.
  The personal token it replaces is usually everything its owner can reach.
- **Expiry without action.** A leaked short-lived token stops mattering on its
  own, which is not true of anything that has to be noticed and revoked.

That is the whole trade: **the long-lived credential moves from the session to
the host**, and it is worth making only because the gap in exposure between
those two is enormous. Root on the host can still take the minting key and mint
forever. TPM sealing narrows that to *root on that machine while it is running*,
which is a real narrowing and not a solution.

There is one arrangement that removes the stored provider credential entirely,
and it is worth naming precisely so its cost is visible. Workload identity
federation — GitHub and the cloud providers will exchange an OIDC token from an
issuer you nominate for a scoped credential — means a host could prove itself
and receive a token with no provider secret stored anywhere. The coordinator
would be that issuer.

**That is a worse trade here, and the reason is the rule two sections up.** It
would make the coordinator able to mint access to every provider for every
host, which is precisely what "the coordinator must never be able to read a
session secret" exists to prevent. Spreading minting keys across hosts means a
compromised host costs that host's access. Centralising them means a
compromised coordinator costs everything, in a component that is
internet-facing by design.

So: keep it on the host, sealed, and be clear that this bounds the damage from
a leaked *session* rather than from a compromised *host*. That is a smaller
claim than the one this section originally made, and it is the one that
survives being asked where the long-lived credential lives.

### For the few that are worth interrupting you: ask the phone

Some secrets should not be unattended at all. A production deploy key does not
need to be available while everyone is asleep, and that is the case where the
fleet has an unusual advantage: **it already wakes a phone.**

The same path that says *a session is waiting for an answer* can say *this
session wants the production key — approve?* The host holds the ciphertext, the
approval releases the unwrapping key for one use, and a machine that reboots
unattended comes back with its sessions and without that secret until somebody
says so.

That is a real design rather than a flourish: push, device identity and
per-session context all exist already, which is why this is worth writing down
now rather than reaching for a vault product that would need all three built
again.

### So, in order of what to reach for

| the secret | how it is unlocked |
|---|---|
| ordinary, needed at boot | TPM-sealed with `systemd-creds`, unattended |
| anything a provider can mint | not stored at all — a minting credential is, and the session gets a short-lived one |
| high value, rarely used | held encrypted, released by an approval on a phone |

None of these is a secrets manager, and that is deliberate. A secrets manager
is a place to put the same question — it stores things and needs unlocking —
and running one would add an availability dependency to every session start.
What is actually needed is a policy about which of the three rows a given
secret belongs in.

## Does Sign in with Apple lean on the phone's security?

At the moment of signing in, yes: the platform account is unlocked by a face or
a fingerprint, and the token comes from an OS component an app cannot reach
into. That instinct is right.

But it stops there. **What the app holds afterwards is a bearer token**, and a
bearer token is a bearer token wherever it came from — copied out of a backup,
read from a debugger, or carried in a log, it works. The phone's security
protected the sign-in; it does not protect the credential the sign-in produced.

The thing that actually delivers "this request came from that phone, unlocked
by that person" is a **key the hardware will not export**: the Secure Enclave on
iOS, a StrongBox-backed key in the Android Keystore, gated on biometrics. Every
request is then a signature the enclave produces and nothing else can, and the
credential cannot be copied because there is no copy of it to take.

Which is the enrolment/authentication split again:

| | mechanism | what it proves |
|---|---|---|
| enrolment | Sign in with Apple / Google | this is `eli@thetech.network`, and a domain rule can act on it |
| authentication | enclave-backed key, or a passkey | this request is from that device, with the person present |

So both, and for different reasons — not one instead of the other. The version
where the app is "kind of an authenticator" is exactly this: the enclave key is
the authenticator, and sign-in is how the fleet learned whose it is.

## The chain, link by link

User authentication is one link of four, and the others are weaker.

| link | today | what it should be |
|---|---|---|
| device → coordinator | **per-device credential, issued at sign-in, revocable on its own** | a key in the Secure Enclave / StrongBox, so the credential cannot be exported either |
| host → coordinator | **per-host keypair, a signed nonce per connection** | unchanged — this is the shape it should be |
| coordinator → host | trusted absolutely: an intent is obeyed because it arrived | intents signed by the device, verified by the host |
| session ← host | unix socket, identity from the socket | already right |

The third row is the interesting one, and it is where the design's own paranoia
points. design.md is emphatic that the coordinator is a cache and never the
authority — but a host today obeys any intent the coordinator sends, so a
compromised coordinator has full control of every box. The registry being a
cache does not help, because the commands are not.

**If a device signs its intents and the host verifies that signature, a
compromised coordinator can no longer forge one.** It can still drop intents or
delay them — it is the transport — but it cannot invent "stop every session" or
"start one in this directory". That reduces the worst case from *owns the fleet*
to *can deny service*, which is the difference between a bad day and a very
different day.

It also makes the fourth link honest: the host learns who asked, end to end,
rather than being told by the coordinator.

## The link that is still missing, and the thing that makes it hard

Signed intents are the third row of that table, and the interesting question is
not the signing. It is: **who tells a host which device keys are real?**

A host verifies a signature against a public key. It has to get that key from
somewhere, and the obvious somewhere is the coordinator — which is precisely
the party the signature exists to distrust. A coordinator that can say "this is
Eli's key" can say it about a key it made up, and the signature verifies
perfectly.

Three ways out, in increasing order of how much they cost:

- **A fleet root key.** The coordinator holds no signing authority; some
  offline key signs device certificates, and hosts trust that. Correct, and it
  is a PKI — key ceremonies, rotation, an offline thing to lose.
- **Pin the first device out-of-band.** The enrolment pin already travels
  through a human: somebody reads six digits and types them on a box. If the
  pin carried a *hash of the minting device's public key*, the host would learn
  one device key through a channel the coordinator cannot forge, and that
  device could vouch for the next. Cheap, and it bootstraps exactly one device
  per host — which for a fleet of one operator and three colleagues may be
  enough.
- **Trust on first use, and shout on change.** The host records the key it
  first saw for a device and refuses a changed one until a human says so. Weak
  against a coordinator compromised before first use; strong against one
  compromised after, which is the likelier order.

**None of this is built.** It is written down because the host keypair made it
buildable — before, there was no per-host identity to bind anything to — and
because the mistake to avoid is shipping signed intents whose keys the
coordinator hands out, which looks like the property and is not.

## Short-lived secrets that outlive their session

A session runs for hours. A minted token lasts an hour, or ten minutes. So the
obvious version — hand the session a token at start — breaks in the middle of
the work, and lengthening the token defeats the point of minting it.

The way out is to stop handing over values. **A session should receive an
indirection, not a secret**, and the host should keep what is behind it fresh:

- **git** takes a `credential.helper`. The helper is a script; it prints a
  username and password on demand, and the host mints a fresh installation
  token each time it is asked. Git asks again on the next fetch, so an expiry
  between operations is invisible.
- **anything reading a file** — a token path the host rewrites in place before
  expiry. Works when the tool re-reads; does not when it caches at startup.
- **anything speaking to an endpoint** — the pattern cloud instances already
  use, where the SDK re-reads from a local address and rotation is something it
  never notices.

The failure this cannot fix is a tool that reads a secret once into memory at
launch and never looks again. For those the choice is an honest one: a token
long enough to cover the session, or a session that can be told to restart the
tool. Pretending otherwise produces the worst outcome — an expiry mid-run, hours
in, with a failure that looks like a permissions problem.

Which is why the indirection matters more than the minting. Minting is the easy
half and every provider does it differently; the part that has to be right here
is that **the session never holds the value**, so that whatever is behind it can
change without the session knowing.

## What was missing under all of it, and now is not

**Hosts had no identity.** Every host presented the same
`AGENT_FLEET_HOST_TOKEN`, so the fleet could not distinguish one from another,
could not revoke one, and — the part that mattered here — had nothing to
encrypt a secret *to*.

Each host now holds a P-256 keypair. The private half lives at
`/var/lib/agent-fleet/host-key.json`, 0600, generated on first run and never
sent anywhere; the coordinator keeps the public half and a name. Connecting is
signing a nonce the coordinator issued seconds earlier, so nothing reusable
crosses the wire — a captured connection yields a signature over a value that
will never be accepted again.

Joining is a **six-digit pin**: short-lived, single-use, purpose-bound, minted
by somebody already in. A pin is not a credential — it buys exactly one
exchange, in which the host presents a public key and receives an identity.
Guessing is bounded too: ten wrong pins in a minute shuts redemption for
everybody until the window passes, because a million possibilities is plenty
for a human and not much for a script.

P-256 rather than Ed25519 for a reason that matters later: it is what the
Secure Enclave and StrongBox support, so the same shape of key works when the
private half moves into hardware.

That gives per-host revocation, real attribution for which box did what, and
**the recipient key that envelope custody needs** — which is what makes the
rest of this document buildable rather than aspirational.

## Order

1. ~~**Host keypairs.**~~ **Done.** Everything else is a special case of a fleet
   whose members have identities; this closed the oldest gap and unlocked
   custody.
2. **Secret references.** No cryptography, immediate value, and it establishes
   that the coordinator names secrets rather than holding them — the habit
   matters more than the mechanism.
3. **Passkeys for people**, replacing the bearer credential inside the existing
   client registry, once there is more than one person and a phone is the thing
   being trusted.
4. **Envelope custody**, if and when a secret needs to travel from a phone.

`docs/identity.md` and the sign-in work stand: enrolment by verified email is
still how somebody gets in. What changes is that it stops being called "the
security model" and becomes one third of it.
