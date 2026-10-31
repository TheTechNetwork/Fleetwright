# Apple Watch and iPhone Duo

Two questions that arrived together and are not the same size. **iPhone Duo is
a layout question about an app that already ships, and it has a date:** the
device is out on 23 October 2026, running iOS 27.1. **Apple Watch is a new
surface, and most of what it would be for is already on the wrist** without a
line of watch code, so the first job there is to find out how much.

The Duo's first round is built (below); the watch is still a survey, what it
found in the code, and the order it argues for. Like the rest of `apps/ios`, it is written without a Mac:
every "verify on a device" below is meant literally.

## iPhone Duo

### What the device does to an app

The first version of this section was written before the device shipped, from
secondary write-ups, and two of its claims were wrong in ways that changed the
work. This version is from Apple's tech talk "Prepare your app for iPhone Duo",
the Apple Developer Forums summary thread, and the App Store Connect screenshot
specification. Still not checked on hardware: every "verify on a device" below
is meant literally.

- **The inner display is regular by regular in every pose**, like an iPad. It is
  669 by 951 points (the screenshot specification's 2007 by 2853 pixels at 3x);
  the 626 by 890 the survey quoted was wrong, and nothing here should depend on
  either number.
- **The outer display is a phone**, 466 by 678 points: compact by regular in
  portrait, and **compact by compact in landscape**, which no iPhone did before.
- **The inner display ignores supported orientations.** Layout is decided by
  size class, never by orientation or `userInterfaceIdiom`.
- **The SDK decides the shape, not the deployment target.** Built with the iOS 26
  SDK the app runs at a familiar iPhone aspect ratio, centred; with 27.0 it
  reaches beside the status bar; with **27.1 (Xcode 27.1, 27A9275)** it goes edge
  to edge and gets the vertical bars.
- **Bars go vertical.** In landscape the tab bar and toolbars move to a side
  edge. A tab needs both an icon and a title to be drawn there; a custom bottom
  bar does not move at all.
- **`NavigationSplitView` is fully adaptive.** It collapses to one stack when
  closed, tiles when open, and keeps its columns clear of the fold. The survey's
  "keyed on `horizontalSizeClass`" was unnecessary.
- **Custom UI over the camera loses touches** unless it asks for the reserved
  regions (`GeometryProxy.reservedRegions(kind:)`, iOS 27.1).
- **It is the first iPhone with multiple windows** of one app, on the inner
  display only, following iPadOS's scene model.
- **Folding is a trait change, not a scene disconnect.** The process, `@State`,
  text being typed and scroll position all survive it.
- **New in iOS 27.1, all `@available(iOS 27.1, *)`:** `ArrangementView`,
  reserved regions, `onHingeChange`, `toolbarVerticalBehavior` and
  `toolbarVerticalEdge`. Apple's guidance is that standard containers come first
  and these are for custom layouts.
- **Apple Pencil (USB-C) works on both displays** from iOS 27.2.
- **App Store Connect has four Duo screenshot sizes**, folded and unfolded in
  each orientation. They are optional until April 2027, and uploads were not yet
  accepted when the device shipped.

### What is built

1. **The SDK, pinned, on the image that has it.** `macos-latest` carried Xcode 26
   alone, so every build before this round was the letterboxed one. The macOS
   jobs run on GitHub's `xcode-27` image, and `scripts/select-xcode.sh` picks an
   exact build or fails: **TestFlight ships on Xcode 27.2** (27B48, the
   release that brought Pencil to the Duo) and the store submits that upload.
   **The next Xcode is built beside it from its first beta** on GitHub's
   image, so a change in it is seen before it is what ships; the script prints
   a notice on every run while the image carries one the build matrix does
   not, and adding it is a line in `ios.yml` and a build in the script. 27.1
   (27A9275), the oldest SDK that draws the Duo edge to edge, was built beside
   27.2 until 27.2 shipped. Unit tests run on the image's iPhone Duo
   simulator, and `scripts/ios-duo-look.sh` attaches a picture of each tab on it
   to every run. The deployment target stays iOS 26 for the reason
   `project.yml` gives.
2. **Sessions and Machines are list beside page.** `ListBesideDetail` wraps each
   in a `NavigationSplitView`: unfolded, the list stays on screen beside the
   session or machine it opened; closed, it is the stack it always was. The rows'
   own links and `navigationDestination`s were left alone, because in the
   sidebar column they open in the detail column. The sidebar is 300 points so
   the page keeps a small iPhone's width in unfolded portrait; the balanced style
   keeps the list from being slid away.
3. **The tabs are a sidebar where there is room.** The root `TabView` is
   `.sidebarAdaptable` with `.defaultAdaptableTabBarPlacement(.sidebar)`, both
   iOS 18, so no availability fork: unfolded, Sessions, Machines and You run down
   the leading edge, collapsible; closed and on every other iPhone it is the tab
   bar it was, which the outer display stands on its side.
4. **Every bar item can stand in the vertical bar.** The closed display puts
   every system bar at its side, in portrait as well as landscape, and only an
   item with a symbol can go there. New session, the sheets' Close, Cancel,
   Done, Save, Copy and Start, the files page's New file and the console's
   Keyboard each have a symbol and a title now; the bin's count is a badge
   instead of "Bin (3)", which would have lost the number on its side.
   Ctrl-Alt-Del stays words, because the words are the information. Android
   still writes "Bin (3)": a presentation difference, not a rule one.

### What was checked and needed nothing

- **Nothing reads orientation or the screen.** No `UIScreen.main`, no
  `UIDevice.orientation`, no branch on `userInterfaceIdiom`; the one
  `GeometryReader` sizes the traffic chart to its own frame.
- **The tabs have an icon and a title each**, so the tab bar can go vertical.
- **The console's Keyboard and Ctrl-Alt-Del are toolbar items**, not a custom
  bar, so they move with the other bars.
- **The Live Activity implements every presentation** (compact leading and
  trailing, minimal, expanded, Lock Screen), which the closed display's side
  Dynamic Island needs.

### Decided against, for now

- **The iOS 27.1 APIs.** Every one needs an `if #available` beside the iOS 26
  path, which is the two-designs cost `project.yml` refuses, and the standard
  containers already avoid the fold. Revisit when the deployment target moves.

### Still to do

1. **Look at it in every pose.** CI builds on 27.2, and on the next beta once
   the image has it, and runs the unit tests on the iPhone Duo simulator, and each run attaches the three tabs on
   both displays; `simctl` cannot fold or rotate, so the other poses and a
   device are still a person's job. Fold, unfold, rotate, and open a session
   from a notification in each pose. **Look first at unfolded portrait**: the tab
   sidebar, the 300-point list and the page are three columns on 669 points, and
   the tab sidebar is meant to be the one that collapses. If it does not, the
   list's width or the split's style is what changes.
2. **Sheets at compact by compact.** The start sheet and the hypervisor flows are
   the long ones, and closed in landscape is the new shortest screen.
3. **Two windows.** `UIApplicationSupportsMultipleScenes` would let two sessions
   sit side by side on the inner display. It needs every notification and
   handoff path checked against more than one scene first.
4. **Screenshots for the Duo classes**, in `ios-screenshots.sh`, once App Store
   Connect accepts them and `simctl` can set the fold.

### Android foldables are out of scope, and why

`docs/app-parity.md` holds the two phones to the same behaviour, so this is a
decision rather than an omission: **there is no Android foldable to test on,**
and layout written for a screen nobody can open is the REVIEWED BUT UNRUN
problem without the excuse of a deadline. Android foldables report a window size
class the same way and Compose has its own list-and-detail scaffold, so the work
is there to pick up when a device is.

Until then the iOS list-and-detail layout is a known difference between the
phones. The parity tests will not flag it, because they compare rules, not
layouts, and the rules (what a row says, which buttons exist) stay shared.

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
- **The iOS Notification Service Extension runs on the phone**
  (`docs/push-encryption.md`), and the watch mirrors what it produced.
  Encrypted pushes therefore need no watch-side crypto, as long as the watch
  is not registering for pushes of its own. A seal the extension cannot open
  is the fallback sentence, and that is what the watch would mirror.

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
- **Wear OS is out of scope** for the reason Android foldables are: nothing to
  test it on.

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

## Sources

Apple's tech talk and the forums thread are primary for the developer
behaviour. The secondary write-ups are kept because the first version of this
document leaned on them, and two of their claims did not survive.

- [Prepare your app for iPhone Duo](https://developer.apple.com/videos/play/tech-talks/111461/), Apple Developer tech talk
- [A summary of the iPhone Duo group lab](https://developer.apple.com/forums/thread/847644), Apple Developer Forums
- [iPhone Duo by Examples](https://github.com/artemnovichkov/iPhone-Duo-by-Examples), runnable SwiftUI for the iOS 27.1 APIs
- [iPhone Duo for developers: the 1.42 problem and the SDK gap](https://blakecrosley.com/blog/iphone-duo-for-developers)
- [Apple Pencil support arrives on iPhone Duo with iOS 27.2](https://appleinsider.com/articles/26/10/21/apple-pencil-support-arrives-on-iphone-duo-with-ios-272), AppleInsider

- [Apple unveils iPhone Duo](https://www.apple.com/newsroom/2026/09/apple-unveils-iphone-duo/), Apple Newsroom
- [iPhone Duo technical specifications](https://www.apple.com/iphone-duo/specs/), Apple
- [iPhone Duo for iOS developers: what actually changes in your Swift code](https://dev.to/arshtechpro/iphone-duo-for-ios-developers-what-actually-changes-in-your-swift-code-5gc5), DEV Community
- [iPhone Duo apps: what changes in your code](https://pasqualepillitteri.it/en/news/15360/iphone-duo-prepare-apps-developers), Pasquale Pillitteri
- [iPhone Duo ships October 23: what iOS developers must change now](https://byteiota.com/iphone-duo-app-development-ios-27/), ByteIota
- [iPhone Duo is here, and it's not one screenshot size, it's two](https://dev.to/_a262dc67fe8e7bf5c7a897/iphone-duo-is-here-and-its-not-one-screenshot-size-its-two-50fl), DEV Community
