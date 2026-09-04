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
