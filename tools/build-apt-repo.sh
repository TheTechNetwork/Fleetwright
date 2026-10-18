#!/usr/bin/env bash
# Build the signed metadata of the fleetwright apt repository.
#
#   tools/build-apt-repo.sh <debs-dir> <out-dir> <gpg-key-id> [<rolling-dir>]
#
# <debs-dir> holds one directory per release tag, each with that release's
# debs:  <debs-dir>/v0.3.0/fleetwright_0.3.0_amd64.deb
#
# <rolling-dir>, when given, holds the debs of the `rolling` release, the
# newest builds of main: fleetwright_<base>.main.<run>_<arch>.deb (the `+` in
# the version is a `.` in the file name, which is how GitHub keeps it).
#
# <out-dir> gets ONLY what is served — dists/ and the public key — and never a
# package. The packages stay GitHub release assets, and the apt Worker
# (apt/src/index.js) serves pool/<tag>/<file> from Cloudflare's cache, filling
# it from releases/download/<tag>/<file>. That is why the tag is in the pool path: it is
# the one thing the Worker needs to find the asset, and putting it in the
# Filename apt already requests means there is no map to keep in step.
#
# TWO SUITES, ONE COMPONENT, `main`. `stable` carries stable releases whose
# rollout is complete, and is what every box is installed from. `rolling`
# carries the newest builds of main, for a pool whose machine image its owner
# chose to build from main (docs/hypervisors.md, "Built from main"). They are
# kept apart by the suite: a box names one of the two on its sources line, and
# /channel moves the word. A build of main is `<base>+main.<run>`, above the
# release it follows and below the next (tools/build-host-deb.mjs, debVersion).
#
# SIGNED OR NOT PUBLISHED. `[trusted=yes]` switches apt's signature check off
# and makes whoever serves the URL root on every box that trusts it; a
# repository that only works that way is worse than the manifest it would
# replace, which at least checks a digest. So there is no unsigned mode: no key
# id, no repository. The signature is also what makes the cache safe — apt
# checks each deb against the sha256 in the signed Packages file, wherever the
# bytes came from.
#
# InRelease (clearsigned) AND Release.gpg (detached), because apt prefers the
# first and older tooling still asks for the second.
set -euo pipefail

DEBS="${1:?usage: build-apt-repo.sh <debs-dir> <out-dir> <gpg-key-id> [<rolling-dir>]}"
OUT="${2:?usage: build-apt-repo.sh <debs-dir> <out-dir> <gpg-key-id> [<rolling-dir>]}"
KEY="${3:?a signing key id is required — this script does not build an unsigned repository}"
ROLLING="${4:-}"

command -v apt-ftparchive >/dev/null || { echo "apt-ftparchive is missing (apt-utils)" >&2; exit 1; }
command -v gpg >/dev/null || { echo "gpg is missing" >&2; exit 1; }

DEBS="$(cd "$DEBS" && pwd)"
[ -z "$ROLLING" ] || ROLLING="$(cd "$ROLLING" && pwd)"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The pool exists only here, long enough for apt-ftparchive to hash it.
n=0
stable=()
for dir in "$DEBS"/*/; do
  tag="$(basename "$dir")"
  case "$tag" in
    rolling) echo "skipping $dir: rolling is its own suite, not a stable release" >&2; continue ;;
    [A-Za-z0-9]*) ;;
    *) echo "skipping $dir: a tag starts with a letter or digit" >&2; continue ;;
  esac
  for deb in "$dir"*.deb; do
    [ -f "$deb" ] || continue
    mkdir -p "$WORK/pool/$tag"
    cp "$deb" "$WORK/pool/$tag/"
    n=$((n + 1))
  done
  [ -d "$WORK/pool/$tag" ] && stable+=("pool/$tag")
done
[ "$n" -gt 0 ] || { echo "no .deb files under $DEBS/<tag>/" >&2; exit 1; }

r=0
if [ -n "$ROLLING" ]; then
  for deb in "$ROLLING"/*.deb; do
    [ -f "$deb" ] || continue
    mkdir -p "$WORK/pool/rolling"
    cp "$deb" "$WORK/pool/rolling/"
    r=$((r + 1))
  done
  [ "$r" -gt 0 ] || echo "no .deb files under $ROLLING, so there is no rolling suite this time" >&2
fi

cd "$WORK"

# One suite: its Packages from exactly the pool directories named, then its
# Release, signed both ways. InRelease (clearsigned) AND Release.gpg
# (detached), because apt prefers the first and older tooling still asks for
# the second.
suite() {
  local name="$1" description="$2"; shift 2
  local arch dir from
  for arch in amd64 arm64; do
    dir="dists/$name/main/binary-$arch"
    mkdir -p "$dir"
    : > "$dir/Packages"
    # Relative to the repository root, because the Filename field in Packages
    # is what apt appends to the repository URL, and so what the Worker
    # receives.
    for from in "$@"; do apt-ftparchive --arch "$arch" packages "$from" >> "$dir/Packages"; done
    gzip -9nkf "$dir/Packages"
  done
  apt-ftparchive \
    -o APT::FTPArchive::Release::Origin=Fleetwright \
    -o APT::FTPArchive::Release::Label=Fleetwright \
    -o "APT::FTPArchive::Release::Suite=$name" \
    -o "APT::FTPArchive::Release::Codename=$name" \
    -o APT::FTPArchive::Release::Components=main \
    -o "APT::FTPArchive::Release::Architectures=amd64 arm64" \
    -o "APT::FTPArchive::Release::Description=$description" \
    release "dists/$name" > "dists/$name/Release"
  gpg --batch --yes --local-user "$KEY" --clearsign -o "dists/$name/InRelease" "dists/$name/Release"
  gpg --batch --yes --local-user "$KEY" --armor --detach-sign -o "dists/$name/Release.gpg" "dists/$name/Release"
}

suite stable "Fleetwright host, stable releases once their rollout is complete" "${stable[@]}"
[ "$r" -eq 0 ] || suite rolling "Fleetwright host, the newest builds of main" pool/rolling

rm -rf "$OUT/dists"
cp -r dists "$OUT/"
# The public half, both ways people install it: armored to read and paste,
# dearmored for /usr/share/keyrings.
gpg --batch --armor --export "$KEY" > "$OUT/fleetwright.asc"
gpg --batch --export "$KEY" > "$OUT/fleetwright.gpg"

echo "apt repository: $n stable and $r rolling package(s), metadata in $OUT, signed by $KEY"
