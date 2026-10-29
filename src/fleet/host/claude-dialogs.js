// The dialogs a Claude Code release draws, read out of the release itself and
// held against the matchers that are supposed to notice them.
//
// THE CAPTURES IN test/fixtures ARE A CLI THAT HAS ALREADY MOVED ON. The trust
// dialog was reworded once and nothing here noticed until a session sat on it
// (prompt.js says what that cost). scripts/claude-dialog-check.mjs hands this
// file the binary a pinned release ships, and this says which of the dialogs
// below the fleet would miss, misread, or claim to answer when it cannot.
//
// WHOLE DIALOGS, NOT PHRASES. The first version of this looked for a handful of
// fixed sentences and fed each one to readPrompt. That passes whenever ANY copy
// of a phrase survives, it cannot see a dialog whose question changed and whose
// phrase did not, and it once reported the workspace trust dialog as
// answerable from the app by handing readPrompt a pane nobody drew: the real
// dialog draws "No, exit" first and with no numbers, so there is nothing for an
// answer to name. So each dialog is found by something that identifies the
// COMPONENT (its title, mostly), and everything that component can say is what
// the matchers are tested against.
//
// IT FAILS CLOSED. A dialog this list names and the binary does not contain is
// a failure, not a skip: either Claude Code removed it, and the entry goes, or
// this can no longer read the binary, and a check that reads nothing must not
// pass. The same for a trust question drawn by a component nobody listed.
//
// WHAT IT CANNOT SEE is anything decided at run time: a branch that draws the
// question only in one layout (the Bash permission dialog's "fitted" form draws
// none), or text built from pieces. It reads what the component COULD say,
// which is the same text the pane shows, minus the layout.

import { readPrompt } from './prompt.js';
import { AWAITING_RE } from './watcher.js';

/**
 * The dialogs the fleet has an opinion about, as the CLI's own source names them.
 *
 * `anchor` begins a string literal inside the component and nowhere else: the
 *   first place the check looks, and the only one it trusts to name the dialog.
 * `kind` is what readPrompt must make of it. null is "noticed, not described":
 *   AWAITING_RE still has to see it, and readPrompt must NOT read it as one of
 *   its questions, because then the phone is asked something else.
 * `answered` says whether the fleet claims to answer it from a notification.
 *   true and the component draws its options without numbers is a failure:
 *   every answer is a digit, and an option without one cannot be named.
 * `unanswered` is the honest sentence for the rest, printed by the check and
 *   repeated in docs/ci.md.
 *
 * @type {{ name: string, anchor: string, kind: string|null, answered: boolean, unanswered?: string }[]}
 */
export const DIALOGS = [
  {
    name: 'the workspace trust dialog',
    anchor: 'Accessing workspace:',
    kind: 'trust',
    // Answerable on 2.1.234, which numbered "1. Yes, I trust this folder".
    // Since then it is hideIndexes, cancelFirst, focus on "No, exit".
    answered: false,
    unanswered: 'its options are drawn without numbers, so the phone is told and has nothing to tap',
  },
  {
    name: 'the Remote Control trust question',
    anchor: 'Error: Workspace not trusted. Please run',
    kind: 'trust',
    answered: false,
    unanswered: 'it is a line that takes y or n, not a numbered choice',
  },
  {
    // /cd. The same question as the trust dialog in different words, about a
    // different thing: moving the session, not opening it. Read as trust, the
    // phone asked "Do you trust the files in this folder?" — which is why it
    // is noticed and not described (prompt.js, watcher.js).
    name: "/cd's move-directory dialog",
    anchor: 'Moving to a new directory:',
    kind: null,
    answered: false,
    unanswered: 'its options are drawn without numbers, and the fleet has no question of its own for it',
  },
  {
    // /cd's second form: already moved, through a parent that was trusted,
    // and asking whether this directory's own settings may apply.
    name: "/cd's project-settings dialog",
    anchor: 'Now in a new directory:',
    kind: null,
    answered: false,
    unanswered: 'its options are drawn without numbers, and the fleet has no question of its own for it',
  },
  {
    name: 'the Bash permission dialog',
    anchor: 'Bash command',
    kind: 'permission',
    answered: true,
  },
  {
    name: 'the resume dialog',
    anchor: 'Resuming the full session will consume',
    kind: 'resume',
    answered: true,
  },
];

/** A question that asks for trust. Every component that draws one is listed above, or the check fails. */
const TRUST_QUESTION = 'or one you trust?';

/** Larger than any dialog component; a "function" that spans more than this is the bounds finder lost. */
const MAX_FUNCTION = 60_000;

/** `hideIndexes: true`, as a minifier writes it. */
const HIDDEN_INDEXES = /\bhideIndexes:\s*(?:!0|true)\b/;

/**
 * What a pinned Claude Code would put in front of a session that this fleet
 * gets wrong, and what it cannot answer from a phone.
 *
 * @param {string} source  the CLI binary, read as latin1: its JavaScript is embedded as text
 * @returns {{ problems: string[], notes: string[] }}
 */
export function dialogProblems(source) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {Set<number>} */
  const known = new Set();

  for (const dialog of DIALOGS) {
    const regions = componentsAt(source, dialog.anchor);
    if (!regions.length) {
      problems.push(
        `Cannot find ${dialog.name} (“${dialog.anchor}”). If Claude Code removed or retitled it, change DIALOGS in src/fleet/host/claude-dialogs.js; if not, this check can no longer read the binary.`,
      );
      continue;
    }
    for (const region of regions) {
      known.add(region.start);
      const code = source.slice(region.start, region.end);
      const text = literals(code).join('\n');
      const read = readPrompt(text);
      const kind = read?.kind ?? null;
      if (kind !== dialog.kind) {
        problems.push(
          dialog.kind === null
            ? `${cap(dialog.name)} is read as a ${kind} question (“${read?.question}”), and it is not one.`
            : `${cap(dialog.name)} is not read as a ${dialog.kind} question${kind ? ` (it reads as ${kind})` : ''}. What it says: ${questionsIn(text)}`,
        );
      }
      if (!AWAITING_RE.test(text)) {
        problems.push(`A session waiting on ${dialog.name} would not be noticed. What it says: ${questionsIn(text)}`);
      }
      const hidden = HIDDEN_INDEXES.test(code);
      if (dialog.answered && hidden) {
        problems.push(`${cap(dialog.name)} draws its options without numbers, and prompt.js claims to answer it with one.`);
      }
      if (!dialog.answered) {
        notes.push(`${cap(dialog.name)} is noticed${read ? ` and asked as “${read.question}”` : ''}, and cannot be answered from the app: ${dialog.unanswered}.`);
      }
    }
  }

  // Fail closed on the family that already drifted: a trust question drawn by
  // a component above is covered, and one drawn anywhere else is a dialog
  // nobody has decided anything about.
  for (let at = source.indexOf(TRUST_QUESTION); at >= 0; at = source.indexOf(TRUST_QUESTION, at + 1)) {
    if (!inSourceLiteral(source, at)) continue;
    const region = enclosingFunction(source, at);
    if (region && known.has(region.start)) continue;
    const line = literalAround(source, at);
    problems.push(`A dialog this check does not know asks “${line}”. Add it to DIALOGS with what the fleet should make of it.`);
  }

  return { problems, notes };
}

/** @param {string} s */
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Every component a literal starting with `anchor` sits in, one per distinct
 * function. The binary carries its strings a second time as bytecode
 * constants; those have no quote in front, which is how they are told apart.
 *
 * @param {string} source
 * @param {string} anchor
 */
function componentsAt(source, anchor) {
  /** @type {{ start: number, end: number }[]} */
  const out = [];
  for (const quote of ['"', "'", '`']) {
    const needle = quote + anchor;
    for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
      const region = enclosingFunction(source, at);
      if (region && !out.some((r) => r.start === region.start)) out.push(region);
    }
  }
  return out;
}

/**
 * The innermost `function` whose body contains `at`.
 *
 * A component in the minified source is a plain function, and its hooks are
 * arrows, so the innermost named function around a dialog's title is the
 * dialog. Braces are counted with strings and template literals skipped; a
 * regex literal holding a quote or a brace would throw the count, and then no
 * function closes around `at` and the dialog is reported missing rather than
 * read from the wrong place.
 *
 * @param {string} source
 * @param {number} at
 * @returns {{ start: number, end: number }|null}
 */
export function enclosingFunction(source, at) {
  let from = at;
  for (;;) {
    const start = source.lastIndexOf('function', from);
    if (start < 0 || at - start > MAX_FUNCTION) return null;
    from = start - 1;
    if (/[\w$]/.test(source[start - 1] ?? '') || !/[\s(*]/.test(source[start + 8] ?? '')) continue;
    const paren = source.indexOf('(', start + 8);
    if (paren < 0 || paren > at) continue;
    const params = closing(source, paren, '(', ')');
    if (params < 0 || source[params] !== '{') continue;
    const end = closing(source, params, '{', '}');
    if (end > at) return { start, end };
  }
}

/**
 * The index just past the bracket that closes the one at `open`, or -1.
 *
 * @param {string} source
 * @param {number} open
 * @param {string} left
 * @param {string} right
 */
function closing(source, open, left, right) {
  let depth = 0;
  const limit = Math.min(source.length, open + MAX_FUNCTION);
  for (let i = open; i < limit; i++) {
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      i = pastString(source, i) - 1;
      if (i < 0) return -1;
    } else if (c === left) depth++;
    else if (c === right && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * The index just past the string literal starting at `i`, or 0 when it does
 * not end where a literal can.
 *
 * @param {string} source
 * @param {number} i
 * @returns {number}
 */
function pastString(source, i) {
  const quote = source[i];
  for (let j = i + 1; j < source.length && j - i < MAX_FUNCTION; j++) {
    const c = source[j];
    if (c === '\\') j++;
    else if (c === quote) return j + 1;
    else if (quote === '`' && c === '$' && source[j + 1] === '{') {
      const end = closing(source, j + 1, '{', '}');
      if (end < 0) return 0;
      j = end - 1;
    } else if (quote !== '`' && c === '\n') return 0;
  }
  return 0;
}

/**
 * Every string a stretch of minified source contains, one per line: the words
 * the component can draw, give or take the ones it only logs.
 *
 * @param {string} code
 * @returns {string[]}
 */
export function literals(code) {
  /** @type {string[]} */
  const out = [];
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const raw = m[1] ?? m[2] ?? (m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
    const text = raw
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\\(.)/g, '$1');
    if (/[A-Za-z]{2}/.test(text)) out.push(text);
  }
  return out;
}

/**
 * Whether `at` is in a string the source spells out, rather than in the
 * bytecode's copy of it: printable all the way back to a quote.
 *
 * @param {string} source
 * @param {number} at
 */
function inSourceLiteral(source, at) {
  for (let i = at - 1; i >= 0 && at - i < 4000; i--) {
    const c = source.charCodeAt(i);
    if (c === 0x22 || c === 0x27 || c === 0x60) return true;
    if (c < 0x20 || c > 0x7e) return false;
  }
  return false;
}

/**
 * The literal around `at`, for a message a person reads.
 *
 * @param {string} source
 * @param {number} at
 */
function literalAround(source, at) {
  let start = at;
  while (start > 0 && !'"\'`'.includes(source[start - 1]) && at - start < 300) start--;
  let end = at;
  while (end < source.length && !'"\'`'.includes(source[end]) && end - at < 300) end++;
  return source.slice(start, end);
}

/**
 * The sentences ending in a question mark, so a failure shows what the dialog
 * asks now and the fix starts from its words.
 *
 * @param {string} text
 */
function questionsIn(text) {
  const asked = text.split('\n').filter((l) => /\?\s*$|\?\s/.test(l)).slice(0, 3);
  return asked.length ? asked.map((q) => `“${q.trim()}”`).join(' ') : '(no question found)';
}
