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

const IOS = iosSources();

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

test('nothing on either phone loops', () => {
  // A pulse that never stops says "live" about something the words already
  // say, and on a screen read at night it is the one thing that keeps moving.
  assert.doesNotMatch(IOS, /repeatForever|\.symbolEffect\(\.pulse|\.symbolEffect\(\.breathe|phaseAnimator/);
});
