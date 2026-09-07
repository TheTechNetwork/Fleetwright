// Labels a person can change without a shell.
//
// Labels are how work is aimed: `tag: gpu` on a start, and the scheduler
// filters before it ranks. They came from two places, and neither of them was
// reachable from a phone — AGENT_FLEET_LABELS in a root-owned env file, and
// auto-labels.js deriving what the machine knows about itself. So "this box is
// on the noisy switch, keep the long jobs off it" was a decision somebody could
// make and not express, which is the shape this repository keeps finding.
//
// Third place, same as the release channel and the sandbox variant: one small
// file in the state directory, which the service owns and can write.
//
// WHAT THIS DELIBERATELY CANNOT DO IS REMOVE THE OTHER TWO. An auto label is a
// fact — `arm64`, `debian`, `browser` — and a fact somebody can switch off from
// a phone is not a fact any more. `tag: arm64` finding a box that turned its
// label off would be the scheduler quietly lying about what it matched. The
// refusal names where the label actually comes from, which is the same rule
// channel.js and sandbox-variant.js already follow: refuse and say where,
// rather than write something the next read ignores.
//
// So the three sources compose, and each one is answerable:
//
//   auto  the machine's own facts, from auto-labels.js
//   env   AGENT_FLEET_LABELS, set at install time
//   set   this file — added from an app, removable from the same app

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/**
 * The charset, and it is the intents protocol's `name` type on purpose.
 *
 * A label crosses the wire as a `tag` in an envelope and is compared against
 * this list by the scheduler; two validators disagreeing about what a label may
 * contain is how a label gets stored that nothing can ever match. Bounded at 40
 * for the same reason names are.
 */
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

/** How many a box may carry. A bound rather than a judgement: this file is read
 * on a path taken per health frame, and an unbounded list is a way to make that
 * path slow from a phone. */
const MAX = 64;

/** @param {import('../config.js').Config} cfg */
function labelsFile(cfg) {
  return path.join(cfg.stateDir, 'labels');
}

/**
 * The labels set from an app, in the order they will be reported.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {string[]}
 */
export function readLabels(cfg) {
  if (!cfg.stateDir) return [];
  try {
    return [...new Set(
      String(readFileSync(labelsFile(cfg), 'utf8'))
        .split('\n')
        .map((l) => l.trim().toLowerCase())
        // A LINE THAT IS NOT A LABEL IS DROPPED, NOT REPAIRED. Somebody editing
        // this file by hand, or a shape from an older version, should not be
        // able to put an unmatchable string into the scheduler's filter.
        .filter((l) => LABEL_RE.test(l)),
    )].sort();
  } catch {
    // No file is the ordinary case: a box nobody has labelled from an app.
    return [];
  }
}

/**
 * @param {import('../config.js').Config} cfg
 * @param {string[]} labels
 * @returns {{ ok: boolean, message: string }}
 */
function write(cfg, labels) {
  const file = labelsFile(cfg);
  const tmp = `${file}.tmp`;
  try {
    // Written and renamed, so a box that loses power mid-write has the old list
    // or the new one and never half of either.
    writeFileSync(tmp, labels.length ? `${labels.join('\n')}\n` : '', { mode: 0o644 });
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return { ok: false, message: `could not write ${file}: ${/** @type {Error} */ (e).message}` };
  }
  return { ok: true, message: '' };
}

/**
 * Add a label to this box.
 *
 * `known` is what the box already carries from the other two sources, so this
 * can say "you already have that, and it is not yours to add" rather than
 * storing a duplicate that shadows a fact.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} value
 * @param {string[]} [known] labels from auto-labels and the environment
 * @returns {{ ok: boolean, label?: string, labels: string[], message: string }}
 */
export function addLabel(cfg, value, known = []) {
  const wanted = String(value || '').trim().toLowerCase();
  const current = readLabels(cfg);
  if (!LABEL_RE.test(wanted)) {
    return {
      ok: false,
      labels: current,
      message:
        `"${String(value).slice(0, 40)}" is not a label. Labels start with a letter or digit and ` +
        'contain letters, digits, dot, dash and underscore, up to 40 characters.',
    };
  }
  if (current.includes(wanted)) return { ok: true, label: wanted, labels: current, message: `This box already has "${wanted}".` };
  if (known.includes(wanted)) {
    // NOT AN ERROR AND NOT A WRITE. The box has the label; storing a second
    // copy would make removing it later look like it worked and change nothing.
    return { ok: true, label: wanted, labels: current, message: `This box already has "${wanted}", from the machine itself or from AGENT_FLEET_LABELS.` };
  }
  if (current.length >= MAX) {
    return { ok: false, labels: current, message: `This box already has ${MAX} labels set here, which is the limit.` };
  }
  const next = [...current, wanted].sort();
  const r = write(cfg, next);
  if (!r.ok) return { ok: false, labels: current, message: r.message };
  return { ok: true, label: wanted, labels: next, message: `This box now has "${wanted}". Work aimed with \`tag: ${wanted}\` can land here.` };
}

/**
 * Take a label off this box.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} value
 * @param {string[]} [known] labels from auto-labels and the environment
 * @returns {{ ok: boolean, label?: string, labels: string[], message: string }}
 */
export function removeLabel(cfg, value, known = []) {
  const wanted = String(value || '').trim().toLowerCase();
  const current = readLabels(cfg);
  if (!current.includes(wanted)) {
    // WHY IT CANNOT BE REMOVED, not just that it was not found. "no such label"
    // for a label the app is displaying is the least useful true sentence
    // available, and the person is looking straight at it.
    if (known.includes(wanted)) {
      return {
        ok: false,
        labels: current,
        message:
          `"${wanted}" is not set here — it comes from the machine itself or from AGENT_FLEET_LABELS.\n` +
          'A label the box derives is a fact about it, and a fact that can be switched off from a phone ' +
          'is not one. Change what it describes, or edit AGENT_FLEET_LABELS and restart.',
      };
    }
    return { ok: false, labels: current, message: `This box does not have "${String(value).slice(0, 40)}".` };
  }
  const next = current.filter((l) => l !== wanted);
  const r = write(cfg, next);
  if (!r.ok) return { ok: false, labels: current, message: r.message };
  return { ok: true, label: wanted, labels: next, message: `This box no longer has "${wanted}". Work aimed with \`tag: ${wanted}\` will look elsewhere.` };
}

/**
 * The whole picture: every label this box carries, and where each came from.
 *
 * SOURCE TRAVELS AS DATA. An app that showed a flat list would offer to remove
 * `arm64` and be refused, which is a control that exists and does not work —
 * C-2, functional completeness, in the one place it is easiest to get wrong.
 *
 * @param {{ auto?: string[], env?: string[], set?: string[] }} sources
 * @returns {Array<{ name: string, source: 'auto'|'env'|'set' }>}
 */
export function describeLabels({ auto = [], env = [], set = [] }) {
  /** @type {Map<string, 'auto'|'env'|'set'>} */
  const out = new Map();
  // Least removable first, so a label present in two sources is reported as the
  // one that decides whether it can be taken off.
  for (const l of auto) out.set(l, 'auto');
  for (const l of env) if (!out.has(l)) out.set(l, 'env');
  for (const l of set) if (!out.has(l)) out.set(l, 'set');
  return [...out.entries()].map(([name, source]) => ({ name, source })).sort((a, b) => a.name.localeCompare(b.name));
}
