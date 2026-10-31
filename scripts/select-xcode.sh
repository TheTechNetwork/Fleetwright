#!/usr/bin/env bash
# Point xcodebuild at the Xcode the app ships with, on every macOS job.
#
#   ./scripts/select-xcode.sh          # 27.2, what ships
#   ./scripts/select-xcode.sh 27.3     # the next one, built beside it once its beta is on the image
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

# WHAT SHIPS, and what is built beside it. TestFlight builds with SHIPS, and
# the store submits that same upload, so this line is what the store gets
# too. ios.yml's build job compiles and tests on SHIPS and, once GitHub's
# image carries its beta, on the next Xcode, so a change in it is seen before
# it is what ships; the notice at the end of this script says when the image
# has one that is not built here. 27.1 was built beside 27.2 as the oldest
# SDK that draws the Duo edge to edge, until 27.2 shipped.
#
# 27.2 is the release that brought Apple Pencil to the Duo. 27B48 is the
# build the image carries, the release candidate Apple has accepted
# submissions from since 20 October; a different 27.2 on the image is an
# error here by design, and this line moves with it.
SHIPS="27.2"
XCODE="${1:-$SHIPS}"
SDK_PREFIX="$XCODE"

# THE BUILD, NOT ONLY THE NUMBER. An image can carry a beta under the same
# Xcode_27.2.app name it later gives the release candidate, so a version that
# matches is not yet the one meant. The next beta is added here with its
# build when it joins ios.yml's matrix.
case "$XCODE" in
  27.2) BUILD="27B48" ;;
  *) echo "::error::no build is recorded for Xcode $XCODE in this script"; exit 1 ;;
esac

app=""
# A beta is Xcode_<version>_beta.app on GitHub's images, hence the last glob.
for candidate in "/Applications/Xcode_${XCODE}.app" /Applications/Xcode_"${XCODE}".*.app /Applications/Xcode_"${XCODE}"_beta*.app; do
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

# THE NEXT ONE, SAID WHEN IT APPEARS. The next Xcode is to be built beside
# what ships from the day its beta is on the image, and nobody watches the
# image's release notes: so every run says, as a notice on the job, when the
# image carries an Xcode newer than SHIPS that this script has no build for.
# Newer by major.minor only, so a 27.2.1 beside 27.2 is not news.
newer=""
for candidate in /Applications/Xcode_*.app; do
  v="${candidate##*/Xcode_}"
  v="${v%.app}"
  v="${v%%_*}"
  mm="$(printf '%s' "$v" | sed -n 's/^\([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')"
  [ -n "$mm" ] || continue
  case "$mm" in "$SHIPS") continue ;; esac
  if [ "${mm%%.*}" -gt "${SHIPS%%.*}" ] || { [ "${mm%%.*}" -eq "${SHIPS%%.*}" ] && [ "${mm#*.}" -gt "${SHIPS#*.}" ]; }; then
    case " $newer " in *" $mm "*) ;; *) newer="$newer $mm" ;; esac
  fi
done
if [ -n "$newer" ]; then
  echo "::notice title=Xcode${newer} is on this image::ios.yml builds on ${SHIPS} and not on it. The next Xcode is built beside what ships from its first beta: add it to ios.yml's matrix and record its build in scripts/select-xcode.sh (docs/watch-and-duo.md, What is built)."
fi
