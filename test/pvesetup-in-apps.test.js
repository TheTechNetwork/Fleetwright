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
