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
