// Push is optional. Crashing because it is absent is not.
//
// THE REPORT, from a Play install on 0.2.3+441:
//
//     IllegalStateException: Default FirebaseApp is not initialized in this
//     process network.thetech.fleetwright. Make sure to call
//     FirebaseApp.initializeApp(Context) first.
//     mechanism: UncaughtExceptionHandler   level: fatal
//
// `FirebaseInstallations.getInstance()` reaches for the default FirebaseApp and
// THROWS when there is not one. MainActivity.registerForPush called it bare,
// from `onCreate` and again from `onSignedIn`.
//
// WHICH PUT THE CRASH AT THE END OF ONBOARDING. The `onCreate` call returns
// early while nothing is configured, so a first launch survives; the person
// fills in the settings, signs in, `onSignedIn` fires, and the app dies on the
// last tap of its own setup.
//
// AND THIS REPOSITORY SHIPS A BUILD WITH NO FIREBASE ON PURPOSE.
// app/build.gradle.kts applies the Google Services plugin only
// `if (file("google-services.json").exists())` so that a fork can build at all,
// and says "push simply does nothing for them — which is the honest outcome
// rather than a broken build". That was the intent and not the behaviour: it
// was not doing nothing, it was killing the app. A build with the config but a
// provider that never ran — a cloned or virtualised app container does that to
// a manifest's ContentProviders — lands in the same place.
//
// What is checkable here is the Kotlin as text. It compiles on a CI runner and
// nothing in Node can execute it, which is the same limitation (and the same
// answer) as the Swift rules in sentry-scrub.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { androidSources } from './helpers/android-sources.js';

/** Source with its commentary gone, so a note ABOUT a pattern is not read as one. */
const bare = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const gradle = () =>
  readFileSync(new URL('../apps/android/app/build.gradle.kts', import.meta.url), 'utf8');

test('nothing asks for the default FirebaseApp without checking there is one', () => {
  const app = bare(androidSources());
  // The bare getInstance() is the throw. Its argument-taking sibling is not:
  // it is handed an app that has already been proven to exist.
  assert.equal(
    /FirebaseInstallations\.getInstance\(\s*\)/.test(app),
    false,
    'FirebaseInstallations.getInstance() throws when Firebase is not configured',
  );
  assert.equal(
    /FirebaseApp\.getInstance\(\s*\)/.test(app),
    false,
    'FirebaseApp.getInstance() throws when Firebase is not configured',
  );
});

test('the app initialises Firebase itself rather than assuming the provider ran', () => {
  const app = bare(androidSources());
  // initializeApp rather than a try/catch, because it answers both failures:
  // it is idempotent and hands back the app the provider already made, it
  // makes one when the provider never ran, and it returns null — rather than
  // throwing — when there is genuinely no configuration to read.
  assert.match(app, /FirebaseApp\.initializeApp\(/);
  // And the null is handled, or the next line dereferences it and this test
  // has certified the crash it was written for.
  assert.match(app, /FirebaseApp\.initializeApp\([^)]*\)\s*\n?\s*if \([a-zA-Z]+ == null\)/);
});

test('a build with no Firebase config is still a build this repository expects', () => {
  // The premise of the test above. If the plugin ever becomes unconditional
  // then "no default app" stops being a supported state, and the guard could
  // be argued away — so the two are asserted together rather than separately.
  assert.match(gradle(), /if \(file\("google-services\.json"\)\.exists\(\)\) \{/);
});
