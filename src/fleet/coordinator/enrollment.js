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

// Six digits is a million possibilities, which is plenty for a human and not
// much for a script: unthrottled, an attacker who can post a few hundred
// guesses a second walks the space inside a code's lifetime. So failures are
// counted, and once there have been enough the door is shut for everybody until
// the window passes. Deliberately GLOBAL rather than per-IP — an attacker
// picks their IP, and these fleets have a handful of operators who will mint
// another code, whereas a per-source limit is no limit at all.
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;

/** @typedef {'host'|'device'} Purpose */

/**
 * @typedef {object} Pending
 * @property {string} code
 * @property {Purpose} purpose
 * @property {string} label      what this will be called once it exists
 * @property {string|null} actor who minted it
 * @property {string|null} hostId if set, the ONLY host id this pin may enrol
 * @property {boolean} readmit   may this pin bring back a revoked host
 * @property {number} expiresAt
 * @property {boolean} [ephemeral]  admits a host that is expected to vanish
 */

export class Enrollment {
  /** @param {{ now?: () => number, ttlMs?: number, maxFailures?: number }} [opts] */
  constructor({ now = () => Date.now(), ttlMs = CODE_TTL_MS, maxFailures = MAX_FAILURES } = {}) {
    /** @type {Map<string, Pending>} */
    this.pending = new Map();
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxFailures = maxFailures;
    /** @type {number[]} timestamps of recent wrong guesses */
    this.failures = [];
  }

  /**
   * Mint a code.
   *
   * A pin can be BOUND to one host id, and can carry permission to readmit a
   * revoked one. Both default off, so an unbound pin still enrols a new machine
   * under whatever name it has — which is the ordinary case and stays one step.
   *
   * Binding matters because re-enrolling an existing name REPLACES its key.
   * Without it, a pin minted so somebody could add a Raspberry Pi is also a pin
   * that can take over the build server: same six digits, different hostId in
   * the request, and the fleet now routes that name to a machine of their
   * choosing.
   *
   * @param {{ purpose: Purpose, label?: string, actor?: string|null, hostId?: string|null, readmit?: boolean, ephemeral?: boolean }} spec
   */
  mint({ purpose, label = '', actor = null, hostId = null, readmit = false, ephemeral = false }) {
    this.#sweep();
    // 6 digits, shown as two groups of three. randomInt over the whole range
    // rather than the modulo of random bytes, which is not uniform.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    /** @type {Pending} */
    const entry = {
      code,
      // EPHEMERAL: this pin enrols a host that is expected to VANISH — a CI
      // runner, a throwaway VM. The property has to be decided when the pin is
      // minted rather than claimed by the host, because a host that could
      // declare itself permanent would be a host that never gets cleaned up.
      ephemeral,
      purpose,
      label: String(label || '').slice(0, 60),
      actor,
      hostId: hostId ? String(hostId) : null,
      readmit: Boolean(readmit),
      expiresAt: this.now() + this.ttlMs,
    };
    this.pending.set(code, entry);
    return { code, expiresAt: entry.expiresAt, purpose, hostId: entry.hostId, readmit: entry.readmit };
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
   * @param {string} [hostId] the name being enrolled, for a pin bound to one
   * @returns {{ ok: true, entry: Pending } | { ok: false, reason: string }}
   */
  redeem(code, purpose, hostId) {
    this.#sweep();
    if (this.#lockedOut()) {
      return { ok: false, reason: 'too many wrong codes lately — wait a minute and try again' };
    }
    const entry = this.pending.get(String(code || '').replace(/\s+/g, ''));
    if (!entry) {
      this.failures.push(this.now());
      return { ok: false, reason: 'that code is not valid, or has already been used' };
    }
    if (entry.expiresAt <= this.now()) {
      this.pending.delete(entry.code);
      return { ok: false, reason: 'that code has expired — mint another' };
    }
    if (entry.purpose !== purpose) {
      return { ok: false, reason: `that code was issued for a ${entry.purpose}, not a ${purpose}` };
    }
    // Checked HERE, beside the purpose check, and deliberately BEFORE the
    // delete below. A bound pin presented for the wrong host is a refusal, not
    // a spend — otherwise anyone who guessed a pin existed could burn it by
    // naming the wrong machine, and the person it was minted for would be left
    // asking for another.
    if (entry.hostId && String(hostId || '') !== entry.hostId) {
      return { ok: false, reason: `that code was minted for ${entry.hostId}` };
    }
    // Deleted before the caller does anything with it: a redemption that fails
    // downstream must not leave the code usable, because the safe failure is
    // "mint another" and the unsafe one is "try it again and see".
    this.pending.delete(entry.code);
    return { ok: true, entry };
  }

  /**
   * Codes survive a restart.
   *
   * They have to: a Durable Object can be evicted between minting a code and
   * somebody typing it into a terminal, and a pin that silently stops working
   * because the coordinator went to sleep is indistinguishable from a pin that
   * was typed wrong. The TTL still applies on the way back in.
   */
  serialise() {
    this.#sweep();
    return [...this.pending.values()];
  }

  /** @param {Pending[]} entries */
  restore(entries) {
    for (const e of entries || []) if (e?.code && e.expiresAt > this.now()) this.pending.set(e.code, e);
  }

  /** What is outstanding, for a person who wants to know what they left lying around. */
  outstanding() {
    this.#sweep();
    return [...this.pending.values()].map(({ code, ...rest }) => ({ ...rest, code: `${code.slice(0, 3)} ***` }));
  }

  /** True while the guess budget is spent. */
  #lockedOut() {
    const cutoff = this.now() - FAILURE_WINDOW_MS;
    this.failures = this.failures.filter((t) => t > cutoff);
    return this.failures.length >= this.maxFailures;
  }

  #sweep() {
    const now = this.now();
    for (const [code, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(code);
  }
}
