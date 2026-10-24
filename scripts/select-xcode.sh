#!/usr/bin/env bash
# Point xcodebuild at the Xcode the app ships with, on every macOS job.
#
#   ./scripts/select-xcode.sh          # 27.1, what ships
#   ./scripts/select-xcode.sh 27.2     # what is next, built beside it
#
# WHY IT IS PINNED AT ALL. The SDK an app is BUILT with decides how iPhone Duo
# draws it, whatever the deployment target says: built with the iOS 26 SDK it
# runs at an old iPhone's aspect ratio in the middle of the unfolded screen;
# with 27.0 it reaches beside the status bar; only with 27.1 does it go edge to
# edge, with the vertical bars and the split view keeping clear of the fold.
# `macos-latest` carried whichever Xcode its image happened to default to, so
# the build that shipped could change shape without a commit. docs/watch-and-duo.md.
#
# NOT THE DEPLOYMENT TARGET. project.yml keeps iOS 26 and its reason; building
# with a newer SDK and running on an older OS are separate settings.
#
# FAILS RATHER THAN FALLING BACK. An image without this Xcode is a build that
# would be letterboxed on the Duo, and quietly building it anyway is the
# failure this script exists to stop. Move XCODE when a newer one ships.
#
# THE IMAGE, NOT JUST THE VERSION. macos-latest carries Xcode 26 alone; the
# jobs that call this run on GitHub's `xcode-27` label, whose default is 27.0,
# which is why selecting 27.1 here still matters.
set -euo pipefail

# WHAT SHIPS, and what is built beside it. ios.yml's build job compiles and
# tests on both, so a change that needs the next SDK, or breaks on it, is seen
# before it ships; TestFlight and the store take the first. Move SHIPS when the
# next one is final.
SHIPS="27.1"
XCODE="${1:-$SHIPS}"
SDK_PREFIX="$XCODE"

# THE BUILD, NOT ONLY THE NUMBER. An image can carry a beta under the same
# Xcode_27.2.app name it later gives the release candidate, so a version that
# matches is not yet the one meant. 27.2's is the RC, the first build Apple
# accepts submissions from.
case "$XCODE" in
  27.1) BUILD="27A9275" ;;
  27.2) BUILD="27B48" ;;
  *) echo "::error::no build is recorded for Xcode $XCODE in this script"; exit 1 ;;
esac

app=""
for candidate in "/Applications/Xcode_${XCODE}.app" /Applications/Xcode_"${XCODE}".*.app; do
  if [ -d "$candidate" ]; then app="$candidate"; break; fi
done

if [ -z "$app" ]; then
  echo "::error::Xcode ${XCODE} is not on this runner image. Installed:"
  ls -d /Applications/Xcode*.app 2>/dev/null || true
  exit 1
fi

sudo xcode-select -s "$app/Contents/Developer"

sdk="$(xcrun --sdk iphonesimulator --show-sdk-version)"
case "$sdk" in
  "$SDK_PREFIX"*) ;;
  *)
    echo "::error::$app carries the iOS $sdk simulator SDK, not $SDK_PREFIX"
    exit 1
    ;;
esac

got="$(xcodebuild -version | awk '/Build version/ {print $3}')"
if [ "$got" != "$BUILD" ]; then
  echo "::error::$app is build $got, not $BUILD"
  exit 1
fi

echo "using $app (Xcode $XCODE, build $got), iOS SDK $sdk"
