// The walls between a host's decide frame and money
// (core.js #onHostDecide, src/fleet/coordinator/decide.js).
//
// Driven the way a host drives it: a `decide` frame into onHostMessage, a
// `decided` frame back on the host's socket. The model is a counter, so every
// test can say whether it was spent on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { maskPane } from '../src/core/mask-pane.js';
import { readFileSync } from 'node:fs';
import { MAX_DECIDE_NEURONS_PER_DAY, NEURONS_PER_INPUT_TOKEN, DECIDE_TIMEOUT_MS, estimateNeurons } from '../src/fleet/coordinator/decide.js';

const STATE = maskPane(readFileSync(new URL('./fixtures/claude-2.1.234-trust.txt', import.meta.url), 'utf8'));
const ANSWER = { answers: { asked: { type: 'noul', noul: 0.94 }, kind: { type: 'choice', choice: 'trust', confidence: 0.81 } }, usage: { input_tokens: 455, output_tokens: 0 } };

/**
 * A coordinator with one connected host and a model that counts its calls.
 *
 * @param {{ budget?: unknown, ask?: (s: string) => Promise<any>, rateLimit?: () => Promise<boolean>, decide?: boolean, clock?: { t: number }, timers?: Function[] }} [o]
 */
function fleet(o = {}) {
  const clock = o.clock ?? { t: Date.UTC(2026, 9, 31, 12) };
  const asked = /** @type {string[]} */ ([]);
  const warned = /** @type {string[]} */ ([]);
  const timers = o.timers ?? [];
  const core = new CoordinatorCore({
    now: () => clock.t,
    logger: { info() {}, debug() {}, error() {}, warn: (/** @type {string} */ m) => warned.push(m) },
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer: () => {},
    decide:
      o.decide === false
        ? null
        : {
            ask: o.ask ?? (async (s) => (asked.push(s), ANSWER)),
            rateLimit: o.rateLimit ?? (async () => true),
            budget: o.budget,
          },
  });
  const replies = /** @type {any[]} */ ([]);
  core.registry.connect('box-1', (/** @type {any} */ f) => replies.push(f), {});
  let n = 0;
  /** @param {Record<string, unknown>} [extra] */
  const ask = async (extra = {}) => {
    const id = `decide-${String(++n).padStart(4, '0')}`;
    await core.onHostMessage('box-1', { v: 1, kind: 'decide', hostId: 'box-1', id, name: 'work', hash: 'h', state: STATE, ...extra });
    return replies.find((r) => r.id === id);
  };
  return { core, ask, asked, warned, clock, replies };
}

test('off unless the Durable Object handed it a model, and then nothing is spent', async () => {
  const f = fleet({ decide: false });
  assert.deepEqual(await f.ask(), { v: f.replies[0].v, kind: 'decided', id: 'decide-0001', ok: false, why: 'off' });
});

test('an answer is the model\'s, with the dialog only as evidence', async () => {
  const f = fleet();
  const r = await f.ask();
  assert.equal(r.ok, true);
  assert.equal(r.asked, true);
  assert.equal(r.p, 0.94);
  assert.equal(r.dialog, 'trust');
  assert.ok(!('prompt' in r) && !('answer' in r) && !('promptId' in r));
  assert.equal(f.asked.length, 1);
});

test('a gate refusal is an answer and a count, the log names the host and the rule, and never the text', async () => {
  const f = fleet();
  const r = await f.ask({ state: 'token sk-ant-oat01 please' });
  assert.deepEqual([r.ok, r.why], [false, 'refused:credential-shape']);
  assert.equal(f.asked.length, 0);
  assert.equal(f.core.decideLimits.snapshot().refused, 1);
  assert.ok(f.warned.some((m) => m.includes('box-1') && m.includes('credential-shape')));
  assert.ok(!f.warned.some((m) => m.includes('sk-ant')), 'the refused text reached the log');
});

test('the platform rate limit, and a limit that cannot be asked, both refuse before any spend', async () => {
  for (const rateLimit of [async () => false, async () => { throw new Error('binding gone'); }]) {
    const f = fleet({ rateLimit });
    assert.equal((await f.ask()).why, 'ratelimited');
    assert.equal(f.asked.length, 0);
    assert.equal(f.core.decideLimits.snapshot().today, 0);
  }
});

test('one decision per session per ten minutes, twenty per host per hour', async () => {
  const f = fleet();
  assert.equal((await f.ask()).ok, true);
  assert.equal((await f.ask()).why, 'ratelimited', 'the same session was asked about twice inside ten minutes');
  for (let i = 0; i < 19; i++) assert.equal((await f.ask({ name: `s${i}` })).ok, true);
  assert.equal((await f.ask({ name: 'one-more' })).why, 'ratelimited', 'a 21st ask in the hour went through');
  assert.equal(f.asked.length, 20);
});

test('the day\'s budget refuses before the call, and each call is reconciled to its real tokens', async () => {
  const f = fleet({ budget: '4' });
  assert.equal((await f.ask()).ok, true);
  // 455 tokens is 1.57 neurons; the estimate it replaced was larger, because
  // a pre-charge that under-estimates lets the day overrun its budget.
  assert.ok(estimateNeurons(Buffer.byteLength(STATE)) > 455 * NEURONS_PER_INPUT_TOKEN);
  assert.equal(f.core.decideLimits.snapshot().today, Math.round(455 * NEURONS_PER_INPUT_TOKEN * 100) / 100);
  assert.equal((await f.ask({ name: 'other' })).why, 'budget');
  assert.equal(f.asked.length, 1);
});

test('the spend and the windows survive a rebuild, and the day turns over at 00:00 UTC', async () => {
  const clock = { t: Date.UTC(2026, 9, 31, 23, 50) };
  const before = fleet({ budget: '4', clock });
  await before.ask();
  const saved = JSON.parse(JSON.stringify(before.core.decideLimits.serialise()));

  const after = fleet({ budget: '4', clock });
  after.core.decideLimits.restore(saved);
  assert.equal((await after.ask({ name: 'other' })).why, 'budget', 'a rebuilt object forgot the day\'s spend');
  assert.equal((await after.ask()).why, 'ratelimited', 'a rebuilt object forgot the session\'s window');

  clock.t = Date.UTC(2026, 10, 1, 0, 1);
  assert.equal((await after.ask({ name: 'third' })).ok, true, 'the budget did not reset with the UTC day');
});

test('a budget in [vars] above the hard ceiling is the ceiling', () => {
  assert.equal(fleet({ budget: '10000000' }).core.decideLimits.budget, MAX_DECIDE_NEURONS_PER_DAY);
  assert.equal(fleet({ budget: 'lots' }).core.decideLimits.budget, 8000);
});

test('a model that does not answer is an error after eight seconds, once, and stays charged', async () => {
  const timers = /** @type {Function[]} */ ([]);
  let calls = 0;
  const f = fleet({ timers, ask: () => (calls++, new Promise(() => {})) });
  const pending = f.ask();
  await new Promise((r) => setImmediate(r));
  assert.equal(timers.length, 1);
  timers[0]();
  const r = await pending;
  assert.deepEqual([r.ok, r.why], [false, 'error']);
  assert.equal(calls, 1, 'retried');
  assert.ok(f.core.decideLimits.snapshot().today > 0, 'a call that never came back was refunded');
  assert.equal(DECIDE_TIMEOUT_MS, 8000);
});
