#!/usr/bin/env bash
# Store screenshots, taken by a script rather than by a person with a file
# picker.
#
#   ./scripts/ios-screenshots.sh
#
# WHAT IT PRODUCES: apps/ios/store/screenshots/<APPLE_DISPLAY_TYPE>/*.png,
# which is exactly what tools/appstore-screenshots.mjs uploads — the directory
# name IS the display type, so adding a size is a line in DEVICES below.
#
# COMMITTED, NOT GENERATED AT RELEASE TIME, and that is the same argument this
# repository makes about the listing copy: what the store shows should be
# reviewable in a pull request. A screenshot generated inside the release job
# is one nobody looks at until it is public. Android's are committed for the
# same reason.
#
# NO UI TEST TARGET. The app takes two launch arguments — see Screenshots.swift
# — so each screen is a separate launch rather than a sequence of taps. A UI
# test that navigates would be a second app to maintain, and one navigation
# change away from producing WRONG screenshots rather than none, which is the
# worse failure.
#
# THE DEMO FLEET IS THE FIXTURE. Two invented hosts and three invented sessions
# from a coordinator that answers from constants: no credential, nothing real,
# and the same picture every time. Screenshots of somebody's actual machines
# would be a privacy problem and would change every run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${SCREENSHOTS_DIR:-$ROOT/apps/ios/store/screenshots}"
APP_NAME=Fleetwright
BUNDLE_ID=network.thetech.fleetwright

# Apple's display type, and a simulator that has that screen. The names are
# App Store Connect's own — appScreenshotSets is keyed on them — so a size is
# added here and nowhere else.
#
# 6.9" and 6.5" are the two Apple currently requires for iPhone; anything else
# is derived from them, which is why this list is short on purpose.
DEVICES=(
  "APP_IPHONE_69:iPhone 17 Pro Max"
  "APP_IPHONE_65:iPhone 16 Plus"
)

# One launch per screen. The name becomes the filename, and the NUMBER is the
# order they appear on the store page — appstore-screenshots.mjs sorts by name
# because readdir's order is the filesystem's.
SHOTS=(
  "01-sessions:sessions"
  "02-fleet:fleet"
  "03-settings:settings"
)

command -v xcrun >/dev/null || { echo "this needs Xcode's command line tools"; exit 1; }

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Building $APP_NAME for the simulator"
DERIVED="$(mktemp -d)"
trap 'rm -rf "$DERIVED"' EXIT
xcodebuild build \
  -project "$ROOT/apps/ios/$APP_NAME.xcodeproj" \
  -scheme "$APP_NAME" \
  -sdk iphonesimulator \
  -configuration Debug \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO \
  >/dev/null
APP="$DERIVED/Build/Products/Debug-iphonesimulator/$APP_NAME.app"
[ -d "$APP" ] || { echo "no app at $APP"; exit 1; }

for entry in "${DEVICES[@]}"; do
  TYPE="${entry%%:*}"
  DEVICE="${entry#*:}"

  # A SIMULATOR OF OUR OWN, deleted afterwards. Reusing whatever is on the
  # machine makes the screenshots depend on somebody else's device list, and
  # on whatever state that device was left in.
  RUNTIME="$(xcrun simctl list runtimes --json | python3 -c "
import json,sys
rs=[r for r in json.load(sys.stdin)['runtimes'] if r.get('isAvailable') and 'iOS' in r['name']]
print(rs[-1]['identifier'] if rs else '')
")"
  [ -n "$RUNTIME" ] || { echo "no iOS runtime available"; exit 1; }

  if ! UDID="$(xcrun simctl create "fleetwright-shots-$TYPE" "$DEVICE" "$RUNTIME" 2>/dev/null)"; then
    echo "::warning::no simulator for '$DEVICE' — skipping $TYPE"
    continue
  fi
  say "$TYPE on $DEVICE"
  xcrun simctl boot "$UDID"
  xcrun simctl bootstatus "$UDID" -b >/dev/null
  # THE STATUS BAR IS PART OF THE PICTURE. Apple's own screenshots show full
  # bars and a round time; a real one would show 43% battery and whatever the
  # clock said, which dates the image and looks like a mistake.
  xcrun simctl status_bar "$UDID" override --time "09:41" --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3
  xcrun simctl install "$UDID" "$APP"

  mkdir -p "$OUT/$TYPE"
  for shot in "${SHOTS[@]}"; do
    NAME="${shot%%:*}"
    TAB="${shot#*:}"
    xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
    xcrun simctl launch "$UDID" "$BUNDLE_ID" -fleetwright-demo -fleetwright-tab "$TAB" >/dev/null
    # The fleet is fetched over the network on appear, so the shutter waits for
    # it. A fixed sleep is crude and it is honest: the alternative is polling
    # the screen, which is the UI test this file exists to avoid.
    sleep 6
    xcrun simctl io "$UDID" screenshot "$OUT/$TYPE/$NAME.png" >/dev/null
    echo "  $TYPE/$NAME.png"
  done

  xcrun simctl shutdown "$UDID" >/dev/null
  xcrun simctl delete "$UDID" >/dev/null
done

say "Done"
echo "  $OUT"
echo "  Review them, then commit — they are what the store will show."
