// A pool's own machine asking to join, and its owner letting it in: the proof
// every party computes, and the coordinator keeping the request until the
// owner answers. The box's half and the phones' have their own tests.
//
//   node --test test/holder-join.test.js
//
// ASKED FOR: "Should it ask us for a pin we request it from the app it gets
// Face ID", after a holder sat running outside the fleet for hours because the
// pin it was booted with ran out before its first boot finished.
// docs/hypervisors.md, "A machine of its own".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CoordinatorCore, REFUSAL_EVERY_MS } from '../src/fleet/coordinator/core.js';
import { HOLDER_JOIN_TTL_MS, MAX_REQUESTS } from '../src/fleet/coordinator/holder-joins.js';
import { keyHashOf, proofOf, proofMessage } from '../src/fleet/protocol/holder-join.js';
import { generateKeyPair } from '../src/fleet/crypto.js';
import { Fleet } from '../worker/src/fleet-do.js';
import worker from '../worker/src/worker.js';

const VECTOR = JSON.parse(readFileSync(new URL('./fixtures/parity/holder-join.json', import.meta.url), 'utf8'));
const ELI = 'eli@example.com';
const JOB = 'a1b2c3d4e5f6';
const XO = '10.10.10.230';
const SECRET = 'ab'.repeat(32);

test('the proof is the one the phones are held to', async () => {
  assert.equal(proofMessage(VECTOR), VECTOR.message);
  assert.equal(await keyHashOf(VECTOR.publicJwk), VECTOR.keyHash);
  assert.equal(await proofOf(VECTOR.secret, VECTOR), VECTOR.proof);
  // Over the name, the pool and the key: change any one and it proves nothing.
  for (const change of [{ hostId: 'holder-000000' }, { address: '10.10.10.231' }, { keyHash: 'f'.repeat(64) }]) {
    assert.notEqual(await proofOf(VECTOR.secret, { ...VECTOR, ...change }), VECTOR.proof, JSON.stringify(change));
  }
});

/** Eli's policy job on a laptop, a clock, and every notification sent. */
async function fleet() {
  let now = Date.UTC(2026, 9, 11, 6, 0);
  /** @type {any[]} */
  const pushed = [];
  const push = { send: async (/** @type {any[]} */ devices, /** @type {any} */ message) => { pushed.push({ devices, message }); return { dead: [] }; } };
  const core = new CoordinatorCore({ push: /** @type {any} */ (push), now: () => now });
  core.hostIds.now = () => now;
  await core.issueClient({ email: ELI }, 'phone');
  /** @type {any[]} */
  const frames = [];
  core.registry.connect('laptop', (/** @type {any} */ f) => frames.push(f));
  core.registry.recordHealth('laptop', { hub: { reachable: true }, protocol: 9, maxSessions: 5, running: 0, free: 5, labels: [] });
  core.setups.set(JOB, { hostId: 'laptop', owner: ELI, startedAt: now, last: null, activities: [] });
  await core.registerDevice({ platform: 'ios', token: '9f'.repeat(32), actor: `fleet:${ELI}` });
  await core.onHostMessage('laptop', { kind: 'holder-pin', id: 'holder-pin-1', job: JOB, address: XO });
  const minted = frames.find((f) => f.id === 'holder-pin-1');
  assert.equal(minted.ok, true, minted.text);
  /** A machine's request under the reserved name, proved with `secret`. */
  const asking = async (secret = SECRET, hostId = minted.hostId) => {
    const { kty, crv, x, y } = /** @type {any} */ ((await generateKeyPair()).publicJwk);
    const publicJwk = { kty, crv, x, y };
    const keyHash = await keyHashOf(/** @type {any} */ (publicJwk));
    return { body: { hostId, publicJwk, proof: await proofOf(secret, { hostId, address: XO, keyHash }) }, keyHash, publicJwk };
  };
  return { core, pushed, minted, asking, tick: (/** @type {number} */ ms) => { now += ms; } };
}

test('the box running the job is given a pin and a name held for a day, for the pool it said', async () => {
  const { core, minted } = await fleet();
  assert.match(minted.pin, /^\d{6}$/, 'the pin stays, for machines made from an image older than the asking');
  assert.equal(minted.until - core.now(), HOLDER_JOIN_TTL_MS);
  assert.deepEqual(core.holdersFor({ email: ELI }).map((h) => [h.hostId, h.address, h.requests.length]), [[minted.hostId, XO, 0]]);
  assert.deepEqual(core.holdersFor({ email: 'ops@example.com' }), [], 'nobody else is waited on by it');
});

test('a machine asking under the name is kept for its owner, who is told once', async () => {
  const { core, pushed, minted, asking, tick } = await fleet();
  tick(40 * 60_000); // long past the pin
  const first = await asking();
  const r = await core.holderJoin(first.body);
  assert.equal(r.status, 202, r.body.text);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].message.data.kind, 'holder-join');
  assert.equal(pushed[0].message.data.hostId, minted.hostId);
  assert.match(pushed[0].message.title, /asks to join/);
  // THE PHONE THAT MADE IT LETS IT IN FROM THIS PUSH: iOS woken for it, Android
  // handed it as data, and Let it in under the category for a phone that
  // could not settle it by itself.
  assert.equal(pushed[0].message.category, 'fleet.holder.join');
  assert.equal(pushed[0].message.drawnByApp, true);
  assert.equal(pushed[0].message.wake, true);
  assert.match(pushed[0].message.body, /The phone that made it lets it in by itself/);
  // Asking again with the same key and proof, as a machine that retries does,
  // keeps the one request and does not tell anybody twice.
  assert.equal((await core.holderJoin(first.body)).status, 202);
  assert.equal(pushed.length, 1);
  const [held] = core.holdersFor({ email: ELI });
  assert.deepEqual(held.requests.map((q) => [q.key, q.proof]), [[first.keyHash, first.body.proof]]);
  assert.deepEqual(held.requests[0].publicJwk, first.publicJwk, 'the key the phone checks the proof over and enrols');
});

test('a request for a name nobody reserved, or not a request at all, is refused and kept nowhere', async () => {
  const { core, asking } = await fleet();
  assert.equal((await core.holderJoin((await asking(SECRET, 'holder-000000')).body)).body.error.code, 'not_reserved');
  assert.equal((await core.holderJoin({ hostId: 'holder-000000' })).status, 400);
  assert.equal((await core.holderJoin({ ...(await asking()).body, proof: 'not hex' })).status, 400);
});

test('strangers who learned the name can add requests beside the machine’s, and cannot push it out past the few kept', async () => {
  const { core, asking } = await fleet();
  const real = await asking();
  await core.holderJoin(real.body);
  // The coordinator cannot tell which is real; the phone can, with the secret.
  for (let i = 0; i < MAX_REQUESTS + 2; i++) await core.holderJoin((await asking('cd'.repeat(32))).body);
  const kept = core.holdersFor({ email: ELI })[0].requests;
  assert.equal(kept.length, MAX_REQUESTS, 'a few per name, so the store has a ceiling');
  assert.equal(kept.some((q) => q.key === real.keyHash), false, 'and the newest win, so a flood hides the real one until it asks again');
  await core.holderJoin(real.body);
  assert.equal(core.holdersFor({ email: ELI })[0].requests[0].key, real.keyHash, 'which a machine waiting to be let in does');
});

test('a flood of requests under the name is one ring entry and one push a window, not one each', async () => {
  // The route needs no credential and the coordinator cannot check a proof, so
  // every fresh key was a holder.asked entry in the shared 200-entry ring and
  // a buzz on the owner's phone: 210 requests evicted the whole stored
  // history and sent 210 pushes in the second Workers audit.
  const { core, pushed, asking, tick } = await fleet();
  for (let i = 0; i < 50; i++) assert.equal((await core.holderJoin((await asking('cd'.repeat(32))).body)).status, 202);
  assert.equal(core.events.filter((e) => e.event === 'holder.asked').length, 1);
  assert.equal(pushed.length, 1);
  // A name still waited on later is news again.
  tick(REFUSAL_EVERY_MS);
  await core.holderJoin((await asking()).body);
  assert.equal(core.events.filter((e) => e.event === 'holder.asked').length, 2);
  assert.equal(pushed.length, 2);
});

test('its owner lets it in by its key: it joins as a permanent host of nobody’s, and the name is not waited on any more', async () => {
  const { core, minted, asking } = await fleet();
  const req = await asking();
  await core.holderJoin(req.body);
  assert.equal((await core.approveHolder({ email: 'ops@example.com' }, minted.hostId, { key: req.keyHash })).status, 404, 'only the person who made it');
  assert.equal((await core.approveHolder({ email: ELI }, minted.hostId, { key: 'e'.repeat(64) })).status, 404, 'only a key that asked');
  const ok = await core.approveHolder({ email: ELI }, minted.hostId, { key: req.keyHash });
  assert.equal(ok.status, 200, ok.body.text);
  assert.equal(ok.body.address, XO);
  const host = core.hostIds.get(minted.hostId);
  assert.deepEqual(host?.publicJwk, req.publicJwk);
  assert.equal(host?.ephemeral, false, 'a machine that holds a pool is not swept like a session’s');
  assert.equal(host?.owner ?? null, null);
  assert.ok(core.events.some((e) => e.event === 'holder.approved' && e.hostId === minted.hostId));
  assert.deepEqual(core.holdersFor({ email: ELI }), []);
  assert.equal((await core.holderJoin(req.body)).body.error.code, 'not_reserved', 'and it cannot be asked under again');
});

test('a machine that joined with its pin is not waited on, and approving a request for it changes nothing', async () => {
  const { core, minted, asking } = await fleet();
  const req = await asking();
  await core.holderJoin(req.body);
  const spent = await core.enrollment.redeem(minted.pin, 'host', minted.hostId);
  assert.equal(spent.ok, true);
  const pinned = await generateKeyPair();
  await core.hostIds.enrol({ hostId: minted.hostId, publicJwk: pinned.publicJwk });
  const before = core.hostIds.get(minted.hostId)?.publicJwk;
  assert.equal((await core.approveHolder({ email: ELI }, minted.hostId, { key: req.keyHash })).status, 409);
  assert.deepEqual(core.hostIds.get(minted.hostId)?.publicJwk, before, 'the key it joined with is kept');
  assert.deepEqual(core.holdersFor({ email: ELI }), []);
});

test('declining one request keeps the name held for the right one', async () => {
  const { core, minted, asking } = await fleet();
  const stranger = await asking('cd'.repeat(32));
  await core.holderJoin(stranger.body);
  assert.equal(core.declineHolder({ email: ELI }, minted.hostId, { key: stranger.keyHash }).status, 200);
  assert.deepEqual(core.holdersFor({ email: ELI }).map((h) => [h.hostId, h.requests.length]), [[minted.hostId, 0]]);
  assert.equal((await core.holderJoin((await asking()).body)).status, 202);
});

test('a name waits a day, then is gone', async () => {
  const { core, asking, tick } = await fleet();
  tick(HOLDER_JOIN_TTL_MS);
  assert.deepEqual(core.holdersFor({ email: ELI }), []);
  assert.equal((await core.holderJoin((await asking()).body)).body.error.code, 'not_reserved');
});

test('on the Worker, a machine asks without a credential, and the request outlives an eviction', async () => {
  const storage = new Map();
  const state = {
    storage: {
      get: async (/** @type {string} */ k) => storage.get(k),
      put: async (/** @type {string} */ k, /** @type {any} */ v) => storage.set(k, JSON.parse(JSON.stringify(v))),
    },
    blockConcurrencyWhile: (/** @type {() => any} */ fn) => fn(),
    getWebSockets: () => [],
    setAlarm: () => {},
  };
  const ADMIN = 'a-token-at-least-16ch';
  const fleetDo = new Fleet(/** @type {any} */ (state), { FLEETWRIGHT_API_TOKEN: ADMIN });
  const env = { FLEET: { idFromName: () => 'id', get: () => fleetDo }, FLEETWRIGHT_API_TOKEN: ADMIN };
  await new Promise((r) => setTimeout(r, 10)); // its own restore, first
  const reserved = fleetDo.core.holderJoins.reserve({ hostId: 'holder-0a0b0c', owner: ELI, address: XO, job: JOB });
  assert.ok(reserved);
  const { publicJwk } = await generateKeyPair();
  const keyHash = await keyHashOf(/** @type {any} */ (publicJwk));
  const body = { hostId: 'holder-0a0b0c', publicJwk, proof: await proofOf(SECRET, { hostId: 'holder-0a0b0c', address: XO, keyHash }) };
  const res = await worker.fetch(
    new Request('https://fleet.example/api/holder/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    /** @type {any} */ (env),
  );
  assert.equal(res.status, 202, await res.text());
  await new Promise((r) => setImmediate(r));
  // Constructed over the same storage, as the object after an eviction is;
  // it restores in its constructor.
  const after = new Fleet(/** @type {any} */ (state), { FLEETWRIGHT_API_TOKEN: ADMIN });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(after.core.holdersFor({ email: ELI }).map((h) => h.requests.map((q) => q.key)), [[keyHash]]);

  // And Eli's phone lets it in, through the route, and the enrolment is stored.
  const issued = await after.core.issueClient({ email: ELI, name: 'Eli' }, 'a phone');
  assert.ok('token' in issued && issued.token);
  const afterEnv = { ...env, FLEET: { idFromName: () => 'id', get: () => after } };
  const approve = (/** @type {string} */ token) =>
    worker.fetch(
      new Request('https://fleet.example/api/holders/holder-0a0b0c/approve', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ key: keyHash }) }),
      /** @type {any} */ (afterEnv),
    );
  const ok = await approve(/** @type {string} */ (issued.token));
  assert.equal(ok.status, 200, await ok.text());
  assert.ok((/** @type {any[]} */ (storage.get('hostIds')) || []).some((h) => h.hostId === 'holder-0a0b0c'), 'an eviction now keeps the machine it let in');
});
