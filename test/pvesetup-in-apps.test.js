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
  assert.match(IOS, /payload: \["v": 1, "purpose": "pve", "root": \["password": rootPassword\], "reply": back\.publicKey\]/);
  assert.match(ANDROID, /\.put\("purpose", PURPOSE\)\s*\.put\("root", JSONObject\(\)\.put\("password", rootPassword\)\)\s*\.put\("reply", reply\)/);
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
  assert.match(iosAdd, /ProxmoxThroughMachineView\(settings: settings, node: nodeKey, password: password, auto: true\)/);
  assert.match(androidAdd, /ProxmoxThroughSheet\(\s*settings,\s*node,\s*password = password,\s*auto = true,/);
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
