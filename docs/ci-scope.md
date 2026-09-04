# What runs, and when

A publish that fires when it should not costs a build number, a review cycle,
and a tester's attention on an app they already have. One that fails to fire
costs more, and says nothing while doing it — which is how the Android publish
job sat skipped and green for weeks.

So this is the table, kept where it can be checked rather than inferred from
the workflow files.

| event | runs |
|---|---|
| **pull request** | tests, typecheck, CodeQL, worker `check`, iOS and Android builds if that app changed. Nothing publishes, ever. |
| **push to main** | the above, plus: Worker deploy (if the Worker or `src/fleet` changed), TestFlight **internal** and Play's commit track — `PLAY_COMMIT_TRACK`, default `beta`, which is **open testing** (each if that app changed) |
| **prerelease published** | TestFlight **external** and the same Play commit track — a rehearsal of the release path in front of testers, not everybody |
| **release published** | Play **production** and the App Store, after review — plus the signed APK and the host package attached to the GitHub release |
| **workflow_dispatch** | build, sign, and publish to the commit track — dispatching by hand is a test of the pipeline, on the track a merge would have used |
| **schedule** | CodeQL, weekly |

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

**Everything is scoped, because nothing is required.** This repository has no
branch protection and no required status checks (confirmed 2026-08-28), so
trigger-level paths filters are safe everywhere: `ci.yml` ignores prose, apps
and the sandbox; `worker.yml` runs only when something in its bundle changed —
which includes `src/core/**`, because the protocol module imports from it;
and CodeQL gates **every** language per pull request through its `changes`
job — the compiled two by their app trees, `actions` by workflow changes, and
`javascript-typescript` by "anything that is not purely prose".

**The standing rule if protection is ever enabled:** a filtered trigger reports
*no status*, which blocks a required check forever. The moment any of these
becomes required, its filter moves from the trigger to an if-gated `changes`
job (codeql.yml is the template), so a skip is a visible "skipping" instead of
a missing answer. Main pushes and the weekly schedule always run CodeQL in
full, so the alert baseline is never built from a partial view.

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

## Changing any of this

Two questions, in order:

1. **If this job does not run, does anybody find out?** If the answer is no, it
   must not be filtered — a silent skip is worse than a wasted minute.
2. **If it runs twice, what does it cost?** For a publish that is a duplicate
   build in front of real people. For a test it is a minute.

Filters are cheap where the answer to 1 is yes and the answer to 2 is
expensive — which is exactly the app and Worker publishes, and nothing else.
