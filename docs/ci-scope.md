# What runs, and when

A publish that fires when it should not costs a build number, a review cycle,
and a tester's attention on an app they already have. One that fails to fire
costs more, and says nothing while doing it — which is how the Android publish
job sat skipped and green for weeks.

So this is the table, kept where it can be checked rather than inferred from
five workflow files.

| event | runs |
|---|---|
| **pull request** | tests, typecheck, CodeQL, worker `check`, iOS and Android builds if that app changed. Nothing publishes, ever. |
| **push to main** | the above, plus: Worker deploy (if the Worker or `src/fleet` changed), TestFlight **internal** and Play **closed testing** (each if that app changed) |
| **release published** | TestFlight **external** and Play **open testing**, both after review — plus the signed APK attached to the GitHub release |
| **workflow_dispatch** | build, sign, and publish to the **closed** track — dispatching by hand is a test of the pipeline, and a pipeline test should not land in front of everybody with the link |
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

**Required checks are never filtered.** `ci.yml` and `codeql.yml` have no paths
filters, and `worker.yml` has none on pull requests. A check that skips itself
reports no status, and no status reads as "nothing found" rather than "not run".

**Two events, two audiences, on both platforms.**

| | push to main | release published |
|---|---|---|
| iOS | TestFlight **internal** | TestFlight **external** |
| Android | Play **closed** testing (`PLAY_TRACK`, default `alpha`) | Play **open** testing (`PLAY_OPEN_TRACK`, default `beta`) |

Android used to publish on both events to the *same* track, which made the
second one a duplicate: the same app to the same testers with a different
version code and a hole in the sequence. The fix is not to remove a trigger but
to make the two events mean different things, which is what iOS already did.

**The distinction is who is on the other side.** Closed testing takes people by
email list or link and they chose to be there. Open testing is anybody who finds
the link. A merge happens because a branch was ready, and *"ready to merge"* is
not the same decision as *"ready for strangers"* — so the wider audience needs
an act with a person behind it, and publishing a release is that act.

A release also attaches the signed APK to the GitHub release, which is the thing
somebody sideloads and a store upload does not provide.

Both tracks are repository variables, so moving one is a setting rather than a
pull request:

```sh
gh variable set PLAY_TRACK --body internal        # closed side
gh variable set PLAY_OPEN_TRACK --body production # open side
```

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
