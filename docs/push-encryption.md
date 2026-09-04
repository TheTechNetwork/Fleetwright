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

## The key belongs to the install, not the phone

`registerDevice` keeps `pushKey` **only when it is supplied on that
registration**, never inherited from the previous row. A reinstall loses the
private key — Keychain and Keystore both go with the app — so carrying the
public key forward would encrypt every future notification to a key nobody
holds. Delivery would succeed, decryption would fail, and the person would see
the fallback forever with nothing reporting an error.

The key is validated at **registration**, not at send time. A key that cannot be
imported is a registration that fails on every notification forever, and the
moment to say so is while somebody is looking at a settings screen — not
silently, hours later, when a session needs an answer. An invalid-curve point is
refused there too: handing somebody a point that is not on the curve and
watching what comes back is the classic way to learn a private key one bit at a
time, and WebCrypto catches it on import.

## Push is off unless switched on

`AGENT_FLEET_PUSH` in your `wrangler.toml`'s `[vars]` (ours is set in
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
`AGENT_FLEET_PUSH = "0"` turned push on would be a config nobody can read, so
the check is an allowlist of `1`, `true`, `yes`, `on`.

## What is done and what is not

| | State |
|---|---|
| Scheme, envelope, key validation | **done**, `src/fleet/push-crypto.js` |
| Encrypting in both senders, with the plaintext fallback | **done**, `src/fleet/push.js` |
| `pushKey` accepted and validated at registration | **done**, both coordinators |
| Exercised end to end against the bytes a phone receives | **done**, `test/push-encryption.test.js` |
| iOS Notification Service Extension | **not built** |
| Android data-message decryption | **not built** |
| Key generation and storage in either app | **not built** |

Until the last three land, no phone registers a `pushKey`, so every notification
takes the fallback path and behaves exactly as it does today. That is the point
of the fallback being a first-class path rather than an error case: the
coordinator half can ship, and be tested, before either app moves.
