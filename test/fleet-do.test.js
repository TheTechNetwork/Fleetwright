// The Durable Object's own routes.
//
// CoordinatorCore is shared verbatim with the Node coordinator and is tested to
// death elsewhere. What is NOT shared is this file's routing: which routes
// exist, what authenticates them, what is written to storage and when. That is
// duplicated between the two coordinators by necessity, and duplicated logic is
// logic that will eventually be two different logics — the apps talk to the
// Worker, so a divergence here is invisible until somebody is holding a phone.
//
// A DO does not need workerd to be exercised: `state` is an interface, and the
// enrolment routes touch storage and nothing Cloudflare-specific.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Fleet } from '../worker/src/fleet-do.js';
import { loadOrCreateKey, keyFingerprint } from '../src/fleet/host/identity.js';
import { sign, signingInput, generateKeyPair } from '../src/fleet/crypto.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The parts of DurableObjectState these routes actually use. */
function fakeState() {
  /** @type {Map<string, any>} */
  const storage = new Map();
  return {
    writes: 0,
    storage: {
      get: async (/** @type {string} */ k) => storage.get(k),
      put: async (/** @type {string} */ k, /** @type {any} */ v) => {
        storage.set(k, JSON.parse(JSON.stringify(v)));
      },
    },
    // Synchronous here: the real one defers the object's first request until
    // the callback settles, and awaiting it in the constructor is the closest
    // equivalent a test can get.
    blockConcurrencyWhile: (/** @type {() => Promise<any>} */ fn) => fn(),
    /** @type {() => any[]} */
    getWebSockets: () => [],
    /** @type {undefined | ((s: any) => string[])} */
    getTags: undefined,
    setAlarm: () => {},
    raw: storage,
  };
}

function fleet(env = {}) {
  const state = fakeState();
  return { fleet: new Fleet(/** @type {any} */ (state), env), state };
}

/** @param {Fleet} f */
const call = (f, path, method = 'GET', body = null, headers = {}) =>
  f.fetch(
    new Request(`https://fleet.example${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === null ? undefined : JSON.stringify(body),
    }),
  );

function scratch() {
  return path.join(mkdtempSync(path.join(tmpdir(), 'do-key-')), 'host-key.json');
}

test('a pin enrols a host, and the keys are written to storage', async () => {
  const { fleet: f, state } = fleet();
  const key = await loadOrCreateKey(scratch());
  const { code } = f.core.enrollment.mint({ purpose: 'host' });

  const res = await call(f, '/api/enroll/host', 'POST', {
    code,
    hostId: 'durable',
    publicJwk: key.publicJwk,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.fingerprint, await keyFingerprint(key.publicJwk));

  // Storage, not memory. A Durable Object is evicted between messages, and an
  // enrolment that lived only in memory would be an enrolment that vanished
  // the first time the fleet went quiet.
  assert.equal(state.raw.get('hostIds').length, 1);
  assert.equal(state.raw.get('hostIds')[0].hostId, 'durable');
  assert.equal(state.raw.get('hostIds')[0].publicJwk.d, undefined, 'no private key is ever stored');
});

test('a spent pin does not come back after an eviction', async () => {
  const { fleet: f, state } = fleet();
  const { code } = f.core.enrollment.mint({ purpose: 'host' });
  await call(f, '/api/enroll/host', 'POST', {
    code,
    hostId: 'first',
    publicJwk: (await generateKeyPair()).publicJwk,
  });

  // Rebuild from the same storage, which is what waking up is.
  const revived = new Fleet(/** @type {any} */ (state), {});
  const again = await call(revived, '/api/enroll/host', 'POST', {
    code,
    hostId: 'second',
    publicJwk: (await generateKeyPair()).publicJwk,
  });
  assert.equal(again.status, 403);
  assert.equal(revived.core.hostIds.list().length, 1, 'the first host survived; the pin did not');
});

test('the challenge/proof pair is the same one the Node coordinator makes', async () => {
  const { fleet: f } = fleet();
  const key = await loadOrCreateKey(scratch());
  const { code } = f.core.enrollment.mint({ purpose: 'host' });
  await call(f, '/api/enroll/host', 'POST', { code, hostId: 'proving', publicJwk: key.publicJwk });

  const { nonce } = await (await call(f, '/api/host/challenge', 'POST', { hostId: 'proving' })).json();
  const proof = await sign(key.privateJwk, signingInput('host-connect', { hostId: 'proving', nonce }));

  assert.equal((await call(f, '/api/host/verify', 'POST', { hostId: 'proving', nonce, proof })).status, 200);
  // Spent. This is the property the whole handshake rests on.
  assert.equal((await call(f, '/api/host/verify', 'POST', { hostId: 'proving', nonce, proof })).status, 401);
});

test('a revoked host is told it was revoked, not that it is a stranger', async () => {
  const { fleet: f } = fleet();
  const key = await loadOrCreateKey(scratch());
  const { code } = f.core.enrollment.mint({ purpose: 'host' });
  await call(f, '/api/enroll/host', 'POST', { code, hostId: 'condemned', publicJwk: key.publicJwk });

  assert.equal((await call(f, '/api/hosts/condemned', 'DELETE')).status, 200);

  const { nonce } = await (await call(f, '/api/host/challenge', 'POST', { hostId: 'condemned' })).json();
  const proof = await sign(key.privateJwk, signingInput('host-connect', { hostId: 'condemned', nonce }));
  const refused = await call(f, '/api/host/verify', 'POST', { hostId: 'condemned', nonce, proof });
  assert.equal(refused.status, 401);
  // Different actions: one sends you to enrol the box, the other tells you
  // somebody removed it on purpose.
  assert.match((await refused.json()).text, /revoked/);
});

test('a revoked device credential is refused rather than falling through', async () => {
  const { fleet: f } = fleet();
  const { token, client } = await f.core.clients.issue('a phone (someone@example.com)');

  assert.equal((await call(f, '/api/hosts', 'GET', null, { authorization: `Bearer ${token}` })).status, 200);
  f.core.clients.revoke(client.id);
  const after = await call(f, '/api/hosts', 'GET', null, { authorization: `Bearer ${token}` });
  assert.equal(after.status, 401);
});

test('minting a pin records who it was for', async () => {
  const { fleet: f, state } = fleet();
  const { token } = await f.core.clients.issue('a phone (someone@example.com)');
  f.core.clients.clients.values().next().value.email = 'someone@example.com';

  const res = await call(f, '/api/enroll', 'POST', { kind: 'host' }, { authorization: `Bearer ${token}` });
  const body = await res.json();
  assert.match(body.code, /^\d{6}$/);
  assert.equal(state.raw.get('enrollment').length, 1);

  const events = f.core.snapshot().events;
  const minted = events.find((/** @type {any} */ e) => e.event === 'enrol.minted');
  assert.match(minted.text, /someone@example.com/);
});

test('sign-in is refused clearly when the coordinator has none configured', async () => {
  const { fleet: f } = fleet();
  const res = await call(f, '/api/session', 'POST', { idToken: 'anything' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).text, /no sign-in configured/);
});

test('re-enrolling a name disconnects whoever held the old key', async () => {
  const { fleet: f, state } = fleet();
  const first = await generateKeyPair();
  const { code } = f.core.enrollment.mint({ purpose: 'host' });
  await call(f, '/api/enroll/host', 'POST', { code, hostId: 'rebuilt', publicJwk: first.publicJwk });

  // Stand in for the machine that is still connected on that name. The DO finds
  // the host id from the socket's tags, which is how it survives hibernation.
  /** @type {any[]} */
  const closed = [];
  const socket = { close: (/** @type {number} */ c, /** @type {string} */ r) => closed.push([c, r]) };
  state.getWebSockets = () => [socket];
  state.getTags = () => ['rebuilt'];

  const second = await generateKeyPair();
  const { code: code2 } = f.core.enrollment.mint({ purpose: 'host' });
  const res = await call(f, '/api/enroll/host', 'POST', { code: code2, hostId: 'rebuilt', publicJwk: second.publicJwk });
  assert.equal((await res.json()).replaced, true);

  // Two machines as one host is the worst shape this can take: the old one
  // keeps answering intents addressed to a name whose key it no longer holds,
  // and which of them a `resume` lands on is whichever the registry saw last.
  assert.deepEqual(closed, [[1008, 're-enrolled']]);

  // And the old key no longer proves anything.
  const { nonce } = await (await call(f, '/api/host/challenge', 'POST', { hostId: 'rebuilt' })).json();
  const stale = await sign(first.privateJwk, signingInput('host-connect', { hostId: 'rebuilt', nonce }));
  assert.equal((await call(f, '/api/host/verify', 'POST', { hostId: 'rebuilt', nonce, proof: stale })).status, 401);

  const fresh = await sign(second.privateJwk, signingInput('host-connect', { hostId: 'rebuilt', nonce }));
  assert.equal((await call(f, '/api/host/verify', 'POST', { hostId: 'rebuilt', nonce, proof: fresh })).status, 200);
});
