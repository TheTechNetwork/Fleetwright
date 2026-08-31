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
   **Built** — `tools/build-host-package.mjs`. Two builds of one commit are
   byte-identical (`--sort=name`, fixed mtime, no owner), which is what makes
   the digest a statement about the code rather than about a build machine.
3. **Teach `/update` the manifest**, preferring it and falling back to git. One
   box at a time, and the fallback is the thing that makes that safe.
   **Partly done** — `src/core/release.js` decides (protocol, version, digest,
   filename) and `updateStatus` now tells a packaged box what updates it instead
   of reporting a missing `.git`. What is not wired is the fetch-and-swap
   itself.
4. **Switch the installer** to fetch a release rather than clone, keeping
   `--from-source` for development boxes. **Half done** — `install.sh` detects
   which shape it is running from (`lib/agent-hub.mjs` exists or it does not),
   skips npm entirely when packaged, and removes the install it replaced. What
   is not done is FETCHING: a release still has to be unpacked by hand. The
   **layout** is done — a release is copied to `releases/<version>` and
   `current` is moved onto it atomically, with the units pointing at `current`.
5. **Drop the git path** once no box reports using it.

Steps 2 and 3 are where the value is: after those, a docs change publishes
nothing, and a host update is a download and a symlink.

## The layout is the rollback

```
/opt/fleetwright/releases/main-41/    the one before
/opt/fleetwright/releases/main-42/    unpacked, verified, complete
/opt/fleetwright/current -> releases/main-42
```

The units point at `current`, so applying a release is **one symlink** — no
daemon-reload, no edit to anything root owns, and no window where the tree a
running process is reading is being written to.

`ln -sfn` then `mv -Tf`, not `ln -sfn` alone: replacing an existing symlink in
place is not atomic on every filesystem, and a symlink that briefly does not
exist is a service that briefly cannot start.

A checkout install still runs where it sits. A checkout is a thing somebody
edits, and moving it under them would be its own kind of rude.

`releasesToPrune` keeps the live release **and the one before it**. A rollback
target that was tidied away is not a rollback target.

## What this does not solve

**The sandbox image is a second artifact** and stays one. It is versioned by
digest, refreshed by `/update` and by a session start, and `minSandboxImage`
is how a host release says which one it needs. Merging them would mean
shipping a container layer to update a JavaScript file.

**Development boxes still want the checkout.** `--from-source` keeps that, and
the fallback in step 3 means the two can coexist indefinitely rather than
needing a flag day of their own.

## What "compiled" would and would not buy

Worth writing down, because it is the natural thing to reach for and half of
the reason usually given for it is wrong.

**Obscurity: nothing.** A bundle is readable JavaScript and a Node SEA has the
same JavaScript inside it — `strings` gets you most of the way and an unpacker
gets you the rest. Shipping an executable does not hide the code, and anything
built on the belief that it does is built on sand.

**Integrity: a great deal, and this is the reason.** One artifact with one
sha256 is verifiable. A `node_modules` tree of thousands of files edited in
place is not — nobody notices a changed line in a transitive dependency on a
running host. That is what turns *"has this box been tampered with"* into a
question with an answer.

**No install-time execution.** npm runs lifecycle scripts from every package in
the tree. A release is unpacked and runs none of them, on a box whose whole
purpose is to be trustworthy.

**The same bytes everywhere.** "The same commit" never quite promised that once
`npm ci` was involved.

So the tarball is kept and a single-file executable is not pursued: it would add
an experimental Node feature and a platform matrix to buy the one property —
obscurity — that is worth nothing here.

## Migration is the requirement, not a step

> installing the new packaged version must allow users to migrate from current
> version and clean up

Every install is an upgrade. Boxes are already running the checkout layout, so
a release cannot behave as though it landed on a clean machine — and two
installs side by side is not harmless leftovers, it is a box where the next
update picks one and nobody can tell which is running.

What makes this a directory removal rather than a data migration: **nothing that
matters lives in the install directory.** The env files are in `/etc`, the
registry and credentials in `/var/lib/agent-hub`, the host key in
`/var/lib/agent-fleet`. The units are rewritten with `__DIR__` pointing at the
release, so the switch has already happened before anything is deleted.

Three rules the installer follows, in this order:

1. **The old unit files are copied before they are overwritten.** Their
   `ExecStart` is the only record of where the previous install lived.
2. **Nothing is removed until the new agent-hub has been SEEN to start.**
   Removing first would leave a box with neither.
3. **A working tree with uncommitted changes is never deleted.** It is reported
   instead, with the command to remove it. Deleting somebody's unsaved work to
   tidy a directory is not a trade an installer gets to make.
