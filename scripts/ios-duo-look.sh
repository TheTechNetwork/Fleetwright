#!/usr/bin/env bash
# The app on the iPhone Duo simulator, as pictures a person can look at.
#
#   ./scripts/ios-duo-look.sh            # into apps/ios/build/duo-look
#
# WHY IT EXISTS. CI compiling the Duo layout says the Swift is valid, not that
# the split view, the tab sidebar and the vertical bars land where
# docs/watch-and-duo.md says they do. This is the cheapest evidence that they
# do: the demo fleet, launched on the Duo, one picture per tab. It is not a
# test and asserts nothing about the pictures; it fails only when there is no
# picture to look at.
#
# NOT THE STORE SCREENSHOTS. ios-screenshots.sh makes those, and App Store
# Connect did not accept the Duo's display types when the device shipped, so a
# Duo directory there would be an upload that fails.
#
# BOTH DISPLAYS, EVERY TIME. The Duo simulator has two, and `simctl io
# screenshot` refuses to guess between them, so each picture is taken once per
# display the simulator lists, named by its pixel size: 2007x2853 is the inner
# display unfolded, 1398x2034 the outer one. Whichever the simulator booted
# into shows the app; the other shows what that display does meanwhile. simctl
# has no verb to fold or rotate, so the other poses are still a person in
# Simulator.
#
# SKIPS, LOUDLY, WITHOUT A DUO. The image's simulators change without a commit,
# and a missing device is the image's news, not this change's failure.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${DUO_LOOK_DIR:-$ROOT/apps/ios/build/duo-look}"
APP_NAME=Fleetwright
BUNDLE_ID=network.thetech.fleetwright
TABS=(sessions machines you)

UDID="$(xcrun simctl list devices available --json | python3 -c "
import json,sys
ds=[d for rt,v in json.load(sys.stdin)['devices'].items() if 'iOS' in rt for d in v if d['name']=='iPhone Duo']
print(ds[-1]['udid'] if ds else '')
")"
if [ -z "$UDID" ]; then
  echo "::warning::no iPhone Duo simulator on this runner, so no pictures of it"
  xcrun simctl list devices available | grep -i iphone || true
  exit 0
fi

DERIVED="$(mktemp -d)"
trap 'rm -rf "$DERIVED"' EXIT
xcodebuild build \
  -project "$ROOT/apps/ios/$APP_NAME.xcodeproj" \
  -scheme "$APP_NAME" \
  -sdk iphonesimulator \
  -destination "id=$UDID" \
  -configuration Debug \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO \
  >/dev/null
APP="$DERIVED/Build/Products/Debug-iphonesimulator/$APP_NAME.app"
[ -d "$APP" ] || { echo "::error::no app at $APP"; exit 1; }

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl status_bar "$UDID" override --time "09:41" --batteryState charged --batteryLevel 100
xcrun simctl install "$UDID" "$APP"

# The displays, as simctl names them. It lists them only in the refusal to
# pick one, so that refusal is the listing: "--display=3  LCD-1 ... 2007x2853".
DISPLAYS="$(xcrun simctl io "$UDID" screenshot /dev/null 2>&1 \
  | sed -nE 's/.*--display=([0-9]+).* ([0-9]+x[0-9]+).*/\1:\2/p' || true)"
[ -n "$DISPLAYS" ] || DISPLAYS="default:"

mkdir -p "$OUT"
for tab in "${TABS[@]}"; do
  xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
  xcrun simctl launch "$UDID" "$BUNDLE_ID" -fleetwright-demo -fleetwright-tab "$tab" >/dev/null
  # The demo fleet answers from constants, so this is the time to draw, not
  # to fetch.
  sleep 4
  for d in $DISPLAYS; do
    id="${d%%:*}" size="${d#*:}"
    if [ "$id" = default ]; then
      xcrun simctl io "$UDID" screenshot "$OUT/duo-$tab.png" >/dev/null
    else
      # A display that is off may refuse; that is news about the pose, not a
      # failure, and the other display's picture still stands.
      xcrun simctl io "$UDID" screenshot --display="$id" "$OUT/duo-$tab-$size.png" >/dev/null \
        || echo "::warning::display $id ($size) gave no picture of $tab"
    fi
  done
done

ls "$OUT"/*.png >/dev/null 2>&1 || { echo "::error::the Duo gave no pictures at all"; exit 1; }
echo "iPhone Duo pictures in $OUT, one per tab per display (2007x2853 inner, unfolded; 1398x2034 outer):"
ls "$OUT"
