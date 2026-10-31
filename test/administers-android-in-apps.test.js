// A machine's own controls on the Android phone, drawn only for somebody who
// may use them: its releases, image, labels, software update, system upgrade
// and reboot.
//
//   node --test test/administers-android-in-apps.test.js
//
// A read of the Kotlin, like the other *-in-apps tests: it compiles only in
// CI. The rule itself is run, not read: test/ownership.test.js (place()
// refuses a member's six verbs with not_admin on a machine that does not act
// for them alone) and the snapshot's `administers` beside it. What is pinned
// here is what a person meets (C-2, C-5): an explicit false hides each control
// the coordinator would refuse after the tap, and a coordinator too old to say
// leaves the page as it was, because cannot tell is not no.

import test from 'node:test';
import assert from 'node:assert/strict';

import { androidSources } from './helpers/android-sources.js';

const APP = androidSources();

test('Android: administers is read with a has-check, so an older coordinator is cannot tell', () => {
  assert.match(APP, /val administers: Boolean\? = null,/);
  // optBoolean alone would read a missing key as false and hide every control
  // from an admin whose coordinator predates the field.
  assert.ok(APP.includes('administers = o.takeIf { it.has("administers") && !it.isNull("administers") }?.optBoolean("administers"),'));
  // Only an explicit false hides anything.
  assert.ok(APP.includes('val administers = h?.administers != false'));
});

test('Android: a machine’s update, upgrade, releases, image, labels and reboot are drawn only where this person administers it', () => {
  // Update, upgrade, reboot, the channel and the image: the coordinator's
  // rule, and then the machine's own when it pins its admins (test/pinned-admins-in-apps.test.js),
  // which can only take away.
  assert.ok(APP.includes('val actsOnBox = administers && h?.boxWideAllowed != false'));
  // Check stays for everybody: it reads, and changes nothing.
  assert.match(APP, /OutlinedButton\(enabled = !busy, onClick = \{ run \{ it\.updates\(hostId\) \} \}\) \{ Text\("Check"\) \}\s*if \(h\.appPending && actsOnBox\) \{\s*OutlinedButton\(enabled = !busy, onClick = \{ run \{ it\.update\(hostId, restart = true\) \} \}\) \{ Text\("Apply update"\) \}/);
  assert.match(APP, /if \(administers\) \{[^{}]*?if \(h\.systemPending && h\.grantUpgrades != false && actsOnBox\) \{\s*OutlinedButton\(enabled = !busy, onClick = \{ run \{ it\.upgrade\(hostId, apply = true\) \} \}\)/);
  // Releases and image keep their answer and lose the choice, behind the
  // same gate as update: a machine that pins its admins takes a new channel
  // or image from them alone.
  assert.match(APP, /\} else if \(!actsOnBox\) \{\s*Hint\(current\)\s*\} else \{[\s\S]{0,800}?run \{ it\.channel\(hostId, to = value\) \}/);
  assert.match(APP, /!actsOnBox -> Hint\(if \(v == "browser"\) "Browser" else "No browser"\)\s*else -> Row[\s\S]{0,800}?run \{ it\.sandbox\(hostId, to = value\) \}/);
  // Labels are listed for everybody; Remove and Add only for somebody who may.
  assert.match(APP, /if \(label in setLabels\) \{\s*if \(administers\) \{\s*InputChip\([\s\S]{0,300}?run \{ it\.labels\(hostId, remove = label\) \}/);
  assert.match(APP, /if \(administers\) Row\(Modifier\.fillMaxWidth\(\), verticalAlignment = Alignment\.CenterVertically\) \{\s*OutlinedTextField\(\s*value = newLabel,/);
  // Reboot, both steps, inside the one gate.
  const gate = APP.indexOf('if (h != null && actsOnBox) {');
  assert.ok(gate > 0, 'the reboot section is gated');
  const end = APP.indexOf('if (member != null) {', gate);
  for (const call of ['run { it.reboot(hostId) }', 'run { it.reboot(hostId, rebootPin, rebootConfirm) }']) {
    const at = APP.indexOf(call);
    assert.ok(at > gate && at < end, `${call} is drawn only where this person administers the machine`);
  }
});

test('Android: a member who sees none of them is told why, once', () => {
  assert.match(APP, /if \(!administers\) \{\s*Hint\("Only this fleet’s admin, or the one person this machine works for, can update it, reboot it or change how it is set up\."\)/);
});
