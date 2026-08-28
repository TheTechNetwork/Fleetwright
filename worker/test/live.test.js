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

const requireWorker = createRequire(new URL('../package.json', import.meta.url));

// The project's own WebSocket client — the one the sidecar ships with. Not the
// `ws` package: that resolved on the machine this was written on from a Debian
// SYSTEM package (/usr/share/nodejs/ws), passed every local run, and then
// failed on CI with MODULE_NOT_FOUND — a dependency that was never declared
// anywhere and worked by coincidence. Using the in-repo client also means the
// handshake below exercises the exact frames a real host sends.
import { connectWebSocket } from '../../src/fleet/ws.js';

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

  const ws = await connectWebSocket(`${origin.replace('http', 'ws')}/host/connect?hostId=${hostId}`, {
    headers: { 'x-fleet-nonce': nonce, 'x-fleet-proof': proof },
  });

  // Volunteer health, as the real sidecar does on connect. Load-bearing, and
  // the first draft of the round-trip test proved it by omission: the
  // scheduler refuses to place work on a host with no health report —
  // "unknown (connected, no health report yet)" — so a connected-but-silent
  // host is reachable for reads and unplaceable for work. Which is correct,
  // and is itself worth having pinned by a test that had to learn it.
  ws.send(JSON.stringify({
    kind: 'health',
    hostId,
    health: {
      hostId,
      labels: [],
      hub: { reachable: true, host: hostId },
      maxSessions: 5,
      running: 0,
      free: 5,
      resumable: [],
      sessions: [],
    },
  }));
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


test('an intent round-trips: phone in, host out, reply back', async () => {
  // The whole outage, as a test. The app POSTs an intent, the DO validates and
  // places it, the frame crosses the real WebSocket, the host answers, and the
  // reply comes back to the caller with the hostId attached. Tonight this path
  // died in the middle — the app saw "network connection was lost" and the
  // host saw ECONNRESET — and nothing in CI walked it end to end.
  const ws = await connectHost('roundtrip-box');
  let closed = null;
  ws.on('close', (code, reason) => { closed = `${code} ${reason}`; });

  // The fake host answers like the sidecar does: echo the id, claim success.
  const seen = [];
  ws.on('message', (text) => {
    const intent = JSON.parse(text);
    seen.push(intent);
    ws.send(JSON.stringify({
      v: intent.v,
      kind: 'reply',
      id: intent.id,
      ok: true,
      text: `handled ${intent.verb}`,
      sessions: [],
    }));
  });

  const reply = await fetch(`${origin}/api/intent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      verb: 'start',
      // The v2 fields, through the REAL coordinator. The protocol bump exists
      // for these; if the DO builds a v1 intent or drops the params, this is
      // where it shows.
      params: { title: 'refactor auth', brief: 'split the token check out' },
      id: 'live-roundtrip-0001',
    }),
  }).then((r) => r.json());

  assert.equal(reply.ok, true, JSON.stringify(reply).slice(0, 200));
  assert.match(reply.text, /handled start/);
  assert.equal(reply.hostId, 'roundtrip-box');

  // What actually crossed the wire to the host.
  assert.equal(seen.length, 1);
  const intent = seen[0];
  assert.equal(intent.kind, 'intent');
  assert.equal(intent.verb, 'start');
  assert.equal(intent.id, 'live-roundtrip-0001', 'the idempotency key must be the caller\'s, not a fresh one');
  assert.equal(intent.params.title, 'refactor auth');
  assert.equal(intent.params.brief, 'split the token check out');
  // The version the DO sends is the version this build speaks — a literal here
  // is the healthz bug on the write path.
  const { PROTOCOL_VERSION } = await import('../../src/fleet/protocol/intents.js');
  assert.equal(intent.v, PROTOCOL_VERSION);

  assert.equal(closed, null, `the socket died during the round trip: ${closed}`);
  ws.close();
});

test('a host that answers with garbage does not take the object down', async () => {
  // The reply path is the DO parsing bytes a remote machine chose. Tonight
  // proved what one uncaught throw in that position costs, so the hostile
  // shapes get sent from a REAL socket: non-JSON, a reply with no id, a reply
  // for an id nobody is waiting on, and a frame of a kind that does not exist.
  const ws = await connectHost('garbage-box');
  let closed = null;
  ws.on('close', (code, reason) => { closed = `${code} ${reason}`; });

  ws.send('not json at all {{{');
  ws.send(JSON.stringify({ kind: 'reply' }));
  ws.send(JSON.stringify({ kind: 'reply', id: 'nobody-waits-for-this-1' }));
  ws.send(JSON.stringify({ kind: 'no-such-kind', id: 'x'.repeat(64) }));
  await new Promise((r) => setTimeout(r, 600));

  assert.equal(closed, null, `garbage from a host reset its socket: ${closed}`);

  // And the coordinator still coordinates.
  const health = await fetch(`${origin}/healthz`).then((r) => r.json());
  assert.equal(health.ok, true);
  ws.close();
});


test('one mute host does not stall the fleet for everyone', async () => {
  // The question that unravelled the outage, asked by the person watching it:
  // "is it possible that if not all hosts are reachable the app breaks?" Yes —
  // the fan-out waited the FULL intent timeout (60s here) for every host under
  // Promise.all, so one connected-but-mute socket made every /list take a
  // minute, and every phone gave up first. One member refusing to answer a
  // question priced the whole fleet.
  const talker = await connectHost('talker-box');
  const mute = await connectHost('mute-box');
  let muteClosed = null;
  mute.on('close', (code, reason) => { muteClosed = `${code} ${reason}`; });

  talker.on('message', (text) => {
    const intent = JSON.parse(String(text));
    if (intent.kind !== 'intent') return;
    talker.send(JSON.stringify({
      v: intent.v, kind: 'reply', id: intent.id, ok: true,
      text: 'talker answered', sessions: [{ name: 'from-the-talker', status: 'running' }],
    }));
  });
  // The mute host receives and says nothing, exactly like a half-open socket
  // from a reconnect storm — or the first probe run against production, which
  // demonstrated this failure by accident on a real fleet.

  const started = Date.now();
  const reply = await fetch(`${origin}/api/intent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'list', params: {}, id: 'live-fanout-mute-001' }),
  }).then((r) => r.json());
  const elapsed = Date.now() - started;

  // The healthy host's answer arrives, attributed; the mute one degrades ITS
  // OWN entry; and the whole thing costs the fan-out deadline, not the intent
  // timeout. 15s of headroom over the 10s deadline, far under the old 60s.
  assert.equal(reply.ok, true, JSON.stringify(reply).slice(0, 200));
  assert.ok(elapsed < 15_000, `fan-out took ${elapsed}ms — the mute host set the price again`);
  assert.ok(reply.sessions.some((s) => s.name === 'from-the-talker' && s.hostId === 'talker-box'));
  const muteResult = reply.hosts.find((h) => h.hostId === 'mute-box');
  assert.ok(muteResult, `mute-box missing from fan-out: ${JSON.stringify(reply.hosts)}`);
  assert.equal(muteResult.ok, false);
  assert.equal(muteResult.error?.code, 'host_timeout');

  assert.equal(muteClosed, null, 'being slow must not get a host disconnected — only ignored');
  talker.close();
  mute.close();
});


test('a start with a chosen host lands on that host', async () => {
  // End to end through the real runtime: the app names a host beside the
  // intent, the DO places on exactly that host, and the intent that crosses
  // the wire carries NO host parameter -- a host would refuse one, since
  // `start` does not declare it.
  const chosen = await connectHost('chosen-box');
  const other = await connectHost('other-box');
  const arrived = { chosen: [], other: [] };
  const answer = (ws, bucket) => (text) => {
    const intent = JSON.parse(String(text));
    if (intent.kind !== 'intent') return;
    bucket.push(intent);
    ws.send(JSON.stringify({ v: intent.v, kind: 'reply', id: intent.id, ok: true, text: 'started here' }));
  };
  chosen.on('message', answer(chosen, arrived.chosen));
  other.on('message', answer(other, arrived.other));

  const reply = await fetch(`${origin}/api/intent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'start', params: {}, host: 'chosen-box', id: 'live-pick-0001' }),
  }).then((r) => r.json());

  assert.equal(reply.ok, true, JSON.stringify(reply).slice(0, 160));
  assert.equal(arrived.chosen.length, 1, 'the chosen host got the work');
  assert.equal(arrived.other.length, 0, 'the other host got none of it');
  assert.equal(arrived.chosen[0].params.host, undefined, 'the preference must never leak into the intent');

  const refused = await fetch(`${origin}/api/intent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'start', params: {}, host: 'no-such-box', id: 'live-pick-0002' }),
  }).then((r) => r.json());
  assert.equal(refused.ok, false);
  assert.match(refused.text, /not a host this fleet knows/);

  chosen.close();
  other.close();
});

test('healthz reports the protocol version of the code that is running', async () => {
  // Asserted here as well as in the source grep, because this is the REAL
  // runtime answering — the hardcoded 1 this catches was live for two days
  // and pointed an outage investigation at the one thing that was not wrong.
  const { PROTOCOL_VERSION } = await import('../../src/fleet/protocol/intents.js');
  const health = await fetch(`${origin}/healthz`).then((r) => r.json());
  assert.equal(health.protocol, PROTOCOL_VERSION);
});
