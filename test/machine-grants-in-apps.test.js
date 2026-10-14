// What the machines made on a pool may do from the app, chosen on the
// pool's policy: offered only by a box that applies it, sent with Apply,
// kept with the pool's record once the job is done, and said in the same
// words on both phones.
//
//   node --test test/machine-grants-in-apps.test.js
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. The payload itself is run, not read: XOPolicyTests.swift and
// XoPolicyTest.kt. The box's half is test/xo-pools.test.js, xo-holder.test.js
// and grants.test.js. ASKED FOR: "Should be a toggle where we can either
// enable it on vms or not". docs/hypervisors.md, "Machines made here".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const A = (/** @type {string} */ f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`);
const I = (/** @type {string} */ f) => read(`apps/ios/Fleetwright/${f}`);

const PHONES = [
  { name: 'iOS', form: I('AddHypervisorView.swift'), policy: I('XOPolicy.swift'), sheet: I('AddHypervisorView.swift'), record: I('XOSetupHandoff.swift') },
  { name: 'Android', form: A('PolicyForm.kt'), policy: A('XoPolicy.kt'), sheet: A('HypervisorSheet.kt'), record: A('XoHandoff.kt') },
];

/** What both phones say, word for word. A sentence is split where both break the line. */
const SAID = [
  'Machines made here',
  'Update their system from the app',
  'Sessions keep running while it updates.',
  'Reboot from the app',
  'A reboot ends every session on that machine.',
  'Each machine made on this pool from now on starts with these answers, the pool’s own machine included. ',
  'One already running keeps what it has. To change it, run sudo fleetwright grant upgrades on, or reboot on, on that machine.',
];

test('both phones say it in the same words', () => {
  for (const p of PHONES) {
    for (const s of SAID) assert.ok(p.form.includes(s) || p.policy.includes(s), `${p.name}: ${s}`);
  }
});

test('the switches are offered only by a box that says machine-grants (C-2)', () => {
  for (const p of PHONES) {
    assert.ok(p.sheet.includes('"machine-grants"'), `${p.name}: read from begin's can`);
    const offer = p.name === 'iOS' ? 'if choice.grantsChoice { machineGrantsSection() }' : 'if (choice.grantsChoice) {\n        SectionHead("Machines made here")';
    assert.ok(p.form.includes(offer), `${p.name}: the section is behind it`);
  }
});

test('Apply sends both answers, and the done job keeps them with the pool before it is kept in the fleet', () => {
  for (const p of PHONES) {
    assert.match(p.policy, p.name === 'iOS' ? /if grantsChoice \{ out\["grants"\] = \["upgrades": machineUpdates, "reboot": machineReboot\] \}/ : /if \(c\.grantsChoice\) put\("grants", JSONObject\(\)\.put\("upgrades", c\.machineUpdates\)\.put\("reboot", c\.machineReboot\)\)/, p.name);
    const kept = p.sheet.indexOf('keepMachineGrants(');
    assert.ok(kept > 0, `${p.name}: kept with the record`);
    assert.match(p.sheet.slice(kept - 300, kept), /"done"/, `${p.name}: only once the job is done`);
    assert.match(p.sheet.slice(kept, kept + 300), /keepInFleet\(/, `${p.name}: and then in the fleet, where the boxes read it`);
    // The same field the box reads (src/fleet/host/xo-pools.js, poolRecord).
    assert.ok(p.record.includes('"grants"'), `${p.name}: under grants`);
  }
});
