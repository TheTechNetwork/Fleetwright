// What apt says about the fleetwright package, on a box that apt owns.
//
// A BOX INSTALLED FROM THE DEB HAS ONE UPDATER, AND IT IS APT. The package lays
// a release out under /opt/fleetwright exactly as the one-liner does, but the
// next release arrives through the apt repository — published there only once
// its rollout is complete — and the package's postinst is what moves `current`.
// A manifest check on the same box would be a second updater with its own idea
// of which version is current, and the two would take turns moving the
// symlink. So on such a box (AGENT_HUB_RELEASE_SOURCE=apt, written by the
// installer when the postinst runs it) the question "is a release waiting" is
// put to apt, and the answer is apt's candidate.
//
// `apt-cache policy` rather than `apt list --upgradable`: it names BOTH the
// installed version and the candidate, so "nothing waiting" is an answer apt
// gave rather than the absence of a line. Needs no privilege, and changes
// nothing.

import { spawnSync } from 'node:child_process';

export const APT_PACKAGE = 'fleetwright';

/**
 * Installed and candidate versions out of `apt-cache policy <pkg>`.
 *
 * `(none)` is apt's word for "not installed" or "no candidate", and it becomes
 * null here — NOT a version, and not an empty string that a comparison would
 * then treat as one.
 *
 * @param {string} stdout
 * @returns {{ installed: string|null, candidate: string|null }}
 */
export function parseAptPolicy(stdout) {
  /** @param {string} name */
  const field = (name) => {
    const m = new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, 'm').exec(stdout || '');
    if (!m || m[1] === '(none)') return null;
    return m[1];
  };
  return { installed: field('Installed'), candidate: field('Candidate') };
}

/**
 * @param {string[]} argv
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function run(argv) {
  const r = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout: 15_000,
    // apt-cache prints in the user's language otherwise, and the parse above
    // reads English field names.
    env: { ...process.env, LC_ALL: 'C' },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * The release check, answered by apt. Same shape as checkRelease's.
 *
 * Never throws: a box whose apt is broken still runs sessions.
 *
 * @param {{ exec?: typeof run }} [opts]
 * @returns {import('./release-check.js').ReleaseCheck}
 */
export function checkAptRelease({ exec = run } = {}) {
  const r = exec(['apt-cache', 'policy', APT_PACKAGE]);
  if (r.status !== 0) {
    return {
      available: null,
      configured: true,
      ok: false,
      reason: 'apt',
      message: `This box takes Fleetwright from apt, and apt could not be asked: ${(r.stderr || 'apt-cache failed').split('\n')[0]}`,
    };
  }
  const { installed, candidate } = parseAptPolicy(r.stdout);
  // NOT INSTALLED BY APT AT ALL, on a box that says it is. Somebody removed
  // the package and kept the env file, or set the variable by hand. Either way
  // apt has no answer about this box, and saying "up to date" would be one.
  if (!installed) {
    return {
      available: null,
      configured: true,
      ok: false,
      reason: 'apt',
      message:
        `This box is set to take Fleetwright from apt, but the ${APT_PACKAGE} package is not installed.\n` +
        'Install it (apt install fleetwright), or remove AGENT_HUB_RELEASE_SOURCE from /etc/agent-hub.env.',
    };
  }
  if (candidate && candidate !== installed) {
    return {
      available: candidate,
      configured: true,
      ok: true,
      reason: 'apt',
      message:
        `${APT_PACKAGE} ${candidate} is waiting in apt (this box has ${installed}).\n` +
        'It installs with the system updates: /upgrade, or apt upgrade on the box.',
    };
  }
  return {
    available: null,
    configured: true,
    ok: true,
    reason: 'apt',
    // AS OF THE LAST TIME THE LISTS WERE FETCHED, and said so. A candidate is
    // only as new as apt's package lists; "up to date" without that clause is a
    // claim about a repository nobody has asked since install day.
    message: `${APT_PACKAGE} ${installed} is the newest in apt, as of the last time this box fetched its package lists.`,
  };
}
