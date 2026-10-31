#!/usr/bin/env bash
# The app on the iPhone Duo simulator, as pictures a person can look at.
#
#   ./scripts/ios-duo-look.sh            # into apps/ios/build/duo-look
#   HINGE=/path/to/hinge ./scripts/ios-duo-look.sh
#
# WHY IT EXISTS. The pictures the store will want: Apple's screenshot
# specification lists the Duo's four sizes, which are the ones taken here, and
# requires Duo screenshots from April 2027 for any app on the iOS 27.1 SDK or
# later. The App Store Connect API had no display type for them on 31 October
# 2026, so ios.yml takes them at each full release and attaches them (the
# `duo-pictures` job), and they become an upload, a display type in
# ios-screenshots.sh, when the type exists. Until then they are the demo
# fleet, launched on the Duo, each tab in each pose, for a person to look at;
# this is not a test and asserts nothing about the pictures, failing only when
# there is no picture to look at. They were taken on every pull request push
# before, half of each build job's time, and the person who looks has the
# device, so they are not any more.
#
# NOT THE STORE SCREENSHOTS, YET. ios-screenshots.sh makes those, keyed on the
# API's display types, and a Duo directory there would be an upload that fails
# until the API names one.
#
# THE POSES NEED `hinge`. The simulator boots closed and simctl has no verb to
# open it, so the first run of this script photographed a black inner display.
# hinge (github.com/artemnovichkov/hinge, MIT) sets the angle and orientation
# from the command line; ios.yml fetches it at a pinned commit and passes it as
# HINGE. Without it, this takes the closed pose alone and says so.
#
# THE DISPLAY THE APP IS ON. The Duo simulator has two, and `simctl io
# screenshot` fails with "Invalid argument" unless it is told which: LCD is the
# cover, LCD-1 the inner display. Each pose names the one it is about. With
# hinge, `hinge screenshot` captures whichever display hosts the UI, waits for
# its backlight, and says which one it took; a picture of the other display is
# thrown away rather than filed under this pose's name, because the simulator
# sometimes stops following the hinge while still reporting the new angle, and
# a picture named "open" that shows the cover is a claim this run cannot back.
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

# Each pose: a name, the hinge angle, the orientation, and the display it shows.
POSES=("closed:0:portrait:LCD")
if [ -n "$HINGE" ]; then
  # 0.3.0 is the first with `screenshot` and `--json`; ios.yml pins it, and an
  # older one on PATH would fail on the first picture, so say so up front.
  if ! "$HINGE" -h 2>/dev/null | grep -qE '^ +screenshot '; then
    echo "::error::$HINGE is older than hinge 0.3.0 and cannot take the pictures; ios.yml pins the version"
    exit 1
  fi
  POSES+=("open:180:portrait:LCD-1" "open-landscape:180:landscape-left:LCD-1")
else
  echo "::warning::no hinge tool, so only the closed pose; the open display needs it"
fi

# THE SIMULATOR DOES NOT ALWAYS FOLLOW THE HINGE. `hinge set` waits two
# seconds for the angle and fails when it is not reached ("the hinge angle
# did not reach 180.0 within 2.0 s"), and on the hosted Macs that has
# happened on one run and not the next with the same code; under `set -e` it
# failed the whole build job for want of a picture. A pose is asked for three
# times, and a pose the simulator will not take is skipped with a warning,
# the way a picture of the wrong display is dropped below: the pictures are
# evidence, and a build is not judged by whether the Duo opened today.
pose_set() {
  local try
  for try in 1 2 3; do
    if "$HINGE" -d "$UDID" orient portrait && "$HINGE" -d "$UDID" set "$angle" && "$HINGE" -d "$UDID" orient "$orient"; then
      return 0
    fi
    sleep 3
  done
  return 1
}

mkdir -p "$OUT"
first=1
for pose in "${POSES[@]}"; do
  IFS=: read -r name angle orient display <<<"$pose"
  if [ -n "$HINGE" ] && ! pose_set; then
    echo "::warning::no pictures of the $name pose: the simulator did not reach hinge angle $angle in three tries"
    continue
  fi
  for tab in "${TABS[@]}"; do
    xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
    xcrun simctl launch "$UDID" "$BUNDLE_ID" -fleetwright-demo -fleetwright-tab "$tab" >/dev/null
    # LONG ENOUGH FOR THE DEMO FLEET TO ANSWER. It is a real coordinator over
    # the network, and the first launch on a cold simulator also pays for the
    # app starting at all: four seconds photographed "No machines are
    # reporting" before the answer came. The store script waits six.
    if [ "$first" = 1 ]; then sleep 20; first=0; else sleep 8; fi
    shot="$OUT/duo-$name-$tab.png"
    if [ -n "$HINGE" ]; then
      if ! took="$("$HINGE" -d "$UDID" screenshot --json "$shot" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["display"])')"; then
        echo "::warning::no picture of $tab, $name"
      elif [ "$took" != "$display" ]; then
        rm -f "$shot"
        echo "::warning::no picture of $tab, $name: the UI was on $took, not $display, so the simulator did not follow the hinge"
      fi
    else
      xcrun simctl io "$UDID" screenshot --display="$display" "$shot" >/dev/null \
        || echo "::warning::no picture of $tab, $name"
    fi
  done
done
if [ -n "$HINGE" ]; then "$HINGE" -d "$UDID" orient portrait || true; fi

ls "$OUT"/*.png >/dev/null 2>&1 || { echo "::error::the Duo gave no pictures at all"; exit 1; }
echo "iPhone Duo pictures in $OUT, one per tab per pose:"
ls "$OUT"
