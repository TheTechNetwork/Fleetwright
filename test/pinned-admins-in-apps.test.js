// A machine that pins its own admins, drawn on the phones as it is.
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
// What the fields decode to is run by HostPinnedAdminsTests.swift; this reads
// which controls sit behind them, the way every *-in-apps test reads a phone
// that does not build here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';

/** Code without its commentary, so a rule is never confused with a note about one. */
const bare = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const IOS = bare(iosSources());

/** The same sentences on both phones. */
const WORDS = [
  'Pinned admins',
  'Address to pin',
  'This machine takes updates, upgrades, reboots and restoring somebody else’s work only from these people. The last one can be removed only on the machine itself.',
  'This machine takes updates, upgrades and reboots only from the admins pinned on it, and you are not one of them. One of them can add you from their phone.',
];

test('iOS says what a machine’s pins mean in these words', () => {
  for (const words of WORDS) assert.ok(IOS.includes(words), `iOS does not say: ${words}`);
});

test('iOS offers no first pin, and changes pins only as a pinned admin', () => {
  assert.doesNotMatch(IOS, /Pin me/, 'a first pin is the machine’s operator’s, never a phone’s');
  // Only where the machine pins somebody (or cannot read its record), and
  // where the coordinator lets this person administer it at all.
  assert.match(IOS, /if mayAdminister, let admins = health\?\.admins, admins\.count != 0 \{/);
  assert.match(IOS, /if admins\.you == true \{[\s\S]*?ForEach\(pinned, id: \\\.self\)/);
  // The last admin is removed on the machine, so its Remove is not drawn.
  assert.match(IOS, /if pinned\.count > 1 \{\s*Button\("Remove", role: \.destructive\) \{\s*run \{ try await fleet\.pinAdmin\(host: hostId, email: email, add: false\) \}/);
  assert.match(IOS, /run \{ try await fleet\.pinAdmin\(host: hostId, email: email, add: true\) \}/);
  assert.match(IOS, /intent\("pinadmin", params: \["email": email, "op": add \? "add" : "remove"\], host: host\)/);
});

test('iOS draws Update, Upgrade, Reboot and Restore only where the machine takes them from this person', () => {
  assert.match(IOS, /var takesFromYou: Bool \{ count == 0 \|\| you == true \}/);
  assert.match(IOS, /var boxWideAllowed: Bool \{ admins\?\.takesFromYou \?\? true \}/);
  assert.match(IOS, /boxWideAllowed \|\| \(admins\?\.count != nil && item\.isOwn\(me\)\)/);
  assert.match(IOS, /if entry\.restorable \{\s*Button\("Restore"\)/);
  assert.match(IOS, /restorable: host\.health\?\.mayRestore\(\$0, as: settings\.signedInAs\) \?\? true/);
});
