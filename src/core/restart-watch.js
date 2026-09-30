// How an update reaches every service, without anybody opening a terminal.
//
// THE PROBLEM. `/update --restart` pulls code for all three services shipped
// from /opt/fleetwright-src and restarts exactly one: the hub, by exiting and
// letting systemd's Restart=always bring it back. The sidecar and the
// coordinator keep running whatever was on disk before the pull, and the only
// fix on offer was "ssh in and systemctl restart" — which is the thing this
// product exists so that nobody has to do. An update that needs a terminal to
// finish is not an update.
//
// WHY NOT SUDO. A rule in /etc/sudoers.d permitting `systemctl restart` would
// work, and the installer already writes two of those. It is the wrong tool
// here: it is a standing privilege escalation, granted for the life of the box,
// to solve a problem that lasts one second. And it is unnecessary, because the
// hub already demonstrates the answer — a service under Restart=always restarts
// itself by exiting, and exiting needs no privilege at all.
//
// SO: the updater leaves a marker, and the hub publishes its time on
// /api/state as `restartRequestedAt`. A time after a service started means that
// service is running code older than the tree it was launched from, and it
// exits. systemd brings it straight back on the new code.
//
// THE SIDECAR READS IT OVER THE LOOPBACK, NOT FROM THE FILE. It used to watch
// the marker itself, which worked while the two services ran as one user and
// stopped the day the sidecar got its own account (#270): the state directory
// is fleetwright's, 0750, and an unreadable marker is read as no marker. So a
// checkout box's sidecar ran old code until somebody restarted it by hand. The
// hub already answers /api/state to the sidecar every fifteen seconds; the
// marker's time rides on it (src/adapters/http.js) and the sidecar compares
// it with its own start (src/fleet/host/sidecar.js, #noticeRestart).
//
// WHY A MARKER RATHER THAN WATCHING GIT. A pull is not atomic. A service that
// notices the tree changed can wake up midway through one and load half of an
// update. The marker is written by the updater AFTER the pull has succeeded,
// so it means "there is a complete new tree", which is a different and much
// safer claim than "something moved".

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { log } from '../log.js';
import { preferExisting } from '../fleet/legacy-paths.js';

/** Where the marker lives. Overridable so tests do not need /var/lib. */
export function markerPath(stateDir = process.env.FLEETWRIGHT_STATE_DIR || preferExisting('/var/lib/fleetwright', '/var/lib/agent-hub')) {
  return path.join(stateDir, 'restart-marker.json');
}

/**
 * Record that a complete new tree is on disk.
 *
 * Called by the updater after a successful pull and before it exits. Failure is
 * swallowed deliberately: the hub is about to restart itself either way, and an
 * update that aborts because it could not write a hint is worse than one whose
 * siblings restart a few minutes later when somebody notices.
 *
 * @param {{ head?: string, actor?: string|null, stateDir?: string }} [opts]
 */
export function requestRestart({ head = '', actor = null, stateDir } = {}) {
  const file = markerPath(stateDir);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ at: Date.now(), head, actor }) + '\n');
    return true;
  } catch (e) {
    log.warn(`update: could not write the restart marker (${/** @type {Error} */ (e).message})`);
    return false;
  }
}

/** @param {string} [stateDir] */
export function readMarker(stateDir) {
  try {
    const raw = JSON.parse(readFileSync(markerPath(stateDir), 'utf8'));
    return Number.isFinite(raw?.at) ? raw : null;
  } catch {
    // No marker is the normal case on a box that has never updated, and an
    // unreadable one is not worth taking a service down over.
    return null;
  }
}
