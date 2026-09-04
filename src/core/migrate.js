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
