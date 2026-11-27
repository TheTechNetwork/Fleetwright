// Coverage from a child that a test may kill.
//
// WHY THIS EXISTS. Run for coverage, the suite hands every process it starts
// a directory in NODE_V8_COVERAGE, and each writes what it ran there as it
// exits, in one file a megabyte or so long. The test runner reads them all at
// the end, and one it cannot parse fails the whole run: every test passed,
// and the gate says there is no coverage to judge.
//
// A stand-in for Podman runs the real runner (sandbox/engine.mjs) as "the
// container", and ends it the way Podman ends one: SIGKILL, to everything in
// it, where it stands. The box removes a sign-in's container the moment the
// runner has said how the sign-in ended, which is the moment the runner is on
// its way out and writing that file. Most times the kill lands before the
// write or after it. Now and then it lands inside, and the file stops at a
// block boundary, 524288 bytes in. That was the run that failed with nothing
// wrong, now and then, and scripts/check-coverage.mjs names the process when
// it happens.
//
// The other way to the same file: a session's pane is killed when its test is
// done, the runner in it is told to stop rather than killed, and it tidies up
// and writes on its way out, after the test that started it has gone
// (test/engines-launch.test.js).
//
// So a child that may be ended writes aside, in a directory of the test's
// own, and the test waits for it to be gone and hands on what is whole. A
// child that was killed where it stood leaves nothing, as it always has when
// the kill came first; one that finished leaves all of it; none leaves half.

import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';

/**
 * The line for a stand-in's shell that sends a child's coverage aside. It
 * does nothing in a run that measures none.
 *
 * @param {string} aside as the shell is to read it, quoted or a variable of its own
 * @returns {string}
 */
export const coverageAside = (aside) => `if [ -n "\${NODE_V8_COVERAGE:-}" ]; then export NODE_V8_COVERAGE=${aside}; fi`;

/**
 * Wait until none of these processes is left, or `ms` has gone by. A child
 * that was told to stop tidies up and writes what it ran before it goes, and
 * one that was killed is not gone the instant the kill returns.
 *
 * @param {number[]} pids
 * @param {number} [ms]
 * @returns {Promise<boolean>} whether every one is gone
 */
export async function allGone(pids, ms = 5000) {
  const until = Date.now() + ms;
  const left = (/** @type {number} */ pid) => {
    try {
      return pid > 0 && (process.kill(pid, 0), true);
    } catch {
      return false;
    }
  };
  while (pids.some(left)) {
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

/**
 * Hand on every whole coverage file in `aside` to where the test runner
 * reads, and leave the cut ones behind. Call it once nothing can still be
 * writing: after whatever the test left running is gone (allGone).
 *
 * @param {string} aside
 * @param {string|undefined} [to] where this process was told to write its own
 * @returns {number} how many were handed on
 */
export function gatherCoverage(aside, to = process.env.NODE_V8_COVERAGE) {
  if (!to || !existsSync(aside)) return 0;
  let whole = 0;
  for (const name of readdirSync(aside)) {
    const from = path.join(aside, name);
    try {
      JSON.parse(readFileSync(from, 'utf8'));
    } catch {
      continue; // cut short, or still being written by something a kill has not reached yet
    }
    try {
      renameSync(from, path.join(to, name));
    } catch {
      // Another filesystem. The runner reads only names that end .json, so a
      // copy that is itself cut short is never read either.
      copyFileSync(from, path.join(to, `${name}.part`));
      renameSync(path.join(to, `${name}.part`), path.join(to, name));
    }
    whole++;
  }
  return whole;
}
