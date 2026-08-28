#!/usr/bin/env bash
# Take this box back out of a fleet.
#
#   sudo /opt/agent-fleet/install/uninstall.sh            services, config, identity
#   sudo /opt/agent-fleet/install/uninstall.sh --purge     the above plus /opt/agent-fleet
#   sudo /opt/agent-fleet/install/uninstall.sh --yes       do not ask
#
# WHY THIS EXISTS, beyond tidiness.
#
# A cloned VM is the case that needs it. Cloning a box that has been installed
# copies /var/lib/agent-fleet/host-key.json, and that file IS this machine's
# identity in the fleet — "whoever can read it can be this machine, and nothing
# else can". Two boxes with the same key are one host as far as the coordinator
# is concerned, and they will take turns holding the socket, each disconnecting
# the other, for ever.
#
# So the identity is removed by default here, not left behind as a convenience.
#
# WHAT IT DELIBERATELY DOES NOT TOUCH:
#
#   ~/agent-runs   the workspaces sessions ran in. That is work, not config.
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
      printf '  --purge  also remove /opt/agent-fleet\n'
      printf '  --yes    do not ask for confirmation\n\n'
      printf 'Leaves ~/agent-runs, running tmux sessions, and node/tmux/podman/claude alone.\n'
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
RUN_USER="${AGENT_HUB_USER:-${SUDO_USER:-root}}"
SERVICES=(agent-hub agent-fleet-sidecar agent-fleet-coordinator)

# --- what is actually here, before anything is removed ----------------------
# Shown first, because "uninstall" on a box that turns out to be a different
# box than you thought is not a recoverable mistake. The fingerprint is the
# part worth reading: it is what the coordinator knows this machine as.
say "About to remove"
printf '  host     %s\n' "$(hostname 2>/dev/null || echo unknown)"
if [ -f /var/lib/agent-fleet/host-key.json ]; then
  FP="$(sudo -u "$RUN_USER" "$DIR/bin/agent-fleet-sidecar" identity 2>/dev/null | awk '/fingerprint/ {print $2}' || true)"
  printf '  identity %s\n' "${FP:-present, could not read fingerprint}"
  printf '           THIS IS THE FLEET IDENTITY. Removing it means this box\n'
  printf '           gets a new one and must be enrolled again — and if this\n'
  printf '           machine is a CLONE, the original still holds the same key.\n'
else
  printf '  identity none\n'
fi
for f in /etc/agent-hub.env /etc/agent-fleet-sidecar.env /etc/agent-fleet-coordinator.env; do
  [ -f "$f" ] && printf '  config   %s\n' "$f"
done
[ "$PURGE" = 1 ] && printf '  source   %s (--purge)\n' "$DIR"
printf '\n  Left alone: ~%s/agent-runs, running tmux sessions, node/tmux/podman/claude.\n' "$RUN_USER"

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
[ "$PLATFORM" = linux ] && { systemctl daemon-reload >/dev/null 2>&1 || true; }
ok "service definitions removed"

# --- the identity, and everything that names it -----------------------------
say "Removing identity and state"
# The key first and by name, so that a failure anywhere after this cannot leave
# a box holding an identity it is no longer configured to use.
if [ -f /var/lib/agent-fleet/host-key.json ]; then
  rm -f /var/lib/agent-fleet/host-key.json
  ok "host key removed — this box is no longer any machine in any fleet"
fi
for d in /var/lib/agent-fleet /var/lib/agent-hub /var/lib/agent-fleet-coordinator; do
  [ -d "$d" ] && { rm -rf "${d:?}"; ok "$d"; }
done
rm -rf /run/agent-fleet 2>/dev/null || true

say "Removing configuration"
for f in /etc/agent-hub.env /etc/agent-fleet-sidecar.env /etc/agent-fleet-coordinator.env; do
  [ -f "$f" ] && { rm -f "$f"; ok "$f"; }
done
for f in /etc/sudoers.d/agent-hub-upgrade /etc/sudoers.d/agent-hub-reboot; do
  [ -f "$f" ] && { rm -f "$f"; ok "$f"; }
done

say "Removing the CLIs"
for c in agent-hub agent-fleet-sidecar agent-fleet-coordinator; do
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
        !JSON.stringify(entry).includes("agent-hub"));
      if (!s.hooks[event].length) delete s.hooks[event];
    }
    if (JSON.stringify(s.hooks ?? {}) === before) process.exit(0);
    // Written through a temp file and renamed, because a half-written
    // settings.json is a Claude Code that will not start at all.
    const tmp = f + ".tmp-agent-hub-uninstall";
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
    fs.renameSync(tmp, f);
    console.log("  ok   removed the SessionStart hook from " + f);
  ' "$SETTINGS" || warn "could not edit $SETTINGS — remove the agent-hub SessionStart hook by hand"
else
  ok "no settings.json to edit"
fi

if [ "$PURGE" = 1 ]; then
  say "Removing the source"
  # cd out first: removing the directory this script is being read from works on
  # Linux but leaves the shell somewhere that no longer exists.
  cd /
  rm -rf "${DIR:?}"
  ok "$DIR"
fi

say "Removed."
printf '  This box is out of the fleet. If it was enrolled, the coordinator still\n'
printf '  lists it — remove it there too:\n\n'
printf '      curl -sX DELETE -H "Authorization: Bearer $TOKEN" \\\n'
printf '           https://YOUR-COORDINATOR/api/hosts/%s\n\n' "$(hostname 2>/dev/null || echo HOSTID)"
[ "$PURGE" != 1 ] && printf '  The checkout at %s was kept. Re-run install.sh to set this box up again.\n\n' "$DIR"
