// Working a machine from your own hypervisor, on the phones: its page (what
// it is, SSH, Xen Orchestra's console, restart, longer, a new size, end it),
// the operating systems an image can be made of, your SSH keys in the vault,
// and the network a new machine goes on.
//
//   node --test test/vm-manage-in-apps.test.js
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. What is pinned is what each screen offers and sends, and that both
// phones say it in the same words (docs/app-parity.md). ASKED FOR: "Vm
// console, settings, reboot, ssh os selection not just Debian".
// docs/hypervisors.md, "Working a machine".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const IOS = (/** @type {string} */ f) => read(`apps/ios/Fleetwright/${f}`);
const I_FLEET = IOS('Fleet.swift');
const I_PAGE = IOS('VMMachineView.swift');
const I_LIST = IOS('MachinesView.swift');
const I_HOST = IOS('HostView.swift');
const I_SHEET = IOS('StartSheet.swift');
const I_SSH = IOS('SSHKeysView.swift');
const I_CREDS = IOS('CredentialsHome.swift');
const I_SETUP = IOS('AddHypervisorView.swift');
const I_POLICY = IOS('XOPolicy.swift');

/** What both phones say, word for word. */
const SHARED = [
  'The fleet has no report of this machine. The box holding your pool may not have looked yet, or it has been removed.',
  'No address reported yet. Its guest agent says it once it has booted.',
  'Open its console in Xen Orchestra',
  'The console is Xen Orchestra’s own page, which asks you to sign in there: this phone never holds the pool’s token.',
  'Give it longer',
  'Restart with this size',
  'End it now',
  '? It is stopped and removed with its disk, and anything on it is lost.',
  '? A session running on it ends.',
  'held to your pool’s limits, and the machine restarts at its old size if the pool refuses.',
  'On your hypervisor',
  'On your hypervisor: console, SSH, size and end',
  'Behind the edge router',
  'SSH keys',
  'Keep in your vault',
  'Only public keys, one a line, starting ssh-ed25519, ssh-rsa or ecdsa-sha2. This line is not one: ',
  'A machine made on your hypervisor after you keep them lets you in as fleetwright, with sudo: ',
  'It is there. New session › Where offers machines from it.',
  ' with Fleetwright installed, on a 20 GiB disk on the storage chosen. ',
  'image once, converts it to a disk, and installs Fleetwright on it, which takes about ten minutes. Sessions can ',
];

test('iOS: the machines on your pools are read from the snapshot, and worked through the fleet, never held for later', () => {
  assert.match(I_FLEET, /struct Reply: Codable \{ let vmMachines: \[VMMachine\]\? \}/);
  assert.match(I_FLEET, /return try await intent\("vmctl", params: params, numeric: \["minutes", "cpus", "memory"\],\s*idempotencyKey: "app-\\\(UUID\(\)\.uuidString\)"\)/);
  assert.match(I_FLEET, /if let network \{ params\["network"\] = network \}/);
  assert.match(I_LIST, /async let onPools = fleet\.vmMachines\(\)/);
  assert.match(I_LIST, /if !poolMachines\.isEmpty \{\s*poolMachineRows/);
  assert.match(I_HOST, /if hostId\.hasPrefix\("vm-"\) \{/);
});

test('iOS: a machine’s page opens Xen Orchestra’s own console, and offers only what can be done', () => {
  assert.match(I_FLEET, /return URL\(string: "https:\/\/\\\(address\)\/#\/vms\/\\\(vm\)\/console"\)/);
  assert.match(I_FLEET, /var sshCommand: String\? \{ ip\.map \{ "ssh fleetwright@\\\(\$0\)" \} \}/);
  // A restart of a machine that is not running is refused, so it is not offered.
  assert.match(I_PAGE, /\.disabled\(busy \|\| m\.state != "Running"\)/);
  // Longer is drawn only while there is longer to give.
  assert.match(I_PAGE, /if canExtend\(m\) \{\s*Menu\("Give it longer"\)/);
  assert.match(I_PAGE, /return until < made \+ Double\(Fleet\.VMMachine\.maxMinutes\) \* 60_000/);
  // Each that interrupts a session asks first.
  for (const ask of ['asking = .restart', 'asking = .resize', 'asking = .end']) assert.ok(I_PAGE.includes(ask), ask);
});

test('iOS: images are offered by operating system to a machine that builds them, and sent as a list', () => {
  assert.match(I_SETUP, /canImages: begun\.can\.contains\("images"\)/);
  assert.match(I_SETUP, /choice\.imagesChoice = policyJob\.canImages && opened\.imageKinds != nil/);
  assert.match(I_POLICY, /out\["images"\] = \(inv\.imageKinds \?\? \[\]\)\.map\(\\\.key\)\.filter \{ images\.contains\(\$0\) \}/);
});

test('iOS: SSH keys are public keys only, kept as one secret in the vault', () => {
  assert.match(I_SSH, /static let secretName = "SSH_AUTHORIZED_KEYS"/);
  assert.match(I_SSH, /vault\.keepSecret\(fleet, name: Self\.secretName, value: lines\.joined\(separator: "\\n"\)\)/);
  assert.match(I_SSH, /\.disabled\(busy \|\| lines\.isEmpty \|\| !notKeys\.isEmpty\)/);
  assert.match(I_CREDS, /NavigationLink\("SSH keys"\) \{ SSHKeysView\(settings: settings\) \}/);
});

test('iOS: a new machine goes behind the edge router unless a network of the pool is chosen', () => {
  assert.match(I_SHEET, /if let networks = chosenImage\?\.networks, !networks\.isEmpty \{/);
  assert.match(I_SHEET, /network: chosenImage == nil \|\| vmNetwork\.isEmpty \? nil : vmNetwork/);
});

test('iOS says it in the shared words', () => {
  const ios = [I_FLEET, I_PAGE, I_LIST, I_HOST, I_SHEET, I_SSH, I_CREDS, I_SETUP, I_POLICY].join('\n');
  for (const words of SHARED) assert.ok(ios.includes(words), words);
});

// --- Android ------------------------------------------------------------------

const ANDROID = (/** @type {string} */ f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`);
const A_FLEET = ANDROID('Fleet.kt');
const A_PAGE = ANDROID('VmMachinePage.kt');
const A_LIST = ANDROID('MachinesScreen.kt');
const A_SHEET = ANDROID('StartSheet.kt');
const A_MAIN = ANDROID('MainActivity.kt');
const A_SSH = ANDROID('SshKeysScreen.kt');
const A_YOU = ANDROID('YouScreen.kt');
const A_HYPER = ANDROID('HypervisorSheet.kt');
const A_FORM = ANDROID('PolicyForm.kt');
const A_POLICY = ANDROID('XoPolicy.kt');

test('Android: the machines on your pools are read from the snapshot, and worked through the fleet, never held for later', () => {
  assert.match(A_FLEET, /get\("\/api\/hosts"\)\.optJSONArray\("vmMachines"\)/);
  assert.match(A_FLEET, /"vmctl",[\s\S]{0,300}idempotencyKey = "app-" \+ java\.util\.UUID\.randomUUID\(\)\.toString\(\),/);
  assert.match(A_FLEET, /\(if \(network == null\) emptyMap\(\) else mapOf\("network" to network\)\)/);
  assert.match(A_MAIN, /template = request\.template, network = request\.network\)/);
  assert.match(A_LIST, /val onPools = async \{ Fleet\(settings\)\.vmMachines\(\) \}/);
  assert.match(A_LIST, /if \(poolMachines\.isNotEmpty\(\)\) \{/);
  assert.match(A_LIST, /if \(hostId\.startsWith\("vm-"\)\) \{/);
});

test('Android: a machine’s page opens Xen Orchestra’s own console, and offers only what can be done', () => {
  assert.match(A_FLEET, /"https:\/\/\$address\/#\/vms\/\$vm\/console"/);
  assert.match(A_FLEET, /val sshCommand: String\? get\(\) = ip\?\.let \{ "ssh fleetwright@\$it" \}/);
  assert.match(A_PAGE, /enabled = !busy && m\.state == "Running"/);
  assert.match(A_PAGE, /if \(canExtend\(m\)\) \{\s*Text\("Give it longer"/);
  assert.match(A_PAGE, /return until < made \+ Fleet\.VmMachine\.MAX_MINUTES \* 60_000L/);
  for (const ask of ['asking = "reboot"', 'asking = "resize"', 'asking = "stop"']) assert.ok(A_PAGE.includes(ask), ask);
});

test('Android: images are offered by operating system to a machine that builds them, and sent as a list', () => {
  assert.match(A_HYPER, /canImages = "images" in p\.setup\.can/);
  assert.match(A_HYPER, /imagesChoice = canImages && opened\.imageKinds != null,/);
  assert.match(A_POLICY, /put\("images", JSONArray\(\(inv\.imageKinds \?: emptyList\(\)\)\.map \{ it\.key \}\.filter \{ it in c\.images \}\)\)/);
  assert.match(A_FORM, /if \(canImage && choice\.egress != null && choice\.imagesChoice && kinds != null\) \{/);
});

test('Android: SSH keys are public keys only, kept as one secret in the vault', () => {
  assert.match(A_SSH, /internal const val SSH_SECRET = "SSH_AUTHORIZED_KEYS"/);
  assert.match(A_SSH, /vault\.keepSecret\(Fleet\(settings\), SSH_SECRET, lines\.joinToString\("\\n"\)\)/);
  assert.match(A_SSH, /enabled = !busy && lines\.isNotEmpty\(\) && notKeys\.isEmpty\(\)/);
  assert.match(A_YOU, /OpenRow\("SSH keys"\) \{ sshKeys = true \}/);
});

test('Android: a new machine goes behind the edge router unless a network of the pool is chosen', () => {
  assert.match(A_SHEET, /if \(!networks\.isNullOrEmpty\(\)\) \{/);
  assert.match(A_SHEET, /network = vmNetwork\.ifBlank \{ null \}\.takeIf \{ platform == "vm" \},/);
});

test('both phones say it in the same words', () => {
  const android = [A_FLEET, A_PAGE, A_LIST, A_SHEET, A_MAIN, A_SSH, A_YOU, A_HYPER, A_FORM, A_POLICY].join('\n');
  for (const words of SHARED) assert.ok(android.includes(words), `Android: ${words}`);
});
