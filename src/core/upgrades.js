// What is out of date on this box, and — if you have said so explicitly — how
// to fix it.
//
// Two separate questions that get confused because they both say "update":
//
//   the APP    a git checkout that can be fast-forwarded (see update.js)
//   the BOX    distribution packages, security fixes, a pending reboot
//
// This file answers the second and reports on the first, so a phone or a chat
// message can say "3 security updates and a reboot pending" without anybody
// logging in to look.
//
// READING IS FREE, ACTING IS NOT. Everything in the check path runs as the
// service user with no privilege at all: `apt list --upgradable` needs none,
// and neither does reading /var/run/reboot-required. Actually applying updates
// needs root, which this service deliberately does not have — see runUpgrade.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

import { log } from '../log.js';

const CHECK_TIMEOUT_MS = 20_000;

/** @param {string[]} argv */
function run(argv, timeout = CHECK_TIMEOUT_MS) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout });
  return { status: r.status ?? 1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

/**
 * Packages this box could upgrade, and whether it is waiting for a reboot.
 *
 * apt only. A box running something else gets `supported: false` rather than a
 * wrong answer — guessing at a package manager is how you end up reporting
 * "0 updates" on a machine that has never checked.
 *
 * @returns {{ supported: boolean, count: number, security: number, rebootRequired: boolean, packages: string[], listsAgeHours?: number|null, reason?: string }}
 */
export function systemUpdates() {
  const none = { supported: false, count: 0, security: 0, rebootRequired: false, packages: [] };
  if (!existsSync('/usr/bin/apt')) return { ...none, reason: 'not an apt system' };

  const r = run(['apt', 'list', '--upgradable']);
  if (r.status !== 0) return { ...none, reason: r.stderr.split('\n')[0] || 'apt failed' };

  const lines = r.stdout
    .split('\n')
    .filter((l) => l.includes('/') && !l.startsWith('Listing'))
    .map((l) => l.trim());
  const security = lines.filter((l) => /-security/i.test(l)).length;

  return {
    supported: true,
    count: lines.length,
    security,
    rebootRequired: existsSync('/var/run/reboot-required'),
    listsAgeHours: packageListAgeHours(),
    // Names only. The full apt line is version noise that no notification has
    // room for.
    packages: lines.map((l) => l.split('/')[0]).slice(0, 20),
  };
}

/**
 * Roughly how long since the package lists were fetched.
 *
 * This matters more than it looks. A minimal Debian does not refresh them on
 * its own — apt-daily.timer only does so when unattended-upgrades has written
 * the periodic config, which a fresh install has not. So `apt list
 * --upgradable` on such a box answers against whatever was current the day it
 * was installed, and reports nothing forever while the machine falls months
 * behind. Reporting "0 updates" there is worse than reporting nothing.
 *
 * Approximate on purpose: the lists directory is touched when anything is
 * written, which is what "we asked recently" means here.
 *
 * @returns {number|null}
 */
function packageListAgeHours() {
  for (const p of ['/var/lib/apt/periodic/update-success-stamp', '/var/lib/apt/lists']) {
    try {
      return Math.round((Date.now() - statSync(p).mtimeMs) / 3_600_000);
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/**
 * Refresh the package lists, if this box has been given permission to.
 *
 * `apt-get update` fetches metadata and changes nothing else, which is why it
 * shares the sudoers rule with the upgrade rather than needing a decision of
 * its own. Rate-limited hard: the lists do not change minute to minute, and
 * this runs off a health report.
 *
 * @param {{ systemUpgrade?: boolean }} cfg
 * @param {{ now?: () => number, minAgeHours?: number }} [opts]
 */
export function refreshPackageLists(cfg, { now = () => Date.now(), minAgeHours = 6 } = {}) {
  if (!cfg.systemUpgrade) return { ok: false, reason: 'not permitted' };
  const age = packageListAgeHours();
  if (age !== null && age < minAgeHours) return { ok: false, reason: 'recent enough' };
  if (now() - lastRefreshAttempt < minAgeHours * 3_600_000) return { ok: false, reason: 'tried recently' };

  lastRefreshAttempt = now();
  const r = run(['sudo', '-n', '/usr/bin/apt-get', 'update'], 120_000);
  if (r.status !== 0) {
    log.warn(`upgrade: could not refresh package lists: ${(r.stderr || r.stdout).split('\n')[0]}`);
    return { ok: false, reason: 'failed' };
  }
  log.info('upgrade: refreshed package lists');
  return { ok: true };
}

let lastRefreshAttempt = 0;

/**
 * A sentence, or null when there is nothing worth saying.
 *
 * Null rather than "0 updates available" on purpose: this goes into a health
 * report that something else decides whether to surface, and a box with
 * nothing to say should be silent rather than reassuring.
 *
 * @param {ReturnType<typeof systemUpdates>} s
 */
export function describeSystemUpdates(s) {
  const age = typeof s.listsAgeHours === 'number' ? s.listsAgeHours : null;
  const stale = age !== null && age > 48;
  if (!s.supported || (!s.count && !s.rebootRequired && !stale)) return null;
  const parts = [];
  if (s.count) parts.push(`${s.count} package${s.count === 1 ? '' : 's'} can be upgraded`);
  if (s.security) parts.push(`${s.security} security`);
  if (s.rebootRequired) parts.push('reboot pending');
  // Said out loud rather than folded into the count, because a stale list makes
  // the count a lie in the reassuring direction — and on a box that never
  // refreshes on its own, that is the normal state rather than the exception.
  if (stale && age !== null) parts.push(`package lists ${Math.round(age / 24)}d old`);
  return parts.join(' · ');
}

/**
 * Apply system updates.
 *
 * The installer offers to set this up, and the grant is narrow enough to be
 * worth taking: sudoers matches the FULL ARGV, so the rule permits
 * `apt-get -y upgrade` and nothing else — not install, not remove, not a
 * shell, not apt-get with other arguments. That is a very different thing from
 * putting the service user in the sudo group.
 *
 * It is still off unless somebody said yes, because a service that can change
 * the operating system should be a decision somebody made rather than a
 * default they inherited. The message below is what an operator sees if it is
 * off and they want it on.
 *
 * @param {import('../config.js').Config} cfg
 * @param {{ actor?: string|null }} [opts]
 */
export function runUpgrade(cfg, { actor = null } = {}) {
  if (!cfg.systemUpgrade) {
    return {
      ok: false,
      text:
        'System upgrades are off.\n\n' +
        'This service runs unprivileged on purpose, so applying packages needs a rule that says ' +
        'so out loud. On the box:\n\n' +
        `  echo '${cfg.runUser} ALL=(root) NOPASSWD: /usr/bin/apt-get update, /usr/bin/apt-get -y upgrade' \\\n` +
        '    | sudo tee /etc/sudoers.d/agent-hub-upgrade\n' +
        '  sudo chmod 0440 /etc/sudoers.d/agent-hub-upgrade\n\n' +
        'then set AGENT_HUB_SYSTEM_UPGRADE=1 in /etc/agent-hub.env and restart.\n' +
        'Scoped to those two commands: it cannot install, remove or run anything else.',
    };
  }

  const before = systemUpdates();
  if (before.supported && !before.count) {
    return { ok: true, text: 'Nothing to upgrade.' + (before.rebootRequired ? ' A reboot is still pending.' : '') };
  }

  log.warn(`upgrade: applying system updates${actor ? ` for ${actor}` : ''}`);
  // -n: never prompt for a password. If the sudoers rule is missing this fails
  // in a second with a clear message rather than hanging on a prompt nobody can
  // answer.
  const r = run(['sudo', '-n', '/usr/bin/apt-get', '-y', 'upgrade'], 15 * 60_000);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout).split('\n').slice(-4).join('\n');
    return {
      ok: false,
      text:
        `apt-get upgrade failed:\n${detail}\n\n` +
        (/password is required|not allowed/i.test(detail)
          ? 'That is the sudoers rule missing — see /upgrade with AGENT_HUB_SYSTEM_UPGRADE unset for the exact line.'
          : 'Run it on the box to see the whole output.'),
    };
  }

  const after = systemUpdates();
  const applied = Math.max(0, before.count - after.count);
  return {
    ok: true,
    text:
      `Upgraded ${applied} package${applied === 1 ? '' : 's'}.` +
      (after.rebootRequired ? '\n\nA REBOOT IS PENDING. Nothing here will do that for you — sessions are running.' : ''),
  };
}
