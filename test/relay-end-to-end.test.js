// A pool only the phone can reach, onboarded through the phone, end to end.
//
//   node --test test/relay-end-to-end.test.js
//
// ASKED FOR: "No machine in the fleet can reach the pool: the phone's own
// network carries the first minute. The phone relays bytes between a machine
// and Xen Orchestra over TLS the machine terminates, so neither the phone nor
// the coordinator reads the sign-in." docs/hypervisors.md, "Through the phone".
//
// EVERYTHING HERE IS THE REAL THING but two: the phone, played by this file
// the way both apps do it (a WebSocket to the coordinator and a TCP connection
// to the address on its own network), and Xen Orchestra, played by the
// suite's stand-in (helpers/xo-stand-in.js) — a real TLS server with a
// self-signed certificate made for this run, a real WebSocket upgrade and
// JSON-RPC. Between them run the Node coordinator over real sockets, and a
// real sidecar whose setup is the one that runs on a box.
//
// ONLY THE PHONE CAN REACH IT. The address is a name under `.invalid`, which
// no resolver answers, so the machine cannot reach it on any network; the
// phone resolves it to the stand-in, which is what a phone on the pool's
// Wi-Fi does. The first assertion is that the machine's own probe found
// nothing — the case this exists for — and every connection the stand-in saw
// is one the phone made.
//
// THE CLAIM PINNED is the one the design rests on: every byte the phone and
// the coordinator carried is TLS the machine opened, so the admin password is
// in none of them, while Xen Orchestra did receive it — the search has a
// positive control, or it would prove only that the password never moved.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { createHash } from 'node:crypto';

import { Coordinator } from './helpers/node-coordinator.js';
import { startStubHub } from './helpers/stub-hub.js';
import { standIn, PASSWORD, skip } from './helpers/xo-stand-in.js';
import { WebSocketTransport } from '../src/fleet/host/transports/websocket.js';
import { Sidecar } from '../src/fleet/host/sidecar.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { generateKeyPair, sign, verify, signingInput } from '../src/fleet/crypto.js';
import { seal, open, newSealKey, xosetupAad, xosetupHandoffAad } from '../src/fleet/seal.js';

const HOST = 'deb14';
const NAME = 'xo.fleetwright.invalid';

/** A coordinator, a sidecar joined to it over a real socket, and an admin's phone credential. */
async function fleet(/** @type {import('node:test').TestContext} */ t) {
  const stub = await startStubHub({ host: HOST });
  const coordinator = new Coordinator({ healthIntervalMs: 500 });
  const port = await coordinator.listen(0, '127.0.0.1');
  const keys = await generateKeyPair();
  const { code } = coordinator.core.enrollment.mint({ purpose: 'host' });
  const enrolled = await fetch(`http://127.0.0.1:${port}/api/enroll/host`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, hostId: HOST, publicJwk: keys.publicJwk }),
  });
  assert.equal(enrolled.status, 200);
  const transport = new WebSocketTransport({
    origin: `http://127.0.0.1:${port}`,
    hostId: HOST,
    proof: async () => {
      const { nonce } = await (await fetch(`http://127.0.0.1:${port}/api/host/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostId: HOST }),
      })).json();
      return { nonce, proof: await sign(keys.privateJwk, signingInput('host-connect', { hostId: HOST, nonce })) };
    },
  });
  const sidecar = new Sidecar({
    hub: new HubClient({ baseUrl: stub.baseUrl, readTimeoutMs: 2000 }),
    transport: /** @type {any} */ (transport),
    hostId: HOST,
    // The key this box signs a setup's key with, as its enrolment key does.
    vaultKey: { publicJwk: keys.publicJwk, sign: (/** @type {string} */ m) => sign(keys.privateJwk, m) },
    vaultIntervalMs: 24 * 60 * 60_000,
  });
  await sidecar.start();
  t.after(async () => {
    await sidecar.stop();
    await coordinator.close();
    await stub.close();
  });
  for (let i = 0; i < 200 && !coordinator.registry.schedulable().length; i++) await new Promise((r) => setTimeout(r, 25));
  const issued = /** @type {any} */ (await coordinator.core.issueClient({ email: 'eli@example.com', name: 'Eli' }, 'phone'));
  assert.ok(issued.token, 'an admin phone credential');
  /** @param {string} verb @param {Record<string, unknown>} params */
  const intent = async (verb, params) => (await fetch(`http://127.0.0.1:${port}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({ verb, params }),
  })).json();
  return { port, token: issued.token, intent, coordinator };
}

/**
 * The phone, as both apps carry a relay: a WebSocket to the coordinator, and
 * for each connection the machine asks for, a TCP connection to the address
 * on its own network — here, the name resolved to the stand-in. Everything it
 * carried, both ways, is kept for the search.
 *
 * @param {{ port: number, token: string, address: string, xoPort: number }} opts
 */
function phone({ port, token, address, xoPort }) {
  /** @type {Buffer[]} */
  const carried = [];
  /** The first byte the machine sent on each connection. @type {number[]} */
  const firsts = [];
  /** @type {Map<number, net.Socket>} */
  const sockets = new Map();
  let tcp = 0;
  /** @type {any[]} */
  const said = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/xosetup/relay?address=${encodeURIComponent(address)}`, /** @type {any} */ ({ headers: { authorization: `Bearer ${token}` } }));
  /** @param {Record<string, unknown>} m */
  const send = (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  /** @type {Promise<any>} */
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      said.push(m);
      if (m.op === 'ready') resolve(m);
      if (m.op === 'closed') {
        reject(new Error(m.text));
        for (const s of sockets.values()) s.destroy();
      }
      if (m.op === 'open') {
        tcp += 1;
        const s = net.connect(xoPort, '127.0.0.1');
        sockets.set(m.stream, s);
        s.on('connect', () => send({ op: 'opened', stream: m.stream }));
        s.on('data', (chunk) => {
          carried.push(chunk);
          for (let at = 0; at < chunk.length; at += 48 * 1024) send({ op: 'data', stream: m.stream, data: chunk.subarray(at, at + 48 * 1024).toString('base64') });
        });
        s.on('close', () => {
          if (sockets.delete(m.stream)) send({ op: 'end', stream: m.stream });
        });
        s.on('error', () => {});
      } else if (m.op === 'data') {
        const bytes = Buffer.from(m.data, 'base64');
        if (!sockets.get(m.stream)?.bytesWritten) firsts.push(bytes[0]);
        carried.push(bytes);
        sockets.get(m.stream)?.write(bytes);
      } else if (m.op === 'end') {
        const s = sockets.get(m.stream);
        sockets.delete(m.stream);
        s?.end();
      }
    });
    ws.addEventListener('error', () => reject(new Error('the relay socket failed')));
  });
  ready.catch(() => {});
  return { ready, carried, firsts, said, connections: () => tcp, close: () => ws.close() };
}

/** What the phone sees for itself: the certificate at the address, over its own TLS. @param {number} xoPort */
function ownLook(xoPort) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port: xoPort, servername: NAME, rejectUnauthorized: false }, () => {
      const raw = s.getPeerCertificate()?.raw;
      s.destroy();
      resolve(raw ? createHash('sha256').update(raw).digest('hex') : null);
    });
    s.on('error', reject);
  });
}

test('a pool only the phone reaches is set up through it, and the sign-in crosses it as TLS the machine opened', { skip }, async (t) => {
  const xo = await standIn(t);
  const xoPort = Number(xo.address.split(':')[1]);
  const address = `${NAME}:${xoPort}`;
  const { port, token, intent } = await fleet(t);

  // NO MACHINE REACHES IT, and the coordinator offers the way through the phone.
  const direct = await intent('xoprobe', { address });
  assert.equal(direct.probes?.find((/** @type {any} */ p) => p.hostId === HOST)?.reachable, false, direct.text);
  assert.deepEqual(direct.relay, { hostId: HOST });

  const carrier = phone({ port, token, address, xoPort });
  t.after(() => carrier.close());
  const ready = await carrier.ready;
  assert.equal(ready.hostId, HOST);

  // THE PROBE THROUGH IT sees the certificate the phone sees for itself, which
  // is what the person accepts: a coordinator that answered the machine's TLS
  // in Xen Orchestra's place would show a different one here.
  const through = await intent('xoprobe', { address, relay: ready.relay });
  const seen = through.probes?.[0];
  assert.equal(seen?.through, 'phone', through.text);
  assert.equal(seen?.reachable, true, through.text);
  assert.equal(seen?.xo, true);
  assert.equal(seen?.cert, await ownLook(xoPort));
  assert.equal(seen?.cert, xo.pin);

  // BEGIN, RUN, and the token back, exactly as without a relay.
  const begun = await intent('xosetup', { phase: 'begin', address, pin: seen.cert, trust: 'accepted', relay: ready.relay });
  assert.equal(begun.ok, true, begun.text);
  const { job, key, keySig, hostKey } = begun.xosetup;
  assert.equal(await verify(hostKey, keySig, signingInput('xosetup-key', { address, job, key, pin: seen.cert })), true);
  const reply = await newSealKey();
  const box = await seal({ to: key, aad: xosetupAad(job, address), payload: { v: 1, xo: { email: 'admin@admin.net', password: PASSWORD }, reply: reply.publicKey } });
  const ran = await intent('xosetup', { phase: 'run', job, sealed: `${box.epk}.${box.iv}.${box.ct}` });
  assert.equal(ran.ok, true, ran.text);
  let end = null;
  for (let i = 0; i < 400 && !end; i++) {
    const s = await intent('xosetup', { phase: 'status', job });
    if (s.xosetup && s.xosetup.state !== 'running') end = s.xosetup;
    else await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(end?.state, 'done', end?.text);
  const [epk, iv, ct] = String(end.handoff).split('.');
  const kept = /** @type {any} */ (await open({ ...reply, aad: xosetupHandoffAad(job, address), sealed: { epk, iv, ct } }));
  assert.equal(kept.token, 'tok-limited-123');
  assert.equal(kept.pin, xo.pin);

  // XEN ORCHESTRA HAD THE PASSWORD, so it crossed the relay...
  const signIn = xo.calls.find((c) => c.method === 'session.signIn' && c.params?.email === 'admin@admin.net');
  assert.equal(signIn?.params.password, PASSWORD);
  // ...and every connection it saw was one the phone made...
  assert.equal(carrier.connections(), xo.connections());
  // ...each of them opened by the machine with a TLS handshake record...
  assert.deepEqual(carrier.firsts, Array(carrier.connections()).fill(0x16));
  // ...and in nothing the phone carried, either way, is there a word of it.
  const everything = Buffer.concat(carrier.carried).toString('latin1');
  assert.ok(everything.length > 2000, 'the phone carried the whole setup');
  for (const secret of [PASSWORD, 'admin@admin.net', 'session.signIn', 'tok-limited-123']) {
    assert.ok(!everything.includes(secret), `the relay carried ${secret} in the clear`);
  }

  // THE JOB'S END CLOSED THE RELAY, at the phone.
  for (let i = 0; i < 100 && !carrier.said.some((m) => m.op === 'closed'); i++) await new Promise((r) => setTimeout(r, 20));
  assert.match(carrier.said.find((m) => m.op === 'closed')?.text ?? '', /job using this relay ended/);
});

test('installing Xen Orchestra is refused through a phone, before the phone is asked to connect anywhere', async (t) => {
  // The install is SSH to the pool master and the installer's downloads,
  // which a relay does not carry. The coordinator places the job on the
  // relay's machine as for any begin; the machine says why it will not, and
  // the relay closes because nothing began.
  const address = `${NAME}:443`;
  const { port, token, intent } = await fleet(t);
  const carrier = phone({ port, token, address, xoPort: 1 });
  t.after(() => carrier.close());
  const ready = await carrier.ready;
  const refused = await intent('xosetup', { phase: 'deploy', address, pin: 'a'.repeat(64), relay: ready.relay });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /needs a machine that reaches the pool/);
  assert.equal(carrier.connections(), 0, 'the phone was asked to connect nowhere');
  for (let i = 0; i < 100 && !carrier.said.some((m) => m.op === 'closed'); i++) await new Promise((r) => setTimeout(r, 20));
  assert.match(carrier.said.find((m) => m.op === 'closed')?.text ?? '', /did not begin/);
});

test('a server that is not the one accepted is never sent the sign-in, through the phone as directly', { skip }, async (t) => {
  // The pin holds over a relay because the machine checks it: a probe, or a
  // coordinator, cannot get the machine to talk to a certificate the person
  // did not accept. Here the phone reaches a different TLS server.
  const xo = await standIn(t);
  const other = await standIn(t);
  const otherPort = Number(other.address.split(':')[1]);
  const address = `${NAME}:${otherPort}`;
  const { port, token, intent } = await fleet(t);
  const carrier = phone({ port, token, address, xoPort: otherPort });
  t.after(() => carrier.close());
  const ready = await carrier.ready;
  // The person accepted xo's certificate; the phone's network answers with other's.
  const begun = await intent('xosetup', { phase: 'begin', address, pin: xo.pin, trust: 'accepted', relay: ready.relay });
  assert.equal(begun.ok, true, begun.text);
  const { job, key } = begun.xosetup;
  const reply = await newSealKey();
  const box = await seal({ to: key, aad: xosetupAad(job, address), payload: { v: 1, xo: { email: 'admin@admin.net', password: PASSWORD }, reply: reply.publicKey } });
  await intent('xosetup', { phase: 'run', job, sealed: `${box.epk}.${box.iv}.${box.ct}` });
  let end = null;
  for (let i = 0; i < 400 && !end; i++) {
    const s = await intent('xosetup', { phase: 'status', job });
    if (s.xosetup && s.xosetup.state !== 'running') end = s.xosetup;
    else await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(end?.state, 'failed');
  assert.match(end?.text ?? '', /different certificate from the one you accepted/);
  assert.equal(other.calls.length, 0, 'the other server heard nothing');
});
