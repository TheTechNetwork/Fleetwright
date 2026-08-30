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

/**
 * Give the box's own Claude account to the person it belongs to.
 *
 * A host running today has a working `~/.claude/.credentials.json` and may have
 * no linked accounts at all. Removing the fallback without this would break it
 * on update, which is the worst version of a simplification.
 *
 * So the credential does not move and does not change — IT ACQUIRES AN OWNER.
 * `~/.claude.json`'s `oauthAccount` block already carries the email, and it is
 * the same field seeding has relied on since the day a sandbox came up "not
 * logged in" holding a perfectly valid token. A fleet where everybody was
 * running on the org account keeps running on it, under the name of the person
 * it always belonged to.
 *
 * Runs once and is a no-op afterwards: an existing row is never overwritten,
 * because the box's copy is by then the older one and adopting it again would
 * hand a session a credential its owner has already replaced.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {{ adopted: string|null, why: string }}
 */
export function adoptBoxAccount(cfg) {
  const file = cfg.sandboxCredentialsFile;
  if (!file || !existsSync(file)) return { adopted: null, why: 'this box has no Claude credential of its own' };
  const home = path.dirname(path.dirname(file));
  let email = null;
  try {
    const meta = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8'));
    email = normaliseEmail(meta?.oauthAccount?.emailAddress);
  } catch {
    return { adopted: null, why: 'could not read whose account the box credential is' };
  }
  if (!email) return { adopted: null, why: 'the box credential does not say whose account it is' };

  const store = new Accounts(cfg.stateDir);
  if (store.credentialPathFor(email)) {
    return { adopted: null, why: `${email} already has a linked account here, which is newer than the box's copy` };
  }
  const accountMeta = extractOauthAccount(readFileSync(path.join(home, '.claude.json'), 'utf8'));
  const saved = store.save(email, readFileSync(file, 'utf8'), accountMeta);
  return saved.ok
    ? { adopted: email, why: `adopted this box's Claude account as ${email}` }
    : { adopted: null, why: saved.message };
}

/**
 * Who a session runs as, when the actor did not say.
 *
 * `telegram:<id>`, `web` and `cli` are all SOMEBODY OPERATING THE BOX, and
 * until now they landed on the box's own Claude account. That account is gone
 * — see docs/one-account-per-person.md — so this answers the question it left:
 * whose credential does a local surface use.
 *
 * THE SINGLE LINKED ACCOUNT, WHEN THERE IS EXACTLY ONE. No configuration, no
 * ambiguity, and the two other cases degrade into a question rather than a
 * wrong answer: none linked is "link one", several is "say which". Both are
 * answerable by a person in one step, which is more than the old behaviour
 * offered — it silently picked the machine's account and told nobody.
 *
 * `AGENT_HUB_OPERATOR` settles the ambiguous case and is needed only there.
 *
 * This is NOT the shared account renamed. It is a named person's credential,
 * attributed to them and revocable by them, which is every property the box
 * account did not have.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {{ email: string|null, why: string }}
 */
export function operatorAccount(cfg) {
  const configured = normaliseEmail(cfg.operator);
  const linked = new Accounts(cfg.stateDir).list();
  if (configured) {
    return linked.includes(configured)
      ? { email: configured, why: `AGENT_HUB_OPERATOR is ${configured}` }
      : { email: null, why: `AGENT_HUB_OPERATOR names ${configured}, who has not linked a Claude account on this box` };
  }
  if (linked.length === 1) return { email: linked[0], why: `${linked[0]} is the only linked account here` };
  if (linked.length === 0) {
    return {
      email: null,
      why: 'nobody has linked a Claude account on this box yet — connect one from the app, or run `agent-hub login`',
    };
  }
  return {
    email: null,
    why: `${linked.length} people have linked accounts here, so set AGENT_HUB_OPERATOR to say which one local sessions use`,
  };
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
 *
 * THE PREFIX IS THE WHOLE POINT and must not be relaxed into "anything that
 * looks like an email". `POST /api/command` accepts a caller-supplied `actor`
 * when there is no fleet identity behind the request, so a bare email in that
 * field is a CLAIM. The prefix is applied by the sidecar, and only ever to an
 * actor the coordinator resolved against an ID token — it is the marker of
 * "verified", not a formatting convention.
 */
/** @param {unknown} actor */
export function emailFromActor(actor) {
  const s = String(actor || '');
  return s.startsWith('fleet:') ? normaliseEmail(s.slice('fleet:'.length)) : null;
}

/**
 * The box's own credential row, as opposed to a person's.
 *
 * A distinct value rather than `null`, and that is the entire reason it
 * exists. Storage keyed on `emailFromActor(...) ?? THE_BOX` cannot tell
 * "nobody is asking, use the shared row" from "somebody IS asking and I could
 * not work out who" — and those two must not have the same answer, because
 * one of them writes a person's live credential into a file every session on
 * the machine reads.
 */
export const HOST_ROW = Symbol('host-row');

/**
 * Which credential row an actor gets, with the failure case separated out.
 *
 * Three outcomes, deliberately, where there used to be two:
 *
 *  - a **verified fleet identity** → that person's row, and only theirs
 *  - **no fleet identity at all** (telegram, the CLI, the web UI) → the box's
 *    own row, because that is somebody operating the machine directly
 *  - a **fleet identity that cannot be named** → `null`, which every caller
 *    must treat as a refusal
 *
 * The third case is the one this function was written for. It should be
 * unreachable — the coordinator only ever sends a verified email — and
 * "unreachable" is exactly the assumption that had already broken once.
 *
 * @param {unknown} actor
 * @returns {string | typeof HOST_ROW | null}
 */
export function rowForActor(actor) {
  const s = String(actor || '');
  if (!s.startsWith('fleet:')) return HOST_ROW;
  return normaliseEmail(s.slice('fleet:'.length));
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
