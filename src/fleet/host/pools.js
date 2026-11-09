// Every hypervisor this box holds a token for, behind one face: Xen
// Orchestra's pools (xo-pools.js) and Proxmox's clusters (pve-pools.js).
// docs/proxmox.md, "One seam".
//
// THE SIDECAR SEES ONE THING, and that is how a second hypervisor became a
// second driver and not a second design (docs/hypervisors.md, "The
// interface"). Each verb goes to the driver that has what it names:
//
//   make        the one that saw the image. Image ids are UUIDs on both
//               (pve-pools.js, pveIdOf), so the coordinator never knows which.
//   handLogin,  the one holding the person's pools and clusters, Xen
//   control     Orchestra's first and Proxmox's when it answers `notHere`,
//               which is the same answer that makes the coordinator ask the
//               next box. `unreachable` from either is kept, so a cluster
//               that did not answer is never reported as "not there".
//   look, act,  Xen Orchestra's alone: the pool page reads Xen Orchestra's
//   edges       own objects. A cluster's page is the Proxmox health entry,
//               which already carries what it shows.

import { XoPools } from './xo-pools.js';
import { PvePools } from './pve-pools.js';

export class Pools {
  /** @param {{ xo?: XoPools, pve?: PvePools }} [drivers] */
  constructor({ xo = new XoPools({}), pve = new PvePools({}) } = {}) {
    this.xo = xo;
    this.pve = pve;
  }

  /**
   * Every token held, Xen Orchestra's and Proxmox's, keyed `owner address`,
   * or `owner address box` for one box's own Xen Orchestra user.
   * @returns {Map<string, { owner: string, record: import('./xo-pools.js').PoolRecord|import('./pve-pools.js').PveRecord }>}
   */
  get held() {
    /** @type {Map<string, { owner: string, record: import('./xo-pools.js').PoolRecord|import('./pve-pools.js').PveRecord }>} */
    const all = new Map();
    for (const [k, v] of this.xo.held) all.set(k, v);
    for (const [k, v] of this.pve.held) all.set(k, v);
    return all;
  }

  /** What each Xen Orchestra pool was last seen as, for edge-watch.js. */
  get seen() {
    return this.xo.seen;
  }

  /** @param {any[]} accounts */
  adopt(accounts) {
    // Proxmox first, which keeps its records and strips nothing; then Xen
    // Orchestra's, which strips every `hypervisor:` item before the hub.
    return this.xo.adopt(this.pve.adopt(accounts));
  }

  report() {
    return [...this.xo.report(), ...this.pve.report()];
  }

  async refresh() {
    await Promise.all([this.xo.refresh(), this.pve.refresh()]);
  }

  /** @param {Parameters<XoPools['make']>[0]} ask */
  make(ask) {
    return this.pve.hasImage(ask.owner, ask.template) ? this.pve.make(ask) : this.xo.make(ask);
  }

  /**
   * Xen Orchestra's answer, unless it says the machine is not there and this
   * box holds a cluster of the person's too.
   *
   * @template {{ ok: boolean, notHere?: boolean, unreachable?: boolean }} R
   * @param {string} owner @param {() => Promise<R>} xo @param {() => Promise<R>} pve
   * @returns {Promise<R>}
   */
  async #either(owner, xo, pve) {
    if (!this.pve.holdsFor(owner)) return xo();
    const holdsXo = [...this.xo.held.values()].some((h) => h.owner === String(owner || '').toLowerCase());
    if (!holdsXo) return pve();
    const a = await xo();
    if (a.ok || !a.notHere) return a;
    const b = await pve();
    // NEITHER HAS IT: unreachable from either wins over "not there".
    return b.ok || b.unreachable || !a.unreachable ? b : a;
  }

  /** @param {Parameters<XoPools['handLogin']>[0]} ask */
  handLogin(ask) {
    return this.#either(ask.owner, () => this.xo.handLogin(ask), () => this.pve.handLogin(ask));
  }

  /** @param {Parameters<XoPools['control']>[0]} ask */
  control(ask) {
    return this.#either(ask.owner, () => this.xo.control(ask), () => this.pve.control(ask));
  }

  /**
   * Where a tunnel from away dials: the pool or cluster at `address`, or,
   * naming `machine`, that machine's SSH (sshAddress), and only for this
   * person's.
   *
   * @param {string} owner @param {string} address @param {string|null} [machine]
   */
  consoleAddress(owner, address, machine = null) {
    if (machine) return this.xo.sshAddress(owner, address, machine) ?? this.pve.sshAddress(owner, address, machine);
    return this.xo.consoleAddress(owner, address) ?? this.pve.consoleAddress(owner, address);
  }

  /** @param {Parameters<XoPools['look']>[0]} ask */
  look(ask) {
    return this.xo.look(ask);
  }

  /** @param {Parameters<XoPools['act']>[0]} ask */
  act(ask) {
    return this.xo.act(ask);
  }

  /** @param {string} key */
  edgeAddresses(key) {
    return this.xo.edgeAddresses(key);
  }
}
