// A machine that is enrolled and not reporting is still a machine.
//
// The fleet screen listed what the coordinator could hear right now, and a box
// that had gone quiet was simply absent — which read as "does not exist". It
// exists: it is enrolled, the coordinator holds its key, and that key is what
// a reinstalled box is refused for. "RPI-7550-ARM is already enrolled.
// Replacing the key of a machine that exists takes a pin minted for that name"
// names a remedy on the machine's own page, and iOS reached that page only
// through a card that only a reporting machine got. So a routine reinstall
// ended in a curl carrying the break-glass admin token, again (see
// bound-pin.test.js for the first time).
//
// Checked on the source rather than by running it, as the app tests here are:
// neither app builds in this environment, and the property is "the list is
// the membership, not the moment", which breaks by somebody filtering it back
// down to what is reporting.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';
import { HostIdentities } from '../src/fleet/coordinator/hosts.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('iOS lists every enrolled machine that is not reporting, and each one leads to its page', () => {
  const swift = iosSources();
  // The membership minus the reporting: not the reporting minus nothing.
  assert.match(swift, /hosts\.filter \{ h in !fleetHosts\.contains \{ \$0\.hostId == h\.hostId \} \}/, 'quiet machines are not listed');
  assert.match(swift, /ForEach\(silent\) \{ host in\s*\n\s*Button \{ showing = host\.hostId \}/, 'a quiet machine does not lead to its page');
  // Named as what it is. The word carries the state; the colour only reinforces it.
  assert.match(swift, /host\.isRevoked \? "revoked" : "not reporting"/);
  // And it leads to the page where Replace key and Revoke live, with the
  // membership record and NO invented report: nil is "cannot tell".
  assert.match(swift, /initialHealth: reporting\?\.health,\n\s+initialState: reporting\?\.state \?\? \(member\?\.isRevoked == true \? "revoked" : "not reporting"\),[\s\S]{0,400}?enrolled: member,/);
  // What the fleet knows about its absence, and nothing more.
  assert.match(swift, /func absence\(_ host: Fleet\.Host\) -> String/);
  assert.match(swift, /return "never connected"/);
  assert.match(swift, /"last seen \\\(relativeTime\(seen\)\)"/);
});

test('Android says when a listed machine was last heard from', () => {
  const kotlin = androidSources();
  const client = read('apps/android/app/src/main/java/network/thetech/fleetwright/Fleet.kt');
  // Parsed from the membership record, and null when the box never connected —
  // a different fact from "a while ago", shown as one.
  assert.match(client, /lastSeenAt = o\.optLong\("lastSeenAt", 0L\)\.takeIf \{ it > 0L \}/);
  assert.match(kotlin, /host\.lastSeenAt\?\.let \{ "last seen " \+ relative\(it\) \} \?: "never connected"/);
});

test('the membership list the apps read carries when each machine was last seen', () => {
  const hosts = new HostIdentities();
  hosts.restore([
    { hostId: 'quiet', publicJwk: { kty: 'EC' }, fingerprint: 'f'.repeat(16), enrolledAt: 1, lastSeenAt: 500, revokedAt: null },
    { hostId: 'never', publicJwk: { kty: 'EC' }, fingerprint: 'e'.repeat(16), enrolledAt: 2, lastSeenAt: null, revokedAt: null },
  ]);
  const byId = Object.fromEntries(hosts.list().map((h) => [h.hostId, h]));
  assert.equal(byId.quiet.lastSeenAt, 500);
  assert.equal(byId.never.lastSeenAt, null);
});
