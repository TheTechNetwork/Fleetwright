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
# ALL THIS DOES IS FETCH. It gets git if the box has none, puts the repository
# somewhere permanent, and hands over to install/install.sh, which is the real
# installer and has not changed. Keeping the two apart is the point: this file
# is what an unknown shell executes sight-unseen, so it stays small enough to
# read in one screen and boring enough to be sure about.
#
# POSIX sh, deliberately. `curl | sh` runs under whatever /bin/sh is — dash on
# Debian — and the real installer is bash: it uses `set -o pipefail`, `local`
# and `printf -v`, none of which dash has. Written as bash and piped to sh, it
# fails on line 16 with "Bad substitution" and no clue as to why. So the piece
# that gets piped is sh, and it `exec`s the other under bash.
set -eu

REPO="${FLEETWRIGHT_REPO:-https://github.com/TheTechNetwork/Fleetwright}"
REF="${FLEETWRIGHT_REF:-main}"
DIR="${FLEETWRIGHT_DIR:-/opt/agent-fleet}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
die()  { printf '\n  FAIL %s\n\n' "$*" >&2; exit 1; }

say "Fleetwright"

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
  git -C "$DIR" fetch --quiet origin "$REF"
  git -C "$DIR" checkout --quiet -B "$REF" "origin/$REF"
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
