// Both phones offer to pin the signed-in person, and send that.
//
//   node --test test/pinned-admins-in-apps.test.js
//
// The button is the only way a phone starts the pin. Omitting `op` or sending
// a blank address would leave the machine taking the coordinator's word, and
// the sheet would look as if it had done something. The words are the same on
// both phones. The Swift and the Kotlin compile only in CI.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

const IOS = iosSources();
const ANDROID = androidSources();

const WORDS = [
  'Pin me on this machine',
  'Pinned admins',
  'Until somebody is pinned here, this machine takes the fleet’s word for who may reboot it, upgrade it, update it, or restore somebody else’s work. Pinning yourself is the signed record this machine keeps, and only a pinned admin can add another.',
];

test('both phones say what pinning yourself does', () => {
  for (const words of WORDS) {
    assert.ok(IOS.includes(words), `iOS does not say: ${words}`);
    assert.ok(ANDROID.includes(words), `Android does not say: ${words}`);
  }
});

test('a phone pins the signed-in person, and only where they may administer the machine', () => {
  assert.match(IOS, /if mayAdminister && !settings\.signedInAs\.isEmpty/);
  assert.match(IOS, /intent\("pinadmin", params: \["email": email, "op": "add"\]/);
  assert.match(ANDROID, /if \(administers && settings\.signedInAs\.isNotBlank\(\)\)/);
  assert.match(ANDROID, /intent\("pinadmin", mapOf\("email" to email, "op" to "add"\)/);
  assert.match(ANDROID, /heightIn\(min = 48\.dp\),\s*onClick = \{ run \{ it\.pinAdmin\(hostId, settings\.signedInAs\) \} \}/);
});
