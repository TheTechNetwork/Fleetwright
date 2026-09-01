# Error reporting

Sentry, on the Worker and both apps. This document is mostly about what it is
**not** allowed to send, because that is the part that needed designing.

## The problem, stated plainly

An error reporter's entire job is to copy request context to a third party, and
this coordinator carries a credential on nearly every request:

| where | what |
| --- | --- |
| `?token=fwk_…` | a device credential **in the URL**. Deliberate — a Shortcut calls this through "Get Contents of URL" and cannot set headers (`openapi.json`). |
| `Authorization` | the same credential, or the admin token. |
| `POST /oauth/token` | an authorization code and its PKCE verifier. |
| `POST /api/session` | an Apple or Google ID token. |
| `POST /api/intent` | `link github <token>` — which `src/core/redact.js` already exists to keep out of this fleet's own journal. |

Keeping a secret out of the journal and then posting it to sentry.io would be
the same bug with a longer flight. So the configuration is mostly refusal.

## What is switched off, and why

**Worker** (`worker/src/sentry.js`):

- `dataCollection.userInfo: false`, `dataCollection.httpBodies: []`, `sendDefaultPii: false` — the three the SDK turns on for you.
- `beforeSend` and `beforeSendTransaction` scrub every event: headers, cookies and body deleted outright; the URL rebuilt.
- The query string is an **allowlist**, not a denylist. `token` is the one that exists today; the rule has to survive the next parameter somebody adds without anybody remembering that file.
- Breadcrumbs are scrubbed too — this coordinator's outbound fetches are intents carrying the caller's credential.
- `tracesSampleRate` is `0.05`, not the quickstart's `1.0`. Every host sends a health frame every fifteen seconds and every phone polls.

**Both apps**: no screenshots, no view hierarchy, no network breadcrumbs, no
user-interaction tracing, tracing off entirely. The session list, the pane and
the credentials sheet are all on screen; a screenshot of any of them is the
thing the app is careful about. iOS keeps a `beforeSend` as a backstop, because
every switch above can be undone by a careless edit or a new SDK default.

**Android has no Sentry Gradle plugin**, and that is a decision rather than an
omission. It failed the build — `Extension of type 'AppExtension' does not
exist`, AGP's old entry point, which AGP 9 removed. A newer plugin may well
handle it, but its only job here would be uploading the ProGuard mapping, and
that needs an auth token this repository does not have. It would buy nothing and
could only break the build. Until somebody adds the token, a release crash
reports with an obfuscated stack: worse than a readable one, much better than no
report.

## A DSN is not a secret

It identifies a project and grants only the ability to send it events, which is
why it lives in `wrangler.toml`, the Android manifest and `project.yml` rather
than in a secret store. **Unset means no reporting at all** — a fresh clone, a
contributor's `wrangler dev` and a self-hosted fleet post nowhere, and turning
it off during an incident is a variable change rather than a code deploy.

What *is* secret is the auth token that uploads debug symbols and ProGuard
mappings. Those files are gitignored up front rather than after the first
accidental commit: `apps/android/sentry.properties`, `.sentryclirc`.

## The cost, measured

The Worker bundle goes from **145 KB to 327 KB** minified — the SDK is larger
than the coordinator. `wrangler.toml` is written around a cold start on
cellular, so this is a real trade and is recorded there. `SENTRY_DSN` being
unset disables the reporting but not the bundle; removing the dependency is the
lever if that second is ever missed.

`nodejs_als` is set, not `nodejs_compat`. The SDK needs `AsyncLocalStorage` to
tie an error to its request; `nodejs_als` provides that one API, while
`nodejs_compat` pulls in the polyfill surface `wrangler.toml` spends a paragraph
declining.

## The versions, and a warning

Every version in the first attempt at this was **invented**, and all three were
wrong: `sentry-android` 8.29.0 (real: 8.54.0), the Gradle plugin 5.1.0 (real:
6.20.0), `sentry-cocoa` 8.60.0 — a version that never existed, because that SDK
went from 8.x to 9.x. CI caught all three, one per platform, which is the only
reason they are right now. Check a registry rather than a memory.

## What CI needed that it did not have

The tests in `test/` import `worker/src/worker.js` — `openapi.test.js`,
`worker-routes.test.js` and `mcp-remote.test.js` all do, to assert the two
coordinators agree. The `test` job installed the root only, which was correct
for as long as its comment ("no runtime dependencies") was true. The moment the
Worker gained one, all three failed with `ERR_MODULE_NOT_FOUND` — while
`verify.sh` passed locally, because `worker/node_modules` was already there.

A local check that cannot fail the way CI fails certifies nothing. The job now
installs the Worker's dependencies too.

## Still to do

- **The Android DSN is a placeholder.** The wizard fetches it and the wizard is
  a Windows executable; `io.sentry.dsn` in `AndroidManifest.xml` reads
  `REPLACE_WITH_ANDROID_DSN` and the app will not report until it is filled in.
- Source maps for the Worker and debug symbols for the apps are not wired into
  CI. Each needs an auth token as a repository secret — and the Android mapping
  upload additionally needs a Gradle plugin that works with AGP 9.
