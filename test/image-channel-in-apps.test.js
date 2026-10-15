// What a pool's machine images are built from, chosen on its policy: released
// versions or every merge to main. Offered only by a box that builds from
// either, sent with Apply, started from what the pool's image was built from,
// and said in the same words on both phones.
//
//   node --test test/image-channel-in-apps.test.js
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. The payload itself is run, not read: XOPolicyTests.swift and
// XoPolicyTest.kt. The box's half is test/xo-setup.test.js and
// xo-pools.test.js. ASKED FOR: "Or should we build a path for the images to
// use main/rolling?" docs/hypervisors.md, "Built from main".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const A = (/** @type {string} */ f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`);
const I = (/** @type {string} */ f) => read(`apps/ios/Fleetwright/${f}`);

const PHONES = [
  { name: 'iOS', form: I('AddHypervisorView.swift'), policy: I('XOPolicy.swift'), sheet: I('AddHypervisorView.swift') },
  { name: 'Android', form: A('PolicyForm.kt'), policy: A('XoPolicy.kt'), sheet: A('HypervisorSheet.kt') },
];

/** What both phones say, word for word. */
const SAID = [
  '"Built from"',
  '"Released versions"',
  '"Every merge to main"',
  'Fleetwright from the newest build of main. Machines made from the image update on every merge, to builds nobody released.',
  'Fleetwright from the newest release. Machines made from the image update to each release.',
  ' An image that is there keeps what it was built from until it is rebuilt.',
  ' It was built from main.',
];

test('both phones say it in the same words', () => {
  for (const p of PHONES) {
    for (const s of SAID) assert.ok(p.form.includes(s) || p.policy.includes(s), `${p.name}: ${s}`);
  }
});

test('the choice is offered only by a box that says image-channel (C-2), and sent as imageChannel', () => {
  for (const p of PHONES) {
    assert.ok(p.sheet.includes('"image-channel"'), `${p.name}: read from begin's can`);
    assert.match(p.form, p.name === 'iOS' ? /if choice\.imageChannelChoice \{/ : /if \(choice\.imageChannelChoice\) \{/, `${p.name}: the choice is behind it`);
    // The field the box reads (src/fleet/host/xo-setup.js, checkPolicy), and
    // the two words it takes (IMAGE_CHANNELS in vm-image.js).
    assert.ok(p.policy.includes('"imageChannel"'), `${p.name}: sent under imageChannel`);
    assert.ok(p.policy.includes('"stable"') && p.policy.includes('"rolling"'), `${p.name}: the box's words`);
    // Read back from the inventory, which is how the choice starts where the
    // image was and a present image says it was built from main.
    assert.ok(p.policy.includes(p.name === 'iOS' ? 'var channel: String? = nil' : 'text(m, "channel")'), `${p.name}: decoded`);
  }
});
