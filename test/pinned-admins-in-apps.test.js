// A machine that pins its own admins, drawn on both phones as it is.
//
//   node --test test/pinned-admins-in-apps.test.js
//
// The machine says whom it pins in its health (src/fleet/host/pinned-admins.js),
// shaped per person by the coordinator (core.js adminsSeenBy). A phone draws
// Update, Upgrade, Reboot and Restore only where the machine will take them
// from the person holding it (C-2), and nothing about pins on a machine that
// cannot pin. It never offers a first pin: that is set on the machine by
// whoever runs it, because anything a phone sends arrives through the
// coordinator. A pinned admin sees the list and adds or removes the others.
// What the fields decode to is run by HostPinnedAdminsTests.swift and
// PinnedAdminsTest.kt; this reads
// which controls sit behind them, the way every *-in-apps test reads a phone
// that does not build here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

/** Code without its commentary, so a rule is never confused with a note about one. */
const bare = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const IOS = bare(iosSources());
const ANDROID = bare(androidSources());

/** The same sentences on both phones. */
const WORDS = [
  'Pinned admins',
  'Address to pin',
  'This machine takes updates, upgrades, reboots, a new release channel or session image, and restoring somebody else’s work only from these people. The last one can be removed only on the machine itself.',
  'This machine takes updates, upgrades, reboots, a new release channel or session image, and restoring somebody else’s work only from the admins pinned on it, and you are not one of them.',
];

/** Nothing a phone says may promise that somebody can pin this person (C-5): on a stranded machine nobody can. */
const PROMISES = /can add you|can pin you/;

test('both phones say what a machine’s pins mean in the same words', () => {
  for (const words of WORDS) {
    assert.ok(IOS.includes(words), `iOS does not say: ${words}`);
    assert.ok(ANDROID.includes(words), `Android does not say: ${words}`);
  }
  assert.doesNotMatch(IOS, PROMISES);
  assert.doesNotMatch(ANDROID, PROMISES);
});

test('iOS offers no first pin, and changes pins only as a pinned admin', () => {
  assert.doesNotMatch(IOS, /Pin me/, 'a first pin is the machine’s operator’s, never a phone’s');
  // Only where the machine pins somebody (or cannot read its record), and
  // where the coordinator lets this person administer it at all.
  assert.match(IOS, /if mayAdminister, let admins = health\?\.admins, admins\.count != 0 \{/);
  // Not while nobody pinned can sign: the machine would refuse a Pin or a
  // Remove from here, and its sentence is all there is to say.
  assert.match(IOS, /if admins\.you == true && admins\.left == nil \{[\s\S]*?ForEach\(pinned, id: \\\.self\)/);
  assert.match(IOS, /\} else if admins\.left == nil && admins\.count != nil \{/);
  // The last admin is removed on the machine, so its Remove is not drawn.
  assert.match(IOS, /if pinned\.count > 1 \{\s*Button\("Remove", role: \.destructive\) \{\s*run \{ try await fleet\.pinAdmin\(host: hostId, email: email, add: false\) \}/);
  assert.match(IOS, /run \{ try await fleet\.pinAdmin\(host: hostId, email: email, add: true\) \}/);
  assert.match(IOS, /intent\("pinadmin", params: \["email": email, "op": add \? "add" : "remove"\], host: host\)/);
});

test('iOS draws Update, Upgrade, Reboot, the channel, the image and Restore only where the machine takes them from this person', () => {
  assert.match(IOS, /var takesFromYou: Bool \{ count == 0 \|\| \(you == true && left == nil\) \}/);
  assert.match(IOS, /var boxWideAllowed: Bool \{ admins\?\.takesFromYou \?\? true \}/);
  // A person's own restore, unless the machine can check no signature.
  assert.match(IOS, /boxWideAllowed \|\| \(admins\?\.checksSignatures == true && item\.isOwn\(me\)\)/);
  assert.match(IOS, /var checksSignatures: Bool \{ count != nil && stranded != "unchecked" \}/);
  assert.match(IOS, /if entry\.restorable \{\s*Button\("Restore"\)/);
  assert.match(IOS, /restorable: host\.health\?\.mayRestore\(\$0, as: settings\.signedInAs\) \?\? true/);
});

test('Android offers no first pin, and changes pins only as a pinned admin', () => {
  assert.doesNotMatch(ANDROID, /Pin me/, 'a first pin is the machine’s operator’s, never a phone’s');
  assert.match(ANDROID, /if \(administers && admins != null && admins\.count != 0\) \{/);
  assert.match(ANDROID, /if \(admins\.you == true && admins\.left == null\) \{[\s\S]*?pinned\.forEach \{ email ->/);
  assert.match(ANDROID, /\} else if \(admins\.left == null && admins\.count != null\) \{/);
  assert.match(ANDROID, /if \(pinned\.size > 1\) \{\s*TextButton\([\s\S]{0,200}?run \{ it\.pinAdmin\(hostId, email, add = false\) \}/);
  assert.match(ANDROID, /run \{ it\.pinAdmin\(hostId, email, add = true\) \}/);
  assert.match(ANDROID, /intent\("pinadmin", mapOf\("email" to email, "op" to if \(add\) "add" else "remove"\), host = host\)/);
});

test('Android draws Update, Upgrade, Reboot, the channel, the image and Restore only where the machine takes them from this person', () => {
  assert.match(ANDROID, /val takesFromYou: Boolean get\(\) = count == 0 \|\| \(you == true && left == null\)/);
  assert.match(ANDROID, /val boxWideAllowed: Boolean get\(\) = admins\?\.takesFromYou \?: true/);
  assert.match(ANDROID, /boxWideAllowed \|\| \(admins\?\.checksSignatures == true && item\.isOwn\(me\)\)/);
  assert.match(ANDROID, /val checksSignatures: Boolean get\(\) = count != null && stranded != "unchecked"/);
  assert.match(ANDROID, /stranded = a\.optString\("stranded"\)/);
  // `has` first: optInt reads a JSON null as 0, which would make a record the
  // box cannot read into nobody pinned.
  assert.match(ANDROID, /count = a\.takeIf \{ it\.has\("count"\) && !it\.isNull\("count"\) \}\?\.optInt\("count"\)/);
  assert.match(ANDROID, /if \(restorable\) TextButton\(/);
  assert.match(ANDROID, /Triple\(host\.hostId, it, host\.mayRestore\(it, settings\.signedInAs\)\)/);
});
