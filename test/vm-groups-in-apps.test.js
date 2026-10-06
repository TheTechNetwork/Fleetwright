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
  'Group networks',
  'A machine behind the edge router is fenced from every other: only the router may open a connection to it. ',
  'A group network has no way off the pool, and machines started in the same group reach each other on it. ',
  'New session › Where puts a machine in one.',
  ' there now, ',
  ' made when you apply',
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
  assert.match(I_SHEET, /if let groups = chosenImage\?\.groups, !groups\.isEmpty \{/);
  assert.match(I_FLEET, /if let group \{ params\["group"\] = group \}/);
  assert.match(I_SHEET, /group: chosenImage == nil \|\| vmGroup\.isEmpty \? nil : vmGroup/);
  assert.match(I_PAGE, /if let group = m\.group \{/);
});

test('iOS says it in the shared words', () => {
  const ios = [I_POLICY, I_FORM, I_FLEET, I_SHEET, I_PAGE].join('\n');
  for (const words of SHARED) assert.ok(ios.includes(words), words);
});
