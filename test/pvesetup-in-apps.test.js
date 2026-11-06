// Setting up Proxmox VE through a machine of the fleet, from either phone
// (ProxmoxThroughMachine.swift, ProxmoxThrough.kt); the machine's half is
// test/pve-setup.test.js.
//
// The Swift and Kotlin compile only in CI, so what leaves each phone and what
// a person reads is held here to the host's own definitions, as text: the
// phase begun, the context the machine signs the job's key under, the names
// the root password and the line are sealed under, what is inside the seal,
// the words for each of PVESETUP_STEPS, and the coordinator's titles. Whether
// the key check and the seals work is run by XOSetupKeyTests.swift and
// ProxmoxThroughTest.kt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PVESETUP_STEPS } from '../src/fleet/protocol/intents.js';
import { PVE_STEP_WORDS } from '../src/fleet/host/xo-setup.js';
import { VMIDS_RE, setupCommand } from '../src/fleet/host/pve-setup.js';
import { pvesetupAad, pvesetupHandoffAad } from '../src/fleet/seal.js';
import { signingInput } from '../src/fleet/crypto.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const IOS = read('apps/ios/Fleetwright/ProxmoxThroughMachine.swift');
const IOS_KEY = read('apps/ios/Fleetwright/XOSetupKey.swift');
const IOS_SEAL = read('apps/ios/Fleetwright/Seal.swift');
const IOS_FLEET = read('apps/ios/Fleetwright/Fleet.swift');
const IOS_WORDS = read('apps/ios/Fleetwright/XOSetupActivity.swift');
const ANDROID = read('apps/android/app/src/main/java/network/thetech/fleetwright/ProxmoxThrough.kt');
const ANDROID_NOTICE = read('apps/android/app/src/main/java/network/thetech/fleetwright/XoSetupNotice.kt');
const CORE = read('src/fleet/coordinator/core.js');

test('both phones begin `pve`, check the key under `pvesetup-key`, and seal under the host’s names', () => {
  // The phase.
  assert.match(IOS_FLEET, /func beginPve[\s\S]*?\["phase": "pve", "address": address, "pin": pin\]/);
  assert.match(ANDROID, /fleet\.xosetup\("pve", address = where, pin = pin, host = p\.hostId\)/);
  // The context, as signingInput writes it.
  const prefix = signingInput('pvesetup-key', {}).replace(/\{\}$/, '');
  assert.equal(JSON.parse(`"${/static let pveSigningPrefix = "([^"]+)"/.exec(IOS_KEY)?.[1]}"`), prefix);
  assert.ok(ANDROID.includes(`"${prefix.replaceAll('\n', '\\n')}{`), 'Android signs under another context');
  // The names, with each language's interpolation filled in.
  const [job, at] = ['0123456789ab', 'pve1.lan'];
  const swift = (/** @type {string} */ name) => (new RegExp(`static func ${name}\\(job: String, address: String\\) -> String \\{ "([^"]+)" \\}`).exec(IOS_SEAL)?.[1] ?? '')
    .replace('\\(job)', job).replace('\\(address)', at);
  const kotlin = (/** @type {string} */ name) => (new RegExp(`fun ${name}\\(job: String, address: String\\): String = "([^"]+)"`).exec(ANDROID)?.[1] ?? '')
    .replace('$job', job).replace('$address', at);
  assert.equal(swift('pvesetupAAD'), pvesetupAad(job, at));
  assert.equal(swift('pvesetupHandoffAAD'), pvesetupHandoffAad(job, at));
  assert.equal(kotlin('aad'), pvesetupAad(job, at));
  assert.equal(kotlin('handoffAad'), pvesetupHandoffAad(job, at));
  // What is inside: what xo-setup.js `run` reads for this job, and the line it seals back.
  assert.match(IOS, /payload: \["v": 1, "purpose": "pve", "root": \["password": rootPassword\], "reply": back\.publicKey, "vmids": vmids, "options": options\.payload\]/);
  assert.match(ANDROID, /\.put\("purpose", PURPOSE\)\s*\.put\("root", JSONObject\(\)\.put\("password", rootPassword\)\)\s*\.put\("reply", reply\)\s*\.put\("vmids", if \(ProxmoxLine\.isVmids\(vmids\)\) vmids else ""\)\s*\.put\("options", options\.payload\(\)\)/);
  assert.match(ANDROID, /const val PURPOSE = "pve"/);
  assert.match(IOS, /inside\["line"\] as\? String/);
  assert.match(ANDROID, /inside\.optString\("line"\)/);
});

test('both phones say each step in the host’s words, and the end in the coordinator’s', () => {
  for (const step of PVESETUP_STEPS) {
    const words = PVE_STEP_WORDS[step];
    assert.ok(words, `the host has no words for ${step}`);
    assert.ok(IOS_WORDS.includes(`case "${step}": return "${words}"`), `iOS says ${step} otherwise`);
    assert.ok(ANDROID.includes(`"${step}" to "${words}"`), `Android says ${step} otherwise`);
  }
  const titles = /const PVE_TITLES = Object\.freeze\((\{[^)]+\})\)/.exec(CORE)?.[1];
  assert.ok(titles, 'the coordinator has no titles for it');
  /** @type {Record<string, string>} */
  const said = JSON.parse(titles.replace(/(\w+):/g, '"$1":').replace(/'/g, '"'));
  for (const [state, words] of Object.entries(said)) {
    if (state !== 'running') assert.ok(IOS_WORDS.includes(`case "${state}": return "${words}"`), `iOS ends ${state} otherwise`);
    assert.ok(ANDROID.includes(state === 'running' ? `else -> "${words}"` : `"${state}" -> "${words}"`), `Android says ${state} otherwise`);
  }
  assert.ok(IOS_WORDS.includes(`static let pveRunning = "${said.running}"`), 'iOS says it runs otherwise');
  assert.match(ANDROID_NOTICE, /pve -> ProxmoxThrough\.stepWords\(data\["phase"\], step, of\)/);
});

// THE SCREEN MAY BE CLOSED, asked for in so many words: "Why no background
// processing why do I need to wait there". Both phones keep the key the line
// comes back to under the job until the line is in the vault, collect it at
// launch and when the app is back in front, and say so rather than asking
// the person to wait.
test('both phones keep the line’s key past the screen, collect it when back in front, and say the screen may close', () => {
  const iosHandoff = read('apps/ios/Fleetwright/ProxmoxThroughHandoff.swift');
  const androidHandoff = read('apps/android/app/src/main/java/network/thetech/fleetwright/ProxmoxThroughHandoff.kt');
  const iosApp = read('apps/ios/Fleetwright/FleetwrightApp.swift');
  const androidMain = read('apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt');
  // The same name for the kept key, distinct from a hypervisor setup's.
  assert.match(iosHandoff, /replyAccount\(_ job: String\) -> String \{ "pvesetup-reply\.\\\(job\)" \}/);
  assert.match(androidHandoff, /replyName\(job: String\) = "pvesetup-reply\.\$job"/);
  // The screens make the key there, not in memory.
  assert.match(IOS, /let back = ProxmoxThroughHandoff\.newKey\(job: begun\.job, address: begun\.address\)/);
  assert.match(ANDROID, /val back = ProxmoxThroughHandoff\.newKey\(settings, b\.setup\.job, b\.where\)/);
  assert.ok(!/Seal\.newKey\(\)/.test(IOS) && !/Seal\.newKey\(\)/.test(ANDROID), 'a screen still holds the key in memory');
  // Collected at launch and when back in front.
  assert.match(iosApp, /ProxmoxThroughHandoff\.collectPending[\s\S]*?ProxmoxThroughHandoff\.collectPending/);
  assert.match(iosApp, /onChange\(of: scenePhase\)/);
  assert.equal(androidMain.match(/ProxmoxThroughHandoff\.collectPending\(settings, fleet\)/g)?.length, 2);
  assert.match(androidMain, /Lifecycle\.Event\.ON_RESUME/);
  // Said the same on both, and the old warning is gone.
  const iosWords = /static let mayClose = ("[\s\S]*?")\n\n/.exec(IOS)?.[1].replace(/"\s*\+\s*"/g, '');
  const androidWords = /const val MAY_CLOSE =\s*("[\s\S]*?")\n/.exec(ANDROID)?.[1].replace(/"\s*\+\s*"/g, '');
  assert.ok(iosWords && iosWords === androidWords, `the phones say it differently:\n${iosWords}\n${androidWords}`);
  assert.ok(!IOS.includes('Keep this screen open') && !ANDROID.includes('Keep this screen open'));
});

// ONE WAY IN, asked for: "the route through a machine and main direct route
// can be combined". Both phones try the node themselves first, and only a
// node they cannot reach goes to a machine, with what was typed carried over
// and the machines asked at once. A run started from the phone is followed
// after its screen closes too, with its password kept on the phone alone.
test('both phones set up a node one way: the phone first, a machine when it cannot reach it, and either may be left', () => {
  const iosAdd = read('apps/ios/Fleetwright/AddProxmoxView.swift');
  const androidAdd = read('apps/android/app/src/main/java/network/thetech/fleetwright/ProxmoxSheet.kt');
  const iosDirect = read('apps/ios/Fleetwright/ProxmoxDirectHandoff.swift');
  const androidDirect = read('apps/android/app/src/main/java/network/thetech/fleetwright/ProxmoxDirectHandoff.kt');
  const iosApp = read('apps/ios/Fleetwright/FleetwrightApp.swift');
  const androidMain = read('apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt');
  // No second entry: the separate row is gone from both.
  for (const s of [iosAdd, androidAdd]) assert.ok(!s.includes('"Through one of your machines"'), 'a phone still offers the machine route as its own row');
  // The phone's own reach is asked first; a node it cannot reach goes to a machine.
  assert.match(iosAdd, /answered = try await ProxmoxSSH\.hostKey\(nodeKey\)[\s\S]*?catch \{[\s\S]*?through = true/);
  assert.match(androidAdd, /ProxmoxSsh\.hostKey\(at\)\.getOrElse \{[\s\S]*?through = true/);
  // With the address and password carried over, and the machines asked at once.
  assert.match(iosAdd, /ProxmoxThroughMachineView\(settings: settings, node: nodeKey, password: password, vmids: trimmedVmids, options: options, auto: true\)/);
  assert.match(androidAdd, /ProxmoxThroughSheet\(\s*settings,\s*node,\s*password = password,\s*vmids = trimmedVmids,\s*options = options,\s*auto = true,/);
  assert.match(IOS, /if auto, probes == nil, job == nil, XOSetupKey\.isAddress\(trimmedAddress\) \{ await probe\(\) \}/);
  assert.match(ANDROID, /if \(auto && probes == null && job == null && addressOk\) probe\(\)/);
  // A direct run is registered when it starts, followed through the same look
  // a launch takes, and collected at launch and when back in front.
  assert.match(iosAdd, /ProxmoxDirectHandoff\.started\(address: nodeKey, fingerprint: key, since: now, password: password\)/);
  assert.match(androidAdd, /ProxmoxDirectHandoff\.started\(settings, at, key, now, password\)/);
  assert.match(iosAdd, /ProxmoxDirectHandoff\.look\(nodeKey, settings: settings\)/);
  assert.match(androidAdd, /ProxmoxDirectHandoff\.look\(settings, at\)/);
  assert.equal(iosApp.match(/ProxmoxDirectHandoff\.collectPending\(settings: settings\)/g)?.length, 2);
  assert.equal(androidMain.match(/ProxmoxDirectHandoff\.collectPending\(settings\)/g)?.length, 2);
  // The same names for what is kept, and the password wiped with the run.
  assert.match(iosDirect, /"pvedirect-password\.\\\(address\)"/);
  assert.match(androidDirect, /"pvedirect-password\.\$address"/);
  for (const s of [iosDirect, androidDirect]) assert.match(s, /forget/);
});

// THE PERSON'S RANGE OF MACHINE NUMBERS, asked for: "vmid range user
// deserves a choice". Both phones take it on Add Proxmox VE, check it as the
// machine does, and pass it on every route: in the command for the node, the
// by-hand command, and sealed to the machine.
test('both phones take a range of machine numbers and pass it to the node on every route', () => {
  const iosAdd = read('apps/ios/Fleetwright/AddProxmoxView.swift');
  const androidAdd = read('apps/android/app/src/main/java/network/thetech/fleetwright/ProxmoxSheet.kt');
  const iosSsh = read('apps/ios/Fleetwright/ProxmoxSSH.swift');
  const androidSsh = read('apps/android/app/src/main/java/network/thetech/fleetwright/ProxmoxSsh.kt');
  // The same check as the machine's, held by examples both ways.
  const androidRe = new RegExp(/Regex\("(\^\(\[1-9\][^"]+)"\)\.find\(s\)/.exec(androidAdd)?.[1] ?? 'nothing');
  for (const [v, ok] of [['9000-9099', true], ['100-100', true], ['99-200', false], ['0900-0999', false], ['9000-9099; x', false], ['9000', false]]) {
    assert.equal(VMIDS_RE.test(v), ok, `the machine on ${v}`);
    assert.equal(androidRe.test(v), ok, `Android on ${v}`);
  }
  assert.match(iosAdd, /static func isVmids\(_ s: String\) -> Bool/);
  // In the command, on both routes and by hand.
  assert.match(iosAdd, /setupCommand\(coordinator: coordinator\) \+ \(isVmids\(vmids\) \? " --vmids \\\(vmids\)" : ""\) \+ options\.args/);
  assert.match(androidAdd, /setupCommand\(coordinator\) \+ \(if \(isVmids\(vmids\)\) " --vmids \$vmids" else ""\) \+ options\.args/);
  assert.equal(setupCommand('https://f.example', '9000-9099'), `${setupCommand('https://f.example')} --vmids 9000-9099`);
  assert.match(iosSsh, /ProxmoxLine\.setupCommand\(coordinator: coordinator, vmids: vmids, options: options\)/);
  assert.match(androidSsh, /ProxmoxLine\.setupCommand\(coordinator, vmids, options\)/);
  assert.match(iosAdd, /ProxmoxSSH\.startCommand\(coordinator: settings\.coordinatorURL, vmids: trimmedVmids, options: options\)/);
  assert.match(androidAdd, /ProxmoxSsh\.startCommand\(settings\.coordinatorUrl, trimmedVmids, options\)/);
  assert.match(iosAdd, /vmids: trimmedVmids, options: options, auto: true/);
  assert.match(androidAdd, /vmids = trimmedVmids,\s*options = options,\s*auto = true/);
});

// EVERY OPTION THE SETUP TAKES, set the same way on both phones and on the
// machine that runs it through. Asked for: "Everything should be in app".
test('both phones set every setup option as the script and the machines take it', async () => {
  const { optionArgs, PVE_STORAGE_RE, PVE_BRIDGE_RE } = await import('../src/fleet/host/pve-setup.js');
  const rd = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const swift = rd('apps/ios/Fleetwright/AddProxmoxView.swift');
  const kotlin = rd('apps/android/app/src/main/java/network/thetech/fleetwright/ProxmoxSheet.kt');
  const script = rd('install/fleetwright-pve-setup');
  // THE FLAGS, in the machine's order, on both phones.
  const flags = optionArgs({ firewall: true, rebuildImage: true, channel: 'rolling', storage: 's', bridge: 'b', expireDays: 90, groups: 1, labsOpen: 2, labsClosed: 2 }).match(/--[a-z-]+/g) ?? [];
  flags.splice(2, 0, '--no-image');
  for (const [name, src] of [['iOS', swift], ['Android', kotlin]]) {
    const at = flags.map((f) => src.indexOf(`" ${f}`));
    assert.ok(at.every((i) => i > 0), `${name} lacks ${flags.filter((_, k) => at[k] < 0)}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, `${name} passes the flags in another order`);
    // THE PAYLOAD'S KEYS are the machine's (pveOptionsOf).
    for (const key of ['firewall', 'rebuildImage', 'noImage', 'channel', 'storage', 'bridge', 'expireDays', 'groups', 'labsOpen', 'labsClosed']) {
      assert.ok(src.includes(`"${key}"`), `${name} never sends ${key}`);
    }
  }
  // THE DEFAULTS are the script's, so nothing changed passes nothing.
  for (const [v, d] of [['EXPIRE_DAYS', '365'], ['GROUP_NETS', '2'], ['LABS_OPEN', '1'], ['LABS_CLOSED', '1'], ['CHANNEL', 'stable']]) {
    assert.match(script, new RegExp(`^${v}=${d}$`, 'm'));
  }
  assert.match(swift, /var expireDays = 365\s+var groups = 2\s+var labsOpen = 1\s+var labsClosed = 1/);
  assert.match(kotlin, /val expireDays: Int = 365,\s+val groups: Int = 2,\s+val labsOpen: Int = 1,\s+val labsClosed: Int = 1,/);
  // THE PATTERNS are the machine's.
  assert.ok(swift.includes(`static let storagePattern = "${PVE_STORAGE_RE.source}"`));
  assert.ok(swift.includes(`static let bridgePattern = "${PVE_BRIDGE_RE.source}"`));
  assert.ok(kotlin.includes(`val STORAGE = Regex("${PVE_STORAGE_RE.source}")`));
  assert.ok(kotlin.includes(`val BRIDGE = Regex("${PVE_BRIDGE_RE.source}")`));
  // THE WORDS are one sentence on both, and true to what the script does.
  const hint = /static let firewallHint = "([^"]+)"/.exec(swift)?.[1];
  assert.ok(hint && kotlin.includes(`const val FIREWALL_HINT = "${hint}"`));
  assert.match(script, /its own rules keep this node's web interface and SSH open to the local network/);
  // THE CLUSTER'S PAGE opens the setup with the firewall on where it is off.
  assert.match(rd('apps/ios/Fleetwright/HypervisorsView.swift'), /if row\.fleet\?\.fenced == false \{\s*NavigationLink\(HypervisorWords\.turnOnFirewall\) \{\s*AddProxmoxView\(settings: settings, startNode: HypervisorAddress\.node\(row\.address\), startOptions: ProxmoxOptions\(firewall: true\)\)/);
  assert.match(rd('apps/android/app/src/main/java/network/thetech/fleetwright/HypervisorsScreen.kt'), /if \(row\.fleet\?\.fenced == false\) OpenRow\(HypervisorWords\.TURN_ON_FIREWALL, onClick = onTurnOnFirewall\)/);
});
