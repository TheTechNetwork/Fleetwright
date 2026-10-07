# The relays: what is shared, what is not, and what is written down

Two services, for coordinators that are not ours: a **push relay** and an
**OAuth callback relay**. This document was written before they were built, on
purpose: it is the specification the implementation had to satisfy, and the
order mattered because the promises below are the kind that are easy to make
and easy to break by adding a log line. **They are built now**
(`src/fleet/relay/relay.js`, a Worker of its own in
`worker/wrangler.relay.toml`), and [How they were built](#how-they-were-built)
at the end says where each promise below is kept and what is not proven yet.

Tracked as [#348](https://github.com/TheTechNetwork/Fleetwright/issues/348).

## Why they exist at all

Exactly one thing about this product cannot be self-hosted. A push notification
is addressed to a **specific app**: `src/fleet/push.js` sends to
`apns-topic: network.thetech.fleetwright` with an APNs key from our Apple team,
and to FCM with a service account for our Firebase project. A coordinator
somebody else deploys has neither, so it cannot wake these apps on a phone. The
alternative is building their own apps — bundle id, Firebase project, Apple
team, store listings, an annual fee and a review queue — to change one
hostname.

Sign-in, by contrast, needs nothing from us; see
[`coordinator-deploy.md`](./coordinator-deploy.md). The OAuth callback is a
convenience rather than a wall — anybody can register their own GitHub App.

**There is no shared coordinator and there is not going to be one.**
[`trust.md`](./trust.md) has coordinator → host as *trusted absolutely*: a
coordinator can start a dangerous-mode session on any host in its fleet and read
the credential file out of it. That is a reasonable thing to hold over your own
machines and not something to hold over a stranger's.

---

## The push relay

### Contentless notifications were considered and rejected

The first design had the relay carry a **wake** and no content — a device token
and nothing else, with the app fetching the detail from its own coordinator.
That kept the relay ignorant by construction, and it was wrong:

> "Contentless and non-actionable notifications are useless."

Which is right, and the product's own reasoning already said so.
[`psychology.md`](./psychology.md) is built on deciding from a lock screen
without opening anything; a notification reading "something happened" moves the
decision into the app and costs the person the interruption twice. The
`answer` verb exists so a waiting prompt can be answered **from the
notification**, with the options the host published. A wake cannot carry
options, so a wake cannot be answered.

So the relay forwards the real payload. That makes what it is **told** a
question about retention rather than about visibility, and the answer is below.

### What is shared with the relay

Per notification, in the request and nowhere else:

| | What | Why it has to be there |
|---|---|---|
| Device token | The APNs or FCM token for one device | It is the address. There is no push without it |
| Fleet id | An opaque identifier the relay issued at registration | Rate limiting, and nothing else |
| Payload | Title, body, and the actionable part — the prompt's options and its `promptId` | This is the notification. Without it there is nothing to deliver |

The payload contains whatever the sending coordinator puts in it, which in
practice is a session name, a short line of text, and a list of options. **It
is not scrubbed by the relay**, because a relay that edited a notification
would be a relay that could change what somebody is agreeing to.

### What is not shared

- **No email address, and no account of any kind.** There is nothing to sign in
  to. A fleet registers and gets an identifier; that identifier is not linked
  to a person here.
- **No host names, session lists, workspace contents or credentials.** None of
  those are in a push request and the relay has no way to ask for them.
- **No coordinator address.** The relay is posted *to*; it never calls back.

### What is written down

**Nothing about any notification. Ever.**

Concretely, and these are implementation constraints rather than aspirations:

- **No request body logging**, at any level, including debug. Not behind a
  flag, because a flag is a thing somebody turns on during an incident and
  forgets.
- **No payload in error reports.** The existing Sentry scrubbing
  (`worker/src/sentry.js`) is an allowlist and the relay's must be too: a
  failure reports a status code and a fleet id, never a body.
- **No delivery history, no receipts, no analytics, no metrics keyed by device
  token.**
- **The device token is used and dropped.** It is not stored, so there is no
  table of which devices exist.

The one thing kept: **a counter per fleet id per time window**, for rate
limiting. It holds an identifier and a number. It is not a log of when
somebody was notified, because it is a bucket that resets and is never
appended to.

APNs and FCM see the notification, and that is unavoidable — it is true of
every push on both platforms, including the ones this project already sends
from its own coordinator. Nothing here can change that, and pretending
otherwise would be worse than saying it.

### This is being replaced by something structural, and it is half built

Everything above is a promise kept by not writing a log line. The stronger
version encrypts the payload on the coordinator to a key held by one phone, so
the relay forwards bytes it cannot read — and neither can Apple or Google, which
is a bigger change than the relay was ever about.

**The coordinator half is done.** ECDH P-256 → HKDF-SHA256 → AES-256-GCM,
exercised end to end in this repository against the same bytes a phone will
receive. See [`push-encryption.md`](./push-encryption.md).

**Neither app implements the other half yet** — an iOS Notification Service
Extension and an Android data-message handler, plus key generation and storage
in the Keychain and the Keystore. Until they do, no phone registers a key and
every notification takes the plaintext fallback.

So this document still describes what is true today, and the sections above are
not softened on the strength of work that is only half finished. When both apps
land, the promise stops being a promise.

---

## The OAuth callback relay

One `redirect_uri` registered on our GitHub App. `state` names the coordinator
the flow belongs to; the result goes there.

### What is shared

The `state` and the `code` GitHub puts in the callback URL, plus the identifier
of the coordinator to forward to. Nothing else — the person's browser arrives,
is redirected, and leaves.

### What is not shared

The relay never learns the GitHub account, the repositories, or what the token
is for. It does not see the coordinator's fleet, hosts or sessions.

### The token, which is the whole problem

Exchanging a `code` for a token requires the App's **client secret**, which is
ours. Three ways, and only one of them keeps the promise:

1. **Relay exchanges, forwards the token in the clear.** Easy. It makes us the
   custodian of strangers' GitHub tokens, which is the thing the no-shared-
   coordinator decision was against.
2. **Relay forwards the code, the coordinator exchanges it.** Requires giving
   self-hosters the client secret, at which point it is not a secret.
3. **Relay exchanges, forwards the token encrypted to a public key the
   coordinator registered.** We handle ciphertext we cannot read.

**Build (3) or do not build this.** (1) is what gets written by accident when
(3) looks like a lot of work, so it is named here rather than left to be
discovered in review.

### What is written down

Nothing about any authorization. No codes, no tokens, no ciphertext, no
`state` values. The relay holds **no pending record at all**, which is
stronger than deleting one before the forward: the `state` carries the fleet
it belongs to, so there is nothing to look up but the fleet. A replayed
callback is refused twice over, by GitHub, which takes a code once, and by the
coordinator, which redeems its state once, the way
[`oauth.js`](../src/fleet/coordinator/oauth.js) always has.

Same as above: a counter per fleet id, for rate limits.

---

## Rate limits, which are the only reason any state exists

Both relays hold our credentials, and a buggy loop upstream is
indistinguishable from abuse — both end with our APNs key throttled and
everybody's notifications stopping. So there is a cap per fleet, and exceeding
it fails that fleet's requests and nobody else's.

A fleet that is being rate limited is **told**, in the response, with the limit
and when it resets. A silent drop would look like a delivery failure, and a
coordinator cannot fix what it is not told about.

## What this is not, and cannot become without saying so

- Not a coordinator. It holds no sessions, no hosts, no credentials of yours.
- Not a place your work is stored. The line on the public page — *"there is no
  server of ours in the middle holding your work"* — stays true precisely
  because of the retention rules above, which is why they are the load-bearing
  part of this document rather than the polite part.
- Not free of Apple and Google. They deliver the notification and they see it,
  here and everywhere else.

If any of that changes, it changes **here first**, with the date, in the same
way [`app-parity.md`](./app-parity.md) requires a claim about the apps to
change in that table before it is said anywhere else. A promise about data that
is revised quietly is not a promise.

---

## How they were built

Written 7 October 2026, against everything above. Where a promise is kept, and
how a coordinator uses them.

### Where each promise is kept

- **A Worker of its own** (`worker/wrangler.relay.toml`), like the minter:
  our APNs key, our Firebase service account and the App's client secret, and
  one route, `<the fleet's hostname>/relay/*`. Deployed only when the
  repository variable `FLEETWRIGHT_RELAY` is `1`, so a fork does not start
  delivering to our apps with credentials it copied.
- **What it keeps** is one Durable Object's rows: per fleet, a hash of its
  secret and, if it uses the OAuth relay, its callback and public key; per
  window, a counter that is overwritten when the window turns. No person, no
  email, nothing linked to anybody. `test/relay.test.js` reads the store after
  a push and after a sign-in and finds nothing else.
- **No log line carries a request.** The senders log a provider's answer, and
  an answer can quote what it was sent, so the relay gives them a logger that
  keeps the HTTP status and drops every other word. An error says the method
  and path and nothing about the body.
- **Observability is off** in its config. Workers observability records each
  request's URL, and the OAuth callback's URL carries the code and the state:
  that would be every authorization, written down by somebody else. The minter
  has it on; this does not, and a test holds the file to it.
- **Notifications are sealed by the coordinator that sends them.** It makes
  each phone's envelope before anything leaves (`relayPusher` in
  `src/fleet/push.js`), and the senders deliver an envelope that arrives made
  exactly as it is. A phone that registered a key gets ciphertext the relay
  cannot read; one that did not gets what Apple or Google would be sent anyway.
- **A GitHub token leaves sealed**, to the key the fleet registered, with the
  scheme a notification is sealed with. The **state is sealed in with it**,
  and the coordinator takes the token only for the state it came back with:
  the fleet's key is public, so anybody can seal something to it, but nobody
  can seal it for a sign-in they never saw.
- **A fleet over a cap is told** the cap and when it resets, with a
  `Retry-After`, and the coordinator says both in its log. The caps are per
  fleet: 600 notifications and 1,200 Live Activity updates an hour, 60
  sign-ins. Registering is open, since there is nothing to sign in to, so its
  cap of 100 an hour is across everybody.

### Using them

Register once, from anywhere with Node:

```sh
node scripts/relay-register.mjs --relay https://fleet.thetech.network --callback https://your.coordinator
```

It makes a P-256 key on that machine, registers the public half and your
callback, and prints `FLEETWRIGHT_RELAY_URL`, `_FLEET`, `_SECRET` and
`_KEY`. The last two are secrets. Set them on your coordinator with
`FLEETWRIGHT_PUSH=1`, and `FLEETWRIGHT_GITHUB_CLIENT_ID` to the App's public
client id **with no client secret**. Without `--callback` the fleet uses the
push relay only and no key is made. A coordinator with credentials of its own
always sends with them, so ours never goes through the relay it runs.

### What is not done, and what is not proven

- **A token through the OAuth relay is not renewable.** Renewing a GitHub App
  token needs the client secret, which the coordinator does not have and its
  hosts are not given, and renewing through the relay would show it the refresh
  token, which this document does not allow. So a connection lasts what GitHub
  gives it, eight hours for a user token, and the person connects again. A
  renewal that keeps the promise needs the refresh token sealed both ways and
  is not built.
- **No PKCE on the relayed sign-in.** The exchange is the relay's and a PKCE
  verifier is the host's, and they never meet.
- **Neither has run against the real services.** Both are exercised end to
  end in this repository, the sign-in through the relay's own code and back
  into a coordinator, and nothing here has delivered through Apple or Google
  or exchanged a real GitHub code via the relay. The relay's callback also has
  to be added to the App's list of callback URLs before the first sign-in.

