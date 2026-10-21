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
import { intentSigningInput, keyId } from '../src/fleet/protocol/intent-signature.js';

const NINA = 'nina@example.test';
const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

/** Nina's, on box-b: what the session verbs below name. */
const BUILD = { name: 'nightly', status: 'running', createdBy: `fleet:${NINA}`, prompt: { id: 'p-1', kind: 'permission', options: [{ index: 1, label: 'Yes' }, { index: 2, label: 'No' }] } };

/** @param {string} hostId @param {number} [protocol] */
const health = (hostId, protocol = PROTOCOL_VERSION) => ({
  hostId, protocol, labels: [], maxSessions: 5, running: 0, free: 5, resumable: [], sessions: hostId === 'box-b' ? [BUILD] : [],
  loadavg: [0, 0, 0], loggedIn: true, claudeAccounts: 1, hub: { reachable: true }, sandboxed: true,
});

async function fleet() {
  const core = new CoordinatorCore({ intentTimeoutMs: 2_000, logger: QUIET });
  /** @type {Record<string, any[]>} */
  const sent = { 'box-a': [], 'box-b': [], 'box-old': [] };
  for (const id of Object.keys(sent)) {
    core.hostConnected(id, (/** @type {any} */ msg) => {
      sent[id].push(msg);
      // Every intent answered, so each dispatch settles.
      if (msg.kind === 'intent') queueMicrotask(() => void core.onHostMessage(id, { v: PROTOCOL_VERSION, kind: 'reply', id: msg.id, ok: true, text: 'done' }));
    });
    await core.onHostMessage(id, { v: PROTOCOL_VERSION, kind: 'health', hostId: id, health: health(id, id === 'box-old' ? 2 : PROTOCOL_VERSION) });
  }
  const { publicJwk, privateJwk } = await generateKeyPair();
  const kid = await keyId({ kty: 'EC', crv: 'P-256', x: String(publicJwk.x), y: String(publicJwk.y) });
  let n = 0;
  /**
   * A request from Nina's phone, signed for `host` over the params it sends.
   * @param {string} verb @param {Record<string, unknown>} params @param {string} host
   */
  const ask = async (verb, params, host) => {
    const id = `signed-intent-${String(++n).padStart(4, '0')}`;
    const issuedAt = Date.now();
    const sig = await sign(privateJwk, intentSigningInput({ actor: NINA, id, issuedAt, params, verb }, host));
    const before = Object.fromEntries(Object.entries(sent).map(([h, frames]) => [h, frames.length]));
    const r = await core.dispatch({ verb, params, id, actor: NINA, requester: { email: NINA, admin: true }, ...(host ? { preferHost: host } : {}), sig, kid, issuedAt });
    /** The intents this request put on each socket. */
    const frames = Object.entries(sent).flatMap(([h, all]) => all.slice(before[h]).filter((m) => m.kind === 'intent').map((m) => ({ host: h, ...m })));
    return { r, frames, sig };
  };
  return { ask };
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
