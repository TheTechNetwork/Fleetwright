// A pool Xen Orchestra stopped showing, as the coordinator sees it: when it
// is said, to whom, how often, and when its return is said.
//
//   node --test test/pool-lost-coordinator.test.js
//
// ASKED FOR: "When Xen shows no pool, reconnecting all hosts usually fixes
// it. Why don't we do it instead of me logging in?" The box sees the pool go
// with the fleet's own token and says so in its health frame (`xo[].missing`,
// `missingFor`); the coordinator decides whether that is news, pushes it with
// a Reconnect button where one can be pressed, and says the pool is back
// when a box sees it again. The host's half has its own tests.
//
// Every negative here sits beside the same frame from a box that is believed,
// so a test cannot pass because nothing is said at all.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { XOSETUP_STEPS, XOWATCHDOG_STEPS } from '../src/fleet/protocol/intents.js';
import { admit } from './helpers/enrolled-hosts.js';

const ELI = 'eli@example.com'; // the admin
const SAM = 'sam@example.com'; // a member
const KIM = 'kim@example.com'; // another member

/** How long a pool must be gone before it is news: five minutes, as asked. */
const POOL_LOST_AFTER_MS = 5 * 60_000;

/**
 * A fleet with an admin and two members, each with a phone, and boxes
 * admitted the way the routes admit them: `null` for the operator's, an email
 * for a member's own.
 *
 * @param {Record<string, string|null>} boxes hostId → who enrolled it
 */
async function fleet(boxes) {
  /** @type {Array<{ devices: any[], message: any }>} */
  const sent = [];
  const push = {
    send: async (/** @type {any[]} */ devices, /** @type {any} */ message) => {
      sent.push({ devices, message });
      return { sent: devices.length, dead: [] };
    },
  };
  const clock = { now: Date.UTC(2026, 9, 17, 3, 0) };
  const core = new CoordinatorCore({ push: /** @type {any} */ (push), now: () => clock.now });
  /** @type {Record<string, string>} */
  const phones = {};
  for (const [email, admin, token] of /** @type {const} */ ([[ELI, true, 'e'], [SAM, false, '5'], [KIM, false, 'b']])) {
    const { client } = /** @type {any} */ (await core.clients.issue(`phone (${email})`, { admin, email }));
    phones[token.repeat(64)] = email;
    await core.registerDevice({ platform: 'ios', token: token.repeat(64), clientId: client.id, actor: `fleet:${email}` });
  }
  for (const [hostId, enrolledBy] of Object.entries(boxes)) await admit(core, hostId, { enrolledBy });
  /** Who each push reached, by email. @param {{ devices: any[] }} p */
  const reached = (p) => p.devices.map((d) => phones[d.token]).sort();
  /**
   * One health frame from a box, holding the pools it is given.
   * @param {string} hostId @param {any[]} xo
   */
  const frame = (hostId, xo) =>
    core.onHostMessage(hostId, { kind: 'health', health: { hub: { reachable: true }, protocol: 7, maxSessions: 5, running: 0, free: 5, labels: [], xo } });
  return { core, sent, clock, frame, reached };
}

/** A look that reached Xen Orchestra and found `tn-pool` gone, `missingFor` ago. */
const gone = (/** @type {string} */ owner, /** @type {number} */ missingFor, /** @type {any} */ extra = {}) => ({
  address: 'xo.lan',
  owner,
  reachable: true,
  pools: [],
  missing: [{ id: 'p-1', name: 'tn-pool' }],
  missingFor,
  ...extra,
});
/** And one that found it there. */
const there = (/** @type {string} */ owner) => ({ address: 'xo.lan', owner, reachable: true, pools: [{ id: 'p-1', name: 'tn-pool' }] });

const lost = (/** @type {any} */ core) => core.events.filter((/** @type {any} */ e) => e.event === 'xo.pool-lost');

test('a pool gone for five minutes is said once an hour, however many boxes hold it', async () => {
  const { core, sent, clock, frame, reached } = await fleet({ deb14: null, 'rpi-7550': null });

  // A pool master restarting for an update is back inside five minutes.
  await frame('deb14', [gone(ELI, POOL_LOST_AFTER_MS - 1)]);
  await frame('rpi-7550', [gone(ELI, POOL_LOST_AFTER_MS - 1)]);
  assert.equal(sent.length, 0, 'said before five minutes were up');

  await frame('deb14', [gone(ELI, POOL_LOST_AFTER_MS)]);
  await frame('rpi-7550', [gone(ELI, POOL_LOST_AFTER_MS + 5_000)]);
  assert.equal(sent.length, 1, `one pool held by two boxes was said ${sent.length} times`);
  assert.deepEqual(sent[0].message.data, { kind: 'pool-lost', name: 'pool-lost-xo.lan', hostId: 'deb14', address: 'xo.lan' });
  assert.equal(sent[0].message.title, 'xo.lan shows no pools');
  // No job has said whether this Xen Orchestra has the reconnect watchdog,
  // so the push says what it can: the sentence the watchdog cases build on.
  assert.equal(
    sent[0].message.body,
    'Xen Orchestra at xo.lan answers deb14 but shows none of its pools. Reconnecting its servers usually brings them back.',
  );
  // Only an admin may run the reconnect, and this pool's owner is one.
  assert.equal(sent[0].message.category, 'fleet.pool.reconnect');
  assert.deepEqual(reached(sent[0]), [ELI], 'the members’ phones were told about the admin’s pool');
  assert.equal(lost(core).length, 1);

  clock.now += 59 * 60_000;
  await frame('deb14', [gone(ELI, 64 * 60_000)]);
  await frame('rpi-7550', [gone(ELI, 64 * 60_000)]);
  assert.equal(sent.length, 1, 'said again inside the hour');

  clock.now += 60_000;
  await frame('rpi-7550', [gone(ELI, 65 * 60_000)]);
  assert.equal(sent.length, 2, 'a pool still gone an hour later is said again');
  assert.equal(sent[1].message.data.hostId, 'rpi-7550');
});

test('a pool that shows again is said once, under the same name, with nothing to press', async () => {
  const { core, sent, frame, reached } = await fleet({ deb14: null, 'rpi-7550': null });
  // Seen before any loss, a pool being there is not news.
  await frame('deb14', [there(ELI)]);
  assert.equal(sent.length, 0);

  // Some of the pools still showing: named, not "none".
  await frame('deb14', [gone(ELI, POOL_LOST_AFTER_MS, { pools: [{ id: 'p-2', name: 'lab' }] })]);
  assert.equal(sent.length, 1, 'the loss was not said');
  assert.equal(sent[0].message.title, 'xo.lan no longer shows tn-pool');
  assert.equal(sent[0].message.body, 'Xen Orchestra at xo.lan answers deb14 but no longer shows tn-pool. Reconnecting its servers usually brings it back.');

  await frame('rpi-7550', [there(ELI)]);
  await frame('deb14', [there(ELI)]);
  await frame('rpi-7550', [there(ELI)]);
  assert.equal(sent.length, 2, 'the return was said more than once');
  assert.deepEqual(sent[1].message.data, { kind: 'pool-back', name: 'pool-lost-xo.lan', hostId: 'rpi-7550', address: 'xo.lan' });
  assert.equal(sent[1].message.title, 'Pools back');
  assert.equal(sent[1].message.body, 'Xen Orchestra at xo.lan shows its pool to rpi-7550 again.');
  assert.equal(sent[1].message.category, undefined, 'a button on good news');
  // Both drawn by the app, or on Android the system's "Pools back" would sit
  // under the app's loss instead of replacing it.
  assert.deepEqual(sent.map((s) => s.message.drawnByApp), [true, true]);
  assert.deepEqual(reached(sent[1]), [ELI]);
  assert.deepEqual(core.events.filter((e) => e.event.startsWith('xo.')).map((e) => e.event), ['xo.pool-lost', 'xo.pool-back']);

  // Gone again inside the hour: one push an hour, recovery or not.
  await frame('deb14', [gone(ELI, POOL_LOST_AFTER_MS)]);
  assert.equal(sent.length, 2);
});

test('only a look a box may make for the owner, and one that reached Xen Orchestra, counts', async () => {
  const { core, sent, frame } = await fleet({ deb14: null, 'aaa-sam': SAM });
  // A box Sam enrolled may act for Sam alone: it cannot put a pool on Eli's
  // phone, with a button that opens Eli's admin sign-in.
  await frame('aaa-sam', [gone(ELI, 60 * 60_000)]);
  // A box that could not reach Xen Orchestra says nothing about its pools,
  // and one that has not looked yet cannot tell.
  await frame('deb14', [gone(ELI, 60 * 60_000, { reachable: false }), gone(ELI, 60 * 60_000, { address: 'xo2.lan', reachable: null })]);
  assert.equal(sent.length, 0, `said from a look that does not count: ${sent[0]?.message.body}`);
  assert.equal(lost(core).length, 0);

  // The same pool, from a box that may act for Eli and reached it.
  await frame('deb14', [gone(ELI, 60 * 60_000)]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.data.hostId, 'deb14');
});

test('a member’s pool goes to their phones without a Reconnect button and to the admin’s with one, and stays out of other members’ feeds', async () => {
  const { core, sent, frame, reached } = await fleet({ 'aaa-sam': SAM });
  await frame('aaa-sam', [gone(SAM, POOL_LOST_AFTER_MS, { missing: [{ id: 'p-1', name: 'tn-pool' }, { id: 'p-2', name: 'lab' }], pools: [{ id: 'p-3', name: 'dev' }] })]);
  assert.deepEqual(sent.flatMap(reached).sort(), [ELI, SAM], 'Kim was told about Sam’s pool, or Sam or the admin was not');
  // Only an admin may run the reconnect, so the admin's phone gets the
  // button and the member's does not, though it is the member's pool.
  const to = (/** @type {string} */ who) => sent.find((p) => reached(p).includes(who))?.message;
  assert.equal(to(ELI)?.category, 'fleet.pool.reconnect', 'the one who can reconnect it was given nothing to press');
  assert.equal(to(SAM)?.category, undefined, 'a member was given a button they cannot use');
  for (const m of [to(ELI), to(SAM)]) {
    assert.equal(m?.title, 'xo.lan no longer shows 2 pools');
    assert.match(m?.body, /no longer shows tn-pool and lab\. Reconnecting its servers usually brings them back\.$/);
  }

  const mine = core.recentEvents({ email: SAM, admin: false }).filter((e) => e.event === 'xo.pool-lost');
  const theirs = core.recentEvents({ email: KIM, admin: false }).filter((e) => e.event === 'xo.pool-lost');
  assert.equal(mine.length, 1, 'the owner’s feed does not have it');
  assert.equal(theirs.length, 0, 'another member’s feed has it');
});

test('a box that sees no pools and remembers none is counted from the first frame that said so', async () => {
  // A reachable look with no pools and none remembered carries no duration.
  const { sent, clock, frame } = await fleet({ deb14: null });
  const none = { address: 'xo.lan', owner: ELI, reachable: true, pools: [] };
  await frame('deb14', [none]);
  clock.now += POOL_LOST_AFTER_MS - 1;
  await frame('deb14', [none]);
  assert.equal(sent.length, 0, 'said before five minutes were up');

  // Seeing pools in between starts the count again.
  await frame('deb14', [there(ELI)]);
  clock.now += 1;
  await frame('deb14', [none]);
  clock.now += POOL_LOST_AFTER_MS - 1;
  await frame('deb14', [none]);
  assert.equal(sent.length, 0, 'the count carried over a frame that showed the pool');
  clock.now += 1;
  await frame('deb14', [none]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.data.kind, 'pool-lost');
});

test('one person’s box naming many addresses is heard about a few, not each', async () => {
  // The addresses are the box's word, and every push reaches the admin too.
  const { sent, clock, frame } = await fleet({ 'aaa-sam': SAM });
  // Counted by address: one loss is a push to the member's phones and one
  // to the admin's, with the button.
  const said = () => new Set(sent.map((p) => p.message.data.address)).size;
  await frame('aaa-sam', Array.from({ length: 20 }, (_, i) => gone(SAM, 60 * 60_000, { address: `xo${i}.lan` })));
  assert.equal(said(), 8);
  // A bound on the hour, not for good.
  clock.now += 60 * 60_000;
  await frame('aaa-sam', Array.from({ length: 20 }, (_, i) => gone(SAM, 120 * 60_000, { address: `xo${i + 20}.lan` })));
  assert.equal(said(), 16);
});

/**
 * A setup job begun by the admin on `hostId`, so that its progress is
 * believed, and that progress's last word with whatever `extra` says about
 * the watchdog. The machine is played the way xosetup-coordinator.test.js
 * plays one: `begin` answered with a job id.
 */
async function setupSaid(/** @type {any} */ core, /** @type {string} */ hostId, /** @type {string} */ job, /** @type {any} */ extra, purpose = 'setup') {
  core.send = async () => ({ ok: true, text: 'Ready.', xosetup: { job, state: 'waiting', key: 'k', keySig: 's', hostKey: 'h', ...(purpose === 'watchdog' ? { can: ['watchdog'] } : {}) } });
  const requester = { email: ELI, admin: true };
  const params = purpose === 'watchdog' ? { phase: 'watchdog', address: '10.0.0.2', pin: 'a'.repeat(64) } : { phase: 'begin', address: 'xo.lan', pin: 'a'.repeat(64) };
  const begun = await core.dispatch({ verb: 'xosetup', params, actor: `fleet:${ELI}`, requester, preferHost: hostId });
  assert.equal(begun.ok, true, begun.text);
  const of = purpose === 'watchdog' ? XOWATCHDOG_STEPS.length : XOSETUP_STEPS.length;
  await core.onHostMessage(hostId, { kind: 'event', event: 'xosetup.progress', job, step: of, of, phase: 'done', state: 'done', text: 'Done.', ...(purpose === 'watchdog' ? { purpose } : {}), ...extra });
}

test('a push about a lost pool says whether its Xen Orchestra will try by itself, from what setup learned', async () => {
  // ASKED FOR, about the push above: "Has to be a better way, is this a
  // known issue?" The box that sees the pool go holds the fleet's limited
  // token and cannot list plugins; setup, with the admin sign-in, learns
  // whether the reconnect watchdog is on it and said so once, in a sentence
  // nobody kept. Now the coordinator keeps it, and the push is worded from
  // it: wait, or press Reconnect and add the watchdog, or what it said before
  // anything was learned.
  const { core, sent: every, frame } = await fleet({ deb14: null });
  await frame('deb14', [there(ELI)]);
  // The setups' own pushes ("Hypervisor added") are not the ones in question.
  const sent = /** @type {typeof every} */ ([]);
  every.push = (...p) => sent.push(...p.filter((x) => x.message.data?.kind === 'pool-lost'));

  // Setup found no watchdog on xo.lan.
  await setupSaid(core, 'deb14', 'a1b2c3d4e5f6', { watchdog: 'absent', address: 'xo.lan' });
  await frame('deb14', [gone(ELI, POOL_LOST_AFTER_MS, { pools: [] })]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.title, 'xo.lan shows no pools', 'the title changed');
  assert.equal(
    sent[0].message.body,
    'Xen Orchestra at xo.lan answers deb14 but shows none of its pools. This Xen Orchestra has no reconnect watchdog, so nothing will try on its own. Reconnect from the pool’s page brings them back, and Add the reconnect watchdog there makes this fix itself next time.',
  );
  assert.deepEqual(sent[0].message.data, { kind: 'pool-lost', name: 'pool-lost-xo.lan', hostId: 'deb14', address: 'xo.lan' }, 'what the phone matches on changed');
  assert.equal(sent[0].message.category, 'fleet.pool.reconnect', 'the Reconnect button went');
  assert.equal(lost(core).at(-1)?.text, sent[0].message.body, 'the feed says something else than the phone');

  // Setup loaded it on xo2.lan. The same box, so the address is the fact's
  // key and not the box.
  await setupSaid(core, 'deb14', 'b1b2c3d4e5f6', { watchdog: 'loaded', address: 'xo2.lan' });
  await frame('deb14', [gone(ELI, POOL_LOST_AFTER_MS, { address: 'xo2.lan' })]);
  assert.equal(sent.length, 2);
  assert.equal(
    sent[1].message.body,
    'Xen Orchestra at xo2.lan answers deb14 but shows none of its pools. Reconnecting its servers usually brings them back. Its reconnect watchdog should bring them back by itself within a few minutes. If this stays, it is something the watchdog leaves to a person: a refused password, a pool already connected through another server, or the pool master itself.',
  );

  // The watchdog job put it on xo3.lan's disk, never seeing it load: the
  // same "should", and nothing stronger (C-5).
  await setupSaid(core, 'deb14', 'c1b2c3d4e5f6', { watchdog: 'added', address: 'xo3.lan' }, 'watchdog');
  await frame('deb14', [gone(ELI, POOL_LOST_AFTER_MS, { address: 'xo3.lan', pools: [{ id: 'p-2', name: 'lab' }] })]);
  assert.equal(sent.length, 3);
  assert.equal(
    sent[2].message.body,
    'Xen Orchestra at xo3.lan answers deb14 but no longer shows tn-pool. Reconnecting its servers usually brings it back. Its reconnect watchdog should bring it back by itself within a few minutes. If this stays, it is something the watchdog leaves to a person: a refused password, a pool already connected through another server, or the pool master itself.',
  );

  // A word that is not one of the three is not believed, and a job that
  // said nothing leaves nothing: xo4.lan is said as it always was.
  await setupSaid(core, 'deb14', 'd1b2c3d4e5f6', { watchdog: 'probably', address: 'xo4.lan' });
  await frame('deb14', [gone(ELI, POOL_LOST_AFTER_MS, { address: 'xo4.lan' })]);
  assert.equal(sent.length, 4);
  assert.equal(sent[3].message.body, 'Xen Orchestra at xo4.lan answers deb14 but shows none of its pools. Reconnecting its servers usually brings them back.');
});

test('what setup learned about a watchdog outlives the setup and a deploy, and goes with the person', async () => {
  // A setup job is forgotten after a day and the Durable Object is rebuilt
  // on every deploy; the push that needs the answer comes months later.
  const { core, frame } = await fleet({ deb14: null });
  await frame('deb14', [there(ELI)]);
  await setupSaid(core, 'deb14', 'a1b2c3d4e5f6', { watchdog: 'absent', address: 'xo.lan' });
  const saved = JSON.parse(JSON.stringify(core.serialiseXoWatchdogs()));
  assert.equal(saved.length, 1);
  assert.deepEqual(Object.keys(saved[0][1]).sort(), ['at', 'hostId', 'watchdog'], 'when and which box said it are kept with the answer');
  assert.equal(saved[0][1].hostId, 'deb14');

  const after = await fleet({ deb14: null });
  after.core.restoreXoWatchdogs(saved);
  await after.frame('deb14', [gone(ELI, POOL_LOST_AFTER_MS)]);
  assert.match(after.sent[0]?.message.body, /^Xen Orchestra at xo\.lan answers deb14 but shows none of its pools\. This Xen Orchestra has no reconnect watchdog/);

  // A row a stranger might have written: not a word from the list, a time
  // that has not happened, or no address in the key.
  const bad = await fleet({ deb14: null });
  bad.core.restoreXoWatchdogs([
    [`${ELI}\nxo.lan`, { watchdog: 'yes', at: 1, hostId: 'deb14' }],
    [`${ELI}\nxo.lan`, { watchdog: 'absent', at: Date.UTC(2099, 0, 1), hostId: 'deb14' }],
    ['xo.lan', { watchdog: 'absent', at: 1, hostId: 'deb14' }],
  ]);
  assert.deepEqual(bad.core.serialiseXoWatchdogs(), []);

  // Removed from the fleet, the person's answers go with their setups: a
  // fact about a pool that is no longer the fleet's to say anything about.
  const eli = [...core.clients.clients.values()].find((c) => c.email === ELI);
  core.revokeClient(eli.id);
  assert.deepEqual(core.serialiseXoWatchdogs(), []);
});
