# CI, and the secrets it needs

Five workflows. **Everything that runs on a pull request needs no secrets at
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
| `codeql.yml` | every push and PR, plus weekly | none |

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
| `AGENT_FLEET_FCM_SERVICE_ACCOUNT` | the Firebase service-account JSON, or base64 of it. Optional; without it push is logged rather than sent |

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

Making one, if there is not already a keystore:

```sh
mise install                                  # keytool comes with the JDK
KEYSTORE_PASSWORD='…' mise run keystore       # writes ./release.jks
```

That prints the base64 and the exact four secrets to paste. It refuses to
overwrite an existing `release.jks`, because that mistake cannot be undone.

`keytool: command not found` means there is no JDK on your PATH — which is what
`mise install` fixes, since `mise.toml` already pins temurin-25 for the Android
build. The equivalent by hand:

```sh
keytool -genkeypair -v -keystore release.jks -keyalg RSA -keysize 4096 \
  -validity 10000 -alias fleetwright
base64 -w0 release.jks    # paste into ANDROID_KEYSTORE_BASE64
```

**Back the file up somewhere that is not GitHub.** Play identifies an app by its
signing key permanently: lose it and there is no update to the existing listing,
only a new one. An Actions secret is write-only in the UI, so it is not a backup.

If you use **Play App Signing**, Google holds the app signing key and this
becomes the *upload* key, which Google can reset if lost. That is the safer
default for a first release and changes nothing above — the workflow signs with
whatever it is given.

## Google Play — the closed (alpha) track

A **published GitHub release** builds a signed bundle and uploads it to Play's
**closed testing** track.

Closed rather than internal, deliberately:

| | internal | closed (alpha) |
|---|---|---|
| review | none, live in minutes | Google reviews the build first |
| testers | up to 100, named individually | email lists or an opt-in link |
| what it is for | does the build work at all | the first people who did not build it |

The slowness is the point at this stage. `PLAY_TRACK` is a repository variable,
so moving between `internal`, `alpha` and `beta` is a setting rather than a
change to the workflow — unset means `alpha`.

| what | where |
|---|---|
| `PLAY_SERVICE_ACCOUNT_JSON` | a GitHub secret. Play Console → Setup → API access → create a service account, grant it **Release manager**, download the JSON key |
| The app record | Play Console → Create app. Name **Fleetwright**, package `network.thetech.fleetwright` |
| The first upload | **by hand.** Play asks for the content rating, the data safety form and the target audience on a first release, and no API can answer those for you |
| A closed testing track with testers | Play Console → Testing → Closed testing → Alpha |

Unset the secret and the job warns and skips, like every other credential here.

### The listing

Internal testing needs **no store listing** — testers install from a link and
never see a store page. It does need the 512 icon, and the App content
declarations, which apply to every track:

| | |
|---|---|
| Privacy policy | `https://fleet.thetech.network/privacy` |
| Ads | none |
| Data safety | **no data collected.** The token and the commands go to a coordinator the user runs; nothing reaches us. This changes the day Firebase is wired for push, because the FCM SDK collects a device identifier |
| Content rating | utility, no user-generated content, no communication → Everyone |
| Target audience | **18+**, which keeps the Families policy and its extra review out of it |

`apps/android/store/` has the icon and the feature graphic, both generated by
`tools/make-app-icon.py`. Screenshots are not there and cannot be: they have to
come from a running app.

### When Play says the caller has no permission

It returns the same 403 for three different problems, so check in this order —
the job now prints which account it is asking as, which is the piece Play's
error leaves out:

1. **Users and permissions** — is that exact service account address listed?
2. Open it → **App permissions** → the app needs **Release to testing tracks**.
   Account-level access on its own is not enough, and its absence looks
   identical to never having been invited.
3. The package must already be bound to an app record by one manual upload.
   Play fixes the package name from the first bundle you upload, so until then
   `network.thetech.fleetwright` matches nothing the account can see.

A different 403 — *"Google Play Android Developer API has not been used in
project N"* — is the API itself being switched off in the Google Cloud project
the service account belongs to. That one names its own fix and links to it.

### Two things that would otherwise bite

**Play wants an `.aab`, not an `.apk`.** CI builds both: the bundle for Play,
the APK for the GitHub release, since an `.aab` is useless to somebody
sideloading. They are different deliveries of the same build.

**`versionCode` comes from the CI run number.** A constant allows exactly one
upload ever — the same trap as `CURRENT_PROJECT_VERSION` on iOS, and it was
hardcoded to `1` here until it was found. Run numbers only increase and are
already past 99, so they stay ahead of anything uploaded by hand.

### A note on the 14-day rule

A **personal** Play developer account created after November 2023 must run a
closed test with 12 testers for 14 days before it can promote to production.
Organisation accounts are exempt. Internal testing is unaffected either way,
but it changes what "ship it" looks like later and is better known now.

## App Store Connect — TestFlight

| secret | where it comes from |
|---|---|
| `APPSTORE_ISSUER_ID` | App Store Connect → Users and Access → Integrations → App Store Connect API |
| `APPSTORE_KEY_ID` | the key's ID, on the same page |
| `APPSTORE_PRIVATE_KEY` | the **contents** of the `AuthKey_XXXX.p8` file (downloadable once) |
| `APPLE_TEAM_ID` | Membership details, a 10-character string |

An API key rather than certificates in the repository — for the *upload*. That
part still holds: one secret, revocable from the web, no second repository of
secrets to look after.

**The signing identity is stored, though, and that was a correction.** The
original arrangement let `-allowProvisioningUpdates` create the certificate
too, which is fine on a developer's machine and wrong on CI: a runner is a new
machine with an empty keychain every time, so every release asked Apple for a
NEW distribution certificate. Apple caps them, and after a day of releases the
archive failed with *"Choose a certificate to revoke. Your account has reached
the maximum number of certificates."* The certificates it had made were also
worthless — their private keys lived on runners that no longer exist.

So: one certificate, exported once as a `.p12`, imported into a throwaway
keychain per job.

| secret | what it is |
|---|---|
| `APPLE_DISTRIBUTION_P12` | `base64 -w0 distribution.p12` |
| `APPLE_DISTRIBUTION_P12_PASSWORD` | the export password |

No Mac is needed to make one:

```sh
openssl req -new -newkey rsa:2048 -nodes -keyout distribution.key -out distribution.csr \
  -subj "/CN=Fleetwright Distribution/C=US"
# upload the .csr as an Apple Distribution certificate, download the .cer
openssl x509 -in distribution.cer -inform DER -out distribution.pem -outform PEM
openssl pkcs12 -export -inkey distribution.key -in distribution.pem -out distribution.p12
```

Keep `distribution.key` and the `.p12`. Losing them means doing this again and
burning another certificate slot, which is the thing being avoided.

**The two version numbers come from build settings**, and the Info.plist
references them rather than carrying literals — `CFBundleShortVersionString:
$(MARKETING_VERSION)` and `CFBundleVersion: $(CURRENT_PROJECT_VERSION)`.
XcodeGen fills those keys in itself when they are absent, as fixed strings, and
a build setting cannot override a value already baked into the plist. The
symptom is quiet: TestFlight showed `1.0 (7)` while the project said 0.1.0 and
the archive was passing 48 on the command line.

**Internal TestFlight goes out on every commit to `main` that touches `apps/ios/**`.** The build number is
`github.run_number`, because App Store Connect refuses a build number it has
already seen for a version — `project.yml`'s `CURRENT_PROJECT_VERSION: "1"`
would have allowed exactly one upload, ever. The *version* still comes from
`MARKETING_VERSION`, so bump that in `project.yml` when you want a new one.

Internal testers need no review, so this costs a macOS build and nothing else.
External testing still wants a published release, which is where a decision
belongs.

### Builds reach internal testers by themselves

`tools/testflight-distribute.mjs` runs after the upload: it waits for the build
to finish processing, finds the beta group, and adds the build to it. Testers
are notified by App Store Connect as usual.

| audience | when | what happens |
|---|---|---|
| **internal** | every commit to `main` touching `apps/ios/**` | assigned to the internal group, available immediately |
| **external** | only a **published GitHub release** | assigned to the external group, then submitted for Beta App Review |

External is not every commit on purpose. Those testers are the public, Apple
reviews the first build, and a release is a decision somebody made — which is
the right shape for a delivery real people install.

**Turn on automatic distribution for the internal group as well.** TestFlight →
Internal Testing → the group → *Automatic distribution*. It is not redundant
with the script: Apple applies it whenever processing finishes, with no runner
waiting, and processing has no deadline — the first build of a new app took
longer than 20 minutes and the job that was waiting for it timed out. The
script gets there first when processing is quick, and sets "What to Test",
which the checkbox cannot do. The checkbox catches everything else.

A slow queue is a **warning, not a failure**. The upload is the delivery this
pipeline is responsible for; how long Apple takes afterwards is not something a
run can influence or should be judged on, and a job that goes red when it
worked is how people learn to ignore red.

The script **submits** for review and stops. Review takes hours to a day, and
waiting would mean holding a runner open for a decision no amount of polling
influences. A build already submitted is not an error either — a re-run of a
release should be idempotent rather than red.

Two things it needs that this repository cannot create:

- **The groups themselves** — TestFlight → Internal Testing → **+**, and
  External Testing → **+**. Their names go in two repository *variables*:

  | variable | example |
  |---|---|
  | `INTERNAL_BETA_GROUP_NAME` | `Internal Testers` |
  | `EXTERNAL_BETA_GROUP_NAME` | `External Testers` |

  Either unset means "the first group of that kind", which is right while
  there is exactly one. One variable per audience rather than one shared name,
  because a rename later is the change that leaves a variable unset somewhere —
  and unset here is not an error, it is a silent fallback.
- **Testers in it.** Internal testers are people with an App Store Connect
  role, up to 100, and they need no review.

There is a checkbox in App Store Connect that does the same thing — automatic
distribution on the group. It works. This is in a file that can be reviewed and
that does not quietly stop applying when a group is renamed.

Export compliance is answered in the bundle (`ITSAppUsesNonExemptEncryption:
false`, correct because the app uses HTTPS and nothing else), so builds do not
stop at "Missing Compliance" — which would otherwise leave a build that looks
delivered and reaches nobody.

### The app icon is generated

`tools/make-app-icon.py` writes `Assets.xcassets/AppIcon.appiconset/icon-1024.png`
from ~30 lines of geometry, stdlib only. Editing the icon means editing numbers
rather than tracking down whoever has the source file, and the PNG is committed
so no build step depends on running it.

It is deliberately **opaque RGB with no alpha channel** — App Store Connect
rejects an icon with transparency, and says so unhelpfully. One 1024×1024 image
is enough; Xcode derives every other size at build time.

### The first upload will fail without these

Both errors from a real attempt, and neither is fixable in this repository:

```
error: exportArchive Cloud signing permission error
error: exportArchive No profiles for 'network.thetech.fleetwright' were found
```

1. **Register the App ID.** Developer portal → Certificates, Identifiers &
   Profiles → Identifiers → `network.thetech.fleetwright`, with **Push
   Notifications** enabled. There is no profile to find until the identifier
   exists, and enabling push later means re-issuing the profile.
2. **The API key needs App Manager or Admin.** Cloud signing —
   `-allowProvisioningUpdates`, which is how CI signs without certificates in
   the repo — creates certificates and profiles on demand, and a **Developer**
   role key is not allowed to. That is what "Cloud signing permission error"
   means. Users and Access → Integrations → App Store Connect API.
3. **Create the app record** (below).

Three things to do once in App Store Connect before the first upload, because
none of them can be automated:

| | |
|---|---|
| Bundle id | `network.thetech.fleetwright` |
| App name | **Fleetwright** — must be unique across the whole App Store, which is what "Agent Fleet" fell foul of |
| SKU | `network.thetech.fleetwright` — the bundle id reused. Internal only, never shown, and never changeable |

The bundle id is reverse-DNS of a domain you actually control, which
`dev.agentfleet.app` was not. The SKU is arbitrary but permanent; reusing the
bundle id means there is one string to remember rather than two, and no chance
of the two drifting into looking like different apps.

## Firebase — push notifications

Not a CI secret. It goes to whichever coordinator is running:

```sh
# on Cloudflare — JSON or base64, either works
cd worker && npx wrangler secret put AGENT_FLEET_FCM_SERVICE_ACCOUNT < service-account.json

# on a box — base64, because a systemd EnvironmentFile mangles the JSON
base64 -w0 service-account.json     # into /etc/agent-fleet-coordinator.env as
AGENT_FLEET_FCM_SERVICE_ACCOUNT=eyJwcm9qZWN0X2lkIjoi…
```

Firebase console → Project settings → Service accounts → Generate new private
key. See [`push.md`](./push.md) — including the newline mangling that catches
everyone.

`google-services.json` goes in `apps/android/app/` and is gitignored. It is not
a secret (it ships inside every APK), but it is account-specific, so CI builds
without it until the app actually uses FCM.

## Code scanning — one setting, and it is not a secret

`codeql.yml` needs no secrets, but it **does** need GitHub's *default setup* for
code scanning turned off, because the two cannot both upload results:

> Settings → Code security → Code scanning → CodeQL analysis → **Disable**

Until that is done, this workflow builds everything correctly and then fails at
the upload with *"CodeQL analyses from advanced configurations cannot be
processed when the default setup is enabled"*.

### Why there is a workflow at all

Default setup ran `autobuild`, and autobuild failed on both compiled languages
on every run:

```
java   ERROR: Could not detect a suitable build command for the source checkout.
swift  ERRO [no-project-found] `autobuild` detected neither an Xcode project or
       workspace, nor a Swift package
```

Neither is a broken build. Autobuild looks at the repository root, and

* the Gradle build is at `apps/android`, not the root — there is no
  `settings.gradle` for it to find;
* there is no `.xcodeproj` **anywhere in the repository**. It is generated from
  `apps/ios/project.yml` by XcodeGen and gitignored, so there is nothing on disk
  to detect until `xcodegen generate` has run.

A compiled language only enters a CodeQL database if the extractor watches a
real compiler run, so `codeql.yml` uses `build-mode: manual` and the same build
commands `android.yml` and `ios.yml` already use. `javascript-typescript` and
`actions` are analysed too — turning off default setup would otherwise stop
scanning the ~50 `.js` files under `src/`, `worker/` and `bin/`, which are the
part of this repository that faces the network.

Two flags in the Android build are load-bearing and easy to remove by accident.
`--no-daemon`, because a Gradle daemon compiles in a process the tracer never
attached to; `--no-build-cache`, because a restored cache entry makes
`compileDebugKotlin` come out `FROM-CACHE` and a task that does not run compiles
nothing. Both mistakes produce a **green run with an empty database**, which is
worse than a red one.

## Permissions

Every workflow declares a top-level `permissions:` block, and `ci.yml` fails the
build if one does not. Without a block a workflow inherits the repository-wide
default — a setting in the web UI, invisible in the diff — so the token a step
receives is decided somewhere nobody reviewing that step will look.

The floor is `contents: read`. Two jobs raise their own:

| job | | why |
|---|---|---|
| `android.yml` — `release` | `contents: write` | `gh release upload` attaches the APK to the release |
| `codeql.yml` — all three | `security-events: write` | uploading results is the point of the workflow |

## What to set up first

1. **Nothing.** Open a PR and the iOS build, the Android debug APK, the Worker
   bundle check and CodeQL all run. That alone verifies the thing that has never
   been verified.
2. **Cloudflare**, two secrets — the coordinator deploys on merge to main and
   the phone has something to talk to.
3. **Firebase**, when you want notifications to actually arrive.
4. **Apple and Android signing**, when you want TestFlight and a signed APK.
