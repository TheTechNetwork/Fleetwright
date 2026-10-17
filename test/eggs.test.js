// The words this box answers without listing them, the Konami code, and the
// line the console says in the small hours.
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
import { KONAMI, KONAMI_LINE, konamiStep } from '../build/console/konami.js';
import { lateLine } from '../build/console/late.js';

const ctx = /** @type {any} */ ({ cfg: { hostname: 'box', loginEnabled: true }, actor: 'web' });
const say = async (/** @type {string} */ line) => (await dispatch(ctx, line)).text;
// Every word an egg answers to, so the gate test below cannot miss one.
const WORDS = ['xyzzy', 'plugh', 'hello', 'hi', 'panic', 'sudo', 'make', 'up'];

test('the plain words answer, with or without a slash, in any case, whatever follows them', async () => {
  for (const w of ['plugh', 'hello', 'hi', 'panic', 'sudo']) {
    for (const line of [w, `/${w}`, `/${w.toUpperCase()} and then some`]) {
      const reply = await dispatch(ctx, line);
      assert.equal(reply.ok, true, `${line} answered ${reply.text}`);
      assert.doesNotMatch(reply.text, /Unknown command/, line);
    }
  }
});

test('xyzzy is a cave: the fourth time it is the first time again', async () => {
  // One process, one cave. node --test runs each file in its own process, and
  // nothing else in this one types the word, so the count starts at zero.
  assert.equal(await say('xyzzy'), 'Nothing happens.');
  assert.equal(await say('/XYZZY'), 'Nothing happens, again.');
  assert.match(await say('xyzzy'), /maze of twisty little hosts, all alike/);
  assert.equal(await say('xyzzy'), 'Nothing happens.');
});

test('xkcd 149, exactly, and sudo anything else still points at grant', async () => {
  assert.equal(await say('make me a sandwich'), 'What? Make it yourself.');
  assert.equal(await say('/sudo make me a sandwich'), 'Okay.');
  assert.equal(await say('sudo MAKE ME A SANDWICH'), 'Okay.');
  assert.match(await say('sudo rm -rf /'), /sudo fleetwright grant/);
  // `make` on its own is not a word this box knows.
  assert.match(await say('make'), /Unknown command "make"/);
  assert.match(await say('make me a coffee'), /Unknown command "make"/);
});

test('the Konami code typed as words, or as its glyphs, is the console’s own line', async () => {
  assert.equal(await say('up up down down left right left right b a'), KONAMI_LINE);
  assert.equal(await say('/UP up Down down LEFT right left RIGHT B A'), KONAMI_LINE);
  assert.equal(await say('/↑↑↓↓←→←→BA'), KONAMI_LINE);
  assert.match(await say('up up down down'), /Unknown command "up"/);
  assert.match(await say('up up down down left right left right b a start'), /Unknown command "up"/);
});

test('none of them is in /help, and an unknown word is still unknown', async () => {
  const help = helpText(ctx);
  for (const w of WORDS) assert.doesNotMatch(help, new RegExp(`/${w}\\b`), `/help lists ${w}`);
  assert.match(await say('frobnicate'), /Unknown command "frobnicate"/);
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

test('the small hours are one to five, local, and the line carries the time', () => {
  const at = (/** @type {number} */ h, /** @type {number} */ m) => lateLine(new Date(2026, 9, 17, h, m));
  assert.equal(at(0, 59), null);
  assert.match(at(1, 0) ?? '', /^It is 1:00 where you are\./);
  assert.match(at(3, 7) ?? '', /^It is 3:07 where you are\./);
  assert.match(at(4, 59) ?? '', /^It is 4:59 where you are\./);
  assert.equal(at(5, 0), null);
  assert.equal(at(14, 30), null);
  // It never says what the fleet is doing; that is the headline's job.
  assert.doesNotMatch(at(3, 0) ?? '', /needs you|healthy|fine|well/i);
});
