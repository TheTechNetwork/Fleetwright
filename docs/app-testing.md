# Testing the apps — a handoff

For whoever picks up Fleetwright on a machine that has **Xcode with a simulator**
and **Android Studio with an emulator**. Neither exists in the environment the
apps were written in, which is the whole reason this document is a handoff
rather than a test report.

## What you are inheriting

Both apps are **built and never run**. Precisely:

| | state |
|---|---|
| Android | APK builds (debug 29 MB, signed release 22 MB), installs. Never launched. |
| iOS | Compiles on a macOS CI runner every PR. Never launched, never signed for a device. |
| Push — server | Sender, encoding, device registry, event fan-out: built and unit-tested. Nothing has ever reached a phone. |
| Push — Android | **Not wired.** Needs a Firebase project; see below. |
| Push — iOS | `AppDelegate` registers with APNs and posts the token. Never exercised. |

So the first person to run either of these should expect to find things. The
first *compile* of the iOS app already turned up a `Section` initialiser that
does not exist — that is the level of unverified this is.

## The one thing to do first: have a coordinator to point at

The apps are clients. Without a coordinator they show an empty settings screen
and nothing else, and you will not be able to tell a broken app from a
misconfigured one. Pick one:

| | how | good for |
|---|---|---|
| **The Worker** | `https://fleet.thetech.network`, already deployed by CI | iOS, and anything realistic — it is HTTPS, which iOS needs |
| **A box on the LAN** | `http://<box>:8791` after `install.sh` | Android; see the ATS note before trying it on iOS |
| **Local Node coordinator** | `node bin/agent-fleet-coordinator` on the Mac | fastest loop, no fleet — but with no host connected, `list` is legitimately empty |

The **API token** is what both apps authenticate with — `Bearer <token>` on every
request. Get it from whichever coordinator you chose:

```sh
sudo grep AGENT_FLEET_API_TOKEN /etc/agent-fleet-coordinator.env   # a box
# for the Worker it is the AGENT_FLEET_API_TOKEN GitHub Actions secret
```

Sanity-check the coordinator from the same machine **before** blaming an app:

```sh
curl -s -H "authorization: Bearer $TOKEN" https://fleet.thetech.network/api/hosts
curl -s https://fleet.thetech.network/healthz     # deliberately unauthenticated
```

`/healthz` answering while `/api/hosts` 401s means the token is wrong, not the
app. `/api/hosts` returning an empty list means no host has dialled in — that is
a fleet problem, and the app will correctly show nothing.

## Emulator specifics that will cost you an hour each

**The Android AVD must be API 36 or newer.** `minSdk = 36`, so the app will not
install on anything older and the failure is a terse `INSTALL_FAILED_OLDER_SDK`.
`compileSdk`/`targetSdk` are 37.

**The Android emulator reaches the host at `10.0.2.2`, never `127.0.0.1`.** A
coordinator on the Mac's loopback is `http://10.0.2.2:8791` from inside the
emulator. `localhost` there is the emulator itself.

**The iOS simulator shares the host's network**, so `127.0.0.1` means the Mac.
That part is easier than Android.

**iOS blocks plain HTTP.** There is no `NSAppTransportSecurity` exception in
`project.yml`, so `http://192.168.x.x:8791` will fail — and it fails as a
network error, which reads exactly like the coordinator being down. Use the
HTTPS Worker on iOS. If you genuinely need a LAN box, add an ATS exception *for
testing only* and do not commit it.

Android allows cleartext deliberately (`usesCleartextTraffic="true"` in the
manifest) because a LAN box over plain HTTP is the normal case there.

**The iOS deployment target is 18.0.** Older simulators will not appear.

## What to actually test

Every action in both apps is one intent to the coordinator, so this is the list:

- [ ] **Settings** accept a URL and token, and persist across a relaunch
- [ ] **A wrong token** produces "The coordinator rejected the token", not a crash or a silent empty list
- [ ] **An unreachable URL** produces a readable error
- [ ] **list** — sessions appear, each attributed to a host
- [ ] **start** — with a name, and without one (the coordinator generates `cc-brave-otter`)
- [ ] **stop**
- [ ] **resume** — including the resume-dialog case, where `choice` is sent
- [ ] **A second `start` with the same idempotency key** does not create two sessions
- [ ] Rotate the device, background and foreground the app, kill and relaunch

### iOS only: Siri

§7 puts these *above* the app itself — "Hey Siri, resume bigjob" from a locked
phone is the requirement that chose the transport.

- [ ] "Resume *session* in Fleetwright" — with the app **not** open
- [ ] "Start a session in Fleetwright"
- [ ] "Stop *session* in Fleetwright"
- [ ] The session name is a **resolved entity** — Siri should match against
      sessions that exist, not transcribe free text
- [ ] `openAppWhenRun` is false, so none of these should foreground the app

Siri works in the simulator, but this is worth doing on a real device if one is
available — speech recognition against a resolved entity list is the part most
likely to disappoint.

### Push

Test the transport before the integration:

- **iOS simulator cannot receive real APNs pushes.** Use
  `xcrun simctl push <device> network.thetech.fleetwright payload.apns` to prove
  the app handles a notification. Real delivery needs a device and a signing
  identity.
- **The Android emulator can** receive real FCM — but only an image **with Google
  Play services**. A plain AOSP image silently never receives anything.

Android push is not wired at all yet. Doing it is four steps, all in
[`../apps/android/README.md`](../apps/android/README.md), and the reason it was
left out is that the Google Services Gradle plugin *fails the build* when
`google-services.json` is absent — so wiring it before a Firebase project exists
would have meant nobody could build the app.

Once a device is registered, make the coordinator send one:

```sh
curl -s -X POST https://fleet.thetech.network/api/devices \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"platform":"android","token":"<the FCM token>"}'
```

Then have a session hit a prompt. If nothing arrives, check the coordinator log
first: with no credential it says `push (not configured, would send to N)`,
which tells you the fan-out worked and only the sender is missing.

## Gotchas already paid for

Do not rediscover these:

- **`Section("title") { } footer: { }` does not exist** in SwiftUI. Use `header:`
  and `footer:` closures. This was the first compile error the app ever produced.
- **The APNs device token must be sent as hex**, not `Data`'s description.
  Sending the description produces a registration that silently never delivers.
  `Fleet.swift` already does this correctly — do not "simplify" it.
- **`aps-environment` is `development`** in the entitlements. Wrong value here is
  the classic "notifications work in Xcode and not in TestFlight".
- **Info.plist and the entitlements are generated by XcodeGen** and gitignored.
  Editing them in Xcode edits a file that `xcodegen generate` overwrites — change
  `project.yml` instead.
- **AGP 9 provides Kotlin itself.** Applying `org.jetbrains.kotlin.android`
  alongside it fails with *"Cannot add extension with name 'kotlin'"*.

## Where the seams are

If something is wrong, it is worth knowing which side to fix:

| symptom | look at |
|---|---|
| A verb is rejected or malformed | `src/fleet/protocol/intents.js` — the verb set is fixed and deliberate |
| The coordinator answers but the app misreads it | `Fleet.kt` / `Fleet.swift` parsing |
| Sessions missing or attributed to the wrong host | the sidecar on that box, not the app |
| Push fans out but nothing arrives | `src/fleet/push.js`, then the Firebase console |

**The API is not the place to change first.** §7 designed it flat and
single-round-trip so a Shortcut could call it; if an app wants a different shape,
that is usually the app's problem to solve.

## Reporting back

- Branch from `main`, one PR per fixable thing.
- CI builds both apps on every PR — the iOS job on a macOS runner — so a green
  PR means it at least still compiles for everyone else.
- For anything you cannot fix, an issue with the exact error text beats a
  description. Most of the errors here are terse and searchable.
- If the *server* side is wrong, say so rather than working around it in the
  app. A workaround in two apps is two workarounds.
