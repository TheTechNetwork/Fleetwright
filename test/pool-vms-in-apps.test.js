// Machines from your own hypervisor, on the phones: the pool's token kept in
// the fleet, the machine image offered in the policy, and a new machine from
// it under New session › Where.
//
//   node --test test/pool-vms-in-apps.test.js
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. What is pinned is what each screen offers and sends, and that both
// phones say it in the same words (docs/app-parity.md). ASKED FOR: "Still
// can't run sessions on it". docs/hypervisors.md, "Machines from your pool".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const IOS_FLEET = read('apps/ios/Fleetwright/Fleet.swift');
const IOS_SHEET = read('apps/ios/Fleetwright/StartSheet.swift');
const IOS_VIEW = read('apps/ios/Fleetwright/FleetView.swift');
const IOS_VAULT = read('apps/ios/Fleetwright/PhoneVault.swift');
const IOS_HANDOFF = read('apps/ios/Fleetwright/XOSetupHandoff.swift');
const IOS_SCREEN = read('apps/ios/Fleetwright/AddHypervisorView.swift');
const IOS_POLICY = read('apps/ios/Fleetwright/XOPolicy.swift');

/** What both phones say, word for word. */
const SHARED = [
  'Keep its token in the fleet',
  'Machines from this pool',
  'The boxes you approved can then make machines on it for your sessions. They hold its token in memory only, ',
  'Make the machine image for sessions',
  'about 220 MB, and installs Fleetwright on it, which takes about ten minutes. Sessions can then start on a new ',
  'Nothing in the way out’s pool has 20 GiB free for the machine image’s disk.',
  'The machine image is built behind the edge router, and that pool has none yet. Build the router with it.',
  'It is cloned from your machine image and joins in a minute or two. The session starts on it then',
  ' It powers off when the time runs out and is removed, with everything on it.',
  'No Claude login is kept in your vault, so a machine from your hypervisor has nothing to run ',
  'Asking your hypervisor for a ',
];

test('iOS: a machine from your hypervisor is asked of the fleet, never of GitHub, with the image it is cloned from', () => {
  assert.match(IOS_FLEET, /if platform != "vm", phone\.signedIn \{/);
  assert.match(IOS_FLEET, /if let template \{ params\["template"\] = template \}/);
  assert.match(IOS_FLEET, /struct Reply: Codable \{ let vmImages: \[VMImage\]\? \}/);
  assert.match(IOS_VIEW, /\.provision\(platform: platform, minutes: request\.minutes, start: start, template: request\.template\)/);
});

test('iOS: New session offers a machine from each of your images, drawn from the snapshot and nothing else', () => {
  assert.match(IOS_SHEET, /images = \(try\? await fleet\.vmImages\(\)\) \?\? \[\]/);
  assert.match(IOS_SHEET, /ForEach\(images\) \{ image in\s*Text\(image\.label\)\.tag\(vmImageTag \+ image\.template\)/);
  assert.match(IOS_SHEET, /if hosts\.count > 1 \|\| canStartMachine \|\| !images\.isEmpty \{/);
  assert.match(IOS_SHEET, /template: chosenImage\?\.template,/);
  assert.match(IOS_FLEET, /var label: String \{ "New machine from \\\(name\)" \+ \(poolName\.map \{ " on \\\(\$0\)" \} \?\? ""\) \}/);
});

test('iOS: the pool’s token is kept in the fleet under its address, after setup and on asking', () => {
  assert.match(IOS_VAULT, /extra: \["name": "hypervisor:\\\(address\)", "value": record\]/);
  assert.match(IOS_HANDOFF, /guard outcome == \.kept, let address else \{ return \(outcome, nil\) \}/);
  assert.match(IOS_HANDOFF, /_ = await collectAndKeep\(job: entry\.job, state: state, settings: fleet\.settings\)/);
  assert.match(IOS_SCREEN, /if let pool = policyFor, job == nil \{ fleetSection\(pool\) \}/);
});

test('iOS: the machine image is offered only by a machine that builds one, where there is none, behind the router', () => {
  assert.match(IOS_SCREEN, /canImage: begun\.can\.contains\("image"\)/);
  assert.match(IOS_SCREEN, /if policyJob\?\.canImage == true, choice\.egress != nil \{/);
  assert.match(IOS_SCREEN, /if on, there == nil \{ choice\.edge = true \}/);
  assert.match(IOS_POLICY, /if imageChoice, image \{ out\["image"\] = true \}/);
  assert.match(IOS_POLICY, /static let imageDiskBytes: Int64 = 20 \* 1024 \* 1024 \* 1024/);
});

test('iOS says it in the shared words', () => {
  const ios = [IOS_FLEET, IOS_SHEET, IOS_VIEW, IOS_HANDOFF, IOS_SCREEN, IOS_POLICY].join('\n');
  for (const words of SHARED) assert.ok(ios.includes(words), words);
});
