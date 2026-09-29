# Auth and host join, reconsidered

Written after the question "are we doing this backwards, and would some of it
be better done with dependencies". The answer to the first is *mostly no, and
the part that is backwards is not the part it looks like*; the answer to the
second is *yes, in four specific places, and no in three others*. This note
says which, with the evidence, and ends with an order to do it in.

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
| two route tables, `server.js` + `fleet-do.js` (+ `worker.js` front door) | ~1500 + ~1250 + ~600 | one router that runs on both runtimes |
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
HTTP layer around it is duplicated. The fix is a router that is itself the
same code on Node and on Workers, so the route table is written once and the
two entry points become a `node:http` listener and a `fetch` handler around
it. That is what Hono is for (§ below), and it is the one dependency here that
deletes more code than it adds.

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
| **hono** | 4.13.10 | 0 | **yes** | one route table for both coordinators. Same code under `node:http` (`@hono/node-server` is optional; a ten-line adapter over `Request`/`Response` does it) and as a Worker `fetch`. MIT. It is also what the MCP SDK itself routes with now, which is a fair sign it is the neutral choice |
| **oauth4webapi** | 3.8.8 | 0 | **yes** | the outbound OAuth client: authorization URL, PKCE, code exchange, token-response validation, for GitHub and Cloudflare in one shape instead of "two functions wearing a trench coat". Also OIDC **discovery**, which `oidc.js` promises ("provider-agnostic") and does not do: it hard-codes three JWKS URLs and guesses the rest. Same author as `jose`, same WebCrypto-only constraint, same audit already done |
| **@modelcontextprotocol/sdk** | 1.31.0 | ~15 | **devDependency only** | the conformance oracle. Its *client* speaks RFC 9728 → 8414 → 7591 → PKCE → token against our authorization server in a test, and speaks Streamable HTTP against our transport. That is the test we do not have. Too heavy (express, zod, ajv) to ship in the coordinator, and it does not need to |
| **@hono/mcp** | 0.3.2 | 1 | **if hono is taken** | the Streamable HTTP transport, including the SSE leg `mcp/http.js` says it has nowhere to put. Tools stay generated from `VERBS`; only the wire changes |
| **ws** | 8.22.0 | 0 | **later, server half only** | the Node coordinator's accept side. The sidecar's *client* half of `ws.js` is already in Node ≥ 22 as `globalThis.WebSocket` with a `headers` option, so half of the 470 lines can go without any dependency. Low priority: framing is stable and the parity test drives it |
| @cloudflare/workers-oauth-provider | 1.2.1 | 0 | **no** | the obvious pick for an MCP authorization server on Workers, and it is Workers-only and wants KV. Taking it makes the MCP surface the one place the two coordinators are two implementations, which is the drift the whole parity apparatus exists to prevent |
| @simplewebauthn/server | 14.0.3 | 8+ | **not yet** | passkeys are `trust.md`'s stated end state for device authentication. CBOR and COSE are exactly "a protocol with a silent failure mode", so when passkeys come this is a take, not a hand-roll. They are not this round |

**And keep owning:** `crypto.js` (one primitive, two calls), the HMAC nonce in
`hosts.js` (there is no standard for "a stateless challenge for a machine that
dials out"), `spent-tokens.js`, `clients.js`, `enrollment.js`. A dependency for
any of those would be carried for a loop and a hash.

## The order

Rounds, each a stacked PR set by layer per [`CONTRIBUTING.md`](../CONTRIBUTING.md).
The dependency rounds are ordered so each one deletes code the next one would
otherwise have to touch twice.

| round | what | deletes | adds |
|---|---|---|---|
| **0** | the four retention defects above, and the PKCE compare | | four tests |
| **1** | **hono**: one route module under `src/fleet/coordinator/routes/`, imported by `server.js` (Node adapter) and `fleet-do.js` (Worker). `openapi.test.js` keeps executing the spec against both, now as a regression test rather than a drift detector | most of the route bodies in two files | one dependency |
| **2** | **oauth4webapi**: `coordinator/oauth.js` becomes configuration for two providers; `host/pkce.js` goes; `oidc.js` gains discovery for any issuer and the `nonce` `identity.md` deferred, once the apps send one | ~500 lines | one dependency |
| **3** | **MCP conformance**: the SDK as a devDependency, a test that registers, authorizes and exchanges against our authorization server, and one that drives `/mcp` with the real client. `@hono/mcp` for the transport if the SSE leg is wanted | the hand-written form-body parsers, if `@hono/mcp` | dev-only |
| **4** | **bootstrap ergonomics**: the app mints a pin and shows `curl …/install?pin=123456 \| sh`; the installer spends it unattended; `coordinator-deploy.md` moves the admin token to a break-glass section. Closes #332 | the curl-with-admin-token tutorial | app layers, both phones |
| later | passkeys with `@simplewebauthn/server`; signed intents, once the trust root question in `trust.md` is answered | | |

What this does not change: who may join (the allowlist and the pin), what a
host proves (its key), what the coordinator may hold (nothing it can spend),
and the rejection of device flow. Those were the decisions. The rest was
plumbing, and plumbing is what dependencies are for.
