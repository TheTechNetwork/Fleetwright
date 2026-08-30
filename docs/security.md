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
| **Host** | Debian box: agent-hub + sidecar + rootless podman | Be the sole authority on its own tmux, hold its own P-256 key, hold at rest the credentials of members who linked on it. | Speak for any host but itself; hold a fleet-wide admin credential. |
| **Session** | A Claude Code agent in a container, root inside, reading untrusted input, holding live credentials | Do the work it was asked to. Nothing else. It is the **least trusted component in the system**. | Be believed about who it is (it reports over a bind-mounted socket it cannot forge); hold anything whose leak must outlive it. |
| **Phone app** | iOS/Android, App Store / Play, holds one per-device credential | Act as the member it was issued to, until revoked. | Contain any baked-in fleet secret (an IPA/APK is public). |
| **Member** | A verified email on the allowlist | Drive their own sessions, see their own sessions, mint enrolment pins. | See or act on another member's sessions; change what account a box runs on. |
| **Guest** | A member who brings their own Claude/GitHub/Cloudflare and has no shell on any box | Same as a member. Never inherits shared GitHub/Cloudflare credentials. | Inherit anyone's provider tokens; get OS-level isolation from other members on the same host. |
| **Admin** | First verified member on a fresh fleet; the `admin` bit | Remove hosts and other people's devices; change the box's own account; see every session. | — (admin is the ceiling; there is no super-admin) |
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
                      │              (4) │ loopback HTTP (agent-hub)
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
4. **anything-on-host-loopback → agent-hub.** Unauthenticated by default (§6.4).
   The trust boundary is "any local process," which is stronger than it sounds.
5. **coordinator → issuer.** The one place identity is actually established, and
   the coordinator does it correctly (§5.1).

---

## 3. What each store physically holds

Custody in one place, so §4's bounds are checkable against it. "At rest" means
on disk or in durable KV; "in flight" means in a process or on a wire.

| Secret | At rest where | Readable by | Rotation | Revocation | Detection |
|---|---|---|---|---|---|
| **Device token** (`fwk_…`) | phone Keychain/Keystore; **hash only** in the DO | the phone; nobody via the DO | re-issue | `revoke(id)`, per-device | `lastSeenAt`, client list |
| **Break-glass admin token** (`AGENT_FLEET_API_TOKEN`) | Cloudflare secret | the Worker; whoever holds the Worker's secrets | `wrangler secret put` + redeploy | none — it is the floor | none; it is unattributed by design |
| **GitHub App client secret** | Cloudflare secret **and** every `<row>.renewal.json` on every host (§9-G2) | the Worker; **root and the service user on every host that has a linked member** | change in Cloudflare — **does not reach the on-disk copies** (§9-G2) | none scoped | none |
| **Host private key** (P-256) | `/var/lib/agent-fleet/host-key.json`, `0600` in `0700`, mode re-checked every load | that host's service user only | re-enrol the host | `revoke` at coordinator, per-host | mode check refuses to start if loosened |
| **Host public key** | coordinator DO | anyone who reads the DO (public half; harmless) | with re-enrol | with revoke | host list |
| **Box shared Claude credential** | host home + copied into each session volume | host service user; every session (a copy) | `claude` renewal / re-login | re-login | `credentialSummary` in `/api/state` |
| **Member linked Claude credential** | `${stateDir}/accounts/<email>.json` on hosts where linked | host service user; that member's sessions (a copy) | keepalive / re-link | `/accounts remove`, `unlink` | `/api/state` per-account |
| **Member provider token** (GitHub/CF access token) | `<row>.env` on each reachable host | host service user; **every session on that host** (sourced from `.secrets.env`) | GitHub App: 8h auto-renew; CF/PAT: manual | `unlink` (local); provider revoke (real) | `verify` verb |
| **Member GitHub refresh token** | `<row>.renewal.json`, `0600` | host service user only; **no session** | rotated on every renewal exchange | `unlink`; provider revoke | renewal-failure log |
| **Enrolment pin** | coordinator DO, **plaintext**, 10-min TTL | the Worker | single-use, expires | expiry | `outstanding()` (masked) |
| **Telegram bot token** | host env (`AGENT_HUB_TELEGRAM_TOKEN`) | host service user | manual | manual | — |
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
never written to `<row>.env`. A test should source a container's `.secrets.env`
and assert no `refresh` field.

**SEC-CRED-3** — Any file holding a live credential MUST be `0600` in a `0700`
directory, and permissions SHOULD be re-checked on load, not only set on write.
*Falsify:* `host/identity.js` re-checks and refuses (good, keep). `connectors.js`
writes `0600` but does **not** re-check on read — see §9-G5.

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
- `unlink` any member (denial), `stop`/`forget`/`purge` sessions, `reboot` hosts.

**What it still cannot do:** read a refresh token or App private key (it never
receives them — SEC-CRED-1/2), or forge an OIDC identity to a host that verified
one (no host does — the host trusts the coordinator-supplied `actor`, so this is
moot under this compromise, not a protection).

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

**Bound:** total for that host and everyone who linked on it. Root reads the box
Claude credential, every member's `<row>.env`, and — because the refresh token
**and** the fleet client secret are on disk (§9-G2) — can mint fresh GitHub
tokens for those members **for as long as the refresh chain lives**, re-minting
after each provider revocation. It cannot reach other hosts (it holds only its
own P-256 key) and cannot forge the coordinator.
*This is the intended bound* — `trust.md`'s "spread minting keys across hosts so
a host compromise costs that host's access." SEC-HOST-1 makes it a rule.

**SEC-HOST-1** — A host MUST hold credentials for no principal but itself and the
members who chose it. No host may hold a fleet-wide credential.
*Falsify:* `fleet-identity.js` refuses coordinator operations; assert no host
code reads `AGENT_FLEET_API_TOKEN` or another host's key.

### 4.3 Local process on a host reaching loopback (NEW — see §6.4)

**Bound:** full agent-hub authority, including the credential verbs, for **any
local process that can reach `127.0.0.1:8790`** when no `AGENT_HUB_TOKEN` is set
(the default). agent-hub's justification — "reaching it means shell, which is
game over" (`http.js`) — was true when the API only managed sessions. It is no
longer true: a non-root local user who is *not* the service owner can now inject
(`link`), remove (`unlink`), read panes (`peek`) and reboot, without ever
holding root or the service user's files.

**SEC-HOST-2** — On any host that is not single-tenant and single-user, the
loopback API MUST be token-gated (`AGENT_HUB_TOKEN`). The default (untokened,
loopback-only) is safe **only** under the assumption that every local process is
already fully trusted. That assumption MUST be stated to an operator, not left
implicit.
*Falsify:* there is no test that a second local uid is refused; there cannot be
while the default is untokened. A doc line in install output would discharge the
`SHOULD`.

### 4.4 Malicious or hijacked session

**Bound:** whatever the credentials it was seeded with can do, for as long as
they live (GitHub access token: 8h; box Claude credential: its remaining life),
plus anything reachable over **open egress** (§8). Escape from the container
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
every `<row>.env`, every `<row>.renewal.json` (refresh tokens **and** the client
secret), and the box Claude credential. This is the exposure `github-app.md`
claims does not exist ("nothing to steal at rest") — see §9-G2. TPM sealing
(`trust.md`) is the intended mitigation and is **ASPIRATIONAL**.

### 4.7 Malicious guest

**Bound:** a normal member's authority, plus co-tenancy on any shared host: guest
sessions run as the **same OS user** as everyone else's, isolated by container
filesystem, not by uid (`accounts.md`). A container escape crosses that.
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
| phone → coordinator (enrolment) | **verifies** | OIDC ID token: `jose`, issuer checked *before* key fetch, `aud`/`exp`/`email_verified`, allowlist |
| phone → coordinator (per request) | **verifies** | device token, SHA-256 hash compared timing-safe |
| host → coordinator | **verifies** | P-256 signature over a coordinator-issued nonce |
| coordinator → host (the `actor`) | **carries** | the host trusts `fleet:<email>` because it arrived |
| host → agent-hub (`/api/command`) | **carries** | agent-hub records the actor a trusted caller states; it cannot verify |
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

---

## 6. The protocol surface — what a host will do, and what makes a verb safe

### 6.1 The line is built, never received

**SEC-PROTO-1** — The command line agent-hub executes MUST be assembled from
literals in the sidecar's own source plus values already charset-checked by
`validateIntent`. No coordinator-supplied string may reach a shell, a tmux argv,
or agent-hub's parser as anything but a single pre-validated token.
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
list, and its `promptId` guard MUST be understood for what it is: it detects that
the dialog *shape* changed, not that the *question* changed. Two distinct prompts
of the same kind and option labels collide (§9-G3). Until fixed, `answer` MUST
NOT be relied on to prevent answering the wrong same-shaped question.
*Falsify:* `prompt.js:promptId` hashes `name+kind+labels`, excluding command
text; construct two permission prompts with identical labels and assert equal ids.

### 6.4 The host's local API

**SEC-PROTO-5** — agent-hub's loopback API is unauthenticated by default and
gains the credential verbs in v2. See SEC-HOST-2: it MUST be token-gated on any
multi-user host. The `/internal/session-start` hook endpoint is deliberately
untokened and MUST stay loopback/socket-only; its authentication is the
bind-mount, not a token (SEC-SESSION-1).

---

## 7. Prompt injection and the autonomous session

Nobody had written this down. A session is the product working as intended: an
agent that **reads untrusted content** (repository files, issue and PR text, web
pages, tool output, dependency READMEs) while holding a **live GitHub token**, a
**root shell inside its container**, **open egress**, and — by default —
`--dangerously-skip-permissions` (`config.js:88`, `AGENT_HUB_SKIP_PERMISSIONS`
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
  rootless** (UNVERIFIED, §9-G4).

**What does NOT bound it, today:**

- **Egress.** It is open (§8). A session can POST the working tree, the seeded
  credentials, or anything it reads to any host on the internet.
- **The permission mode.** Dangerous is the default; the "safe mode" that several
  arguments lean on is not shipped as the default and MUST NOT be assumed active.

**SEC-INJECT-2** (ASPIRATIONAL) — Default-deny egress through a credential-
terminating proxy (`trust.md`, `ROADMAP §2`) is the control that would bound
misuse to a named allowlist of destinations. It is **not built**. Until it is,
the security posture of a session on untrusted input is "trusted to the extent
of everything it can reach."
*Falsify:* `sandboxArgv` in `claude.js` passes no `--network` restriction; grep
for a proxy/netns. Absent.

**SEC-INJECT-3** — Starting a session in dangerous mode on a repository the
operator did not write is accepting that injected content in that repository may
execute arbitrary commands as the agent, using the seeded credentials, exfiltrable
over open egress. Any surface that offers "start a session" on an arbitrary repo
MUST make that mode legible (`psychology.md §5`: word + symbol, not colour), and
SHOULD make safe mode reachable without editing host config.
*Falsify:* `start` carries `mode`; the apps render it. Check that a per-session
`--safe` is offered, since the box default is dangerous.

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

**SEC-SESSION-4** — Egress from a session is **open** by design today
(`design.md §2`, confirmed: `sandboxArgv` sets no network restriction). This MUST
be stated wherever containment is described, so nobody reads "sandbox" as
"contained network."
*Falsify:* grep `claude.js` `sandboxArgv` for `--network`; absent.

**SEC-SESSION-5** (UNVERIFIED) — Rootless podman is claimed to map container-root
to an unprivileged host user, so an escape is unprivileged on the host. This is
**not proven**: `design.md §10` records every hardware test ran as root. The
property MUST be treated as unverified until a non-root deployment is tested.
*Falsify:* run the sandbox as a non-root service user and confirm `podman run`
maps uid 0 in-container to the service uid on the host; today nothing asserts it.

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

Gaps G1–G4 are the ones that change what a person should believe before pointing
this at real machines. G5–G7 are real and smaller.

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
- **Denial of service.** Global enrolment lockout (§9-G7), fan-out timeouts, and a
  host that will not answer are handled for *correctness* (a mute host degrades
  its own entry, not the fleet), not for availability under a determined attacker.
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
- [ ] No shared fallback for a per-person provider (GitHub/Cloudflare get their
      own token or none; only Claude falls back to the shared org account).
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
      phone can read via `logs`.

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
| SEC-SESSION-5 | (Unverified) rootless maps escape to an unprivileged user |
| SEC-CRED-1 | Coordinator holds no secret that derives a session credential |
| SEC-CRED-2 | Refresh tokens never reach a session |
| SEC-CRED-3 | Credential files 0600/0700, re-checked on load |
| SEC-ID-1 | OIDC: issuer checked before key fetch |
| SEC-ID-2 | `email_verified` required; relay addresses refused with remedy |
| SEC-ID-3 | `actor` is carried, not verified; not local authorisation |
| SEC-ID-4 | One lost device is one revocation |
| SEC-ID-5 | Nothing replayable crosses the wire in host auth |
| SEC-ID-6 | `fleet:` prefix required to resolve an actor to a credential row |
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
