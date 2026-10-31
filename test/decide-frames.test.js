// The decide / decided frame pair between a host and the coordinator
// (sidecar.js #askDecide, core.js #onHostDecide), end to end over the same
// in-memory wiring vault.test.js uses.
//
// The contract a unit test on either side cannot see: what the watcher's
// `decide` hands the coordinator reaches its walls, the answer comes back on
// the right id, and a host with the feature off never sends a frame at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { Sidecar } from '../src/fleet/host/sidecar.js';
import { maskPane } from '../src/core/mask-pane.js';

/** @param {{ decide: boolean, model?: (state: string) => Promise<any> }} o */
function wired({ decide, model = async () => ({ answers: { asked: { type: 'noul', noul: 0.96 } }, usage: { input_tokens: 420 } }) }) {
  const sent = /** @type {any[]} */ ([]);
  const core = new CoordinatorCore({ decide: { ask: model, rateLimit: async () => true } });
  const sidecar = new Sidecar({
    hub: /** @type {any} */ ({}),
    transport: /** @type {any} */ ({ origin: 'https://fleet.test', onMessage() {}, start: async () => true, stop: async () => {}, send: (/** @type {any} */ f) => { sent.push(f); void core.onHostMessage('box-1', f); return true; } }),
    hostId: 'box-1',
    watch: true,
    decide,
    healthIntervalMs: 0,
    renewIntervalMs: 0,
  });
  core.registry.connect('box-1', (/** @type {any} */ f) => void sidecar.handle(f), {});
  return { sidecar, sent };
}

test('a host with the decision model on asks over the socket and gets the coordinator\'s answer back', async () => {
  const { sidecar, sent } = wired({ decide: true });
  const state = maskPane(' Before we start: is this folder yours?\n ❯ 1. Yes\n   2. No');
  const answer = await /** @type {any} */ (sidecar.watcher).decide({ name: 'work', hash: '123', state });
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['hostId', 'id', 'kind', 'name', 'state', 'v']);
  assert.equal('hash' in sent[0], false, 'the unmasked pane fingerprint left the box');
  assert.equal(sent[0].kind, 'decide');
  assert.deepEqual([answer.kind, answer.id, answer.ok, answer.asked, answer.p], ['decided', sent[0].id, true, true, 0.96]);
});

test('a host with it off has no way to send the frame', () => {
  const { sidecar, sent } = wired({ decide: false });
  assert.equal(/** @type {any} */ (sidecar.watcher).decide, null);
  assert.equal(sent.length, 0);
});
