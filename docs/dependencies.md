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
| version | pinned in `package.json`, not floated |
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
compromise. Mitigations: the version is pinned so an upgrade is a reviewable
diff; there are no transitive dependencies to hide a change; and the blast
radius is bounded by what the code does — it verifies tokens, and a malicious
version could forge a sign-in but could not reach a host, because hosts verify
signatures themselves.

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

## What was deliberately NOT taken

**A JOSE library for our own signing.** `src/fleet/crypto.js` calls
`crypto.subtle.sign` and `verify` directly. That is one primitive with no
format to parse and no negotiation to get wrong — the argument above does not
apply, and a library would be carried for two function calls.

**A secrets manager.** See `docs/trust.md`: it is a place to put the same
question, plus an availability dependency on every session start.

**A sign-in SDK on iOS.** `AuthenticationServices` is in the operating system;
Sign in with Apple is `SignInWithAppleButton` and one delegate callback. The iOS
app still has zero packages.

**A Google sign-in SDK beyond the three above.** Firebase Auth would have done
it too, and would have brought an account system, a user database and a second
place for identity to live — for a coordinator whose entire model is "check a
verified email against a list".
