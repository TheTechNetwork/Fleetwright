// The named-secret store, and the decision of whether a session may read one.
//
// trust.md step 2: `start --secret github-deploy` NAMES a secret this box
// already holds. The name is all that crosses the protocol; the value lives
// here, in a file the operator placed with a shell — the same trust boundary as
// a task profile, and for the same reason. A coordinator that could supply the
// value would be handing a durable credential to an agent with root in a
// container, which is the capability this whole document exists to withhold.
//
// The value reaches the session the way a provider token does: over the
// per-session hook socket, read at the moment of the request (so a rotation
// lands in a running session), logged by name, never seeded into the container's
// filesystem or environment. See src/core/credential-broker.js, which this is
// modelled on, and docs/credential-broker.md.
//
// Two halves, kept apart so the decision is testable without a filesystem: a
// pure `answerSecretRequest` that says yes or no given what the session was
// granted, and a `readNamedSecret` that touches disk. `sessionSecret` wires
// them together for the hook socket in src/index.js.
//
// WHOSE STORE ANSWERS. Two hold named secrets: this box's, which its operator
// placed, and each person's vault, which their phone gave this box
// (vault-store.js). The box's used to answer first for every session, and
// `start { secret }` is a grant any member can make on an operator's box, so a
// member who named DEPLOY_KEY was served the operator's, with their own vault's
// DEPLOY_KEY hidden behind it. Now the box's answers only a session whose
// record says it may (`boxSecrets`, which the coordinator decides from who
// administers the box, protocol v14) or one started by somebody on the box
// itself; everybody else's is answered from their own vault alone.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { isValidName } from './names.js';
import { vaultSecret, vaultHolder } from './vault-store.js';

/**
 * The names of the secrets this box holds, sorted, for the `secrets` verb and
 * its picker. NAMES ONLY — nothing here reads a value, and there is nowhere on
 * the result to put one.
 *
 * A file counts only if its own name is a valid reference name: that excludes a
 * `README` left as a note (well, a dotted `README.md` — `isValidName` forbids
 * the dot), a dotfile, and anything with a path-shaped character. Directories
 * are skipped. A missing store is not an error — it is the ordinary state of a
 * box that holds no secrets, and answers with [].
 *
 * @param {string} dir the store directory (cfg.secretsDir)
 * @returns {string[]}
 */
export function listSecretNames(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => {
      if (!isValidName(name)) return false;
      try {
        return statSync(path.join(dir, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Read a named secret from the store, or null if it is not there.
 *
 * The name is charset-checked BEFORE it is joined to the directory, and that is
 * load-bearing rather than defensive: `readNamedSecret(dir, '../state.json')`
 * must never resolve out of the store. `isValidName` forbids a dot, so `..`
 * cannot be spelled, and forbids a slash, so no path can be built — the same
 * guarantee `profile` names rely on. A caller that skips this check reopens a
 * traversal the type system cannot see.
 *
 * A single trailing newline is stripped, because `printf 'tok' > f` and
 * `echo tok > f` should both store the same secret and the second is what
 * everyone types. Nothing else is trimmed: a secret is arbitrary bytes and
 * chewing its edges is how a working credential becomes a mysterious 401.
 *
 * @param {string} dir  the store directory (cfg.secretsDir)
 * @param {string} name the requested secret name
 * @returns {string|null}
 */
export function readNamedSecret(dir, name) {
  if (!isValidName(name)) return null;
  try {
    return readFileSync(path.join(dir, name), 'utf8').replace(/\r?\n$/, '');
  } catch {
    // Missing, unreadable, a directory — all "the host does not hold this",
    // which the caller turns into a `no_secret` refusal rather than a crash.
    return null;
  }
}

/**
 * May this session read this named secret, and if so what is its value?
 *
 * Pure: the caller supplies what the session was granted (the `secret` on its
 * record, put there by `start --secret`) and a `read` that resolves a name to a
 * value. The refusals mirror the credential broker's — a named reason the
 * session can act on, and never the value.
 *
 * `granted` is a single name today (the record field), accepted here as one or
 * many so a later `start` that grants a set needs no change on this side.
 *
 * @param {object} opts
 * @param {string} opts.requested            the name the session asked for
 * @param {string|string[]|null} opts.granted the name(s) start --secret allowed
 * @param {(name: string) => string|null} opts.read reads the store
 * @returns {{ ok: true, name: string, value: string } | { ok: false, error: string }}
 */
export function answerSecretRequest({ requested, granted, read }) {
  if (!requested || typeof requested !== 'string') {
    return { ok: false, error: 'no_name' };
  }
  const allowed = Array.isArray(granted) ? granted : granted ? [granted] : [];
  // NOT GRANTED is the scoping check, and it comes first. A session started
  // without `--secret`, or one reaching for a name it was not given, is refused
  // before the store is even consulted — so a session cannot probe which
  // secrets exist by asking for them. This is the whole point of the reference:
  // the grant, not the ask, decides.
  if (!allowed.includes(requested)) {
    return { ok: false, error: 'not_granted' };
  }
  const value = read(requested);
  // GRANTED BUT ABSENT is a different fact, and worth its own word: the session
  // was told it could have `github-deploy` and this box has no such file. That
  // is an operator gap on THIS host — the name was placed on one box and not
  // this one — and saying `not_granted` for it would send them to fix the wrong
  // thing.
  if (value === null) {
    return { ok: false, error: 'no_secret' };
  }
  return { ok: true, name: requested, value };
}

/** @param {unknown} actor */
const fromTheFleet = (actor) => String(actor ?? '').startsWith('fleet:');

/**
 * What a start or resume writes on the record about this box's own secrets.
 *
 * The coordinator's word when it gave one. When it did not, which is a
 * coordinator from before v14: `false` for somebody the fleet started, because
 * it cannot be told whether they administer this box and the box's secrets
 * are its operator's (fail closed, and their own vault still answers); and
 * null, leaving the record as it is, for somebody on the box, whose sessions
 * the box's secrets have always answered (boxSecretsServed).
 *
 * @param {string|null|undefined} actor  who pressed start or resume
 * @param {boolean|null|undefined} said  `--box-secrets`, from the coordinator
 * @returns {boolean|null}
 */
export function boxSecretsFor(actor, said) {
  if (typeof said === 'boolean') return said;
  return fromTheFleet(actor) ? false : null;
}

/**
 * May this box's own named secrets answer this session?
 *
 * A session started by somebody on the box (the console, the CLI: an actor
 * with no fleet identity) yes, as it always was: that is the box's operator.
 * A session the fleet started only when its record says so, which only the
 * coordinator's `yes` writes; a record from before, or one an older
 * coordinator started, says nothing and is answered from its owner's vault.
 * An unparseable fleet creator is the fleet's like any other, so no.
 *
 * @param {{ createdBy?: string|null, boxSecrets?: boolean|null }|null|undefined} rec
 */
export function boxSecretsServed(rec) {
  if (!rec) return false;
  return fromTheFleet(rec.createdBy) ? rec.boxSecrets === true : true;
}

/**
 * The answer to a session's `fleet-secret <name>`, as the hook socket gives
 * it: the grant on its record decides (answerSecretRequest), then this box's
 * store if it may answer this session (boxSecretsServed), then the session
 * owner's vault: for one started on the box itself, the operator's, on a vault
 * box (vault-store.js, vaultHolder). Read now, so a rotation reaches a running
 * session.
 *
 * @param {{ secretsDir: string, stateDir: string }} cfg
 * @param {{ createdBy?: string|null, secret?: string|null, boxSecrets?: boolean|null }|null|undefined} rec  the session's record
 * @param {string} requested
 */
export function sessionSecret(cfg, rec, requested) {
  return answerSecretRequest({
    requested,
    granted: rec?.secret ?? null,
    read: (n) =>
      (boxSecretsServed(rec) ? readNamedSecret(cfg.secretsDir, n) : null) ??
      vaultSecret(cfg, vaultHolder(cfg, rec?.createdBy ?? null)?.email ?? null, n),
  });
}
