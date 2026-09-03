#!/bin/sh
# The one thing install.sh refuses to do: a new-enough Node.
#
#   curl -fsSL https://fleet.thetech.network/prereq | sudo sh
#
# WHY THIS IS A SEPARATE COMMAND. install.sh installs git, tmux and podman
# itself, on the argument that reporting a missing dependency makes the operator
# do the work twice. Node is where that argument stops: Debian 13 ships 20, this
# needs 24, and closing that gap means adding a THIRD-PARTY APT REPOSITORY AND
# SIGNING KEY to somebody's machine.
#
# That is a different kind of act from `apt-get install nodejs`, and it is not
# one an installer gets to make on your behalf halfway through doing something
# else. So it is its own line, which you either type or do not.
#
# install.sh refuses before it changes anything if Node is too old, and points
# here. Running this is the answer; so is installing Node any other way — nvm,
# fnm, a distro backport — and then running install.sh normally.

set -eu

FLOOR=24

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
warn() { printf '  --   %s\n' "$*"; }
die()  { printf '\n  FAIL %s\n\n' "$*" >&2; exit 1; }

say "Fleetwright prerequisites"

[ "$(id -u)" = 0 ] || die "run this with sudo — it installs system packages:
       curl -fsSL https://fleet.thetech.network/prereq | sudo sh"

# ALREADY FINE IS THE COMMON CASE, and it must be a no-op rather than a
# reinstall. A box with Node 26 from nvm does not want a system Node 24 landing
# on top of it, and this script is run by people following instructions who will
# not check first.
current=""
if command -v node >/dev/null 2>&1; then
  current="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
fi
case "$current" in
  ''|*[!0-9]*) current=0 ;;
esac
if [ "$current" -ge "$FLOOR" ]; then
  ok "node $(node -v) is already new enough — nothing to do"
  printf '\n  Next:\n      curl -fsSL https://fleet.thetech.network/install | sudo sh\n\n'
  exit 0
fi

if [ "$current" -gt 0 ]; then
  warn "node $current is installed and is older than $FLOOR"
else
  warn "node is not installed"
fi

command -v curl >/dev/null 2>&1 || die "curl is needed to fetch the Node repository, and is not installed."

if ! command -v apt-get >/dev/null 2>&1; then
  die "this box does not use apt, so there is nothing here I can do safely.
       Install Node $FLOOR or newer however this distribution does it, then:
           curl -fsSL https://fleet.thetech.network/install | sudo sh
       Or point the installer at a node it cannot see:
           sudo AGENT_HUB_NODE_BIN=\$(command -v node) /opt/agent-fleet/install/install.sh"
fi

# SAID OUT LOUD, BEFORE IT HAPPENS. This is the entire reason the step is
# separate, so hiding it behind a progress line would defeat the point of
# splitting it out.
printf '\n  This adds the NodeSource apt repository and its signing key to this box,\n'
printf '  then installs Node %s from it. That is a third-party source of system\n' "$FLOOR"
printf '  packages, and it stays configured afterwards.\n\n'

say "Adding the NodeSource repository"
curl -fsSL "https://deb.nodesource.com/setup_${FLOOR}.x" | bash - >/dev/null 2>&1 \
  || die "NodeSource's setup script failed. Install Node $FLOOR another way and re-run the installer."

say "Installing node"
apt-get install -y -qq nodejs >/dev/null 2>&1 || die "apt could not install nodejs from NodeSource."

command -v node >/dev/null 2>&1 || die "node still is not on PATH after installing it."
now="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$now" -ge "$FLOOR" ] || die "installed node $now, which is still older than $FLOOR."
ok "node $(node -v)"

printf '\n  Next:\n      curl -fsSL https://fleet.thetech.network/install | sudo sh\n\n'
