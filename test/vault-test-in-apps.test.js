// Both phones test a kept credential where there is a service to ask, and ask
// before forgetting one.
//
//   node --test test/vault-test-in-apps.test.js
//
// A read of the sources, like the other *-in-apps tests: the Swift and the
// Kotlin compile only in CI. What the test op answers is held by
// test/vault.test.js against the minter itself.
//
// WRITTEN AFTER A RUNNER'S CLAUDE LOGIN WENT MISSING. The vault listed what it
// held and never whether any of it worked, and Forget was one tap beside the
// buttons people come to this screen for: a person found "Forgot your Claude
// login" under Credentials after a runner had already started without one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

const IOS = iosSources();
const ANDROID = androidSources();

// The sentences a person reads, the same on both phones.
const SAID = [
  "Runners you start go back to the runner repository's API key, and boxes stop being given it. ",
  'Getting it back means a new token from claude setup-token.',
  'Boxes stop being given it when they next ask. Getting it back means signing in again from this page.',
  'Boxes stop being given it when they next ask. Getting it back means typing it in again.',
];

test('iOS: Test is offered for the three kept credentials the minter can ask about, and only those', () => {
  assert.ok(IOS.includes('op: "test"'), 'iOS never asks the vault to test');
  // C-2: a named secret or a hypervisor's token has no service to ask.
  assert.match(IOS, /static func isTestable\(_ name: String\) -> Bool \{\s*\["claude", "github", "cloudflare"\]\.contains\(name\)/);
  assert.match(IOS, /if PhoneVault\.isTestable\(item\.name\) \{\s*Button\("Test \\\(PhoneVault\.label\(item\.name\)\)"\)/);
  // Cannot tell is not drawn as working (C-5).
  assert.match(IOS, /guard r\.answer\["state"\] as\? String == "accepted" else \{ throw/);
});

test('iOS: Forget asks first, and says what forgetting costs', () => {
  for (const words of SAID) assert.ok(IOS.includes(words), `iOS does not say: ${words}`);
  assert.match(IOS, /\.confirmationDialog\("Forget \\\(PhoneVault\.label\(forgetting \?\? ""\)\)\?"/);
  assert.match(IOS, /Button\("Forget \\\(PhoneVault\.label\(item\.name\)\)", role: \.destructive\) \{ forgetting = item\.name \}/);
});

test('iOS: the vault makes a Claude token on a machine, as Set up Claude does', () => {
  // The paste field here wanted a command run on a computer, from somebody
  // holding a phone; Set up Claude already offered a machine to run it.
  assert.match(IOS, /ClaudeSetup\(settings: settings\) \{ Task \{ await reload\(\) \} \}/);
  assert.doesNotMatch(IOS, /Forget my Claude login/);
});

test('Android: Test for the same three, the same Forget dialog, the same Claude rows', () => {
  assert.ok(ANDROID.includes('ask(fleet, "test",'), 'Android never asks the vault to test');
  assert.match(ANDROID, /fun isTestable\(name: String\): Boolean = name in setOf\("claude", "github", "cloudflare"\)/);
  assert.match(ANDROID, /if \(PhoneVault\.isTestable\(item\.name\)\) \{[\s\S]{0,200}Text\("Test \$\{PhoneVault\.label\(item\.name\)\}"\)/);
  assert.match(ANDROID, /if \(answer\.optString\("state"\) != "accepted"\) error\(text\)/);

  for (const words of SAID) assert.ok(ANDROID.includes(words), `Android does not say: ${words}`);
  assert.match(ANDROID, /title = \{ Text\("Forget \$\{PhoneVault\.label\(name\)\}\?"\) \}/);
  assert.match(ANDROID, /TextButton\(enabled = !busy, onClick = \{ forgetting = item\.name \}\) \{\s*Text\("Forget \$\{PhoneVault\.label\(item\.name\)\}"\)/);

  assert.match(ANDROID, /ClaudeSetup\(settings\) \{ scope\.launch \{ reload\(\) \} \}/);
  assert.doesNotMatch(ANDROID, /Forget my Claude login/);
});
