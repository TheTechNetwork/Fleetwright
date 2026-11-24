// The two phones say the same thing about the organization (docs/members.md),
// and say only what they were told.
//
//   node --test test/members-in-apps.test.js
//
// A read of the sources, not a run: the Swift and the Kotlin compile only in
// CI. What a build cannot check is that the OTHER phone uses the same words,
// and here the words carry the rules: whose vault a screen is pointed at,
// whether a member is signed in or was never asked, and what removing one
// costs. What the coordinator and the vault answer is their own tests'
// business (test/members-coordinator.test.js, test/vault.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

const IOS = iosSources();
const ANDROID = androidSources();

test('the words about the organization are the same on both phones', () => {
  for (const words of [
    // The screen, and the two lists on it.
    'Organization',
    'My team',
    'Everyone',
    'Add a member',
    'Could not load the organization.',
    'Try again',
    'No members yet. Add the first one.',
    // A member is a person or an agent, in words on the row.
    '"Person"',
    '"Agent"',
    // A member's page.
    'Reports to',
    'Its sessions open with these.',
    'Stored. Nothing enforces it yet.',
    'Start a session as ',
    "'s credentials",
    // Custody is the vault's answer, and the page says when it has none.
    'Custody',
    'The vault could not be asked.',
    'Nobody administers the organization in your vault yet.',
    'Become its first admin',
    'Custody is not filed for this change yet.',
    'File it',
    'Custodians',
    'Add custodian',
    'Lets their managers manage their credentials.',
    'Has not let their managers manage their credentials.',
    'Has not signed in on a phone yet, so there is no vault to manage.',
    // A person's own switch, under You, Credentials.
    'Your managers',
    'Let my managers manage my credentials',
    'They can keep, test and remove what your vault holds, approve machines for it, and start sessions as you. You can turn this off.',
    'What they changed',
    'Nothing yet.',
    'approved a machine',
    'removed a machine',
    // New session, as a member.
    'Yourself',
    "'s sign-ins, on a machine its custodians approved.",
    // Every member as a file, for an admin.
    'Export as files',
    'Import a file',
    'Paste a member file',
    'Each member is one markdown file: the record, then the instructions. No credential is in one.',
    // What Recent activity calls the three new kinds.
    'Member saved',
    'Member removed',
    'A manager changed your vault',
  ]) {
    assert.ok(IOS.includes(words), `iOS lost: ${words}`);
    assert.ok(ANDROID.includes(words), `Android lost: ${words}`);
  }
});

test('both phones read the list, write one member, and move members as files', () => {
  for (const [name, src] of [['iOS', IOS], ['Android', ANDROID]]) {
    assert.ok(src.includes('get("/api/members")'), `${name} never reads the organization`);
    assert.match(src, /send\("PUT", "\/api\/members\/(?:\\\(id\)|\$id)"/, `${name} cannot save a member`);
    assert.match(src, /send\("DELETE", "\/api\/members\/(?:\\\(id\)|\$id)"/, `${name} cannot remove a member`);
    assert.ok(src.includes('get("/api/members/export")'), `${name} cannot export members`);
    assert.ok(src.includes('"/api/members/import"'), `${name} cannot import a member`);
  }
});

test('a member is signed in, not signed in, or not checked, and a vault that did not answer is never "Not signed in" (C-5)', () => {
  for (const words of ['Signed in to Claude', 'Not signed in', 'Not checked']) {
    assert.ok(IOS.includes(words), `iOS lost: ${words}`);
    assert.ok(ANDROID.includes(words), `Android lost: ${words}`);
  }
  // The answer decides between the first two; no answer is the third.
  assert.match(IOS, /if let contents = try\? await vault\.list\(fleet, for: member\.id\) \{[\s\S]{0,160}\} else \{\s*signIns\[member\.id\] = \.notChecked/);
  assert.match(ANDROID, /contents == null -> MemberSignIn\.NotChecked/);
  // And a phone that cannot ask at all says so for everybody on the team.
  assert.match(IOS, /guard PhoneGitHub\(settings: settings\)\.signedIn else \{\s*for member in team \{ signIns\[member\.id\] = \.notChecked \}/);
  assert.match(ANDROID, /if \(!PhoneGitHub\(settings\)\.signedIn\) \{\s*mine\.forEach \{ signIns\[it\.id\] = MemberSignIn\.NotChecked \}/);
});

test('a request for a member’s vault says whose, and the organization is asked of the vault itself', () => {
  // `for` rides inside the sealed request, only when a member is named.
  assert.match(IOS, /guard let member, !member\.isEmpty else \{ return extra \}\s*var out = extra\s*out\["for"\] = member/);
  assert.match(ANDROID, /if \(member\.isNullOrBlank\(\)\) extra else extra\.put\("for", member\)/);
  for (const [name, src] of [['iOS', IOS], ['Android', ANDROID]]) {
    for (const op of ['"org"', '"orgadmin"', '"orgmember"', '"custodian"', '"custody"']) {
      assert.ok(src.includes(op), `${name} never asks the vault ${op}`);
    }
  }
  // A Claude sign-in made on a machine for a member is kept in that
  // member's vault: the same request, with the member in it.
  assert.match(IOS, /keepClaude\(fleet, token: token, signIn: signIn, for: member\)/);
  assert.match(ANDROID, /keepClaude\(fleet, inside\.optString\("token"\), signIn, member\)/);
});

test('New session sends the member it was asked to start as, signed like any other parameter', () => {
  assert.match(IOS, /if let member, !member\.isEmpty \{ params\["member"\] = member \}/);
  assert.match(ANDROID, /if \(!member\.isNullOrBlank\(\)\) put\("member", member\)/);
  // And a session started as one says so on its row.
  assert.ok(IOS.includes('return "as \\(memberName)"'), 'iOS does not say whom a session runs as');
  assert.ok(ANDROID.includes('"as $it"'), 'Android does not say whom a session runs as');
});

test('Remove asks first, and says what it costs', () => {
  const cost = ' from the organization. Its vault is not deleted; a custodian forgets what it keeps.';
  assert.ok(IOS.includes(cost), 'iOS does not say what removing a member costs');
  assert.ok(ANDROID.includes(cost), 'Android does not say what removing a member costs');
  // The button opens the question; only the question's own button removes.
  assert.match(IOS, /Button\("Remove member", role: \.destructive\) \{ removing = true \}/);
  assert.match(IOS, /\.confirmationDialog\("Remove \\\(shown\.name\)\?"/);
  assert.match(ANDROID, /onClick = \{ removing = true \},[\s\S]{0,120}Text\("Remove member"/);
  assert.match(ANDROID, /title = \{ Text\("Remove \$\{member\.name\}\?"\) \}/);
});

test('the Organization row is drawn only once the fleet answered with its members (C-2)', () => {
  assert.match(IOS, /if let orgCount \{\s*NavigationLink \{\s*OrgView/);
  assert.match(ANDROID, /orgCount\?\.let \{ count ->\s*OpenRow\("Organization"/);
});
