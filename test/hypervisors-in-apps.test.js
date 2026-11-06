// THE ONE HYPERVISORS PAGE, said the same on both phones. Asked for: "unify
// the two hypervisor pages". iOS (HypervisorsView.swift) and Android
// (HypervisorsScreen.kt) each write the page's words, its status line and its
// facts; this holds them equal, and holds both to the coordinator's field.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const swift = read('apps/ios/Fleetwright/HypervisorsView.swift');
const kotlin = read('apps/android/app/src/main/java/network/thetech/fleetwright/HypervisorsScreen.kt');
const machinesIos = read('apps/ios/Fleetwright/MachinesView.swift');
const machinesAndroid = read('apps/android/app/src/main/java/network/thetech/fleetwright/MachinesScreen.kt');

/** Every quoted string in a source, unescaped as far as these need. @param {string} src */
const strings = (src) => new Set([...src.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]));

test('both phones name the same words for the page, by name', () => {
  const ios = Object.fromEntries([...swift.matchAll(/static let (\w+) = "((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1].replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase(), m[2]]));
  const android = Object.fromEntries([...kotlin.matchAll(/const val (\w+) = "((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2]]));
  assert.ok(Object.keys(ios).length >= 9, `found ${Object.keys(ios).length} words in HypervisorsView.swift`);
  assert.deepEqual(android, ios);
});

test('both phones word a hypervisor\'s status, reach and facts the same', () => {
  const a = strings(kotlin);
  for (const said of [
    'reached it', 'could not reach it', 'has not looked yet',
    'On this phone. No machine of the fleet holds its token yet.', 'No machine of the fleet holds its token yet.',
    '1 image', '1 machine', 'older than Proxmox VE 9', ' · ',
    'Not looked at yet. The machines holding it look every few minutes.',
    'Older than Proxmox VE 9, so no machine is made on it.',
    "The datacenter firewall is on, and the fleet's machines are behind it.",
    'The datacenter firewall is off: machines are made only on networks you chose until it is on.',
    '1 machine image', "1 machine of the fleet's on it",
    'Proxmox VE', 'Xen Orchestra', 'Hypervisors', 'Add a hypervisor', 'Which hypervisor is it', 'What each machine saw', 'The hypervisor', 'Set it up again',
    'Host name or address', 'Find it', 'Looking…',
  ]) {
    assert.ok(strings(swift).has(said), `iOS does not say ${JSON.stringify(said)}`);
    assert.ok(a.has(said), `Android does not say ${JSON.stringify(said)}`);
  }
  // THE INTERPOLATED ONES, each in its own language's shape.
  for (const [ios, android] of [
    ['Reached from \\(reached.joined(separator: ", "))', 'Reached from ${reached.joinToString(", ")}'],
    ['No machine reached it. \\(failed.hostId)\\(why)', 'No machine reached it. ${failed.hostId}$why'],
    [
      "Nothing at \\(address) answered as Xen Orchestra or as Proxmox VE, from the fleet's machines or from this phone. Which is it?",
      "Nothing at $address answered as Xen Orchestra or as Proxmox VE, from the fleet's machines or from this phone. Which is it?",
    ],
    // THE PHONE'S OWN LOOK: Proxmox VE's port, or the one named unless it is Xen Orchestra's.
    ['let port = named.flatMap { $0 == 443 ? nil : $0 } ?? 8006', 'val port = named?.takeIf { it != 443 } ?: 8006'],
  ]) {
    assert.ok(swift.includes(ios), `iOS: ${ios}`);
    assert.ok(kotlin.includes(android), `Android: ${android}`);
  }
});

test('Machines has one Hypervisors row on both phones, and no separate Add rows', () => {
  for (const [name, src] of [['iOS', machinesIos], ['Android', machinesAndroid]]) {
    assert.ok(src.includes('"Hypervisors"'), `${name}: no Hypervisors row`);
    assert.ok(!src.includes('"Add Proxmox VE"'), `${name}: Add Proxmox VE is still its own row`);
    assert.ok(!src.includes('"Add a hypervisor"'), `${name}: Add a hypervisor is still on Machines`);
  }
});

test('both phones read the field the coordinator sends', () => {
  const core = read('src/fleet/coordinator/core.js');
  assert.match(core, /hypervisors: this\.hypervisorsFor\(requester\)/);
  assert.match(read('apps/ios/Fleetwright/Fleet.swift'), /let hypervisors: \[Hypervisor\]\?/);
  assert.match(read('apps/android/app/src/main/java/network/thetech/fleetwright/Fleet.kt'), /optJSONArray\("hypervisors"\)/);
  for (const field of ['address', 'kind', 'boxes', 'hostId', 'reachable', 'problem', 'pools', 'version', 'supported', 'fenced', 'images', 'machines']) {
    assert.match(core, new RegExp(`\\b${field}\\b`), field);
  }
});
