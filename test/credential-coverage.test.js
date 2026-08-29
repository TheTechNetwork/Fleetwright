// Where a credential actually is, which is not "everywhere".
//
// Two questions from using it:
//
//   "If credentials are user wide why are they under the menu for the host?"
//   "If I were to add a host now would it get all my credentials?"
//
// The first was a real contradiction — the screen said "goes to every machine"
// while living inside one machine's row. The second has an uncomfortable
// answer: NO. `link` fans out to the hosts REACHABLE AT THE TIME, and a host
// enrolled afterwards has none. Nothing holds them centrally to replay, and
// under docs/trust.md nothing should.
//
// So the fix is not to pretend otherwise: it is to say where each credential
// is, and where it is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { place } from '../src/fleet/coordinator/scheduler.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

const intent = (verb, params) => ({
  v: PROTOCOL_VERSION, kind: 'intent', id: 'abcd1234', verb, params, issuedAt: Date.now(),
});
const twoHosts = () => ({
  reachable: () => [{ hostId: 'a' }, { hostId: 'b' }],
  list: () => [{ hostId: 'a' }, { hostId: 'b' }],
  findSessions: () => [],
  schedulable: () => [{ hostId: 'a' }, { hostId: 'b' }],
});

test('asking what is connected asks every machine', () => {
  // I pinned this to one host and gave a reason that was wrong: "fanning out a
  // question would mean N copies of one answer". The CATALOGUE is identical
  // everywhere. The CONNECTED LIST is not — which is the whole of what makes
  // the second question answerable.
  const p = place(/** @type {any} */ (twoHosts()), intent('connect', {}));
  assert.equal(p.kind, 'fanout');
  assert.deepEqual(p.hosts.map((h) => h.hostId), ['a', 'b']);
});

test('naming a host still asks only that one', () => {
  const p = place(/** @type {any} */ (twoHosts()), intent('connect', {}), { preferHost: 'b' });
  assert.equal(p.kind, 'host');
  assert.equal(p.host.hostId, 'b');
});

test('starting a specific connection is still one box', () => {
  // `connect github` mints a state and returns a URL. Fanning THAT out would
  // start two authorizations for one tap.
  const p = place(/** @type {any} */ (twoHosts()), intent('connect', { provider: 'github' }));
  assert.equal(p.kind, 'refused');
  assert.equal(p.code, 'ambiguous_host');
});

test('coverage names the machines that do not have it', async () => {
  const { CoordinatorCore } = await import('../src/fleet/coordinator/core.js');
  const core = new CoordinatorCore({ logger: { info() {}, warn() {}, error() {}, debug() {} } });

  // One host has GitHub, the other does not — the case that adding a host
  // creates, and the one a single-host answer hides completely.
  core.registry.hosts.set('a', { hostId: 'a', state: 'healthy', connected: true, healthAt: Date.now(), health: {} });
  core.registry.hosts.set('b', { hostId: 'b', state: 'healthy', connected: true, healthAt: Date.now(), health: {} });
  core.send = async (host) => ({
    ok: true,
    hostId: host.hostId,
    connections: {
      catalogue: [{ provider: 'github', label: 'GitHub' }],
      connected: host.hostId === 'a'
        ? [{ provider: 'github', label: 'GitHub', account: 'octocat', missing: ['workflow'] }]
        : [],
    },
  });

  const reply = await core.dispatch({ verb: 'connect', params: {} });
  const github = reply.connections.connected.find((c) => c.provider === 'github');
  assert.deepEqual(github.hosts, ['a']);
  assert.deepEqual(github.absentFrom, ['b'], 'the machine without it is named');

  // AND THE PERMISSION ABSENCE SURVIVES. `missing` already meant "scopes this
  // token was not granted"; the coverage merge spread over it once and would
  // have turned "missing workflow" into "missing b".
  assert.deepEqual(github.missing, ['workflow']);
});
