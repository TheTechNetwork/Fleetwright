// The host socket leg, executed against BOTH coordinators.
//
// WHY THIS FILE EXISTS. There are two coordinators and they are required to
// behave identically — `openapi.test.js` proves that for the HTTP leg by
// EXECUTING the spec against both, and five parity bugs reached a branch before
// it existed. The socket leg had no such contract. The Worker's is proven in
// workerd (`live.test.js`) and the Node coordinator's in Node
// (`test/coordinator.test.js`), but nothing drove one script through both and
// asserted the answers matched — which is exactly the gap the Aug-28 outage
// lived in, where the Worker's socket handler diverged from what Node's tests
// covered.
//
// So this is the ws analogue of the executed OpenAPI spec. It boots the real
// Worker under workerd AND a real Node coordinator, and drives each with the
// SAME host client — `identity.js` and `ws.js`, the code a real sidecar ships —
// because the enrol / challenge / connect routes are identical on both by
// design. A behaviour that is true of one coordinator and not the other fails
// here instead of on somebody's phone.
//
// The host client being literally the same object for both halves is not a
// convenience — it is the point. If a real host can drive both coordinators
// through one code path, the two are the transport swap the design claims, and
// if it cannot, that is the parity bug.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { enrol, proveIdentity } from '../../src/fleet/host/identity.js';
import { connectWebSocket } from '../../src/fleet/ws.js';
import { Coordinator } from '../../src/fleet/coordinator/server.js';
import { PROTOCOL_VERSION } from '../../src/fleet/protocol/intents.js';

const requireWorker = createRequire(new URL('../package.json', import.meta.url));

const ADMIN = 'parity-test-admin-token-0123456789';

/** @type {{ name: string, origin: string, stop: () => Promise<void> }[]} */
let coordinators = [];

before(async () => {
  // The Worker, in the runtime it ships to. Same boot as live.test.js: a fresh
  // DO state so a host enrolled by a previous run is not still enrolled.
  const { rm } = await import('node:fs/promises');
  await rm(new URL('../.wrangler/state', import.meta.url), { recursive: true, force: true });

  const { unstable_dev } = await import(requireWorker.resolve('wrangler'));
  const worker = await unstable_dev(new URL('../src/worker.js', import.meta.url).pathname, {
    config: new URL('../wrangler.toml', import.meta.url).pathname,
    local: true,
    logLevel: 'error',
    vars: { AGENT_FLEET_API_TOKEN: ADMIN },
    experimental: { disableExperimentalWarning: true },
  });

  // The Node coordinator, in process — the same class openapi.test.js boots,
  // with the same admin token so one host client can mint against either.
  const node = new Coordinator({ apiToken: ADMIN });
  const port = await node.listen(0, '127.0.0.1');

  coordinators = [
    { name: 'worker', origin: `http://${worker.address}:${worker.port}`, stop: () => worker.stop() },
    { name: 'node', origin: `http://127.0.0.1:${port}`, stop: async () => { await node.close(); } },
  ];
});

after(async () => {
  for (const c of coordinators) await c.stop().catch(() => {});
});

/** Admin headers for the HTTP leg. `/healthz` is the one route that needs none. */
const auth = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };

/**
 * A real host against either coordinator: mint a pin over the admin API, spend
 * it, prove the key, open the socket, and volunteer health the way the sidecar
 * does on connect. Identical for both origins because the routes are.
 *
 * @param {string} origin
 * @param {string} hostId
 */
async function connectHost(origin, hostId) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

  const minted = await fetch(`${origin}/api/enroll`, { method: 'POST', headers: auth, body: '{}' }).then((r) => r.json());
  assert.ok(minted.code, `no pin minted on ${origin}: ${JSON.stringify(minted)}`);

  await enrol({ origin, code: minted.code, hostId, publicJwk });
  const { nonce, proof } = await proveIdentity({ origin, hostId, privateJwk });

  const ws = await connectWebSocket(`${origin.replace('http', 'ws')}/host/connect?hostId=${hostId}`, {
    headers: { 'x-fleet-nonce': nonce, 'x-fleet-proof': proof },
  });

  // The health frame that makes a host schedulable — no `protocol`, no
  // `claudeAccounts: 0`, no expired credential, so the shared registry ladder
  // lands it on `healthy`. The one place a divergence would show is if one
  // coordinator read this frame differently, which is what scenario 1 checks.
  ws.send(JSON.stringify({
    kind: 'health',
    hostId,
    health: { hostId, labels: [], hub: { reachable: true, host: hostId }, maxSessions: 5, running: 0, free: 5, resumable: [], sessions: [] },
  }));
  return ws;
}

/** Poll `/api/hosts` until `hostId` reaches `state`, or give up. */
async function waitForState(origin, hostId, state, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const body = await fetch(`${origin}/api/hosts`, { headers: auth }).then((r) => r.json());
    const host = (body.hosts || []).find((/** @type {any} */ h) => h.hostId === hostId);
    if (host?.state === state) return host;
    await new Promise((r) => setTimeout(r, 50));
  }
  const body = await fetch(`${origin}/api/hosts`, { headers: auth }).then((r) => r.json());
  return (body.hosts || []).find((/** @type {any} */ h) => h.hostId === hostId) || null;
}

// Each scenario runs the SAME steps against both coordinators and asserts the
// SAME observable result. `for (const c of coordinators)` inside one test keeps
// the two halves visibly one contract rather than two tests that happen to look
// alike and could drift apart.

test('a host connects and a health frame makes it schedulable, the same on both', async () => {
  for (const c of coordinators) {
    const ws = await connectHost(c.origin, 'parity-connect');
    try {
      const host = await waitForState(c.origin, 'parity-connect', 'healthy');
      assert.ok(host, `[${c.name}] the connected host is absent from /api/hosts`);
      assert.equal(host.connected, true, `[${c.name}] a connected host must report connected`);
      assert.equal(host.state, 'healthy', `[${c.name}] a host that reported clean health must be healthy`);
    } finally {
      ws.close();
    }
  }
});

test('an intent round-trips phone → host → reply with the host id attached, the same on both', async () => {
  for (const c of coordinators) {
    const ws = await connectHost(c.origin, 'parity-intent');
    /** @type {any[]} */
    const seen = [];
    // Answer every intent so the coordinator's own health ask (Node sends one
    // on connect) does not sit unanswered; the assertion looks only at `start`.
    ws.on('message', (text) => {
      const intent = JSON.parse(String(text));
      if (intent.kind !== 'intent') return;
      seen.push(intent);
      ws.send(JSON.stringify({ v: intent.v, kind: 'reply', id: intent.id, ok: true, text: `handled ${intent.verb}`, sessions: [] }));
    });

    try {
      await waitForState(c.origin, 'parity-intent', 'healthy');
      const reply = await fetch(`${c.origin}/api/intent`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ verb: 'start', params: { title: 'a job' }, host: 'parity-intent', id: 'parity-intent-0001' }),
      }).then((r) => r.json());

      assert.equal(reply.ok, true, `[${c.name}] ${JSON.stringify(reply).slice(0, 160)}`);
      assert.match(reply.text, /handled start/, `[${c.name}] the host's reply text must come back`);
      assert.equal(reply.hostId, 'parity-intent', `[${c.name}] the reply must name the host that answered`);

      const start = seen.find((i) => i.verb === 'start');
      assert.ok(start, `[${c.name}] the start intent never crossed the wire`);
      assert.equal(start.kind, 'intent', `[${c.name}] a host frame must be an intent`);
      assert.equal(start.id, 'parity-intent-0001', `[${c.name}] the idempotency key must be the caller's, not a fresh one`);
      assert.equal(start.params.host, undefined, `[${c.name}] the host preference must never leak into the intent`);
      assert.equal(start.v, PROTOCOL_VERSION, `[${c.name}] the intent must carry this build's protocol version`);
    } finally {
      ws.close();
    }
  }
});

test('a garbage frame does not drop the socket, and the coordinator still answers, the same on both', async () => {
  for (const c of coordinators) {
    const ws = await connectHost(c.origin, 'parity-garbage');
    let closed = null;
    ws.on('close', (code, reason) => { closed = `${code} ${reason}`; });
    try {
      ws.send('not json at all {{{');
      ws.send(JSON.stringify({ kind: 'reply' }));
      ws.send(JSON.stringify({ kind: 'reply', id: 'nobody-waits-for-this' }));
      ws.send(JSON.stringify({ kind: 'no-such-kind', id: 'x'.repeat(32) }));
      await new Promise((r) => setTimeout(r, 500));

      assert.equal(closed, null, `[${c.name}] garbage from a host reset its socket: ${closed}`);
      const health = await fetch(`${c.origin}/healthz`).then((r) => r.json());
      assert.equal(health.ok, true, `[${c.name}] the coordinator stopped answering after garbage`);
    } finally {
      ws.close();
    }
  }
});

test('an unenrolled host is refused the upgrade with a reason, the same on both', async () => {
  for (const c of coordinators) {
    // A real signature over a real challenge, made by a key that was never
    // enrolled — the interesting impostor, not a missing header. The challenge
    // route hands one to anyone; only the signature check refuses.
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const { nonce, proof } = await proveIdentity({ origin: c.origin, hostId: 'parity-impostor', privateJwk });

    let refused = null;
    try {
      const ws = await connectWebSocket(`${c.origin.replace('http', 'ws')}/host/connect?hostId=parity-impostor`, {
        headers: { 'x-fleet-nonce': nonce, 'x-fleet-proof': proof },
      });
      ws.close();
    } catch (e) {
      refused = /** @type {Error} */ (e).message;
    }

    assert.ok(refused, `[${c.name}] an unenrolled host was NOT refused the socket`);
    // The refusal is a refusal on both. The reason phrasing comes from the
    // shared core (`hostIds.prove`), so where a body survives the transport it
    // says the same thing — but the contract both must keep is that the upgrade
    // does not complete.
    assert.match(refused, /refused|enrolled|401|Unauthorized/i, `[${c.name}] the refusal gave no legible reason: ${refused}`);

    // And it left nothing behind: the impostor is not in the fleet.
    const body = await fetch(`${c.origin}/api/hosts`, { headers: auth }).then((r) => r.json());
    assert.ok(
      !(body.hosts || []).some((/** @type {any} */ h) => h.hostId === 'parity-impostor'),
      `[${c.name}] a refused host entered the registry`,
    );
  }
});

test('/healthz reports this build’s protocol version on both', async () => {
  for (const c of coordinators) {
    const health = await fetch(`${c.origin}/healthz`).then((r) => r.json());
    assert.equal(health.protocol, PROTOCOL_VERSION, `[${c.name}] /healthz must report the running protocol version`);
    assert.deepEqual(Object.keys(health).sort(), ['ok', 'protocol'], `[${c.name}] /healthz must leak nothing beyond {ok, protocol}`);
  }
});
