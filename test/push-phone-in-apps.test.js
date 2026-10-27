// Both phones register a push key and open what was sealed to it.
//
//   node --test test/push-phone-in-apps.test.js
//
// Neither phone builds here. What is pinned is the send, the sentence a
// person sees when an envelope does not open, and that the extension which
// rewrites an iOS alert is actually in the app. docs/push-encryption.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const IOS = read('apps/ios/Fleetwright/Fleet.swift');
const PUSH_KEY = read('apps/ios/Fleetwright/PushCrypto.swift');
const NSE = read('apps/ios/FleetwrightPush/NotificationService.swift');
const PROJECT = read('apps/ios/project.yml');
const WORKFLOW = read('.github/workflows/ios.yml');
const ANDROID_FLEET = read('apps/android/app/src/main/java/network/thetech/fleetwright/Fleet.kt');
const ANDROID_MSG = read('apps/android/app/src/main/java/network/thetech/fleetwright/Messaging.kt');
const ANDROID_KEY = read('apps/android/app/src/main/java/network/thetech/fleetwright/PushKey.kt');
const REVEAL = read('apps/android/app/src/main/java/network/thetech/fleetwright/PushCrypto.kt');
const SENDER = read('src/fleet/push.js');

const SENTENCE = 'Something needs you. Open to see.';

test('both phones send the key they can open, and omit it when they have none', () => {
  const ios = IOS.slice(IOS.indexOf('func registerDevice'), IOS.indexOf('func resend'));
  assert.match(ios, /PushKey\.publicKey\(\)/);
  assert.match(ios, /body\["pushKey"\] = pushKey/);
  const android = ANDROID_FLEET.slice(ANDROID_FLEET.indexOf('fun registerDevice'), ANDROID_FLEET.indexOf('fun resend'));
  assert.match(android, /PushKey\.publicKey\(\)/);
  assert.match(android, /\.put\("pushKey", it\)/);
});

test('the sentence a failed open shows is the one the coordinator already sends', () => {
  assert.match(SENDER, new RegExp(SENTENCE.replace(/[.]/g, '\\.')));
  assert.match(REVEAL, new RegExp(`FALLBACK_BODY = "${SENTENCE.replace(/[.]/g, '\\.')}"`));
  // iOS does not keep a second copy. The alert is already that sentence, and
  // a failed open leaves it.
  assert.doesNotMatch(NSE, /content\.title = "Fleetwright"/);
});

test('Android opens the envelope before it reads a kind, and posts when the tray will not', () => {
  const received = ANDROID_MSG.slice(ANDROID_MSG.indexOf('fun onMessageReceived'), ANDROID_MSG.indexOf('private companion object'));
  const reveal = received.indexOf('PushReveal.fields');
  const kind = received.indexOf('XoSetupNotice.EXTRA_KIND');
  assert.ok(reveal !== -1 && kind !== -1 && reveal < kind, 'kind is read before the envelope is opened');
  assert.match(received, /if \(sealed\)/);
  assert.match(ANDROID_MSG, /fun postPlain\(/);
});

test('iOS rewrites the alert in the extension, and drops buttons it could not open', () => {
  assert.match(NSE, /PushKey\.open\(envelope\)/);
  assert.match(NSE, /content\.title = opened\.title/);
  assert.match(NSE, /content\.body = opened\.body/);
  assert.match(NSE, /PushCrypto\.merged/);
  assert.match(NSE, /content\.categoryIdentifier = ""/);
  // The extension reads the app's key. It does not mint its own.
  assert.match(PUSH_KEY, /guard !isExtension else \{ return nil \}/);
  assert.match(PUSH_KEY, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
});

test('the extension is embedded, and its profile is made rather than pasted', () => {
  assert.match(PROJECT, /FleetwrightPush:\s*\n\s*type: app-extension/);
  assert.match(PROJECT, /NSExtensionPointIdentifier: com\.apple\.usernotifications\.service/);
  assert.match(PROJECT, /PRODUCT_BUNDLE_IDENTIFIER: network\.thetech\.fleetwright\.Push/);
  assert.match(PROJECT, /- target: FleetwrightPush/);
  assert.match(PROJECT, /PROVISIONING_PROFILE_SPECIFIER: \$\(FLEETWRIGHT_PUSH_PROFILE\)/);
  // The app's own entitlements are not given a new key. Its profile is a
  // secret, and a key it does not have fails the archive.
  const appEntitlements = PROJECT.slice(PROJECT.indexOf('entitlements:'), PROJECT.indexOf('FleetwrightActivity:'));
  assert.doesNotMatch(appEntitlements, /keychain-access-groups/);
  assert.match(PROJECT, /\$\(AppIdentifierPrefix\)network\.thetech\.fleetwright\.Push/);
  assert.match(PROJECT, /\$\(AppIdentifierPrefix\)network\.thetech\.fleetwright\n/);
  assert.match(WORKFLOW, /BUNDLE_ID: network\.thetech\.fleetwright\.Push/);
  assert.match(WORKFLOW, /FLEETWRIGHT_PUSH_PROFILE="\$PUSH_PROFILE_NAME"/);
  assert.match(WORKFLOW, /<key>\$\{PUSH_BUNDLE_ID\}<\/key><string>\$\{PUSH_PROFILE_NAME\}<\/string>/);
  assert.doesNotMatch(WORKFLOW, /APPLE_PUSH_PROVISIONING_PROFILE/);
  // The keystore key is for agreement, and it does not ask the person.
  assert.match(ANDROID_KEY, /PURPOSE_AGREE_KEY/);
  assert.match(ANDROID_KEY, /setUserAuthenticationRequired\(false\)/);
  assert.match(ANDROID_KEY, /AndroidKeyStore/);
});
