// Answering a prompt is an ordinal into a list the HOST published.
//
// docs/plan.md: send-keys into a Claude Code pane reaches `!` bash mode, slash
// commands, and a root shell after one Ctrl-C. A reply carrying text would be
// strictly worse than the shell string design.md refuses, because it would
// look bounded and would not be.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateIntent, PROTOCOL_VERSION, isMutating } from '../src/fleet/protocol/intents.js';
import { toCommandLine } from '../src/fleet/host/sidecar.js';

const answer = (params) => ({
  v: PROTOCOL_VERSION, kind: 'intent', id: 'abcd1234', verb: 'answer', params, issuedAt: Date.now(),
});

test('an ordinal and a prompt id are what it takes', () => {
  const r = validateIntent(answer({ name: 'job', option: 2, promptId: 'a1b2c3d4' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.intent.params, { name: 'job', option: 2, promptId: 'a1b2c3d4' });
});

test('free text cannot be smuggled in', () => {
  for (const params of [
    { name: 'job', option: 1, text: 'rm -rf /' },
    { name: 'job', option: 1, reply: 'yes' },
    { name: 'job', option: 'yes' },
  ]) {
    assert.equal(validateIntent(answer(params)).ok, false, JSON.stringify(params));
  }
});

test('the ordinal is bounded to what a pane can show', () => {
  assert.equal(validateIntent(answer({ name: 'j', option: 0 })).ok, false);
  assert.equal(validateIntent(answer({ name: 'j', option: 10 })).ok, false);
  for (const n of [1, 5, 9]) assert.equal(validateIntent(answer({ name: 'j', option: n })).ok, true);
});

test('it is mutating -- it presses a key in a live session', () => {
  assert.equal(isMutating('answer'), true);
});

test('nothing free-form reaches the command line', () => {
  const line = toCommandLine({ verb: 'answer', params: { name: 'job', option: 3, promptId: 'deadbeef' } });
  assert.equal(line, '/answer job 3 deadbeef');
  assert.doesNotMatch(line, /[;&|$`]/);
});

test('a missing prompt id is omitted rather than sent empty', () => {
  assert.equal(toCommandLine({ verb: 'answer', params: { name: 'job', option: 1 } }), '/answer job 1');
});
