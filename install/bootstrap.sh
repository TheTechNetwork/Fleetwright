#!/bin/sh
# The one-liner. Takes a bare box to a working install.
#
#   curl -fsSL https://fleet.thetech.network/install | sudo sh
#
# ...and with arguments, which need the `-s --` that tells sh the rest is for
# the script rather than for sh:
#
#   curl -fsSL https://fleet.thetech.network/install | sudo sh -s -- --check
#
# ALL THIS DOES IS FETCH. It gets a release — the manifest, then the tarball
# the manifest names, checked against the sha256 the manifest carries — unpacks
# it somewhere temporary, and hands over to the install/install.sh inside it,
# which is the real installer and lays the release out under /opt/fleetwright
# exactly as it does for a migration. Keeping the two apart is the point: this
# file is what an unknown shell executes sight-unseen, so it stays small enough
# to read in one screen and boring enough to be sure about.
#
# A CHECKOUT IS NO LONGER WHAT A FRESH BOX GETS. It used to be: this cloned the
# repository — it had to, because install.sh lived in it — so every install by
# the documented command produced a git working tree, and the installer's last
# act was to offer to convert it into the packaged layout it could have started
# in. That cost every box git, a clone of the whole monorepo, and a tree the
# service user could write and therefore drift. A release is a tarball with a
# checksum, and a fresh box can start from one. Three things still get the
# checkout: `--from-source`, which is for a box somebody EDITS; a box that
# already has one at $DIR, which is kept the shape it was; and a repository
# that is not on GitHub, where there is no release address to derive and a
# guess would be a 404 blamed on the installer.
#
# POSIX sh, deliberately. `curl | sh` runs under whatever /bin/sh is — dash on
# Debian — and the real installer is bash: it uses `set -o pipefail`, `local`
# and `printf -v`, none of which dash has. Written as bash and piped to sh, it
# fails on line 16 with "Bad substitution" and no clue as to why. So the piece
# that gets piped is sh, and it runs the other under bash.
set -eu

REPO="${FLEETWRIGHT_REPO:-https://github.com/TheTechNetwork/Fleetwright}"
REF="${FLEETWRIGHT_REF:-main}"
DIR="${FLEETWRIGHT_DIR:-/opt/agent-fleet}"
# Where a release goes. The same default install.sh has, so the two agree
# without either reading the other.
BASE="${AGENT_FLEET_BASE:-/opt/fleetwright}"
# WHICH RELEASE. `stable` is the latest GitHub release; `rolling` is the tag
# that every merge to main republishes. The manifest is the only address a box
# ever has to know — src/core/release.js derives everything else from it — so
# it can also be given outright, for a mirror or a fork on another host.
CHANNEL="${FLEETWRIGHT_CHANNEL:-stable}"
MANIFEST="${FLEETWRIGHT_MANIFEST:-}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
die()  { printf '\n  FAIL %s\n\n' "$*" >&2; exit 1; }

say "Fleetwright"

# --- which way in -------------------------------------------------------------
#
# Decided before anything is touched, because the two routes check different
# things and refuse in different words.
SOURCE=0
for arg in "$@"; do [ "$arg" = "--from-source" ] && SOURCE=1; done
# A box that has a checkout keeps it. Laying a release beside a checkout that
# is still what the units point at would be two installs arguing about one
# box; the installer's own conversion offer is the way from one to the other.
[ -d "$DIR/.git" ] && SOURCE=1

if [ "$SOURCE" = 0 ] && [ -z "$MANIFEST" ]; then
  case "$REPO" in
    https://github.com/*)
      slug="${REPO#https://github.com/}"
      slug="${slug%.git}"
      slug="${slug%/}"
      case "$CHANNEL" in
        rolling) MANIFEST="https://github.com/$slug/releases/download/rolling/manifest.json" ;;
        *)       MANIFEST="https://github.com/$slug/releases/latest/download/manifest.json" ;;
      esac ;;
    *)
      # Not guessed at. A release path invented inside somebody else's server
      # is a 404 on the first fetch, blamed on the installer.
      say "No release address for $REPO — fetching the repository instead"
      SOURCE=1 ;;
  esac
fi

# --- a release ----------------------------------------------------------------
if [ "$SOURCE" = 0 ]; then
  # Being ROOT is not the requirement; being able to write BASE is. The real
  # installer asks for root when it wants root — it writes /etc and systemd
  # units — and says so in its own words.
  TARGET="$BASE"
  [ -e "$TARGET" ] || TARGET="$(dirname "$BASE")"
  [ -w "$TARGET" ] || die "cannot write $TARGET.
       For the default location that means:
           curl -fsSL https://fleet.thetech.network/install | sudo sh
       Or keep a checkout somewhere you own instead:
           curl -fsSL https://fleet.thetech.network/install | FLEETWRIGHT_DIR=~/fleetwright sh -s -- --from-source"

  for tool in curl tar; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed, and a release cannot be fetched without it."
  done
  # One of three, because a box has whichever its OS ships: coreutils on Linux,
  # perl's shasum on macOS, and openssl nearly everywhere as the fallback.
  sha256_of() {
    if   command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum    >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
    elif command -v openssl   >/dev/null 2>&1; then openssl dgst -sha256 -r "$1" | cut -d' ' -f1
    else return 1
    fi
  }

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/fleetwright-install.XXXXXX")"
  # Removed however this ends — a refusal above leaves nothing behind either.
  trap 'rm -rf "$WORK"' EXIT
  say "Fetching the release"
  printf '  from %s\n' "$MANIFEST"
  curl -fsSL "$MANIFEST" -o "$WORK/manifest.json" \
    || die "could not fetch the manifest at $MANIFEST.
       A fork or a mirror can say where its releases are:
           curl -fsSL ... | FLEETWRIGHT_MANIFEST=https://host/path/manifest.json sudo sh"

  # sed, because this is sh with no jq. The manifest is ours, one key per
  # line, written by tools/build-host-package.mjs; the same three expressions
  # install/fleetwright-migrate uses.
  field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$WORK/manifest.json" | head -1; }
  VERSION="$(field version)"
  FILE="$(field file)"
  SHA="$(field sha256)"
  [ -n "$VERSION" ] && [ -n "$FILE" ] && [ -n "$SHA" ] \
    || die "the manifest at $MANIFEST does not name a version, a file and a sha256."
  # A BARE FILE NAME, beside the manifest. A `file` carrying a path would be
  # the manifest choosing where on this box to write, which is not its to
  # choose.
  case "$FILE" in
    */*|.*) die "the manifest names \"$FILE\", which is not a file beside it." ;;
  esac

  TARBALL="${MANIFEST%/*}/$FILE"
  curl -fsSL "$TARBALL" -o "$WORK/$FILE" || die "could not download $TARBALL"

  # VERIFIED BEFORE IT IS UNPACKED, not after. A tarball that is unpacked and
  # then checked has already written whatever it contained.
  GOT="$(sha256_of "$WORK/$FILE")" \
    || die "no sha256sum, shasum or openssl on this box, so the release cannot be checked."
  [ "$GOT" = "$SHA" ] \
    || die "the release does not match its manifest: expected $SHA, got $GOT.
       Nothing was installed. A download cut short does this; so does a manifest
       edited after its tarball was published. Run this again, and if it
       repeats, the release is wrong rather than the box."
  ok "$VERSION, sha256 ok"

  mkdir "$WORK/release"
  tar -xzf "$WORK/$FILE" -C "$WORK/release" --strip-components=1
  [ -x "$WORK/release/install/install.sh" ] \
    || die "the release has no install/install.sh in it, so it cannot install itself."

  # Hand over, with stdin BACK ON THE TERMINAL — see the checkout route below
  # for why. Not `exec`, because the unpacked copy is this script's to remove
  # once the installer has laid the release out where it lives.
  #
  # THE MANIFEST GOES WITH IT. The installer records where a box's releases
  # come from, and on a checkout it reads that off the git remote. There is no
  # remote here, so it is told outright: this is what `/update` will read from
  # then on, and it is the address this release was just verified against.
  AGENT_HUB_RELEASE_MANIFEST="$MANIFEST"
  export AGENT_HUB_RELEASE_MANIFEST
  say "Running the installer"
  if (exec < /dev/tty) 2>/dev/null; then
    bash "$WORK/release/install/install.sh" "$@" < /dev/tty && RC=0 || RC=$?
  else
    bash "$WORK/release/install/install.sh" "$@" && RC=0 || RC=$?
  fi
  exit "$RC"
fi

# --- a checkout ---------------------------------------------------------------

# Being ROOT is not the requirement; being able to write DIR is. Somebody
# installing into their own home does not need sudo, and a script that demands a
# privilege it will not use is a script people learn to run with sudo out of
# habit. The real installer asks for root when it wants root — it writes /etc
# and systemd units — and says so in its own words.
TARGET="$DIR"
[ -e "$TARGET" ] || TARGET="$(dirname "$DIR")"
[ -w "$TARGET" ] || die "cannot write $TARGET.
       For the default location that means:
           curl -fsSL https://fleet.thetech.network/install | sudo sh
       Or choose somewhere you own:
           curl -fsSL https://fleet.thetech.network/install | FLEETWRIGHT_DIR=~/fleetwright sh"

# git, if the box has none. Same rule as the installer's: a script that reports
# a missing dependency instead of installing it has made the operator do the
# work twice.
if ! command -v git >/dev/null 2>&1; then
  say "Installing git"
  if   command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq git
  elif command -v dnf     >/dev/null 2>&1; then dnf install -y -q git
  elif command -v pacman  >/dev/null 2>&1; then pacman -Sy --noconfirm git
  elif command -v apk     >/dev/null 2>&1; then apk add --quiet git
  elif command -v zypper  >/dev/null 2>&1; then zypper --quiet install -y git
  else die "git is not installed and this box has no package manager I know."
  fi
  command -v git >/dev/null 2>&1 || die "git still is not on PATH after installing it."
fi

# Three states, three different right answers. The third is the one worth being
# careful about: a directory that is not ours must not be clobbered by a command
# somebody pasted.
if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" remote set-url origin "$REPO"
  # AN EXPLICIT REFSPEC, AND STALE TAGS PRUNED. `fetch origin main` names a ref
  # the remote may hold twice — this repository shipped a TAG called `main`
  # beside the branch for half a day — and a local tag left behind by an older
  # release keeps answering after the remote's is gone. Neither is a state
  # anybody chose, and both are ours to clean up rather than to explain.
  # A LOCAL TAG WITH THE BRANCH'S NAME shadows it: git resolves refs/tags/ before
  # refs/heads/, so `git checkout main`, `git log main..` and `git describe` all
  # answer with the tag. This repository published one for half a day, and every
  # clone that fetched it still has it — `--prune-tags` does not reach it,
  # because an explicit branch refspec never consults the tag refspec.
  #
  # Deleting it is the self-heal: nothing should ever want a tag named after the
  # branch it is tracking, and leaving it means every later command is quietly
  # answering about the wrong commit.
  if git -C "$DIR" rev-parse -q --verify "refs/tags/$REF" >/dev/null 2>&1; then
    git -C "$DIR" tag -d "$REF" >/dev/null 2>&1 || true
    ok "removed a local tag named $REF — it was shadowing the branch"
  fi
  git -C "$DIR" fetch --quiet --prune --prune-tags --force \
    origin "refs/heads/$REF:refs/remotes/origin/$REF" 2>/dev/null \
    || git -C "$DIR" fetch --quiet --force origin "refs/heads/$REF:refs/remotes/origin/$REF"

  # ATTEMPTED, THEN EXPLAINED — rather than predicted. Whether a checkout would
  # destroy something is a question git already answers correctly, and a
  # reimplementation here would be a second opinion that is wrong on the day it
  # matters. So: try it, and if it refuses, say what that means in this
  # script's own words.
  #
  # What it looked like before: sixty file names, "Please commit your changes or
  # stash them", "Aborting". Accurate, and it reads as the installer being
  # broken rather than as a decision somebody has to make. On a box whose whole
  # promise is that updates do not need a shell, ending in a git error message
  # is the failure, not the report of one.
  if ! git -C "$DIR" checkout --quiet -B "$REF" "origin/$REF" 2>/dev/null; then
    say "$DIR has changes of its own"

    # SAVED BEFORE ANYTHING IS OFFERED, and saved OUTSIDE the tree that is about
    # to be reset. Whatever is in there, somebody may want it back, and this
    # script is not in a position to judge — the diff costs nothing to keep and
    # a discarded one cannot be recovered.
    STAMP="$(date +%Y%m%d-%H%M%S)"
    SAVED="${TMPDIR:-/tmp}/fleetwright-local-changes-$STAMP.diff"
    { git -C "$DIR" status --porcelain; printf '\n--- diff ---\n'; git -C "$DIR" diff HEAD; } > "$SAVED" 2>/dev/null || true
    printf '  A copy of them is at %s\n' "$SAVED"

    git -C "$DIR" status --porcelain | head -10 | sed 's/^/    /'
    COUNT="$(git -C "$DIR" status --porcelain | wc -l | tr -d ' ')"
    [ "$COUNT" -gt 10 ] && printf '    ... and %s more\n' "$((COUNT - 10))"

    # DISCARDING IS THE ONLY ANSWER ON OFFER, and it is asked for rather than
    # assumed. $DIR is meant to be a plain checkout of ours; a box that keeps
    # edits there has made a choice this script must not silently undo, and
    # merging is not something to attempt unattended on a machine running other
    # people's sessions.
    ANSWER=n
    if (exec < /dev/tty) 2>/dev/null; then
      printf '\n  Discard them and take %s as it is? [y/N] ' "$REF"
      read -r ANSWER < /dev/tty || ANSWER=n
    fi
    case "$ANSWER" in
      y|Y|yes|YES)
        # -fd and NOT -fdx: ignored files stay. node_modules is the one that
        # matters — removing it turns a re-run into a fresh npm install for no
        # reason, and it was never the thing in the way.
        git -C "$DIR" reset --quiet --hard "origin/$REF"
        git -C "$DIR" clean --quiet -fd
        git -C "$DIR" checkout --quiet -B "$REF" "origin/$REF"
        ok "discarded; $SAVED still has them" ;;
      *)
        die "$DIR has local changes and this would overwrite them.
       They are saved at $SAVED.
       Keep them:      cd $DIR && git stash --include-untracked
       Or discard them: cd $DIR && git reset --hard origin/$REF && git clean -fd
       Then run this again." ;;
    esac
  fi
  # PROVED, NOT ASSUMED. A fetch that quietly updated nothing leaves the box on
  # old code while every line above says it worked — which is how a host spent
  # an afternoon being told to re-run an installer that could not reach the fix
  # it was being re-run for.
  WANT="$(git -C "$DIR" rev-parse "origin/$REF")"
  HAVE="$(git -C "$DIR" rev-parse HEAD)"
  if [ "$WANT" != "$HAVE" ]; then
    die "$DIR is at ${HAVE%"${HAVE#???????}"} and origin/$REF is ${WANT%"${WANT#???????}"}.
       The update did not take. Something local is overriding it — try:
           git -C $DIR fetch --prune --prune-tags --force origin $REF
           git -C $DIR reset --hard origin/$REF"
  fi
  ok "$(git -C "$DIR" rev-parse --short HEAD) on $REF"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null || true)" ]; then
  die "$DIR exists, is not a checkout, and is not empty. Move it, or set FLEETWRIGHT_DIR."
else
  say "Fetching into $DIR"
  git clone --quiet --branch "$REF" "$REPO" "$DIR"
  ok "$(git -C "$DIR" rev-parse --short HEAD) on $REF"
fi

[ -x "$DIR/install/install.sh" ] || die "$DIR does not look like Fleetwright — no install/install.sh in it."

# Hand over, with stdin BACK ON THE TERMINAL.
#
# This is the part that makes the one-liner worth having rather than merely
# possible. Piped, stdin is the script, so the installer sees no terminal and
# skips the wizard — the thing that turns a bare box into a finished one. The
# terminal is still there on /dev/tty, so reattach it and the interactive
# install a person expects is what they get.
say "Running the installer"
# TRIED, not tested for. /dev/tty exists on every box; opening it fails when
# there is no controlling terminal — a cron job, a CI runner, a container
# started without one. `[ -r /dev/tty ]` says yes in all of those and the exec
# then dies with "No such device or address", which is a strange way for an
# installer to end. The subshell does the only reliable check there is: open it
# and see.
if (exec < /dev/tty) 2>/dev/null; then
  exec bash "$DIR/install/install.sh" "$@" < /dev/tty
fi
exec bash "$DIR/install/install.sh" "$@"
