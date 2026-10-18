// A box's own named secrets go only to sessions of those who administer it.
//
// `start { secret: NAME }` is the grant, and a member can start on an
// operator's box, so a member naming DEPLOY_KEY was served the operator's
// DEPLOY_KEY, and their own vault secret of that name was hidden behind it.
// Who administers a box is the coordinator's knowledge and whose secret it
// serves is the hub's, so the coordinator writes `boxSecrets` onto the start
// and the resume and the hub keeps it on the record. These are the
// coordinator's half, asked through dispatch and read off the wire a box is
// sent; the hub's half is in secret-store.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { admit, makeAdmin } from './helpers/enrolled-hosts.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const ADMIN = { email: 'admin@example.test', admin: true };
const BOB = { email: 'bob@example.test', admin: false };

/**
 * The operator's box and bob's, sandboxed, at the protocol given, recording
 * every intent as it crosses the socket.
 *
 * @param {{ protocol?: number, sessions?: any[] }} [opts]
 */
async function fleet({ protocol = PROTOCOL_VERSION, sessions = [] } = {}) {
  const core = new CoordinatorCore({ logger: quiet });
  await makeAdmin(core, ADMIN.email);
  /** @type {Array<{ hostId: string, intent: any }>} */
  const wire = [];
  for (const [hostId, enrolledBy] of [['ops-box', null], ['bob-box', BOB.email]]) {
    await admit(core, /** @type {string} */ (hostId), {
      enrolledBy,
      send: (/** @type {any} */ intent) => {
        wire.push({ hostId: String(hostId), intent });
        queueMicrotask(() => core.onHostMessage(/** @type {string} */ (hostId), { kind: 'reply', id: intent.id, ok: true, text: 'done' }));
      },
    });
    core.registry.recordHealth(/** @type {string} */ (hostId), {
      hostId, protocol, hub: { reachable: true }, maxSessions: 5, running: 0, free: 5, labels: [], loadavg: [0, 0, 0],
      claudeAccounts: 2, sandboxed: true, sessions: hostId === 'ops-box' ? sessions : [],
    });
  }
  return { core, wire };
}

/** @param {any} core @param {any} requester @param {string} preferHost @param {Record<string, any>} [params] */
const start = (core, requester, preferHost, params = {}) =>
  core.dispatch({ verb: 'start', params: { name: 'job', secret: 'DEPLOY_KEY', ...params }, actor: requester?.email ?? null, requester, preferHost });

test('a start says whether the box’s own secrets may answer it, and the caller cannot say so', async () => {
  const { core, wire } = await fleet();
  const said = async (/** @type {any} */ requester, /** @type {string} */ host) => {
    wire.length = 0;
    const r = await start(core, requester, host, { boxSecrets: 'yes' });
    assert.equal(r.ok, true, String(r.text));
    return wire[0]?.intent.params.boxSecrets;
  };
  assert.equal(await said(BOB, 'ops-box'), 'no', 'a member was given the operator’s secrets by asking');
  assert.equal(await said(BOB, 'bob-box'), 'yes', 'his own box’s secrets are his');
  assert.equal(await said(ADMIN, 'ops-box'), 'yes');
  assert.equal(await said(null, 'ops-box'), 'yes', 'the break-glass token is the operator');
});

test('a resume decides it for the session’s owner, not for whoever pressed resume', async () => {
  // An admin resuming bob's session on the operator's box must not open the
  // box's secrets to it; bob's own resume is decided for bob.
  const bobs = { name: 'bobs', status: 'stopped', resumable: true, createdBy: `fleet:${BOB.email}` };
  const theirs = { name: 'theirs', status: 'stopped', resumable: true, createdBy: `fleet:${ADMIN.email}` };
  const { core, wire } = await fleet({ sessions: [bobs, theirs] });
  const resumed = async (/** @type {string} */ name, /** @type {any} */ requester) => {
    wire.length = 0;
    const r = await core.dispatch({ verb: 'resume', params: { name, boxSecrets: 'yes' }, actor: requester?.email ?? null, requester });
    assert.equal(r.ok, true, String(r.text));
    return wire[0]?.intent.params.boxSecrets;
  };
  assert.equal(await resumed('bobs', ADMIN), 'no');
  assert.equal(await resumed('bobs', BOB), 'no');
  assert.equal(await resumed('bobs', null), 'no');
  assert.equal(await resumed('theirs', ADMIN), 'yes');
});

test('a box too old to keep its secrets apart is not sent a member’s secret start', async () => {
  // An older box would answer the session from its own store first, which is
  // the leak itself, and it cannot be told otherwise: `boxSecrets` is newer
  // than it and is left off what it is sent.
  const { core, wire } = await fleet({ protocol: 13 });
  const refused = await start(core, BOB, 'ops-box');
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.code, 'host_outdated');
  assert.match(String(refused.text), /^ops-box is too old to keep the secrets its operator placed on it apart from yours/);
  assert.match(String(refused.text), /needs 14\. Start without a secret, or ask whoever runs it to update it\.$/);
  assert.deepEqual(wire, []);

  // Without a secret nothing is granted, and it goes, without the flag.
  const bare = await core.dispatch({ verb: 'start', params: { name: 'job' }, actor: BOB.email, requester: BOB, preferHost: 'ops-box' });
  assert.equal(bare.ok, true, String(bare.text));
  // The admin's secrets are the box's to give, old box or not.
  assert.equal((await start(core, ADMIN, 'ops-box')).ok, true);
  assert.deepEqual(wire.map((w) => [w.hostId, 'boxSecrets' in w.intent.params]), [['ops-box', false], ['ops-box', false]]);
});
