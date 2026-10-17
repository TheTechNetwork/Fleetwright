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
import { HEARTBEAT_PING, HEARTBEAT_PONG } from '../src/fleet/protocol/heartbeat.js';
import { loadOrCreateKey, keyFingerprint } from '../src/fleet/host/identity.js';
import { sign, signingInput, generateKeyPair } from '../src/fleet/crypto.js';
import { admit } from './helpers/enrolled-hosts.js';
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

  // Recorded AS the actor, not only in the text: a member is shown every event
  // with no actor as fleet topology, so a name in the text alone reached all
  // of them. The minter still sees it; somebody else does not.
  assert.equal(minted.actor, 'someone@example.com');
  assert.ok(f.core.recentEvents({ email: 'someone@example.com', admin: false }).some((/** @type {any} */ e) => e.event === 'enrol.minted'));
  assert.ok(!f.core.recentEvents({ email: 'other@example.com', admin: false }).some((/** @type {any} */ e) => e.event === 'enrol.minted'));
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
  // Bound to that name, because replacing the key of a machine that already
  // exists is exactly what an unbound pin is no longer allowed to do.
  const { code: code2 } = f.core.enrollment.mint({ purpose: 'host', hostId: 'rebuilt' });
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

test('a colleague cannot revoke machines on the Worker either', async () => {
  // The Node coordinator had this guard placed after the route it guards, so it
  // never fired. The Worker had the identical bug, and the tests did not catch
  // it — because they only exercised the Node one. That is the parity failure
  // this branch keeps rediscovering, so: both, here.
  const { fleet: f } = fleet();
  const admin = await f.core.clients.issue('first phone (eli@thetech.network)', { admin: true });
  const colleague = await f.core.clients.issue('their phone (colleague@thetech.network)');

  const { code } = f.core.enrollment.mint({ purpose: 'host' });
  await call(f, '/api/enroll/host', 'POST', { code, hostId: 'build-server', publicJwk: (await generateKeyPair()).publicJwk });

  const refused = await call(f, '/api/hosts/build-server', 'DELETE', null, { authorization: `Bearer ${colleague.token}` });
  assert.equal(refused.status, 403);
  assert.equal(f.core.hostIds.list().find((h) => h.hostId === 'build-server')?.revokedAt, null, 'still enrolled');

  const allowed = await call(f, '/api/hosts/build-server', 'DELETE', null, { authorization: `Bearer ${admin.token}` });
  assert.equal(allowed.status, 200);
});

test('an admin viewing as a member is refused like one on the Worker too, and only for that request', async () => {
  // The same rule as the Node coordinator (identity.test.js), on the
  // coordinator that is actually deployed.
  const { fleet: f } = fleet();
  const admin = await f.core.clients.issue('first phone (eli@thetech.network)', { admin: true });
  const { code } = f.core.enrollment.mint({ purpose: 'host' });
  await call(f, '/api/enroll/host', 'POST', { code, hostId: 'build-server', publicJwk: (await generateKeyPair()).publicJwk });
  const asMember = { authorization: `Bearer ${admin.token}`, 'x-fleetwright-view': 'member' };

  const me = /** @type {any} */ (await (await call(f, '/api/me', 'GET', null, asMember)).json());
  assert.equal(me.admin, true, 'the real role, so the app can offer the way back');
  assert.equal(me.viewing, 'member');
  assert.equal((await call(f, '/api/hosts/build-server', 'DELETE', null, asMember)).status, 403);
  assert.equal(f.core.hostIds.list().find((h) => h.hostId === 'build-server')?.revokedAt, null, 'still enrolled');

  const allowed = await call(f, '/api/hosts/build-server', 'DELETE', null, { authorization: `Bearer ${admin.token}` });
  assert.equal(allowed.status, 200, 'the next request without it is an admin\u2019s again');
});

test('the Worker refuses to unregister somebody else’s phone, in the same words as the Node coordinator', async () => {
  const { fleet: f } = fleet({ FLEETWRIGHT_API_TOKEN: 'a-token-at-least-16ch' });
  const alice = await f.core.clients.issue('alice phone');
  alice.client.email = 'alice@example.com';
  const bob = await f.core.clients.issue('bob phone');
  bob.client.email = 'bob@example.com';

  const reg = await call(f, '/api/devices', 'POST', { platform: 'ios', token: 'a'.repeat(64) }, { authorization: `Bearer ${alice.token}` });
  assert.equal(reg.status, 200);

  const bobTries = await call(f, '/api/devices', 'DELETE', { token: 'a'.repeat(64) }, { authorization: `Bearer ${bob.token}` });
  assert.equal(bobTries.status, 403);
  assert.equal(/** @type {any} */ (await bobTries.json()).error?.code, 'not_yours');

  const aliceDoes = await call(f, '/api/devices', 'DELETE', { token: 'a'.repeat(64) }, { authorization: `Bearer ${alice.token}` });
  assert.equal(aliceDoes.status, 200);

  const missing = await call(f, '/api/devices', 'DELETE', { token: 'a'.repeat(64) }, { authorization: `Bearer ${alice.token}` });
  assert.equal(missing.status, 404);
});

test('a spent sign-in token stays spent across an eviction', async () => {
  // The Worker is evicted between requests as a matter of course. The Node
  // coordinator's version of this test drives a real sign-in twice across a
  // restart; here the point is only that the store is written and read back,
  // since the check itself lives in identity.js and is shared.
  const { fleet: first, state } = fleet();
  assert.equal(await first.core.spentTokens.spend('eyJ.a.b', Date.now() + 600_000), true);
  // Written by the same save every credential-issuing route calls.
  await first.core.spentTokens.serialise(); // sweep
  state.raw.set('spentTokens', first.core.spentTokens.serialise());
  const written = JSON.stringify(state.raw.get('spentTokens'));
  assert.equal(written.includes('eyJ.a.b'), false, 'the token itself is in storage');

  const second = new Fleet(/** @type {any} */ (state), {});
  // The fake blockConcurrencyWhile cannot hold the first request the way the
  // real one does, so let the restore's chain of storage reads drain.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await second.core.spentTokens.spend('eyJ.a.b', Date.now() + 600_000), false, 'an eviction made it reusable');
});

test('the heartbeat auto-response is the shared constants, byte for byte', () => {
  // setWebSocketAutoResponse matches the REQUEST bytes and replies with the
  // RESPONSE bytes without waking the object. The sidecar compares bytes too.
  // If either side ever built its frame with a JSON.stringify of its own, a key
  // order or a space would turn a free heartbeat into one that wakes the
  // object every twenty seconds per host — so the pair the object registers is
  // pinned to the constants, not to a re-spelling of them.
  const state = fakeState();
  /** @type {any} */
  let registered = null;
  /** @type {any} */ (state).setWebSocketAutoResponse = (/** @type {any} */ pair) => { registered = pair; };
  // The pair class is a workerd global; stand one in that records its inputs.
  const had = /** @type {any} */ (globalThis).WebSocketRequestResponsePair;
  /** @type {any} */ (globalThis).WebSocketRequestResponsePair = class {
    /** @param {string} request @param {string} response */
    constructor(request, response) { this.request = request; this.response = response; }
  };
  try {
    new Fleet(/** @type {any} */ (state), {});
  } finally {
    if (had === undefined) delete /** @type {any} */ (globalThis).WebSocketRequestResponsePair;
    else /** @type {any} */ (globalThis).WebSocketRequestResponsePair = had;
  }
  assert.ok(registered, 'the object registered no auto-response');
  assert.equal(registered.request, HEARTBEAT_PING);
  assert.equal(registered.response, HEARTBEAT_PONG);
  // And a fake state without the method is simply not asked — the unit tests
  // above construct the object that way on every run.
  new Fleet(/** @type {any} */ (fakeState()), {});
});

test('strangers knocking on /host/connect cannot overwrite the event history', async () => {
  // The upgrade needs no credential to attempt and an unknown host id is
  // refused at a Map lookup, so every refusal used to be recorded: 200 made-up
  // names replaced the stored ring, and the loss survived a rebuild.
  const { fleet: f, state } = fleet();
  f.core.record({ event: 'host.enrolled', hostId: 'seed-host' });
  for (let i = 0; i < 1000; i++) {
    const res = await call(f, `/host/connect?hostId=stranger-${i}`, 'GET', null, { upgrade: 'websocket' });
    assert.equal(res.status, 401);
  }
  assert.ok(f.core.events.some((e) => e.hostId === 'seed-host'), 'the history a stranger can reach is the history a stranger can erase');
  assert.equal(f.core.events.filter((e) => e.event === 'host.refused').length, 0);
  // The persisted ring is the one that matters across an eviction.
  await new Promise((r) => setTimeout(r, 0));
  const stored = state.raw.get('events') ?? [];
  assert.ok(!stored.some((/** @type {any} */ e) => e.event === 'host.refused'));
});

test('an enrolled host that is refused is recorded once, not once per attempt', async () => {
  const { fleet: f } = fleet();
  const key = await loadOrCreateKey(scratch());
  const { code } = f.core.enrollment.mint({ purpose: 'host' });
  assert.equal((await call(f, '/api/enroll/host', 'POST', { code, hostId: 'durable', publicJwk: key.publicJwk })).status, 200);

  // No challenge: refused, and its operator wants to know, once.
  for (let i = 0; i < 20; i++) {
    assert.equal((await call(f, '/host/connect?hostId=durable', 'GET', null, { upgrade: 'websocket' })).status, 401);
  }
  const refused = f.core.events.filter((e) => e.event === 'host.refused');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].hostId, 'durable');
});

test('a revoked host knocking is a stranger, not one ring entry per row per window', async () => {
  // Revoked rows stay thirty days and every retired runner leaves one, so a
  // per-name throttle was a recurring write slot per row for anybody holding
  // the names, which every member is shown. Thirty of them cycled the stored
  // ring in about seventy minutes in the second Workers audit.
  const { fleet: f } = fleet();
  for (const hostId of ['gone-1', 'gone-2', 'gone-3']) {
    const { code } = f.core.enrollment.mint({ purpose: 'host' });
    const key = await generateKeyPair();
    assert.equal((await call(f, '/api/enroll/host', 'POST', { code, hostId, publicJwk: key.publicJwk })).status, 200);
    f.core.revokeHost(hostId);
    assert.equal((await call(f, `/host/connect?hostId=${hostId}`, 'GET', null, { upgrade: 'websocket' })).status, 401);
  }
  assert.equal(f.core.events.filter((e) => e.event === 'host.refused').length, 0);
});

test('a member listing credentials sees their own devices, an admin sees everyone', async () => {
  // A list of everyone holding a credential is a list of colleagues, the
  // reason invites are refused to members, plus who the admin is and when
  // each phone was last used.
  const { fleet: f } = fleet();
  const issue = async (/** @type {string} */ name, /** @type {string} */ email, admin = false) => {
    const { token } = await f.core.clients.issue(name, { admin });
    const row = [...f.core.clients.clients.values()].find((c) => c.name === name);
    row.email = email;
    return token;
  };
  const admin = await issue('admin phone', 'admin@example.test', true);
  await issue('alice phone', 'alice@example.test');
  const bob = await issue('bob phone', 'bob@example.test');
  await issue('bob tablet', 'bob@example.test');

  const asBob = await (await call(f, '/api/clients', 'GET', null, { authorization: `Bearer ${bob}` })).json();
  assert.deepEqual(asBob.clients.map((/** @type {any} */ c) => c.name).sort(), ['bob phone', 'bob tablet']);

  const asAdmin = await (await call(f, '/api/clients', 'GET', null, { authorization: `Bearer ${admin}` })).json();
  assert.equal(asAdmin.clients.length, 4);
});

test('a member listing pins and enrolled hosts is not shown whose they are', async () => {
  // GET /api/clients stopped handing members every colleague's email; the
  // pin list and the enrolled-host list still did, as each pin's actor and
  // each pin-enrolled host's enrolledBy and owner.
  const { fleet: f } = fleet();
  const issue = async (/** @type {string} */ name, /** @type {string} */ email, admin = false) => {
    const { token } = await f.core.clients.issue(name, { admin });
    const row = [...f.core.clients.clients.values()].find((c) => c.name === name);
    row.email = email;
    return token;
  };
  const admin = await issue('admin phone', 'admin@example.test', true);
  const alice = await issue('alice phone', 'alice@example.test');
  const bob = await issue('bob phone', 'bob@example.test');
  const as = (/** @type {string} */ token) => ({ authorization: `Bearer ${token}` });

  const { code } = await (await call(f, '/api/enroll', 'POST', { kind: 'host', ephemeral: true }, as(alice))).json();
  await call(f, '/api/enroll', 'POST', { kind: 'host' }, as(alice));
  await call(f, '/api/enroll', 'POST', { kind: 'host' }, as(bob));
  const key = await generateKeyPair();
  assert.equal((await call(f, '/api/enroll/host', 'POST', { code, hostId: 'alice-box', publicJwk: key.publicJwk })).status, 200);

  const pins = async (/** @type {string} */ token) => (await (await call(f, '/api/enroll', 'GET', null, as(token))).json()).codes;
  assert.deepEqual((await pins(bob)).map((/** @type {any} */ c) => c.actor), ['bob@example.test']);
  assert.equal((await pins(admin)).length, 2);

  const hosts = async (/** @type {string} */ token) => (await (await call(f, '/api/hosts/enrolled', 'GET', null, as(token))).json()).hosts;
  const [seenByBob] = await hosts(bob);
  assert.equal(seenByBob.hostId, 'alice-box', 'every host stays listed, for vault approval');
  assert.deepEqual(seenByBob.publicJwk, { kty: 'EC', crv: 'P-256', x: key.publicJwk.x, y: key.publicJwk.y });
  assert.equal(JSON.stringify(seenByBob).includes('alice@'), false, `a member was shown a colleague's email: ${JSON.stringify(seenByBob)}`);
  const [seenByAlice] = await hosts(alice);
  assert.equal(seenByAlice.enrolledBy, 'alice@example.test', 'and the person who added it still sees that they did');
  assert.equal(seenByAlice.owner, 'alice@example.test');
  assert.equal((await hosts(admin))[0].enrolledBy, 'alice@example.test');
});

test('one member filling a shared store fills only their own share of it', async () => {
  // Pending pins, runner and VM tickets and live credentials were each one
  // fleet-wide store with a fleet-wide cap. A member minting two hundred pins
  // or tickets evicted everybody else's oldest, and 149 sign-ins refused
  // every other person's next one, the admin's included.
  const { fleet: f } = fleet();
  const issue = async (/** @type {string} */ name, /** @type {string} */ email) => {
    const { token } = await f.core.clients.issue(name);
    const row = [...f.core.clients.clients.values()].find((c) => c.name === name);
    row.email = email;
    return { authorization: `Bearer ${token}` };
  };
  const alice = await issue('alice phone', 'alice@example.test');
  const bob = await issue('bob phone', 'bob@example.test');

  const { code } = await (await call(f, '/api/enroll', 'POST', { kind: 'host' }, alice)).json();
  for (let i = 0; i < 250; i++) await call(f, '/api/enroll', 'POST', { kind: 'host' }, bob);
  const key = await generateKeyPair();
  assert.equal((await call(f, '/api/enroll/host', 'POST', { code, hostId: 'alice-box', publicJwk: key.publicJwk })).status, 200, "another member's pins pushed out alice's");

  const ticket = await f.core.runnerTickets.mint({ owner: 'alice@example.test', platform: 'linux' });
  for (let i = 0; i < 250; i++) await f.core.runnerTickets.mint({ owner: 'bob@example.test', platform: 'linux' });
  assert.ok(await f.core.runnerTickets.peek(ticket?.token), "another member's tickets pushed out alice's");

  for (let i = 0; i < 160; i++) await f.core.issueClient({ email: 'bob@example.test' }, `bob device ${i}`);
  const signedIn = await f.core.issueClient({ email: 'alice@example.test' }, 'alice laptop');
  assert.ok('token' in signedIn, `alice could not sign in after another member's sign-ins: ${JSON.stringify(signedIn)}`);
});

/**
 * A fleet with a GitHub App and a Cloudflare client, a box one member
 * enrolled and one the operator runs, each answering `connect` with a
 * catalogue and recording every credential verb the coordinator sends it. The providers' token
 * endpoints answer with a token named after the code, so a test can see whose
 * code became whose token.
 *
 * @param {import('node:test').TestContext} t
 */
async function providerFleet(t) {
  const { fleet: f } = fleet({
    FLEETWRIGHT_GITHUB_CLIENT_ID: 'Iv23liTEST',
    FLEETWRIGHT_GITHUB_CLIENT_SECRET: 'shh',
    FLEETWRIGHT_CLOUDFLARE_CLIENT_ID: 'cf-id',
    FLEETWRIGHT_CLOUDFLARE_CLIENT_SECRET: 'cf-shh',
    FLEETWRIGHT_CLOUDFLARE_SCOPES: 'account-settings.read offline_access',
  });
  const as = async (/** @type {string} */ email) => {
    const { token } = await f.core.clients.issue(`${email} phone`);
    const row = [...f.core.clients.clients.values()].find((c) => c.name === `${email} phone`);
    row.email = email;
    return { authorization: `Bearer ${token}` };
  };
  /** @type {any[]} */
  const stored = [];
  /** A box answering as a sidecar would, recording what it is asked to store. @param {string} hostId */
  const box = (hostId) => (/** @type {any} */ msg) => {
    if (msg?.kind !== 'intent') return;
    if (msg.verb !== 'connect') stored.push({ hostId, verb: msg.verb, actor: msg.actor, secret: msg.params?.secret });
    const reply =
      msg.verb === 'connect'
        ? { connections: { catalogue: [{ provider: 'github', url: 'https://github.com/settings/tokens/new' }, { provider: 'cloudflare', url: 'https://dash.cloudflare.com/profile/api-tokens' }], connected: [] } }
        : { text: 'stored' };
    queueMicrotask(() => f.core.onHostMessage(hostId, { kind: 'reply', id: msg.id, ok: true, ...reply }));
  };
  // One box Mallory enrolled with a pin of her own, and one the operator runs.
  await admit(f.core, 'mallory-box', { enrolledBy: 'mallory@example.test', send: box('mallory-box') });
  await admit(f.core, 'ops-box', { send: box('ops-box') });
  // Reported, as a sidecar does within seconds: a box that has not is waited for.
  for (const hostId of ['mallory-box', 'ops-box']) f.core.registry.recordHealth(hostId, { hostId, running: 0, sessions: [] });
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    const u = new URL(String(url));
    if (u.pathname === '/login/oauth/access_token' || u.pathname === '/oauth2/token') {
      const code = new URLSearchParams(String(init?.body)).get('code');
      return new Response(JSON.stringify({ access_token: `tok_for_${code}`, token_type: 'bearer', expires_in: 28800, refresh_token: 'refresh_x' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`nothing else is reachable from this test: ${u.href}`);
  });
  t.after(() => { globalThis.fetch = real; });
  /** The two authorize URLs' states from one Connect. @param {Record<string,string>} who @param {string} host */
  const connect = async (who, host) => {
    const reply = await (await call(f, '/api/intent', 'POST', { verb: 'connect', params: {}, host, oauthFinish: true }, who)).json();
    const url = (/** @type {string} */ p) => new URL(reply.connections.catalogue.find((/** @type {any} */ c) => c.provider === p).url);
    return { github: url('github').searchParams.get('state'), cloudflare: url('cloudflare').searchParams.get('state') };
  };
  return { f, as, stored, connect };
}

test('a forwarded GitHub or Cloudflare link connects nothing for the person who started it', async (t) => {
  // Mallory, a member, started a connect on a box she enrolled, kept the
  // provider's authorize URL and forwarded it. Whoever authorized it came back
  // to the callback, which took no credential, redeemed the state, exchanged
  // THEIR code with the App's secret, and linked the token on mallory-box as
  // Mallory's. The state proves who started a flow, not whose browser came
  // back, so the callback now finishes nothing, and the finish is refused to
  // anybody but the person who started it.
  const { f, as, stored, connect } = await providerFleet(t);
  const mallory = await as('mallory@example.test');
  const victim = await as('victim@example.test');
  const states = await connect(mallory, 'mallory-box');

  // The victim's browser comes back from each provider with the victim's
  // code and Mallory's state, holding no fleet credential.
  for (const [path, state] of [['/oauth/github/callback', states.github], ['/oauth/cloudflare/callback', states.cloudflare]]) {
    const page = await call(f, `${path}?code=VICTIMCODE123&state=${state}`);
    assert.deepEqual(stored, [], `${path} stored somebody else’s token for the person who started the flow`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /fleetwright:\/\/(github|cloudflare)\?state=/, 'the page does not hand the code back');
  }

  // The victim's app or `/me` hands it on with the victim's own credential.
  for (const provider of ['github', 'cloudflare']) {
    const r = await call(f, '/api/oauth/finish', 'POST', { provider, code: 'VICTIMCODE123', state: states[provider] }, victim);
    const body = await r.json();
    assert.equal(r.status, 400);
    assert.equal(body.error?.code, 'not_yours', body.text);
  }
  // Nor the admin token, which is what reaches the object with no client: it
  // finishes only the flows it started itself.
  assert.equal((await (await call(f, '/api/oauth/finish', 'POST', { provider: 'github', code: 'VICTIMCODE123', state: states.github })).json()).error?.code, 'not_yours');
  assert.deepEqual(stored, [], 'a finish by somebody other than the starter stored a token');

  // The person who started it still can, with their own code, and only once.
  const own = await call(f, '/api/oauth/finish', 'POST', { provider: 'github', code: 'MALLORYCODE1', state: states.github }, mallory);
  assert.equal(own.status, 200, (await own.clone().json()).text);
  assert.deepEqual(stored.filter((x) => x.verb === 'link').map((x) => [x.hostId, x.actor, x.secret]), [['mallory-box', 'mallory@example.test', 'tok_for_MALLORYCODE1']]);
  assert.equal((await call(f, '/api/oauth/finish', 'POST', { provider: 'github', code: 'MALLORYCODE1', state: states.github }, mallory)).status, 400);
});

test('an enrolled host cannot erase, outweigh or impersonate the fleet’s own records', async () => {
  // Host event frames went into the one 200-entry ring the coordinator's
  // audit records live in, with no share per host, no cap on `name` or
  // `event`, and any type at all. In the second Workers audit a box a member
  // enrolled evicted every enrolment and revocation with 200 small frames,
  // made the stored ring a single entry with one 110,000-character name, and
  // put a `client.revoked` of its own wording in every member's feed.
  const { fleet: f, state } = fleet();
  f.core.record({ event: 'host.enrolled', hostId: 'seed-host' });
  const frame = (/** @type {string} */ hostId, /** @type {any} */ body) => f.webSocketMessage(
    /** @type {any} */ ({ deserializeAttachment: () => ({ hostId }) }),
    JSON.stringify({ kind: 'event', ...body }),
  );

  // Several boxes, as a member can enrol several, each sending the largest
  // event the coordinator keeps.
  for (const box of ['mallory-box', 'mallory-2', 'mallory-3', 'mallory-4', 'mallory-5']) {
    for (let i = 0; i < 250; i++) await frame(box, { event: 'session.ended', name: `s${i}`, text: 'x'.repeat(500), url: `https://example.com/${'y'.repeat(470)}` });
  }
  await frame('mallory-box', { event: 'session.ended', name: 'n'.repeat(110_000) });
  await frame('mallory-box', { event: 'client.revoked', text: 'your credential was revoked, sign in again here', url: 'https://evil.example/' });
  await new Promise((r) => setTimeout(r, 0));

  const seeded = (/** @type {any[]} */ events) => events.some((e) => e.hostId === 'seed-host');
  assert.ok(seeded(f.core.events), 'a host pushed the coordinator’s record out of the ring');
  assert.ok(seeded(state.raw.get('events') ?? []), 'a host pushed the coordinator’s record out of storage');
  const revived = new Fleet(/** @type {any} */ (state), {});
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(seeded(revived.core.events), 'and the loss outlived a rebuild');
  assert.ok(f.core.events.some((e) => e.name === 's249'), 'the host’s own news is still recorded');
  assert.ok(f.core.events.every((e) => String(e.name ?? '').length <= 40), 'a name no session can have was recorded');
  const member = f.core.recentEvents({ email: 'someone@example.test', admin: false });
  assert.ok(!member.some((e) => String(e.hostId).startsWith('mallory')), 'a member was shown an entry a host wrote');
});
