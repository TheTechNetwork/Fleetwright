// A PROXMOX VE CLUSTER'S OWN MACHINE, as both phones make it: the setup run
// from the phone writes the same pin file and starts the script with the same
// flags a machine of the fleet does (src/fleet/host/pve-setup.js), the
// options carry the same keys, and the cluster's page says the same words.
// The Swift and Kotlin compile only in CI, so what they send is held to the
// JavaScript here, as text. docs/proxmox.md, "A machine of its own".
//
//   node --test test/pve-holder-in-apps.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as pveSetup from '../src/fleet/host/pve-setup.js';
import { PVESETUP_STEPS } from '../src/fleet/protocol/intents.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const A = 'apps/android/app/src/main/java/network/thetech/fleetwright';
const IOS_SSH = read('apps/ios/Fleetwright/ProxmoxSSH.swift');
const ANDROID_SSH = read(`${A}/ProxmoxSsh.kt`);
const IOS_ADD = read('apps/ios/Fleetwright/AddProxmoxView.swift');
const ANDROID_SHEET = read(`${A}/ProxmoxSheet.kt`);
const IOS_THROUGH = read('apps/ios/Fleetwright/ProxmoxThroughMachine.swift');
const ANDROID_THROUGH = read(`${A}/ProxmoxThrough.kt`);
const IOS_PAGE = read('apps/ios/Fleetwright/HypervisorsView.swift');
const ANDROID_PAGE = read(`${A}/HypervisorsScreen.kt`);

test('both phones look, ask the node its address, and write the pin file with the box’s commands', () => {
  const swift = (/** @type {string} */ name) => new RegExp(`static let ${name} = "((?:[^"\\\\]|\\\\.)*)"`).exec(IOS_SSH)?.[1].replace(/\\"/g, '"');
  const kotlin = (/** @type {string} */ name) => new RegExp(`const val ${name} = "((?:[^"\\\\]|\\\\.)*)"`).exec(ANDROID_SSH)?.[1].replace(/\\\$/g, '$').replace(/\\"/g, '"');
  assert.equal(swift('holderJoinFile'), pveSetup.HOLDER_JOIN_FILE);
  assert.equal(kotlin('HOLDER_JOIN_FILE'), pveSetup.HOLDER_JOIN_FILE);
  assert.equal(swift('holderFind'), pveSetup.HOLDER_FIND);
  assert.equal(kotlin('HOLDER_FIND'), pveSetup.HOLDER_FIND);
  assert.equal(swift('addressFind'), pveSetup.ADDRESS_FIND);
  assert.equal(kotlin('ADDRESS_FIND'), pveSetup.ADDRESS_FIND);
  // The flags only with the file, and made again only then, as the box.
  assert.ok(IOS_SSH.includes('let holder = holderJoin ? " " + holderJoinFlag + " " + holderJoinFile + (options.holderAgain == true ? " " + holderAgainFlag : "") : ""'));
  assert.ok(ANDROID_SSH.includes('val holder = if (holderJoin) " " + HOLDER_JOIN_FLAG + " " + HOLDER_JOIN_FILE + (if (options.holderAgain == true) " " + HOLDER_AGAIN_FLAG else "") else ""'));
  for (const [s, k] of [['holderJoinFlag', 'HOLDER_JOIN_FLAG'], ['holderAgainFlag', 'HOLDER_AGAIN_FLAG']]) {
    assert.equal(swift(s), kotlin(k));
  }
  assert.equal(swift('holderJoinFlag'), '--holder-join');
  assert.equal(swift('holderAgainFlag'), '--holder-again');
  assert.ok(pveSetup.startCommand('https://f.example', null, { holder: true, holderAgain: true }, true).includes(` --holder-join ${pveSetup.HOLDER_JOIN_FILE} --holder-again --line-file `));
  // The file: the JSON in base64 through the same shell words.
  assert.ok(IOS_SSH.includes('"umask 077; printf %s \\(data.base64EncodedString()) | base64 -d >\\(holderJoinFile)"'));
  assert.ok(ANDROID_SSH.includes('"umask 077; printf %s ${Base64.getEncoder().encodeToString(join.toString().toByteArray())} | base64 -d >$HOLDER_JOIN_FILE"'));
  assert.match(pveSetup.holderJoinCommand({ hostId: 'holder-0a0b0c', pin: '482913', address: '10.0.0.5:8006' }), /^umask 077; printf %s \S+ \| base64 -d >\/root\/\.fleetwright-holder-join$/);
  for (const key of ['"hostId"', '"pin"', '"address"', '"secret"']) {
    assert.ok(IOS_SSH.includes(key) && ANDROID_SSH.includes(key), `a phone writes no ${key}`);
  }
  // Their own, by the tag and outside the pool, as the box finds it.
  for (const src of [IOS_SSH, ANDROID_SSH]) {
    assert.ok(src.includes('"fleetwright-holder"') && src.includes('"fleetwright"') && src.includes(':8006'));
  }
});

test('both phones ask the fleet for the pin, keep the secret where approval finds it, and retire one made again', () => {
  assert.match(read('apps/ios/Fleetwright/Fleet.swift'), /post\("\/api\/holders", body: \["address": address\]\)/);
  assert.match(read(`${A}/Fleet.kt`), /post\("\/api\/holders", JSONObject\(\)\.put\("address", address\)\)/);
  assert.match(read('apps/ios/Fleetwright/HolderJoin.swift'), /static let proxmoxSetup = "proxmox setup"/);
  assert.match(read(`${A}/HolderJoin.kt`), /const val PROXMOX_SETUP = "proxmox setup"/);
  // Approval tries those secrets for any request: the proof says which.
  assert.match(read('apps/ios/Fleetwright/HolderJoin.swift'), /let pending = await secrets\(for: proxmoxSetup\)/);
  assert.match(read(`${A}/HolderJoin.kt`), /val pending = secrets\(settings, PROXMOX_SETUP\)/);
  for (const src of [IOS_ADD, ANDROID_SHEET]) {
    assert.match(src, /holderPin\(address/);
    assert.match(src, /revokeHost/);
    assert.match(src, /\^holder-\[0-9a-f\]\{6\}\$/);
  }
  assert.match(IOS_ADD, /HolderJoin\.newSecret\(for: HolderJoin\.proxmoxSetup\)/);
  assert.match(ANDROID_SHEET, /HolderJoin\.newSecret\(settings, HolderJoin\.PROXMOX_SETUP\)/);
  // Through a machine: only where it says it can, with the secret.
  assert.match(IOS_THROUGH, /setup\.can\?\.contains\("pve-holder"\) == true/);
  assert.match(ANDROID_THROUGH, /"pve-holder" in b\.setup\.can/);
  for (const src of [IOS_THROUGH, ANDROID_THROUGH]) assert.match(src, /holderSecret/);
});

test('the options carry the keys the box takes, and a run made again is never kept for the next', () => {
  const read2 = pveSetup.pveOptionsOf({ holder: true, holderAgain: true, holderSecret: 'a'.repeat(64) });
  assert.equal(read2.problem, null);
  for (const src of [IOS_ADD, ANDROID_SHEET]) {
    assert.match(src, /"holder"/);
    assert.match(src, /"holderAgain"/);
  }
  assert.match(IOS_ADD, /kept\.holderAgain = nil/);
  assert.ok(!/put\("holderAgain"/.test(/fun saved\(\)[\s\S]*?toString\(\)/.exec(ANDROID_SHEET)?.[0] ?? ''), 'Android keeps a run made again for the next');
});

test('both phones say the step and the cluster’s own machine in the same words', () => {
  assert.ok(PVESETUP_STEPS.includes('holder'));
  assert.ok(IOS_SSH.includes('case "holder": return "Its own machine"'));
  assert.ok(ANDROID_SSH.includes('"holder" -> "Its own machine"'));
  const words = [
    ['ownHeader', 'OWN_HEADER'],
    ['ownNone', 'OWN_NONE'],
    ['makeOwn', 'MAKE_OWN'],
    ['makeOwnAgain', 'MAKE_OWN_AGAIN'],
    ['makeOwnAgainFooter', 'MAKE_OWN_AGAIN_FOOTER'],
  ];
  for (const [ios, android] of words) {
    const a = new RegExp(`static let ${ios} = "([^"]+)"`).exec(IOS_PAGE)?.[1];
    assert.ok(a, `iOS has no ${ios}`);
    assert.equal(new RegExp(`const val ${android} = "([^"]+)"`).exec(ANDROID_PAGE)?.[1], a, `${android} differs`);
  }
  assert.ok(IOS_PAGE.includes('running ? "\\(name), running" : "\\(name), off. Setting it up again starts it."'));
  assert.ok(ANDROID_PAGE.includes('if (running) "$name, running" else "$name, off. Setting it up again starts it."'));
  for (const [ios, android] of [['holderHint', 'HOLDER_HINT'], ['holderNeedsImage', 'HOLDER_NEEDS_IMAGE']]) {
    const a = new RegExp(`static let ${ios} = "([^"]+)"`).exec(IOS_ADD)?.[1];
    assert.ok(a, `iOS has no ${ios}`);
    assert.equal(new RegExp(`const val ${android} = "([^"]+)"`).exec(ANDROID_SHEET)?.[1], a);
  }
});

test('both phones offer the edge router with the box’s flags and keys, and say it in the same words', () => {
  assert.ok(PVESETUP_STEPS.includes('edge'));
  assert.ok(IOS_SSH.includes('case "edge": return "The edge router, which takes a few minutes"'));
  assert.ok(ANDROID_SSH.includes('"edge" -> "The edge router, which takes a few minutes"'));
  // The flags the box's optionArgs gives, in its order: after the labs.
  assert.equal(pveSetup.optionArgs({ labsClosed: 2, edge: true, edgeBlock: true, edgeAgain: true }), ' --labs-closed 2 --edge-block --edge-again');
  assert.ok(IOS_ADD.includes('if wantsEdge { a += edgeBlock == true ? " --edge-block" : " --edge" }'));
  assert.ok(IOS_ADD.includes('if wantsEdge && edgeAgain == true { a += " --edge-again" }'));
  assert.ok(ANDROID_SHEET.includes('if (edge) a.append(if (edgeBlock) " --edge-block" else " --edge")'));
  assert.ok(ANDROID_SHEET.includes('if (edge && edgeAgain == true) a.append(" --edge-again")'));
  for (const key of ['"edge"', '"edgeBlock"', '"edgeAgain"']) assert.ok(IOS_ADD.includes(key) && ANDROID_SHEET.includes(key), key);
  assert.match(IOS_ADD, /kept\.edgeAgain = nil/);
  for (const [ios, android] of [['edgeHeader', 'EDGE_HEADER'], ['edgeNone', 'EDGE_NONE'], ['makeEdge', 'MAKE_EDGE'], ['makeEdgeAgain', 'MAKE_EDGE_AGAIN'], ['makeEdgeAgainFooter', 'MAKE_EDGE_AGAIN_FOOTER']]) {
    const a = new RegExp(`static let ${ios} = "([^"]+)"`).exec(IOS_PAGE)?.[1];
    assert.ok(a, `iOS has no ${ios}`);
    assert.equal(new RegExp(`const val ${android} = "([^"]+)"`).exec(ANDROID_PAGE)?.[1], a, `${android} differs`);
  }
  for (const [ios, android] of [['edgeHint', 'EDGE_HINT'], ['edgeBlock', 'EDGE_BLOCK'], ['edgeBlockHint', 'EDGE_BLOCK_HINT']]) {
    const a = new RegExp(`static let ${ios} = "([^"]+)"`).exec(IOS_ADD)?.[1];
    assert.ok(a, `iOS has no ${ios}`);
    assert.equal(new RegExp(`const val ${android} = "([^"]+)"`).exec(ANDROID_SHEET)?.[1], a);
  }
  for (const words of ['Running, dropping what its threat rules match', 'Running, logging what its threat rules match']) {
    assert.ok(IOS_PAGE.includes(words) && ANDROID_PAGE.includes(words), words);
  }
});
