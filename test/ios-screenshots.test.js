// Screenshots, taken by a script rather than by a person with a file picker.
//
// The last stage of the release that needed somebody at a laptop. Also the
// worst one to leave manual: per device size AND per locale, refused all at
// once by App Review, and silently stale the moment the UI changes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SH = readFileSync(new URL('../scripts/ios-screenshots.sh', import.meta.url), 'utf8');
const SWIFT = readFileSync(new URL('../apps/ios/Fleetwright/Screenshots.swift', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../apps/ios/Fleetwright/FleetwrightApp.swift', import.meta.url), 'utf8');
const VIEW = readFileSync(new URL('../apps/ios/Fleetwright/FleetView.swift', import.meta.url), 'utf8');

test('a launch argument can select the demo and a tab, and nothing else', () => {
  // A LAUNCH ARGUMENT THAT COULD CONFIGURE ANYTHING WOULD BE A WAY TO POINT
  // SOMEBODY'S APP SOMEWHERE WITHOUT THEM NOTICING. There is no argument here
  // that takes a URL, a token, or an email; the only choice is "the demo, or
  // not", and the values are Demo's compiled-in constants.
  assert.match(SWIFT, /-fleetwright-demo/);
  assert.match(SWIFT, /-fleetwright-tab/);
  assert.equal((SWIFT.match(/arguments\.contains|firstIndex\(of:/g) || []).length, 2,
    'a third launch argument was added without a note here');

  // The tab is matched against a fixed set, so an unknown value opens the app
  // normally rather than doing something inventive.
  assert.match(SWIFT, /\["sessions", "fleet", "settings"\]\.contains\(name\)/);
});

test('the demo launch writes what the Demo button writes, and no more', () => {
  const init = APP.slice(APP.indexOf('if Screenshots.wantsDemo'), APP.indexOf('if Screenshots.wantsDemo') + 400);
  // Demo's constants only. A screenshot run must not be able to set a real
  // coordinator or a real credential.
  assert.match(init, /s\.coordinatorURL = Demo\.coordinatorURL/);
  assert.match(init, /s\.credential = Demo\.credential/);
  assert.doesNotMatch(init, /ProcessInfo|arguments\[/, 'a launch argument reached a settings value directly');
});

test('the screenshot tab and the unconfigured-app rule cannot both fire', () => {
  // Two things can choose a tab, and their order has to be visible: a
  // screenshot run has already been pointed at the demo, so it is configured,
  // and `else if` is what says that rather than leaving it to be worked out.
  assert.match(VIEW, /if let t = screenshotTab \{ tab = t \}\s*\n\s*else if !settings\.configured \{ tab = \.settings \}/);
});

test('the directories are named for Apple display types, which the uploader reads', () => {
  // The directory name IS the display type — appScreenshotSets is keyed on it
  // — so a size is added in one list and nowhere else.
  assert.match(SH, /APP_IPHONE_69:/);
  assert.match(SH, /APP_IPHONE_65:/);
  const uploader = readFileSync(new URL('../tools/appstore-screenshots.mjs', import.meta.url), 'utf8');
  assert.match(uploader, /screenshotDisplayType: type/, 'the uploader stopped keying on the directory name');
  assert.match(SH, /apps\/ios\/store\/screenshots/);
});

test('the status bar is overridden, because a real one dates the picture', () => {
  // Apple's own screenshots show full bars and 09:41. A real status bar shows
  // 43% battery and whatever the clock said, which looks like a mistake on a
  // store page.
  assert.match(SH, /simctl status_bar .* override .*--time "09:41"/);
  assert.match(SH, /--batteryState charged/);
});

test('it uses a simulator of its own and deletes it', () => {
  // Reusing whatever is on the machine makes the screenshots depend on
  // somebody else's device list, and on whatever state that device was left in.
  assert.match(SH, /simctl create "fleetwright-shots-/);
  assert.match(SH, /simctl delete "\$UDID"/);
});

test('a device the machine does not have is skipped, not fatal', () => {
  // Runner images change. A missing simulator must not stop the other sizes,
  // because half the screenshots is better than none and the message says
  // which half.
  assert.match(SH, /::warning::no simulator for/);
  assert.match(SH, /continue/);
});

test('nothing here uploads — that is a separate decision on a full release', () => {
  // This writes files a person reviews and commits. Uploading happens inside
  // appstore-release.mjs, on a published non-prerelease release, and only for
  // a display type that has none.
  assert.doesNotMatch(SH, /appstoreconnect\.apple\.com|ASC_KEY/);
});
