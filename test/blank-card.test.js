// Neither phone draws a card around nothing.
//
// The rule, in one sentence: a screen that QUOTES a reply asks whether the
// reply said anything, and `isEmpty` is not that question.
//
// This is the app half of the blank Output card. `tmux capture-pane` returns
// every row of the visible region, so a session that has printed nothing
// answers with forty newlines — a string that is not empty. iOS gated its
// quoted-reply cards on `!x.isEmpty` and drew a card the height of the phone
// with nothing on it. Android gated the same card on `isNotBlank()` and drew
// nothing at all, which is better and still not right: a button that reports
// nothing when it is pressed is a button somebody presses again.
//
// src/core/logs.js stops the host sending it. This is here because a phone in
// a pocket talks to whatever host that fleet is running, which is not always
// the newest one — and because the rule is easy to lose on the next screen
// somebody adds.
//
// The Swift side of the SAME rule is exercised for real in
// apps/ios/FleetwrightTests/BlankReplyTests.swift. This is the part a grep can
// answer: that no gate anywhere went back to `isEmpty`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

test('iOS defines the blank test once, in the app rather than per screen', () => {
  const swift = iosSources();
  assert.match(
    swift,
    /var isBlank: Bool \{ trimmingCharacters\(in: \.whitespacesAndNewlines\)\.isEmpty \}/,
    'the one definition every screen leans on',
  );
});

test('no iOS card is drawn around a reply that might be whitespace', () => {
  const swift = iosSources();
  // Every state that holds a QUOTED REPLY — the coordinator's words, a box's
  // words, a journal — and the gate each one is drawn behind.
  for (const held of ['status', 'result', 'runnerResult', 'clientResult', 'pushResult']) {
    assert.doesNotMatch(
      swift,
      new RegExp(`if !${held}\\.isEmpty`),
      `${held} is quoted from somewhere else, so it is gated on isBlank`,
    );
  }
});

test('the verb whose job is to bring text back says something when there is none', () => {
  // Trimming alone would trade an empty card for a button that does nothing
  // visible. Output is the one verb on the sessions screen that exists to
  // return text, so it is the one that needs a sentence for the empty case.
  const swift = iosSources();
  assert.match(swift, /nothingSaid/, 'iOS has nowhere to put the sentence');
  assert.match(swift, /has printed nothing that this machine could read/);

  const kotlin = androidSources();
  assert.match(kotlin, /fun String\.said\(nothing: String = ""\)/, 'Android has nowhere to put the sentence');
  assert.match(kotlin, /has printed nothing that this machine could read/,
    'the two phones say the same thing here, or one of them is wrong');
});

test('Android says something when a peeked pane is blank too', () => {
  // Android has a Peek button and iOS does not, so this one has no twin. It is
  // the same rule: the pane IS the answer, and this screen deliberately does
  // not refresh afterwards — so a blank pane that set nothing would leave
  // whatever the last command said sitting there as if it were the reply.
  const kotlin = androidSources();
  assert.match(kotlin, /Nothing is on \$\{session\.label\}'s screen right now\./);
});

test('Android keeps the blank test it already had', () => {
  // It has been right about this since the card was added. Pinned so it stays
  // right: `isNotEmpty()` here is the iOS bug, ported.
  const kotlin = androidSources();
  assert.match(kotlin, /if \(status\.isNotBlank\(\)\)/);
  assert.doesNotMatch(kotlin, /if \(status\.isNotEmpty\(\)\)/);
});
