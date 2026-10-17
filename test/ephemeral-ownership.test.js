import test from 'node:test';
import assert from 'node:assert/strict';
import { place } from '../src/fleet/coordinator/scheduler.js';

/** A registry stub: placement only reads these. */
function registry(hosts) {
  return {
    schedulable: () => hosts,
    reachable: () => hosts,
    list: () => hosts,
    get: (id) => hosts.find((h) => h.hostId === id) ?? null,
    findSessions: () => [],
    nextCursor: () => 0,
  };
}
const host = (hostId, extra = {}) => ({
  hostId,
  connected: true,
  health: { free: 3, claudeAccounts: 1 },
  healthAt: Date.now(),
  ...extra,
});
const START = { verb: 'start', params: { cwd: '/work' } };

test("somebody else's runner is not spare capacity", () => {
  // Several people may want a runner at once and they are not interchangeable:
  // each exists because somebody asked for it, for their job, and costs them
  // money while it lives. A runner belonging to someone else is a machine that
  // vanishes when a job you cannot see finishes.
  const hosts = [
    host('box', {}),
    host('gha-1', { ephemeral: true, owner: 'someone@else.com' }),
  ];
  const r = place(registry(hosts), START, { requester: { email: 'me@example.com' } });
  assert.equal(r.kind, 'host');
  assert.equal(r.host.hostId, 'box');
});

test('a fleet whose only host is somebody else\'s runner refuses', () => {
  const hosts = [host('gha-1', { ephemeral: true, owner: 'someone@else.com' })];
  const r = place(registry(hosts), START, { requester: { email: 'me@example.com' } });
  assert.equal(r.kind, 'refused');
  // NOT "only_ephemeral_hosts", and emphatically not "at_capacity" — which is
  // what it said before, about an empty machine. The reason it cannot be used
  // has nothing to do with how full it is.
  assert.equal(r.code, 'no_hosts');
  assert.match(r.reason, /belonging to somebody else/);
  assert.equal(/gha-1/.test(r.reason), false, 'do not name a machine they cannot use');
});

test('my own runner is still never chosen for me automatically', () => {
  // Ownership does not make it a default target. It is empty, so capacity would
  // pick it every time — and work placed there is lost when the job ends.
  const hosts = [host('gha-1', { ephemeral: true, owner: 'me@example.com' })];
  const r = place(registry(hosts), START, { requester: { email: 'me@example.com' } });
  assert.equal(r.kind, 'refused');
  assert.equal(r.code, 'only_ephemeral_hosts');
  assert.match(r.reason, /gha-1/);
  assert.match(r.reason, /Name one explicitly/);
});

test('an unowned ephemeral host stays visible to everyone', () => {
  // Hosts enrolled before ownership existed have no owner. Hiding them from
  // everybody would strand them; they behave exactly as they did.
  const hosts = [host('gha-old', { ephemeral: true })];
  const r = place(registry(hosts), START, { requester: { email: 'me@example.com' } });
  assert.equal(r.code, 'only_ephemeral_hosts');
});

test('a box another member enrolled is not spare capacity either, named or not', async () => {
  // FOUND BY AN AUDIT: any member can mint a host pin, and new work was ranked
  // by the free slots each box reported, so alice's box, reporting the most
  // room, took bob's unnamed start, his task and his archive's name with it,
  // onto a machine where she has root. Naming her box worked too. Her box acts
  // for her alone (hosts.js actsFor), as it already does for credentials.
  const { CoordinatorCore } = await import('../src/fleet/coordinator/core.js');
  const { PROTOCOL_VERSION } = await import('../src/fleet/protocol/intents.js');
  const { admit, makeAdmin } = await import('./helpers/enrolled-hosts.js');
  const core = new CoordinatorCore({ logger: { info() {}, warn() {}, error() {}, debug() {} } });
  await makeAdmin(core, 'admin@example.test');
  await admit(core, 'ops-box');
  await admit(core, 'alice-box', { enrolledBy: 'alice@example.test' });
  const report = (/** @type {string} */ hostId, /** @type {number} */ free, claudeAccounts = 1) => core.onHostMessage(hostId, {
    kind: 'health',
    health: { hostId, protocol: PROTOCOL_VERSION, maxSessions: 4, running: 4 - free, free, sessions: [], loadavg: [0, 0, 0], loggedIn: true, claudeAccounts, hub: { reachable: true } },
  });
  await report('ops-box', 1);
  await report('alice-box', 4);
  /** @type {string[]} */
  const sent = [];
  core.send = async (/** @type {any} */ host) => {
    sent.push(host.hostId);
    return { ok: true, text: 'started' };
  };
  const start = async (/** @type {string} */ email, /** @type {Record<string, any>} */ extra = {}) => {
    sent.length = 0;
    const reply = await core.dispatch({
      verb: 'start',
      params: { name: 'job', task: 'a job' },
      actor: email,
      requester: { email, admin: email === 'admin@example.test' },
      ...extra,
    });
    return { reply, sent: [...sent] };
  };

  assert.deepEqual((await start('bob@example.test')).sent, ['ops-box'], 'the most room in the fleet is not his to use');
  const named = await start('bob@example.test', { preferHost: 'alice-box' });
  assert.equal(named.reply.error?.code, 'host_unavailable');
  assert.deepEqual(named.sent, []);
  // An admin is held to it like anybody, as for a credential.
  assert.deepEqual((await start('admin@example.test')).sent, ['ops-box']);
  // And it is still hers.
  assert.deepEqual((await start('alice@example.test')).sent, ['alice-box']);

  // With the fleet's own box unable to start anything, nothing that acts for
  // him is left, and he is told that, not shown hers or told about runners.
  await report('ops-box', 1, 0);
  const none = await start('bob@example.test');
  assert.equal(none.reply.error?.code, 'no_hosts');
  assert.match(String(none.reply.text), /No machine that acts for you/);
  assert.doesNotMatch(String(none.reply.text), /alice-box|temporary/);
  assert.deepEqual(none.sent, []);
});
