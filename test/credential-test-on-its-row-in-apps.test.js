// A credential's Test answers under the row it tested, and says which machine
// answered.
//
//   node --test test/credential-test-on-its-row-in-apps.test.js
//
// A read of the sources, like the other *-in-apps tests: the Swift and the
// Kotlin compile only in CI. The coordinator's half, a Test on a token asked
// of every box and answered from one that holds it, is in
// credential-coverage.test.js.
//
// WRITTEN FROM A SCREENSHOT. "Linked on machines" showed GitHub "connected",
// and under every row a card reading "No GitHub token is stored here." It
// named no row and no machine. A Claude Test filled the same card with a
// paragraph about "this box".

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

const IOS = iosSources();
const ANDROID = androidSources();

test('iOS: a Test that comes back as words is kept under its own row', () => {
  assert.match(IOS, /@State private var tested: \[String: \(text: String, ok: Bool\)\]/);
  assert.match(IOS, /tested\[provider\.provider\] = \(reply\.text \?\? "", reply\.ok != false\)/);
  assert.match(IOS, /if let said = tested\[provider\.provider\] \{/);
  // And no longer into the screen-wide result line.
  const check = IOS.slice(IOS.indexOf('private func check('), IOS.indexOf('private func bindingForDetail('));
  assert.doesNotMatch(check, /\bresult = /);
});

test('iOS: a check names the machine that made it', () => {
  assert.match(IOS, /let hostId: String\?\s*\}/);
  assert.match(IOS, /if let host = check\.hostId, !host\.isEmpty \{ parts\.append\("on \\\(host\)"\) \}/);
});

test('Android: a Test that comes back as words is kept under its own row', () => {
  assert.match(ANDROID, /var tested by remember \{ mutableStateOf\(mapOf<String, Pair<String, Boolean>>\(\)\) \}/);
  assert.match(ANDROID, /tested = tested \+ \(provider\.provider to \(reply\.text to reply\.ok\)\)/);
  assert.match(ANDROID, /tested\[provider\.provider\]\?\.let \{ \(text, ok\) ->/);
  assert.doesNotMatch(ANDROID, /verify\(host, provider\.provider\)[\s\S]{0,200}?else result = reply\.text/);
});

test('Android: a check names the machine that made it', () => {
  assert.match(ANDROID, /hostId = c\.optString\("hostId"\)/);
  assert.match(ANDROID, /check\.hostId\?\.takeIf \{ it\.isNotBlank\(\) \}\?\.let \{ "on \$it" \}/);
});
