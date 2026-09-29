// The heartbeat, at the core: a ping is answered, a pong is swallowed, and
// neither leaves a mark.
//
// worker/test/parity.test.js proves the same thing over a real socket against
// both coordinators; this is the cheap version that runs in every `node --test`
// and says WHICH layer answered. The core answering is what makes the Node
// harness and a Cloudflare runtime without auto-response identical on the wire;
// the auto-response on the Worker is an optimisation on top of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { HEARTBEAT_PING, HEARTBEAT_PONG, heartbeatKind } from '../src/fleet/protocol/heartbeat.js';

/** @type {string[]} */
const warned = [];
const logger = { info: () => {}, warn: (/** @type {string} */ m) => { warned.push(m); }, error: () => {}, debug: () => {} };

test('the two frames are JSON with a kind, and nothing else', () => {
  // The dispatchers switch on `kind` after parsing; the transport compares the
  // bytes before parsing. Both readings must agree with the constants.
  assert.deepEqual(JSON.parse(HEARTBEAT_PING), { kind: 'ping' });
  assert.deepEqual(JSON.parse(HEARTBEAT_PONG), { kind: 'pong' });
  assert.equal(heartbeatKind(HEARTBEAT_PING), 'ping');
  assert.equal(heartbeatKind(HEARTBEAT_PONG), 'pong');
  assert.equal(heartbeatKind('{"kind":"health"}'), null);
  assert.equal(heartbeatKind(undefined), null);
  // Byte-exact against a re-spelling, which is the mistake the constants exist
  // to prevent: the Worker's auto-response matches bytes.
  assert.equal(HEARTBEAT_PING, JSON.stringify({ kind: 'ping' }));
  assert.equal(HEARTBEAT_PONG, JSON.stringify({ kind: 'pong' }));
});

test('a ping is answered with the pong constant, and moves nothing', async () => {
  const core = new CoordinatorCore({ logger });
  /** @type {any[]} */
  const sent = [];
  core.hostConnected('box', (msg) => { sent.push(msg); });
  const events = core.events.length;
  warned.length = 0;

  await core.onHostMessage('box', JSON.parse(HEARTBEAT_PING));

  // Whatever the connect sent (a config frame, perhaps), the ping added exactly
  // one thing: the pong, spelled as the constant would be on the wire.
  const pong = sent.at(-1);
  assert.equal(JSON.stringify(pong), HEARTBEAT_PONG, `the answer must be the shared bytes, got ${JSON.stringify(pong)}`);
  assert.equal(core.events.length, events, 'a heartbeat recorded an event');
  assert.deepEqual(warned, [], `a heartbeat warned: ${warned.join('; ')}`);
  const host = core.registry.hosts.get('box');
  assert.equal(host?.state, 'unknown', 'a heartbeat is not a health report and must not move the host');
});

test('a pong from a host is dropped in silence, not warned about as an unknown frame', async () => {
  const core = new CoordinatorCore({ logger });
  /** @type {any[]} */
  const sent = [];
  core.hostConnected('box', (msg) => { sent.push(msg); });
  const before = sent.length;
  warned.length = 0;

  await core.onHostMessage('box', JSON.parse(HEARTBEAT_PONG));

  assert.equal(sent.length, before, 'a pong must not be answered');
  assert.deepEqual(warned, [], `a pong warned: ${warned.join('; ')}`);
});

test('a ping from a host whose socket is gone does not throw', async () => {
  const core = new CoordinatorCore({ logger });
  core.hostConnected('box', () => { throw new Error('socket closed'); });
  await core.onHostMessage('box', JSON.parse(HEARTBEAT_PING));
  core.hostDisconnected('box', 'gone');
  await core.onHostMessage('box', JSON.parse(HEARTBEAT_PING));
  await core.onHostMessage('never-connected', JSON.parse(HEARTBEAT_PING));
});
