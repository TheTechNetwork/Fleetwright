# What runs, and when

A publish that fires when it should not costs a build number, a review cycle,
and a tester's attention on an app they already have. One that fails to fire
costs more, and says nothing while doing it — which is how the Android publish
job sat skipped and green for weeks.

So this is the table, kept where it can be checked rather than inferred from
the workflow files.

| event | runs |
|---|---|
| **pull request** | tests, coverage, typecheck, CodeQL, worker `check`, iOS and Android builds if that app changed. Nothing publishes, ever. |
| **push to main** | the above, plus: Worker deploy (if the Worker or `src/fleet` changed), TestFlight **internal** and Play's commit track — `PLAY_COMMIT_TRACK`, default `beta`, which is **open testing** (each if that app changed) |
| **prerelease published** | TestFlight **external** and the same Play commit track — a rehearsal of the release path in front of testers, not everybody |
| **release published** | Play **production** and the App Store, after review — plus the signed APK and the host package attached to the GitHub release |
| **workflow_dispatch** | build, sign, and publish to the commit track — dispatching by hand is a test of the pipeline, on the track a merge would have used |
| **schedule** | CodeQL, weekly |
| **merge queue** | the whole of `ci.yml` and `worker.yml`, against main plus everything ahead of the pull request in the queue — see "Two questions a pull request cannot answer" below |

## The rules underneath it

**A publish needs a changed artifact.** `apps/ios/**` and `apps/android/**` gate
the app workflows, and `!**/*.md` excludes documentation inside them — a README
under `apps/ios` used to build, sign, upload and spend a build number to hand
testers a byte-identical app.

**A deploy needs a changed deployment.** `worker.yml` had **no filter at all**,
so every commit to main redeployed the Worker, documentation included. Its
filter is deliberately wider than `worker/**`: `worker/src/fleet-do.js` imports
`CoordinatorCore`, the push senders and the OIDC verifier out of `src/fleet`,
because the same code runs in both coordinators. The cost of that arrangement is
that changing `src/fleet` changes the Worker, so the filter has to say so. A
filter naming only `worker/**` would quietly stop deploying the half of the
Worker that lives somewhere else — much worse than deploying too often.

**And that filter is no longer maintained by hand, because it was wrong twice.**
It is a list of directories that has to stay in step with an import graph, and
an import graph moves when somebody adds a line at the top of a file — which is
not a moment anybody thinks about a workflow.

| | what happened |
|---|---|
| `src/core` | the protocol module started importing `text.js` and `names.js`. Caught by somebody noticing. |
| `src/mcp` | `worker.js` mounts the remote MCP server's routes, so six files under `src/mcp` are compiled into the deployed Worker. The filter never named them, and **it cost a deploy**: `0d3f8af` (*"Say which origin, because Google will not"*, #291) changed `src/mcp/authorize-page.js` and otherwise only `docs/` and `test/`, so `worker.yml` never ran and production kept the old code until an unrelated commit happened to redeploy it. |

A missed deploy is the quietest failure in this repository. Nothing is red, no
job is visibly skipped, and the coordinator serves last week's code while main
says otherwise.

`scripts/check-worker-filter.mjs`, in `verify.sh`, asks **esbuild** which files
are in the bundle — `--metafile` on the same invocation the `worker` line
bundles with — and fails when `on.push.paths` does not name one of them. It also
checks that the `changes` job's shell gates on every directory the trigger
names, since those two lists are written twice and answer the same question.

**The root suite is not scoped at all any more, and that is a correction.**
`ci.yml` used to carry
`paths-ignore: ['**/*.md', 'docs/**', 'apps/**', 'sandbox/**', 'LICENSE']`, on
the grounds that a filtered trigger was safe while nothing was a required
status. That was the wrong risk to be measuring. The filter did not only skip a
check nobody required — **it skipped the tests that guard the files it was
skipping for:**

| skipped | what did not run |
|---|---|
| `apps/**` | **twenty-two** test files in `test/` read the Swift and the Kotlin. They are the parity suite: both phones say the same five things in the same order (`reassurance.test.js`), both carry the same verbs, both compute `quietFor` and both show it. The app workflows *compile* the app; nothing else asserts any of that. So the one change those tests exist for — an edit to an app — was the one change that did not run them. |
| `docs/**` | `install-node-floor.test.js` reads `docs/deployment.md` and asserts the Node floor it states matches `package.json`. Editing that document alone skipped the test whose entire subject is that document. |
| `sandbox/**` | `verify.sh` parses `entrypoint.sh` and `tool-shim.sh`; `sandbox.yml` only ever built the image. A sandbox-only change reached main with its shell read by nothing. |

That is one failure in three places, and it is not fixable by writing a
cleverer filter — a filter has to know which tests read which files, and it
learns that a year late, from a bug. The root suite is 21 seconds. It runs.

**The expensive filters stay exactly where they are.** A macOS runner, a build
number and a Cloudflare deploy are the cases where the answer to "if this does
not run, does anybody find out?" is *yes* — the app workflows report on the
pull request themselves — and where running twice costs something real.
`worker.yml`'s filter also moved off the trigger into an if-gated `changes`
job, so a skip is a visible "skipped" rather than a missing answer; its list is
the same one the deploy uses, word for word, because the two answer the same
question.

CodeQL gates **every** language per pull request through its own `changes` job
— the compiled two by their app trees, `actions` by workflow changes, and
`javascript-typescript` by "anything that is not purely prose". Main pushes and
the weekly schedule always run it in full, so the alert baseline is never built
from a partial view.

**Two events, two audiences, on both platforms.**

| | push to main | release published |
|---|---|---|
| iOS | TestFlight **internal** | TestFlight **external** |
| Android | Play **open** testing (`PLAY_COMMIT_TRACK`, default `beta`) | Play **production** (`PLAY_RELEASE_TRACK`, default `production`) |

Android used to publish on both events to the *same* track, which made the
second one a duplicate: the same app to the same testers with a different
version code and a hole in the sequence. The fix is not to remove a trigger but
to make the two events mean different things, which is what iOS already did.

**The distinction is who is on the other side.** Open testing is anybody who
finds the Play listing and taps join; production is anybody who finds the Play
listing. That is a smaller gap than it sounds, and it is the right one to put a
release across rather than a merge. A merge happens because a branch was ready,
and *"ready to merge"* is not the same decision as *"ready for everybody who
already has it installed"* — so the wider audience needs an act with a person
behind it, and publishing a release is that act.

**Tag pushes are deliberately not a trigger.** A GitHub release is made *from* a
tag, so a tag push fires both `push: tags` and `release: published` — two runs,
two version codes, two production releases minutes apart with the second
silently replacing the first. The release event is also the only one carrying
notes, and on production those notes are public. A bare tag with no release is
not a shipment; it is a bookmark.

A release also attaches the signed APK to the GitHub release, which is the thing
somebody sideloads and a store upload does not provide.

Both tracks are repository variables, so moving one is a setting rather than a
pull request:

```sh
gh variable set PLAY_COMMIT_TRACK --body alpha  # what a merge reaches
gh variable set PLAY_RELEASE_TRACK --body beta  # what a release reaches
```

`PLAY_ROLLOUT` stages a production release instead of shipping it whole
(`0.1` = 10%). **Unset on purpose**: a staged rollout has to be finished by hand
in the console, and a default that leaves every release half-shipped by a
pipeline reporting success is worse than no staging at all.

**Main runs are never cancelled.** `cancel-in-progress` is on for pull requests
only. A cancelled PR run is waste; a cancelled main run is something that did
not ship while reporting nothing wrong.

## Two questions a pull request cannot answer

Both are about the gap between "green" and "safe to merge", and both are now
closed by something other than a test.

**Does it still pass against the main it will land on?** A pull request is
built against the base it branched from. Two of them, each green, can be red
together — and this repository merges **stacked** pull requests bottom-up
(`CONTRIBUTING.md`), which is that situation deliberately: `#N+1` is based on
`#N`, and the moment `#N` merges, `#N+1`'s green tick describes a main that no
longer exists.

`ci.yml` and `worker.yml` both listen for `merge_group` now, so a merge queue
runs them against main *plus everything ahead of this pull request in the
queue*, immediately before it lands. Enabling the queue is a repository
setting; the workflows are ready for it either way.

**Is there anything the tests never looked at?** A green suite proves the tests
that exist still pass. It says nothing about the lines no test reaches, and
that is where the bugs in this repository's history actually lived.
`scripts/check-coverage.mjs` records per-file line coverage in
`test/coverage-floor.json` and fails a change that executes **less** of a file
than the last one did. A ratchet rather than a target: it never argues about
whether 80% is enough, and it never lets the untested surface quietly grow. It
runs inside `verify.sh`, so it is the same check locally and in CI.

## Changing any of this

Two questions, in order:

1. **If this job does not run, does anybody find out?** If the answer is no, it
   must not be filtered — a silent skip is worse than a wasted minute.
2. **If it runs twice, what does it cost?** For a publish that is a duplicate
   build in front of real people. For a test it is a minute.

Filters are cheap where the answer to 1 is yes and the answer to 2 is
expensive — which is exactly the app and Worker publishes, and nothing else.
