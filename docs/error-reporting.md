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

## Session replay, on both phones

The one thing in this document that is not a refusal, so it gets the argument
rather than a line in the table.

A replay is a recording of the app's screens. Read against the paragraph above
that turns screenshots off, that looks like a contradiction, and it is not:

- **A replay frame is composited, not captured.** Every text run and every
  image is replaced by a rectangle before the frame is encoded. What leaves the
  phone is the *shape* of the app — which screen, which sheet, in which order —
  and none of the words on it. `maskAllText` and `maskAllImages` are the SDK's
  defaults and are written out anyway, because the reporter's whole posture is
  that a default is something a minor version may change and a line is not.
- **The sequence is the part a stack trace does not have.** A crash in the pane
  reads differently depending on whether somebody had just switched hosts or
  had been sitting still for a minute. A single masked still adds nearly
  nothing the trace lacks, which is why the trade comes out differently for the
  two — `attachScreenshot` stays off rather than being reconsidered.
- **`sessionSampleRate` is 0.0, not the quickstart's 0.1.** Same reasoning as
  the Worker's `tracesSampleRate`, landing harder on a phone: one session in
  ten would be a recording of somebody's fleet made for no reason, with no
  incident behind it and nothing waiting to read it. `onErrorSampleRate` is
  1.0, so every session that goes wrong is covered, and a session that went
  right is not one anybody opens. **Raise it while testing the feature** — until
  somebody does, a replay only ever appears attached to an error.
- **Network detail is left unset.** On iOS, `networkDetailAllowUrls`,
  `networkRequestHeaders` and `networkResponseHeaders` would attach request and
  response detail to the replay, and every request this app makes carries the
  fleet credential in a header. Empty is the same refusal
  `enableNetworkBreadcrumbs` makes by another route. Android exposes no
  manifest key for any of it, so there is nothing to decline there — which is
  also why only the iOS side of this has a test.

`beforeSend` is **not** a backstop here and nothing is — a frame never passes
through it. The masking switches are load-bearing alone, which is what
`test/sentry-scrub.test.js` asserts about the Swift source.

**What it costs when nothing breaks.** A non-zero `onErrorSampleRate` means the
SDK composites and buffers frames continuously, for a recording discarded
unless an error arrives. That is real battery on a phone that is often just
sitting on a session list, and it is the price of the replay being there for
the crash that does not reproduce.

**No version bump was needed.** Replay wants sentry-cocoa 8.43.0 or newer and
`project.yml` already pins 9.27.0 exact; on the v9 line the options live at
`options.sessionReplay` rather than the 8.x `options.experimental.sessionReplay`.
The install snippet's `from: "9.28.0"` is a range, and a range is a build that
changes without a commit — the pin stays exact and stays where it is. Replay
needs iOS 16; the deployment target is 26, so there is no `#available` guard to
write.

**Android carries the same four decisions,** in `AndroidManifest.xml` rather
than in code — that app has no `Application` class and no `SentryAndroid.init`
call, so every option it sets is a `meta-data` key:

```xml
<meta-data android:name="io.sentry.session-replay.mask-all-text"        android:value="true"  />
<meta-data android:name="io.sentry.session-replay.mask-all-images"      android:value="true"  />
<meta-data android:name="io.sentry.session-replay.on-error-sample-rate" android:value="1.0"   />
<meta-data android:name="io.sentry.session-replay.session-sample-rate"  android:value="0.0"   />
```

The values match iOS exactly, and `test/sentry-scrub.test.js` reads both files
and fails if they ever stop matching. Two numbers in two languages with nothing
asserting they agree is how the reassurance line drifted.

**A manifest key is a worse failure than a wrong Swift property,** which is why
those tests are blunter on this side. A `meta-data` name the SDK does not
recognise is *silently ignored* — no build error, no runtime error, just a
replay that never records or a mask nobody asked for. Every key above is a
literal from Sentry's documentation rather than a name inferred from the Swift
property beside it; "The versions, and a warning" below is what that habit is
for.

**No Gradle plugin and no version bump.** `io.sentry:sentry-android` is already
8.56.0 and replay wants 7.20.0 or newer, so the install snippet's other branch
— adding `io.sentry.android.gradle` — is not needed and is still the thing that
broke the build under AGP 9, above. Android's sample rates both default to
0.0, so replay was simply off until `on-error-sample-rate` turned it on.

**The Canvas screenshot strategy was considered and not taken.**
`io.sentry.session-replay.screenshot-strategy` set to `canvas` always masks
text and images and cannot be told otherwise, which is a stronger guarantee
than two booleans and is what Sentry recommends for strict PII. It is also
still experimental, and it has no counterpart on iOS — taking it would mean the
two phones masking by different mechanisms with only one of them testable. One
line when it leaves experimental.

## A DSN is not a secret

It identifies a project and grants only the ability to send it events, which is
why it lives in `wrangler.production.toml` (ours; the fork-safe `wrangler.toml`
leaves it unset), the Android manifest and `project.yml` rather than in a
secret store. **Unset means no reporting at all** — a fresh clone, a
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

## The first real event, and what it taught

`Durable Object reset because its code was updated.` on `POST /api/host/challenge`,
minutes after the first deploy with reporting on.

**It is not a defect.** Every Worker deploy evicts live Durable Objects, and
Cloudflare throws that into whatever request was in flight. The host reconnected
seconds later on its own backoff. Sentry's suggested fix — catch and retry —
was half right and would have been dangerous applied whole: a blind replay
spends a single-use enrolment pin twice, or runs two sessions for one `start`
from a caller that sent no idempotency id.

So a request is replayed only when replaying it is indistinguishable from
sending it once: `GET`/`HEAD`, and `POST /api/host/challenge`, which mints a
nonce that costs nothing to mint twice. Everything else gets **503 with
`Retry-After`** — the honest answer, because the request may or may not have
happened, and a caller that knows to come back is better served than one handed
a 500 and a guess.

The reporting earned its place on day one, and not by finding a bug: it found a
**wrong answer to an expected event**, which no test would have failed on.

## Still to do

- ~~**The Android DSN is a placeholder.**~~ Done — `io.sentry.dsn` now carries
  the real project rather than `REPLACE_WITH_ANDROID_DSN`, which had made every
  refusal in that manifest theoretical: the app posted nowhere, so none of them
  had ever been tested against a real ingest. A replay turned on for an app
  that reports nothing would have been the same joke, so it landed with this.
- Source maps for the Worker and debug symbols for the apps are not wired into
  CI. Each needs an auth token as a repository secret — and the Android mapping
  upload additionally needs a Gradle plugin that works with AGP 9.
