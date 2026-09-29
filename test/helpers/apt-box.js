// A box apt owns, for a test that dispatches a verb at one.
//
// A packaged install dir, and two stand-ins first on PATH: an `apt-cache`
// that answers `policy` with the text given, and a `sudo` that does nothing
// and appends its argv to a log. The log is the order things happened in at
// the process boundary — which is what a test about "asked apt after apt
// fetched" has to read, because the verb under test spawns both.

import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** `apt-cache policy fleetwright` text for an installed and a candidate version. */
export const POLICY = (/** @type {string} */ installed, /** @type {string} */ candidate) =>
  `fleetwright:\n  Installed: ${installed}\n  Candidate: ${candidate}\n  Version table:\n *** ${installed} 500\n`;

/** @param {string} policy  what the fake apt-cache prints */
export function aptBox(policy) {
  const dir = mkdtempSync(path.join(tmpdir(), 'apt-box-'));
  mkdirSync(path.join(dir, 'lib'));
  writeFileSync(path.join(dir, 'lib', 'fleetwright.mjs'), '');
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  writeFileSync(log, '');
  // Both stubs write one line per call, so the log reads as a timeline.
  writeFileSync(path.join(bin, 'apt-cache'), `#!/bin/sh\necho "apt-cache $*" >> '${log}'\ncat <<'EOF'\n${policy}EOF\n`);
  writeFileSync(path.join(bin, 'sudo'), `#!/bin/sh\necho "sudo $*" >> '${log}'\n`);
  chmodSync(path.join(bin, 'apt-cache'), 0o755);
  chmodSync(path.join(bin, 'sudo'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  return {
    dir,
    /** Every stubbed call so far, in order, one argv line each. */
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    done() {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
