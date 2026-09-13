// Reclaiming the release directories prune could not remove.
//
// THE OTHER HALF OF prune's QUARANTINE. When prune (release-apply.js) meets a
// release it cannot delete as the service user — a legacy one left root-owned by
// an old `sudo` install — it renames it aside to `.stale-<name>` rather than
// failing the update. Renaming is all an unprivileged process can do; removing a
// root-owned tree needs root. This module is the one narrow place that asks for
// it, through the same sudoers shape as migrate.js: a fixed-argv, root-owned
// helper the service user may run but cannot rewrite.
//
// It decides WHETHER to call and reports WHAT HAPPENED; the helper decides
// nothing this side can widen — it removes only `<base>/releases/.stale-*`, so
// the worst a caller can do is ask it to sweep quarantine that is already there.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { releaseLayout } from './release-apply.js';
import { RELEASES_DIR } from './release.js';
import { log } from '../log.js';

export const RECLAIM_BIN = '/usr/local/sbin/fleetwright-reclaim';

/**
 * The quarantined directories waiting to be reclaimed, if any.
 *
 * Cheap and side-effect free, so the sudo call is only made when there is
 * actually something to remove — a settled box pays a single readdir and never
 * shells out.
 *
 * @param {string} base
 * @returns {string[]}
 */
export function staleReleases(base) {
  try {
    return readdirSync(path.join(base, RELEASES_DIR)).filter((v) => v.startsWith('.stale-'));
  } catch {
    return [];
  }
}

/**
 * Sweep quarantined releases, if there are any and the helper is installed.
 *
 * Never throws. Reclaiming disk is housekeeping — a box runs sessions perfectly
 * well with a stale directory sitting there, so nothing here is allowed to take
 * the process down, and every failure is a logged line rather than an exception.
 *
 * @param {import('../config.js').Config} cfg
 * @param {{ run?: typeof spawnSync, exists?: (p: string) => boolean }} [opts]
 * @returns {{ swept: boolean, reason: string, message?: string }}
 */
export function reclaimStale(cfg, { run = spawnSync, exists = existsSync } = {}) {
  const layout = releaseLayout(cfg.installDir);
  if (!layout.ok) return { swept: false, reason: 'unpackaged' };

  const stale = staleReleases(layout.base);
  if (stale.length === 0) return { swept: false, reason: 'none' };

  // THE HELPER MAY NOT BE THERE YET, and that is a state to report rather than
  // an error to throw. A box that quarantined a release before this shipped will
  // carry the `.stale-` directory until an installer puts the helper down; until
  // then the quarantine is harmless (it is out of the release namespace) and the
  // update it came from succeeded regardless.
  if (!exists(RECLAIM_BIN)) {
    return {
      swept: false,
      reason: 'no_helper',
      message:
        `${stale.length} quarantined release(s) are waiting, but ${RECLAIM_BIN} is not installed to remove them.\n` +
        'Re-run the installer with --upgrade and it will put the helper and its sudoers rule in place.',
    };
  }

  try {
    // -n: never prompt. If the sudoers rule is missing this is refused rather
    // than hanging a background process on a password nobody will type.
    const r = run('sudo', ['-n', RECLAIM_BIN], { encoding: 'utf8', timeout: 60_000 });
    if (r.status === 0) {
      log.info(`update: reclaimed ${stale.length} quarantined release(s)`);
      return { swept: true, reason: 'ok', message: `reclaimed ${stale.length} quarantined release(s)` };
    }
    const why = String(r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 200);
    log.warn(`update: could not reclaim quarantined releases: ${why}`);
    return { swept: false, reason: 'failed', message: why };
  } catch (e) {
    const why = /** @type {Error} */ (e).message;
    log.warn(`update: could not reclaim quarantined releases: ${why}`);
    return { swept: false, reason: 'failed', message: why };
  }
}
