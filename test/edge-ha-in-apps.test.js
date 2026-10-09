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
const HOST = read('src/fleet/host/xo-setup.js');

/** What the phones say, word for word: iOS here, and Android with it in its own layer. */
const SHARED = [
  'Two edge routers',
  'On: they share the way out, so one carries the machines while the other restarts for an update.',
  'Off: one router, and when it restarts for an update, machines behind it have no way out for those minutes.',
  ' Apply makes the second and hands over to it: machines behind it have no way out while it starts.',
  ' Apply removes the second and rebuilds the first: machines behind it have no way out until it is up.',
];

test('offered only by a machine whose `can` says so, and only with the router asked for', () => {
  assert.ok(HOST.includes("'edge-ha'"), 'the machine does not say it can');
  assert.match(I_FORM, /canEdgeHa: begun\.can\.contains\("edge-ha"\)/);
  assert.match(I_FORM, /if choice\.edgeHaChoice, canEdge, choice\.edge, choice\.egress != nil \{/);
});

test('sent only to a machine that reads it, only with the router, as the key checkPolicy reads', () => {
  assert.match(I_POLICY, /if edgeHaChoice, edge \{ out\["edgeHa"\] = edgeHa \}/);
  assert.ok(HOST.includes('p.edgeHa'));
});

test('the phone starts it as the router is, and as each pool’s is when the way out changes', () => {
  assert.match(I_POLICY, /c\.edgeHa = inv\.edge\(on: c\.egress\)\?\.ha \?\? false/);
  assert.match(I_FORM, /choice\.edgeHa = inv\.edge\(on: way\)\?\.ha \?\? false/);
});

test('the phone says it in these words', () => {
  for (const words of SHARED) {
    assert.ok(I_FORM.includes(words), `iOS: ${words}`);
  }
});
