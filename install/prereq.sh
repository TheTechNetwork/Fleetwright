#!/bin/sh
# The one thing install.sh refuses to do: a new-enough Node.
#
#   curl -fsSL https://fleet.thetech.network/prereq | sudo sh
#
# WHY THIS IS A SEPARATE COMMAND. install.sh installs git, tmux and podman
# itself, on the argument that reporting a missing dependency makes the operator
# do the work twice. Node is where that argument stops: Debian 13 ships 20, this
# needs 24, and closing that gap means changing how the machine gets software.
# That is not a decision an installer makes on your behalf halfway through doing
# something else, so it is its own line, which you either type or do not.
#
# NVM RATHER THAN NODESOURCE, and the reason is the same one that made this a
# separate command in the first place.
#
# NodeSource means adding a third-party APT REPOSITORY AND SIGNING KEY, which
# stays configured forever and can replace the distribution's own nodejs
# package. It buys automatic security updates through apt, which is a real
# advantage and the only one — and it is not worth permanently changing where a
# machine gets its system software.
#
# nvm is one directory in one user's home. It is removed with `rm -rf ~/.nvm`,
# it changes nothing system-wide, and it cannot conflict with anything the
# distribution ships. The service units bake an ABSOLUTE node path
# (`ExecStart=__NODE__ …`), and install.sh's find_node already looks in
# ~/.nvm/versions/node/*/bin/node and takes the newest — so no shell
# integration, no PATH, nothing to source.
#
# WHAT IT COSTS: nothing patches it. Re-run this to move to a newer Node; that
# is the trade, and it is stated rather than discovered.
#
# INSTALLED AS THE RUN USER, NOT ROOT. nvm is per-user, and root's home is 0700
# — a node in /root/.nvm is unreadable by the service, which runs as somebody
# else. This is the whole reason the script needs to know who that is.

set -eu

FLOOR=24

# PINNED, AND KEPT PINNED BY RENOVATE. An unpinned installer URL is a build that
# changes without a commit — the objection this repository already makes about
# dependency ranges, applied to a shell script that runs as root. The comment
# below is what Renovate matches on; see customManagers in renovate.json.
#
# renovate: datasource=github-releases depName=nvm-sh/nvm
NVM_RELEASE=v0.40.7

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
warn() { printf '  --   %s\n' "$*"; }
die()  { printf '\n  FAIL %s\n\n' "$*" >&2; exit 1; }

say "Fleetwright prerequisites"

# WHO THE SERVICES WILL RUN AS. install.sh derives this the same way; here it is
# SUDO_USER, because `curl … | sudo sh` is the documented way to arrive and that
# is the one variable which survives it.
RUN_USER="${AGENT_HUB_USER:-${SUDO_USER:-}}"
if [ -z "$RUN_USER" ] || [ "$RUN_USER" = root ]; then
  die "cannot tell which user the fleet will run as.
       Run this with sudo from that user's shell, or name them:
           curl -fsSL https://fleet.thetech.network/prereq | sudo AGENT_HUB_USER=someone sh"
fi
USER_HOME="$(getent passwd "$RUN_USER" 2>/dev/null | cut -d: -f6)"
[ -n "$USER_HOME" ] && [ -d "$USER_HOME" ] || die "$RUN_USER has no home directory to install into."

# ALREADY FINE IS THE COMMON CASE, and it must be a no-op rather than a
# reinstall. This gets run by people following instructions who will not check
# first, and a box that already has a new Node does not want a second one.
#
# Looks where install.sh looks, so the two agree about what counts.
existing=""
for candidate in "$(command -v node 2>/dev/null || true)" \
                 "$(ls -1d "$USER_HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  major="$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  case "$major" in ''|*[!0-9]*) major=0 ;; esac
  if [ "$major" -ge "$FLOOR" ]; then existing="$candidate"; break; fi
done
if [ -n "$existing" ]; then
  ok "node $("$existing" -v) at $existing is already new enough — nothing to do"
  printf '\n  Next:\n      curl -fsSL https://fleet.thetech.network/install | sudo sh\n\n'
  exit 0
fi

[ "$(id -u)" = 0 ] || die "run this with sudo — it installs into $RUN_USER's home:
       curl -fsSL https://fleet.thetech.network/prereq | sudo sh"
command -v curl >/dev/null 2>&1 || die "curl is needed to fetch nvm, and is not installed."

# SAID OUT LOUD, BEFORE IT HAPPENS. This is the entire reason the step is
# separate, so hiding it behind a progress line would defeat the point.
printf '\n  This installs nvm and Node %s into %s, as %s.\n' "$FLOOR" "$USER_HOME/.nvm" "$RUN_USER"
printf '  Nothing system-wide changes: no apt repository, no signing key, and the\n'
printf '  distribution'"'"'s own node is left exactly as it is. Undo it with\n'
printf '      rm -rf %s/.nvm\n' "$USER_HOME"
printf '  Nothing patches it afterwards — re-run this to move to a newer Node.\n\n'

as_user() { su - "$RUN_USER" -c "$1"; }

say "Installing nvm $NVM_RELEASE"
as_user "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_RELEASE/install.sh | PROFILE=/dev/null bash" \
  >/dev/null 2>&1 || die "nvm's installer failed. Install Node $FLOOR another way and re-run the installer."

say "Installing node $FLOOR"
# PROFILE=/dev/null above, and sourcing nvm.sh directly here: this must not edit
# anybody's .bashrc. The service finds node by absolute path, so shell
# integration buys nothing and changing a login shell somebody else uses is a
# side effect nobody asked for.
as_user ". \"\$HOME/.nvm/nvm.sh\" && nvm install $FLOOR" >/dev/null 2>&1 \
  || die "nvm could not install Node $FLOOR."

installed="$(ls -1d "$USER_HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
[ -n "$installed" ] && [ -x "$installed" ] || die "nvm reported success but there is no node under $USER_HOME/.nvm."
now="$("$installed" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$now" -ge "$FLOOR" ] || die "installed node $now, which is still older than $FLOOR."
ok "node $("$installed" -v) at $installed"

printf '\n  install.sh finds this on its own — the units use an absolute path.\n'
printf '\n  Next:\n      curl -fsSL https://fleet.thetech.network/install | sudo sh\n\n'
