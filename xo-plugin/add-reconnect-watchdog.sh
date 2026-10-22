#!/usr/bin/env bash
# Add Fleetwright's reconnect watchdog to a Xen Orchestra that was installed
# without it. docs/hypervisors.md, "When Xen Orchestra loses a pool".
#
# A Xen Orchestra Fleetwright installs has it already. This is for one built
# from source some other way, or by a Fleetwright older than the watchdog. It
# runs as root ON THE XEN ORCHESTRA MACHINE, from a copy of this directory:
#
#   scp -r xo-plugin root@<xen orchestra>:/root/
#   ssh root@<xen orchestra> bash /root/xo-plugin/add-reconnect-watchdog.sh
#
# WHAT IT DOES, and nothing else:
#   1. copies the plugin into the running build, beside xo-server's own
#      plugins, where xo-server looks for them when it starts;
#   2. where Xen Orchestra was installed by XenOrchestraInstallerUpdater with
#      bundled plugins (Fleetwright's fork of it), puts the plugin beside the
#      installer and names it in xo-install.cfg, so every later update builds
#      it in too. With an installer that has no bundled plugins, an update
#      replaces the build and the watchdog has to be added again; it says so;
#   3. restarts xo-server. Xen Orchestra connects every enabled server as it
#      starts, so a pool it had lost comes back with the restart.
#
# It has no settings, so xo-server loads it the first time it sees it.
#
#   --xo-server DIR   xo-server's directory (default: what /opt/xo/xo-server points to)
#   --installer DIR   the installer's directory (default: /opt/xo-installer, if it is there)
#   --no-restart      leave xo-server running; the watchdog starts at its next start

set -euo pipefail

NAME=xo-server-fleetwright-reconnect
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PLUGIN="$HERE/$NAME"
XO_SERVER=""
INSTALLER=""
RESTART=true

fail() {
    echo "Not added: $*" >&2
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --xo-server) XO_SERVER="${2:-}"; shift 2 ;;
        --installer) INSTALLER="${2:-}"; shift 2 ;;
        --no-restart) RESTART=false; shift ;;
        -h | --help) sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) fail "$1 is not an option this script takes. --help lists them." ;;
    esac
done

[[ $EUID -eq 0 ]] || fail "it changes xo-server's files and restarts it, so it runs as root."
[[ -f "$PLUGIN/package.json" && -f "$PLUGIN/index.js" ]] || fail "the plugin is not beside this script, in $PLUGIN. Copy the whole xo-plugin directory."

if [[ -z "$INSTALLER" && -f /opt/xo-installer/xo-install.cfg ]]; then INSTALLER=/opt/xo-installer; fi
if [[ -z "$XO_SERVER" ]]; then
    # The installer's own INSTALLDIR, where it says one; /opt/xo is its default.
    installdir=/opt/xo
    if [[ -n "$INSTALLER" ]]; then
        found=$(bash -c 'source "$1" >/dev/null 2>&1; printf %s "${INSTALLDIR:-}"' bash "$INSTALLER/xo-install.cfg" || true)
        [[ -n "$found" ]] && installdir=$found
    fi
    XO_SERVER=$(readlink -f "$installdir/xo-server" || true)
fi
[[ -n "$XO_SERVER" && -f "$XO_SERVER/package.json" ]] || fail "no xo-server was found. Name its directory with --xo-server."
grep -q '"name": *"xo-server"' "$XO_SERVER/package.json" || fail "$XO_SERVER is not xo-server's directory. Name it with --xo-server."
[[ -d "$XO_SERVER/node_modules" ]] || fail "$XO_SERVER has no node_modules, so it is not a built xo-server."

# 1. INTO THE RUNNING BUILD. A directory of its own rather than a link, so it
# does not depend on this copy staying where it is.
target="$XO_SERVER/node_modules/$NAME"
rm -rf "$target"
cp -r "$PLUGIN" "$target"
echo "Added to $XO_SERVER."

# 2. INTO EVERY LATER BUILD, where the installer builds bundled plugins in.
if [[ -n "$INSTALLER" ]]; then
    cfg="$INSTALLER/xo-install.cfg"
    if [[ -f "$INSTALLER/xo-install.sh" ]] && grep -q 'BUNDLED_PLUGINS' "$INSTALLER/xo-install.sh"; then
        mkdir -p "$INSTALLER/plugins"
        rm -rf "${INSTALLER:?}/plugins/$NAME"
        cp -r "$PLUGIN" "$INSTALLER/plugins/$NAME"
        named=$(bash -c 'source "$1" >/dev/null 2>&1; printf %s "${BUNDLED_PLUGINS:-none}"' bash "$cfg" || true)
        case ",$named," in
            *",$NAME,"*) echo "$cfg already names it, so updates keep it." ;;
            *)
                # APPENDED, AND WRITTEN TO ADD ITSELF to whatever the file says
                # above it: a list a person kept is kept.
                cat >>"$cfg" <<EOF

# Added by Fleetwright's add-reconnect-watchdog.sh: the reconnect watchdog, in every build.
case ",\${BUNDLED_PLUGINS:-none}," in *",$NAME,"*) ;; ",none,") BUNDLED_PLUGINS="$NAME" ;; *) BUNDLED_PLUGINS="\$BUNDLED_PLUGINS,$NAME" ;; esac
EOF
                named=$(bash -c 'source "$1" >/dev/null 2>&1; printf %s "${BUNDLED_PLUGINS:-none}"' bash "$cfg" || true)
                case ",$named," in
                    *",$NAME,"*) echo "Named in $cfg, so updates keep it." ;;
                    *) echo "Warning: $cfg still does not name it after the line added at its end, so the next update leaves it out. Add $NAME to BUNDLED_PLUGINS there." >&2 ;;
                esac
                ;;
        esac
    else
        echo "Warning: the installer in $INSTALLER does not build bundled plugins in, so the next update leaves the watchdog out. Run this again after updating." >&2
    fi
else
    echo "Warning: no installer was found, so an update that replaces this build leaves the watchdog out. Run this again after updating." >&2
fi

# 3. STARTED.
if $RESTART; then
    if systemctl cat xo-server.service >/dev/null 2>&1; then
        systemctl restart xo-server.service
        echo "xo-server restarted with the watchdog. It reconnects every enabled server as it starts."
    else
        echo "Warning: there is no xo-server service to restart. The watchdog starts with xo-server next time." >&2
    fi
else
    echo "xo-server was left running. The watchdog starts with it next time."
fi
