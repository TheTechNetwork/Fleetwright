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

/**
 * The account identity that has to travel WITH a credential.
 *
 * Found the hard way, from a phone screenshot: a sandbox seeded with a valid
 * .credentials.json came up "not logged in", because the newer CLI decides
 * logged-in-ness from the PAIR — the token in .credentials.json and the
 * `oauthAccount` block in .claude.json. Seeding one without the other is a
 * login that fails while every file involved is genuine.
 *
 * @param {string} claudeJsonText  the raw text of a .claude.json
 * @returns {string|null}          the oauthAccount block, serialised, or null
 */
export function extractOauthAccount(claudeJsonText) {
  try {
    const parsed = JSON.parse(String(claudeJsonText || ''));
    const account = parsed?.oauthAccount;
    if (!account || typeof account !== 'object' || Array.isArray(account)) return null;
    return JSON.stringify(account);
  } catch {
    return null;
  }
}

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

  /** `<email>.account.json` beside the credential: the oauthAccount block. @param {string} email */
  accountMetaPathFor(email) {
    const clean = normaliseEmail(email);
    if (!clean) return null;
    const file = path.join(this.dir, `${clean}.account.json`);
    return existsSync(file) ? file : null;
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
   * `accountMeta` is the serialised oauthAccount block when the login produced
   * one; without it the CLI inside a sandbox treats the credential as logged
   * out.
   * @param {string} email @param {string} contents @param {string|null} [accountMeta]
   */
  save(email, contents, accountMeta = null) {
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
    if (accountMeta) {
      writeFileSync(path.join(this.dir, `${normaliseEmail(email)}.account.json`), accountMeta, { mode: 0o600 });
    }
    return { ok: true, message: `Linked a Claude account for ${normaliseEmail(email)}.` };
  }

  /** @param {string} email */
  remove(email) {
    const file = this.fileFor(email);
    if (!file || !existsSync(file)) return false;
    unlinkSync(file);
    const meta = this.accountMetaPathFor(email);
    if (meta) unlinkSync(meta);
    return true;
  }

  /** Who has linked an account. Emails only — never the credentials. */
  // eslint-disable-next-line jsdoc/require-param
  list() {
    try {
      return readdirSync(this.dir)
        // Every sibling file this directory has grown has to be excluded by
        // name, and each one was added by somebody who was not thinking about
        // this function. `person@example.com.connections.json` would otherwise
        // list a linked account called `person@example.com.connections`.
        .filter(
          (f) =>
            f.endsWith('.json') &&
            !f.endsWith('.account.json') &&
            !f.endsWith('.connections.json') &&
            !f.startsWith('.'),
        )
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
