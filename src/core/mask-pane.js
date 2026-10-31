// What of a terminal pane may leave the host, for the decision model to read.
//
// Pane text does not leave the box (docs/plan.md, fleet/host/prompt.js header).
// The one exception is this: when every deterministic reader has failed on a
// still pane, the host may send the coordinator a MASKED copy and ask whether
// a person is being asked something (docs/decide-design.md, sections A and C).
// It lives beside redact.js for the reason redact.js exists: the knowledge of
// what is a secret has to live in one place, or it rots at the second caller.
//
// ALLOWLIST, NOT DENYLIST. A denylist of secret shapes is a list of the
// secrets somebody has thought of. This keeps a token only when its core is
// unmistakably an ordinary word or a small number, and replaces everything
// else with a fixed mask. So a setup token, an fwk_ key, a Remote Control URL,
// an email, a path, a hostname, a hash, a version string and a CamelCase
// identifier all go the same way without being named, and a credential shape
// invented next year goes that way too. What survives is the prose a dialog is
// made of: "Do you want to proceed", "1. Yes", "2. No", option labels.
//
// KNOWN LOSS, accepted in the design: a secret that is a dictionary word
// survives, as it would in any mask; so does a filename that is a word.
// Neither is a credential shape the fleet issues.
//
// THE MASK NEVER PRODUCES WHAT THE COORDINATOR'S GATE REFUSES. The gate
// (fleet/coordinator/decide.js) refuses a request rather than cleaning it, so
// a mask that can emit a gate hit turns into a feature that silently never
// fires for some panes. Three ways that could happen, each closed below: a
// kept capitalised word is 20 characters long; a kept run of `-` or `_` sits
// next to a kept word ("-----BEGIN"); a bare "(https://" whose core is the
// word "https". Every emitted token is checked against the gate's own
// patterns, and the byte cut runs again after masking, because the mask is
// twelve bytes and a two-byte token it replaced was not.

import { dewrapPane } from './pane.js';

/** The fixed replacement. Fixed length, so it never leaks the size of what it hid. */
export const PANE_MASK = '▮▮▮▮';

export const MASK_MAX_LINES = 40;
export const MASK_MAX_BYTES = 4096;

// Natural-language words, all-caps words, numbers of at most three digits.
// A core is kept only when it matches one of these whole.
const KEEP = [/^[A-Z]?[a-z']{1,19}$/, /^[A-Z]{1,8}$/, /^\d{1,3}$/];

// Punctuation, symbols and box drawing at either end of a whitespace run.
// Kept as-is, so "1." and "(Like" and "│" read as they did; only the core
// between them is judged.
const AFFIX = /[\p{P}\p{S}]/u;

/**
 * The patterns the coordinator's gate refuses on, by name. Exported so the
 * gate and the mask agree by construction rather than by care; the gate still
 * applies them itself, because the coordinator does not trust the host to have
 * run this module at all.
 */
/** @type {ReadonlyArray<[string, RegExp]>} */
export const GATE_PATTERNS = Object.freeze([
  ['long-run', /[A-Za-z0-9_-]{20,}/],
  ['credential-shape', /sk-ant-|fwk_|https?:\/\/|@[a-z0-9-]+\.[a-z]{2,}|-----BEGIN/i],
]);

/** @param {string} text */
function gateHit(text) {
  return GATE_PATTERNS.some(([, re]) => re.test(text));
}

/**
 * The last `maxBytes` of `text`, starting on a whole line.
 *
 * @param {string} text @param {number} maxBytes
 */
function tailBytes(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const tail = buf.subarray(buf.length - maxBytes).toString('utf8');
  // The cut can land inside a character or a line; start at the next whole one.
  const nl = tail.indexOf('\n');
  return nl === -1 ? '' : tail.slice(nl + 1);
}

/** @param {string} token */
function maskToken(token) {
  const chars = [...token];
  let start = 0;
  let end = chars.length;
  while (start < end && AFFIX.test(chars[start])) start++;
  while (end > start && AFFIX.test(chars[end - 1])) end--;
  const lead = chars.slice(0, start).join('');
  const core = chars.slice(start, end).join('');
  const trail = chars.slice(end).join('');
  // A run of dashes or underscores is a rule or a gap, not information; three
  // say so as well as forty, and forty would be the gate's long run.
  const clamp = (/** @type {string} */ s) => s.replace(/[-_]{4,}/g, (m) => m.slice(0, 3));
  const kept = core === '' || KEEP.some((re) => re.test(core));
  const out = kept ? clamp(lead) + core + clamp(trail) : clamp(lead) + PANE_MASK + clamp(trail);
  return gateHit(out) ? PANE_MASK : out;
}

/**
 * Mask a captured pane for the decision model.
 *
 * De-wrap first, so a URL tmux broke across rows is masked as the one token it
 * is rather than as fragments a word might survive from. Then the last 40
 * non-blank-terminated lines and 4,096 bytes, mask each whitespace-separated
 * token, keep the whitespace, and cut again to the same limits.
 *
 * Trailing blank rows are dropped before counting: a tall pane is mostly empty
 * below a dialog, and counting those rows would push the dialog out.
 *
 * @param {string} pane  the raw capture
 * @returns {string}
 */
export function maskPane(pane) {
  const lines = dewrapPane(String(pane ?? ''))
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const input = tailBytes(lines.slice(-MASK_MAX_LINES).join('\n'), MASK_MAX_BYTES);
  const masked = input
    .split(/(\s+)/)
    .map((part, i) => (i % 2 === 1 || part === '' ? part : maskToken(part)))
    .join('');
  return tailBytes(masked, MASK_MAX_BYTES);
}
