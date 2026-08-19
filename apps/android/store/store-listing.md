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
• Get a push notification the moment a session stops and waits on you — the point of carrying this in a pocket at all.

YOU BRING THE SERVER

Fleetwright is a client, not a service. It talks to an agent fleet coordinator that you run yourself. On first launch it asks for two things: the coordinator's URL and its API token. Until you enter those, there is nothing to show — this app does not ship with a backend and there is no account to create.

Nothing is baked into the binary. A credential inside an APK is public the moment somebody unzips it, so the token is entered once, stored on the device, and masked on screen.

DESIGNED TO BE READ, NOT DECODED

Every session state is shown as a word, never as a colour alone — colour only reinforces it. That matters outdoors, and it matters for the roughly one in twelve men with a colour vision deficiency.

The interface follows the system theme and picks up your wallpaper palette on devices that support dynamic colour.

DELIBERATELY SMALL

No account. No analytics. No advertising. No third-party trackers. The only network traffic is between this app and the coordinator address you typed in, and the only data it holds is that address, your token, and whatever your coordinator returns.

Requires Android 16 or later.
```

---

## Notes for the review team (What's new / internal review notes)

Play reviewers cannot exercise a self-hosted client without credentials. Put
something like this in **App content → App access** (choose *All or some
functionality is restricted*), otherwise expect a rejection for
"app not functional":

```
Fleetwright is a client for a self-hosted agent fleet coordinator. It has no
built-in backend and no sign-up. To exercise the app, open Settings on first
launch and enter:

  Coordinator URL: https://<demo-coordinator-host>
  API token:       <demo-token>

The demo coordinator returns a small set of sample sessions and accepts
start / stop / resume / peek. It will remain available for the duration of
the review.
```

Stand up a throwaway coordinator with a read-mostly token before you submit.

---

## Category and tags

- **App category:** Tools (Developer tools is not a Play category; Tools is where clients like this land)
- **Tags:** suggest *Utilities*, *Developer tools*, *Remote control*
- **Contains ads:** No
- **In-app purchases:** No
