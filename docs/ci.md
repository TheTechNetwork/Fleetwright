# CI, and the secrets it needs

The workflows in `.github/workflows/` — the directory is the authority on how
many. **Everything that runs on a pull request needs no secrets at all** — the
secret-dependent jobs skip themselves with a notice rather than failing, so a
fork or a fresh clone never shows a red main for something it was never given.

| workflow | on | secrets |
|---|---|---|
| `ci.yml` | every push and PR — **no paths filter**, see `ci-scope.md` | none |
| `ci.yml` — `gate` (`CI passed`) | every push, PR and merge-queue run | none |
| `ios.yml` — `build` | PRs touching `apps/ios` | **none** |
| `android.yml` — `debug` | PRs touching `apps/android` | none |
| `worker.yml` — `check` | PRs touching the bundle (`worker/`, `src/fleet/`, `src/core/`) | none |
| `worker.yml` — `gate` (`Worker passed`) | every push, PR and merge-queue run | none |
| `sandbox.yml` — `smoke` | PRs touching `sandbox/` | none |
| `worker.yml` — `deploy` | push to `main` | Cloudflare |
| `android.yml` — `release` | published release | Android keystore |
| `ios.yml` — `testflight` | published release | App Store Connect |
| `ios.yml` — `release-app-store` | **full** release (not a prerelease) | App Store Connect |
| `ios-profile.yml` | manual (`workflow_dispatch`) | App Store Connect API key (`ASC_*`) |
| `codeql.yml` | every push and PR, plus weekly | none |
| `sandbox.yml` | pushes touching `sandbox/` | none — `GITHUB_TOKEN` with `packages: write`, publishing the session image to GHCR |
| `host-release.yml` | published release | none — `GITHUB_TOKEN` with `contents: write`, attaching the host tarball and manifest |
| `tail.yml` | manual | Cloudflare |
| `ephemeral-mac.yml` | manual | `FLEETWRIGHT_RUNNER_TOKEN` — see [`ephemeral-hosts.md`](./ephemeral-hosts.md) |
| `renovate-config.yml` | PRs touching `renovate.json` | none |

## The merge gate

Two named checks, and they are the only two worth requiring:

| check | what it means |
|---|---|
| **`CI passed`** | `ci.yml`'s `test` matrix and `checks` job both passed, or were legitimately skipped |
| **`Worker passed`** | `worker.yml`'s `check` job passed, or the change was not in the Worker's bundle |

**They exist so that a required check can have a stable name.** Requiring
`test (node 24)` directly works right up until the matrix moves — it has
already been 18 and 20 — and on the day it becomes `26`, every protection rule
naming the old leg waits forever for a check that will never report again. It
does not fail; it hangs, and it looks like slow CI rather than a broken gate.
These two names do not move.

Both are `if: always()` over their dependencies, and **skipped counts as
passed**. That is the half that makes a filtered job safe to require: a change
outside the Worker's bundle skips `check` and the gate still answers. A failed
or **cancelled** job does not pass — `success()` alone gets the cancellation
case wrong, and a cancelled run is not a run that said yes.

### Turning it on

The workflows are ready either way; these are repository settings, and nothing
in the repository can set them.

**Settings → Rules → Rulesets**, on `main`:

- *Require status checks to pass* → add **`CI passed`** and **`Worker passed`**.
- *Require branches to be up to date before merging* — or, better, the merge
  queue below, which does the same thing without a push-and-wait loop.
- *Require a pull request before merging.*

**Settings → General → Pull Requests → Allow merge queue**, then in the same
ruleset *Require merge queue*. `ci.yml` and `worker.yml` already listen for
`merge_group`; a queue run builds main *plus everything ahead of this pull
request* and tests that, which is the only thing that answers "does merging
this break main" rather than "did this break the main it branched from".

**That distinction is not theoretical here.** `CONTRIBUTING.md` describes
stacked rounds merged bottom-up: `#N+1` is based on `#N`, so the moment `#N`
merges, `#N+1`'s green tick describes a base that no longer exists. That is the
exact shape a merge queue is for.

**Do not require the app builds.** `ios.yml` filters at the trigger, so on a
change outside `apps/ios` it reports *nothing* rather than *skipped* — a
required check would wait on it forever. Making them requireable means the same
`changes`-job treatment `worker.yml` got; until then they report on the pull
request and a human reads them.

## The Worker's deploy filter

`worker.yml` only deploys when something in the Worker's bundle changed, and
that bundle is wider than `worker/`: it pulls `CoordinatorCore`, the push
senders and the OIDC verifier out of `src/fleet`, `text.js` and `names.js` out
of `src/core`, and six files out of `src/mcp`.

The list is checked rather than remembered. `scripts/check-worker-filter.mjs`
(inside `verify.sh`, the `deploy` line) bundles the Worker with esbuild's
`--metafile` and fails when `on.push.paths` does not name a file that is
actually in it:

```
deploy     ... 30 bundled files, all named
```

It exists because the hand-maintained version was wrong twice, and the second
time cost a deploy — see `docs/ci-scope.md`. When it fails it prints the
uncovered files and the exact `- 'dir/**'` lines to add.

## Coverage

`scripts/check-coverage.mjs`, inside `verify.sh`, so it is the same check
locally and in CI.

It records per-file **line** coverage in `test/coverage-floor.json` and fails a
change that executes *less* of a file than the last one did. It is a ratchet,
not a target: there is no "80% or fail" line to argue about, and no way for the
untested surface to quietly grow.

```sh
node scripts/check-coverage.mjs            # the gate
node scripts/check-coverage.mjs --update   # re-baseline after coverage RISES
VERIFY_SKIP_COVERAGE=1 ./scripts/verify.sh # skip it, announced
```

`--update` is the only way a floor moves, and it lands as a reviewable diff in
the pull request that earned it. A run that rises prints the files and the
command; a run that drops prints how many **lines** stopped executing, because
that is the number somebody can act on.

**The suite runs three times per pull request.** Twice in the matrix, and once
more inside `check-coverage.mjs` — `VERIFY_SKIP_TESTS` skips the `tests` *line*,
not the run underneath the coverage one, because coverage has to execute the
suite to measure it. Three runs of 21 seconds, in parallel with a docker build.
Recorded here so "coverage runs once, here" is not read as "once in total".

Two failures, and they say different things:

| | what it means | what to do |
|---|---|---|
| **dropped below its floor** | a test was removed, or code was added that nothing runs | add the test |
| **no floor recorded** | new source, or newly reached by a test | `--update`, and read the number before committing it |

The second one fails rather than merely printing, because a module added at 0%
is the untested surface growing — the thing the ratchet exists to stop. There is
no prior number to judge it against, so the gate insists the number be
*recorded* rather than judging its value.

Three things it deliberately does not do:

- **Branches and functions are not ratcheted.** They move on their own — the
  same file measured twice reports 89.83% and 90.60% of branches with nothing
  changed — and a gate that fails on an unchanged tree is a gate people learn
  to re-run and then to ignore.
- **It never fails on a low number.** `src/core/trust.js` sits at 46%. That is
  a fact to fix with a test, not a reason to block an unrelated change — and it
  is why an unrecorded file fails on being *unrecorded* rather than on being
  low.
- **It does not judge a failing suite.** A run that stopped early covered
  whatever it reached, and ratcheting against that would record a floor from a
  broken run.

The slack is **two lines per file**, converted to a percentage from that file's
own length rather than being a flat percentage — two lines out of a hundred is
two points, two lines out of a thousand is 0.2, and a flat tolerance would have
let twenty lines go dark on the big file without a word.

Writing that rule found a real gap, which is the argument for the whole
mechanism: `scheduler.js` was flapping between 100% and 98.06% on an unchanged
tree because its `ambiguous_session` refusal — *"a stop that lands on the wrong
box is not recoverable by trying again"* — **had no test**, and was being
covered by accident from a fixture elsewhere in the suite.
`test/ambiguous-session.test.js` asserts it now.


## Cutting a release

Three files carry the version and `test/version.test.js` refuses a release
where they disagree — `package.json`, `MARKETING_VERSION` in
`apps/ios/project.yml`, `versionName` in `apps/android/app/build.gradle.kts`.
The fourth is `CHANGELOG.md`, whose top section must be that same version.

1. Bump the three, write the changelog section, merge.
2. Publish a GitHub release on that commit. **Prerelease** ships external
   TestFlight and the Play commit track; a **full release** ships the App Store
   and Play production as well. That grammar is the whole decision — nothing
   else in the pipeline is allowed to mean "ship to everybody".

**The notes come from `CHANGELOG.md`, not from the release box.** Both app
pipelines call `scripts/release-notes.mjs`, which extracts the top section and
fits it to the store's limit: 4000 characters for App Store Connect's
`whatsNew`, 500 for Play per locale — trimmed at a paragraph boundary with a
pointer to the full notes, because a note cut mid-clause reads as a bug in the
app rather than as a shortened note.

The release body is the **fallback**, used only when the changelog has no
section for the version being built, and the run says so with a warning. It
used to be the source, which meant a tester's "What to Test" was whatever was
pasted into the release box — usually the PR description, written for a
reviewer.

To see exactly what a store will receive:

```sh
node scripts/release-notes.mjs --max 500     # what Play gets
node scripts/release-notes.mjs --max 4000    # what TestFlight gets
```

## Commit messages

`commitlint` runs on pull requests only — on main the commit already exists and
a red check tells nobody anything they can act on.

**It is not conventional commits, deliberately.** `commitlint.config.mjs`
argues that out at length; the short version is that the subjects in this
history are sentences a person can read, and a generated `feat(mcp): add
profile param` changelog would say less while looking more official. Switching
later costs one line — extend `@commitlint/config-conventional` and delete the
overrides — because every rule in that file is a standard commitlint rule.

What it enforces is shape rather than vocabulary: a subject under 80
characters with no full stop, a blank line before the body, and body lines that
do not run off the side of a terminal. A missing body is a **warning**: a
one-line change exists, and failing it would teach people to write a body that
says nothing, which is worse than none because it looks like an explanation.

Locally:

```sh
npx commitlint --from origin/main --to HEAD
```

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
**A Worker with no way for anybody to authenticate — no admin token and no
sign-in pair — answers 503 to everything**, deliberately, and the refusal
names both remedies.

Two ways to set them, and you only need one.

**As repository secrets**, if GitHub is where you would rather manage them. The
deploy job pushes each one to the Worker after deploying, and skips any that are
unset:

| secret | |
|---|---|
| `AGENT_FLEET_API_TOKEN` | break-glass admin. `openssl rand -hex 24`. Not what phones use |
| `AGENT_FLEET_FCM_SERVICE_ACCOUNT` | the Firebase service-account JSON, or base64 of it. Optional; without it push is logged rather than sent |
| `AGENT_FLEET_APNS_KEY` / `_KEY_ID` / `_TEAM_ID` | the `.p8` and its identifiers, for push to iOS. Optional, same fallback |

And two repository **variables**:

| variable | |
|---|---|
| `WRANGLER_CONFIG` | which config the deploy uses. Ours sets `wrangler.production.toml`; unset falls back to the fork-safe `wrangler.toml` — no routes, empty `[vars]` — so a fork running this workflow can never deploy our config by accident |
| `AGENT_FLEET_AUTH_ALLOW` | who may sign in: `@yourdomain.com`, or whole addresses. **Empty allows nobody.** A repository variable here, synced to the Worker **as a secret** — it decides who can reach a fleet and must not be a committed var, because Cloudflare keeps vars and secrets in one namespace and a committed var clobbers the synced secret on every deploy |

The other two sign-in settings — `AGENT_FLEET_AUTH_ISSUERS` and
`AGENT_FLEET_AUTH_AUDIENCES` — are **not** synced from GitHub: they are public
identifiers and live as `[vars]` in the wrangler config itself (ours in
`wrangler.production.toml`), so changing who a coordinator will accept is a
reviewable diff. One home per name; see
[`coordinator-deploy.md`](./coordinator-deploy.md).

**Or directly**, which keeps the secrets out of GitHub entirely:

```sh
cd worker
npx wrangler secret put AGENT_FLEET_API_TOKEN
npx wrangler secret put AGENT_FLEET_AUTH_ALLOW
npx wrangler secret put AGENT_FLEET_FCM_SERVICE_ACCOUNT
```

**Hosts need none of this.** There is no shared host token to keep in step any
more: a host generates a keypair, enrols once with a six-digit pin, and signs a
fresh nonce on every connection.

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
KEYSTORE_PASSWORD='…' mise run keystore       # writes ~/fleetwright-release.jks
```

That prints the base64 and the exact four secrets to paste. It writes to
`$HOME` rather than the checkout (`KEYSTORE_OUT` overrides) — a signing key
does not belong in a git tree — and refuses to overwrite an existing keystore,
because that mistake cannot be undone.

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

## Google Play — open testing on a merge, production on a release

| event | track | who |
|---|---|---|
| push to `main` | **open testing** (`beta`) | anybody who found the listing and joined |
| **prerelease** published | **open testing** (`beta`) | the same testers — a rehearsal of the release path |
| release published | **production** | everybody |

A release marked *prerelease* stays on the commit track. The box literally
says "not ready for production", and it used to ship to production anyway,
because only the event name was consulted. Same grammar as iOS: prerelease
means testers, clearing the box means everybody.

The app is public — [listing](https://play.google.com/store/apps/details?id=network.thetech.fleetwright) —
so a merge no longer lands somewhere private. Open testing is the right place
for it: real installs, on real phones, without a hand-maintained list, and one
deliberate act still standing between a merge and the public.

Both are repository variables, so moving a track is a setting rather than a
change to the workflow — `PLAY_COMMIT_TRACK` (unset means `beta`) and
`PLAY_RELEASE_TRACK` (unset means `production`).

`PLAY_ROLLOUT` stages a production release rather than shipping it whole
(`0.1` = 10%), and only applies to a release. It is unset on purpose: a staged
rollout has to be **finished by hand in the console**, so defaulting to one
leaves every release permanently half-shipped by a pipeline reporting success.

Every track above internal goes through Google review, so nothing here is
instant. On production that slowness is the last chance to notice.

| what | where |
|---|---|
| `PLAY_SERVICE_ACCOUNT_JSON` | a GitHub secret. Play Console → Setup → API access → create a service account, grant it **Release manager**, download the JSON key |
| The app record | Play Console → Create app. Name **Fleetwright**, package `network.thetech.fleetwright` |
| The first upload | **by hand.** Play asks for the content rating, the data safety form and the target audience on a first release, and no API can answer those for you |
| An open testing track | Play Console → Testing → Open testing. A merge cannot publish to a track that does not exist |

Unset the secret and the job warns and skips, like every other credential here.

### The listing

Open testing and production both need a **full store listing** — unlike internal
testing, where people install from a link and never see a store page. Plus the
512 icon and the App content declarations, which apply to every track:

| | |
|---|---|
| Privacy policy | `https://fleet.thetech.network/privacy` |
| Ads | none |
| Data safety | changed when sign-in and push landed — the email address is collected and linked to the user, for app functionality. [`store-listing.md`](../apps/android/store/store-listing.md)'s "Data safety" section is the one source for these answers; do not fill the form from here |
| Content rating | utility, no user-generated content, no communication → Everyone |
| Target audience | **18+**, which keeps the Families policy and its extra review out of it |

`apps/android/store/` has the icon and the feature graphic, both generated by
`tools/make-app-icon.py`, and the phone screenshots, which came from a running
app because inventing them would be inventing the product.

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

### These are ORG secrets, shared with ajar-family

Fleetwright and `ajar-family` are both in Apple team `2BPX4R682U` and **share
its certificate cap.** Apple caps distribution certificates per team, so if each
repo mints its own CI certificate they revoke each other's — and a revoked
certificate invalidates every provisioning profile bound to it. That is the exact
failure this arrangement exists to stop repeating.

So the credentials that are identical for both repos live **once**, as
organisation secrets on `TheTechNetwork` (visibility: *selected*, granted to
`ajar-family` and `Fleetwright`). Both repos' workflows read the same names:

| org secret | where it comes from |
|---|---|
| `ASC_ISSUER_ID` | App Store Connect → Users and Access → Integrations → App Store Connect API |
| `ASC_KEY_ID` | the key's ID, on the same page |
| `ASC_KEY_P8` | the **contents** of the `AuthKey_XXXX.p8` file (downloadable once). **Raw PEM, not base64** — the workflow does `printf '%s' "$ASC_KEY_P8" > AuthKey.p8`, so base64 would write a file that is not a key and fails at upload with nothing pointing at the cause |
| `APPLE_DIST_P12` | `base64 -w0 distribution.p12` — this IS base64 (it is binary) |
| `APPLE_DIST_P12_PASSWORD` | the `.p12` export password. Use a **hex** password: base64 can contain `/` and `+`, which get mangled between a GitHub secret and `security import -P` |

| org variable | where it comes from |
|---|---|
| `APPLE_TEAM_ID` | Membership details, a 10-character string (`2BPX4R682U`). A **variable**, not a secret — it is public — so the workflow reads `${{ vars.APPLE_TEAM_ID }}` |

The provisioning profile is the **one Apple credential that stays repo-level**:

| repo secret | where it comes from |
|---|---|
| `APPLE_PROVISIONING_PROFILE` | the App Store profile for `network.thetech.fleetwright`, base64. Bound to this bundle id and meaningless in any other repo, so it is not shared |

> **A repo secret SHADOWS an org secret of the same name.** If a stale
> repo-level copy of `ASC_KEY_ID` (etc.) is left behind, the workflow silently
> uses it instead of the org secret — so the org secret can be wrong and CI still
> passes, right up until the local copy drifts. After a green run on the org
> secrets, **delete the repo-level copies** of `ASC_KEY_ID`, `ASC_ISSUER_ID`,
> `ASC_KEY_P8`, `APPLE_DIST_P12`, `APPLE_DIST_P12_PASSWORD` and the
> `APPLE_TEAM_ID` variable. Keep only `APPLE_PROVISIONING_PROFILE`.

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
keychain per job. As **org secrets** now (see above), because that one
certificate is shared with `ajar-family` — the whole point is that the team has
a single distribution certificate rather than one per repo racing to revoke each
other:

| org secret | what it is |
|---|---|
| `APPLE_DIST_P12` | `base64 -w0 distribution.p12` |
| `APPLE_DIST_P12_PASSWORD` | the export password. **Hex**, per the note above |

> **Do NOT create a new distribution certificate.** Reuse the existing shared
> one. Minting another consumes the team's cap and, once the cap is hit, forces a
> revocation that invalidates a profile somewhere — which is the bug this shared
> arrangement is fixing. If a profile has already been invalidated by a
> revocation, do not mint a cert to fix it: run the
> **iOS — recreate provisioning profile** workflow, which rebinds the profile to
> the certificates that are still valid.

No Mac is needed to make the `.p12` (only ever done once, to seed the shared
secret):

```sh
openssl req -new -newkey rsa:2048 -nodes -keyout distribution.key -out distribution.csr \
  -subj "/CN=Fleetwright Distribution/C=US"
# upload the .csr as an Apple Distribution certificate, download the .cer
openssl x509 -in distribution.cer -inform DER -out distribution.pem -outform PEM
openssl pkcs12 -export -legacy -inkey distribution.key -in distribution.pem -out distribution.p12
```

**`-legacy` is not optional.** OpenSSL 3 defaults to a SHA-256 MAC and AES-256-CBC,
which macOS cannot read — and `security import` reports that as *"MAC
verification failed (wrong password?)"*, which is a lie in the most expensive
direction. Check before uploading it; `MAC: sha1` is what you want:

```sh
openssl pkcs12 -in distribution.p12 -info -nokeys -passin pass:… 2>&1 | grep MAC:
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
| **external** | any **published GitHub release**, prereleases included | assigned to the external group, then submitted for Beta App Review |
| **the App Store** | only a **full release** (prerelease box clear) | App Store version created, build attached, submitted for App Review |

External is not every commit on purpose. Those testers are the public, Apple
reviews the first build, and a release is a decision somebody made — which is
the right shape for a delivery real people install.

The prerelease box is the whole staging mechanism: mark a release as a
prerelease and it stops at external TestFlight; publish one with the box clear
and the same pipeline goes all the way to the store. One flag, GitHub's own,
meaning exactly what it says. Unticking the box on an existing release does
**not** promote it — the workflow fires on `published`, and an edit is not a
publish. Promotion is a new release, which also gets a new build number, which
is what App Store Connect requires anyway.

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

### The App Store — production on a full release

`tools/appstore-release.mjs` runs on a full release (prerelease box clear),
after the same upload the TestFlight jobs use. It waits for the build to
process, creates the App Store version — named by the build's own version
train, i.e. `MARKETING_VERSION` at the tagged commit, read back from the build
so the two cannot drift — attaches the build, carries the release body over as
"What's New in This Version", and submits the version for App Review.

`releaseType` is **AFTER_APPROVAL**: when Apple approves, it is live. The same
choice as not defaulting `PLAY_ROLLOUT` — a shipment the pipeline cannot
finish is a shipment it should not start, and "approved but waiting for a
click nobody knows they owe" is that in different clothes. A phased release,
if ever wanted, is a checkbox on the version in App Store Connect and does not
change this job.

Re-runs are safe, and are the recovery for everything slow or rejected:

- build still processing after 45 minutes → **warning, green**, re-run later;
- version exists and is editable (including **rejected** — fix, publish a new
  release or re-run) → reused, newest build attached;
- version already waiting for or in review → says so, green, done;
- version already **on the store** → the one real refusal: bump
  `MARKETING_VERSION` in `apps/ios/project.yml` and publish a new release.

**The first submission fails until the listing exists**, and that is Apple
naming decisions no API should make. Once, by hand, in App Store Connect, on
the version page:

| | |
|---|---|
| Description, promotional text, keywords, support URL | written for the store page |
| Screenshots | 6.9" and 6.5" iPhone at minimum; from a running app, like the Play ones |
| Privacy policy URL | `https://fleet.thetech.network/privacy`, same as Play |
| App Privacy | same answers as Play's data safety form, and from the same single source: [`store-listing.md`](../apps/android/store/store-listing.md)'s "Data safety" section (email address collected, linked, app functionality) |
| Age rating | the questionnaire; utility, no user-generated content → 4+ |
| Category | Developer Tools |
| Pricing and availability | free, all territories — set once, outlives versions |

After a rejection the version drops back to editable: address the review
notes, then re-run the job (same build) or publish a fresh release (new
build). Nothing needs to be re-typed — the listing fields persist across
versions.

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

`google-services.json` lives in `apps/android/app/` and is **committed,
deliberately** — it is not a secret (it ships inside every APK) and treating it
as one would mean a repository nobody else can build; `apps/android/README.md`
carries the argument, including why gitignoring it would have been a silent
push failure.

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

The floor is `contents: read`. The jobs that raise their own:

| job | | why |
|---|---|---|
| `android.yml` — `release` | `contents: write` | `gh release upload` attaches the APK to the release |
| `codeql.yml` — all three | `security-events: write` | uploading results is the point of the workflow |
| `host-release.yml` — attach | `contents: write` | uploads the host tarball and manifest to the release |
| `sandbox.yml` | `packages: write` | pushes the session image to GHCR |

## What to set up first

1. **Nothing.** Open a PR and the iOS build, the Android debug APK, the Worker
   bundle check and CodeQL all run. That alone verifies the thing that has never
   been verified.
2. **Cloudflare**, two secrets — the coordinator deploys on merge to main and
   the phone has something to talk to.
3. **Firebase**, when you want notifications to actually arrive.
4. **Apple and Android signing**, when you want TestFlight and a signed APK.

## iOS signing: nothing is minted at build time

An ephemeral runner has an empty keychain. `-allowProvisioningUpdates` reacts
to that by asking Apple for whatever is missing — which is fine once and fatal
on the fiftieth run:

```
error: Choose a certificate to revoke. Your account has reached the
       maximum number of certificates.
error: No profiles for 'network.thetech.fleetwright' were found:
       ... any iOS App Development provisioning profiles ...
```

**The second line is the tell.** An archive should never be looking for a
*development* profile. `CODE_SIGN_STYLE=Automatic` let Xcode choose the
identity and it chose Apple Development, so the Apple **Distribution**
certificate the workflow had just imported did not satisfy it — and the build
went and asked Apple for a development certificate instead. Every run. Until
the account filled up.

Importing the certificate was a real fix for a real bug and it did not fix
this one, because it addressed *which* assets exist rather than *whether the
build is allowed to create them*.

So both halves are now nailed down:

| | |
|---|---|
| `CODE_SIGN_STYLE=Manual` | nothing is chosen at build time |
| `CODE_SIGN_IDENTITY="Apple Distribution"` | and it is the identity we imported |
| `PROVISIONING_PROFILE_SPECIFIER` | read out of the profile, never typed twice |
| no `-allowProvisioningUpdates` | nothing **can** be minted, on archive or export |

The worst case is now a build that fails, rather than a build that fails **and**
leaves the account one certificate closer to unusable.

### Three secrets, and the job skips without all three

`ASC_KEY_P8` (org), `APPLE_DIST_P12` (org), `APPLE_PROVISIONING_PROFILE` (repo).
The gate used to check only the first and fall back to automatic signing for
the rest — which is precisely the fallback that burned the certificates.
Skipping costs a release; minting costs the ability to release at all, and
takes a trip to the developer portal to undo.

### Making the profile

Once, in the developer portal — Certificates, Identifiers & Profiles →
Profiles → **App Store Connect** distribution, for `network.thetech.fleetwright`,
signed by the same certificate that is in `APPLE_DIST_P12`. Download it
and:

```sh
base64 -i Fleetwright_App_Store.mobileprovision | pbcopy   # → APPLE_PROVISIONING_PROFILE
```

The workflow prints the profile's name, app id and **expiry** on every run.
Profiles expire after a year, and an expired one fails with a message about
identities rather than about dates — so the date is printed where it will be
read.

### When a revoked certificate invalidates the profile

A profile names the specific distribution certificates it trusts, and it is
**immutable** — the App Store Connect API has create and delete, no edit. So when
a distribution certificate is revoked (freeing a slot in the team's shared cap),
every profile bound to it turns INVALID, and signing fails with the same "No
profiles for 'network.thetech.fleetwright' were found" as a missing profile.

Do **not** fix this by minting a new certificate — that is what fills the cap.
Instead run **Actions → iOS — recreate provisioning profile** (type `recreate`
to confirm). It uses the shared `ASC_*` org key to delete `Fleetwright Profile`
and recreate it bound to **every** distribution certificate that is still valid,
then verifies it comes back `ACTIVE` with `GET /v1/profiles`. Binding to all of
them means a future revocation of any single certificate leaves the others still
covering the profile. Source: `tools/recreate-ios-profile.mjs`.

That workflow cannot write secrets (the proxy blocks the GitHub secrets API, and
a profile's bytes cannot be read back out of App Store Connect), so after it runs
download the recreated profile from the portal and refresh
`APPLE_PROVISIONING_PROFILE` by hand, exactly as in *Making the profile* above.

### If the account is already full

Revoke the surplus in the portal under Certificates. The ones CI created are
useless anyway: their private keys were on runners that no longer exist, so
nothing can sign with them and nothing is lost by revoking them. Keep the one
whose `.p12` is in the secret.

