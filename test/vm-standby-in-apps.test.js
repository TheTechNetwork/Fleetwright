// Machines kept ready on your hypervisor, on the phones: the setting, what it
// costs said before it is asked for, the image in New session that has one
// ready, and a kept machine named as one in the list.
//
//   node --test test/vm-standby-in-apps.test.js
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. ASKED FOR: "standby vms to speed up session starts".
// docs/hypervisors.md, "Machines kept ready".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const IOS = (/** @type {string} */ f) => read(`apps/ios/Fleetwright/${f}`);
const I_FLEET = IOS('Fleet.swift');
const I_VIEW = IOS('VMStandbyView.swift');
const I_LIST = IOS('MachinesView.swift');
const I_SHEET = IOS('StartSheet.swift');

/** What both phones say, word for word. */
const SHARED = [
  'Keep machines ready',
  'A session from this image starts on a ready one at once, and another is made behind it. Each uses a machine’s worth of your pool all the time, and is replaced when its 350 minutes run out.',
  'None kept ready.',
  ' ready now, ',
  ' being made, of ',
  'Stop keeping any',
  'Keep them ready',
  'kept ready',
  ', ready now',
  'Behind the edge router',
];

test('iOS: what is kept ready is read from the snapshot and set through the fleet, 0 to 3', () => {
  assert.match(I_FLEET, /struct Reply: Codable \{ let vmStandby: VMStandby\? \}/);
  assert.match(I_FLEET, /send\("PUT", "\/api\/vm-standby", body: body\)/);
  assert.match(I_FLEET, /body\["network"\] = network\.map \{ \$0 as Any \} \?\? NSNull\(\)/);
  assert.match(I_VIEW, /Stepper\("Keep \\\(count\) ready", value: \$count, in: 0\.\.\.3\)/);
});

test('iOS: the setting is offered only where an image is, and the image with one ready says so', () => {
  assert.match(I_LIST, /if !poolImages\.isEmpty \{\s*NavigationLink \{\s*VMStandbyView/);
  assert.match(I_SHEET, /standby\?\.template == image\.template && \(standby\?\.ready \?\? 0\) > 0/);
  assert.match(I_LIST, /m\.standby == true \? "kept ready" : m\.image/);
});

test('iOS: the count moves while it is open, says when the one being made was asked for, and why the last did not come', () => {
  // A person looked an hour later and was told "0 being made" and nothing
  // else: two machines had failed to join and were forgotten in silence.
  assert.match(I_FLEET, /var since: Double\? = nil/);
  assert.match(I_FLEET, /var failed: Failure\? = nil\s*struct Failure: Codable, Hashable \{\s*let at: Double\s*let text: String\s*\}/);
  assert.match(I_VIEW, /if let failed = kept\?\.failed \{\s*Text\("\\\(Self\.clock\(failed\.at\)\): \\\(failed\.text\)"\)[\s\S]{0,120}?Design\.Palette\.bad/);
  assert.match(I_VIEW, /while !Task\.isCancelled \{\s*try\? await Task\.sleep\(for: \.seconds\(15\)\)\s*await refresh\(\)/);
  // The reply to the tap goes once the count has moved on; a refusal stays.
  assert.match(I_VIEW, /if got != kept, !failed \{ message = "" \}/);
  // The coordinator's own field names.
  const core = read('src/fleet/coordinator/core.js');
  assert.match(core, /\.\.\.\(since === null \? \{\} : \{ since \}\), \.\.\.\(failed \? \{ failed \} : \{\}\)/);
});

test('iOS says it in the shared words', () => {
  const ios = [I_FLEET, I_VIEW, I_LIST, I_SHEET].join('\n');
  for (const words of SHARED) assert.ok(ios.includes(words), words);
});

// --- Android ------------------------------------------------------------------

const ANDROID = (/** @type {string} */ f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`);
const A_FLEET = ANDROID('Fleet.kt');
const A_VIEW = ANDROID('VmStandbyScreen.kt');
const A_LIST = ANDROID('MachinesScreen.kt');
const A_SHEET = ANDROID('StartSheet.kt');

test('Android: what is kept ready is read from the snapshot and set through the fleet, 0 to 3', () => {
  assert.match(A_FLEET, /get\("\/api\/hosts"\)\.optJSONObject\("vmStandby"\)/);
  assert.match(A_FLEET, /send\("PUT", "\/api\/vm-standby", body\)/);
  assert.match(A_FLEET, /\.put\("network", network \?: JSONObject\.NULL\)/);
  assert.match(A_VIEW, /enabled = !busy && count > 0/);
  assert.match(A_VIEW, /enabled = !busy && count < 3/);
});

test('Android: the setting is offered only where an image is, and the image with one ready says so', () => {
  assert.match(A_LIST, /if \(poolImages\.isNotEmpty\(\)\) \{/);
  assert.match(A_SHEET, /val ready = standby\?\.template == image\.template && \(standby\?\.ready \?: 0\) > 0/);
  assert.match(A_LIST, /if \(m\.standby\) "kept ready" else m\.image/);
});

test('Android says it in the shared words', () => {
  const android = [A_FLEET, A_VIEW, A_LIST, A_SHEET].join('\n');
  for (const words of SHARED) assert.ok(android.includes(words), words);
});
