# Notifications nobody in the middle can read

[`relay-terms.md`](./relay-terms.md) promises that nothing about a notification
is written down. That promise is **contractual** — it is kept by not adding a
log line, which is a thing people do during incidents. This is the structural
version of the same promise, and it applies to what already ships rather than
only to a relay that does not exist yet.

**Every push this project sends today goes through Apple or Google in the
clear**, carrying a session name and — since prompts started carrying the
question — the question itself. That is normal, it is what almost every app
does, and it is worth fixing while the plumbing is being touched anyway.

## The scheme

```
ECDH on P-256  →  HKDF-SHA256  →  AES-256-GCM
```

Every piece is in WebCrypto, and that is the whole reason for the choice.
`src/fleet/push-crypto.js` has to run in the Workers runtime and in Node with
no dependency, and both phones have to implement the other half natively —
CryptoKit on iOS, the Android Keystore on Android. **A scheme neither phone can
do without a library is a scheme that does not ship.**

Per notification:

1. A fresh ephemeral P-256 keypair, **per message**.
2. `shared = ECDH(ephemeral private, device public)`.
3. `salt` = 16 random bytes. `info` = `"fleetwright-push-v1" || devicePublic || ephemeralPublic`.
4. `HKDF-SHA256(shared, salt, info)` → 44 bytes → a 32-byte AES key and a 12-byte nonce.
5. `AES-256-GCM` over the JSON payload.

The envelope is `version(1) || salt(16) || ephemeralPublic(65) || ciphertext`,
base64url. A realistic notification comes to about 270 bytes — both services cap
a payload at 4 KB.

**Both public keys go into `info`.** This is the part that is easy to leave out
and expensive to leave out: without it a ciphertext is not bound to the pair it
was made for, and somebody who can choose one of the keys can make two different
exchanges derive the same secret.

**A fresh ephemeral per message** is what makes two notifications to one phone
unlinkable to anyone holding only the ciphertexts, and what stops one
compromised message revealing the next. Generating it once and reusing it is the
obvious optimisation and throws both properties away for a millisecond.

### Not RFC 8291, and the difference on purpose

The key derivation follows Web Push's shape because that part is reviewed and
its reasoning is public. What is dropped is the `aes128gcm` content coding —
record sizes, padding, a framing header — which exists so a push service can
chunk a body. It buys interop with libraries this project does not use and adds
three ways to be subtly wrong. There is one record here and it is small.

## What it hides, and what it cannot

**Hidden:** the session name, the notification text, the prompt's question and
its options, and the deep-link data. From Apple, from Google, and from any
relay.

**Not hidden, and no arrangement of keys changes it:** that a notification was
sent, when, and to which device address. A push service has to know all three to
deliver anything. The claim is about **content**, and it is worth keeping exact
— an overstated privacy claim is worse than none.

## How it reaches the phone

The two platforms need opposite things, and getting it wrong looks like success.

**iOS** needs `mutable-content: 1` in the `aps` dictionary. That is what runs
the Notification Service Extension, which decrypts and rewrites the title and
body before the system draws anything. Without it iOS renders the fallback alert
and the ciphertext is never opened — **delivery reports success and the person
sees the fallback line forever.**

**Android** needs a **data-only** message: no `notification` block at all. A
`notification` block is rendered by the system before the app is consulted, so
an encrypted body would be displayed as base64. A data message is handed to
`onMessageReceived`, which decrypts and posts the real notification itself.

The cost of that is honest and worth writing down: a data message needs the app
to run, so it is not delivered to a force-stopped app, and Doze can delay it.
`priority: HIGH` is what buys a wake in Doze and is set either way.

## The fallback, which is a sentence

When a device has no key — an app installed before this existed, and there are
some — the notification is sent in plain text exactly as before. **Refusing to
send would be choosing "no notification" over "a notification Apple can read",
which is the wrong trade for somebody waiting on a session.**

When a device *has* a key, the alert still carries a fallback title and body,
because it is what iOS shows if the extension times out, if a phone restored
from a backup no longer holds the key, or on any version skew. So it has to be
a sentence rather than a placeholder:

> **Fleetwright** — Something needs you. Open to see.

"New notification" in that moment is the contentless wake this design
[rejected](./relay-terms.md).

## When it was sent is inside the envelope

AES-GCM proves the bytes are ours; nothing proved they are *current*. A
captured `session.awaiting-input` replayed a day later invites somebody to
answer a question the host stopped asking — the `promptId` refuses the answer,
but the person still read it. So `sentAt` (milliseconds, as a string, because
FCM data values are strings) is sealed with the title, body and data, and rides
in the clear on a plaintext notification too. An app that decrypts can refuse
one older than it likes. The providers' own expiry — an hour, `apns-expiration`
and FCM `ttl` — stops a late one being delivered at all, and the collapse id is
the session name, so a newer word about a session replaces the older one rather
than stacking under it.

## The category is sealed too, and the sealed one decides

The category names which two buttons a notification gets, and it has to be in
the clear: iOS picks the buttons from `aps.category` before the extension has
opened anything, and a phone from before encryption reads nothing else. A clear
field is one Apple, Google or a relay could change, and the words on the
buttons come from the category while the digits they type are sealed — so a
swapped category is a button labelled for one answer typing another.

So `envelopeFor` seals a second copy, empty when there is nothing to answer. A
phone that opens the envelope takes the sealed one, and when a clear one is
there and disagrees, it draws no buttons at all; the notification still opens
the app. A sealed copy that is absent means a coordinator from before this,
and then the clear one is all there is, as it always was.

## The key belongs to the install, not the phone

`registerDevice` keeps `pushKey` **only when it is supplied on that
registration**, never inherited from the previous row. A reinstall on Android
loses the private key — the Keystore goes with the app — so carrying the
public key forward would encrypt every future notification to a key nobody
holds. Delivery would succeed, decryption would fail, and the person would see
the fallback forever with nothing reporting an error. An iOS Keychain item
outlives the app, so a reinstalled iPhone usually finds its old key and sends
it again; the coordinator learns that by being sent it, not by assuming it,
and an iPhone whose item is gone (restored onto a new phone, which a
`ThisDeviceOnly` item does not follow) sends the new one it makes.

The key is validated at **registration**, not at send time. A key that cannot be
imported is a registration that fails on every notification forever, and the
moment to say so is while somebody is looking at a settings screen — not
silently, hours later, when a session needs an answer. An invalid-curve point is
refused there too: handing somebody a point that is not on the curve and
watching what comes back is the classic way to learn a private key one bit at a
time, and WebCrypto catches it on import.

## Push is off unless switched on

`FLEETWRIGHT_PUSH` in your `wrangler.toml`'s `[vars]` (ours is set in
`wrangler.production.toml`), or the environment for a Node coordinator. **Unset is off, and it says so in the log** rather than being
silent — silence is how a fleet discovers on the day it matters that push was
never wired up.

It used to turn itself on whenever an APNs key and an FCM service account
happened to be present. That is a fine rule for one deployment and a bad one for
a fork: those credentials are ours and they address *our* app's device tokens,
so a fork that acquires them by copying a config would be notifying our users'
phones. Turning push on should be a line somebody wrote.

It is also the seam a paid entitlement would sit on later. If push ever becomes
something an account pays for, what changes is the value here and whatever
issues it — not the plumbing underneath.

`"0"` and `"false"` are truthy strings in JavaScript; a config where
`FLEETWRIGHT_PUSH = "0"` turned push on would be a config nobody can read, so
the check is an allowlist of `1`, `true`, `yes`, `on`.

## What is done and what is not

| | State |
|---|---|
| Scheme, envelope, key validation | **done**, `src/fleet/push-crypto.js` |
| Encrypting in both senders, with the plaintext fallback | **done**, `src/fleet/push.js` |
| `pushKey` accepted and validated at registration | **done**, both coordinators |
| Exercised end to end against the bytes a phone receives | **done**, `test/push-encryption.test.js` and `test/fixtures/parity/push-envelope.json` |
| Key generation and storage | **done**. iOS Keychain, `AfterFirstUnlockThisDeviceOnly`, account `push-key`. Android Keystore, alias `fleetwright.push`, `PURPOSE_AGREE_KEY`, no user authentication, agreed with through the `AndroidKeyStore` provider by name |
| Both phones register `pushKey` | **done**, after a self-test: a probe sealed to the key in software has to open with it, or the phone registers without one |
| The category sealed beside the words | **done**. The coordinator writes it inside the envelope, empty when there is nothing to answer, and still in the clear for iOS and older phones. A phone that opens the envelope takes the sealed one, and draws no buttons when the clear one disagrees |
| iOS Notification Service Extension | **done**, `network.thetech.fleetwright.Push`. It rewrites the alert and copies the sealed fields into `userInfo`. A seal it cannot open leaves the fallback sentence and clears the category, so a button is not offered for a question that was not read |
| Android data-message decryption | **done**, Android 12 and later. `onMessageReceived` opens `e` before it reads `kind`, and posts the notification itself when the tray was not given one |

A phone installed before this, which registers no key, still gets the plaintext
path. That is the point of the fallback being a first-class path rather than an
error case.

### A key is sent, withheld, or not sent at all

The coordinator keeps a key only when the registration sends one, so a phone
that registers without its key is put back on plaintext until it registers
again. That makes the phone's choice worth stating:

- **The key**, once it has passed the self-test.
- **No key**, only for a phone that cannot open what would be sealed to it:
  Android 11, where `PURPOSE_AGREE_KEY` does not exist yet; a keystore that
  will not make an agreement key, on a phone that has never registered one;
  or a key made in that same registration that fails the self-test, which
  Android then deletes so the next launch starts fresh. A key that was sent
  before is never dropped for failing it: Android's keystore reports a daemon
  that did not answer the same way it reports a key it will not agree with,
  so that failure is treated as the next case.
- **No registration at all** when the Keychain or the Keystore did not answer
  this time: locked before the first unlock, busy, a daemon that timed out.
  The phone keeps the registration it has, the coordinator keeps sealing to
  the key it has, and the next launch registers again. iOS makes a new key
  only when the Keychain says there is none, never because a read failed.
- **A new key** when that error does not go away. A phone that never
  registers never sends a new APNs token or FCM address, and push stops with
  nothing to say so. So each phone counts the registrations its key failed,
  with the time of the first, and after three in a row spread over at least a
  day it deletes the key and makes another, which goes through the self-test
  like any new one. Only a phone that cannot keep or use the new one either
  registers without a key. Any registration that gets as far as the key
  clears the count.

### Android 12 and later, and what data-only costs there

**Android 11 stays on plaintext.** The app runs from Android 11, and the
Keystore's agreement purpose arrived in Android 12, so an Android 11 phone
registers no key and gets the notifications it always has.

**On Android 12 and later every notification is data-only once the phone has
registered its key**, because a `notification` block would be drawn by the
tray as ciphertext. So the cost written above applies to all of them, not
only to the ones with buttons: a phone where the app has been force-stopped
gets nothing until the app is opened again, and Doze may delay one.
`priority: HIGH` is set, which is what buys the wake. That is the trade for
Google not reading what a session is asking, and it was taken knowingly.

**What is still true, and worth not overstating.** A Live Activity is not
sealed: ActivityKit is handed `content-state` with nothing of ours run first
(`docs/push.md`). The key is unavailable before the first unlock after a
reboot, and the fallback shows. An encrypted notification does not collapse on
the session name, because the name is inside the envelope; Android replaces by
that name once it has opened one, and iOS may stack them. An iOS extension that
runs out of time leaves the fallback sentence and no buttons, as a seal it
cannot open does. The clear category would still draw them, but the prompt id
and the digits were never opened, and an answer button does not bring the app
forward, so a press on one would do nothing at all.

**The extension can read more of the Keychain than it uses.** It reads the
app's default keychain group, and a group is the smallest thing iOS grants, so
it could read every item the app keeps there, the coordinator credential among
them; its code reads the push key and nothing else. Narrowing it would mean
the app writing the key into a group of its own, which needs a
`keychain-access-groups` entitlement on the app, and the app's profile is the
hand-made secret the release installs, which nothing in this repository can
inspect. An archive that failed on that would stop every release until the
profile was remade by hand, so the grant stays, to our own extension, and is
written down here and in `apps/ios/project.yml`. The app's entitlements are
unchanged, so the existing distribution profile still signs it, and the
release job refuses an extension profile that does not allow that group.
