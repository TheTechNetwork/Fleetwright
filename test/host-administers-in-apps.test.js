// A machine's releases, image, labels, update, upgrade and reboot, drawn on
// the iPhone only where this person may use them.
//
//   node --test test/host-administers-in-apps.test.js
//
// The coordinator refuses a member those six verbs on a machine that runs
// anybody's work but theirs (scheduler.js, hosts.js administers), and says
// which machines on each snapshot host as `administers`. A control the
// coordinator refuses is the dead control C-2 names, so the page leaves it
// out where the answer is false and still says what each is set to. Absent
// is a coordinator too old to say, cannot tell, and draws everything as
// before (C-5). What false, true and absent decode to is run by
// HostAdministersTests.swift; this reads which controls sit behind it, the
// way every *-in-apps test reads a phone that does not build here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const I = (/** @type {string} */ f) => read(`apps/ios/Fleetwright/${f}`);
/** Code without its commentary, so a rule is never confused with a note about one. */
const bare = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const PAGE = bare(I('HostView.swift'));

test('iOS reads `administers` off each snapshot host, and absent is not no', () => {
  const fleet = bare(I('Fleet.swift'));
  assert.match(fleet, /struct FleetHost: Codable[\s\S]*?var administers: Bool\?[\s\S]*?var mayAdminister: Bool \{ administers != false \}/);
  // The same key the coordinator writes on each snapshot host, once it does.
  const core = bare(read('src/fleet/coordinator/core.js'));
  if (core.includes('administers')) assert.match(core, /hosts: this\.registry\.list\(\)\.map\(\(h\) => \(\{[\s\S]*?\badministers: /);
  // The page is told by the list, and a machine the list has no answer for
  // keeps its controls.
  assert.match(bare(I('MachinesView.swift')), /HostView\([\s\S]*?mayAdminister: reporting\?\.mayAdminister \?\? true,/);
  assert.match(PAGE, /var mayAdminister: Bool = true/);
});

test('iOS: Apply update and Apply system upgrade only where this person may', () => {
  // The coordinator's rule, and then the machine's own when it pins its
  // admins (test/pinned-admins-in-apps.test.js): it can only take away.
  assert.match(PAGE, /private var mayActOnBox: Bool \{ mayAdminister && \(health\?\.boxWideAllowed \?\? true\) \}/);
  assert.match(PAGE, /if mayActOnBox && health\?\.updates\?\.appUpdatePending == true \{\s*Button\("Apply update"\)/);
  assert.match(PAGE, /if mayActOnBox && health\?\.updates\?\.systemPending == true && health\?\.updates\?\.grants\?\.upgrades != false \{\s*Button\("Apply system upgrade"\)/);
  // Check stays: asking what is waiting changes nothing.
  assert.match(PAGE, /Button\("Check for updates"\) \{ run \{ try await fleet\.updates\(host: hostId\) \} \}\s*if mayActOnBox/);
  // Why the rest of the page reads as answers, said once.
  assert.match(PAGE, /if !mayAdminister \{\s*Text\("Only this fleet’s admin, or the one person this machine works for, can update it, reboot it or change how it is set up\."\)/);
});

test('iOS: the channel and the image are said, not offered, where this person may not change them', () => {
  // mayActOnBox: the coordinator's rule, and then a machine's that pins its
  // admins, which takes a new channel or image from them alone
  // (test/pinned-admins-in-apps.test.js).
  assert.match(PAGE, /\} else if let now = channel, !mayActOnBox \{\s*LabeledContent\("Channel"\) \{ Text\(now\)/);
  const image = PAGE.slice(PAGE.indexOf('private var sandboxSection'), PAGE.indexOf('private var labelsSection'));
  assert.ok(image.indexOf('} else if !mayActOnBox {') > 0, 'no read-only image');
  assert.ok(image.indexOf('} else if !mayActOnBox {') < image.indexOf('Picker("Image"'), 'the picker is reachable without asking');
});

test('iOS: labels are listed for everyone, and added or removed only where this person may', () => {
  assert.match(PAGE, /\.swipeActions\(edge: \.trailing\) \{\s*if setLabels\.contains\(label\), mayAdminister \{\s*Button\("Remove"/);
  assert.match(PAGE, /if mayAdminister \{\s*HStack \{\s*TextField\("Add a label"/);
});

test('iOS: Reboot only where this person may, since it ends everybody’s sessions there', () => {
  assert.match(PAGE, /case \.idle:\s*if !mayActOnBox \{\s*EmptyView\(\)\s*\} else if health\?\.updates\?\.grants\?\.reboot == false \{/);
});
