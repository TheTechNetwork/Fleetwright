// What the sidecar says it is running, on every health frame.
//
// It lived inline in bin/fleetwright-sidecar, where nothing could test it, and
// moved here when it gained a case that has to be right: a checkout the
// sidecar's account does not own, which it must not run git in (update.js,
// ownedTree, says why) and which still has a version to report.

import { updateStatus } from '../../core/update.js';
import { installedVersion, currentVersion } from '../../core/release-apply.js';
import { INSTALL_ROOT } from '../../core/resources.js';
import { helperState } from '../../core/migrate.js';

/**
 * The commit on disk right now. From updateStatus rather than a constant
 * baked at build time: the restart watcher can put this process on new code
 * without anything rebuilding, and what a person reading the app wants is
 * what is running, not what was compiled.
 *
 * @param {import('../../config.js').Config} hub  fleetwright's configuration as this process sees it
 * @param {{ installRoot?: string, uid?: number }} [opts]  the tree this
 *   process loaded, and the account it compares owners with; INSTALL_ROOT and
 *   its own unless a test says otherwise
 * @returns {{ head: string|null, branch: string|null, installed?: string|null, helper?: 'current'|'stale'|null }|null}
 */
export function runningVersion(hub, { installRoot = INSTALL_ROOT, uid } = {}) {
  const st = updateStatus(hub, uid === undefined ? undefined : { uid });
  if (st.ok) return { head: st.head ?? null, branch: st.branch ?? null };
  // A CHECKOUT THIS ACCOUNT DOES NOT OWN, which is every checkout install: the
  // tree is the service user's and the sidecar runs as its own account. Git is
  // not run there any more, so the version is the one this process's own
  // package.json names — less precise than a commit, and true. `branch` stays
  // null rather than guessed: the branch is git's answer, and git was not asked.
  if (st.notOwned) {
    const v = installedVersion(installRoot);
    return v === 'unknown' ? null : { head: v, branch: null };
  }
  // A PACKAGED BOX HAS A VERSION TOO, and it reported none. updateStatus
  // answers `ok: false` for a release — correctly, there is no checkout to
  // read — and this returned null, which the apps render as "version not
  // reported" on a machine that knows exactly what it is running.
  //
  // The release version is the honest answer to the same question. `branch`
  // stays null: a release is not on one, and inventing "release" there
  // would be a word the app might one day try to use.
  if (st.packaged) {
    // FROM THIS PROCESS'S OWN TREE, not from hub.installDir. On a release
    // install that is `<base>/current`, which follows the symlink to
    // whatever is on disk now, so `head` and `installed` were the same
    // read and a sidecar running an old release reported the new one.
    // INSTALL_ROOT is found from this bundle's own file, symlinks resolved.
    const v = installedVersion(installRoot);
    // AND WHAT `current` POINTS AT, which is a different question once an
    // update has landed and this process has not restarted. `head` is
    // what this sidecar is running, read from its own directory;
    // `installed` is what the box would run after a restart. The apps
    // draw the gap, because "up to date" about a service running an old
    // release out of a box whose disk holds a newer one was the exact
    // sentence a fleet showed for fourteen releases.
    // AND WHETHER ROOT'S HALF IS THIS RELEASE'S. The helper is what every
    // update runs as root and the installer is the only thing that writes
    // it; a box whose helper the installer never refreshed restarts its
    // services on every update and refreshes nothing else, and the only
    // place that said so was the hub's journal. Compared against the
    // tree this sidecar runs, for the reason helperState gives — which
    // is INSTALL_ROOT by name: on a packaged Linux box hub.installDir is
    // the hub's `current` (the unit says so) and this runs a root-owned
    // copy elsewhere, so the two are no longer one directory.
    return v === 'unknown'
      ? null
      : { head: v, branch: null, installed: currentVersion(hub.installDir), helper: helperState({ installRoot }) };
  }
  return null;
}
