// The verb an engine is signed in on a machine with (docs/engines.md,
// "Signing in on the machine"): what the protocol takes for it, what an
// older box is told, and that a delegation carries it for a member only by
// naming that member.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PROTOCOL_VERSION, buildIntent, validateIntent } from '../src/fleet/protocol/intents.js';
import { delegationGap, delegationMemberGap } from '../src/fleet/protocol/intent-signature.js';
import { newSealKey, canSealTo } from '../src/fleet/seal.js';

const envelope = (/** @type {Record<string, unknown>} */ params, v = PROTOCOL_VERSION) => ({ v, kind: 'intent', id: 'signin-0001', verb: 'enginesignin', params, issuedAt: Date.now(), actor: 'eli@example.com' });

test('enginesignin names a member, one of two engines and one of four actions, and nothing else', () => {
  for (const engine of ['codex', 'opencode']) {
    for (const action of ['start', 'status', 'cancel', 'signout']) {
      assert.equal(validateIntent(envelope({ member: 'debbie', engine, action })).ok, true, `${engine} ${action}`);
    }
  }
  // Claude Code is signed in through the vault, and an engine on a key has no sign-in.
  for (const bad of [
    { member: 'debbie', engine: 'claude-code', action: 'start' },
    { member: 'debbie', engine: 'codex', action: 'renew' },
    { member: 'Debbie Smith', engine: 'codex', action: 'start' },
    { member: 'debbie@members.invalid', engine: 'codex', action: 'start' },
    // No member is nobody's engine: a person names their own record.
    { engine: 'codex', action: 'start' },
    { member: 'debbie', action: 'start' },
    { member: 'debbie', engine: 'codex' },
    // What the answer is sealed to is a seal key in the form a vault request's is, or it is refused by its shape.
    { member: 'debbie', engine: 'codex', action: 'start', reply: 'not-a-key' },
    { member: 'debbie', engine: 'codex', action: 'start', reply: `${'A'.repeat(86)}=` },
    // Nothing a caller could put a sign-in or a place in.
    { member: 'debbie', engine: 'codex', action: 'start', token: 'x' },
    { member: 'debbie', engine: 'codex', action: 'start', host: 'ops-box' },
  ]) {
    const r = validateIntent(envelope(bad));
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(/** @type {any} */ (r).code, 'bad_params', JSON.stringify(bad));
  }
});

test('a phone may name the key its answer is sealed to, and a string that is not one is refused in words', async () => {
  const { publicKey } = await newSealKey();
  for (const action of ['start', 'status', 'cancel', 'signout']) {
    assert.equal(validateIntent(envelope({ member: 'debbie', engine: 'codex', action, reply: publicKey })).ok, true, action);
  }
  const bad = /** @type {any} */ (validateIntent(envelope({ member: 'debbie', engine: 'codex', action: 'start', reply: 'not-a-key' })));
  assert.deepEqual([bad.code, bad.error], ['bad_params', 'enginesignin.reply is not in the form a P-256 public key']);
  // The right length and alphabet is all a pattern can ask. Whether it is a key is asked by using it, before anything is started.
  assert.deepEqual([await canSealTo(publicKey), await canSealTo('A'.repeat(87)), await canSealTo('not-a-key'), await canSealTo(undefined)], [true, false, false, false]);
});

test('nothing of an engine sign-in can be built for a box that speaks 21, and the refusal says to update it', () => {
  assert.throws(
    () => buildIntent({ id: 'signin-0002', verb: 'enginesignin', params: { member: 'debbie', engine: 'codex', action: 'start' }, actor: 'eli@example.com', speaks: 21 }),
    /this host speaks protocol 21 and enginesignin\.member needs 22 — update the host, then retry/,
  );
  const now = buildIntent({ id: 'signin-0003', verb: 'enginesignin', params: { member: 'debbie', engine: 'codex', action: 'start' }, actor: 'eli@example.com', speaks: 22 });
  assert.deepEqual([now.v, now.params], [22, { member: 'debbie', engine: 'codex', action: 'start' }]);
});

test('a delegation carries an engine sign-in for a member only when it names that member', () => {
  const now = Date.UTC(2026, 10, 25);
  /** @type {any} */
  const grant = { v: 1, id: 'd-1', actor: 'eli@example.com', verbs: ['enginesignin', 'start'], hosts: ['*'], match: {}, issuedAt: now - 1000, expires: now + 3_600_000 };
  const ask = { actor: 'eli@example.com', verb: 'enginesignin', params: { member: 'debbie', engine: 'codex', action: 'start' } };
  // No list is no member, as for a start.
  assert.equal(delegationGap(grant, ask, 'ops-box', now), 'it does not cover signing an engine in for debbie');
  assert.equal(delegationGap({ ...grant, members: ['ada'] }, ask, 'ops-box', now), 'it does not cover signing an engine in for debbie');
  assert.equal(delegationGap({ ...grant, members: ['ada', 'debbie'] }, ask, 'ops-box', now), null);
  // `status` answers with the code, so it is held to the list like the rest.
  assert.equal(delegationMemberGap(grant, { ...ask, params: { ...ask.params, action: 'status' } }), 'it does not cover signing an engine in for debbie');
  // A start's own words are unchanged.
  assert.equal(delegationMemberGap(grant, { verb: 'start', params: { member: 'debbie' } }), 'it does not cover starting a session as debbie');
});
