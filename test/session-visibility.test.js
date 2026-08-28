// Whose sessions a caller may see.
//
// Filtered at the COORDINATOR, never at the host: the host has one token and
// no idea who is asking, so a host-side filter would be a check performed by
// the party with the least information. docs/accounts.md, step "visibility".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * A coordinator with one connected host that answers `list` with a fixed set
 * of sessions -- one attributed to the owner, one to a member, one to nobody
 * (telegram-era, pre-attribution).
 */
function fleetWithSessions() {
  const core = new CoordinatorCore({ logger: silent, intentTimeoutMs: 2_000 });
  core.hostConnected('box-1', (msg) => {
    // Answer like a sidecar: echo the id, return the canned sessions.
    setImmediate(() => core.onHostMessage('box-1', {
      kind: 'reply',
      id: msg.id,
      ok: true,
      text: '3 sessions',
      sessions: [
        { name: 'org-work', status: 'running', createdBy: 'fleet:owner@example.com' },
        { name: 'client-work', status: 'running', createdBy: 'fleet:client@example.com' },
        { name: 'tg-session', status: 'running', createdBy: 'telegram:12345' },
      ],
    }));
  });
  core.registry.recordHealth('box-1', { hub: { reachable: true }, maxSessions: 5, running: 3, free: 2, labels: [] });
  return core;
}

const list = { verb: 'list', params: {} };

test('the break-glass token sees everything', async () => {
  const r = await fleetWithSessions().dispatch({ ...list, requester: null });
  assert.equal(r.sessions.length, 3);
});

test('an admin sees everything', async () => {
  const r = await fleetWithSessions().dispatch({ ...list, requester: { email: 'owner@example.com', admin: true } });
  assert.equal(r.sessions.length, 3);
});

test('a member sees exactly their own', async () => {
  const r = await fleetWithSessions().dispatch({ ...list, requester: { email: 'client@example.com', admin: false } });
  assert.deepEqual(r.sessions.map((s) => s.name), ['client-work']);
});

test('case differences in the email do not hide sessions', async () => {
  const r = await fleetWithSessions().dispatch({ ...list, requester: { email: 'Client@Example.com', admin: false } });
  assert.equal(r.sessions.length, 1);
});

test('unattributed sessions belong to the fleet, not to whoever asks', async () => {
  // telegram-era and CLI sessions have no fleet identity. Erring open would
  // quietly break the promise this exists for -- "my client must not read my
  // org's other work" -- so a member never sees them.
  const r = await fleetWithSessions().dispatch({ ...list, requester: { email: 'client@example.com', admin: false } });
  assert.ok(!r.sessions.some((s) => s.name === 'tg-session'));
});

test('the hosts array is never filtered -- topology is not a secret here', async () => {
  const r = await fleetWithSessions().dispatch({ ...list, requester: { email: 'client@example.com', admin: false } });
  assert.equal(r.hosts.length, 1);
  assert.equal(r.hosts[0].hostId, 'box-1');
});
