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

Every step is built and tested. What is not wired is the **app end of FCM**,
which needs a Firebase project — see `apps/android/README.md`.

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

One environment variable, holding the Firebase service-account JSON — as JSON,
or base64-encoded. Both are accepted; which one you want depends on where it is
going.

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

## iOS

Two routes, and the first is much less work:

- **Through FCM.** Add the iOS app to the same Firebase project and upload an
  APNs auth key. One integration for both platforms, and nothing here changes.
- **Direct APNs.** A second sender beside `fcmPusher`, signing ES256 with a
  `.p8` key. The `Pusher` interface is a single `send(devices, message)` that
  returns `{sent, dead}` — `logPusher` is nine lines and shows the shape.

## Why FCM was implemented first

It covers Android directly and iOS through the APNs bridge, so it is one
integration for both platforms — and crucially it needs **no Apple signing key**,
which means Android push can be tested before an iOS build exists at all.
