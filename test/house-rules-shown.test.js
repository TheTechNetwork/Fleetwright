// The phone shows what a box puts into every session, in the states the host
// actually sends and no others.
//
// The health frame carries `houseRules` as a NUMBER (docs/intents.md): a count
// of characters, 0 for a file that is present and not in use, null for none or
// a host too old to say. This holds the app to that shape, which matters most
// at the two ends: 0 is the one state worth attention and must not read as
// "none", and null must draw nothing rather than a guess.
//
// A grep, not a run — the Swift is compiled by CI's iOS job and this asserts
// what it says, not what it does. The Android half joins this file with its
// own pull request, and the assertion that both phones use the same sentences
// arrives with it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

test('iOS decodes house rules as a number that may be absent', () => {
  const swift = iosSources();
  assert.match(swift, /let houseRules: Int\?/, 'an Int? is the three-state shape; Bool or Int would lose one');
  // Every rebuild of the health struct must carry it, or an action on the
  // page silently drops the number until the next frame.
  const carried = swift.match(/houseRules: houseRules,/g) ?? [];
  assert.equal(carried.length, 4, 'four rebuilds (updates, channel, sandbox, labels) and each must carry it');
});

test('iOS draws the two states that mean something and nothing for the third', () => {
  const swift = iosSources();
  assert.match(swift, /if let houseRules \{/, 'nil draws nothing');
  assert.match(swift, /houseRules == 0/, 'zero is its own state');
  assert.match(swift, /is not being used/, 'and it is the one worth attention');
  assert.match(swift, /characters of house rules, read on every turn/, 'the count says what it costs');
  assert.match(swift, /Design\.Palette\.attention[\s\S]{0,400}characters of house rules/s,
    'the attention colour is on the fault, not on the count');
});

test('Android decodes house rules without reading a missing key as zero', () => {
  // optInt("houseRules") on an absent key returns 0, which is the one collapse
  // this field exists to prevent: "no file" drawn as "a file not in use".
  const kotlin = androidSources();
  assert.match(kotlin, /val houseRules: Int\? = null/);
  assert.match(kotlin, /has\("houseRules"\) && !it\.isNull\("houseRules"\)/, 'absent and JSON-null must both stay null');
});

test('both phones say the same thing about house rules, in the same two states', () => {
  const swift = iosSources();
  const kotlin = androidSources();
  for (const sentence of [
    'A rules file is on this box and is not being used.',
    'characters of house rules, read on every turn.',
    'One file on the box, written into each new session as its CLAUDE.md.',
  ]) {
    assert.ok(swift.includes(sentence), `iOS lost: ${sentence}`);
    assert.ok(kotlin.includes(sentence), `Android lost: ${sentence}`);
  }
  assert.match(kotlin, /host\.houseRules\?\.let/, 'null draws nothing on Android too');
  assert.match(kotlin, /houseRules == 0/, 'zero is its own state on Android too');
});
