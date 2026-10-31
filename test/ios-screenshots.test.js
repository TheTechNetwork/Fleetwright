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
  assert.match(VIEW, /if let t = screenshotTab \{ tab = t \}\s*\n\s*else if !settings\.configured \{ tab = \.you \}/);
});

test('the directories are named for Apple display types, which the uploader reads', () => {
  // The directory name IS the display type — appScreenshotSets is keyed on it
  // — so a size is added in one list and nowhere else. And the names are the
  // API's ScreenshotDisplayType values: the first list here said
  // APP_IPHONE_69, which does not exist (6.9" phones are APP_IPHONE_67), and
  // Apple would have refused it on the first upload.
  assert.match(SH, /"APP_IPHONE_67:/);
  assert.match(SH, /"APP_IPHONE_61:/);
  assert.match(SH, /"APP_IPAD_PRO_3GEN_129:/);
  assert.doesNotMatch(SH, /"APP_IPHONE_69:/, 'APP_IPHONE_69 is not a display type Apple has');
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

test('the simulator is chosen by pattern and the highest model number, not by position', () => {
  // "iPhone 17 Pro Max" is a job that breaks when the runner image moves to
  // the next phone. A pattern over simctl's device types picks whatever the
  // current Pro Max, Pro and 13-inch iPad are — by the NUMBER in the name.
  // simctl's list is not in age order: taking the last match gave 0.4.13 an
  // iPhone 11 Pro on a runner that had the 17s.
  assert.match(SH, /simctl list devicetypes --json/);
  assert.match(SH, /\^iPhone \[0-9\]\+ Pro Max\$/);
  assert.match(SH, /\^iPad Pro 13-inch/);
  assert.match(SH, /ds\.sort\(key=gen\)/, 'the matches are no longer ordered by model number');
  assert.match(SH, /re\.search\(r'\\d\+', d\['name'\]\)/);
});

test('a picture the wrong size for its slot fails the run, and never reaches the store', () => {
  // The API's upload says nothing about size; App Store Connect refuses at
  // submission, in the browser, after the release has gone red for the wrong
  // reason. 0.4.13's phone sets were 1125×2436 and 1242×2688 — a 2019 screen
  // — and nothing between the simulator and Apple noticed.
  assert.match(SH, /APP_IPHONE_67\) echo "1320x2868 1290x2796 1260x2736 1284x2778"/);
  assert.match(SH, /APP_IPHONE_61\) echo "1206x2622 1179x2556 1170x2532"/);
  assert.match(SH, /APP_IPAD_PRO_3GEN_129\) echo "2064x2752 2048x2732"/);
  assert.match(SH, /struct\.unpack\('>II'/, 'the size is read from the PNG itself');
  assert.match(SH, /::error::\$TYPE\/\$NAME\.png is \$\{got\}/);
  assert.match(SH, /rm -rf "\$OUT\/\$TYPE"/, 'a wrong-sized set is left where the uploader will find it');
  assert.match(SH, /exit 1/);
});

test('the devices run one at a time, each with its own log, under a job timeout', () => {
  // Three concurrent boots never came up on the hosted runner: 0.4.14's job
  // sat for over half an hour with the submission waiting behind it. Serial
  // is the shape known to finish, and the workflow's timeout-minutes is the
  // wall a hang cannot climb past.
  assert.match(SH, /shoot "\$TYPE" "\$\{entry#\*:\}" >"\$OUT\/\.log-\$TYPE" 2>&1 \|\| failed=1/);
  assert.doesNotMatch(SH, /2>&1 &$/m, 'a device is backgrounded again');
  const yml = readFileSync(new URL('../.github/workflows/ios.yml', import.meta.url), 'utf8');
  const shots = yml.slice(yml.indexOf('  screenshots:'), yml.indexOf('  release-app-store:'));
  assert.match(shots, /timeout-minutes: 30/);
});

test('a device the machine does not have is skipped, not fatal', () => {
  // Runner images change. A missing simulator must not stop the other sizes,
  // because half the screenshots is better than none and the message says
  // which half.
  assert.match(SH, /::warning::no simulator for/);
  assert.match(SH, /return 0/);
});

test('nothing here uploads — that is a separate decision on a full release', () => {
  // This writes files a person reviews and commits. Uploading happens inside
  // appstore-release.mjs, on a published non-prerelease release, and only for
  // a display type that has none.
  assert.doesNotMatch(SH, /appstoreconnect\.apple\.com|ASC_KEY/);
});

test('the iOS workflow runs on a change to any script its jobs run, on a push and on a pull request alike', () => {
  // #1485 changed scripts/ios-duo-look.sh and came up green with no iOS job
  // run at all: the paths named apps/ios and the workflow file, not the
  // scripts outside apps/ the jobs call, so the change's first run would have
  // been on main. Every scripts/*.sh a run: line names has to be in both path
  // lists, or the filter skips exactly the run that would prove the change.
  const yml = readFileSync(new URL('../.github/workflows/ios.yml', import.meta.url), 'utf8');
  const on = yml.slice(0, yml.indexOf('\njobs:'));
  const lists = ['push:', 'pull_request:'].map((k) => {
    const from = on.indexOf(`  ${k}`);
    const next = on.slice(from + 1).search(/\n  [a-z_]+:/);
    return on.slice(from, next < 0 ? undefined : from + 1 + next);
  });
  const scripts = [...new Set([...yml.matchAll(/^\s+run: (?:\.\.\/\.\.\/|\.\/)?(scripts\/[a-z0-9-]+\.sh)\b/gm)].map((m) => m[1]))];
  assert.ok(scripts.includes('scripts/ios-duo-look.sh') && scripts.includes('scripts/select-xcode.sh'), `the run: lines name ${scripts.join(', ')}`);
  for (const [i, list] of lists.entries()) {
    for (const script of scripts) assert.ok(list.includes(`'${script}'`), `${['push', 'pull_request'][i]} paths lack ${script}`);
  }
});
