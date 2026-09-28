# Auth and host join, reconsidered

Written after the question "are we doing this backwards, and would some of it
be better done with dependencies". The answer to the first is *mostly no, and
the part that is backwards is not the part it looks like*; the answer to the
second is *yes, in two places, one option held open, and no in the rest*, and
the reason the list is shorter than a first reading suggests is a decision
recorded partway down: **the coordinator runs on Cloudflare, or in a container
of the same Worker, and nowhere else.** This note says which, with the
evidence, and ends with an order to do it in.

It is an assessment before a rework, in the same spirit as
[`identity.md`](./identity.md) and [`trust.md`](./trust.md): a decision written
down so the code that follows can be checked against it.

## What is actually here

Five kinds of credential, each answering a different question, none of them
shared:

| who | proves it with | issued by | lives |
|---|---|---|---|
| a person on a phone or in a browser | an Apple or Google **ID token**, once | the provider | spent on exchange (`spent-tokens.js`) |
| that person's **device** afterwards | `fwk_…` bearer credential | `/api/session`, or the MCP `/oauth/token` | until revoked; never expires |
| a **host** | ECDSA P-256 keypair, signs an HMAC nonce per connection | the host itself; admitted by a 6-digit pin | until revoked; 30-day tombstone |
| a **GitHub Actions runner** | GitHub's OIDC job token plus a `fwt_` ticket or `fwr_` token | GitHub, and `provision` | retired on disconnect |
| the **operator with no phone** | `AGENT_FLEET_API_TOKEN` | `wrangler secret put` | until rotated |

The coordinator holds no password, no refresh token and no session secret. What
it does hold is hashes of the `fwk_` secrets, host public keys, spent ID-token
hashes, pins in plain text for ten minutes, and MCP client registrations.

The shape is right and it is mainstream: federated identity for people, a key
per machine, a short-lived human-carried secret to bind the two, and a public
edge that relays but never reads. Nothing below argues with it.

### What is hand-rolled, by size

| piece | lines | what a library would normally do here |
|---|---|---|
| two route tables, `server.js` + `fleet-do.js` (+ `worker.js` front door) | ~1500 + ~1250 + ~600 | nothing: the answer is one coordinator, not a shared router (see the decision below) |
| MCP OAuth 2.1 authorization server: `mcp/oauth.js`, `mcp/routes.js`, `authorize-page.js` | ~760 | RFC 7591 / 8414 / 9728 / 7636 |
| outbound OAuth client for GitHub and Cloudflare: `coordinator/oauth.js`, `host/pkce.js` | ~500 | RFC 6749 + PKCE + token-response validation |
| ID-token verification: `oidc.js` | ~340 | already `jose`; discovery still by hand |
| WebSocket framing: `ws.js` | ~470 | RFC 6455 client and server |
| MCP stdio + HTTP transport: `mcp/server.js`, `mcp/http.js` | ~1100 | JSON-RPC framing, Streamable HTTP |
| host identity and nonces: `crypto.js`, `hosts.js` | ~600 | nothing standard fits; see below |

The single runtime dependency is `jose`, taken for ID tokens because JWT
verification is "the canonical place where being *nearly* right has produced
CVEs for a decade, and its failure mode is silent acceptance"
([`dependencies.md`](./dependencies.md)). That sentence is the test everything
below is held to.

## Is it backwards?

Three places where the ordering *looks* wrong, and what is actually true of each.

### The pin flows from the fleet to the box, not the other way

`agent-fleet-sidecar enrol 123456`: somebody already in the fleet mints a code,
a human carries it to the machine, the machine spends it. The other direction,
where the box shows a code and a signed-in person approves it, is RFC 8628, and
it feels more natural because every CLI does it now.

**Keep the direction.** [`connectors.md`](./connectors.md) already rejected
device flow for the Claude connector on the phishing argument, and it holds
harder here: an approval screen for "a machine called `build-3` wants to join"
is exactly what an attacker's machine would also produce, and the screen is not
lying. A pin the *admitter* generates binds the admission to an action the
admitter started. That is the property [`trust.md`](./trust.md)'s "pin the
first device out-of-band" idea depends on, and reversing the flow would spend
it for a nicer install script.

What *is* backwards is one step earlier, and it is ergonomic rather than
structural:

- The documented first pin is minted with `curl … -H "authorization: Bearer
  $AGENT_FLEET_API_TOKEN"`, so the break-glass token is on the happy path of
  every fresh fleet. Beta finding G1 (#332) is this.
- The installer knows which coordinator it is joining (`/install` sets
  `AGENT_FLEET_COORDINATOR_URL`, and "curling a coordinator IS joining that
  coordinator") and then stops to ask for a pin from somewhere else.
- `ROADMAP.md` §"spin up a box, install, register, go" already has the fix in
  one line: *the pin is the answer; the command could carry it and enrol
  unattended*.

So the order that should be documented and built for is: deploy, set the
allowlist, **sign in on a phone** (first person in is admin, already true),
mint a pin **in the app**, and the app hands back a one-line install command
with the pin in it. The admin token becomes what its own description says it
is, break-glass, and leaves the tutorial.

### Two coordinators, one design, two route tables

`server.js` and `fleet-do.js` each carry the same ~30 routes by hand, and
`openapi.test.js` plus `parity.test.js` exist because five parity bugs reached a
branch before they did. That is the single largest hand-rolled thing in the
repository and the one that costs on every feature: a route is written twice,
its auth gate twice, its body parsing twice, its error shape twice, and the
tests are what keep them from drifting.

This is not what "transport swap" was meant to mean. `core.js` is shared; the
HTTP layer around it is duplicated. The first draft of this note reached for a
router that runs identically on Node and Workers so the table would be written
once. The decision below makes that unnecessary: there is going to be one
coordinator, so there is going to be one table.

## Decision: the coordinator runs on Cloudflare, or in a container of the same thing

**The Node coordinator stops being part of the package.** A fleet's coordinator
is the Worker, deployed to Cloudflare per
[`coordinator-deploy.md`](./coordinator-deploy.md); the one alternative worth
allowing is the *same Worker* run under `workerd` in a container, for whoever
cannot or will not have a Cloudflare account. What is not offered any more is
"run the coordinator on this box" as a plain Node service.

The repository is already most of the way there and says so in its own
comments: a release ships no coordinator (`host-release.yml`, and `install.sh`
retires a leftover local unit on a packaged box), the Worker is what production
runs, and `server.js` describes itself as the design "running somewhere you can
put a breakpoint in". What remains is to stop *offering* it, and then to stop
carrying it.

What goes with it, in order of how much it is used:

| thing | today | after |
|---|---|---|
| `bin/agent-fleet-coordinator`, `install/agent-fleet-coordinator.*`, installer step 5c and the "Run the coordinator on this box?" question | offered on every checkout install | removed; the installer asks for a coordinator URL, full stop |
| `src/fleet/coordinator/server.js` (~1500 lines) | shipped, and the in-process harness for 13 test files | test helper only, then deleted once those tests drive the Worker under workerd the way `live.test.js` and `parity.test.js` already do |
| `src/fleet/ws.js` server half, `src/fleet/apns-node.js` | Node coordinator only | deleted with it |
| `src/fleet/ws.js` client half | the sidecar's dial | Node ≥ 22 ships `WebSocket` with a `headers` option; the file goes entirely, with no dependency |
| `openapi.test.js`, `parity.test.js` | drift detectors between two implementations | conformance tests of one |
| `docs/coordinator.md` "there are two of it" | the design | history, kept as such |

**The container option needs one proof before it is promised.** `workerd`'s
own config supports disk-backed Durable Object storage (`durableObjectStorage
= localDisk`) and is published as a binary, so a `Containerfile` holding
`workerd` plus the bundled Worker plus a volume is a small thing to write. What
nobody here has done is run this Worker that way for a week: the DO eviction
behaviour `worker.js` works around, the KV-shaped rate limiter bindings, and
Sentry are all Cloudflare-shaped assumptions to check. Until that run exists,
`coordinator-deploy.md` says Cloudflare, and the container is a row on the
roadmap rather than a sentence in the install guide.

**What it costs, stated:** a single-box operator now needs a Cloudflare account
(free tier suffices) or Docker. The deployment story stops having a "Y for a
single-machine setup" row. That is the trade being made on purpose, because the
alternative is two implementations of the most security-sensitive component in
the system held together by tests that exist to catch them disagreeing.

**What it changes in the dependency table below:** the router dependency loses
its reason and is not taken; the Workers-only OAuth provider library stops
being disqualified on parity grounds and becomes a real option, with a
different trade to weigh.

### The MCP authorization server is the JWT argument again

`mcp/oauth.js` is an OAuth 2.1 authorization server with dynamic client
registration, written by hand, on the open internet, taking anonymous
registrations. It is careful, and reading it found the kind of thing the jose
paragraph predicts:

- the PKCE verifier is compared with `!==` (`mcp/oauth.js` `redeem`), while
  every other secret compare in the repo is constant-time;
- `/.well-known/openid-configuration` returns OAuth AS metadata, not an OIDC
  provider document, so a client that asks for OIDC is told something
  well-formed and wrong;
- `state` is never held server-side; the page echoes it back.

None of these is an exploit today. All of them are the failure mode where the
code accepts something it should refuse, and there is no test that speaks the
protocol from the client side to catch the next one. That is the gap to close,
and there are two honest ways to close it, in the dependency table.

## Retention, checked

The retention rules are right and consistent: revoked device rows and revoked
host rows are tombstoned for 30 days so a reconnecting host hears *revoked*
rather than *not enrolled*, then swept so the single Durable Object value stays
under 128 KiB (#351); ephemeral hosts are deleted on disconnect and their key
revoked; a forgotten session sits in a seven-day bin; the event ring is the
audit trail that outlives the rows. Nothing there needs a library.

Reading it end to end did turn up four defects, and they belong in the first
round of whatever follows, before any dependency:

1. **A pin minted `ephemeral` produces a permanent host.** Both
   `/api/enroll/host` handlers pass `readmit` and `boundToThisHost` to
   `hostIds.enrol()` and neither passes `spent.entry.ephemeral`, so the record
   is written with the default `false`, `hostConnected` reads `false` back,
   and `disconnect` keeps the entry. The retirement path the comment in
   `core.js` says was "being dropped one layer below" is still dropped, one
   layer above. `test/enroll-ephemeral.test.js` checks the mint and not the
   record.
2. **The runner enrols under one name and dials under another.** The
   coordinator derives `gha-<owner>-<repo>-<run>-<attempt>`; the action sets
   `AGENT_FLEET_HOST_ID=<prefix>-<run>-<attempt>` (`gha-mac-…`); `enrol-actions`
   writes the coordinator's name into its own `process.env` and exits, and the
   sidecar launched on the next line inherits the workflow's. As read, the
   sidecar is refused as not enrolled. Needs a live run to confirm, and the fix
   is to have `enrol-actions` print the id and the action export it.
3. **Founding admin can be re-granted.** `everHadAdmin()` reads revoked rows to
   decide whether the next sign-in becomes admin; the 30-day sweep removes
   revoked rows with no exemption for admin ones. A fleet whose only admin
   revoked their phones and came back a month later mints a second founding
   admin to whoever signs in first. Keep a one-bit `hadAdmin` beside the rows.
4. **A revoked permanent host stays listed as `offline`** until the process
   restarts, because `snapshot()` lists the registry cache without consulting
   `hostIds`. Cosmetic, and exactly the kind of thing C-5 is about.

## Dependencies: what to take and what not to

The bar in [`dependencies.md`](./dependencies.md) is "would I rather own this
code than audit this package". That bar produced `jose` and refused everything
else, and the reasoning was specific: a *primitive* (sign, verify, hash, frame)
is worth owning; a *protocol with negotiation and a silent failure mode* is
not. Applying the same sentence to the rest of the auth surface gives a
different answer than it gave two years ago, because the surface grew.

Versions are what `npm view` returned on the day this was written; the pin
lands in `package.json`, exact, like `jose`.

| package | version | deps | take? | for |
|---|---|---|---|---|
| **oauth4webapi** | 3.8.8 | 0 | **yes** | the outbound OAuth client: authorization URL, PKCE, code exchange, token-response validation, for GitHub and Cloudflare in one shape instead of "two functions wearing a trench coat". Also OIDC **discovery**, which `oidc.js` promises ("provider-agnostic") and does not do: it hard-codes three JWKS URLs and guesses the rest. Same author as `jose`, same WebCrypto-only constraint, same audit already done |
| **@modelcontextprotocol/sdk** | 1.31.0 | ~15 | **devDependency only** | the conformance oracle. Its *client* speaks RFC 9728 → 8414 → 7591 → PKCE → token against our authorization server in a test, and speaks Streamable HTTP against our transport. That is the test we do not have. Too heavy (express, zod, ajv) to ship in the coordinator, and it does not need to |
| **@cloudflare/workers-oauth-provider** | 1.2.1 | 0 | **option, decide after the oracle runs** | Cloudflare's own OAuth 2.1 server for Workers, written for exactly this MCP case: registration, PKCE, codes, tokens, all in a library that the platform's authors maintain. Once there is one coordinator it is no longer disqualified. What it costs is a KV binding and **a second credential list**: it issues its own opaque tokens, where today an MCP client's access token *is* a `fwk_` device credential revocable from the People screen like any phone. That property is worth keeping. So: run the SDK's client against the hand-rolled server first; if conformance turns up holes that are protocol rather than typo, take this and map its grants onto `clients.js`; if it turns up typos, fix them and keep the ~600 lines |
| hono | 4.13.10 | 0 | **not now** | the case for it was one route table across two runtimes. With one coordinator the table is already written once, in `fleet-do.js`. Worth revisiting only if the Worker's own routing grows past what an `if` chain reads well as |
| @hono/mcp | 0.3.2 | 1 | **not now** | goes with hono. The SSE leg `mcp/http.js` lacks is a known gap, and the SDK-as-oracle test is what will say whether it matters to a real client |
| ws | 8.22.0 | 0 | **no** | the server half of `ws.js` leaves with the Node coordinator, and the client half is `globalThis.WebSocket` in Node ≥ 22. Nothing left to replace |
| @simplewebauthn/server | 14.0.3 | 8+ | **not yet** | passkeys are `trust.md`'s stated end state for device authentication. CBOR and COSE are exactly "a protocol with a silent failure mode", so when passkeys come this is a take, not a hand-roll. They are not this round |

**And keep owning:** `crypto.js` (one primitive, two calls), the HMAC nonce in
`hosts.js` (there is no standard for "a stateless challenge for a machine that
dials out"), `spent-tokens.js`, `clients.js`, `enrollment.js`. A dependency for
any of those would be carried for a loop and a hash.

The net of it is smaller than the first draft: one new runtime dependency
(`oauth4webapi`), one dev dependency (the MCP SDK), one option held open, and
about two thousand lines deleted by retiring a second implementation rather
than by importing a framework to hold it up.

## The order

Rounds, each a stacked PR set by layer per [`CONTRIBUTING.md`](../CONTRIBUTING.md).
The dependency rounds are ordered so each one deletes code the next one would
otherwise have to touch twice.

| round | what | deletes | adds |
|---|---|---|---|
| **0** | the four retention defects above, and the PKCE compare. Both coordinators while both exist | | four tests |
| **1** | **stop offering the Node coordinator**: remove the binary, the units, installer step 5c and the "run it here?" question; `deployment.md` and `coordinator.md` say Cloudflare; `server.js` moves under `test/helpers/` as the in-process harness it already is. A `workerd` `Containerfile` is written and *tried*, and lands in the docs only if it survives a week | the shipped second implementation, `ws.js`, `apns-node.js` | nothing |
| **2** | **oauth4webapi**: `coordinator/oauth.js` becomes configuration for two providers; `host/pkce.js` goes; `oidc.js` gains discovery for any issuer and the `nonce` `identity.md` deferred, once the apps send one | ~500 lines | one dependency |
| **3** | **MCP conformance**: the SDK as a devDependency, a test that registers, authorizes and exchanges against our authorization server, and one that drives `/mcp` with the real client. Its verdict decides whether `@cloudflare/workers-oauth-provider` is taken | | dev-only |
| **4** | **bootstrap ergonomics**: the app mints a pin and shows `curl …/install?pin=123456 \| sh`; the installer spends it unattended; `coordinator-deploy.md` moves the admin token to a break-glass section. Closes #332 | the curl-with-admin-token tutorial | app layers, both phones |
| **5** | **one implementation**: the 13 test files that drive `server.js` in-process move to the Worker under workerd, and `server.js` is deleted. `openapi.test.js` and `parity.test.js` stay as conformance tests of the one that is left | ~1500 lines | |
| later | passkeys with `@simplewebauthn/server`; signed intents, once the trust root question in `trust.md` is answered | | |

What this does not change: who may join (the allowlist and the pin), what a
host proves (its key), what the coordinator may hold (nothing it can spend),
and the rejection of device flow. Those were the decisions. What changed
between the first draft of this note and this one is where the coordinator is
allowed to run, and that one decision removed the largest dependency from the
list by removing the code it was going to hold up.
