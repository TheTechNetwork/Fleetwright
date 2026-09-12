// Commit-confirm for updates: apply, then keep it only if the box proves itself,
// or a watchdog OUTSIDE the app puts the release it came from back.
//
// THE CISCO `reload in` PATTERN, and it is here for the outage this project
// already lived through. An update swapped the code, every service restarted
// cleanly, and every session died at `mount proc` — a box that "updated fine"
// and could no longer do the one thing it exists for, with (as the update
// screen itself says) no way to tell you afterwards. A human types `reload in
// 10` before a risky change so a box that loses its head comes back on its own;
// this is that, for a fleet with no terminal.
//
// WHO WATCHDOGS THE WATCHDOG. The first cut of this ran the timer INSIDE the
// sidecar — and a watchdog that has to start in order to run cannot catch its
// own failure to start. Any of the three services can be the one an update
// breaks, so the arbiter cannot be app code at all. It is a standing systemd
// timer (install/agent-fleet-confirm.*) running install/fleetwright-confirm as
// the service user: the one thing on the box that is always up and never part
// of an update. This module is only the app's HALF — it arms the trial and
// records health evidence; the script decides.
//
// TWO HALVES OF HEALTH, because "reached the coordinator" alone would have
// CONFIRMED the mount-proc outage (the box was online; sessions were dead). The
// hub writes it can start a session (a real `podman run`), the sidecar writes it
// reached the coordinator, and the script keeps the update only if BOTH are
// fresh. A broken hub, a broken sidecar, or a broken coordinator link each
// leaves one half missing, and the update reverts.
//
// SHELL-READABLE ON PURPOSE. The record is KEY=VALUE, not JSON, because the
// thing that reads it must work when node is the broken part — the revert script
// is POSIX shell and depends on nothing the update ships.

import { readFileSync, writeFileSync, mkdirSync, rmSync, utimesSync, closeSync, openSync } from 'node:fs';
import path from 'node:path';

import { log } from '../log.js';

/** The default trial window, and the number the Cisco reference lands on. */
const DEFAULT_WINDOW_MS = 10 * 60_000;

/** The two halves of health, each a process that a bad update can break. */
export const EVIDENCE = Object.freeze(['hub', 'coord']);

/** @param {string} stateDir */
export function confirmPath(stateDir) {
  return path.join(stateDir, 'update-confirm');
}

/** @param {string} stateDir @param {string} which */
export function evidencePath(stateDir, which) {
  return path.join(stateDir, `confirm-${which}.ok`);
}

/**
 * Put a release on trial: keep it if both halves of health arrive, else the
 * watchdog reverts to `from`.
 *
 * `windowMs` of 0 disables commit-confirm — an update then simply stays, as it
 * did before this existed. `from` is what a revert returns to, so an update with
 * nothing to fall back to (a first install, or `from === to`) arms nothing and
 * says so rather than pretending to guard.
 *
 * Any stale evidence is cleared as the trial arms, so a previous update's health
 * can never confirm this one (the script also ignores evidence older than the
 * trial file — this is the belt to that suspenders).
 *
 * @param {import('../config.js').Config} cfg
 * @param {{ from: string|null, to: string, windowMs?: number, now?: () => number }} opts
 * @returns {{ armed: boolean, from?: string, to?: string, windowMs?: number, why?: string }}
 */
export function armConfirmation(cfg, { from, to, windowMs, now = Date.now }) {
  const win = windowMs ?? cfg.updateConfirmMs ?? DEFAULT_WINDOW_MS;
  if (!win || win <= 0) return { armed: false, why: 'commit-confirm is off' };
  if (!from || !to || from === to) return { armed: false, why: 'nothing to revert to' };
  try {
    mkdirSync(cfg.stateDir, { recursive: true });
    for (const which of EVIDENCE) rmSync(evidencePath(cfg.stateDir, which), { force: true });
    // KEY=VALUE, in the order the script reads them. from/to are validated
    // release names and windowMs/armedAt are numbers, so there is nothing here a
    // shell `read` could mishandle.
    const body = `FROM=${from}\nTO=${to}\nWINDOW_MS=${win}\nARMED_AT=${now()}\n`;
    writeFileSync(confirmPath(cfg.stateDir), body);
  } catch (e) {
    // An update that aborts because it could not write a trial record would be
    // worse than one that is simply unguarded — the code is already on disk.
    return { armed: false, why: /** @type {Error} */ (e).message };
  }
  return { armed: true, from, to, windowMs: win };
}

/**
 * The trial in progress, or null. Never throws — an unreadable record is no
 * trial rather than a reason to take a box down.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {{ from: string, to: string, windowMs: number, armedAt: number }|null}
 */
export function readConfirmation(cfg) {
  let raw;
  try {
    raw = readFileSync(confirmPath(cfg.stateDir), 'utf8');
  } catch {
    return null;
  }
  /** @type {Record<string, string>} */
  const kv = {};
  for (const line of raw.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  const from = kv.FROM;
  const to = kv.TO;
  const windowMs = Number(kv.WINDOW_MS);
  const armedAt = Number(kv.ARMED_AT);
  if (!from || !to || !Number.isFinite(windowMs) || !Number.isFinite(armedAt)) return null;
  return { from, to, windowMs, armedAt };
}

/**
 * Record this box's half of health: `hub` (a session can start) or `coord`
 * (the coordinator is reachable). A no-op when nothing is on trial, so a healthy
 * box never litters its state directory.
 *
 * The evidence IS the file's freshness — the watchdog compares its mtime against
 * the trial file, so an existing-and-newer file is the signal and its contents
 * do not matter.
 *
 * @param {import('../config.js').Config} cfg
 * @param {'hub'|'coord'} which
 * @returns {{ noted: boolean, why?: string }}
 */
export function noteHealth(cfg, which) {
  if (!EVIDENCE.includes(which)) return { noted: false, why: `unknown evidence "${which}"` };
  if (!readConfirmation(cfg)) return { noted: false, why: 'nothing on trial' };
  const file = evidencePath(cfg.stateDir, which);
  try {
    // Create if absent, then stamp it now so "written after the trial armed" is
    // true even on a box where the file lingered from a previous trial.
    closeSync(openSync(file, 'a'));
    const t = new Date();
    utimesSync(file, t, t);
  } catch (e) {
    return { noted: false, why: /** @type {Error} */ (e).message };
  }
  log.info(`update: recorded ${which} health for the release on trial`);
  return { noted: true };
}
