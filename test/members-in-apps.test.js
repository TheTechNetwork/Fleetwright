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
    'Dollars a month, at API prices. Approvals decides what happens when it is passed.',
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
    // Whoever added a person manages what they keep, said on their page...
    ' added them, and manages their credentials.',
    'Lets their other managers manage their credentials.',
    'Has not let their other managers manage their credentials.',
    'Stop managing their credentials',
    'This is not given back. After it, managing their credentials is theirs to allow, as it is for their other managers.',
    // ...and to the person, under You, Credentials, before the switch.
    ' added you, and manages your credentials.',
    'They can keep, test and remove what your vault holds, approve machines for it, and start sessions as you. They or an org admin can end this, and you can still remove anything your vault keeps.',
    'Let my other managers manage my credentials',
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

test('a member’s row says what the vault keeps, never that it is signed in, and a vault that did not answer is "Not checked" (C-5)', () => {
  for (const words of ['Keeps a Claude sign-in', 'No Claude sign-in kept', 'Not checked']) {
    assert.ok(IOS.includes(words), `iOS lost: ${words}`);
    assert.ok(ANDROID.includes(words), `Android lost: ${words}`);
  }
  // THE VAULT'S LIST IS NAMES, TIMES AND KINDS (src/fleet/minter/vault.js,
  // `list`). An item named claude is a sign-in somebody kept: nobody tried
  // it, and one that ran out is kept all the same. So no row may say the
  // member is signed in, which is a state nobody checked.
  for (const [name, src] of [['iOS', IOS], ['Android', ANDROID]]) {
    assert.doesNotMatch(src, /(?:return|->) "Signed in to Claude"/, `${name} says a member is signed in on the strength of a kept item`);
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

test('giving up custody of a person is offered to whoever holds it or an org admin of the vault, and asks first (C-2)', () => {
  // The vault refuses anybody else (test/vault.test.js), so the button is
  // drawn for nobody else.
  assert.match(IOS, /if address == me \|\| org\.youAdmin \{\s*Button\("Stop managing their credentials", role: \.destructive\) \{ stopping = address \}/);
  assert.match(ANDROID, /if \(address == me \|\| held\.youAdmin\) \{\s*TextButton\(\s*enabled = !busy,\s*onClick = \{ stopping = address \},/);
  // The first press only opens the question; its own button asks the vault.
  assert.match(IOS, /\.confirmationDialog\("Stop managing their credentials\?"[\s\S]{0,260}Button\("Stop managing", role: \.destructive\) \{\s*if let address = stopping \{\s*act \{ try await vault\.setCustodian\(fleet, member: shown\.id, address: address, remove: true\) \}/);
  assert.match(ANDROID, /title = \{ Text\("Stop managing their credentials\?"\) \},[\s\S]{0,260}act \{ vault\.setCustodian\(Fleet\(settings\), filed\.id, address, remove = true\) \}\s*\}\) \{ Text\("Stop managing"\) \}/);
});

test('removing an agent’s custodian asks first, and is not offered for the last one, which the vault keeps (C-2)', () => {
  for (const words of ['Remove this custodian?', 'Remove custodian', ' stops being a custodian of ', '. Anybody still listed can add them again.']) {
    assert.ok(IOS.includes(words), `iOS lost: ${words}`);
    assert.ok(ANDROID.includes(words), `Android lost: ${words}`);
  }
  // The row's button only opens the question, and is drawn while more than
  // one custodian is left: the vault refuses to remove the last
  // (`last_custodian`, src/fleet/minter/org.js).
  assert.match(IOS, /\.custodians\.count > 1 \{\s*Button\("Remove", role: \.destructive\) \{ (\w+) = address \}/);
  assert.match(ANDROID, /\.custodians\.size > 1\) \{\s*TextButton\(\s*enabled = !busy,\s*onClick = \{ (\w+) = address \},[\s\S]{0,200}?Text\("Remove", /);
  // Only the question's own button asks the vault.
  assert.match(IOS, /\.confirmationDialog\("Remove this custodian\?"[\s\S]{0,260}?Button\("Remove custodian", role: \.destructive\) \{\s*if let address = \w+ \{\s*act \{ try await vault\.setCustodian\(fleet, member: shown\.id, address: address, remove: true\) \}/);
  assert.match(ANDROID, /title = \{ Text\("Remove this custodian\?"\) \},[\s\S]{0,300}?act \{ vault\.setCustodian\(Fleet\(settings\), filed\.id, address, remove = true\) \}\s*\}\) \{ Text\("Remove custodian"\) \}/);
  // And nothing takes a custodian away at a press: every removal sits in a
  // question's own button.
  for (const [name, src, call] of [['iOS', IOS, /setCustodian\([^\n]*remove: true\)/g], ['Android', ANDROID, /setCustodian\([^\n]*remove = true\)/g]]) {
    assert.equal(src.match(call)?.length, 2, `${name} removes a custodian somewhere other than its two questions`);
  }
});

test('a person is told who added them and manages what they keep, with nothing drawn to end it, before the switch for the rest (C-2)', () => {
  // Drawn when either is true, so somebody whose only manager added them
  // still reads it, and the switch only when there is somebody it lets in.
  assert.match(IOS, /if let custody, custody\.member != nil, !\(custody\.custodians\.isEmpty && custody\.managers\.isEmpty\) \{/);
  assert.match(ANDROID, /if \(held != null && held\.member != null && !\(held\.custodians\.isEmpty\(\) && held\.managers\.isEmpty\(\)\)\) \{/);
  assert.match(IOS, /if !custody\.managers\.isEmpty \{\s*Toggle\(/);
  assert.match(ANDROID, /if \(held\.managers\.isNotEmpty\(\)\) \{\s*Row\(/);
});

test('Remove asks first, says what it costs by kind, and tells the vault before the fleet', () => {
  // The cost is the vault's to exact, so it differs by what the member is:
  // an agent's vault goes with it, and a person's stays theirs.
  for (const words of [
    ' from the organization. The vault forgets what it kept and the machines approved for it, and that cannot be undone.',
    ' from the organization. What they keep in the vault is their own and stays theirs.',
    // A phone that cannot ask the vault removes nothing, and says why.
    'Sign in to GitHub under Runners first. Removing a member also tells the vault, which keeps who may use its credentials.',
  ]) {
    assert.ok(IOS.includes(words), `iOS lost: ${words}`);
    assert.ok(ANDROID.includes(words), `Android lost: ${words}`);
  }
  // The button opens the question; only the question's own button removes.
  assert.match(IOS, /Button\("Remove member", role: \.destructive\) \{ removing = true \}/);
  assert.match(IOS, /\.confirmationDialog\("Remove \\\(shown\.name\)\?"/);
  assert.match(ANDROID, /onClick = \{ removing = true \},[\s\S]{0,120}Text\("Remove member"/);
  assert.match(ANDROID, /title = \{ Text\("Remove \$\{member\.name\}\?"\) \}/);
  // THE VAULT FIRST. It keeps its own tree and decides custody from it, so
  // a member removed from the fleet alone kept its place there: a removed
  // person went on holding an agent's credentials. Each phone asks the
  // fleet to remove a member in one place, and in that function the vault
  // was asked before it. The one refusal it goes on after is the vault
  // never having held the member.
  for (const [name, src] of [['iOS', IOS], ['Android', ANDROID]]) {
    const vault = src.search(/fileOrgMember\([^)]*remove(?:: | = )true\)/);
    const fleet = src.indexOf('.removeMember(');
    assert.ok(vault > 0, `${name} never tells the vault a member is removed`);
    assert.ok(fleet > vault, `${name} asks the fleet to remove a member before the vault`);
    assert.equal(src.lastIndexOf('.removeMember('), fleet, `${name} removes a member somewhere that does not tell the vault`);
    const between = src.slice(vault, fleet);
    assert.doesNotMatch(between, /\n\s*(?:\w+ )*(?:func|fun) \w/, `${name} tells the vault and the fleet in different functions`);
    assert.ok(between.includes('"no_member"'), `${name} does not go on when the vault never held the member`);
  }
});

test('File it is drawn only for somebody the vault would take it from, and anybody else reads who files it (C-2)', () => {
  // The vault takes a place from an org admin, or from a manager its own
  // tree already puts above it, and files nobody under a member it does not
  // hold. The button used to be drawn for anybody the fleet lets edit: a
  // team lead's press was refused until an admin had filed every member
  // above theirs, and nothing said so.
  for (const words of [
    "This is an org admin's to file: ",
    'The vault files a member after whoever it reports to, and ',
    ' is not filed yet. An org admin files both: ',
    ' is not filed yet. Go back to Organization to file them all, in order.',
  ]) {
    assert.ok(IOS.includes(words), `iOS lost: ${words}`);
    assert.ok(ANDROID.includes(words), `Android lost: ${words}`);
  }
  // One or the other, never both: the button is what is drawn when there
  // is nobody else to name.
  assert.match(IOS, /if let \w+ = whoFilesInstead\([^\n]*\) \{\s*Text\(\w+\)[\s\S]{0,300}?\} else \{\s*Button\("File it"\)/);
  assert.match(ANDROID, /= whoFilesInstead\([^\n]*\)\s*if \(\w+ != null\) \{\s*[^\n]*\n\s*\} else \{\s*OutlinedButton\([\s\S]{0,400}?Text\("File it"\)/);
  // Every "File it" on a member's page is that one.
  for (const [name, src, button] of [['iOS', IOS, 'Button("File it")'], ['Android', ANDROID, 'Text("File it")']]) {
    assert.equal(src.split(button).length - 1, 1, `${name} draws File it somewhere the vault's answer does not decide`);
  }
});

test('an org admin files every member the vault does not hold in one press, whoever it reports to first, and reads what happened', () => {
  for (const words of [
    'Custody is not filed for 1 member yet.',
    'Custody is not filed for ',
    ' members yet.',
    'File all ',
    'Filing…',
    // What it did, by name, and each refusal with the vault's own sentence.
    ' with the vault: ',
    'Could not file ',
  ]) {
    assert.ok(IOS.includes(words), `iOS lost: ${words}`);
    assert.ok(ANDROID.includes(words), `Android lost: ${words}`);
  }
  // THE ORDER IS THE TREE'S OWN, the one Everyone is drawn in, so a manager
  // is filed before its reports. The vault refuses the other order with
  // "dana is not a member, so nobody can report to it".
  assert.match(IOS, /func membersToFile\([^\n]*\) -> \[Fleet\.Member\] \{\s*orgRows\(members\)/);
  assert.match(ANDROID, /fun membersToFile\([^\n]*\): List<Fleet\.Member> =\s*orgRows\(members\)/);
  // And what is filed is what the vault holds NOW: it is asked again in the
  // same function, before the first member is sent.
  for (const [name, src, open] of [['iOS', IOS, 'func fileAll()'], ['Android', ANDROID, 'fun fileAll()']]) {
    const body = src.slice(src.indexOf(open)).split(/\n {4}\}\n/)[0];
    const asks = body.search(/\.org\(fleet\)/);
    const files = body.search(/\.fileOrgMember\(/);
    assert.ok(asks > 0 && files > asks, `${name} files everybody from an answer it did not just ask for`);
  }
  // The button is the vault's org admin's, and nobody else's (C-2).
  assert.match(IOS, /\w+\?\.youAdmin == true && !\w+\.isEmpty\n[\s\S]{0,1400}?fileAllLabel\(/);
  assert.match(ANDROID, /\w+\?\.youAdmin == true && \w+\.isNotEmpty\(\)\n[\s\S]{0,1400}?fileAllLabel\(/);
});

test('the Organization row is drawn only once the fleet answered with its members (C-2)', () => {
  assert.match(IOS, /if let orgCount \{\s*NavigationLink \{\s*OrgView/);
  assert.match(ANDROID, /orgCount\?\.let \{ count ->\s*OpenRow\("Organization"/);
});

test('an organization that could not be loaded says so under You, with the reason and Try again, and is not drawn as a fleet with none (C-5)', () => {
  // A request that failed and a fleet from before members both drew no row,
  // so a person on a bad connection was shown a fleet with no organization.
  // In the row's place, and only when there is no answer to draw instead:
  const ios = /if let orgCount \{\s*NavigationLink \{\s*OrgView[\s\S]{0,400}?\} else if let (\w+) \{[\s\S]{0,200}?\w+\("Could not load the organization\.", why: \1\)/.exec(IOS)?.[1];
  assert.ok(ios, 'iOS draws nothing where the organization could not be loaded');
  const android = /if \(orgCount == null && (\w+) != null\) \{\s*\w+\("Could not load the organization\.", \1\) \{/.exec(ANDROID)?.[1];
  assert.ok(android, 'Android draws nothing where the organization could not be loaded');
  // The reason is the request's own failure, or the fleet's sentence. An
  // answer with neither a list nor a sentence is a fleet from before
  // members: no reason, so no row, as before.
  assert.match(IOS, new RegExp(`\\} catch \\{\\s*if !Task\\.isCancelled \\{ ${ios} = error\\.localizedDescription \\}`), 'iOS drops why the organization could not be loaded');
  assert.match(IOS, new RegExp(`${ios} = \\(\\w+\\.text \\?\\? ""\\)\\.isBlank \\? nil : \\w+\\.text`), 'iOS takes an answer with no sentence for a failure');
  const whyAndroid = /val (\w+) = (\w+)\s*if \(orgCount == null && \1 != null\)/.exec(ANDROID)?.[2];
  assert.ok(whyAndroid, 'Android has no reason to show');
  assert.match(ANDROID, new RegExp(`\\.onFailure \\{ if \\(it !is [\\w.]+CancellationException\\) ${whyAndroid} = it\\.message \\?: "no answer" \\}`), 'Android drops why the organization could not be loaded');
  assert.match(ANDROID, new RegExp(`\\} else \\{\\s*${whyAndroid} = \\w+\\.text\\s*\\}`), 'Android takes an answer with no sentence for a failure');
  // And the row that says so has the reason under it and a way to ask again.
  assert.match(IOS, /Text\(what\)[\s\S]{0,200}?Text\(why\)[\s\S]{0,260}?Button\("Try again"\) \{ Task \{ await \w+\(\) \} \}/);
  assert.match(ANDROID, /Hint\(what, color = Design\.Palette\.bad\.now\)\s*SelectionContainer \{ Hint\(why\) \}\s*OutlinedButton\(onClick = again[^\n]*\{ Text\("Try again"\) \}/);
});

test('a start from a member’s page is answered on that page on both phones, and a timeout there says where to look', () => {
  // docs/app-parity.md says the two pages are the same. iOS drew the answer
  // under the button; Android moved the person to Sessions, off the member
  // they were looking at, and told a timeout to "Pull to refresh" on a page
  // with nothing to pull.
  assert.match(IOS, /Button\("Start a session as \\\(shown\.name\)"\)[\s\S]{0,700}?RefusedStartView\(settings: settings, refused: \w+\)[\s\S]{0,160}?\} else if !(\w+)\.isBlank \{\s*Text\(\1\)/, 'iOS no longer draws a start’s answer on the member’s page');
  assert.match(ANDROID, /Text\("Start a session as \$\{member\.name\}"\)\s*\}[\s\S]{0,700}?RefusedStartCard\(settings, (\w+)\) \{ onStart\(\1\.request\) \}\s*\} else if \((\w+) != null && \2\.text\.isNotBlank\(\)\) \{\s*SelectionContainer \{ Hint\(\2\.text\) \}/, 'Android does not draw a start’s answer on the member’s page');
  // And the person stays there: what sends a start from under You does not
  // change the tab.
  const you = ANDROID.slice(ANDROID.indexOf('"you" -> YouScreen('));
  const sends = /onStart = \{ request ->([\s\S]{0,240}?)\n {16}\},/.exec(you)?.[1] ?? '';
  assert.match(sends, /startInBackground\(request\)/, 'this no longer reads what sends a start from under You on Android');
  assert.doesNotMatch(sends, /tab = /, 'Android moves a person off the page whose start they pressed');
  // The timeout's sentence, from a page: the session, if there is one, is
  // under Sessions. On Sessions itself both phones still say to pull.
  for (const [name, src] of [['iOS', IOS], ['Android', ANDROID]]) {
    assert.ok(src.includes('Not sure it started. Look under Sessions.'), `${name} lost: Not sure it started. Look under Sessions.`);
    assert.ok(src.includes('Not sure it started. Pull to refresh.'), `${name} lost: Not sure it started. Pull to refresh.`);
  }
});
