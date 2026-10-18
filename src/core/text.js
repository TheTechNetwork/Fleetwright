// Text a PERSON wrote, cleaned once.
//
// This lives here rather than in the protocol because there are two doors into
// the same storage and they must not disagree. The fleet protocol validates a
// `title` on its way through an intent; fleetwright's HTTP API accepts the same
// field directly, from the sidecar and from anything else holding its token.
//
// Two doors validating separately is the shape of a bug this project has
// already paid for once: `?token=fwk_` was full fleet access because the Worker
// and the Durable Object extracted credentials differently, and the
// disagreement failed OPEN. One function, both callers.
//
// The rules, and what each refuses:
//
//  - Whitespace collapses FIRST, so a title of 200 spaces and a word is not
//    "too long", one made only of whitespace is empty rather than valid, and a
//    newline or carriage return cannot forge a second row in a list.
//  - Length is counted in CHARACTERS. JS string length counts UTF-16 code
//    units, so an emoji costs two -- a limit measured that way invites a
//    truncating client to cut through the middle of a character and store half
//    a surrogate pair.
//  - Control characters are refused. ESC begins a terminal escape sequence in
//    anything that prints this, and NEL (U+0085) is a line break to some
//    renderers while NOT being whitespace to JS: exactly the gap between two
//    definitions that a check like this exists to close.
//  - Bidi overrides are REFUSED rather than substituted. The console's scrub()
//    substitutes, so a hostile label looks wrong instead of looking fine -- but
//    the console is displaying something that already exists, and this is the
//    door. Nothing hostile should reach storage and then rely on every future
//    renderer remembering.

const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/;

/**
 * @param {unknown} value
 * @param {{ max?: number, label?: string }} [opts]
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function cleanText(value, { max = 200, label = 'value' } = {}) {
  if (typeof value !== 'string') return { ok: false, error: `${label} must be a string` };
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, error: `${label} must not be empty` };
  if (Array.from(text).length > max) return { ok: false, error: `${label} must be at most ${max} characters` };
  if (CONTROL_RE.test(text)) return { ok: false, error: `${label} must not contain control characters` };
  if (BIDI_RE.test(text)) return { ok: false, error: `${label} must not contain bidirectional overrides` };
  return { ok: true, value: text };
}

/** The limits, named once so the protocol and the HTTP API cannot drift apart. */
export const TITLE_MAX = 60;
export const BRIEF_MAX = 500;
/** A task is typed into a session as its first message, so it is bounded like a profile file (profiles.js). */
export const TASK_MAX = 8000;

/**
 * Text a BOX wrote, as one line, for a reader who is not the box: control
 * characters, line and paragraph separators and the bidirectional overrides
 * become spaces, so nothing it says can start a line of its own or reorder
 * the line it is on. Substituted rather than refused, because it is not a
 * door: the box has already said it, and what is wanted is that it reads as
 * one thing it said.
 *
 * Here rather than in the coordinator, where it began (core.js, a session
 * event's text), because the same words now pass through three files on
 * their way to an admin's agent: the registry keeps a box's hub reason, the
 * coordinator merges a fan-out, and the MCP server renders the record. Each
 * holding its own copy is how one of them kept U+2028 and the other two did
 * not (eighth audit). No imports, so the Worker bundle and the stdio server
 * can both take it.
 *
 * @param {unknown} v @param {number} max
 */
export function oneLine(v, max) {
  return String(v)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * What a label may be: the hub's rule (labels.js), which a label set from an
 * app is held to, and here so the coordinator can hold a box's report to the
 * same one. A box's frame carried any strings it liked as labels, and they
 * reached an admin's agent through fleet_health as written (eighth audit);
 * nothing a label is for, `tag` matching among them, needs more than this.
 */
export const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
