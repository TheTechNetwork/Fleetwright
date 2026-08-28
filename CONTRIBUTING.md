# How changes ship

## Feature rounds are stacked PRs, split by layer

One feature, one stack — each PR is a layer, based on the one below it, merged
bottom-up:

```
#N    coordinator / worker     deployable alone; the API the rest talks to
#N+1  host (sidecar, hub)      based on #N
#N+2  iOS                      based on #N+1 (or #N when the host is untouched)
#N+3  Android                  same
#N+4  docs / roadmap status    last, so it describes what actually merged
```

Why this shape, learned the expensive way:

- **Commit every layer first; open every PR together.** Branches are built,
  verified and pushed as the round progresses, and the PRs for all of them
  open in one batch when the round is complete. Opening them one at a time
  invited the failure this rule replaced: a base merged mid-build, and half a
  round stranded on a deleted branch.
- **Each layer is deployable when it merges.** The layer above it is stacked,
  visible, and reviewable from the moment the batch opens — "the apps ride in
  the next PR" with nothing visible reads as "not shipped", because it is
  indistinguishable from it.
- **A PR branch is final the moment its link is posted.** Merges happen
  mid-conversation here. #138 was merged between two pushes and main silently
  took half of an outage fix; the deploy that "ended the outage" did not
  contain the fix. Anything after the link is a new PR on the stack.
- **Layers keep the blast radius honest.** The Swift and Kotlin compile only
  in CI, so app layers carry compile risk the coordinator layer must not wait
  on — and a coordinator fix must not be hostage to an Xcode error.

Skip layers a round does not touch. A docs-only change is one PR. A protocol
version bump is the exception: everything it strands ships in ONE coordinated
round, because `PROTOCOL_VERSION` is exact-match and the flag day is paid once
(see `docs/plan.md`).

## The gates

- `./scripts/verify.sh` green before every commit — it is the gate that can
  actually fail, and "SOMETHING FAILED — do not commit" means exactly that.
- The Worker's behaviour is proven in workerd (`worker/test/live.test.js`),
  not inferred from Node. The outage lived entirely in the gap between the
  two runtimes.
- `ROADMAP.md` is the index of everything asked for. A feature that is not on
  it is a feature that will get lost; statuses update in the docs layer of the
  round that changes them.
