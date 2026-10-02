// A change of state moves, on both phones, and nothing moves for somebody who
// asked for less motion.
//
//   node --test test/motion-in-apps.test.js
//
// A read of the sources, like the other *-in-apps tests: the Swift and the
// Kotlin compile only in CI. The numbers themselves are held equal across the
// three surfaces by design-parity.test.js; this is about where they are used.
//
// WRITTEN BECAUSE NEITHER APP HAD ANY. Not a reduced amount of motion: none, in
// either codebase, so a session going from working to waiting swapped one card
// for another. Each assertion below is one of the moments docs/design-system.md
// names under Motion.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

const IOS = iosSources();
const ANDROID = androidSources();

test('iOS: the session list and the machine list move their cards, unless motion is reduced', () => {
  assert.match(IOS, /withAnimation\(Design\.Motion\.settle\(reduceMotion\)\) \{ sessions = reply\.sessions \?\? \[\] \}/);
  assert.match(IOS, /withAnimation\(Design\.Motion\.settle\(reduceMotion\)\) \{\s*if let got = gotReporting \{ fleetHosts = got \}/);
  assert.match(IOS, /@Environment\(\\\.accessibilityReduceMotion\) private var reduceMotion/);
});

test('iOS: a status, the assurance line and a question change rather than swap', () => {
  // The badge's symbol becomes the next symbol, and the word crossfades.
  assert.match(IOS, /\.contentTransition\(\.symbolEffect\(\.replace\)\)[\s\S]{0,200}?Text\(status\)\s*\.contentTransition\(\.opacity\)/);
  assert.match(IOS, /\.animation\(Design\.Motion\.change, value: status\)/);
  // The first line on the screen says it changed, and its counts roll.
  assert.match(IOS, /\.animation\(Design\.Motion\.change, value: summary\.headline\)/);
  assert.match(IOS, /\.contentTransition\(reduceMotion \? ContentTransition\.opacity : \.numericText\(\)\)/);
  // The question unfolds; the card's ring takes on the tone as it does.
  assert.match(IOS, /\.transition\(questionArrives\)/);
  assert.match(IOS, /\.animation\(Design\.Motion\.change, value: session\.prompt != nil\)/);
});

test('iOS: what the fleet did with an action is felt, and a refusal feels different', () => {
  // Counted, so the same answer twice is felt twice.
  // On the list and on the session's own page, so twice.
  const felt = IOS.match(/\.sensoryFeedback\(\.success, trigger: accepted\)\s*\.sensoryFeedback\(\.error, trigger: refused\)/g) ?? [];
  assert.equal(felt.length, 2, 'the list and the session page each give feedback');
  assert.match(IOS, /if reply\.ok == false \{ refused \+= 1 \} else \{ accepted \+= 1 \}/);
});

test('Android: the session list and the machine list move their cards, unless animations are off', () => {
  // `animateItem` with the shared spring for where a card goes, and a crossfade
  // for one arriving or leaving. The spring is null with "Remove animations"
  // on, which turns placement off rather than shortening it.
  const items = ANDROID.match(/animateItem\(\s*fadeInSpec = Design\.Motion\.change\(\),\s*placementSpec = Design\.Motion\.settle\(reduced\),\s*fadeOutSpec = Design\.Motion\.change\(\),?\s*\)/g) ?? [];
  assert.equal(items.length, 3, 'sessions, reporting machines and silent machines each move');
  assert.match(ANDROID, /Settings\.Global\.ANIMATOR_DURATION_SCALE/);
});

test('Android: a status, the assurance line and a question change rather than swap', () => {
  assert.match(ANDROID, /AnimatedContent\(\s*targetState = session\.status,/);
  assert.match(ANDROID, /AnimatedContent\(\s*targetState = summary\.headline,/);
  assert.match(ANDROID, /AnimatedVisibility\(\s*visible = session\.prompt != null,/);
  // The ring takes on the tone rather than being swapped for it, on the card
  // that is asking and on the assurance card.
  assert.match(ANDROID, /val ring by animateColorAsState\(\s*if \(session\.prompt != null\)/);
  assert.match(ANDROID, /val ring by animateColorAsState\(if \(summary\.settled\)/);
});

test('Android: what the fleet did with an action is felt, and a refusal feels different', () => {
  assert.match(ANDROID, /performHapticFeedback\(if \(reply\.ok\) HapticFeedbackType\.Confirm else HapticFeedbackType\.Reject\)/);
});

test('Android: the tabs are the current short bar, with a mark above each word', () => {
  // The marks were empty slots (`icon = {}`), so the tabs read as three words.
  assert.match(ANDROID, /ShortNavigationBar \{/);
  assert.match(ANDROID, /icon = \{ Icon\(mark, contentDescription = null\) \}/);
  assert.doesNotMatch(ANDROID, /NavigationBarItem\([\s\S]{0,80}icon = \{\}/);
});

test('nothing on either phone loops', () => {
  // A pulse that never stops says "live" about something the words already
  // say, and on a screen read at night it is the one thing that keeps moving.
  assert.doesNotMatch(IOS, /repeatForever|\.symbolEffect\(\.pulse|\.symbolEffect\(\.breathe|phaseAnimator/);
  assert.doesNotMatch(ANDROID, /rememberInfiniteTransition|infiniteRepeatable|RepeatMode\.Reverse/);
});
