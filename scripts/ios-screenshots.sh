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
# TAKEN ON A macOS RUNNER ON EVERY FULL RELEASE, and uploaded as a run
# artifact so they can be looked at. The first version of this file wanted
# them committed, on the argument that what the store shows should be
# reviewable in a pull request — and then no Mac ever ran it, the directory
# never existed, and the first submission was refused for want of a picture.
# A release the pipeline cannot finish on its own is the thing this project
# keeps declining. Committed screenshots still win over the runner's, for
# when somebody wants different shots; see the release-app-store job.
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

# Apple's display type, and a PATTERN for a simulator that has that screen.
# The display types are App Store Connect's own — appScreenshotSets is keyed
# on them — so a size is added here and nowhere else. They are the API's
# ScreenshotDisplayType values, and there is no APP_IPHONE_69: the 6.9" phones
# upload under APP_IPHONE_67, the 6.3" ones under APP_IPHONE_61, and the
# 13" iPad under APP_IPAD_PRO_3GEN_129. The first version of this list named a
# type that does not exist, which Apple would have refused on the first upload.
#
# THE THREE APP STORE CONNECT ASKS FOR on a new app, in its words: the large
# and the medium "iPhone with Dynamic Island", and the 13-inch iPad. Every
# smaller display is scaled from these.
#
# THE SIMULATOR IS A PATTERN, NOT A NAME. "iPhone 17 Pro Max" is a job that
# breaks when the runner image moves to the next phone, which happens without
# warning and reads as a code failure. The newest device type matching the
# pattern is used, so the screenshots are taken on whatever the current Pro
# Max, Pro and 13-inch iPad are — which is also what the store page shows them
# on.
DEVICES=(
  "APP_IPHONE_67:^iPhone [0-9]+ Pro Max$"
  "APP_IPHONE_61:^iPhone [0-9]+ Pro$"
  "APP_IPAD_PRO_3GEN_129:^iPad Pro 13-inch"
)
# One launch per screen. The name becomes the filename, and the NUMBER is the
# order they appear on the store page — appstore-screenshots.mjs sorts by name
# because readdir's order is the filesystem's.
SHOTS=(
  "01-sessions:sessions"
  "02-machines:machines"
  "03-you:you"
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

# THE RUNTIME, once: the newest iOS the runner has.
RUNTIME="$(xcrun simctl list runtimes --json | python3 -c "
import json,sys
rs=[r for r in json.load(sys.stdin)['runtimes'] if r.get('isAvailable') and 'iOS' in r['name']]
print(rs[-1]['identifier'] if rs else '')
")"
[ -n "$RUNTIME" ] || { echo "no iOS runtime available"; exit 1; }

# WHAT EACH SLOT ACCEPTS, in pixels, portrait. App Store Connect refuses a
# picture of the wrong size at submission — "1 or more screenshots don't meet
# the required specifications" — and the API's upload says nothing, so the
# check has to be here, where the device was chosen. 0.4.13 shipped an
# iPhone 11 Pro's 1125×2436 into the 6.1" slot and an 11 Pro Max's 1242×2688
# into the 6.7" one, and the first anyone knew was Apple's refusal.
accepts() {
  case "$1" in
    APP_IPHONE_67) echo "1320x2868 1290x2796 1260x2736 1284x2778" ;;
    APP_IPHONE_61) echo "1206x2622 1179x2556 1170x2532" ;;
    APP_IPAD_PRO_3GEN_129) echo "2064x2752 2048x2732" ;;
    *) echo "" ;;
  esac
}
pixels() { python3 -c "
import struct,sys
with open(sys.argv[1],'rb') as h:
    h.seek(16); w,hh=struct.unpack('>II',h.read(8))
print(f'{w}x{hh}')
" "$1"; }

# One display type, start to finish: its own simulator, its own log (so the
# three running at once read as three stories rather than one interleaved
# one), and a non-zero exit when its pictures are not the size its slot
# takes. Returns 0 with no pictures when the runner has no such device.
shoot() {
  local TYPE="$1" PATTERN="$2" DEVICE UDID shot NAME TAB got ok
  # THE NEWEST MATCH BY MODEL NUMBER, not by position. simctl's list is not
  # in age order: the first version of this took the LAST match and got an
  # iPhone 11 Pro on a runner that also had the 17s, which is how 0.4.13's
  # phone screenshots came out the size of a 2019 screen. The number in the
  # name is the generation; the highest wins, and a tie goes to the later
  # name (M5 over M4).
  DEVICE="$(xcrun simctl list devicetypes --json | python3 -c "
import json,re,sys
pat=re.compile(sys.argv[1])
ds=[d for d in json.load(sys.stdin)['devicetypes'] if pat.search(d['name'])]
def gen(d):
    m=re.search(r'\d+', d['name']); return (int(m.group()) if m else 0, d['name'])
ds.sort(key=gen)
print(ds[-1]['identifier'] if ds else '')
" "$PATTERN")"
  if [ -z "$DEVICE" ]; then
    echo "::warning::no simulator for '$PATTERN' — skipping $TYPE"
    return 0
  fi

  # A SIMULATOR OF OUR OWN, deleted afterwards. Reusing whatever is on the
  # machine makes the screenshots depend on somebody else's device list, and
  # on whatever state that device was left in.
  if ! UDID="$(xcrun simctl create "fleetwright-shots-$TYPE" "$DEVICE" "$RUNTIME" 2>/dev/null)"; then
    echo "::warning::no simulator for '$DEVICE' on this runtime — skipping $TYPE"
    return 0
  fi
  say "$TYPE on $DEVICE"
  xcrun simctl boot "$UDID"
  xcrun simctl bootstatus "$UDID" -b >/dev/null
  # THE STATUS BAR IS PART OF THE PICTURE. Apple's own screenshots show full
  # bars and a round time; a real one would show 43% battery and whatever the
  # clock said, which dates the image and looks like a mistake.
  xcrun simctl status_bar "$UDID" override --time "09:41" --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3
  xcrun simctl install "$UDID" "$APP"

  ok=0
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
    got="$(pixels "$OUT/$TYPE/$NAME.png")"
    case " $(accepts "$TYPE") " in
      *" $got "*) echo "  $TYPE/$NAME.png ($got)" ;;
      *) echo "::error::$TYPE/$NAME.png is ${got}, which App Store Connect does not take for $TYPE (one of: $(accepts "$TYPE")) — the wrong simulator, $DEVICE"; ok=1 ;;
    esac
  done

  xcrun simctl shutdown "$UDID" >/dev/null
  xcrun simctl delete "$UDID" >/dev/null
  if [ "$ok" != 0 ]; then rm -rf "$OUT/$TYPE"; fi
  return "$ok"
}

# ONE AT A TIME, on purpose. The version before this booted all three at
# once to save the release ten minutes, and on the hosted runner the three
# never came up at all: 0.4.14's job sat for over half an hour with every
# other job finished, and the submission waited behind it. A boot takes
# three to four minutes alone and the runner has few cores to give three;
# serial is slower by the clock and the only shape that is known to finish.
# Each device still gets its own log, printed as it ends, and the job's
# timeout-minutes in ios.yml is the wall this can never climb past.
mkdir -p "$OUT"
failed=0
for entry in "${DEVICES[@]}"; do
  TYPE="${entry%%:*}"
  shoot "$TYPE" "${entry#*:}" >"$OUT/.log-$TYPE" 2>&1 || failed=1
  cat "$OUT/.log-$TYPE"; rm -f "$OUT/.log-$TYPE"
done
[ "$failed" = 0 ] || { echo "a display type came out the wrong size; see above"; exit 1; }

say "Done"
echo "  $OUT"
echo "  On a full release the iOS workflow takes these on a macOS runner and"
echo "  attaches them before submitting; committed ones under apps/ios/store/"
echo "  screenshots win over the runner's, for when somebody wants different shots."
