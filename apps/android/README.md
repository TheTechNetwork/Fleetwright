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

Settings → the coordinator URL, then **Sign in with Google**. The app hands the
coordinator the resulting ID token and is issued a credential for this device,
kept encrypted with a key that never leaves the phone's keystore. There is no
token to type: §5 is explicit that a credential in an APK is public the moment
somebody unzips it, and a credential shared between phones is one that cannot be
revoked for one of them.

The coordinator has to have sign-in configured — `AGENT_FLEET_AUTH_ISSUERS`,
`AGENT_FLEET_AUTH_AUDIENCES` and `AGENT_FLEET_AUTH_ALLOW`, with your address on
the allowlist. See [`../../docs/identity.md`](../../docs/identity.md).

### Google sign-in needs a web OAuth client — four steps

The committed `google-services.json` has `"oauth_client": []` for both package
names. Until that changes, the app builds, runs, and says plainly that this
build has no Google sign-in configured.

**1. Enable Google as a sign-in provider.** Firebase console → Authentication →
Sign-in method → Google → Enable. This is what creates the OAuth clients,
including the **web** one, which is the one that matters.

**2. Register SHA-1 fingerprints, for every keystore that will ever build.**
Project settings → your Android app → Add fingerprint. Google Sign-In checks the
signing certificate, so a missing fingerprint fails at the account picker with a
message that does not say why.

```sh
# the debug keystore, for local builds — password is literally "android"
keytool -list -v -alias androiddebugkey -keystore ~/.android/debug.keystore \
  -storepass android -keypass android | grep SHA1

# your release keystore, the one ANDROID_KEYSTORE_FILE points at
keytool -list -v -alias fleetwright -keystore ~/fleetwright-release.jks | grep SHA1
```

Do it for **both package names** — `network.thetech.fleetwright` and
`network.thetech.fleetwright.debug`, which the debug build appends.

**THE ONE THAT CATCHES PEOPLE: Play App Signing.** If Play re-signs your app —
and it does by default — then the certificate a user's device sees is Google's,
not yours. Sign-in works perfectly in an APK you built and fails for every
install from Play, which is the worst possible order to discover it in. Take the
SHA-1 from **Play Console → your app → Setup → App integrity → App signing key
certificate** and add that one too.

**It has now happened.** Build 300 from the Play beta answered
`No credentials available`; the release APK from the same commit, installed
directly, signed in fine. That difference IS the diagnosis — same code, same
`google-services.json`, different signing certificate — and `SignIn.kt` now says
so in the failure rather than passing Google's four words through.

Adding the fingerprint is server-side: existing installs start working within
minutes, with no new release.

**3. Download `google-services.json` again and commit it.** One file carries
every client. With a web client present, the Google Services plugin generates
the `default_web_client_id` string resource that `SignIn.kt` looks up at runtime.

**4. Put the WEB client id in `AGENT_FLEET_AUTH_AUDIENCES`** on the coordinator
— not the Android one. `setServerClientId` names the web client, so the web
client is what appears as `aud` on the ID token, and the coordinator checks
`aud`. It sits alongside the iOS bundle id; the list holds both because Apple
and Google issue for different audiences.

```sh
npx wrangler secret put AGENT_FLEET_AUTH_AUDIENCES
#   network.thetech.fleetwright  654943059314-....apps.googleusercontent.com
```

Until then, the collapsed **"use a credential instead"** field takes the demo
credential or the admin token, which is enough to exercise everything
downstream of sign-in.

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

The app side needed a Firebase project, because the FCM token has to come from
somewhere — that is done, not pending. Both `network.thetech.fleetwright` and
`network.thetech.fleetwright.debug` are registered, `google-services.json`
above is the result, the Google Services plugin is applied
(`apps/android/build.gradle.kts`), and `firebase-bom` plus `firebase-messaging`
are on the classpath (`app/build.gradle.kts`). A fork that wants its own
Firebase project repeats those same steps with its own console and its own
`google-services.json`.

The same Firebase project delivers to iOS through FCM's APNs bridge, which is
why it is one integration rather than two.

## What is deliberately not here

No dependency injection, no networking library, no architecture. The API is a
handful of endpoints returning flat JSON — §7 designed it that way so a Shortcut
could call it — and every layer added here is one carried for the life of the
app to save about thirty lines.
