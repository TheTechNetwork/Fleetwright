// The pool's own machine, on the phones: a switch on the policy screen's way
// out, offered only by a machine that makes one, sent only when asked, held
// to the machine's own rules in its own words, and said as there when the
// pool has one.
//
//   node --test test/holder-in-apps.test.js
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. ASKED FOR: "dedicated hypervisor VM on the pool (preferred holder;
// any LAN host is the fallback)". docs/hypervisors.md, "A machine of its own".

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
const HOST_SAYS = read('src/fleet/host/xo-holder.js');

/** The machine's refusals, which each phone says before Apply rather than after. */
const RULES = [
  'The pool’s own machine goes on the way out: choose the network it is on.',
  'The pool’s own machine is made from its machine image, and that pool has none yet. Build one with it.',
];

/** What both phones say, word for word. */
const SHARED = [
  'Make the pool a machine of its own',
  'A Fleetwright machine that stays up on this network, made from the pool’s machine image and kept outside what the ',
  'fleet may use, so the pool does not need ',
  ' to be awake. Once it joins, approve it under Machines and it ',
  'holds the pool.',
  ' is there and running. It holds the pool once you have approved it under Machines.',
  ' is there and stopped. Apply starts it.',
];

test('offered only by a machine whose `can` says so, and only where the inventory says whether there is one', () => {
  assert.match(I_FORM, /canHolder: begun\.can\.contains\("holder"\)/);
  assert.match(I_FORM, /choice\.holderChoice = policyJob\.canHolder && opened\.holders != nil/);
  assert.match(I_FORM, /if choice\.holderChoice, choice\.egress != nil \{/);
  assert.match(A_SHEET, /canHolder = "holder" in p\.setup\.can/);
  assert.match(A_SHEET, /holderChoice = canHolder && opened\.holders != null/);
  assert.match(A_FORM, /if \(choice\.holderChoice && choice\.egress != null\) \{/);
  // The machine offers it on the same terms.
  assert.ok(HOST.includes("...(this.coordinatorUrl && this.holderPin ? ['holder'] : [])"));
});

test('sent only to a machine that reads it, only when asked, as the key checkPolicy reads', () => {
  assert.match(I_POLICY, /if holderChoice, holder \{ out\["holder"\] = true \}/);
  assert.match(A_POLICY, /if \(c\.holderChoice && c\.holder\) put\("holder", true\)/);
  assert.ok(HOST.includes('const holder = p.holder === true;'));
});

test('both phones hold it to the machine’s rules, in the machine’s words', () => {
  for (const rule of RULES) {
    assert.ok(HOST.includes(rule), `host: ${rule}`);
    assert.ok(I_POLICY.includes(rule), `iOS: ${rule}`);
    assert.ok(A_POLICY.includes(rule), `Android: ${rule}`);
  }
});

test('asking for one where the pool has no image asks for Debian’s, and the router behind it', () => {
  assert.match(I_FORM, /if choice\.imagesChoice \{ choice\.images\.insert\(XOPolicy\.debianKey\) \} else \{ choice\.image = true \}/);
  assert.match(A_FORM, /images = if \(needsImage && choice\.imagesChoice\) choice\.images \+ XoPolicy\.DEBIAN_KEY else choice\.images/);
  // And the machine tells the person what is left, which is theirs to do.
  assert.ok(HOST_SAYS.includes('Approve it under Machines once it joins, and it holds this pool from then on.'));
});

test('both phones say it in the shared words', () => {
  for (const words of SHARED) {
    assert.ok(I_FORM.includes(words), `iOS: ${words}`);
    assert.ok(A_FORM.includes(words), `Android: ${words}`);
  }
});
