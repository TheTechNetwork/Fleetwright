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

## Reviewed, but unrun

design.md §9 says this plainly and it has not changed: **this cannot be built or
tested in the environment it was written in.** No macOS, no Xcode, no signing
identity. The Swift here is reviewed code, not verified code, and the first
build on a Mac should be expected to turn up something.

## Build

```sh
brew install xcodegen
cd apps/ios && xcodegen generate && open Fleetwright.xcodeproj
```

`project.yml` is the source of truth rather than a checked-in `.xcodeproj`. A
`project.pbxproj` is a generated file full of UUID cross-references; hand-writing
one produces a project that opens on exactly one machine.

Then in Xcode: set your team on the target, and check that **Push Notifications**
is on under Signing & Capabilities.

## First run

Settings → the coordinator URL and the API token from
`/etc/agent-fleet-coordinator.env`. Nothing is baked into the binary — §5: a
credential in an IPA is public the moment somebody unzips it.

## Siri

Three intents, with phrases registered so they work without opening Shortcuts:

- "Resume *session* in agent-fleet"
- "Start a session in agent-fleet"
- "Stop *session* in agent-fleet"

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
