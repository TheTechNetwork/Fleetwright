// Machines that work together, on the phones: how many group networks a pool
// has, chosen in its policy; a machine put in one from New session › Where;
// and its group and its address there on the machine's page.
//
//   node --test test/vm-groups-in-apps.test.js
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. ASKED FOR: "the 3 VMs need to reach each other ... a default of
// isolate from each other and only allow outbound". docs/hypervisors.md,
// "Machines that work together".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_GROUPS, GROUP_PREFIX } from '../src/fleet/host/edge-router.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const IOS = (/** @type {string} */ f) => read(`apps/ios/Fleetwright/${f}`);
const I_POLICY = IOS('XOPolicy.swift');
const I_FORM = IOS('AddHypervisorView.swift');
const I_FLEET = IOS('Fleet.swift');
const I_SHEET = IOS('StartSheet.swift');
const I_PAGE = IOS('VMMachineView.swift');

/** What both phones say, word for word. */
const SHARED = [
  'Machines that work together',
  'Groups',
  'Every machine the fleet starts here reaches the internet and nothing else: not your network, and not the other machines. ',
  'A group is for machines that need to talk to each other, like the nodes of a cluster you are testing. ',
  'Machines in the same group share a private network and keep their way to the internet. ',
  'You choose the group when you start a session, under Where. A group stays once it is made, because a machine may be on it.',
  'None, so every machine is on its own',
  ' made when you apply',
  ' there now, ',
  'Group networks are made in the way out’s pool: choose the way out. Nothing was changed.',
  'Work with others on',
  'No group',
  'an address not reported',
];

test('iOS: the policy holds the host’s numbers and sends groups only to a machine that makes them', () => {
  assert.ok(I_POLICY.includes(`static let groupPrefix = "${GROUP_PREFIX}"`));
  assert.ok(I_POLICY.includes(`static let maxGroups = ${MAX_GROUPS}`));
  assert.match(I_POLICY, /if groupsChoice, egress != nil \{ out\["groups"\] = groups \}/);
  assert.match(I_FORM, /canGroups: begun\.can\.contains\("groups"\)/);
  assert.match(I_FORM, /choice\.groupsChoice = policyJob\.canGroups && opened\.groups != nil/);
  // Never fewer than there are: a machine may be on one.
  assert.match(I_POLICY, /min\(inv\.groupCount\(on: egress\), XOPolicy\.maxGroups\)\.\.\.XOPolicy\.maxGroups/);
  // A group network is not offered as a network the fleet's VMs go on, nor as the way out.
  assert.match(I_FORM, /ForEach\(inv\.choosable\) \{ network in\s*Toggle\(isOn: networkBinding/);
  assert.match(I_FORM, /ForEach\(inv\.choosable\.filter/);
});

test('iOS: a machine is put in a group only where the pool has one, and the page says where the others reach it', () => {
  // A machine in a lab joins no group: it is on the lab's network alone.
  assert.match(I_SHEET, /if vmLab\.isEmpty, let groups = chosenImage\?\.groups, !groups\.isEmpty \{/);
  assert.match(I_FLEET, /if let group \{ params\["group"\] = group \}/);
  assert.match(I_SHEET, /group: chosenImage == nil \|\| vmGroup\.isEmpty \|\| !vmLab\.isEmpty \? nil : vmGroup/);
  assert.match(I_PAGE, /if let group = m\.group \{/);
});

test('iOS says it in the shared words', () => {
  const ios = [I_POLICY, I_FORM, I_FLEET, I_SHEET, I_PAGE].join('\n');
  for (const words of SHARED) assert.ok(ios.includes(words), words);
});

// --- Android ------------------------------------------------------------------

const ANDROID = (/** @type {string} */ f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`);
const A_POLICY = ANDROID('XoPolicy.kt');
const A_FORM = ANDROID('PolicyForm.kt');
const A_SHEET_HV = ANDROID('HypervisorSheet.kt');
const A_FLEET = ANDROID('Fleet.kt');
const A_SHEET = ANDROID('StartSheet.kt');
const A_PAGE = ANDROID('VmMachinePage.kt');
const A_MAIN = ANDROID('MainActivity.kt');

test('Android: the policy holds the host’s numbers and sends groups only to a machine that makes them', () => {
  assert.ok(A_POLICY.includes(`const val GROUP_PREFIX = "${GROUP_PREFIX}"`));
  assert.ok(A_POLICY.includes(`const val MAX_GROUPS = ${MAX_GROUPS}`));
  assert.match(A_POLICY, /\.apply \{ if \(c\.groupsChoice && c\.egress != null\) put\("groups", c\.groups\) \}/);
  assert.match(A_SHEET_HV, /canGroups = "groups" in p\.setup\.can/);
  assert.match(A_SHEET_HV, /groupsChoice = canGroups && opened\.groups != null/);
  assert.match(A_POLICY, /minOf\(groupCount\(inv, c\.egress\), MAX_GROUPS\)\.\.MAX_GROUPS/);
  assert.match(A_FORM, /val choosable = XoPolicy\.choosable\(inv\)/);
  assert.match(A_FORM, /choosable\.filter \{ anyWayOut \|\| it\.id in choice\.networks \}/);
});

test('Android: a machine is put in a group only where the pool has one, and the page says where the others reach it', () => {
  assert.match(A_SHEET, /if \(!groups\.isNullOrEmpty\(\)\) \{/);
  assert.match(A_FLEET, /\(if \(group == null\) emptyMap\(\) else mapOf\("group" to group\)\)/);
  // A machine in a lab joins no group: it is on the lab's network alone.
  assert.match(A_SHEET, /group = vmGroup\.ifBlank \{ null \}\.takeIf \{ platform == "vm" && vmLab\.isEmpty\(\) \}/);
  assert.match(A_MAIN, /network = request\.network, group = request\.group\)/);
  assert.match(A_PAGE, /m\.group\?\.let \{ g -> Fact\("Group"/);
});

test('Android says it in the shared words', () => {
  const android = [A_POLICY, A_FORM, A_SHEET_HV, A_FLEET, A_SHEET, A_PAGE].join('\n');
  for (const words of SHARED) assert.ok(android.includes(words), words);
});
