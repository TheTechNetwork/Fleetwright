#!/usr/bin/env bash
# Build the signed metadata of the fleetwright apt repository.
#
#   tools/build-apt-repo.sh <debs-dir> <out-dir> <gpg-key-id>
#
# <debs-dir> holds one directory per release tag, each with that release's
# debs:  <debs-dir>/v0.3.0/fleetwright_0.3.0_amd64.deb
#
# <out-dir> gets ONLY what is served — dists/ and the public key — and never a
# package. The packages stay GitHub release assets, and the apt Worker
# (apt/src/index.js) answers pool/<tag>/<file> with a redirect to
# releases/download/<tag>/<file>. That is why the tag is in the pool path: it is
# the one thing the Worker needs to find the asset, and putting it in the
# Filename apt already requests means there is no map to keep in step.
#
# One suite, `stable`, one component, `main`: the repository only ever carries
# stable releases whose rollout is complete, so there is nothing to choose
# between.
#
# SIGNED OR NOT PUBLISHED. `[trusted=yes]` switches apt's signature check off
# and makes whoever serves the URL root on every box that trusts it; a
# repository that only works that way is worse than the manifest it would
# replace, which at least checks a digest. So there is no unsigned mode: no key
# id, no repository. The signature is also what makes the redirect safe — apt
# checks each deb against the sha256 in the signed Packages file, wherever the
# bytes came from.
#
# InRelease (clearsigned) AND Release.gpg (detached), because apt prefers the
# first and older tooling still asks for the second.
set -euo pipefail

DEBS="${1:?usage: build-apt-repo.sh <debs-dir> <out-dir> <gpg-key-id>}"
OUT="${2:?usage: build-apt-repo.sh <debs-dir> <out-dir> <gpg-key-id>}"
KEY="${3:?a signing key id is required — this script does not build an unsigned repository}"

command -v apt-ftparchive >/dev/null || { echo "apt-ftparchive is missing (apt-utils)" >&2; exit 1; }
command -v gpg >/dev/null || { echo "gpg is missing" >&2; exit 1; }

DEBS="$(cd "$DEBS" && pwd)"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The pool exists only here, long enough for apt-ftparchive to hash it.
n=0
for dir in "$DEBS"/*/; do
  tag="$(basename "$dir")"
  case "$tag" in
    [A-Za-z0-9]*) ;;
    *) echo "skipping $dir: a tag starts with a letter or digit" >&2; continue ;;
  esac
  for deb in "$dir"*.deb; do
    [ -f "$deb" ] || continue
    mkdir -p "$WORK/pool/$tag"
    cp "$deb" "$WORK/pool/$tag/"
    n=$((n + 1))
  done
done
[ "$n" -gt 0 ] || { echo "no .deb files under $DEBS/<tag>/" >&2; exit 1; }

cd "$WORK"
for arch in amd64 arm64; do
  dir="dists/stable/main/binary-$arch"
  mkdir -p "$dir"
  # Relative to the repository root, because the Filename field in Packages is
  # what apt appends to the repository URL — and so what the Worker receives.
  apt-ftparchive --arch "$arch" packages pool > "$dir/Packages"
  gzip -9nk "$dir/Packages"
done

apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=Fleetwright \
  -o APT::FTPArchive::Release::Label=Fleetwright \
  -o APT::FTPArchive::Release::Suite=stable \
  -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Components=main \
  -o "APT::FTPArchive::Release::Architectures=amd64 arm64" \
  -o "APT::FTPArchive::Release::Description=Fleetwright host, stable releases once their rollout is complete" \
  release dists/stable > dists/stable/Release

gpg --batch --yes --local-user "$KEY" --clearsign -o dists/stable/InRelease dists/stable/Release
gpg --batch --yes --local-user "$KEY" --armor --detach-sign -o dists/stable/Release.gpg dists/stable/Release

rm -rf "$OUT/dists"
cp -r dists "$OUT/"
# The public half, both ways people install it: armored to read and paste,
# dearmored for /usr/share/keyrings.
gpg --batch --armor --export "$KEY" > "$OUT/fleetwright.asc"
gpg --batch --export "$KEY" > "$OUT/fleetwright.gpg"

echo "apt repository: $n package(s), metadata in $OUT, signed by $KEY"
