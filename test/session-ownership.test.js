// A member may act only on their own sessions -- and must not be able to
// LEARN anything from trying.
//
// Visibility (one layer down) hides other people's sessions from a member's
// list. Without this, a guessed name still stopped them: privacy against
// reading with no authorisation against acting.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HostRegistry } from '../src/fleet/coordinator/registry.js';
import { place } from '../src/fleet/coordinator/scheduler.js';

function fleet() {
  const r = new HostRegistry();
  r.connect('box-1', () => {});
  r.recordHealth('box-1', {
    hub: { reachable: true }, maxSessions: 5, running: 2, free: 3, labels: [],
    sessions: [
      { name: 'org-work', status: 'running', createdBy: 'fleet:owner@example.com' },
      { name: 'client-work', status: 'running', createdBy: 'fleet:client@example.com' },
      { name: 'tg-session', status: 'running', createdBy: 'telegram:12345' },
    ],
  });
  return r;
}

const stop = (name) => ({ verb: 'stop', params: { name } });
const member = { email: 'client@example.com', admin: false };
const admin = { email: 'owner@example.com', admin: true };

test('a member acts on their own session', () => {
  const p = place(fleet(), stop('client-work'), { requester: member });
  assert.equal(p.kind, 'host');
});

test('an admin acts on anything', () => {
  for (const name of ['org-work', 'client-work', 'tg-session']) {
    assert.equal(place(fleet(), stop(name), { requester: admin }).kind, 'host');
  }
});

test('the break-glass token acts on anything', () => {
  assert.equal(place(fleet(), stop('org-work'), { requester: null }).kind, 'host');
});

test('a member cannot act on someone else\'s session', () => {
  const p = place(fleet(), stop('org-work'), { requester: member });
  assert.equal(p.kind, 'refused');
  assert.equal(p.code, 'unknown_session');
});

test('unattributed sessions belong to the fleet, for acting as for reading', () => {
  const p = place(fleet(), stop('tg-session'), { requester: member });
  assert.equal(p.kind, 'refused');
  assert.equal(p.code, 'unknown_session');
});

test('the refusal is byte-identical to a name that does not exist', () => {
  // A distinct "not yours" would confirm that a guessed name exists on
  // somebody else's work -- an existence oracle built out of an access
  // control. To a member, a session they cannot touch and a session that does
  // not exist must be the same fact.
  const notMine = place(fleet(), stop('org-work'), { requester: member });
  const notReal = place(fleet(), stop('org-work-that-never-existed'), { requester: member });
  assert.equal(notMine.code, notReal.code);
  assert.equal(
    notMine.reason.replace('org-work-that-never-existed', 'org-work'),
    notReal.reason.replace('org-work-that-never-existed', 'org-work'),
  );
});

test('case differences in the email do not lock a member out of their own work', () => {
  const p = place(fleet(), stop('client-work'), { requester: { email: 'Client@Example.com', admin: false } });
  assert.equal(p.kind, 'host');
});
