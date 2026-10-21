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
import { checkIntentSignature, keyId } from '../protocol/intent-signature.js';

/** The path the minter answers on, on the fleet's own address. */
export const MINTER_KEY_PATH = '/.well-known/fleetwright-minter';
/** Where the minter's signing key is kept once fetched, in the sidecar's own directory. */
export const MINTER_KEY_FILE = 'minter-signing.json';
/** A key list older than this is not taken: a coordinator could hold on to an old one. */
export const KEY_LIST_MAX_AGE_MS = 10 * 60_000;

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
 * @returns {Promise<{ ok: true, directory: Map<string, Array<{ kid: string, key: any, label: string }>>, at: number } | { ok: false, text: string }>}
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
  for (const person of Array.isArray(payload.people) ? payload.people : []) {
    const email = String(person?.email || '').trim().toLowerCase();
    if (!email) continue;
    const keys = [];
    for (const k of Array.isArray(person.keys) ? person.keys : []) {
      const key = p256(k?.key);
      // The id is worked out here, not taken: a list naming a key by another
      // key's id would have a box report the wrong device.
      if (key && String(k.kid) === (await keyId(key))) keys.push({ kid: String(k.kid), key, label: String(k.label || '').slice(0, 60) });
    }
    if (keys.length) directory.set(email, keys);
  }
  return { ok: true, directory, at: payload.at };
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
    /** What every intent checked so far was found to be. */
    this.counts = { signed: 0, 'not-needed': 0, unsigned: 0, 'unknown-key': 0, 'bad-signature': 0, 'no-directory': 0 };
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
      this.problem = null;
      return true;
    } catch (e) {
      this.problem = `the key list could not be fetched: ${/** @type {Error} */ (e).message}`;
      return false;
    }
  }

  /**
   * What one intent was found to be, counted. A list past its age is not used.
   *
   * @param {{ actor?: string, id: string, issuedAt: number, params?: Record<string, unknown>, verb: string, sig?: string, kid?: string }} intent
   * @param {string} host  this box's id
   */
  async check(intent, host) {
    const fresh = this.directory && this.listAt !== null && this.now() - this.listAt <= 2 * KEY_LIST_MAX_AGE_MS ? this.directory : null;
    const r = await checkIntentSignature({ intent, sig: intent.sig, kid: intent.kid, host, directory: fresh });
    this.counts[r.verdict] += 1;
    return r;
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
