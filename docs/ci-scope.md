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
| **push to main** | the above, plus: Worker deploy (if the Worker or `src/fleet` changed), TestFlight **internal** (if the iOS app changed), Play **testing track** (if the Android app changed) |
| **release published** | TestFlight **external**, after review — and the signed APK attached to the GitHub release. **Not** a second Play upload. |
| **workflow_dispatch** | build, sign and publish, the same as a push to main |
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

**One publish per shipment.** Android used to publish on a push to main *and* on
`release: published`, both to the same track — so cutting a release sent testers
the same app twice with a hole in the version-code sequence. Only the merge
publishes now. A release still attaches the signed APK to the GitHub release,
which is the thing somebody sideloads and the store upload does not provide.

iOS deliberately keeps both, because there the two events mean different things:
a merge goes to **internal** TestFlight, a release goes to **external**, and
Apple's review sits between them. Two audiences and a decision, not a duplicate.

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
