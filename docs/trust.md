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

## Where the indirection should live: a broker, and sometimes a proxy

The section above says a session gets an indirection rather than a value. This
one is about what that indirection actually is, because "the host keeps it
fresh" is doing a lot of work in that sentence.

### The socket is already there

The sandbox already bind-mounts **one unix socket per session** into that
session's container and nowhere else (`docs/hook-socket.md`). It exists so a
container can report its conversation uuid without being able to name any
session but its own — and the authentication is the bind-mount itself: the
sidecar knows which session is asking because of which socket it arrived on,
and a container cannot reach a socket it was not given.

That is the same shape a credential broker needs, and it is already built. A
session asks its own socket for `github`; the sidecar decides whether that
session may have it, mints or fetches, and returns a value that is good for
minutes. Nothing is stored in the container, nothing is in the environment, and
rotation is invisible because the next ask returns the next value.

**Take this from the tools rather than inventing it.** Git has
`credential.helper`, which is a program that prints a credential on demand.
`GIT_ASKPASS` is the same idea one layer down. Cloud SDKs already re-read from a
local metadata address and treat rotation as unremarkable. Claude Code itself
has the shape — a helper command that produces the auth value and is re-run on
an interval rather than a key pasted into a file. Every one of those is a hook
for exactly this, and none of them needs anything intercepted.

### The proxy, and what it is actually for

For tools with no such hook, the remaining move is to put the credential in the
**network path** instead of the process: the session's outbound request carries
no authorization, and something on the way out adds it.

What that buys, stated precisely:

- the secret is not in the container filesystem, environment or process memory,
  so it cannot be read out of a core dump, a log, or the session's own history
- it cannot be **exfiltrated and used later, somewhere else** — which is the
  difference that matters, because a token that leaves the box outlives the
  session and the box
- rotation and revocation become the proxy's business, not the session's
- there is one place that sees every credentialed request, which is the only
  practical audit point

And what it does **not** buy, which is the part that gets skipped: a session can
still *use* the credential even though it cannot *hold* it. Anything the proxy
will sign, a compromised session can ask for. So the proxy's value is exactly
proportional to how narrowly it is willing to sign — per host, per method, per
path prefix. "It may reach api.github.com" is barely a control. "It may POST to
`/repos/OWNER/REPO/issues` and nothing else" is one.

### The awkward part is TLS

To add a header to an HTTPS request, something must terminate the TLS. There are
three ways and they are not equally good:

| | how | cost |
|---|---|---|
| **Protocol hooks** | `credential.helper`, `GIT_ASKPASS`, a metadata endpoint, an `apiKeyHelper`-shaped command | none — no interception, and the tool already expects it. **Use this wherever it exists.** |
| **Per-service reverse proxy** | the session calls `http://gh.fleet.local`, the proxy makes the real call | one shim per service, and every tool has to be pointed at it |
| **Intercepting forward proxy** | a CA the container trusts, `HTTPS_PROXY` set | the proxy can now read ALL of the session's traffic, not just what it injects into; pinned clients break; and a trusted CA inside the container is itself a thing worth being careful with |

The last row is the one people picture when they say "inject at the proxy". It
is the most expensive by a distance — a large new trusted component that sees
everything, introduced to solve a problem the first row already solves for git,
for cloud SDKs and for Claude Code.

**But it buys two things the first row cannot, and they are not small**: a
credential the session holds can be given an expiry the upstream does not
support, and egress can be denied by default. Neither is reachable through a
protocol hook, because a hook only controls what the session is *given*, never
where the session can *go*. So the ordering here is about cost, not about
capability — reach for a hook first because it is nearly free, not because it is
sufficient. `Terminating credentials at the proxy` below is the full argument.

#### The general shape, because GitHub is one of many

Every service a session touches has this problem, and it does not go away: npm,
Cloudflare, AWS, a container registry, a package index, whatever the work needs
this month. So the thing to build is not a GitHub broker. It is **the broker**,
with a small adapter per service — and the honest part of the design is that the
adapters are not equivalent, because the services are not.

**Three categories, and most services are in the middle one.**

| | what the broker can do | what that bounds |
|---|---|---|
| **Mintable** — GitHub Apps, AWS STS, Google service accounts, Cloudflare tokens with `expires_on` | mint a fresh short-lived credential per request, scoped at the moment of minting | time AND reach. The best case, and the only one where "nothing a session leaks outlives it by an hour" is true |
| **Storable only** — most SaaS, most package registries | hold one durable value and hand it over | reach and revocability, **not time**. A session that receives it holds a durable secret, and no amount of socket plumbing changes that |
| **Unnecessary** — anything where the session needs the EFFECT, not the credential | perform the operation on the session's behalf and return the result | everything, because the credential never moves |

The middle row is the common case and the weakest, and pretending a uniform
abstraction hides that would be the worst outcome of building this. When a
provider cannot mint, the broker should say so — `expiresAt: null` is a fact the
UI should show, not a detail to smooth over.

**That row is defeatable, though, and the next section is how.** Everything
above is true of a broker that hands over whatever the upstream gave it. A
proxy that terminates credentials does not have to hand over the upstream's
credential at all, and that changes which category a service is in. What is still gained there is real
but smaller: the value is not in the image, not in the environment of every
session, not in a config file somebody copies to the next box, and it is
revocable centrally with an audit trail of which session asked.

**The third row is the one people skip, and it is often the right answer.**

A session usually does not need a credential. It needs an outcome — open a pull
request, publish a package, purge a cache. Where the operation is nameable, the
host can perform it and hand back the result, and the credential never enters
the container at all. That is the same move as `answer` taking an ordinal
instead of text: narrow the interface rather than hand over the capability.

It costs an operation to be designed for each case, which is why it will never
cover everything. It should cover the destructive ones.

**What is actually shared, and therefore what gets built once:**

- the per-session socket, which already exists and is already unforgeable
- a request protocol: a session names a reference, and gets a value, a refusal,
  or an operation's result
- policy: which session may reference what, decided host-side from what `start`
  was given, never from what the session asks for
- an audit line per grant — session, reference, time, and whether it was minted
  or handed over
- the delivery adapters, which are per-TOOL rather than per-service and there
  are only about four: `credential.helper` for git, a PATH shim for a CLI that
  reads an env var, a local metadata endpoint for SDKs that already expect one,
  and a file the host rewrites before expiry for tools that re-read

That last list is the argument for doing it properly once. The per-service
adapter is then a small thing — "given this durable credential and this scope,
produce a value and an expiry" — and a service that cannot mint implements the
same interface and returns a null expiry.

**The recursion, once, so nobody has to rediscover it.** Every one of these
needs a durable credential somewhere: an App private key, a service account
token, a vault token. There is no arrangement in which nothing durable exists.
The whole game is moving the durable thing to the fewest, best-protected places
and making everything downstream of it short-lived, scoped and attributable —
not eliminating it, which is not available.

### Terminating credentials at the proxy, which collapses the table

The table above sorts services by what the *upstream* supports. That is the
wrong axis, and noticing it is the single best idea in this document.

If every session's egress goes through a proxy that terminates credentials,
then what the session holds is **issued by us**, not by the upstream — and a
credential we issue has whatever expiry, scope and revocation we decide,
regardless of what the real service is capable of. For a service that cannot
mint, the proxy invents a credential that authenticates *to the proxy*, and
swaps it for the real one on the way out.

    session                proxy                      upstream
    ───────                ─────                      ────────
    Authorization:    →    recognise, check policy,  →  Authorization:
    Bearer fwk_live_…      substitute                   Bearer <the real one>

What the session holds is then:

- **short-lived by construction**, because we chose the lifetime
- **instantly revocable**, because revoking is deleting a row we own
- **useless anywhere else** — it authenticates to one listener, reachable from
  one network namespace. Exfiltrated, it is a random string. This is the
  property the storable-only row could not have, and it is now free

So the three categories collapse to one. Every service becomes mintable *from
the session's side*, which is the only side whose blast radius we were ever
arguing about. The upstream's own capability stops being the constraint and
becomes an internal detail of one adapter.

**And the bigger win is the one that comes free with the same plumbing.** If all
egress goes through the proxy, egress can be **denied by default**. A session
that can reach `api.github.com` and `registry.npmjs.org` and nothing else cannot
post the working tree to a pastebin, cannot phone home, cannot fetch its second
stage. That is plausibly worth more than the credential handling, and it is not
available in any design where the session talks to the internet directly.

**Per-request policy also stops being bespoke.** The section above said a
session usually needs an outcome rather than a credential, and that each such
operation has to be designed. A proxy that sees the request can express the same
thing as a rule — `DELETE /repos/*` refused, force-push refused, publish
refused — without designing an operation for each. Row three of the table
becomes a config file rather than a project.

#### What it costs, stated at full price

**TLS must be terminated, so the container must trust our CA.** That CA key is
now the most powerful durable secret in the system: it can impersonate *any*
site to a session, including the coordinator. Concentrating custody is the right
trade — one key in a TPM beats twenty in config files — but it is concentration,
not elimination, and it should be written down as such.

**Every runtime finds its trust store somewhere different**, and this is dull,
unavoidable, per-image work: `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and
`REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`, the system bundle for Go, and a separate
keystore for the JVM. Each one that is missed fails closed and loudly, which is
the good kind of failure, but there is a list and it has to be worked through.

**Substitution is trivial for bearer tokens and not for signed requests.** This
is the sharp edge. AWS SigV4 — and anything else doing HMAC request signing —
computes the signature client-side over the headers and body. There is no header
to swap: the proxy has to *verify* the signature with the fake key it issued and
then *re-sign* the whole request with the real one. That is a known and
implementable pattern, but it is per-scheme work, and it is the difference
between "one substitution table" and "a project". Bearer, Basic and
API-key-in-header are the easy majority; signing schemes are each their own
adapter.

**Not everything is HTTP.** `git` over SSH, and anything on port 22, is not
proxy-shaped. The answer there is `ssh-agent` forwarding to an agent held
outside the container — which is *exactly this design*, twenty-five years early:
the key never enters the session, the session gets a socket that will sign on
request, and forwarding can be revoked. It is a second mechanism rather than a
gap, and its existence is decent evidence the shape is right.

**Pinned clients break.** Rare in CLIs, common in mobile SDKs. They fail
visibly rather than silently, which is survivable.

#### Where 1Password fits, and why this is not the thing I argued against

The proxy needs somewhere to keep the real credentials, and a vault with a
service account is the right answer: better custody than a file, a real audit
log, and rotation that propagates on the next fetch if the proxy caches on a
short TTL rather than at boot.

This is not the MCP-in-the-session idea. **The objection was never to using a
vault; it was to putting one inside the model's context.** An MCP vault tool
gives the agent standing read access to everything in scope, for the session,
decided once at configuration time, with the values landing in context. Here the
vault is read by one component the session cannot address, and what the session
receives is a token that is worthless outside its own network namespace. Same
vendor, opposite blast radius.

The service account token then becomes the one durable secret on the box — which
is the whole point of the recursion note above. It is the thing TPM sealing has
to protect, and now it is the *only* thing.

#### What is still not solved

A session can still *use* everything it is allowed to use. It is authenticated
as us for as long as it runs, and the proxy will faithfully sign whatever policy
permits. The gain is that nothing survives the session, nothing works off the
box, and there is exactly one place that saw every request. That is a real and
large improvement over a token in an environment variable, and it is not the
same as a session being unable to do harm.

### Worked example: `gh` in every session

Every session should have `gh`. Working out what that means end to end is the
clearest test of everything above, because it has all the awkward parts —
a long-running session, a short-lived credential, a CLI nobody wrote, and a
durable secret that has to live somewhere.

**What the durable credential is: a GitHub App, not a token.**

A personal access token is the obvious answer and the wrong one. It is
long-lived by construction, it carries the permissions of a person rather than
of a task, and the only way to scope it down is to make a second one. A
**GitHub App** installed on the org mints **installation access tokens** that
expire in an hour and can be scoped, at the moment of minting, to specific
repositories and specific permissions. So the thing a session receives is
already bounded in time and in reach before any of our machinery is involved.

The App's private key is then the ONLY durable secret in the system, which is
the property worth buying: one thing to protect, in one place, rather than a
token per box per repo.

**Where that key lives, which is the question underneath the question.**

Minting relocates a secret; it never removes one. The private key has to sit
somewhere, and the honest options are:

- **Sealed to the host.** `systemd-creds` with TPM2, `LoadCredentialEncrypted=`
  in the unit. The key is decryptable only on that machine, in that unit. This
  is the answer that needs nothing external.
- **In a secrets manager, fetched by the host.** 1Password with a service
  account and `op read op://vault/item/field`, or the equivalent elsewhere.
  Better custody than a file — real access control, real audit, rotation
  somebody else operates — at the cost of an availability dependency at session
  start, and of the **service account token becoming the new durable secret**.
  That recursion never terminates; it only relocates, and relocating it into a
  vault with an audit log is a genuine improvement over relocating it into a
  file with none.

Either is defensible. What is not defensible is the coordinator holding it.

**On a secrets-manager MCP server specifically: no.**

Handing a session an MCP tool that can read a vault is not the same shape as
anything above, and it is worth being precise about why. It gives the agent
standing read access to every secret in that tool's scope, for the whole
session, decided once at configuration time — not per call, not per task, not
revocable without changing the configuration. It also puts the values into the
model's context, which is the one place we have been trying to keep them out of.

A broker answers *one named request at a time* and can refuse. A vault tool
answers *whatever is asked*. The first is an indirection; the second is a copy
of the vault with extra steps.

**How the token reaches `gh` without the session holding it.**

Two mechanisms, because `gh` and `git` want different things:

- **`git`** takes `credential.helper`, a program git runs on every operation. It
  prints a username and password on demand, so an expiry between a fetch and a
  push is invisible — git simply asks again. This is the mechanism the tool was
  built for and it needs nothing clever.
- **`gh`** reads `GH_TOKEN` from the environment on every invocation, and `gh`
  is a CLI: it starts, does one thing, and exits. So a **shim on PATH** —
  `/usr/local/bin/gh` — asks the per-session socket for a token and `exec`s the
  real binary with `GH_TOKEN` set for that one process. The value exists in one
  process's environment for the life of one command, and never in a file, never
  in the session's shell, never in `~/.config/gh/hosts.yml`.

The socket is the one that already exists: `/run/agent-fleet/<name>.sock`,
bind-mounted into that session's container and nowhere else. The sidecar knows
which session is asking because of which socket it arrived on, so a session
cannot ask for another session's scope. That is the same unforgeability the
hook socket already relies on, used for a second purpose.

**What this bounds, stated exactly.**

A session can ask the broker for a token and then exfiltrate that token. Nothing
here prevents it. What it gets is good for an hour, for the repositories that
session was scoped to, and is attributable in GitHub's audit log to an
installation rather than to a person.

So the property is: **no durable credential ever enters a session, and nothing a
session leaks outlives the session by more than an hour.** That is a real and
bounded claim. It is not "the session cannot misuse GitHub", which no mechanism
on this list provides — see below.

## The visibility rule, and the three routes that went around it

Found by the second security sweep, and the timing is the interesting part.

The rule was never in doubt: a member sees the sessions their verified identity
created, and unattributed sessions belong to the fleet, which is to say the
admin. It was enforced on `list` and on the pinned verbs. Three routes went
around it:

- **`GET /api/hosts`** returned every host's health blob verbatim — and that
  blob carries, per session, the name, the title, the working directory, who
  created it, whose account it runs on, and the live prompt text. The filter
  was being enforced one route over.
- **`GET /api/<verb>/<name>`**, the Shortcut-friendly shorthand, omitted
  `requester` entirely on both coordinators, so `stop`, `resume` and `peek`
  reached any member's session by name. A missing requester reads as "do not
  filter" — forgetting it is the fail-open direction, which is why both
  coordinators now build it through one named helper.
- **`logs <session>`** was routed as a question about a box rather than about a
  session, so it was never ownership-checked at all — while `peek`, which
  returns less, was.

**None of this had ever bitten, and the reason is the lesson.** `createdBy` was
being stored bare while the comparison expected `fleet:<email>`, so the checks
matched nothing and every member request failed closed. The model looked
enforced because it was uniformly broken. Fixing the actor prefix is what made
these routes matter: **an authorisation model that starts working is also an
authorisation model whose gaps start counting**, and the two changes have to
land together or the fix for one is the enabling condition for the other.

Every refusal added here is byte-identical to the one for a session that does
not exist, held constant on the name. A distinct "not yours" tells a member
that a guessed name is real and belongs to somebody else — an existence oracle
built out of an access control.

Topology is deliberately not filtered. Which machines exist, what state they
are in and what code they run stays visible to everyone: a member needs the
host picker to work, and the existence of a box is not somebody's private
information. What is running on it is.

## Asked: should sandboxes pull from a central vault at startup?

Cloudflare Secrets Store is the obvious candidate, and the question is a good
one because it names the real gap in the current design — a token is at rest on
**every host in the fleet**, three boxes means three copies, and a host enrolled
later has none.

**No to that shape, and the reason is not about Cloudflare.** Three costs, in
descending order of how much they matter:

**1. It makes the coordinator hold credentials.** Everything above is built on
the coordinator being treated as compromised: the fixed verb set exists so that
a compromised Worker can do no more than start and stop some sessions. A vault
the coordinator can read turns it into the single highest-value target in the
system — one breach yielding every member's GitHub and Cloudflare tokens rather
than a bounded amount of session mischief. That is not a small trade for a
convenience gain; it is the trade this document exists to refuse.

**2. Pulling AT STARTUP is not better than seeding, it is the same exposure
with a dependency added.** A secret fetched at container start lands in the
container's environment or filesystem exactly as a seeded one does — the same
core dump, the same `env`, the same leak — and now a session cannot start when
the network or the vault is down. Today a host starts sessions with no
coordinator at all, which is a property worth keeping.

**3. Something must authenticate to get the credentials**, and a credential to
fetch credentials is where this kind of design usually quietly ends up back at
a shared secret.

### The version worth taking

The right answer is already in this document and is the one to spend a vault
on: **the broker, and behind it the proxy.** The per-session unix socket is
already built and already authenticated by the bind-mount. A session asks its
own socket for `github`; something on the other side decides whether that
session may have it and returns a value good for minutes. Nothing is stored in
the container, nothing is in the environment, and rotation is invisible because
the next ask returns the next value.

**That** is where a central vault belongs — as custody for what the broker or
the proxy hands out, alongside the 1Password option already listed here. The
distinction is the whole point: with a vault behind a broker the credential
never reaches a session or sits on a host; with a vault read at startup it
reaches both, and the coordinator now holds it too.

So: not "pull at startup" instead of the current model, but "ask on demand"
instead of holding at all — and a vault is a fine backend for the thing being
asked. Which reorders nothing on the list below; it is an argument for item 4
rather than a new item.

### And the narrower gap, meanwhile

A host enrolled later has no copy of a token connected before it joined.
Envelope custody would fix it — the coordinator holding a copy encrypted to
each host's public key, which the P-256 host keys already make possible — but
note the honest limit: **nothing can encrypt to a key that did not exist yet.**
A host that joins tomorrow cannot be handed an envelope sealed today by a
device that has since forgotten the secret. Either something central holds
plaintext, or somebody re-links.

Until the broker exists, re-linking is one tap, and it is one tap per new
machine rather than one per machine per credential.

## Minting instead of storing, and OAuth instead of a PAT

The follow-up question, and the better one: rather than a vault holding a
long-lived token, let something hold **permission to generate tokens** and mint
a short one per session — seven days, or less. And use OAuth rather than a PAT
or an API token.

Both are right in direction. The thing to be precise about is that they change
*which* credential is dangerous, not *whether* one is.

### A minting credential is strictly more powerful than what it mints

This is the sentence to keep. A stolen token is one token, with its scopes and
its expiry. A stolen minting key is **every token that key can issue, for as
long as nobody notices** — and it re-issues after each revocation.

So "the Worker holds permission to generate Cloudflare tokens" is not a smaller
version of "the Worker holds a Cloudflare token". It is a larger one. The same
argument that refuses the vault refuses this harder: coordinator compromise
currently buys start-and-stop-some-sessions, and this would upgrade it to
mint-credentials-for-every-provider-for-every-member.

**The minting key belongs where a compromise is already total for the things it
affects** — the host, behind the per-session broker, or the proxy. A host
compromise already owns that host's sessions; it should not also federate to
the fleet. That is the same reasoning that gave hosts their own keypairs
instead of one shared token.

### GitHub is genuinely solved, and it is the case to build first

A **GitHub App** issues *installation access tokens*: minted from the app's
private key, scoped to selected repositories and permissions, and expiring in
**one hour**. Not seven days — one hour, as the documented default path.

That is the whole idea working, with the provider doing the hard part:

| | PAT today | GitHub App installation token |
|---|---|---|
| lifetime | until it is revoked | 1 hour |
| scope | account-wide by scope | chosen repositories |
| revocation | the person, by hand | expiry, unattended |
| attribution | one token, all sessions | mint per session |

`ROADMAP` already lists "`gh` in every session (GitHub App, installation
tokens, PATH shim)" as designed. This is the argument for promoting it: it is
not an improvement on the paste-a-PAT flow, it replaces it.

### Cloudflare is weaker, and worth saying so

Cloudflare tokens do support `expires_on`, so a seven-day token is real. But
minting one requires a parent with **API Tokens: Edit**, and there is no
scoped-down minting primitive equivalent to a GitHub App installation — the
parent that can mint is close to account-wide. The asymmetry is the point:
GitHub gives us a minting authority that is *weaker* than an account
credential; Cloudflare's is *stronger* than the token it produces.

So Cloudflare stays pasted for now, or goes behind the proxy where the session
never holds either. Pretending the two providers are the same shape is how the
weaker one gets the stronger one's architecture by association.

### OAuth versus a PAT: better, and not free

OAuth buys consent the person can see and withdraw at the provider, scopes, and
— with GitHub Apps' user-to-server tokens — an eight-hour access token with a
refresh token behind it. All real.

Two costs, stated rather than discovered:

- **The refresh token becomes the long-lived secret.** OAuth moves the problem
  down a layer; it does not remove it. What it changes is that the long-lived
  thing is revocable from a screen the person already knows, which is worth
  something.
- **It puts a client secret of ours in the middle of their consent screen** —
  the one property the current design deliberately bought by having people
  paste their own tokens: no OAuth app, no client secret, no callback, and
  nothing of ours between a person and their provider. Taking OAuth means
  spending that, deliberately.

For a GitHub App the trade is clearly worth it, because the same app is what
issues the one-hour installation tokens. Elsewhere it is a judgement call per
provider rather than a policy.

### What this reorders

Nothing on the list below moves, but item 4 gains a shape: **the broker first,
then a GitHub App behind it.** The broker is what makes short-lived credentials
usable at all — a token that expires in an hour is a liability if a session
holds it in an environment variable, and unremarkable if the session asks a
socket each time and gets the current one.

Minting without the broker is a shorter fuse on the same bomb. The broker
without minting is already an improvement. In that order they compose; in the
other order the first half makes things worse.

## What this does not solve, and should be said out loud

An agent that can make authorised requests can make bad ones. Moving the
credential out of the session bounds *theft*, not *misuse* — the same
distinction as design.md §5's containment argument, where a contained agent can
still push with whatever credential it holds. Scoping what the broker will
answer for, and what the proxy will sign, is the part that bounds misuse, and it
is separate work from either mechanism.

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
