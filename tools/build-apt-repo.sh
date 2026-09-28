#!/usr/bin/env bash
# Turn a directory of fleetwright debs into a signed apt repository.
#
#   tools/build-apt-repo.sh <debs-dir> <out-dir> <gpg-key-id>
#
# One suite, `stable`, one component, `main` — the repository only ever carries
# stable releases whose rollout is complete, so there is nothing to choose
# between. The layout is the ordinary one, so the line people add is the
# ordinary one too:
#
#   deb [signed-by=/usr/share/keyrings/fleetwright.gpg] https://<pages>/apt stable main
#
# SIGNED OR NOT PUBLISHED. `[trusted=yes]` switches apt's signature check off
# and makes whoever serves the URL root on every box that trusts it; a
# repository that only works that way is worse than the manifest it would
# replace, which at least checks a digest. So there is no unsigned mode here:
# no key id, no repository.
#
# InRelease (clearsigned) AND Release.gpg (detached), because apt prefers the
# first and older tooling still asks for the second.
set -euo pipefail

DEBS="${1:?usage: build-apt-repo.sh <debs-dir> <out-dir> <gpg-key-id>}"
OUT="${2:?usage: build-apt-repo.sh <debs-dir> <out-dir> <gpg-key-id>}"
KEY="${3:?a signing key id is required — this script does not build an unsigned repository}"

command -v apt-ftparchive >/dev/null || { echo "apt-ftparchive is missing (apt-utils)" >&2; exit 1; }
command -v gpg >/dev/null || { echo "gpg is missing" >&2; exit 1; }

rm -rf "$OUT"
POOL="$OUT/pool/main/f/fleetwright"
mkdir -p "$POOL"
n=0
for deb in "$DEBS"/*.deb; do
  [ -f "$deb" ] || continue
  cp "$deb" "$POOL/"
  n=$((n + 1))
done
[ "$n" -gt 0 ] || { echo "no .deb files in $DEBS" >&2; exit 1; }

cd "$OUT"
for arch in amd64 arm64; do
  dir="dists/stable/main/binary-$arch"
  mkdir -p "$dir"
  # Relative to $OUT, because the Filename field in Packages is what apt
  # appends to the repository URL.
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

# The public half, both ways people install it: armored to read and paste,
# dearmored for /usr/share/keyrings.
gpg --batch --armor --export "$KEY" > fleetwright.asc
gpg --batch --export "$KEY" > fleetwright.gpg

echo "apt repository: $n package(s) in $OUT, signed by $KEY"
