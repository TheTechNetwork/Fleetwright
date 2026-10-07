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
  'Every lab on this pool is in use. One is free again when its session ends.',
  'A lab is a network of its own on your edge router, and this machine is alone on it. ',
  'It reaches the internet and nothing private: not your network, not the machines behind the router, not another lab.',
  'It reaches the fleet and Claude and nothing else, so the session still runs, and everything else it tries is blocked.',
  ' It costs no extra machine: the lab is an interface on the router you already have.',
  ' When the session ends, or the time runs out, the machine is removed and the lab is free for the next one.',
  'open: it reaches the internet and nothing private',
  'closed: it reaches the fleet and Claude and nothing else',
];

test('iOS: the policy holds the host’s numbers, starts from the edge’s labs, and sends labs only where there is a router', () => {
  assert.ok(I_POLICY.includes(`static let labPrefix = "${LAB.prefix}"`));
  assert.ok(I_POLICY.includes(`static let maxLabs = ${LAB.max}`));
  assert.match(I_POLICY, /if labsChoice, egress != nil, edge \|\| inv\.edge\(on: egress\) != nil \{ out\["labs"\] = \["open": labsOpen, "closed": labsClosed\] \}/);
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

test('iOS says it in the shared words', () => {
  const ios = [I_POLICY, I_FORM, I_FLEET, I_SHEET, I_PAGE].join('\n');
  for (const words of SHARED) assert.ok(ios.includes(words), words);
});
