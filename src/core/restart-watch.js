// How an update reaches every service, without anybody opening a terminal.
//
// THE PROBLEM. `/update --restart` pulls code for all three services shipped
// from /opt/agent-fleet and restarts exactly one: the hub, by exiting and
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
// SO: the updater leaves a marker, and every service watches for it. A marker
// written after a service started means that service is running code older than
// the tree it was launched from, and it exits. systemd brings it straight back
// on the new code.
//
// All three run as the same user from the same directory, so the marker needs
// no permission that is not already held. That is the whole reason this is
// cheap.
//
// WHY A MARKER RATHER THAN WATCHING GIT. A pull is not atomic. A service that
// notices the tree changed can wake up midway through one and load half of an
// update. The marker is written by the updater AFTER the pull has succeeded,
// so it means "there is a complete new tree", which is a different and much
// safer claim than "something moved".

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { log } from '../log.js';

/** Where the marker lives. Overridable so tests do not need /var/lib. */
export function markerPath(stateDir = process.env.AGENT_HUB_STATE_DIR || '/var/lib/agent-hub') {
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

/**
 * Exit when an update lands, so systemd restarts this process on the new code.
 *
 * @param {object} o
 * @param {string} [o.name]        for the log line
 * @param {number} [o.since]       treat markers older than this as already applied
 * @param {number} [o.everyMs]
 * @param {string} [o.stateDir]
 * @param {() => void} [o.exit]    injectable for tests
 * @returns {() => void} stop
 */
export function watchForRestart({
  name = 'service',
  since = Date.now(),
  everyMs = 15_000,
  stateDir,
  exit = () => process.exit(0),
} = {}) {
  const timer = setInterval(() => {
    const marker = readMarker(stateDir);
    // Strictly newer than our own start. Without this a service that comes up
    // after an update reads the marker that caused it and exits again, for ever
    // — a restart loop built out of the mechanism meant to end one.
    if (!marker || marker.at <= since) return;
    log.warn(`${name}: new code was installed${marker.actor ? ` by ${marker.actor}` : ''} — restarting to pick it up`);
    clearInterval(timer);
    exit();
  }, everyMs);

  // Unref'd, unlike the transport's retry timer. This one must never be the
  // reason a process stays alive: a service whose real work has finished should
  // exit, not linger because it is still watching for an update it will never
  // act on.
  timer.unref?.();
  return () => clearInterval(timer);
}
