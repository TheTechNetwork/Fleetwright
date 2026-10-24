#!/usr/bin/env bash
# Point xcodebuild at the Xcode the app ships with, on every macOS job.
#
#   ./scripts/select-xcode.sh
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
set -euo pipefail

XCODE="27.1"
SDK_PREFIX="27.1"

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

echo "using $app ($(xcodebuild -version | tr '\n' ' ')), iOS SDK $sdk"
