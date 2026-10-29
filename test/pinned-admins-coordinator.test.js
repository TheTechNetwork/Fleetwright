// Who a box pins as its admins, as each person is shown it.
//
//   node --test test/pinned-admins-coordinator.test.js
//
// The box reports the addresses it pins (src/fleet/host/pinned-admins.js) so a
// phone can draw Update and Reboot only where the box will take them from the
// person holding it. The addresses are people's: the admin, and somebody on
// the list, are shown it; anybody else how many and that they are not one.
// Both ways a person reads a box's health go through the same shaping: the
// snapshot the phones list machines from, and the `health` verb's reply.
// The box's own half is test/pinned-admins.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { PIN_SENTENCES, PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { admit, makeAdmin } from './helpers/enrolled-hosts.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const ADMIN = { email: 'admin@example.test', admin: true };
const ADA = { email: 'ada@example.test', admin: false };
const BEA = { email: 'bea@example.test', admin: false };

/** @param {unknown} admins what the box says, or undefined for a box from before pins */
async function fleet(admins) {
  const core = new CoordinatorCore({ logger: quiet });
  await makeAdmin(core, ADMIN.email);
  const health = {
    hostId: 'ops-box', protocol: PROTOCOL_VERSION, hub: { reachable: true }, maxSessions: 5, running: 0, free: 5,
    labels: [], loadavg: [0, 0, 0], claudeAccounts: 1, sessions: [], ...(admins === undefined ? {} : { admins }),
  };
  await admit(core, 'ops-box', {
    send: (/** @type {any} */ intent) =>
      queueMicrotask(() => core.onHostMessage('ops-box', { kind: 'reply', id: intent.id, ok: true, text: 'ok', health })),
  });
  core.registry.recordHealth('ops-box', /** @type {any} */ (health));
  return core;
}

/** What one person is shown, by both routes, which must agree. @param {any} core @param {any} who */
async function seen(core, who) {
  const listed = core.snapshot(who).hosts.find((/** @type {any} */ h) => h.hostId === 'ops-box').health.admins;
  const asked = await core.dispatch({ verb: 'health', params: {}, actor: who.email, requester: who, preferHost: 'ops-box' });
  assert.deepEqual(asked.health.admins, listed, 'the health verb and the snapshot disagree');
  return listed;
}

test('the addresses a box pins go to the admin and to the people on the list, and a count to everybody else', async () => {
  const core = await fleet({ pinned: ['Ada@Example.test', 'carol@example.test'] });
  assert.deepEqual(await seen(core, ADMIN), { count: 2, you: false, pinned: ['ada@example.test', 'carol@example.test'] });
  assert.deepEqual(await seen(core, ADA), { count: 2, you: true, pinned: ['ada@example.test', 'carol@example.test'] });
  assert.deepEqual(await seen(core, BEA), { count: 2, you: false }, 'a member who is not pinned was shown whom to ask');
});

test('nobody pinned is an answer, a record the box cannot read is cannot tell, and neither sentence names anybody', async () => {
  assert.deepEqual(await seen(await fleet({ pinned: [] }), BEA), { count: 0, you: false });

  const unreadable = await fleet({ pinned: null, problem: 'The record of who is pinned on this machine cannot be read.' });
  assert.deepEqual(await seen(unreadable, ADMIN), { count: null, you: null, problem: PIN_SENTENCES.unreadable });

  for (const code of ['left', 'unlisted', 'unchecked']) {
    const stranded = await fleet({ pinned: ['gone@example.test'], stranded: code, left: 'whatever the box wrote' });
    assert.deepEqual(await seen(stranded, BEA), { count: 1, you: false, left: PIN_SENTENCES[code] }, code);
  }
  for (const sentence of Object.values(PIN_SENTENCES)) assert.doesNotMatch(sentence, /@/);
});

test('what a box writes in its own sentences never reaches the people who see it', async () => {
  // Every viewer of the box is shown these, members who are not shown the
  // addresses included, so a box could otherwise hand all of them a list.
  const core = await fleet({ pinned: ['ada@example.test'], left: 'Ask ada@example.test or carol@example.test.', stranded: 'carol@example.test' });
  assert.deepEqual(await seen(core, BEA), { count: 1, you: false, left: PIN_SENTENCES.left });
  const broken = await fleet({ pinned: null, problem: 'Ask carol@example.test to fix it.' });
  assert.equal((await seen(broken, BEA)).problem, PIN_SENTENCES.unreadable);
});

test('a box that says nothing about pins, or says it in another shape, is shown as saying nothing', async () => {
  // Absent is how a phone knows the box cannot pin (C-2): no list, no count,
  // and no `pinadmin` offered there. A malformed field must read the same,
  // not as "nobody pinned", which would draw buttons a box may refuse.
  for (const admins of [undefined, 'ada@example.test', { pinned: 'ada@example.test' }, { pinned: [42] }, { pinned: ['not-an-address'] }]) {
    const health = (await fleet(admins)).snapshot(BEA).hosts[0].health;
    assert.equal('admins' in health, false, `shown for ${JSON.stringify(admins)}`);
  }
});
