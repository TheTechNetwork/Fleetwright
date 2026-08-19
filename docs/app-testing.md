# Testing the apps — a handoff

For whoever picks up Fleetwright on a machine that has **Xcode with a simulator**
and **Android Studio with an emulator**. Neither exists in the environment the
apps were written in, which is the whole reason this document is a handoff
rather than a test report.

## What you are inheriting

Precisely:

| | state |
|---|---|
| Android | Builds, installs, **launches**. Driven through the whole checklist below on an API 37 AVD. |
| iOS | Builds, installs, **launches**, lists sessions over HTTPS and over plain HTTP. Never signed for a device. |
| Push — server | Sender, encoding, device registry, event fan-out: built and unit-tested. Nothing has ever reached a phone. |
| Push — Android | **Not wired.** Needs a Firebase project; see below. |
| Push — iOS | Registers with APNs and posts the token. **The only sender cannot use that token — see below.** |

Both apps have now been run. What that turned up is in the git history; what it
did *not* cover is Siri (no way to speak to it or tap Shortcuts headlessly) and
notification display (the permission alert needs a tap).

So the first person to run either of these should expect to find things. The
first *compile* of the iOS app already turned up a `Section` initialiser that
does not exist — that is the level of unverified this is.

**iOS push cannot work as it currently stands, and the failure is silent.**
`pusherFromEnv` only ever builds `fcmPusher`, which passes `device.token`
straight to FCM's `messages:send` as an *FCM registration token*. But
`FleetwrightApp.swift` registers with APNs directly and `Fleet.swift` posts the
raw **APNs** device token — a different kind of token entirely. FCM rejects it,
and `push.js` treats `INVALID_ARGUMENT`/404 as a dead token and *deletes the
registration*, so the phone quietly unregisters itself and nothing in the log
says why. `docs/push.md` describes both fixes — add the Firebase iOS SDK and
post `Messaging.messaging().token` instead, or write the direct-APNs sender —
and neither is wired. The hex encoding in `Fleet.swift` is correct for the
*direct APNs* path; it is not a substitute for having that path.

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
a fleet problem, and the app will correctly show nothing. It is worth checking
that *first*: the Worker was answering with `"hosts":[]` for the whole first
part of this exercise, which makes both apps look broken when they are being
exactly honest.

Note that the two coordinators answer `/api/hosts` in **different shapes**. The
Worker returns the `snapshot()` form, the Node one returns the registry:

```jsonc
// Worker
{"ok":true,"protocol":1,"hosts":[],"devices":0,"events":[]}
// Node
{"ok":true,"hosts":[…]}
```

Neither app reads this endpoint — they only POST `/api/intent` — so it costs
nothing today, but do not write anything against it assuming one shape.

## Emulator specifics that will cost you an hour each

**The Android AVD must be API 36 or newer.** `minSdk = 36`, so the app will not
install on anything older and the failure is a terse `INSTALL_FAILED_OLDER_SDK`.
`compileSdk`/`targetSdk` are 37.

**The Android emulator is supposed to reach the host at `10.0.2.2`, never
`127.0.0.1`** — `localhost` there is the emulator itself. That is the documented
behaviour and it is worth trying first.

It did not work on the machine this was tested on (macOS 27, emulator 37.0.1,
an API 37 `google_apis_playstore` AVD). The app sat there and then reported:

```
failed to connect to /10.0.2.2 (port 8791) from /10.0.2.16 (port 33698) after 15000ms
```

with the coordinator up and answering `curl` on the host the whole time, on
both `127.0.0.1` and the LAN address. If you hit that, do not spend an hour on
it — forward the port instead and use `127.0.0.1` from inside the emulator:

```sh
adb reverse tcp:8791 tcp:8791
```

That worked immediately and survives app restarts, though not an emulator
restart — re-run it after rebooting the AVD.

**The iOS simulator shares the host's network**, so `127.0.0.1` means the Mac.
That part is easier than Android.

**iOS does NOT block plain HTTP to a local address, at least in the simulator.**
This document previously said it did. Measured on an iOS 26.4 simulator with an
app built from this `project.yml` — no `NSAppTransportSecurity` key in the built
`Info.plist` at all — an HTTP request reached a logging server on every one of:

| target | result |
|---|---|
| `http://127.0.0.1:8799` | request arrived |
| `http://192.168.x.x:8799` | request arrived |
| `http://Elis-MacBook-Pro.local:8799` | request arrived |

ATS's default only blocks cleartext to *public* hostnames; loopback, private
ranges and `.local` are exempt. So a local Node coordinator over plain HTTP is a
perfectly good iOS target, and you do not need an ATS exception for one.

Two caveats before relying on this. **ATS is laxer on the simulator than on a
device**, so re-check on hardware before concluding anything about a real
phone. And a *public* hostname over `http://` is still blocked, which is the
case the original warning was really about — if you put a coordinator behind a
public DNS name, it needs HTTPS.

Android allows cleartext deliberately (`usesCleartextTraffic="true"` in the
manifest) because a LAN box over plain HTTP is the normal case there.

**Xcode 27 ships no `Simulator.app`** — it has been replaced by `DeviceHub.app`,
and `simctl` has no touch injection. There is no `adb shell input tap`
equivalent, so anything that needs a tap (answering the notification permission
alert, driving Siri through Shortcuts) cannot be automated the way the Android
side can. `simctl` still covers install, launch, `openurl`, `push`, screenshots
and `spawn defaults write`, which is enough for everything except tapping.

If you seed settings with `xcrun simctl spawn <sim> defaults write`, be aware
that a key already read by a *running* install may not propagate — a stale
`apiToken` survived several terminate/launch cycles here and sent the old
credential, which presents as "The coordinator rejected the token" against a
coordinator whose token is correct. `uninstall` and `install` before seeding,
and confirm what actually went out rather than what `defaults read` reports.

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
- **`start` needs an idempotency key of at least 8 characters** from
  `[A-Za-z0-9._:-]`. A shorter one is refused with *"refusing to send a
  malformed intent"* — and, less helpfully, reported as `error.code:
  "host_timeout"`, because `buildIntent` throws inside `send()` and every
  rejection out of `dispatch` is labelled a timeout. Both apps send
  `app-<UUID>`, which is fine; hand-rolled `curl` calls are what trip on it.
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
