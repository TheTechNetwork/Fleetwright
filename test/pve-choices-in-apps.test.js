// WHAT A PROXMOX VE NODE HAS TO CHOOSE FROM, on both phones: the same
// read-only command as the box (src/fleet/host/pve-setup.js, CHOICES_FIND),
// read the same way, and the storage and the bridge picked from what it
// listed, typed in only when it could not be read. The Swift and Kotlin
// compile only in CI, so they are held to the JavaScript here, as text.
// docs/proxmox.md, "From the phone".
//
//   node --test test/pve-choices-in-apps.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CHOICES_FIND } from '../src/fleet/host/pve-setup.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const A = 'apps/android/app/src/main/java/network/thetech/fleetwright';
const IOS_SSH = read('apps/ios/Fleetwright/ProxmoxSSH.swift');
const ANDROID_SSH = read(`${A}/ProxmoxSsh.kt`);
const IOS_ADD = read('apps/ios/Fleetwright/AddProxmoxView.swift');
const ANDROID_SHEET = read(`${A}/ProxmoxSheet.kt`);

test('both phones run the box’s command to list the node’s storage and bridges', () => {
  assert.equal(/static let choicesFind = #"(.*)"#$/m.exec(IOS_SSH)?.[1], CHOICES_FIND);
  const kotlin = /const val CHOICES_FIND = "((?:[^"\\]|\\.)*)"$/m.exec(ANDROID_SSH)?.[1]?.replace(/\\\$/g, '$').replace(/\\"/g, '"');
  assert.equal(kotlin, CHOICES_FIND);
});

test('both phones read the answer as the box does: the same lines, fields and names the setup takes', () => {
  for (const src of [IOS_SSH, ANDROID_SSH]) {
    for (const field of ['"storage"', '"avail"', '"shared"', '"active"', '"iface"', '"cidr"', '"comments"']) assert.ok(src.includes(field), field);
  }
  assert.ok(IOS_SSH.includes('range(of: ProxmoxOptions.storagePattern') && IOS_SSH.includes('range(of: ProxmoxOptions.bridgePattern'));
  assert.ok(ANDROID_SSH.includes('ProxmoxOptions.STORAGE.matches(id)') && ANDROID_SSH.includes('ProxmoxOptions.BRIDGE.matches(name)'));
});

test('both phones pick from the list once read, keep the field to type in before, and say it in the same words', () => {
  for (const [s, k] of [['choicesRead', 'CHOICES_READ'], ['choicesReading', 'CHOICES_READING'], ['choicesKey', 'CHOICES_KEY'], ['choicesNone', 'CHOICES_NONE'], ['storageAuto', 'STORAGE_AUTO'], ['bridgeAuto', 'BRIDGE_AUTO']]) {
    const ios = new RegExp(`static let ${s} = "([^"]*)"`).exec(IOS_ADD)?.[1];
    assert.ok(ios, `iOS has no ${s}`);
    assert.equal(new RegExp(`const val ${k} = "([^"]*)"`).exec(ANDROID_SHEET)?.[1], ios, s);
    assert.ok(ios.length <= 100);
  }
  // Empty is still "found by itself" and vmbr0, as the script takes it.
  assert.ok(IOS_ADD.includes('Text(ProxmoxWords.storageAuto).tag("")') && IOS_ADD.includes('Text(ProxmoxWords.bridgeAuto).tag("")'));
  assert.ok(ANDROID_SHEET.includes('onChange(options.copy(storage = ""))') && ANDROID_SHEET.includes('onChange(options.copy(bridge = ""))'));
  // The key is checked as Start checks it before anything is sent.
  assert.match(IOS_ADD, /private func readChoices\(\) async \{[\s\S]*?guard known\[nodeKey\] == answered else \{[\s\S]*?offered = answered/);
  assert.match(ANDROID_SHEET, /suspend fun readChoices\(\) \{[\s\S]*?if \(known\.getString\(at, null\) != answered\) \{[\s\S]*?offered = answered/);
  // Another node is another list.
  assert.ok(IOS_ADD.includes('trusted = nil; choices = nil'));
  assert.ok(ANDROID_SHEET.includes('trusted = null; choices = null'));
});
