// What a box allows from the app, drawn as what it is: a button only where it
// would work, and the one line on the box everywhere else.
//
// The host sends `updates.grants` — upgrades and reboot, each a root-owned
// sudoers rule on the machine. A phone cannot write that rule and must not be
// able to, so the app's whole part is to say the state and name the line:
// `sudo fleetwright grant reboot on`. Reboot behind a grant that is off used
// to be a button that earned a paragraph, which is the fault C-2 names.
//
// SAID ONCE PER PAGE. The grant that is off is said beside its row, with the
// line, and the Reboot button is simply absent below: the page used to say
// "off" and show the line a second time where the button would be, the same
// fact twice on one screen (docs/reviews/copy-2026-11-06.md, 25). The
// mechanism (a root-owned rule) is behind the page's one "How this works".

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';
import { grantCommand } from '../src/core/grants.js';

const IOS = iosSources();
const ANDROID = androidSources();

test('iOS decodes the grants from the frame and from a check, and keeps them across a check that does not say', () => {
  assert.match(IOS, /struct Grants: Codable, Hashable \{\s*let upgrades: Bool\?\s*let reboot: Bool\?\s*\}/);
  assert.match(IOS, /struct Updates: Codable, Hashable \{[\s\S]*?let grants: Grants\?/);
  assert.match(IOS, /struct Waiting: Codable, Hashable \{[\s\S]*?let grants: Grants\?/);
  // An older host's check must not clear what its frame reported.
  assert.match(IOS, /grants: w\.grants \?\? updates\?\.grants/);
});

test('iOS draws Reboot only where the box allows it, and nothing in its place: the line is said once, beside the grant', () => {
  assert.match(IOS, /if health\?\.updates\?\.grants\?\.reboot == false \{[\s\S]*?EmptyView\(\)\s*\} else \{\s*Button\("Reboot", role: \.destructive\)/);
  // The command appears once on the page, under Reboot: Off, and not a
  // second time where the button would be.
  const page = IOS.slice(IOS.indexOf('struct HostView'));
  assert.equal((page.match(/grantLine\("reboot"\)/g) || []).length, 1, 'the reboot line is said once on the machine page');
  // And the system upgrade the same way — nil (an older host) keeps the button.
  assert.match(IOS, /health\?\.updates\?\.systemPending == true && health\?\.updates\?\.grants\?\.upgrades != false/);
  // The line is the host's own command, verbatim, and the app never runs it.
  assert.match(IOS, /"sudo fleetwright grant \\\(name\) on"/);
  assert.equal(grantCommand('reboot'), 'sudo fleetwright grant reboot on');
  assert.doesNotMatch(IOS, /fleet\.grant\(|grant\(host:/, 'the app has no verb to change a grant, on purpose');
});

test('iOS says what the box allows before a button is pressed, and nothing from silence', () => {
  // Only when the host said: an older host sends nothing and gets no section.
  assert.match(IOS, /if let grants = health\?\.updates\?\.grants \{[\s\S]*?sectionHead\("Allowed from the app"\)/);
  assert.match(IOS, /LabeledContent\("System upgrades"\)[\s\S]*?upgrades \? "On" : "Off"/);
  assert.match(IOS, /LabeledContent\("Reboot"\)[\s\S]*?reboot \? "On" : "Off"/);
  assert.match(IOS, /if !upgrades \{ grantOff\("To turn it on, run this on the machine:", line: grantLine\("upgrades"\)\) \}/);
  assert.match(IOS, /if !reboot \{ grantOff\("To turn it on, run this on the machine:", line: grantLine\("reboot"\)\) \}/);
  // The mechanism, once, behind the page's one disclosure.
  assert.match(IOS, /DisclosureGroup\("How this works", isExpanded: \$howGrantsWork\) \{\s*Text\("Each one is a root-owned rule on the machine/);
  // Copyable, and dim: an answer, not a fault.
  assert.match(IOS, /Text\(line\)\s*\.fleetType\(\.labelMono\)[\s\S]*?\.textSelection\(\.enabled\)/);
  assert.match(IOS, /Text\(fact\)\.fleetType\(\.label\)\.foregroundStyle\(Design\.Palette\.inkDim\)/);
});

test('Android parses the grants with a has-check, from the frame and from a check, and keeps them across a check that does not say', () => {
  assert.match(ANDROID, /val grantUpgrades: Boolean\? = null,\s*val grantReboot: Boolean\? = null,/);
  // `has` first, twice: optBoolean turns a missing grant into false, and a
  // host too old to say is not a host that refuses.
  const parses = ANDROID.match(/optJSONObject\("grants"\)\?\.takeIf \{ it\.has\("reboot"\) && !it\.isNull\("reboot"\) \}\?\.optBoolean\("reboot"\)/g) || [];
  assert.equal(parses.length, 2, 'the frame and the check reply both parse the reboot grant honestly');
  assert.match(ANDROID, /grantUpgrades = w\.grantUpgrades \?: host\.grantUpgrades,\s*grantReboot = w\.grantReboot \?: host\.grantReboot,/);
});

test('Android draws Reboot only where the box allows it, and nothing in its place: the line is said once, beside the grant', () => {
  // On the machine's page, as on iOS: no button when the machine refuses,
  // and the line once, under Software, where the grant is said to be off.
  assert.match(ANDROID, /if \(h != null && actsOnBox && h\.grantReboot != false\) \{\s*if \(!rebooting\) \{/);
  assert.match(ANDROID, /h\.grantReboot\?\.let \{ allowed ->\s*if \(!allowed\) \{\s*Hint\("Reboot: Off"\)\s*GrantOff\("To turn it on, run this on the machine:", grantLine\("reboot"\)\)/);
  const page = ANDROID.slice(ANDROID.indexOf('private fun MachinePage('), ANDROID.indexOf('private fun AddMachineSheet('));
  assert.equal((page.match(/grantLine\("reboot"\)/g) || []).length, 1, 'the reboot line is said once on the machine page');
  // (and where the machine takes it from this person: test/pinned-admins-in-apps.test.js)
  assert.match(ANDROID, /if \(h\.systemPending && h\.grantUpgrades != false && actsOnBox\)/);
  // Only the case that is news is said: "allowed" is the ordinary state.
  assert.match(ANDROID, /h\.grantUpgrades\?\.let \{ allowed ->\s*if \(!allowed\) \{\s*Hint\("System upgrades: Off"\)\s*GrantOff\("To turn it on, run this on the machine:", grantLine\("upgrades"\)\)/);
  // The mechanism, once, behind the page's one "How this works".
  assert.match(ANDROID, /Text\("How this works"\)[\s\S]{0,400}?Hint\("Each one is a root-owned rule on the machine/);
  assert.match(ANDROID, /fun grantLine\(name: String\): String = "sudo fleetwright grant \$name on"/);
  // Copyable, and not a fault colour: an answer, not a fault.
  assert.match(ANDROID, /fun GrantOff\(fact: String, line: String\) \{[\s\S]*?SelectionContainer \{\s*Text\(line, style = Design\.Style\.bodySmall, fontFamily = FontFamily\.Monospace/);
  assert.doesNotMatch(ANDROID, /fun grant\(host|\.grant\(host/, 'the app has no verb to change a grant, on purpose');
});

test('both phones name the same line and the same sentence, so a person who reads one is not surprised by the other', () => {
  for (const [name, src] of [['iOS', IOS], ['Android', ANDROID]]) {
    assert.match(src, /To turn it on, run this on the machine:/, `${name} words the fix differently`);
    assert.match(src, /Each one is a root-owned rule on the machine, set by somebody with a shell there\. Nothing on a phone can change it; sudo fleetwright grant does, and sessions keep running\./, `${name} explains the mechanism differently`);
    assert.match(src, /grantLine\("reboot"\)/, `${name} does not name the reboot line`);
    assert.match(src, /grantLine\("upgrades"\)/, `${name} does not name the upgrades line`);
  }
  // And the line is the host's own, so the three cannot drift.
  assert.equal(grantCommand('upgrades'), 'sudo fleetwright grant upgrades on');
});
