#!/usr/bin/env bash
# Every state a host can be in, walked for real.
#
# WHY THIS IS A SCRIPT AND NOT A TEST. It writes /etc/systemd units, starts
# services and asks systemd whether they came up — which is the one question
# that mattered in every failure this path has had, and the one thing a test
# running on a shared machine must not do. It is destructive by design: it
# installs, converts, breaks and cleans up after itself.
#
# Run it on a machine you are willing to have agent-hub installed on.
#
#   sudo ./scripts/migration-drill.sh
#
# THE SCENARIOS ARE THE STATES REAL BOXES HAVE BEEN IN. Each one here is a
# failure that reached a production host today, kept as a fixture:
#
#   fresh          nothing installed
#   convert        a checkout box moved onto packaged releases
#   rerun          the one-liner run again on a converted box   (it reverted)
#   stale-unit     converted, carrying a unit from before units named the
#                  module                                        (deb13-staging)
#   half           a release laid out, symlink moved, units not  (vnic-runner)
#   from-source    a converted box asked to go back
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${DRILL_WORK:-/tmp/fleetwright-drill}"
BASE="$WORK/opt/fleetwright"
CHECKOUT="$WORK/opt/agent-fleet"
DIST="$WORK/dist"

PASS=0; FAIL=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "needs root: it writes /etc/systemd/system"; exit 1; }
[ -d /run/systemd/system ] || { echo "needs systemd as pid 1 — this asks it to start things"; exit 1; }

# NOTHING OF SOMEBODY ELSE'S. A box with a real install is not a drill ground.
for f in /etc/systemd/system/agent-hub.service /etc/agent-hub.env /var/lib/agent-hub; do
  [ -e "$f" ] && { echo "refusing: $f exists — this machine has an install on it"; exit 1; }
done

cleanup() {
  step "Cleaning up"
  for u in agent-hub agent-fleet-sidecar agent-fleet-coordinator; do
    systemctl disable --now "$u" >/dev/null 2>&1
    rm -f "/etc/systemd/system/$u.service"
  done
  systemctl daemon-reload >/dev/null 2>&1
  rm -rf /etc/agent-hub.env /etc/agent-fleet-sidecar.env /etc/agent-fleet-coordinator.env \
         /var/lib/agent-hub /var/lib/agent-fleet /var/lib/agent-fleet-coordinator \
         /usr/local/bin/agent-hub /usr/local/bin/agent-fleet-sidecar \
         /usr/local/bin/agent-fleet-coordinator /usr/local/sbin/fleetwright-migrate \
         /etc/sudoers.d/agent-hub-upgrade /etc/sudoers.d/agent-hub-reboot \
         /etc/sudoers.d/agent-hub-migrate
  # The logs outlive the drill: a failure you cannot read afterwards is a
  # failure you get to reproduce.
  mkdir -p "${DRILL_LOGS:-/tmp/fleetwright-drill-logs}"
  cp "$WORK"/*.log "${DRILL_LOGS:-/tmp/fleetwright-drill-logs}/" 2>/dev/null
  rm -rf "$WORK"
  echo "  logs in ${DRILL_LOGS:-/tmp/fleetwright-drill-logs}"
  echo "  removed everything this drill created"
}
trap cleanup EXIT

# --- the assertions ---------------------------------------------------------

unit_names() { grep -o 'ExecStart=.*' /etc/systemd/system/agent-hub.service | head -1; }

starts() { # starts WHAT — the only question that has ever mattered here
  systemctl daemon-reload
  systemctl restart agent-hub >/dev/null 2>&1
  sleep 2
  if [ "$(systemctl is-active agent-hub)" = active ]; then
    ok "$1: agent-hub is active"
  else
    bad "$1: agent-hub did not start"
    journalctl -u agent-hub -n 6 --no-pager 2>/dev/null | sed 's/^/       /'
  fi
}

points_at() { # points_at DESCRIPTION SUBSTRING
  if unit_names | grep -q "$2"; then ok "$1"; else bad "$1 — unit says: $(unit_names)"; fi
}

# --- the release this drill installs ----------------------------------------

step "Building a release"
rm -rf "$WORK"; mkdir -p "$CHECKOUT" "$DIST"
cp -a "$ROOT"/. "$CHECKOUT"/ 2>/dev/null
rm -rf "$CHECKOUT/node_modules/.cache"
# A checkout is a checkout because it has .git — previous_install and the
# migration helper both ask.
[ -d "$CHECKOUT/.git" ] || mkdir -p "$CHECKOUT/.git"

RELEASE_OUT_DIR="$DIST" RELEASE_VERSION=v-drill node "$ROOT/tools/build-host-package.mjs" >/dev/null \
  || { echo "could not build a release"; exit 1; }
ok "built $(basename "$(ls "$DIST"/*.tar.gz)")"

# Served over file://, so the drill needs no network and no publishing.
MANIFEST="file://$DIST/manifest.json"

install_from_checkout() { # install_from_checkout [extra args...]
  AGENT_FLEET_BASE="$BASE" AGENT_HUB_NO_INSTALL_DEPS=1 \
    bash "$CHECKOUT/install/install.sh" --no-wizard "$@" >"$WORK/install.log" 2>&1
}

convert() {
  FLEETWRIGHT_ENV_FILE=/etc/agent-hub.env AGENT_FLEET_BASE="$BASE" \
    sh "$CHECKOUT/install/fleetwright-migrate" >"$WORK/migrate.log" 2>&1
}

# --- 1. a fresh box ---------------------------------------------------------

step "1. fresh box — nothing installed"
install_from_checkout
points_at "units name the checkout" "$CHECKOUT/bin/agent-hub"
starts "fresh"

# The installer has to have recorded where releases come from, or nothing below
# can happen. On a real box it derives this from the git remote; here there is
# none, so it is set the way the installer would have.
sed -i '/AGENT_HUB_RELEASE_MANIFEST/d' /etc/agent-hub.env
# A LEADING NEWLINE, because the template does not end in one and an appended
# line would otherwise be glued to the last — `...0AGENT_HUB_RELEASE_MANIFEST=`,
# which `sed -n 's/^KEY=//p'` does not match. The drill's first run failed on
# exactly that and blamed the migration.
{ printf '\n'; printf 'AGENT_HUB_RELEASE_MANIFEST=%s\n' "$MANIFEST"; printf 'AGENT_HUB_INSTALL_DIR=%s\n' "$CHECKOUT"; } >> /etc/agent-hub.env
grep -q '^AGENT_HUB_RELEASE_MANIFEST=' /etc/agent-hub.env || { echo "the drill could not record the manifest URL"; exit 1; }

# AN ENROLLED BOX, because that is what converts. `--upgrade` refuses a machine
# that was never in a fleet — correctly, since enrolling needs a pin somebody
# mints — and every box this drill is about has been in one for weeks.
mkdir -p /var/lib/agent-fleet
printf '{"kty":"EC","crv":"P-256","d":"drill","x":"drill","y":"drill"}\n' > /var/lib/agent-fleet/host-key.json
chmod 600 /var/lib/agent-fleet/host-key.json

# --- 2. convert it ----------------------------------------------------------

step "2. convert — a checkout box moves onto packaged releases"
if convert; then ok "the migration finished"; else
  RC=$?
  bad "the migration exited $RC"
  tail -6 "$WORK/migrate.log" | sed 's/^/       /'
fi
points_at "units name the release, by module" "$BASE/current/lib/agent-hub.mjs"
[ -L "$BASE/current" ] && ok "current points at $(basename "$(readlink "$BASE/current")")" || bad "no current symlink"
starts "converted"

# --- 3. the one-liner, run again --------------------------------------------

step "3. rerun — the one-liner on a converted box"
install_from_checkout
points_at "units still name the release" "$BASE/current/lib/agent-hub.mjs"
grep -q "$CHECKOUT/bin" /etc/systemd/system/agent-hub.service && bad "it reverted to the checkout" || ok "it did not revert"
starts "after rerun"

# --- 4. the state deb13-staging was in --------------------------------------

step "4. stale unit — converted, carrying a unit from before units named the module"
# Exactly what that box had: a unit naming bin/, against a release whose bin/ is
# the shell shim v0.2.3 shipped.
printf '#!/bin/sh\n# Shipped by fleetwright-host-v-drill.\nexec node "$(dirname "$(readlink -f "$0")")/../lib/agent-hub.mjs" "$@"\n' \
  > "$BASE/current/bin/agent-hub"
sed -i "s|current/lib/agent-hub.mjs|current/bin/agent-hub|" /etc/systemd/system/agent-hub.service
systemctl daemon-reload
systemctl restart agent-hub >/dev/null 2>&1; sleep 1
[ "$(systemctl is-active agent-hub)" = active ] && bad "the broken unit started, so this fixture proves nothing" \
  || ok "reproduced: the box is in a restart loop"
install_from_checkout
points_at "the unit was repaired" "$BASE/current/lib/agent-hub.mjs"
starts "after repair"

# --- 5. a half-finished migration -------------------------------------------

step "5. half — a release laid out and the symlink moved, units left behind"
# A REAL half-migration: the units genuinely written for the checkout, with the
# release still laid out and `current` still pointing at it. Editing one line of
# the unit by hand would leave WorkingDirectory naming the release, which is not
# a state any box reaches.
install_from_checkout --from-source
[ -L "$BASE/current" ] || bad "the fixture lost the release symlink"
systemctl daemon-reload
if convert; then ok "it resumed rather than reporting nothing to do"; else bad "the resume failed"; tail -4 "$WORK/migrate.log" | sed 's/^/       /'; fi
grep -q "nothing to do" "$WORK/migrate.log" && bad "it claimed there was nothing to do" || ok "it did not claim success without acting"
points_at "units name the release again" "$BASE/current/lib/agent-hub.mjs"
starts "after resume"

# --- 6. going back ----------------------------------------------------------

step "6. from-source — a converted box asked to return to the checkout"
install_from_checkout --from-source
points_at "units name the checkout again" "$CHECKOUT/bin/agent-hub"
starts "after --from-source"

step "Result"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ] || exit 1
