// Two edge routers, on the phones: a switch under the edge router, offered
// only by a machine that builds a pair, sent only with the router asked for,
// under the key checkPolicy reads, starting as the router is, and said in
// the same words on both phones, including what changing it costs.
//
//   node --test test/edge-ha-in-apps.test.js
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. ASKED FOR: "do ha will allow maintenance". docs/hypervisors.md,
// "Two edge routers".

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
  'Two edge routers',
  'No downtime during updates',
  'Brief outage during updates',
];
// Going back to one, or to two, rebuilds the router that is there: the first
// is rebuilt beside the second while the second still carries the machines
// (ONE_BOOT in src/fleet/host/edge-router.js). Said once, beside Apply, in
// the sentence edge-block-in-apps.test.js pins, and not on the row.
const REBUILD = 'Applying rebuilds the router. VMs behind it lose internet while the new one starts.';

test('offered only by a machine whose `can` says so, and only with the router asked for', () => {
  assert.ok(HOST.includes("'edge-ha'"), 'the machine does not say it can');
  assert.match(I_FORM, /canEdgeHa: begun\.can\.contains\("edge-ha"\)/);
  assert.match(I_FORM, /if choice\.edgeHaChoice, canEdge, choice\.edge, choice\.egress != nil \{/);
  assert.match(A_SHEET, /canEdgeHa = "edge-ha" in p\.setup\.can/);
  assert.match(A_FORM, /if \(canEdge && choice\.edgeHaChoice && choice\.edge && choice\.egress != null\) \{/);
});

test('sent only to a machine that reads it, only with the router, as the key checkPolicy reads', () => {
  assert.match(I_POLICY, /if edgeHaChoice, edge \{ out\["edgeHa"\] = edgeHa \}/);
  assert.match(A_POLICY, /if \(c\.edgeHaChoice && c\.edge\) put\("edgeHa", c\.edgeHa\)/);
  assert.ok(HOST.includes('p.edgeHa'));
});

test('both phones start it as the router is, and as each pool’s is when the way out changes', () => {
  assert.match(I_POLICY, /c\.edgeHa = inv\.edge\(on: c\.egress\)\?\.ha \?\? false/);
  assert.match(A_POLICY, /edgeHa = edgeOn\(inv, egress\)\?\.ha \?: false/);
  assert.match(I_FORM, /choice\.edgeHa = inv\.edge\(on: way\)\?\.ha \?\? false/);
  assert.match(A_FORM, /edgeHa = edge\?\.ha \?: false/);
});

test('both phones say it in the same words', () => {
  for (const words of SHARED) {
    assert.ok(I_FORM.includes(words), `iOS: ${words}`);
    assert.ok(A_FORM.includes(words), `Android: ${words}`);
  }
  for (const [name, form] of [['iOS', I_FORM], ['Android', A_FORM]]) {
    assert.ok(!form.includes('no way out until it is up'), `${name}: going back to one still says the way out is gone for the whole build`);
    assert.ok(!form.includes('Apply removes the second and rebuilds the first'), `${name}: the rebuild is still said on the row`);
  }
  assert.ok(I_FORM.includes(REBUILD) && A_SHEET.includes(REBUILD));
  // And the rule that shows it counts the pair.
  assert.match(I_POLICY, /func rebuildsRouter\(in inv: Inventory\) -> Bool \{[\s\S]{0,200}?\(there\.ha \?\? false\) != edgeHa/);
  assert.match(A_POLICY, /fun rebuildsRouter\(inv: Inventory, c: Choice\): Boolean \{[\s\S]{0,200}?\(there\.ha \?: false\) != c\.edgeHa/);
});
