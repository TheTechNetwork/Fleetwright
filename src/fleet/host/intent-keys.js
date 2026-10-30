// The keys this box checks a person's signature with, and what it found.
// docs/signed-intents.md.
//
// WHERE THE KEYS COME FROM, which is the whole point. Not from the coordinator:
// the minter lists each person's signing keys, the coordinator carries the
// list, and this box takes it only if it is signed by the minter's signing
// key. That key is fetched by this box from the fleet's own address,
// `/.well-known/fleetwright-minter`, a path the deploy routes to the minter
// before the coordinator's Custom Domain sees it (worker/src/minter.js), and
// kept here once fetched.
//
// KEPT, AND NOT REPLACED BY ITSELF. A key the well-known address answers with
// that differs from the one kept is a minter that was redeployed with a new
// key or an address that is no longer the minter's, and this box cannot tell
// which. So it keeps the old one, stops taking lists, and says so in its
// health, where `fleetwright-sidecar` on the box prints it, until somebody
// deletes the kept file there (`minter-signing.json`) to accept the new one.
//
// PHASE 1 ENFORCES NOTHING. Every intent is checked and counted, and the
// counts go in this box's health, so the fleet can see what enforcement would
// refuse before anything is refused.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { signingInput, verify } from '../crypto.js';
import { actorEmail, checkDelegation, checkIntentSignature, keyId } from '../protocol/intent-signature.js';

/** The path the minter answers on, on the fleet's own address. */
export const MINTER_KEY_PATH = '/.well-known/fleetwright-minter';
/** Where the minter's signing key is kept once fetched, in the sidecar's own directory. */
export const MINTER_KEY_FILE = 'minter-signing.json';
/** A key list older than this is not taken: a coordinator could hold on to an old one. */
export const KEY_LIST_MAX_AGE_MS = 10 * 60_000;
/**
 * How often a signature by a key the list does not have makes this box ask
 * again before answering. A phone the minter listed a moment ago is not on a
 * list this box took up to ten minutes earlier, and its person was refused
 * until the next one: a new phone's first request, every time. Asking again
 * at most this often keeps a stream of unknown keys from spending the twelve
 * asks in ten minutes the coordinator allows a box (core.js), which the
 * regular refresh needs one of.
 */
export const MISS_REFRESH_MS = 2 * 60_000;
/**
 * The people this box has been shown a key for, kept across restarts: a box
 * that enforces for people with keys (the default) goes on enforcing for them
 * when a later list leaves them out, which is all a coordinator that drops
 * somebody from the members list can make it do.
 */
export const SIGNERS_FILE = 'signers.json';
/** How many people that file keeps: a fleet's members list is capped at 512 (vault.js). */
export const MAX_SIGNERS = 512;

const B64_COORD_RE = /^[A-Za-z0-9_-]{43}$/;

/** @param {unknown} k */
function p256(k) {
  const j = /** @type {any} */ (k);
  return j && j.kty === 'EC' && j.crv === 'P-256' && B64_COORD_RE.test(String(j.x)) && B64_COORD_RE.test(String(j.y))
    ? { kty: 'EC', crv: 'P-256', x: String(j.x), y: String(j.y) }
    : null;
}

/**
 * The minter's key list, if it is the minter's, for this box, and recent.
 *
 * @param {{ payload: any, signature: unknown, pinned: { kty: string, crv: string, x: string, y: string }, host: string, now: number }} args
 *   `host` is this box key's id (keyId)
 * @returns {Promise<{ ok: true, directory: Map<string, Array<{ kid: string, key: any, label: string }>>, at: number,
 *   revoked: Map<string, Set<string>>, cleared: Set<string> } | { ok: false, text: string }>}
 *   `revoked` the delegations each person took back; `cleared` the people the
 *   minter says keep no key now, having had one
 */
export async function keyListFrom({ payload, signature, pinned, host, now }) {
  if (!payload || typeof payload !== 'object' || typeof signature !== 'string') return { ok: false, text: 'the answer is not a key list' };
  if (!(await verify(pinned, signature, signingInput('vault-keys-answer', payload)))) {
    return { ok: false, text: 'the key list is not signed by the minter’s key this box keeps, so it was not used' };
  }
  if (payload.v !== 1 || payload.host !== host) return { ok: false, text: 'the key list was made for another box' };
  if (!Number.isFinite(payload.at) || Math.abs(now - payload.at) > KEY_LIST_MAX_AGE_MS) return { ok: false, text: 'the key list is more than ten minutes old' };
  /** @type {Map<string, Array<{ kid: string, key: any, label: string }>>} */
  const directory = new Map();
  /** @type {Map<string, Set<string>>} */
  const revoked = new Map();
  /** @type {Set<string>} */
  const cleared = new Set();
  for (const person of Array.isArray(payload.people) ? payload.people : []) {
    const email = String(person?.email || '').trim().toLowerCase();
    if (!email) continue;
    const ids = (Array.isArray(person.revoked) ? person.revoked : []).map(String).filter((/** @type {string} */ id) => /^[A-Za-z0-9_-]{16,64}$/.test(id));
    if (ids.length) revoked.set(email, new Set(ids.slice(0, 64)));
    const keys = [];
    for (const k of Array.isArray(person.keys) ? person.keys : []) {
      const key = p256(k?.key);
      // The id is worked out here, not taken: a list naming a key by another
      // key's id would have a box report the wrong device.
      if (key && String(k.kid) === (await keyId(key))) keys.push({ kid: String(k.kid), key, label: String(k.label || '').slice(0, 60) });
    }
    if (keys.length) directory.set(email, keys);
    else cleared.add(email);
  }
  return { ok: true, directory, at: payload.at, revoked, cleared };
}

/**
 * What a box keeps and reports about signed intents.
 */
export class IntentKeys {
  /**
   * @param {{ origin: string, dir: string|null, hostKey: { publicJwk: { x: string, y: string }, sign: (message: string) => Promise<string> },
   *   ask: (request: any, signature: string) => Promise<any>, fetchImpl?: typeof fetch, now?: () => number, log?: { info: (s: string) => void, warn: (s: string) => void } }} opts
   *   `ask` sends the box's request to the coordinator and resolves with what came back
   */
  constructor({ origin, dir, hostKey, ask, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), log = { info() {}, warn() {} } }) {
    this.origin = new URL(origin).origin;
    this.file = dir ? path.join(dir, MINTER_KEY_FILE) : null;
    this.signersFile = dir ? path.join(dir, SIGNERS_FILE) : null;
    this.hostKey = hostKey;
    this.ask = ask;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.log = log;
    /** @type {{ kty: string, crv: string, x: string, y: string }|null} */
    this.pinned = null;
    /** @type {string|null} a sentence saying what is wrong, for health */
    this.problem = null;
    /** @type {Map<string, Array<{ kid: string, key: any, label: string }>>|null} */
    this.directory = null;
    /** @type {number|null} */
    this.listAt = null;
    /** @type {Map<string, Set<string>>} the delegations each person revoked, from the same list */
    this.revoked = new Map();
    /** @type {Set<string>} everybody this box has been shown a key for, until the minter says they keep none */
    this.signers = new Set();
    if (this.signersFile) {
      try {
        const kept = JSON.parse(readFileSync(this.signersFile, 'utf8'));
        for (const e of Array.isArray(kept) ? kept.slice(0, MAX_SIGNERS) : []) if (actorEmail(e)) this.signers.add(String(e).toLowerCase());
      } catch { /* none kept yet */ }
    }
    /** @type {number|null} when a key the list did not have last made this box ask again */
    this.missAskedAt = null;
    /** What every intent checked so far was found to be. */
    this.counts = {
      signed: 0, delegated: 0, 'not-needed': 0, unsigned: 0, 'unknown-key': 0, 'bad-signature': 0, 'no-directory': 0, 'not-covered': 0, revoked: 0,
    };
  }

  /**
   * Whether this box has been shown a key for this person: the people a box
   * that enforces by default enforces for.
   *
   * @param {unknown} actor
   */
  isSigner(actor) {
    const person = actorEmail(actor);
    return Boolean(person && (this.signers.has(person) || this.directory?.has(person)));
  }

  /** @param {Map<string, unknown>} directory @param {Set<string>} cleared */
  #noteSigners(directory, cleared) {
    let changed = false;
    for (const person of directory.keys()) {
      if (this.signers.has(person)) continue;
      if (this.signers.size >= MAX_SIGNERS) {
        this.log.warn(`sidecar: this box already remembers ${MAX_SIGNERS} people with signing keys; ${person} is checked from the key list only`);
        break;
      }
      this.signers.add(person);
      changed = true;
    }
    for (const person of cleared) if (this.signers.delete(person)) changed = true;
    if (changed && this.signersFile) {
      try {
        mkdirSync(path.dirname(this.signersFile), { recursive: true });
        writeFileSync(`${this.signersFile}.part`, `${JSON.stringify([...this.signers].sort())}\n`, { mode: 0o644 });
        renameSync(`${this.signersFile}.part`, this.signersFile);
      } catch (e) {
        this.log.warn(`sidecar: could not keep who has signing keys: ${/** @type {Error} */ (e).message}`);
      }
    }
  }

  /** The kept key, or the one the minter's address gives, kept now. */
  async #pin() {
    if (!this.pinned && this.file) {
      try {
        this.pinned = p256(JSON.parse(readFileSync(this.file, 'utf8')));
      } catch { /* none kept yet */ }
    }
    /** @type {any} */
    let answer = null;
    try {
      const res = await this.fetchImpl(`${this.origin}${MINTER_KEY_PATH}`, { headers: { accept: 'application/json' } });
      answer = res.ok ? await res.json() : null;
    } catch (e) {
      if (!this.pinned) {
        this.problem = `the minter’s address could not be reached for its signing key: ${/** @type {Error} */ (e).message}`;
        return null;
      }
    }
    const served = p256(answer?.signing);
    if (!this.pinned) {
      if (!served) {
        this.problem = 'the minter’s address gives no signing key yet, so this box has nothing to check signatures with';
        return null;
      }
      this.pinned = served;
      if (this.file) {
        mkdirSync(path.dirname(this.file), { recursive: true });
        writeFileSync(`${this.file}.part`, `${JSON.stringify(served)}\n`, { mode: 0o644 });
        renameSync(`${this.file}.part`, this.file);
      }
      this.log.info(`sidecar: kept the minter’s signing key from ${this.origin}${MINTER_KEY_PATH}`);
    } else if (served && (served.x !== this.pinned.x || served.y !== this.pinned.y)) {
      this.problem = `the minter’s address now gives a different signing key from the one this box keeps; no key list is taken until somebody deletes ${this.file ?? MINTER_KEY_FILE} on this box to accept it`;
      return null;
    }
    return this.pinned;
  }

  /**
   * Ask for the key list and keep it if it is the minter's. Never throws.
   *
   * @returns {Promise<boolean>} whether a list was taken
   */
  async refresh() {
    try {
      const pinned = await this.#pin();
      if (!pinned) return false;
      const hostKey = { kty: 'EC', crv: 'P-256', x: this.hostKey.publicJwk.x, y: this.hostKey.publicJwk.y };
      const request = { v: 1, hostKey, at: this.now() };
      const signature = await this.hostKey.sign(signingInput('vault-keys', request));
      const answer = await this.ask(request, signature);
      if (answer?.ok !== true) {
        this.problem = `the fleet did not give a key list: ${String(answer?.text || 'no answer')}`;
        return false;
      }
      const list = await keyListFrom({ payload: answer.payload, signature: answer.signature, pinned, host: await keyId(hostKey), now: this.now() });
      if (!list.ok) {
        this.problem = list.text;
        this.log.warn(`sidecar: ${list.text}`);
        return false;
      }
      this.directory = list.directory;
      this.listAt = list.at;
      this.revoked = list.revoked;
      this.#noteSigners(list.directory, list.cleared);
      this.problem = null;
      return true;
    } catch (e) {
      this.problem = `the key list could not be fetched: ${/** @type {Error} */ (e).message}`;
      return false;
    }
  }

  /**
   * The key list while it may still be checked with, or null: twice the age a
   * list is taken at, so one missed refresh does not refuse everybody. What
   * check() uses, and so who this box can take a signature from now, which
   * is also what its pins report (pinned-admins.js pinReport): a box holding
   * a list too old to use refuses everybody, and must not say otherwise.
   */
  get current() {
    return this.directory && this.listAt !== null && this.now() - this.listAt <= 2 * KEY_LIST_MAX_AGE_MS ? this.directory : null;
  }

  /**
   * What one intent was found to be, counted. A list past its age is not used.
   * A signature is checked when there is one; a delegation only when there is
   * not, because what the person signed for this request is the stronger word.
   *
   * A KEY THE LIST DOES NOT HAVE makes this box ask the minter again, once,
   * and check again with what comes back (MISS_REFRESH_MS). Nothing about
   * what is taken changes: the new list is the minter's or it is not used,
   * as every list is. Only the intent's final verdict is counted.
   *
   * @param {{ actor?: string, id: string, issuedAt: number, params?: Record<string, unknown>, verb: string, sig?: string, kid?: string, delegation?: unknown }} intent
   * @param {string} host  this box's id
   * @returns {Promise<{ verdict: import('../protocol/intent-signature.js').Verdict | import('../protocol/intent-signature.js').DelegationVerdict, label?: string, gap?: string,
   *   askedAgain?: 'taken'|'failed'|'held' }>}
   *   `askedAgain`, for an unknown key: whether the box asked again and took a
   *   list, asked and got none, or held back because it asked moments ago
   */
  async check(intent, host) {
    const once = async () => {
      const fresh = this.current;
      return !intent.sig && intent.delegation
        ? checkDelegation({ intent, delegation: intent.delegation, host, directory: fresh, revoked: this.revoked, now: this.now() })
        : checkIntentSignature({ intent, sig: intent.sig, kid: intent.kid, host, directory: fresh });
    };
    /** @type {any} */
    let r = await once();
    if (r.verdict === 'unknown-key') {
      const askedAgain = await this.#askAgain();
      if (askedAgain === 'taken') r = await once();
      if (r.verdict === 'unknown-key') r = { ...r, askedAgain };
    }
    this.counts[/** @type {keyof IntentKeys['counts']} */ (r.verdict)] += 1;
    return r;
  }

  /** @type {Promise<boolean>|null} */
  #asking = null;

  /**
   * Ask for the list again because a key was not on it, unless a key that was
   * not on it made this box ask within MISS_REFRESH_MS. Intents arriving
   * together wait for the same ask.
   *
   * @returns {Promise<'taken'|'failed'|'held'>}
   */
  async #askAgain() {
    if (!this.#asking) {
      const now = this.now();
      if (this.missAskedAt !== null && now - this.missAskedAt < MISS_REFRESH_MS) return 'held';
      this.missAskedAt = now;
      this.#asking = this.refresh().finally(() => { this.#asking = null; });
    }
    return (await this.#asking) ? 'taken' : 'failed';
  }

  /** For this box's health. */
  report() {
    return {
      keys: this.directory ? [...this.directory.values()].reduce((n, k) => n + k.length, 0) : null,
      keysAt: this.listAt,
      checked: { ...this.counts },
      ...(this.problem ? { problem: this.problem } : {}),
    };
  }
}
