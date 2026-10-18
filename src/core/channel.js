// Which releases this box takes, and where that answer lives.
//
// NOT IN /etc/fleetwright.env, and that is the whole design. The env file is
// installed 0600 and root-owned; fleetwright runs as an unprivileged user and
// cannot write it. A setting somebody is meant to change from a phone cannot
// live somewhere only root can edit — that is the shape this project keeps
// finding, where the product names a fix and only a shell can apply it.
//
// So it lives in the state directory, which the service owns. One line, one
// word, and a file somebody can read with `cat` when they are wondering.
//
// THE ENVIRONMENT STILL WINS, and refuses rather than being overridden
// silently. An operator who sets FLEETWRIGHT_RELEASE_CHANNEL has said something
// deliberate — probably from configuration management — and a phone quietly
// writing a file that the next process start ignores would be the exact failure
// this repository has paid for repeatedly: true where it was written, quietly
// false one layer up. Setting the channel refuses in that case and says which
// file to edit instead.

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { grantCommand } from './grants.js';
import { APT_REPAIR } from './apt-release.js';

/**
 * The only two answers. `stable` is what a box gets by saying nothing.
 *
 * ROLLING, NOT `prerelease`, and the name matters more than it looks. GitHub
 * already has a field called prerelease — it is the checkbox on a release, and
 * the manifest carries it — so a CHANNEL of the same name meant one word for
 * two things: "which address this box polls" and "was this release marked as
 * not-final". They are not the same question, and every sentence explaining the
 * pair had to say which one it meant.
 */
export const CHANNELS = Object.freeze(['stable', 'rolling']);

/**
 * What the channel was called for one afternoon.
 *
 * Read-only, and deliberately not settable. #366 shipped `prerelease` as the
 * value and the docs said so for a few hours; anybody who copied it into
 * FLEETWRIGHT_RELEASE_CHANNEL should get the channel they asked for rather than
 * falling back to stable, which is the silent-wrong-answer this file is written
 * against. Nothing writes this value any more.
 */
const ALIASES = Object.freeze({ prerelease: 'rolling' });

/**
 * Where a box apt updates is told which suite to take. The machine image
 * writes it (vm-image.js), and every machine cloned from the image keeps it.
 */
export const APT_SOURCES = '/etc/apt/sources.list.d/fleetwright.list';

/**
 * The unit that moves an apt box between suites, a template whose instance is
 * the suite: fleetwright-apt-channel@stable.service or @rolling.service. The
 * sources line is root's and the hub is not, so the change is a named unit
 * the upgrade grant lets the hub start (install/fleetwright-apt-channel@.service
 * says what it does), and the grant names the two instances as two lines.
 */
export const APT_CHANNEL_UNIT = 'fleetwright-apt-channel@';

/** @param {'stable'|'rolling'} suite */
export const aptChannelUnit = (suite) => `${APT_CHANNEL_UNIT}${suite}.service`;

/**
 * On a box apt updates, which suite its sources line names: `rolling` for a
 * machine made from an image built from main, `stable` for everything else.
 *
 * READ FROM THE LINE, NOT REMEMBERED. The line is what apt reads, so it is the
 * one place the answer cannot drift from what the next upgrade installs. A
 * line that cannot be read is stable: the package's own install never writes
 * anything else, and claiming rolling about a box that is not would be the
 * wrong one of the two.
 *
 * @param {{ aptSources?: string }} [cfg]
 * @returns {'stable'|'rolling'}
 */
export function aptSuite(cfg = {}) {
  try {
    const text = readFileSync(cfg.aptSources || APT_SOURCES, 'utf8');
    return /^\s*deb\s+(?:\[[^\]]*\]\s+)?\S+\s+rolling\s/m.test(text) ? 'rolling' : 'stable';
  } catch {
    return 'stable';
  }
}

/** @param {import('../config.js').Config} cfg */
function channelFile(cfg) {
  return path.join(cfg.stateDir, 'release-channel');
}

/**
 * Which channel this box is on.
 *
 * Read at the moment it is needed rather than cached into the config at
 * startup, because the point is that it changes without a restart. It is one
 * small file read, on a path taken once per update check.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {'stable'|'rolling'}
 */
export function readChannel(cfg) {
  // AN APT BOX TAKES WHAT ITS SUITE CARRIES, whatever the file or the
  // environment say: apt is its only updater.
  if (cfg.releaseSource === 'apt') return aptSuite(/** @type {any} */ (cfg));
  const fromEnv = canonical(cfg.releaseChannel);
  if (fromEnv) return fromEnv;
  try {
    const stored = canonical(readFileSync(channelFile(cfg), 'utf8'));
    if (stored) return stored;
  } catch {
    // No file is the ordinary case and means stable, which is what a box that
    // has never been asked should be on.
  }
  return 'stable';
}

/**
 * One written-down answer, or null if it is not one.
 *
 * @param {string|undefined|null} value
 * @returns {'stable'|'rolling'|null}
 */
function canonical(value) {
  const v = String(value || '').trim().toLowerCase();
  if (CHANNELS.includes(v)) return /** @type {any} */ (v);
  return /** @type {any} */ (ALIASES[/** @type {keyof typeof ALIASES} */ (v)] ?? null);
}

/**
 * Whether the environment is forcing a channel, and so overriding the file.
 *
 * @param {import('../config.js').Config} cfg
 */
export function pinnedByEnv(cfg) {
  // AN APT BOX IS PINNED ONLY WITHOUT THE UPGRADE GRANT. Its suite is one word
  // on a root-owned sources line, and moving it is a unit the grant lets the
  // hub start; with no grant there is no way from here, and a picker would
  // offer a choice that is refused. With it, the picker is the same as any
  // other box's.
  if (cfg.releaseSource === 'apt') return !cfg.systemUpgrade;
  return canonical(cfg.releaseChannel) !== null;
}

/**
 * @param {string[]} argv
 * @param {number} timeout
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function run(argv, timeout) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout, env: { ...process.env, LC_ALL: 'C' } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Move a box apt owns to the other suite.
 *
 * THE ANSWER IS READ BACK, NOT ASSUMED. The unit rewrites the sources line,
 * pins or unpins the package and refreshes the lists, and then this reads the
 * line again: the reply says which suite the box IS on, which is the only
 * claim this file is allowed to make. A unit that ran and left the line as it
 * was is reported as exactly that.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} value
 * @param {{ exec?: typeof run }} [opts]  `exec` stands in for spawning so a test
 *   can script sudo's answer and rewrite the fixture file the way the unit would
 * @returns {{ ok: boolean, channel?: 'stable'|'rolling', message: string }}
 */
export function switchAptSuite(cfg, value, { exec = run } = {}) {
  const wanted = canonical(value);
  if (!wanted) {
    return { ok: false, message: `"${String(value).slice(0, 30)}" is not a channel. It is one of: ${CHANNELS.join(', ')}.` };
  }
  const before = aptSuite(/** @type {any} */ (cfg));
  if (before === wanted) {
    return { ok: true, channel: wanted, message: `This box already takes apt's ${wanted} suite.` };
  }
  // THE GRANT, SAID OUT LOUD, the way an upgrade without one is. The unit is
  // installed and permitted by the same decision, so there is nothing to try.
  if (!cfg.systemUpgrade) {
    return {
      ok: false,
      message:
        'Moving an apt box between suites rewrites its sources line, which is root\'s, and this service runs ' +
        'unprivileged on purpose. It needs the same rule system upgrades do:\n\n' +
        `  ${grantCommand('upgrades', 'on')}\n\n` +
        `Or by hand, as root: change the suite word in ${APT_SOURCES} to ${wanted}, ` +
        (wanted === 'stable'
          ? 'pin the package to that suite above priority 1000 (a build of main is a prerelease of the next release, so this is a downgrade), '
          : 'remove the pin /etc/apt/preferences.d/fleetwright-channel if there is one, ') +
        'and run apt-get update.',
    };
  }
  const unit = aptChannelUnit(wanted);
  const r = exec(['sudo', '-n', '/usr/bin/systemctl', 'start', unit], 180_000);
  if (r.status !== 0) {
    // sudo's refusal rather than the unit's failure: the grant predates the
    // unit, which --repair puts right — the same shape as the package unit.
    // Through the package, never the installer under the install root, which
    // the service user owns (apt-release.js, APT_REPAIR).
    if (/not allowed|password is required|no tty/i.test(r.stderr)) {
      return {
        ok: false,
        message:
          `This box's sudoers rule predates the channel unit, so it cannot change suite from here yet.\n` +
          `On the box: ${APT_REPAIR} puts the rule in place, from a checked copy of the release only root can write.`,
      };
    }
    const why = (r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n');
    return { ok: false, message: `could not start ${unit}:\n${why || 'systemd said nothing about why.'}` };
  }
  const after = aptSuite(/** @type {any} */ (cfg));
  if (after !== wanted) {
    return {
      ok: false,
      channel: after,
      message: `${unit} ran, but ${APT_SOURCES} still names the ${after} suite. The journal for fleetwright-apt-channel says what it did.`,
    };
  }
  return {
    ok: true,
    channel: wanted,
    message:
      wanted === 'rolling'
        ? 'This box now takes apt\'s rolling suite: the newest build of main, on every merge. A build of main is ' +
          'versioned as a prerelease of the next release, so the next Apply update installs the newest build as an ' +
          'ordinary upgrade, and any pin from an earlier move is gone.'
        : 'This box now takes apt\'s stable suite: published releases, each once its rollout is complete. A build of ' +
          'main is a prerelease of the next release and outranks the last one, so the package is pinned to the suite ' +
          'and the next Apply update installs the newest release even though apt counts it as a downgrade.',
  };
}

/**
 * Move this box to a channel.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} value
 * @returns {{ ok: boolean, channel?: string, message: string }}
 */
export function writeChannel(cfg, value) {
  const wanted = String(value || '').trim().toLowerCase();
  if (!CHANNELS.includes(wanted)) {
    return { ok: false, message: `"${String(value).slice(0, 30)}" is not a channel. It is one of: ${CHANNELS.join(', ')}.` };
  }
  // REFUSED RATHER THAN OVERRIDDEN. Writing a file the next read ignores is
  // worse than not writing it: the app would show one channel and the box would
  // take another, and nothing anywhere would say so.
  if (pinnedByEnv(cfg)) {
    return {
      ok: false,
      message:
        `FLEETWRIGHT_RELEASE_CHANNEL is set to "${cfg.releaseChannel}" in this box's environment, ` +
        'which wins over anything set here.\n' +
        'Remove it from /etc/fleetwright.env and restart if you want to choose the channel from the app.',
    };
  }

  const file = channelFile(cfg);
  const tmp = `${file}.tmp`;
  try {
    // Written and renamed, so a box that loses power mid-write has either the
    // old channel or the new one and never half a word.
    writeFileSync(tmp, `${wanted}\n`, { mode: 0o644 });
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return { ok: false, message: `could not write ${file}: ${/** @type {Error} */ (e).message}` };
  }
  return {
    ok: true,
    channel: wanted,
    message:
      wanted === 'rolling'
        ? 'This box now takes rolling builds — the newest build of main, on every merge.'
        : 'This box now takes published releases only.',
  };
}
