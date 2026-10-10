// A pool's page from away from home, as the coordinator routes it: which box
// is asked to read the pool or act on it for a phone that cannot reach it,
// and what is refused before any box is asked.
//
//   node --test test/pool-page-away.test.js
//
// ASKED FOR: "Direct line of sight vs on 5g", then "Both, in that order":
// the page said why it could not connect, and now it loads through a machine
// that can. docs/manage.md, "From away". The box's half has its own tests
// (test/xo-pools.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { xoActionArgs } from '../src/fleet/protocol/intents.js';

const ELI = 'eli@example.com';
const eli = { email: ELI, admin: false };
const sam = { email: 'sam@example.com', admin: false };
const VM = '0b1e8c2a-3f4d-4e5a-9b6c-7d8e9f0a1b2c';
const KEY = 'B'.repeat(87);

/** @param {string} owner @param {string} address @param {boolean|null} reachable */
const pool = (owner, address, reachable = true) => ({ address, owner, reachable, pools: [], images: [], networks: [], machines: [] });

/**
 * @param {Record<string, { xo: any[], protocol?: number }>} boxes
 * @param {(hostId: string, spec: any) => any} reply
 */
function fleet(boxes, reply) {
  const core = new CoordinatorCore({});
  for (const [hostId, b] of Object.entries(boxes)) {
    core.registry.connect(hostId, () => {});
    core.registry.recordHealth(hostId, { hub: { reachable: true }, protocol: b.protocol ?? 13, maxSessions: 5, running: 0, free: 5, labels: [], xo: b.xo });
  }
  /** @type {string[]} */
  const asked = [];
  core.send = /** @type {any} */ (async (/** @type {any} */ host, /** @type {any} */ spec) => {
    asked.push(host.hostId);
    // The box picks the token by the actor, so it is the person checked.
    assert.equal(spec.actor, ELI);
    return reply(host.hostId, spec);
  });
  return { core, asked };
}

// The actor as a caller might send it, unlike the requester's email: the
// requester is who was verified, and is what the box is told.
const look = (/** @type {any} */ requester, address = 'xo.lan') => ({ verb: 'xolook', params: { address, reply: KEY }, actor: requester ? `fleet:${requester.email}` : undefined, requester });

test('a look goes to the boxes holding this person’s token for this pool, the one that last reached it first, until one answers', async () => {
  const { core, asked } = fleet(
    {
      // Holds Eli's token for another pool only, and Sam's for this one.
      other: { xo: [pool(ELI, 'xo.office'), pool(sam.email, 'xo.lan')] },
      // Holds it, but could not reach it on its last look.
      aaa: { xo: [pool(ELI, 'xo.lan', false)] },
      // Holds it and reached it, and is asked first despite its name.
      zzz: { xo: [pool(ELI, 'xo.lan', true)] },
      // Holds it and speaks 12: never sent a verb it would not know.
      old: { xo: [pool(ELI, 'xo.lan', true)], protocol: 12 },
    },
    (hostId) => (hostId === 'zzz' ? { ok: false, unreachable: true, text: 'xo.lan could not be reached from here' } : { ok: true, sealed: { epk: 'e', iv: 'i', ct: 'c' } }),
  );
  const r = await core.dispatch(look(eli));
  assert.deepEqual(asked, ['zzz', 'aaa'], 'the box that reached it first, then the next holder; never one holding another pool or somebody else’s');
  assert.equal(r.ok, true);
  assert.equal(r.hostId, 'aaa', 'the answer says which machine read it');
  assert.deepEqual(r.sealed, { epk: 'e', iv: 'i', ct: 'c' }, 'and carries the sealed page as the box sent it');
});

test('when no holder can reach the pool, the refusal names each and why', async () => {
  const { core } = fleet(
    { aaa: { xo: [pool(ELI, 'xo.lan')] }, old: { xo: [pool(ELI, 'xo.lan')], protocol: 12 } },
    () => ({ ok: false, unreachable: true, text: 'connect ETIMEDOUT' }),
  );
  const r = await core.dispatch(look(eli));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unreachable');
  assert.match(r.text, /aaa \(connect ETIMEDOUT\)/);
  assert.match(r.text, /old \(needs updating\)/);
});

test('a pool’s page is its owner’s: nobody signed in and somebody else are refused before any box is asked', async () => {
  const { core, asked } = fleet({ aaa: { xo: [pool(ELI, 'xo.lan')] } }, () => ({ ok: true }));
  assert.equal((await core.dispatch(look(null))).error.code, 'not_signed_in');
  const theirs = await core.dispatch(look(sam));
  assert.equal(theirs.error.code, 'no_hosts', 'Sam holds no token for Eli’s pool, so no box is asked to use Eli’s');
  assert.match(theirs.text, /No connected machine holds your token for xo\.lan/);
  assert.deepEqual(asked, []);
});

test('an action is sent only in the shape its method takes', async () => {
  const { core, asked } = fleet({ aaa: { xo: [pool(ELI, 'xo.lan')] } }, () => ({ ok: true, text: 'Restarted.' }));
  const act = (/** @type {string} */ method, /** @type {any} */ args) =>
    core.dispatch({ verb: 'xoact', id: `t-${method}-${asked.length}-${Math.random()}`, params: { address: 'xo.lan', method, args: JSON.stringify(args) }, actor: `fleet:${ELI}`, requester: eli });

  const ok = await act('vm.restart', { id: VM, force: false });
  assert.equal(ok.ok, true);
  assert.equal(ok.hostId, 'aaa');

  const bad = await act('vm.restart', { id: VM, force: false, deleteDisks: true });
  assert.equal(bad.error.code, 'bad_params');
  assert.match(bad.text, /vm\.restart takes no deleteDisks/);
  assert.equal((await core.dispatch({ verb: 'xoact', params: { address: 'xo.lan', method: 'session.signIn', args: '{}' }, requester: eli })).ok, false, 'a method the page does not offer is not an xoact');
  assert.deepEqual(asked, ['aaa'], 'nothing refused reached a box');
});

test('xoact arguments: an id always, only the keys a method takes, each in its own shape', () => {
  /** @type {Array<[string, any, string|Record<string, any>]>} expected args, or the error it says */
  const cases = [
    ['vm.start', { id: VM }, { id: VM }],
    ['vm.snapshot', { id: VM, name: 'web 2026-10-10 12:00 UTC' }, { id: VM, name: 'web 2026-10-10 12:00 UTC' }],
    ['vm.set', { id: VM, CPUs: 4, memory: 8 * 2 ** 30 }, { id: VM, CPUs: 4, memory: 8 * 2 ** 30 }],
    ['host.setMaintenanceMode', { id: VM, maintenance: true }, { id: VM, maintenance: true }],
    ['vm.start', { id: 'not-an-id' }, 'xoact.args.id is not a Xen Orchestra id'],
    ['vm.start', { id: VM, force: true }, 'vm.start takes no force'],
    ['vm.snapshot', { id: VM }, 'vm.snapshot needs name'],
    ['vm.snapshot', { id: VM, name: 'a\nb' }, 'xoact.args.name must be a name'],
    ['vm.set', { id: VM }, 'vm.set needs CPUs or memory'],
    ['vm.set', { id: VM, CPUs: 0 }, 'xoact.args.CPUs must be a whole number from 1 to 64'],
    ['disk.resize', { id: VM, size: -1 }, 'xoact.args.size must be a size in bytes'],
    ['vm.stop', { id: VM, force: 'yes' }, 'xoact.args.force must be true or false'],
    ['vm.start', [VM], 'xoact.args must be a JSON object'],
    ['__proto__', { id: VM }, '__proto__ is not something a pool’s page does'],
  ];
  for (const [method, args, want] of cases) {
    const r = xoActionArgs(method, JSON.stringify(args));
    if (typeof want === 'string') assert.deepEqual(r, { ok: false, error: want }, `${method} ${JSON.stringify(args)}`);
    else assert.deepEqual(r, { ok: true, args: want }, `${method} ${JSON.stringify(args)}`);
  }
  assert.deepEqual(xoActionArgs('vm.start', '{'), { ok: false, error: 'xoact.args is not JSON' });
});
