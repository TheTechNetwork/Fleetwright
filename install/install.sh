#!/usr/bin/env bash

# RUN THIS WITH BASH. `sh install.sh` fails at `set -o pipefail` with "Illegal
# option -o pipefail" and explains nothing, and people type it — the docs say
# to execute the file, but a habit is a habit. Two lines here beat the next
# person losing ten minutes to a shell they did not choose.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "This installer needs bash. Run it as:  sudo bash install/install.sh" >&2
  exit 2
fi

# fleetwright installer — the whole thing, in one script.
#
#   curl -fsSL https://fleet.thetech.network/install | sudo sh
#
# ...which is install/bootstrap.sh fetching a verified release and running the
# copy of this inside it, so a fresh box is packaged from its first minute and
# never needs git. By hand, from a checkout, which is what a box somebody edits
# gets (`--from-source` asks the one-liner for the same):
#
#   git clone https://github.com/TheTechNetwork/Fleetwright /opt/fleetwright-src
#   sudo /opt/fleetwright-src/install/install.sh
#
# Sets up both halves: the session manager (systemd service, SessionStart hook,
# CLI) and the fleet sidecar (config, CLI). There is nothing else to run and
# nothing to hand-copy between files.
#
# Idempotent: re-run it after `git pull` to pick up changes. It never overwrites
# /etc/fleetwright.env or /etc/fleetwright-sidecar.env once those exist, so your
# tokens and allowlist survive every upgrade.
set -euo pipefail

# WHERE THE PAYLOAD IS — beside this script, unless told otherwise.
#
# FLEETWRIGHT_PAYLOAD EXISTS TO BREAK ONE DEPENDENCY, and it is the reason this
# project stopped needing a release to fix its own installer.
#
# A migration lays a release out and then has to re-point the systemd units at
# it. It did that by running the installer INSIDE the release — so a release
# carrying a broken installer could not be migrated to, and the only way to fix
# an installer bug was to supersede it. Three releases in one day went that way,
# each fixing a bug the previous one revealed, on code that had never run.
#
# For a while the migration ran the installer THE BOX ALREADY HAD — the
# checkout, refreshed by `curl … | sudo sh` — pointed at the release as
# payload, so an installer fix needed no release. That had a cost this comment
# did not name: the checkout is chowned to the service user so /update can
# pull, so root was executing a script the service user could rewrite. The
# migration and the heal both run the installer out of a VERIFIED copy of the
# release now — unpacked by root where only root can reach, from a tarball
# whose sha256 the manifest vouched for — and point it at `current` as the
# payload. The payload option is what makes that work: the templates come
# from the installer that is running, the tree it lays out is the one under
# the symlink.
#
# So a release has to carry a correct installer again, and CI runs it before
# one ships (test/packaged-installer.test.js); the --help smoke check in the
# helper refuses a release whose installer cannot start before `current`
# moves. The one-liner still updates a checkout's installer, for the person
# unpacking or re-running by hand.
# WHERE THIS SCRIPT ITSELF LIVES, which is not always where the payload is.
#
# THE TEMPLATES COME FROM HERE, AND THAT IS THE WHOLE POINT. install_unit read
# `$DIR/install/<name>.service`, and $DIR is the PAYLOAD — so a box pointing its
# units at a release read that RELEASE's unit template. v0.2.3's predates
# __ENTRY__ and hardcodes `__DIR__/bin/fleetwright`, so the substitution found
# nothing to replace and every repair wrote the same broken unit, on a box whose
# installer had been correct for hours.
#
# The installer that is running is the newest thing on the box — it is what
# `curl … | sudo sh` just updated. Its templates are the ones to use.
# SETTINGS FROM BEFORE THE RENAME, read under their new names. A coordinator
# deployed before it serves an /install that exports
# AGENT_FLEET_COORDINATOR_URL, and somebody's muscle memory types
# AGENT_HUB_NODE_BIN; both still work. The new name wins when both are set.
# src/fleet/legacy-names.js is the same rule for the Node code.
for __legacy in $(env | sed -n -e 's/^\(AGENT_HUB_[A-Za-z0-9_]*\)=.*/\1/p' -e 's/^\(AGENT_FLEET_[A-Za-z0-9_]*\)=.*/\1/p'); do
  __new="FLEETWRIGHT_${__legacy#AGENT_*_}"
  if [ -z "$(eval "printf '%s' \"\${$__new:-}\"")" ]; then
    eval "export $__new=\"\${$__legacy}\""
  fi
done
unset __legacy __new

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${FLEETWRIGHT_PAYLOAD:-$SELF_DIR}"

# A RELEASE, OR A CHECKOUT. The two differ in exactly one way that matters here:
# a release carries its dependencies already bundled into lib/, so there is no
# npm step, no lockfile, and no git remote to pull from. Everything else — the
# units, the sandbox image, the wizard — is identical, which is why this is a
# flag and not a second installer.
#
# Detected from the layout rather than from a flag somebody has to pass,
# because the person running it got here by unpacking a tarball and has no
# reason to know there are two shapes.
PACKAGED=0
if [ -f "$DIR/lib/fleetwright.mjs" ]; then PACKAGED=1; fi

# A RELEASE IS INSTALLED BESIDE THE ONE BEFORE IT, never over it. The layout is
# the rollback:
#
#   /opt/fleetwright/releases/main-41/   the one before
#   /opt/fleetwright/releases/main-42/   this one
#   /opt/fleetwright/current -> releases/main-42
#
# The units point at `current`, so applying a release is one symlink — no
# daemon-reload, no edit to anything root owns, and no window where the tree a
# running process is reading is being written to. A checkout install keeps
# running in place, because a checkout is a thing somebody edits and moving it
# under them would be its own kind of rude.
FLEET_BASE="${FLEETWRIGHT_BASE:-/opt/fleetwright}"
# THE LAY-OUT ITSELF HAPPENS AFTER THE ARGUMENTS ARE READ, further down. It
# used to be right here, and this file has learned that lesson once already:
# "Ordering is the entire fix. Anything that can refuse this install has to
# refuse it before anything is destroyed."
#
# Two things were wrong with it here. It read $CHECK_ONLY twenty lines before
# anything set it, which under `set -u` is a FATAL ERROR — and only ever
# evaluated on a packaged box, so it could not fire until the first machine
# converted itself. It fired on the first one. And even with the variable
# defaulted, `--check` would have copied a release into place before reaching
# the argument that promises to change nothing.

# IS THIS BOX ALREADY ON PACKAGED RELEASES, even though this script is running
# out of a checkout?
#
# THE ONE-LINER RE-RAN AND QUIETLY UN-MIGRATED A CONVERTED BOX. bootstrap.sh
# updates /opt/fleetwright-src and runs the install.sh inside it, so PACKAGED is 0 —
# and everything below then re-pointed the units and the CLI links back at the
# checkout, undoing a conversion nobody asked to undo, before offering to
# convert again. The repeated offer was the visible half of a revert.
#
# What a box RUNS is what systemd starts, which is the same question
# fleetwright-migrate asks and the same way it asks it.
# CONVERTED IS DECIDED BELOW, after say/ok/warn exist. See the block following
# their definitions — it used to be here, and calling `warn` twenty lines before
# `warn` was defined killed the installer under `set -e` on exactly the boxes it
# was added to rescue.

# Set only when the new fleetwright has been SEEN to start. Section 8 will not
# remove the install it replaced without it.
SERVICES_STARTED=0
OLD_UNIT_BACKUP_DIR=""
ENV_FILE=/etc/fleetwright.env
# The release address root acts on, which is not $ENV_FILE: that file is the
# service user's, chowned to them so the CLI can read it. See "WHERE ROOT
# TAKES ITS RELEASES FROM" below, and install/fleetwright-migrate, which reads
# only this.
RELEASE_MANIFEST_FILE=/usr/local/etc/fleetwright/release-manifest
SIDECAR_ENV=/etc/fleetwright-sidecar.env
COORD_ENV=/etc/fleetwright-coordinator.env
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
warn() { printf '  warn %s\n' "$*"; }
die()  { printf '\n  FAIL %s\n\n' "$*" >&2; exit 1; }

# Who owns a path. GNU stat spells it -c %U and BSD stat -f %Su; a Mac has the
# second, and the first version of the two chown guards below asked GNU's
# question there, got nothing back, and chowned a tree it did not need to on
# every run. Empty when the path is missing.
owner_of() { stat -c %U "$1" 2>/dev/null || stat -f %Su "$1" 2>/dev/null || true; }

# ROOT ACTS IN SOMEBODY'S DIRECTORY AS THEM. Whoever owns a directory decides
# what every name in it is, at every moment: a profile, a token, `releases`, a
# file root is about to copy over can each be a symlink by the time root's
# `install -d`, `cp`, `mkdir`, `>` or `chown` reaches it, and each of those
# follows one — GNU `install -d` on a link to /usr/local/sbin fchmods and, as
# root, fchowns the directory it lands on. So what root makes, writes, moves
# or copies inside a directory another account owns, it does as that account,
# with an argv and no login shell, and lands only where that account could
# land anyway. sudo first and runuser second, because a minimal image may have
# either; neither, and the step fails rather than falling back to root.
run_as() { # run_as WHO CMD [ARG...]
  local who="$1"
  shift
  if [ "$(id -un)" = "$who" ]; then
    "$@"
  elif command -v sudo >/dev/null; then
    sudo -u "$who" -H -- "$@"
  elif command -v runuser >/dev/null; then
    runuser -u "$who" -- "$@"
  else
    return 1
  fi
}

# A PAYLOAD IS A RELEASE, OR THIS DOES NOT RUN. FLEETWRIGHT_PAYLOAD is how a
# verified installer is pointed at `current` — fleetwright-migrate's heal and
# bring-forward, and root's `fleetwright` (section 6) — and `current` is the
# service user's. Everything that decides what shape this box is reads $DIR,
# so the service user decided it: delete current/lib/fleetwright.mjs, write the
# manifest's version into current/package.json, `sudo -n fleetwright-migrate`,
# and PACKAGED came out 0. The rest of this file then took the CHECKOUT branch
# as root in `current`, which runs `npm ci` there, and npm runs a package's own
# lifecycle scripts as the user that called it. No person needed.
#
# Nothing that names a payload means a checkout by it, so one that does not
# hold a release is refused here, before anything has been read out of it.
# Asked of PACKAGED, which was decided once at the top, and not of the file
# again: a second look is a second answer the service user can race.
if [ -n "${FLEETWRIGHT_PAYLOAD:-}" ] && [ "$PACKAGED" != 1 ]; then
  die "FLEETWRIGHT_PAYLOAD=$DIR is not a release (it has no lib/fleetwright.mjs), and a payload is only ever
       one. Nothing was changed. A checkout is installed by running its own install.sh."
fi

# --- the names from before the rename ---------------------------------------
#
# FLEETWRIGHT WAS agent-hub AND agent-fleet UNTIL THE RENAME, and a box
# installed before it is made of those names: agent-hub.service,
# /etc/agent-hub.env full of AGENT_HUB_*, /var/lib/agent-fleet holding the
# host key, sudoers rules naming the old units. This moves it onto the new
# names, once, the first time a new installer runs on it — which the next
# update does (the heal runs the release's installer with --repair).
#
# FIRST, BEFORE ANYTHING READS A UNIT. The two blocks below ask the units which
# user this service runs as and whether the box is on packaged releases, and
# both ask by the NEW names. Asked before this, an unmigrated box answers
# "no unit" to both: the service user becomes whoever ran sudo, and the box is
# treated as a checkout. That is the exact failure the RUN_USER comment
# describes, reached a new way.
#
# NOTHING IS STOPPED HERE. Files move and the old paths become symlinks, so a
# service still running under its old unit keeps finding everything; the old
# unit is stopped only by start_service, immediately before its replacement
# starts, and the sweep at the end starts the replacement of anything that was
# running and that no other step restarted. KillMode=process on the hub is
# what makes that safe mid-heal: stopping the old unit signals the hub alone,
# not the helper and installer it spawned, and not the tmux sessions.
#
# Only what can be moved without a decision is moved. A new name that already
# exists is left alone and said, never merged.
LEGACY_RUNNING=""   # new unit names whose old unit was active
LEGACY_UNITS=""     # old unit names to stop before their replacement starts
LEGACY_CONFIRM=0    # the commit-confirm watchdog was removed under its old name
legacy_unit_for() { # legacy_unit_for NEW → OLD, or nothing
  case "$1" in
    fleetwright) echo agent-hub ;;
    fleetwright-sidecar) echo agent-fleet-sidecar ;;
    fleetwright-coordinator) echo agent-fleet-coordinator ;;
    fleetwright-upgrade) echo agent-hub-upgrade ;;
    fleetwright-apt-update) echo agent-hub-apt-update ;;
    fleetwright-confirm) echo agent-fleet-confirm ;;
  esac
}
# Stop the old unit, if this box had one, the moment before its replacement
# starts — never earlier, so a run that fails half way leaves the old service
# running rather than nothing.
stop_legacy_unit() { # stop_legacy_unit NEW
  local old; old="$(legacy_unit_for "$1")"
  [ -n "$old" ] || return 0
  case " $LEGACY_UNITS " in *" $old "*) ;; *) return 0 ;; esac
  if [ "$PLATFORM" = macos ]; then
    launchctl bootout "system/network.thetech.$old" >/dev/null 2>&1 || true
    return 0
  fi
  systemctl stop "$old" >/dev/null 2>&1 || true
  # ENABLED UNDER ITS NEW NAME, HERE, because the old one was disabled by the
  # migration and this is the one call every route to a restart goes through.
  # The --upgrade loop restarts without enabling — it never had to, when unit
  # names did not change — and a box that came back from a reboot with nothing
  # running is the failure that found this.
  [ -f "/etc/systemd/system/$1.service" ] && { systemctl enable "$1" >/dev/null 2>&1 || true; }
  return 0
}
migrate_legacy_names() {
  [ "$(id -u)" = 0 ] || return 0
  for a in "$@"; do case "$a" in --check|-n|-h|--help) return 0 ;; esac; done

  # UNITS, renamed on disk so the reads below find them. Contents untouched:
  # install_unit rewrites every one of them a few sections down, and until then
  # the old text is exactly the record those reads want.
  local pair old new f
  for pair in agent-hub:fleetwright agent-fleet-sidecar:fleetwright-sidecar \
              agent-fleet-coordinator:fleetwright-coordinator \
              agent-hub-upgrade:fleetwright-upgrade agent-hub-apt-update:fleetwright-apt-update; do
    old="${pair%%:*}"; new="${pair#*:}"
    if [ -f "/etc/systemd/system/$old.service" ]; then
      if systemctl is-active --quiet "$old" 2>/dev/null; then LEGACY_RUNNING="$LEGACY_RUNNING $new"; fi
      systemctl disable "$old" >/dev/null 2>&1 || true
      if [ -e "/etc/systemd/system/$new.service" ]; then
        warn "/etc/systemd/system/$new.service already exists — leaving it, and removing $old.service"
        rm -f "/etc/systemd/system/$old.service"
      else
        mv "/etc/systemd/system/$old.service" "/etc/systemd/system/$new.service"
      fi
      LEGACY_UNITS="$LEGACY_UNITS $old"
      ok "unit $old → $new"
    fi
    if [ -f "/Library/LaunchDaemons/network.thetech.$old.plist" ]; then
      # Not booted out here — the same rule as systemd: the old daemon keeps
      # running until stop_legacy_unit, the moment before its replacement.
      if launchctl print "system/network.thetech.$old" >/dev/null 2>&1; then LEGACY_RUNNING="$LEGACY_RUNNING $new"; fi
      [ -e "/Library/LaunchDaemons/network.thetech.$new.plist" ] \
        || mv "/Library/LaunchDaemons/network.thetech.$old.plist" "/Library/LaunchDaemons/network.thetech.$new.plist"
      rm -f "/Library/LaunchDaemons/network.thetech.$old.plist"
      LEGACY_UNITS="$LEGACY_UNITS $old"
      ok "launchd $old → $new"
    fi
  done
  # The watchdog is a timer and a oneshot; stopped outright, because the new
  # one is armed by the start step and two would race over one trial record.
  for f in service timer; do
    if [ -f "/etc/systemd/system/agent-fleet-confirm.$f" ]; then
      systemctl disable --now "agent-fleet-confirm.$f" >/dev/null 2>&1 || true
      rm -f "/etc/systemd/system/agent-fleet-confirm.$f"
      LEGACY_CONFIRM=1
      ok "unit agent-fleet-confirm.$f removed — fleetwright-confirm replaces it"
    fi
  done
  [ -n "$LEGACY_UNITS" ] && { systemctl daemon-reload >/dev/null 2>&1 || true; }

  # STATE: moved whole, the old path a symlink, so an open file, a running
  # sidecar reading its key, and any absolute path recorded anywhere still
  # resolve. The host key in particular IS this box's identity in the fleet.
  for pair in /var/lib/agent-hub:/var/lib/fleetwright \
              /var/lib/agent-fleet:/var/lib/fleetwright-sidecar \
              /var/lib/agent-fleet-coordinator:/var/lib/fleetwright-coordinator; do
    old="${pair%%:*}"; new="${pair#*:}"
    [ -d "$old" ] && [ ! -L "$old" ] || continue
    if [ -e "$new" ]; then warn "$new already exists — leaving $old where it is"; continue; fi
    mv "$old" "$new"
    ln -s "$new" "$old"
    ok "$old → $new"
  done

  # ENV FILES: moved, keys renamed, the old path left as a symlink. A key that
  # would collide with one already renamed in the same file is commented out
  # with a note rather than silently overriding it.
  #
  # A PATH IS REWRITTEN ONLY IF ITS DIRECTORY MOVED. The state moves above
  # refuse when the new name already exists; an env file then pointing at the
  # new name would name a directory without the host key, and the sidecar
  # would mint a fresh identity. So each rewrite is on the list only when the
  # old path is now a symlink or gone.
  PATH_SEDS=(-e 's#/run/agent-fleet#/run/fleetwright-sidecar#g'
             -e 's#/etc/agent-fleet-sidecar\.env#/etc/fleetwright-sidecar.env#g'
             -e 's#/etc/agent-fleet-coordinator\.env#/etc/fleetwright-coordinator.env#g'
             -e 's#/etc/agent-hub\.env#/etc/fleetwright.env#g')
  moved() { [ -L "$1" ] || [ ! -e "$1" ]; }
  moved /var/lib/agent-fleet-coordinator && PATH_SEDS+=(-e 's#/var/lib/agent-fleet-coordinator#/var/lib/fleetwright-coordinator#g')
  moved /var/lib/agent-fleet && PATH_SEDS+=(-e 's#/var/lib/agent-fleet/#/var/lib/fleetwright-sidecar/#g' -e 's#/var/lib/agent-fleet$#/var/lib/fleetwright-sidecar#')
  moved /var/lib/agent-hub && PATH_SEDS+=(-e 's#/var/lib/agent-hub#/var/lib/fleetwright#g')
  # 0600 from the first byte: this is a copy of a file holding tokens.
  umask 077
  for pair in /etc/agent-hub.env:/etc/fleetwright.env \
              /etc/agent-fleet-sidecar.env:/etc/fleetwright-sidecar.env \
              /etc/agent-fleet-coordinator.env:/etc/fleetwright-coordinator.env; do
    old="${pair%%:*}"; new="${pair#*:}"
    [ -f "$old" ] && [ ! -L "$old" ] || continue
    if [ -e "$new" ]; then warn "$new already exists — leaving $old where it is"; continue; fi
    mv "$old" "$new"
    ln -s "$new" "$old"
    awk '
      /^AGENT_(HUB|FLEET)_[A-Z0-9_]*=/ {
        key = $0; sub(/=.*/, "", key); nk = key; sub(/^AGENT_(HUB|FLEET)_/, "FLEETWRIGHT_", nk)
        if (nk in seen) { print "# renamed from " key ", which duplicated " nk " above: " $0; next }
        seen[nk] = 1; sub(/^AGENT_(HUB|FLEET)_/, "FLEETWRIGHT_"); print; next
      }
      /^FLEETWRIGHT_[A-Z0-9_]*=/ { key = $0; sub(/=.*/, "", key); seen[key] = 1 }
      { print }
    ' "$new" \
      | sed "${PATH_SEDS[@]}" \
      > "$new.renaming" && cat "$new.renaming" > "$new" && rm -f "$new.renaming"
    ok "$old → $new, settings renamed to FLEETWRIGHT_*"
  done
  umask 022

  # SUDOERS: the rules this box already agreed to, rewritten for the new unit
  # names and validated before the old ones go. A rule that does not validate
  # is left as it was — a broken sudoers.d file breaks sudo, not one rule.
  for f in /etc/sudoers.d/agent-hub-*; do
    [ -f "$f" ] || continue
    new="/etc/sudoers.d/fleetwright-${f#/etc/sudoers.d/agent-hub-}"
    if [ ! -e "$new" ]; then
      sed -e 's/agent-hub-apt-update/fleetwright-apt-update/g' -e 's/agent-hub-upgrade/fleetwright-upgrade/g' \
          -e 's/agent-fleet-sidecar/fleetwright-sidecar/g' -e 's/agent-fleet-coordinator/fleetwright-coordinator/g' \
          -e 's/agent-hub/fleetwright/g' "$f" > "$new.tmp"
      if command -v visudo >/dev/null 2>&1 && visudo -cf "$new.tmp" >/dev/null 2>&1; then
        install -m 0440 "$new.tmp" "$new"
      else
        rm -f "$new.tmp"
        warn "could not rewrite $f for the new names — left in place"
        continue
      fi
      rm -f "$new.tmp"
    fi
    rm -f "$f"
    ok "$f → $new"
  done
}
migrate_legacy_names "$@"

# MOVED DOWN, BECAUSE IT SPOKE BEFORE IT COULD SPEAK.
#
# This block was twenty lines above `warn()`, and its else-branch calls `warn`.
# Under `set -euo pipefail` that is not a missing message — it is
#
#     install.sh: line 131: warn: command not found
#
# and the installer EXITS, having done nothing. Which boxes hit the else-branch?
# Only the broken ones. So the guard added to rescue a box whose release is
# missing killed the installer on precisely those boxes and no others, while
# every healthy box took the if-branch and never noticed.
#
# Found by drilling it, not by reading it: scenarios 10 and 13 both failed with
# the units still naming a release that was not there, because install.sh had
# died before it wrote any. The same shape as `CHECK_ONLY` being read before the
# argument loop set it — code placed above the thing it depends on — and the fix
# is the same one: move the block, do not paper over the symptom.
#
CONVERTED=0
if [ "$PACKAGED" = 0 ] && [ -f /etc/systemd/system/fleetwright.service ] \
   && grep -q "$FLEET_BASE/current" /etc/systemd/system/fleetwright.service 2>/dev/null; then
  # AND THE RELEASE IT NAMES HAS TO BE THERE. "Converted" meant "the unit points
  # at the release tree", which is true of a box whose release tree is GONE —
  # and that is a state boxes reached, because an earlier installer deleted the
  # directory it was running out of and left `current` dangling.
  #
  # On such a box every path agreed to leave things alone: the units were
  # pointed at a release that did not exist, unit_entry fell back to a bin/ that
  # did not exist either, the conversion was not offered because the box looked
  # converted, and the service restarted six thousand times.
  #
  # A box whose payload is missing is not converted. It is broken, and the
  # checkout beside it works — so it goes back to that, says so, and offers the
  # conversion again.
  # EITHER NAME: a release built before the rename has lib/agent-hub.mjs and
  # nothing else, and it is exactly what a converted box has under `current`
  # until the refresh below replaces it. Checking only the new name un-converted
  # every such box the one-liner touched.
  if [ -f "$FLEET_BASE/current/lib/fleetwright.mjs" ] || [ -f "$FLEET_BASE/current/lib/agent-hub.mjs" ]; then
    CONVERTED=1
  else
    warn "$FLEET_BASE/current does not contain a usable release"
    warn "  the units point there and nothing is behind them — putting this box"
    warn "  back on the checkout, which works, and offering the move again below"
    rm -f "$FLEET_BASE/current"
  fi
fi


# --- what this script is installing onto -----------------------------------
#
# Checked FIRST, because the first thing a Mac used to hit was `getent:
# command not found` on the line that looks up a home directory — a tool
# nobody has heard of, failing under `set -e`, naming nothing about the cause.
#
# NOT a refusal. A Mac as a fleet host is intended, so this installs what it
# can and says exactly where it stops, rather than putting up a wall that has
# to be taken down again later. What it cannot do yet is listed at the end of
# the run, not hidden in a comment here.
PLATFORM=linux
case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=macos ;;
  *) PLATFORM=unknown ;;
esac
# Collected as they are skipped, and printed together at the end. One warning
# in the middle of two hundred lines of output is a warning nobody read.
MISSING=()

# WHO THIS SERVICE RUNS AS — READ FROM THE UNIT, NOT GUESSED FROM WHO IS TYPING.
#
# The order used to be FLEETWRIGHT_USER, then SUDO_USER, then whoever is running
# this. That is right for a FIRST install and wrong for every later one, because
# on an existing box the service user is a property of the machine and not of
# the person at the keyboard.
#
# WHAT IT COST. fleetwright-migrate ends by handing off to this installer, and
# that handoff sets neither variable — it is already root, so there is no
# SUDO_USER. RUN_USER became `root`, so the chown that gives the service user
# its release tree ran as `chown -R root` on a root-owned tree: a no-op that
# reported success. The box came out of the migration unable to apply its own
# updates, with
#
#     update failed: EACCES: permission denied,
#     mkdir '/opt/fleetwright/releases/.incoming-main-67'
#
# on every attempt afterwards. #411 fixed the missing chown; this is why it
# still did nothing on the path that matters most.
#
# It also stops a quieter one: person B running `sudo ./install.sh` on a box
# installed by person A used to re-point the units at B and chown the tree to
# them — a rerun silently changing whose service this is.
#
# The unit is the answer, which is the same rule fleetwright-migrate states
# about what a box RUNS. An explicit FLEETWRIGHT_USER still wins: somebody setting
# it is deliberately changing the answer.
unit_user() {
  # THE HUB'S UNIT ONLY. The sidecar's names a different account since #270,
  # and reading it here would make that account the owner of the sessions on
  # the one box where the hub's unit was missing.
  for u in /etc/systemd/system/fleetwright.service; do
    [ -f "$u" ] || continue
    # `User=` only, and the first one: a unit has other lines with users in them.
    got="$(sed -n 's/^User=[[:space:]]*//p' "$u" | head -1)"
    # A NAME THAT STILL EXISTS. A unit naming a deleted account would otherwise
    # hand every chown below a user that cannot own anything.
    [ -n "$got" ] && id "$got" >/dev/null 2>&1 && { printf '%s' "$got"; return 0; }
  done
  return 1
}
RUN_USER="${FLEETWRIGHT_USER:-$(unit_user || printf '%s' "${SUDO_USER:-$(id -un)}")}"

# WHO THE SIDECAR RUNS AS — ITS OWN ACCOUNT. The sidecar holds this box's
# private key and the coordinator socket; $RUN_USER holds every member's Claude
# and provider credential and runs the sessions. One uid for both meant each
# could read the other's secrets (#270). The account is created below, once
# say/ok/warn exist, and the sidecar's unit, state directory and env file are
# given to it. FLEETWRIGHT_SIDECAR_USER names another account instead — set it
# to $RUN_USER to keep the old shape on purpose.
#
# Not on a Mac: launchd daemons run as a named user, and making a hidden
# system account through dscl is more machinery than this installer wants to
# own for a platform hardening.md says is not the one this is built for.
SIDECAR_USER="${FLEETWRIGHT_SIDECAR_USER:-fleetwright-sidecar}"
[ "$PLATFORM" = macos ] && SIDECAR_USER="${FLEETWRIGHT_SIDECAR_USER:-$RUN_USER}"

# WHERE THE SIDECAR'S CODE LIVES, WHICH IS NOT THE RELEASE TREE.
#
# A separate account is worth nothing if $RUN_USER can change what that
# account runs. The release tree is $RUN_USER's on purpose — applyRelease
# unpacks into releases/ and swaps `current` as that user — and the sidecar
# unit used to run `node <base>/current/lib/fleetwright-sidecar.mjs` straight
# out of it. So $RUN_USER, or a session escape landing as it, could rewrite
# the sidecar's code, write the hub's restart marker, and be running as the
# sidecar's account three seconds later with the host key in reach. #270's
# line was a uid and not a boundary.
#
# So on a packaged Linux box the sidecar runs from a ROOT-OWNED copy here,
#
#   <store>/releases/<version>/   a read-only copy of a verified release
#   <store>/current -> releases/<version>   the newest copy root made
#   <store>/launch.mjs            picks which copy to run (see that file)
#
# written only by root, only from a tree root has verified and $RUN_USER cannot
# reach — the deb's sha-checked extract, the tarball bootstrap.sh checked, the
# copy fleetwright-migrate checked — and NEVER copied out of releases/, which
# is the same "root reading what the service user can rewrite" this file's
# header records about the installer itself. See refresh_sidecar_store.
SIDECAR_BASE="${FLEETWRIGHT_SIDECAR_BASE:-/usr/local/lib/fleetwright-sidecar}"
# 1 once this run has a usable copy in the store; the sidecar's unit, its CLI
# link and every command run as the sidecar then point there.
SIDECAR_STORE=0

# Resolved once, up here, because finding node depends on it — sudo hides
# anything a version manager put in this directory.
#
# Not plain getent: it is glibc's, so it is absent on macOS and on musl images
# such as Alpine, where this used to abort on line 28 under `set -e` naming a
# command rather than a cause. The tilde form is what bash consults the
# password database with, and works wherever bash does.
user_home() {
  local u="$1" home=""
  if command -v getent >/dev/null 2>&1; then
    home="$(getent passwd "$u" 2>/dev/null | cut -d: -f6 || true)"
  fi
  if [ -z "$home" ] && [ -r /etc/passwd ]; then
    home="$(awk -F: -v u="$u" '$1 == u { print $6; exit }' /etc/passwd || true)"
  fi
  # macOS keeps real accounts in Directory Services, not /etc/passwd — that
  # file exists there but lists only system users, so the lookup above finds
  # nothing for a person and finds it silently.
  if [ -z "$home" ] && command -v dscl >/dev/null 2>&1; then
    home="$(dscl . -read "/Users/$u" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"
  fi
  printf '%s' "$home"
}
USER_HOME="$(user_home "$RUN_USER")"

# THE WORKSPACES, which are the one legacy path in somebody's home. Moved like
# the state directories — whole, with a symlink left behind — so every session
# the registry recorded by its absolute path, and every shell sitting in one,
# still resolves. Only when nobody chose the place: a workdir set in the env
# file is a decision, and it stays where it was put.
#
# AS $RUN_USER, in their home (run_as): between root's look and root's `mv`,
# fleetwright-runs could become a link to a directory of root's, and `mv` into
# a directory moves INTO it.
if [ "$(id -u)" = 0 ] && [ -n "$USER_HOME" ] && [ -d "$USER_HOME/agent-runs" ] && [ ! -L "$USER_HOME/agent-runs" ] \
   && [ ! -e "$USER_HOME/fleetwright-runs" ] \
   && ! grep -qE '^(FLEETWRIGHT|AGENT_HUB)_WORKDIR=.' "$ENV_FILE" 2>/dev/null; then
  case " $* " in *" --check "*|*" -n "*|*" --help "*|*" -h "*) ;; *)
    if run_as "$RUN_USER" mv "$USER_HOME/agent-runs" "$USER_HOME/fleetwright-runs" \
       && run_as "$RUN_USER" ln -s fleetwright-runs "$USER_HOME/agent-runs"; then
      ok "~$RUN_USER/agent-runs → ~$RUN_USER/fleetwright-runs"
    else
      warn "could not move ~$RUN_USER/agent-runs to ~$RUN_USER/fleetwright-runs as $RUN_USER"
    fi ;;
  esac
fi
USER_HOME="${USER_HOME:-$HOME}"

# --check verifies the prerequisites and changes nothing. Worth having as a
# first step on a box you are not sure about, rather than finding out halfway
# through that node is invisible to sudo.
CHECK_ONLY=0
# ask = report what is here and do nothing; yes = offer to remove it.
CLEAN=ask
# The wizard asks the handful of questions that otherwise become a checklist at
# the end. It runs when there is a terminal to ask on, and never otherwise — a
# piped or scripted install must behave exactly as it always has.
WIZARD=auto
while [ $# -gt 0 ]; do
  case "$1" in
    --check|-n) CHECK_ONLY=1 ;;
    --clean|--reinstall) CLEAN=yes ;;
    --wizard) WIZARD=yes ;;
    --no-wizard|--yes|-y) WIZARD=no ;;
    -h|--help)
      printf 'usage: install.sh [--check] [--clean] [--wizard|--no-wizard]\n\n'
      printf '  --check       verify prerequisites and change nothing\n'
      printf '  --wizard      force the interactive setup even without a terminal\n'
      printf '  --no-wizard   never ask; write templates and print the next steps\n'
      printf '  --upgrade     an already-enrolled box onto new code: no questions,\n'
      printf '                restarts the services, and checks the protocol matches\n'
      printf '  --repair      --upgrade, and put back everything this installer\n'
      printf '                generates: units, the hook, and the sudoers rules this\n'
      printf '                box has already agreed to. Never changes an answer\n'
      printf '  --from-source stay a git checkout. For a box somebody EDITS; every\n'
      printf '                other install ends up on packaged releases\n'
      printf '  --grant reboot=on|off      change one answer the wizard asked, and nothing\n'
      printf '  --grant upgrades=on|off    else: the rule, the recorded answer, a restart.\n'
      printf '                             `sudo fleetwright grant …` is the same thing\n'
      exit 0 ;;
    --grant)
      # ONE ANSWER, CHANGED ON PURPOSE, AND NOTHING ELSE TOUCHED. The wizard
      # asks about upgrades and reboot once and records the answer; --repair
      # re-applies the recorded answers and never changes one. So a box that
      # said no on install day — every apt box, which is asked nothing and
      # takes the defaults — had no way to say yes later except a hand-written
      # sudoers line and an edit to a root-owned env file. This is that way:
      # `sudo fleetwright grant reboot on` runs it.
      shift
      case "${1:-}" in
        reboot=on|reboot=yes|reboot=1|reboot=true)        GRANT_REBOOT=yes ;;
        reboot=off|reboot=no|reboot=0|reboot=false)       GRANT_REBOOT=no ;;
        upgrades=on|upgrades=yes|upgrades=1|upgrades=true)  GRANT_UPGRADES=yes ;;
        upgrades=off|upgrades=no|upgrades=0|upgrades=false) GRANT_UPGRADES=no ;;
        *) die "--grant takes reboot=on|off or upgrades=on|off (got: ${1:-nothing})" ;;
      esac
      GRANT_ONLY=1 ;;
    --repair)
      # EVERYTHING THIS INSTALLER GENERATES, PUT BACK, and nothing it was told.
      #
      # Sections 2, 4 and 5 already rewrite what they own on every run — the
      # units, the hook, the directories — so a plain unattended run repairs
      # most of a drifted box already. What it does NOT put back is the pair of
      # sudoers rules, because those live behind questions in the wizard, and
      # the wizard does not run when nobody is there to answer.
      #
      # The answers are already recorded in the env file. A repair re-applies
      # the rules that the box has already said yes to, which is how a machine
      # whose rule predates a change gets the current one without being asked
      # again about a decision it already made.
      REPAIR=1; UPGRADE=1; WIZARD=no ;;
    --from-source)
      # THE ESCAPE HATCH docs/packaging.md has named since packaging shipped and
      # nothing implemented. A development box wants the checkout: it is a thing
      # somebody edits, and `/update` pulling into it is the point.
      #
      # Everything else should end up packaged, which is what the block at the
      # end of this script now makes happen.
      FROM_SOURCE=1 ;;
    --upgrade)
      # AN ALREADY-CONFIGURED BOX, BROUGHT ONTO NEW CODE, WITH NO QUESTIONS.
      #
      # `FLEETWRIGHT_NONINTERACTIVE=1` has always existed and does half the job:
      # it skips the wizard, which is also where the services get restarted. So
      # an unattended run put the new code on disk and left the old code
      # RUNNING, reporting success — the exact failure update.js is written
      # around ("the new code is on disk but this process is still the old
      # one"). This flag is the other half.
      UPGRADE=1; WIZARD=no ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
# WHERE AN ANSWER COMES FROM, WHICH IS NOT ALWAYS STDIN.
#
# A piped install has no stdin of its own — the shell is reading the script
# through it — so `read` sees EOF and every question silently takes its default.
#
# bootstrap.sh ALREADY HANDLES THAT for the documented one-liner: it opens
# /dev/tty and re-execs this script with stdin attached to it, so
# `curl … | sudo sh` has always reached the wizard. This is not a fix for that,
# and it would be wrong to describe it as one.
#
# What it fixes is the DEPENDENCE. Being askable was a property of how this
# script happened to be invoked, so every other way of running it —
# `sh -c "$(curl …)"`, piping straight into install.sh, any wrapper — got a
# silent wizard that took defaults on somebody's box. Opening the terminal here
# means the script that asks the questions is the one that finds the person.
#
# Empty means there is genuinely nobody: cron, a CI job, a container build. Then
# `ask` returns the default without printing a prompt nobody will see.
#
# OPENED, NOT STAT'ED. `[ -r /dev/tty ]` is true on every Linux box, because the
# device node is there and world-readable — it says nothing about whether THIS
# process has a controlling terminal behind it. Without one, every `read` from
# it fails with "No such device or address", printed once per question into a
# log, while the question silently takes its default. `fleetwright join` under
# cron, Ansible or a container found this: it forces the wizard and had no
# terminal to force it onto. Opening the device is the only honest test.
if [ -t 0 ]; then ASK_IN=/dev/stdin
elif { : </dev/tty; } 2>/dev/null; then ASK_IN=/dev/tty
else ASK_IN=""; fi
# NOBODY TO ASK, EVEN WITH A TERMINAL IN THE ROOM. A deb's postinst runs with
# apt's terminal attached and debconf holding it: the questions have already
# been asked THERE, and the answers arrive in the environment. Reading /dev/tty
# underneath debconf fights its frontend for the screen, and under Ansible or
# unattended-upgrades there is nobody at all. So the package says so, and every
# question takes its default or the answer it was handed.
[ "${FLEETWRIGHT_ASK_NONE:-0}" = "1" ] && ASK_IN=""

REPAIR="${REPAIR:-0}"
[ "${FLEETWRIGHT_REPAIR:-0}" = "1" ] && { REPAIR=1; UPGRADE=1; WIZARD=no; }
FROM_SOURCE="${FROM_SOURCE:-0}"
[ "${FLEETWRIGHT_FROM_SOURCE:-0}" = "1" ] && FROM_SOURCE=1
UPGRADE="${UPGRADE:-0}"
[ "${FLEETWRIGHT_UPGRADE:-0}" = "1" ] && { UPGRADE=1; WIZARD=no; }
[ "${FLEETWRIGHT_NONINTERACTIVE:-0}" = "1" ] && WIZARD=no
# AN ANSWER HANDED IN, for the two questions that write a sudoers rule. debconf
# asks them on a deb box (install/deb/config) and the postinst passes the
# answers here; a flag or `fleetwright grant` sets the same variables. Given,
# the wizard applies the answer instead of asking — even when one is already
# recorded, which is how `dpkg-reconfigure` changes a decision.
grant_answer() { # grant_answer VALUE → yes|no|'' (empty: not given, or not an answer)
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    yes|y|on|1|true) printf yes ;;
    no|n|off|0|false) printf no ;;
    *) printf '' ;;
  esac
}
GRANT_REBOOT="$(grant_answer "${GRANT_REBOOT:-${FLEETWRIGHT_GRANT_REBOOT:-}}")"
GRANT_UPGRADES="$(grant_answer "${GRANT_UPGRADES:-${FLEETWRIGHT_GRANT_UPGRADES:-}}")"
GRANT_ONLY="${GRANT_ONLY:-0}"
if [ "$WIZARD" = auto ]; then
  # SOMEWHERE TO ASK, AND SOMEWHERE TO SHOW IT.
  #
  # This was `[ -t 0 ] && [ -t 1 ]`, which is right whenever stdin is the
  # terminal — including the documented one-liner, because bootstrap.sh
  # reattaches /dev/tty before running this. $ASK_IN widens it to every other
  # way of piping the script in, where a person is watching and stdin is not
  # theirs. Asking questions nobody can answer is still worse than not asking,
  # and that is still what the empty case is for.
  if [ -n "$ASK_IN" ] && [ -t 1 ]; then WIZARD=yes; else WIZARD=no; fi
fi
[ "$CHECK_ONLY" = 1 ] && WIZARD=no

if [ "$PACKAGED" = 1 ]; then
  RELEASE_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DIR/package.json" | head -1)"
  [ -n "$RELEASE_VERSION" ] || RELEASE_VERSION="unversioned"
  # A NAME, NEVER A PATH — the rule fleetwright-migrate, release.js and the
  # sidecar's store apply to the same string. On the heal it is read out of
  # `current`, which the service user writes, and below it is a directory root
  # removes and copies into: a version of ../../../etc/systemd/system was an
  # `rm -rf` and a copy of the service user's tree there, as root.
  case "$RELEASE_VERSION" in
    .*|*[!A-Za-z0-9._+-]*) die "the release's version \"$RELEASE_VERSION\" is not a plain name — refusing to lay it out. Nothing was changed." ;;
  esac
  RELEASE_DIR="$FLEET_BASE/releases/$RELEASE_VERSION"

  # RESOLVED, BECAUSE $DIR CAN BE THE SYMLINK POINTING AT $RELEASE_DIR, and
  # comparing those two as strings said "different" about one directory.
  #
  # This is what a migration does: fleetwright-migrate lays the release out,
  # points `current` at it, and runs the installer from `$FLEET_BASE/current`.
  # So $DIR is /opt/fleetwright/current and $RELEASE_DIR is
  # /opt/fleetwright/releases/v0.2.3 — the same directory by two names. The
  # block then ran, and its FIRST ACT was `rm -rf "$RELEASE_DIR"`: it deleted
  # the directory it was running out of, leaving `current` dangling, and the
  # copy that came next failed with
  #
  #     cp: cannot stat '/opt/fleetwright/current/.': No such file or directory
  #
  # on a real box, on the first migration that got this far. The block was
  # written for a release unpacked SOMEWHERE ELSE — a tarball in /tmp — and
  # nothing had ever run it from `current` until the migration existed.
  #
  # `pwd -P` is the whole fix: it resolves symlinks, so a release installing
  # itself recognises itself and skips straight to the symlink it already is.
  DIR_REAL="$(cd "$DIR" 2>/dev/null && pwd -P)" || DIR_REAL="$DIR"
  #
  # AND ONLY FROM A PAYLOAD OUTSIDE THE RELEASE TREE. The copy exists for a
  # release unpacked somewhere root vouched for — the deb's extract, the
  # tarball bootstrap.sh checked, root's own copy under /usr/local/lib — and
  # never has a reason to run from inside $FLEET_BASE, which is the service
  # user's: from there the source, the version that names the destination
  # and every directory on the way to it (`releases` can be a symlink they
  # planted) are theirs, and root would be removing and writing wherever they
  # chose. The units name `current` either way.
  #
  # NOR FOR --grant, which changes one answer and lays nothing out. Run from
  # root's copy (section 6), this block would otherwise have replaced the
  # release the hub runs with a root-owned one on every grant.
  PAYLOAD_IN_BASE=0
  case "$DIR/" in "${FLEET_BASE%/}"/*) PAYLOAD_IN_BASE=1 ;; esac
  #
  # AND AS WHOEVER OWNS $FLEET_BASE (run_as). On every box after the first
  # install that is $RUN_USER — the end of this file gives it to them — and an
  # apt upgrade they can start runs this from the deb's extract, outside the
  # tree, so the copy runs. As root, `releases` was theirs to point anywhere
  # before the `mkdir`, the `rm -rf` and the `cp -a` went through it. So root
  # only reads its own tree, into a pipe, and the owner of the base unpacks
  # it, under a name of this installer's own beside applyRelease's
  # `.incoming-`, and swaps `current`. A base still root's (a first install)
  # is root's to write.
  if [ "$DIR_REAL" != "$RELEASE_DIR" ] && [ "$CHECK_ONLY" != 1 ] && [ "$GRANT_ONLY" != 1 ] && [ "$PAYLOAD_IN_BASE" = 0 ]; then
    BASE_OWNER="$(owner_of "$FLEET_BASE")"
    if [ -n "$BASE_OWNER" ] && [ "$BASE_OWNER" != root ]; then
      # Replaced atomically. `ln -sfn` on an existing symlink is not atomic on
      # every filesystem, and a symlink that briefly does not exist is a
      # service that briefly cannot start.
      tar -C "$DIR" -cf - . | run_as "$BASE_OWNER" sh -c '
        set -e
        mkdir -p "$1/releases"
        rm -rf "$1/releases/.installing-$2"
        mkdir "$1/releases/.installing-$2"
        tar -xpf - -C "$1/releases/.installing-$2"
        rm -rf "$1/releases/$2"
        mv "$1/releases/.installing-$2" "$1/releases/$2"
        ln -sfn "$1/releases/$2" "$1/.current.new"
        mv -Tf "$1/.current.new" "$1/current"' sh "$FLEET_BASE" "$RELEASE_VERSION" \
        || die "could not lay $RELEASE_VERSION out in $FLEET_BASE as $BASE_OWNER, whose directory it is."
    else
      mkdir -p "$FLEET_BASE/releases"
      rm -rf "$RELEASE_DIR"
      cp -a "$DIR/." "$RELEASE_DIR"
      ln -sfn "$RELEASE_DIR" "$FLEET_BASE/.current.new"
      mv -Tf "$FLEET_BASE/.current.new" "$FLEET_BASE/current"
    fi
  fi
  # Everything below templates units and runs binaries from here, so it is the
  # symlink and not the versioned directory: that is what makes the next
  # release a symlink swap instead of an installer run.
  [ -L "$FLEET_BASE/current" ] && DIR="$FLEET_BASE/current"
fi

# Installing missing OS packages rather than printing a command for someone to
# copy is the difference between "one installer" and "an installer plus a
# checklist". It is only ever used for packages from the distro's own
# repositories — nothing here pipes a remote script into a shell.
#
# FLEETWRIGHT_NO_INSTALL_DEPS=1 turns it off for a box where package management is
# somebody else's job.
# --- asking things ----------------------------------------------------------


ask() { # ask VAR "prompt" [default]
  __var="$1"; __prompt="$2"; __default="${3:-}"
  if [ -z "$ASK_IN" ]; then printf -v "$__var" '%s' "${3:-}"; return 0; fi
  if [ -n "$__default" ]; then printf '  %s [%s]: ' "$__prompt" "$__default"
  else printf '  %s: ' "$__prompt"; fi
  IFS= read -r __reply <"$ASK_IN" || __reply=""
  [ -z "$__reply" ] && __reply="$__default"
  printf -v "$__var" '%s' "$__reply"
}

confirm() { # confirm "prompt" [Y|N]  → 0 for yes
  __default="${2:-Y}"
  case "$__default" in
    Y|y) __hint="[Y/n]" ;;
    *)   __hint="[y/N]" ;;
  esac
  if [ -z "$ASK_IN" ]; then __reply="$__default"; else
  printf '  %s %s: ' "$1" "$__hint"
  IFS= read -r __reply <"$ASK_IN" || __reply=""
  fi
  [ -z "$__reply" ] && __reply="$__default"
  case "$__reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# A secret nobody has to think about. Every one of these is a value with no
# decision content — leaving them blank for an operator to generate and paste
# is pure friction, and the reason people end up running with none at all.
gen_secret() {
  if command -v openssl >/dev/null; then openssl rand -hex 24
  else "$NODE_BIN" -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
  fi
}

# Set KEY=VALUE in an env file, but ONLY if it is currently empty. An operator
# who has already put something there keeps it on every re-run — the same
# promise the whole installer makes about /etc files.
#
# Done in node rather than sed because these values are secrets and may contain
# any character at all.
set_env() { # set_env FILE KEY VALUE
  ENVFILE="$1" ENVKEY="$2" ENVVAL="$3" "$NODE_BIN" -e '
    const fs = require("fs");
    const { ENVFILE, ENVKEY, ENVVAL } = process.env;
    const lines = fs.readFileSync(ENVFILE, "utf8").split("\n");
    let done = false;
    const out = lines.map((line) => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m || m[1] !== ENVKEY) return line;
      done = true;
      // Already set by hand — leave it exactly as it is.
      if (m[2].trim() !== "") return line;
      return `${ENVKEY}=${ENVVAL}`;
    });
    if (!done) out.push(`${ENVKEY}=${ENVVAL}`);
    fs.writeFileSync(ENVFILE, out.join("\n"));
  '
}

# Set KEY=VALUE in an env file, WHATEVER is there. The one for an answer that
# is being CHANGED: `fleetwright grant reboot on` on a box whose file recorded
# FLEETWRIGHT_SYSTEM_REBOOT=0 wrote the sudoers rule, restarted the hub, and
# left the 0 in place, because set_env above keeps a value that is already
# set — the right promise for a token somebody pasted, and the wrong one for
# a decision somebody just made. The hub then went on refusing a reboot the
# rule allowed. Anchored to the live line: a commented-out `#KEY=` stays a
# comment.
put_env() { # put_env FILE KEY VALUE
  ENVFILE="$1" ENVKEY="$2" ENVVAL="$3" "$NODE_BIN" -e '
    const fs = require("fs");
    const { ENVFILE, ENVKEY, ENVVAL } = process.env;
    const text = fs.readFileSync(ENVFILE, "utf8");
    const line = new RegExp(`^${ENVKEY}=.*$`, "m");
    const out = line.test(text)
      ? text.replace(line, `${ENVKEY}=${ENVVAL}`)
      : `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}${ENVKEY}=${ENVVAL}\n`;
    fs.writeFileSync(ENVFILE, out);
  '
}

# Read a value back out of an env file.
#
# CANNOT FAIL, AND THAT IS THE POINT. This is a reader whose contract is "empty
# means unset" — and under `set -euo pipefail` it killed the entire installer
# when the file did not exist. `sed` exits 2 on a file it cannot read, pipefail
# promotes that through the pipeline, and set -e ends the script.
#
# It did so SILENTLY, and in the worst place: the protocol check, which runs
# after the services have been restarted. A migration that had completely
# succeeded printed "Checking the protocol" and stopped, exited non-zero, and
# was reported to whoever ran it as "the migration did not finish".
#
# Found by scripts/migration-drill.sh on the first scenario it ran, which is
# the argument for the drill.
get_env() { # get_env FILE KEY
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -1 || true
}

# A CONVERTED BOX IS BROUGHT FORWARD, NOT JUST RE-POINTED.
#
# Re-running the one-liner on a packaged box used to rewrite its units, restart
# it, and leave `current` on whatever release it was already on. That is fine
# when the release works, and it is the whole problem when it does not:
#
#   deb13-staging runs v0.2.3, whose releaseLayout() refuses a packaged box's
#   own path. Its own update path answers "there is no symlink to swap" — so it
#   cannot update itself to a version where that is fixed, and fixing main does
#   not reach it, because a box runs the RELEASE's code and not main's. Check
#   from the app reported the refusal and nothing could act on it.
#
# THE INSTALLER IS THE ONLY WAY IN, and it is the way in precisely because it is
# the one component that does not come from the release: it comes from the
# checkout, which the one-liner refreshes. So "re-run the installer" has to mean
# "bring this box onto the release its channel points at", or the box is stuck
# with no route out except a person with a shell.
#
# Cheap to run every time: the helper fetches one manifest, compares it to the
# version under `current`, and exits saying "nothing to do" when they match.
# That is what makes this a self-heal rather than a thing to remember.
#
# BEFORE THE UNITS AND THE RESTART BELOW, deliberately. A box whose release is
# crash-looping is exactly the box that needs this, and restarting the broken
# release first is how the run dies before reaching the repair.
refresh_release_if_converted() {
  [ "$CONVERTED" = 1 ] || return 0
  [ "$FROM_SOURCE" = 0 ] || return 0          # --from-source is the way BACK
  [ "$CHECK_ONLY" != 1 ] || return 0
  [ "$PACKAGED" = 0 ] || return 0             # we ARE the release being laid out
  [ -z "${FLEETWRIGHT_MIGRATING:-}" ] || return 0   # the helper re-ran us; do not loop
  [ -n "$(get_env "$ENV_FILE" FLEETWRIGHT_RELEASE_MANIFEST)" ] || return 0

  # THE TREE'S HELPER, NOT THE INSTALLED SNAPSHOT. /usr/local/sbin's copy was
  # taken by whichever install ran last, so a fix to the helper would otherwise
  # not take effect until the run AFTER the one that installed it — which has
  # already happened once on a real box.
  HELPER=/usr/local/sbin/fleetwright-migrate
  [ -x "$SELF_DIR/install/fleetwright-migrate" ] && HELPER="$SELF_DIR/install/fleetwright-migrate"
  [ -x "$HELPER" ] || return 0

  say "Packaged release"
  # Failure is NOT fatal: a box that cannot reach GitHub still has a working
  # release under `current`, and the rest of this run still repairs its units —
  # which on its own is what fixed a box whose unit template was wrong.
  FLEETWRIGHT_MIGRATING=1 "$HELPER" \
    || warn "could not refresh the release — carrying on with the one this box has"
}

# THE SIDECAR'S STORE, refreshed from the one tree this run can vouch for.
#
# WHICH TREE THAT IS: the installer's own, $SELF_DIR, when it is a release and
# $RUN_USER cannot change it — checked, not assumed. Every root route into
# this file that has a verified release arrives exactly that way: the deb's
# postinst runs the installer out of its sha-checked extract, bootstrap.sh out
# of the tarball it checked, fleetwright-migrate out of the one it checked,
# each unpacked into a 0700 directory of root's. $DIR is never the source: on
# all three it is, or becomes, `current`, which $RUN_USER can repoint.
#
# NO VERIFIED TREE, NO REFRESH. Root running the installer out of `current` by
# hand, or a checkout's installer on a converted box, has nothing to vouch for,
# so a store that is already there is kept and the sidecar goes on running the
# copy it has. That is the version skew this design accepts, said plainly: an
# update applied by $RUN_USER alone (/update with no fleetwright-migrate to
# heal it) moves the hub and NOT the sidecar, which keeps its root-owned
# release until root next runs a verified installer. The sidecar's health
# frame says so — `head` is the tree it runs, `installed` is `current` — and
# the apps already draw that gap. Where the heal does run, it IS such an
# installer, so on an ordinary box the two move together.
#
# A CHECKOUT GETS NO STORE. It is a thing somebody edits and /update pulls into
# as $RUN_USER, so there is no verified tree to copy, and a snapshot of
# whatever is in it would only be a copy of what $RUN_USER chose. The sidecar
# runs from the checkout and the check below says, in words, that the host key
# is not protected from $RUN_USER on this box.
refresh_sidecar_store() {
  SIDECAR_STORE=0
  [ "$PLATFORM" = linux ] && [ "$SIDECAR_USER" != "$RUN_USER" ] && [ "$CHECK_ONLY" != 1 ] && [ "$(id -u)" = 0 ] || return 0
  # Only a box that runs packaged releases. --from-source is the way back to
  # the checkout, and a store left over from before keeps nothing running.
  { [ "$PACKAGED" = 1 ] || { [ "$CONVERTED" = 1 ] && [ "$FROM_SOURCE" = 0 ]; }; } || return 0

  # THE STORE ITSELF HAS TO BE ROOT'S, all the way down. A FLEETWRIGHT_BASE or
  # FLEETWRIGHT_SIDECAR_BASE that puts it inside the tree chowned to $RUN_USER
  # would make every copy below a copy into their hands.
  if [ -e "$SIDECAR_BASE" ] || [ -L "$SIDECAR_BASE" ]; then
    if run_user_can_alter "$SIDECAR_BASE"; then
      warn "$SIDECAR_BASE can be changed by $RUN_USER, so it cannot hold the sidecar's code"
      return 0
    fi
  elif run_user_can_alter "$(dirname "$SIDECAR_BASE")"; then
    warn "$(dirname "$SIDECAR_BASE") can be changed by $RUN_USER, so the sidecar's code cannot live under it"
    return 0
  fi

  local src="$SELF_DIR" ver have="" previous r
  if [ -f "$SIDECAR_BASE/launch.mjs" ] && [ -f "$SIDECAR_BASE/current/lib/fleetwright-sidecar.mjs" ]; then
    have="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SIDECAR_BASE/current/package.json" 2>/dev/null | head -1 || true)"
    have="${have:-a version that cannot be read}"
  fi

  if [ -f "$src/lib/fleetwright-sidecar.mjs" ] && [ -f "$src/install/fleetwright-sidecar-launch.mjs" ] \
     && ! run_user_can_alter "$src"; then
    ver="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$src/package.json" 2>/dev/null | head -1 || true)"
    # A NAME, NEVER A PATH — the rule fleetwright-migrate and release.js apply
    # to the same string, and launch.mjs applies again before it uses one.
    case "$ver" in
      ''|.*|*[!A-Za-z0-9._+-]*) warn "the release's version \"$ver\" is not a plain name — not copying it for the sidecar"; ver="" ;;
    esac
    # ALREADY ROOT'S COPY. Root's `fleetwright join` runs the installer out of
    # this store (section 6), so the verified tree can be the copy itself, and
    # copying a directory over itself would remove the tree this script is
    # being read from on the way.
    if [ -n "$ver" ] && [ "$(cd "$src" 2>/dev/null && pwd -P)" = "$(cd "$SIDECAR_BASE/releases/$ver" 2>/dev/null && pwd -P)" ]; then
      ok "the sidecar runs $ver from $SIDECAR_BASE — this installer is root's copy of it"
      SIDECAR_STORE=1
      return 0
    fi
    if [ -n "$ver" ]; then
      install -d -m 0755 -o root -g root "$SIDECAR_BASE" "$SIDECAR_BASE/releases"
      previous="$(basename "$(readlink "$SIDECAR_BASE/current" 2>/dev/null || true)")"
      rm -rf "$SIDECAR_BASE/releases/.incoming-$ver"
      cp -a "$src/." "$SIDECAR_BASE/releases/.incoming-$ver"
      # Whatever uid the archive carried, and nothing anybody else may write.
      chown -R root:root "$SIDECAR_BASE/releases/.incoming-$ver"
      chmod -R u+rwX,go+rX,go-w "$SIDECAR_BASE/releases/.incoming-$ver"
      rm -rf "$SIDECAR_BASE/releases/$ver"
      mv "$SIDECAR_BASE/releases/.incoming-$ver" "$SIDECAR_BASE/releases/$ver"
      # Atomically, for the reason the release lay-out above gives.
      ln -sfn "releases/$ver" "$SIDECAR_BASE/.current.new"
      mv -Tf "$SIDECAR_BASE/.current.new" "$SIDECAR_BASE/current"
      install -m 0644 -o root -g root "$SIDECAR_BASE/releases/$ver/install/fleetwright-sidecar-launch.mjs" "$SIDECAR_BASE/launch.mjs"
      # THIS ONE AND THE ONE IT REPLACED, the deb's rule for releases/. The
      # one before is what the commit-confirm watchdog points `current` back
      # at, and launch.mjs follows `current` when root has a copy of it — so
      # tidying it away would leave a revert that moves the hub and not the
      # sidecar. Re-copying the live version replaced nothing, so nothing goes.
      if [ -n "$previous" ] && [ "$previous" != "$ver" ]; then
        for r in "$SIDECAR_BASE"/releases/*; do
          [ -d "$r" ] || continue
          case "$(basename "$r")" in "$ver"|"$previous") ;; *) rm -rf "$r" ;; esac
        done
      fi
      ok "the sidecar runs $ver from $SIDECAR_BASE — root's copy of the verified release"
      SIDECAR_STORE=1
      return 0
    fi
  fi

  if [ -n "$have" ]; then
    SIDECAR_STORE=1
    local hub
    hub="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$FLEET_BASE/current/package.json" 2>/dev/null | head -1 || true)"
    if [ "$hub" = "$have" ]; then
      ok "the sidecar runs $have from $SIDECAR_BASE, the release the hub runs"
    else
      warn "no verified copy of the release in this run ($src is not one), so the sidecar keeps running"
      warn "  $have from $SIDECAR_BASE while the hub runs ${hub:-something else} — apt, the one-liner"
      warn "  or sudo /usr/local/sbin/fleetwright-migrate brings it level"
    fi
  fi
  return 0
}

# CAN $RUN_USER CHANGE WHAT THIS PATH IS? The question the sidecar's
# separation stands or falls on, asked of its code, its node and the directory
# it runs in, and of every tree root is about to copy into the store.
#
# "Writable" is not the question. A file can be 0644 root and still be
# $RUN_USER's to replace, if any directory on the way to it is theirs: rename
# the parent, put a tree of their own in its place. So every directory from /
# down is asked, and a symlink on the way is followed and its target's path
# asked too — `current` is exactly such a symlink, and the entry it lives in
# decides where it points. Then, for a directory, everything under it.
#
# Two things make it NOT alterable on the way down, and both are load-bearing
# for the cases this is used on:
#   - a directory $RUN_USER cannot search: nothing below it can be reached.
#     The deb's extract and fleetwright-migrate's copy sit in a 0700 root
#     directory under /tmp, and that is what makes them safe to copy from.
#   - a sticky directory (/tmp) protects an entry $RUN_USER does not own.
#
# Read from the mode bits with the owner/group/other precedence the kernel
# applies, as GNU stat reports them — not by running `test -w` as the user,
# which needs root and an account to test, and gets /tmp's sticky bit wrong.
# ACLs are not read; a box that grants $RUN_USER write through one has said so
# itself. Linux only, which is the only place the sidecar has its own account.
#
# Returns 0 when $RUN_USER could change it — and when it cannot tell, because
# a check that fails open is not a check.
#
# With `notree`, only the path and the thing itself are asked, not what is
# under it: whether $RUN_USER decides what that name resolves to.
run_user_can_alter() { # run_user_can_alter PATH [notree] → 0 when $RUN_USER could change PATH or anything under it
  local uid gids
  uid="$(id -u "$RUN_USER" 2>/dev/null)" || return 0
  [ "$uid" = 0 ] && return 0
  gids=" $(id -G "$RUN_USER" 2>/dev/null) "
  RUA_UID="$uid" RUA_GIDS="$gids" _rua_walk "$1" 0 "${2:-}"
}
# The permission bits that apply to $RUN_USER for one stat line, 7 for an
# owner: an owner can chmod, so every bit is theirs whatever the mode says.
_rua_bits() { # _rua_bits UID GID MODE
  local m=$((8#$3))
  if [ "$1" = "$RUA_UID" ]; then echo 7
  elif case "$RUA_GIDS" in *" $2 "*) true ;; *) false ;; esac; then echo $(((m >> 3) & 7))
  else echo $((m & 7)); fi
}
_rua_walk() { # _rua_walk PATH DEPTH [notree]
  local path="$1" depth="$2" notree="${3:-}" cur="/" next c rest i uid gid mode kind bits pbits puid sticky target g
  local -a parts
  [ "$depth" -lt 40 ] || return 0
  case "$path" in /*) ;; *) path="$PWD/$path" ;; esac
  IFS=/ read -r -a parts <<<"$path"
  read -r uid gid mode kind < <(stat -c '%u %g %a %F' -- / 2>/dev/null) || return 0
  [ "$uid" = "$RUA_UID" ] && return 0
  for ((i = 0; i < ${#parts[@]}; i++)); do
    c="${parts[$i]}"
    case "$c" in ''|.) continue ;; ..) cur="$(dirname "$cur")"; continue ;; esac
    read -r puid gid mode kind < <(stat -c '%u %g %a %F' -- "$cur" 2>/dev/null) || return 0
    pbits="$(_rua_bits "$puid" "$gid" "$mode")"
    sticky=$(((8#$mode) & 01000))
    # Cannot search the directory: nothing in it is reachable, this included.
    [ $((pbits & 1)) = 1 ] || return 1
    next="${cur%/}/$c"
    if ! read -r uid gid mode kind < <(stat -c '%u %g %a %F' -- "$next" 2>/dev/null); then
      # Not there. Theirs to create if the directory is theirs to write.
      [ $((pbits & 2)) = 2 ] && return 0
      return 1
    fi
    # The entry itself: replaceable through a writable parent, unless the
    # parent is sticky and the entry is somebody else's.
    if [ $((pbits & 2)) = 2 ] && { [ "$sticky" = 0 ] || [ "$uid" = "$RUA_UID" ] || [ "$puid" = "$RUA_UID" ]; }; then
      return 0
    fi
    [ "$uid" = "$RUA_UID" ] && return 0
    if [ "$kind" = "symbolic link" ]; then
      target="$(readlink -- "$next")" || return 0
      case "$target" in /*) ;; *) target="${cur%/}/$target" ;; esac
      rest="$(IFS=/; printf '%s' "${parts[*]:$((i + 1))}")"
      _rua_walk "${target%/}${rest:+/$rest}" $((depth + 1)) "$notree"
      return $?
    fi
    cur="$next"
  done
  # The thing itself, then — for a directory — everything under it.
  read -r uid gid mode kind < <(stat -c '%u %g %a %F' -- "$cur" 2>/dev/null) || return 0
  bits="$(_rua_bits "$uid" "$gid" "$mode")"
  [ $((bits & 2)) = 2 ] && return 0
  [ "$kind" = directory ] && [ -z "$notree" ] || return 1
  # A directory they cannot search hides everything in it, as on the way down.
  [ $((bits & 1)) = 1 ] || return 1
  local -a groupw=()
  for g in $RUA_GIDS; do groupw+=(-o -group "$g"); done
  # Owned by them, or writable by everybody, or by a group they are in.
  # Symlinks report 0777 and mean nothing by it, so they are followed instead.
  if [ -n "$(find "$cur" \( -user "$RUA_UID" -o \( ! -type l \( -perm -0002 -o \( -perm -0020 \( -false "${groupw[@]}" \) \) \) \) \) -print -quit 2>/dev/null)" ]; then
    return 0
  fi
  # A symlink in the tree is asked where it lands — the path to it and the
  # thing itself, not a second walk of everything under it, and not at all
  # when it lands inside the tree just scanned.
  while IFS= read -r -d '' target; do
    target="$(readlink -f -- "$target" 2>/dev/null)" || return 0
    case "$target/" in "${cur%/}/"*) continue ;; esac
    _rua_walk "$target" $((depth + 1)) notree && return 0
  done < <(find "$cur" -type l -print0 2>/dev/null)
  return 1
}

# MAY ROOT EXECUTE THIS? Not when $RUN_USER could replace it: that is root
# running their program. The question for every binary root runs out of
# somewhere the service user reaches — a node in ~/.nvm, a claude in
# ~/.local/bin — on every route, and most of all on the heal, which the service
# user can start for itself with `sudo -n fleetwright-migrate`. Linux only,
# like run_user_can_alter; a Mac is a checkout, which is $RUN_USER's whole.
root_may_run() { # root_may_run PATH → 0 when root may execute PATH
  [ "$PLATFORM" = linux ] && [ "$(id -u)" = 0 ] && [ "$RUN_USER" != root ] || return 0
  ! run_user_can_alter "$1"
}

# IS THIS DAEMON RUNNING, BY LAUNCHD'S OWN WORD. `launchctl bootstrap`
# returning 0 says the request was accepted, and nothing else: a job whose
# spawn fails sits at "spawn scheduled" with KeepAlive retrying it, and
# bootstrap has already said yes. The installer reported "fleetwright running"
# over exactly that, and its own doctor two lines later could not reach the
# hub. So the state line is read, and given a moment to become `running`.
# On failure the reason launchd knows is printed — the last exit code is
# where EX_CONFIG shows up — with the tail of the log if there is one.
launchd_running() { # launchd_running NAME
  local label="system/network.thetech.$1" state="" i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    state="$(launchctl print "$label" 2>/dev/null | awk '/^\tstate = / {print $3}')"
    if [ "$state" = running ]; then
      # RUNNING HAS TO HOLD. A process that exits within seconds — the hub
      # with no tmux on its PATH did, three times — is `running` between
      # spawn and exit, and that window is exactly when this first looked.
      sleep 3
      state="$(launchctl print "$label" 2>/dev/null | awk '/^\tstate = / {print $3}')"
      [ "$state" = running ] && return 0
    fi
    sleep 1
  done
  warn "$1 is '${state:-not loaded}', not running:"
  launchctl print "$label" 2>/dev/null | grep -E '^\t(state|last exit code|runs) = ' | sed 's/^/       /' || true
  tail -n 12 "/var/log/$1.log" 2>/dev/null | sed 's/^/       /' || true
  return 1
}

# LOAD A DAEMON, REPLACING ANY COPY THAT IS LOADED, AND SAY WHY IF IT WON'T.
#
# `launchctl bootout` returns before launchd has finished tearing the job down,
# and a `bootstrap` of the same label in that window fails — "Bootstrap failed:
# 5: Input/output error" — with the old job gone and nothing in its place. The
# upgrade path did exactly that on a GitHub macOS runner: the hub logged its
# SIGTERM and never started again, and the installer said only "did not come
# back", because bootstrap's own refusal went to /dev/null and launchd_running
# was never reached to say more.
#
# So: bootout, WAIT until launchd no longer knows the label, then bootstrap —
# retried, since the teardown can outlast the wait on a busy box — and print
# launchd's own words when it still refuses. Every load of a daemon goes
# through here; test/install-upgrade.test.js holds that.
launchd_reload() { # launchd_reload NAME
  local label="system/network.thetech.$1" plist="/Library/LaunchDaemons/network.thetech.$1.plist"
  local i err=""
  launchctl bootout "$label" >/dev/null 2>&1 || true
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    launchctl print "$label" >/dev/null 2>&1 || break
    sleep 0.5
  done
  for i in 1 2 3; do
    if err="$(launchctl bootstrap system "$plist" 2>&1)"; then
      launchd_running "$1"
      return
    fi
    sleep 2
  done
  warn "launchd refused to load $1: ${err:-no reason given}"
  return 1
}

# Run something as the target user. `sudo` is not guaranteed to exist — a
# minimal Debian image has none, and neither does a container you are already
# root in — so fall back to running it directly when we are already that user.
as_user() {
  if [ "$(id -un)" = "$RUN_USER" ]; then
    bash -lc "$1"
  elif command -v sudo >/dev/null; then
    sudo -u "$RUN_USER" -H bash -lc "$1"
  elif command -v runuser >/dev/null; then
    runuser -l "$RUN_USER" -c "$1"
  else
    return 1
  fi
}

# The same with an argv instead of a line, and no login shell, for what WRITES
# in $RUN_USER's home or any directory of theirs (run_as, at the top). Root
# must not do that itself: the home is theirs, and a
# symlink they leave at the path is followed by root's write and by root's
# chown, which then lands on whatever it points at — /etc/passwd, say, on the
# next heal, which the service user can start for itself.
run_as_user() { # run_as_user CMD [ARG...]
  run_as "$RUN_USER" "$@"
}

# The same, as the sidecar's account. Never `-l` on runuser and never su
# without -s: the account's shell is nologin, and a login shell of it is a
# refusal that reads like a broken box.
as_sidecar() {
  if [ "$(id -un)" = "$SIDECAR_USER" ]; then
    bash -lc "$1"
  elif command -v sudo >/dev/null; then
    sudo -u "$SIDECAR_USER" -H bash -lc "$1"
  elif command -v runuser >/dev/null; then
    runuser -u "$SIDECAR_USER" -- bash -lc "$1"
  elif command -v su >/dev/null; then
    su -s /bin/bash "$SIDECAR_USER" -c "$1"
  else
    return 1
  fi
}

# Make the sidecar's account exist. A system account with no login shell and
# its home at its state directory — the one place it owns — so a `bash -lc`
# under it has somewhere to be and git has somewhere to read a config from.
# Where no account can be made (no useradd, and no busybox adduser either) the
# sidecar falls back to $RUN_USER and the summary says so, rather than a unit
# naming a user that does not exist.
SIDECAR_USER_FALLBACK=0
ensure_sidecar_user() {
  [ "$SIDECAR_USER" = "$RUN_USER" ] && return 0
  if id "$SIDECAR_USER" >/dev/null 2>&1; then
    ok "$SIDECAR_USER exists"
    return 0
  fi
  [ "$CHECK_ONLY" = 1 ] && { ok "would create the $SIDECAR_USER account"; return 0; }
  local shell=/usr/sbin/nologin
  [ -x "$shell" ] || shell=/sbin/nologin
  [ -x "$shell" ] || shell=/bin/false
  if command -v useradd >/dev/null \
     && useradd --system --user-group --home-dir /var/lib/fleetwright-sidecar --no-create-home \
                --shell "$shell" "$SIDECAR_USER" 2>/dev/null; then
    ok "created the $SIDECAR_USER account (system, no login)"
  elif command -v adduser >/dev/null \
       && adduser -S -D -H -h /var/lib/fleetwright-sidecar -s "$shell" "$SIDECAR_USER" 2>/dev/null; then
    ok "created the $SIDECAR_USER account (system, no login)"
  else
    warn "could not create the $SIDECAR_USER account — the sidecar will run as $RUN_USER"
    MISSING+=("a separate account for the sidecar: create $SIDECAR_USER (useradd --system) and re-run this")
    SIDECAR_USER="$RUN_USER"
    SIDECAR_USER_FALLBACK=1
  fi
}

PKG_UPDATED=0
pkg_install() {
  [ "${FLEETWRIGHT_NO_INSTALL_DEPS:-0}" = "1" ] && return 1
  # Homebrew REFUSES to run as root, which is the opposite of every package
  # manager below it — so this branch comes before the root check, and runs as
  # the invoking user rather than the one this script became.
  if [ "$PLATFORM" = macos ]; then
    command -v brew >/dev/null || return 1
    as_user "brew install $*" >/dev/null 2>&1
    return $?
  fi
  [ "$(id -u)" = "0" ] || return 1
  if command -v apt-get >/dev/null; then
    if [ "$PKG_UPDATED" = 0 ]; then
      DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
      PKG_UPDATED=1
    fi
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null 2>&1
  elif command -v dnf >/dev/null; then dnf install -y -q "$@" >/dev/null 2>&1
  elif command -v pacman >/dev/null; then pacman -Sy --noconfirm --quiet "$@" >/dev/null 2>&1
  elif command -v zypper >/dev/null; then zypper -nq install "$@" >/dev/null 2>&1
  elif command -v apk >/dev/null; then apk add --quiet "$@" >/dev/null 2>&1
  else return 1
  fi
}

# Why it could not be installed, phrased for whoever has to fix it.
pkg_why() {
  if [ "${FLEETWRIGHT_NO_INSTALL_DEPS:-0}" = "1" ]; then printf 'FLEETWRIGHT_NO_INSTALL_DEPS=1 is set'
  elif [ "$PLATFORM" = macos ]; then printf 'Homebrew is not installed — see https://brew.sh'
  elif [ "$(id -u)" != "0" ]; then printf 'not running as root — re-run with sudo'
  else printf 'no supported package manager found (apt, dnf, pacman, zypper, apk)'
  fi
}

say "fleetwright installer${CHECK_ONLY:+}"
printf '  source : %s\n  user   : %s\n  sidecar: %s\n' "$DIR" "$RUN_USER" "$SIDECAR_USER"
[ "$CHECK_ONLY" = 1 ] && printf '  mode   : --check (nothing will be changed)\n'

# --- 0. what is already here -------------------------------------------------
#
# A separate uninstall script is no use to somebody who does not know it exists,
# and no use at all on a box where the checkout is the thing that is wrong. The
# installer already has to look at every one of these paths, so it can say what
# it found and offer to clear it.
#
# NOT offered on an ordinary re-run. Re-running this to upgrade is the
# documented path and must stay non-destructive — a prompt every time is a
# prompt somebody eventually answers wrong, and the answer costs them the host
# identity. So it asks only when there is a reason: --clean was passed, or the
# key belongs to different hardware.
previous_install() {
  FOUND=()
  for f in /etc/fleetwright.env /etc/fleetwright-sidecar.env /etc/fleetwright-coordinator.env; do
    [ -f "$f" ] && FOUND+=("config    $f")
  done
  if [ -f /var/lib/fleetwright-sidecar/host-key.json ]; then
    local fp=""
    # As whichever account can read the key: the sidecar's on a box that has
    # been through this installer since #270, the session user's before it.
    # AS THE SIDECAR ONLY FROM ROOT'S COPY. $DIR is the payload, which on a
    # packaged box is `current` — $RUN_USER's to rewrite — and code run as the
    # sidecar's account is code that can read the key it is printing.
    if [ -f "$SIDECAR_BASE/current/bin/fleetwright-sidecar" ] && ! run_user_can_alter "$SIDECAR_BASE"; then
      fp="$(as_sidecar "'$SIDECAR_BASE/current/bin/fleetwright-sidecar' identity" 2>/dev/null | awk '/fingerprint/ {print $2}' || true)"
    fi
    [ -n "$fp" ] || fp="$(as_user "'$DIR/bin/fleetwright-sidecar' identity" 2>/dev/null | awk '/fingerprint/ {print $2}' || true)"
    FOUND+=("IDENTITY  /var/lib/fleetwright-sidecar/host-key.json${fp:+  fingerprint $fp}")
  fi
  for d in /var/lib/fleetwright /var/lib/fleetwright-coordinator; do
    [ -d "$d" ] && FOUND+=("state     $d")
  done
  for u in fleetwright fleetwright-sidecar fleetwright-coordinator fleetwright-upgrade fleetwright-apt-update fleetwright-package-upgrade fleetwright-apt-channel@; do
    if [ "$PLATFORM" = macos ]; then
      [ -f "/Library/LaunchDaemons/network.thetech.$u.plist" ] && FOUND+=("service   $u")
    else
      [ -f "/etc/systemd/system/$u.service" ] && FOUND+=("service   $u")
    fi
  done
  for f in /etc/sudoers.d/fleetwright-upgrade /etc/sudoers.d/fleetwright-reboot /etc/sudoers.d/fleetwright-reclaim; do
    [ -f "$f" ] && FOUND+=("sudoers   $f")
  done
  # THE LAST COMMAND OF THIS FUNCTION DECIDES ITS EXIT STATUS, and the loop
  # above ends in a `[ -f ] &&` that is FALSE on any box where the last file is
  # absent — which is every box that has never had this installed. The function
  # then returned 1, `set -euo pipefail` killed the script, and a fresh install
  # died after four header lines with no message at all.
  #
  # Found by a beta tester on their first command. Both --check and the real
  # install died there, so `curl … /install | sudo sh` took a bare machine to
  # four lines and silence.
  #
  # `return 0` says what this function means: it REPORTS, and finding nothing
  # is a perfectly good report. Every loop above has the same shape, so the
  # explicit return is what makes the whole function safe rather than only its
  # last line.
  return 0
}

# A key that belongs to different hardware is the one case where continuing
# quietly is actively wrong: two boxes proving the same identity disconnect each
# other for ever. So a clone escalates from "reporting" to "asking", without
# --clean having to be passed by somebody who does not yet know anything is
# wrong. Read-only here; the rotation itself happens with the rest of the
# identity work further down.
CLONE=0
if [ -f /var/lib/fleetwright-sidecar/host-key.json ] && [ -f /var/lib/fleetwright-sidecar/machine-id ]; then
  NOW_ID=""
  if [ -r /etc/machine-id ]; then NOW_ID="$(cat /etc/machine-id)"
  elif [ -r /var/lib/dbus/machine-id ]; then NOW_ID="$(cat /var/lib/dbus/machine-id)"
  elif command -v ioreg >/dev/null 2>&1; then
    NOW_ID="$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/ {print $4}')"
  fi
  if [ -n "$NOW_ID" ] && [ "$(cat /var/lib/fleetwright-sidecar/machine-id 2>/dev/null)" != "$NOW_ID" ]; then
    CLONE=1
    [ "$CLEAN" = ask ] && CLEAN=yes
  fi
fi

# The two oneshot units the upgrade grant names. Linux only — launchd has no
# equivalent and a Mac host applies nothing from chat — and only when the
# operator has said yes to upgrades, because a unit that runs apt as root is
# part of that decision rather than furniture every box gets.
install_upgrade_units() {
  [ "$PLATFORM" = macos ] && return 0
  install_unit fleetwright-upgrade
  install_unit fleetwright-apt-update
  # The package's own door, for a box apt owns: it names fleetwright and
  # nothing else, and the system unit holds fleetwright for its run.
  install_unit fleetwright-package-upgrade
  # THE SUITE, for a box apt owns: /channel on such a box moves one word on a
  # root-owned sources line, so it is a unit too, a template whose instance is
  # the suite, running a script outside the app's tree for the same reason
  # fleetwright-confirm lives there. The grant names the two instances.
  # From this installer's tree only, never the payload, like the units.
  local channel_src="$SELF_DIR"
  if [ -f "$channel_src/install/fleetwright-apt-channel" ]; then
    install -m 0755 -o root -g root "$channel_src/install/fleetwright-apt-channel" /usr/local/sbin/fleetwright-apt-channel
    install_unit fleetwright-apt-channel@
  fi
  systemctl daemon-reload >/dev/null 2>&1 || true
}

# --- writing the sudoers rules ----------------------------------------------
#
# ONE IMPLEMENTATION, called by the wizard when somebody says yes and by
# --repair when the env file says they already did. Two copies of a rule that
# must match is how a box ends up permitted to run a command the code no longer
# issues — which is exactly the drift --repair exists to undo.
#
# Both validate with visudo BEFORE installing. A malformed file in
# /etc/sudoers.d does not break one rule, it breaks sudo.

# `:` and `=` are sudoers metacharacters — they separate the host, runas and
# command sections — so Dpkg::Options::= must be escaped or visudo rejects the
# whole file. Found by running visudo on it rather than by reading the grammar.
write_upgrade_sudoers() {
  local tmp
  tmp="$(mktemp)"
  # TWO NAMED UNITS, AND NOTHING THAT TAKES ARGUMENTS. This used to grant
  # three exact apt-get command lines, and the grant was the reason
  # fleetwright.service could not keep ProtectSystem: sudo does not escape the
  # hub's mount namespace, so the upgrade ran with the hub's read-only /usr and
  # /etc and dpkg failed on the first conffile. The upgrade now runs in
  # install/fleetwright-upgrade.service — a oneshot with a namespace of its own —
  # and the hub may only START it. `systemctl start <unit>` has no argument
  # anybody can widen; the flags live in the unit, owned by root.
  #
  # The old apt-get lines are not written any more. upgrades.js still tries
  # them when the unit grant is refused, so a box whose rule predates this
  # keeps upgrading the way it did until --repair moves it across.
  #
  # THE THIRD, WITH --no-block: the package unit restarts the hub that starts
  # it, so the hub must not wait on it. The option is part of the granted
  # line — sudo matches the whole argv — and it is the only form permitted.
  #
  # THE FOURTH AND FIFTH ARE ONE TEMPLATE, TWICE: fleetwright-apt-channel@ with
  # the suite as its instance. Granting the template with a wildcard would let
  # the hub name any instance, so the two the script accepts are granted as
  # two exact lines and nothing else matches.
  {
    printf '%s ALL=(root) NOPASSWD: /usr/bin/systemctl start fleetwright-upgrade.service, ' "$RUN_USER"
    printf '/usr/bin/systemctl start fleetwright-apt-update.service, '
    printf '/usr/bin/systemctl start --no-block fleetwright-package-upgrade.service, '
    printf '/usr/bin/systemctl start fleetwright-apt-channel@stable.service, '
    printf '/usr/bin/systemctl start fleetwright-apt-channel@rolling.service\n'
  } > "$tmp"
  if visudo -cf "$tmp" >/dev/null 2>&1; then
    install -m 0440 "$tmp" /etc/sudoers.d/fleetwright-upgrade
    rm -f "$tmp"
    return 0
  fi
  rm -f "$tmp"
  return 1
}

# BECOMING A PACKAGED BOX, which is the one update step that needs root.
#
# Everything else about an update is unprivileged and stays that way: fetch,
# verify a sha256, unpack beside what is running, move a symlink. Switching
# LAYOUTS is different — it rewrites systemd units and reloads the daemon.
#
# THE HELPER IS NOT IN THE INSTALL TREE, and that is the whole security
# argument. The service user can write the install tree — it has to, because
# applyRelease unpacks releases and swaps `current` as that user — so a sudoers
# rule naming a script in there would let the service rewrite the thing it is
# allowed to run as root. It is installed here, root-owned, outside anything the
# service can touch, and the rule names this path exactly.
#
# No arguments, for the reason the apt rule spells its whole command line out:
# sudoers matches argv, and every argument somebody could pass is a widening.
write_migrate_sudoers() {
  local tmp
  tmp="$(mktemp)"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/fleetwright-migrate\n' "$RUN_USER" > "$tmp"
  if visudo -cf "$tmp" >/dev/null 2>&1; then
    install -m 0440 "$tmp" /etc/sudoers.d/fleetwright-migrate
    rm -f "$tmp"
    return 0
  fi
  rm -f "$tmp"
  return 1
}

write_reboot_sudoers() {
  local tmp
  tmp="$(mktemp)"
  printf '%s ALL=(root) NOPASSWD: /usr/bin/systemctl reboot\n' "$RUN_USER" > "$tmp"
  if visudo -cf "$tmp" >/dev/null 2>&1; then
    install -m 0440 "$tmp" /etc/sudoers.d/fleetwright-reboot
    rm -f "$tmp"
    return 0
  fi
  rm -f "$tmp"
  return 1
}

# THE ONE PLACE A GRANT IS TURNED ON OR OFF. The wizard calls it when somebody
# answers, --repair calls it for the answers already recorded, and --grant
# calls it for an answer changed later. Three callers, one implementation:
# the rule, the units it names, and the recorded answer move together, or a
# box ends up permitted something the env file says it is not.
#
# Off REMOVES the rule. A recorded "0" beside a rule still on disk is the
# shape of drift this file keeps finding, and a grant somebody withdrew from
# chat has to be withdrawn from sudo too.
apply_grant() { # apply_grant upgrades|reboot yes|no → 0, or 1 when a rule did not validate
  # A MAC APPLIES NOTHING FROM CHAT. Both rules name systemctl and apt-get,
  # which it does not have, and visudo would accept the line anyway — so a Mac
  # ended up with a sudoers rule permitting two commands that do not exist,
  # recorded as a grant the app then drew as allowed. The answer is recorded
  # as off, with the reason, and no rule is written.
  if [ "$PLATFORM" = macos ]; then
    case "$1" in
      upgrades) put_env "$ENV_FILE" FLEETWRIGHT_SYSTEM_UPGRADE 0 ;;
      reboot)   put_env "$ENV_FILE" FLEETWRIGHT_SYSTEM_REBOOT 0 ;;
      *) die "apply_grant: not a grant: $1=$2" ;;
    esac
    [ "$2" = yes ] && warn "$1 from chat is not available on a Mac — recorded as off (apt and systemctl are Linux)"
    return 0
  fi
  case "$1:$2" in
    upgrades:yes)
      install_upgrade_units
      if write_upgrade_sudoers; then
        put_env "$ENV_FILE" FLEETWRIGHT_SYSTEM_UPGRADE 1
        set_env "$ENV_FILE" FLEETWRIGHT_USER "$RUN_USER"
        ok "/etc/sudoers.d/fleetwright-upgrade — $RUN_USER may start fleetwright-upgrade, fleetwright-apt-update, fleetwright-package-upgrade and fleetwright-apt-channel@{stable,rolling}"
      else
        warn "the upgrade sudoers rule did not validate, so it was NOT installed"
        return 1
      fi ;;
    upgrades:no)
      rm -f /etc/sudoers.d/fleetwright-upgrade
      put_env "$ENV_FILE" FLEETWRIGHT_SYSTEM_UPGRADE 0
      ok "system upgrades from chat are off — /etc/sudoers.d/fleetwright-upgrade removed" ;;
    reboot:yes)
      if write_reboot_sudoers; then
        put_env "$ENV_FILE" FLEETWRIGHT_SYSTEM_REBOOT 1
        set_env "$ENV_FILE" FLEETWRIGHT_USER "$RUN_USER"
        ok "/etc/sudoers.d/fleetwright-reboot — $RUN_USER may run systemctl reboot"
      else
        warn "the reboot sudoers rule did not validate, so it was NOT installed"
        return 1
      fi ;;
    reboot:no)
      rm -f /etc/sudoers.d/fleetwright-reboot
      put_env "$ENV_FILE" FLEETWRIGHT_SYSTEM_REBOOT 0
      ok "reboot from chat is off — /etc/sudoers.d/fleetwright-reboot removed" ;;
    *) die "apply_grant: not a grant: $1=$2" ;;
  esac
  return 0
}

# RECLAIMING A ROOT-OWNED RELEASE prune COULD NOT DELETE. An update runs as the
# service user; when prune meets a legacy release left root-owned by an old
# `sudo` install it renames it aside to `.stale-` and carries on, because the
# unprivileged process cannot remove a root-owned tree. This rule lets the
# service user run the one helper that can, and it is scoped exactly the way the
# migrate rule is: root-owned, outside the writable install tree, no arguments —
# so the caller cannot widen it, and the helper itself removes only
# `<base>/releases/.stale-*` and nothing else.
write_reclaim_sudoers() {
  local tmp
  tmp="$(mktemp)"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/fleetwright-reclaim\n' "$RUN_USER" > "$tmp"
  if visudo -cf "$tmp" >/dev/null 2>&1; then
    install -m 0440 "$tmp" /etc/sudoers.d/fleetwright-reclaim
    rm -f "$tmp"
    return 0
  fi
  rm -f "$tmp"
  return 1
}

# --- 0. --grant: one answer, changed on purpose --------------------------------
#
# Everything this needs is defined above this line, and nothing below it runs:
# a grant is not an install, and a box asking to allow reboots from chat should
# not have its units rewritten and its hook reinstalled on the way.
if [ "$GRANT_ONLY" = 1 ]; then
  [ "$(id -u)" = 0 ] || die "changing a grant writes /etc/sudoers.d, so it needs root: sudo fleetwright grant …"
  [ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist, so this box is not installed yet — install first, then grant"
  { command -v visudo >/dev/null && [ -d /etc/sudoers.d ]; } || die "no visudo or no /etc/sudoers.d on this box, so nothing here can be granted"
  say "Changing what this box allows from chat"
  # THE NODE THIS RUNS, before section 1 has found one. put_env records the
  # answer through node, and the first `fleetwright grant reboot on` on a
  # real box stopped at "NODE_BIN: unbound variable" for want of this line.
  # `fleetwright grant` names the node it runs on in FLEETWRIGHT_NODE_BIN; a
  # hand-run of --grant gets whatever node is on PATH.
  NODE_BIN="${FLEETWRIGHT_NODE_BIN:-$(command -v node || true)}"
  [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || die "no node to record the answer with — run it as: sudo fleetwright grant …"
  root_may_run "$NODE_BIN" || die "$NODE_BIN is a node $RUN_USER can replace, and recording the answer runs it as root. Nothing was changed.
       Name a system one: sudo FLEETWRIGHT_NODE_BIN=/usr/bin/node $0 --grant …"
  if [ -n "$GRANT_UPGRADES" ]; then apply_grant upgrades "$GRANT_UPGRADES" || exit 1; fi
  if [ -n "$GRANT_REBOOT" ]; then apply_grant reboot "$GRANT_REBOOT" || exit 1; fi
  # THE SERVICE READS THE ANSWER AT START, so it restarts here rather than
  # leaving a box whose env file says one thing and whose process believes
  # another until somebody remembers. Sessions keep running: they live in tmux
  # and in containers, not in the hub.
  if command -v systemctl >/dev/null 2>&1; then
    for u in fleetwright "$(legacy_unit_for fleetwright)"; do
      systemctl cat "$u.service" >/dev/null 2>&1 || continue
      if systemctl restart "$u" >/dev/null 2>&1; then
        ok "$u restarted, so the change is live — sessions keep running"
      else
        warn "$u did not restart; sudo systemctl restart $u applies the change"
      fi
      break
    done
  fi
  exit 0
fi

# --- 1. prerequisites -------------------------------------------------------
say "Checking prerequisites"

# THE NODE FLOOR, IN ONE PLACE. package.json is the source of truth and
# test/install-node-floor.test.js pins this to it — they drifted once already,
# with the manifest saying 24 while this script admitted 18, so `--check`
# printed "ok" on a box that could not run any of it.
NODE_FLOOR=24

# Finding node is not as simple as `command -v`, and the reason has bitten every
# operator who installs it the normal way. `sudo` replaces PATH with sudoers'
# secure_path — typically /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# — so a node installed by nvm, fnm, volta, asdf or into ~/.local/bin is
# invisible to this script even though `node -v` works perfectly in the shell
# the operator just ran `sudo` from. An earlier version of this script reported
# "node is not installed" at somebody with a working Node 24.
#
# So: ask the run user's own login shell, then look where the common installers
# actually put things. Same treatment `claude` already gets below.
# Every node this box has, in preference order. Emitting them all rather than
# returning the first is what fixes the bug below.
node_candidates() {
  command -v node 2>/dev/null || true
  # The login shell of whoever invoked sudo — this is what picks up nvm's and
  # asdf's shell functions and shims.
  as_user 'command -v node' 2>/dev/null || true
  for candidate in \
      /usr/local/bin/node /usr/bin/node /snap/bin/node \
      "$USER_HOME/.local/bin/node" "$USER_HOME/.volta/bin/node" "$USER_HOME/.asdf/shims/node" \
      /home/linuxbrew/.linuxbrew/bin/node; do
    [ -x "$candidate" ] && printf '%s\n' "$candidate"
  done
  # nvm and fnm keep one directory per version; take the newest. sort -V, not
  # sort — otherwise v9.9.9 beats v24.10.0.
  for root in "$USER_HOME/.nvm/versions/node" "$USER_HOME/.local/share/fnm/node-versions" "$USER_HOME/.fnm/node-versions"; do
    [ -d "$root" ] || continue
    newest="$(ls -1d "$root"/*/bin/node "$root"/*/installation/bin/node 2>/dev/null | sort -V | tail -1)"
    [ -n "$newest" ] && [ -x "$newest" ] && printf '%s\n' "$newest"
  done
}

# THE NEWEST-ENOUGH NODE, NOT THE FIRST ONE.
#
# This returned on the first hit, which is `command -v node`. On a box that has
# never had node it falls through to the nvm and fnm search and works — which is
# why it worked on a clean host. On a box with the DISTRIBUTION'S node
# installed, /usr/bin/node wins, and Debian ships 20: the installer refused a
# machine where prereq.sh had just put 24 in the run user's home, minutes
# earlier, and named the wrong one in the error.
#
# Reported from a real install, and the shape is one this script has already
# paid for once — "found something" is not the same question as "found the
# thing that works", and the two only diverge on boxes that are not fresh.
#
# Falls back to the first candidate when none is new enough, so the refusal can
# still say WHICH node it looked at rather than "node is not installed" on a box
# that plainly has one.
find_node() {
  first=""
  for candidate in $(node_candidates); do
    [ -x "$candidate" ] || continue
    [ -n "$first" ] || first="$candidate"
    major="$(node_major "$candidate" 2>/dev/null || true)"
    case "$major" in ''|*[!0-9]*) continue ;; esac
    if [ "$major" -ge "$NODE_FLOOR" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  [ -n "$first" ] && { printf '%s\n' "$first"; return 0; }
  return 1
}

# Ask a node something, as $RUN_USER when it is theirs to replace. Finding a
# node runs every candidate for its version, and the candidates include the
# service user's own (their PATH, ~/.local/bin, the newest ~/.nvm): asked as
# root, that was their program, run as root, on every heal.
node_ask() { # node_ask NODE ARG...
  if root_may_run "$1"; then "$@"; else as_user "$(printf '%q ' "$@")"; fi
}

# Major version, or empty if that is not a working node.
node_major() {
  major="$(node_ask "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$major"
}

# AN EXPLICIT OVERRIDE IS LOOKED AT FIRST, before the search. The deb's
# postinst names the node it ships in FLEETWRIGHT_NODE_BIN and sets
# FLEETWRIGHT_NO_INSTALL_DEPS, on a box that may have no other node at all —
# which is the point of shipping one. The search ran first, found nothing,
# and died asking for a node to be installed, with the override one line
# below it never reached. Checked again below: the override is still a path
# somebody named, and it still has to be a node that is new enough.
NODE_BIN="${FLEETWRIGHT_NODE_BIN:-$(find_node || true)}"

# Missing entirely: install it, the same way tmux and podman are installed.
if [ -z "$NODE_BIN" ]; then
  if [ "$CHECK_ONLY" = 1 ]; then
    warn "node is not installed — the installer would install it"
  else
    say "Installing node"
    if pkg_install nodejs && NODE_BIN="$(find_node || true)" && [ -n "$NODE_BIN" ]; then
      ok "installed node $(node_ask "$NODE_BIN" -v)"
    else
      die "node is not installed and could not be installed automatically ($(pkg_why)).
       Install Node $NODE_FLOOR or newer and re-run. If \`node -v\` already works for you,
       that is sudo's secure_path hiding it — point at it directly:
           sudo FLEETWRIGHT_NODE_BIN=\$(command -v node) $0"
    fi
  fi
fi

# An explicit override always wins.
NODE_BIN="${FLEETWRIGHT_NODE_BIN:-${NODE_BIN:-}}"
if [ -n "$NODE_BIN" ]; then
  [ -x "$NODE_BIN" ] || die "FLEETWRIGHT_NODE_BIN=$NODE_BIN is not an executable file."
  NODE_MAJOR="$(node_major "$NODE_BIN")" || die "could not read a version from $NODE_BIN — is it really node?"

  # A distro whose nodejs package is older than we need. Say which, rather than
  # leaving someone to work out why a fresh install still fails.
  # $NODE_FLOOR, WHICH IS WHAT package.json SAYS. This read 18 and recommended
  # nodesource's 22 line, so `--check` printed "ok node v20.19.2" on a box
  # that cannot run this — package.json has said `>=24` and docs/deployment.md
  # has said 24 for some time, and the gate that actually stops somebody never
  # moved. A floor nobody enforces is a hope, and this one was a hope that
  # printed the word "ok".
  #
  # Pinned to the manifest by test/install-node-floor.test.js, because the way
  # this drifted is that the two live in different files and only one of them is
  # read when the requirement changes.
  # REFUSED, AND NOT HEALED. Piping a third-party installer into root bash to
  # add an apt repository and a signing key is a different kind of act from
  # `apt-get install nodejs`, and it is not one this script gets to make on
  # somebody's behalf. What it owes them is to refuse BEFORE anything is
  # destroyed — which is what moving section 1b below buys — and to name the
  # command rather than the problem.
  [ "$NODE_MAJOR" -ge "$NODE_FLOOR" ] || die "node $NODE_MAJOR at $NODE_BIN is too old — this needs $NODE_FLOOR or newer (package.json says >=$NODE_FLOOR).
       Nothing has been changed on this box.

       The prerequisite step installs it into your user's home with nvm, and is
       separate because changing how this machine gets software is not a thing
       an installer does on your behalf:
           curl -fsSL ${FLEETWRIGHT_COORDINATOR_URL:-https://fleet.thetech.network}/prereq | sudo sh

       Or install node any other way — nvm, fnm, a backport — and re-run. If
       you already have one that sudo cannot see:
           sudo FLEETWRIGHT_NODE_BIN=\$(command -v node) $0"

  # AND ROOT'S NODE IS ONE THE SERVICE USER CANNOT REPLACE. Everything below
  # runs "$NODE_BIN" as root — the env files, the tokens, the sidecar's
  # environment — and the one found above is often theirs: prereq.sh puts node
  # in their ~/.nvm, and fleetwright-migrate's heal names none. So a system
  # node is preferred for root's own work whenever the found one is theirs; the
  # units' choice is made separately below, and the hook is written as them.
  if ! root_may_run "$NODE_BIN"; then
    ROOT_NODE_FOUND=""
    for candidate in /usr/lib/fleetwright/node/bin/node "$(command -v node 2>/dev/null || true)" /usr/local/bin/node /usr/bin/node /snap/bin/node; do
      [ -n "$candidate" ] && [ -x "$candidate" ] && root_may_run "$candidate" || continue
      candidate_major="$(node_major "$candidate")" || continue
      [ "$candidate_major" -ge "$NODE_FLOOR" ] || continue
      ROOT_NODE_FOUND="$candidate"
      break
    done
    if [ -n "$ROOT_NODE_FOUND" ]; then
      ok "$NODE_BIN is $RUN_USER's to replace, so this installer runs $ROOT_NODE_FOUND instead"
      NODE_BIN="$ROOT_NODE_FOUND"
    elif [ -n "${FLEETWRIGHT_PAYLOAD:-}" ]; then
      # THE ROUTE NOBODY IS WATCHING, which the service user can start: refused.
      die "every node $NODE_FLOOR+ on this box is one $RUN_USER can replace ($NODE_BIN), and this installer
       runs node as root, so this heal stops here. Install a system node $NODE_FLOOR or newer (a backport, or
       the apt package of fleetwright, which brings its own) and the next update heals."
    else
      # A PERSON RAN THIS, as root, on a box whose only node is the service
      # user's. Said, so it is a decision rather than a surprise.
      warn "$NODE_BIN is the only node $NODE_FLOOR+ here and $RUN_USER can replace it — this run executes it as root"
      warn "  a system node $NODE_FLOOR or newer ends that; the heal after an update refuses to run without one"
      MISSING+=("a system node $NODE_FLOOR or newer: the only one here is $RUN_USER's, and root runs it")
    fi
  fi
  ok "node $(node_ask "$NODE_BIN" -v) at $NODE_BIN"
fi

# The systemd unit hardcodes a node path, and that path has a different job from
# the one the operator's shell uses. A node inside their home is usually nvm's,
# and `nvm install` / `nvm uninstall` moves or removes it — which takes the
# service down at the next restart, long after the change that caused it.
#
# So the unit prefers a SYSTEM node, installing one if there is none. The two
# are allowed to differ: the service wants a path that does not move, the
# operator wants their toolchain.
UNIT_NODE_BIN="${NODE_BIN:-}"
case "${NODE_BIN:-}" in
  "$USER_HOME"/*)
    for attempt in find install; do
      for candidate in /usr/local/bin/node /usr/bin/node; do
        [ -x "$candidate" ] || continue
        candidate_major="$(node_major "$candidate")" || continue
        # The floor, not a number of its own: this read 18, so a box whose node
        # came from the prerequisite step got Debian's 20 installed beside it
        # and the service pointed at that, which cannot run this.
        [ "$candidate_major" -ge "$NODE_FLOOR" ] || continue
        UNIT_NODE_BIN="$candidate"
        break 3
      done
      [ "$attempt" = find ] || break
      [ "$CHECK_ONLY" = 1 ] && break
      say "Installing a system node for the service"
      warn "$NODE_BIN is inside $RUN_USER's home — a version-manager upgrade would move it"
      pkg_install nodejs || true
    done
    if [ "$UNIT_NODE_BIN" = "$NODE_BIN" ]; then
      warn "no system node available — the $([ "$PLATFORM" = macos ] && echo "launchd daemons" || echo "systemd unit") will point at $NODE_BIN"
      warn "  A version-manager upgrade will move it and the service will fail to start."
    else
      ok "systemd will use $UNIT_NODE_BIN — a path that will not move"
    fi
    ;;
esac

# tmux is not optional — it is what holds every session — so a missing one is
# fixed here rather than reported.
if ! command -v tmux >/dev/null; then
  if [ "$CHECK_ONLY" = 1 ]; then
    warn "tmux is not installed — the installer would install it"
  elif pkg_install tmux && command -v tmux >/dev/null; then
    ok "installed tmux"
  else
    die "tmux is not installed and could not be installed automatically ($(pkg_why)).
       Install it and re-run:  apt install -y tmux"
  fi
fi
command -v tmux >/dev/null && ok "tmux $(tmux -V | awk '{print $2}')"

# claude may legitimately be missing at this point — fleetwright can install
# nothing for you, but it CAN log you in once it is running, so this is a
# warning rather than a hard stop.
CLAUDE_HOME="$USER_HOME"

# Look where the official installer actually puts it, not only on PATH. A login
# shell does NOT necessarily see ~/.local/bin: Debian's stock ~/.bashrc returns
# early for non-interactive shells, so the PATH line the Claude installer adds
# there never runs for the `bash -lc` that launches sessions. fleetwright resolves
# an absolute path at startup (src/core/which.js) so this cannot bite it — but
# report accurately here either way.
CLAUDE_BIN=""
for candidate in "$CLAUDE_HOME/.local/bin/claude" /usr/local/bin/claude /usr/bin/claude "$CLAUDE_HOME/.claude/local/claude"; do
  [ -x "$candidate" ] && { CLAUDE_BIN="$candidate"; break; }
done
[ -z "$CLAUDE_BIN" ] && CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"

if [ -n "$CLAUDE_BIN" ]; then
  # ITS VERSION AS $RUN_USER TOO. The first place looked is ~/.local/bin, the
  # service user's own file, and asking it for a version as root ran whatever
  # they had put there as root — on every heal, which they can start with
  # `sudo -n fleetwright-migrate`.
  ok "claude $(as_user "'$CLAUDE_BIN' --version" 2>/dev/null | head -1) at $CLAUDE_BIN"
  # as_user, not root: the credentials live in the service user's home, and
  # this script runs under sudo. Checking as root reports a logged-in box as
  # logged out, which is a scary line in the middle of a successful install.
  if as_user "'$CLAUDE_BIN' auth status --json" 2>/dev/null | grep -q '"loggedIn": *true'; then
    ok "claude is logged in"
  else
    warn "claude is NOT logged in — once the service is up, run 'fleetwright login', or connect an account from the app"
  fi
  # Put it on the login-shell PATH too, so an operator who SSHes in and types
  # `claude` gets the same binary fleetwright uses.
  if ! as_user 'command -v claude' >/dev/null 2>&1; then
    BIN_DIR="$(dirname "$CLAUDE_BIN")"
    PROFILE="$CLAUDE_HOME/.profile"
    # Appended AS $RUN_USER: root's `>>` follows a ~/.profile that is a
    # symlink to /root/.bashrc, and puts the service user's directory on
    # root's PATH.
    if ! grep -qF "$BIN_DIR" "$PROFILE" 2>/dev/null; then
      if printf '\n# added by fleetwright install.sh\nexport PATH="%s:$PATH"\n' "$BIN_DIR" | run_as_user tee -a "$PROFILE" >/dev/null; then
        ok "added $BIN_DIR to $PROFILE (it was missing from the login-shell PATH)"
      else
        warn "could not add $BIN_DIR to $PROFILE as $RUN_USER"
      fi
    fi
  fi
elif [ "$CHECK_ONLY" = 1 ]; then
  warn "claude is not installed — the installer would install it"
else
  # The one thing here that is not a distro package. This runs Anthropic's own
  # installer, as the RUN USER rather than as root, because it installs into
  # ~/.local/bin and a root-owned binary in someone's home is its own problem.
  #
  # Not fatal if it fails: the hub still comes up, still serves its web UI, and
  # still tells you claude is missing. A box you can log into and fix beats an
  # installer that stopped halfway.
  say "Installing the Claude Code CLI"
  command -v curl >/dev/null || pkg_install curl || true
  # A log named by mktemp, root's own, rather than a fixed name in /tmp, where
  # anybody can leave a link for root's `>` to follow. Same for the sandbox's.
  CLAUDE_LOG="$(mktemp "${TMPDIR:-/tmp}/claude-install.XXXXXX")"
  if ! command -v curl >/dev/null; then
    warn "curl is not available ($(pkg_why)) — install claude yourself:"
    warn "  curl -fsSL https://claude.ai/install.sh | bash"
  elif as_user 'curl -fsSL https://claude.ai/install.sh | bash' >"$CLAUDE_LOG" 2>&1; then
    for candidate in "$USER_HOME/.local/bin/claude" "$USER_HOME/.claude/local/claude" /usr/local/bin/claude; do
      [ -x "$candidate" ] && { CLAUDE_BIN="$candidate"; break; }
    done
    if [ -n "$CLAUDE_BIN" ]; then
      ok "installed claude $(as_user "'$CLAUDE_BIN' --version" 2>/dev/null | head -1) at $CLAUDE_BIN"
      warn "claude is NOT logged in yet — run 'fleetwright login', or connect an account from the app"
    else
      warn "the claude installer finished but no binary was found — see $CLAUDE_LOG"
    fi
  else
    warn "could not install claude — see $CLAUDE_LOG. Install it yourself:"
    warn "  curl -fsSL https://claude.ai/install.sh | bash"
  fi
fi

# podman is optional — sessions run fine without it, just not sandboxed — so a
# failure to install is a warning rather than a stop. It is still attempted,
# because "sandboxed sessions" is not much use as a feature you have to go and
# enable the prerequisites for yourself.
HAVE_PODMAN=0
# Rootless podman on macOS is not rootless podman. There is no user namespace
# to be root in, so podman runs a Linux VM (`podman machine`) and every step
# the sandbox setup takes below — newuidmap, /etc/subuid, usermod — is
# meaningless there. Skipping is the honest outcome: allocating nothing and
# then starting sessions that report themselves sandboxed would be worse.
if [ "$PLATFORM" = macos ]; then
  warn "sandboxing is off — podman on macOS needs a Linux VM, which this does not set up"
  MISSING+=("sandboxed sessions: run 'podman machine init && podman machine start', then re-run this")
elif ! command -v podman >/dev/null && [ "$CHECK_ONLY" = 0 ]; then
  say "Installing podman (for sandboxed sessions)"
  if pkg_install podman && command -v podman >/dev/null; then
    ok "installed podman"
  else
    warn "could not install podman ($(pkg_why)) — sessions will run directly on this box"
    warn "  install it yourself and re-run to build the sandbox image"
  fi
fi
if [ "$PLATFORM" = macos ]; then
  : # already reported above; HAVE_PODMAN stays 0 so nothing downstream runs
elif command -v podman >/dev/null; then
  ok "podman $(podman --version | awk '{print $3}') — the sandbox is available"
  HAVE_PODMAN=1
elif [ "$CHECK_ONLY" = 1 ]; then
  warn "podman is not installed — the installer would install it (sandboxing is optional)"
fi

if [ "$CHECK_ONLY" = 1 ]; then
  say "Prerequisites look fine. Nothing was changed — re-run without --check to install."
  exit 0
fi

# --- 1b. a previous install --------------------------------------------------
#
# AFTER THE PREREQUISITES, WHICH IS NOT WHERE THIS USED TO BE, and the move is
# the whole point.
#
# It ran first, so a box could be taken apart — services stopped, identity
# deleted, config removed — and THEN refused at the node version. That is
# exactly what happened on deb13-staging: the clean succeeded, the prerequisite
# check said node 20 is too old, and the box was left out of the fleet with no
# way back in except by hand.
#
# docs/packaging.md already states the rule this violated, about the packaged
# installer: "Nothing is removed until the new fleetwright has been SEEN to
# start. Removing first would leave a box with neither." The same reasoning
# governs the prerequisites, and only the packaged path had been taught it.
#
# Ordering is the entire fix. Anything that can refuse this install has to
# refuse it before anything is destroyed.
previous_install
# Remembered for section 9: converting a box that is ALREADY RUNNING is a
# different question from setting up a fresh one, and gets a different
# default. Recorded here because the block below runs after section 8 has
# tidied FOUND away.
HAD_PREVIOUS=0
[ ${#FOUND[@]} -gt 0 ] && HAD_PREVIOUS=1
if [ ${#FOUND[@]} -gt 0 ] && [ "$CHECK_ONLY" = 0 ]; then
  say "A previous install is already here"
  for f in "${FOUND[@]}"; do printf '  %s\n' "$f"; done

  # The identity is called out separately because it is the one thing here that
  # cannot be recreated: removing it means this box is no longer the host the
  # coordinator knows, and has to be enrolled again.
  if [ -f /var/lib/fleetwright-sidecar/host-key.json ]; then
    printf '\n  The IDENTITY line is this box'"'"'s place in the fleet. Clearing it means\n'
    printf '  enrolling again, and removing the old entry from the coordinator.\n'
  fi

  if [ "$CLONE" = 1 ]; then
    printf '\n  THIS BOX IS A CLONE. That identity was made on different hardware,\n'
    printf '  so the machine it came from still holds the same private key. The\n'
    printf '  coordinator cannot tell the two apart: they will take turns\n'
    printf '  connecting and disconnecting each other, for ever, and neither box\n'
    printf '  will log anything that explains it.\n'
  fi

  # A choice, not a yes/no. "Do you want to clean up?" is ambiguous about what
  # happens if you say no, and this is the one prompt in the script where the
  # wrong answer costs something that cannot be recovered.
  #
  # 1 is the default and is what re-running this has always done. 2 is only the
  # default when the identity provably belongs to another machine, because
  # there "keep it" is not a conservative choice — it is the broken one.
  printf '\n  1) Update      keep the config, the identity and running sessions\n'
  printf '  2) Clean       remove everything above, then install fresh\n'
  if [ "$CLONE" = 1 ]; then
    printf '\n     2 is recommended here: this identity is not this machine'"'"'s.\n'
    CHOICE_DEFAULT=2
  else
    CHOICE_DEFAULT=1
  fi

  # --clean is the same thing without a terminal, and NOBODY THERE means 1 —
  # an unattended install must never destroy an identity nobody was asked about.
  #
  # `! [ -t 0 ]` USED TO BE THAT TEST. It is correct for the documented
  # one-liner, where bootstrap.sh has already attached /dev/tty — and wrong for
  # every other way of piping this script in, where it silently chose Update on
  # a box that may be a clone, which the prompt above calls out as the case
  # where keeping is the broken answer. $ASK_IN asks the terminal, so the
  # reasoning above is satisfied rather than dodged: skipped only when there is
  # genuinely nobody.
  if [ "$CLEAN" = yes ]; then
    CHOICE=2
  elif [ "$WIZARD" = no ] || [ -z "$ASK_IN" ]; then
    CHOICE=1
    printf '\n  Nobody to ask — updating. Pass --clean to remove instead.\n'
  else
    ask CHOICE "Choose" "$CHOICE_DEFAULT"
  fi

  case "$CHOICE" in
    2)
      # Said BEFORE the gate, as what WOULD happen — "Removing." printed while
      # still asking whether to remove is the script claiming an action it has
      # not taken and might not take.
      printf '\n  This would remove everything listed above. ~%s/fleetwright-runs,\n' "$RUN_USER"
      printf '  running sessions and node/tmux/claude are left alone.\n'

      # A second gate, and deliberately not [y/N]. A single keystroke is the
      # wrong weight for the one action in this script that destroys something
      # unrecoverable — the identity is a private key, and there is no copy.
      # Typing a word cannot be done by leaning on the return key.
      if [ -n "$ASK_IN" ]; then
        if [ -f /var/lib/fleetwright-sidecar/host-key.json ]; then
          printf '\n  This deletes the host key. There is no copy, and the coordinator\n'
          printf '  will not recognise this box again until it is enrolled afresh.\n'
        fi
        ask SURE "Are you sure you want to delete? Type YES"
        if [ "$SURE" != YES ]; then
          ok "not deleting — updating instead, nothing above was changed"
          CHOICE=1
        fi
      fi

      if [ "$CHOICE" = 2 ]; then
        say "Removing the previous install"
        # One implementation, called rather than copied: the uninstaller is the
        # thing that knows how to take a box apart, and a second copy of that
        # knowledge here is the copy that goes stale.
        #
        # THIS INSTALLER'S COPY, which root may run: on a packaged route $DIR
        # is `current` by now, and `current` is the service user's to rewrite.
        "$SELF_DIR/install/uninstall.sh" --yes || die "cleanup failed — nothing further was changed"
        ok "cleaned — installing fresh"
      fi
      ;;
    *)
      ok "updating — nothing above was changed"
      [ "$CLONE" = 1 ] && warn "the cloned identity is still in place; this box and its original will fight over it"
      ;;
  esac
fi

# --- 2. state directory -----------------------------------------------------
say "Creating state directory"
STATE_DIR="${FLEETWRIGHT_STATE_DIR:-/var/lib/fleetwright}"
install -d -o "$RUN_USER" -m 0750 "$STATE_DIR"
ok "$STATE_DIR"

# THE SIDECAR'S TOKEN, minted here if the hub has not yet. The hub keeps two:
# the operator's (`api-token`, the web UI's and every command's) and the
# sidecar's (`sidecar-token`, the routes and command shapes the sidecar uses
# and nothing else — src/core/sidecar-scope.js). The sidecar found the first by
# reading the hub's state directory, which stopped working the day it got its
# own account (#270): the directory is $RUN_USER's, 0750, and a sidecar with
# nothing to send is refused by design. So root, which can read both sides,
# mints the second one where the hub will find it and copies it into the
# sidecar's env below. Same file, same mode, whichever process wrote it first.
SIDECAR_TOKEN_FILE="$STATE_DIR/sidecar-token"
#
# WRITTEN AS $RUN_USER, whose directory this is. Root writing it, then
# chowning it, followed a symlink they left at the name: a dangling link to
# /etc/profile.d/x.sh became a root-created file handed to them, which every
# root login shell then sources.
if [ "$CHECK_ONLY" != 1 ] && [ ! -s "$SIDECAR_TOKEN_FILE" ]; then
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' \
    | run_as_user sh -c 'umask 077; { cat; echo; } > "$1" && chmod 0600 "$1"' sh "$SIDECAR_TOKEN_FILE" \
    && ok "minted the sidecar's token at $SIDECAR_TOKEN_FILE" \
    || warn "could not write $SIDECAR_TOKEN_FILE as $RUN_USER — the hub mints it when it starts"
fi

# THE SIDECAR'S, owned by its own account. systemd's StateDirectory= fixes the
# ownership of the directory itself on every start but not of what is in it,
# and what is in it is this box's private key — written by $RUN_USER on every
# box installed before #270. A key the sidecar cannot read is a host that
# cannot prove who it is, so the contents move with the directory, once.
ensure_sidecar_user
if [ "$CHECK_ONLY" != 1 ]; then
  install -d -m 0700 -o "$SIDECAR_USER" /var/lib/fleetwright-sidecar
  if find /var/lib/fleetwright-sidecar -mindepth 1 ! -user "$SIDECAR_USER" 2>/dev/null | grep -q .; then
    chown -R "$SIDECAR_USER" /var/lib/fleetwright-sidecar \
      && ok "/var/lib/fleetwright-sidecar now belongs to $SIDECAR_USER" \
      || warn "could not chown /var/lib/fleetwright-sidecar to $SIDECAR_USER — the sidecar will not be able to read its key"
  else
    ok "/var/lib/fleetwright-sidecar"
  fi
  # A CHECKOUT BELONGS TO $RUN_USER, and git refuses to read a repository owned
  # by somebody else ("dubious ownership") — which would leave the sidecar's
  # version and update fields on the health frame null, for ever, on every box
  # installed from source. The account's home is its state directory, so the
  # one line git needs goes there, for this account alone rather than in
  # /etc/gitconfig for everybody.
  #
  # It switches off the guard that stops $RUN_USER's .git/config running a
  # program as this account, and that is only acceptable because a checkout
  # gives nothing away it had not already: the sidecar runs the checkout's own
  # code, which $RUN_USER can rewrite. Never on a packaged box, which has no
  # .git — and the end of this run says a checkout has no separation.
  #
  # AND TAKEN BACK WHEN THE BOX STOPS BEING ONE. Nothing removed it, so a box
  # converted to packaged releases kept trusting the checkout it left behind
  # (/opt/fleetwright-src, still $RUN_USER's), while the sidecar now runs
  # root's code that $RUN_USER cannot change — and a `core.fsmonitor` in that
  # checkout's .git/config is a program git runs as whoever reads it. A
  # converted box re-running the checkout's installer (the one-liner on an old
  # box does) is not a checkout either, though $DIR has a .git: its units name
  # `current`. Only a box that RUNS its checkout keeps the line.
  SIDECAR_GITCONFIG=/var/lib/fleetwright-sidecar/.gitconfig
  #
  # BOTH AS $SIDECAR_USER (run_as), whose directory this is. Root's `git
  # config --file` writes through a symlink at the name (git's lock file
  # resolves it) and root's chown then follows it too, so whatever the account
  # left there — the sidecar's own, or $RUN_USER's where no separate account
  # could be made — became a root-written file handed to it.
  if [ -d "$DIR/.git" ] && { [ "$CONVERTED" != 1 ] || [ "$FROM_SOURCE" = 1 ]; } \
     && [ "$SIDECAR_USER" != "$RUN_USER" ] && command -v git >/dev/null; then
    run_as "$SIDECAR_USER" sh -c 'cd / && git config --file "$1" --replace-all safe.directory "$2" && chmod 0600 "$1"' \
      sh "$SIDECAR_GITCONFIG" "$DIR" 2>/dev/null \
      && ok "$SIDECAR_USER may read the checkout's git history" \
      || warn "could not write $SIDECAR_USER's git config — the sidecar will report no version"
  elif [ -f "$SIDECAR_GITCONFIG" ] && grep -q 'safe' "$SIDECAR_GITCONFIG" 2>/dev/null; then
    # Filtered rather than `git config --unset-all`, which needs a git this
    # box may not have; the file is the installer's alone, one [safe] section.
    # Replaced by rename, never written through.
    if run_as "$SIDECAR_USER" sh -c '
         tmp="$(mktemp "$1.XXXXXX")" || exit 1
         grep -v -e "^[[:space:]]*\[safe\][[:space:]]*\$" -e "^[[:space:]]*directory[[:space:]]*=" "$1" > "$tmp"
         chmod 0600 "$tmp" && mv -f "$tmp" "$1" || { rm -f "$tmp"; exit 1; }' sh "$SIDECAR_GITCONFIG"; then
      ok "$SIDECAR_USER no longer trusts a checkout's git config — this box does not run one"
    else
      warn "could not remove safe.directory from $SIDECAR_GITCONFIG — remove it by hand"
    fi
  fi
fi

# TASK PROFILES. A session started with no profile comes up idle, waiting for a
# person; a profile is a file here whose content becomes its first message.
#
# THE DIRECTORY IS CREATED EVEN THOUGH IT IS OPTIONAL, and one example is
# written into it, because a feature nobody can see is a feature nobody uses:
# `/profiles` on a box with no directory says "add one as …/<name>.md", and a
# path in an error message is a worse instruction than a file to copy.
#
# 0750, and content only ever put here by somebody with a shell on this box.
# That is the whole security argument for the feature — the coordinator names a
# profile and can never carry one, so what a session is told to do is chosen
# here rather than over the wire.
#
# NEVER OVERWRITTEN. Re-running the installer is how you upgrade, and clobbering
# a profile somebody wrote would be an upgrade that changes what their sessions
# are told to do.
#
# README.md is the note explaining the directory, not a profile — and
# src/core/profiles.js excludes it by name for the same reason. It is not
# copied at all: a note about the shipped examples belongs beside them in the
# repository, not in the directory a session's instructions are read from.
#
# ALL OF IT AS $RUN_USER (run_as, at the top): the directory, the look for an
# existing profile and every copy. $STATE_DIR is theirs, so `profiles` is a
# name they control, and this was root's `install -d -o "$RUN_USER"` on it:
# GNU install follows a symlink to a directory and fchmods and fchowns what it
# lands on, so `ln -s /usr/local/sbin …/profiles` and the heal they can start
# with `sudo -n fleetwright-migrate` handed them the directory the migrate
# helper lives in. And $DIR is `current` on the heal, so a shipped example
# that is a link to /etc/shadow was root's copy of /etc/shadow into their
# directory. As them, a link reaches only what they could read anyway; a link
# is still skipped, because a shipped example never is one.
PROFILE_DIR="${FLEETWRIGHT_PROFILE_DIR:-$STATE_DIR/profiles}"
if run_as_user sh -c '
  umask 027
  install -d -m 0750 "$1" || exit 1
  for f in "$2"/install/profiles/*.md; do
    [ -e "$f" ] && [ ! -L "$f" ] || continue
    base="${f##*/}"
    [ "$base" = README.md ] && continue
    [ -e "$1/$base" ] || [ -L "$1/$base" ] && continue
    cp "$f" "$1/$base" && chmod 0640 "$1/$base" || exit 1
  done' sh "$PROFILE_DIR" "$DIR"; then
  ok "$PROFILE_DIR"
else
  warn "could not make $PROFILE_DIR or copy the example profiles into it as $RUN_USER"
fi

# --- 3. environment file ----------------------------------------------------
say "Configuration"
if [ -f "$ENV_FILE" ]; then
  ok "$ENV_FILE already exists — left untouched"
else
  # THIS INSTALLER'S TEMPLATE, like the sidecar's below: on the heal $DIR is
  # `current`, and a template there that is a link to /etc/shadow was root's
  # copy of it into a file this installer later chowns to the service user.
  install -m 0600 "$SELF_DIR/install/fleetwright.env.example" "$ENV_FILE"
  ok "wrote $ENV_FILE from the template"
  ok "edit it to change anything — the defaults work"
fi

# WHERE THIS BOX'S RELEASES COME FROM, derived from the repository it was
# installed out of rather than baked in. A fork's boxes take the fork's
# releases, and nobody has to be told to set a variable they have never heard
# of — which is the state every box installed so far is in, and the reason
# `/update` on a packaged host could only say "set FLEETWRIGHT_RELEASE_MANIFEST"
# and stop.
#
# The STABLE address. `releases/latest/download` skips prereleases by GitHub's
# own definition, and a box that wants the rolling build moves itself with
# `/channel rolling` — src/core/release.js derives the other address from this
# one, so this is the only URL anybody has to know.
release_manifest_url() { # release_manifest_url REMOTE
  # Both forms git writes: https://github.com/owner/repo(.git) and
  # git@github.com:owner/repo(.git). Anything else — a mirror, a local path, a
  # GitHub Enterprise host — is deliberately NOT guessed at: inventing a release
  # path inside somebody else's server produces a 404 on every update check and
  # blames the update for it.
  case "$1" in
    https://github.com/*) slug=${1#https://github.com/} ;;
    git@github.com:*)     slug=${1#git@github.com:} ;;
    ssh://git@github.com/*) slug=${1#ssh://git@github.com/} ;;
    *) return 1 ;;
  esac
  slug=${slug%.git}
  slug=${slug%/}
  # owner/repo and nothing else. A slug with a third segment is not a
  # repository, and building a URL from it would be confidently wrong.
  case "$slug" in
    */*/*|*/|/*|*" "*|"") return 1 ;;
    */*) ;;
    *) return 1 ;;
  esac
  printf 'https://github.com/%s/releases/latest/download/manifest.json' "$slug"
}

# A BOX THAT APT OWNS says so, and that is the whole of its update config.
#
# The deb lays a release out exactly as bootstrap.sh does, but apt decides when
# the next one arrives: a stable release is promoted to the apt repository once
# its rollout is complete, and `apt-get upgrade` (from a shell, from
# unattended-upgrades, or from /upgrade in the app) runs this installer again
# from the package's postinst. A manifest check on the same box would be a
# second updater with its own opinion of which version is current, and the two
# would take turns moving `current`. src/core/release-check.js reads this and
# asks apt instead. See docs/packaging.md, "Stable releases through apt".
if [ "${FLEETWRIGHT_RELEASE_SOURCE:-}" = "apt" ] && [ "$CHECK_ONLY" != 1 ]; then
  set_env "$ENV_FILE" FLEETWRIGHT_RELEASE_SOURCE apt
  ok "releases come from apt — the fleetwright package"
elif [ "$(get_env "$ENV_FILE" FLEETWRIGHT_RELEASE_SOURCE)" = "apt" ] && [ "$CHECK_ONLY" != 1 ] \
     && [ "$(dpkg-query -W -f='${Status}' fleetwright 2>/dev/null || true)" != "install ok installed" ]; then
  # THE PACKAGE WENT AND THE LINE STAYED. `apt remove` keeps /etc, so a box
  # moved back to the one-liner would go on asking apt about a package it no
  # longer has. Cleared only when dpkg agrees the package is gone: somebody
  # running this installer by hand on a box that still has it must not quietly
  # hand the box a second updater.
  # Not set_env, which never overwrites a value that is already there.
  ENVFILE="$ENV_FILE" "$NODE_BIN" -e '
    const fs = require("fs");
    const f = process.env.ENVFILE;
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^FLEETWRIGHT_RELEASE_SOURCE=.*$/m, "FLEETWRIGHT_RELEASE_SOURCE="));
  '
  ok "the fleetwright package is gone — releases come from the manifest again"
fi

# WHERE ROOT TAKES ITS RELEASES FROM, which is no longer the env file.
#
# fleetwright-migrate runs as root — on `sudo -n` at the service user's word,
# and from refresh_release_if_converted whenever this installer runs as root,
# which the deb's postinst does on every apt upgrade — and it fetches a
# manifest, checks a tarball against that manifest's sha256, and runs the
# tarball's install.sh as root. It read the address from $ENV_FILE, and that
# file is the service user's: it is chowned to them further down so the CLI
# can read it, and its owner can rewrite it. So the service user named the
# manifest, the manifest named the sha256, and their install.sh ran as root.
#
# So root's address lives in $RELEASE_MANIFEST_FILE, root's own, written here
# and nowhere else, and the helper reads nothing else for it. The order, and
# why each step is allowed to write it:
#
#   TOLD. FLEETWRIGHT_RELEASE_MANIFEST in this installer's own environment:
#     bootstrap.sh hands down the address it just verified a tarball against,
#     or an operator passes one to change it. Either way it is root's
#     environment, which the service user cannot reach. Written, every time.
#
#   KEPT. A file already there is left exactly as it is — NEVER refreshed from
#     the env file or from the checkout's git remote, both of which the
#     service user can write, because this runs as root unattended. The only
#     way to change it is to tell it, above.
#
#   SEEDED, ONCE. No file yet: the box's first run after this change, or a
#     first install. It takes what the box already has — the env file's value,
#     or the checkout's origin — which is trust on first use, and argued
#     rather than assumed: it adds no exposure the box did not already have,
#     because until this run the helper read that same value as root, at the
#     same service user's request. From the second run on it is kept.
#
# NOT ON A MAC, where there is no helper to read it (see "THE MIGRATION
# HELPER" below) and /usr/local/etc is often the Homebrew user's directory.
#
# Called inside `if`, so a failure is a warning rather than the end of the run.
record_release_manifest() { # record_release_manifest URL
  local tmp
  tmp="$(mktemp)" || return 1
  printf '%s\n' "$1" > "$tmp"
  if install -d -m 0755 -o root -g root "${RELEASE_MANIFEST_FILE%/*}" \
     && install -m 0644 -o root -g root "$tmp" "$RELEASE_MANIFEST_FILE"; then
    rm -f "$tmp"
    return 0
  fi
  rm -f "$tmp"
  return 1
}

ENV_MANIFEST="$(get_env "$ENV_FILE" FLEETWRIGHT_RELEASE_MANIFEST)"
ROOT_MANIFEST=""
if [ "$PLATFORM" != macos ]; then
  MANIFEST_FROM=""
  if [ -n "${FLEETWRIGHT_RELEASE_MANIFEST:-}" ]; then
    ROOT_MANIFEST="$FLEETWRIGHT_RELEASE_MANIFEST"
    MANIFEST_FROM=told
  elif [ -s "$RELEASE_MANIFEST_FILE" ]; then
    ROOT_MANIFEST="$(head -n 1 "$RELEASE_MANIFEST_FILE" | tr -d '[:space:]')"
    MANIFEST_FROM=kept
  elif [ -n "$ENV_MANIFEST" ]; then
    ROOT_MANIFEST="$ENV_MANIFEST"
    MANIFEST_FROM=seeded
  elif [ "$(get_env "$ENV_FILE" FLEETWRIGHT_RELEASE_SOURCE)" != "apt" ] \
       && ROOT_MANIFEST=$(release_manifest_url "$(git -C "$DIR" remote get-url origin 2>/dev/null || true)"); then
    MANIFEST_FROM=seeded
  fi
  if [ -n "$ROOT_MANIFEST" ] && [ "$MANIFEST_FROM" != kept ]; then
    if record_release_manifest "$ROOT_MANIFEST"; then
      ok "root takes releases from $ROOT_MANIFEST ($RELEASE_MANIFEST_FILE)"
    else
      warn "could not write $RELEASE_MANIFEST_FILE — root will not move this box onto a release until it can"
      ROOT_MANIFEST=""
    fi
  fi
fi

# AND THE ENV FILE, for `/update`, which runs as the service user and reads
# cfg.releaseManifest from here. It is not what root trusts any more; it is
# kept saying the same thing as root's file, because two addresses would be
# two updaters — the hub laying out one release unprivileged and the heal it
# asks for bringing the box "forward" to the other. A value set here by hand
# is replaced with root's and the run says so: the way to change the address
# is to tell the installer, which changes both.
if [ "$(get_env "$ENV_FILE" FLEETWRIGHT_RELEASE_SOURCE)" != "apt" ]; then
  if [ -n "$ROOT_MANIFEST" ]; then
    if [ "$ENV_MANIFEST" != "$ROOT_MANIFEST" ]; then
      [ -z "$ENV_MANIFEST" ] || {
        warn "$ENV_FILE named $ENV_MANIFEST, and root moves this box only to $ROOT_MANIFEST — it says that now"
        warn "  to change it: re-run this installer as root with FLEETWRIGHT_RELEASE_MANIFEST=<url>"
      }
      put_env "$ENV_FILE" FLEETWRIGHT_RELEASE_MANIFEST "$ROOT_MANIFEST"
    fi
    ok "releases come from $ROOT_MANIFEST"
  elif [ -z "$ENV_MANIFEST" ]; then
    ORIGIN=$(git -C "$DIR" remote get-url origin 2>/dev/null || true)
    # TOLD, BEFORE IT IS GUESSED. A fresh box installed from a release has no
    # remote to read: bootstrap.sh fetched the manifest, verified the tarball
    # against it, and hands the address down in the environment — the one
    # address this release was just checked against is the one `/update` should
    # read from. The remote is the answer for a checkout, where it is the only
    # thing that knows which repository this is. (Off a Mac both were already
    # answered above, as root's address; this is the Mac's, and the warning.)
    if [ -n "${FLEETWRIGHT_RELEASE_MANIFEST:-}" ]; then
      set_env "$ENV_FILE" FLEETWRIGHT_RELEASE_MANIFEST "$FLEETWRIGHT_RELEASE_MANIFEST"
      ok "releases come from $FLEETWRIGHT_RELEASE_MANIFEST"
    elif MANIFEST_URL=$(release_manifest_url "$ORIGIN"); then
      set_env "$ENV_FILE" FLEETWRIGHT_RELEASE_MANIFEST "$MANIFEST_URL"
      ok "releases come from $MANIFEST_URL"
    else
      # Said rather than left silent. A box with no manifest URL is one whose
      # /update can only report that it cannot update, and finding that out on
      # the day it matters is the failure this whole line exists to avoid.
      warn "could not tell which repository this came from, so FLEETWRIGHT_RELEASE_MANIFEST is unset"
      warn "  re-run this installer as root with FLEETWRIGHT_RELEASE_MANIFEST=<url of a release manifest>, or this box cannot take updates"
    fi
  fi
fi

# THE MIGRATION HELPER, and the grant that lets the app use it.
#
# ON A PACKAGED BOX TOO. This said "only on a checkout: a box that is already
# packaged has nothing to migrate to", and that was true while converting a
# checkout was the helper's only job. Since root's half of an update started
# following the release, the helper is the ONE root step every update has —
# and a copy that is only ever written on a checkout is a copy that stays
# whatever it was the day the box converted.
#
# A box found out. Its helper predated the heal: on a box already at the
# manifest's version it said "nothing to do" and exited 0, so the hub logged
# that the installer had run with --repair, restarted itself, and left the
# sidecar on the tree it started from. Nothing could refresh that helper,
# because refreshing it is a thing THIS script does and the stale helper was
# the one thing on the box that would not run this script.
#
# Not on --check, which promises to change nothing. `install -o root -g root`
# rather than a copy, because the mode and the owner are the security property
# — see write_migrate_sudoers. And GNU install unlinks before it writes, so a
# helper that is running this installer keeps reading the file it started
# from rather than the one that replaces it.
#
# FROM THIS INSTALLER'S TREE, NOT THE PAYLOAD — the rule the watchdog, the
# reclaimer and the apt-channel script below already follow. On every packaged
# route $DIR is `current` by now, which the service user can rewrite, and this
# line was copying the service user's file into the one path sudoers lets the
# service user run as root. fleetwright-migrate's heal runs this installer out
# of a verified copy with `current` as the payload, so the whole of it was:
# edit current/install/fleetwright-migrate, `sudo -n fleetwright-migrate`
# (allowed, no arguments), and the next `sudo -n fleetwright-migrate` ran the
# edit as root. $SELF_DIR is the deb's extract, bootstrap.sh's or the
# helper's own verified copy on those routes, and the checkout on a checkout,
# where it is the same tree as $DIR.
#
# NOT ON A MAC. The helper rewrites systemd units under /etc/systemd/system and
# runs the packaged release's installer, and a Mac has neither the units nor
# the packaged layout — /update there pulls the checkout and the operator
# re-runs this script with --upgrade, which is what the launchd path exercises
# in CI. The first macOS runner got exactly this far and stopped on BSD
# install's `unknown group root`: root's group on a Mac is wheel. Saying that
# the helper is not for this box is the honest answer, not a portable group.
if [ "$PLATFORM" = macos ]; then
  say "the release-migration helper is systemd-only — a Mac updates by re-running this installer with --upgrade"
elif [ "$CHECK_ONLY" != 1 ] && [ -f "$SELF_DIR/install/fleetwright-migrate" ]; then
  install -m 0755 -o root -g root "$SELF_DIR/install/fleetwright-migrate" /usr/local/sbin/fleetwright-migrate
  ok "installed /usr/local/sbin/fleetwright-migrate"
  if write_migrate_sudoers; then
    ok "the app can move this box onto packaged releases without a shell"
  else
    warn "could not write /etc/sudoers.d/fleetwright-migrate — moving this box onto"
    warn "  packaged releases will need: sudo /usr/local/sbin/fleetwright-migrate"
  fi
fi

# The installer knows exactly where claude is; the service should not have to
# work it out again. src/core/which.js searches $HOME/.local/bin and would
# normally find it — but only for the user it runs as, which is why `doctor`
# run under sudo reports "claude on PATH: FAIL" on a box where the service is
# perfectly happy. Recording the path removes the guess for both.
if [ -n "$CLAUDE_BIN" ]; then
  set_env "$ENV_FILE" FLEETWRIGHT_CLAUDE_BIN "$CLAUDE_BIN"
  ok "recorded claude at $CLAUDE_BIN in $ENV_FILE"
fi

# --- 3b. sidecar configuration ----------------------------------------------
# Pre-filled from the session manager's own config, because the hub URL and
# token MUST agree between the two and hand-copying a secret between files is
# exactly the step people get wrong.
say "Configuring the fleet sidecar"
if [ -f "$SIDECAR_ENV" ]; then
  ok "$SIDECAR_ENV already exists — left untouched"
else
  # The template from this installer's own tree: what lands here is the
  # sidecar's environment, and a NODE_OPTIONS in it is code the sidecar runs.
  # $DIR is `current` on a packaged route, which is the service user's.
  SIDECAR_ENV="$SIDECAR_ENV" HUB_ENV="$ENV_FILE" SIDECAR_TOKEN_FILE="$SIDECAR_TOKEN_FILE" \
  TEMPLATE="$SELF_DIR/install/fleetwright-sidecar.env.example" "$NODE_BIN" <<'NODE'
const fs = require('fs');

// The sidecar's own token, minted above. Preferred over the operator's
// FLEETWRIGHT_TOKEN even when the hub has one: the hub gates this one to what
// the sidecar does, and the other to nothing.
let sidecarToken = '';
try { sidecarToken = fs.readFileSync(process.env.SIDECAR_TOKEN_FILE, 'utf8').trim(); } catch {}

// Read the hub's env the way systemd does: KEY=value, one per line, one layer
// of surrounding quotes stripped. Done in node rather than sed so a token
// containing & or | cannot corrupt the substitution.
const hub = {};
try {
  for (const raw of fs.readFileSync(process.env.HUB_ENV, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    hub[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no hub env yet — defaults below are right anyway */ }

// 0.0.0.0 and :: are bind addresses, not addresses to dial.
let bind = hub.FLEETWRIGHT_BIND || '127.0.0.1';
if (bind === '0.0.0.0' || bind === '::' || bind === '') bind = '127.0.0.1';
const port = hub.FLEETWRIGHT_PORT || '8790';

const filled = {
  FLEETWRIGHT_HUB_URL: `http://${bind}:${port}`,
  FLEETWRIGHT_HUB_TOKEN: sidecarToken || hub.FLEETWRIGHT_TOKEN || '',
  // stdio is the only transport implemented, and this is a local placeholder
  // rather than a real remote origin — but the sidecar still refuses to start
  // without one, so filling it in keeps a fresh box working out of the box.
  FLEETWRIGHT_COORDINATOR_URL: 'stdio:local',
};

const out = fs
  .readFileSync(process.env.TEMPLATE, 'utf8')
  .split('\n')
  .map((line) => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    return m && m[1] in filled ? `${m[1]}=${filled[m[1]]}` : line;
  })
  .join('\n');

fs.writeFileSync(process.env.SIDECAR_ENV, out, { mode: 0o600 });
console.log(`  ok   wrote ${process.env.SIDECAR_ENV} (hub URL and token copied from ${process.env.HUB_ENV})`);
NODE
  chmod 0600 "$SIDECAR_ENV"
fi

# Reconcile the DERIVED values on every run, existing file or not.
#
# FLEETWRIGHT_HUB_TOKEN is not an independent secret: it is the sidecar's token
# the hub minted (or, on a hub from before that existed, the hub's own
# FLEETWRIGHT_TOKEN), or the sidecar cannot read /api/state and the host joins
# the fleet reporting "degraded — rejected the token". Copying it once at file
# creation is wrong, because the token can be minted afterwards or rotated
# later, and "already exists, left untouched" then freezes a value that was
# only ever a copy. A box whose sidecar env still carries the OPERATOR's token
# is moved onto the sidecar's here, which is the narrowing #270 left open.
#
# Config the operator CHOSE is still never overwritten. This is strictly the
# two fields that are computed from somewhere else.
SIDECAR_ENV="$SIDECAR_ENV" HUB_ENV="$ENV_FILE" SIDECAR_TOKEN_FILE="$SIDECAR_TOKEN_FILE" "$NODE_BIN" <<'NODE'
const fs = require('fs');

let sidecarToken = '';
try { sidecarToken = fs.readFileSync(process.env.SIDECAR_TOKEN_FILE, 'utf8').trim(); } catch {}

const read = (file) => {
  /** @type {Record<string,string>} */
  const out = {};
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
  return out;
};

const { SIDECAR_ENV, HUB_ENV } = process.env;
if (fs.existsSync(SIDECAR_ENV)) {
  const hub = read(HUB_ENV);
  const side = read(SIDECAR_ENV);

  let bind = hub.FLEETWRIGHT_BIND || '127.0.0.1';
  if (bind === '0.0.0.0' || bind === '::' || bind === '') bind = '127.0.0.1';
  const want = {
    FLEETWRIGHT_HUB_URL: `http://${bind}:${hub.FLEETWRIGHT_PORT || '8790'}`,
    FLEETWRIGHT_HUB_TOKEN: sidecarToken || hub.FLEETWRIGHT_TOKEN || '',
  };

  let text = fs.readFileSync(SIDECAR_ENV, 'utf8');
  const fixed = [];
  for (const [key, value] of Object.entries(want)) {
    // An empty hub value is not authority to blank a working one — that would
    // turn a half-written hub env into a broken sidecar.
    if (!value || side[key] === value) continue;
    const line = `${key}=${value}`;
    text = new RegExp(`^${key}=.*$`, 'm').test(text)
      ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line)
      : `${text.replace(/\n?$/, '\n')}${line}\n`;
    fixed.push(key);
  }

  if (fixed.length) {
    fs.writeFileSync(SIDECAR_ENV, text, { mode: 0o600 });
    console.log(`  ok   re-copied ${fixed.join(', ')} into ${SIDECAR_ENV} — it had drifted`);
  }
}
NODE

# --- 4. service units -------------------------------------------------------
# BEFORE THE UNITS ARE WRITTEN AND ANYTHING IS RESTARTED. If this box is on an
# older release than its channel points at, the release is brought forward first
# — so the units below are templated from the release this box is ABOUT to run,
# and not from the one it is leaving.
#
# It execs this installer again when it does any work, so everything after this
# line runs once, against the new release.
refresh_release_if_converted

say "Installing the $([ "$PLATFORM" = macos ] && echo "launchd daemons" || echo "systemd units")"

# After the release is brought forward, so the store is filled from the
# release this box is about to run. Before the units, which name what it made.
refresh_sidecar_store

# All three, not just fleetwright. Installing only the hub was a real bug with a
# quiet symptom: the installer went on to call `systemctl enable --now
# fleetwright-sidecar` on a unit that did not exist, warned once, and finished
# looking successful — so the box never joined a fleet, and the coordinator it
# was meant to join reported that no host had ever connected.
# The same substitution either way; only the template and the destination
# differ. Kept as one function so a service can never be installed on one
# platform and forgotten on the other — which is exactly the bug described
# above, in a different coat.
# WHAT NODE SHOULD RUN FOR A UNIT, which is not the same file in both shapes.
#
# A checkout's bin/<name> is JavaScript with a node shebang, so `node bin/<name>`
# works. A RELEASE ships lib/<name>.mjs plus a thin bin/ shim — and when that
# shim was a shell script, `node <shim>` was a syntax error and every packaged
# service died in a restart loop.
#
# Naming the module takes the shim out of systemd's path entirely. That also
# fixes releases ALREADY ON DISK: the installer is updated by re-running the
# one-liner, which costs nothing, while a payload can only be superseded. The
# same reasoning as FLEETWRIGHT_PAYLOAD, applied to the other half.
unit_entry() { # unit_entry NAME
  if [ -f "$DIR/lib/$1.mjs" ]; then printf '%s/lib/%s.mjs' "$DIR" "$1"
  else printf '%s/bin/%s' "$DIR" "$1"; fi
}

# THE PATH A LAUNCHD DAEMON GETS. launchd gives a daemon PATH=/usr/bin:/bin:
# /usr/sbin:/sbin and nothing else — no /opt/homebrew/bin, no /usr/local/bin —
# and the hub looks tmux and claude up on PATH. The first macOS runner installed
# tmux with brew, wrote the plist, and the hub exited on "tmux is not installed"
# three times in a row. So the plist carries the directories of the tools THIS
# installer found, in front of launchd's defaults. systemd does not need it:
# its units name absolute paths and read the env file.
launchd_path() {
  local out="" d tool
  for tool in "${UNIT_NODE_BIN:-$NODE_BIN}" "$(command -v tmux 2>/dev/null || true)" "${CLAUDE_BIN:-}"; do
    [ -n "$tool" ] || continue
    d="$(dirname "$tool")"
    case ":$out:" in *":$d:"*) ;; *) out="${out:+$out:}$d" ;; esac
  done
  for d in /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
    case ":$out:" in *":$d:"*) ;; *) out="${out:+$out:}$d" ;; esac
  done
  printf '%s' "$out"
}

install_unit() { # install_unit NAME
  local src dest
  # THE TEMPLATE FROM THIS INSTALLER, the entry path from the payload. Reading
  # the template from $DIR meant a release's own template decided the shape of
  # the unit, and an old release cannot know about a placeholder added after it
  # was built. SELF_DIR is what the one-liner just updated.
  #
  # AND NEVER FROM THE PAYLOAD AT ALL. This fell back to $DIR's template when
  # SELF_DIR had none, and on the heal $DIR is `current`, the service user's: a
  # unit is root's, and `User=root` in a template they wrote is a root service.
  # A release's installer carries every template it names, so a missing one
  # is an installer to refuse, not a gap to fill from somebody else's tree.
  local from="$SELF_DIR"
  [ -f "$from/install/$1.service" ] || [ -f "$from/install/$1.plist" ] \
    || die "this installer has no template for $1 in $SELF_DIR — it is not a whole release"
  if [ "$PLATFORM" = macos ]; then
    src="$from/install/$1.plist"
    dest="/Library/LaunchDaemons/network.thetech.$1.plist"
  else
    src="$from/install/$1.service"
    dest="/etc/systemd/system/$1.service"
  fi
  # ProtectHome=yes is the template's answer and right on every box where the
  # code and its node live outside /home — which is every packaged box. A
  # checkout or a version-managed node under somebody's home would be invisible
  # to a unit that says yes, and the service would die at ExecStart.
  # THE SIDECAR'S OWN THREE: its directory, its entry and its node are the
  # store's and the node chosen for it below, not the hub's. __INSTALL_DIR__
  # is the hub's tree either way — the sidecar reads which release `current`
  # holds from it, and runs nothing out of it.
  local udir="$DIR" uentry unode="$NODE_BIN"
  uentry="$(unit_entry "$1")"
  if [ "$1" = fleetwright-sidecar ]; then
    udir="$(sidecar_dir)"; uentry="$(sidecar_entry)"; unode="${SIDECAR_NODE_BIN:-$NODE_BIN}"
  fi
  local protect_home="ProtectHome=yes"
  case "$udir:$unode" in
    /home/*|/root/*|*:/home/*|*:/root/*)
      protect_home="ProtectHome=read-only"
      [ "$1" = fleetwright-sidecar ] && warn "$udir or $unode is under a home directory, so the sidecar's unit keeps ProtectHome=read-only" ;;
  esac
  sed -e "s|__USER__|$RUN_USER|g" \
      -e "s|__SIDECAR_USER__|$SIDECAR_USER|g" \
      -e "s|^ProtectHome=yes$|$protect_home|" \
      -e "s|__ENTRY__|$uentry|g" \
      -e "s|__INSTALL_DIR__|$DIR|g" \
      -e "s|__DIR__|$udir|g" \
      -e "s|__NODE__|$unode|g" \
      -e "s|__PATH__|$(launchd_path)|g" \
      -e "s|__STATE_DIR__|$STATE_DIR|g" \
      -e "s|__FLEET_BASE__|$FLEET_BASE|g" \
      "$src" > "$dest"
  # root-owned, because launchd REFUSES to load a daemon that is writable by
  # anyone else, and does so with a message about permissions rather than
  # about the file it means.
  chown root:wheel "$dest" 2>/dev/null || true
  chmod 0644 "$dest"
  # THE LOG FILE THE PLIST NAMES HAS TO EXIST BEFORE LAUNCHD SPAWNS THE JOB.
  # launchd opens StandardOutPath as the job's user, and /var/log is root's:
  # the open fails, launchd gives up with EX_CONFIG (78), and `launchctl
  # print` shows "spawn scheduled" forever — while bootstrap returned 0 and
  # nothing was written anywhere to say why. The first macOS runner sat
  # exactly there, both daemons, three runs each. Created empty and owned by
  # the user the plist runs as; an existing file is re-owned, not truncated.
  if [ "$PLATFORM" = macos ]; then
    local log_owner; log_owner="$(sed -n '/<key>UserName<\/key>/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$dest" | head -1)"
    [ -n "$log_owner" ] || log_owner="$RUN_USER"
    [ -e "/var/log/$1.log" ] || : > "/var/log/$1.log"
    chown "$log_owner" "/var/log/$1.log" 2>/dev/null || true
    chmod 0644 "/var/log/$1.log" 2>/dev/null || true
  fi

  # WHAT THIS UNIT NAMES HAS TO EXIST, and nothing checked. A unit is written
  # from a template and looks perfectly correct while pointing at a file that is
  # not there — which is precisely how a fleet spent an afternoon in restart
  # loops, with an installer reporting `ok` on every line.
  #
  # systemd will not tell you either: it reports "Failed with result exit-code"
  # and the reason is in the journal, on a box somebody has to log in to.
  UNIT_TARGET="$(sed -n 's/^ExecStart=[^ ]* \([^ ]*\).*/\1/p' "$dest" | head -1)"
  # A PATH, not an option or a subcommand: the oneshot units run
  # `apt-get -y ...` and `apt-get update`, and neither `-y` nor `update` is a
  # file that should exist. Warning about `update` on every box that allowed
  # system updates taught people to skim past this line.
  case "$UNIT_TARGET" in /*) ;; *) UNIT_TARGET="" ;; esac
  if [ -n "$UNIT_TARGET" ] && [ ! -f "$UNIT_TARGET" ]; then
    warn "$dest names $UNIT_TARGET, which does not exist — this service cannot start"
    warn "  the install continued; fix the payload and re-run, or use --from-source"
  fi
  ok "$dest"
}

# WHERE THE SIDECAR RUNS FROM: the store when this run has one, otherwise the
# same tree as the hub — a checkout, or a packaged box no verified installer
# has run on yet. Functions, because $DIR is swapped to `current` around the
# unit writes on a converted box and the answer has to follow it.
sidecar_dir() { if [ "$SIDECAR_STORE" = 1 ]; then printf '%s' "$SIDECAR_BASE"; else printf '%s' "$DIR"; fi; }
sidecar_entry() { if [ "$SIDECAR_STORE" = 1 ]; then printf '%s/launch.mjs' "$SIDECAR_BASE"; else unit_entry fleetwright-sidecar; fi; }
# The tree whose bin/fleetwright-sidecar the installer runs AS the sidecar —
# enrol, identity, doctor — and the CLI link points at. The same rule as the
# unit: those commands read the host key too.
sidecar_tree() { if [ "$SIDECAR_STORE" = 1 ]; then printf '%s/current' "$SIDECAR_BASE"; else printf '%s' "$DIR"; fi; }

# THE SIDECAR'S NODE, which $RUN_USER must not be able to replace either: a
# node in their home is a binary they can swap, and the sidecar would then be
# running their program with the key in reach. The system node the units
# prefer if there is one they cannot touch, then the one this run found.
SIDECAR_NODE_BIN="$NODE_BIN"
if [ "$SIDECAR_USER" != "$RUN_USER" ] && [ "$PLATFORM" = linux ] && [ "$CHECK_ONLY" != 1 ]; then
  for candidate in "${UNIT_NODE_BIN:-}" "$NODE_BIN"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    if ! run_user_can_alter "$candidate"; then SIDECAR_NODE_BIN="$candidate"; break; fi
  done
fi

# CAN THE SIDECAR'S ACCOUNT RUN THE SIDECAR. Its unit names a node and an entry
# that $RUN_USER can read by construction and another account can only read
# if the directories on the way allow it — a checkout cloned into a 0750 home,
# a node under ~/.nvm. Checked as that account, before a unit is written that
# would die at ExecStart with a permissions error attributed to node.
#
# HERE, AFTER unit_entry EXISTS. This probe sat above that function's
# definition, so `$(unit_entry …)` was "command not found", the test read an
# empty path and failed, and EVERY Linux box took the branch below: the
# sidecar has run as $RUN_USER since #682 shipped, with a warning saying so
# that read like a permissions problem on the box. Nothing here was the
# boundary it was written to be until this moved.
if [ "$SIDECAR_USER" != "$RUN_USER" ] && [ "$CHECK_ONLY" != 1 ]; then
  if as_sidecar "test -r '$(sidecar_entry)' && test -x '$SIDECAR_NODE_BIN'" >/dev/null 2>&1; then
    ok "$SIDECAR_USER can read $(sidecar_dir) and run $SIDECAR_NODE_BIN"
  else
    warn "$SIDECAR_USER cannot read $(sidecar_entry) or run $SIDECAR_NODE_BIN — the sidecar will run as $RUN_USER"
    MISSING+=("a separate account for the sidecar: make $(sidecar_dir) and $SIDECAR_NODE_BIN readable by $SIDECAR_USER and re-run this")
    SIDECAR_USER="$RUN_USER"
    SIDECAR_USER_FALLBACK=1
  fi
fi

# AND CAN $RUN_USER CHANGE WHAT IT RUNS. Reading is the account's half; this is
# the half the separation is for. Nothing the sidecar executes — its entry,
# the tree it runs in, its node — nor any directory or symlink on the way to
# them may be $RUN_USER's to change, or $RUN_USER runs code as the sidecar and
# reads the host key through it.
#
# SAID, NOT REFUSED. The account still keeps a compromised sidecar out of
# $RUN_USER's credentials, which is half of #270 and holds either way, and a
# checkout is a legitimate box for somebody who edits it. What the box must
# not do is claim the other half, so it is said here and again at the end.
SIDECAR_EXPOSED=""
if [ "$SIDECAR_USER" != "$RUN_USER" ] && [ "$CHECK_ONLY" != 1 ] && [ "$PLATFORM" = linux ]; then
  for p in "$(sidecar_entry)" "$(sidecar_dir)" "$SIDECAR_NODE_BIN"; do
    run_user_can_alter "$p" && SIDECAR_EXPOSED="$SIDECAR_EXPOSED $p"
  done
  if [ -z "$SIDECAR_EXPOSED" ]; then
    ok "nothing the sidecar runs can be changed by $RUN_USER — the host key is out of its reach"
  else
    warn "$RUN_USER can change what the sidecar runs:$SIDECAR_EXPOSED"
    warn "  so the host key is NOT protected from $RUN_USER, or a session escape landing as it"
  fi
fi

# KEPT BEFORE THEY ARE OVERWRITTEN, because the old ExecStart is the only
# record of where the previous install lived — and install_unit is about to
# replace it. Section 8 reads these to know what it is replacing.
OLD_UNIT_BACKUP_DIR="$(mktemp -d)"
for u in fleetwright fleetwright-sidecar fleetwright-coordinator fleetwright-upgrade fleetwright-apt-update; do
  if [ "$PLATFORM" = macos ]; then
    [ -f "/Library/LaunchDaemons/network.thetech.$u.plist" ] \
      && cp "/Library/LaunchDaemons/network.thetech.$u.plist" "$OLD_UNIT_BACKUP_DIR/$u.service" || true
  else
    [ -f "/etc/systemd/system/$u.service" ] \
      && cp "/etc/systemd/system/$u.service" "$OLD_UNIT_BACKUP_DIR/$u.service" || true
  fi
done

# RE-TEMPLATED FOR THE RELEASE, NOT SKIPPED — and the difference took a host
# down. The first version of this guard left the units alone entirely, on the
# reasoning that rewriting them to point at this checkout is a revert. True, and
# it threw away the other half: a unit is GENERATED, and an old one is exactly
# what needs replacing.
#
# deb13-staging was already converted, with a unit written before units named
# the module — `node .../current/bin/fleetwright`, against a release whose bin/ is
# a shell shim. It had been in a restart loop for thirty-odd attempts. The
# re-run that could have fixed it politely left it broken.
#
# So the units are written, pointed at the release this box actually runs.
# --from-source is how somebody asks for the checkout instead.
if [ "$CONVERTED" = 1 ] && [ "$FROM_SOURCE" = 0 ]; then
  ok "this box runs packaged releases — pointing its units at $FLEET_BASE/current"
  ok "  (--from-source moves it back to this checkout)"
  UNIT_DIR_SAVED="$DIR"
  DIR="$FLEET_BASE/current"
fi

install_unit fleetwright
install_unit fleetwright-sidecar
# NO COORDINATOR UNIT, ON ANY BOX. The coordinator runs as a Cloudflare Worker
# (docs/coordinator-deploy.md) — or as that same Worker under workerd in a
# container — and is no longer part of what a host installs. A release never
# shipped one; a checkout used to, and offering it here is what this installer
# stopped doing (docs/auth-and-join.md). Nothing is written for it.
ok "no coordinator unit — it runs as a Worker, not on this box"

# AND RETIRE A LEFTOVER ONE. A box that ran its own coordinator from a checkout
# still has the unit — under its new name, since migrate_legacy_names moved it
# — pointing at a binary this tree no longer contains, so it would crash-loop
# under Restart=always from the next restart on. Two cases:
#
#   REMOTE URL — the sidecar already talks to a coordinator elsewhere, so the
#   local one served nothing. Retired silently; this rides root's half of every
#   packaged update (install.sh --repair), so it needs no shell.
#
#   LOOPBACK, STDIO OR UNSET — this box WAS its own fleet. The unit is still
#   retired, because there is nothing left for it to run, and the box is told
#   in so many words what to do next: deploy the Worker and point the sidecar
#   at it. Its membership list stays in /var/lib/fleetwright-coordinator, and
#   the env file stays too; removing either is a bigger decision than "stop
#   running a service that no longer exists".
#
# REMOVE THE UNIT, DO NOT JUST DISABLE IT. `disable --now` stops the service
# and clears its boot symlinks but LEAVES THE UNIT FILE — and section 9 below
# restarts every unit `list-unit-files` still reports, so a disable here was
# undone by a restart in the same run, and the leftover reappeared on the next
# update besides. Deleting the file and reloading is what makes the retirement
# stick: nothing can find it to restart, this run or any later one.
if [ "$PLATFORM" != macos ] && { [ -f /etc/systemd/system/fleetwright-coordinator.service ] \
     || [ -f /etc/systemd/system/agent-fleet-coordinator.service ]; }; then
  COORD_URL="$(sed -n 's/^FLEETWRIGHT_COORDINATOR_URL=//p' "$SIDECAR_ENV" 2>/dev/null | tail -1 | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/')"
  systemctl disable --now fleetwright-coordinator >/dev/null 2>&1 || true
  systemctl disable --now agent-fleet-coordinator >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/fleetwright-coordinator.service /etc/systemd/system/agent-fleet-coordinator.service
  systemctl daemon-reload >/dev/null 2>&1 || true
  case "$COORD_URL" in
    ''|stdio:*|*127.0.0.1*|*localhost*)
      warn "this box ran its own coordinator, and that is no longer shipped: the unit is retired.
       The fleet now meets at a Cloudflare Worker — docs/coordinator-deploy.md is five
       commands — then point this box at it in $SIDECAR_ENV:
           FLEETWRIGHT_COORDINATOR_URL=https://your-coordinator
       and enrol it there with a pin from the app. Its old membership list is kept at
       /var/lib/fleetwright-coordinator for reference; nothing reads it any more." ;;
    *)
      ok "retired the leftover local coordinator — this box uses the remote one ($COORD_URL)" ;;
  esac
fi

if [ -n "${UNIT_DIR_SAVED:-}" ]; then DIR="$UNIT_DIR_SAVED"; unset UNIT_DIR_SAVED; fi

# THE COMMIT-CONFIRM WATCHDOG. A standing timer that reverts an update the box
# cannot prove itself on — see src/core/update-confirm.js and
# install/fleetwright-confirm. It lives OUTSIDE the app on purpose: a watchdog
# inside a service cannot catch that service failing to start, and any of the
# three can be the one an update breaks. Packaged Linux only: a checkout has no
# `current` symlink to move back and nothing kept to revert to, so there is
# nothing here to guard.
if [ "$PACKAGED" = 1 ] && [ "$PLATFORM" != macos ] && [ "$CHECK_ONLY" != 1 ]; then
  # From this installer's tree only, never the payload: a root helper copied
  # out of `current` is the service user's code installed as root's.
  CONFIRM_SRC="$SELF_DIR"
  if [ -f "$CONFIRM_SRC/install/fleetwright-confirm" ]; then
    # Owner root, mode 0755 — the watchdog must not be rewritable by the service
    # user it protects, or the thing being watched could edit its own watcher.
    install -m 0755 -o root -g root "$CONFIRM_SRC/install/fleetwright-confirm" /usr/local/sbin/fleetwright-confirm
    install_unit fleetwright-confirm
    install -m 0644 -o root -g root "$CONFIRM_SRC/install/fleetwright-confirm.timer" /etc/systemd/system/fleetwright-confirm.timer
    ok "commit-confirm watchdog installed (reverts an update that cannot prove itself)"
  fi
fi

# THE STALE-RELEASE RECLAIMER. prune cannot delete a legacy release left
# root-owned by an old `sudo` install, so it renames it aside to `.stale-` and an
# update goes on succeeding; this root-owned helper is the one thing that can
# then remove it, invoked by the service user through one narrow sudoers rule.
# Packaged Linux only, same as the watchdog: a checkout has no releases/ to prune.
# Root-owned and outside the writable install tree, for the migrate rule's
# reason — a helper the service can rewrite is not a narrow grant.
if [ "$PACKAGED" = 1 ] && [ "$PLATFORM" != macos ] && [ "$CHECK_ONLY" != 1 ]; then
  # From this installer's tree only, never the payload: a root helper copied
  # out of `current` is the service user's code installed as root's.
  RECLAIM_SRC="$SELF_DIR"
  if [ -f "$RECLAIM_SRC/install/fleetwright-reclaim" ]; then
    install -m 0755 -o root -g root "$RECLAIM_SRC/install/fleetwright-reclaim" /usr/local/sbin/fleetwright-reclaim
    if write_reclaim_sudoers; then
      ok "installed /usr/local/sbin/fleetwright-reclaim (reclaims releases prune could not delete)"
    else
      warn "installed /usr/local/sbin/fleetwright-reclaim but its sudoers rule did not validate"
      warn "  a root-owned release prune quarantines will need: sudo /usr/local/sbin/fleetwright-reclaim"
    fi
  fi
fi

# Reading the service journal needs group membership: systemd-journald shows a
# plain user only their own logs. Without this /logs returns "no entries" for a
# service that is logging perfectly well — a silence that reads as a broken
# service rather than a permissions one.
if [ "$PLATFORM" != macos ] && [ "$RUN_USER" != root ] && command -v usermod >/dev/null; then
  if id -nG "$RUN_USER" 2>/dev/null | tr ' ' '\n' | grep -qx systemd-journal; then
    ok "$RUN_USER can already read the service journal"
  elif getent group systemd-journal >/dev/null && usermod -aG systemd-journal "$RUN_USER" 2>/dev/null; then
    ok "added $RUN_USER to systemd-journal, so /logs can read the journal"
  else
    warn "could not add $RUN_USER to systemd-journal — /logs will see no entries"
  fi
fi

# The tmux server must outlive the login session that spawned it, or every
# session dies when the operator logs out.
if command -v loginctl >/dev/null; then
  loginctl enable-linger "$RUN_USER" >/dev/null 2>&1 && ok "lingering enabled for $RUN_USER" \
    || warn "could not enable lingering for $RUN_USER — sessions may not survive logout"
fi

if [ "$PLATFORM" = macos ]; then
  # launchd has no daemon-reload: bootstrapping the plist IS the load, and that
  # happens where the services are started. Nothing to do here.
  ok "launchd daemons written"
  HAVE_SYSTEMD=1
elif systemctl daemon-reload >/dev/null 2>&1; then
  ok "systemd reloaded"
  HAVE_SYSTEMD=1
else
  # A container, WSL, or a chroot. Everything else here still applies — the
  # unit file is written and will work the moment systemd is running — so this
  # is a note, not a failure.
  warn "systemd is not running here, so the units were written but not loaded."
  warn "  Start the hub directly instead:  $UNIT_NODE_BIN $DIR/bin/fleetwright serve"
  HAVE_SYSTEMD=0
fi

# --- 5. the SessionStart hook ----------------------------------------------
# This is what makes resume reliable: Claude hands the hook its own session id
# and transcript path, so the conversation uuid fleetwright records is
# authoritative rather than guessed.
say "Installing the Claude Code SessionStart hook"
SETTINGS="${CLAUDE_HOME:-$HOME}/.claude/settings.json"
# AS $RUN_USER, the directory, the merge below and the file it writes: all of
# it is in their home. This was root's `install -d -o`, a node script writing
# a temp file beside settings.json, and a `chown` of settings.json afterwards,
# and every one of those follows a symlink. `ln -s /etc/passwd
# ~/.claude/settings.json`, `sudo -n fleetwright-migrate`, and the heal's
# --repair handed /etc/passwd to the service user.
run_as_user install -d -m 0755 "$(dirname "$SETTINGS")" \
  || warn "could not make $(dirname "$SETTINGS") as $RUN_USER"
# THE HOOK IS THE CLI WRAPPER'S PROBLEM IN ANOTHER PLACE. bin/fleetwright
# starts `#!/usr/bin/env node`, and Claude runs the hook with the session's own
# PATH — on a deb box that has no node at all, only the one under
# /usr/lib/fleetwright/node. Every session then opened with "SessionStart hook
# error: env: 'node': No such file or directory", non-blocking, on every start,
# and the hook never ran. The links in /usr/local/bin already get a wrapper on
# exactly that box (see CLI_NEEDS_WRAPPER below the units); the hook is written
# the same way, naming the node the units run.
CLI_NEEDS_WRAPPER=0
PATH_NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$PATH_NODE" ]; then
  CLI_NEEDS_WRAPPER=1
elif ! PATH_NODE_MAJOR="$(node_major "$PATH_NODE")" || [ "$PATH_NODE_MAJOR" -lt "$NODE_FLOOR" ]; then
  CLI_NEEDS_WRAPPER=1
fi
HOOK_CMD="$DIR/bin/fleetwright hook"
if [ "$CLI_NEEDS_WRAPPER" = 1 ] && [ -n "${UNIT_NODE_BIN:-}" ]; then
  HOOK_CMD="$UNIT_NODE_BIN $DIR/bin/fleetwright hook"
fi

# Merged with node rather than sed: settings.json holds the operator's own
# hooks, theme and permissions, and a text-level edit would eventually eat one.
# `env`, because sudo hands the command a clean environment.
run_as_user env SETTINGS="$SETTINGS" HOOK_CMD="$HOOK_CMD" "$NODE_BIN" <<'NODE'
const fs = require('fs');
const file = process.env.SETTINGS;
const cmd = process.env.HOOK_CMD;

let settings = {};
try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) {
  if (e.code !== 'ENOENT') {
    console.error(`  FAIL ${file} is not valid JSON — fix it and re-run. Nothing was changed.`);
    process.exit(1);
  }
}

settings.hooks ||= {};
settings.hooks.SessionStart ||= [];

let dirty = false;

// AN EARLIER FORM OF THE HOOK is rewritten in place, keeping whatever matcher
// group it is in: `<dir>/bin/agent-hub hook` from before the rename, or the
// bare `<dir>/bin/fleetwright hook` on a box that has since lost the node on
// its PATH (or gained one). Left beside the new one, both would run and every
// session start would be reported twice — or, for the bare one on a deb box,
// fail on every start.
for (const group of settings.hooks.SessionStart) {
  for (const h of group?.hooks ?? []) {
    if (typeof h?.command === 'string' && h.command !== cmd && /\/bin\/(agent-hub|fleetwright) hook$/.test(h.command)) {
      h.command = cmd;
      dirty = true;
      console.log('  ok   SessionStart hook command updated');
    }
  }
}
// And only once, if the new one was there as well.
const seen = new Set();
for (const group of settings.hooks.SessionStart) {
  if (!Array.isArray(group?.hooks)) continue;
  group.hooks = group.hooks.filter((h) => {
    if (h?.command !== cmd) return true;
    if (seen.has(cmd)) { dirty = true; return false; }
    seen.add(cmd);
    return true;
  });
}
settings.hooks.SessionStart = settings.hooks.SessionStart.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);

const already = JSON.stringify(settings.hooks.SessionStart).includes(cmd);
if (already) {
  console.log('  ok   SessionStart hook already installed');
} else {
  // Append as its own matcher group. Any hook already there is someone else's
  // and keeps working — Claude runs every group.
  settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command: cmd }] });
  console.log(`  ok   added SessionStart hook to ${file}`);
  dirty = true;
}

// First-run defaults. Only set when the key is ABSENT — an operator who has
// deliberately turned one of these off keeps their choice on every re-run.
const defaults = {
  // Remote Control on by default, so a session is drivable from claude.ai/code
  // the moment it starts. fleetwright also passes --remote-control per session;
  // this makes it the default for sessions started by hand on this box too.
  remoteControlAtStartup: true,
  // fleetwright launches with --dangerously-skip-permissions. Without this, the
  // first such session stops at a one-time confirmation prompt that nobody is
  // there to answer — the exact silent hang this tool exists to prevent.
  skipDangerousModePermissionPrompt: true,
};
for (const [key, value] of Object.entries(defaults)) {
  if (settings[key] === undefined) {
    settings[key] = value;
    console.log(`  ok   set ${key} = ${value} (first-run default)`);
    dirty = true;
  } else {
    console.log(`  ok   ${key} already set to ${JSON.stringify(settings[key])} — left alone`);
  }
}

if (dirty) {
  const tmp = `${file}.tmp-fleetwright`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
NODE

# --- 5b. the sandbox image --------------------------------------------------
# Built here rather than left as a documented step, because a sandbox that is
# switched on with no image is a session that dies the instant it starts.
#
# AS THE SERVICE USER, not as root. Rootless podman gives every user their own
# image store — root's images are invisible to anyone else — so an image built
# here by sudo is one the service can never see. It fails later, at the first
# sandboxed session, with "the sandbox image is not built" pointing at an image
# that very obviously IS built if you go and look as root.
if [ "$HAVE_PODMAN" = "1" ] && [ "${FLEETWRIGHT_BUILD_IMAGE:-1}" != "0" ]; then
  say "Preparing rootless podman for $RUN_USER"

  # Rootless containers need a subordinate uid/gid range and the setuid helpers
  # that map it. Debian's useradd normally allocates the range, but a user made
  # some other way (adduser --system, cloud-init, an old account) may have none,
  # and podman then fails with a message about newuidmap that explains nothing.
  if [ "$RUN_USER" != root ]; then
    command -v newuidmap >/dev/null || pkg_install uidmap || true
    command -v newuidmap >/dev/null && ok "uidmap helpers present" \
      || warn "newuidmap is missing ($(pkg_why)) — rootless podman will not work"

    if grep -q "^$RUN_USER:" /etc/subuid 2>/dev/null && grep -q "^$RUN_USER:" /etc/subgid 2>/dev/null; then
      ok "subuid/subgid range allocated for $RUN_USER"
    elif command -v usermod >/dev/null \
         && usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$RUN_USER" 2>/dev/null; then
      ok "allocated a subuid/subgid range for $RUN_USER"
    else
      warn "no subuid/subgid range for $RUN_USER — rootless podman will not work."
      warn "  Add one:  usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $RUN_USER"
    fi
  fi

  # PULLED, not built. CI builds this image once and publishes it, so every
  # host runs the same bytes — a local build meant the image a box got depended
  # on the day it built it, and CLAUDE_VERSION was `latest`, so two hosts on the
  # same commit could disagree about how a session behaves.
  #
  # Building locally is still supported and is the fallback below, for an
  # offline box or a Containerfile somebody is editing.
  # The owner is separable, because a fork's CI publishes to its own namespace
  # and this line was pulling ours. See src/config.js — same two variables, same
  # precedence, because the hub and the installer disagreeing about which image
  # a box runs is a difference nobody would think to look for.
  IMAGE_OWNER="${FLEETWRIGHT_SANDBOX_IMAGE_OWNER:-thetechnetwork}"
  IMAGE="${FLEETWRIGHT_SANDBOX_IMAGE:-ghcr.io/${IMAGE_OWNER}/fleetwright-session:latest}"
  say "Fetching the sandbox image"
  PULL_LOG="$(mktemp "${TMPDIR:-/tmp}/fleetwright-session-pull.XXXXXX")"
  BUILD_LOG="$(mktemp "${TMPDIR:-/tmp}/fleetwright-session-build.XXXXXX")"
  if as_user "podman image exists '$IMAGE'" 2>/dev/null \
     && [ "${FLEETWRIGHT_REBUILD_IMAGE:-0}" != "1" ]; then
    ok "$IMAGE already present for $RUN_USER"
    # Cleared, like the pulled case, or the build below runs on every re-run
    # of a box that already has the image — and on the first apt box it did:
    # "already present" followed by "image build failed", from a build nobody
    # needed, on a Containerfile that is not in the release payload.
    IMAGE=""
  elif [ "${IMAGE#localhost/}" != "$IMAGE" ]; then
    : # a localhost/ image can only be built, so fall through to the build below
  elif as_user "podman pull '$IMAGE'" >"$PULL_LOG" 2>&1; then
    ok "pulled $IMAGE"
    # WRITTEN ONLY IF A PERSON SAID IT. This line used to write the image on
    # every install, and it was writing the default — the same value the hub
    # derives when the variable is absent. The hub reads a named image as a
    # decision, so every box installed this way told the app "set on the box,
    # cannot be changed here" about a choice nobody had made. The full name
    # is kept when it was given; an owner is kept as the owner, so the hub
    # derives the same image and can still swap the tag; the default is left
    # to the code that already knows it.
    if [ -n "${FLEETWRIGHT_SANDBOX_IMAGE:-}" ]; then
      set_env "$ENV_FILE" FLEETWRIGHT_SANDBOX_IMAGE "$IMAGE"
    elif [ -n "${FLEETWRIGHT_SANDBOX_IMAGE_OWNER:-}" ]; then
      set_env "$ENV_FILE" FLEETWRIGHT_SANDBOX_IMAGE_OWNER "$IMAGE_OWNER"
    fi
    IMAGE=""
  else
    warn "could not pull $IMAGE — falling back to building it here."
    warn "  $(tail -1 "$PULL_LOG" 2>/dev/null || echo "see $PULL_LOG")"
    IMAGE="localhost/fleetwright-session:latest"
  fi

  # The build, for a localhost/ image or a failed pull. Tagged with the
  # localhost/ prefix deliberately: a bare name goes through short-name
  # resolution at run time, which fails on a stock Debian 13 with no
  # unqualified-search-registries configured.
  if [ -n "$IMAGE" ]; then
    if as_user "podman build -t '$IMAGE' -f '$DIR/sandbox/Containerfile' '$DIR/sandbox'" \
       >"$BUILD_LOG" 2>&1; then
      ok "$IMAGE (built in $RUN_USER's image store)"
      set_env "$ENV_FILE" FLEETWRIGHT_SANDBOX_IMAGE "$IMAGE"
    else
      warn "image build failed — see $BUILD_LOG."
      warn "  Sandboxed sessions will not start until it succeeds; everything else works."
    fi
  fi
fi

# The three env files hold tokens, so they stay 0600 — but they are read by the
# CLI as well as by systemd, and the CLI runs as the service user. Root-owned
# 0600 means `fleetwright doctor` silently sees no config at all and reports
# things like "a control surface is configured — web only" on a box with
# Telegram plainly working.
for f in "$ENV_FILE" "$COORD_ENV"; do
  # $COORD_ENV only on a box from before the coordinator left, which still has one.
  [ -f "$f" ] || continue
  chown "$RUN_USER" "$f" 2>/dev/null || true
  chmod 0600 "$f"
done
# The sidecar's file to the sidecar's account: `fleetwright-sidecar enrol` and
# `doctor` run as it and read this. systemd reads it as root either way.
if [ -f "$SIDECAR_ENV" ]; then
  chown "$SIDECAR_USER" "$SIDECAR_ENV" 2>/dev/null || true
  chmod 0600 "$SIDECAR_ENV"
fi
ok "config readable by $RUN_USER, the sidecar's by $SIDECAR_USER"

# --- 5b. runtime dependencies ------------------------------------------------
# package.json's `dependencies` are what a checkout host runs with, and
# node_modules is gitignored, so a fresh checkout has no way to get them but
# this. A missing one dies at startup with ERR_MODULE_NOT_FOUND naming a package
# nobody asked for and no fix at all — which is how `jose` was first noticed,
# on the day a box tried to run the coordinator that has since left for the
# Worker (docs/auth-and-join.md). The sidecar imports one today: oauth4webapi,
# through the OAuth exchange it finishes for a host that minted a PKCE
# verifier. A release bundles it into lib/; a checkout gets it here.
say "Runtime dependencies"
if [ "$PACKAGED" = 1 ]; then
  # NOTHING TO INSTALL, and that is the point of the release rather than a
  # convenience. npm runs lifecycle scripts from every package in the tree, on
  # a box whose whole job is to be trustworthy; a release is unpacked and runs
  # none of them. The one runtime dependency is inside lib/.
  ok "bundled — no npm install on this box"
else
NPM_BIN="$(command -v npm 2>/dev/null || true)"
if [ -z "$NPM_BIN" ]; then
  # Debian ships npm separately from nodejs, so a box that got node from
  # `pkg_install nodejs` above very often has no npm at all.
  pkg_install npm >/dev/null 2>&1 || true
  NPM_BIN="$(command -v npm 2>/dev/null || true)"
fi

if [ "$CHECK_ONLY" = 1 ]; then
  [ -n "$NPM_BIN" ] && ok "npm at $NPM_BIN" || warn "npm is not installed — the installer would install it"
elif [ -z "$NPM_BIN" ]; then
  warn "npm is not installed and could not be installed automatically ($(pkg_why)).
       fleetwright is fine without it. The sidecar is not — it will not start:
         cd $DIR && npm install --omit=dev"
else
  # ci first: it installs exactly the lockfile and is the reproducible one. It
  # refuses when package.json and the lock disagree, which is a state a fork or
  # a half-finished merge can be in, so `install` is the fallback rather than
  # the failure.
  #
  # --ignore-scripts, because this is root and npm runs lifecycle scripts —
  # the tree's own package.json's and every dependency's — as whoever called
  # it. A checkout is $RUN_USER's to edit, so its `postinstall` is theirs; and
  # FLEETWRIGHT_PAYLOAD (above) used to let them steer a heal down this branch
  # in `current`. The two runtime dependencies, jose and oauth4webapi, are
  # plain JavaScript with no install step, so nothing is lost by it.
  if (cd "$DIR" && "$NPM_BIN" ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1) \
     || (cd "$DIR" && "$NPM_BIN" install --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1); then
    # Owned by the service user, so `/update` can rewrite it after a pull that
    # changes a dependency. Root-owned node_modules is the same class of bug as
    # the root-owned .git objects the block below exists for.
    chown -Rh "$RUN_USER" "$DIR/node_modules" 2>/dev/null || true
    ok "installed $(cd "$DIR" && "$NPM_BIN" ls --omit=dev --depth=0 2>/dev/null | grep -c '^[├└]' || echo '?') runtime dependencies"
  else
    warn "npm install failed in $DIR — the sidecar on this box will not start.
       Run it by hand and read the error:  cd $DIR && npm install --omit=dev"
  fi
fi
fi

# The checkout must belong to the user that runs the service, or /update cannot
# pull: git refuses to operate on a repository owned by somebody else ("dubious
# ownership"), and even past that, writing the objects needs the permission.
#
# The alternative — giving the service user passwordless sudo for git — is a far
# larger grant to solve a file-ownership problem, so: the deployment owns its
# own deployment.
if [ -d "$DIR/.git" ] && [ "$(owner_of "$DIR/.git")" != "$RUN_USER" ]; then
  if chown -Rh "$RUN_USER" "$DIR" 2>/dev/null; then
    ok "$DIR now belongs to $RUN_USER, so /update can pull"
  else
    warn "could not chown $DIR to $RUN_USER — /update will fail with a permissions error"
  fi
fi

# AND THE SAME THING FOR A PACKAGED BOX, which had no equivalent at all.
#
#   update failed: EACCES: permission denied,
#   mkdir '/opt/fleetwright/releases/.incoming-main-67'
#
# on every update attempt, from a box that had just been converted. The chown
# above is gated on `$DIR/.git` — the CHECKOUT case — and a release has no .git,
# so nothing ever gave the service user the release tree. fleetwright-migrate
# runs as root and creates it root-owned, so CONVERTING A BOX TOOK AWAY ITS
# ABILITY TO UPDATE ITSELF: every update afterwards needed the root helper, and
# the app's Apply update could not work by construction.
#
# It is the whole tree and not just the base, because an update touches all of
# it: it mkdirs `releases/.incoming-<v>`, replaces `releases/<v>`, swaps the
# `current` symlink, and PRUNES old releases — and removing a root-owned tree
# needs write on the directories inside it, not only on their parent.
#
# THE GRANT IS THE SAME ONE THE CHECKOUT ALREADY HAD, and it is a grant over
# the HUB'S code: the service user can replace what the service user runs,
# which gives it nothing it did not have. It is not a grant over anything
# another account runs, and this said "there is nothing to escalate to" for
# years while the sidecar — a different account, holding the host key — ran
# straight out of this tree. That is why the sidecar now runs from root's store
# (refresh_sidecar_store), filled from a verified release and never from here.
#
# What else stays out of reach: the units are root-owned in /etc, the sidecar's
# env file is its account's and 0600, and the sudoers rule names
# /usr/local/sbin/fleetwright-migrate — deliberately outside this tree, and
# written from the installer's own tree rather than from this one, so a service
# user who can rewrite the tree still cannot rewrite what runs as root.
#
# -h, and -R's default of never following a link: the tree is the service
# user's, so a symlink in it is theirs, and a chown that followed one would
# hand them whatever it points at. GNU and BSD chown both read it that way.
if [ -d "$FLEET_BASE" ] && [ "$(owner_of "$FLEET_BASE")" != "$RUN_USER" ]; then
  if chown -Rh "$RUN_USER" "$FLEET_BASE" 2>/dev/null; then
    ok "$FLEET_BASE now belongs to $RUN_USER, so updates can be applied without root"
  else
    warn "could not chown $FLEET_BASE to $RUN_USER — updates will fail with EACCES"
    warn "  every update will need: sudo /usr/local/sbin/fleetwright-migrate"
  fi
fi

# --- 6. CLIs on PATH --------------------------------------------------------
# Same reasoning as the units: pointed at the release, not skipped and not
# dragged back to the checkout. A command line on one tree and services on
# another is the confusing half of a revert.
if [ "$CONVERTED" = 1 ] && [ "$FROM_SOURCE" = 0 ]; then
  LINK_DIR_SAVED="$DIR"
  DIR="$FLEET_BASE/current"
fi
say "Linking the CLIs"

# /usr/local/bin is NOT guaranteed to exist. On Apple Silicon it usually does
# not: Homebrew lives in /opt/homebrew there, and nothing else creates the
# directory — so a clean Mac ends this script with
#
#   ln: /usr/local/bin/fleetwright: No such file or directory
#
# after everything else has already been installed. It is on the default PATH
# regardless (/etc/paths ships it), so creating it is the right fix rather than
# picking a different directory that a shell might not search.
BIN_DIR=/usr/local/bin
if [ ! -d "$BIN_DIR" ]; then
  install -d -m 0755 "$BIN_DIR" || die "could not create $BIN_DIR"
  ok "created $BIN_DIR"
fi

# A WRAPPER, NOT A LINK, WHEN `node` IS NOT ON THE PATH. The shims start with
# `#!/usr/bin/env node`, which is right on every box that has node where a
# shell looks for it — and the deb is the box that does not: its node lives in
# /usr/lib/fleetwright/node, on purpose, so that it neither shadows nor is
# shadowed by a distro nodejs. Linked there, `fleetwright doctor` from a shell
# ends in "env: 'node': No such file or directory". The wrapper names the node
# the units run, so the command a person types and the service agree on which
# runtime this is.
# Also when the node a shell finds is too old: a distro nodejs below the floor
# on PATH would run the shim and fail on the first modern line, which is the
# same box — the deb on a machine that happens to have Debian's node — with a
# stranger error.
# CLI_NEEDS_WRAPPER is decided above, before the SessionStart hook is written,
# because the hook is the same question with a worse failure mode.
# NAME:FILE, because `fw` is not a file of its own: it is `fleetwright`,
# shorter, and a second copy of the entry point would be a second thing to
# keep in step. `fleetwright` is the name a person is told; the agent-* names
# stay for every box, runbook and muscle memory that already uses them.
# ROOT'S COMMAND IS ROOT'S CODE. The hub, the apps and these docs tell people
# to type `sudo fleetwright grant reboot on`, `sudo fleetwright join …` and
# `sudo fleetwright doctor --repair`, and on a packaged box the link those
# went through pointed into `current`: the release tree this installer gives
# $RUN_USER so /update can unpack into it. So root ran a file the service user
# can rewrite — and grant and join then ran `current`'s install.sh as root on
# top. The service user, or a session landing as it (security.md G8), edits
# current/src/core/grants.js and waits for somebody to follow the advice.
#
# So on such a box the hub's commands are a wrapper, root's and written here,
# that sends root to the sidecar's store: root's own copy of a verified
# release (refresh_sidecar_store), run with a node $RUN_USER cannot replace,
# and told `current` as its payload, which is the heal's arrangement — root's
# installer, the service user's release. Everybody else runs `current`, as
# before. And where root has no such copy, root is refused, in words, rather
# than handed the service user's tree.
#
# NOT ON A CHECKOUT, OR A MAC (which is one). There, everything is $RUN_USER's
# by design, the installer root runs included, and there is no root-owned
# tree to send anybody to; the line below says so instead of implying a
# boundary.
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
ROOT_GUARD=0 ROOT_TREE="" ROOT_NODE="" ROOT_WHY=""
if [ "$PLATFORM" = linux ] && [ "$CHECK_ONLY" != 1 ] && [ "$RUN_USER" != root ] \
   && { [ "$PACKAGED" = 1 ] || { [ "$CONVERTED" = 1 ] && [ "$FROM_SOURCE" = 0 ]; }; }; then
  ROOT_GUARD=1
  if [ "$SIDECAR_STORE" = 1 ] && [ -f "$SIDECAR_BASE/current/bin/fleetwright" ] && ! run_user_can_alter "$SIDECAR_BASE"; then
    for candidate in "${SIDECAR_NODE_BIN:-}" "${UNIT_NODE_BIN:-}" "${NODE_BIN:-}"; do
      [ -n "$candidate" ] && [ -x "$candidate" ] || continue
      if ! run_user_can_alter "$candidate"; then ROOT_NODE="$candidate"; break; fi
    done
    if [ -n "$ROOT_NODE" ]; then ROOT_TREE="$SIDECAR_BASE/current"
    else ROOT_WHY="every node on this box is one $RUN_USER can replace"; fi
  else
    ROOT_WHY="there is no root-owned copy of the release in $SIDECAR_BASE"
  fi
fi

for pair in fleetwright:fleetwright fw:fleetwright \
            fleetwright-sidecar:fleetwright-sidecar \
            agent-hub:agent-hub agent-fleet-sidecar:agent-fleet-sidecar; do
  link="${pair%%:*}"; cli="${pair#*:}"
  # THE SIDECAR'S COMMAND IS THE STORE'S. `sudo -u fleetwright-sidecar
  # fleetwright-sidecar enrol` is what the installer tells people to type, and
  # through a link into `current` that ran $RUN_USER's file as the account
  # holding the key.
  tree="$DIR"; node="${UNIT_NODE_BIN:-}"
  case "$cli" in *-sidecar) tree="$(sidecar_tree)"; node="${SIDECAR_NODE_BIN:-$node}" ;; esac
  [ -f "$tree/bin/$cli" ] || continue
  # Never written through: the old entry may be a symlink into `current`, and
  # `>` would follow it and overwrite the service user's file as root.
  rm -f "$BIN_DIR/$link" "$BIN_DIR/.$link.new"
  if [ "$ROOT_GUARD" = 1 ] && case "$cli" in *-sidecar) false ;; *) true ;; esac; then
    {
      printf '#!/bin/sh\n'
      printf '# Written by install.sh. Root never runs %s, which %s can change:\n' "$tree" "$RUN_USER"
      printf '# see "ROOT'"'"'S COMMAND IS ROOT'"'"'S CODE" in install.sh.\n'
      printf 'if [ "$(id -u)" = 0 ]; then\n'
      if [ -n "$ROOT_TREE" ] && [ -f "$ROOT_TREE/bin/$cli" ]; then
        printf '  [ -f %s ] || { echo "%s: root'"'"'s copy of the release is gone (%s); sudo /usr/local/sbin/fleetwright-migrate makes it again" >&2; exit 1; }\n' \
          "$(sq "$ROOT_TREE/bin/$cli")" "$link" "$ROOT_TREE"
        printf '  FLEETWRIGHT_PAYLOAD=%s FLEETWRIGHT_USER=%s\n' "$(sq "$FLEET_BASE/current")" "$(sq "$RUN_USER")"
        printf '  export FLEETWRIGHT_PAYLOAD FLEETWRIGHT_USER\n'
        printf '  exec %s %s "$@"\n' "$(sq "$ROOT_NODE")" "$(sq "$ROOT_TREE/bin/$cli")"
      else
        printf '  echo %s >&2\n' "$(sq "$link: not as root on this box. Its code is $tree, which $RUN_USER can change, and ${ROOT_WHY:-root has no copy of $cli}.")"
        if [ -n "$ROOT_NODE$ROOT_TREE" ] || [ "$SIDECAR_STORE" != 1 ]; then
          printf '  echo %s >&2\n' "$(sq "  A verified install makes root's copy: sudo /usr/local/sbin/fleetwright-migrate, the one-liner, or apt.")"
        else
          printf '  echo %s >&2\n' "$(sq "  A system node (apt install nodejs, $NODE_FLOOR or newer) and a re-run of the installer give root one.")"
        fi
        printf '  exit 1\n'
      fi
      printf 'fi\n'
      if [ "$CLI_NEEDS_WRAPPER" = 1 ] && [ -n "$node" ]; then
        printf 'exec %s %s "$@"\n' "$(sq "$node")" "$(sq "$tree/bin/$cli")"
      else
        printf 'exec %s "$@"\n' "$(sq "$tree/bin/$cli")"
      fi
    } > "$BIN_DIR/.$link.new"
    chmod 0755 "$BIN_DIR/.$link.new"
    mv -f "$BIN_DIR/.$link.new" "$BIN_DIR/$link"
  elif [ "$CLI_NEEDS_WRAPPER" = 1 ] && [ -n "$node" ]; then
    printf '#!/bin/sh\n# Written by install.sh: the node on PATH is missing or older than this needs.\nexec %s %s "$@"\n' \
      "$(sq "$node")" "$(sq "$tree/bin/$cli")" > "$BIN_DIR/.$link.new"
    chmod 0755 "$BIN_DIR/.$link.new"
    mv -f "$BIN_DIR/.$link.new" "$BIN_DIR/$link"
  else
    ln -sf "$tree/bin/$cli" "$BIN_DIR/$link"
  fi
  # Belt-and-braces: git already records the executable bit, so this only
  # matters for a checkout that lost it. Never fatal — the repo may legitimately
  # be on a read-only mount, or owned by someone else, and the symlink above is
  # the part that matters. ONLY a checkout: in a release tree the path is the
  # service user's, and root's chmod follows whatever symlink they left there.
  # And in a checkout as its owner (run_as), for the same reason.
  if [ -d "$tree/.git" ]; then
    [ -x "$tree/bin/$cli" ] || run_as "$(owner_of "$tree")" chmod +x "$tree/bin/$cli" 2>/dev/null || \
      warn "$tree/bin/$cli is not executable and could not be made so — check the checkout"
  fi
  ok "$BIN_DIR/$link -> $tree/bin/$cli"
done
# Said once, after the links, in the words a person needs before typing sudo.
if [ "$ROOT_GUARD" = 1 ] && [ -n "$ROOT_TREE" ]; then
  if run_user_can_alter "$BIN_DIR/fleetwright"; then
    warn "$RUN_USER can change $BIN_DIR/fleetwright, so \`sudo fleetwright …\` is theirs to redirect"
    MISSING+=("a $BIN_DIR that $RUN_USER cannot write, so root's \`fleetwright\` stays root's")
  else
    ok "as root, fleetwright runs $ROOT_TREE — root's copy — and never $DIR"
  fi
elif [ "$ROOT_GUARD" = 1 ]; then
  warn "as root, fleetwright refuses to run here: $ROOT_WHY, and $DIR is $RUN_USER's"
  MISSING+=("root's copy of the release, for \`sudo fleetwright grant\` and \`join\`: sudo /usr/local/sbin/fleetwright-migrate makes it")
elif [ "$CHECK_ONLY" != 1 ] && [ "$RUN_USER" != root ]; then
  warn "\`sudo fleetwright …\` runs $DIR as root, and $RUN_USER owns it — the same trust as running this installer from it"
fi
# A command from before the coordinator left points at nothing now, under either
# name; a command that exists and fails to run is worse than one that does not.
for stale in fleetwright-coordinator agent-fleet-coordinator; do
  if [ -L "$BIN_DIR/$stale" ] || [ -f "$BIN_DIR/$stale" ]; then
    rm -f "$BIN_DIR/$stale"
    ok "removed the old $stale command — it runs as a Worker now"
  fi
done
if [ -n "${LINK_DIR_SAVED:-}" ]; then DIR="$LINK_DIR_SAVED"; unset LINK_DIR_SAVED; fi

# --- 7. the wizard ----------------------------------------------------------
# Everything above wrote files. This turns the checklist that used to be printed
# at the end into questions, because most of that checklist was not decisions —
# it was secrets to generate and services to start.
#
# Skipped entirely without a terminal, in which case the old next-steps text is
# printed instead and nothing changes.

# THE FLEET THIS BOX IS JOINING, IF THE SCRIPT ARRIVED KNOWING IT.
#
# `/install` on a coordinator serves a six-line shim that exports this before
# fetching the installer, so
#
#     curl -fsSL https://fleet.example/install | sudo sh
#
# carries "which fleet" all the way through. Curling a coordinator IS joining
# that coordinator, and the installer should not then ask.
#
# Empty for a clone, a re-run, or anyone who fetched the installer from the
# repository — all of which still get the questions.
JOINING="${FLEETWRIGHT_COORDINATOR_URL:-}"
# A BARE HOSTNAME MEANS HTTPS, the same rule `fleetwright join` applies
# (src/core/join.js): `fleet.example.com` is somebody naming a host, and a
# Worker answers on nothing else. debconf's "Coordinator URL to join" was
# answered with exactly that on the first apt box, the address was written as
# typed, and enrolment failed with "Failed to parse URL from
# fleet.thetech.network/api/enroll/host" — a sentence about a scheme, shown to
# somebody who typed the same thing `join` accepts. A loopback address is
# http, because the local coordinator has no certificate; an explicit scheme
# is kept as typed.
case "$JOINING" in
  ''|*://*) ;;
  localhost*|127.*|\[::1\]*) JOINING="http://$JOINING" ;;
  *) JOINING="https://$JOINING" ;;
esac
case "$JOINING" in
  # Local and stdio are not a fleet somebody is joining; they are what the
  # wizard offers to set up, so leave the questions alone.
  ''|stdio:*|http://127.0.0.1*|http://localhost*) JOINING="" ;;
esac

ENROLLED=0
# WRITTEN WHETHER OR NOT THERE IS A TERMINAL. The address arrived with the
# script, and a box installed unattended off a coordinator's /install must
# join that coordinator too — it used to be written only inside the wizard, so
# `curl … | sudo sh` with no terminal installed a box that knew no fleet.
if [ -n "$JOINING" ] && [ "$CHECK_ONLY" != 1 ]; then
  set_env "$SIDECAR_ENV" FLEETWRIGHT_COORDINATOR_URL "$JOINING"
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [f, url] = process.argv.slice(1);
    fs.writeFileSync(f, fs.readFileSync(f, "utf8")
      .replace(/^FLEETWRIGHT_COORDINATOR_URL=.*$/m, `FLEETWRIGHT_COORDINATOR_URL=${url}`)
      .replace(/^FLEETWRIGHT_TRANSPORT=.*$/m, "FLEETWRIGHT_TRANSPORT=websocket"));
  ' "$SIDECAR_ENV" "$JOINING"
  ok "joining $JOINING"
fi

# Run a sidecar subcommand as the service user, with the environment the unit
# would have given it. Running it as root would put a root-owned key file
# where the service expects its own, and the service would refuse to read it.
# $1 is a SUBCOMMAND, $2 an optional argument, and the argument is quoted
# before it reaches the shell.
#
# It used to be one string interpolated raw into `bash -lc`, and the only
# thing ever put in it was a pin the operator pasted at a prompt — running as
# root. `enrol 123 456` silently enrolled with the code "123"; anything with a
# $( ) in it did rather more than that. The pin is checked to be six digits
# first, and %q-quoted after, because either alone would be enough and neither
# costs anything.
#
# Defined here, outside the wizard, because enrol_host below is too — an
# unattended install that was handed a pin has to be able to spend it. (It
# used to live inside the wizard; the unattended path then called a function
# that had never been defined, which `set -e` turned into a silent exit.)
sidecar_cli() {
  local sub="$1" arg="${2:-}" quoted=""
  [ -n "$arg" ] && printf -v quoted ' %q' "$arg"
  as_sidecar "FLEETWRIGHT_ENROL_QUIET=1 \
           FLEETWRIGHT_COORDINATOR_URL='$ENROL_URL' \
           FLEETWRIGHT_HOST_ID='$(get_env "$SIDECAR_ENV" FLEETWRIGHT_HOST_ID)' \
           FLEETWRIGHT_HOST_KEY='$(get_env "$SIDECAR_ENV" FLEETWRIGHT_HOST_KEY)' \
           '$SIDECAR_NODE_BIN' '$(sidecar_tree)/bin/fleetwright-sidecar' $sub$quoted"
}

# --- joining the fleet -------------------------------------------------------
# A pin, spent once, in exchange for this box's public key being known. The
# pin comes from a person: this installer holds no credential that could mint
# one, and that is the property — see docs/identity.md. Defined here, outside
# the wizard, because an unattended install that was handed a pin enrols too.
enrol_host() {
  local ENROL_URL
  ENROL_URL="$(get_env "$SIDECAR_ENV" FLEETWRIGHT_COORDINATOR_URL)"
  [ -n "$ENROL_URL" ] || return 0

  # Already enrolled? `doctor` is the one that asks the coordinator, because a
  # key on disk looks identical whether it was ever presented or has since
  # been revoked. Re-running the installer on a working box must not demand a
  # new pin.
  #
  # Two things this line has to get right, and it got both wrong first:
  #
  #   CAPTURED, NOT PIPED. doctor exits non-zero when anything it checks is
  #   unhappy, and on a fresh box something usually is — claude not being
  #   logged in yet, most often. Under `set -o pipefail` that exit code sinks
  #   the pipeline no matter what grep found.
  #
  #   MATCHED ON THE LEADING " ok ". doctor prints the same words on the
  #   FAILING line, so grepping for the sentence reports every unenrolled box
  #   as enrolled and skips the one step this function exists to do.
  DOCTOR_OUT="$(sidecar_cli doctor 2>/dev/null || true)"
  if printf '%s\n' "$DOCTOR_OUT" | grep -q '^ ok .*coordinator knows this host'; then
    ok "this box is already enrolled at $ENROL_URL"
    ENROLLED=1
    return 0
  fi

  # THE PIN CAN ARRIVE WITH THE COMMAND. The app prints, beside every pin it
  # mints, the one line that installs a box and joins it:
  #
  #     curl -fsSL https://fleet.example/install | sudo FLEETWRIGHT_ENROL_PIN=123456 sh
  #
  # An environment variable on the command line, not a query string: the pin
  # never reaches the coordinator's request log, and the shim it fetches stays
  # an address and nothing else. It is the same six digits the person would
  # otherwise be asked for below, from the same place, spent the same way — so
  # this is not enrolment reading a credential it found lying around; it is the
  # person answering the question before it is asked, which is what makes the
  # unattended install possible at all. The same variable is how the deb's
  # debconf question and `fleetwright join --pin` hand the pin in, so asking
  # again here would be a second prompt for the same six digits.
  local pin="${FLEETWRIGHT_ENROL_PIN:-}"
  if [ -n "$pin" ]; then
    ok "enrolment pin supplied with the command"
  else
    printf '\n  This box needs a six-digit pin from %s to join it.\n' "$ENROL_URL"
    printf '  Get one from the app (Fleet -> Add a host), or from anyone who has the admin token.\n'
    printf '  Blank is fine — run "fleetwright-sidecar enrol <pin>" whenever you have one.\n'
    ask pin "Enrolment pin"
    [ -n "$pin" ] || { warn "not enrolled — this host will be refused until it is"; return 0; }
  fi

  # Six digits or nothing. A pin is not free text and never was.
  pin="$(printf '%s' "$pin" | tr -cd '0-9')"
  if [ ${#pin} -ne 6 ]; then
    warn "that is not a six-digit pin — enrol later with: sudo -u $SIDECAR_USER $(sidecar_tree)/bin/fleetwright-sidecar enrol <pin>"
    return 0
  fi
  if sidecar_cli enrol "$pin" 2>&1 | sed 's/^/  /'; then
    ok "enrolled at $ENROL_URL"
    ENROLLED=1
  else
    warn "enrolment failed — run: sudo -u $SIDECAR_USER $(sidecar_tree)/bin/fleetwright-sidecar enrol <pin>"
  fi
}

if [ "$WIZARD" = yes ]; then
  say "Setup"
  printf '  Answers go into the /etc files. Anything you have already edited there is\n'
  printf '  left alone, and you can re-run this at any time.\n\n'

  # --- Telegram ------------------------------------------------------------
  #
  # TELEGRAM IS NO LONGER ASKED FOR. The adapter is archived — see
  # docs/telegram.md — so this prompt configured a feature that does nothing,
  # which is worse than not offering it: somebody answers it, sees "Telegram bot
  # configured", and messages a bot that will never reply.
  #
  # The env key is still READ, once, so that a box that has one gets told. It is
  # never written here again.

  # --- which fleet? ----------------------------------------------------------
  #
  # NOT ASKED WHEN THE ANSWER ARRIVED WITH THE SCRIPT. `curl .../install | sudo
  # sh` off a coordinator sets FLEETWRIGHT_COORDINATOR_URL, and the address in
  # what somebody typed IS the answer to "which fleet" — asking again is asking
  # them to repeat themselves.
  #
  # NOT OFFERED: running the coordinator here. It runs as a Cloudflare Worker
  # (or that Worker under workerd in a container), never as a Node service on a
  # host — docs/auth-and-join.md. A box that has no fleet yet is told where to
  # get one rather than handed a second implementation to run.
  if [ -n "$JOINING" ]; then
    : # written above, before the wizard, so the unattended path has it too
  elif [ -z "$(get_env "$SIDECAR_ENV" FLEETWRIGHT_COORDINATOR_URL)" ] \
     || [ "$(get_env "$SIDECAR_ENV" FLEETWRIGHT_COORDINATOR_URL)" = "stdio:local" ]; then
    printf '\n  A fleet needs a coordinator, and it runs as a Cloudflare Worker — five commands\n'
    printf '  on a free account, in docs/coordinator-deploy.md. Give its URL here, or leave\n'
    printf '  it blank and set FLEETWRIGHT_COORDINATOR_URL in %s later.\n' "$SIDECAR_ENV"
    ask COORD_URL "Coordinator URL to join (e.g. https://fleet.example.com)"
    if [ -n "$COORD_URL" ]; then
      "$NODE_BIN" -e '
        const fs = require("fs");
        const [f, url] = process.argv.slice(1);
        fs.writeFileSync(f, fs.readFileSync(f, "utf8")
          .replace(/^FLEETWRIGHT_COORDINATOR_URL=.*$/m, `FLEETWRIGHT_COORDINATOR_URL=${url}`)
          .replace(/^FLEETWRIGHT_TRANSPORT=.*$/m, "FLEETWRIGHT_TRANSPORT=websocket"));
      ' "$SIDECAR_ENV" "$COORD_URL"
      ok "this host will join $COORD_URL"
    fi
  else
    case "$(get_env "$SIDECAR_ENV" FLEETWRIGHT_COORDINATOR_URL)" in
      *127.0.0.1*|*localhost*)
        # The box was its own fleet. The unit was retired above; the URL is left
        # for the operator to change, because guessing a fleet address is worse
        # than a sidecar that says it cannot connect and to what.
        warn "FLEETWRIGHT_COORDINATOR_URL in $SIDECAR_ENV points at this box, and this box no longer
       runs a coordinator. Deploy the Worker (docs/coordinator-deploy.md) and set the URL." ;;
    esac
  fi

  # --- fleet identity ------------------------------------------------------
  # AFTER the fleet question, because the answer decides where this box enrols.
  #
  # There is no host token to generate or to ask for any more. This box makes a
  # keypair, keeps the private half 0600, and presents the public half once with
  # a six-digit pin. What that removes: a shared secret that had to be typed
  # identically on every machine, could not tell two boxes apart, and could not
  # be revoked for one of them. The pin comes from a person — the app, Fleet ->
  # Add a host, or the install command it prints — and blank is fine, because
  # `fleetwright-sidecar enrol` works perfectly well tomorrow.

  # The key file, and the directory systemd will also create. Made here as well
  # so `enrol` below can run before the service has ever started.
  # No -g: a matching group usually exists but is not guaranteed, and the mode
  # is 0700 so the group does not decide anything anyway. Same shape as the
  # STATE_DIR line above.
  install -d -m 0700 -o "$SIDECAR_USER" /var/lib/fleetwright-sidecar
  KEY_FILE_PATH=/var/lib/fleetwright-sidecar/host-key.json
  set_env "$SIDECAR_ENV" FLEETWRIGHT_HOST_KEY "$KEY_FILE_PATH"

  # --- is this box a clone of one that was already in the fleet? -----------
  #
  # /var/lib/fleetwright-sidecar/host-key.json IS this machine's identity — "whoever
  # can read it can be this machine, and nothing else can". Clone a VM that has
  # been installed and both boxes now hold the same private key, so the
  # coordinator sees ONE host. They take turns proving the same identity and
  # disconnecting each other, for ever, and the symptom is a host that flaps
  # with nothing in either box's logs to explain it.
  #
  # Nothing detected this. The installer found a valid key, assumed this box
  # was that host, and carried on.
  #
  # So the machine is fingerprinted next to the key, and a mismatch means the
  # key travelled to hardware it was not made on.
  machine_id() {
    if [ -r /etc/machine-id ]; then cat /etc/machine-id
    elif [ -r /var/lib/dbus/machine-id ]; then cat /var/lib/dbus/machine-id
    elif command -v ioreg >/dev/null 2>&1; then
      ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null \
        | awk -F'"' '/IOPlatformUUID/ {print $4}'
    fi
  }
  MACHINE_FILE=/var/lib/fleetwright-sidecar/machine-id
  THIS_MACHINE="$(machine_id || true)"
  if [ -n "$THIS_MACHINE" ]; then
    if [ -f "$KEY_FILE_PATH" ] && [ -f "$MACHINE_FILE" ] \
       && [ "$(cat "$MACHINE_FILE" 2>/dev/null)" != "$THIS_MACHINE" ]; then
      # Rotating rather than reusing, because the alternative is not "maybe
      # fine" — it is two machines authenticating as one, which is broken for
      # both. Moved aside rather than deleted: if this clone was meant to
      # REPLACE the original, the old key can be put back, and the original
      # must then be destroyed rather than left running.
      STAMP="$(date +%Y%m%d%H%M%S)"
      run_as "$SIDECAR_USER" mv "$KEY_FILE_PATH" "$KEY_FILE_PATH.clone-$STAMP"
      warn "THIS BOX IS A CLONE. It carried another machine's fleet identity."
      warn "  The key has been set aside as host-key.json.clone-$STAMP and a new"
      warn "  one will be made, so this box needs enrolling again."
      warn "  The ORIGINAL still holds that key — remove this box's old entry from"
      warn "  the coordinator, or the two will disconnect each other for ever."
      warn "  Meant to replace the original? Move the file back and destroy the original."
    fi
    # AS $SIDECAR_USER (run_as): the directory is that account's, and root's
    # `>` then chown followed a link left at the name — on a box whose sidecar
    # had to fall back to $RUN_USER, a link to /etc/passwd was root writing a
    # machine id over it and giving it away.
    printf '%s' "$THIS_MACHINE" | run_as "$SIDECAR_USER" sh -c 'umask 077; cat > "$1" && chmod 0600 "$1"' sh "$MACHINE_FILE" \
      || warn "could not write $MACHINE_FILE as $SIDECAR_USER — a clone of this box will not be recognised as one"
  fi

  # Sweep out the credential this replaced. It does nothing now — no coordinator
  # reads it and no sidecar sends it — but a dead secret sitting in a config
  # file still looks live to whoever finds it next, and the whole point of the
  # change is that there is no shared string to leak.
  for STALE_ENV in "$COORD_ENV" "$SIDECAR_ENV"; do
    if [ -f "$STALE_ENV" ] && grep -q '^FLEETWRIGHT_HOST_TOKEN=' "$STALE_ENV"; then
      ENVFILE="$STALE_ENV" "$NODE_BIN" -e '
        const fs = require("fs");
        const f = process.env.ENVFILE;
        fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^FLEETWRIGHT_HOST_TOKEN=.*\n?/gm, ""));
      '
      ok "removed the old shared host token from $STALE_ENV — hosts hold a key now"
    fi
  done

  ENROL_URL="$(get_env "$SIDECAR_ENV" FLEETWRIGHT_COORDINATOR_URL)"

  # --- system updates from chat --------------------------------------------
  # A NOPASSWD rule for ONE exact command, which is a much narrower grant than
  # it first sounds: sudoers matches the full argv, so this permits
  # `apt-get -y upgrade` and nothing else — not install, not remove, not a
  # shell, not apt-get with different arguments.
  #
  # Validated with visudo before it is installed. A malformed file in
  # /etc/sudoers.d does not break one rule, it breaks sudo, and that is a bad
  # way to find out.
  if [ -n "$GRANT_UPGRADES" ] && command -v visudo >/dev/null && [ -d /etc/sudoers.d ]; then
    # Answered already — by debconf, a flag, or `fleetwright grant` — so the
    # answer is applied and the question is not asked.
    apply_grant upgrades "$GRANT_UPGRADES" || true
  elif [ -z "$(get_env "$ENV_FILE" FLEETWRIGHT_SYSTEM_UPGRADE)" ] \
     && command -v sudo >/dev/null && command -v visudo >/dev/null && [ -d /etc/sudoers.d ]; then
    printf '\n  /upgrade can show what the operating system has waiting, and apply it.\n'
    printf '  That needs one sudoers rule permitting exactly three things, each a\n'
    printf '  root-owned unit this user may start and cannot give arguments to:\n'
    printf '      apt-get update                          (refresh the package lists)\n'
    printf '      apt-get -y upgrade                      (install what is waiting, fleetwright held)\n'
    printf '      apt-get install --only-upgrade fleetwright   (this package alone)\n'
    printf '  and nothing else — not another package, not remove, not a shell.\n'
    printf '\n  The refresh matters: this box does not update its package lists on its\n'
    printf '  own, so without it "no updates" would mean "nobody has looked since\n'
    printf '  install day".\n'
    if confirm "Allow system updates from chat?" Y; then
      apply_grant upgrades yes || true
    else
      set_env "$ENV_FILE" FLEETWRIGHT_SYSTEM_UPGRADE 0
      ok "skipping — /upgrade will report what is waiting but not apply it"
    fi
    printf '\n'
  fi

  # Reboot is asked separately, and defaults to no. It is not a bigger version
  # of the same permission: installing packages leaves every session running,
  # and a reboot takes the tmux server with it, so every session dies
  # mid-thought. Folding the two into one question would mean somebody granting
  # the second while thinking about the first.
  if [ -n "$GRANT_REBOOT" ] && command -v visudo >/dev/null && [ -d /etc/sudoers.d ]; then
    apply_grant reboot "$GRANT_REBOOT" || true
  elif [ -z "$(get_env "$ENV_FILE" FLEETWRIGHT_SYSTEM_REBOOT)" ] \
     && command -v sudo >/dev/null && command -v visudo >/dev/null && [ -d /etc/sudoers.d ]; then
    printf '  /reboot can restart this machine from chat, behind three confirmations:\n'
    printf '  the command, a one-time token, and the hostname typed out.\n'
    printf '  EVERY RUNNING SESSION DIES — a reboot takes the tmux server with it.\n'
    if confirm "Allow reboot from chat?" N; then
      apply_grant reboot yes || true
    else
      set_env "$ENV_FILE" FLEETWRIGHT_SYSTEM_REBOOT 0
      ok "skipping — sudo fleetwright grant reboot on turns it on later, and /reboot says so"
    fi
    printf '\n'
  fi

  # --- sandbox -------------------------------------------------------------
  if [ "$HAVE_PODMAN" = 1 ] && [ -z "$(get_env "$ENV_FILE" FLEETWRIGHT_SANDBOX)" ]; then
    printf '\n  Sandboxed sessions get real root inside a container whose filesystem is\n'
    printf '  thrown away on every stop. The conversation and the workspace survive.\n'
    if confirm "Sandbox sessions?" Y; then
      set_env "$ENV_FILE" FLEETWRIGHT_SANDBOX 1
      ok "sandboxing on"
    fi
  fi

  # --- start it ------------------------------------------------------------
  if [ "$HAVE_SYSTEMD" = 1 ]; then
    printf '\n'
    if confirm "Enable and start the services now?" Y; then
      # Print the reason rather than where to look for it. "failed to start,
      # go read the journal" is a round trip for information we already have.
      # `enable --now` STARTS a stopped unit and does nothing at all to a
      # running one. So re-running the installer over an existing deployment —
      # which is the documented way to upgrade, and what `/update` tells people
      # to do — left the old code running with the old environment, reported
      # "running", and looked like a successful upgrade.
      #
      # An already-active unit is restarted. It is the same reload systemd would
      # do anyway, and the unit files may have changed underneath it.
      start_service() {
        if [ "$PLATFORM" = macos ]; then
          local label="system/network.thetech.$1" plist="/Library/LaunchDaemons/network.thetech.$1.plist"
          # bootout then bootstrap, because bootstrap on an already-loaded
          # label fails rather than replacing it — the launchd equivalent of
          # the restart-an-active-unit case below, and the same bug it fixes:
          # an upgrade that leaves the old code running while reporting success.
          if launchd_reload "$1"; then
            ok "$1 running"
            return 0
          fi
          warn "$1 failed to start — see above, then: sudo launchctl print $label"
          return 1
        fi
        systemctl daemon-reload >/dev/null 2>&1 || true

        # A UNIT THAT CRASH-LOOPED CANNOT BE STARTED UNTIL ITS FAILURE IS
        # CLEARED, and nothing cleared it. Once StartLimitBurst is hit systemd
        # answers "Start request repeated too quickly" and refuses — so a box
        # that has been failing cannot be repaired by ANY installer, however
        # correct the unit it writes. A real host reached restart counter 6423
        # and every re-run of the installer reported `ok`.
        systemctl reset-failed "$1" >/dev/null 2>&1 || true
        stop_legacy_unit "$1"

        WAS_ACTIVE=no
        systemctl is-active --quiet "$1" && WAS_ACTIVE=yes
        systemctl enable "$1" >/dev/null 2>&1 || true
        systemctl restart "$1" >/dev/null 2>&1 || true

        # AND THE ANSWER IS SYSTEMD'S, NOT THE EXIT CODE OF THE COMMAND. Both
        # `enable --now` and `restart` returned success on a box whose service
        # died immediately afterwards — so the installer said "running" about a
        # unit in a restart loop, which is the single most misleading line it
        # could print.
        sleep 1
        if systemctl is-active --quiet "$1"; then
          [ "$WAS_ACTIVE" = yes ] && ok "$1 restarted, on the new code" || ok "$1 running"
          return 0
        fi
        warn "$1 failed to start:"
        journalctl -u "$1" -n 12 --no-pager 2>/dev/null | sed 's/^/       /' \
          || warn "       journalctl -u $1 -n 50"
        return 1
      }
      # Recorded, because section 8 removes the previous install and must not
      # do that on a box where the replacement never came up. Seen-to-start is
      # the only evidence worth acting on.
      if start_service fleetwright; then SERVICES_STARTED=1; fi

      # Arm the commit-confirm watchdog. A timer, not a service: `enable --now`
      # starts its clock, and it is a no-op on a box with nothing on trial.
      if [ "$PACKAGED" = 1 ] && [ -f /etc/systemd/system/fleetwright-confirm.timer ]; then
        systemctl reset-failed fleetwright-confirm.timer >/dev/null 2>&1 || true
        if systemctl enable --now fleetwright-confirm.timer >/dev/null 2>&1; then
          ok "commit-confirm watchdog armed — a bad update reverts itself"
        else
          warn "could not arm fleetwright-confirm.timer — updates will not auto-revert"
        fi
      fi

      # Enrol BEFORE starting the sidecar. Not for correctness — the sidecar
      # retries and would pick it up — but because a box that comes up refused
      # writes "that host is not enrolled" into the journal every few seconds,
      # and the first thing anyone does with that is assume it is broken.
      enrol_host

      [ -n "$(get_env "$SIDECAR_ENV" FLEETWRIGHT_COORDINATOR_URL)" ] && { start_service fleetwright-sidecar || true; }
      STARTED=1
    fi
  fi

  # THE COORDINATOR IS UP WHETHER OR NOT THIS BOX'S SERVICES ARE. Enrolment
  # used to happen only on the started path above, on the reasoning that it is
  # the only path with a coordinator to enrol with — which was true of a
  # coordinator on this box, and is not of a Worker, which is the only kind
  # left (docs/auth-and-join.md). So `fleetwright join fleet.example.com --pin`
  # on a box without systemd (a container, WSL) wrote the address, printed
  # "has not joined yet", and dropped the pin it was given. The same for a
  # box whose operator declined the start: the pin is the thing they typed.
  if [ "${STARTED:-0}" != 1 ] && [ -n "$ENROL_URL" ]; then
    enrol_host
  fi

  # --- log claude in -------------------------------------------------------
  # The one remaining step that genuinely needs a human, and the one the hub was
  # built to make possible without SSH. Doing it here means a fresh box is
  # finished when this script is.
  # The login state lives in the RUN_USER's home, and this script runs under
  # sudo — so asking root whether claude is logged in gets the wrong answer on
  # a box that is perfectly well logged in. Same bug as `doctor` had, same fix.
  # Not without somebody to paste a code: the login prints a link and waits
  # for what the page gives back, and a default of "yes" with nobody there
  # prints a URL into apt's output and then gives up on it.
  if [ "${STARTED:-0}" = 1 ] && [ -n "$CLAUDE_BIN" ] && [ -n "$ASK_IN" ] \
     && ! as_user "'$CLAUDE_BIN' auth status --json" 2>/dev/null | grep -q '"loggedIn": *true'; then
    printf '\n'
    if confirm "Log this box into a Claude account now?" Y; then
      sleep 2 # let the hub finish binding its port
      # AS THE SERVICE USER, which owns the login it is starting and the
      # config it reads: run as root, this was root executing a file in
      # `current`, which that user can rewrite.
      if LOGIN_OUT="$(as_user "'$UNIT_NODE_BIN' '$DIR/bin/fleetwright' login" 2>&1)"; then
        printf '%s\n' "$LOGIN_OUT"
        # Only ask for a code if there is a page to get one from. `login` on an
        # already-authenticated box answers "Already logged in", and asking for
        # a code after that is asking the operator to produce something that
        # does not exist.
        #
        # Gated on THAT string rather than on spotting a URL. The first version
        # of this grepped for https://claude.ai/ — and the live authorize URL is
        # https://claude.com/cai/oauth/authorize, which src/core/login.js says
        # in as many words. It would have skipped the prompt on a genuinely
        # logged-out box and announced the opposite. Matching the sentence the
        # hub actually emits (src/adapters/commands.js) cannot fail that way,
        # and a new first-party auth host cannot silently reintroduce it.
        if ! printf '%s' "$LOGIN_OUT" | grep -q 'Already logged in'; then
          ask AUTH_CODE "Paste the code from that page (blank to do it later)"
          if [ -n "$AUTH_CODE" ]; then
            as_user "'$UNIT_NODE_BIN' '$DIR/bin/fleetwright' code $(printf '%q' "$AUTH_CODE")" 2>&1 | sed 's/^/  /' || true
          fi
        else
          ok "nothing to do — this box is already logged in"
        fi
      else
        warn "could not start the login: $LOGIN_OUT"
      fi
    fi
  fi
fi


# --- joining, unattended -----------------------------------------------------
# No terminal, or --yes — and a pin arrived with the command. Everything the
# wizard would have asked is answered: the address came with the script, the
# pin came with the command, so the box joins. Services are still yours to
# start (the Next block says so); enrolment needs only the coordinator.
if [ "$WIZARD" != yes ] && [ "$CHECK_ONLY" != 1 ] && [ -n "${FLEETWRIGHT_ENROL_PIN:-}" ]; then
  say "Joining the fleet"
  enrol_host
fi

# --- 8. the install this one replaces ---------------------------------------
#
# EVERY INSTALL IS AN UPGRADE. Boxes are already running the checkout layout —
# a git clone with node_modules — so a release cannot behave as though it
# arrived on a clean machine. Two installs side by side is not "harmless
# leftovers": it is a box where the next `/update` picks one of them and nobody
# can tell which is running.
#
# Nothing here touches state. The credentials, the host key, the registry and
# the env files all live OUTSIDE the install directory already
# (/etc/*.env, /var/lib/fleetwright, /var/lib/fleetwright-sidecar), which is why this can
# be a directory removal rather than a migration of data. The units were
# rewritten above with __DIR__ pointing at this release, so the switch has
# already happened by the time we get here.
if [ "$PACKAGED" = 1 ] && [ "$CHECK_ONLY" != 1 ]; then
  say "The install this one replaces"

  OLD_DIR=""
  for u in fleetwright fleetwright-sidecar; do
    [ -f "$OLD_UNIT_BACKUP_DIR/$u.service" ] || continue
    # The path the OLD unit ran from, taken from the backup rather than from
    # the file we just overwrote.
    d="$(sed -n 's|^ExecStart=[^ ]* \(.*\)/bin/[a-z-]*.*$|\1|p' "$OLD_UNIT_BACKUP_DIR/$u.service" | head -1)"
    [ -n "$d" ] && [ "$d" != "$DIR" ] && OLD_DIR="$d" && break
  done

  if [ -z "$OLD_DIR" ]; then
    ok "no earlier install to clean up"
  elif [ ! -d "$OLD_DIR" ]; then
    ok "the earlier install at $OLD_DIR is already gone"
  elif [ "$UPGRADE" = 1 ] && [ -d "$OLD_DIR/.git" ]; then
    # A MIGRATION KEEPS THE CHECKOUT, DELIBERATELY, and this used to be
    # reported as a failure: SERVICES_STARTED is only set inside the wizard's
    # start block, which --upgrade skips — so this warned that "the new services
    # did not start" immediately before the upgrade section restarted them and
    # said so. Two true-looking lines contradicting each other, in the log
    # somebody reads to find out whether a conversion worked.
    #
    # And keeping it is right on its own terms. That tree holds the installer a
    # future migration runs (FLEETWRIGHT_PAYLOAD), and it is the way back: one
    # `ln -sfn` re-points `current` at it if a release turns out not to start.
    ok "$OLD_DIR kept — it is the installer future updates use, and the way back"
  elif [ "$SERVICES_STARTED" != 1 ]; then
    # THE ORDER IS THE SAFETY. Removing the old tree before the new one has
    # been seen to start would leave a box with neither.
    warn "the new services did not start, so $OLD_DIR was left alone.
       Fix the service, re-run this installer, and it will clean up then."
  # The question asked AS $RUN_USER: git run by root in their repository runs
  # what its config names (core.fsmonitor), and under sudo git trusts a
  # repository owned by the account that ran sudo.
  elif [ -d "$OLD_DIR/.git" ] && ! as_user "cd $(printf '%q' "$OLD_DIR") && git diff --quiet HEAD" 2>/dev/null; then
    # Somebody's working tree. This is a development box, and deleting
    # uncommitted work to tidy up a directory is not a trade this installer
    # gets to make on anybody's behalf.
    warn "$OLD_DIR has uncommitted changes, so it was NOT removed.
       It is no longer what runs — the services point at $DIR.
       Remove it yourself when you have saved what you want:  rm -rf $OLD_DIR"
  # AS $RUN_USER WHEN THE PATH TO IT IS THEIRS — a checkout in a directory of
  # their home: rm -rf never follows the link it is handed, but a directory on
  # the way that they can rename is a different tree by the time root gets
  # there. A path of root's (/opt/fleetwright-src) is root's to remove, and
  # GNU rm does not follow a link inside the tree it removes.
  elif run_user_can_alter "$(dirname "$OLD_DIR")" notree; then
    if run_as_user rm -rf "$OLD_DIR"; then
      ok "removed the earlier install at $OLD_DIR"
    else
      warn "could not remove $OLD_DIR as $RUN_USER — it is no longer what runs; remove it yourself"
    fi
  else
    rm -rf "$OLD_DIR"
    ok "removed the earlier install at $OLD_DIR"
  fi
fi

# --- done -------------------------------------------------------------------
# Everything that was skipped, together, at the end. One warning in the middle
# of two hundred lines is a warning nobody read — and on a platform this only
# partly supports, the list IS the useful output.
# --- 8b. --repair: the rules this box already agreed to -----------------------
#
# The sections above rewrite everything they own on every run — units, the hook,
# the directories — so an unattended run already repairs most of a drifted box.
# The two sudoers rules are the exception, because they live behind questions in
# the wizard and the wizard does not run when nobody is there to answer.
#
# THE ANSWERS ARE ALREADY IN THE ENV FILE. A box that said yes to system
# upgrades has FLEETWRIGHT_SYSTEM_UPGRADE=1 recorded, so re-applying the rule is
# acting on a decision somebody already made rather than making one for them.
# A box that said no keeps its no: this reads the setting, it never writes one.
#
# The case this exists for is a rule that has CHANGED shape. The upgrade rule
# grew two permitted command forms so an unattended apt can answer conffile
# prompts, and every box installed before that carries the old one — where the
# only remedy was a full reinstall on a machine whose only fault was being
# older than a commit.
if [ "$REPAIR" = 1 ] && [ "$CHECK_ONLY" != 1 ]; then
  say "Repairing what this box has already agreed to"
  if command -v visudo >/dev/null && [ -d /etc/sudoers.d ]; then
    if [ "$(get_env "$ENV_FILE" FLEETWRIGHT_SYSTEM_UPGRADE)" = 1 ]; then
      apply_grant upgrades yes || true
    else
      ok "system upgrades are off here — leaving that alone (sudo fleetwright grant upgrades on)"
    fi
    if [ "$(get_env "$ENV_FILE" FLEETWRIGHT_SYSTEM_REBOOT)" = 1 ]; then
      apply_grant reboot yes || true
    else
      ok "reboot from chat is off here — leaving that alone (sudo fleetwright grant reboot on)"
    fi
  else
    warn "no visudo on this box, so the sudoers rules were not touched"
  fi
fi

# --- 9. --upgrade: apply the code, and say whether it can talk ---------------
#
# The wizard block above is where services get restarted, and it only runs with
# a terminal. So `FLEETWRIGHT_NONINTERACTIVE=1` — which has existed all along —
# put new code on disk and left the OLD CODE RUNNING while reporting success.
# That is the failure src/core/update.js is written around, in the one place
# nobody was looking.
#
# This is deliberately NOT the wizard with the questions removed. Running a
# wizard with no stdin means every prompt silently takes its default on a
# machine somebody is not watching, and "took a default" is not a thing to
# discover on a production box. It does three things and refuses to guess at
# anything else.
if [ "$UPGRADE" = 1 ] && [ "$CHECK_ONLY" != 1 ]; then
  say "Applying the upgrade"

  # ALREADY ENROLLED, OR THIS IS THE WRONG COMMAND. Enrolling a new box needs a
  # six-digit pin minted by a person in the app — short-lived, single-use, and
  # deliberately not something a script can obtain. So --upgrade refuses rather
  # than half-installing, and names what is missing instead of leaving somebody
  # to work out why nothing connected.
  UPGRADE_MISSING=""
  [ -f "$SIDECAR_ENV" ] || UPGRADE_MISSING="$UPGRADE_MISSING $SIDECAR_ENV"
  [ -f /var/lib/fleetwright-sidecar/host-key.json ] || UPGRADE_MISSING="$UPGRADE_MISSING /var/lib/fleetwright-sidecar/host-key.json"
  if [ -n "$UPGRADE_MISSING" ]; then
    die "--upgrade is for a box that is already in a fleet, and this one is not.
       Missing:$UPGRADE_MISSING
       Run the installer with a terminal to set it up and enrol it, or enrol by hand:
           fleetwright-sidecar enrol <pin>"
  fi

  # Only what is actually installed, so a unit an older install wrote and this
  # one retired is not a failure about something absent on purpose.
  for unit in fleetwright fleetwright-sidecar; do
    if [ "$PLATFORM" = macos ]; then
      label="system/network.thetech.$unit"
      plist="/Library/LaunchDaemons/network.thetech.$unit.plist"
      [ -f "$plist" ] || continue
      if launchd_reload "$unit"; then
        ok "$unit restarted, on the new code"
      else
        warn "$unit did not come back — sudo launchctl print $label"
      fi
      continue
    fi
    systemctl list-unit-files "$unit.service" >/dev/null 2>&1 || continue
    systemctl cat "$unit.service" >/dev/null 2>&1 || continue
    systemctl daemon-reload >/dev/null 2>&1 || true
    # THE SAME TWO RULES AS start_service, AND FOR THE SAME REASON. A unit that
    # crash-looped is refused by systemd until its failure is cleared, so an
    # upgrade — which is how a migration finishes — could not repair the boxes
    # that most needed repairing. And `restart` returning 0 says the request was
    # accepted, not that anything is running.
    systemctl reset-failed "$unit" >/dev/null 2>&1 || true
    stop_legacy_unit "$unit"
    systemctl restart "$unit" >/dev/null 2>&1 || true
    sleep 1
    if systemctl is-active --quiet "$unit"; then
      ok "$unit restarted, on the new code"
    else
      warn "$unit did not come back:"
      journalctl -u "$unit" -n 12 --no-pager 2>/dev/null | sed 's/^/       /' || true
    fi
  done

  # THE PROTOCOL, WHICH IS THE WHOLE REASON THIS FLAG EXISTS.
  #
  # The coordinator and a host agree on a version number, EXACTLY — a mismatch
  # is refused per intent with `unsupported_version`. And the coordinator does
  # not check it on connect or on health, so a host one version behind stays
  # CONNECTED AND GREEN while every action against it fails. The fleet looks up
  # and nothing works, which is the worst shape a failure can have.
  #
  # An upgrade is exactly when that gap opens, so this is where it gets said.
  say "Checking the protocol"
  UPGRADE_URL="$(get_env "$SIDECAR_ENV" FLEETWRIGHT_COORDINATOR_URL)"
  # BOTH SHAPES. A checkout has src/; a RELEASE has only bundled lib/, so this
  # read nothing on a packaged box and skipped the one check that catches the
  # failure described above — silently, on exactly the boxes an upgrade puts
  # most at risk. The release states the protocol it speaks in its package.json,
  # which is the same number the manifest carries.
  #
  # AS THE SERVICE USER, NOT AS ROOT. That import executes a file in $DIR, and
  # on a packaged box $DIR is `current`: a release ships no src/, so the
  # service user could add one, ask for the heal (`sudo -n fleetwright-migrate`
  # runs this with --repair), and have root import it. Reading a number does
  # not need root, and the service user running its own file gains nothing.
  UPGRADE_MINE="$(as_user "'$NODE_BIN' -e \"import('$DIR/src/fleet/protocol/intents.js').then(m => console.log(m.PROTOCOL_VERSION))\"" 2>/dev/null | tail -1 || true)"
  case "$UPGRADE_MINE" in *[!0-9]*) UPGRADE_MINE="" ;; esac
  # GUARDED, BECAUSE A FALLBACK MUST NOT BE ABLE TO END THE SCRIPT. As
  # `[ -n "$X" ] || VAR=$(sed ... | head -1)` this was a landmine: sed exits 2
  # on a file it cannot read, pipefail promotes that through the pipeline, and
  # the assignment being the right-hand side of `||` makes its failure the
  # status of the whole compound — so `set -e` ended the installer.
  #
  # It ended it in the worst possible place: immediately after the services were
  # restarted, printing "Checking the protocol" and nothing else. A migration
  # that had completely succeeded exited non-zero and was reported as a failure.
  #
  # This line was added today to make the check work on packaged boxes, and it
  # took out the thing it was fixing. scripts/migration-drill.sh caught it.
  if [ -z "$UPGRADE_MINE" ] && [ -f "$DIR/package.json" ]; then
    UPGRADE_MINE="$(sed -n 's/.*"protocol"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$DIR/package.json" | head -1 || true)"
  fi
  if [ -z "$UPGRADE_MINE" ]; then
    warn "could not read this box's protocol version from $DIR — skipping the check"
  elif [ -z "$UPGRADE_URL" ]; then
    ok "this box speaks protocol v$UPGRADE_MINE (no coordinator configured, so nothing to compare)"
  else
    # /healthz needs no credential and answers {ok, protocol}. Deliberately not
    # an authenticated route: the point is to be readable from a box that is
    # being repaired.
    # A REPORTING SECTION MUST NOT BE ABLE TO END THE SCRIPT, and this is the
    # third statement in this block that could. `curl` exits 3 on a URL it
    # cannot parse and 7 on one it cannot reach; pipefail promotes that through
    # the pipeline, the assignment fails, and `set -e` ends the installer —
    # AFTER the services have already been restarted.
    #
    # So any box whose coordinator is unreachable, or which has never had one,
    # reported a completely successful migration as a failure and stopped with
    # "Checking the protocol" as its last line. Being unable to compare two
    # version numbers is a warning; it is not a reason to stop.
    UPGRADE_THEIRS=""
    if UPGRADE_HEALTH="$(curl -fsS --max-time 10 "${UPGRADE_URL%/}/healthz" 2>/dev/null)"; then
      UPGRADE_THEIRS="$(printf '%s' "$UPGRADE_HEALTH" \
        | sed -n 's/.*"protocol"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
    fi
    if [ -z "$UPGRADE_THEIRS" ]; then
      warn "could not reach $UPGRADE_URL to compare protocol versions — this box speaks v$UPGRADE_MINE"
    elif [ "$UPGRADE_THEIRS" = "$UPGRADE_MINE" ]; then
      ok "protocol v$UPGRADE_MINE, and the coordinator agrees"
    else
      warn "PROTOCOL MISMATCH: this box speaks v$UPGRADE_MINE, $UPGRADE_URL speaks v$UPGRADE_THEIRS.
       The box will connect and look healthy, and EVERY command to it will be refused
       with unsupported_version until both ends match. Upgrade whichever is behind."
    fi
  fi
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  say "Not set up on this platform"
  printf '  This is a %s box, and parts of this are still Linux-only:\n\n' "$PLATFORM"
  for m in "${MISSING[@]}"; do printf '    - %s\n' "$m"; done
  printf '\n  Everything else above is installed and working. Mac host support is\n'
  printf '  being filled in — see docs/wanted.md.\n'
fi

# THE ONE THING THIS BOX MUST NOT CLAIM, at the end where it is read. Found
# by the check before the units were written; see SIDECAR_EXPOSED.
if [ -n "${SIDECAR_EXPOSED:-}" ]; then
  say "The host key is not protected from $RUN_USER"
  printf '  The sidecar runs as %s, which keeps it out of %s'"'"'s credentials,\n' "$SIDECAR_USER" "$RUN_USER"
  printf '  but %s can change what it runs:\n\n' "$RUN_USER"
  for p in $SIDECAR_EXPOSED; do printf '    %s\n' "$p"; done
  if [ "$SIDECAR_STORE" != 1 ] && [ -d "$DIR/.git" ]; then
    printf '\n  This box runs from a git checkout, which %s owns so that /update can\n' "$RUN_USER"
    printf '  pull, so there is no separation to have here. That is right for a box\n'
    printf '  somebody edits. Packaged releases keep the sidecar'"'"'s code root-owned:\n'
    printf '      sudo /usr/local/sbin/fleetwright-migrate\n'
  elif [ "$SIDECAR_STORE" != 1 ]; then
    printf '\n  No verified copy of a release has been through this installer yet, so the\n'
    printf '  sidecar runs out of the tree %s updates. Any of these makes the copy:\n' "$RUN_USER"
    printf '      sudo /usr/local/sbin/fleetwright-migrate      (or apt, or the one-liner)\n'
  else
    printf '\n  Its node is the usual cause: one in %s'"'"'s home is a binary they can\n' "$RUN_USER"
    printf '  replace. Install a system node (apt install nodejs, %s or newer) and re-run.\n' "$NODE_FLOOR"
  fi
fi

# --- what the rename stopped, started again ---------------------------------
# A service that was running under its old name, and that no step above
# restarted — the one-liner re-run with no terminal, say, which writes files
# and starts nothing — is started under its new one. The migration must never
# be the thing that leaves a working box stopped.
if [ -n "$LEGACY_RUNNING" ] && [ "$CHECK_ONLY" != 1 ]; then
  for unit in $LEGACY_RUNNING; do
    if [ "$PLATFORM" = macos ]; then
      plist="/Library/LaunchDaemons/network.thetech.$unit.plist"
      launchctl print "system/network.thetech.$unit" >/dev/null 2>&1 && continue
      [ -f "$plist" ] || continue
      stop_legacy_unit "$unit"
      if launchd_reload "$unit"; then
        ok "$unit running — it was running before the rename"
      else
        warn "$unit was running as $(legacy_unit_for "$unit") and did not start under its new label — sudo launchctl print system/network.thetech.$unit"
      fi
      continue
    fi
    systemctl is-active --quiet "$unit" 2>/dev/null && continue
    [ -f "/etc/systemd/system/$unit.service" ] || continue
    stop_legacy_unit "$unit"
    systemctl daemon-reload >/dev/null 2>&1 || true
    if systemctl enable --now "$unit" >/dev/null 2>&1 && systemctl is-active --quiet "$unit"; then
      ok "$unit running — it was running before the rename"
    else
      warn "$unit was running as $(legacy_unit_for "$unit") and did not start under its new name:"
      journalctl -u "$unit" -n 12 --no-pager 2>/dev/null | sed 's/^/       /' || true
    fi
  done
fi
# THE WATCHDOG, RE-ARMED. The migration removed agent-fleet-confirm.timer; the
# new timer is written above but only the wizard arms it, and an update runs
# no wizard. Left here, every pre-rename box would stop reverting bad updates
# the day it took this one.
if [ "$LEGACY_CONFIRM" = 1 ] && [ "$PLATFORM" = linux ] && [ "$CHECK_ONLY" != 1 ] \
   && [ -f /etc/systemd/system/fleetwright-confirm.timer ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
  if systemctl enable --now fleetwright-confirm.timer >/dev/null 2>&1; then
    ok "commit-confirm watchdog re-armed under its new name"
  else
    warn "could not arm fleetwright-confirm.timer — updates will not auto-revert"
  fi
fi

say "Installed."

# What is genuinely left, which is not the same as what the checklist used to
# say. Telling someone to create a Telegram bot they just configured, or to
# generate tokens that were generated for them, is worse than saying nothing.
if [ "$WIZARD" = yes ]; then
  if [ "${STARTED:-0}" = 1 ]; then
    printf '\n'
    # As the RUN USER, not as root. doctor resolves paths relative to $HOME, so
    # running it under sudo answers a question nobody asked — it reports on
    # root's box while the service runs as somebody else.
    as_user "'$UNIT_NODE_BIN' '$DIR/bin/fleetwright' doctor" 2>&1 | sed 's/^/  /' || true
  fi

  printf '\n'
  # SAID ONLY WHEN IT IS SET, and then to say it does nothing. A box carrying a
  # token from before the adapter was archived would otherwise start clean, log
  # nothing and answer no messages — which reads as a broken bot rather than an
  # absent one, and sends whoever set it looking at Telegram.
  [ -n "$(get_env "$ENV_FILE" FLEETWRIGHT_TELEGRAM_TOKEN)" ] \
    && printf '  Telegram : archived — the token in %s is not read. See docs/telegram.md\n' "$ENV_FILE"
  [ "$(get_env "$ENV_FILE" FLEETWRIGHT_SANDBOX)" = "1" ] && printf '  Sandbox  : on\n'

  if [ "$HAVE_SYSTEMD" != 1 ]; then
    printf '\n  systemd is not running here, so nothing was started. Run them directly:\n'
    printf '      %s %s/bin/fleetwright serve\n' "$UNIT_NODE_BIN" "$DIR"
    printf '      %s %s/bin/fleetwright-sidecar\n' "$SIDECAR_NODE_BIN" "$(sidecar_tree)"
  elif [ "${STARTED:-0}" != 1 ]; then
    printf '\n  Start them when you are ready:\n'
    printf '      systemctl enable --now fleetwright fleetwright-sidecar\n'
  fi

  # Said when this box is still not enrolled — a local coordinator that was not
  # started, a blank pin, or a refusal — rather than leaving a box that
  # connects and is refused on every try.
  if [ -n "$ENROL_URL" ] && [ "${ENROLLED:-0}" != 1 ]; then
    printf '\n  This box has not joined %s yet. With a six-digit pin from the app:\n' "$ENROL_URL"
    printf '      sudo -u %s %s/bin/fleetwright-sidecar enrol <pin>\n' "$SIDECAR_USER" "$(sidecar_tree)"
    printf '  Until then the sidecar is refused on every try.\n'
  fi

  # As the service user: root's ~/.claude is not where the credentials live, so
  # asking as root reports "not logged in" on a box that plainly is.
  if [ -n "$CLAUDE_BIN" ] && ! as_user "'$CLAUDE_BIN' auth status --json" 2>/dev/null | grep -q '"loggedIn": *true'; then
    printf '\n  claude is not logged in yet:\n'
    printf '      fleetwright login          (then: fleetwright code <value>)\n'
    printf '      or connect an account from the app, once this box has joined a fleet\n'
  fi

  # This box's own identity, printed because it is the thing to compare against
  # /hosts when something does not line up.
  if [ -n "$ENROL_URL" ]; then
    # Same trap as the pin above: this is a summary line, and a summary line
    # must not be able to end the install it is summarising.
    #
    # THE NAME COMES FROM THE SIDECAR, NOT THE ENV FILE. FLEETWRIGHT_HOST_ID is
    # blank on most boxes — the hostname is the default, and the coordinator may
    # have recorded a different name beside the key — so reading the env file
    # printed "This host:   fingerprint …" with nothing where the name goes.
    # `identity` resolves the name the same way the running sidecar does.
    IDENT="$(sidecar_cli identity 2>/dev/null || true)"
    FP="$(printf '%s\n' "$IDENT" | sed -n 's/^fingerprint  *//p')"
    HID="$(printf '%s\n' "$IDENT" | sed -n 's/^host id  *//p')"
    [ -n "$FP" ] && printf '\n  This host: %s  fingerprint %s\n' "$HID" "$FP"
  fi

  # The log is wherever this platform puts it: the journal, or the file the
  # plist names. A Mac told to run journalctl has been told nothing.
  FOLLOW_LOG="journalctl -u fleetwright -f"
  [ "$PLATFORM" = macos ] && FOLLOW_LOG="tail -f /var/log/fleetwright.log"
  cat <<EOF

  Drive it:
      fleetwright list
      $FOLLOW_LOG

  Config: $ENV_FILE
          $SIDECAR_ENV

EOF
elif [ "$UPGRADE" = 1 ] || [ "$HAD_PREVIOUS" = 1 ]; then
  # A BOX THAT WAS ALREADY SET UP GETS TOLD WHAT CHANGED, not what to set up.
  #
  # This branch is `WIZARD = no`, which is true of an unattended fresh install
  # AND of every --upgrade — and --upgrade is how a migration finishes. So a
  # machine that had been enrolled and running for weeks ended a successful
  # conversion by being told to create a Telegram bot, start the session
  # manager, and put an admin token in a file that already had one.
  #
  # Everything in that list was already done. Printing it reads like the
  # install wiped the configuration, which is the one thing somebody watching a
  # migration is afraid of.
  printf '\n  Nothing above was reconfigured — the answers already in the /etc files\n'
  printf '  were kept, and the services were restarted on the code below.\n\n'
  printf '  Running from : %s\n' "$DIR"
  if [ -L "$FLEET_BASE/current" ] && [ "$DIR" = "$FLEET_BASE/current" ]; then
    printf '  Release      : %s\n' "$(readlink "$FLEET_BASE/current")"
    printf '\n  This box now takes packaged releases. Updates are a download with a\n'
    printf '  checksum from here on, and `/update` from the app applies them.\n'
  fi
  printf '\n  Check it:\n'
  printf '      systemctl status fleetwright fleetwright-sidecar\n'
  printf '      fleetwright doctor\n\n'
else
  cat <<EOF

Next:

  1. Start the session manager:
       systemctl enable --now fleetwright
       journalctl -u fleetwright -f

  2. Check the box is ready:
       fleetwright doctor

  If claude is not logged in yet, run 'fleetwright login' and follow the link,
  or connect an account from the app once this box has joined a fleet.

  For the fleet: the coordinator is a Cloudflare Worker (docs/coordinator-deploy.md).
     Put its URL in $SIDECAR_ENV as FLEETWRIGHT_COORDINATOR_URL, then:
       systemctl enable --now fleetwright-sidecar
$( if [ "${ENROLLED:-0}" = 1 ]; then
     printf '     This box is enrolled — the pin that came with the command was spent.\n'
   else
     printf '     Hosts have no token. Mint a pin in the app and spend it on the box:\n'
     printf '       fleetwright-sidecar enrol <pin>\n'
     printf '     or re-run the one line the app shows, which carries the pin.\n'
   fi )

  Or re-run this installer with a terminal and it will ask instead — it
  enrols this box and starts the services for you.

EOF
fi

# --- 9. and then it stops being a checkout ----------------------------------
#
# THE THING THAT WAS MISSING, and it is why a box re-run through the one-liner
# stayed commit-based no matter which menu option somebody chose.
#
# bootstrap.sh USED TO clone the repository — it had to, because install.sh
# lived in it — so this script always ran from a checkout, PACKAGED was always
# 0, and every install the documented way produced a git working tree. "Clean"
# wiped the box and rebuilt exactly the same shape. #376 installed the
# migration helper and nothing ever called it, so the capability existed and no
# path reached it: true where it was written, quietly false one layer up.
#
# A fresh box now arrives here from a verified release, PACKAGED is 1, and this
# block is skipped: there is nothing to convert. It still runs for a checkout —
# `--from-source`, a box that already had one, a repository off GitHub — which
# is exactly the box that has a conversion to be offered.
#
# A CHECKOUT IS THE WRONG DEFAULT NOW. It needs the tree writable by the service
# user so `/update` can pull, it drifts (which is how a real box met
# `git checkout` refusing to overwrite sixty-eight files), and a pull is not
# verified against anything. A release is a tarball with a sha256 checked before
# it is unpacked, installed beside what is running, activated by a symlink.
#
# So: offer it, default yes, once the box is otherwise finished. Not earlier —
# the migration re-runs this script from the release to re-template the units,
# and running it against a half-configured box would be two installers
# interleaving.
if [ "$PACKAGED" = 0 ] && [ "$FROM_SOURCE" = 0 ] && [ "$CHECK_ONLY" != 1 ] && [ "$CONVERTED" = 0 ] \
   && [ -z "${FLEETWRIGHT_MIGRATING:-}" ] && [ -x /usr/local/sbin/fleetwright-migrate ] \
   && [ -n "$(get_env "$ENV_FILE" FLEETWRIGHT_RELEASE_MANIFEST)" ]; then
  say "Packaged releases"
  printf '  This box is a git checkout. On packaged releases an update is a\n'
  printf '  download with a checksum instead of a pull, installed beside what is\n'
  printf '  running and activated by a symlink — and the tree stops being\n'
  printf '  something that can drift.\n'
  printf '\n  What it does, so that it is not a surprise:\n'
  printf '    - installs the current release under %s\n' "${FLEETWRIGHT_BASE:-/opt/fleetwright}"
  printf '    - re-points the systemd units at it and RESTARTS the services\n'
  printf '    - leaves %s where it is, and leaves running sessions alone\n' "$DIR"
  printf '  Reversible: re-run this installer with --from-source.\n'

  # THE DEFAULT DEPENDS ON WHETHER THIS BOX WAS ALREADY DOING SOMETHING, and
  # that distinction is the whole answer to "are you sure?".
  #
  # A FRESH box has nothing to disturb — no sessions, no services anybody is
  # relying on — and packaged is the shape every install should end up in. Yes.
  #
  # A box that was ALREADY RUNNING is a different question. Moving where its
  # code lives and restarting its services is not a thing to discover having
  # happened because somebody leaned on the return key. That is the rule this
  # script already follows for the identity prompt, and the one the app follows
  # by refusing to migrate without an explicit apply. So: no, and it says how
  # to ask for it.
  if [ "$HAD_PREVIOUS" = 1 ]; then MIGRATE_DEFAULT=no; else MIGRATE_DEFAULT=yes; fi

  MIGRATE="$MIGRATE_DEFAULT"
  # NOBODY THERE MEANS NO, whichever kind of box this is. An unattended run must
  # not change the shape of a box nobody was asked about.
  if [ -z "$ASK_IN" ]; then
    MIGRATE=no
    printf '\n  Nobody to ask — leaving this box as a checkout.\n'
    printf '  Move it later from the app, or: sudo /usr/local/sbin/fleetwright-migrate\n'
  elif [ "$MIGRATE_DEFAULT" = no ]; then
    ask MIGRATE "This box is already running. Convert it now? [y/N]" no
  else
    ask MIGRATE "Set this box up on packaged releases? [Y/n]" yes
  fi

  # `""` is NOT in the yes list. `ask` already substitutes the default for an
  # empty answer, so accepting it here as well would make return mean yes on the
  # box where the default is deliberately no — which is precisely the keystroke
  # this is written to not act on.
  case "$MIGRATE" in
    y|Y|yes|YES)
      # Called directly rather than through sudo: this script is already root.
      # FLEETWRIGHT_MIGRATING stops the install.sh the helper execs from
      # arriving back here — it will be running from the release, where
      # PACKAGED is 1 and this block is skipped anyway, and belt and braces on
      # a loop that would be a fork bomb rather than a bug.
      # THE ONE IN THE TREE, NOT THE COPY IN /usr/local/sbin.
      #
      # That copy is a snapshot taken by whichever install ran last, and this
      # script is running as root out of a checkout that was updated seconds
      # ago. Running the snapshot means a fix to the helper does not take
      # effect until the run AFTER the one that installed it — which is exactly
      # what happened: a box re-ran the one-liner with the fix present in its
      # tree, and migrated with the previous helper.
      #
      # /usr/local/sbin is for the APP's path, where there is no checkout and a
      # narrow sudoers rule is the point. Here there is a tree, it is newer, and
      # nothing needs sudo because this is already root.
      HELPER=/usr/local/sbin/fleetwright-migrate
      [ -x "$DIR/install/fleetwright-migrate" ] && HELPER="$DIR/install/fleetwright-migrate"
      FLEETWRIGHT_MIGRATING=1 "$HELPER" \
        || warn "the migration did not finish — this box is still the checkout it was, and still works"
      ;;
    *) ok "staying a checkout" ;;
  esac
fi
