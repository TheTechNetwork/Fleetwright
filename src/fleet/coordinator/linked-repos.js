// Each person's linked repositories, by role (#346).
//
// THREE ROLES, AND THIS STORE HOLDS TWO OF THEM. `runners` is the runner
// repository runner-repos.js already keeps, and stays there: admission reads
// that store, and moving a value the enrolment route trusts into a new shape
// to make a list look tidier is a migration with a security property on the
// other end of it. The linking API shows all three as one list with a role on
// each, so a person sees one place; underneath, `runners` is read from and
// written to RunnerRepos and the other two live here.
//
//   archive    the PRIVATE repository a session is pushed to before it goes.
//              Carried on `start` to the host by the coordinator, never by the
//              caller (protocol v11, `start.archive`)
//   templates  a repository of skills, presets, configs and workflows a
//              session may read when asked to. Stored and shown; nothing is
//              taken from it by itself — docs/linked-repos.md argues why
//
// PER PERSON, NEVER PER SESSION. The issue is specific about it: a repository
// named per session is a text field in the app and the coordinator choosing
// where work gets written. One link per role per person, set from a settings
// screen after a check passes, is a decision the person made once.
//
// WHAT A STORED NAME CAN DO. An archive name decides where a session's work is
// pushed, so a compromised coordinator could change it. Two things bound that,
// and neither is in this file: the push is made with the STARTER's own GitHub
// credential, so it can land only somewhere they could already push; and the
// host asks GitHub that the repository is private immediately before pushing,
// and refuses a public one whatever it was told. Nothing here admits a machine
// or mints a token.
//
// The name is not a secret, and it is stored as GitHub spells it.

import { REPO_RE } from '../protocol/intents.js';

/** The roles this store keeps. `runners` is runner-repos.js's. */
export const STORED_ROLES = Object.freeze(['archive', 'templates']);

/** One row per person, both roles in it, all in ONE Durable Object value,
 * which refuses anything over 128KiB. The widest row is a 254-character email
 * and two 140-character repository names, about 640 bytes as JSON; 150 of
 * those is under 100KB, and test/do-key-bounds.test.js fills the store to
 * prove it. A fleet with more people than this linking repositories has
 * outgrown one storage key, and is refused with a sentence rather than failing
 * to save. */
export const MAX_LINKED_PEOPLE = 150;

/** @typedef {{ repo: string, setAt: number }} Link */
/** @typedef {{ archive?: Link, templates?: Link }} Links */

export class LinkedRepos {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, Links>} keyed by lowercased email */
    this.byEmail = new Map();
  }

  /**
   * @param {string|null|undefined} email @param {string} role
   * @returns {Link|null}
   */
  get(email, role) {
    const key = String(email || '').toLowerCase();
    if (!key || !STORED_ROLES.includes(role)) return null;
    return /** @type {any} */ (this.byEmail.get(key))?.[role] || null;
  }

  /**
   * @param {string} email @param {string} role
   * @param {string} repo  already checked; the shape is checked again here,
   *   because this is what a `start` carries to a host
   * @returns {{ ok: true } | { ok: false, text: string }}
   */
  set(email, role, repo) {
    const key = String(email || '').toLowerCase();
    if (!key) return { ok: false, text: 'A linked repository belongs to a person — sign in first.' };
    if (!STORED_ROLES.includes(role)) return { ok: false, text: `There is no "${String(role).slice(0, 40)}" role here.` };
    if (!REPO_RE.test(String(repo || ''))) return { ok: false, text: 'That is not a repository name. Write it as owner/repo.' };
    if (!this.byEmail.has(key) && this.byEmail.size >= MAX_LINKED_PEOPLE) {
      return { ok: false, text: 'This fleet holds as many linked repositories as it can.' };
    }
    const row = { ...(this.byEmail.get(key) || {}) };
    /** @type {any} */ (row)[role] = { repo: String(repo), setAt: this.now() };
    this.byEmail.set(key, row);
    return { ok: true };
  }

  /** @param {string|null|undefined} email @param {string} role @returns {boolean} whether there was one */
  clear(email, role) {
    const key = String(email || '').toLowerCase();
    const row = this.byEmail.get(key);
    if (!row || !STORED_ROLES.includes(role) || !(/** @type {any} */ (row)[role])) return false;
    const rest = { ...row };
    delete (/** @type {any} */ (rest))[role];
    if (Object.keys(rest).length) this.byEmail.set(key, rest);
    else this.byEmail.delete(key);
    return true;
  }

  /** @returns {Array<[string, Links]>} */
  serialise() {
    return [...this.byEmail.entries()];
  }

  /** Anything malformed is dropped rather than trusted: an archive name read
   * back from here is where somebody's work is pushed. @param {unknown} entries */
  restore(entries) {
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || !e[1] || typeof e[1] !== 'object') continue;
      if (this.byEmail.size >= MAX_LINKED_PEOPLE) break;
      /** @type {Links} */
      const row = {};
      for (const role of STORED_ROLES) {
        const link = e[1][role];
        if (link && REPO_RE.test(String(link.repo || ''))) {
          /** @type {any} */ (row)[role] = { repo: String(link.repo), setAt: Number(link.setAt) || 0 };
        }
      }
      if (Object.keys(row).length) this.byEmail.set(e[0].toLowerCase(), row);
    }
  }
}
