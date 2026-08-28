// Linked Claude accounts, one file per person.
//
// docs/accounts.md: the shared org credential is the default, and a person who
// has linked their own account gets THEIRS seeded into every session they
// start. This is the store — `${stateDir}/accounts/<email>.json`, each file the
// same shape as the `.credentials.json` the claude CLI writes.
//
// WHY THE FILENAME IS SAFE TO DERIVE FROM AN ACTOR. The email arrives either
// from the fleet (where the coordinator verified it against an ID token before
// it ever reached this box) or from an operator typing it into a surface the
// allowlist already trusts. Both paths go through normalise(), which refuses
// anything that does not look like a bare email — and the actor charset the
// hub accepts has no path separators, so even a hostile value cannot climb out
// of the directory. Belt and braces: normalise() checks anyway, because the
// charset guarantee lives in a different file and distance is how guarantees
// rot.

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

/** A bare email, lowercased — or null for anything else. @param {unknown} value */
export function normaliseEmail(value) {
  const email = String(value || '').toLowerCase().trim();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return null;
  if (email.includes('/') || email.includes('\\')) return null; // unreachable, kept anyway
  return email;
}

/**
 * The email inside a fleet actor, or null.
 *
 * `fleet:person@example.com` is the sidecar's prefix on a coordinator-verified
 * identity. Everything else — telegram ids, `web`, `cli`, absent — has no
 * email and gets the shared credential.
 */
/** @param {unknown} actor */
export function emailFromActor(actor) {
  const s = String(actor || '');
  return s.startsWith('fleet:') ? normaliseEmail(s.slice('fleet:'.length)) : null;
}

export class Accounts {
  /** @param {string} stateDir */
  constructor(stateDir) {
    this.dir = path.join(stateDir, 'accounts');
  }

  /** @param {string} email */
  fileFor(email) {
    const clean = normaliseEmail(email);
    return clean ? path.join(this.dir, `${clean}.json`) : null;
  }

  /** The linked file for this email, or null when they have not linked one. @param {string} email */
  credentialPathFor(email) {
    const file = this.fileFor(email);
    return file && existsSync(file) ? file : null;
  }

  /**
   * Store a credential for this person. `contents` is the raw text of a
   * `.credentials.json` — stored verbatim, because this module has no business
   * understanding Anthropic's credential format, only custody of it.
   * @param {string} email @param {string} contents
   */
  save(email, contents) {
    const file = this.fileFor(email);
    if (!file) return { ok: false, message: `"${email}" does not look like an email address` };
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch {
      return { ok: false, message: 'that is not JSON — expected the contents of a .credentials.json' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length) {
      return { ok: false, message: 'that JSON does not look like a credential file' };
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, contents, { mode: 0o600 });
    return { ok: true, message: `Linked a Claude account for ${normaliseEmail(email)}.` };
  }

  /** @param {string} email */
  remove(email) {
    const file = this.fileFor(email);
    if (!file || !existsSync(file)) return false;
    unlinkSync(file);
    return true;
  }

  /** Who has linked an account. Emails only — never the credentials. */
  // eslint-disable-next-line jsdoc/require-param
  list() {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length))
        .sort();
    } catch {
      return []; // no directory yet: nobody has linked anything
    }
  }

  /** @param {string} email */
  read(email) {
    const file = this.credentialPathFor(email);
    return file ? readFileSync(file, 'utf8') : null;
  }
}
