# Dependencies, and what was checked before taking one

This project shipped with none for a long time, and the reason was never
purity: a dependency in the coordinator runs with the coordinator's authority,
and a dependency in the app is public the moment the app is. The bar is
therefore "would I rather own this code than audit this package", and for most
things the answer stayed yes.

Two places where it does not, and one that was reversed.

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

## What was deliberately NOT taken

**A JOSE library for our own signing.** `src/fleet/crypto.js` calls
`crypto.subtle.sign` and `verify` directly. That is one primitive with no
format to parse and no negotiation to get wrong — the argument above does not
apply, and a library would be carried for two function calls.

**A secrets manager.** See `docs/trust.md`: it is a place to put the same
question, plus an availability dependency on every session start.

**Anything in the apps.** The iOS app has no packages and the Android app has
AndroidX and Firebase only. A credential in a phone is public the moment
somebody unzips the binary, and every SDK is another party in that.
