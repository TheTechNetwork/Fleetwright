// How many releases a box keeps, and why it is not two.
//
// It WAS two — live and previous — written when a release meant a published
// version every few weeks. The rolling channel takes a build on every merge
// (`main-55` on a real host), so "the one before" can be an hour old, and a bad
// build noticed on Monday has nothing to go back to.

import test from 'node:test';
import assert from 'node:assert/strict';

import { releasesToPrune, RELEASES_KEPT } from '../src/core/release.js';

test('fourteen are kept, newest first', () => {
  const present = Array.from({ length: 20 }, (_, i) => `main-${i + 1}`);
  // Newest first is the caller's answer, from mtimes — see prune().
  const newestFirst = [...present].reverse();

  const pruned = releasesToPrune(present, 'main-20', 'main-19', { newestFirst });
  const kept = present.filter((v) => !pruned.includes(v));

  assert.equal(kept.length, RELEASES_KEPT);
  assert.equal(RELEASES_KEPT, 14);
  // The fourteen most recent, and nothing older.
  assert.deepEqual(kept.sort(), newestFirst.slice(0, 14).sort());
});

test('live and previous survive however many newer ones arrive', () => {
  // NOT "the two newest". `previous` is what a rollback returns to, and it has
  // to still be there while somebody is deciding — even if a rolling box has
  // taken fourteen builds since.
  const present = ['old-live', 'old-previous', ...Array.from({ length: 20 }, (_, i) => `main-${i}`)];
  const newestFirst = Array.from({ length: 20 }, (_, i) => `main-${19 - i}`);

  const pruned = releasesToPrune(present, 'old-live', 'old-previous', { newestFirst });
  assert.equal(pruned.includes('old-live'), false, 'the running release was pruned');
  assert.equal(pruned.includes('old-previous'), false, 'the rollback target was pruned');

  // And they count against the limit rather than being extra.
  const kept = present.filter((v) => !pruned.includes(v));
  assert.equal(kept.length, RELEASES_KEPT);
});

test('half-unpacked debris always goes, and never occupies a slot', () => {
  // `.incoming-` is not a version anybody could go back to. Counting it would
  // let an interrupted update push a real rollback target off the end.
  const present = ['.incoming-main-9', 'main-1', 'main-2'];
  const pruned = releasesToPrune(present, 'main-2', 'main-1', { newestFirst: ['main-2', 'main-1'] });
  assert.deepEqual(pruned, ['.incoming-main-9']);
});

test('a box with fewer than the limit loses nothing', () => {
  const present = ['v0.2.2', 'v0.2.3'];
  assert.deepEqual(releasesToPrune(present, 'v0.2.3', 'v0.2.2', { newestFirst: present }), []);
});

test('with no ordering it keeps what it was given, rather than guessing', () => {
  // Version names do NOT sort against each other once two channels exist:
  // `v0.2.3` and `main-55` have no order. A caller with no filesystem to ask
  // gets the same behaviour as before rather than an invented ranking.
  const present = ['v0.2.3', 'main-55', 'main-54'];
  const pruned = releasesToPrune(present, 'main-55', 'main-54');
  assert.deepEqual(pruned, []);
});

test('the limit is honoured exactly, not approximately', () => {
  // Off by one here means either a rollback target quietly disappearing or a
  // disk that grows for ever, and both are found months later.
  for (const keep of [1, 2, 3, 5]) {
    const present = Array.from({ length: 10 }, (_, i) => `main-${i}`);
    const newestFirst = [...present].reverse();
    const kept = present.filter((v) => !releasesToPrune(present, 'main-9', 'main-8', { keep, newestFirst }).includes(v));
    // live and previous are unconditional, so the floor is two.
    assert.equal(kept.length, Math.max(2, keep), `keep=${keep} kept ${kept.length}`);
  }
});
