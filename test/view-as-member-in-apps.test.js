// An admin can see the fleet as a member does, on both phones, and it is the
// coordinator's member view rather than the admin's view with rows hidden.
//
//   node --test test/view-as-member-in-apps.test.js
//
// A read of the sources, like the other *-in-apps tests: the Swift and the
// Kotlin compile only in CI. The coordinator's half (that the header makes a
// request a member's, and only ever takes privilege away) is exercised in
// identity.test.js and fleet-do.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

const IOS = iosSources();
const ANDROID = androidSources();

test('both phones send the member view as a header, from the setting, on every authenticated request', () => {
  // Drawing a member's view on the phone would be a claim about what a member
  // sees; asking the coordinator for it is the evidence.
  assert.match(IOS, /if settings\.viewAsMember \{ request\.setValue\("member", forHTTPHeaderField: "x-fleetwright-view"\) \}/);
  assert.match(ANDROID, /if \(settings\.viewAsMember\) setRequestProperty\("x-fleetwright-view", "member"\)/);
});

test('the switch is offered to admins only, and admin-only rows follow the view rather than the role', () => {
  assert.match(IOS, /if settings\.admin == true && !inDemo \{\s*Toggle\("View as a member"/);
  assert.match(IOS, /var showsAdmin: Bool \{ admin == true && !viewAsMember \}/);
  assert.doesNotMatch(IOS, /settings\.admin == true \{\s*NavigationLink\("People"\)/, 'People follows the role, not the view');
  assert.match(ANDROID, /if \(admin == true && !inDemo\) \{[\s\S]{0,300}?Text\("View as a member"/);
  assert.match(ANDROID, /val showsAdmin = admin == true && !viewAsMember/);
});

test('both phones say it on the session list, with the way back beside it', () => {
  // An admin looking at a smaller fleet than theirs, without being told, is a
  // list that quietly shows less.
  for (const [name, src] of [['iOS', IOS], ['Android', ANDROID]]) {
    assert.ok(src.includes('"Viewing as a member"'), `${name} does not say it is in the member view`);
    assert.ok(src.includes('"Switch back"'), `${name} has no way back from the list`);
  }
  // And signing out leaves it, so the next person on this phone starts in
  // their own view.
  assert.match(IOS, /admin = nil\s*\n\s*viewAsMember = false/);
  assert.match(ANDROID, /onSignedOut = \{\s*settings\.viewAsMember = false/);
});
