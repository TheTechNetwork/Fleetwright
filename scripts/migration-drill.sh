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
# A KNOWN STARTING STATE, because a scenario that inherits the last one's
# wreckage tests whatever happened rather than what it says it tests. The first
# runs of scenarios 12 and 13 did exactly that: they asserted against a box some
# earlier failure had left on the checkout, and reported it as the bug they were
# written to find.
reset_to_converted() {
  install_from_checkout >/dev/null 2>&1
  if ! convert; then cp "$WORK/migrate.log" "$WORK/reset.log" 2>/dev/null; return 1; fi
  grep -q "$BASE/current" /etc/systemd/system/agent-hub.service || return 1
  return 0
}
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
  [ -n "${DRILL_SERVER:-}" ] && kill "$DRILL_SERVER" 2>/dev/null
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
  cp "$WORK"/*.log "${DRILL_LOGS:-/tmp/fleetwright-drill-logs}/" 2>/dev/null || true
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

# SERVED OVER HTTP, not file://, and the difference is not cosmetic. The shell
# helper fetches with curl, which reads file:// happily; applyRelease — the JS
# half, which is what `/update` uses after a box is converted — fetches with
# node's `fetch`, which does not. A drill using file:// exercises one half of
# the update path and is silently unable to exercise the other.
#
# A local server on a loopback port is what a real box sees, minus the internet.
node -e '
  const http = require("http"), fs = require("fs"), path = require("path");
  const dir = process.argv[1];
  http.createServer((req, res) => {
    const f = path.join(dir, path.basename(req.url.split("?")[0]));
    fs.readFile(f, (e, b) => e ? (res.statusCode = 404, res.end("no")) : res.end(b));
  }).listen(0, "127.0.0.1", function () {
    fs.writeFileSync(process.argv[2], String(this.address().port));
  });
' "$DIST" "$WORK/port" &
DRILL_SERVER=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$WORK/port" ] && break; sleep 0.3; done
[ -s "$WORK/port" ] || { echo "could not start the release server"; exit 1; }
MANIFEST="http://127.0.0.1:$(cat "$WORK/port")/manifest.json"
ok "serving releases at $MANIFEST"

install_from_checkout() { # install_from_checkout [extra args...]
  AGENT_FLEET_BASE="$BASE" AGENT_HUB_NO_INSTALL_DEPS=1 \
    bash "$CHECKOUT/install/install.sh" --no-wizard "$@" >"$WORK/install.log" 2>&1
}

convert() {
  # SAY WHY IT COULD NOT EVEN START. A missing or unreadable helper produced an
  # empty log and a bare non-zero exit, which reads as "the migration failed"
  # and is a different problem entirely.
  [ -f "$CHECKOUT/install/fleetwright-migrate" ] \
    || { echo "no helper at $CHECKOUT/install/fleetwright-migrate" >"$WORK/migrate.log"; return 1; }
  [ -f /etc/agent-hub.env ] \
    || { echo "no /etc/agent-hub.env — nothing says where releases come from" >"$WORK/migrate.log"; return 1; }
  FLEETWRIGHT_ENV_FILE=/etc/agent-hub.env AGENT_FLEET_BASE="$BASE" \
    sh "$CHECKOUT/install/fleetwright-migrate" >"$WORK/migrate.log" 2>&1
}

# --- 0. can the box get the new code at all? --------------------------------
#
# THE SCENARIO THAT WAS MISSING, and the one that cost a host an afternoon.
# Everything below tests what happens once a box HAS the current installer. A
# box that cannot update its checkout never reaches any of it, and every "re-run
# and it will be fixed" is wrong for a reason no migration test can see.

step "0. an outdated checkout — can bootstrap bring it forward?"
ORIGIN="$WORK/origin"; SEED="$WORK/seed"
git init -q --bare "$ORIGIN"
git init -q "$SEED"
git -C "$SEED" config user.email drill@local; git -C "$SEED" config user.name drill
echo one > "$SEED/f"; git -C "$SEED" add -A; git -C "$SEED" commit -qm one
git -C "$SEED" branch -M main; git -C "$SEED" push -q "$ORIGIN" main
OLD_SHA="$(git -C "$SEED" rev-parse HEAD)"
echo two > "$SEED/f"; git -C "$SEED" commit -qam two; git -C "$SEED" push -q "$ORIGIN" main
NEW_SHA="$(git -C "$SEED" rev-parse HEAD)"

BOX="$WORK/outdated"
git clone -q "$ORIGIN" "$BOX"
git -C "$BOX" reset -q --hard "$OLD_SHA"
# The states a real box has been in: behind, with a stale tag shadowing the
# branch, and with local edits.
git -C "$BOX" tag -f main "$OLD_SHA" >/dev/null 2>&1
echo "local edit" >> "$BOX/f"

FLEETWRIGHT_REPO="$ORIGIN" FLEETWRIGHT_DIR="$BOX" FLEETWRIGHT_REF=main \
  sh -c 'set -eu
    DIR="$FLEETWRIGHT_DIR"; REF="$FLEETWRIGHT_REF"; REPO="$FLEETWRIGHT_REPO"
    git -C "$DIR" remote set-url origin "$REPO"
    if git -C "$DIR" rev-parse -q --verify "refs/tags/$REF" >/dev/null 2>&1; then
      git -C "$DIR" tag -d "$REF" >/dev/null 2>&1 || true
    fi
    git -C "$DIR" fetch --quiet --prune --prune-tags --force       origin "refs/heads/$REF:refs/remotes/origin/$REF" 2>/dev/null       || git -C "$DIR" fetch --quiet --force origin "refs/heads/$REF:refs/remotes/origin/$REF"
    git -C "$DIR" checkout --quiet -B "$REF" "origin/$REF" 2>/dev/null       || { git -C "$DIR" reset --quiet --hard "origin/$REF"; git -C "$DIR" checkout --quiet -B "$REF" "origin/$REF"; }
  ' >/dev/null 2>&1
if [ "$(git -C "$BOX" rev-parse HEAD)" = "$NEW_SHA" ]; then
  ok "an outdated checkout with a stale tag and local edits came forward"
else
  bad "the checkout did not update: $(git -C "$BOX" rev-parse --short HEAD), wanted ${NEW_SHA:0:7}"
fi
git -C "$BOX" rev-parse refs/tags/main >/dev/null 2>&1 && bad "the stale tag survived" || ok "the stale tag was pruned"

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

# --- 7. the update a converted box takes next -------------------------------
#
# THE POINT OF CONVERTING, and nothing had ever run it. `releaseLayout` refused
# a running box's own path for as long as packaging existed — the check compared
# against `current` while a service reports the resolved release directory — so
# updating by manifest could not work on any machine, and no test noticed
# because every fixture named `current` directly.

step "7. update — a converted box takes a newer release"
install_from_checkout   # back to a known state, then convert again
convert >/dev/null 2>&1
BEFORE="$(readlink "$BASE/current")"

# A second release, published at the same address.
RELEASE_OUT_DIR="$DIST" RELEASE_VERSION=v-drill-2 node "$ROOT/tools/build-host-package.mjs" >/dev/null 2>&1
NEWEST="$(node -e "console.log(require('$DIST/manifest.json').version)")"
[ "$NEWEST" = v-drill-2 ] && ok "published $NEWEST at the same manifest URL" || bad "the second release did not build"

# What a running service would report as its own root: the RESOLVED path, not
# the symlink. This is the exact input that used to be refused.
RESOLVED="$(readlink -f "$BASE/current")"
if AGENT_HUB_RELEASE_MANIFEST="$MANIFEST" node -e "
  import('$ROOT/src/core/release-apply.js').then(async ({ applyRelease }) => {
    const r = await applyRelease({
      installDir: '$RESOLVED',
      manifestUrl: '$MANIFEST',
      protocol: $(node -e "import('$ROOT/src/fleet/protocol/intents.js').then(m=>console.log(m.PROTOCOL_VERSION))"),
    });
    if (!r.ok) { console.error(r.message); process.exit(1); }
  });
" >"$WORK/update.log" 2>&1; then
  ok "the update applied from the path a running service reports"
else
  bad "the update was refused"; sed 's/^/       /' "$WORK/update.log" | head -3
fi

AFTER="$(readlink "$BASE/current")"
[ "$AFTER" != "$BEFORE" ] && ok "current moved to $(basename "$AFTER")" || bad "current did not move"
[ -d "$BASE/releases/$(basename "$BEFORE")" ] && ok "the previous release is still there to roll back to" \
  || bad "the rollback target was pruned"
starts "after update"

# --- 8. a rollback ----------------------------------------------------------

step "8. rollback — point current at the release before"
ln -sfn "$BASE/releases/$(basename "$BEFORE")" "$BASE/.current.new"
mv -Tf "$BASE/.current.new" "$BASE/current"
starts "after rollback"
[ "$(readlink "$BASE/current")" = "$BEFORE" ] && ok "back on $(basename "$BEFORE")" || bad "the rollback did not take"

# --- 9. a release that does not match its manifest --------------------------
#
# The digest is the whole integrity claim. A drill that only ever feeds it
# correct tarballs is not testing it.

step "9. tampering — a tarball that does not match its sha256"
# FROM A NOT-YET-CONVERTED BOX. The helper answers "already on the packaged
# layout" first, and would never reach the digest — a fixture that skips the
# check it is testing passes for the wrong reason.
install_from_checkout --from-source
# BOTH ARTIFACTS BACKED UP, not just the manifest. Restoring one of the two
# left a corrupt tarball on the server for every scenario that followed — each
# of which then correctly refused it, and reported that as its own failure. The
# digest check was working the entire time; the fixture was the bug.
cp "$DIST/manifest.json" "$WORK/manifest.good"
for t in "$DIST"/*.tar.gz; do cp "$t" "$WORK/$(basename "$t").good"; done
printf 'tampered' >> "$DIST"/*.tar.gz
GUARD_BEFORE="$(readlink "$BASE/current")"
if convert >/dev/null 2>&1; then
  bad "a tampered release was accepted"
else
  grep -q "does not match its manifest" "$WORK/migrate.log" && ok "refused, naming the digest" \
    || { bad "refused for the wrong reason"; tail -2 "$WORK/migrate.log" | sed 's/^/       /'; }
fi
[ "$(readlink "$BASE/current")" = "$GUARD_BEFORE" ] && ok "nothing was switched over" || bad "current moved anyway"
starts "after a refused release"
cp "$WORK/manifest.good" "$DIST/manifest.json"
for g in "$WORK"/*.tar.gz.good; do cp "$g" "$DIST/$(basename "$g" .good)"; done

# --- 10. a converted box whose release is gone ------------------------------
#
# THE STATE deb13-staging WAS ACTUALLY IN, and the one every path agreed to
# leave alone. An earlier installer deleted the directory it was running out of
# (#388) and left `current` dangling. After that:
#
#   the units pointed at a release that did not exist
#   unit_entry fell back to a bin/ that did not exist either
#   the conversion was not offered, because the box looked converted
#   and the service restarted six thousand times
#
# Every line of the installer said ok.

step "10. a converted box whose release directory is gone"
install_from_checkout >/dev/null 2>&1
convert >/dev/null 2>&1
GONE="$(readlink -f "$BASE/current")"
# NEVER DELETE ANYTHING THAT IS NOT A RELEASE. `current` points at the checkout
# on a box that has been reverted, and `rm -rf $(readlink -f current)` would
# then delete the checkout — the drill destroying its own fixture, and on a real
# box the thing that is the way back.
case "$GONE" in
  "$BASE/releases/"*) rm -rf "$GONE" ;;
  *) bad "refusing to delete $GONE — that is not a release directory"; GONE="" ;;
esac
[ -e "$BASE/current" ] && bad "the fixture did not break the symlink" || ok "reproduced: current dangles, nothing behind it"

install_from_checkout
TARGET="$(sed -n 's/^ExecStart=[^ ]* \([^ ]*\).*/\1/p' /etc/systemd/system/agent-hub.service | head -1)"
[ -f "$TARGET" ] && ok "the unit names something that exists: $(basename "$TARGET")" \
  || bad "the unit still names a missing file: $TARGET"
starts "after healing a missing release"

# --- 11. a box systemd has given up on ---------------------------------------
#
# THE REASON A REPAIRED BOX STAYED BROKEN. Once StartLimitBurst is hit systemd
# answers "Start request repeated too quickly" and refuses to start the unit at
# all — so a box that has been crash-looping cannot be healed by ANY installer,
# however correct the unit it writes. deb13-staging reached restart counter
# 6423, and every re-run reported `ok agent-hub running`.

step "11. rate-limited — systemd has stopped trying"
install_from_checkout >/dev/null 2>&1
# Break it the way a bad release does, then let systemd give up.
BROKEN="$WORK/broken-entry.mjs"
printf '#!/bin/sh\n# not javascript\n' > "$BROKEN"
sed -i "s|^ExecStart=.*|ExecStart=$(command -v node) $BROKEN serve|" /etc/systemd/system/agent-hub.service
systemctl daemon-reload
systemctl restart agent-hub >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8; do systemctl start agent-hub >/dev/null 2>&1; done
sleep 1
if systemctl status agent-hub 2>&1 | grep -q "repeated too quickly" \
   || [ "$(systemctl show -p NRestarts --value agent-hub 2>/dev/null || echo 0)" -gt 0 ]; then
  ok "reproduced: systemd is refusing to start it"
else
  ok "systemd did not rate-limit here; the repair below is still the assertion"
fi

# THE INSTALLER MUST CLEAR THE FAILURE AND BRING IT BACK — on its own. The
# assertion deliberately does not restart anything itself, because that would
# be the drill doing the healing it is supposed to be testing.
install_from_checkout --upgrade
sleep 1
if [ "$(systemctl is-active agent-hub)" = active ]; then
  ok "the installer cleared the failure and started it"
else
  bad "the installer left it dead"
  journalctl -u agent-hub -n 4 --no-pager 2>/dev/null | sed 's/^/       /'
fi

# --- 12. a release whose unit TEMPLATES predate the fix ----------------------
#
# THE ONE EVERY OTHER SCENARIO MISSED, because they all build the release from
# the code under test — so its templates are always current, and the bug cannot
# appear.
#
# install_unit read `$DIR/install/<name>.service`, and $DIR is the PAYLOAD. A
# box pointing its units at a release therefore read THAT RELEASE's template.
# v0.2.3's predates __ENTRY__ and hardcodes `__DIR__/bin/agent-hub`, so the
# substitution found nothing to replace and every repair wrote the same broken
# unit — on a box whose installer had been correct for hours.

step "12. an old release, whose unit template hardcodes bin/"
# A PRECONDITION, ASSERTED. Earlier scenarios leave the box on the checkout, and
# a fixture that quietly starts from the wrong state tests nothing while
# reporting a pass — which is the failure mode this whole drill exists to avoid.
if reset_to_converted; then ok "precondition: the box is converted"
else bad "precondition: could not get to a converted box"; tail -3 "$WORK/reset.log" | sed 's/^/       /'; fi
REL="$(readlink -f "$BASE/current")"
# Exactly what v0.2.3 ships.
printf 'ExecStart=__NODE__ __DIR__/bin/agent-hub serve\n' > "$REL/install/agent-hub.service"
printf '#!/bin/sh\n# Shipped by an old release.\nexec node "$(dirname "$0")/../lib/agent-hub.mjs" "$@"\n' > "$REL/bin/agent-hub"
grep -q '__ENTRY__' "$REL/install/agent-hub.service" && bad "the fixture did not take" \
  || ok "reproduced: the release's template hardcodes bin/"

install_from_checkout
TARGET="$(sed -n 's/^ExecStart=[^ ]* \([^ ]*\).*/\1/p' /etc/systemd/system/agent-hub.service | head -1)"
case "$TARGET" in
  */lib/agent-hub.mjs) ok "the unit names the module, from this installer's template" ;;
  *) bad "the old template won: $TARGET" ;;
esac
starts "after an old release's template"

# --- 13. a partial release ---------------------------------------------------
#
# THE DIRECTORY IS THERE AND THE PAYLOAD IS NOT. A real box reached this:
# `current` resolves, `releases/<version>/` exists, and lib/ is missing —
# an unpack that died, or a tree somebody half-removed.
#
# It is a nastier shape than scenario 10 (the release GONE) because every cheap
# check passes. The symlink resolves. The directory exists. Only opening the
# file it is supposed to run says otherwise, and nothing did.

step "13. a converted box whose release has no payload"
if reset_to_converted; then ok "precondition: the box is converted"
else bad "precondition: could not get to a converted box"; tail -3 "$WORK/reset.log" | sed 's/^/       /'; fi

REL="$(readlink -f "$BASE/current")"
case "$REL" in
  "$BASE"/releases/*) rm -rf "${REL:?}/lib" ;;
  *) bad "current does not point into the release tree: $REL" ;;
esac
[ -d "$REL" ] && [ ! -e "$REL/lib/agent-hub.mjs" ] \
  && ok "reproduced: the release directory is there, the payload is not" \
  || bad "the fixture did not take"

install_from_checkout
# THE BOX MUST END UP RUNNING SOMETHING. Which of the two remedies it picks is
# not the assertion — putting it back on the checkout and re-laying the release
# are both correct answers. Leaving the units pointed at an empty directory is
# not, and that is what happened.
TARGET="$(sed -n 's/^ExecStart=[^ ]* \([^ ]*\).*/\1/p' /etc/systemd/system/agent-hub.service | head -1)"
if [ -f "$TARGET" ]; then ok "the unit names something that exists: $TARGET"
else bad "the unit names $TARGET, which is not there"; fi
starts "after a partial release"

step "Result"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ] || exit 1
