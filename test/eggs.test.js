// The words this box answers without listing them, and the Konami code.
//
// What is worth guarding is not the jokes. It is that they stay jokes: found
// only by a person at the box, never shadowing a command, never in /help, and
// never anywhere near a claim about the fleet.

import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatch, helpText, canonicalCommand } from '../src/adapters/commands.js';
import { sidecarMayRun } from '../src/core/sidecar-scope.js';
// From build/, like the console's own tests: node cannot import the .jsx
// around it, and `npm test` builds first.
import { KONAMI, konamiStep } from '../build/console/konami.js';

const ctx = /** @type {any} */ ({ cfg: { hostname: 'box', loginEnabled: true }, actor: 'web' });
const WORDS = ['xyzzy', 'plugh', 'hello', 'hi', 'panic', 'sudo'];

test('each hidden word answers, with or without a slash, and without arguments mattering', async () => {
  for (const w of WORDS) {
    for (const line of [w, `/${w}`, `/${w.toUpperCase()} make me a sandwich`]) {
      const reply = await dispatch(ctx, line);
      assert.equal(reply.ok, true, `${line} answered ${reply.text}`);
      assert.doesNotMatch(reply.text, /Unknown command/, line);
    }
  }
  assert.equal((await dispatch(ctx, 'xyzzy')).text, 'Nothing happens.');
});

test('none of them is in /help, and an unknown word is still unknown', async () => {
  const help = helpText(ctx);
  for (const w of WORDS) assert.doesNotMatch(help, new RegExp(`/${w}\\b`), `/help lists ${w}`);
  assert.match((await dispatch(ctx, 'frobnicate')).text, /Unknown command "frobnicate"/);
});

test('the fleet cannot reach them: the sidecar gate refuses a word it has no command for', () => {
  for (const w of WORDS) {
    assert.equal(canonicalCommand(w), null, `${w} became a command, so the egg is no longer the one answering`);
    assert.equal(sidecarMayRun({ canonical: canonicalCommand(w), args: [] }).ok, false, w);
  }
});

test('the Konami code completes on the sequence and survives one up too many', () => {
  const run = (/** @type {string[]} */ keys) => keys.reduce(konamiStep, 0);
  assert.equal(run(KONAMI), KONAMI.length);
  assert.equal(run(['ArrowUp', ...KONAMI]), KONAMI.length, 'up, up, up, down... still counts');
  assert.equal(run(['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowUp', ...KONAMI]), KONAMI.length, 'a stray key restarts cleanly');
  assert.equal(run([...KONAMI.slice(0, 8), 'B', 'A']), KONAMI.length, 'caps lock does not matter');
  assert.notEqual(run(KONAMI.slice(0, 9)), KONAMI.length);
  assert.equal(run([...KONAMI.slice(0, 5), 'x']), 0);
});
