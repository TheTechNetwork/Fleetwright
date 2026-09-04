// The pure half of the coverage gate: parse a report, and say whether it got
// worse. Split out of check-coverage.mjs so it can be TESTED — that file runs
// the whole suite as its first act, which makes importing it from a test a
// twenty-five-second recursion rather than a unit test.
//
// The thresholds live here too, with the comparison that uses them. A constant
// in one file and the arithmetic in another is how the two stop meaning the
// same thing.

// TWO LINES, AND NO PERCENTAGE FLOOR UNDER IT. See the header of
// check-coverage.mjs for why the slack is measured in lines at all.
//
// There WAS a `Math.max(1.0, ...)` here, and writing its test is what showed it
// does the opposite of what it reads like: a minimum expressed in points is a
// minimum SLACK, so it loosens the rule rather than tightening it. On a
// thousand-line file two lines is 0.2 points, and the floor quietly widened
// that to a full point — ten lines — while claiming to protect small files.
//
// Lines all the way down is both simpler and the thing actually meant: a drop
// of more than two lines is a regression at any file size.
export const SLACK_LINES = 2;

import path from 'node:path';

/**
 * Per-file line coverage, out of the lcov the run just wrote.
 *
 * LF is lines found, LH is lines hit. Only those two are read: branch and
 * function counts move for reasons that are not "less code is executed" —
 * a refactor splitting one function into three changes the denominator without
 * changing what runs — and a ratchet on a number that moves on its own is a
 * ratchet somebody learns to re-baseline without reading.
 *
 * @param {string} text
 * @returns {Map<string, {pct: number, found: number}>} path → what was executed
 */
export function parseLcov(text) {
  /** @type {Map<string, {pct: number, found: number}>} */
  const out = new Map();
  let file = '';
  let found = 0;
  let hit = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      file = line.slice(3).trim();
      found = 0;
      hit = 0;
    } else if (line.startsWith('LF:')) found = Number(line.slice(3));
    else if (line.startsWith('LH:')) hit = Number(line.slice(3));
    else if (line.startsWith('end_of_record') && file) {
      // A file with no executable lines is not 0% covered, it is not a
      // measurement. Recording it as 0 would put a floor of 0 on a file that
      // can never rise above it.
      if (found > 0) out.set(normalise(file), { pct: (hit / found) * 100, found });
      file = '';
    }
  }
  return out;
}


/**
 * The verdict, as a pure function of two numbers — separated out because a
 * checker whose comparison lives inside a 25-second suite run is a checker with
 * no test of its own. test/coverage-gate.test.js drives this directly.
 *
 * @param {Map<string, {pct: number, found: number}>} actual
 * @param {Record<string, number>} floors
 */
export function judge(actual, floors) {
  /** @type {Array<[string, number, number, number]>} */
  const regressions = [];
  /** @type {Array<[string, number, number]>} */
  const risen = [];
  /** @type {Array<[string, number]>} */
  const untracked = [];
  for (const [file, { pct, found }] of [...actual].sort()) {
    const floor = floors[file];
    if (floor === undefined) {
      untracked.push([file, pct]);
      continue;
    }
    const slack = (SLACK_LINES / found) * 100;
    if (pct < floor - slack) regressions.push([file, floor, pct, Math.round(((floor - pct) / 100) * found)]);
    else if (pct >= floor + 2) risen.push([file, floor, pct]);
  }
  return { regressions, risen, untracked };
}

/**
 * lcov paths as they are written in the floors file: repository-relative,
 * forward slashes. Node writes them relative to the working directory already;
 * an absolute one would make the floors machine-specific.
 *
 * @param {string} p
 */
export function normalise(p) {
  const rel = path.isAbsolute(p) ? path.relative(process.cwd(), p) : p;
  return rel.split(path.sep).join('/');
}

/**
 * How many tests the run skipped, out of node's spec-reporter summary.
 *
 * A skip means the coverage numbers are not comparable with floors recorded
 * from a full run — see the long note in check-coverage.mjs for the case that
 * found this. Parsed rather than inferred: node prints one summary line, and
 * anything else here would be guessing.
 *
 * @param {string} stdout
 */
export function skippedCount(stdout) {
  const m = /^\u2139 skipped (\d+)$/m.exec(stdout || '');
  return m ? Number(m[1]) : 0;
}
