// A phone renews its GitHub sign-in once at a time, keeps what the renewal
// brought back, and drops a sign-in GitHub will not renew.
//
//   node --test test/github-renewal-in-apps.test.js
//
// A read of the sources, like the other *-in-apps tests: the Swift and the
// Kotlin compile only in CI. The minter's half, that a spent refresh token is
// answered `sign_in_again`, is proven in runners-without-a-box.test.js.
//
// WRITTEN AFTER "GitHub did not sign you in: The refresh token passed is
// incorrect or expired." GitHub's refresh tokens work once. Sessions, New
// session and the vault each renewed as they appeared, so two renewals went out
// with the same token and one lost; and the phone kept the dead sign-in, so
// every screen after that failed the same way with no way back but finding
// "Sign out of GitHub".

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

const IOS = iosSources();
const ANDROID = androidSources();

test('iOS: every caller waits on the one renewal in flight, and it outlives the screen that started it', () => {
  assert.match(IOS, /try await Renewal\.shared\.run \{ try await renew\(fleet\) \}/);
  // Shared: a second caller awaits the first's task rather than starting its own.
  assert.match(IOS, /if let running \{ return try await running\.value \}/);
  // Unstructured, so a cancelled `.task` does not drop the new refresh token.
  assert.match(IOS, /let task = Task \{ try await work\(\) \}/);
  // Asked again inside: the renewal waited behind may already have done it.
  assert.match(IOS, /private func renew\(_ fleet: Fleet\) async throws \{[\s\S]{0,400}?if Self\.fresh\(held\) \{ return \}/);
});

test('iOS: a renewal reads the sign-in another Settings may have renewed', () => {
  // A Shortcut builds its own Settings; renewing through it spent the token
  // the app's copy still held.
  assert.match(IOS, /func reloadGithubSignIn\(\) \{\s*let stored = Keychain\.get\("githubSignIn"\) \?\? ""/);
  const reloads = IOS.match(/settings\.reloadGithubSignIn\(\)/g) ?? [];
  assert.equal(reloads.length, 2, 'before deciding to renew, and again inside the renewal');
});

test('iOS: a spent refresh token signs this phone out of GitHub rather than failing every screen', () => {
  assert.match(IOS, /\["code"\] as\? String == "sign_in_again" \{ signOut\(\) \}/);
});

test('Android: every caller waits on the one renewal in flight, and it outlives the screen that started it', () => {
  // One lock for every PhoneGitHub, since each screen builds its own; and
  // NonCancellable inside it, so a LaunchedEffect leaving does not drop the
  // new refresh token.
  assert.match(ANDROID, /renewal\.withLock \{ withContext\(NonCancellable\) \{ renew\(fleet\) \} \}/);
  assert.match(ANDROID, /private companion object \{[\s\S]{0,120}?val renewal = Mutex\(\)/);
  assert.match(ANDROID, /private suspend fun renew\(fleet: Fleet\) \{[\s\S]{0,400}?if \(fresh\(held\)\) return/);
});

test('Android: a spent refresh token signs this phone out of GitHub rather than failing every screen', () => {
  assert.match(ANDROID, /optJSONObject\("error"\)\?\.optString\("code"\) == "sign_in_again"\) signOut\(\)/);
});

test('both phones say the same thing when a sign-in has run out', () => {
  const words = "This phone's GitHub sign-in has run out. Sign in to GitHub again.";
  assert.ok(IOS.includes(words) && ANDROID.includes(words));
});
