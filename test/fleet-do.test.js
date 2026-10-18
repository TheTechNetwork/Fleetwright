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
import { s256 } from '../src/mcp/oauth.js';
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

test('the Durable Object reads no setting under a name from before the rename', async () => {
  // It aliased AGENT_FLEET_X onto a missing or empty FLEETWRIGHT_X in its
  // constructor, so blanking FLEETWRIGHT_AUTH_ALLOW brought back the allowlist
  // it replaced. The sign-in settings ride the same path and are what a route
  // shows without a signed token: under the old names only, there is no
  // sign-in, and no old allowlist either.
  const { fleet: f } = fleet({
    AGENT_FLEET_AUTH_ISSUERS: 'https://accounts.google.com',
    AGENT_FLEET_AUTH_AUDIENCES: 'network.thetech.fleetwright',
    FLEETWRIGHT_AUTH_ALLOW: '',
    AGENT_FLEET_AUTH_ALLOW: 'legacy@example.test',
  });
  const res = await call(f, '/api/session', 'POST', { idToken: 'anything' });
  assert.equal(res.status, 503, 'the Durable Object read its sign-in settings under the old names');
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

test('a member cannot claim a phone the admin token registered, any more than remove it', async () => {
  // A row with no credential is the operator's: the admin token made it. The
  // test notification and unregistering refused it to members, and
  // registering did not — its check asked only whether the row HAD a
  // credential — so a member who knew the phone's token re-keyed the row to
  // their own, the operator's notifications stopped reaching it, and revoking
  // the member removed it.
  const { fleet: f } = fleet();
  const member = await f.core.clients.issue('member phone', { email: 'm@example.com' });
  const admin = await f.core.clients.issue('admin phone', { admin: true, email: 'eli@thetech.network' });
  const token = '5f0c9e2ab4d3e1f7'.repeat(4);
  // No credential at all is the admin token here; worker.js has already checked it.
  assert.equal((await call(f, '/api/devices', 'POST', { platform: 'ios', token })).status, 200);

  const removes = await call(f, '/api/devices', 'DELETE', { token }, { authorization: `Bearer ${member.token}` });
  assert.equal(removes.status, 403, 'removing it was already refused');
  const claims = await call(f, '/api/devices', 'POST', { platform: 'ios', token }, { authorization: `Bearer ${member.token}` });
  assert.equal(claims.status, 403);
  assert.equal(/** @type {any} */ (await claims.json()).code, 'not_yours');
  assert.equal(f.core.devices.get(token)?.clientId, undefined, 'the row is still the operator’s');

  // The operator's own phone, signed in as the admin, may take its row over.
  const adopts = await call(f, '/api/devices', 'POST', { platform: 'ios', token }, { authorization: `Bearer ${admin.token}` });
  assert.equal(adopts.status, 200);
  assert.equal(f.core.devices.get(token)?.clientId, admin.client.id);
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

  // And nothing the record grew after this was written: the GitHub account
  // that started a runner sat beside the owner it hid (seventh audit), and
  // handBackPending named a removed operator's boxes. Shown to the owner only.
  Object.assign(f.core.hostIds.get('alice-box'), { admittedBy: 'ticket', actorId: '515151', handBackPending: true });
  const [later] = await hosts(bob);
  for (const field of ['actorId', 'admittedBy', 'handBackPending']) {
    assert.equal(field in later, false, `a member was shown ${field} of a colleague's host`);
  }
  assert.equal((await hosts(alice))[0].actorId, '515151');
  assert.equal((await hosts(admin))[0].actorId, '515151');

  // And the live host list the apps draw from, which handed every member the
  // owner of every temporary host (third Workers audit), before its first
  // health frame and after.
  f.core.hostConnected('alice-box', () => {});
  const live = async (/** @type {string} */ token) =>
    (await (await call(f, '/api/hosts', 'GET', null, as(token))).json()).hosts.find((/** @type {any} */ h) => h.hostId === 'alice-box');
  for (const when of ['before its health', 'after its health']) {
    if (when === 'after its health') await f.core.onHostMessage('alice-box', { kind: 'health', health: { sessions: [], claudeAccounts: 1 } });
    const seen = await live(bob);
    assert.ok(seen, `a member was not shown the host at all ${when}`);
    assert.equal(JSON.stringify(seen).includes('alice@'), false, `a member was shown a colleague's email ${when}: ${JSON.stringify(seen)}`);
    assert.equal((await live(alice)).owner, 'alice@example.test', `the owner was not shown their own ${when}`);
  }
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

test('another member’s connects cannot push out a sign-in somebody is half-way through', async (t) => {
  // Every connect reply with a catalogue minted a state into one store per
  // provider, shared by the fleet and capped at two hundred, oldest out
  // whoever's it was. A member with a box that answers connect sent two
  // hundred and every other person's in-progress GitHub and Cloudflare
  // sign-in came back "expired".
  const { f, as, stored, connect } = await providerFleet(t);
  const mallory = await as('mallory@example.test');
  const victim = await as('victim@example.test');
  const hers = await connect(victim, 'ops-box');
  for (let i = 0; i < 1000; i++) {
    await call(f, '/api/intent', 'POST', { verb: 'connect', params: {}, host: 'mallory-box', oauthFinish: true }, mallory);
  }
  for (const provider of ['github', 'cloudflare']) {
    const r = await call(f, '/api/oauth/finish', 'POST', { provider, code: 'VICTIMCODE123', state: hers[provider] }, victim);
    assert.equal(r.status, 200, `${provider}: ${(await r.json()).text}`);
  }
  assert.deepEqual(
    stored.filter((x) => x.verb === 'link').map((x) => [x.hostId, x.actor]),
    [['ops-box', 'victim@example.test'], ['ops-box', 'victim@example.test']],
  );
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

test('one member’s requests displace their own records, never the fleet’s or anybody else’s', async () => {
  // The coordinator's own records had no share of the ring at all, so 200
  // pins minted by one member (never more than 20 waiting) replaced every
  // entry in memory and in storage, and a rebuilt Fleet loaded only those:
  // the enrolments and revocations before them were gone (third Workers
  // audit).
  //
  // And records written at her request that named nobody, which that share
  // did not count: a phone re-registering without its push key and then
  // with it, a box of hers re-keyed with a pin bound to it, a temporary host
  // of hers going away (fourth Workers audit).
  const { fleet: f, state } = fleet();
  const { token } = await f.core.clients.issue('mallory phone', { email: 'mallory@example.test' });
  const as = { authorization: `Bearer ${token}` };
  f.core.record({ event: 'host.revoked', hostId: 'build-server' });
  f.core.record({ event: 'linked.repo', actor: 'alice@example.test', text: 'alice linked a repository' });
  for (let i = 0; i < 200; i++) {
    assert.equal((await call(f, '/api/enroll', 'POST', { kind: 'host' }, as)).status, 200);
  }
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pushKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64');
  for (let i = 0; i < 200; i++) {
    for (const key of [{ pushKey }, {}]) {
      assert.equal((await call(f, '/api/devices', 'POST', { platform: 'android', token: 'fcm_dummy_token', ...key }, as)).status, 200);
    }
  }
  // Named as hers, so they count in her share and only she and an admin see them.
  const last = () => `${f.core.events.at(-1)?.event} ${f.core.events.at(-1)?.actor}`;
  assert.equal(last(), 'device.plaintext mallory@example.test');
  const { publicJwk } = await generateKeyPair();
  const pin = async (/** @type {any} */ body) => (await (await call(f, '/api/enroll', 'POST', { kind: 'host', ...body }, as)).json()).code;
  for (let i = 0; i < 200; i++) {
    const code = await pin(i ? { hostId: 'm-box' } : {});
    assert.equal((await call(f, '/api/enroll/host', 'POST', { code, hostId: 'm-box', publicJwk })).status, 200);
  }
  assert.equal(last(), 'host.enrolled mallory@example.test');
  for (let i = 0; i < 200; i++) {
    const code = await pin({ ephemeral: true });
    assert.equal((await call(f, '/api/enroll/host', 'POST', { code, hostId: `t-${i}`, publicJwk })).status, 200);
    f.core.hostConnected(`t-${i}`, () => {});
    f.core.hostDisconnected(`t-${i}`, 'job done');
  }
  await new Promise((r) => setTimeout(r, 0));

  const kept = (/** @type {any[]} */ events) =>
    events.some((e) => e.event === 'host.revoked') && events.some((e) => e.actor === 'alice@example.test');
  assert.ok(kept(f.core.events), 'a member’s requests pushed other records out of the ring');
  assert.ok(kept(state.raw.get('events') ?? []), 'and out of storage');
  const revived = new Fleet(/** @type {any} */ (state), {});
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(kept(revived.core.events), 'and the loss outlived a rebuild');
  assert.ok(f.core.events.filter((e) => e.actor === 'mallory@example.test').length > 0, 'her own minting is still recorded');
});

test('a box changing its health reason every frame is announced once, and holds only its own share', async () => {
  // A health frame's hub.reason went into host.reason uncapped, every new
  // reason was a transition, and #onHostState suppressed only the identical
  // sentence: so a box with a new reason per frame wrote one host.degraded
  // per frame into the coordinator's records and pushed each one to the
  // admin's phone. 51 frames displaced the oldest audit record from memory,
  // storage and a rebuild (third Workers audit).
  const { fleet: f, state } = fleet();
  f.core.record({ event: 'host.enrolled', hostId: 'seed-host' });
  // Of several kinds, since one kind naming nobody keeps only 25 (#makeRoom).
  for (let i = 0; i < 150; i++) f.core.record({ event: `audit.seed-${i % 10}`, text: `seed ${i}` });
  const admin = await f.core.clients.issue('admin phone', { admin: true, email: 'admin@example.test' });
  await f.core.registerDevice({ platform: 'ios', token: 'a'.repeat(64), clientId: admin.client.id, actor: 'admin@example.test' });
  /** @type {any[]} */
  const sent = [];
  f.core.push = /** @type {any} */ ({ send: async (/** @type {any[]} */ d) => { sent.push(...d); return { ok: true }; } });
  f.core.hostConnected('mallory-box', () => {});
  const socket = /** @type {any} */ ({ deserializeAttachment: () => ({ hostId: 'mallory-box' }) });
  for (let i = 0; i < 120; i++) {
    const health = { protocol: 7, labels: [], maxSessions: 4, running: 0, free: 4, sessions: [], loggedIn: true, claudeAccounts: 1, hub: { reachable: false, reason: `DUMMY-REASON-${i} ${'x'.repeat(3_000)}` } };
    await f.webSocketMessage(socket, JSON.stringify({ kind: 'health', health }));
  }
  await new Promise((r) => setTimeout(r, 0));

  const degraded = f.core.events.filter((e) => e.event === 'host.degraded');
  assert.equal(degraded.length, 1, `one box wrote ${degraded.length} host.degraded records in a quiet window`);
  assert.ok(sent.length <= 1, `and pushed ${sent.length} of them`);
  assert.ok(String(f.core.registry.get('mallory-box')?.reason).length < 300, 'a reason the box chose was kept uncapped');
  const seeded = (/** @type {any[]} */ events) => events.some((e) => e.hostId === 'seed-host');
  assert.ok(seeded(f.core.events), 'a box’s health pushed the coordinator’s record out of the ring');
  assert.ok(seeded(state.raw.get('events') ?? []), 'and out of storage');
});

test('a health frame heavier than any honest one is neither kept nor served again', async () => {
  // recordHealth kept a frame whole, keys nobody reads included, and
  // /api/hosts handed it back to every member who could see the box: one box
  // a member enrolled made this object hold and re-send whatever it chose,
  // every fifteen seconds, up to the platform's message limit (seventh audit).
  const { fleet: f } = fleet();
  f.core.hostConnected('mallory-box', () => {});
  const socket = /** @type {any} */ ({ deserializeAttachment: () => ({ hostId: 'mallory-box' }) });
  const health = (/** @type {any} */ extra) => ({ protocol: 7, labels: [], maxSessions: 4, running: 0, free: 4, sessions: [], loggedIn: true, claudeAccounts: 1, hub: { reachable: true }, ...extra });
  const served = async () => JSON.stringify(await (await call(f, '/api/hosts')).json());

  await f.webSocketMessage(socket, JSON.stringify({ kind: 'health', health: health({ note: 'an honest frame' }) }));
  assert.match(await served(), /an honest frame/, 'an ordinary frame is not kept');

  // Over the health bound, then over the bound on parsing anything at all.
  for (const size of [600 * 1024, 3 * 1024 * 1024]) {
    await f.webSocketMessage(socket, JSON.stringify({ kind: 'health', health: health({ note: 'padded', pad: 'x'.repeat(size) }) }));
    assert.equal(f.core.registry.get('mallory-box')?.health?.note, 'an honest frame', `a ${size}-byte frame replaced the last honest one`);
    const body = await served();
    assert.ok(body.length < 64 * 1024, `/api/hosts re-served ${body.length} bytes of one box's frame`);
  }
});

test('one member’s machines fill their own share of the fleet, not everybody’s', async () => {
  // HostIdentities refused any new machine once 200 were live, and nothing
  // bounded how many one person added: a member minting and spending pins one
  // after another enrolled 200 permanent hosts, and every other enrolment in
  // the fleet, runners and VMs included, answered 507 hosts_full until an admin
  // revoked them one at a time (third Workers audit).
  const { fleet: f } = fleet();
  await f.core.clients.issue('admin phone', { admin: true, email: 'admin@example.test' });
  const { publicJwk } = await generateKeyPair();
  const enrol = async (/** @type {string|null} */ actor, /** @type {string} */ hostId) => {
    const { code } = /** @type {any} */ (f.core.enrollment.mint({ purpose: 'host', actor }));
    return call(f, '/api/enroll/host', 'POST', { code, hostId, publicJwk });
  };
  let refused = null;
  for (let i = 0; i < 40 && !refused; i++) {
    const res = await enrol('mallory@example.test', `m-${i}`);
    if (res.status !== 200) refused = { i, status: res.status, body: await res.json() };
  }
  assert.ok(refused, 'one member enrolled forty machines with nothing to stop them');
  assert.equal(refused.status, 507);
  assert.equal(refused.body.error.code, 'person_full');
  assert.ok(refused.i >= 20, `refused after only ${refused.i}`);
  assert.equal((await enrol('alice@example.test', 'alice-box')).status, 200, 'another member was refused for mallory’s machines');
  // The operator's boxes are the fleet, not one person's share of it.
  for (let i = 0; i < 40; i++) assert.equal((await enrol(i % 2 ? 'admin@example.test' : null, `op-${i}`)).status, 200, `the operator was refused their ${i + 1}th box`);
});

test('readmitting a machine, or re-keying one for somebody else, is counted like a new one', async () => {
  // The share and the ceiling were checked only for a host id with no row, so
  // a readmission (a revoked row made live again, under whoever's pin it was)
  // and a re-key handing a row to another person counted for neither. One
  // member let 200 temporary hosts of theirs retire, readmitted every row,
  // and held 225 live hosts; the next person's enrolment got hosts_full
  // (fourth Workers audit).
  const { fleet: f } = fleet();
  await f.core.clients.issue('admin phone', { admin: true, email: 'admin@example.test' });
  const { publicJwk } = await generateKeyPair();
  const enrol = async (/** @type {string|null} */ actor, /** @type {string} */ hostId, /** @type {any} */ pin = {}) => {
    const { code } = /** @type {any} */ (f.core.enrollment.mint({ purpose: 'host', actor, ...pin }));
    const res = await call(f, '/api/enroll/host', 'POST', { code, hostId, publicJwk });
    return res.status === 200 ? 200 : `${res.status} ${(await res.json()).error.code}`;
  };
  const mallory = 'mallory@example.test';
  for (let i = 0; i < 25; i++) assert.equal(await enrol(mallory, `m-${i}`), 200);
  for (let i = 0; i < 5; i++) f.core.revokeHost(`m-${i}`);
  for (let i = 0; i < 5; i++) assert.equal(await enrol(mallory, `n-${i}`), 200);
  assert.equal(await enrol(mallory, 'm-0', { readmit: true }), '507 person_full', 'a readmission went past the person’s share');
  assert.equal(await enrol(null, 'ops-box'), 200);
  assert.equal(await enrol(mallory, 'ops-box', { hostId: 'ops-box' }), '507 person_full', 'a re-key handed a box to a person at their share');
  assert.equal(await enrol(mallory, 'm-5', { hostId: 'm-5' }), 200, 'a person at their share could not re-key their own box');

  // And the fleet's ceiling: a readmission makes one more live machine.
  for (let i = 0; f.core.hostIds.list().length < 200; i++) assert.equal(await enrol(null, `op-${i}`), 200);
  assert.equal(await enrol(null, 'm-1', { readmit: true }), '507 hosts_full', 'a readmission went past the fleet’s ceiling');
  assert.equal(await enrol(mallory, 'm-6', { hostId: 'm-6' }), 200, 'a re-key, which adds no machine, was refused by a full fleet');
});

test('a removed member’s pins go with them, and any pin listed can be cancelled after a restart', async () => {
  // #forgetPerson took back a removed member's tickets and left their pins:
  // for the rest of each pin's ten minutes they enrolled a new host in that
  // person's name, re-keyed a host the pin was bound to and readmitted a
  // revoked one. And nothing could cancel a pin, before a restart or after:
  // the admin's DELETE answered 404 (third Workers audit).
  const { fleet: f, state } = fleet();
  const admin = await f.core.clients.issue('admin phone', { admin: true, email: 'admin@example.test' });
  const sam = await f.core.clients.issue('sam phone', { email: 'sam@example.test' });
  const bob = await f.core.clients.issue('bob phone', { email: 'bob@example.test' });
  const carol = await f.core.clients.issue('carol phone', { email: 'carol@example.test' });
  const as = (/** @type {{ token: string }} */ who) => ({ authorization: `Bearer ${who.token}` });
  const { publicJwk } = await generateKeyPair();
  const op = /** @type {any} */ (f.core.enrollment.mint({ purpose: 'host', actor: 'admin@example.test' }));
  assert.equal((await call(f, '/api/enroll/host', 'POST', { code: op.code, hostId: 'op-box', publicJwk })).status, 200);

  const mint = async (/** @type {any} */ who, /** @type {any} */ body) => (await (await call(f, '/api/enroll', 'POST', { kind: 'host', ...body }, as(who))).json()).code;
  const pins = [await mint(sam, {}), await mint(sam, { hostId: 'op-box' })];
  assert.equal((await call(f, `/api/clients/${sam.client.id}`, 'DELETE', null, as(admin))).status, 200);
  await new Promise((r) => setTimeout(r, 0));
  for (const fleetNow of [f, new Fleet(/** @type {any} */ (state), {})]) {
    await new Promise((r) => setTimeout(r, 0));
    const fresh = (await generateKeyPair()).publicJwk;
    assert.equal((await call(fleetNow, '/api/enroll/host', 'POST', { code: pins[0], hostId: 'sam-box', publicJwk: fresh })).status, 403, 'a removed member’s pin enrolled a host');
    assert.equal((await call(fleetNow, '/api/enroll/host', 'POST', { code: pins[1], hostId: 'op-box', publicJwk: fresh })).status, 403, 'a removed member’s pin re-keyed a host');
  }

  // Cancelling: whoever minted the pin, or an admin, by the id the list shows.
  const bobs = await mint(bob, {});
  const revived = new Fleet(/** @type {any} */ (state), {});
  await new Promise((r) => setTimeout(r, 0));
  const listed = (await (await call(revived, '/api/enroll', 'GET', null, as(admin))).json()).codes;
  assert.equal(listed.length, 1);
  assert.equal((await call(revived, `/api/enroll/${listed[0].id}`, 'DELETE', null, as(carol))).status, 404, 'a member cancelled somebody else’s pin');
  assert.equal((await call(revived, `/api/enroll/${listed[0].id}`, 'DELETE', null, as(admin))).status, 200, 'the admin could not cancel a listed pin after a restart');
  assert.equal((await call(revived, '/api/enroll/host', 'POST', { code: bobs, hostId: 'bob-box', publicJwk })).status, 403, 'a cancelled pin still enrolled');
  const again = new Fleet(/** @type {any} */ (state), {});
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((await (await call(again, '/api/enroll', 'GET', null, as(admin))).json()).codes.length, 0, 'the cancelled pin came back after a restart');
});

test('an MCP sign-in begun before a person was removed buys no credential after', async () => {
  // /oauth/authorize checks the allowlist and the invites; /oauth/token spent
  // the code it issued for five minutes without asking again, and removal
  // left the code alone. So a member un-invited and revoked while holding one
  // exchanged it afterwards for a working credential, and minted pins and
  // runner tokens with it (fourth Workers audit).
  const { fleet: f } = fleet({ FLEETWRIGHT_AUTH_ALLOW: 'admin@example.test' });
  const admin = await f.core.clients.issue('admin phone', { admin: true, email: 'admin@example.test' });
  const as = { authorization: `Bearer ${admin.token}` };
  const reg = /** @type {any} */ (f.core.mcpAuthorizations.register({ redirect_uris: ['http://127.0.0.1:9999/cb'] }));
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = await s256(verifier);
  const signIn = (/** @type {string} */ email) =>
    /** @type {any} */ (f.core.mcpAuthorizations.issueCode({ email, clientId: reg.clientId, redirectUri: 'http://127.0.0.1:9999/cb', challenge })).code;
  const exchange = (/** @type {string} */ code) =>
    f.fetch(new Request('https://fleet.example/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.clientId, redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier }),
    }));
  const held = (/** @type {string} */ email) => f.core.clients.list().filter((c) => c.email === email && !c.revokedAt).length;
  for (const who of ['sam@example.test', 'carol@example.test']) f.core.invites.add(who, { invitedBy: 'admin@example.test', note: null });
  const sam = await f.core.clients.issue('sam phone', { email: 'sam@example.test' });
  const [first, second] = [signIn('sam@example.test'), signIn('sam@example.test')];

  assert.equal((await call(f, '/api/invites/sam%40example.test', 'DELETE', null, as)).status, 200);
  const refused = await exchange(first);
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, 'invalid_grant');
  assert.equal(held('sam@example.test'), 1, 'an un-invited person was issued a credential');

  // Revoking the last credential is the rest of the removal, and drops the
  // code even if the person is invited again before it expires.
  assert.equal((await call(f, `/api/clients/${sam.client.id}`, 'DELETE', null, as)).status, 200);
  f.core.invites.add('sam@example.test', { invitedBy: 'admin@example.test', note: null });
  assert.equal((await exchange(second)).status, 400, 'a removed person’s code outlived the removal');
  assert.equal(held('sam@example.test'), 0);

  // Somebody still in the fleet signs in as before.
  assert.equal((await exchange(signIn('carol@example.test'))).status, 200);
  assert.equal(held('carol@example.test'), 1);
});
