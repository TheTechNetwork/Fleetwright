// The hand-rolled WebSocket, over real loopback sockets.
//
//   node --test test/
//
// A transport every fleet host holds open permanently is worth testing at the
// frame level, not just "did a message arrive". The cases here are the ones
// that make a hand-rolled implementation look fine against itself and fail
// against everyone else: masking direction, fragmentation, control-frame rules,
// and length fields that arrive attacker-controlled.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  attachWebSocketServer,
  connectWebSocket,
  encodeFrame,
  decodeFrame,
  acceptKey,
  WsConnection,
} from '../src/fleet/ws.js';

/**
 * A server that echoes, plus the connections it accepted.
 * @param {import('node:test').TestContext} t
 * @param {{ authorise?: (req: any) => boolean|string, path?: string, maxMessageBytes?: number }} [opts]
 */
async function serverFor(t, opts = {}) {
  const server = createServer((_req, res) => res.writeHead(200).end('http still works'));
  /** @type {WsConnection[]} */
  const conns = [];
  /** @type {string[]} */
  const received = [];
  attachWebSocketServer(server, {
    path: opts.path ?? '/host/connect',
    authorise: opts.authorise,
    maxMessageBytes: opts.maxMessageBytes,
    onConnection: (conn) => {
      conns.push(conn);
      conn.on('message', (m) => {
        received.push(m);
        conn.send(`echo:${m}`);
      });
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  // server.close() waits for open connections, and an upgraded socket never
  // ends on its own — so tear the sockets down first or the hook hangs forever.
  t.after(async () => {
    for (const c of conns) c.socket.destroy();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r(null)));
  });
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { server, port, conns, received, url: `ws://127.0.0.1:${port}${opts.path ?? '/host/connect'}` };
}

/** @param {WsConnection} conn */
function nextMessage(conn) {
  return new Promise((resolve) => conn.once('message', resolve));
}

/**
 * Buffer everything a connection receives.
 *
 * Awaiting `once('message')` in a loop looks equivalent and is not: messages
 * that arrive between iterations land with no listener attached and are gone.
 * Anything expecting more than one message needs this.
 * @param {WsConnection} conn
 */
function collect(conn) {
  /** @type {string[]} */
  const messages = [];
  /** @type {(() => void)[]} */
  let waiters = [];
  conn.on('message', (m) => {
    messages.push(m);
    const woken = waiters;
    waiters = [];
    for (const w of woken) w();
  });
  return {
    messages,
    /** @param {number} n */
    async waitFor(n) {
      while (messages.length < n) await new Promise((r) => waiters.push(/** @type {() => void} */ (r)));
      return messages;
    },
  };
}

// --- the handshake ----------------------------------------------------------

test('a client can connect and exchange a message', async (t) => {
  const { url, received } = await serverFor(t);
  const conn = await connectWebSocket(url);
  t.after(() => conn.close());

  conn.send('hello');

  assert.equal(await nextMessage(conn), 'echo:hello');
  assert.deepEqual(received, ['hello']);
});

test('the accept key is computed per RFC 6455', () => {
  // The example from the RFC itself, so a rewrite of this function has
  // something external to be right about.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('ordinary HTTP still works on the same port', async (t) => {
  // The coordinator serves both: a host dials one origin, and the phone speaks
  // HTTPS to it.
  const { port } = await serverFor(t);
  const res = await fetch(`http://127.0.0.1:${port}/anything`);
  assert.equal(await res.text(), 'http still works');
});

test('a connection to the wrong path is refused', async (t) => {
  const { port } = await serverFor(t, { path: '/host/connect' });
  await assert.rejects(
    () => connectWebSocket(`ws://127.0.0.1:${port}/nope`, { timeoutMs: 3000 }),
    /upgrade refused: HTTP\/1.1 404/,
  );
});

test('authorisation runs before the upgrade, so a refused peer never gets a socket', async (t) => {
  const { port } = await serverFor(t, {
    authorise: (req) => req.headers.authorization === 'Bearer right' || 'Unauthorized',
  });
  const url = `ws://127.0.0.1:${port}/host/connect`;

  await assert.rejects(
    () => connectWebSocket(url, { headers: { authorization: 'Bearer wrong' }, timeoutMs: 3000 }),
    /upgrade refused: HTTP\/1.1 401/,
  );

  const good = await connectWebSocket(url, { headers: { authorization: 'Bearer right' } });
  t.after(() => good.close());
  good.send('ok');
  assert.equal(await nextMessage(good), 'echo:ok');
});

test('dialling something that is not a websocket fails cleanly', async (t) => {
  const server = createServer((_req, res) => res.writeHead(200).end('hello'));
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  t.after(() => new Promise((r) => server.close(() => r(null))));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  await assert.rejects(() => connectWebSocket(`ws://127.0.0.1:${port}/`, { timeoutMs: 3000 }), /upgrade refused/);
});

test('a non-websocket URL scheme is rejected without dialling', async () => {
  await assert.rejects(() => connectWebSocket('http://127.0.0.1:1/'), /not a websocket url/);
});

// --- messages ---------------------------------------------------------------

test('messages round-trip in order, including unicode and empty', async (t) => {
  const { url, received } = await serverFor(t);
  const conn = await connectWebSocket(url);
  t.after(() => conn.close());
  const echoes = collect(conn);

  const sent = ['first', '', 'héllo — ünicode ✅', JSON.stringify({ v: 1, verb: 'list' })];
  for (const m of sent) conn.send(m);

  const got = await echoes.waitFor(sent.length);

  assert.deepEqual(received, sent);
  assert.deepEqual(got, sent.map((m) => `echo:${m}`));
});

test('a message larger than one frame arrives whole', async (t) => {
  // Not fragmented on the way out by this implementation, but a 100 KB payload
  // certainly arrives as several TCP reads, which is the same reassembly path.
  const { url, received } = await serverFor(t);
  const conn = await connectWebSocket(url);
  t.after(() => conn.close());

  const big = 'x'.repeat(100_000);
  conn.send(big);
  await nextMessage(conn);

  assert.equal(received[0].length, 100_000);
});

test('two messages arriving in one TCP read are both delivered', async (t) => {
  // The decoder loops until the buffer is short, rather than assuming one read
  // is one frame. Getting this wrong drops every message after the first
  // whenever the network coalesces.
  const { url, received } = await serverFor(t);
  const conn = await connectWebSocket(url);
  t.after(() => conn.close());
  const echoes = collect(conn);

  const a = encodeFrame(0x1, Buffer.from('one'), true);
  const b = encodeFrame(0x1, Buffer.from('two'), true);
  conn.socket.write(Buffer.concat([a, b]));

  await echoes.waitFor(2);
  assert.deepEqual(received, ['one', 'two']);
});

test('a fragmented message is reassembled', async (t) => {
  const { url, received } = await serverFor(t);
  const conn = await connectWebSocket(url);
  t.after(() => conn.close());

  // FIN=0 TEXT, then FIN=0 CONT, then FIN=1 CONT — built by hand because
  // encodeFrame always sets FIN.
  /** @param {number} opcode @param {string} text @param {boolean} fin */
  const frag = (opcode, text, fin) => {
    const f = encodeFrame(opcode, Buffer.from(text), true);
    if (!fin) f[0] &= 0x7f;
    return f;
  };
  conn.socket.write(Buffer.concat([frag(0x1, 'frag', false), frag(0x0, 'ment', false), frag(0x0, 'ed', true)]));

  await nextMessage(conn);
  assert.deepEqual(received, ['fragmented']);
});

// --- keepalive and close ----------------------------------------------------

test('a ping is answered with a pong', async (t) => {
  const { url } = await serverFor(t);
  const conn = await connectWebSocket(url);
  t.after(() => conn.close());

  const pong = new Promise((r) => conn.once('pong', r));
  conn.ping();
  await pong;
});

test('close is delivered to both ends with its code', async (t) => {
  const { url, conns } = await serverFor(t);
  const conn = await connectWebSocket(url);
  while (!conns.length) await new Promise((r) => setTimeout(r, 10));

  const serverSaw = new Promise((r) => conns[0].on('close', (code) => r(code)));
  const clientSaw = new Promise((r) => conn.on('close', (code) => r(code)));
  conn.close(1000, 'done');

  assert.equal(await serverSaw, 1000);
  assert.equal(await clientSaw, 1000);
  assert.equal(conn.closed, true);
});

test('a dropped socket surfaces as a close, not a hang', async (t) => {
  // The case a fleet host actually hits: a NAT drops the mapping and the peer
  // never says goodbye.
  const { url, conns } = await serverFor(t);
  const conn = await connectWebSocket(url);
  while (!conns.length) await new Promise((r) => setTimeout(r, 10));

  const closed = new Promise((r) => conn.on('close', (code) => r(code)));
  conns[0].socket.destroy();

  assert.equal(await closed, 1006, 'an abnormal close must be distinguishable from a clean one');
});

test('sending after close is a no-op rather than a throw', async (t) => {
  const { url } = await serverFor(t);
  const conn = await connectWebSocket(url);
  conn.close();
  assert.equal(conn.send('anyone there'), false);
});

// --- the direction rules, which are the easy thing to get wrong --------------

test('a server rejects an unmasked client frame', async (t) => {
  // RFC 6455 is one-directional about this. Honouring it makes a
  // half-implemented peer fail loudly here rather than subtly later.
  const { url } = await serverFor(t);
  const conn = await connectWebSocket(url);

  const closed = new Promise((r) => conn.on('close', (code) => r(code)));
  conn.socket.write(encodeFrame(0x1, Buffer.from('unmasked'), false));

  assert.equal(await closed, 1002);
});

test('a client rejects a masked server frame', () => {
  assert.throws(
    () => decodeFrame(encodeFrame(0x1, Buffer.from('x'), true), { expectMasked: false, max: 1024 }),
    /server frame was masked/,
  );
});

test('an oversized declared length is refused before anything is allocated', () => {
  // The length field is attacker-supplied. A peer announcing 2^63 bytes must
  // not be believed.
  const evil = Buffer.alloc(10);
  evil[0] = 0x81;
  evil[1] = 127;
  evil.writeBigUInt64BE(2n ** 62n, 2);
  assert.throws(() => decodeFrame(evil, { expectMasked: false, max: 1024 }), /larger than the message limit/);
});

test('a message over the limit closes the connection instead of buffering', async (t) => {
  const { url } = await serverFor(t, { maxMessageBytes: 1024 });
  const conn = await connectWebSocket(url);

  const closed = new Promise((r) => conn.on('close', (code) => r(code)));
  conn.send('x'.repeat(4096));

  assert.ok([1002, 1009].includes(await closed));
});

test('reserved bits and stray control frames are protocol errors', () => {
  const rsv = encodeFrame(0x1, Buffer.from('x'), false);
  rsv[0] |= 0x40;
  assert.throws(() => decodeFrame(rsv, { expectMasked: false, max: 1024 }), /reserved bits/);

  // A control frame may not be fragmented or long.
  const longPing = encodeFrame(0x9, Buffer.alloc(200), false);
  assert.throws(() => decodeFrame(longPing, { expectMasked: false, max: 4096 }), /control frame/);
});

test('a partial frame yields null rather than a wrong answer', () => {
  const whole = encodeFrame(0x1, Buffer.from('hello there'), false);
  for (let i = 0; i < whole.length; i++) {
    assert.equal(decodeFrame(whole.subarray(0, i), { expectMasked: false, max: 1024 }), null, `prefix of ${i}`);
  }
  assert.equal(decodeFrame(whole, { expectMasked: false, max: 1024 })?.payload.toString(), 'hello there');
});

test('binary frames are refused, because nothing here sends bytes', async (t) => {
  const { url } = await serverFor(t);
  const conn = await connectWebSocket(url);

  const closed = new Promise((r) => conn.on('close', (code) => r(code)));
  conn.socket.write(encodeFrame(0x2, Buffer.from([1, 2, 3]), true));

  assert.equal(await closed, 1003);
});
