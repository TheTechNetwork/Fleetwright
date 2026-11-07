// THE ONE HYPERVISORS PAGE, said the same on both phones. Asked for: "unify
// the two hypervisor pages". iOS (HypervisorsView.swift) and Android
// (HypervisorsScreen.kt) each write the page's words, its status line and its
// facts; this holds them equal, and holds both to the coordinator's field.
//
// THE WORDS ARE THE REVIEW'S (docs/reviews/copy-2026-11-06.md, finding 59): a
// row says one status from a fixed set, the page leads with one sentence, and
// Add shows both kinds always, with "Couldn't tell" above them when nothing
// answered. §7 stays: "cannot tell" is Unknown or Not checked, never "none".

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

/** The named words of each phone, UPPER_SNAKE on both so they compare by name. */
const iosWords = Object.fromEntries([...swift.matchAll(/static let (\w+) = "((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1].replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase(), m[2]]));
const androidWords = Object.fromEntries([...kotlin.matchAll(/const val (\w+) = "((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2]]));

test('both phones name the same words for the page, by name', () => {
  assert.ok(Object.keys(iosWords).length >= 18, `found ${Object.keys(iosWords).length} words in HypervisorsView.swift`);
  assert.deepEqual(androidWords, iosWords);
});

test('a row says one status from the fixed set, and the page one sentence', () => {
  // THE ROW: a verdict in one to three words, never a sentence, never a count
  // or a machine's name. Trouble is the three the ring marks.
  assert.deepEqual(
    ['READY', 'CANT_REACH', 'WAITING', 'NEEDS_PVE9', 'CHECKING', 'UNKNOWN'].map((k) => iosWords[k]),
    ['Ready', "Can't reach", 'Waiting for a machine', 'Needs Proxmox VE 9', 'Checking', 'Unknown'],
  );
  for (const [name, src] of [['iOS', swift], ['Android', kotlin]]) {
    const status = src.match(/(?:static func|fun) status\([\s\S]*?(?:static func|fun) answer\(/)?.[0] ?? '';
    assert.ok(status, `${name}: no status function`);
    assert.ok(!/" [·:]|\. [A-Z]/.test(status), `${name}: the row's status is a sentence again`);
    assert.ok(!/hostId|images|machines\b/.test(status.replace(/\bmachine\b/g, '')), `${name}: the row names machines or counts`);
  }
  // §7, AS A WORD: a pool the fleet did not list is "waiting" only when the
  // fleet answered and left it out; when the fleet did not answer it is Unknown.
  assert.match(swift, /guard let h else \{ return answered && onPhone \? waiting : unknown \}/);
  assert.match(kotlin, /if \(h == null\) return if \(answered && onPhone\) WAITING else UNKNOWN/);
  assert.match(swift, /HypervisorWords\.status\(row\.fleet, onPhone: row\.onPhone, answered: fleet != nil\)/);
  assert.match(kotlin, /HypervisorWords\.status\(row\.fleet, row\.onPhone, answered = fleet != null\)/);
  // THE RING keeps its logic: nothing of the fleet's can use it, or too old.
  assert.match(swift, /guard let h else \{ return !onPhone \}\s*if h\.boxes\.isEmpty \{ return true \}/);
  assert.match(kotlin, /if \(h == null\) return !onPhone\s*if \(h\.boxes\.isEmpty\(\)\) return true/);
  // THE PAGE: one sentence first, then Machines, then Details.
  for (const [name, src] of [['iOS', swift], ['Android', kotlin]]) {
    const page = src.slice(src.indexOf('HypervisorWords.answer(row.fleet)'));
    assert.ok(page.indexOf('"Machines"') > 0 && page.indexOf('"Details"') > page.indexOf('"Machines"'), `${name}: the page is not sentence, Machines, Details`);
  }
});

test('both phones word a hypervisor\'s status, reach and facts the same', () => {
  const a = strings(kotlin);
  for (const said of [
    'Reached', "Can't reach", 'Not checked',
    'Unknown. Your fleet said nothing about it.', 'Waiting for a machine to pick it up.',
    'Needs Proxmox VE 9. No machine is made on it.', "Can't reach it. No machine got through.", 'Checking. No machine has checked it yet.',
    'Datacenter firewall on', 'Datacenter firewall off: machines only on networks you chose',
    '1 image', '1 machine made on it',
    'Proxmox VE', 'Xen Orchestra', 'Hypervisors', 'Add a hypervisor', 'Which hypervisor is it', 'Machines', 'Details', 'Set it up again',
    'Host name or address', 'Find it', 'Checking…',
  ]) {
    assert.ok(strings(swift).has(said), `iOS does not say ${JSON.stringify(said)}`);
    assert.ok(a.has(said), `Android does not say ${JSON.stringify(said)}`);
  }
  // THE INTERPOLATED ONES, each in its own language's shape.
  for (const [ios, android] of [
    ['Ready. \\(reached.joined(separator: ", ")) \\(reached.count == 1 ? "makes" : "make") machines on it.', 'Ready. ${reached.joinToString(", ")} ${if (reached.size == 1) "makes" else "make"} machines on it.'],
    ['"Updated \\(when)"', '"Updated $time"'],
    ['"Couldn\'t tell what\'s at \\(address). Pick one."', '"Couldn\'t tell what\'s at $address. Pick one."'],
    [
      '"\\(machines.joined(separator: ", ")) \\(machines.count == 1 ? "needs" : "need") an update to check for Proxmox VE."',
      '"${machines.joinToString(", ")} ${if (machines.size == 1) "needs" else "need"} an update to check for Proxmox VE."',
    ],
    // A MACHINE THAT NEVER LOOKED is named, by the same test on both phones.
    ['let didNotLook = probes.filter { $0.pveLooked != true && $0.through != "phone" }.map(\\.hostId)', 'val didNotLook = probes.filter { it.pveLooked != true && it.through != "phone" }.map { it.hostId }'],
    // THE PHONE'S OWN LOOK: Proxmox VE's port, or the one named unless it is Xen Orchestra's.
    ['let port = named.flatMap { $0 == 443 ? nil : $0 } ?? 8006', 'val port = named?.takeIf { it != 443 } ?: 8006'],
  ]) {
    assert.ok(swift.includes(ios), `iOS: ${ios}`);
    assert.ok(kotlin.includes(android), `Android: ${android}`);
  }
});

test('Add shows both kinds always, marks the one found, and says Couldn\'t tell above them otherwise', () => {
  // BOTH ROWS are under the field whether or not anything answered: no
  // `if let unknown` wraps them on iOS, no `unknown?.let` on Android.
  const iosRows = swift.slice(swift.indexOf('Text(HypervisorWords.findFooter)'), swift.indexOf('Text("Which hypervisor is it")'));
  assert.match(iosRows, /if let unknown \{\s*Text\(unknown\)[^\n]*attention[^\n]*\n\s*\}\s*if let note \{\s*Text\(note\)[^\n]*inkDim[^\n]*\n\s*\}\s*NavigationLink/);
  assert.match(iosRows, /if marked == \.xo\(trimmed\) \{\s*Text\(HypervisorWords\.foundHere\)[^\n]*Design\.Palette\.ok/);
  assert.match(iosRows, /if marked == \.pve\(HypervisorAddress\.node\(trimmed\)\) \{\s*Text\(HypervisorWords\.foundHere\)[^\n]*Design\.Palette\.ok/);
  const androidRows = kotlin.slice(kotlin.indexOf('Hint(HypervisorWords.FIND_FOOTER)'), kotlin.indexOf('FullScreen(title = "Hypervisors"'));
  assert.match(androidRows, /unknown\?\.let \{ Hint\(it, Design\.Palette\.attention\.now\) \}\s*note\?\.let \{ Hint\(it\) \}\s*SectionHead\("Which hypervisor is it"\)/);
  assert.match(androidRows, /if \(marked == "xo"\) Hint\(HypervisorWords\.FOUND_HERE, Design\.Palette\.ok\.now\)/);
  assert.match(androidRows, /if \(marked == "pve"\) Hint\(HypervisorWords\.FOUND_HERE, Design\.Palette\.ok\.now\)/);
  // NOTHING ANSWERED: the one line, and the quiet note only when a machine was too old to check.
  assert.match(swift, /unknown = HypervisorWords\.notFound\(at\)\s*note = didNotLook\.isEmpty \? nil : HypervisorWords\.needsUpdate\(didNotLook\)/);
  assert.match(kotlin, /unknown = HypervisorWords\.notFound\(at\)\s*note = if \(didNotLook\.isEmpty\(\)\) null else HypervisorWords\.needsUpdate\(didNotLook\)/);
  assert.equal(iosWords.FOUND_HERE, 'Found at this address');
});

test('the empty state keeps §7: a fleet that did not answer is not one with no hypervisors', () => {
  // THE TITLE says which. "No hypervisors yet" is a claim, and it is made
  // only once the fleet has answered; a failed ask gets its own title and
  // the fleet-silent line under it.
  assert.match(swift, /Label\(failed \? "Couldn't load hypervisors" : "No hypervisors yet", systemImage:/);
  assert.match(kotlin, /SectionHead\(if \(failed\) "Couldn't load hypervisors" else "No hypervisors yet"\)/);
  assert.match(swift, /Text\(failed \? HypervisorWords\.fleetSilentEmpty : HypervisorWords\.none\)/);
  assert.match(kotlin, /Hint\(if \(failed\) HypervisorWords\.FLEET_SILENT_EMPTY else HypervisorWords\.NONE\)/);
  assert.equal(iosWords.FLEET_SILENT, "Your fleet didn't answer. Only pools on this phone are shown.");
});

test('the mechanism is off the screen: no footer narrates custody or polling', () => {
  for (const [name, words] of [['iOS', iosWords], ['Android', androidWords]]) {
    for (const [key, said] of Object.entries(words)) {
      assert.ok(!/\b(vault|token|coordinator|holds? (the|its)|every few minutes|ten minutes|looks? at)\b/i.test(said), `${name} ${key}: ${JSON.stringify(said)}`);
      assert.ok(said.length <= 100, `${name} ${key} is ${said.length} characters`);
    }
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
