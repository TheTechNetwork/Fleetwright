// A member's session goes only where it is contained (docs/security.md G8).
//
// With the sandbox off, a session is a tmux pane under the service user, which
// owns the loopback token, the hub, the tmux server and every person's
// credentials on the box. So a member who could start or resume one on the
// operator's direct box held all of that without escaping anything. The rule
// is hosts.js runsSessionsFor: on a box that is not sandboxed, or has not said,
// only those who administer it. These are the coordinator's half of it, asked
// through dispatch and the snapshot, which are what the phones and agents call.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { admit, makeAdmin } from './helpers/enrolled-hosts.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const ADMIN = { email: 'admin@example.test', admin: true };
const BOB = { email: 'bob@example.test', admin: false };

/**
 * The operator's box and bob's own, each reporting what it says about its
 * sandbox (`undefined` leaves the field out, as a box from before it does).
 *
 * @param {{ ops?: boolean, own?: boolean, sessions?: any[], labels?: string[] }} said
 */
async function fleet({ ops, own, sessions = [], labels = [] }) {
  const core = new CoordinatorCore({ logger: quiet });
  await makeAdmin(core, ADMIN.email);
  /** @type {string[]} */
  const delivered = [];
  for (const [hostId, enrolledBy] of [['ops-box', null], ['bob-box', BOB.email]]) {
    await admit(core, /** @type {string} */ (hostId), {
      enrolledBy,
      send: (/** @type {any} */ intent) => {
        delivered.push(`${intent.verb}@${hostId}`);
        queueMicrotask(() => core.onHostMessage(/** @type {string} */ (hostId), { kind: 'reply', id: intent.id, ok: true, text: 'done' }));
      },
    });
  }
  const health = (/** @type {string} */ hostId, /** @type {boolean|undefined} */ sandboxed, /** @type {any[]} */ held) => ({
    hostId, protocol: PROTOCOL_VERSION, hub: { reachable: true }, maxSessions: 5, running: 0, free: 5, labels, loadavg: [0, 0, 0],
    claudeAccounts: 2, sessions: held, ...(sandboxed === undefined ? {} : { sandboxed }),
  });
  core.registry.recordHealth('ops-box', health('ops-box', ops, sessions));
  core.registry.recordHealth('bob-box', health('bob-box', own, []));
  return { core, delivered };
}

/** @param {any} core @param {any} requester @param {Record<string, any>} [extra] */
const start = (core, requester, extra = {}) =>
  core.dispatch({ verb: 'start', params: { name: 'job', task: 'a job' }, actor: requester?.email ?? null, requester, ...extra });

test('a member is not started on the operator’s box when it runs sessions without the sandbox', async () => {
  const { core, delivered } = await fleet({ ops: false, own: false });

  const named = await start(core, BOB, { preferHost: 'ops-box' });
  assert.equal(named.ok, false);
  assert.equal(named.error?.code, 'unsandboxed');
  assert.match(String(named.text), /^ops-box runs sessions without the sandbox/);
  assert.match(String(named.text), /only this fleet’s admin can start work there/);
  assert.match(String(named.text), /FLEETWRIGHT_SANDBOX=1/, 'names the way on');
  assert.deepEqual(delivered, []);

  // Unnamed, his own box is where it goes: he administers it, so it holds
  // nothing of anybody else's however it runs sessions.
  assert.equal((await start(core, BOB)).ok, true);
  assert.deepEqual(delivered, ['start@bob-box']);

  // The admin administers every box and is started on the operator's.
  delivered.length = 0;
  assert.equal((await start(core, ADMIN, { preferHost: 'ops-box' })).ok, true);
  assert.deepEqual(delivered, ['start@ops-box']);
});

test('a box that has not said whether it is sandboxed is treated as not, for a member', async () => {
  // C-5: an older box sends no `sandboxed`, which is cannot tell. Its
  // `sandbox` variant does not answer it either, because a sidecar from
  // before #681 sent one whether or not the box used the sandbox.
  const { core, delivered } = await fleet({ ops: undefined, own: undefined });
  core.registry.hosts.get('ops-box').health.sandbox = { variant: 'minimal', image: 'x', pinned: false };

  const r = await start(core, BOB, { preferHost: 'ops-box' });
  assert.equal(r.error?.code, 'unsandboxed');
  assert.match(String(r.text), /^ops-box has not said whether its sessions are sandboxed/);
  assert.match(String(r.text), /until it is updated/);
  assert.deepEqual(delivered, []);

  // Once it says so, it takes his work.
  core.registry.hosts.get('ops-box').health.sandboxed = true;
  assert.equal((await start(core, BOB, { preferHost: 'ops-box' })).ok, true);
  assert.deepEqual(delivered, ['start@ops-box']);
});

test('a tag finds the sandboxed box for a member rather than landing on the direct one', async () => {
  // Two operator boxes carry `linux`; the direct one has more room, which is
  // what placement ranks on. A member's `tag: linux` goes to the sandboxed
  // one, and when it is the only kind left, is refused with each box named.
  const core = new CoordinatorCore({ logger: quiet });
  /** @type {string[]} */
  const delivered = [];
  for (const [hostId, sandboxed, free] of [['direct', false, 5], ['contained', true, 1]]) {
    await admit(core, /** @type {string} */ (hostId), {
      send: (/** @type {any} */ intent) => {
        delivered.push(String(hostId));
        queueMicrotask(() => core.onHostMessage(/** @type {string} */ (hostId), { kind: 'reply', id: intent.id, ok: true, text: 'done' }));
      },
    });
    core.registry.recordHealth(/** @type {string} */ (hostId), {
      hostId, protocol: PROTOCOL_VERSION, hub: { reachable: true }, maxSessions: 5, running: 5 - Number(free), free, labels: ['linux'],
      loadavg: [0, 0, 0], claudeAccounts: 1, sessions: [], sandboxed,
    });
  }
  assert.equal((await start(core, BOB, { preferLabels: 'linux' })).ok, true);
  assert.deepEqual(delivered, ['contained']);
  // The break-glass token is the operator's, and the most room wins for it.
  delivered.length = 0;
  assert.equal((await start(core, null, { preferLabels: 'linux' })).ok, true);
  assert.deepEqual(delivered, ['direct']);

  core.registry.hosts.get('contained').health.sandboxed = false;
  delivered.length = 0;
  const none = await start(core, BOB, { preferLabels: 'linux' });
  assert.equal(none.error?.code, 'unsandboxed');
  assert.match(String(none.text), /^Every machine that could take this runs sessions without the sandbox.*: direct, contained\./);
  assert.deepEqual(delivered, []);
});

test('a member cannot resume a session on a box that runs it without the sandbox, and can still stop it', async () => {
  // A resume runs the session again, as the service user, exactly as a start
  // would. A session of his from before this rule is still his to stop.
  const mine = { name: 'old', status: 'stopped', resumable: true, createdBy: `fleet:${BOB.email}` };
  const { core, delivered } = await fleet({ ops: false, own: true, sessions: [mine] });

  const r = await core.dispatch({ verb: 'resume', params: { name: 'old' }, actor: BOB.email, requester: BOB });
  assert.equal(r.error?.code, 'unsandboxed');
  assert.match(String(r.text), /^ops-box runs sessions without the sandbox.*only this fleet’s admin can resume a session there/);
  assert.deepEqual(delivered, []);

  assert.equal((await core.dispatch({ verb: 'stop', params: { name: 'old' }, actor: BOB.email, requester: BOB })).ok, true);
  assert.equal((await core.dispatch({ verb: 'resume', params: { name: 'old' }, actor: ADMIN.email, requester: ADMIN })).ok, true);
  assert.deepEqual(delivered, ['stop@ops-box', 'resume@ops-box']);
});

test('the host list offers a member only the machines a start of theirs would reach', async () => {
  // `takesSessions` is what New session › Where draws (C-2). It said yes to a
  // member for the operator's direct box, and for a box another member
  // enrolled, both of which placement refuses.
  const { core } = await fleet({ ops: false, own: false });
  const takes = (/** @type {any} */ requester) =>
    Object.fromEntries(core.snapshot(requester).hosts.map((/** @type {any} */ h) => [h.hostId, h.takesSessions]));
  assert.deepEqual(takes(BOB), { 'ops-box': false, 'bob-box': true });
  assert.deepEqual(takes({ email: 'carol@example.test', admin: false }), { 'ops-box': false, 'bob-box': false });
  assert.deepEqual(takes(ADMIN), { 'ops-box': true, 'bob-box': false });

  core.registry.hosts.get('ops-box').health.sandboxed = true;
  assert.deepEqual(takes({ email: 'carol@example.test', admin: false }), { 'ops-box': true, 'bob-box': false });
});
