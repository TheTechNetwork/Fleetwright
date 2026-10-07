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

/** What both phones say, word for word. */
const SHARED = [
  'Drop what the threat rules match',
  'On: Suricata drops it, and while it cannot inspect, nothing leaves.',
  'Off: Suricata logs it by machine and lets it through.',
  ' Apply rebuilds the edge router to change this: machines behind it have no way out until the new one is up.',
];

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
});
