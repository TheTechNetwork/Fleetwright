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
  'Let my machines use this pool',
  'Machines from this pool',
  'Your approved machines can then create VMs here.',
  'Make the machine image for sessions',
  'Debian 13 · 20 GiB disk · 220 MB download · about 10 min',
  'Nothing in the way out’s pool has 20 GiB free for the machine image’s disk.',
  'The machine image is built behind the edge router, and that pool has none yet. Build the router with it.',
  // New session's footer and the start's status, in one sentence each
  // (docs/reviews/copy-2026-11-06.md, 6, 39, 40).
  'Ready in about 2 minutes. Deleted with its files when time runs out.',
  "Set up Claude first, or this session can't start.",
  "Your session starts when it's ready.",
];

test('iOS: a machine from your hypervisor is asked of the fleet, never of GitHub, with the image it is cloned from', () => {
  // Nor is one in a lab, which is the same machine on a lab's network.
  assert.match(IOS_FLEET, /if platform != "vm", platform != "lab", phone\.signedIn \{/);
  assert.match(IOS_FLEET, /if let template \{ params\["template"\] = template \}/);
  assert.match(IOS_FLEET, /struct Reply: Codable \{ let vmImages: \[VMImage\]\? \}/);
  assert.match(IOS_VIEW, /\.provision\(platform: platform, minutes: request\.minutes, start: start, template: request\.template,\s*network: request\.network, group: request\.group, image: request\.runnerImage\)/);
});

test('iOS: New session offers a machine from each of your images, drawn from the snapshot and nothing else', () => {
  assert.match(IOS_SHEET, /images = \(try\? await fleet\.vmImages\(\)\) \?\? \[\]/);
  assert.match(IOS_SHEET, /ForEach\(images\) \{ image in\s*Text\(standby\?\.template == image\.template[\s\S]{0,120}image\.label\)\s*\.tag\(vmImageTag \+ image\.template\)/);
  assert.match(IOS_SHEET, /if hosts\.count > 1 \|\| canStartMachine \|\| !images\.isEmpty \{/);
  assert.match(IOS_SHEET, /template: chosenImage\?\.template,/);
  assert.match(IOS_FLEET, /var label: String \{ "New machine from \\\(name\) on \\\(onProxmox \? "Proxmox" : "XCP-ng"\)" \}/);
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
  assert.match(IOS_POLICY, /if imageChoice, wantsImage \{\s*if imagesChoice \{[\s\S]*?\} else \{\s*out\["image"\] = true\s*\}/);
  assert.match(IOS_POLICY, /static let imageDiskBytes: Int64 = 20 \* 1024 \* 1024 \* 1024/);
});

test('iOS says it in the shared words', () => {
  const ios = [IOS_FLEET, IOS_SHEET, IOS_VIEW, IOS_HANDOFF, IOS_SCREEN, IOS_POLICY].join('\n');
  for (const words of SHARED) assert.ok(ios.includes(words), words);
});

// --- Android ------------------------------------------------------------------

const ANDROID = (/** @type {string} */ f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`);
const A_FLEET = ANDROID('Fleet.kt');
const A_SHEET = ANDROID('StartSheet.kt');
const A_MAIN = ANDROID('MainActivity.kt');
const A_VAULT = ANDROID('PhoneVault.kt');
const A_HANDOFF = ANDROID('XoHandoff.kt');
const A_HYPER = ANDROID('HypervisorSheet.kt');
const A_FORM = ANDROID('PolicyForm.kt');
const A_POLICY = ANDROID('XoPolicy.kt');

test('Android: a machine from your hypervisor is asked of the fleet, never of GitHub, with the image it is cloned from', () => {
  // Nor is one in a lab, which is the same machine on a lab's network.
  assert.match(A_FLEET, /if \(platform != "vm" && platform != "lab" && phone\.signedIn\) \{/);
  assert.match(A_FLEET, /if \(template == null\) mapOf\("platform" to platform\) else mapOf\("platform" to platform, "template" to template\)/);
  assert.match(A_FLEET, /get\("\/api\/hosts"\)\.optJSONArray\("vmImages"\)/);
  assert.match(A_MAIN, /fleet\.provision\(platform, minutes = request\.minutes, start = start, template = request\.template, network = request\.network, group = request\.group, image = request\.runnerImage\)/);
});

test('Android: New session offers a machine from each of your images, drawn from the snapshot and nothing else', () => {
  assert.match(A_SHEET, /images = Fleet\(settings\)\.vmImages\(\)\.getOrDefault\(emptyList\(\)\)/);
  assert.match(A_SHEET, /if \(hosts\.size > 1 \|\| canStartMachine \|\| images\.isNotEmpty\(\)\) \{/);
  assert.match(A_SHEET, /template = template\.ifBlank \{ null \}\.takeIf \{ platform == "vm" \},/);
  assert.match(A_FLEET, /val label: String get\(\) = "New machine from \$name on \$\{if \(onProxmox\) "Proxmox" else "XCP-ng"\}"/);
});

test('Android: the pool’s token is kept in the fleet under its address, after setup and on asking', () => {
  assert.match(A_VAULT, /JSONObject\(\)\.put\("name", "hypervisor:\$address"\)\.put\("value", record\)/);
  assert.match(A_HANDOFF, /if \(outcome != Outcome\.Kept \|\| address == null\) return outcome to null/);
  assert.match(A_HANDOFF, /setup\.state == "done" -> collectAndKeep\(settings, fleet, entry\.job, setup\)/);
  assert.match(A_HYPER, /fleetNote = XoHandoff\.keepInFleet\(settings, fleet, address\.trim\(\)\)/);
});

test('Android: the machine image is offered only by a machine that builds one, where there is none, behind the router', () => {
  assert.match(A_HYPER, /canImage = "image" in p\.setup\.can/);
  assert.match(A_FORM, /if \(canImage && choice\.egress != null\) \{/);
  assert.match(A_FORM, /onChange = \{ on -> onChange\(choice\.copy\(image = on, edge = choice\.edge \|\| \(on && there == null\)\)\) \}/);
  assert.match(A_POLICY, /if \(c\.imageChoice && c\.wantsImage\) \{\s*if \(c\.imagesChoice\) \{[\s\S]*?\} else \{\s*put\("image", true\)\s*\}/);
  assert.match(A_POLICY, /const val IMAGE_DISK = 20L \* 1024 \* 1024 \* 1024/);
});

test('both phones say it in the same words', () => {
  const ios = [IOS_FLEET, IOS_SHEET, IOS_VIEW, IOS_HANDOFF, IOS_SCREEN, IOS_POLICY].join('\n');
  const android = [A_FLEET, A_SHEET, A_MAIN, A_HANDOFF, A_HYPER, A_FORM, A_POLICY].join('\n');
  for (const words of SHARED) {
    assert.ok(ios.includes(words), `iOS: ${words}`);
    assert.ok(android.includes(words), `Android: ${words}`);
  }
});

// WHERE A MACHINE GOES, asked of a list whose every image ended "on
// fleetwright": "Is it on proxmox or on xcp where is it going to go?" The
// kind alone, "if we need sub pickers from there we can do it", in the same
// words on both phones and in the coordinator's record of the request.
test('both phones and the coordinator say which hypervisor a new machine goes on, and only that', async () => {
  const { imageWhere } = await import('../src/fleet/coordinator/core.js');
  assert.equal(imageWhere('proxmox'), 'Proxmox');
  assert.equal(imageWhere('xo'), 'XCP-ng');
  // A coordinator older than Proxmox VE gives no kind, and was Xen Orchestra.
  assert.equal(imageWhere(null), 'XCP-ng');
  for (const [name, src] of [['iOS', IOS_FLEET], ['Android', A_FLEET]]) {
    assert.ok(src.includes('"Proxmox"') && src.includes('"XCP-ng"'), `${name} says the kinds otherwise`);
  }
});
