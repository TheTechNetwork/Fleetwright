# Security specification

The document a change is held against. `trust.md`, `design.md` and `intents.md`
argue; this states what must be true, and — for every normative claim — how you
would catch it becoming false. Where those essays assert something the code
contradicts, this document states the true version and names the file to correct.

Read the two things that make it usable before the prose:

- **Property IDs** (`SEC-AREA-n`) are stable. Cite them in tests, code comments
  and findings. Do not renumber; retire with a note.
- **Aspirational is marked.** A property written in the present tense is claimed
  to hold in the code today. Anything not yet built says **ASPIRATIONAL** in the
  statement itself. This project has twice shipped a false present-tense claim
  (§9); the tense is load-bearing.

Keywords MUST / MUST NOT / SHOULD are RFC-2119, used only where genuinely
normative.

---

## 1. Actors and what each is trusted with

| Actor | Is | Trusted to | Explicitly NOT trusted to |
|---|---|---|---|
| **Coordinator** | Cloudflare Worker + Durable Object, internet-facing at `fleet.thetech.network` | Route intents, hold device-token hashes, host public keys, enrolment pins, the GitHub App **client secret**, and relay OAuth. Authenticate phones and hosts. | Read any session secret; hold a refresh token, a GitHub App private key, or a member's Claude credential. It is **treated as compromised** for custody decisions. |
| **Host** | Debian box: fleetwright + sidecar + rootless podman | Be the sole authority on its own tmux, hold its own P-256 key, hold at rest the credentials of members who linked on it. | Speak for any host but itself (a reply is taken only for an intent sent to it); speak for, or be given the work or credentials of, a member it does not act for (`mayActFor`, `hosts.js`); hold a fleet-wide admin credential. |
| **Session** | A Claude Code agent in a container, root inside, reading untrusted input, holding live credentials | Do the work it was asked to. Nothing else. It is the **least trusted component in the system**. | Be believed about who it is (it reports over a bind-mounted socket it cannot forge); hold anything whose leak must outlive it. |
| **Phone app** | iOS/Android, App Store / Play, holds one per-device credential | Act as the member it was issued to, until revoked. | Contain any baked-in fleet secret (an IPA/APK is public). |
| **Member** | A verified email on the allowlist | Drive their own sessions, see their own sessions, mint enrolment pins; administer a box that acts for them alone. | See or act on another member's sessions; link a Claude account for anyone but themselves; change the release channel, image or labels of, update, upgrade or reboot a box that does not act for them alone, since each reaches everybody's work on it and a reboot names and ends every session there (`place`, `scheduler.js`). |
| **Guest** | A member who brings their own Claude/GitHub/Cloudflare and has no shell on any box | Same as a member. Never inherits shared GitHub/Cloudflare credentials. | Inherit anyone's provider tokens; get OS-level isolation from other members on the same host. |
| **Admin** | First verified member on a fresh fleet; the `admin` bit | Remove hosts and other people's devices; see every session; administer any box. | — (admin is the ceiling; there is no super-admin) |
| **Platform parties** | Cloudflare, Apple, Google, GitHub, Anthropic | Nobody chose them; everybody depends on them. Compromise or coercion of any is out of scope (§10). | — |

**SEC-ACTOR-1** — Every component MUST be designed so that its own compromise
has a written, bounded cost in §4. A component whose compromise cost is "total,
everywhere" is a design error, not a risk to accept.
*Falsify:* find a component in §4 whose bound is "everything" and is not the
coordinator's break-glass token or a platform party.

---

## 2. Trust boundaries

Five boundaries. A credential or an instruction crossing one is where the
interesting failures live.

```
  phone ──(1)──▶ coordinator ──(2)──▶ host ──(3)──▶ session (container)
                      │                  │
                      │              (4) │ loopback HTTP (fleetwright)
                 (5) issuer                └── unix socket ──▶ session
              (OIDC verify)
```

1. **phone → coordinator.** Authenticated: per-device bearer token, hashed at
   rest, compared timing-safe (`clients.js`).
2. **coordinator → host.** **Carried, not verified.** The host obeys any intent
   that arrives over its authenticated socket. This is the sharpest boundary in
   the system and the one the docs describe wrongly — see §5 and §9.
3. **host → session.** One-directional seeding (credentials in) plus a
   per-session unforgeable socket (uuid out). The session cannot cross back.
   **Only for a sandboxed session.** A box that runs sessions directly
   (`FLEETWRIGHT_SANDBOX` off, which is every Mac and any Linux box installed
   without podman) has no boundary here at all: the session is a tmux pane
   running as the service user, and holds everything that account holds (G8).
   So a member's session goes on such a box only when the box acts for that
   member alone (`runsSessionsFor`, `hosts.js`).
4. **anything-on-host-loopback → fleetwright.** Token-gated (§6.4, §9-G6): a
   token is generated into `${stateDir}/api-token` when none is configured, and
   the check fails closed. The boundary is "any local process that can read
   that file," which in practice means the service user.
5. **coordinator → issuer.** The one place identity is actually established, and
   the coordinator does it correctly (§5.1).

---

## 3. What each store physically holds

Custody in one place, so §4's bounds are checkable against it. "At rest" means
on disk or in durable KV; "in flight" means in a process or on a wire.

| Secret | At rest where | Readable by | Rotation | Revocation | Detection |
|---|---|---|---|---|---|
| **Device token** (`fwk_…`) | phone Keychain/Keystore; **hash only** in the DO | the phone; nobody via the DO | re-issue | `revoke(id)`, per-device | `lastSeenAt`, client list |
| **Break-glass admin token** (`FLEETWRIGHT_API_TOKEN`) | Cloudflare secret | the Worker; whoever holds the Worker's secrets | `wrangler secret put` under this name + redeploy | delete the secret, which leaves no break-glass and never an older one (SEC-CRED-4) | none; it is unattributed by design |
| **GitHub App client secret** | Cloudflare secret; on hosts, sidecar **memory only** — delivered on the config frame, never written (§9-G2, fixed) | the Worker; each connected sidecar on a box the operator runs, in memory (and root on that box, via process memory). Not a box a member enrolled, a pool's own machine or a runner (`actsFor`, `hosts.js`), and not a box enrolled by an admin since removed: the tier wants an admin holding a credential that still works, and is decided again when they are removed (`#isOperator`, `core.js`) | change in Cloudflare + redeploy; hosts pick it up on reconnect | none scoped: a box that leaves the operator's tier when its admin is removed keeps it in memory until it restarts, so the removal records `host.demoted` naming the box and saying to rotate, worked out from the enrolments so that a box offline at the time, or missing from the registry after a restart, is named too (`#forgetPerson`, `core.js`) | none |
| **Host private key** (P-256) | `/var/lib/fleetwright-sidecar/host-key.json`, `0600` in `0700`, mode re-checked every load | the sidecar's own account (`fleetwright-sidecar`) only — not the session user, so neither the hub nor a session escape landing as it can read this, **on a packaged Linux box**, where the sidecar runs a root-owned copy of a verified release from `/usr/local/lib/fleetwright-sidecar` that the session user cannot change. On a git checkout, or a box whose node lives in the session user's home, the session user can change what the sidecar runs and so reach this key through it; the installer says so in those words (`hardening.md`) | re-enrol the host | `revoke` at coordinator, per-host | mode check refuses to start if loosened |
| **Host public key** | coordinator DO | anyone who reads the DO (public half; harmless) | with re-enrol | with revoke | host list |
| **Box Claude credential** | **gone as a standing store** — adopted once into `${stateDir}/accounts/<email>.json` and handed to the member it belonged to; a session with no linked account is refused, not given a shared one (`one-account-per-person.md`) | — | — | — | — |
| **Member linked Claude credential** | `${stateDir}/accounts/<email>.json` on hosts where linked | host service user; that member's sessions (a copy) | keepalive / re-link | `/accounts remove`, `unlink`; a removal from the fleet deletes it on each of the fleet's own boxes, asked with `forgetperson` at once or on the box's first report after it returns, and owed until the box itself says it is done (`#forgetOnBoxes`, `core.js`; `forget-person.js`; G13). Not on the person's own boxes, which act for them alone | `/api/state` per-account |
| **Member provider token** (GitHub/CF access token) | `<row>.env` on each reachable host that may hold it: the operator's boxes, and the member's own boxes and runners, never another member's (`mayActFor`, `hosts.js`) | host service user; a session only **per request, via the broker socket** — nothing is seeded into the volume (`credential-broker.md`) | GitHub App: 8h auto-renew; CF/PAT: manual | `unlink` (local), which deletes the renewal material with the token (until G13 it left it, and the next renewal wrote a fresh token back), and which a removal also asks of a box it takes out of the operator's tier, for every other person whose credential was live at the removal and nobody who joined since, then or, for a box away at the time, on its first report after it returns: each request names its person, so a box that put the debt off was otherwise told the emails of everybody who joined meanwhile (`#handBack`). The fleet's own boxes are asked instead to forget the person removed, with `forgetperson`: `<row>.env`, its metadata and `<row>.renewal.json` deleted in one act, asked at once or on the box's first report after it returns, and owed until the box itself says it is done (`#forgetOnBoxes`, `Connections.forget`, G13); not the person's own boxes. A copy held from the person's vault is not a link and `unlink` does not reach it; it stops because the minter serves no grant of somebody no longer in the fleet, and the box deletes it on that ask (`#onHostVault`, [vault.md](./vault.md)), or at once when it is asked to forget them; provider revoke (real) | `verify` verb |
| **Member GitHub refresh token** | `<row>.renewal.json`, `0600` | host service user only; **no session** | rotated on every renewal exchange | `unlink`, which until G13 left this file behind; `forgetperson`, for somebody removed; provider revoke | renewal-failure log |
| **Enrolment pin** | coordinator DO, **plaintext**, 10-min TTL | the Worker | single-use, expires | expiry; `DELETE /api/enroll/{id}` by its minter or an admin; dropped when its minter is removed (`#forgetPerson`) | `outstanding()` (masked) |
| **Telegram bot token** (archived) | host env (`FLEETWRIGHT_TELEGRAM_TOKEN`), **read by nothing** | host service user | manual | delete the line | `fleetwright doctor` names it |
| **GitHub App private key** | **nowhere in this system** (ASPIRATIONAL: waits for the broker) | — | regenerate at first use | delete in GitHub | — |

**SEC-CRED-1** — The coordinator MUST NOT hold, at rest or in flight, any secret
from which a session credential can be derived: no refresh token, no App private
key, no member Claude credential. The client secret is the single deliberate
exception, and only because it is inert without a refresh token (§7).
*Falsify:* grep the Worker and `coordinator/` for a store of refresh tokens,
`.pem`, or `accounts/*.json`. Test `test/oidc.test.js` and the DO storage schema
should show device hashes, host public keys, pins, pending-OAuth states — and
nothing else secret.

**SEC-CRED-2** — A refresh token MUST NOT travel to any session. It lives in
`<row>.renewal.json`, mounted into no container.
*Falsify:* assert `renewalPathFor` output is never in `sandboxArgv` mounts and
never written to `<row>.env`, and that the broker's answer to a session never
carries a `refresh` field (`credential-broker.js`).

**SEC-CRED-3** — Any file holding a live credential MUST be `0600` in a `0700`
directory, and permissions SHOULD be re-checked on load, not only set on write.
*Falsify:* `host/identity.js` re-checks and refuses, and so does the credential
store now — `Connections` re-checks mode on every read, tightens, and warns
(§9-G5, fixed; `test/connectors.test.js`).

**SEC-CRED-4** — The coordinator Worker MUST read each secret under exactly one
name. A deleted or blank secret is absent, and no other name stands in for it,
least of all one from before the rename: a coordinator migrated off
`AGENT_FLEET_*` still holds those copies, and when the Worker fell back to them,
deleting `FLEETWRIGHT_API_TOKEN` brought the token it replaced back as admin.
Removing or rotating a credential is only real if nothing else can supply it.
*Falsify:* give the Worker `AGENT_FLEET_API_TOKEN` and a deleted or blank
`FLEETWRIGHT_API_TOKEN`, and present the old value; it must be refused
(`test/optional-admin-token.test.js`). The Durable Object must not read its
sign-in settings or allowlist under an old name either (`test/fleet-do.test.js`),
and the deploy's secret sync reads no `AGENT_FLEET_*` name
(`.github/workflows/worker.yml`).

---

## 4. Threat model — the real bound for each compromise

Each row states what is reachable and for how long. "Signed intents" appears in
several as the control that would tighten the bound; it is **ASPIRATIONAL and not
built** (`trust.md` concedes this; `intents.md` implies otherwise — §9-G1).

### 4.1 Compromised coordinator (the one the docs get wrong)

**Published bound (WRONG):** "can do no more than start and stop some sessions"
— `design.md:233`, `intents.md:29`, `trust.md:72`, `coordinator.md:86`,
`intents.js:13`.

**Real bound:** a compromised coordinator can drive **every verb**, including the
credential-writing ones (`link`, `renew`, `connect`, `unlink`) that the fixed set
gained in v2. Concretely it can:

- write an **attacker-controlled** provider token into any member's row (`link`
  with a chosen `secret` and a chosen `actor`), which is then seeded into that
  member's sessions — the victim's agent operates as the attacker's token;
- deposit renewal material (`renew`), and forge the `actor` on any intent, so
  attribution is worthless under this compromise;
- `start` a dangerous session as any member and `peek` its pane, reading the
  member's seeded Claude/provider credentials out of it;
- **write that session's instructions** (`start.task`, protocol 7), on any host,
  permanent boxes included. Until v7 it could only name a profile a person
  with a shell had put on the box, so what an unattended session was told to
  do was bounded by files the box's owner had written. The owner decided on
  4 Oct 2026 to let a start carry its task everywhere, because a runner has no
  profiles and every session started on one came up idle. What a session so
  instructed can reach is whatever that member's session can reach: their
  linked Claude account or a runner's kept login, their seeded provider
  tokens, the per-repository GitHub tokens the App mints for a runner, for
  the job's life. Text into a session that is already running still has no
  route;
- `unlink` any member (denial), `stop`/`forget`/`purge` sessions, `reboot` hosts.

**What it still cannot do:** read a refresh token or App private key (it never
receives them — SEC-CRED-1/2), or forge an OIDC identity to a host that verified
one (for every verb but `mint` no host does — the host trusts the
coordinator-supplied `actor`, so this is moot under this compromise, not a
protection; `mint` is the exception, below).

**`mint`, which produces a credential, and what it adds to this bound.** It is
the verb that makes a runner a GitHub installation token for one repository
(`runner-central.md`, "Private code on a runner"), and SEC-COORD-1 requires it
be accounted for here. The coordinator does not mint: it relays the ask to the
**minting Worker**, a separate script holding the App key with no public route,
or to a permanent box holding it. A compromised coordinator can drop the ask,
delay it, or send it to the wrong minter — denial, bounded per runner at thirty
asks in ten minutes. What it cannot do is get a token it can use:

- the reply is **sealed** to a P-256 key the runner generated for that one
  request, so what the coordinator relays is ciphertext;
- the key and the repository are bound into the **audience of a GitHub Actions
  job token**, which the minter verifies against GitHub's own keys — so
  substituting its own key, or a different repository, fails GitHub's
  signature rather than the coordinator's word;
- that job token must come from one of the four **runner workflows, started by
  a dispatch**, and the token is no wider than **what GitHub says the account
  that started the job can do** in that repository — asked by account id, by
  the minting Worker with a metadata-only probe token, or by a box with that
  person's own connection. Nothing the coordinator claims about the owner is
  read;
- and the job must have run in **that account's own repository or one on
  `FLEETWRIGHT_GITHUB_MINT_OWNERS`**, as the Claude hand-out below requires.
  The job's code chose the repository and the key, so without this a
  `runner-linux.yml` in a stranger's repository that the person was got to
  dispatch would be minted their push on a fleet repository, sealed to a key
  that stranger holds.

To obtain such a job token it would need code of its choosing running inside a
runner the person started. `provision` cannot express one — no workflow file,
no ref, no inputs, and the host code the job runs is the published default —
and a session on a runner runs only what a person or a profile gives it, and a
runner has no profiles. This is the one place something verifies an identity
the coordinator relayed rather than trusting it, which is why it holds here when
nothing else in this section does.

**Whose reach a runner is given is the coordinator's word**, because only it
knows whose a runner is. The minting Worker mints for the account that started
the job, so the coordinator asks it only for a runner the fleet dispatched
with a ticket, with a job token naming the account that started it at
enrolment, and sends one admitted with a reusable runner token to a box as its
owner, which mints only when the job was started by the GitHub account
connected for that person there. The two accounts differ when one member's
runner token is a shared repository's secret and another member presses Run
workflow; that runner was minted the starter's push for the token owner's
sessions. Under this compromise the check can be skipped, which hands such a
runner the starter's reach again; the minter's own checks still hold it to what
GitHub says the starter can do, for a runner job the starter started.

**A person's Claude login on their runner, and what it adds.** Not a verb: a
`claude-login` frame a runner sends, and `PUT /api/claude-login`, which a
person's own computer calls to deposit their `claude setup-token` with the
minting Worker (`runner-central.md`, "Your Claude login on a runner"). Both
carry a credential through the coordinator, so both are accounted for here.

- **The deposit** is sealed on the person's computer to the minter's deposit
  key, and the tool refuses to seal unless that key is the **pin** the person
  was given by their operator, by a route that is not the fleet. A coordinator
  offering its own key is caught there, before anything is sent. Inside the
  seal is a GitHub token of theirs: the minter asks GitHub whose it is and keeps
  the login for that account id, so the coordinator's word about the person is
  never read, and the GitHub token is not kept. Each deposit carries its time;
  one older than ten minutes, or not newer than the one held, is refused, so a
  captured envelope cannot be replayed to put back a login its owner forgot.
- **The hand-out** is `mint`'s construction without the repository: sealed to a
  one-request key, bound into the audience of the runner's job token, verified
  against GitHub's keys, a runner workflow started by a dispatch — and the
  login goes to the account that **started the job**, and only from a job in
  that account's own repository or one on `FLEETWRIGHT_GITHUB_MINT_OWNERS`.
  **And only to its depositor's own runner**: the minter keeps the fleet
  account that sent each deposit, and refuses a hand-out to a runner enrolled
  for anybody else. The job's starter and the runner's owner differ when a
  member's reusable runner token is a shared repository's secret and somebody
  else presses Run workflow; that runner was handed the starter's login for
  the token owner's sessions. A login kept before deposits named their fleet
  account is refused until it is deposited again.
- **What it can still do** is deny: drop a deposit or a hand-out, and the
  runner uses its repository's API key. Both fleet accounts above are its
  word, the only part of the hand-out that is, because only it knows whose a
  runner is; it names the runner's owner in the reply too, and the runner runs
  that person's sessions on the login. A lie there changes whose sessions on
  *that one runner* use it, which is no more than forging the `actor` on a
  `start` already gives it, and the minter's check can only refuse what
  GitHub's half would have allowed. It can start sessions on
  the runner, which then run on the person's subscription; a runner has no
  profiles and no verb carries free text, so such a session sits at an empty
  prompt. The login never leaves the runner through the fleet: the file verbs
  reach podman volumes only, and a runner has none.
- **A token made on a machine** (`setuptoken`) is in the clear on that
  machine for the seconds between the CLI printing it and the seal: on its
  pane, and in the hub's memory. The machine is one that may hold the person's
  credentials, an operator's box, one they enrolled or their own runner
  (`mayActFor`), which already holds their linked login if they have one, and
  never a box or runner another member controls. It keeps nothing: the
  pane and its config directory are removed before the reply, the code is
  masked in the journal, and the token is in no reply text. The coordinator
  relays the sign-in page and a ciphertext sealed to the phone's one-answer
  key. What it can do is the usual: refuse, or send the phone's request to a
  different machine of the fleet, which then makes the token instead. It still
  cannot read it, and only whoever started a flow can finish it.
- **What it cannot narrow** is the credential itself: a setup-token is the
  person's whole subscription for a year. At rest in the minter it is sealed
  to the deposit key under the account id; on the runner it is a 0600 file for
  the length of the job, and the session running there can read it. That is
  the reach a session on their permanent box already has with their login.

**A hypervisor's admin sign-in** (`xoprobe`, `xosetup`, `docs/hypervisors.md`).
Onboarding a Xen Orchestra pool carries its admin sign-in from a phone to one
machine of the fleet, through the coordinator.

- **It relays ciphertext.** The phone seals the sign-in to a key the machine
  made for that one job, under a binding of the job and the address, so a
  sealed sign-in cannot be replayed into another job or pointed at another
  Xen Orchestra. The machine opens it, uses it for the steps, wipes it on
  every way out and writes it nowhere.
- **It cannot substitute the key.** The machine signs the job's key with its
  enrolment key, over the job, the address, the pin and the key together; the
  phone checks that signature against the fingerprint it approved for the
  vault, or has the person compare it with `fleetwright-sidecar identity` on
  that machine. A coordinator that swaps the key cannot sign the swap.
- **It cannot redirect the connection.** The machine connects only to a server
  presenting the certificate the person accepted (its SHA-256, from the probe),
  and sends nothing to any other. What a compromised coordinator can still do
  is refuse, or send the request to a different machine of the fleet, which
  then runs the setup; the phone's signature check names the machine it
  verified.
- **Except over plain HTTP, which a person chose.** A Xen Orchestra with no
  certificate has nothing to pin, and setting it up there means the admin
  sign-in, and every later call with the fleet's token, crosses the network
  between that machine and Xen Orchestra as it is. Anything on that path can
  read and redirect it. The phone says so in those words and `begin` carries
  `plain: accepted` only after the person says send it anyway; the sign-in is
  still sealed from the phone to the machine, so the coordinator never sees
  it. The bound is the network between the machine and Xen Orchestra, which
  for the common case is one LAN the person owns.
- **A certificate nothing vouches for is accepted by a person, not by
  default.** The probe reports what is wrong with the certificate as well as
  its fingerprint; the phone shows it, and `begin` carries `trust: accepted`
  only after the person says they checked it. The machine refuses to connect
  to a certificate that does not check out without it. This is not what keeps
  the password from another server — the pin is — and a coordinator could set
  the flag itself; what it would gain is a setup the phone then has to seal a
  sign-in for, which the phone does only after asking.
- **The probe is a port scan, one address at a time.** `xoprobe` asks every
  permanent machine of the fleet's own to reach an address on its network
  (`begin` goes only to one of them too, by name or as the only one; a box a
  member enrolled acts only for them, `mayActFor`), and answers with
  whether something did, whether it looks like Xen Orchestra and its
  certificate. Admin only, checked here, which a compromised coordinator does
  not respect; the reach is "does this address answer HTTPS from that box",
  and, from a box that can install Xen Orchestra, "does it answer SSH on
  22, and with which host key", which is all `ssh-keyscan` learns.
- **Through the phone, the bytes are TLS the machine opened**
  (`/api/xosetup/relay`, `docs/hypervisors.md`, "Through the phone"). When
  no machine reaches a pool, the phone adding it carries bytes between one
  machine and the address on the phone's own network. The machine opens TLS
  over them and holds it to the pin. The phone and the coordinator carry
  ciphertext: neither reads the sign-in, the token, or anything Xen
  Orchestra answers. Plain HTTP is refused through a phone, by the
  coordinator and by the machine. So is installing Xen Orchestra, which is
  SSH to the pool master: the machine refuses it, and the probe through a
  phone looks only for HTTPS, never for SSH.
- **The pin comes from the phone's own look.** Over a relay the coordinator
  is on the probe's path. It could answer the machine's handshake itself,
  and a person used to self-signed certificates might accept that one. So
  the phone reads the certificate at the address directly, and offers the
  machine only when its probe through the relay saw the same one. A
  compromised coordinator can make the two disagree, which stops the setup.
  It cannot make them agree on a certificate of its own, because it is not
  on the phone's own path.
- **What a compromised coordinator can do with a relay:** open TCP
  connections from inside the phone's network to the one address the person
  typed, at most eight, for at most fifteen minutes and 64 MiB, carrying
  what it likes. That reaches Xen Orchestra's unauthenticated surface (its
  sign-in page and the API's handshake) from the person's network for that
  window, and nothing else: no frame carries an address, so it cannot point
  the phone at another host or port. It can also drop, delay or corrupt
  bytes, which TLS turns into a failed step. **What it cannot do:** read or
  change anything inside the TLS, open a relay without an admin's phone, use
  one from another phone or for another person, or keep one past the job.
- **What a compromised phone can do with a relay:** nothing it could not
  already. It is where the person types the admin password, so it could read
  that without a relay. Through the relay it sees TLS records. It can
  withhold or corrupt bytes, which fails the job, or connect the machine to
  another server, which the pin refuses before a byte of the sign-in is
  sent.
- **What a compromised machine can do with a relay:** what it could do with
  the sign-in sealed to it, which it already holds. The relay adds a TCP
  path to the one address, only while its probe or its job runs.
- **Progress on a Lock Screen is not sealed.** A Live Activity's content goes
  to the widget with no hook that could decrypt it first, so it carries step
  and part numbers and keys from fixed lists (the step, and what is being
  built), never an address or a name. The words
  travel in the ordinary notification, which is sealed.
- **Changing what the fleet may use needs the admin sign-in again**, sealed
  the same way. The pool's inventory goes back sealed to the phone, the
  person's choice comes back sealed to the job's key, and the machine
  checks it against what it showed before applying it as the resource set,
  which is what bounds the fleet's token. A compromised coordinator can drop
  or delay either message; it cannot read the pool's storage and networks
  or change what was chosen. The machine holds the signed-in session, not
  the password, for at most ten minutes while the person chooses.
- **The admin sign-in can be kept on the phone, when the person asks.**
  *Keep on this phone* puts the admin email and password, and the
  fingerprint of the certificate they accepted, in a Keychain item that
  opens to Face ID or Touch ID only (this device only, gone with the
  passcode), or under an Android Keystore key that needs a strong
  biometric check for every use and is retired by a new enrolment. That is
  an admin credential at rest on a phone. The bound is the phone's own
  biometric unlock, and what is kept never leaves it: the fleet still
  receives only the sign-in sealed to one job's key. It is written only
  after the machine signed in with it, and is off unless turned on.
- **Reconnecting a pool's servers uses the admin sign-in once, for one job**
  (`docs/hypervisors.md`, "When a pool goes missing"). The phone opens the
  kept sign-in with Face ID, Touch ID or a strong fingerprint or face check
  (or the person types it) and seals it to one job's key on one machine,
  saying `purpose: reconnect` inside the seal, where a coordinator cannot
  change it, under a binding of its own,
  `fleetwright-xosetup-reconnect-signin/v1:<job>:<address>`, and only to a
  machine whose `begin` lists `reconnect-signin`. A machine older than that
  binding cannot open it, where under the setup's binding an older one
  opened it and ran a whole setup. `can` is not signed, so a compromised
  coordinator can add the word to an older machine's `begin`; all that gets
  it is a seal that machine cannot open. The machine opens anything under
  that binding only as a reconnect, and refuses, before it reaches Xen
  Orchestra, any purpose it does not know rather than run a setup for it.
  The machine holds the signed-in session, not the password, for at most ten
  minutes. It calls `server.enable` and `server.disable` and nothing else
  that changes anything: only on servers that are not connected, or are
  connected with an error Xen Orchestra recorded; never on a server a person
  turned off, which stays off; and it keeps nothing afterwards. A server it
  disables to cycle is asked to turn on again before the session closes: the
  ten minutes do not cut a cycle in the middle, and one is begun only with
  room for the longest it can take, every call waiting the minute the
  connection allows. A server left off all the same, because Xen Orchestra
  refused or the connection to it ended (which a relay can cause), is said
  on the phone to be off, or to have been turned off by this job and maybe
  left so, never to have been left as it was. A later reconnect cannot tell
  that server from one a person turned off, and leaves it off. That is every
  server Xen Orchestra lists, including pools outside the fleet's resource
  set, which is what a person reconnecting by hand would touch. Which
  servers there are, their addresses and what became of each is sealed to
  the phone under `fleetwright-xosetup-reconnect/v1:<job>:<address>`; the
  coordinator relays counts and the address. Only an admin can run it.
- **A lost pool's push is bounded by whose pool it is.** It goes to the
  owner's and the admins' phones only, once per pool per hour plus one
  recovery, and to at most eight addresses per person in an hour, since the
  addresses are a box's word; the event is the owner's, and other members do
  not see it. Only a box that may act for the owner is listened to, and only
  a look that reached Xen Orchestra. **A compromised coordinator can push a
  "pool lost" that is not true**, as it can push anything, with a Reconnect
  button for any address it likes. The worst that follows is a reconnect the
  person approved with their face or their password: the phone opens a kept
  sign-in only for the address it was kept for, the machine still holds the
  sign-in to that address's pinned certificate, and the job only reconnects
  servers that were not connected or carried an error. The category
  `fleet.pool.reconnect` is in the clear to Apple and Google, as the prompt
  categories are (`docs/push.md`): on a sealed push it says that a pool went
  missing, never which.
- **The edge router is built from a pinned image, with nobody's login.**
  The machine downloads OPNsense's published nano image, refuses it unless
  its SHA-256 is the one pinned in the source, and replaces only the default
  configuration's bytes, after checking those against their own pinned hash.
  The disk goes to Xen Orchestra over the job's pinned connection. The image
  as published is kept on the pool as a template so a rebuild can copy it
  and write only the configuration's blocks into the copy, checked the same
  way first; that template is visible to Xen Orchestra's admins only, is not
  tagged for the fleet and is outside its resource set, so the fleet's token
  can neither see nor clone it, and no box offers it for sessions. The router
  has no account anyone can sign in to (root's password is `*`) and no
  anti-lockout rule, so a lab, the only thing on its LAN side, cannot change
  the rules that keep it off the person's LAN. It is not tagged `fleetwright`,
  so the fleet's limited token cannot stop, move or delete it. Its WAN may go
  on any network the pool lists, including one outside the fleet's resource
  set, and that is the safer place: a network the fleet's VMs cannot attach
  to is one no lab can use to leave without passing through the router.
  Putting the WAN on a network the fleet may also use is still allowed, and
  leaves that way around the router open.
- **The edge filters names and watches traffic** (`docs/hypervisors.md`,
  "What the edge filters"). Names on two threat blocklists resolve to
  0.0.0.0, and DNS to any resolver but the edge is blocked; DNS over HTTPS
  to a resolver by address is not, so this stops malware that uses the
  network's resolver, not a session determined to get around it. Suricata
  detects and logs, and drops what its rules match when the policy says so,
  failing closed: an edge set to drop whose Suricata has stopped lets nothing
  out. Both are in the edge's own
  configuration, which no fleet credential can change, and both are fetched
  by the edge itself from their publishers over HTTPS: a compromised
  blocklist publisher could make names fail to resolve, not reach anything.
- **A pool master's root password** (`docs/hypervisors.md`, "A pool without
  Xen Orchestra"). Installing Xen Orchestra on a pool that has none carries the
  pool master's root password and a new admin password from the phone to one
  machine, sealed to the job's key under its own binding
  (`fleetwright-xodeploy/v1:<job>:<address>`), with the job's key signed under
  its own context over the pool master's SSH host key, which the person
  compared with the pool master's console. The machine refuses a server
  answering with any other host key before the password is offered (its own
  `known_hosts`, `StrictHostKeyChecking=yes`), types the password once into one
  OpenSSH master through `SSH_ASKPASS` from a socket only its process can reach,
  and wipes it when the master is up; nothing the installer runs can ask for
  it (`BatchMode=yes` on every client, riding the master). Root on the pool
  master is everything on the pool, for as long as the master connection is
  open: the length of the install, half an hour or so. What a compromised
  coordinator can do is what it can with a setup: refuse, delay, or send the
  request to another machine of the fleet, whose signature the phone checks
  against the one it approved. The installer it runs as root on the pool
  master and in the VM is pinned by commit and SHA-256 per file; Debian's
  image is checked against Debian's own published checksum, fetched over
  HTTPS by the pool master; Xen Orchestra's sources are the installer's
  default, `master`, unpinned.
- **Xen Orchestra's default admin password is a window.** The installer
  leaves `admin@admin.net` / `admin`; until it is changed, anything on the
  management network can sign in as admin. The machine changes it to the
  person's the moment the script says Xen Orchestra is up, over a certificate
  it made itself before the VM existed (so the pin is known and no first-use
  trust is involved), and stops rather than going on if the default no longer
  works. The certificate's key is 0644 inside that VM, whose only accounts are
  root and `xo` (with sudo, by a key nobody holds).
- **A kept acceptance is the person's earlier word, for that certificate
  only.** With it the phone sends `trust: accepted` without asking again,
  but only for a probe or a remembered path carrying the same fingerprint.
  A different certificate is asked about in full. The remembered machine
  changes nothing about where the sign-in can go: `begin` names it, the
  coordinator can still route elsewhere or refuse, and the key check names
  the machine that signed.
- **What is kept** is the limited user's token, and only on the phone that
  asked. The phone puts a key of its own inside the sealed sign-in; the
  machine seals the token to it under a binding of its own
  (`fleetwright-xosetup-handoff/v1:<job>:<address>`) and writes nothing. The
  coordinator relays that ciphertext too, and cannot swap the key, which
  came inside a seal it cannot open. The phone keeps the token in the
  Keychain (this device only) or under the Android Keystore key. What it can
  do is bounded in Xen Orchestra by the resource set. The machine that ran
  the setup holds nothing after the job; until the job is forgotten (six
  hours) it holds the sealed copy in memory, which only the phone can
  open.
- **The same token, kept in the fleet** so a session can start on a machine
  from the pool (`docs/hypervisors.md`, "Machines from your pool"). The phone
  puts the record in the person's vault as `hypervisor:<address>`: sealed at
  rest in the minting Worker, changed only by that person, handed only to a
  box whose key they approved. The coordinator relays it sealed. A box takes
  it out of the vault's answer before its hub sees it and **holds it in its
  sidecar's memory only**, so no session can read it and no disk holds it;
  a box removed from the vault stops being given it on the next pass. What
  a compromised approved box can do with it is what the resource set allows:
  clone the images in the set onto the storage and networks in the set,
  within its limits. That is the bound the token always had, now reachable
  from every box the person approved instead of from their phone alone.
- **A machine from the pool is admitted by a ticket alone.** There is no
  GitHub token beside it, so a VM ticket admits a machine: single use, at
  most forty-five minutes, bound to the person who asked, and spendable only
  at `/api/enroll/vm` (a runner's ticket is refused there, and a VM's at
  `/api/enroll/actions`). The name is derived from the ticket, never chosen.
  It travels only on the machine's cloud-init drive, with the person's Claude
  login from their vault; the machine wipes the drive as its first act and
  Xen Orchestra is asked to destroy it after boot. Somebody who read the
  drive before then (a pool admin, or anything that can read that storage)
  could enrol a machine of their own as that person's temporary host and be
  started the session asked for with it, and has their Claude login: the
  same reach as reading the machine's own disk, which the hypervisor always
  had. The box checks the image it clones is one it saw tagged
  `fleetwright-image` on that person's pool, and a network one it saw on
  that pool, so the coordinator can name which of the person's images and
  which of the networks the policy allows, and nothing else.
- **A machine image's build VM reports its install** at `/api/xosetup/report`,
  without a fleet credential, because its token is one: minted by the
  coordinator only for the box running that policy job (`image-reporter`),
  one live token per job and three per job at most, kept as a SHA-256 hash,
  gone when the job ends or after an hour, and good for 140 reports (the
  session image's pull every 15 seconds through the install's 25 minutes).
  What it admits is a word from a fixed list of steps, passed to that box
  and no other; only a failure carries text, the end of the install log,
  stripped of control and direction characters and cut to 2000, and only the
  pull carries numbers, two whole byte counts up to 64 GiB, dropped when
  they are anything else. The token is written into
  the build VM's cloud-init drive, which the build deletes, and the script
  that holds it deletes itself and runs `cloud-init clean` before the VM
  becomes the template, so no clone carries it. Somebody who read the drive
  while the build ran could report a step or a count that is not true, or end the build
  early with a made-up failure, and nothing more. Every refusal is the same
  403.
- **The pool's own machine is admitted by a pin** (`docs/hypervisors.md`,
  "A machine of its own"). The coordinator gives the pin only to the box
  running that person's policy job, at most three times a job, while the
  job runs, the box may act for that person and that person still holds a
  credential that works: removing them ends the jobs they began
  (`#forgetPerson`), as it takes back their pins. "The box" is the enrolment
  that began the job, its key and when it was let in, not its name: a
  re-key, readmission or revocation of the name ends the job, so a member
  who replaces a box's key with a pin bound to its name inherits none of
  its setup, and the same binding holds for the build VM's token and for
  progress pushed to the owner's phones. The pin is
  bound to a name the coordinator chose and no host had, so it cannot
  replace an existing host's key. It is single use and lasts ten minutes. It
  travels only on the machine's cloud-init drive, which the machine wipes
  first and Xen Orchestra destroys after boot. Somebody who read the drive in
  those minutes could enrol a machine of their own under that name. That
  machine would be a member of the fleet with **nothing to hold**: a box is
  handed the pool's token only once the person approves its key on the
  phone, which shows its fingerprint, and nothing the coordinator or the
  box does can approve it. The machine is made with the admin sign-in,
  outside the resource set, so the limited token cannot remove it. Being
  asked first (`xo[].holder` in its health) only reorders boxes the person
  already gave the token to.
- **Or it asks to join, and the phone checks it.** From a box that says
  `holder-ask`, the person's phone makes a 32-byte secret, keeps it behind
  its owner, and seals it to the policy job; it reaches the machine on the
  same cloud-init drive as the pin. The machine asks at `/api/holder/join`
  with its key and an HMAC of the name, the pool and the key's whole hash
  under the secret. The route is open, and bounded: only a name the
  coordinator holds for somebody, for a day, three requests a name, and a
  name nobody asked for is refused (`src/fleet/coordinator/holder-joins.js`).
  **The coordinator never has the secret**, so it cannot make a proof, and
  a coordinator that listed a key of its own under the holder's name is
  refused by the phone, which checks the proof before anything is let in.
  Somebody who read the drive in the window it exists could make a proof
  for a key of their own; that is the same reach as reading the pin, and
  it ends the same way: one approval, which the person gives only to a
  machine they just made, and which holds **one item**, the vault grant
  being scoped to `hypervisor:<address>` (`only`, `docs/vault.md`), never
  the person's other credentials.
- **Working a machine** (`vmctl`, `docs/hypervisors.md`, "Working a
  machine"). The box works only a machine it tagged as made for the person
  asking, under that person's pool token: restart, a size within the
  resource set, an end no later than 350 minutes from when it was made, or
  an end now. A compromised coordinator can do to a person's machines what
  that person could, and nothing to anybody else's. The console is Xen
  Orchestra's own page, signed in to there; the phone never holds the pool's
  token for it.
- **What a pool's machines may do from chat** (`docs/hypervisors.md`,
  "Machines made here"). The two grants, updates and reboot, are applied by
  the machine's own join script, as root, on its first boot, from the file
  the box that made it wrote, and never by a running service. The answer is
  the owner's: sealed in the policy for the pool's own machine, and kept in
  the pool's record in their vault for the rest, which the coordinator
  cannot write. A box that makes the machine already writes its whole first
  boot with the pool's sign-in, so the answer gives it nothing it did not
  have. A compromised coordinator cannot turn either grant on.
- **The edge routers' key** (`docs/hypervisors.md`, "Watching the edge
  routers"). Each router has one API user with no password and a key whose
  privileges are the CARP, Unbound, gateway and dnsmasq status pages, plus
  `user-config-readonly`. OPNsense has no read-only form of those pages, so
  **the key can stop or start Unbound and dnsmasq, and put CARP into
  maintenance**: machines behind the routers would lose names or their
  gateway until it is undone. It cannot change the configuration, so the
  firewall's rules stay as built, and it cannot read or clear the logs. The
  API answers only HTTPS to the WAN address from private addresses, with a
  certificate the job made and the box pins, so the key is sent to nothing
  else. The key lives on the routers in Xen Orchestra (admins only), in the
  person's vault beside the pool's token, and in the memory of the boxes they
  approved for the pool. A compromised coordinator sees none of it: the key
  reaches the phone sealed, and the vault keeps it sealed.
- **A pool's page from away** (`xolook`, `xoact`, `docs/manage.md`, "From
  away"). A box that holds a person's pool token reads the page for their
  phone and seals it to a key the phone made for that one look, so the
  coordinator relays a map of the pool it cannot read. An action names a
  method from the page's own list and an object id, held to that method's
  shape by the coordinator and the box, and runs under that person's token:
  what a compromised coordinator gains is what it already has by starting a
  session on that box, and the box picks the token by the person asked for,
  never another's.
- **Machines kept ready** (`/api/vm-standby`) are made exactly as one asked
  for by hand: a single-use ticket bound to the person, a box holding their
  pool, inside the resource set's limits. What changes is time: a kept
  machine holds the person's Claude login, and its cloud-init drive's ticket
  is spent, for up to 350 minutes before any session uses it. A machine a
  session has used is never handed to another. Keeping none, or fewer, ends
  the rest.
- **Machines behind the edge router are fenced from each other**
  (`install/fleetwright-net`, `docs/hypervisors.md`, "Machines that work
  together"): at every boot each drops connections opened to it from the
  uplink except by the router, and powers off if it cannot. The fence is in
  the machine, so it holds against the other machines and not against its
  own root, which can only expose itself; it does not stop forged frames on
  the uplink, which the router's rules and a lab of its own are for. A
  **group network** has no interface off the pool and is made by the policy
  job with the admin sign-in, so a group is reachable only by the machines
  put in it. **A group is the pool's, not a person's**: two people who keep
  tokens for the same pool share its group networks, and machines either of
  them puts in group 1 reach each other. A compromised coordinator can put a
  person's new machine in one of their pool's groups, and so beside whatever
  else is in that group.
- **A session's archive** (`start.archive`, `docs/linked-repos.md`) is a
  repository name the coordinator sets from the starter's link, so a
  compromised coordinator can change where a session's work is pushed. Two
  things bound it, both on the host. The push is made with the **starter's
  own** GitHub credential (their connection, or on a runner a token minted
  for them), so it lands only where they could already push. And the host
  asks GitHub, with that credential, whether the repository is **private**
  immediately before every push and refuses a public one, so a session's work
  cannot be aimed at a world-readable repository from here. What it can still
  do is send a session's work to a different private repository the starter
  can push to, or name none, which loses a copy and nothing else. The
  minting Worker's role and runner-repository checks answer for a private
  repository only inside `FLEETWRIGHT_GITHUB_MINT_OWNERS` (outside it, a
  runner check is answered for a public repository and nothing else), so the
  App's key is not an oracle over which private repositories exist elsewhere.
- **A lab is an interface on the edge router, and its session holds no key**
  (`docs/hypervisors.md`, "Labs"). Lab networks are made by the policy job
  with the admin sign-in, attached to the edge, and given rules in its
  configuration, which nothing in the fleet can change: nothing private,
  names only from the edge, then the internet (open) or HTTPS to the
  coordinator and Claude's required hosts and nothing else (closed). A
  closed lab resolves only those same hosts and the names under them, and
  is refused every other name, so it cannot carry data out in its lookups
  (an edge built before that was written keeps answering it any name until
  the edge is rebuilt). One machine is put on a lab at a time, by a box
  that saw it empty and looks again after; the coordinator holds a lab from
  the ask until the box sees the machine there. A compromised coordinator can
  put a person's new machine in a free lab of their pool, open or closed,
  which is what they could ask for themselves; it cannot change a lab's
  rules. The admin's limit on how many labs one person may hold is the
  coordinator's to keep, so a compromised one can ignore it: that costs
  other people a free lab, not anyone's isolation. Seeing inside a lab would need a way into the edge, and none exists:
  the design for one keeps its key on the pool's own machine, never with a
  session, and is not built.
- **SSH keys** are public keys, kept as the named secret
  `SSH_AUTHORIZED_KEYS` and checked on the phone and on the box to be public
  keys and nothing else. They go on the machine's cloud-init drive beside
  the ticket, and give their holder the `fleetwright` account with sudo on
  machines made for that person. A machine on the uplink is reachable only
  from behind the edge router; one started on a network of the person's own
  is beside their own machines, which is why that is a choice and never the
  default.

**A device's own GitHub sign-in, and the dispatch it makes.** Starting a
runner no longer needs a permanent box (`runner-central.md`, "Without a
permanent box"), so two more routes carry something through the coordinator.

- **`POST /api/runners/dispatch`** gives the signed-in person what `provision`
  would have sent a box: the repository, the workflow and a ticket. Nothing
  new is minted; the ticket is the same single-use one. A compromised
  coordinator can name a different repository or workflow, and the device then
  dispatches there with the person's own token, which is a dispatch the person
  could have made themselves and one the device's own screen names. It cannot
  make the device send it the token: the dispatch goes to `api.github.com`.
- **`/api/github/device`** relays a phone's GitHub sign-in to the minting
  Worker. The code GitHub sends back passes through the coordinator's callback,
  and is useless without the PKCE verifier, which is only on the phone and in
  the sealed request. The request is sealed to the minter's key, which the
  phone takes from the minter itself (below), and the answer to a key the
  phone made for that request; the minter
  makes the exchange with the client secret, which is now in the minter as
  well as the coordinator. What the coordinator can do is deny (drop either
  message) or, holding the secret already, run a sign-in of its own through a
  page it serves, which is no more than it could do before this route existed.
  It cannot read a token a phone was given.
- **On the phone** the token is in the Keychain or under the Keystore key that
  already guards the fleet credential, and starts that person's runners from
  their repository. It is the person's own user token, so it reaches what they
  can reach on github.com through the App's permissions, for eight hours, and
  is renewed with a refresh token kept the same way.

**Each person's vault, and what it adds.** `POST /api/vault` and the `vault`
frame carry every person's GitHub, Cloudflare and Claude credentials and named
secrets through the coordinator, so they are accounted for here
([vault.md](./vault.md)).

- **A person's request** is sealed on their phone to the minter's key,
  with their GitHub token inside, and the minter decides whose vault it is
  from GitHub. The coordinator adds which signed-in account sent it, and the
  minter refuses unless that matches the account named inside the seal, so an
  honest coordinator stops one member filing credentials under another's name.
  A dishonest one can at most file a person's *own* credentials under the
  wrong fleet account, which is no more than forging an intent's actor.
- **A box is approved by its key**, which the phone takes from the
  coordinator's list and fingerprints itself, for the person to compare with
  `fleetwright-sidecar identity` on the box. **This is the one place a
  compromised coordinator can gain credentials:** by listing a key of its own
  under a real box's name, to a person who approves without comparing. The
  phone puts the comparison beside the button, and nothing else in this design
  rests on the coordinator's word for a key.
- **A box's request** is signed by that key and answered sealed to a key the
  box made for it. The coordinator checks the key is the one the box enrolled
  with, and the minter checks the signature and the approval; a replay gets an
  answer only the box can open. What the coordinator can do is deny: drop the
  request, and the box keeps what it holds until it runs out.
- **What a box holds** is access tokens, a Claude setup-token and named
  secrets, never a refresh token, in 0600 files the box's own sessions are
  given through the broker. That is less than a box holding a linked
  connection, which keeps the refresh token.
- **A person removed from the fleet** is served to no box. A removal is the
  coordinator's, so beside each box's request it lists every fleet account
  with a credential that still works, and the minter gives nothing for a
  grant whose account is not on it: no item, no Claude login, and no renewal
  of their refresh token. Until the eighth audit the minter never heard of a
  removal, and every box the person had approved went on being given their
  sign-ins, renewed on each ask, while the hand-back's `unlink` cleared only
  the box's own links (r8-leads-1). The list can only take away: a dishonest
  coordinator that lists somebody removed gets what every box got before the
  list existed, and one that leaves a member off denies, which dropping the
  request already could. A coordinator from before the list sends none and
  is served as before. Grants are filtered, not deleted, so a person who
  signs in again is served again, and their refresh token stays sealed in the
  minter, renewed by nothing, until then; revoking it at the provider is the
  person's, or the operator's.

**Where the minter's key comes from.** Every phone request and every Claude
deposit is sealed to the minter's deposit key, which the minter makes and
keeps in its own Durable Object. Phones and `fleetwright-claude-login` ask the
minter for it at `/.well-known/fleetwright-minter` on the fleet's hostname, a
path the deploy routes to the minting Worker; a route runs before the
coordinator's Custom Domain, so the coordinator's code is never asked and
cannot answer with a key of its own. The deposit tool also refuses when the
coordinator names a different key. On a fleet whose deploy gave the minter no
route, that path reaches the coordinator, which has no such path, so the
lookup fails and the person is asked for a pin; coordinator code changed to
answer it would be believed, and changing that code takes the same deploy
access that could replace the minter's, which is the bound below. A phone uses
a saved key only when the lookup fails, so a rotated key cannot leave it
sealing to the old one; `fleetwright-claude-login` takes `FLEETWRIGHT_MINTER_KEY`
over the lookup, for a person who wants a check outside that bound and sets it
for the one run.

**The minting Worker's own bound, which is a different compromise.** Whoever
can deploy to the Cloudflare account can replace the minter's code and capture
every token it signs from then on — for every repository of every account on
`FLEETWRIGHT_GITHUB_MINT_OWNERS` the App is installed on, and, by editing that
list or ignoring it, every installation — and open every Claude login the
minter keeps, since new code runs with the deposit key, and every phone
sign-in it finishes from then on, and every vault, refresh tokens included. Secrets cannot be read
back out of Cloudflare; code can be swapped. So the account and the API token
that deploys to it are the boundary for both keys, not the coordinator.
Rotating the App key on github.com ends the first. For the second, a new
deposit key makes every kept login unreadable, but a token already captured
lasts its year: Anthropic's documentation does not say where a person revokes
a setup-token, and this page will not guess.

**Duration:** until redeploy / secret rotation. There is no per-intent signature
to expire.

**SEC-COORD-1** — The set of verbs a compromised coordinator can drive MUST be
kept in sync with the stated blast-radius sentence, or the sentence removed.
Adding a verb that reads or writes a credential widens the real bound and MUST
update §4.1 in the same change.
*Falsify:* diff the `VERBS` table (`intents.js`) against §4.1's capability list;
any verb here that is not accounted for above is an unreconciled widening.

**SEC-COORD-2** (ASPIRATIONAL) — Device-signed intents, verified host-side
against a key the coordinator did not vouch for, would reduce this bound to
"deny service." Until built, no document may claim the coordinator cannot forge
an instruction.
*Falsify:* search host code for signature verification of intent bodies; today
there is none (`sidecar.js` validates shape, not authorship).

### 4.2 Compromised host (root on the box)

**Bound:** total for that host and everyone who linked on it. Root reads every
member's linked credentials and `<row>.env`, and — because the refresh token is
on disk and the client secret sits in the sidecar's memory, which root can read
(§9-G2 moved it off disk, not off the box) — can mint fresh GitHub tokens for
those members **for as long as the refresh chain lives**, re-minting after each
provider revocation. It cannot reach other hosts (it holds only its
own P-256 key) and cannot forge the coordinator.
*This is the intended bound* — `trust.md`'s "spread minting keys across hosts so
a host compromise costs that host's access." SEC-HOST-1 makes it a rule.

**SEC-HOST-1** — A host MUST hold credentials for no principal but itself and the
members who chose it. No host may hold a fleet-wide credential.
*Falsify:* `fleet-identity.js` refuses coordinator operations; assert no host
code reads `FLEETWRIGHT_API_TOKEN` or another host's key.

### 4.3 Local process on a host reaching loopback (NEW — see §6.4)

**Bound:** full fleetwright authority, including the credential verbs, for any
local process that can present the token — which since §9-G6 means any process
that can **read `${stateDir}/api-token`**, not any process that can reach
`127.0.0.1:8790`. A token is generated whenever none is configured and the
check fails closed, so a non-service local uid is refused rather than served.
The old justification — "reaching it means shell, which is game over" — no
longer has to carry the credential verbs on its own.

**SEC-HOST-2** — The loopback API MUST be token-gated, with the token generated
when none is configured and the check failing closed — never open because
configuration was skipped.
*Falsify:* `test/api-token.test.js` asserts a caller without the token is
refused, including when token generation itself failed.

### 4.4 Malicious or hijacked session

**On a box that runs sessions directly, the bound is §4.2's, not this one.** The
session runs as the service user, so it reads `${stateDir}/api-token` and drives
the hub as any actor it names, reads every person's direct config, linked Claude
credential and `<row>.env`, and types into any other session's pane (G8). What it
does not reach is the host key, which the sidecar's own account holds. A member
cannot start or resume a session on such a box unless it acts for them alone:
placement runs a member's session only on a box that reports `sandboxed: true`
or that they administer (`runsSessionsFor`, `hosts.js`), so on an operator's
direct box this bound is held by the admins' sessions and nobody else's, bar a
member's session already running there before the change (G8). The rest of
this section is the sandboxed case.

**Bound (sandboxed):** whatever the credentials it holds can do, for as long as they live
(GitHub access token: 8h, fetched per request over the broker socket; the
member's Claude credential: its remaining life), plus anything reachable over
**open egress** (§8). Escape from the container
lands as the host's unprivileged user **if podman is rootless** — which is the
correct posture and **UNVERIFIED**: `design.md:§10` records that all hardware
tests ran as root, so container-root → host-root is the state actually proven.
See §8 and §9-G4.

### 4.5 Stolen phone

**Bound:** the member's full authority until the credential is revoked. If the
phone is locked, the credential is behind the OS lock; today it is a bearer token
in the Keychain/Keystore, **not** an enclave-backed key (that is ASPIRATIONAL,
`trust.md`). So a bearer token extracted from an unlocked device or a backup
works off-device.
**SEC-ID-4** — Losing one device MUST be one revocation, never a fleet rotation.
*Falsify:* `clients.revoke(id)` leaves other rows live; `test/` should assert a
revoked token 401s and a sibling still verifies.

### 4.6 Stolen host disk / backup

**Bound:** the host private key (`0600` — but a backup copies bytes, not modes),
every `<row>.env`, every `<row>.renewal.json` (refresh tokens — the client
secret is no longer on disk, §9-G2), and every linked Claude credential under
`accounts/`. A refresh token without the client secret cannot be exchanged,
which is what the G2 fix bought: the stolen-disk case is now the inert one
`github-app.md` always described. TPM sealing (`trust.md`) is the intended
mitigation for the rest and is **ASPIRATIONAL**.

### 4.7 Malicious guest

**Bound:** a normal member's authority, plus co-tenancy on any shared host: guest
sessions run as the **same OS user** as everyone else's, isolated by container
filesystem, not by uid (`accounts.md`). A container escape crosses that, and on
a box that runs sessions directly there is no container to escape, which is why
a guest's session is not placed on one unless it acts for them alone (G8).
**SEC-SESSION-3** — The system MUST NOT be presented as isolating mutually
distrusting people on one host. People who need isolation from each other need
different hosts.
*Falsify:* `accounts.md` says this; ensure no UI/marketing surface claims
per-user isolation.

### 4.8 Network attacker

**Bound:** TLS to the coordinator and to providers; the host dials out and signs
a fresh nonce per connection, so a captured connection replays nothing
(`hosts.js`, `crypto.js`). Nonces carry a MAC proving the coordinator issued them,
so probing for a nonce is not an enrolment oracle.
**SEC-ID-5** — Host authentication MUST put nothing replayable on the wire.
*Falsify:* `test/oidc.test.js` and host-enrol tests; assert the signed value is a
coordinator-issued, single-use nonce.

**SEC-NET-1** — A phone MUST NOT send its device credential over cleartext to
anything but loopback. The coordinator URL is typed by a person, so "TLS to the
coordinator" above is an assumption about a *setting*, not a property of the
code — and an assumption is where this one went wrong.

*Found by CodeQL* (`swift/cleartext-transmission`) and true on exactly one of
the two phones. iOS had been refusing plain `http` all along because App
Transport Security defaults to off; Android shipped
`usesCleartextTraffic="true"` and permitted it anywhere. Every request carries a
Bearer credential and the replies carry session names, prompts and the signed-in
email, so a listener on the path needs to break nothing — only be present.

Both apps now refuse a non-`https` coordinator unless the host is loopback or
`.local`, and each is backed by the platform's own enforcement one layer down
(`NSAllowsLocalNetworking`, `network_security_config.xml`) so the app's rule and
the platform's rule cannot drift apart. A tailnet address is deliberately NOT
exempt: WireGuard is a good argument at the wrong layer, the app cannot
distinguish a tailnet IP from any other, and Tailscale issues real certificates
for `ts.net` names.

*Falsify:* `Fleet.isLocal` / `isLocal` in `Fleet.kt`; grep for
`NSAllowsArbitraryLoads` and `usesCleartextTraffic`, which must not appear.

**SEC-NET-2** — A credential presented as `?token=` MUST be understood as one
that has been written down. Both coordinators accept it (`credential.js`), and
so does fleetwright's own HTTP adapter, deliberately: a Shortcut's "Get Contents
of URL" cannot set a header, and §7 wanted a Shortcut to work. But a URL is
copied into shell history, proxy and CDN access logs, and a browser's history,
none of which a `Bearer` header touches — and it is the SAME credential, not a
weaker one. Neither phone builds such a URL; the exposure is the operator's
curl and the Shortcut. So: the header is the form to reach for, `?token=` is
for the one client that cannot, and a credential that has travelled in a URL
is one to revoke when the Shortcut is retired rather than one to keep.
*Falsify:* grep the two apps for `queryItems` and `?token` — they must build
none; `credentialFrom` in `credential.js` is the only reader.

**No page a browser is handed may be framed by another site.** The MCP sign-in
page, `/me`, the provider callback pages, `/privacy` and the demo Worker's
pages all carry `X-Frame-Options: DENY` and `frame-ancestors 'none'`, one value
in `worker/src/pages.js` (`NOT_FRAMED`); the relay's sign-in page carries the
same pair itself. A framed page whose button means something is a click the
framer chose.
*Falsify:* `test/worker-routes.test.js` ("no page either Worker hands a browser
can be framed"), `test/fleet-do.test.js` ("a provider callback’s page cannot
be framed").

### 4.9 Malicious contributor / compromised dependency

**Bound:** high, and mostly out of band. A malicious change to `intents.js`,
`connectors.js`, the sidecar, or the Worker can defeat any property here. The
defences are review (this document as the checklist, §11), pinned dependencies,
and the OIDC verifier being delegated to an audited library rather than
hand-rolled (`oidc.js` uses `jose`). A compromised dependency in the session
image is inside §4.4's bound already.
**SEC-BUILD-1** — Security-relevant dependencies (`jose`, the WebCrypto usage,
the sandbox base image) MUST be pinned and MUST NOT float.
*Falsify:* `renovate.json` / lockfiles; `jose` pinned per `oidc.js` comment.

---

## 5. Identity and authorisation — which hops verify, which carry

The distinction `intents.md` blurs. A hop **verifies** if it independently
checks a cryptographic fact; it **carries** if it forwards a claim it took on
trust.

| Hop | Verifies or carries | Mechanism |
|---|---|---|
| phone → coordinator (enrolment) | **verifies** | OIDC ID token: `jose`, issuer checked *before* key fetch, `aud`/`exp`/`email_verified`, allowlist; spent on exchange. An MCP client's sign-in asks the allowlist and invites again when its code is spent, and a removal drops the code |
| phone → coordinator (per request) | **verifies** | device token, SHA-256 hash compared timing-safe |
| host → coordinator | **verifies** | P-256 signature over a coordinator-issued nonce |
| provider redirect → coordinator (GitHub, Cloudflare) | **carries**, so it finishes nothing | the `state` names a flow and proves only who started it; the finish is a separate request that **verifies** (SEC-ID-8) |
| coordinator → host (the `actor`) | **carries** | the host trusts `fleet:<email>` because it arrived |
| host → fleetwright (`/api/command`) | **carries** | fleetwright records the actor a trusted caller states; it cannot verify |
| session → host (uuid) | **verifies** | the bind-mounted socket *is* the proof of which session |

**SEC-ID-1** — Enrolment MUST verify a real OIDC token and MUST check the issuer
against the configured allowlist **before** fetching any signing key. Deferring
the issuer check until after key fetch is an algorithm/issuer-confusion hole.
*Falsify:* `oidc.js:verifyIdToken` parses and checks `iss` before `keysFor`;
`test/oidc.test.js` covers `alg:none`, tampered payload, unlisted issuer.

**SEC-ID-2** — `email_verified` MUST be present and true (boolean or `"true"`),
and an Apple private-relay address MUST be refused with a remediating message,
not silently rejected.
*Falsify:* `oidc.js` checks both; `identity.md` documents the relay refusal.

**SEC-ID-3** — The `actor` on an intent is a **carried claim**, never a verified
fact host-side, and MUST NOT be treated as authorisation for anything the host
decides locally. The single check that is genuine — `scope: host` is admin-only
— is enforced **at the coordinator** against a device the coordinator
authenticated, and is worth exactly that and no more (it stops a *member*, not a
compromised coordinator).
*Falsify:* `core.js` gates `scope:host` on `requester.admin`; the host does not
re-check. Note the correction to `intents.md`'s "the aiming is impossible by
construction" in §9-G1.

**SEC-ID-6** — The `fleet:` prefix is the marker that the coordinator resolved an
identity against an ID token. A bare actor from `/api/command` is a claim.
Anything host-side that resolves an actor to a credential row MUST require the
prefix and MUST fail to *no* row (not to the shared box row) when it cannot.
*Falsify:* `emailFromActor` returns null without `fleet:`; `rowForActor`
null-fails; `sidecar.js` prepends `fleet:` from `intent.actor`. A length or
parsing bug that degrades a verified member into the box row is the failure
`http.js` guards at limit 134 — keep that test.

**SEC-ID-7** — An ID token MUST buy at most one credential. Its hash is kept
until the token would have expired, on both coordinators and across a restart
or an eviction, and a second presentation is refused as `token_reused`. The
token is spent only after every other check has passed, so a refusal does not
burn it. This is not the OIDC nonce — it does not stop a token intercepted
before its first presentation — and `identity.md` records why the nonce waits.
*Falsify:* `spent-tokens.js` is consulted last in `identity.js:identify`; the
Node state file and the Durable Object both persist `spentTokens`;
`test/identity.test.js` drives the same token twice across a restart.

**SEC-ID-8** — A provider sign-in a person starts MUST be finished only by
that person's own verified credential. The callback a provider redirects to
carries no fleet credential, so it MUST NOT exchange, link or renew: it hands
the code and state to the app, or to `/me` on the same origin, and
`POST /api/oauth/finish` behind the credential gate redeems the state only when
the requester's email is the one it was minted for (an admin-token flow, only
with the admin token). The state alone used to be the proof, and a member who
forwarded the authorize URL from their own Connect had whoever completed it
connected under the member's name, on a box the member enrolled. What remains:
on Android a custom scheme can be claimed by another installed app, so an app
that has taken `fleetwright://` on the victim's phone and is signed in as the
person who started the flow could finish it. iOS hands the redirect only to the
session that opened it, and `/me` never lets the code leave the origin. Each
person also holds a bounded share of the pending flows, so another member's
connects cannot evict a sign-in somebody is in the middle of.
*Falsify:* `PendingAuthorizations.redeem` takes the requester and refuses a
mismatch; `githubCallback`, `relayedGithubCallback` and `cloudflareCallback`
in `core.js` dispatch nothing; `test/fleet-do.test.js` forwards a link through
the routes and asserts nothing is stored until the starter finishes.

---

## 6. The protocol surface — what a host will do, and what makes a verb safe

### 6.1 The line is built, never received

**SEC-PROTO-1** — The command line fleetwright executes MUST be assembled from
literals in the sidecar's own source plus values already charset-checked by
`validateIntent`. No coordinator-supplied string may reach a shell, a tmux argv,
or fleetwright's parser as anything but a single pre-validated token.
*Falsify:* `toCommandLine` in `sidecar.js`; `intents.js` param regexes
(`NAME_RE` anchored at `[A-Za-z0-9]`, `secret` rejects whitespace/quotes/leading
dash). `test/bin-verbs.test.js`, protocol tests.

### 6.2 The verb set is the only gate

**SEC-PROTO-2** — The verb allowlist is **the** defence, not defence in depth:
`/api/command` runs any line including `/login`, and the sidecar holds its token.
The allowlist MUST validate on arrival at the host (re-validation), independently
of whatever the coordinator claims to have checked.
*Falsify:* `Sidecar` calls `validateIntent` on every message; a test feeds a
malformed/unknown-verb envelope and asserts refusal, not execution.

### 6.3 What makes a verb safe to add

This is the rule your future self needs. A new verb is safe to add **only if all
of these hold**; if any fails, it widens §4.1 and the change MUST say so.

**SEC-PROTO-3** — A verb is safe to add when:
1. it takes **no free text that reaches a terminal or a model's context** — an
   ordinal, an enum, a charset-checked name, or a `secret` typed for handling,
   never a `text`/`say`/`reply` that a `--dangerously-skip-permissions` session
   would execute (`plan.md §4`);
2. it takes **no identity-shaped parameter** (`email`/`owner`/`account`/`user`)
   — aiming is by `scope`, resolved from the verified actor, never named;
3. it takes **no path** — the coordinator cannot express a working directory;
4. it **reads or writes no credential**, OR, if it must (`link`/`renew`/
   `connect`/`unlink`), the change explicitly updates §4.1's compromised-
   coordinator bound rather than repeating the "start and stop" sentence;
5. it is a **new verb, not a new parameter** on an existing verb — a new param
   is a flag day (`bad_params` arrives after the version handshake agreed); a new
   verb degrades cleanly to `unknown_verb` on an old host.
*Falsify:* a test refuses any identity-shaped param name on any verb; `NAME_RE`
anchoring; the `secret` type's charset. Point (4) is checkable only by a reviewer
holding this list — that is what §11 is for.

**SEC-PROTO-4** — `answer` MUST remain an ordinal into a host-published option
list, and its `promptId` guard MUST keep folding in a digest of the dialog body
for the kinds that recur (§9-G3, fixed): a late tap against a same-shaped but
different question is refused, not typed into whatever is on screen.
*Falsify:* construct two permission prompts with identical labels and different
bodies and assert their ids differ (`test/prompt.test.js`).

### 6.4 The host's local API

**SEC-PROTO-5** — fleetwright's loopback API is token-gated: a token is generated
into `${stateDir}/api-token` whenever none is configured and the check fails
closed (§9-G6). The `/internal/session-start` hook endpoint is deliberately
untokened and MUST stay loopback/socket-only; its authentication is the
bind-mount, not a token (SEC-SESSION-1).

---

## 7. Prompt injection and the autonomous session

Nobody had written this down. A session is the product working as intended: an
agent that **reads untrusted content** (repository files, issue and PR text, web
pages, tool output, dependency READMEs) while holding a **live GitHub token**, a
**root shell inside its container**, **open egress**, and — by default —
`--dangerously-skip-permissions` (`src/config.js`, `FLEETWRIGHT_SKIP_PERMISSIONS`
defaults **true**).

**What this means concretely.** Injected text in any content the agent reads can
direct it to run commands, and in dangerous mode those commands run without a
human gate. The agent will faithfully use the credentials it holds. So the honest
statement is:

**SEC-INJECT-1** — The system provides **no defence against a session being
induced to misuse the credentials and access it legitimately holds.** Moving
credentials out of the session (the broker/proxy, §7 of `trust.md`) bounds
*theft* — what survives the session — not *misuse*. Any claim that containment
makes a session safe to point at untrusted input is false.
*Falsify:* there is nothing to test that would pass; this is a stated non-defence.
The test that would matter is the *absence* of egress control — see SEC-INJECT-2.

**What actually bounds it, today:**

- **Time.** A GitHub App installation/user token expires (8h). A leaked or
  misused token stops mattering on its own — *only* for providers that expire.
- **Scope.** A user-to-server GitHub token cannot exceed the installation's
  repositories (real, and free — `github-app.md`), *if* the install is on "Only
  select repositories." On "All repositories" this bound is absent.
- **Reach off-box.** Container escape lands as an unprivileged host user **iff
  rootless** (measured on rootless podman in a lab, not yet on a deployed box,
  §9-G4).

**What does NOT bound it, today:**

- **Egress.** It is open (§8). A session can POST the working tree, the seeded
  credentials, or anything it reads to any host on the internet.
- **The permission mode.** Dangerous is the default; the "safe mode" that several
  arguments lean on is not shipped as the default and MUST NOT be assumed active.

**SEC-INJECT-2** (BUILT, OPT-IN, NOT YET MEASURED) — Default-deny egress
through a named allowlist is the control that bounds misuse to a set of
destinations. It is built as `FLEETWRIGHT_SANDBOX_EGRESS=allowlist`
(`src/core/egress.js`): each person's sessions join that person's own podman
`--internal` network, which has no route out, and one CONNECT-only proxy
container on every such network and the default one is the only path; the
allowlist lives in the proxy because the network cannot express one. It is **off by default**, and until a
box has been seen refusing `curl https://example.com` from a session while
`claude` signs in and answers, the property stays unmeasured. Off, the
posture of a session on untrusted input is still "trusted to the extent of
everything it can reach." Not a credential-terminating proxy: the tunnel is
bytes in, bytes out, and the CLI needs `HTTPS_PROXY` and no CA bundle.
Until the seventh audit it could not have been measured at all: the config said
`FilterType fixed`, which tinyproxy 1.11 rejects as a syntax error, so the
proxy never started and an allowlisted box had no way out. It is ERE now, one
anchored line per host. It still did not start until it was first run on real
podman: conf.c reads `Filter` as a double-quoted string, the path was written
bare, and tinyproxy 1.11.3 said `Syntax error on line 16` and was restarted
forever. The path is quoted now, and the test reads every line against
tinyproxy's own grammar. Until the eighth audit every session on such a box
shared one internal network, so each could reach the ports the others listened
on (G9). Now a person's sessions share only their own, and the proxy, the one
container on all of them, is started with forwarding off and filters by
hostname, so it joins none of them to another.
*Falsify:* `egressArgs` in `egress.js` empty under `allowlist`; `sandboxArgv`
in `claude.js` not spreading it; `ensureEgress` giving two people one network;
`test/egress.test.js`.

**SEC-INJECT-3** — Starting a session in dangerous mode on a repository the
operator did not write is accepting that injected content in that repository may
execute arbitrary commands as the agent, using the seeded credentials, exfiltrable
over open egress. Any surface that offers "start a session" on an arbitrary repo
MUST make that mode legible (`psychology.md §5`: word + symbol, not colour), and
SHOULD make safe mode reachable without editing host config.
*Falsify:* `start` carries `mode`; the apps render it. Check that a per-session
`--safe` is offered, since the box default is dangerous.

**What a box says reaches an agent as the box's, never as the fleet's.** The
other direction of the same problem: an agent holding an admin's credential
reads text a member's box wrote, and a box is a machine somebody else has root
on. `list`, a nameless `status` and `profiles` asked by an admin go to every
box, members' included (`scheduler.js`). A box's listing is rewritten from its
records by the coordinator for every caller, with whose each session is as the
fleet believes it, and anything else a fan-out reply says is quoted on one line
under the box's name, `deb13 said: “…”` (`describeSessions`, `boxSaid`,
`core.js`). A box's labels are held to the hub's label rule where its frame
comes in (`attributed`, `registry.js`), so `fleet_health` prints tags and
nothing else. In `fleet_events`, every event the box is the author of, by the
coordinator's own test (`hostReported`: its session events, `host.degraded`
and `host.recovered`, the pool events), is quoted and attributed to the box,
and a hub reason is cut to one line by the same rule as everything else a box
sends (`oneLine`, `src/core/text.js`), line separators and bidirectional
overrides included. An event's link is a Remote Control link, the shape the
hub finds one in (`RC_URL_RE`), or nothing (`rcLink`, `core.js`): it is the
link a phone opens. The question a waiting session asks, in `fleet_await` and
the MCP server's notification, is quoted on one line as its box's report, and
when it went up is a timestamp or nothing (`askingFrom`, `awaitingSince`,
`src/mcp/server.js`). None of this stops a box saying something false about
itself; it stops one saying it in somebody else's voice.
*Falsify:* `test/ownership.test.js` ("a member’s box writes no line of an
admin’s list"), `test/mcp.test.js` ("a box’s labels reach fleet_health", "a
box’s hub reason reaches fleet_events", "a session event’s link", "a box’s
question is quoted as its own").

---

## 8. Isolation and the sandbox

**SEC-SESSION-1** — A session reports its conversation uuid over a **per-session
unix socket** bind-mounted into that container and no other. Identity is the
socket, not the payload; the container names nothing and cannot reach another
session's socket.
*Falsify:* `hook-socket.js`; `test/hook-socket.test.js` (19 tests over real
sockets, incl. the stale-socket-hijack and `listen()`→`chmod` race the design
turned up).

**SEC-SESSION-2** — State is split by lifetime: conversation and workspace
survive a stop in named volumes; everything root did to the container filesystem
is destroyed on every stop (`--rm`). `forget` deletes the volumes; nothing else
does.
*Falsify:* `podman.js` / `sandboxArgv`; a test that a stopped-and-resumed session
keeps `/work` and loses `/etc` changes.

**SEC-SESSION-4** — Egress from a session is **open** by default
(`design.md §2`, confirmed: `sandboxArgv` sets no network restriction unless
`FLEETWRIGHT_SANDBOX_EGRESS=allowlist`, SEC-INJECT-2). This MUST be stated
wherever containment is described, so nobody reads "sandbox" as "contained
network" on a box that has not turned the allowlist on.
*Falsify:* grep `claude.js` `sandboxArgv` for `egressArgs`; `test/egress.test.js`
pins that it is empty when open.

**SEC-SESSION-5** (MEASURED IN A LAB, NOT ON A DEPLOYED BOX) — Rootless podman
maps container-root to an unprivileged host user, so an escape is unprivileged on
the host. Under `--userns=nomap` that user is the first subordinate uid, not the
service uid; measured on rootless podman 4.9.3 (§9-G4). `design.md §10` records
every hardware test ran as root, so a deployed non-root box has still not been
seen, and a box whose service runs as root falls back to `host`, where container
root IS that uid.
*Falsify:* read `/proc/<pid>/uid_map` of a session from the host: a line
`0 <service uid> 1` means container root is the service user.

---

## 9. Gap register — true in the docs, false in the code, today

The honest part. Each gap names the property it violates and the file to correct.
The first four are from the review that preceded this document; the rest surfaced
while writing it.

**G1 — "A compromised coordinator can only start and stop sessions."**
*Violates SEC-COORD-1, SEC-ID-3.* False since v2 added `link`/`renew`/`connect`/
`unlink`. The real bound is §4.1. `intents.md`'s "the aiming is impossible by
construction" is also false: aiming moved from a rejected parameter to the
`actor` field, which the coordinator controls. **Correct:** `design.md:233`,
`intents.md:29,230`, `trust.md:72,714`, `coordinator.md:86`, and the header of
`intents.js`. `trust.md:245` ("coordinator → host: trusted absolutely") is the
one place that already tells the truth; align the others to it.

**G2 — "The GitHub client secret is never at rest; rotation is a deploy."**
*Violates SEC-CRED-3, and the at-rest bound in §4.6.* `github-app.md:284–306`
says the secret lives only in memory and there is "no file." The shipped `renew`
path writes it to `<row>.renewal.json` on disk, once per member, on every host
where a member linked GitHub (`connectors.js:saveRenewal`, field `client`).
`redact.js` even calls it "the App's own, shared by every host in the fleet."
Two consequences: a stolen host disk yields the client secret plus refresh
tokens; and rotating the secret in Cloudflare does **not** update the on-disk
copies (`readRenewal` reads disk), so rotation silently breaks every existing
renewal 8h later. **Correct:** `github-app.md` "Nowhere on the host … in memory
… nothing at rest," and its "Rotation is a deploy" claim. The config-frame
delivery it describes is **not implemented anywhere in the tree.**

**G3 — `promptId` does not close the temporal hole for same-shaped prompts.**
*Violates SEC-PROTO-4.* `promptId` hashes kind + option labels, excluding the
command text, so two distinct permission prompts (`rm -rf` vs `git push`) collide
and a late tap answers the wrong one. **Correct:** `intents.md`'s "promptId
closes the temporal hole" — it narrows it to "a differently-shaped question,"
which is not the common case. Fix in `prompt.js` would fold a bounded,
non-secret discriminator of the underlying request into the id.

**G4 — Rootless mapping is asserted, tested only as root.**
*Violates SEC-SESSION-5.* `design.md §10` is honest in its "still unvalidated"
list; other sections describe the unprivileged-escape property in the present
tense. **Correct:** anywhere the userns mapping is stated as a fact.

**G5 — `connectors.js` writes credentials `0600` but does not re-check mode on
read.** *Weakens SEC-CRED-3.* `host/identity.js` re-checks and refuses a loosened
key file; the credential store does not. A backup-restore or stray `chmod` that
loosens `<row>.env`/`.renewal.json` is silent. **Add:** a mode check in
`Connections` reads, matching `identity.js`.

**G6 — The host loopback API's "reaching it means game over" assumption is stale.**
*Violates SEC-HOST-2.* True when the API only managed sessions; with the credential
verbs a non-service local uid gains credential-write and pane-read without root.
**Correct:** the `http.js` header comment justifying the untokened default;
document the multi-tenant caveat in install output.

**G7 — Enrolment lockout is global and is therefore a denial lever.** *Bounds, not
breaks.* `enrollment.js` shuts redemption for everyone after 10 wrong guesses/min
— deliberate (per-IP is no limit), but it lets an attacker keep enrolment locked.
Acceptable for a handful of operators; **state it** rather than discover it. Not a
correction, an addition to non-goals (§10).

**G8 — "The session cannot cross back" is false on a box that runs sessions
directly.** *Violates §2 boundary 3, §4.4, and the §3 rows that say a member's
credential reaches "that member's sessions".* With the sandbox off a session is a
tmux pane under the service user, which owns the loopback token, every person's
`${stateDir}/direct/<name>` and `accounts/<email>.json`, every `<row>.env`, and
the tmux server. A member who may start a session on the operator's direct box
therefore has the hub's authority there, as any actor, and every other person's
credentials on it. SEC-SESSION-3 already says people who need isolation need
different hosts; this is the stronger statement that a direct box isolates
nobody, not even from a member who never escapes anything. Until the seventh
audit it was worse, because the service user could also become root through the
migrate helper (`hardening.md`). **Decided: refused, with no per-box opt-in.**
A member's `start` and `resume` go only to a box whose health says
`sandboxed: true`, or to one they administer, which for a member is a box that
acts for them alone (`runsSessionsFor`, `hosts.js`). The hub says `true` only
with the sandbox on and no `FLEETWRIGHT_SANDBOX_ARGS` let through that end
containment, `--privileged` among them (`#hostFacts`, `http.js`;
`unsafeSandboxArgs`); the `sandbox` field beside it could not answer the
question, because a sidecar from before #681 sent a variant whether or not the
box used it. A box too old to send `sandboxed` has not said, which is cannot
tell (C-5), and is treated as unsandboxed. A tag pick leaves such boxes out for
a member rather than landing on one, and is refused with code `unsandboxed` and
every box named only when nothing else will do (`scheduler.js`); a resume is
held to the same rule, and the owner's `stop`, `forget` and the rest still
reach the session, since they run nothing of theirs there. The snapshot's
`takesSessions` asks the same question, so a phone offers a member only the
machines a start of theirs would reach, and it now asks `mayActFor` too: it
used to say yes to a member for a box another member enrolled. Both phones
draw Resume by the same rule and say why in its place where they do not.
`test/unsandboxed-hosts.test.js`, `test/unsandboxed-resume-ios-in-apps.test.js`,
`test/unsandboxed-resume-android-in-apps.test.js`. **Not fixed, and stated:** a
member's session already running on a direct box keeps running, and the box's
boot restore brings it back, because the rule is placement's and the hub
restores its own; an operator should stop those. `sandboxed` does not account
for G4's fallback to `--userns=host` on a box whose service runs as root, so
such a box says `true` where G4's mapping does not hold. And until each box is
updated none reports `sandboxed`, so for that window a member starts and
resumes only on boxes they administer.

**G9 — Sessions on the egress allowlist share one network.** *Narrows
SEC-INJECT-2.* `agent-egress` is one `--internal` network per box, so a session
on it reaches any port another person's session has open (a dev server, a
debugger, an MCP server bound to 0.0.0.0), a path the open default's per-container
namespaces do not give it. **Correct:** one internal network per owner, or say so
wherever the allowlist is offered. Corrected the first way; see the status row.

**G10 — "The service user can rewrite the code it runs, and nothing else."**
*Violates SEC-HOST-1's premise that root on a box is its own boundary.* The
release tree is the service user's so updates need no root, and the installer
said that gave it "nothing to escalate to". But root kept running things out of
that account's reach. `sudo fleetwright grant …`, `join` and `doctor --repair`
— advice the hub, the apps and these docs print — went through a link into
`current`, so root ran the service user's `bin/fleetwright`, and grant and join
then ran `current`'s `install.sh` as root. The installer itself, on every
route including the heal the service user can start with `sudo -n
fleetwright-migrate`, ran their `~/.local/bin/claude` and a node from their
`~/.nvm` as root, wrote the Claude hook and the sidecar's token through paths
in their reach and chowned the result (a symlink made that a chown of any file
on the box), took the version that names the directory it `rm -rf`s from
`current/package.json`, and could be steered into the checkout branch, which
runs `npm ci` and its lifecycle scripts in `current`. **Fixed on a packaged
Linux box:** root's `fleetwright` is a root-owned wrapper that runs the
sidecar's root-owned store with a node the service user cannot replace, or
refuses in words (`install.sh`, "ROOT'S COMMAND IS ROOT'S CODE"); the rest are
closed one by one (`install-root-sources.test.js`). The eighth audit found the
same class one level down: the service user owns `/var/lib/fleetwright`, so
`profiles` in it is a name they control, and the heal's `install -d -o` on it
followed a symlink to `/usr/local/sbin` and gave them the directory the
migrate helper lives in. Root now does what it does inside a directory another
account owns as that account (`install.sh`, "ROOT ACTS IN SOMEBODY'S DIRECTORY
AS THEM"): the profiles, the release lay-out into a base that is theirs, the
migrate helper's bring-forward, apt's tidy-up of old releases, the old
workspace move, the sidecar's machine id and git config; unit templates and
root helpers never fall back to the payload, and the installer's logs are no
longer fixed names in `/tmp`. And the one-liner had the same hole from the
other side: a converted box keeps `/opt/fleetwright-src`, the service user's,
so `curl …/install | sudo sh -s -- --repair` — the hub's own advice for a
stale helper — took the checkout route, ran root's `git checkout` there (and
so its `post-checkout` hook, with git trusting a repository owned by whoever
ran sudo) and then its `install.sh`. `bootstrap.sh` now uses a checkout as
root only when root owns it outright, runs git with no global or system
config, hooks or fsmonitor, and on a box whose units run the release fetches
the release instead. The migrate helper itself trusted the wrong file: it
read the manifest address from `/etc/fleetwright.env`, which its header called
root-owned and which is the service user's (the hub writes it), so they could
name a manifest of their own and have root run that release's `install.sh`,
and its channel fallback printed any file a symlink in their state directory
named. Root now takes the address only from
`/usr/local/etc/fleetwright/release-manifest`, root's, written by the installer
from what it was told or seeded once from what the box already had, and never
refreshed from the env file afterwards; the channel is read as one of two words
(`fleetwright-migrate`, `migration-end-to-end.test.js`). Root's two other
answers were in the same file: `--repair` re-applied each sudoers rule whose
answer was yes in the env file, so `FLEETWRIGHT_SYSTEM_REBOOT=1` there and
`sudo -n fleetwright-migrate` wrote the service user a reboot rule, and the
upgrade answer the rule that starts apt as root. Root's answers now live in
`/usr/local/etc/fleetwright/system-upgrade` and `system-reboot`, beside the
release address and by its rule: told, kept, or seeded once from the rules in
`/etc/sudoers.d`, which only root writes, so the env file can make a record a
no and never a yes, and is put back to root's answer out loud (`install.sh`,
"WHAT ROOT HAS GRANTED"). The address's seed was not once either: a seed with
nothing to take left no file, so an apt box seeded root's address from the env
file on every later upgrade; an empty record now marks the seed taken, and a
box root's own environment says is apt's seeds nothing from the env file.
`sudo fleetwright grant` no longer hands the installer the env file as root's
environment (`grants.js`, `bin/fleetwright`), and `fleetwright-reclaim` no
longer takes the base it removes `.stale-*` under from that file. The
conversion offer and the heal run the installer's own helper, or root's copy
in `/usr/local/sbin` when the tree is the service user's; a pool machine's
first-boot join runs root's copy there, not `current`'s (`JOIN_RUNCMD`,
`vm-image.js`); and a link in a tree is checked one hop at a time. Root's CLI
had the same habit: `sudo fleetwright doctor` ran `FLEETWRIGHT_SYSTEMCTL_BIN`
out of the env file as root, asked claude as whatever user that file named,
root included, and handed every child the file's variables, `LD_PRELOAD` among
them; and the hub's commands read the API token through the service user's
state directory as root. As root, on a box whose env file is another
account's, the CLI now runs doctor and grant on root's own environment and
takes from that file only what they show, asks as and chowns to the
installation's owner as root knows it (root's environment, the unit's `User=`,
the file's owner, never a name inside it), runs every other command as that
owner, and refuses `serve` (`bin/fleetwright`). `install-root-sources.test.js`,
`sidecar-store.test.js`, `reclaim.test.js`, `grants.test.js`,
`xo-pools.test.js`, `xo-holder.test.js`, `doctor.test.js` (the doctor tests
need root and skip otherwise). **Not fixed, and stated:**
a checkout or a Mac has no root-owned tree, so `sudo fleetwright` there runs
the service user's code and the installer says so, and the one-liner as root
refuses a checkout the service user owns and names the two ways on — move to
releases with `sudo /usr/local/sbin/fleetwright-migrate`, or read the checkout
and run its installer as root knowingly; a box whose only node
24+ is in the service user's home still has a person-run installer execute
it as root, with a warning (the heal refuses).

**G11 — An operator box can become a member's vault device.** *Narrows
docs/vault.md's "a box you removed … cannot approve a key of its own".* An
operator box finishes the device sign-ins it starts for people, and the minter
records a sign-in by its token's hash, so that box's root or sidecar account
can register itself as the person's device and approve a key against their
vault (eighth audit, reproduced). It does not reach a member's own boxes. Fix
options, each a change to the device model: device-key-signed vault operations,
refusing code grants without the phone's own marker bound in the seal, or binding
vault and deposit to the GitHub id already linked to the requester. **Decided:
operator boxes are outside a member's vault boundary**, and only a sign-in the
person's own phone started can become their device. Nothing in a code or a
verifier says which flow made it, and the coordinator is the one place that
knows which codes it relayed to a box, so it remembers the SHA-256 of each
GitHub code it hands one, for ten minutes and at most 64, written to the
Durable Object key `boxSignIns` before the code leaves (`#rememberBoxSignIn`,
`core.js`), and lists them beside every device's sign-in. The minter refuses a
listed code before GitHub is asked (`box_sign_in`, `minter/github.js`), so the
box can still finish the sign-in it was started for, and it never becomes a
device's. A sign-in recorded before the fix could not be told from a phone's,
so every one was ended: a record now carries `SIGNIN_VERSION`, one without it
is no device's and renews into none, and each member's phone signs in to
GitHub once more after the deploy, told how by the `not_a_device` sentence.
Vault items and approvals were not touched: an approval a forged sign-in made
stays until its person removes it, and shows in their vault list with the
fleet account that made it. `test/vault.test.js`, the two G11 tests. **Not
fixed, and stated:** the list is the coordinator's word and can only take
away, so a compromised coordinator can still begin a flow of its own or leave a
code off it ([vault.md](./vault.md), "A sign-in the coordinator started"), and
a coordinator from before the list sends none and is served as before.

**G12 — A box's own named secrets answered members' sessions first.**
*Narrows [credential-broker.md](./credential-broker.md)'s "a named secret is
scoped to what `start --secret <name>` granted".* The hook socket answered
`fleet-secret NAME` from the box's `FLEETWRIGHT_SECRETS_DIR` first, for every
session, and only then from the session owner's vault (`namedSecretFor`,
`src/index.js`). `start --secret` is a grant any member can make on a box that
acts for them, so a member who named `DEPLOY_KEY` on an operator's box was
served the operator's, and their own vault secret of that name was hidden
behind it. **Fixed in protocol 14:** `start` and `resume` carry
`boxSecrets: yes|no`, set by the coordinator once the box is chosen and removed
from anything a caller sent: `yes` when the session's owner administers the box
(`#boxSecrets`, `core.js`; the break-glass token, which names nobody,
administers every box), decided again on a resume for the session's owner
rather than whoever pressed it. The hub keeps it on the record
(`--box-secrets`), and `sessionSecret` (`secret-store.js`) reads the box's
store only for a record that says yes, or for a session somebody on the box
itself started; every other session is answered from its owner's vault alone.
A start or resume from a coordinator older than 14 says nothing, which the hub
takes as no for anybody the fleet started (`boxSecretsFor`). A member's
`secret` start on a box they do not administer that speaks below 14 is refused
`host_outdated` rather than sent, and a member's `secrets` listing covers only
the boxes they administer, so a picker offers nothing it could not have.
`test/box-secrets.test.js`, `test/box-secrets-hub.test.js`,
`test/ownership.test.js`. **Not fixed, and stated:** a fleet session started
before its host was updated carries no flag, so the box's secrets stop
answering it, an admin's included, until it is resumed through a coordinator
that speaks 14; and a resume on a host below 14 cannot carry the flag, so that
host serves it as it always did.

**G13 — Removing a member left the fleet's own boxes acting for them.**
*Violates the §3 revocation column for **Member linked Claude credential** and
**Member provider token**.* A removal asked each connected box in the
operator's tier to `stop` the person's sessions its last report listed and to
`unlink` their three sign-ins (`#handBackPerson`), and four things went on in
their name (ninth audit). A box offline at the removal was never asked, then or
when it returned. A session the last report did not list kept running with its
Remote Control link, and `stop` keeps a record resumable, so one that ended
with its box came back as them on the next boot (`resumeOnBoot`). `unlink`
(`Connections.remove`) emptied `<row>.env` and left `<row>.renewal.json`, so
`renewProviderTokens` traded their refresh token with the fleet's client secret
and wrote a fresh GitHub token back into the row, which undid the hand-back on
a box a removed admin's removal took out of the tier too. And the sends were
never checked, so a box that refused or never answered read as asked.
**Fixed:** a removal is now a debt each live enrolment in the operator's tier
owes until the box itself says it is paid (`#forgetOnBoxes`, `core.js`). The
person goes on a list of removals, at most `MAX_REMOVALS_KEPT` (200), under the
Durable Object key `removals`; each enrolment keeps the earliest one it has not
confirmed (`forgetFrom`, saved with the enrolment); and the box is sent
`forgetperson`, whose actor is the person and which has no params, at once
when it is connected and otherwise on its first report whose hub is answering.
Only its `ok` settles it. A box that answers `unknown_verb` runs an older
release: it is asked the old `stop` and `unlink` meanwhile and asked again when
it reconnects. One that does not answer is asked again from a report five
minutes on, with one event saying so. `dispatch` refuses the verb from any
caller (`coordinator_only`) and no MCP tool offers it, and it adds no reach:
it is `forget` of each of the person's sessions and `unlink` of each of their
sign-ins, in one act. On the box the sidecar takes the address from the actor
alone and hands it to the hub on a loopback route of its own,
`/api/forget-person`, which no command surface reaches; `forget-person.js`
stops and bins every session whose record says the person started it, marked
not to resume on boot before it is binned, deletes `accounts/<email>.json`,
deletes the env file, its metadata and the renewal material
(`Connections.forget`), and deletes what the vault gave the box for them.
Separately, `unlink` now drops the provider's renewal material too, and
`Accounts.list` no longer counts `<email>.renewal.json` as a second linked
Claude account. `test/config-frame.test.js`, `test/forget-person.test.js`,
`test/github-renewal.test.js`. **Not fixed, and stated:** a member's own boxes
are not asked: they act for that person alone and are their hardware, the
minter stops serving them anything from the vault, and an admin can delete the
box. A pool's sign-in the sidecar holds in memory from the vault goes on the
next vault pass, within ten minutes, not at once. A `/login for <email>` in
flight at the removal is not cancelled.

Gaps G1–G4 are the ones that change what a person should believe before pointing
this at real machines. G5–G7 are real and smaller. G8 is the one to read first on
a box without podman: a member's sessions no longer go there, and an admin's
still run as the account that holds everybody's credentials on it. G9–G13
surfaced later; what each leaves behind is in its status row.

### Status

| gap | state |
|---|---|
| **G1** | **corrected.** Every site now states the real bound: `intents.js`, `intents.md`, `connectors.md`, `design.md`, `coordinator.md`, `trust.md` ×2. The two `trust.md` conclusions that leaned on the understated baseline were re-derived and **both survive** — the vault refusal and the minting-key placement rest on the *delta*, which correcting the baseline widens rather than narrows. |
| **G2** | **fixed.** The config frame `github-app.md` describes is built (`src/fleet/protocol/config-frame.js`), sent on every host connect, and held in the sidecar's memory. `saveRenewal` no longer stores `client`; `renew` accepts it and discards it so an older coordinator is not refused. The renewal timer moved from fleetwright to the sidecar, because the exchange needs the secret and the sidecar is the process that has it. `test/config-frame.test.js`, `test/github-renewal.test.js`. |
| **G3** | **fixed.** `promptId` folds in a bounded, non-travelling digest of the dialog body, for the kinds that recur (`permission`, `trust`) and not for the one that does not (`resume`, whose body carries a live counter). `test/prompt.test.js`. |
| **G4** | **built, and measured on real rootless podman; not yet on a deployed box.** Podman 4.9.3, a throwaway non-root user (uid 1002) with one subordinate range, `231072:65536`. The session line `buildCommand` gave it carried `--userns=nomap`; replayed with only the name, image and TTY changed and `--network none` added (rootless networking does not start in that lab container: `slirp4netns … open("/dev/net/tun"): Permission denied`), `/proc/self/uid_map` inside read `0 1 65536` and `/proc/<pid>/uid_map` from the host `0 231072 65536`. Container pid 1 ran as host uid 231072, a directory the service user owns read `65534:65534` inside, a file container root wrote in `/work` was `231072` on disk, and `volumeAccount`, whose helper carries the same flag, read back what that container wrote. The same line without `--userns`, the one from before, mapped `0 1002 1`: container root was the service uid. Run as root, `resolveUserns` gave `host`, `validateConfig` returned the warning, the line carried no `--userns`, and `podman run --userns=nomap` there said `nomap is only supported in rootless mode`. What changed: `sandboxArgv` used to pass no `--userns`, and rootless podman's default for that is `host` inside the caller's namespace, so container root WAS the service uid — the account that owns the credential and the socket directory ([`recommendations-review.md`](./recommendations-review.md) §1). Sessions now run `--userns=nomap` by default (`FLEETWRIGHT_SANDBOX_USERNS`, `src/core/sandbox-userns.js`), the same flag on every helper container that touches a session volume, the credential seeded over stdin rather than a bind mount the remapped root could not open, the hook socket reached through permission bits in a session directory behind a `0700` one (it was mounted `:U`, which chowned it away from the hub and left a restarted hub unable to make it again), the hub's stale-socket probe taught that `EACCES` is a live socket, and volumes from before moved into the namespace once on resume. On a box that runs the service as root the setting falls back to `host` with a warning, because podman refuses `nomap` there. `test/sandbox-userns.test.js`, `test/podman.test.js`, `test/hook-socket.test.js`. | (This row briefly claimed "fixed" on the strength of the pane-detection work in `test/real-panes.test.js`, which belongs to a different finding entirely — recorded rather than erased, because a security row marked fixed by an unrelated bug fix is exactly the failure this register exists to catch.) |
| **G5** | **fixed.** `Connections` re-checks mode on every credential read, tightens, and warns. `test/connectors.test.js`. |
| **G6** | **fixed.** The loopback API always has a token — generated into `${stateDir}/api-token` when none is configured, read by the sidecar from the same file — and `#authorised` now fails closed. `test/api-token.test.js`, which is also the first test in this repo to construct the HTTP adapter at all. |
| **G7** | **fixed rather than stated.** The lockout is a growing, capped DELAY now instead of a refusal: an attacker's guess rate stays bounded (a million guesses is tens of days against a ten-minute code) and somebody holding a real pin always gets in. The wait applies to correct codes too, because waiting only on failures would time-leak the answer. `test/identity.test.js`. |
| **G8** | **decided and fixed: refused, with no per-box opt-in.** A member's start or resume goes only to a box that reports `sandboxed: true` (the sandbox on, and no `FLEETWRIGHT_SANDBOX_ARGS` that end containment) or that they administer (`runsSessionsFor`); a box that has not said is treated as unsandboxed, a tag pick leaves such boxes out, and nothing else doing is refused `unsandboxed` with every box named. The snapshot's `takesSessions` and both phones' Resume follow the same rule and say why where they do not. Members' sessions already running on a direct box keep running and come back on boot until an operator stops them; `sandboxed` does not account for G4's `--userns=host` fallback; and until hosts update, members start and resume only on boxes they administer. The migrate helper's root path it compounded is closed (`install-root-sources.test.js`). `test/unsandboxed-hosts.test.js`, `test/unsandboxed-resume-ios-in-apps.test.js`, `test/unsandboxed-resume-android-in-apps.test.js`. |
| **G9** | **fixed, and measured as root; rootless not yet.** Each person's sessions join `agent-egress-<hash of their email>`, keyed as their download cache is, on a subnet counted up from `FLEETWRIGHT_SANDBOX_EGRESS_SUBNET` that podman agrees is free; the proxy is on every one of them at that subnet's second address, joined to a new one with `podman network connect` so nobody's tunnels drop, and started with `net.ipv4.ip_forward=0`. A box with the old `agent-egress` keeps it and stops putting sessions on it. Measured on podman 4.9.3 (netavark 1.4.0) as root, with `ensureEgress` and `buildCommand` run for alice@ and bob@ through a `podman` that recorded each call: two networks, `10.89.201.0/24` and `10.89.202.0/24`, the proxy on both at `.2`, the second joined with `network connect` and nothing restarted, and each session line put its session on its owner's network told `HTTPS_PROXY=http://10.89.20x.2:3128`. From alice's session, bob's by address: `Network unreachable`; by name: `NXDOMAIN`; and the same the other way. Her own proxy answered: `CONNECT example.com:443` `403 Filtered`, `CONNECT <bob's address>:8080` `403 Access violation`. The proxy's address on bob's network and on the default one, `1.1.1.1:443`, and a container on the default network: `Network unreachable`; her one route is `10.89.201.0/24 dev eth0`, and `ip route add` through the proxy is `Operation not permitted`. The proxy reads `ip_forward=0`, where a container started without the flag reads `1`; two lab containers given `NET_ADMIN` and routes through it reached each other only while it was switched to `1`. Before, on the old single `agent-egress`, alice reached bob by address and by name; after the upgrade her new session did not reach his new one or his old one. Measuring found the proxy had never started (the `Filter` line, SEC-INJECT-2), fixed alongside. Not measured: rootless, which is how a box runs it, because that lab container cannot start a rootless network. `test/egress.test.js`, "two people's sessions go on two networks, each told a proxy on its own, and joining the second restarts nothing (G9)". |
| **G10** | **fixed on packaged Linux, stated elsewhere.** Root's `fleetwright` runs root's store or refuses; the heal refuses a node or a payload the service user controls; the hook, the sidecar token and `uninstall.sh`'s settings edit run as the service user; the lay-out never copies from inside the release tree; `apt purge` no longer falls back to `current`'s uninstaller; the stale-helper advice names a verified installer, not a copy out of the tree; and what root makes, copies or removes inside a directory the service user (or the sidecar's account) owns, it does as that account; and the one-liner as root uses only a checkout root owns, so its repair advice fetches the release on a converted box; and the migrate helper takes the manifest address from a file root owns, not the service user's env file; and the sudoers answers `--repair` acts on, and every seed of root's records, come from root's own files; and root's CLI runs nothing from the service user's env file as root, chowns to no name in it, and hands its variables to no child. A checkout (where the one-liner as root now refuses and names the two ways on), a Mac, and a person-run install on a box whose only node 24+ is in the service user's home (run as root, with a warning; the heal refuses) are the remaining cases, each said by the installer or the one-liner. `install-root-sources.test.js`, `bootstrap.test.js`, `doctor.test.js`, `migrate.test.js`, `migration-end-to-end.test.js`, `sidecar-store.test.js`, `reclaim.test.js`, `grants.test.js`, `xo-pools.test.js`, `xo-holder.test.js`. |
| **G11** | **decided and fixed.** Operator boxes are outside a member's vault boundary. The coordinator remembers the SHA-256 of every GitHub code it hands a box (ten minutes, in Durable Object storage key `boxSignIns`, at most 64) and lists them beside each device's sign-in; the minter refuses a listed code before GitHub is asked (`box_sign_in`), so a sign-in started for a box never becomes a device's. A sign-in recorded before the fix could not be told from a phone's, so every one was ended: records now carry a version (`SIGNIN_VERSION`), one without it is no device's and renews into none, and each member's phone signs in to GitHub once more after the deploy. Vault items and approvals were not touched; an approval a forged sign-in made stays until its person removes it, and shows in their vault list with the fleet account that made it. A compromised coordinator can still begin its own flow or leave a code off the list, and an old coordinator sends no list and is served as before. `test/vault.test.js` (two G11 tests). |
| **G12** | **fixed.** Protocol 14's `boxSecrets`, set by the coordinator on `start` and `resume` from whether the session's owner administers the box, decides whether the box's own named secrets may answer it; otherwise only the owner's vault does (`sessionSecret`). A member's `secret` start on a box they do not administer that speaks below 14 is refused `host_outdated`, and a member's `secrets` listing covers only boxes they administer. Fleet sessions started before the host update carry no flag, so the box's secrets stop answering them, admins' included, until resumed through a v14 coordinator; a resume on a host below 14 cannot be scoped. `test/box-secrets.test.js`, `test/box-secrets-hub.test.js`, `test/ownership.test.js`. |
| **G13** | **fixed, except a member's own boxes.** A removal is a debt each live operator-tier enrolment owes until the box says it is paid: the coordinator-only `forgetperson`, asked at once or on the box's first answering report after it returns, retried after five minutes, with the old `stop` and `unlink` for a box too old to know it; the removals kept under Durable Object key `removals`, at most 200. The box bins the person's sessions with nothing to bring them back on boot, and deletes their Claude account, their sign-ins with the renewal material, and their vault copies. `unlink` now drops renewal material too. Their own boxes are not asked; a pool's sign-in held in sidecar memory goes on the next vault pass, within ten minutes; a `/login for <email>` in flight at the removal is not cancelled. `test/config-frame.test.js`, `test/forget-person.test.js`, `test/github-renewal.test.js`. |

---

## 10. Non-goals — what this does not defend against

Stated plainly, because omission is where a security document lies.

- **A compromised coordinator, today.** It can forge instructions and drive the
  credential verbs (§4.1). Signed intents would fix it and are not built. If this
  matters to you, do not deploy the coordinator anywhere you would not deploy the
  thing it controls.
- **Misuse of legitimately-held access by a session** (§7). Bounded in theft,
  not in use.
- **Mutually distrusting users on one host** (§4.7). Container filesystems, not
  uids. Use separate hosts.
- **A malicious platform party** — Cloudflare, Apple, Google, GitHub, Anthropic.
  Their compromise or legal coercion is out of scope. The design's only hedge is
  that no single one of them is a credential *store* for the others.
- **Root on a live host** (§4.2). Nothing running on a box defends against root on
  that box; TPM sealing narrows the *disk/backup* case (§4.6) and is aspirational.
- **A stolen unlocked phone**, beyond one revocation. The credential is a bearer
  token until enclave-backed keys ship.
- **Denial of service.** Fan-out timeouts and a host that will not answer are
  handled for *correctness* (a mute host degrades its own entry, not the fleet),
  not for availability under a determined attacker. **Enrolment is the exception
  and was fixed rather than accepted** (§9-G7): a global lockout let anyone who
  could reach the endpoint keep enrolment shut indefinitely without ever nearly
  guessing a code, so it is a bounded delay now — slow under attack, never
  closed. Nor closed by one member filling it: the 200 live hosts a fleet can
  store are shared out at 25 per person (`hosts.js`), the operator's boxes
  not counted, so a member's own excess is refused with `person_full` and
  everyone else's enrolment goes on. A readmitted machine counts as a new
  one, and a re-key that hands a box to another person counts in theirs.
- **Traffic analysis / metadata.** The coordinator sees which member touched which
  host and when; that is not hidden.

---

## 11. Change checklist

Hold a change against this. If a box is unchecked, the change is not done.

**Adding or changing a verb**
- [ ] No free text reaching a terminal or model context (SEC-PROTO-3.1).
- [ ] No identity-shaped parameter; aiming is by `scope` (SEC-PROTO-3.2).
- [ ] No path parameter (SEC-PROTO-3.3).
- [ ] If it reads/writes a credential, §4.1 updated in the same change; the
      "start and stop" sentence not repeated (SEC-COORD-1, SEC-PROTO-3.4).
- [ ] New verb, not a new parameter, unless the whole fleet moves at once
      (SEC-PROTO-3.5).
- [ ] Re-validated host-side, not only coordinator-side (SEC-PROTO-2).
- [ ] If it carries a secret, added to `redact.js`'s `SECRET_FROM` (SEC-LOG-1).

**Adding a provider (`connectors.js`)**
- [ ] Whether it can mint short-lived tokens is stated (`expiresAt: null` shown,
      never smoothed over).
- [ ] The pre-filled scopes err toward the work succeeding *and* are unstickable.
- [ ] No shared fallback, for any provider. Claude used to be the exception and
      is not one any more — there is no box account to fall back to
      (`one-account-per-person.md`).
- [ ] Any at-rest material placed per §3; refresh-type material to
      `.renewal.json`, never `.env` (SEC-CRED-2).

**Adding a credential store or a place a secret travels**
- [ ] The coordinator cannot read it (SEC-CRED-1), unless it is inert alone
      (client-secret exception) and that is argued.
- [ ] Row added to §3 with: at rest, readable by, rotation, revocation, detection.
- [ ] File mode `0600`/`0700` and re-checked on read (SEC-CRED-3, close G5).
- [ ] Rotation actually reaches every copy, or the doc says it does not (avoid G2).

**Adding a surface that logs**
- [ ] Command lines pass through `redactCommandLine` before any log call
      (SEC-LOG-1).
- [ ] The surface does not put pane text, titles, or secrets in a journal a
      phone can read via `logs`. Who can read one is bounded too: a box's
      journal is the admin's, or the one person the box acts for
      (`mayActFor`), because it names everyone's work on that box.

**Adding a surface that reaches a host locally**
- [ ] It does not assume the loopback API is authenticated (SEC-HOST-2).

**SEC-LOG-1** — Every surface that logs a command line MUST redact through the
single `redact.js` table; a new secret-bearing command MUST be added to
`SECRET_FROM`. Per-site care is forbidden — it rots (the authorization code
leaked from three sites for months for exactly this reason).
*Falsify:* `http.js`, `telegram.js`, `sidecar.js` all call `redactCommandLine`;
`test/redact.test.js`. A tripwire test SHOULD assert every mutating verb carrying
a `secret`-typed param appears in `SECRET_FROM`.

---

## 12. Property index

| ID | One line |
|---|---|
| SEC-ACTOR-1 | Every component's compromise cost is bounded and written |
| SEC-COORD-1 | Verb set and the blast-radius sentence stay in sync |
| SEC-COORD-2 | (Aspirational) signed intents reduce coordinator compromise to DoS |
| SEC-HOST-1 | A host holds credentials for itself and its members only |
| SEC-HOST-2 | Multi-user hosts token-gate the loopback API |
| SEC-SESSION-1 | Session identity is the bind-mounted socket |
| SEC-SESSION-2 | State split by lifetime; only `forget` deletes volumes |
| SEC-SESSION-3 | Not isolation between distrusting users on one host |
| SEC-SESSION-4 | Egress is open; say so wherever containment is claimed |
| SEC-SESSION-5 | (Measured in a lab) rootless maps escape to an unprivileged user |
| SEC-CRED-1 | Coordinator holds no secret that derives a session credential |
| SEC-CRED-2 | Refresh tokens never reach a session |
| SEC-CRED-3 | Credential files 0600/0700, re-checked on load |
| SEC-CRED-4 | The Worker reads each secret under one name; a removed one stays removed |
| SEC-ID-1 | OIDC: issuer checked before key fetch |
| SEC-ID-2 | `email_verified` required; relay addresses refused with remedy |
| SEC-ID-3 | `actor` is carried, not verified; not local authorisation |
| SEC-ID-4 | One lost device is one revocation |
| SEC-ID-5 | Nothing replayable crosses the wire in host auth |
| SEC-ID-6 | `fleet:` prefix required to resolve an actor to a credential row |
| SEC-ID-7 | An ID token buys at most one credential, across a restart |
| SEC-ID-8 | A provider sign-in is finished only by the person who started it |
| SEC-PROTO-1 | The command line is built from literals, never received |
| SEC-PROTO-2 | The verb allowlist is the defence, re-validated host-side |
| SEC-PROTO-3 | The five conditions that make a verb safe to add |
| SEC-PROTO-4 | `promptId` detects shape change, not question change |
| SEC-PROTO-5 | The loopback API and the untokened hook endpoint |
| SEC-INJECT-1 | No defence against a session misusing what it holds |
| SEC-INJECT-2 | (Aspirational) default-deny egress bounds misuse |
| SEC-INJECT-3 | Dangerous mode on an untrusted repo is arbitrary execution |
| SEC-LOG-1 | One redaction table; new secret commands added to it |
| SEC-BUILD-1 | Security-relevant dependencies pinned |

---

*This document supersedes the security claims in `trust.md`, `design.md`,
`intents.md`, `coordinator.md` and `github-app.md` wherever they conflict with it,
and §9 names each conflict. When you fix a gap, delete the false sentence in the
named file and cite the property ID here in the commit.*
