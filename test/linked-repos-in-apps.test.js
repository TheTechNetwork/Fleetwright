// The two phones say the same thing about linked repositories (#346), and
// offer to unlink only what is linked.
//
//   node --test test/linked-repos-in-apps.test.js
//
// A read of the sources, not a run: the Swift and the Kotlin compile only in
// CI, and each phone has a unit test of its own words (LinkedReposTests.swift,
// LinkedReposTest.kt). What neither can check is that the OTHER phone uses the
// same ones — and here the words are the feature: what each role means is said
// at the point of linking, which is where the issue asks for the warning.

import test from 'node:test';
import assert from 'node:assert/strict';
import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

const IOS = iosSources();
const ANDROID = androidSources();

test('the words about each role, and about a session’s archive, are the same on both phones', () => {
  for (const words of [
    // What each role is, said before its button.
    'Private. Each session you start is pushed here, on a branch of its own, before it stops and every ten minutes while it runs. A public repository is refused: this is your work, and possibly a client\'s.',
    'Public, because Actions minutes are free only there. Your temporary machines start here. Anyone can read it, logs included, so it is a launcher and nothing else: no session writes into it.',
    'Public or private. Skills, presets, configs and workflows a session can read when you ask it to. Nothing in it runs by itself.',
    // The controls and the screen.
    'Linked repositories',
    'Check and link',
    'Unlink',
    'Asking the fleet…',
    'The fleet did not say what you have linked: ',
    'Ask again',
    // What is linked, and what a check found.
    'Nothing linked. Sessions you start are not pushed anywhere when they stop.',
    'Linked: ',
    'Private: ',
    'You can push: ',
    'Can write: ',
    'Can read: ',
    'Carries: ',
    'none of the known shapes',
    'none linked',
    // A session's archive before its first push: said, never implied.
    'before it stops. Nothing has been pushed yet.',
  ]) {
    assert.ok(IOS.includes(words), `iOS lost: ${words}`);
    assert.ok(ANDROID.includes(words), `Android lost: ${words}`);
  }
});

test('the same three roles, in the same order, on both phones', () => {
  assert.match(IOS, /let linkedRoles = \["archive", "runners", "templates"\]/);
  assert.match(ANDROID, /val linkedRoles = listOf\("archive", "runners", "templates"\)/);
});

test('unlink is offered only for a role that has a link, and the row only once the fleet answered (C-2)', () => {
  assert.match(IOS, /if links\[role\] != nil \{\s*Button\("Unlink"/);
  assert.match(ANDROID, /if \(links\[role\] != null\) \{\s*TextButton\(/);
  assert.match(IOS, /if let linkedCount \{\s*NavigationLink \{\s*LinkedReposView/);
  assert.match(ANDROID, /linkedCount\?\.let \{ count ->\s*OpenRow\("Linked repositories"/);
});
