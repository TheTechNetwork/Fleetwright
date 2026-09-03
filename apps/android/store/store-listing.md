# Fleetwright — Play Store listing copy

Paste into Play Console → Grow → Store presence → Main store listing.

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
• Register for push notifications when a session stops and waits on you. (In beta: the delivery path is built and unit-tested, and has not yet been confirmed on a physical device — see the release notes.)

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

## Notes for the review team (What's new / internal review notes)

Play reviewers cannot exercise a self-hosted client without credentials. Put
something like this in **App content → App access** (choose *All or some
functionality is restricted*), otherwise expect a rejection for
"app not functional":

```
Fleetwright is a client for a self-hosted agent fleet coordinator. It has no
built-in backend and no sign-up of its own: it signs you in with Google, and
your coordinator decides which addresses it allows. A reviewer's address will
not be on anybody's list, so use the demo credential instead.

  1. Open Settings.
  2. Coordinator URL: https://fleet.thetech.network
  3. Tap "Use a credential instead" and paste:
       demo-3a2ec7773eabcd4e38a9a880296a4e4b
  4. Tap "Use it".

The demo coordinator returns a small set of sample sessions and accepts
start / stop / resume / peek. It reaches no real machine — there are no hosts
behind it — and it will remain available for the duration of the review.
```

The demo credential is deliberately public and rate limited; it is a `[vars]`
entry in `worker/wrangler.toml` rather than a secret. See
`docs/coordinator-deploy.md` for why that is safe: the requests it authorises
are answered from constants, and the Durable Object holding the real fleet is
never reached.

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
