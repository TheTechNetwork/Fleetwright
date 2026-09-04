// Readmitting a revoked host, and re-keying an existing one, from the app.
//
// The coordinator refuses an unbound pin for both, deliberately and with good
// reasons it states out loud:
//
//   "<id> was revoked. Readmitting it takes a pin minted for that, so that
//    bringing a removed machine back is a decision somebody makes rather than
//    a side effect."
//
//   "<id> is already enrolled. Replacing the key of a machine that exists takes
//    a pin minted for that name, so that a pin handed out to add a box cannot
//    be spent taking over another one."
//
// Both name the remedy. Neither remedy was reachable from either app, so a
// reinstalled box — which is every box that has ever been cleaned — could only
// be brought back with a curl carrying the break-glass admin token. That is the
// credential the whole per-device design exists to stop needing, and reaching
// for it to fix a routine reinstall is the shape of #323 a third time.
//
// IT WAS NEVER A PERMISSION PROBLEM. /api/enroll has no admin gate — the
// destructive-route guard covers DELETE on hosts and clients and nothing else —
// so any signed-in phone could always have done this. It was a screen that was
// missing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const IOS_CLIENT = read('apps/ios/Fleetwright/Fleet.swift');
const IOS_VIEW = read('apps/ios/Fleetwright/FleetView.swift');
const DROID_CLIENT = read('apps/android/app/src/main/java/network/thetech/fleetwright/Fleet.kt');
const DROID_VIEW = read('apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt');

test('minting a pin needs no admin credential, which is why this is only a screen', () => {
  // Asserted rather than assumed, because if an admin gate is ever added to
  // /api/enroll these buttons silently become a 403 for everybody who is not
  // one — and the failure would arrive as "could not mint a pin".
  const guard = read('worker/src/fleet-do.js');
  const destructive = /if \(\/\^\\\/api\\\/\(([^)]*)\)\\\/\/\.test\(url\.pathname\) && request\.method === 'DELETE'/.exec(guard);
  assert.ok(destructive, 'the destructive-route guard has moved');
  assert.equal(destructive[1].includes('enroll'), false, 'minting a pin now needs admin — the buttons will 403');
});

test('both clients can bind a pin to one host, and ask for readmission', () => {
  for (const [name, src] of [['iOS', IOS_CLIENT], ['Android', DROID_CLIENT]]) {
    assert.match(src, /hostId/, `${name} cannot bind a pin to a host`);
    assert.match(src, /readmit/, `${name} cannot ask for readmission`);
  }
  // OMITTED WHEN ABSENT rather than sent as null. A null hostId binds the pin
  // to nothing and reads, on the wire, as somebody having meant to.
  assert.match(IOS_CLIENT, /if let hostId, !hostId\.isEmpty \{/);
  assert.match(DROID_CLIENT, /if \(!hostId\.isNullOrBlank\(\)\)/);

  // The unbound form still works unchanged — adding a box is what almost every
  // pin is for, and it must stay one tap.
  assert.match(IOS_CLIENT, /func mintHostPin\(ephemeral: Bool = false/);
  assert.match(DROID_CLIENT, /ephemeral: Boolean = false,/);
});

test('both apps offer the right verb for the state the host is in', () => {
  // Readmit for a revoked host, Replace key for a live one. Two different
  // refusals, two different remedies, and showing the wrong word would send
  // somebody to a pin the coordinator declines.
  assert.match(IOS_VIEW, /host\.isRevoked \? "Readmit" : "Replace key"/);
  assert.match(DROID_VIEW, /if \(host\.revoked\) "Readmit" else "Replace key"/);
  assert.match(IOS_VIEW, /mintBoundPin\(for: host\.hostId, readmit: host\.isRevoked\)/);
  assert.match(DROID_VIEW, /hostId = host\.hostId, readmit = host\.revoked/);
});

test('a bound pin says which box it is for, on both phones', () => {
  // It only works on the machine it names, and the refusal for using it
  // elsewhere arrives on the BOX rather than on this screen. Six digits with no
  // owner is a pin somebody types into the wrong terminal.
  assert.match(IOS_VIEW, /for \\\(bound\) only/);
  assert.match(DROID_VIEW, /for \$pinBoundTo only/);

  // And it is cleared when an unbound pin is minted, so the label cannot
  // outlive the pin it described.
  assert.match(IOS_VIEW, /pinBoundTo = nil\n\s+do \{/);
  assert.match(DROID_VIEW, /pinBoundTo = ""\n\s+pin = runCatching \{ Fleet\(settings\)\.mintHostPin\(ephemeralPin\)/);
});

test('a failed mint does not leave the old pin wearing a new name', () => {
  // The label is set only after the call returns a code. Setting it first would
  // relabel whatever was already on screen as belonging to the host somebody
  // just tapped.
  assert.match(IOS_VIEW, /pin = try await Fleet\(settings: settings\)\.mintHostPin\(hostId: hostId, readmit: readmit\)\n\s+\/\/[\s\S]{0,200}?pinBoundTo = hostId/);
  assert.match(DROID_VIEW, /if \(pin\.isNotBlank\(\)\) pinBoundTo = host\.hostId/);
});
