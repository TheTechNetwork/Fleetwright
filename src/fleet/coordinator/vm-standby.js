// Machines kept ready on a person's own hypervisor, so a session starts in
// seconds rather than after a clone, a boot and an enrolment.
// docs/hypervisors.md, "Machines kept ready".
//
// Asked for: "standby vms to speed up session starts".
//
// WHAT IS KEPT HERE is two small things: what each person asked to keep ready
// (an image, how many, and which network), and which machines were made for
// that, from the moment one is asked for until a session takes it. Everything
// else about those machines is what it is for any other: a ticket bound to
// the person, a temporary host enrolled under a name derived from it, swept
// by the box at its end.
//
// A MACHINE TAKEN IS NEVER GIVEN BACK. Once a session has run on it, it is
// that session's, and the next session gets one nobody has used. Reuse would
// carry one session's leftovers into the next, which is the thing a machine
// per session exists to prevent.
//
// BOUNDED, because it is one Durable Object value (test/do-key-bounds.test.js):
// a refusal past MAX_PEOPLE wishes, at most MAX_READY machines each, and a
// machine still being made forgotten after PENDING_MS.

/** The most machines one person may keep ready. Each costs a VM's worth of the pool, all the time. */
export const MAX_READY = 3;
/**
 * How many people may keep machines ready at once: a refusal past it, never
 * an eviction. Small on purpose, because it is one Durable Object value: at
 * the longest an address can be, this many people and twice MAX_READY
 * machines each still fit (test/do-key-bounds.test.js does the arithmetic).
 */
export const MAX_PEOPLE = 32;
/** A machine asked for and not enrolled by then is taken to have failed, and another may be asked for. */
export const PENDING_MS = 15 * 60_000;

/**
 * @typedef {{ template: string, count: number, network: string|null }} Wish
 * @typedef {{ owner: string, template: string, network: string|null, at: number, enrolled: boolean }} Kept
 */

export class VmStandby {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, Wish>} by owner */
    this.wishes = new Map();
    /** @type {Map<string, Kept>} by the host id the machine enrols as */
    this.machines = new Map();
  }

  /** @param {string} owner @returns {Wish|null} */
  wishFor(owner) {
    return this.wishes.get(owner) ?? null;
  }

  /**
   * Keep `count` machines from `template` ready for `owner`; 0 stops keeping
   * any. The machines already kept beyond the new count are returned, for
   * the caller to end.
   *
   * @param {string} owner @param {Wish} wish
   * @returns {{ ok: true, extra: string[] } | { ok: false, text: string }}
   */
  set(owner, { template, count, network }) {
    if (count > 0 && !this.wishes.has(owner) && this.wishes.size >= MAX_PEOPLE) {
      return { ok: false, text: `This fleet already keeps machines ready for ${MAX_PEOPLE} people, which is as many as it can store.` };
    }
    if (count === 0) this.wishes.delete(owner);
    else this.wishes.set(owner, { template, count, network });
    // WHAT NO LONGER MATCHES is ended: another image or network, or more of
    // them than now asked for. The oldest are the ones kept, because they are
    // the ones ready soonest, or already.
    const mine = [...this.machines.entries()].filter(([, m]) => m.owner === owner);
    const matching = mine.filter(([, m]) => count > 0 && m.template === template && m.network === network);
    const extra = [
      ...mine.filter(([id]) => !matching.some(([k]) => k === id)).map(([id]) => id),
      ...matching.sort((a, b) => a[1].at - b[1].at).slice(count).map(([id]) => id),
    ];
    for (const id of extra) this.machines.delete(id);
    return { ok: true, extra };
  }

  /** A machine asked for to be kept ready, by the host id it will enrol as. @param {string} hostId @param {Omit<Kept, 'at'|'enrolled'>} m */
  noteMade(hostId, { owner, template, network }) {
    const theirs = [...this.machines.values()].filter((k) => k.owner === owner).length;
    // Twice the most a person may keep: room for a machine being made while
    // the one it replaces is still counted, and no more.
    if (theirs >= MAX_READY * 2) return false;
    this.machines.set(hostId, { owner, template, network, at: this.now(), enrolled: false });
    return true;
  }

  /** It joined the fleet. @param {string} hostId */
  noteEnrolled(hostId) {
    const m = this.machines.get(hostId);
    if (m) m.enrolled = true;
  }

  /** @param {string} hostId */
  isKept(hostId) {
    return this.machines.has(hostId);
  }

  /**
   * How many of this person's are ready and how many are being made, after
   * forgetting the ones that are gone: an enrolled machine no longer live, or
   * one asked for and never enrolled.
   *
   * @param {string} owner @param {(hostId: string) => boolean} isReady
   */
  tally(owner, isReady) {
    let ready = 0;
    let starting = 0;
    const wish = this.wishes.get(owner);
    for (const [id, m] of [...this.machines.entries()]) {
      if (m.owner !== owner) continue;
      if (m.enrolled ? !isReady(id) : this.now() - m.at > PENDING_MS) {
        this.machines.delete(id);
        continue;
      }
      if (wish && (m.template !== wish.template || m.network !== wish.network)) continue;
      if (m.enrolled) ready++;
      else starting++;
    }
    return { ready, starting };
  }

  /**
   * Take a ready machine for a session: this person's, from that image, on
   * that network, and one `isReady` accepts. Gone from here once taken.
   *
   * @param {string} owner @param {string} template @param {string|null} network
   * @param {(hostId: string) => boolean} isReady
   * @returns {string|null}
   */
  claim(owner, template, network, isReady) {
    const ready = [...this.machines.entries()]
      .filter(([id, m]) => m.owner === owner && m.template === template && m.network === network && m.enrolled && isReady(id))
      .sort((a, b) => a[1].at - b[1].at);
    if (!ready.length) return null;
    const [id] = ready[0];
    this.machines.delete(id);
    return id;
  }

  serialise() {
    return { wishes: [...this.wishes.entries()], machines: [...this.machines.entries()] };
  }

  /** @param {unknown} saved */
  restore(saved) {
    const s = /** @type {any} */ (saved);
    if (!s || typeof s !== 'object') return;
    for (const e of Array.isArray(s.wishes) ? s.wishes.slice(0, MAX_PEOPLE) : []) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || !e[1] || typeof e[1].template !== 'string') continue;
      const count = Math.max(0, Math.min(MAX_READY, Number(e[1].count) || 0));
      if (count) this.wishes.set(e[0], { template: e[1].template, count, network: typeof e[1].network === 'string' ? e[1].network : null });
    }
    for (const e of Array.isArray(s.machines) ? s.machines.slice(0, MAX_PEOPLE * MAX_READY * 2) : []) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || !e[1] || typeof e[1].owner !== 'string') continue;
      this.machines.set(e[0], {
        owner: e[1].owner,
        template: String(e[1].template || ''),
        network: typeof e[1].network === 'string' ? e[1].network : null,
        at: Number(e[1].at) || 0,
        enrolled: e[1].enrolled === true,
      });
    }
  }
}
