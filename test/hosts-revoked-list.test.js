// Removing a host has to LOOK like removing a host.
//
// Revoke marks the entry rather than deleting it, so a reconnecting host can be
// told "you were revoked" instead of "never enrolled" (see prove()). Right, and
// it leaked into the display: the app renders the enrolled list under "Hosts",
// list() did not filter, and a removed host sat there looking exactly like the
// removal not working. Reported as "removing a host in the app, it comes right
// back" -- it never came back, it never left.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HostIdentities } from '../src/fleet/coordinator/hosts.js';

function withHost(id) {
  const hosts = new HostIdentities();
  hosts.restore([{ hostId: id, publicJwk: { kty: 'EC' }, fingerprint: 'f'.repeat(16), enrolledAt: 1, revokedAt: null }]);
  return hosts;
}

test('a revoked host leaves the list a person reads', () => {
  const hosts = withHost('gone-box');
  assert.equal(hosts.list().length, 1);
  assert.equal(hosts.revoke('gone-box'), true);
  assert.deepEqual(hosts.list(), []);
});

test('but stays in storage, so a reconnect is told the truth', () => {
  const hosts = withHost('gone-box');
  hosts.revoke('gone-box');
  // Still present internally -- prove() needs it to say "revoked", and
  // serialise() must persist it or a restart un-revokes the host.
  assert.equal(hosts.serialise().length, 1);
  assert.ok(hosts.serialise()[0].revokedAt);
});

test('revoking twice is agreement, not a new event', () => {
  const hosts = withHost('gone-box');
  assert.equal(hosts.revoke('gone-box'), true);
  // false = nothing changed. The route layer turns this into 200 "already
  // revoked" rather than the 404 "is not enrolled" it used to send -- a person
  // staring at the host in a stale list was told it did not exist.
  assert.equal(hosts.revoke('gone-box'), false);
});

test('the list never carries key material, revoked or not', () => {
  const hosts = withHost('box');
  for (const h of hosts.list()) assert.equal(h.publicJwk, undefined);
});
