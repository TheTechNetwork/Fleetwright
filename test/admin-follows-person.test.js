// Admin follows the person, not the credential row.
//
// It was granted to the first credential ever issued and stuck there -- so
// signing out and back in on the same phone DEMOTED THE FLEET'S OWNER: the old
// row kept admin, hasAdmin() said "taken", and the new credential came out a
// plain member whose every host removal answered 403. The app closed the
// confirmation sheet without showing the refusal, so the symptom was "the host
// comes right back or never gets deleted".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const core = () => new CoordinatorCore({ logger: silent });

test('the first person in is the admin', async () => {
  const c = core();
  const { client } = await c.issueClient({ email: 'owner@example.com' }, 'iPhone');
  assert.equal(client.admin, true);
});

test('the same person signing in again is STILL the admin', async () => {
  // The bug: this second credential came out a plain member, because admin
  // lived on the first row and hasAdmin() said the seat was taken.
  const c = core();
  await c.issueClient({ email: 'owner@example.com' }, 'iPhone');
  const { client } = await c.issueClient({ email: 'owner@example.com' }, 'iPhone again');
  assert.equal(client.admin, true, 'signing in again must not demote the owner');
});

test('case differences in the email do not drop the role', async () => {
  const c = core();
  await c.issueClient({ email: 'owner@example.com' }, 'iPhone');
  const { client } = await c.issueClient({ email: 'Owner@Example.com' }, 'iPad');
  assert.equal(client.admin, true);
});

test('a different person is a member, exactly as before', async () => {
  const c = core();
  await c.issueClient({ email: 'owner@example.com' }, 'iPhone');
  const { client } = await c.issueClient({ email: 'colleague@example.com' }, 'Pixel');
  assert.equal(client.admin, false);
});

test('revoking the admin device does not revoke the admin person', async () => {
  // Revocation is for lost devices. Demotion is removal from the allowlist,
  // after which sign-in is refused and none of this is consulted.
  const c = core();
  const first = await c.issueClient({ email: 'owner@example.com' }, 'lost phone');
  c.clients.revoke(first.client.id);
  const { client } = await c.issueClient({ email: 'owner@example.com' }, 'new phone');
  assert.equal(client.admin, true, 'a lost phone must not cost the person their role');
});

test('the admin seat does not leak to a member through revocation', async () => {
  // With every admin row revoked, hasAdmin() is false and the first-person-in
  // rule fires again for whoever arrives next. The owner is covered by the
  // email rule; a member arriving in that window must still be a member.
  const c = core();
  const first = await c.issueClient({ email: 'owner@example.com' }, 'phone');
  c.clients.revoke(first.client.id);
  const m = await c.issueClient({ email: 'colleague@example.com' }, 'Pixel');
  assert.equal(m.client.admin, false, 'a member must never inherit the seat because the admin lost a phone');
});
