// The sidecar's transport, on Node's own WebSocket: the heartbeat, and what
// happens when it is not answered.
//
//   node --test test/
//
// The transport used to prove a socket alive with a protocol ping the runtime
// answered; now it sends a heartbeat frame and reads the answer as a message.
// These are the cases that changed shape and had better still hold: a pong
// keeps the socket, any other frame keeps it too (a coordinator that predates
// the pong must not lose its hosts), silence drops it and a reconnect follows,
// and a refused dial says why. Against the harness server, over loopback, with
// the intervals turned down to milliseconds.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { attachWebSocketServer } from './helpers/ws-server.js';
import { WebSocketTransport } from '../src/fleet/host/transports/websocket.js';
import { HEARTBEAT_PING, HEARTBEAT_PONG } from '../src/fleet/protocol/heartbeat.js';

/**
 * A coordinator stand-in on loopback. `onPing` decides what a heartbeat gets.
 * @param {import('node:test').TestContext} t
 * @param {{
 *   onPing?: (conn: import('./helpers/ws-server.js').WsConnection) => void,
 *   authorise?: (req: any) => boolean|string,
 * }} [opts]
 */
async function coordinatorFor(t, opts = {}) {
  const server = createServer((_req, res) => res.writeHead(404).end());
  /** @type {import('./helpers/ws-server.js').WsConnection[]} */
  const conns = [];
  /** @type {string[]} */
  const frames = [];
  /** @type {any[]} */
  const upgrades = [];
  attachWebSocketServer(server, {
    path: '/host/connect',
    authorise: (req) => { upgrades.push(req.headers); return opts.authorise ? opts.authorise(req) : true; },
    onConnection: (conn) => {
      conns.push(conn);
      conn.on('message', (text) => {
        frames.push(text);
        if (text === HEARTBEAT_PING) (opts.onPing ?? ((c) => c.send(HEARTBEAT_PONG)))(conn);
      });
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  t.after(async () => {
    for (const c of conns) c.socket.destroy();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r(null)));
  });
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { origin: `http://127.0.0.1:${port}`, conns, frames, upgrades };
}

/** @param {() => boolean} cond @param {number} [ms] */
async function until(cond, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  return cond();
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

test('the proof headers ride on the upgrade, and the coordinator reads them', async (t) => {
  const c = await coordinatorFor(t);
  const transport = new WebSocketTransport({
    origin: c.origin,
    hostId: 'box',
    proof: async () => ({ nonce: 'the-nonce', proof: 'the-proof' }),
    logger: quiet,
  });
  t.after(() => transport.stop());
  await transport.start();
  assert.ok(await until(() => transport.connected), 'the transport never connected');
  assert.equal(c.upgrades[0]['x-fleet-nonce'], 'the-nonce');
  assert.equal(c.upgrades[0]['x-fleet-proof'], 'the-proof');
  assert.equal(new URL(transport.url).searchParams.get('hostId'), 'box');
});

test('a heartbeat goes out on the interval, its pong is counted, and nothing reaches the handler', async (t) => {
  const c = await coordinatorFor(t);
  const transport = new WebSocketTransport({ origin: c.origin, hostId: 'box', logger: quiet, pingIntervalMs: 40, pongGraceMs: 30 });
  /** @type {unknown[]} */
  const delivered = [];
  transport.onMessage(async (m) => { delivered.push(m); });
  t.after(() => transport.stop());
  await transport.start();

  assert.ok(await until(() => transport.heartbeats >= 3), `only ${transport.heartbeats} pongs in 3s`);
  assert.ok(c.frames.filter((f) => f === HEARTBEAT_PING).length >= 3, 'the coordinator saw fewer pings than were answered');
  // The pong is the transport's business, not the sidecar's.
  assert.deepEqual(delivered, []);
  // An ordinary frame still gets through, parsed.
  c.conns[0].send(JSON.stringify({ kind: 'intent', verb: 'health', id: 'h1' }));
  assert.ok(await until(() => delivered.length === 1));
  assert.deepEqual(delivered[0], { kind: 'intent', verb: 'health', id: 'h1' });
  assert.equal(transport.connected, true, 'the socket must have stayed up throughout');
});

test('a coordinator that never pongs but keeps talking keeps its host', async (t) => {
  // The compatibility case: a coordinator from before the heartbeat frame
  // drops the ping as an unknown kind, but it still asks for health and sends
  // intents. Any frame is proof of life; only silence is death.
  const c = await coordinatorFor(t, { onPing: (conn) => conn.send(JSON.stringify({ kind: 'intent', verb: 'health', id: 'x' })) });
  const transport = new WebSocketTransport({ origin: c.origin, hostId: 'box', logger: quiet, pingIntervalMs: 40, pongGraceMs: 30 });
  t.after(() => transport.stop());
  await transport.start();
  assert.ok(await until(() => c.frames.length >= 5), 'not enough heartbeats went out to judge');
  assert.equal(transport.heartbeats, 0, 'no pong was ever sent, so none may be counted');
  assert.equal(transport.connected, true, 'a talking coordinator must not be dropped for lacking a pong');
  assert.equal(c.conns.length, 1, 'the transport must not have reconnected');
});

test('silence past the grace drops the socket and the transport reconnects', async (t) => {
  /** @type {string[]} */
  const warned = [];
  const logger = { ...quiet, warn: (/** @type {string} */ m) => { warned.push(m); } };
  // Pings are swallowed: the socket is open as far as TCP knows and nothing
  // ever comes back down it — the half-open case.
  const c = await coordinatorFor(t, { onPing: () => {} });
  const transport = new WebSocketTransport({ origin: c.origin, hostId: 'box', logger, pingIntervalMs: 40, pongGraceMs: 200, maxBackoffMs: 50 });
  t.after(() => transport.stop());
  await transport.start();

  assert.ok(await until(() => c.conns.length >= 2), 'the transport never gave up on the mute socket and dialled again');
  assert.ok(warned.some((m) => /did not answer a heartbeat/.test(m)), `the drop must be said: ${warned.join(' | ')}`);
  // And the new socket is the live one.
  assert.ok(await until(() => transport.connected));
});

test('a refused dial asks why, and the reason reaches the log', async (t) => {
  /** @type {string[]} */
  const warned = [];
  const logger = { ...quiet, warn: (/** @type {string} */ m) => { warned.push(m); } };
  const c = await coordinatorFor(t, { authorise: () => 'that host has been revoked' });
  let asked = 0;
  const transport = new WebSocketTransport({
    origin: c.origin,
    hostId: 'box',
    logger,
    maxBackoffMs: 50,
    proof: async () => ({ nonce: 'n', proof: 'p' }),
    diagnose: async () => { asked += 1; return 'that host has been revoked'; },
  });
  t.after(() => transport.stop());
  await transport.start();
  assert.ok(await until(() => asked >= 1), 'the transport never asked why it was refused');
  assert.ok(warned.some((m) => /refused this host: that host has been revoked/.test(m)), `the reason must be in the log: ${warned.join(' | ')}`);
  assert.equal(transport.connected, false);
  assert.ok(transport.retryTimer, 'and it keeps trying');
});

test('a refused dial without a diagnose hook still says it was refused', async (t) => {
  /** @type {string[]} */
  const warned = [];
  const logger = { ...quiet, warn: (/** @type {string} */ m) => { warned.push(m); } };
  const c = await coordinatorFor(t, { authorise: () => 'nope' });
  const transport = new WebSocketTransport({ origin: c.origin, hostId: 'box', logger, maxBackoffMs: 50 });
  t.after(() => transport.stop());
  await transport.start();
  assert.ok(await until(() => warned.length >= 1));
  assert.match(warned[0], /did not accept the connection/);
});

test('stop() closes cleanly and the coordinator sees a normal close', async (t) => {
  const c = await coordinatorFor(t);
  const transport = new WebSocketTransport({ origin: c.origin, hostId: 'box', logger: quiet });
  await transport.start();
  assert.ok(await until(() => transport.connected));
  const closed = new Promise((r) => c.conns[0].on('close', (code) => r(code)));
  await transport.stop();
  assert.equal(await closed, 1000);
  assert.equal(transport.send({ kind: 'reply' }), false, 'nothing is sent after stop');
});
