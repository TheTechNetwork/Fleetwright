# CI, and the secrets it needs

Four workflows. **Everything that runs on a pull request needs no secrets at
all** — the secret-dependent jobs skip themselves with a notice rather than
failing, so a fork or a fresh clone never shows a red main for something it was
never given.

| workflow | on | secrets |
|---|---|---|
| `ci.yml` | every push and PR | none |
| `ios.yml` — `build` | PRs touching `apps/ios` | **none** |
| `android.yml` — `debug` | PRs touching `apps/android` | none |
| `worker.yml` — `check` | PRs touching `worker/` or `src/fleet/` | none |
| `worker.yml` — `deploy` | push to `main` | Cloudflare |
| `android.yml` — `release` | published release | Android keystore |
| `ios.yml` — `testflight` | published release | App Store Connect |

## The one that matters most needs nothing

`ios.yml`'s **build** job compiles the iOS app on a macOS runner. design.md §9
has said since the beginning that this app "cannot be verified anywhere in
Claude Code" and is *reviewed-but-unrun*. This is what changes that, and it
needs no Apple account: `CODE_SIGNING_ALLOWED=NO` builds for the simulator,
which type-checks every line without a team, a certificate or a profile.

Signing failures are a different class of problem and must not be able to hide a
syntax error, which is why the two are separate jobs.

## Cloudflare — deploy the coordinator

| secret | where it comes from |
|---|---|
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages overview, right-hand sidebar |

Use the template rather than a global key: it is scoped to Workers, and it is
revocable on its own.

### The Worker's runtime secrets are a different thing

These live in Cloudflare, not GitHub, and `wrangler deploy` does not touch them.
**A Worker deployed without them answers 503 to everything** — deliberately, since
a coordinator with no credentials is remote control of every box in the fleet for
whoever finds the URL.

Two ways to set them, and you only need one.

**As repository secrets**, if GitHub is where you would rather manage them. The
deploy job pushes each one to the Worker after deploying, and skips any that are
unset:

| secret | |
|---|---|
| `AGENT_FLEET_HOST_TOKEN` | what a host presents. `openssl rand -hex 24` |
| `AGENT_FLEET_API_TOKEN` | what a phone or Shortcut presents. `openssl rand -hex 24` |
| `AGENT_FLEET_FCM_SERVICE_ACCOUNT` | the Firebase service-account JSON. Optional; without it push is logged rather than sent |

**Or directly**, which keeps them out of GitHub entirely:

```sh
cd worker
npx wrangler secret put AGENT_FLEET_HOST_TOKEN
npx wrangler secret put AGENT_FLEET_API_TOKEN
npx wrangler secret put AGENT_FLEET_FCM_SERVICE_ACCOUNT
```

Whichever you choose, `AGENT_FLEET_HOST_TOKEN` has to match the value in each
host's `/etc/agent-fleet-sidecar.env`, or the host's websocket is refused at the
upgrade.

## Android — a signed release APK

Only for `release` builds. **The debug APK on every PR needs none of this**, and
is installable.

| secret | what it is |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | the store password |
| `ANDROID_KEY_ALIAS` | the alias inside the store |
| `ANDROID_KEY_PASSWORD` | the key password |

Making one, if there is not already a keystore — **keep the file, and back it
up**. Losing it means the app can never be updated under the same identity:

```sh
keytool -genkeypair -v -keystore release.jks -keyalg RSA -keysize 4096 \
  -validity 10000 -alias agent-fleet
base64 -w0 release.jks    # paste into ANDROID_KEYSTORE_BASE64
```

## App Store Connect — TestFlight

| secret | where it comes from |
|---|---|
| `APPSTORE_ISSUER_ID` | App Store Connect → Users and Access → Integrations → App Store Connect API |
| `APPSTORE_KEY_ID` | the key's ID, on the same page |
| `APPSTORE_PRIVATE_KEY` | the **contents** of the `AuthKey_XXXX.p8` file (downloadable once) |
| `APPLE_TEAM_ID` | Membership details, a 10-character string |

An API key rather than certificates in the repository: it is one secret, it is
revocable from the web, and it lets `xcodebuild -allowProvisioningUpdates`
create the signing assets itself. Fastlane match solves the same problem by
giving you a second repository of secrets to look after.

Two things to do once in App Store Connect before the first upload, because
neither can be automated: register the bundle id `dev.agentfleet.app`, and
create the app record.

## Firebase — push notifications

Not a CI secret. It goes to whichever coordinator is running:

```sh
# on Cloudflare
cd worker && npx wrangler secret put AGENT_FLEET_FCM_SERVICE_ACCOUNT

# on a box
AGENT_FLEET_FCM_SERVICE_ACCOUNT='{"project_id":…}'   # in /etc/agent-fleet-coordinator.env
```

Firebase console → Project settings → Service accounts → Generate new private
key. See [`push.md`](./push.md) — including the newline mangling that catches
everyone.

`google-services.json` goes in `apps/android/app/` and is gitignored. It is not
a secret (it ships inside every APK), but it is account-specific, so CI builds
without it until the app actually uses FCM.

## What to set up first

1. **Nothing.** Open a PR and the iOS build, the Android debug APK and the
   Worker bundle check all run. That alone verifies the thing that has never
   been verified.
2. **Cloudflare**, two secrets — the coordinator deploys on merge to main and
   the phone has something to talk to.
3. **Firebase**, when you want notifications to actually arrive.
4. **Apple and Android signing**, when you want TestFlight and a signed APK.
