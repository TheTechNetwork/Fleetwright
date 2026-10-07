// A pool no machine can reach, reached through the phone adding it: the
// coordinator's half. docs/hypervisors.md, "Through the phone".
//
//   node --test test/xo-relay-coordinator.test.js
//
// ASKED FOR: "no machine in the fleet can reach the pool: the phone's own
// network carries the first minute". What is pinned here is what bounds a
// relay — whose it is, which phone carries it, which machine may use it and
// when, how much it carries and when it ends — at the coordinator, which is
// the party a relay must not hand more than a byte pipe. The bytes themselves,
// and that they are TLS the coordinator cannot read, are proven end to end in
// test/relay-end-to-end.test.js on the host's branch.
//
// The machines are played the way xosetup-coordinator.test.js plays them: a
// transport that answers intents from a function, and a socket that records
// the relay frames each machine is sent.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { RELAY_MAX_BYTES } from '../src/fleet/coordinator/relays.js';

const JOB = 'a1b2c3d4e5f6';
const PHONE = 'cl_phone_1';
const admin = { email: 'eli@example.com', admin: true };
const member = { email: 'sam@example.com', admin: false };

/**
 * Permanent machines at the protocol each speaks, a transport that answers
 * intents from `reply`, and the relay frames each machine was sent.
 *
 * @param {Record<string, number>} boxes  hostId → protocol
 * @param {(hostId: string, spec: any, core: CoordinatorCore) => any} reply
 */
function fleet(boxes, reply) {
  /** @type {Array<() => void>} */
  const timers = [];
  const core = new CoordinatorCore({
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length - 1;
    },
    clearTimer: (i) => {
      timers[i] = () => {};
    },
  });
  /** @type {Record<string, any[]>} */
  const frames = {};
  for (const [hostId, protocol] of Object.entries(boxes)) {
    frames[hostId] = [];
    core.registry.connect(hostId, (msg) => frames[hostId].push(msg));
    core.registry.recordHealth(hostId, { hub: { reachable: true }, protocol, maxSessions: 5, running: 0, free: 5, labels: [] });
  }
  /** @type {Array<{ hostId: string, spec: any }>} */
  const asked = [];
  core.send = /** @type {any} */ (async (/** @type {any} */ host, /** @type {any} */ spec) => {
    asked.push({ hostId: host.hostId, spec });
    return reply(host.hostId, spec, core);
  });
  /** Fire every timer set so far: the clock running out. */
  const elapse = () => timers.splice(0).forEach((fn) => fn());
  return { core, asked, frames, elapse };
}

/** A phone's relay socket: what it was sent, and whether it was closed. */
function phoneSocket() {
  /** @type {any[]} */
  const got = [];
  /** @type {Array<[number, string]>} */
  const closed = [];
  return { got, closed, send: (/** @type {any} */ m) => got.push(m), close: (/** @type {number} */ c, /** @type {string} */ r) => closed.push([c, r]) };
}

/** A machine that answers `begin` with a job and every other phase plainly. */
const machine = (/** @type {string} */ _hostId, /** @type {any} */ spec) =>
  spec.verb === 'xoprobe'
    ? { ok: true, text: 'Nothing answered at xo.lan from here.', xoprobe: { reachable: false, xo: null, tls: false, cert: null } }
    : spec.params.phase === 'begin'
      ? { ok: true, text: 'Ready for the sign-in.', xosetup: { job: JOB, state: 'waiting', key: 'k', keySig: 's', hostKey: 'h' } }
      : { ok: true, text: 'Running.', xosetup: { job: JOB, state: 'running', step: 0, of: 8 } };

const probe = (/** @type {string} */ relay, device = PHONE, requester = admin, address = 'xo.lan') => ({
  verb: 'xoprobe',
  params: { address, relay },
  actor: `fleet:${requester.email}`,
  requester,
  device,
});
const begin = (/** @type {string} */ relay, device = PHONE) => ({
  verb: 'xosetup',
  params: { phase: 'begin', address: 'xo.lan', pin: 'a'.repeat(64), trust: 'accepted', relay },
  actor: `fleet:${admin.email}`,
  requester: admin,
  device,
});

/** A relay opened as `requester` from `device`, and the socket it lives on. */
function open(/** @type {CoordinatorCore} */ core, requester = admin, device = PHONE, ask = { address: 'xo.lan' }) {
  const phone = phoneSocket();
  const r = core.openRelay(requester, device, ask, phone);
  return { r, phone };
}

test('a relay is carried only by an admin’s own phone, and a refusal is said down the socket that asked', () => {
  const { core } = fleet({ deb14: 12 }, machine);
  for (const [requester, device, code] of /** @type {const} */ ([
    [member, PHONE, 'not_admin'],
    [null, null, 'not_signed_in'], // the break-glass token: no phone, no name
    [admin, null, 'not_signed_in'],
  ])) {
    const { r, phone } = open(core, /** @type {any} */ (requester), /** @type {any} */ (device));
    assert.equal(r.ok, false);
    assert.equal(/** @type {any} */ (r).error.code, code);
    // THE PHONE HEARS WHY, in the sentence, and the socket is closed.
    assert.equal(phone.got[0].op, 'closed');
    assert.equal(phone.got[0].text, /** @type {any} */ (r).text);
    assert.equal(phone.closed.length, 1);
  }
  assert.equal(core.relays.open.size, 0);
  // An address the protocol would not carry is refused before any relay exists.
  assert.equal(open(core, admin, PHONE, { address: 'https://xo.lan/' }).r.ok, false);
});

test('the probe offers the way through the phone only when no machine reached the address, on a machine that speaks it', async () => {
  // Nobody reached it: deb14 is named, and rpi-7550 (protocol 11, the version before relays) never is.
  const unreached = fleet({ deb14: 12, 'rpi-7550': 11 }, machine);
  const none = await unreached.core.dispatch({ verb: 'xoprobe', params: { address: 'xo.lan' }, actor: `fleet:${admin.email}`, requester: admin });
  assert.deepEqual(none.relay, { hostId: 'deb14' });

  // Somebody reached it: nothing is offered.
  const reached = fleet({ deb14: 12 }, () => ({ ok: true, text: 'Xen Orchestra answered.', xoprobe: { reachable: true, xo: true, tls: true, cert: 'b'.repeat(64) } }));
  const some = await reached.core.dispatch({ verb: 'xoprobe', params: { address: 'xo.lan' }, actor: `fleet:${admin.email}`, requester: admin });
  assert.equal(some.relay, undefined);

  // No machine new enough: nothing is offered, and a relay cannot be opened.
  const old = fleet({ 'rpi-7550': 11 }, machine);
  const before = await old.core.dispatch({ verb: 'xoprobe', params: { address: 'xo.lan' }, actor: `fleet:${admin.email}`, requester: admin });
  assert.equal(before.relay, undefined);
  const { r } = open(old.core);
  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).text, /older than protocol 12/);
});

test('bytes cross between the phone and its one machine, and only while that machine is using it for something asked', async () => {
  /** @type {any} */
  let during = null;
  const { core, frames } = fleet({ deb14: 12, 'rpi-7550': 12 }, async (hostId, spec, c) => {
    // THE MACHINE, MID-PROBE: it opens a connection through the phone and
    // the phone answers, then bytes go each way.
    const relay = spec.params.relay;
    await c.onHostMessage(hostId, { kind: 'relay', relay, stream: 1, op: 'open' });
    const opened = phone.got.at(-1);
    c.relayFromPhone(relay, JSON.stringify({ op: 'opened', stream: 1 }));
    await c.onHostMessage(hostId, { kind: 'relay', relay, stream: 1, op: 'data', data: Buffer.from('\x16\x03\x01 client hello').toString('base64') });
    c.relayFromPhone(relay, JSON.stringify({ op: 'data', stream: 1, data: Buffer.from('\x16\x03\x03 server hello').toString('base64') }));
    during = { opened, toPhone: phone.got.at(-1), toHost: frames[hostId].slice() };
    return { ok: true, text: 'Xen Orchestra answered at xo.lan.', xoprobe: { reachable: true, xo: true, tls: true, cert: 'c'.repeat(64) } };
  });
  const { r, phone } = open(core, admin, PHONE, { address: 'xo.lan', host: 'deb14' });
  assert.equal(r.ok, true);
  const relay = /** @type {any} */ (r).relay;
  assert.equal(phone.got[0].op, 'ready');
  assert.equal(phone.got[0].hostId, 'deb14');
  assert.equal(phone.got[0].address, 'xo.lan');

  // BEFORE ANYTHING IS ASKED, the machine may not open a connection.
  await core.onHostMessage('deb14', { kind: 'relay', relay, stream: 9, op: 'open' });
  assert.equal(frames.deb14.at(-1).op, 'refused');
  assert.equal(phone.got.length, 1, 'the phone was asked for nothing');
  // AND ANOTHER MACHINE NEVER: it is told the relay is closed, to it.
  await core.onHostMessage('rpi-7550', { kind: 'relay', relay, stream: 1, op: 'open' });
  assert.equal(frames['rpi-7550'].at(-1).op, 'closed');
  assert.equal(phone.got.length, 1);

  const answer = await core.dispatch(probe(relay));
  assert.equal(answer.ok, true, answer.text);
  // One machine, the relay's, and its answer marked as through the phone.
  assert.deepEqual(answer.probes.map((/** @type {any} */ p) => [p.hostId, p.through, p.cert]), [['deb14', 'phone', 'c'.repeat(64)]]);
  assert.deepEqual(during.opened, { op: 'open', stream: 1 }, 'the phone is told a connection number and never an address');
  assert.equal(Buffer.from(during.toPhone.data, 'base64').toString('latin1'), '\x16\x03\x01 client hello');
  assert.deepEqual(during.toHost.map((/** @type {any} */ f) => f.op), ['refused', 'opened', 'data']);
  assert.equal(Buffer.from(during.toHost.at(-1).data, 'base64').toString('latin1'), '\x16\x03\x03 server hello');
  // The probe's connection ends with its answer.
  assert.deepEqual(phone.got.at(-1), { op: 'end', stream: 1 });
});

test('a relay is one person’s, one phone’s, to one address, for one probe and one job', async () => {
  const { core, asked } = fleet({ deb14: 12 }, machine);
  const { r } = open(core);
  const relay = /** @type {any} */ (r).relay;

  // ANOTHER PHONE OF THE SAME PERSON, another admin, a guess: the same words.
  const other = await core.dispatch(probe(relay, 'cl_other_phone'));
  const stranger = await core.dispatch(probe(relay, PHONE, { email: 'ops@example.com', admin: true }));
  const guess = await core.dispatch(probe('f'.repeat(24)));
  assert.equal(other.error.code, 'unknown_relay');
  assert.equal(stranger.text, other.text);
  assert.equal(guess.text, other.text);
  // Another address: the phone connects to what was typed and nowhere else.
  assert.equal((await core.dispatch(probe(relay, PHONE, admin, 'nas.lan'))).error.code, 'relay_address');
  assert.equal(asked.length, 0, 'none of those reached a machine');

  // One probe, then one begin, then nothing.
  assert.equal((await core.dispatch(probe(relay))).ok, true);
  assert.equal((await core.dispatch(probe(relay))).error.code, 'relay_spent');
  const begun = await core.dispatch(begin(relay));
  assert.equal(begun.ok, true, begun.text);
  assert.equal(begun.hostId, 'deb14');
  assert.equal(asked.at(-1)?.spec.params.relay, relay, 'the machine is told which relay the job reaches Xen Orchestra through');
  assert.equal((await core.dispatch(begin(relay))).error.code, 'relay_spent');
  // NEVER PLAIN HTTP through a phone, where the sign-in would be readable.
  const second = open(core).r;
  const plain = await core.dispatch({ ...begin(/** @type {any} */ (second).relay), params: { phase: 'begin', address: 'xo.lan', plain: 'accepted', relay: /** @type {any} */ (second).relay } });
  assert.equal(plain.error.code, 'relay_plain');
});

test('the end of the job closes the relay, and both ends are told why', async () => {
  for (const ending of ['progress', 'status', 'done']) {
    const { core, frames } = fleet({ deb14: 12 }, (hostId, spec) =>
      spec.params.phase === 'status' ? { ok: true, text: 'Stopped.', xosetup: { job: JOB, state: 'failed', step: 1, of: 5 } } : machine(hostId, spec));
    const { r, phone } = open(core);
    const relay = /** @type {any} */ (r).relay;
    await core.dispatch(begin(relay));
    assert.equal(core.relays.open.size, 1);
    if (ending === 'progress') {
      await core.onHostMessage('deb14', { kind: 'event', event: 'xosetup.progress', job: JOB, step: 8, of: 8, phase: 'done', state: 'done', text: 'xo.lan is in the fleet.' });
    } else if (ending === 'status') {
      // A policy job reports nothing until it applies: its status is the end.
      await core.dispatch({ verb: 'xosetup', params: { phase: 'status', job: JOB }, actor: `fleet:${admin.email}`, requester: admin });
    } else {
      await core.onHostMessage('deb14', { kind: 'relay', relay, op: 'done' });
    }
    assert.equal(core.relays.open.size, 0, ending);
    assert.equal(phone.got.at(-1).op, 'closed', ending);
    assert.match(phone.got.at(-1).text, /job using this relay ended/, ending);
    assert.equal(phone.closed.length, 1, ending);
    assert.equal(frames.deb14.at(-1).op, 'closed', ending);
  }
});

test('the byte cap, the clock, the phone and the machine leaving each close a relay', async () => {
  const kinds = /** @type {const} */ (['bytes', 'clock', 'phone', 'machine']);
  for (const kind of kinds) {
    const { core, frames, elapse } = fleet({ deb14: 12 }, machine);
    const { r, phone } = open(core);
    const relay = /** @type {any} */ (r).relay;
    await core.dispatch(begin(relay));
    await core.onHostMessage('deb14', { kind: 'relay', relay, stream: 1, op: 'open' });
    core.relayFromPhone(relay, JSON.stringify({ op: 'opened', stream: 1 }));
    if (kind === 'bytes') {
      // Full pieces until one goes past the cap: that one is not carried.
      const piece = Buffer.alloc(48 * 1024).toString('base64');
      const pieces = Math.ceil(RELAY_MAX_BYTES / (48 * 1024)) + 1;
      for (let i = 0; i < pieces && core.relays.open.size; i++) core.relayFromPhone(relay, JSON.stringify({ op: 'data', stream: 1, data: piece }));
      const carried = frames.deb14.filter((f) => f.op === 'data').length;
      assert.equal(carried, Math.floor(RELAY_MAX_BYTES / (48 * 1024)), 'nothing past the cap reached the machine');
      assert.match(phone.got.at(-1).text, /64 MiB/);
    } else if (kind === 'clock') {
      elapse();
      assert.match(phone.got.at(-1).text, /fifteen minutes/);
    } else if (kind === 'phone') {
      core.relayPhoneGone(relay);
    } else {
      core.hostDisconnected('deb14', 'socket closed');
      assert.match(phone.got.at(-1).text, /deb14/);
    }
    assert.equal(core.relays.open.size, 0, kind);
    assert.equal(phone.got.at(-1).op, 'closed', kind);
  }
});

test('anything that is not a frame of ours closes the relay rather than being carried', async () => {
  const { core, frames } = fleet({ deb14: 12 }, machine);
  const { r, phone } = open(core);
  const relay = /** @type {any} */ (r).relay;
  await core.dispatch(begin(relay));
  await core.onHostMessage('deb14', { kind: 'relay', relay, stream: 1, op: 'open' });
  core.relayFromPhone(relay, JSON.stringify({ op: 'opened', stream: 1 }));
  core.relayFromPhone(relay, JSON.stringify({ op: 'data', stream: 1, data: 'not base64!' }));
  assert.equal(core.relays.open.size, 0);
  assert.equal(frames.deb14.filter((f) => f.op === 'data').length, 0);
  assert.equal(phone.got.at(-1).op, 'closed');
});
