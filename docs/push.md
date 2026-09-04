# Push notifications

design.md §3 lists three meanings of "wake". This is the third — *push when a
session needs you* — and it is the only one where the machine knows something
the person does not. The other two are things somebody already decided to do.

That is the whole argument for carrying an app rather than using a Shortcut: a
Shortcut cannot tell you a session has been sitting at a prompt since 3am.

## The path, end to end

```
session hits a prompt
   │
   ├─ sidecar SessionWatcher polls /api/state + /api/peek        src/fleet/host/watcher.js
   │     notices a TRANSITION, not a state
   ├─ sidecar sends {kind:"event", event:"session.awaiting-input"}
   │     over the same websocket it already holds open
   ├─ coordinator records it and fans out to registered devices  src/fleet/coordinator/core.js
   └─ FCM → the phone                                            src/fleet/push.js
```

Every step is built and tested, and the app end is wired on both platforms —
what is *proven* about delivery lives in
[`app-parity.md`'s table](./app-parity.md#what-is-actually-proven-about-the-apps)
and nowhere else, including here.

## What gets a notification, and what does not

| event | notifies | why |
|---|---|---|
| `session.awaiting-input` | ✅ | the whole reason for this |
| `session.error` | ✅ | it stopped and it was not supposed to |
| `session.ended` | ✅ | the work finished |
| `session.rc-online` | ✅ | it is now drivable from the phone that just buzzed |
| `session.started` | ❌ | you started it |

**Transitions, never states.** A session parked at a prompt for an hour is one
notification, not 180. A phone that cries wolf gets its notifications turned
off, which costs you the one that mattered.

The first poll after a sidecar starts is deliberately **quiet**: on a restart
every session looks new, and announcing all of them would be a notification
storm every time the service restarts.

## Registering a phone

```
POST /api/devices   {"platform":"android|ios","token":"…"}
DELETE /api/devices {"token":"…"}
```

Keyed by the push token rather than by a device id the coordinator mints,
because the token *is* the delivery target — and a reinstall hands back a new
one, which should not accumulate as a second registration that fails forever.

Tokens the provider reports as dead (`404`, `UNREGISTERED`) are dropped rather
than retried on every event.

**A phone that changes its address does not become two phones.** The map is
keyed by the address, so a changed address leaves the old row behind — and that
row is not obviously dead, because FCM keeps accepting a superseded registration
token for a while. Two live rows for one phone is every notification delivered
twice, which nobody reads as stale state. So a registration carrying a
`clientId` — the credential issued to that phone — drops the other rows holding
the same one. Without a `clientId` nothing is dropped: an unauthenticated
registration cannot tell *the same phone with a new address* from *a different
phone*, and guessing deletes somebody else's.

## Android: the token is becoming an installation ID

firebase-messaging **25.1.0** (16 June 2026) deprecated `getToken`,
`deleteToken` and `onNewToken` together. FCM is moving from a per-app
registration token to the **Firebase installation ID**, which is a handle on the
install across the whole Firebase stack rather than a channel for one product.

The app moved with it:

| was | is |
|---|---|
| `FirebaseMessaging.getInstance().token` | `FirebaseInstallations.getInstance().id` |
| `FirebaseMessagingService.onNewToken` | `FirebaseMessagingService.onRegistered` |

`onRegistered` is also the better callback: it fires on routine syncs at app
startup as well as on change, so a registration that quietly lapsed repairs
itself instead of waiting for a rotation that may never come.

**The coordinator did not change, and that is not luck.** The FCM v1 `token`
field is documented as *"Deprecated: Use `fid` instead … During the transition
period, this field also accepts a Firebase Installation ID (FID)."* So a phone
that upgrades starts posting a FID into the same field, old registrations keep
working, and there is no flag day. Renaming the protocol parameter to `fid`
would have been one: an old client sending `token` fails **after** the version
handshake agreed, which is the worst-shaped failure this protocol has. The name
outlives its literal meaning on purpose.

Moving the sender to the `fid` field is a later, separate change, and it can
only happen once nothing is registered under an old-style token.

## iOS: APNs, directly

The iOS app registers with APNs and posts the raw device token. That is not an
FCM registration token and never becomes one, so for a while every iOS device
was registered against a service that could not reach it.

`apnsPusher` talks to Apple directly, and `pusherFromEnv` routes by platform:
iOS to APNs, everything else to FCM. Three variables:

```sh
AGENT_FLEET_APNS_KEY_ID=QK4U44N7R9     # the key's id
AGENT_FLEET_APNS_TEAM_ID=…             # the same team id the iOS build signs with
AGENT_FLEET_APNS_KEY="$(cat AuthKey_QK4U44N7R9.p8)"
```

On Cloudflare all three are GitHub secrets, synced to the Worker on deploy:

| | source |
|---|---|
| `AGENT_FLEET_APNS_KEY` | the `.p8` |
| `AGENT_FLEET_APNS_KEY_ID` | which key that is |
| `AGENT_FLEET_APNS_TEAM_ID` | reused from `APPLE_TEAM_ID`, the same team the iOS build signs with |

The key id and team id are identifiers rather than credentials, and the key id
was briefly a `[vars]` entry for exactly that reason. **A name cannot be both.**
Cloudflare keeps vars and secrets in one namespace, so a deploy carrying a var
clobbers the secret of the same name — which would have replaced the key id
with itself and worked, right up until somebody rotated one and not the other.

The key comes from the Apple Developer portal → **Keys** → **+** → tick **Apple
Push Notifications service**. It is *not* the App Store Connect API key used for
TestFlight — different key, different page, downloadable once, and good for
every app on the team.

`AGENT_FLEET_APNS_BUNDLE_ID` defaults to `network.thetech.fleetwright`, and
`AGENT_FLEET_APNS_SANDBOX=1` switches to the sandbox host for a build run from
Xcode. TestFlight and App Store builds use production, which is the default,
because defaulting the other way makes the common case the one that fails
silently.

### Why not the Firebase SDK

That is Google's recommendation and a reasonable choice. It also means a
dependency in an app that has none, a plist checked in or fetched at build
time, and a second vendor sitting between a session needing a person and the
person. The direct path needs no app change at all — the hex encoding in
`Fleet.swift` was already exactly right for it.

### HTTP/2

APNs requires it. A Worker's `fetch` negotiates HTTP/2; Node's does not. Rather
than add undici, the transport is injected: `src/fleet/apns-node.js` uses
`node:http2`, which is already in the runtime, and the Worker keeps the default
`fetch`. That is also why the import lives outside `push.js` — `node:http2` does
not exist in a Worker and importing it would break the bundle.

### If a token still fails

An `INVALID_ARGUMENT` from FCM keeps the registration and logs why rather than
deleting it — see below. From APNs, a `410` or `BadDeviceToken` does mean the
registration is gone for good, and it is pruned.

## Configuring the sender

Two things, not one. **`AGENT_FLEET_PUSH` is the switch** — until it is set to
`1`/`true`/`yes`/`on`, nothing is sent at all and the coordinator logs that it
is disabled, whatever credentials exist (see
[`push-encryption.md`](./push-encryption.md) for why the switch is separate).
Then the credential: an environment variable holding the Firebase
service-account JSON — as JSON, or base64-encoded. Both are accepted; which one
you want depends on where it is going.

The installer asks for this and does the encoding — `install.sh` takes the
*path* to the JSON and base64s it into the coordinator's env file, which is the
whole reason it asks for a path rather than a value. By hand:

```sh
# the coordinator on a box — BASE64, and not optionally so, see below
base64 -w0 service-account.json      # paste into /etc/agent-fleet-coordinator.env
AGENT_FLEET_FCM_SERVICE_ACCOUNT=eyJwcm9qZWN0X2lkIjoi…

# the coordinator on Cloudflare — either form; wrangler reads stdin
cd worker && npx wrangler secret put AGENT_FLEET_FCM_SERVICE_ACCOUNT < service-account.json
```

### Why base64 on a box

Because systemd's `EnvironmentFile=` cannot carry that JSON, in two separate
ways:

1. **It has no multi-line values,** and Google hands you the file
   pretty-printed across a dozen lines.
2. **It expands C escapes inside double-quoted values.** So even flattened onto
   one line, the `\n` sequences in `private_key` arrive as *real* newlines — and
   a raw newline inside a JSON string is a parse error, not a quirk.

The second is the nasty one, because the result is a coordinator that starts
cleanly and simply never sends a notification. Base64 has no character that
either systemd or a shell will touch.

Raw JSON keeps working everywhere it already did — a secret already set on
Cloudflare does not need re-entering.

Get it from Firebase console → Project settings → Service accounts → Generate
new private key. Only `project_id`, `client_email` and `private_key` are used.

**Without it, push logs instead of sending, and says so.** That is deliberate: a
fleet with no push credentials should still run, still record events, and still
tell you what it *would* have sent. Silently doing nothing is how you find out
on the day it matters that push was never wired up.

A malformed service account also falls back to logging rather than throwing. A
coordinator that will not boot because push is misconfigured is worse than one
that cannot send notifications.

### The failure that will happen to you

`private_key` contains newlines. Put it through an environment variable and they
often arrive as literal `\n`, which makes the key import fail with a message
that explains nothing. `pemToBytes` accepts both forms, and there is a test for
exactly that.

## iOS: the route that was chosen

There were two routes, and the one that shipped is **direct APNs**:
`apnsPusher` signs ES256 with a `.p8` key, and `routingPusher` sends iOS
registrations there and everything else to FCM — `pusherFromEnv` logs "APNs
for iOS, FCM for everything else" when both are configured. The rejected
route, FCM's APNs bridge, would have meant adding the Firebase SDK to the iOS
app, which the section above declines for its own reasons. The `Pusher`
interface is a single `send(devices, message)` returning `{sent, dead}` —
`logPusher` shows the shape in eight lines.

## Why FCM was implemented first

It covered Android directly and, until the direct sender existed, iOS through
the APNs bridge — one integration for both platforms, and crucially it needed
**no Apple signing key**, which meant Android push could be tested before an
iOS build existed at all.
