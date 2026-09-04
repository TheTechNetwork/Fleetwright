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
   **Done** — `release.js` decides, `release-apply.js` fetches and swaps, and
   `/update` branches on which kind of install it is. The git path is
   untouched, which is what makes it a fallback rather than a second
   implementation.
4. **Switch the installer** to fetch a release rather than clone, keeping
   `--from-source` for development boxes. **Half done** — `install.sh` detects
   which shape it is running from (`lib/agent-hub.mjs` exists or it does not),
   skips npm entirely when packaged, and removes the install it replaced. What
   is not done is the FIRST install: a box still gets its first release
   unpacked by hand, and updates itself by manifest from then on. The
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

## Updating, in one order that does not change

```
1. ask the manifest, and decide          protocol, then version
2. download
3. VERIFY THE DIGEST                     before anything is unpacked
4. unpack into staging                   a name that is not a version
5. RUN IT ONCE                           the last moment this is free
6. move the symlink                      atomic
7. prune, keeping the one before
```

**Every step before 6 is reversible by doing nothing.** That is the property to
preserve when editing `release-apply.js`: a failure at 1–5 leaves the box
exactly as it was, and a failure after 6 leaves the previous release on disk to
point back at.

Step 5 is the one that is easy to leave out. A bundle built against a newer
Node, or broken in a way a digest cannot see, fails there — where the running
box is still untouched — instead of after the swap, where systemd restarts the
corpse every three seconds and the box is unreachable by the tool that would
fix it.

Step 1 checks **protocol before version** so a host one flag day behind is told
that, rather than told it is up to date. And it downloads nothing on a
mismatch: there is no point spending bandwidth on a release that is going to be
refused.

### What the digest proves, and what it does not

It proves the bytes are the bytes the manifest named — corruption, a truncated
download, a cache serving something stale.

**It does not prove the manifest is honest.** The manifest is fetched over the
same TLS connection from the same host, so whoever serves it chooses what a box
installs. That is the same trust as the git remote it replaces, bounded the
same way: by who can write to that host. Signing the manifest is the thing that
would change it, and it is not built.

### Configuring it

```sh
AGENT_HUB_RELEASE_MANIFEST=https://releases.example/fleet/manifest.json
```

The tarball is fetched **relative to the manifest's own URL**, so one setting
cannot point at another deployment's build, and moving a release host is one
value rather than two that have to agree.

Unset on a checkout, which updates by git and always will.

## Channels and staged rollouts

Two fields on the manifest, both defaulting to "everybody", so a release built
without thinking about either behaves exactly as releases always have.

```json
{ "prerelease": true, "rollout": 0.25 }
```

**`prerelease` is opt-in per host.** `AGENT_HUB_RELEASE_CHANNEL=prerelease`
takes them; the default `stable` skips them. That is the point of marking a
release: it reaches the machines somebody chose to expose, so a bad build is
found before the whole fleet takes it. CI sets the field from GitHub's own
prerelease checkbox — the same box that decides TestFlight-only versus the App
Store — so the manifest cannot disagree with the release. A build from a push
to `main` is a prerelease by definition: nobody published it.

**`rollout` is a fraction, and the host decides only where it falls.**
`rolloutPosition(hostKey, version)` maps a machine into `[0, 1)`, and the host
takes the release if it lands under the line. No coordinator involvement, no
list of who has it, nothing to keep in sync — a box can work this out offline.

Three properties it has to have, and each one is a test:

- **Widening only ever adds.** A host that qualified at 25% still qualifies at
  50%, or raising a rollout would take a release away from machines that had it
  and the fleet would oscillate.
- **Each release reshuffles who leads.** The version is in the key, so the same
  boxes do not take every risk while others never see a release until it is
  proven. This is why the hash needs a finaliser: without one, `v2.0.0` and
  `v2.0.1` put 37 of 38 hosts in the same order, because FNV moves a one-bit
  change into the low bits and the position is the high ones.
- **A host with no stable name waits for 100%.** Guessing a position would move
  it between rollouts at random; the fraction only ever rises, so waiting is the
  answer that cannot be wrong.

FNV-1a with MurmurHash3's `fmix32`, not SHA-256 — nothing here is secret, and
both a Worker and a Node process must compute it identically without an
`await`. `crypto.subtle` is async and would make the whole decision async for a
guarantee nobody needs.

The rollout comes from a repository variable (`RELEASE_ROLLOUT`), so widening
one is a setting somebody changes rather than a commit.

### Two addresses, and the channel picks one

| Channel | `AGENT_HUB_RELEASE_MANIFEST` | What it gets |
|---|---|---|
| `stable` (default) | `.../releases/latest/download/manifest.json` | Published releases only. GitHub's `latest` pointer skips prereleases, so this address cannot serve a main build even by accident |
| `prerelease` | `.../releases/download/main/manifest.json` | The newest build of `main`, replaced on every merge |

**The prerelease channel is `main`, not "a release somebody marked".** CI has
built a host package on every push for weeks and uploaded it as a workflow
artifact — which expires and has no stable URL, so nothing could poll it. A
rolling release at a fixed tag gives it a permanent address whose contents are
replaced on every merge.

**It is still a package, not a pull.** The box fetches a tarball, checks the
sha256 *before* unpacking, unpacks beside what is running, and moves a symlink.
Identical mechanism to a published release; only the address differs. The git
path stays what `docs/packaging.md` has always called it — a fallback, kept
untouched so it remains one.

**The channel MOVES the address; the installer does not have to.** A box is
installed pointing at the stable manifest, and `manifestUrlFor` derives the
other address from it by recognising GitHub's two release paths. Filtering the
manifest without moving the URL would have been the trap: `releases/latest/download`
skips prereleases by GitHub's own definition, so a box switched to `prerelease`
would have reported the new channel and gone on taking stable builds forever.
A URL matching neither shape — a mirror — is left alone, and `/channel` says
so rather than letting somebody discover it from a box that never updates.

**The URL selects and the flag verifies.** A stable host pointed at the main
manifest by hand is still refused, because the manifest says `prerelease: true`
and `decideRelease` checks the channel. Two independent mistakes have to line
up for a stable box to take an unreleased build.

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
