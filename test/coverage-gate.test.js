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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseLcov, judge, skippedCount, whatFailed, unreadCoverageFile, scriptsIn, SLACK_LINES } from '../scripts/coverage-verdict.mjs';

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

test('a skipped test is counted, because a partial run is not a coverage answer', () => {
  // THE BUG THIS CAME FROM. test/files-container.test.js skips itself when
  // there is no container engine, and src/core/files.js then measures 48%
  // instead of the 96% CI sees. Judging that against a floor recorded from CI
  // reports 189 lines of regression that did not happen — red locally, green on
  // CI, which is the direction that teaches people the gate is noise.
  assert.equal(skippedCount('\u2139 pass 1257\n\u2139 fail 0\n\u2139 skipped 1\n'), 1);
  assert.equal(skippedCount('\u2139 pass 1257\n\u2139 fail 0\n\u2139 skipped 12\n'), 12);
});

test('a full run counts zero, so the ratchet still runs where nothing skips', () => {
  // The half that matters for CI: if this over-reported, the gate would quietly
  // stop judging anything anywhere.
  assert.equal(skippedCount('\u2139 pass 1257\n\u2139 fail 0\n\u2139 skipped 0\n'), 0);
  assert.equal(skippedCount(''), 0);
  // Not fooled by the word appearing in a test NAME, which is the obvious way
  // for a line-matching parser to be wrong.
  assert.equal(skippedCount('\u2714 a test about skipped 3 things (1ms)\n\u2139 skipped 0\n'), 0);
});

test('a run that failed names its failing tests, and nothing else when it has them', () => {
  const said = whatFailed({ status: 1, stdout: '\u2714 fine (1ms)\n\u2716 a box refuses an unsigned answer (4ms)\n  \u2716 nested, not at the margin\nnot ok 3 - the TAP form\n', stderr: 'noise' });
  assert.deepEqual(said, ['\u2716 a box refuses an unsigned answer (4ms)', 'not ok 3 - the TAP form']);
});

test('a run that was ended after a test had failed says both', () => {
  // The names alone read as the whole list. It is the list up to where the
  // run was stopped, and a reader who fixes those two has not finished.
  const stdout = '\u2716 a box refuses an unsigned answer (4ms)\n';
  assert.deepEqual(whatFailed({ status: null, signal: 'SIGKILL', stdout, stderr: '' }), [
    '\u2716 a box refuses an unsigned answer (4ms)',
    'and the test runner was then ended by SIGKILL, so tests after these did not run.',
  ]);
  assert.match(whatFailed({ status: null, error: { code: 'ENOBUFS' }, stdout, stderr: '' })[1], /^and the run was then stopped \(ENOBUFS\)/);
});

test('a run that was killed says so, where it used to print an empty line', () => {
  // THE CASE THIS WAS WRITTEN FOR. Out of memory is a SIGKILL: no status, no
  // failing test, nothing on stderr. The gate printed `FAILED` over nothing,
  // and a failure with no name is rerun until it is green.
  const said = whatFailed({ status: null, signal: 'SIGKILL', stdout: '\u2714 one (1ms)\n\u2714 two (1ms)\n', stderr: '' });
  assert.match(said[0], /ended by SIGKILL/);
  assert.match(said[0], /out of memory/);
  assert.match(said.join('\n'), /\u2714 two/, 'the last thing it printed says how far it got');
  // Another signal is named and not explained as memory.
  assert.doesNotMatch(whatFailed({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' })[0], /memory/);
});

test('a run whose output passed the buffer, or that died after its last test, says which', () => {
  assert.match(whatFailed({ status: null, error: { code: 'ENOBUFS' }, signal: 'SIGTERM', stdout: '', stderr: '' })[0], /printed more than this script reads/);
  const died = whatFailed({ status: 7, stdout: '\u2139 pass 12\n\u2139 fail 0\n', stderr: 'Error: the reporter could not write coverage.lcov\n' });
  assert.match(died[0], /exited 7 and named no failing test/);
  assert.match(died.join('\n'), /the reporter could not write coverage\.lcov/);
});

test('whatever a failed run was, something is said of it', () => {
  // Never an empty answer: that is the failure this function replaces.
  for (const run of [{ status: 1 }, { status: null }, { status: 1, stdout: '', stderr: '' }]) {
    const said = whatFailed(run);
    assert.ok(said.length && said.every((l) => typeof l === 'string') && said.join('').trim(), JSON.stringify(run));
  }
});

test('a run where every test passed and the coverage report could not be built says that', () => {
  // AS IT WAS CAUGHT, word for word but for the directory: 4327 passing, 0
  // failing, exit 1. The warning is nine lines from the end, one more than
  // the tail that is printed, so without its own line it was never seen.
  const stdout = [
    '\u2714 the last test (2ms)',
    '\u2139 Warning: Could not report code coverage. Error [ERR_OPERATION_FAILED]: Operation failed: failed to parse coverage file /tmp/cov-Ab12Cd/t/node-coverage-n7vuWZ/coverage-25390-1795674076758-0.json: Unterminated string in JSON at position 524288 (line 1 column 524289)',
    '\u2139 tests 4333', '\u2139 suites 0', '\u2139 pass 4327', '\u2139 fail 0', '\u2139 cancelled 0', '\u2139 skipped 6', '\u2139 todo 0', '\u2139 duration_ms 201234.5',
  ].join('\n');
  const said = whatFailed({ status: 1, stdout, stderr: '' }).join('\n');
  assert.match(said, /exited 1 and named no failing test/);
  assert.match(said, /Could not report code coverage/);
  assert.match(said, /Unterminated string in JSON at position 524288/);
  assert.equal(unreadCoverageFile(stdout), '/tmp/cov-Ab12Cd/t/node-coverage-n7vuWZ/coverage-25390-1795674076758-0.json');
  assert.equal(unreadCoverageFile('\u2139 pass 12\n'), null);
});

test('a cut-short coverage file still says which program it was', () => {
  // The start of a V8 coverage file, cut in the middle of a string, as the
  // real one was. A dependency is not what names a process; its own files are.
  const cut = '{"result":[{"scriptId":"7","url":"file:///home/x/fleet/node_modules/ws/index.js","functions":[]},'
    + '{"scriptId":"8","url":"file:///home/x/fleet/bin/fleetwright","functions":[]},'
    + '{"scriptId":"9","url":"file:///home/x/fleet/src/index.js","functions":[]},'
    + '{"scriptId":"9","url":"file:///home/x/fleet/src/index.js","functions":[]},'
    + '{"scriptId":"10","url":"file:///home/x/fleet/src/core/regis';
  assert.deepEqual(scriptsIn(cut), ['bin/fleetwright', 'src/index.js']);
  assert.deepEqual(scriptsIn(''), []);
});


test('the gate itself, run on one small suite: it names the process and takes its directory away', () => {
  // THE RUNNER HALF, ONCE, on a project of one source file and one test, not
  // on this repository's suite. It is here because the half that reads the
  // cut-short file could not be reached from the arithmetic: its first
  // version looked for the file where node's test runner had already
  // removed it, said in a comment that it was still there, and passed every
  // test above while never once naming a process.
  const project = mkdtempSync(path.join(tmpdir(), 'gate-'));
  try {
    for (const dir of ['scripts', 'src', 'test', 'tmp']) mkdirSync(path.join(project, dir));
    for (const script of ['check-coverage.mjs', 'coverage-verdict.mjs']) copyFileSync(path.join('scripts', script), path.join(project, 'scripts', script));
    writeFileSync(path.join(project, 'scripts', 'build-web.mjs'), 'process.exit(0);\n');
    writeFileSync(path.join(project, 'src', 'a.js'), 'export const a = 1;\n');
    writeFileSync(path.join(project, 'test', 'coverage-floor.json'), '{}\n');
    // One passing test, which leaves beside its own coverage file one that
    // stops in the middle of a string, as a process ended while writing does.
    writeFileSync(path.join(project, 'test', 'a.test.js'), [
      "import { test } from 'node:test';",
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { a } from '../src/a.js';",
      "test('passes', () => {",
      "  if (a !== 1) throw new Error('no');",
      "  fs.writeFileSync(path.join(process.env.NODE_V8_COVERAGE, 'coverage-424242-1700000000000-0.json'),",
      "    '{\"result\":[{\"scriptId\":\"7\",\"url\":\"file:///home/x/fleet/src/index.js\",\"functions\":[{\"functionName\":\"tru');",
      '});',
      '',
    ].join('\n'));
    // A RUN OF ITS OWN, not a child of this one: the runner this test is
    // inside marks its children (NODE_TEST_CONTEXT) so that they report to
    // it, and one so marked prints nothing and writes no coverage report.
    const { NODE_V8_COVERAGE: _outer, NODE_TEST_CONTEXT: _child, ...env } = process.env;
    const run = spawnSync(process.execPath, ['scripts/check-coverage.mjs'], { cwd: project, encoding: 'utf8', env: { ...env, TMPDIR: path.join(project, 'tmp') } });
    const said = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 1, said);
    assert.match(said, /suite: \u2139 pass 1 \u2139 fail 0/);
    assert.match(said, /Could not report code coverage/);
    assert.match(said, /the process whose coverage was cut short had loaded, first: src\/index\.js\. A test left it running, or ended it, while it was still writing\./);
    // And nothing of the run is left where it made its directory.
    assert.deepEqual(readdirSync(path.join(project, 'tmp')), []);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
