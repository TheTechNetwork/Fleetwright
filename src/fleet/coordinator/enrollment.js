// Admitting a new host or device, once.
//
// Enrolment is the moment a machine or a phone stops being a stranger, and it
// is the only moment when something that has no credential is allowed to ask
// for one. Everything about the design follows from that:
//
//   SHORT LIVED    a code that works for an hour is a password that leaked an
//                  hour ago. Ten minutes is long enough to walk to the box.
//   SINGLE USE     redeemed once, gone. Otherwise a code in a scrollback is a
//                  second host nobody knows about.
//   SPEAKABLE      six digits in two groups. These get read down a phone or
//                  typed into a terminal by somebody holding a laptop.
//   BOUND          minted for a purpose — a host or a device — so a code meant
//                  for a Raspberry Pi cannot enrol somebody's phone.
//
// A code is not a credential. It buys exactly one exchange, in which the
// enroller presents a public key and receives an identity. After that the code
// is worthless and the key is what matters.

import { randomInt } from './random.js';

const CODE_TTL_MS = 10 * 60_000;

/** @typedef {'host'|'device'} Purpose */

/**
 * @typedef {object} Pending
 * @property {string} code
 * @property {Purpose} purpose
 * @property {string} label      what this will be called once it exists
 * @property {string|null} actor who minted it
 * @property {number} expiresAt
 */

export class Enrollment {
  /** @param {{ now?: () => number, ttlMs?: number }} [opts] */
  constructor({ now = () => Date.now(), ttlMs = CODE_TTL_MS } = {}) {
    /** @type {Map<string, Pending>} */
    this.pending = new Map();
    this.now = now;
    this.ttlMs = ttlMs;
  }

  /**
   * Mint a code.
   *
   * @param {{ purpose: Purpose, label?: string, actor?: string|null }} spec
   */
  mint({ purpose, label = '', actor = null }) {
    this.#sweep();
    // 6 digits, shown as two groups of three. randomInt over the whole range
    // rather than the modulo of random bytes, which is not uniform.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    /** @type {Pending} */
    const entry = {
      code,
      purpose,
      label: String(label || '').slice(0, 60),
      actor,
      expiresAt: this.now() + this.ttlMs,
    };
    this.pending.set(code, entry);
    return { code, expiresAt: entry.expiresAt, purpose };
  }

  /**
   * Spend a code, or explain why it cannot be spent.
   *
   * The reason is returned because these are read by a person standing at a
   * machine: "expired" and "already used" and "wrong kind" send them to three
   * different actions, and a single "invalid" sends them to guess.
   *
   * @param {string} code
   * @param {Purpose} purpose
   * @returns {{ ok: true, entry: Pending } | { ok: false, reason: string }}
   */
  redeem(code, purpose) {
    this.#sweep();
    const entry = this.pending.get(String(code || '').replace(/\s+/g, ''));
    if (!entry) return { ok: false, reason: 'that code is not valid, or has already been used' };
    if (entry.expiresAt <= this.now()) {
      this.pending.delete(entry.code);
      return { ok: false, reason: 'that code has expired — mint another' };
    }
    if (entry.purpose !== purpose) {
      return { ok: false, reason: `that code was issued for a ${entry.purpose}, not a ${purpose}` };
    }
    // Deleted before the caller does anything with it: a redemption that fails
    // downstream must not leave the code usable, because the safe failure is
    // "mint another" and the unsafe one is "try it again and see".
    this.pending.delete(entry.code);
    return { ok: true, entry };
  }

  /** What is outstanding, for a person who wants to know what they left lying around. */
  outstanding() {
    this.#sweep();
    return [...this.pending.values()].map(({ code, ...rest }) => ({ ...rest, code: `${code.slice(0, 3)} ***` }));
  }

  #sweep() {
    const now = this.now();
    for (const [code, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(code);
  }
}
