// New session names the permission mode on both phones, and sends it.
//
//   node --test test/permission-mode-in-apps.test.js
//
// The fleet default is bypassed. A phone that omitted `mode` started the
// session that way and the sheet never said so (SEC-INJECT-3). The words are
// the same on both phones. The Swift and the Kotlin compile only in CI.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

const IOS = iosSources();
const ANDROID = androidSources();

const WORDS = [
  'Permissions bypassed',
  'Permission prompts on',
  'Permissions bypassed. This is the usual start: the session runs commands without asking.',
  'Permission prompts are on for this session. It stops and asks before it runs a command.',
  'Permissions bypassed is the usual start. Choose permission prompts on and a start of this kind asks first.',
];

test('both phones say the permission mode, and say what the usual start does', () => {
  for (const words of WORDS) {
    assert.ok(IOS.includes(words), `iOS does not say: ${words}`);
    assert.ok(ANDROID.includes(words), `Android does not say: ${words}`);
  }
});

test('a phone start sends safe or dangerous, and never omits the mode', () => {
  // The sheet's own request, and the spoken start, which has no sheet.
  assert.match(IOS, /mode: permission == "safe" \? "safe" : "dangerous"/);
  assert.match(IOS, /mode: chosen\?\.mode == "safe" \? "safe" : "dangerous"/);
  assert.match(ANDROID, /mode = if \(permission == "safe"\) "safe" else "dangerous"/);
  assert.doesNotMatch(IOS, /mode: kind\?\.mode/);
  assert.doesNotMatch(ANDROID, /mode = kind\?\.mode/);
});
