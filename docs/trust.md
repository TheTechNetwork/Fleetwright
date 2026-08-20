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

## What is missing under all of it

**Hosts have no identity.** Every host presents the same
`AGENT_FLEET_HOST_TOKEN`, so the fleet cannot distinguish one from another,
cannot revoke one, and — the part that matters here — has nothing to encrypt a
secret *to*.

A host keypair is the missing primitive. It gives per-host revocation, real
attribution for which box did what, and the recipient key that envelope custody
needs. It is also the thing §5 already wanted and the thing this project has
deferred longest.

## Order

1. **Host keypairs.** Everything else is a special case of a fleet whose members
   have identities. It closes the oldest gap and unlocks custody.
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
