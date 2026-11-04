// The first screen's sign-in button answers every tap it can receive.
//
// WHY THIS EXISTS. App Review rejected iOS 0.4.15 under guideline 2.1(a):
// "when we tapped on 'Sign in with Apple' button, no action took place". The
// fleet-address field was empty, so the button was `.disabled` — and
// SwiftUI's `SignInWithAppleButton` does not LOOK disabled. It stays the same
// solid black button and stops answering, which is a broken app to anybody who
// taps it. C-2 says a control appears only when its action exists, so the iOS
// app now draws the button only once there is an address, with the sentence
// that names the missing address in its place.
//
// Android is not held to the same shape: Material's Button greys itself when
// disabled, so a disabled Google button already reads as waiting for
// something, with the same sentence beside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

// Comments carry the reasoning here, and this file's subject is quoted in
// them; an assertion must read only the code.
const code = (src) => src.replace(/^\s*\/\/.*$/gm, '');

/** The modifier chain hung off the one Sign in with Apple button. */
function appleButtonChain(src) {
  const at = src.indexOf('SignInWithAppleButton(');
  assert.ok(at >= 0, 'the iOS app no longer draws a Sign in with Apple button');
  const lines = src.slice(at).split('\n');
  const chain = [lines[0]];
  for (const line of lines.slice(1)) {
    if (!/^\s*\./.test(line)) break;
    chain.push(line);
  }
  return chain.join('\n');
}

test('the Apple button is never drawn waiting on an address it cannot show it lacks', () => {
  const swift = code(iosSources());
  const chain = appleButtonChain(swift);
  // Disabled only while a sign-in is in flight, which the line beneath it
  // explains ("signing in…"). Disabled on the address is the rejected build.
  assert.doesNotMatch(chain, /coordinatorURL/, 'the Apple button is disabled on the address again — it will look live and ignore the tap');
  // And it is drawn only once there is an address: the button sits in the
  // branch that runs when the address is not blank.
  const before = swift.slice(0, swift.indexOf('SignInWithAppleButton('));
  assert.match(before.slice(-600), /if fleetAddressBlank \{[\s\S]*Enter your fleet's address first[\s\S]*\} else \{\s*$/,
    'the Apple button is no longer drawn only when the address is filled in');
});

test('both phones say why there is nothing to sign in to yet, in the same words', () => {
  const sentence = "Enter your fleet's address first — signing in means signing in to a fleet.";
  assert.ok(code(iosSources()).includes(sentence), 'the iOS app lost the sentence that stands in for the button');
  assert.ok(code(androidSources()).includes(sentence), 'the Android app lost the sentence beside its disabled button');
});
