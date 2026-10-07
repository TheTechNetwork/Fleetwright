// Labs, on the phones: how many of each kind the edge router has, chosen in
// the pool's policy; a machine put in one from New session › Where, offered
// only while one of that kind is free; and which lab a machine is in, on its
// page.
//
//   node --test test/vm-labs-in-apps.test.js
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. docs/hypervisors.md, "Labs".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LAB } from '../src/fleet/host/edge-router.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const IOS = (/** @type {string} */ f) => read(`apps/ios/Fleetwright/${f}`);
const I_POLICY = IOS('XOPolicy.swift');
const I_FORM = IOS('AddHypervisorView.swift');
const I_FLEET = IOS('Fleet.swift');
const I_SHEET = IOS('StartSheet.swift');
const I_PAGE = IOS('VMMachineView.swift');

/**
 * What both phones say, word for word: what a lab is, what each kind
 * reaches, that it costs no extra machine, and what changing them costs.
 */
const SHARED = [
  'Labs',
  'Open labs',
  'Closed labs',
  ': each reaches the internet and nothing private',
  ': each reaches the fleet and Claude and nothing else',
  'Apply rebuilds the edge router to change the labs: machines behind it have no way out until the new one is up.',
  'A lab is a network of its own on the edge router, for one machine at a time: New session › Where puts a machine in one. ',
  'It costs no extra machine, only an interface on the router. Up to four in all.',
  'Labs are on the edge router, and that pool has none yet. Build the router with them. Nothing was changed.',
  'In a lab',
  'No lab',
  'Open: reaches the internet',
  'Closed: only the fleet and Claude',
  'A lab is a network of its own on your edge router, and this machine is alone on it. ',
  'It reaches the internet and nothing private: not your network, not the machines behind the router, not another lab.',
  'It reaches the fleet and Claude and nothing else, so the session still runs, and everything else it tries is blocked.',
  ' It costs no extra machine: the lab is an interface on the router you already have.',
  'open: it reaches the internet and nothing private',
  'closed: it reaches the fleet and Claude and nothing else',
];

test('iOS: the policy holds the host’s numbers, starts from the edge’s labs, and sends labs only where there is a router', () => {
  assert.ok(I_POLICY.includes(`static let labPrefix = "${LAB.prefix}"`));
  assert.ok(I_POLICY.includes(`static let maxLabs = ${LAB.max}`));
  assert.match(I_POLICY, /if labsChoice, egress != nil, edge \|\| inv\.edge\(on: egress\) != nil \{\s*out\["labs"\] = \["open": labsOpen, "closed": labsClosed\]/);
  assert.match(I_POLICY, /c\.labsOpen = inv\.edge\(on: c\.egress\)\?\.labs\?\.open \?\? 0/);
  assert.match(I_FORM, /canLabs: begun\.can\.contains\("labs"\)/);
  assert.match(I_FORM, /choice\.labsChoice = policyJob\.canLabs && opened\.labMax != nil/);
  // A lab network is the policy's, never a network the fleet's machines go on.
  assert.match(I_POLICY, /!\$0\.name\.hasPrefix\(XOPolicy\.labPrefix\)/);
  // Four in all: each stepper stops where the other leaves off.
  assert.match(I_FORM, /in: 0\.\.\.\(XOPolicy\.maxLabs - choice\.labsClosed\)/);
  assert.match(I_FORM, /in: 0\.\.\.\(XOPolicy\.maxLabs - choice\.labsOpen\)/);
});

test('iOS: a lab is offered only by kind while one is free, rides in `network`, and the page says which', () => {
  assert.match(I_SHEET, /if open \{ Text\("Open: reaches the internet"\)\.tag\("open"\) \}/);
  assert.match(I_SHEET, /if closed \{ Text\("Closed: only the fleet and Claude"\)\.tag\("closed"\) \}/);
  assert.match(I_FLEET, /func freeLab\(open: Bool\) -> Lab\? \{ labs\?\.first \{ \$0\.open == open && \$0\.free \} \}/);
  assert.match(I_SHEET, /!vmLab\.isEmpty \? chosenImage\?\.freeLab\(open: vmLab == "open"\)\?\.id/);
  assert.match(I_SHEET, /return vmLab\.isEmpty \? "vm" : "lab"/);
  assert.match(I_PAGE, /if let lab = m\.lab \{/);
});
/**
 * IN iOS FIRST, and in SHARED once Android says them too: when a lab is free
 * again, which is when its machine ends and not its session, and labs per
 * person.
 */
const IOS_FIRST = [
  'Every lab on this pool is in use. One is free again when its machine ends.',
  ' When its time runs out, or you end it on its page, the machine is removed and the lab is free for the next one.',
  'Labs per person',
  '"No limit"',
  '"At most one at once"',
  ' Labs per person is how many one person may hold at once. With no limit, one person may take every lab that is free.',
  'With no labs, labs per person is no limit. Nothing was changed.',
  ', the labs there are. Nothing was changed.',
];

test('iOS says it in the shared words', () => {
  const ios = [I_POLICY, I_FORM, I_FLEET, I_SHEET, I_PAGE].join('\n');
  for (const words of [...SHARED, ...IOS_FIRST]) assert.ok(ios.includes(words), words);
  // A lab is free again when its machine ends: nothing ends one with its session.
  assert.ok(!/free again when its session ends|When the session ends/.test(ios), 'a lab still said to end with its session');
});

test('iOS: labs per person is offered only by a machine that keeps it, starts from the pool’s, and No limit is sent as null, never 0', () => {
  // C-2: offered only where the machine says it keeps the number, and only with labs to limit.
  assert.match(I_FORM, /canLabsEach: begun\.can\.contains\("labs-each"\)/);
  assert.match(I_FORM, /choice\.labsEachChoice = choice\.labsChoice && policyJob\.canLabsEach/);
  assert.match(I_FORM, /if choice\.labsEachChoice, choice\.labsOpen \+ choice\.labsClosed > 0 \{\s*Stepper\(value: \$choice\.labsEach, in: 0\.\.\.\(choice\.labsOpen \+ choice\.labsClosed\)\)/);
  // C-5: a pool that says nothing is No limit, and No limit goes as null.
  assert.match(I_POLICY, /c\.labsEach = inv\.edge\(on: c\.egress\)\?\.labsEach \?\? 0/);
  assert.match(I_POLICY, /each == 0 \? "No limit"/);
  assert.match(I_POLICY, /if labsEachChoice \{ out\["labsEach"\] = labsEach > 0 \? \(labsEach as Any\) : \(NSNull\(\) as Any\) \}/);
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

test('Android: the policy holds the host’s numbers, starts from the edge’s labs, and sends labs only where there is a router', () => {
  assert.ok(A_POLICY.includes(`const val LAB_PREFIX = "${LAB.prefix}"`));
  assert.ok(A_POLICY.includes(`const val MAX_LABS = ${LAB.max}`));
  assert.match(A_POLICY, /if \(c\.labsChoice && c\.egress != null && \(c\.edge \|\| edgeOn\(inv, c\.egress\) != null\)\) \{\s*put\("labs", JSONObject\(\)\.put\("open", c\.labsOpen\)\.put\("closed", c\.labsClosed\)\)/);
  assert.match(A_POLICY, /labsOpen = edgeOn\(inv, egress\)\?\.labs\?\.open \?: 0,/);
  assert.match(A_SHEET_HV, /canLabs = "labs" in p\.setup\.can/);
  assert.match(A_SHEET_HV, /labsChoice = canLabs && opened\.labMax != null/);
  assert.match(A_POLICY, /it\.name\.startsWith\(LAB_PREFIX\)/);
  assert.match(A_FORM, /max = \(XoPolicy\.MAX_LABS - choice\.labsClosed\)\.toLong\(\),/);
  assert.match(A_FORM, /max = \(XoPolicy\.MAX_LABS - choice\.labsOpen\)\.toLong\(\),/);
});

test('Android: a lab is offered only by kind while one is free, rides in `network`, and the page says which', () => {
  assert.match(A_SHEET, /if \(open\) \{\s*AssistChip\(/);
  assert.match(A_SHEET, /if \(closed\) \{\s*AssistChip\(/);
  assert.match(A_FLEET, /fun freeLab\(open: Boolean\): VmLab\? = labs\?\.firstOrNull \{ it\.open == open && it\.free \}/);
  // Free only when the coordinator said so: anything else is not free.
  assert.match(A_FLEET, /l\.opt\("free"\) == true/);
  assert.match(A_SHEET, /\?\.freeLab\(open = vmLab == "open"\)\?\.id\.takeIf \{ platform == "vm" \}/);
  assert.match(A_SHEET, /platform = \(if \(platform == "vm" && vmLab\.isNotEmpty\(\)\) "lab" else platform\)\.ifBlank \{ null \},/);
  assert.match(A_MAIN, /status = if \(platform == "lab"\) \{/);
  assert.match(A_PAGE, /m\.lab\?\.let \{ l ->/);
});

test('Android says it in the shared words', () => {
  const android = [A_POLICY, A_FORM, A_SHEET_HV, A_FLEET, A_SHEET, A_PAGE].join('\n');
  for (const words of SHARED) assert.ok(android.includes(words), words);
});
