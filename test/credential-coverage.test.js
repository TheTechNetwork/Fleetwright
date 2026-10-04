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

test('what an account has left is one fact, and the box that asked last has it', async () => {
  // An account is a person's, not a machine's: the same address linked on two
  // boxes is one plan with one five-hour window. Each box asks the endpoint
  // because the token lives there; the merge keeps the freshest answer, and a
  // box that could not ask never overwrites one that could.
  const { CoordinatorCore } = await import('../src/fleet/coordinator/core.js');
  const core = new CoordinatorCore({ logger: { info() {}, warn() {}, error() {}, debug() {} } });
  for (const id of ['a', 'b', 'c']) {
    core.registry.hosts.set(id, { hostId: id, state: 'healthy', connected: true, healthAt: Date.now(), health: {} });
  }
  const windows = (/** @type {number} */ used) => ({ fiveHour: { used, resetsAt: 1_700_000_900_000 }, sevenDay: null, sevenDayOpus: null, sevenDaySonnet: null });
  const usageOn = /** @type {Record<string, any>} */ ({
    a: { checkedAt: 1_700_000_000_000, windows: windows(40), why: null },
    b: { checkedAt: 1_700_000_600_000, windows: windows(42), why: null },
    c: null,
  });
  core.send = async (host) => ({
    ok: true,
    hostId: host.hostId,
    connections: {
      catalogue: [{ provider: 'claude', label: 'Claude' }],
      connected: [{ provider: 'claude', label: 'Claude', account: 'a@example.com', updatedAt: 0, usage: usageOn[host.hostId] }],
    },
  });

  const reply = await core.dispatch({ verb: 'connect', params: {} });
  const claude = reply.connections.connected.find((c) => c.provider === 'claude');
  assert.equal(claude.usage.checkedAt, 1_700_000_600_000, 'the freshest box');
  assert.equal(claude.usage.windows.fiveHour.used, 42);
  assert.deepEqual(claude.hosts, ['a', 'b', 'c']);
});

test('a box that could not read the account never replaces one that could, however recently it asked', async () => {
  // REPORTED FROM A PHONE: the Claude row said "the credential has expired and
  // has not renewed yet" while a Test said two hours left. One box held an
  // expired copy and asked last; its report has no figures, and it replaced
  // the reading from the box where the account works.
  const { CoordinatorCore } = await import('../src/fleet/coordinator/core.js');
  const core = new CoordinatorCore({ logger: { info() {}, warn() {}, error() {}, debug() {} } });
  for (const id of ['works', 'expired']) {
    core.registry.hosts.set(id, { hostId: id, state: 'healthy', connected: true, healthAt: Date.now(), health: {} });
  }
  const usageOn = /** @type {Record<string, any>} */ ({
    works: { checkedAt: 1_700_000_000_000, windows: { fiveHour: { used: 40, resetsAt: 1_700_000_900_000 }, sevenDay: null, sevenDayOpus: null, sevenDaySonnet: null }, why: null },
    expired: { checkedAt: 1_700_000_600_000, windows: null, why: 'the credential has expired and has not renewed yet' },
  });
  core.send = async (host) => ({
    ok: true,
    hostId: host.hostId,
    connections: {
      catalogue: [{ provider: 'claude', label: 'Claude' }],
      connected: [{ provider: 'claude', label: 'Claude', account: 'a@example.com', updatedAt: 0, usage: usageOn[host.hostId] }],
    },
  });

  const reply = await core.dispatch({ verb: 'connect', params: {} });
  const claude = reply.connections.connected.find((c) => c.provider === 'claude');
  assert.equal(claude.usage.windows.fiveHour.used, 40);
  assert.equal(claude.usage.why, null);
});

test('Test on a token asks every box, and answers from one that holds it', async () => {
  // REPORTED FROM A PHONE: GitHub's row said "connected" and "not on
  // rpi-7550", and Test answered "No GitHub token is stored here." The Test
  // had been sent to one box, and it was rpi-7550.
  const { CoordinatorCore } = await import('../src/fleet/coordinator/core.js');
  const core = new CoordinatorCore({ logger: { info() {}, warn() {}, error() {}, debug() {} } });
  for (const id of ['rpi-7550', 'deb13']) {
    core.registry.hosts.set(id, { hostId: id, state: 'healthy', connected: true, healthAt: Date.now(), health: {} });
  }
  /** @type {string[]} */
  const asked = [];
  core.send = async (host) => {
    asked.push(host.hostId);
    return host.hostId === 'deb13'
      ? { ok: true, hostId: host.hostId, text: 'GitHub token works.', check: { ok: true, account: 'eli', granted: ['repo'], missing: [] } }
      : { ok: false, hostId: host.hostId, text: 'No GitHub token is stored here.' };
  };

  const reply = await core.dispatch({ verb: 'verify', params: { provider: 'github' } });
  assert.deepEqual(asked.sort(), ['deb13', 'rpi-7550']);
  assert.equal(reply.check.ok, true);
  assert.equal(reply.check.hostId, 'deb13', 'said by the box that holds it');
  assert.match(reply.hosts.find((/** @type {any} */ h) => h.hostId === 'rpi-7550').text, /No GitHub token/);
});
