// What the coordinator does with a device's signature on the way to a box.
// docs/signed-intents.md.
//
//   node --test test/signed-carry.test.js
//
// The box checks a signature over the id, the person, the box and the
// parameters (intent-signature.js). The coordinator rewrites intents in several
// places of its own accord, and every one of those breaks that signature. Sent
// on, each would reach the box as a signature that does not hold, which is the
// count that means somebody tampered with it. So a signature travels only with
// what it was made over, and anything else goes unsigned.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { generateKeyPair, sign } from '../src/fleet/crypto.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { delegationSigningInput, intentSigningInput, keyId } from '../src/fleet/protocol/intent-signature.js';
import { validateIntent } from '../src/fleet/protocol/intents.js';

const NINA = 'nina@example.test';
const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

/** Nina's, on box-b: what the session verbs below name. */
const BUILD = { name: 'nightly', status: 'running', createdBy: `fleet:${NINA}`, prompt: { id: 'p-1', kind: 'permission', options: [{ index: 1, label: 'Yes' }, { index: 2, label: 'No' }] } };

/** @param {string} hostId @param {number} [protocol] */
const health = (hostId, protocol = PROTOCOL_VERSION) => ({
  hostId, protocol, labels: [], maxSessions: 5, running: 0, free: 5, resumable: [], sessions: hostId === 'box-b' ? [BUILD] : [],
  loadavg: [0, 0, 0], loggedIn: true, claudeAccounts: 1, hub: { reachable: true }, sandboxed: true,
  // box-strict runs with FLEETWRIGHT_REQUIRE_SIGNED=1, as its health says.
  ...(hostId === 'box-strict' ? { signatures: { keys: 1, keysAt: Date.now(), checked: {}, enforcing: true } } : {}),
  // box-signers enforces for the people it has seen a key for, which only it
  // knows, and refuses what reaches it unsigned as the sidecar does.
  ...(hostId === 'box-signers' ? { signatures: { keys: 1, keysAt: Date.now(), checked: {}, enforcing: 'signers' } } : {}),
});

/** What box-signers answers, the sidecar's words for each. @param {any} msg */
const signersAnswer = (msg) => (msg.sig || msg.delegation
  ? { ok: true, text: 'done' }
  : { ok: false, error: { code: 'signature_required' }, text: `box-signers takes only requests a person signed, and this ${msg.verb} from ${msg.actor} was not signed. Nothing was done.` });

async function fleet() {
  const core = new CoordinatorCore({ intentTimeoutMs: 2_000, logger: QUIET });
  /** @type {Record<string, any[]>} */
  const sent = { 'box-a': [], 'box-b': [], 'box-old': [], 'box-strict': [], 'box-signers': [] };
  for (const id of Object.keys(sent)) {
    core.hostConnected(id, (/** @type {any} */ msg) => {
      sent[id].push(msg);
      // Every intent answered, so each dispatch settles.
      if (msg.kind === 'intent') {
        const answer = id === 'box-signers' ? signersAnswer(msg) : { ok: true, text: 'done' };
        queueMicrotask(() => void core.onHostMessage(id, { v: PROTOCOL_VERSION, kind: 'reply', id: msg.id, ...answer }));
      }
    });
    await core.onHostMessage(id, { v: PROTOCOL_VERSION, kind: 'health', hostId: id, health: health(id, id === 'box-old' ? 2 : PROTOCOL_VERSION) });
  }
  const { publicJwk, privateJwk } = await generateKeyPair();
  const kid = await keyId({ kty: 'EC', crv: 'P-256', x: String(publicJwk.x), y: String(publicJwk.y) });
  let n = 0;
  /**
   * A request from Nina's phone, signed for `host` over the params it sends.
   * Unsigned, with `{ unsigned: true }`: the app before its key is listed, or MCP.
   * @param {string} verb @param {Record<string, unknown>} params @param {string} host @param {{ unsigned?: boolean }} [opts]
   */
  const ask = async (verb, params, host, { unsigned = false } = {}) => {
    const id = `signed-intent-${String(++n).padStart(4, '0')}`;
    const issuedAt = Date.now();
    const sig = await sign(privateJwk, intentSigningInput({ actor: NINA, id, issuedAt, params, verb }, host));
    const before = Object.fromEntries(Object.entries(sent).map(([h, frames]) => [h, frames.length]));
    const r = await core.dispatch({ verb, params, id, actor: NINA, requester: { email: NINA, admin: true }, ...(host ? { preferHost: host } : {}), ...(unsigned ? {} : { sig, kid, issuedAt }) });
    /** The intents this request put on each socket. */
    const frames = Object.entries(sent).flatMap(([h, all]) => all.slice(before[h]).filter((m) => m.kind === 'intent').map((m) => ({ host: h, ...m })));
    return { r, frames, sig };
  };
  return { ask, core, sent, privateJwk, kid };
}

test('a signature reaches the box with what it was made over, and goes nowhere else', async () => {
  const { ask } = await fleet();

  // TO THE BOX NAMED, AS SIGNED: carried, `boxSecrets` added by the
  // coordinator and all (it is the coordinator's word, setBy: 'fleet').
  const plain = await ask('start', { name: 'build' }, 'box-a');
  assert.equal(plain.r.ok, true, plain.r.text);
  assert.deepEqual(plain.frames.map((f) => [f.host, f.sig]), [['box-a', plain.sig]]);
  assert.ok('boxSecrets' in plain.frames[0].params);

  // A VALUE CHECKPARAMS CLEANS: what the box gets is not what was signed.
  const spaced = await ask('start', { name: 'tidy', title: 'two  spaces' }, 'box-a');
  assert.equal(spaced.frames[0].params.title, 'two spaces');
  assert.equal(spaced.frames[0].sig, undefined, 'a signature over a value the coordinator changed was sent on');

  // A PARAMETER DROPPED FOR A BOX TOO OLD FOR IT (`profile` is protocol 3).
  const old = await ask('start', { name: 'legacy', profile: 'ci' }, 'box-old');
  assert.equal(old.r.ok, true, old.r.text);
  assert.equal(old.frames[0].params.profile, undefined);
  assert.equal(old.frames[0].sig, undefined);

  // A FAN-OUT: every box under an id of the coordinator's, none of them the
  // box it was signed for.
  const all = await ask('verify', { provider: 'github' }, '');
  assert.ok(all.frames.length >= 2, `fanned out to ${all.frames.length}`);
  assert.deepEqual(all.frames.map((f) => f.sig), all.frames.map(() => undefined));
});

// A SESSION'S VERBS GO WHERE THE SESSION IS, whatever box the caller names: the
// coordinator ignores the name for routing them (scheduler.js, PINNED). So the
// phone names the box its list showed the session on and signs for that, and
// the signature travels when the session is still there. When it is not, the
// work still reaches the box that holds it, unsigned, as an intent the phone
// did not sign for that box.
test('a signed session verb is carried to the box holding the session, and sent unsigned when the phone named another', async () => {
  const { ask } = await fleet();
  for (const [verb, params] of /** @type {const} */ ([
    ['stop', { name: 'nightly' }],
    ['peek', { name: 'nightly' }],
    ['answer', { name: 'nightly', option: 1, promptId: 'p-1' }],
    ['forget', { name: 'nightly' }],
  ])) {
    const there = await ask(verb, params, 'box-b');
    assert.deepEqual(there.frames.map((f) => [f.host, f.sig]), [['box-b', there.sig]], `${verb} to the box holding it`);
    const elsewhere = await ask(verb, params, 'box-a');
    assert.deepEqual(elsewhere.frames.map((f) => [f.host, f.sig]), [['box-b', undefined]], `${verb} signed for another box`);
  }
});

// A BOX THAT TAKES ONLY SIGNED REQUESTS says so in its health, and the
// coordinator refuses there what the box would refuse, saying which of two
// things is true that the box cannot tell apart: nobody signed it, or somebody
// did and the fleet changed it. Nothing is sent either way, and what needs no
// signature still goes.
test('a box that enforces is sent what a person signed, and nothing unsigned that needs a signature', async () => {
  const { ask } = await fleet();

  const signed = await ask('start', { name: 'strict-ok' }, 'box-strict');
  assert.equal(signed.r.ok, true, signed.r.text);
  assert.deepEqual(signed.frames.map((f) => [f.host, f.sig]), [['box-strict', signed.sig]]);

  const bare = await ask('start', { name: 'strict-bare' }, 'box-strict', { unsigned: true });
  assert.equal(bare.r.error?.code, 'signature_required');
  assert.match(bare.r.text, /box-strict takes only requests a person signed, and nothing nina@example\.test signed covers this start/);
  assert.deepEqual(bare.frames, []);

  // Signed, then tidied here: checkParams collapses the two spaces.
  const changed = await ask('start', { name: 'strict-tidy', title: 'two  spaces' }, 'box-strict');
  assert.equal(changed.r.error?.code, 'signature_required');
  assert.match(changed.r.text, /changed on its way through the fleet/);
  assert.deepEqual(changed.frames, []);

  // `list` needs no signature anywhere, so the fan-out still reaches it.
  const listed = await ask('list', {}, '', { unsigned: true });
  assert.ok(listed.frames.some((f) => f.host === 'box-strict'), 'list did not reach the enforcing box');

  // And a box that does not enforce still takes the unsigned request.
  const elsewhere = await ask('start', { name: 'relaxed' }, 'box-a', { unsigned: true });
  assert.equal(elsewhere.r.ok, true, elsewhere.r.text);
  assert.deepEqual(elsewhere.frames.map((f) => f.host), ['box-a']);
});

// WHAT THE FLEET SENDS IN A PERSON'S NAME WHILE THEY ARE NOT THERE carries what
// they signed earlier to allow it: a delegation, kept here and attached by
// `send` to whatever it covers. The box checks it; this side only chooses
// which to carry, so a box that enforces is sent the unsigned request with it,
// and refused here only when nothing the person signed covers it.
test('an unsigned request goes to a box that enforces with a delegation that covers it, and not without one', async () => {
  const { ask, core, privateJwk, kid } = await fleet();
  const now = Date.now();
  /** @param {Record<string, any>} over */
  const delegation = async (over = {}) => {
    const grant = { v: 1, id: `held-start-${Math.random().toString(36).slice(2, 12)}`, actor: NINA, verbs: ['start'], hosts: ['*'], match: { name: 'held' }, issuedAt: now, expires: now + 3_600_000, ...over };
    return { grant, sig: await sign(privateJwk, delegationSigningInput(grant)), kid };
  };

  // Nothing kept: refused here, as before.
  assert.equal((await ask('start', { name: 'held' }, 'box-strict', { unsigned: true })).r.error?.code, 'signature_required');

  // Somebody else's is not kept for Nina, nor hers for somebody else.
  const ninas = await delegation();
  assert.equal(core.keepDelegation('kim@example.test', ninas).error?.code, 'not_yours');
  assert.equal(core.keepDelegation(NINA, { ...ninas, grant: { ...ninas.grant, hosts: ['*', 'box-a'] } }).error?.code, 'bad_params');

  // Kept: carried with the start it covers, whole, and in the shape the box
  // reads it in.
  assert.equal(core.keepDelegation(NINA, ninas).ok, true);
  const held = await ask('start', { name: 'held' }, 'box-strict', { unsigned: true });
  assert.equal(held.r.ok, true, held.r.text);
  assert.equal(held.frames.length, 1);
  assert.deepEqual(held.frames[0].delegation, ninas);
  const atBox = validateIntent(held.frames[0]);
  assert.equal(atBox.ok, true);
  assert.deepEqual(/** @type {any} */ (atBox).intent.delegation, ninas);

  // Not for another session name, which is what she signed it with.
  assert.equal((await ask('start', { name: 'other' }, 'box-strict', { unsigned: true })).r.error?.code, 'signature_required');

  // A request she signed herself travels with her signature, not the delegation.
  const signed = await ask('start', { name: 'held' }, 'box-strict');
  assert.equal(signed.frames[0].sig, signed.sig);
  assert.equal(signed.frames[0].delegation, undefined);

  // Withdrawn: no longer carried.
  assert.equal(core.dropDelegation({ email: NINA }, ninas.grant.id).ok, true);
  assert.deepEqual(core.delegationsFor({ email: NINA }), []);
  assert.equal((await ask('start', { name: 'held' }, 'box-strict', { unsigned: true })).r.error?.code, 'signature_required');

  // Carried inline with the request that needs it, as a phone sends one for a
  // request the fleet places, and kept for the person asking.
  const inline = await delegation({ match: { name: 'placed' } });
  const r = await core.dispatch({ verb: 'start', params: { name: 'placed' }, actor: NINA, requester: { email: NINA, admin: true }, preferHost: 'box-strict', delegation: inline });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(core.delegationsFor({ email: NINA }).map((g) => g.id), [inline.grant.id]);
});

test('a box that enforces for the people it knows says what would have carried a request it refused unsigned', async () => {
  const { ask, core, privateJwk, kid } = await fleet();

  // Sent, because only the box knows whether it has seen Nina's key, and
  // refused there. The box says it was not signed; the fleet says what Nina
  // can do about it, which is the MCP client's whole way out.
  const bare = await ask('start', { name: 'from-mcp' }, 'box-signers', { unsigned: true });
  assert.equal(bare.frames.length, 1, 'sent to the box, which decides');
  assert.equal(bare.r.error?.code, 'signature_required');
  assert.match(bare.r.text, /^box-signers takes only requests a person signed, and this start from nina@example\.test was not signed\. Nothing was done\. /);
  assert.match(bare.r.text, /allow an MCP client under Delegations on the You tab/);

  // With the phone's MCP delegation kept, the same request carries it and is
  // taken.
  const now = Date.now();
  const grant = { v: 1, id: 'mcp-client-0123456789', actor: NINA, verbs: ['start', 'stop', 'resume'], hosts: ['*'], match: {}, issuedAt: now, expires: now + 86_400_000 };
  assert.equal(core.keepDelegation(NINA, { grant, sig: await sign(privateJwk, delegationSigningInput(grant)), kid }).ok, true);
  const carried = await ask('start', { name: 'from-mcp' }, 'box-signers', { unsigned: true });
  assert.equal(carried.r.ok, true, carried.r.text);
  assert.equal(carried.frames[0].delegation.grant.id, grant.id);
});

test('a renewal replaces what it renews, and a person’s short delegations give way to new ones', async () => {
  const { Delegations, MAX_DELEGATIONS_PER_PERSON } = await import('../src/fleet/coordinator/delegations.js');
  const store = new Delegations();
  const { privateJwk, publicJwk } = await generateKeyPair();
  const kid = await keyId({ kty: 'EC', crv: 'P-256', x: String(publicJwk.x), y: String(publicJwk.y) });
  let n = 0;
  const make = async (/** @type {Record<string, any>} */ over) => {
    const grant = { v: 1, id: `grant-${String(++n).padStart(12, '0')}`, actor: NINA, verbs: ['provision'], hosts: ['*'], match: { template: 't-1' }, issuedAt: Date.now(), expires: Date.now() + 20 * 86_400_000, ...over };
    return { grant, sig: await sign(privateJwk, delegationSigningInput(grant)), kid };
  };
  // Keeping machines ready, renewed every day: one kept, the newest.
  for (let i = 0; i < 3; i++) assert.equal(store.put(NINA, await make({ expires: Date.now() + (20 + i) * 86_400_000 })).ok, true);
  assert.deepEqual(store.listFor(NINA).map((g) => g.id), [`grant-${String(3).padStart(12, '0')}`]);
  // A request the fleet places, signed for ten minutes each, more than the
  // allowance holds: the nearest its end gives way each time.
  for (let i = 0; i < MAX_DELEGATIONS_PER_PERSON + 4; i++) {
    assert.equal(store.put(NINA, await make({ verbs: ['start'], match: { name: `job-${i}` }, expires: Date.now() + 600_000 + i })).ok, true, `placed request ${i}`);
  }
  assert.equal(store.listFor(NINA).length, MAX_DELEGATIONS_PER_PERSON);
  assert.ok(store.listFor(NINA).some((g) => g.verbs[0] === 'provision'), 'a standing delegation gave way to a short one');
  // Standing ones are never dropped to make room.
  const full = new Delegations();
  for (let i = 0; i < MAX_DELEGATIONS_PER_PERSON; i++) assert.equal(full.put(NINA, await make({ match: { template: `t-${i}` } })).ok, true);
  assert.equal(full.put(NINA, await make({ match: { template: 'one-more' } })).error?.code, 'too_many');
});

test('a full delegation store still fits in one Durable Object value', async () => {
  const { Delegations, MAX_DELEGATION_STORE_BYTES } = await import('../src/fleet/coordinator/delegations.js');
  const store = new Delegations();
  const { privateJwk, publicJwk } = await generateKeyPair();
  const kid = await keyId({ kty: 'EC', crv: 'P-256', x: String(publicJwk.x), y: String(publicJwk.y) });
  let refused = false;
  for (let i = 0; i < 5000 && !refused; i++) {
    const actor = `${String(i).padStart(5, '0')}${'e'.repeat(50)}@example.test`;
    const grant = { v: 1, id: `g${String(i).padStart(20, '0')}`, actor, verbs: ['provision', 'vmctl'], hosts: ['*'], match: { template: '0'.repeat(36) }, issuedAt: Date.now(), expires: Date.now() + 86_400_000 };
    const r = store.put(actor, { grant, sig: await sign(privateJwk, delegationSigningInput(grant)), kid });
    if (r.ok === false) refused = true;
  }
  assert.ok(refused, 'the delegation store did not refuse');
  assert.ok(JSON.stringify(store.serialise()).length <= MAX_DELEGATION_STORE_BYTES);
});
