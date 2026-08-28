# Packaging a host

Today a host is a **git checkout of the whole monorepo**, and `/update` is
`git pull`. That was right when the repository was one thing. It is now two
apps, a Worker, a coordinator, a sandbox image and documentation — and a host
runs a fraction of it.

## What is wrong with a checkout

**A host is told about work that is not its own.** `rev-list HEAD..@{upstream}`
counted every commit, so a README edit made every box report "1 commit behind",
and `/update --restart` bounced three services to deliver a paragraph. Scoping
the count to `HOST_PATHS` fixes the lie (shipped), but the *shape* is still
wrong: the box is still tracking a branch that mostly is not about it.

**There is no version to name.** "Which version is deb132 on?" answers with a
commit hash, which is precise and says nothing. A box cannot be pinned, a
rollback is `git checkout <sha>`, and two boxes on the same feature can be on
different trees.

**Updating is a build.** `git pull` plus `npm ci` on the box means every host
needs git, npm, a network path to the forge and the registry, and enough disk
for the whole history. A packaged host needs none of that.

**The tree is writable and therefore drifts.** Everything in `/opt/agent-fleet`
can be edited in place, which is occasionally useful and permanently a source
of "works on that box only".

## What replaces it

**A versioned tarball containing exactly `HOST_PATHS`**, published by CI on
merge, with a manifest:

```json
{
  "version": "2026.08.29-1",
  "url": "https://.../fleetwright-host-2026.08.29-1.tar.gz",
  "sha256": "…",
  "minSandboxImage": "sha256:…",
  "protocol": 2
}
```

- **`HOST_PATHS` is already the manifest.** It lives in `src/core/update.js`
  today because that is where it could act; the package is built from the same
  list. Getting it right early is work that carries forward.
- **`protocol` in the manifest** lets a host refuse an update that would strand
  it from its coordinator, instead of discovering the mismatch afterwards. The
  version is exact-match; the flag day should be visible *before* it happens.
- **`minSandboxImage`** ties the two artifacts together. They are already
  coupled — the entrypoint and the credential seeding live in the image — and
  today nothing says so.

**Install is atomic.** Unpack beside the current release, verify the digest,
swap a symlink, restart:

```
/opt/fleetwright/releases/2026.08.29-1/
/opt/fleetwright/current -> releases/2026.08.29-1
```

A failed download changes nothing. A rollback is one symlink. Two boxes on the
same version are byte-identical, which "the same commit" never quite promised
once `npm ci` was involved.

## The order to do it in

1. **Path-scoped "behind"** — shipped. Hosts stop reporting updates that are
   not theirs, and stop restarting for them.
2. **Publish the tarball and manifest in CI**, alongside the current git flow.
   Nothing consumes them yet; they can be wrong without hurting anybody.
3. **Teach `/update` the manifest**, preferring it and falling back to git. One
   box at a time, and the fallback is the thing that makes that safe.
4. **Switch the installer** to fetch a release rather than clone, keeping
   `--from-source` for development boxes.
5. **Drop the git path** once no box reports using it.

Steps 2 and 3 are where the value is: after those, a docs change publishes
nothing, and a host update is a download and a symlink.

## What this does not solve

**The sandbox image is a second artifact** and stays one. It is versioned by
digest, refreshed by `/update` and by a session start, and `minSandboxImage`
is how a host release says which one it needs. Merging them would mean
shipping a container layer to update a JavaScript file.

**Development boxes still want the checkout.** `--from-source` keeps that, and
the fallback in step 3 means the two can coexist indefinitely rather than
needing a flag day of their own.
