// The edge that blocks, on the phones: a switch under the edge router,
// offered only by a machine that builds either kind, sent only with the
// router asked for, under the key checkPolicy reads, and said in the same
// words on both phones, including what changing it costs.
//
//   node --test test/edge-block-in-apps.test.js
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. ASKED FOR: blocking mode for the edge's intrusion detection.
// docs/hypervisors.md, "What the edge filters".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const I_POLICY = read('apps/ios/Fleetwright/XOPolicy.swift');
const I_FORM = read('apps/ios/Fleetwright/AddHypervisorView.swift');
const A = (/** @type {string} */ f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`);
const A_POLICY = A('XoPolicy.kt');
const A_SHEET = A('HypervisorSheet.kt');
const A_FORM = A('PolicyForm.kt');
const HOST = read('src/fleet/host/xo-setup.js');

/** What both phones say, word for word: the row's verdict as the switch stands. */
const SHARED = [
  'Drop what the threat rules match',
  'Blocks matched traffic',
  'Logs only',
];
// The rebuild's cost, said once beside Apply and not on the row, as the box
// says it: the new router is built beside the old one (ONE_BOOT in
// src/fleet/host/edge-router.js), so internet access is gone for one boot
// and not for the whole build.
const REBUILD = 'Applying rebuilds the router. VMs behind it lose internet while the new one starts.';

test('offered only by a machine whose `can` says so, and only with the router asked for', () => {
  assert.ok(HOST.includes("'edge-block'"), 'the machine does not say it can');
  assert.match(I_FORM, /canEdgeBlock: begun\.can\.contains\("edge-block"\)/);
  assert.match(I_FORM, /if choice\.edgeBlockChoice, canEdge, choice\.edge, choice\.egress != nil \{/);
  assert.match(A_SHEET, /canEdgeBlock = "edge-block" in p\.setup\.can/);
  assert.match(A_FORM, /if \(canEdge && choice\.edgeBlockChoice && choice\.edge && choice\.egress != null\) \{/);
});

test('sent only to a machine that reads it, only with the router, as the key checkPolicy reads', () => {
  assert.match(I_POLICY, /if edgeBlockChoice, edge \{ out\["edgeBlock"\] = edgeBlock \}/);
  assert.match(A_POLICY, /if \(c\.edgeBlockChoice && c\.edge\) put\("edgeBlock", c\.edgeBlock\)/);
  assert.ok(HOST.includes('p.edgeBlock'));
});

test('both phones start it as the router is, so Apply rebuilds nothing the person did not change', () => {
  assert.match(I_POLICY, /c\.edgeBlock = inv\.edge\(on: c\.egress\)\?\.blocks \?\? false/);
  assert.match(A_POLICY, /edgeBlock = edgeOn\(inv, egress\)\?\.blocks \?: false/);
});

test('both phones say it in the same words', () => {
  for (const words of SHARED) {
    assert.ok(I_FORM.includes(words), `iOS: ${words}`);
    assert.ok(A_FORM.includes(words), `Android: ${words}`);
  }
  for (const [name, form] of [['iOS', I_FORM], ['Android', A_FORM]]) {
    assert.ok(!form.includes('no way out until the new one is up'), `${name}: the rebuild still says the way out is gone for the whole build`);
    assert.ok(!form.includes('Apply rebuilds the edge router to change this'), `${name}: the rebuild is still said on the row`);
  }
  // Once, beside Apply, where the choice is sent (iOS's applySection, the
  // sheet's Apply row on Android), and only when a router there would change.
  assert.match(I_FORM, /if choice\.rebuildsRouter\(in: inv\) \{\s*Text\("Applying rebuilds the router\./);
  assert.match(A_SHEET, /if \(XoPolicy\.rebuildsRouter\(inv, c\)\) \{\s*Hint\("Applying rebuilds the router\./);
  assert.ok(I_FORM.includes(REBUILD) && A_SHEET.includes(REBUILD));
  assert.match(I_POLICY, /func rebuildsRouter\(in inv: Inventory\) -> Bool \{\s*guard edge, let there = inv\.edge\(on: egress\) else \{ return false \}\s*return \(there\.blocks \?\? false\) != edgeBlock \|\| \(there\.ha \?\? false\) != edgeHa \|\| labsChanged\(in: inv\)/);
  assert.match(A_POLICY, /fun rebuildsRouter\(inv: Inventory, c: Choice\): Boolean \{\s*if \(!c\.edge\) return false\s*val there = edgeOn\(inv, c\.egress\) \?: return false\s*return \(there\.blocks \?: false\) != c\.edgeBlock \|\| \(there\.ha \?: false\) != c\.edgeHa \|\| labsChanged\(inv, c\)/);
});
