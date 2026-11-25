// Machines on this box itself, behind the seam the hypervisors and the
// sandbox providers share (pools.js). docs/api-engines.md, "A machine on a
// box of your own".
//
// A FOURTH DRIVER, AND THE ONLY ONE WITH NOTHING TO HOLD. A hypervisor's
// driver holds a token and a provider's holds an API key. This one holds
// nothing: the machine is a container on the box it runs on, made from the
// fleet's own image, with no third party and no key. It reports the shape
// the others report (`kind: 'sandbox'`, marked `own`), so the coordinator
// and both phones see one more place a machine image can be.
//
// THE HUB DOES THE WORK. This process never touches Podman (sidecar.js says
// why: it runs as its own user, with nobody's containers). It asks the box's
// hub, which owns them (src/core/machines.js), over the loopback it already
// talks to it on. So everything here is a question to the hub and its
// answer in a person's words, and a hub that cannot be asked is said as
// that and never as "no machines". A machine that stopped by itself is said
// too, on its owner's place and nobody else's, with how its log ended: the
// hub read that before it removed the machine. It travels as the place's
// `problem`, which both phones already draw, so nothing new is on the wire.
//
// OFF UNLESS THE BOX'S OPERATOR NAMED `own` in FLEETWRIGHT_SANDBOX_PROVIDERS.
// Then it makes machines for the people whose vault this box is approved
// for and nobody else: the people who already said this box may hold their
// sign-ins, which a machine on it is handed.
//
// ONLY WITH A HYPERVISOR: a network, a group or a lab of its own, a restart,
// a resize and a console. Each is refused in words, here, and not ignored.

import { createHash } from 'node:crypto';
import { seal, claudeBindingFor } from '../seal.js';
import { SANDBOX_KIND } from './sandbox-pools.js';

/** The name the box's operator turns this on with, beside a provider's. */
export const OWN_PROVIDER = 'own';

const TICKET_RE = /^fwt_([0-9a-f]{12})_[0-9a-f]{48}$/;
const NAME_RE = /^vm-[0-9a-f]{12}$/;
/** A Claude token's alphabet and length, as xo-pools.js reads one. */
const CLAUDE_RE = /^[A-Za-z0-9._~+/=-]{20,2048}$/;

/**
 * A UUID for this box's one image, from the box's name, so it is an image
 * id like any other and two boxes' images are two.
 *
 * @param {string} boxId
 */
export function ownImageId(boxId) {
  const h = createHash('sha256').update(`own\0${boxId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** One printable line of the hub's or Podman's words, bounded. */
function line(/** @type {unknown} */ v) {
  return String(v ?? '').split('\n')[0].replace(/[^\x20-\x7e’]/g, '').trim().slice(0, 200);
}

/**
 * @typedef {{
 *   machines: (opts?: { prepare?: boolean }) => Promise<any>,
 *   makeMachine: (ask: { owner: string, ticket: string, coordinator: string, minutes: number|null }) => Promise<any>,
 *   machineControl: (ask: { owner: string, name: string, action: string, minutes: number|null }) => Promise<any>,
 * }} MachineHub  the three questions of hub-client.js this asks
 */

export class OwnPools {
  /**
   * @param {{ enabled?: boolean, hub?: MachineHub|null, boxId?: string, log?: { info: Function, warn: Function } }} [opts]
   *   `enabled` is the operator's switch; without it, or without a hub to
   *   ask, this holds nothing and reports nothing.
   */
  constructor({ enabled = false, hub = null, boxId = '', log = { info() {}, warn() {} } } = {}) {
    this.hub = hub;
    this.boxId = String(boxId || '');
    this.enabled = Boolean(enabled && hub && this.boxId);
    this.log = log;
    /** The people this box makes machines for. @type {Map<string, { owner: string }>} `owner own` */
    this.held = new Map();
    /** Each person's Claude token, as the vault handed it. @type {Map<string, string>} */
    this.claude = new Map();
    /** What each was last seen as. @type {Map<string, any>} */
    this.seen = new Map();
    /** The machines already handed a sign-in, so each is handed one once. @type {Set<string>} */
    this.handed = new Set();
  }

  /** Where these machines are, as an address no pool or provider has. */
  get address() {
    return `${OWN_PROVIDER}:${this.boxId}`;
  }

  /** @param {string} owner */
  holdsFor(owner) {
    return this.held.has(`${String(owner || '').toLowerCase()} ${OWN_PROVIDER}`);
  }

  /**
   * Note who this box is approved for, and each one's Claude token. Nothing
   * is taken out of the answer: there is no item of this driver's in it.
   *
   * @param {Array<{ email: string, items?: Array<{ name: string, value?: string }> }>} accounts
   */
  adopt(accounts) {
    if (!this.enabled) return accounts;
    /** @type {Map<string, { owner: string }>} */
    const held = new Map();
    /** @type {Map<string, string>} */
    const claude = new Map();
    for (const a of Array.isArray(accounts) ? accounts : []) {
      const owner = String(a?.email || '').toLowerCase();
      if (!owner) continue;
      held.set(`${owner} ${OWN_PROVIDER}`, { owner });
      for (const i of Array.isArray(a?.items) ? a.items : []) {
        if (i?.name === 'claude' && typeof i.value === 'string' && CLAUDE_RE.test(i.value)) claude.set(owner, i.value);
      }
    }
    for (const k of [...this.seen.keys()]) if (!held.has(k)) this.seen.delete(k);
    if (held.size && !this.held.size) this.log.info('sidecar: making machines on this box for the people it is approved for');
    this.held = held;
    this.claude = claude;
    return accounts;
  }

  /** For the health frame, in the shape the other drivers report, marked `own`. */
  report() {
    return [...this.held.entries()].map(([k, h]) => this.seen.get(k) ?? this.#entry(h.owner, { reachable: null, ready: false, image: null, machines: [] }));
  }

  /** @param {string} owner @param {{ reachable: boolean|null, ready: boolean, image: string|null, machines: any[], problem?: string|null }} now */
  #entry(owner, now) {
    return {
      address: this.address,
      owner,
      kind: SANDBOX_KIND,
      // NOT SOMEBODY ELSE'S CLOUD. The one word a screen reads to not call
      // this rented, and the box's own name where a provider's would be.
      own: true,
      provider: this.boxId,
      reachable: now.reachable,
      pools: [],
      // OFFERED ONLY ONCE IT IS BUILT, so nobody is offered a machine that
      // would be refused for want of an image.
      images: now.ready ? [{ id: ownImageId(this.boxId), name: now.image || 'Linux, with the fleet' }] : [],
      networks: [],
      machines: now.machines,
      ...(now.problem ? { problem: now.problem } : {}),
    };
  }

  /** Whether this box offers this person that image. @param {string} owner @param {string} template */
  hasImage(owner, template) {
    return this.holdsFor(owner) && template === ownImageId(this.boxId);
  }

  /** Ask the hub what it has, and have it build the image if there is none. */
  async refresh() {
    if (!this.enabled || !this.held.size) return;
    /** @type {any} */
    let said;
    try {
      said = await /** @type {MachineHub} */ (this.hub).machines({ prepare: true });
    } catch (e) {
      said = { ok: false, text: `The hub on this machine did not answer: ${line(/** @type {Error} */ (e)?.message) || 'no answer'}` };
    }
    for (const [k, h] of this.held) {
      if (said?.ok !== true || !Array.isArray(said.machines)) {
        // COULD NOT LOOK is not "has none": a machine that enrolled must not
        // be retired on it, so this is "not reachable", with why.
        this.seen.set(k, this.#entry(h.owner, { reachable: false, ready: false, image: null, machines: [], problem: line(said?.text) || 'The hub on this machine did not answer.' }));
        continue;
      }
      const image = said.image && typeof said.image === 'object' ? said.image : {};
      const machines = said.machines
        .filter((/** @type {any} */ m) => NAME_RE.test(String(m?.name)) && String(m?.owner || '').toLowerCase() === h.owner)
        .map((/** @type {any} */ m) => ({
          name: String(m.name),
          id: String(m.name),
          state: typeof m.state === 'string' ? m.state : null,
          until: Number.isFinite(m.until) ? m.until : null,
          madeAt: Number.isFinite(m.madeAt) ? m.madeAt : null,
          // What Podman gives it is the box's setting, which this does not read.
          cpus: null,
          memory: null,
          image: typeof image.name === 'string' ? image.name : null,
        }));
      // A MACHINE OF THEIRS THAT STOPPED BY ITSELF and was removed, said
      // where this place says why it has no image: the hub read how its log
      // ended before removing it, and keeps that for an hour. The newest, if
      // there are two. Nobody else's: a log is its owner's to read. Why
      // there is no image comes first, since that is why nothing can be made.
      const ended = (Array.isArray(said.ended) ? said.ended : [])
        .filter((/** @type {any} */ e) => NAME_RE.test(String(e?.name)) && String(e?.owner || '').toLowerCase() === h.owner && Number.isFinite(e.at) && typeof e.text === 'string')
        .sort((/** @type {any} */ a, /** @type {any} */ b) => b.at - a.at)[0];
      const noImage = image.ready === true ? null : line(image.problem) || null;
      this.seen.set(k, this.#entry(h.owner, { reachable: true, ready: image.ready === true, image: typeof image.name === 'string' ? image.name : null, machines, problem: noImage ?? (ended ? line(ended.text) || null : null) }));
    }
  }

  /**
   * Make a machine on this box, for a person it is approved for.
   *
   * @param {{ owner: string, template: string, ticket: string, minutes?: number|null, network?: string|null, group?: string|null, lab?: boolean, coordinatorUrl: string }} ask
   */
  async make({ owner, template, ticket, minutes = null, network = null, group = null, lab = false, coordinatorUrl }) {
    const who = String(owner || '').toLowerCase();
    if (!TICKET_RE.test(String(ticket || ''))) return { ok: false, text: 'That machine came without the ticket it enrols with, so it was not made.' };
    if (!this.hasImage(who, template)) return { ok: false, text: `${this.boxId} makes no machine of its own for you.` };
    // ONLY WITH A HYPERVISOR, said and not ignored: the machine would not be
    // where it was asked to be.
    if (network || group || lab) return { ok: false, text: `A machine on ${this.boxId} is on ${this.boxId}’s own network. A network, a group or a lab of its own needs a hypervisor, so it was not made.` };
    if (!/^https:\/\//.test(String(coordinatorUrl || ''))) return { ok: false, text: 'This machine does not know the fleet’s address to give the new one, so it was not made.' };
    let r;
    try {
      r = await /** @type {MachineHub} */ (this.hub).makeMachine({ owner: who, ticket, coordinator: coordinatorUrl, minutes: minutes == null ? null : Number(minutes) });
    } catch (e) {
      const name = `vm-${/** @type {RegExpExecArray} */ (TICKET_RE.exec(ticket))[1]}`;
      return { ok: false, unreachable: true, text: `The hub on ${this.boxId} did not answer, so whether ${name} was made is not known: ${line(/** @type {Error} */ (e)?.message) || 'no answer'}. Look at Machines before trying again.` };
    }
    if (r?.ok !== true) return { ok: false, text: line(r?.text) || `${this.boxId} did not make the machine, and did not say why.` };
    this.log.info(`sidecar: made ${r.name} on this box for ${who}, for ${r.minutes} minutes`);
    return { ok: true, name: r.name, minutes: r.minutes, text: `Made ${r.name} on ${this.boxId}, for ${r.minutes} minutes. It joins when it has started and enrolled.` };
  }

  /**
   * End a machine, or give it more time.
   *
   * @param {{ owner: string, name: string, action: string, minutes?: number|null }} ask
   * @returns {Promise<{ ok: boolean, text: string, notHere?: boolean, unreachable?: boolean, minutes?: number }>}
   */
  async control({ owner, name, action, minutes = null }) {
    const who = String(owner || '').toLowerCase();
    if (!NAME_RE.test(String(name))) return { ok: false, text: 'That is not the name of a machine this fleet made.' };
    if (!this.holdsFor(who)) return { ok: false, notHere: true, text: `${this.boxId} makes no machine of its own for you.` };
    let r;
    try {
      r = await /** @type {MachineHub} */ (this.hub).machineControl({ owner: who, name: String(name), action: String(action), minutes: minutes == null ? null : Number(minutes) });
    } catch (e) {
      return { ok: false, unreachable: true, text: `The hub on ${this.boxId} did not answer: ${line(/** @type {Error} */ (e)?.message) || 'no answer'}.` };
    }
    if (r?.ok === true) return { ok: true, text: line(r.text), ...(Number.isFinite(r.minutes) ? { minutes: r.minutes } : {}) };
    return { ok: false, ...(r?.notHere === true ? { notHere: true } : {}), text: line(r?.text) || `${this.boxId} did not do that, and did not say why.` };
  }

  /**
   * Hand a person's Claude sign-in to one of their machines on this box. As
   * to a VM this box made: the box already holds the sign-in, and the
   * machine is the box's own container, so it goes nowhere it was not.
   *
   * Only to a machine the hub lists as this person's and running; a name
   * the hub does not have is `notHere`, so the coordinator asks the next box.
   *
   * @param {{ owner: string, name: string, key: string }} ask
   * @returns {Promise<{ ok: boolean, text: string, sealed?: any, notHere?: boolean, unreachable?: boolean }>}
   */
  async handLogin({ owner, name, key }) {
    const who = String(owner || '').toLowerCase();
    if (!this.holdsFor(who)) return { ok: false, notHere: true, text: `${this.boxId} makes no machine of its own for you.` };
    if (!NAME_RE.test(String(name))) return { ok: false, notHere: true, text: 'That is not the name of a machine this fleet made.' };
    /** @type {any} */
    let said;
    try {
      said = await /** @type {MachineHub} */ (this.hub).machines();
    } catch (e) {
      return { ok: false, unreachable: true, text: `The hub on ${this.boxId} did not answer: ${line(/** @type {Error} */ (e)?.message) || 'no answer'}.` };
    }
    if (said?.ok !== true || !Array.isArray(said.machines)) return { ok: false, unreachable: true, text: line(said?.text) || `The hub on ${this.boxId} could not say what machines it has.` };
    const machine = said.machines.find((/** @type {any} */ m) => m?.name === name && String(m?.owner || '').toLowerCase() === who);
    if (!machine) return { ok: false, notHere: true, text: `${name} is not a machine of yours on ${this.boxId}.` };
    if (machine.state !== 'Running') return { ok: false, text: `${name} is ${String(machine.state || 'not running').toLowerCase()}, so it is handed nothing.` };
    const token = this.claude.get(who);
    if (!token) return { ok: false, notHere: true, text: `${this.boxId} made ${name} but has no Claude login of ${who}’s to hand it; another of their machines may.` };
    // ONCE A MACHINE, as a hypervisor's driver hands it (xo-pools.js): a
    // second ask under the same name is somebody replaying the first, and
    // the sign-in is not sealed to a second key.
    if (this.handed.has(name)) return { ok: false, text: `${name} was handed its login by this machine already, so this ask is handed nothing.` };
    if (this.handed.size >= 200) this.handed.delete(/** @type {string} */ (this.handed.values().next().value));
    this.handed.add(name);
    const sealed = await seal({ to: key, aad: await claudeBindingFor(key), payload: { token } });
    this.log.info(`sidecar: handed ${name} ${who}’s Claude login`);
    return { ok: true, text: `Handed ${name} your Claude login.`, sealed };
  }
}
