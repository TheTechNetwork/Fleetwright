// Both phones ask for a Claude login before a runner needs one, and say what
// the fleet actually did with a start.
//
//   node --test test/claude-setup-in-apps.test.js
//
// A read of the sources, like the other *-in-apps tests: the Swift and the
// Kotlin compile only in CI.
//
// WRITTEN AFTER A RUNNER REFUSED ITS OWN SESSION. A person signed in, started a
// machine from New session, and it joined with no Claude login: the only place
// to keep one was a field under Credentials that nothing pointed to. And a
// start refused because no machine had reported yet arrived as a notification
// titled "Session ready".

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

const IOS = iosSources();
const ANDROID = androidSources();

// The sentences a person reads, the same on both phones.
const SAID = [
  'Your Claude login is kept under your GitHub account, so sign in to GitHub on this phone first.',
  'Token from claude setup-token',
  'Keep my Claude login',
  'Finish setting up',
  'Set up Claude',
  'Not now',
];

test('iOS: Sessions asks for a Claude login once signed in, and only when it knows none is kept', () => {
  for (const words of SAID) assert.ok(IOS.includes(words), `iOS does not say: ${words}`);
  // FOUR ANSWERS, and the card is drawn for two of them. Cannot tell draws
  // nothing (C-5): a vault that did not answer is not a missing login.
  assert.match(IOS, /enum ClaudeKept: Equatable \{\s*case kept, missing, needsGitHub, cannotTell/);
  assert.match(IOS, /if !claudePutOff, claude == \.missing \|\| claude == \.needsGitHub,/);
  assert.match(IOS, /guard let contents = try\? await PhoneVault\(settings: settings\)\.list\(Fleet\(settings: settings\)\) else \{ return \.cannotTell \}/);
  // The demo fleet has no vault to keep anything in.
  assert.match(IOS, /settings\.configured, !Demo\.isActive\(settings\.coordinatorURL\)/);
});

test('iOS: New session says so when a new machine is chosen with no login kept, and offers the field there', () => {
  assert.match(IOS, /if chosenPlatform != nil, claude == \.missing \|\| claude == \.needsGitHub \{/);
  assert.match(IOS, /ClaudeSetup\(settings: settings\) \{ claude = \.kept \}/);
});

test('iOS: a refused start is not announced as a ready session', () => {
  assert.match(IOS, /LocalNotice\.post\(title: reply\.ok == false \? "Could not start a session" : "Session ready", body: text\)/);
  assert.doesNotMatch(IOS, /LocalNotice\.post\(title: "Session ready"/);
});

test('Android: the same ask, in the same places, with the same words', () => {
  for (const words of SAID) assert.ok(ANDROID.includes(words), `Android does not say: ${words}`);
  assert.match(ANDROID, /enum class ClaudeKept \{ Kept, Missing, NeedsGitHub, CannotTell \}/);
  assert.match(ANDROID, /\?: return ClaudeKept\.CannotTell/);
  assert.match(ANDROID, /if \(!claudePutOff && \(claude == ClaudeKept\.Missing \|\| claude == ClaudeKept\.NeedsGitHub\) &&/);
  assert.match(ANDROID, /settings\.configured && !Demo\.isActive\(settings\.coordinatorUrl\)/);
  assert.match(ANDROID, /if \(platform\.isNotEmpty\(\) && \(claude == ClaudeKept\.Missing \|\| claude == ClaudeKept\.NeedsGitHub\)\) \{/);
  // "Not now" is remembered on the phone, as on iOS.
  assert.match(ANDROID, /prefs\.getBoolean\("claudeSetupPutOff", false\)/);
});

test('Android: a refused start is not announced as a ready session', () => {
  assert.match(ANDROID, /LocalNotice\.post\(context, if \(reply\.ok\) "Session ready" else "Could not start a session",/);
  assert.doesNotMatch(ANDROID, /LocalNotice\.post\(context, "Session ready"/);
});

test('the runner warning in New session is one sentence on both phones', () => {
  const warning = 'No Claude login is kept for your runners, so this one runs on the runner repository';
  assert.ok(IOS.includes(warning) && ANDROID.includes(warning));
});
