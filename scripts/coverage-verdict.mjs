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

/**
 * What to say of a suite run that did not pass.
 *
 * THE FAILING TESTS, WHEN THERE ARE ANY TO NAME. And when there are none,
 * WHATEVER ENDED THE RUN, because a run can fail without a failing test: the
 * runner is killed (out of memory is a SIGKILL, and leaves no last word), its
 * output passes the buffer it is read into, or it dies after the last test
 * with something on stderr. Each of those used to print an empty line here,
 * and verify.sh then printed `tests ... FAILED` over nothing. Three people
 * met that in one night with several suites running on one box, reran, saw
 * green, and never learned which it had been. A failure with no name gets
 * reread as noise, which is the thing a gate must not teach.
 *
 * @param {{ status: number|null, signal?: string|null, error?: { code?: string, message?: string }|null, stdout?: string, stderr?: string }} run
 *   what `spawnSync` returned for the suite
 * @returns {string[]}  lines to print, never empty
 */
export function whatFailed(run) {
  const named = (run.stdout || '').split('\n').filter((l) => /^(not ok|\u2716)/.test(l)).slice(0, 10);
  // A RUN THAT WAS ENDED AFTER A TEST HAD FAILED says both. The names alone
  // read as the whole list, and it is the list up to where the run stopped.
  if (named.length) {
    if (run.signal) named.push(`and the test runner was then ended by ${run.signal}, so tests after these did not run.`);
    else if (run.error) named.push(`and the run was then stopped (${run.error.code || run.error.message || 'no reason given'}), so tests after these did not run.`);
    return named;
  }
  const said = [];
  if (run.error) {
    said.push(run.error.code === 'ENOBUFS'
      ? 'the suite printed more than this script reads, so it was stopped before its end. Something is printing far more than it used to.'
      : `the suite could not be run to its end: ${run.error.code || run.error.message || 'no reason given'}.`);
  }
  if (run.signal) {
    said.push(`the test runner was ended by ${run.signal}, and named no failing test.${run.signal === 'SIGKILL' ? ' That is what running out of memory looks like: is another suite running on this machine?' : ''}`);
  }
  if (!said.length) said.push(`the test runner exited ${run.status === null ? 'with no status' : run.status} and named no failing test.`);
  // WHAT THE RUNNER WARNED OF, which is the whole story when every test
  // passed: node prints a failure to build the coverage report as a warning
  // among its closing lines and exits 1 for it. Caught once, after three
  // people had rerun past it: one process's coverage file was cut short
  // ("Unterminated string in JSON at position 524288"), so there was no
  // report, so the run "failed" with 4327 passing and 0 failing.
  const warned = (run.stdout || '').split('\n').filter((l) => /^(\u2139|#) Warning: /.test(l)).map((l) => l.slice(0, 600));
  if (warned.length) said.push('every test may have passed; the runner warned:', ...warned.slice(0, 5));
  const stderr = (run.stderr || '').trim();
  if (stderr) said.push('what it wrote last:', stderr.slice(-2000));
  else {
    const last = (run.stdout || '').trim().split('\n').slice(-8);
    if (last.join('').trim()) said.push('the last lines of its output:', ...last);
  }
  return said;
}

/**
 * The coverage file a run could not read, if it said so, and null otherwise.
 *
 * @param {string} stdout  the suite's output
 * @returns {string|null}
 */
export function unreadCoverageFile(stdout) {
  const m = /failed to parse coverage file (\S+\.json)/.exec(stdout || '');
  return m ? m[1] : null;
}

/**
 * Which process a cut-short coverage file was, as far as the file says: the
 * first few of this repository's own files it had loaded, in the order V8
 * listed them. The file cannot be parsed, which is the fault being reported,
 * so the names are picked out of its text.
 *
 * A PROCESS IS NAMED BY WHAT IT RAN. The file's own name holds only a process
 * id, long gone by the time anybody reads the message. Its first scripts are
 * the program's entry and what that imported first, which is enough to say
 * "the hub a test started" or "the stand-in Podman", and so which tests to
 * look at for a process still writing as the run ended.
 *
 * @param {string} text  what could be read of the file
 * @param {number} [most]
 * @returns {string[]}  paths, shortened to what follows the repository's root where they are in it
 */
export function scriptsIn(text, most = 6) {
  /** @type {string[]} */
  const out = [];
  for (const m of String(text || '').matchAll(/"url":"file:\/\/([^"]+)"/g)) {
    const file = m[1];
    if (file.includes('/node_modules/')) continue;
    const short = file.replace(/^.*\/(src|test|bin|scripts|sandbox|worker|install|tools)\//, '$1/');
    if (!out.includes(short)) out.push(short);
    if (out.length >= most) break;
  }
  return out;
}
