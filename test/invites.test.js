// Letting somebody into the fleet without a deploy.
//
//   node --test test/
//
// `AGENT_FLEET_AUTH_ALLOW` is an environment variable, so adding a person meant
// editing wrangler.toml, committing, and waiting for a deploy — a CODE CHANGE
// PER PERSON, performed by the one person who can already do everything. For a
// product whose premise is "nothing to ssh into", it was the last thing you had
// to be at a keyboard to do.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Invites } from '../src/fleet/coordinator/invites.js';
import { isAllowed } from '../src/fleet/coordinator/oidc.js';

test('an invited person can sign in; the env list still decides on its own', () => {
  // TWO LISTS ANSWERING TWO QUESTIONS. The env one says who this DEPLOYMENT
  // belongs to and survives losing all state, which is what makes it the
  // bootstrap: a coordinator whose storage is empty still knows its owner, so
  // there is always somebody who can let everybody else back in.
  const invites = new Invites();
  const env = ['owner@example.com'];

  assert.equal(isAllowed('guest@example.com', env) || invites.has('guest@example.com'), false);

  invites.add('guest@example.com', { invitedBy: 'owner@example.com' });

  assert.equal(isAllowed('guest@example.com', env) || invites.has('guest@example.com'), true);
  assert.equal(isAllowed('owner@example.com', env), true, 'and the owner never depended on storage');
});

test('a whole domain cannot be invited from a phone', () => {
  // The env list allows `@domain` entries; this deliberately does not. Inviting
  // a company from a phone is a decision whose blast radius nobody can see at
  // the moment they make it — every future address there, admitted by a tap.
  // The env list keeps that power because editing it is already a deliberate
  // act with review attached.
  const invites = new Invites();
  const r = invites.add('@example.com', { invitedBy: 'owner@example.com' });

  assert.equal(r.ok, false);
  assert.equal(invites.has('anyone@example.com'), false);
});

test('nonsense is refused without being echoed back in full', () => {
  const invites = new Invites();
  for (const bad of ['', 'not an email', 'a@b', `${'x'.repeat(400)}@example.com`, null, 42]) {
    assert.equal(invites.add(/** @type {any} */ (bad), { invitedBy: 'o@e.com' }).ok, false, String(bad));
  }
  assert.equal(invites.list().length, 0);
});

test('inviting somebody twice is agreement, not an error', () => {
  // Somebody re-inviting a person is asking "did that work?", and a refusal
  // there reads as a fault.
  const invites = new Invites();
  const first = invites.add('guest@example.com', { invitedBy: 'o@e.com', note: 'the client' });
  const again = invites.add('GUEST@example.com', { invitedBy: 'o@e.com' });

  assert.equal(again.ok, true);
  assert.match(again.message, /already invited/);
  assert.equal(invites.list().length, 1, 'and case is not a second person');
  assert.equal(again.invite?.at, first.invite?.at, 'the original date survives');
  assert.equal(again.invite?.note, 'the client', 'and so does the note');
});

test('withdrawing an invitation does not sign anybody out, and says so', () => {
  // Conflating the two would make "un-invite" quietly mean "revoke every device
  // they hold", which is a bigger action than the word suggests.
  const invites = new Invites();
  invites.add('guest@example.com', { invitedBy: 'o@e.com' });

  const r = invites.remove('guest@example.com');

  assert.equal(r.ok, true);
  assert.equal(invites.has('guest@example.com'), false);
  assert.match(r.message, /keeps working until you revoke it/);
});

test('invitations survive a restart', () => {
  const invites = new Invites();
  invites.add('guest@example.com', { invitedBy: 'owner@example.com', note: 'the client' });

  const restored = new Invites();
  restored.load(JSON.parse(JSON.stringify(invites.toJSON())));

  assert.equal(restored.has('guest@example.com'), true);
  assert.equal(restored.list()[0].invitedBy, 'owner@example.com');
  assert.equal(restored.list()[0].note, 'the client');
});

test('a corrupt stored row is dropped rather than taken as an invitation', () => {
  // Loading is the one path where this data has been outside our hands.
  const restored = new Invites();
  restored.load([{ email: '@example.com' }, { email: 'not an email' }, null, 'nope', { email: 'ok@example.com' }]);

  assert.deepEqual(restored.list().map((i) => i.email), ['ok@example.com']);
});

test('both coordinators gate invites the same way, in every direction', () => {
  // The Worker and the Node coordinator are required to behave identically, and
  // they have drifted before — an admin check that existed on one and not the
  // other, caught only because the tests happened to exercise that one. Same
  // rule, both files, asserted here rather than hoped for.
  const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  for (const [name, file] of [
    ['Node', 'src/fleet/coordinator/server.js'],
    ['Worker', 'worker/src/fleet-do.js'],
  ]) {
    const src = read(file);
    // Admin on EVERY method, reading included: a list of who has been invited
    // is a list of colleagues, and a member has no reason to hold one.
    assert.match(src, /\/api\/invites'\)\s*&&\s*client\s*&&\s*!client\.admin|startsWith\('\/api\/invites'\) && client && !client\.admin/,
      `${name} does not gate invites on admin for every method`);
    // And the sign-in consults both lists.
    assert.match(src, /invites\.has\(who\.email\)/, `${name} does not honour an invitation at sign-in`);
    // Stored, or an invitation lasts until the next restart.
    assert.match(src, /invites/, `${name} does not persist invitations`);
  }
});
