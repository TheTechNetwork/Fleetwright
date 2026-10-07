// What a machine did on the network, on the phones: half an hour of what it
// sent and received as the hypervisor counted it, on the machine's page,
// with a gap kept a gap and nothing reported said for what it is.
//
//   node --test test/vm-traffic-in-apps.test.js
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. ASKED FOR: "what each session's VM did on the network, on the
// phone". docs/hypervisors.md, "What a machine did on the network".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const I_FLEET = read('apps/ios/Fleetwright/Fleet.swift');
const I_PAGE = read('apps/ios/Fleetwright/VMMachineView.swift');
const A = (/** @type {string} */ f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`);
const A_FLEET = A('Fleet.kt');
const A_PAGE = A('VmMachinePage.kt');

/** What both phones say, word for word. */
const SHARED = [
  'On the network',
  'Received is the solid line, sent the dashed one.',
  'Not counted in the last minute',
  ' not counted',
  'The pool has not said what it sent and received. The box holding it asks each time it looks.',
  'It is not running, so there is nothing to count.',
  'As the hypervisor counted it at this machine’s network interfaces, which nothing running on the machine can change. ',
  'It is how much went in and out, not where it went.',
  ', received at most ',
  'nothing counted',
];

test('both phones read the traffic with a point nobody counted kept as nothing, not a zero', () => {
  assert.match(I_FLEET, /let net: Traffic\?/);
  assert.match(I_FLEET, /let rx: \[Double\?\]/);
  assert.match(A_FLEET, /val net: Traffic\?/);
  assert.match(A_FLEET, /val rx: List<Double\?>/);
  assert.match(A_FLEET, /if \(a\.isNull\(i\)\) null else/);
  // Uneven is none, as the coordinator holds it.
  assert.match(A_FLEET, /if \(rx\.size == tx\.size\) VmMachine\.Traffic\(interval, end, rx, tx\) else null/);
});

test('both phones draw a gap as a break in the line, sent dashed, and in the chart ramp', () => {
  assert.match(I_PAGE, /guard let v else \{ drawing = false; continue \}/);
  assert.match(A_PAGE, /if \(v == null\) \{\s*drawing = false/);
  assert.match(I_PAGE, /\.stroke\(Design\.Palette\.chart4, style: StrokeStyle\([^)]*dash: \[4, 3\]\)\)/);
  assert.match(A_PAGE, /PathEffect\.dashPathEffect\(floatArrayOf\(4\.dp\.toPx\(\), 3\.dp\.toPx\(\)\)\)/);
  for (const page of [I_PAGE, A_PAGE]) assert.ok(page.includes('chart5') && page.includes('chart4'));
});

test('both phones say it in the shared words', () => {
  for (const words of SHARED) {
    assert.ok(I_PAGE.includes(words), `iOS: ${words}`);
    assert.ok(A_PAGE.includes(words), `Android: ${words}`);
  }
});
