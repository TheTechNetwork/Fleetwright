#!/usr/bin/env bash
# The app on the iPhone Duo simulator, as pictures a person can look at.
#
#   ./scripts/ios-duo-look.sh            # into apps/ios/build/duo-look
#   HINGE=/path/to/hinge ./scripts/ios-duo-look.sh
#
# WHY IT EXISTS. CI compiling the Duo layout says the Swift is valid, not that
# the split view, the tab sidebar and the vertical bars land where
# docs/watch-and-duo.md says they do. This is the cheapest evidence that they
# do: the demo fleet, launched on the Duo, each tab in each pose. It is not a
# test and asserts nothing about the pictures; it fails only when there is no
# picture to look at.
#
# NOT THE STORE SCREENSHOTS. ios-screenshots.sh makes those, and App Store
# Connect did not accept the Duo's display types when the device shipped, so a
# Duo directory there would be an upload that fails.
#
# THE POSES NEED `hinge`. The simulator boots closed and simctl has no verb to
# open it, so the first run of this script photographed a black inner display.
# hinge (github.com/artemnovichkov/hinge, MIT) sets the angle and orientation
# from the command line; ios.yml fetches it at a pinned commit and passes it as
# HINGE. Without it, this takes the closed pose alone and says so.
#
# THE DISPLAY THE APP IS ON. The Duo simulator has two, and `simctl io
# screenshot` will not choose; each pose names the one it is about, matched by
# pixel size: 1398x2034 is the outer display, 2007x2853 the inner one in
# portrait, 2853x2007 in landscape.
#
# SKIPS, LOUDLY, WITHOUT A DUO. The image's simulators change without a commit,
# and a missing device is the image's news, not this change's failure.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${DUO_LOOK_DIR:-$ROOT/apps/ios/build/duo-look}"
APP_NAME=Fleetwright
BUNDLE_ID=network.thetech.fleetwright
HINGE="${HINGE:-$(command -v hinge || true)}"
# Screenshots.tab's names, which are not the tabs' titles: Machines is "fleet"
# and You is "settings", from before the tabs were renamed.
TABS=(sessions fleet settings)

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

# The displays, as simctl names them. It lists them only in its refusal to pick
# one, so that refusal is the listing: "--display=3  LCD-1 ... 2007x2853".
DISPLAYS="$(xcrun simctl io "$UDID" screenshot /dev/null 2>&1 \
  | sed -nE 's/.*--display=([0-9]+).* ([0-9]+x[0-9]+).*/\1:\2/p' || true)"

# The simctl display id for a size, either way round, or empty.
display_for() {
  local want="$1" flipped d
  flipped="${want#*x}x${want%x*}"
  for d in $DISPLAYS; do
    case "${d#*:}" in "$want"|"$flipped") echo "${d%%:*}"; return ;; esac
  done
}

# Each pose: a name, the hinge angle, the orientation, and the display it shows.
POSES=("closed:0:portrait:1398x2034")
if [ -n "$HINGE" ]; then
  POSES+=("open:180:portrait:2007x2853" "open-landscape:180:landscape-left:2007x2853")
else
  echo "::warning::no hinge tool, so only the closed pose; the open display needs it"
fi

mkdir -p "$OUT"
first=1
for pose in "${POSES[@]}"; do
  IFS=: read -r name angle orient size <<<"$pose"
  if [ -n "$HINGE" ]; then
    "$HINGE" -d "$UDID" orient portrait
    "$HINGE" -d "$UDID" set "$angle"
    "$HINGE" -d "$UDID" orient "$orient"
  fi
  display="$(display_for "$size")"
  for tab in "${TABS[@]}"; do
    xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
    xcrun simctl launch "$UDID" "$BUNDLE_ID" -fleetwright-demo -fleetwright-tab "$tab" >/dev/null
    # LONG ENOUGH FOR THE DEMO FLEET TO ANSWER. It is a real coordinator over
    # the network, and the first launch on a cold simulator also pays for the
    # app starting at all: four seconds photographed "No machines are
    # reporting" before the answer came. The store script waits six.
    if [ "$first" = 1 ]; then sleep 20; first=0; else sleep 8; fi
    shot="$OUT/duo-$name-$tab.png"
    if [ -n "$display" ]; then
      xcrun simctl io "$UDID" screenshot --display="$display" "$shot" >/dev/null \
        || echo "::warning::no picture of $tab, $name"
    else
      xcrun simctl io "$UDID" screenshot "$shot" >/dev/null \
        || echo "::warning::no picture of $tab, $name"
    fi
  done
done
if [ -n "$HINGE" ]; then "$HINGE" -d "$UDID" orient portrait || true; fi

ls "$OUT"/*.png >/dev/null 2>&1 || { echo "::error::the Duo gave no pictures at all"; exit 1; }
echo "iPhone Duo pictures in $OUT, one per tab per pose:"
ls "$OUT"
