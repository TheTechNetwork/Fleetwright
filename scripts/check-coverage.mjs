// The surface the suite does not execute, held at a number that can only go up.
//
// THE PROBLEM THIS IS FOR is the second half of "nothing breaks by merging it":
// a green pull request proves the tests that exist still pass. It says nothing
// about the lines the tests never reach, and those lines are where the bugs
// that reach main live — every one of the failures the comments in ci.yml and
// verify.sh describe was in code no test executed.
//
// So: measure what is executed, record it, and refuse a change that executes
// less of a file than the last one did.
//
// A RATCHET, NOT A TARGET. A single "80% or fail" line is a number somebody
// picks and then argues with; it fails files that were always at 60 and passes
// a file that fell from 99 to 81. Per-file floors, recorded from what the suite
// actually reaches today, fail exactly one thing: a change that stops covering
// code that was covered before it. That is the only coverage question a pull
// request can answer honestly, and it is the one that matters — the untested
// surface shrinks or holds, and never quietly grows.
//
// `--update` rewrites the floors from a passing run. That is the only way they
// move, and it is a reviewable diff in the pull request that earned it.
//
// THE TOLERANCE IS TWO LINES, NOT A PERCENTAGE, and it is small because the
// one source of jitter this found turned out to be a missing test rather than
// noise.
//
// src/fleet/coordinator/scheduler.js reported 100% on some runs and 98.06% on
// others — three times in nine runs of an unchanged tree, lines 239-247 the
// only difference. That block is the `ambiguous_session` refusal, and it had no
// test: something else in the suite happened to build a registry where two
// hosts claimed one session name, and the branch ran by accident. A safety
// refusal exercised by accident is one nobody has checked, and the accident can
// stop happening in a commit that has nothing to do with it.
// test/ambiguous-session.test.js asserts it now, and the number is stable.
//
// So the slack is here for real measurement noise and nothing else, and it is
// stated in LINES rather than as a percentage: two of them, converted per file
// from that file's own length. On a hundred-line file that is two points; on a
// thousand-line file it is 0.2, where a flat percentage would have quietly
// allowed twenty lines to go dark.
//
// LINES ONLY, NOT BRANCHES. Branch coverage on that same file still moves
// between 89.83 and 90.60 run to run with nothing changed, and a gate that
// fails a third of the time on an unchanged tree is not a gate — it is a thing
// people learn to re-run, and then to ignore, and the day it is right nobody
// reads it.

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { globSync } from 'node:fs';

import { parseLcov, judge, skippedCount } from './coverage-verdict.mjs';

const FLOORS = 'test/coverage-floor.json';
const update = process.argv.includes('--update');

// THE CONSOLE, COMPILED FIRST — the same thing `npm test`'s pretest does, and
// not an optimisation to skip. Node cannot import JSX, so the component tests
// live in build/ and only exist after this runs. Without it a coverage run
// under VERIFY_SKIP_TESTS (which is how CI reaches this file) would find no
// build/*.test.js, cover less, and say so in a number nobody would question —
// a measurement that quietly shrinks is worse than none, and is precisely the
// failure this file exists to catch elsewhere.
const built = spawnSync(process.execPath, ['scripts/build-web.mjs'], { stdio: 'pipe', encoding: 'utf8' });
if (built.status !== 0) {
  console.error(`could not build the console, so the suite is incomplete:\n${built.stderr || built.stdout}`);
  process.exit(1);
}

// The same files `npm test` runs, resolved here rather than handed in — a
// coverage run over a different set of tests is a different measurement, and
// one that quietly covers less is exactly what this file exists to catch.
const testFiles = [...globSync('test/*.test.js'), ...globSync('build/*.test.js')].sort();
if (testFiles.length === 0) {
  console.error('no test files found — run from the repository root');
  process.exit(1);
}

// Everything that is not source. `dist/` and `build/` are generated (the host
// package tarball unpacks into dist/ during the suite, and build/ is the
// compiled console), and counting generated output as covered or uncovered is
// counting a number nobody can act on.
const EXCLUDE = ['test/**', 'build/**', 'dist/**', 'node_modules/**', 'scripts/**', 'apps/**'];

const work = mkdtempSync(path.join(tmpdir(), 'cov-'));
const lcovPath = path.join(work, 'coverage.lcov');

const run = spawnSync(
  process.execPath,
  [
    '--test',
    '--experimental-test-coverage',
    // TWO REPORTERS, and the second one is not decoration. With lcov as the
    // only reporter the run writes coverage to a file and NOTHING to stdout —
    // so a failing suite came back with a non-zero exit and no test names, and
    // the message below had nothing to print. Node takes reporter/destination
    // in pairs; `spec` to stdout is what makes a failure legible.
    '--test-reporter=lcov',
    `--test-reporter-destination=${lcovPath}`,
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    ...EXCLUDE.map((p) => `--test-coverage-exclude=${p}`),
    ...testFiles,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

// THE SUITE FAILING IS NOT A COVERAGE ANSWER. A run with failing tests covers
// whatever it happened to reach before it stopped, and ratcheting against that
// would record a floor from a broken run. Say what failed and stop.
if (run.status !== 0) {
  // Both reporter formats: `not ok` is TAP, `✖` is the spec reporter node emits
  // now. Naming only one is how a failure message becomes an empty one — see
  // the same fix in scripts/verify.sh.
  const notOk = (run.stdout || '')
    .split('\n')
    .filter((l) => /^(not ok|✖)/.test(l))
    .slice(0, 10);
  console.error('the suite did not pass, so there is no coverage to judge:');
  console.error(notOk.length ? notOk.join('\n') : (run.stderr || '').slice(-2000));
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

// A SUITE THAT DID NOT ALL RUN IS NOT A COVERAGE ANSWER EITHER, and this is
// the sibling of the check above rather than a new idea.
//
// THE BUG THIS FIXES, found by using it. test/files-container.test.js runs the
// workspace browser inside a real container and SKIPS ITSELF when there is no
// container engine. CI has Docker, so it runs there and src/core/files.js
// measures 96%; a laptop without Docker measures 48% for the same unchanged
// code. The floor recorded from CI then failed every local run with
//
//     src/core/files.js
//       covered 48.62%, floor is 96% — about 189 lines that used to run no
//       longer do
//
// naming a regression that did not happen. That is red-locally-green-on-CI,
// which is worse than the other way round: the gate is wrong in the direction
// that teaches people to stop reading it.
//
// So a skip means the numbers are not comparable, and the honest answer is to
// say so rather than to judge. CI skips nothing, so the ratchet is fully
// enforced exactly where it decides whether something merges.
//
// ANNOUNCED, NEVER SILENT — the same rule verify.sh's header states about
// VERIFY_SKIP_TESTS. A check that can quietly do less than it says is the
// failure this whole file is about.
const skipped = skippedCount(run.stdout || '');

if (!existsSync(lcovPath)) {
  console.error('no coverage was written — node produced no lcov report');
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

const actual = parseLcov(readFileSync(lcovPath, 'utf8'));
rmSync(work, { recursive: true, force: true });

/** @type {Record<string, number>} */
const floors = existsSync(FLOORS) ? JSON.parse(readFileSync(FLOORS, 'utf8')) : {};

if (update && skipped > 0) {
  // MORE URGENT THAN THE READ PATH. Judging against a partial run is a wrong
  // answer; RECORDING one writes it into the floors file, where it silently
  // lowers the bar for everybody afterwards — the ratchet slipping, by the one
  // command that is supposed to move it deliberately.
  console.error(
    `refusing to re-baseline from a run with ${skipped} skipped test${skipped === 1 ? '' : 's'}.\n` +
      'Those files would be recorded at whatever this environment happened to reach,\n' +
      'which is lower than CI reaches and would lower the floor for everybody.\n' +
      'Run it where nothing skips — a container engine is usually what is missing.',
  );
  process.exit(1);
}

if (update) {
  /** @type {Record<string, number>} */
  const next = {};
  for (const file of [...actual.keys()].sort()) next[file] = Math.floor(actual.get(file)?.pct ?? 0);
  writeFileSync(FLOORS, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`wrote ${FLOORS} — ${Object.keys(next).length} files`);
  process.exit(0);
}

if (skipped > 0) {
  // The one-line summary LAST, because verify.sh shows the final line and a
  // trailing sentence of explanation would read as the whole answer.
  console.log(
    'The numbers are not comparable with floors recorded from a full run. The usual\n' +
      '  cause is no container engine, which makes test/files-container.test.js skip and\n' +
      '  src/core/files.js read about half what CI measures. CI runs everything, so the\n' +
      '  ratchet is enforced where it decides whether something merges.\n' +
      `not judged — ${skipped} test${skipped === 1 ? '' : 's'} skipped`,
  );
  process.exit(0);
}

const { regressions, risen, untracked } = judge(actual, floors);

// A FILE THAT DISAPPEARS FROM THE REPORT IS NOT AUTOMATICALLY FINE. It means
// either the file was deleted — correct, and the floor should go with it — or
// nothing imports it any more, which is the same "no test reaches this" the
// rest of this file is about, wearing a disguise the percentage cannot show.
const vanished = Object.keys(floors).filter((f) => !actual.has(f) && existsSync(f));

const pct = (/** @type {number} */ n) => n.toFixed(2).padStart(6);

if (risen.length) {
  console.log('coverage rose — re-baseline with `node scripts/check-coverage.mjs --update`:');
  for (const [file, floor, now] of risen) console.log(`  ${pct(floor)} → ${pct(now)}  ${file}`);
}

// A NEW FILE FAILS, and this used to only print. The docs claimed the untested
// surface "never quietly grows", and for a file that had never been measured it
// could: it appeared under a heading, nothing failed, and a module added at 0%
// passed the gate that exists to stop exactly that.
//
// There is no prior number to ratchet against, so the gate cannot judge the
// VALUE — but it can insist the value be recorded, which is the same act that
// records every other floor and lands as the same reviewable diff. One command,
// once per new file.
//
// It costs nothing in flakiness that was not already there: a file that drops
// out of the report while still on disk already fails as `vanished`, so a file
// that flaps in and out was always going to fail in one direction. This makes
// it symmetric rather than adding a new way to be red.

if (!regressions.length && !vanished.length && !untracked.length) {
  const covered = [...actual.values()].map((v) => v.pct);
  const mean = covered.reduce((a, b) => a + b, 0) / (covered.length || 1);
  console.log(`coverage held on ${actual.size} files (mean ${mean.toFixed(1)}% of lines)`);
  process.exit(0);
}

for (const [file, floor, now, lines] of regressions) {
  console.error(
    `  ${file}\n    covered ${now.toFixed(2)}%, floor is ${floor}% — about ${lines} line${lines === 1 ? '' : 's'} that used to run no longer do`,
  );
}
for (const file of vanished) {
  console.error(`  ${file}\n    still on disk but no longer reached by any test — it had a floor of ${floors[file]}%`);
}
for (const [file, now] of untracked) {
  console.error(
    `  ${file}\n    covered ${now.toFixed(2)}% and has no floor recorded — new source, or newly reached by a test`,
  );
}
const lost = regressions.length + vanished.length;
if (lost) {
  console.error(
    `\n${lost} file${lost === 1 ? '' : 's'} lost coverage.\n` +
      'Either the change removed the test that covered it, or it added code nothing runs.\n' +
      'Add the test, then re-run. `--update` is for a floor that went UP.',
  );
}
if (untracked.length) {
  console.error(
    `\n${untracked.length} file${untracked.length === 1 ? ' has' : 's have'} no floor recorded.\n` +
      'This is the one case `--update` is for on a first run:\n' +
      '  node scripts/check-coverage.mjs --update\n' +
      'It writes what the suite reaches today, and that number is then held. If it\n' +
      'reads lower than you expected, the fix is a test rather than the command.',
  );
}
process.exit(1);
