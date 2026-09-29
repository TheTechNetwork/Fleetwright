#!/usr/bin/env bash
# Take this box back out of a fleet.
#
#   sudo /opt/fleetwright/current/install/uninstall.sh          services, config, identity
#   sudo /opt/fleetwright/current/install/uninstall.sh --purge  the above plus the code
#   sudo /opt/fleetwright/current/install/uninstall.sh --yes    do not ask
#
# (On a checkout install the script lives under /opt/fleetwright-src/install/ and
# --purge removes that checkout instead.)
#
# WHY THIS EXISTS, beyond tidiness.
#
# A cloned VM is the case that needs it. Cloning a box that has been installed
# copies /var/lib/fleetwright-sidecar/host-key.json, and that file IS this machine's
# identity in the fleet — "whoever can read it can be this machine, and nothing
# else can". Two boxes with the same key are one host as far as the coordinator
# is concerned, and they will take turns holding the socket, each disconnecting
# the other, for ever.
#
# So the identity is removed by default here, not left behind as a convenience.
#
# WHAT IT DELIBERATELY DOES NOT TOUCH:
#
#   ~/fleetwright-runs   the workspaces sessions ran in. That is work, not config.
#   tmux sessions  running sessions are left alone; stopping the services does
#                  not kill them, which is the whole point of KillMode=process.
#   node, tmux,    installed as dependencies, but something else on the box may
#   podman, claude want them now.
set -euo pipefail

PURGE=0
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help)
      printf 'usage: uninstall.sh [--purge] [--yes]\n\n'
      printf '  --purge  also remove the code: every release under /opt/fleetwright, or the checkout\n'
      printf '  --yes    do not ask for confirmation\n\n'
      printf 'Leaves ~/fleetwright-runs, running tmux sessions, and node/tmux/podman/claude alone.\n'
      exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
warn() { printf '  warn %s\n' "$*"; }
die()  { printf '\n  FAIL %s\n\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run this with sudo — it removes files in /etc, /var/lib and /usr/local/bin"

PLATFORM=linux
case "$(uname -s 2>/dev/null || echo unknown)" in
  Darwin) PLATFORM=macos ;;
  Linux) PLATFORM=linux ;;
esac

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# WHAT --purge REMOVES depends on which shape this box is, and "the directory
# this script is in" was the wrong answer for one of them. On a packaged box
# this script lives at /opt/fleetwright/current/install/, so $DIR is the
# `current` symlink — and `rm -rf` on a symlink removes the link, leaving every
# release under /opt/fleetwright exactly where it was. A purge that removed a
# pointer and called the code gone.
#
# A release tree is told apart the way install.sh tells it: lib/fleetwright.mjs
# exists in a release and not in a checkout. The base is the one install.sh
# uses, so the two agree without either reading the other.
FLEET_BASE="${FLEETWRIGHT_BASE:-/opt/fleetwright}"
PACKAGED=0
if [ -f "$DIR/lib/fleetwright.mjs" ]; then PACKAGED=1; fi
if [ "$PACKAGED" = 1 ]; then PURGE_DIR="$FLEET_BASE"; else PURGE_DIR="$DIR"; fi
RUN_USER="${FLEETWRIGHT_USER:-${SUDO_USER:-root}}"
# The sidecar's own account, which install.sh makes with its home at its state
# directory. That home is how this script tells an account it made from one
# somebody else did, so that only the former is removed.
SIDECAR_USER="${FLEETWRIGHT_SIDECAR_USER:-fleetwright-sidecar}"
# The old names too: a box can be uninstalled without ever having been migrated
# off agent-hub, and a service left running under its old name is still a host
# in somebody's fleet. src/fleet/legacy-names.js has the whole list.
SERVICES=(fleetwright fleetwright-sidecar fleetwright-coordinator agent-hub agent-fleet-sidecar agent-fleet-coordinator)

# --- what is actually here, before anything is removed ----------------------
# Shown first, because "uninstall" on a box that turns out to be a different
# box than you thought is not a recoverable mistake. The fingerprint is the
# part worth reading: it is what the coordinator knows this machine as.
say "About to remove"
printf '  host     %s\n' "$(hostname 2>/dev/null || echo unknown)"
if [ -f /var/lib/fleetwright-sidecar/host-key.json ] || [ -f /var/lib/agent-fleet/host-key.json ]; then
  # As whichever account can read the key: the sidecar's since #270, the
  # session user's on a box installed before it.
  FP="$( { sudo -u "$SIDECAR_USER" "$DIR/bin/fleetwright-sidecar" identity 2>/dev/null \
          || sudo -u "$RUN_USER" "$DIR/bin/fleetwright-sidecar" identity 2>/dev/null; } | awk '/fingerprint/ {print $2}' || true)"
  printf '  identity %s\n' "${FP:-present, could not read fingerprint}"
  printf '           THIS IS THE FLEET IDENTITY. Removing it means this box\n'
  printf '           gets a new one and must be enrolled again — and if this\n'
  printf '           machine is a CLONE, the original still holds the same key.\n'
else
  printf '  identity none\n'
fi
for f in /etc/fleetwright.env /etc/fleetwright-sidecar.env /etc/fleetwright-coordinator.env \
         /etc/agent-hub.env /etc/agent-fleet-sidecar.env /etc/agent-fleet-coordinator.env; do
  [ -f "$f" ] && [ ! -L "$f" ] && printf '  config   %s\n' "$f"
done
[ "$PURGE" = 1 ] && printf '  code     %s (--purge)\n' "$PURGE_DIR"
printf '\n  Left alone: ~%s/fleetwright-runs, running tmux sessions, node/tmux/podman/claude.\n' "$RUN_USER"

if [ "$ASSUME_YES" != 1 ]; then
  printf '\n  Type the hostname to confirm: '
  read -r ANSWER || ANSWER=''
  [ "$ANSWER" = "$(hostname 2>/dev/null)" ] || die "that is not this host's name — nothing was changed"
fi

# --- services ---------------------------------------------------------------
say "Stopping services"
for s in "${SERVICES[@]}"; do
  if [ "$PLATFORM" = macos ]; then
    launchctl bootout "system/network.thetech.$s" >/dev/null 2>&1 \
      && ok "$s stopped" || true
    rm -f "/Library/LaunchDaemons/network.thetech.$s.plist" && ok "removed the $s daemon" || true
  else
    systemctl disable --now "$s" >/dev/null 2>&1 && ok "$s stopped and disabled" || true
    rm -f "/etc/systemd/system/$s.service"
  fi
done
# The commit-confirm watchdog is a timer, not one of the SERVICES above, and it
# is Linux-only. Left behind, it would keep firing against a box that no longer
# has a release layout to revert to.
if [ "$PLATFORM" = linux ]; then
  systemctl disable --now fleetwright-confirm.timer >/dev/null 2>&1 && ok "commit-confirm watchdog stopped and disabled" || true
  systemctl disable --now agent-fleet-confirm.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/fleetwright-confirm.timer /etc/systemd/system/fleetwright-confirm.service \
        /etc/systemd/system/agent-fleet-confirm.timer /etc/systemd/system/agent-fleet-confirm.service
  # The two oneshots the system-updates grant names. Its sudoers rule goes
  # below; the units it permitted starting stayed, and a purged package left
  # them in /etc/systemd/system naming an apt run nobody had asked for.
  rm -f /etc/systemd/system/fleetwright-upgrade.service /etc/systemd/system/fleetwright-apt-update.service \
        /etc/systemd/system/agent-hub-upgrade.service /etc/systemd/system/agent-hub-apt-update.service
fi
[ "$PLATFORM" = linux ] && { systemctl daemon-reload >/dev/null 2>&1 || true; }
ok "service definitions removed"

# --- the identity, and everything that names it -----------------------------
say "Removing identity and state"
# The key first and by name, so that a failure anywhere after this cannot leave
# a box holding an identity it is no longer configured to use.
for key in /var/lib/fleetwright-sidecar/host-key.json /var/lib/agent-fleet/host-key.json; do
  if [ -f "$key" ] && [ ! -L "$key" ]; then
    rm -f "$key"
    ok "host key removed — this box is no longer any machine in any fleet"
  fi
done
for d in /var/lib/fleetwright-sidecar /var/lib/fleetwright /var/lib/fleetwright-coordinator \
         /var/lib/agent-fleet /var/lib/agent-hub /var/lib/agent-fleet-coordinator; do
  # A symlink left by the rename goes as a link; its target is in this list too.
  if [ -L "$d" ]; then rm -f "$d"; ok "$d"; continue; fi
  [ -d "$d" ] && { rm -rf "${d:?}"; ok "$d"; }
done
rm -rf /run/fleetwright-sidecar 2>/dev/null || true

# The sidecar's account, if the installer made it: a system account whose home
# is the state directory just removed. One with any other home was somebody's
# and stays.
if [ "$PLATFORM" = linux ] && id "$SIDECAR_USER" >/dev/null 2>&1; then
  home="$(getent passwd "$SIDECAR_USER" 2>/dev/null | cut -d: -f6 || true)"
  if [ "$home" = /var/lib/fleetwright-sidecar ]; then
    if userdel "$SIDECAR_USER" >/dev/null 2>&1 || deluser "$SIDECAR_USER" >/dev/null 2>&1; then
      ok "removed the $SIDECAR_USER account"
    else
      warn "could not remove the $SIDECAR_USER account — userdel $SIDECAR_USER"
    fi
  else
    ok "left the $SIDECAR_USER account alone — its home is $home, so the installer did not make it"
  fi
fi

say "Removing configuration"
for f in /etc/fleetwright.env /etc/fleetwright-sidecar.env /etc/fleetwright-coordinator.env \
         /etc/agent-hub.env /etc/agent-fleet-sidecar.env /etc/agent-fleet-coordinator.env; do
  [ -L "$f" ] && { rm -f "$f"; ok "$f"; continue; }
  [ -f "$f" ] && { rm -f "$f"; ok "$f"; }
done
for f in /etc/sudoers.d/agent-hub-upgrade /etc/sudoers.d/agent-hub-reboot /etc/sudoers.d/agent-hub-migrate /etc/sudoers.d/agent-hub-reclaim; do
  [ -f "$f" ] && { rm -f "$f"; ok "$f"; }
done
for f in /etc/sudoers.d/fleetwright-upgrade /etc/sudoers.d/fleetwright-reboot /etc/sudoers.d/fleetwright-migrate /etc/sudoers.d/fleetwright-reclaim; do
  [ -f "$f" ] && { rm -f "$f"; ok "$f"; }
done
# THE ROOT HELPER GOES WITH ITS RULE. It is the one thing the installer puts
# outside the tree on purpose — root-owned, in /usr/local/sbin, so the service
# user cannot rewrite what it is allowed to run as root — which is exactly why
# purging the tree never reached it. Left behind, a box that is out of the
# fleet still carries a root-capable script named by a rule that is gone.
if [ -f /usr/local/sbin/fleetwright-migrate ]; then
  rm -f /usr/local/sbin/fleetwright-migrate
  ok "/usr/local/sbin/fleetwright-migrate"
fi
if [ -f /usr/local/sbin/fleetwright-confirm ]; then
  rm -f /usr/local/sbin/fleetwright-confirm
  ok "/usr/local/sbin/fleetwright-confirm"
fi
if [ -f /usr/local/sbin/fleetwright-reclaim ]; then
  rm -f /usr/local/sbin/fleetwright-reclaim
  ok "/usr/local/sbin/fleetwright-reclaim"
fi

say "Removing the CLIs"
for c in fleetwright fleetwright-sidecar fleetwright-coordinator fw agent-hub agent-fleet-sidecar agent-fleet-coordinator; do
  [ -L "/usr/local/bin/$c" ] || [ -f "/usr/local/bin/$c" ] && { rm -f "/usr/local/bin/$c"; ok "/usr/local/bin/$c"; }
done

# --- the SessionStart hook --------------------------------------------------
# Left behind, this points Claude Code at a command that no longer exists, and
# every new session starts by failing to run it.
say "Removing the Claude Code hook"
USER_HOME="$(eval printf '%s' "~$RUN_USER" 2>/dev/null || printf '%s' "/home/$RUN_USER")"
SETTINGS="$USER_HOME/.claude/settings.json"
if [ -f "$SETTINGS" ] && command -v node >/dev/null; then
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    let s;
    try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch { process.exit(0); }
    const before = JSON.stringify(s.hooks ?? {});
    for (const event of Object.keys(s.hooks ?? {})) {
      s.hooks[event] = (s.hooks[event] ?? []).filter((entry) =>
        !JSON.stringify(entry).includes("fleetwright"));
      if (!s.hooks[event].length) delete s.hooks[event];
    }
    if (JSON.stringify(s.hooks ?? {}) === before) process.exit(0);
    // Written through a temp file and renamed, because a half-written
    // settings.json is a Claude Code that will not start at all.
    const tmp = f + ".tmp-fleetwright-uninstall";
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
    fs.renameSync(tmp, f);
    console.log("  ok   removed the SessionStart hook from " + f);
  ' "$SETTINGS" || warn "could not edit $SETTINGS — remove the fleetwright SessionStart hook by hand"
else
  ok "no settings.json to edit"
fi

if [ "$PURGE" = 1 ]; then
  say "Removing the code"
  # cd out first: removing the directory this script is being read from works on
  # Linux but leaves the shell somewhere that no longer exists. bash has the
  # script open, so the file going away under it does not stop it finishing.
  cd /
  rm -rf "${PURGE_DIR:?}"
  ok "$PURGE_DIR"
fi

say "Removed."
printf '  This box is out of the fleet. If it was enrolled, the coordinator still\n'
printf '  lists it — remove it there too:\n\n'
printf '      curl -sX DELETE -H "Authorization: Bearer $TOKEN" \\\n'
printf '           https://YOUR-COORDINATOR/api/hosts/%s\n\n' "$(hostname 2>/dev/null || echo HOSTID)"
[ "$PURGE" != 1 ] && printf '  The code at %s was kept. Re-run install.sh to set this box up again.\n\n' "$PURGE_DIR"
