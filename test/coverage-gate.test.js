// The coverage gate, checked the way it checks everything else.
//
// scripts/check-coverage.mjs decides whether a pull request may land. A gate
// with no test of its own is the failure this repository has already paid for
// twice — check-workflows.mjs exists because nothing looked at the workflows,
// and it has test/check-workflows.test.js for exactly this reason.
//
// The arithmetic lives in scripts/coverage-verdict.mjs precisely so it can be
// driven here: the runner half spends twenty-five seconds executing the suite,
// and importing that from a test would be a recursion rather than a check.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLcov, judge, SLACK_LINES } from '../scripts/coverage-verdict.mjs';

/** One lcov record. Only SF/LF/LH are read, so only those are written. */
const record = (file, found, hit) => `TN:\nSF:${file}\nLF:${found}\nLH:${hit}\nend_of_record\n`;

test('lcov is read as lines found and lines hit, and nothing else', () => {
  const cov = parseLcov(record('src/a.js', 200, 150) + record('src/b.js', 10, 10));
  assert.equal(cov.get('src/a.js').pct, 75);
  assert.equal(cov.get('src/a.js').found, 200);
  assert.equal(cov.get('src/b.js').pct, 100);
});

test('a file with no executable lines is not 0% covered — it is not a measurement', () => {
  // The distinction matters because `--update` would otherwise record a floor
  // of 0 on a file that can never rise above it, and the entry would sit in the
  // floors file forever looking like an untested module.
  const cov = parseLcov(record('src/types.js', 0, 0));
  assert.equal(cov.has('src/types.js'), false);
});

test('a drop past the slack fails, and the message counts lines rather than points', () => {
  // 200 lines, floor 90%, now 80% — twenty lines that used to run and no longer
  // do. Percentages are what get stored; lines are what somebody can act on.
  const cov = parseLcov(record('src/a.js', 200, 160));
  const { regressions } = judge(cov, { 'src/a.js': 90 });
  assert.equal(regressions.length, 1);
  const [file, floor, now, lines] = regressions[0];
  assert.equal(file, 'src/a.js');
  assert.equal(floor, 90);
  assert.equal(now, 80);
  assert.equal(lines, 20);
});

test('the slack is a number of LINES, so a big file gets a tighter percentage', () => {
  // THE WHOLE REASON THE SLACK IS NOT A PERCENTAGE. Two lines out of a hundred
  // is two points; two lines out of a thousand is 0.2. A flat two-point
  // tolerance would let twenty lines go dark on the thousand-line file without
  // a word — which is most of a feature.
  const small = parseLcov(record('src/small.js', 100, 98)); // 98%, floor 100 → 2 lines
  assert.equal(judge(small, { 'src/small.js': 100 }).regressions.length, 0, 'two lines in a small file is noise');

  const big = parseLcov(record('src/big.js', 1000, 980)); // 98%, floor 100 → 20 lines
  assert.equal(judge(big, { 'src/big.js': 100 }).regressions.length, 1, 'twenty lines in a big file is a change');

  // And the boundary itself: exactly SLACK_LINES is still noise on the big one,
  // one more is not. Two assertions, because a rule with no tested edge is a
  // rule whose edge is wherever the last refactor left it.
  const edge = parseLcov(record('src/big.js', 1000, 1000 - SLACK_LINES));
  assert.equal(judge(edge, { 'src/big.js': 100 }).regressions.length, 0);
  const past = parseLcov(record('src/big.js', 1000, 1000 - SLACK_LINES - 1));
  assert.equal(judge(past, { 'src/big.js': 100 }).regressions.length, 1);
});

test('the rule is lines at every size — a tiny file gets two lines too, not two points', () => {
  // THIS TEST IS WHY THERE IS NO `Math.max(1.0, ...)` IN THE SLACK ANY MORE.
  // There was one, and it read like a floor protecting small files. It is not:
  // a minimum expressed in points is a minimum SLACK, so on a thousand-line
  // file it widened two lines into ten. Writing the assertion is what made the
  // direction visible.
  //
  // Twenty lines, two of them dark, is ten percentage points and still two
  // lines — noise, by the only rule this gate has.
  const noise = parseLcov(record('src/tiny.js', 20, 18));
  assert.equal(judge(noise, { 'src/tiny.js': 100 }).regressions.length, 0);

  // Three of them is not.
  const real = parseLcov(record('src/tiny.js', 20, 17));
  assert.equal(judge(real, { 'src/tiny.js': 100 }).regressions.length, 1);
});

test('a rise is reported and never fails — the floors move by hand, in a diff', () => {
  const cov = parseLcov(record('src/a.js', 100, 95));
  const { risen, regressions } = judge(cov, { 'src/a.js': 60 });
  assert.equal(regressions.length, 0);
  assert.deepEqual(
    risen.map(([f]) => f),
    ['src/a.js'],
  );
});

test('a file with no floor is its OWN bucket, not a regression', () => {
  // The distinction is the point. There is no prior number for a new file, so
  // calling it a regression would be a lie about what was measured — but the
  // command-line gate still refuses it, because a file that has never been
  // measured is exactly the "untested surface quietly growing" the ratchet
  // claims to prevent. Reported as new, failed as unrecorded, fixed by
  // `--update` writing the number down as a reviewable diff.
  const cov = parseLcov(record('src/new.js', 100, 10));
  const { untracked, regressions } = judge(cov, {});
  assert.equal(regressions.length, 0, 'it is not a drop — there was nothing to drop from');
  assert.deepEqual(
    untracked.map(([f]) => f),
    ['src/new.js'],
  );
});

test('holding exactly at the floor passes', () => {
  // The boring case, asserted because an off-by-one here would fail every
  // pull request that changed nothing about coverage.
  const cov = parseLcov(record('src/a.js', 100, 90));
  assert.equal(judge(cov, { 'src/a.js': 90 }).regressions.length, 0);
});
