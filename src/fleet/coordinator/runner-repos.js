// Where each person's runners come from.
//
// A fleet has had one runner repository, set by an operator on the
// coordinator (FLEETWRIGHT_RUNNER_REPO) and delivered to every host on the
// config frame. That made a runner something an operator had to arrange before
// anybody could have one — and put everybody's Actions minutes in one
// repository's account.
//
// This is the other half: a person names their own PUBLIC repository, the
// fleet checks it with their GitHub connection (the `runnerrepo` verb), and
// their runners come from there from then on. Free minutes are per repository
// owner, so each person's runners are paid for by — or free to — the person
// who asked for them.
//
// WHY THIS IS SAFE TO LET A MEMBER DO. It lets a member's own repository admit
// a machine into the fleet, which until now only an operator's allowlist
// could. Two things keep that from being new power:
//
//  - a member can already mint an enrolment pin and add a machine (the
//    `/api/enroll` route is not admin-gated, deliberately). A runner from their
//    own repository is that, with GitHub's token doing the proving;
//  - a repository here admits a job ONLY with a dispatch ticket minted for that
//    person and naming that repository, for one of the four runner workflow
//    files — see runner-tickets.js and CoordinatorCore#runnerAdmission. A
//    stored name on its own admits nothing.
//
// The name is not a secret. It is stored as GitHub spells it — the check
// returns the canonical form — because the OIDC token a job presents carries
// that spelling, and admission compares the two.

import { REPO_RE } from '../protocol/intents.js';

/** One entry per person, all in ONE Durable Object value, which refuses
 * anything over 128KiB. The widest row is a 254-character email and a
 * 140-character repository name; 250 of those is about 110KB, and
 * test/do-key-bounds.test.js fills the store to prove it. A fleet with more
 * people than this setting their own runner repository has outgrown one
 * storage key, and is refused with a sentence rather than failing to save. */
export const MAX_RUNNER_REPOS = 250;

/** @typedef {{ repo: string, setAt: number }} RunnerRepo */

export class RunnerRepos {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, RunnerRepo>} keyed by lowercased email */
    this.byEmail = new Map();
  }

  /** @param {string|null|undefined} email @returns {string|null} */
  get(email) {
    const key = String(email || '').toLowerCase();
    return (key && this.byEmail.get(key)?.repo) || null;
  }

  /**
   * @param {string} email
   * @param {string} repo  already checked; the shape is checked again here
   *   because this is what admission later trusts
   * @returns {{ ok: true } | { ok: false, text: string }}
   */
  set(email, repo) {
    const key = String(email || '').toLowerCase();
    if (!key) return { ok: false, text: 'A runner repository belongs to a person — sign in first.' };
    if (!REPO_RE.test(String(repo || ''))) return { ok: false, text: 'That is not a repository name. Write it as owner/repo.' };
    if (!this.byEmail.has(key) && this.byEmail.size >= MAX_RUNNER_REPOS) {
      return { ok: false, text: 'This fleet holds as many runner repositories as it can.' };
    }
    this.byEmail.set(key, { repo: String(repo), setAt: this.now() });
    return { ok: true };
  }

  /** @param {string|null|undefined} email @returns {boolean} whether there was one */
  clear(email) {
    return this.byEmail.delete(String(email || '').toLowerCase());
  }

  /** @returns {Array<[string, RunnerRepo]>} */
  serialise() {
    return [...this.byEmail.entries()];
  }

  /** Anything malformed is dropped rather than trusted: this is read back into
   * the thing admission consults. @param {unknown} entries */
  restore(entries) {
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || !REPO_RE.test(String(e[1]?.repo || ''))) continue;
      if (this.byEmail.size >= MAX_RUNNER_REPOS) break;
      this.byEmail.set(e[0].toLowerCase(), { repo: String(e[1].repo), setAt: Number(e[1].setAt) || 0 });
    }
  }
}
