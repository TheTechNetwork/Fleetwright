// Task profiles: the content a session starts with, kept on the host.
//
// THE RULE THIS EXISTS TO SATISFY, from docs/wanted.md:
//
//     The coordinator may NAME a profile; it may never CARRY one.
//
// Injected text is instructions to an agent with root in a container. A
// coordinator that chooses the content writes that agent's instructions, which
// is a far larger capability than the verb set — it is the `reply { text }`
// argument in different clothes. So the wire carries `profile: "reviewer"`, a
// charset-checked name and nothing else, and the words live in a file on the
// box that a person with a shell put there.
//
// That is also why this is a DIRECTORY OF FILES rather than a field in
// state.json. A profile is prose somebody edits, reviews and version-controls;
// it wants a filename and a diff, not a JSON string. `git -C /var/lib/agent-hub
// diff profiles/` answers "what are these boxes being told to do", which is a
// question worth being able to ask.
//
// WHAT A PROFILE IS NOT: a per-session prompt. There is deliberately no way to
// send arbitrary text from a phone or a coordinator into a session, at start or
// otherwise. The set of things a session can be started with is exactly the set
// of files on that host, and enlarging it means having a shell on the box.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Profile names, the same shape as a session name and for the same reason: it
 * arrives from the wire, it becomes part of a path, and it must never be able
 * to become a flag or an escape.
 *
 * NO DOTS, which is stricter than the session charset and is the whole of the
 * traversal argument — `..` cannot be spelled, so `path.join` cannot be talked
 * out of the directory. Belt and braces both: the join is also checked below.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/**
 * Names that are a note to a reader rather than a profile.
 *
 * Somebody WILL put a README in this directory — the shipped examples come with
 * one — and a README offered as a profile is a session started with "Example
 * profiles" as its instruction. Excluded by name rather than by a convention
 * nobody would guess, and listed here so the exclusion is visible.
 */
const NOT_PROFILES = new Set(['README', 'readme', 'Readme']);

/** How much of a profile is worth reading into a list. */
const SUMMARY_MAX = 120;

/** A profile longer than this is a mistake rather than a profile: it is typed
 * into a session as its first message, and a wall of text is a wall of text. */
const CONTENT_MAX = 8000;

export class Profiles {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir;
  }

  /**
   * Every profile this host has, newest-irrelevant and sorted by name so two
   * calls agree.
   *
   * A MISSING DIRECTORY IS NOT AN ERROR. Most boxes will never have one, and a
   * host with no profiles is a host that starts idle sessions — which is what
   * every host did before this existed. It answers `[]` and says so upstream.
   *
   * @returns {Array<{ name: string, summary: string, chars: number }>}
   */
  list() {
    /** @type {string[]} */
    let entries = [];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return [];
    }
    /** @type {Array<{ name: string, summary: string, chars: number }>} */
    const out = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.md')) continue;
      const name = entry.slice(0, -3);
      if (!NAME_RE.test(name) || NOT_PROFILES.has(name)) continue;
      const text = this.#read(name);
      if (text === null) continue;
      out.push({ name, summary: summarise(text), chars: text.length });
    }
    return out;
  }

  /**
   * One profile's content, or null if this host does not have it.
   *
   * NULL IS "NO SUCH PROFILE", and the caller must refuse rather than start an
   * idle session — silently starting something that does not do what was asked
   * is the exact failure `brief` had, and it is worse the second time.
   *
   * @param {string} name
   * @returns {string|null}
   */
  get(name) {
    if (!NAME_RE.test(String(name || '')) || NOT_PROFILES.has(String(name))) return null;
    return this.#read(String(name));
  }

  /**
   * @param {string} name  already matched against NAME_RE
   * @returns {string|null}
   */
  #read(name) {
    const file = path.join(this.dir, `${name}.md`);
    // The charset already makes traversal unspellable. This is the second
    // check, and it is here because the first one is a regex somebody could
    // relax in a hurry to allow a dot in a name.
    if (path.dirname(path.resolve(file)) !== path.resolve(this.dir)) return null;
    try {
      if (!statSync(file).isFile()) return null;
      const text = readFileSync(file, 'utf8');
      return text.length > CONTENT_MAX ? text.slice(0, CONTENT_MAX) : text;
    } catch {
      return null;
    }
  }
}

/**
 * The first line worth showing, for a list.
 *
 * A profile is markdown a person wrote, so the first line is usually a heading;
 * the `#` is noise in a list on a phone and the words after it are the answer.
 *
 * @param {string} text
 */
function summarise(text) {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (line) return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
  }
  return '(empty)';
}
