// The Worker, running in workerd — the runtime it actually ships to.
//
// WHY THIS FILE EXISTS. The fleet went down because the event ring outgrew
// Durable Object storage's 128KiB value limit, the failed put was an unhandled
// rejection, and an unhandled rejection ABORTS THE OBJECT — every host socket
// reset, every phone request died. No test could have seen it coming, because
// no test ran the Worker in its own runtime: CoordinatorCore was tested in
// Node, where storage has no limits and a floating rejection kills nothing.
// verify.sh checked that the Worker *bundles*. The bug lived entirely in the
// gap between those two.
//
// So this boots the real worker.js under workerd via wrangler's unstable_dev,
// enrols a real host with the host's own identity code, opens the real
// WebSocket, and floods the event ring with maximum-size events. The assertion
// is the one that was false in production: the socket stays up and the
// coordinator keeps answering.
//
// AN HONEST LIMIT, found by reverting the fix and watching this pass anyway:
// local workerd does NOT enforce the production 128KiB storage-value limit, so
// this flood cannot reproduce that exact abort. The size contract is pinned by
// test/event-ring-size.test.js at the root, and the .catch on the persist
// makes even an unenforced limit non-fatal. What THIS file guards is the layer
// nothing else executes at all: the routes, the enrolment pin flow, the signed
// handshake, the upgrade, and a socket that survives real traffic — it caught
// the hardcoded healthz protocol within a minute of first running.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { enrol, proveIdentity } from '../../src/fleet/host/identity.js';

const requireRoot = createRequire(new URL('../../package.json', import.meta.url));
const requireWorker = createRequire(new URL('../package.json', import.meta.url));
const { WebSocket } = requireRoot('ws');

const ADMIN = 'live-test-admin-token-0123456789';
let worker;
let origin;

before(async () => {
  // Fresh state every run. workerd persists DO storage under .wrangler/state,
  // so a host enrolled by the previous run is still enrolled in this one — and
  // the enrolment code correctly refuses to replace a key with a pin minted
  // for adding a new box.
  const { rm } = await import('node:fs/promises');
  await rm(new URL('../.wrangler/state', import.meta.url), { recursive: true, force: true });

  const { unstable_dev } = await import(requireWorker.resolve('wrangler'));
  worker = await unstable_dev(new URL('../src/worker.js', import.meta.url).pathname, {
    config: new URL('../wrangler.toml', import.meta.url).pathname,
    local: true,
    logLevel: 'error',
    vars: { AGENT_FLEET_API_TOKEN: ADMIN },
    experimental: { disableExperimentalWarning: true },
  });
  origin = `http://${worker.address}:${worker.port}`;
});

after(async () => {
  await worker?.stop();
});

/** A real host: generate a key, spend a pin, prove, connect. */
async function connectHost(hostId) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

  const minted = await fetch(`${origin}/api/enroll`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}` },
  }).then((r) => r.json());
  assert.ok(minted.code, `no pin minted: ${JSON.stringify(minted)}`);

  await enrol({ origin, code: minted.code, hostId, publicJwk });
  const { nonce, proof } = await proveIdentity({ origin, hostId, privateJwk });

  const ws = new WebSocket(`${origin.replace('http', 'ws')}/host/connect?hostId=${hostId}`, {
    headers: { 'x-fleet-nonce': nonce, 'x-fleet-proof': proof },
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

test('flooding the event ring does not take down the fleet', async () => {
  const ws = await connectHost('live-box');

  let closed = null;
  ws.on('close', (code, reason) => { closed = `${code} ${reason}`; });

  // 220 events at the maximum the coordinator accepts: 500 chars of text and
  // ~500 of url. Serialised, this is roughly double the 128KiB DO storage
  // limit — the exact overflow that aborted the object in production.
  for (let i = 0; i < 220; i++) {
    ws.send(JSON.stringify({
      kind: 'event',
      event: 'session.ended',
      name: `session-${i}`,
      text: 'x'.repeat(500),
      url: `https://example.com/${'y'.repeat(470)}`,
    }));
  }
  // Let workerd drain the frames and run the coalesced persist.
  await new Promise((r) => setTimeout(r, 1500));

  assert.equal(closed, null, `the host socket was reset: ${closed} — the object aborted`);

  // And the coordinator is still a coordinator: it answers, and the host that
  // delivered the flood is still listed as connected.
  const snap = await fetch(`${origin}/api/hosts`, {
    headers: { authorization: `Bearer ${ADMIN}` },
  }).then((r) => r.json());
  assert.equal(snap.ok, true);
  assert.ok(Array.isArray(snap.events), 'events survived');

  // One more frame round-trips, so the socket is live rather than half-dead.
  ws.send(JSON.stringify({ kind: 'event', event: 'session.ended', name: 'after-the-flood', text: 'still here' }));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(closed, null, 'the socket died on the frame after the flood');

  ws.close();
});

test('healthz reports the protocol version of the code that is running', async () => {
  // Asserted here as well as in the source grep, because this is the REAL
  // runtime answering — the hardcoded 1 this catches was live for two days
  // and pointed an outage investigation at the one thing that was not wrong.
  const { PROTOCOL_VERSION } = await import('../../src/fleet/protocol/intents.js');
  const health = await fetch(`${origin}/healthz`).then((r) => r.json());
  assert.equal(health.protocol, PROTOCOL_VERSION);
});
