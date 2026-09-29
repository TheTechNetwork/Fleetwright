# Dependencies, and what was checked before taking one

This project shipped with none for a long time, and the reason was never
purity: a dependency in the coordinator runs with the coordinator's authority,
and a dependency in the app is public the moment the app is. The bar is
therefore "would I rather own this code than audit this package", and for most
things the answer stayed yes.

Two kinds of place where it does not, and one that was reversed.

## jose — runtime, coordinator only

Used for verifying OIDC ID tokens at sign-in.

| | |
|---|---|
| version | `6.2.10`, exact — see below (Renovate moves it; `package.json` is the number to believe) |
| dependencies | **none** — nothing transitive to audit |
| licence | MIT |
| adoption | ~100M downloads a week |
| author | panva, who writes the specifications this implements |
| cadence | four releases in the three weeks before it was taken |
| runtime | WebCrypto, so the Worker bundle works unchanged |

**Why a dependency here and nowhere else.** This file hand-rolled JWT
verification first, and the hand-rolled version was defensible: two algorithms,
every claim checked, tests for `alg: none` and for a tampered payload with a
valid signature. It still went. JWT verification is the canonical place where
being *nearly* right has produced CVEs for a decade, and its failure mode is
silent acceptance rather than a crash — the worst thing to be nearly right
about. Key rotation, cooldowns and concurrent cache misses are also real work
that jose has already done carefully.

**The residual risk, stated.** A single maintainer is a single account to
compromise.

Mitigations: the version is **exact, not a caret range**, and that was a
correction rather than a decision — this table said "pinned" while
`package.json` said `^6.2.9`, which floats within 6.x. The lockfile and
`npm ci` meant the installed version was pinned in practice, but the
installer falls back to `npm install` when the lockfile and the manifest
disagree, and that path would have taken whatever 6.x was newest. An
argument for pinning is worth nothing if the pin is not there, so the pin
is there. Renovate proposes upgrades as reviewable pull requests either
way.

There are also no transitive dependencies to hide a change; and the blast
radius is bounded by what the code does — it verifies tokens, and a
malicious version could forge a sign-in but could not reach a host,
because hosts verify signatures themselves.

## oauth4webapi — runtime, coordinator and host

Used for the outbound OAuth client — exchanging a GitHub or Cloudflare code
for tokens, on the coordinator or on the host that minted the PKCE verifier —
and for OIDC discovery in `oidc.js`, so an issuer nobody wrote down is asked
where its keys are rather than guessed at.

| | |
|---|---|
| version | exact, like `jose` — `package.json` is the number to believe |
| dependencies | **none** |
| licence | MIT |
| author | panva, the same as `jose` |
| runtime | WebCrypto and `fetch`, so the Worker bundle and the sidecar carry the same code |

**Why a dependency here.** [`auth-and-join.md`](./auth-and-join.md) applies
the sentence that took `jose` to the rest of the auth surface: a *primitive*
is worth owning, a *protocol with negotiation and a silent failure mode* is
not. A token endpoint is one — content types, error shapes, `WWW-Authenticate`
challenges, the `token_type` check — and this repository had two hand-written
clients for two providers that disagreed about all of it ("two functions
wearing a trench coat", the old comment said). The library speaks RFC 6749 to
both; what stays ours is the URL each person is sent to and the words they
read on the way back.

It also does discovery. `oidc.js` used to hard-code three JWKS URLs and guess
`<issuer>/.well-known/jwks.json` for anyone else, which the specification does
not require; `identity.md`'s "provider-agnostic" is true now.

**The residual risk, stated.** Same maintainer as `jose`, so the same single
account — and the same mitigations: exact pin, no transitive dependencies,
Renovate proposing upgrades as reviewable pull requests. The blast radius is
the exchange: a malicious version could leak a GitHub or Cloudflare token at
link time, from the host that already holds the client secret. It could not
mint a fleet credential and could not reach a session.

**What it deliberately does not do here.** The PKCE *challenge* in
`host/pkce.js` is still one `createHash('sha256')` of ours: it is a primitive,
and `connect` builds its catalogue synchronously. The *verifier* is the
library's, so the length and alphabet are RFC 7636's by construction.

## @modelcontextprotocol/sdk — development only, the conformance oracle

Used in exactly one file, `test/mcp-conformance.test.js`, and never at
runtime: the SDK's *client* is driven against our hand-written authorization
server and Streamable HTTP transport in `src/mcp/`.

| | |
|---|---|
| version | exact |
| dependencies | many — express, zod, ajv and friends, which is why it stays a devDependency |
| runtime | none; it is not in the coordinator bundle or the release |

**Why a dependency, and why only in tests.** `src/mcp/oauth.js` and
`routes.js` implement RFC 9728, 8414, 7591 and PKCE by hand, on the open
internet, taking anonymous registrations. Every route was tested with requests
we wrote. What was missing is a client we did *not* write, reading the
specifications the way their reference implementation reads them — because the
failure mode of a hand-rolled protocol server is not a crash, it is a quiet
mismatch found by the first real client. The SDK is that client. Shipping it
would mean carrying its dependency tree in the coordinator for a transport we
already have; asking it questions costs nothing at runtime.

**What it found, the first time it ran.** Nothing in the protocol: discovery
from the 401's `WWW-Authenticate`, both metadata documents, dynamic
registration, the S256 challenge, the code exchange at `/oauth/token`,
`initialize`, the `initialized` notification's 202, `tools/list` and
`tools/call` all went through unchanged. That is the answer to the question
[`auth-and-join.md`](./auth-and-join.md) left open: Cloudflare's
`workers-oauth-provider` is **not taken**, because the ~600 lines it would
replace conform, and replacing them would cost the property that an MCP
client's token *is* a device credential revocable from the People screen.

## androidx.browser — Android app

`androidx.browser:browser`, for Custom Tabs: the provider's authorization page
opened inside the app, closing itself when it redirects back. Pinned to an
exact version like everything else here.

**Why a dependency at all.** The alternative is not "no browser" — it is a
WebView, which needs no dependency and is the wrong answer. A Custom Tab is the
real browser: real address bar, real padlock, its own process, the user's own
cookies. A WebView is a login form drawn by the app that is asking for the
login, which is the shape of every credential-phishing screen ever built, and
the fact that it would be *our* app drawing it is not something a person on the
other side of the screen can check.

iOS needs no equivalent because `ASWebAuthenticationSession` is in the SDK.

**Blast radius.** It renders a page and returns; it holds no credential, and
what comes back over the custom scheme is trusted for nothing beyond "go and
ask the host again".

## androidx.credentials + googleid — Android app

Used for signing in. Three artifacts, all Google-maintained:

| | |
|---|---|
| `androidx.credentials:credentials` | the platform API that replaced `GoogleSignInClient`, which is deprecated |
| `androidx.credentials:credentials-play-services-auth` | the Play Services provider behind it |
| `com.google.android.libraries.identity.googleid:googleid` | turns a returned credential into a typed ID token |

All three pinned rather than floated, for the same reason `jose` is.

**Why a dependency here.** There is no hand-rolled alternative that is not
worse. The account picker is drawn by the system, not by this app — which is
the security property, because a sign-in screen an app draws is a sign-in
screen an app could fake. Doing this without the platform API would mean an
OAuth flow in a web view, which is the thing every provider now refuses.

**The residual risk, stated.** These run inside the app, so they see whatever
the app sees — which is deliberately little: the app holds one credential for
one fleet, and the ID token they produce is verified at the coordinator against
Google's published keys rather than trusted because the SDK said so. A
malicious version could produce a token the coordinator would reject; it could
not produce one it would accept.

## Checking that the manifest and the lock agree

There is an obvious way to do this and it is destructive:

```sh
npm ci --dry-run          # DON'T
```

**`npm ci` deletes `node_modules` before it does anything, and `--dry-run` does
not stop it.** So the command that looks like "tell me whether these two files
agree" is in fact "empty both dependency trees, then tell me". It reports
success, exits 0, and every tool the project uses is gone — `tsc`, `esbuild`,
`wrangler`. The next thing you run fails with an error about TypeScript not
being installed, which points at nothing.

Learned the direct way, mid-task, in this repo.

The non-destructive answer is already a test, and `verify.sh` runs it:

```sh
node --test test/pinned-dependencies.test.js
```

It reads the JSON and compares it — no install, no network, nothing removed.
It checks three separate properties, because each can break on its own and
only the first is visible in a review:

1. no dependency is declared as a range,
2. what the manifest claims is what the lock installs,
3. the lock's own copy of the root declarations matches the manifest — which
   is the one `npm ci` would otherwise refuse over.

If a tree really does need rebuilding, `npm ci` is the right command for that
job. Just know that rebuilding is what it does, and that the worker's tree may
need the network even when the root's does not: a lockfile bump merged by a bot
is a version nothing has ever fetched onto this machine.

## What was deliberately NOT taken

**A JOSE library for our own signing.** `src/fleet/crypto.js` calls
`crypto.subtle.sign` and `verify` directly. That is one primitive with no
format to parse and no negotiation to get wrong — the argument above does not
apply, and a library would be carried for two function calls.

**An OAuth *server* library for the remote MCP endpoint.** The authorization
server in `src/mcp/oauth.js` is hand-written, and the candidate for replacing
it — Cloudflare's `workers-oauth-provider` — is a real option now that the
coordinator only runs as a Worker. It is held rather than taken, because it
would issue tokens of its own where today an MCP client's token *is* a device
credential revocable from the People screen. The MCP SDK, as a dev-only
conformance oracle, is what decides — [`auth-and-join.md`](./auth-and-join.md).

**A secrets manager.** See `docs/trust.md`: it is a place to put the same
question, plus an availability dependency on every session start.

**A sign-in SDK on iOS.** `AuthenticationServices` is in the operating system;
Sign in with Apple is `SignInWithAppleButton` and one delegate callback. The
iOS app's only package is Sentry (`sentry-cocoa`, pinned exact in
`project.yml`), taken for the same reasons as the Worker's —
[`error-reporting.md`](./error-reporting.md).

**A Google sign-in SDK beyond the three above.** Firebase Auth would have done
it too, and would have brought an account system, a user database and a second
place for identity to live — for a coordinator whose entire model is "check a
verified email against a list".
