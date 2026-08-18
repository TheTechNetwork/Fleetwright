# The Android app

A one-screen client for the fleet: what is running, and start / stop / resume.
Every action is an intent to the coordinator, so the app never talks to a host
and never has to know which box holds which session.

## Versions

Latest of everything, and every one of them was built before it was written
down: JDK 25, Gradle 9.7, AGP 9.3.1, Kotlin 2.2, compileSdk and targetSdk 37,
compose-bom 2026.08.

**`minSdk` is 36 — one version back, and that is a real decision.** It excludes
most phones in the field today. It is the right trade here because there is no
installed base to keep working and every level supported below it is a
compatibility path somebody reasons about forever, but it is not a default to
inherit without thinking.

Two notes on the toolchain, both of which cost a build to discover:

- **AGP 9 has built-in Kotlin support.** Applying `org.jetbrains.kotlin.android`
  alongside it fails with *"Cannot add extension with name 'kotlin'"*. Only the
  Compose plugin is applied separately, because it is a compiler plugin rather
  than language support.
- **`android.kotlinOptions` is gone.** `jvmTarget` lives in a top-level
  `kotlin { compilerOptions { } }` block now, and has to agree with
  `compileOptions` or the two toolchains disagree about what they are emitting.

## Build

```sh
mise trust && mise install     # node + java
mise run android-sdk           # SDK, licences, build tools
mise run apk                   # or: cd apps/android && ./gradlew assembleDebug
```

The APK lands at `app/build/outputs/apk/debug/app-debug.apk`. Install it with
`adb install -r app/build/outputs/apk/debug/app-debug.apk`, or just copy it to
the phone and open it.

Debug only for now. A release build needs a signing key, and an **unsigned
release APK cannot be installed** — which makes it worse than useless for
testing. Signing is one `signingConfigs` block once there is a keystore.

## First run

Settings → the coordinator URL and the API token from
`/etc/agent-fleet-coordinator.env`.

Nothing is baked into the binary. §5 is explicit about this: a credential in an
APK is public the moment somebody unzips it, so it is entered once and kept on
the device.

## Push notifications

The **server side is finished** — the sidecar detects that a session needs a
person, the coordinator fans it out, and `POST /api/devices` is where a phone
registers. See [`../../docs/push.md`](../../docs/push.md).

The app side needs a Firebase project, because the FCM token has to come from
somewhere. It is deliberately **not** wired up yet: the Google Services Gradle
plugin *fails the build* when `google-services.json` is absent, so adding it
before there is a Firebase project would mean nobody could build the app at all.

To turn it on:

1. Firebase console → add an Android app with the id `network.thetech.fleetwright.debug`
   (note the `.debug` suffix the debug build applies), download
   `google-services.json` into `apps/android/app/`.
2. `apps/android/build.gradle.kts` → add
   `id("com.google.gms.google-services") version "4.4.2" apply false`
3. `apps/android/app/build.gradle.kts` → add `id("com.google.gms.google-services")`
   to the plugins block, and
   `implementation(platform("com.google.firebase:firebase-bom:33.1.2"))` plus
   `implementation("com.google.firebase:firebase-messaging")` to dependencies.
4. Call `Fleet.registerDevice(token)` with the token from
   `FirebaseMessaging.getInstance().token`. That method already exists and
   already posts to the coordinator.

The same Firebase project delivers to iOS through FCM's APNs bridge, which is
why it is one integration rather than two.

## What is deliberately not here

No dependency injection, no networking library, no architecture. The API is a
handful of endpoints returning flat JSON — §7 designed it that way so a Shortcut
could call it — and every layer added here is one carried for the life of the
app to save about thirty lines.
