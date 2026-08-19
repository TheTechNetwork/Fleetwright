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

For a **signed release** APK, which is what an unsigned one cannot be —
unsigned APKs will not install:

```sh
KEYSTORE_PASSWORD='…' mise run keystore     # writes ~/fleetwright-release.jks
ANDROID_KEYSTORE_FILE=~/fleetwright-release.jks ANDROID_KEYSTORE_PASSWORD='…' \
  ANDROID_KEY_ALIAS=fleetwright ANDROID_KEY_PASSWORD='…' ./gradlew assembleRelease
```

`signingConfigs` is only declared when `ANDROID_KEYSTORE_FILE` is set, so a box
with no keystore still builds debug. CI does the same thing from the four
`ANDROID_*` secrets and attaches the APK to a GitHub release — see
[`../../docs/ci.md`](../../docs/ci.md).

## First run

Settings → the coordinator URL and the API token from
`/etc/agent-fleet-coordinator.env`.

Nothing is baked into the binary. §5 is explicit about this: a credential in an
APK is public the moment somebody unzips it, so it is entered once and kept on
the device.

## Push notifications

Wired. The app fetches an FCM token on launch, registers it with the
coordinator, and re-registers when FCM rotates it (`Messaging.kt`).

**Two Firebase apps are needed, not one.** The debug build appends `.debug` to
the applicationId so it can sit beside a release build on the same phone, and
the Google Services plugin fails any build whose package is not in
`google-services.json`:

```
No matching client found for package name 'network.thetech.fleetwright.debug'
```

So register both in the Firebase console — `network.thetech.fleetwright` and
`network.thetech.fleetwright.debug` — and download the config again; one file
carries both. Without the second, `assembleDebug` cannot build at all, which
is every PR and every local build.

`google-services.json` is committed. It is not a secret: it ships inside every
APK, and its API key is restricted to this package. Treating it as one would
mean a repository nobody else can build.


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
