# Fleetwright — store listing copy

One document for both stores. Play's copy is pasted into Play Console → Grow →
Store presence → Main store listing. The App Store's is written by
`tools/appstore-release.mjs` on every submission: the App Store description,
the short description as promotional text, the keywords and the URLs below.

---

## App name (30 char max)

```
Fleetwright
```

---

## Short description (80 char max)

**Primary — 75 characters**

```
Start, stop, resume and peek at your coding agent sessions from your phone.
```

Alternates, if you want to A/B or if the primary reads too generic:

```
Your coding agent fleet, from your phone. Start, stop, resume, peek.
```
(68 characters)

```
One screen for every agent session you have running, on every host.
```
(67 characters)

---

## Full description (4000 char max)

```
Fleetwright is a phone client for a fleet of coding agent sessions.

One screen: what is running, and the handful of things worth doing about it from a phone. Every session across every host in one list, with the ones that have stopped and are waiting on a person marked so you can find them at a glance.

WHAT IT DOES

• See every session — name, status and the host it is on, pulled from your coordinator on open and on demand.
• Start a new session without touching a terminal.
• Stop a session that has gone somewhere you did not want it to go.
• Resume a stopped session with a summary of where it left off.
• Peek at the live pane output for any session, so you can read what it is actually doing before deciding anything.
• Open a running session in Remote Control, and go from reading it to driving it.
• Get a push notification the moment a session stops and waits on you — the point of carrying this in a pocket at all.

YOU BRING THE SERVER

Fleetwright is a client, not a service. It talks to an agent fleet coordinator that you run yourself. On first launch it asks for the coordinator's address and for you to sign in with Google. Until then there is nothing to show — this app does not ship with a backend, and the account you sign in with is your own Google account, not one created here.

Signing in gets THIS DEVICE a credential of its own, issued by your coordinator and revocable on its own. It is kept encrypted with a key that never leaves the phone's keystore. Nothing is baked into the binary: a credential inside an APK is public the moment somebody unzips it, and a credential shared between phones is one that cannot be revoked for just one of them.

DESIGNED TO BE READ, NOT DECODED

Every session state is shown as a word, never as a colour alone — colour only reinforces it. That matters outdoors, and it matters for the roughly one in twelve men with a colour vision deficiency.

The interface follows the system theme and picks up your wallpaper palette on devices that support dynamic colour.

DELIBERATELY SMALL

No analytics. No advertising. No third-party trackers. The only network traffic is between this app and the coordinator address you typed in, and the only data it holds is that address, this device's credential, the address you signed in with, and whatever your coordinator returns.

Requires Android 11 or later.
```

---

## App Store description (4000 char max)

THE APP STORE GETS ITS OWN, because App Review rejected 0.4.15 under guideline
2.3.10 for the Play one: "Revise the app's description to remove Android
references." The Play copy says Google, APK, keystore, dynamic colour and
"Requires Android 11", and none of that is true of the iOS app.

Two things the Play copy can claim and this one cannot: the iOS app reports
crashes and hangs to an error tracker (Sentry, with no identifiers and every
on-screen word masked), and it talks to GitHub or Xen Orchestra when you point
it at them. So it does not say "the only network traffic is the coordinator".
`tools/store-listing.mjs` refuses this block if it names Android or Google Play.

```
Fleetwright is an iPhone and iPad client for a fleet of coding agent sessions.

One screen: what is running, and the handful of things worth doing about it from wherever you are. Every session across every host in one list, with the ones that have stopped and are waiting on a person marked so you can find them at a glance.

WHAT IT DOES

• See every session: name, status and the host it is on, pulled from your coordinator on open and on demand.
• Start a new session without touching a terminal.
• Stop a session that has gone somewhere you did not want it to go.
• Resume a stopped session with a summary of where it left off.
• Peek at the live pane output for any session, so you can read what it is actually doing before deciding anything.
• Open a running session in Remote Control, and go from reading it to driving it.
• Get a notification the moment a session stops and waits on you.
• Ask Siri, or build it into Shortcuts: "start a dev session on my fleet".

YOU BRING THE SERVER

Fleetwright is a client, not a service. It talks to an agent fleet coordinator that you run yourself. On first launch it asks for the coordinator's address, then for you to sign in with Apple. Until then there is nothing to show: the app does not ship with a backend, and your fleet decides which email addresses it lets in. Choose "Share My Email" when you sign in, because a hidden address matches nobody on a fleet's list.

To see it working first, tap "Look around the demo fleet". It is a sample fleet with nothing real behind it, and nothing to type.

Signing in gets this device a credential of its own, issued by your coordinator and revocable on its own. It is kept in the keychain on this device. Nothing is built into the app: a credential shipped inside an app is public to anybody who unpacks it, and one shared between devices cannot be revoked for just one of them.

DESIGNED TO BE READ, NOT DECODED

Every session state is shown as a word, never as a colour alone; colour only reinforces it. That matters outdoors, and it matters for the roughly one in twelve men with a colour vision deficiency.

DELIBERATELY SMALL

No analytics, no advertising and no tracking. If the app crashes or hangs, a report goes to the developer's error tracker, with no identifiers, no IP address and every word on the screen masked. Everything else the app sends goes to the coordinator you typed in, or to a service you connect it to yourself.

Requires iOS 26 or iPadOS 26 or later.
```

---

## Notes for the review team (What's new / internal review notes)

Play reviewers cannot exercise a self-hosted client without credentials. Put
something like this in **App content → App access** (choose *All or some
functionality is restricted*), otherwise expect a rejection for
"app not functional":

```
Fleetwright is a client for a self-hosted agent fleet coordinator. It has no
built-in backend and no sign-up of its own: it signs you in with Google, and
your coordinator decides which addresses it allows. A reviewer's address will
not be on anybody's list, so use the demo fleet instead.

  1. Open the app.
  2. Tap "Look around the demo fleet" — one tap, nothing to type.

The demo fleet (fleetdemo.thetech.network) returns a small set of sample
sessions and accepts start / stop / resume / peek. It reaches no real
machine — there are no hosts behind it — and it will remain available for the
duration of the review.
```

The demo runs on its own Worker with no fleet behind it, and its token is
committed and rate limited *because it authorises nothing* — it is a `[vars]`
entry in `worker/wrangler.demo.toml`, pinned to both apps by
`test/demo-button.test.js`. See `docs/coordinator-deploy.md`: the requests it
answers come from constants, and the Durable Object holding the real fleet is
on a different Worker entirely.

---

## Keywords (100 char max)

App Store only — Play has no keyword field. Comma-separated, no spaces after
the commas (Apple counts them), and nothing already in the name.

```
claude,fleet,sessions,servers,xen orchestra,xcp-ng,remote,devops,agents,ssh
```

## Support URL

Where App Store Connect sends "Support" on the store page. The issue tracker
is where support actually happens.

```
https://github.com/TheTechNetwork/Fleetwright/issues
```

## Privacy policy URL

The same page both stores are given.

```
https://fleet.thetech.network/privacy
```

## Copyright

The App Store shows this line under the description. The year is whatever
the release is cut in; update it when it changes.

```
© 2026 The Tech Network
```

---

## Category and tags

- **App category:** Tools (Developer tools is not a Play category; Tools is where clients like this land)
- **Tags:** suggest *Utilities*, *Developer tools*, *Remote control*
- **Contains ads:** No
- **In-app purchases:** No

---

## Data safety / privacy labels — this changed

Signing in means the app now handles an **email address**, and both stores ask
about that on a form rather than reading the code. Getting it wrong is a
rejection, and getting it wrong in the generous direction ("we collect nothing")
is the kind of wrong that gets an app pulled later.

What is true:

- The address comes from the identity provider, is sent to **your own
  coordinator** and to nowhere else, and is stored on the device so the app can
  show who it is signed in as.
- It is **linked to the user's identity** — that is the entire point of it — and
  used **for app functionality** only. Not for analytics, advertising, or
  personalisation, of which there is none.
- It is **not shared with any third party.** The coordinator is the person's own
  server; it is not a third party to them.
- There is a per-device credential too, which is a secret this app holds. It is
  not personal information and does not belong on the form.

**Play → App content → Data safety**: Personal info → Email address →
*Collected*, not shared, linked to the user, purpose *App functionality*.
Account creation: *No*, the app has no accounts of its own.

**App Store Connect → App Privacy**: Contact Info → Email Address → linked to
the user, used for App Functionality. Tracking: **No**.

**And on the App Store, crash reports.** The iOS app sends crashes and hangs
to Sentry, with no identifiers, no IP address and every word on the screen
masked (`FleetwrightApp.swift`, `startErrorReporting`). The App Store
description says so, and the App Privacy answers have to agree with it:
Diagnostics → Crash Data → **not** linked to the user, used for App
Functionality. Checking the form against this is a step in App Store
Connect, because nothing in this repository can write those answers.
