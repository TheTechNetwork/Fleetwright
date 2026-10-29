// What a person sees of a notification the Android app draws itself.
//
//   node --test test/push-in-apps.test.js
//
// A notification the tray draws is opened and routed by the system: FCM hands
// its `data` to the launcher intent and MainActivity reads it. Once the app
// draws one — every answerable one, and on a phone with a push key every
// sealed one (docs/push-encryption.md) — the tap carries only what
// Messaging.openIntent puts on it, and the words are only what the app wrote.
// The crypto and the category rule are tested where they run, in
// PushCryptoTest.kt and PushCryptoTests.swift; this is the part Kotlin unit
// tests cannot reach, because Intent is a stub there.
//
// And the one line both phones show on You when they do not know they can
// open what is sealed to them. When it is shown is PushKeyRule.Evidence, held
// to its cases in those same unit tests; the words are here, because both
// phones have to say the same sentence and only a read of both sources can
// see that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { envelopeFor } from '../src/fleet/push.js';
import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

const kotlin = (/** @type {string} */ f) =>
  readFileSync(new URL(`../apps/android/app/src/main/java/network/thetech/fleetwright/${f}`, import.meta.url), 'utf8');

test('a tap on a notification the app drew carries every extra MainActivity routes a tap on', () => {
  // The extras MainActivity reads by name: the wire keys a notification's
  // `data` arrives with (`event`, `name`, `hostId`, `kind`). A key read
  // through a constant (XoSetupNotice, PoolNotice) belongs to a notification
  // that builds its own intent, and is not this one's to carry.
  const routed = new Set(
    [...kotlin('MainActivity.kt').matchAll(/(?:getStringExtra|hasExtra)\("([^"]+)"\)/g)].map((m) => m[1]),
  );
  assert.ok(routed.has('event') && routed.has('name'), 'MainActivity no longer routes a session tap by name');

  const messaging = kotlin('Messaging.kt');
  const open = messaging.slice(messaging.indexOf('fun openIntent'), messaging.indexOf('fun answerIntent'));
  const carried = new Set([...open.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  if (/\bOPEN_KEYS\b/.test(open)) {
    const list = messaging.match(/OPEN_KEYS = listOf\(([^)]*)\)/);
    assert.ok(list, 'openIntent names OPEN_KEYS and there is no list');
    for (const m of list[1].matchAll(/"([^"]+)"/g)) carried.add(m[1]);
  }
  const missing = [...routed].filter((key) => !carried.has(key));
  assert.deepEqual(missing, [], `a tap on a notification the app drew drops ${missing.join(', ')}, so it opens on whatever was last on screen`);
});

test('a seal the phone cannot open says the sentence the coordinator put on the alert', async () => {
  // iOS keeps no copy: the alert already says it, and a failed open leaves
  // it. Android draws the notification itself, so it has the words, and they
  // are the same words.
  const alert = await envelopeFor(
    { pushKey: 'BCGcSbxeM7YEm2bc-9t5Y_N--9Qv-U7FTgxUwCpvbMwYj1Jf0kDo-6zXgjYuSgpp4O1oUtj8rRGAHafuS4mdJtQ' },
    { title: 't', body: 'b' },
  );
  const reveal = kotlin('PushCrypto.kt');
  assert.equal(reveal.match(/FALLBACK_TITLE = "([^"]+)"/)?.[1], alert.title);
  assert.equal(reveal.match(/FALLBACK_BODY = "([^"]+)"/)?.[1], alert.body);
});

test('a phone that could not use its key says so on You, in the same words on both', () => {
  // A key sent that the phone could not use, or a seal it could not open, was
  // silent everywhere: the coordinator seals to the key it was sent, delivery
  // succeeds, and every notification is the fallback sentence.
  const said =
    'Notifications sent to this phone may arrive without their words: it could not use its key the last time it tried. It tries again each time Fleetwright starts.';
  const ios = iosSources();
  const android = androidSources();
  assert.ok(ios.includes(said), 'iOS does not say it');
  assert.ok(android.includes(said), 'Android does not say it');
  // Only while the phone is in doubt, and read from what it keeps.
  assert.match(ios, /if pushInDoubt \{\s*Text\("Notifications sent to this phone/);
  assert.match(ios, /pushInDoubt = doubt/);
  assert.match(ios, /static var inDoubt: Bool \{[\s\S]{0,80}?return evidence\?\.doubt != nil/);
  assert.match(android, /visible = pushInDoubt,[\s\S]{0,200}?"Notifications sent to this phone/);
  assert.match(android, /pushInDoubt = settings\.pushKeyEvidence\?\.doubt != null/);
});
