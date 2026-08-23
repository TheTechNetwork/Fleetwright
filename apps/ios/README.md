# Fleetwright — the iOS app

**The app is called Fleetwright; the project is still agent-fleet.** "Agent
Fleet" is taken on the App Store, where display names are unique across the
whole store. The CLIs, the services and the repository keep their names — only
the thing with a listing needed a new one.

Coined on purpose, like shipwright: a made-up compound is far less likely to
collide, which matters after losing time to one collision already. If you would
rather it were something else, it is `name:` and
`PRODUCT_BUNDLE_IDENTIFIER` in `project.yml` plus the sources directory — a
two-line change plus a rename, deliberately kept that small.

SwiftUI, plus the App Intents that make Siri work — which §7 puts *above* the
app itself: "Hey Siri, resume bigjob" from a cold radio in under a second is the
requirement that chose the transport in §4.

## Compiled, not run

design.md §9 said this could not be built in the environment it was written in —
no macOS, no Xcode, no signing identity. That is still true locally, but **CI
builds it on a macOS runner on every PR** (`.github/workflows/ios.yml`), so it
is no longer unverified code: it compiles, and the first compile duly turned up
a `Section` initialiser that does not exist.

What CI does *not* do is run it. Nothing here has been driven by a person on a
device — no Siri phrase spoken, no push delivered, no session resumed from a
lock screen. Compiling is a much weaker claim than working.

## Build

```sh
brew install xcodegen
cd apps/ios && xcodegen generate && open Fleetwright.xcodeproj
```

`project.yml` is the source of truth rather than a checked-in `.xcodeproj`. A
`project.pbxproj` is a generated file full of UUID cross-references; hand-writing
one produces a project that opens on exactly one machine.

Then in Xcode: set your team on the target, and check that **Push
Notifications** and **Sign in with Apple** are both on under Signing &
Capabilities.

Sign in with Apple is entitled in `project.yml`, so XcodeGen writes it into the
entitlements file — but an entitlement is only half of it. The App ID has to
carry the capability before a provisioning profile can include it, and until it
does, signing fails with *"provisioning profile does not include the
com.apple.developer.applesignin entitlement"*, which reads like a certificate
problem and is not one. Xcode's automatic signing usually enables it for you;
otherwise it is one checkbox in the developer portal under Identifiers.

## First run

Settings → the coordinator URL, then **Sign in with Apple**. The app hands the
coordinator the resulting ID token and is issued a credential for this device,
kept in the keychain. There is no token to type — §5: a credential in an IPA is
public the moment somebody unzips it, and one shared between phones cannot be
revoked for just one of them.

Choose **Share My Email**. Hide My Email produces a real, stable address that
can never match a company domain, so a fleet that allows people by domain can
never allow it; the coordinator detects it and says so rather than reporting
"not on the list".

The coordinator has to have sign-in configured — `AGENT_FLEET_AUTH_ISSUERS`,
`AGENT_FLEET_AUTH_AUDIENCES` (which must include this app's bundle id, because
that is the audience Apple issues its ID tokens for) and
`AGENT_FLEET_AUTH_ALLOW`. See [`../../docs/identity.md`](../../docs/identity.md).

The collapsed **"use a credential instead"** field takes the public demo
credential or the admin token, which is how App Review gets in and how you
exercise everything downstream of sign-in before sign-in works.

## Siri

Three intents, with phrases registered so they work without opening Shortcuts:

- "Resume *session* in Fleetwright"
- "Start a session in Fleetwright"
- "Stop *session* in Fleetwright"

The app name in those phrases is `\(.applicationName)` rather than a literal,
so it followed the rename to Fleetwright without anyone editing it.

The session is a **resolved entity**, not free text: Siri matches what you say
against the sessions that actually exist, rather than mishearing a name and
failing. This is also why generated names became words — "resume brave otter" is
something a person can say, and "resume cc-1a2b3c" is not.

`openAppWhenRun` is false throughout. The point is that it happens while the
phone is still in your pocket.

## Push

`AppDelegate` asks for authorisation once the app is configured, registers with
APNs, and posts the device token to `POST /api/devices`. The token is sent as
**hex** — sending `Data`'s description instead is the classic mistake, and
produces a registration that silently never delivers.

Two routes to actually delivering:

- **Through FCM** (recommended, and what Android already uses): add the iOS app
  to the same Firebase project and upload an APNs auth key. One integration,
  both platforms, and `docs/push.md` needs no changes.
- **Direct APNs**: a second sender alongside `fcmPusher` in
  `src/fleet/push.js`, signing ES256 with a `.p8` key. The interface is one
  `send` method; see `docs/push.md`.

`aps-environment` is `development` in the entitlements. Getting this wrong is
the classic "notifications work in Xcode and not in TestFlight".
