// What a box allows from the app, drawn as what it is: a button only where it
// would work, and the one line on the box everywhere else.
//
// The host sends `updates.grants` — upgrades and reboot, each a root-owned
// sudoers rule on the machine. A phone cannot write that rule and must not be
// able to, so the app's whole part is to say the state and name the line:
// `sudo fleetwright grant reboot on`. Reboot behind a grant that is off used
// to be a button that earned a paragraph, which is the fault C-2 names.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { grantCommand } from '../src/core/grants.js';

const IOS = iosSources();

test('iOS decodes the grants from the frame and from a check, and keeps them across a check that does not say', () => {
  assert.match(IOS, /struct Grants: Codable, Hashable \{\s*let upgrades: Bool\?\s*let reboot: Bool\?\s*\}/);
  assert.match(IOS, /struct Updates: Codable, Hashable \{[\s\S]*?let grants: Grants\?/);
  assert.match(IOS, /struct Waiting: Codable, Hashable \{[\s\S]*?let grants: Grants\?/);
  // An older host's check must not clear what its frame reported.
  assert.match(IOS, /grants: w\.grants \?\? updates\?\.grants/);
});

test('iOS draws Reboot only where the box allows it, and the line where it does not', () => {
  assert.match(IOS, /if health\?\.updates\?\.grants\?\.reboot == false \{[\s\S]*?grantOff\("Reboot from the app is off on this box\.", line: grantLine\("reboot"\)\)[\s\S]*?\} else \{\s*Button\("Reboot", role: \.destructive\)/);
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
  assert.match(IOS, /LabeledContent\("System upgrades"\)[\s\S]*?upgrades \? "allowed" : "not allowed"/);
  assert.match(IOS, /LabeledContent\("Reboot"\)[\s\S]*?reboot \? "allowed" : "not allowed"/);
  assert.match(IOS, /if !upgrades \{ grantOff\("Turning it on is one line on the box:", line: grantLine\("upgrades"\)\) \}/);
  assert.match(IOS, /if !reboot \{ grantOff\("Turning it on is one line on the box:", line: grantLine\("reboot"\)\) \}/);
  // Copyable, and dim: an answer, not a fault.
  assert.match(IOS, /Text\(line\)\s*\.fleetType\(\.labelMono\)[\s\S]*?\.textSelection\(\.enabled\)/);
  assert.match(IOS, /Text\(fact\)\.fleetType\(\.label\)\.foregroundStyle\(Design\.Palette\.inkDim\)/);
});
