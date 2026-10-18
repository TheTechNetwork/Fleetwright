# Apple Watch and iPhone Duo

Two questions that arrived together and are not the same size. **iPhone Duo is
a layout question about an app that already ships, and it has a date:** the
device is out on 23 October 2026, running iOS 27.1. **Apple Watch is a new
surface, and most of what it would be for is already on the wrist** without a
line of watch code, so the first job there is to find out how much.

Nothing below is built. This is the survey, what it found in the code, and the
order it argues for. Like the rest of `apps/ios`, it is written without a Mac:
every "verify on a device" below is meant literally.

## iPhone Duo

### What the device does to an app

Apple's own pages confirm the hardware: a 7.6-inch inner display and a 5.4-inch
outer one. The developer detail so far comes from secondary write-ups rather
than Apple's documentation, so treat these as claims to check against the iOS
27 SDK before building on them:

- **The inner display reports regular width and regular height**, like an iPad,
  at about 626 × 890 points. The outer display is a phone, about 466 × 678.
- **Closed and in landscape it reports compact and compact**, which no iPhone
  has done before.
- **The inner display ignores the app's supported orientations.**
- **An app built with an SDK older than iOS 27 is letterboxed** on the inner
  display. The iOS 27 SDK gets it beside the status bar; the 27.1 SDK gets it
  edge to edge.
- **App Store Connect treats folded and unfolded as two screenshot classes.**

### Where Fleetwright stands

Better than it might have, because the code never asked the question the Duo
breaks:

- **Nothing reads orientation or the screen.** No `UIScreen.main`, no
  `UIDevice.orientation`, no branch on `userInterfaceIdiom`. The one
  `GeometryReader` is the traffic chart in `VMMachineView.swift`, which sizes to
  its own frame. Unfolding is a scene resize, `@State` survives it, and there is
  nothing to re-plumb.
- **The app is already iPhone and iPad.** `project.yml` sets no device family,
  so XcodeGen's iOS preset applies, and the `UISupportedInterfaceOrientations~ipad`
  key is there because App Store Connect demanded iPad multitasking support.
  Check the generated project says `1,2` before relying on it.
- **It is built with whatever SDK `macos-latest` carries.** `ios.yml` does not
  pin Xcode. If that image is still on the iOS 26 SDK when the Duo ships, our
  build is the letterboxed one. **This is the first thing to fix, and it is not
  the deployment target**: `project.yml`'s rule keeps the target at iOS 26 until
  28 is announced, and that rule still holds. Building with a newer SDK and
  running on an older OS are separate settings.

### What it looks like unfolded today

`FleetApp` (in `FleetView.swift`) is a three-tab `TabView` with a `NavigationStack` in each tab. On a
regular-width screen that is a phone layout stretched to 626 points: every row
spans the width (`.frame(maxWidth: .infinity)` in several places), and opening a
session or a machine replaces the list instead of sitting beside it.

That is usable. It is not what somebody unfolding a phone to read a fleet
expects, and the design system's own line, calm recedes and trouble comes
forward, is easier to keep when the list of sessions stays on screen while one
of them is open.

### What to change, in order

1. **Pin the SDK in CI.** Name the Xcode version in `ios.yml` that carries the
   iOS 27.1 SDK rather than taking the image's default, so the build that ships
   is not letterboxed and the next image change is a commit rather than a
   surprise.
2. **Sessions and Machines as list and detail when the width is regular.** A
   `NavigationSplitView` keyed on `horizontalSizeClass`: the list on the left,
   `SessionView` or `HostView` on the right. Compact width keeps today's stack
   exactly, so the outer display and every other iPhone do not change. One
   design with two arrangements, not two designs, which is the same reasoning
   `project.yml` gives for refusing `if #available` forks.
3. **`.tabViewStyle(.sidebarAdaptable)`** on the root, so regular width gets the
   sidebar iPadOS already offers and compact keeps the tab bar.
4. **Check every sheet at compact by compact.** The start sheet and the
   hypervisor flows are the long ones; closed and in landscape is the new
   shortest screen.
5. **Screenshots for both classes.** `Screenshots.swift` already drives the
   store shots; it needs a folded and an unfolded run.

### Android has the same question

`docs/app-parity.md` holds the two phones to the same behaviour. Android
foldables report a window size class the same way, and Compose has its own
list-and-detail scaffold. If step 2 ships on iOS only, the parity tests will
not catch it, because they compare rules, not layouts. Decide whether Android
foldables are in this piece of work or explicitly next, and write that down.

## Apple Watch

### What is on the wrist already, for free

- **Notifications are mirrored.** The watch shows what the phone would have
  shown when the phone is locked, and it mirrors actions, so the two answer
  buttons `NotificationAnswers.swift` registers on an `awaiting-input`
  notification should appear on the wrist and run on the phone.
  **Verify this first:** those actions carry `.authenticationRequired`, and how
  the watch handles that option on a mirrored action decides whether the most
  useful thing a watch could do works today or needs the phone in hand.
- **The Live Activity reaches the Smart Stack.** On watchOS 11 and later, the
  hypervisor setup's Live Activity appears on the watch without a watch app,
  drawn from the extension's compact views. Declaring the small supplemental
  family lets `FleetwrightActivity` draw a proper wrist-sized version instead.
- **When the iOS Notification Service Extension is built** (`docs/push-encryption.md`
  lists it as not built), it runs on the phone and the watch mirrors what it
  produced. Encrypted pushes therefore need no watch-side crypto, as long as the
  watch is not registering for pushes of its own.

### What a watch app would add

The question a wrist answers well is **"is anything waiting for me, and can I
say yes to it"**. A complication with the number of sessions waiting, a list of
just those, and the same two answers the notification carries. Nothing that ends
work: reboot needs Face ID and the hostname on screen for a reason, and stop and
forget are not decisions to make from a glance.

### Where it costs real work

- **The credential does not reach the watch, by design.** `Keychain` stores it
  `AfterFirstUnlockThisDeviceOnly`, and a watch is another device. Two ways to
  give a watch access:
  1. Hand it over with WatchConnectivity. Quick, and it puts the credential on a
     second device that cannot be revoked separately from the phone.
  2. **Sign the watch in as a device of its own**, through the same pairing a
     phone uses, so it has its own credential, shows up in the device list, and
     can be revoked alone. More work, and the only one consistent with
     `docs/push-encryption.md`'s "the key belongs to the install, not the phone".
  This document recommends the second.
- **Push needs a decision before anybody registers a token.** If the watch app
  registers its own APNs token, the person gets every notification twice, once
  mirrored and once direct. The simplest answer is that the watch app does not
  register at all and lets mirroring carry notifications, fetching only when it
  is opened or when the complication refreshes. If it ever does register, the
  coordinator's `registerDevice` accepts only `ios`, `android` and `web`, and
  `core.js` filters progress pushes on `platform !== 'ios'`; a watch registered
  as `ios` would be lumped in with phones in ways those lines did not consider.
- **A third target in `project.yml`**, `platform: watchOS`, deployment target
  watchOS 26 to match the phone's reasoning, embedded in the app the way
  `FleetwrightActivity` is so CI's one build type-checks it. `Design.swift`
  joins its sources as it already does for the extension, which keeps
  `test/design-parity.test.js` covering the wrist without a fourth token file.
- **Android has Wear OS**, and the same parity question as the Duo section.

### What to build, in order

1. **Verify mirroring on a device**: an `awaiting-input` notification, both
   buttons, phone locked and in a pocket. If the answers work, the watch's best
   feature already exists and the rest is extra.
2. **The small family on the Live Activity.** A few lines in
   `FleetwrightActivity`, no new target.
3. **A watch app with its own sign-in**: the waiting list and the answers,
   no push registration, plus a complication with the count.

## Decisions this needs

- **Watch scope:** stop after mirroring and the Smart Stack, or build the app?
  The app is where the credential and push questions above become real work.
- **Duo layout:** list and detail side by side in regular width (recommended),
  or the current single column with a readable width cap.
- **Android:** foldables and Wear OS in this work, or explicitly after it.

## Sources

Apple's pages are primary for the hardware. The developer behaviour (size
classes, letterboxing by SDK, screenshot classes) is from the secondary
write-ups and is listed so it can be checked, not because it has been.

- [Apple unveils iPhone Duo](https://www.apple.com/newsroom/2026/09/apple-unveils-iphone-duo/), Apple Newsroom
- [iPhone Duo technical specifications](https://www.apple.com/iphone-duo/specs/), Apple
- [iPhone Duo for iOS developers: what actually changes in your Swift code](https://dev.to/arshtechpro/iphone-duo-for-ios-developers-what-actually-changes-in-your-swift-code-5gc5), DEV Community
- [iPhone Duo apps: what changes in your code](https://pasqualepillitteri.it/en/news/15360/iphone-duo-prepare-apps-developers), Pasquale Pillitteri
- [iPhone Duo ships October 23: what iOS developers must change now](https://byteiota.com/iphone-duo-app-development-ios-27/), ByteIota
- [iPhone Duo is here, and it's not one screenshot size, it's two](https://dev.to/_a262dc67fe8e7bf5c7a897/iphone-duo-is-here-and-its-not-one-screenshot-size-its-two-50fl), DEV Community
