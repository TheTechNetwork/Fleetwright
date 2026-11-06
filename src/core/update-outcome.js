// What the last update did NOT finish, kept where the next question can read it.
//
// AN UPDATE IS SEVERAL THINGS, and the reply said "ok" when the first of them
// worked. The code lands; the session image is pulled again; stored credential
// files are tidied; on a packaged box the release's own installer runs as root
// with --repair; the services restart. Each of those can fail on its own, and
// three of them failed quietly: the image pull returned `ok: true` with the
// reason in prose (src/core/update.js, refreshSandboxImageStep — boxes stayed on
// an old image while /update said they were current, which is the incident that
// function's comment records), the credential sweep did the same, and the root
// repair runs AFTER the reply has left, so when sudo refused it the only record
// was a journal line and the services restarted anyway, on top of a reply that
// had already promised the repair.
//
// So the parts that did not finish are written down here, and `/updates` — the
// question the phone asks every fifteen minutes and on every Check — reads them
// back and says so, beside "up to date", until an update finishes them. The
// shape is per step, because the steps are written by different processes at
// different moments: the update writes image and credentials as it goes and
// leaves repair unknown; the deferred heal writes repair when it knows.
//
// NOTHING HERE FAILS AN UPDATE. A box that could not write this file is still a
// box that wants the new code; the file is a record, not a gate.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** @typedef {'image'|'credentials'|'repair'} UpdateStep */
/** @typedef {{ ok: boolean, text: string }} StepOutcome */
/** @typedef {{ at: number, steps: Partial<Record<UpdateStep, StepOutcome|null>> }} UpdateOutcome */

/** What each step is called when it is named to a person. */
export const STEP_NAMES = Object.freeze({
  image: 'the session image',
  credentials: 'tidying stored credentials',
  repair: 'the root repair',
});

/** @param {string} stateDir */
export function outcomePath(stateDir) {
  return path.join(stateDir, 'last-update.json');
}

/**
 * The record as it stands, or null where there is none or it cannot be read.
 * Null is CANNOT TELL — a box that has never updated, or a state directory
 * another account owns — and never "everything finished".
 *
 * @param {string|null|undefined} stateDir
 * @returns {UpdateOutcome|null}
 */
export function readUpdateOutcome(stateDir) {
  if (!stateDir) return null;
  try {
    const raw = JSON.parse(readFileSync(outcomePath(stateDir), 'utf8'));
    if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.at) || !raw.steps || typeof raw.steps !== 'object') return null;
    return { at: raw.at, steps: raw.steps };
  } catch {
    return null;
  }
}

/**
 * Write the outcome of some steps, keeping what is already recorded about the
 * others. `null` for a step means it has not been decided yet: an update
 * writes `repair: null` before scheduling the heal, so a stale repair verdict
 * from the update before does not outlive the update that superseded it.
 *
 * @param {string|null|undefined} stateDir
 * @param {Partial<Record<UpdateStep, StepOutcome|null>>} steps
 * @param {{ at?: number, fresh?: boolean }} [opts] `fresh` starts a new record
 *   rather than merging into the last one — the start of an update.
 * @returns {UpdateOutcome|null} what was written, or null when it could not be
 */
export function recordUpdateOutcome(stateDir, steps, { at = Date.now(), fresh = false } = {}) {
  if (!stateDir) return null;
  const before = fresh ? null : readUpdateOutcome(stateDir);
  /** @type {UpdateOutcome} */
  const next = { at: before?.at ?? at, steps: { ...(before?.steps ?? {}), ...steps } };
  if (fresh) next.at = at;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(outcomePath(stateDir), JSON.stringify(next) + '\n');
    return next;
  } catch {
    return null;
  }
}

/**
 * The steps of an outcome that did not finish, each with its reason.
 * @param {UpdateOutcome|null|undefined} outcome
 * @returns {Array<{ step: UpdateStep, text: string }>}
 */
export function unfinished(outcome) {
  if (!outcome) return [];
  return /** @type {UpdateStep[]} */ (Object.keys(outcome.steps))
    .filter((step) => outcome.steps[step] && outcome.steps[step]?.ok === false)
    .map((step) => ({ step, text: String(outcome.steps[step]?.text ?? '') }));
}

/**
 * One sentence naming what the last update did not finish, or null when it
 * finished everything it recorded or there is no record. Null adds nothing to
 * a reply; a sentence goes first in one.
 *
 * @param {UpdateOutcome|null|undefined} outcome
 * @returns {string|null}
 */
export function describeUnfinished(outcome) {
  const left = unfinished(outcome);
  if (!left.length) return null;
  const when = outcome?.at ? ` (${new Date(outcome.at).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : '';
  return `The last update${when} did not finish everything: ` + left.map((l) => `${STEP_NAMES[l.step] ?? l.step} — ${l.text}`).join('; ') + '.';
}
