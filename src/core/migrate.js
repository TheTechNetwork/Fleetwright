// Moving a checkout onto packaged releases, from the app.
//
// THE LAST THING ABOUT UPDATING THAT NEEDED A SHELL. A packaged box updates by
// fetching a tarball, checking a sha256 and moving a symlink — all of it as the
// service user. A CHECKOUT cannot get there on its own: becoming packaged means
// rewriting systemd units and reloading the daemon, and the service is
// unprivileged on purpose.
//
// So there is one narrow sudoers rule, and everything about it is written to be
// reviewable. /usr/local/sbin/fleetwright-migrate is root-owned and takes no
// arguments; the install tree is NOT a candidate for it, because the service
// user can write that tree — it has to, in order to unpack releases into it —
// and a rule naming a script the caller can rewrite is root with extra steps.
//
// What this module does is decide WHETHER and report WHAT HAPPENED. The
// judgement of whether a release is worth taking is decideRelease's, reached
// through checkRelease, so a migration cannot be offered for a release the box
// would then refuse.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { requestRestart } from './restart-watch.js';

export const MIGRATE_BIN = '/usr/local/sbin/fleetwright-migrate';

/**
 * Can this box be moved onto packaged releases, and is there one to move to?
 *
 * @param {import('../config.js').Config} cfg
 * @param {{ packaged?: boolean }} status what updateStatus said — `packaged`
 *   is absent on a checkout, which is the shape updateStatus really returns
 * @param {{ available: string|null, configured: boolean }} release what checkRelease found
 * @param {{ exists?: (p: string) => boolean }} [opts]
 * @returns {{ can: boolean, reason: string, message: string }}
 */
export function migrationState(cfg, status, release, { exists = existsSync } = {}) {
  if (status.packaged) {
    return { can: false, reason: 'packaged', message: 'This box already installs packaged releases.' };
  }
  if (!release.configured) {
    return {
      can: false,
      reason: 'unconfigured',
      message:
        'This box does not know where its releases come from, so there is nothing to move it to.\n' +
        'Set AGENT_HUB_RELEASE_MANIFEST in /etc/agent-hub.env, or re-run the installer with --upgrade.',
    };
  }
  // THE GRANT IS CHECKED BEFORE IT IS OFFERED. A button that fails with "sudo:
  // a password is required" has told somebody nothing they can act on from a
  // phone, and the remedy is one command on the box — so name it here, where
  // whoever is reading can pass it on, rather than after they have tapped.
  if (!exists(MIGRATE_BIN)) {
    return {
      can: false,
      reason: 'no_helper',
      message:
        `${MIGRATE_BIN} is not installed on this box, so it cannot move itself.\n` +
        'Re-run the installer with --upgrade and it will put it there.',
    };
  }
  if (!release.available) {
    return {
      can: false,
      reason: 'nothing_waiting',
      message: 'This box is a checkout, and there is no release waiting that it could move to.',
    };
  }
  return {
    can: true,
    reason: 'ready',
    message:
      `This box is a git checkout. ${release.available} is waiting as a package.\n` +
      'Applying an update will move it onto packaged releases — after which updates are a ' +
      'download and a symlink, with no checkout to drift.',
  };
}

/**
 * Do it.
 *
 * Synchronous and slow — it downloads a release and re-runs the installer —
 * which is why the caller only reaches this on an explicit apply and never on a
 * check. Twenty minutes is the timeout because the installer may build a
 * sandbox image on the way through, and a migration killed halfway is worse
 * than one that took a while.
 *
 * @param {{ run?: typeof spawnSync }} [opts]
 */
export function migrate({ run = spawnSync } = {}) {
  // `sudo -n`: never prompt. There is no terminal here and a sudo waiting for a
  // password would hang until the timeout with nothing to show for it.
  const r = run('sudo', ['-n', MIGRATE_BIN], { encoding: 'utf8', timeout: 20 * 60_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status === 0) {
    return {
      ok: true,
      // The tail, because the installer's output is long and what somebody
      // needs is how it ended.
      text: `Moved onto packaged releases.\n\n${out.split('\n').slice(-12).join('\n')}`,
    };
  }
  return {
    ok: false,
    text:
      `The migration failed.\n\n${out.split('\n').slice(-12).join('\n') || `sudo exited ${r.status}`}\n\n` +
      'Nothing was switched over: the units still point at the checkout, and this box is ' +
      'running exactly what it was running before.',
  };
}


/**
 * The whole answer for `/update` on a box that is still a checkout, or null
 * when there is nothing to say and git should have its turn.
 *
 * HERE RATHER THAN IN commands.js, and not for tidiness. The branch this
 * replaces was four returns deep inside the update verb, where the only way to
 * reach it was through a dispatch that does real network I/O and a real
 * `existsSync` — so it was code nothing executed, which the coverage gate said
 * out loud on the first run after it landed. Moved here it takes injections and
 * is tested directly.
 *
 * @param {import('../config.js').Config} cfg
 * @param {{ packaged?: boolean }} status
 * @param {{ available: string|null, configured: boolean }} release
 * @param {{ apply?: boolean, check?: boolean, exists?: (p: string) => boolean, run?: typeof spawnSync }} opts
 * @returns {{ ok: boolean, text: string, buttons?: Array<{label: string, command: string}> }|null}
 */
export function migrationReply(cfg, status, release, { apply = false, check = false, exists = existsSync, run = spawnSync } = {}) {
  if (status.packaged || !cfg.releaseManifest) return null;
  const m = migrationState(cfg, status, release, { exists });

  if (m.can) {
    // THE SAME CHECK/APPLY SPLIT AS THE REST OF THIS SCREEN. A layout change is
    // not a thing to discover having happened, so a bare /update says what
    // would happen and only an explicit apply does it.
    if (!apply) {
      return {
        ok: true,
        text: `${m.message}\n\n/update --apply to do it.`,
        buttons: [{ label: 'Move to packaged releases', command: '/update --apply' }],
      };
    }
    return migrate({ run });
  }

  // Two of the four refusals are worth saying even though the git path still
  // works, because they are the REASON this box is still a checkout and both
  // name a fix. `packaged` cannot be reached from here and `nothing_waiting` is
  // not news — git has the better answer for those.
  if (check && (m.reason === 'no_helper' || m.reason === 'unconfigured')) {
    return { ok: true, text: m.message };
  }
  return null;
}

/**
 * After a release has been applied unprivileged, have root refresh its half.
 *
 * applyRelease fetches, verifies, unpacks and swaps `current` as the service
 * user, and that is everything an update needs — except what root owns: the
 * units, the Claude hook, the sudoers rules and the migrate helper itself. Those
 * stayed as the last installer left them, so a box could be on the newest
 * release and running units from three releases ago, and the only cure was a
 * shell. The helper heals that now: on a box already on the manifest's version
 * it unpacks a verified copy and runs that release's installer with --repair.
 *
 * DEFERRED, NOT AWAITED, and the reason is the reply. The installer restarts
 * agent-hub — this process — so a verb that waited for it would never answer
 * the phone that asked. The reply goes out first; the heal starts after the
 * same delay a restart waits for the reply to leave. If the heal cannot run,
 * the process still restarts itself so the new code applies either way: the
 * heal is the better restart, never a reason to skip one.
 *
 * THE MARKER IS WRITTEN FIRST, before the helper runs, and this is the fix for
 * a fleet that showed a box as `main-88 · up to date` while the box itself
 * said "already on main-102". This path used to restart with a bare exit: when
 * the heal failed, the hub came back on the new release and NOBODY TOLD THE
 * SIDECAR — the restart marker that restart-watch.js exists to provide was
 * only ever written by restartSelf, which the scheduled heal skips. The
 * sidecar stayed on the old release, reporting the old version, and the
 * fleet read that as current.
 *
 * Before, not after, and the order is load-bearing. The marker means "a
 * complete new tree is on disk", which is already true here — applyRelease
 * has swapped `current`. Written now, a sibling the installer restarts starts
 * AFTER the marker and ignores it; a sibling the installer failed to restart
 * started before it and picks it up within a minute. Written after the
 * installer returned, every sibling it had just restarted would restart a
 * second time for nothing.
 *
 * @param {{ run?: typeof spawnSync, exists?: (p: string) => boolean,
 *   after?: (fn: () => void) => void, restart?: () => void,
 *   mark?: typeof requestRestart, head?: string|null, actor?: string|null, stateDir?: string|null,
 *   logger?: { warn: Function, info: Function } }} [opts]
 * @returns {{ scheduled: boolean, text: string }}
 */
export function healAfterRelease({
  run = spawnSync,
  exists = existsSync,
  after = (fn) => setTimeout(fn, 1500),
  restart = () => process.exit(0),
  mark = requestRestart,
  head = null,
  actor = null,
  stateDir = null,
  logger = console,
} = {}) {
  if (!exists(MIGRATE_BIN)) {
    return {
      scheduled: false,
      text:
        `${MIGRATE_BIN} is not installed, so the units, hook and sudoers rules this release's installer ` +
        'writes were not refreshed. Re-run the installer once with --upgrade and every update after it will.',
    };
  }
  after(() => {
    // Told BEFORE anything else happens. Whatever the helper does next — runs,
    // fails, is refused by sudo — every service on this box now knows there is
    // a newer tree than the one it started from.
    mark({ head: head ?? undefined, actor: actor ?? undefined, stateDir: stateDir ?? undefined });
    const r = run('sudo', ['-n', MIGRATE_BIN], { encoding: 'utf8', timeout: 20 * 60_000 });
    if (r.status === 0) {
      // The installer restarted the services on its way out, this one
      // included — reaching here means it did not, so do it ourselves.
      logger.info('update: the release\u2019s installer ran with --repair; restarting to apply new code');
    } else {
      const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-6).join('\n');
      logger.warn(`update: could not refresh what the installer generates (sudo exited ${r.status}) — restarting anyway\n${out}`);
    }
    restart();
  });
  return {
    scheduled: true,
    text:
      'In a moment the release\u2019s own installer runs with --repair, so the units, the hook and the ' +
      'sudoers rules follow the release, and the services restart on the new code. Sessions are left running.',
  };
}
