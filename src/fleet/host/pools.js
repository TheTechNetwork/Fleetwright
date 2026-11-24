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

//
// AND A THIRD DRIVER, for machines on a sandbox provider's cloud
// (sandbox-pools.js, docs/api-engines.md). It answers the same verbs. It has
// no page, no network and no edge router of its own, so `look`, `act`,
// `edges` and the console never go to it. A box whose operator named no
// provider holds an empty one.

import { XoPools } from './xo-pools.js';
import { PvePools } from './pve-pools.js';
import { SandboxPools, SANDBOX_KIND } from './sandbox-pools.js';

export class Pools {
  /** @param {{ xo?: XoPools, pve?: PvePools, sandbox?: SandboxPools }} [drivers] */
  constructor({ xo = new XoPools({}), pve = new PvePools({}), sandbox = new SandboxPools({}) } = {}) {
    this.xo = xo;
    this.pve = pve;
    this.sandbox = sandbox;
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
    // A sandbox provider's key is not among them: `held` is read for pools
    // and clusters with an address to dial (edge-watch.js, the console), and
    // a provider has neither. `kindOf` and `report` are where it shows.
    return all;
  }

  /**
   * Whether this box holds anything a machine can be made from: a pool, a
   * cluster, or a sandbox provider's key. What the sidecar asks before it
   * looks or reports, so a box holding only a provider still does both.
   */
  get holdsAny() {
    return this.xo.held.size > 0 || this.pve.held.size > 0 || this.sandbox.held.size > 0;
  }

  /**
   * What each pool and cluster was last seen as, for edge-watch.js, which
   * reads whether this box reached it (`reachable`).
   */
  get seen() {
    /** @type {Map<string, any>} */
    const all = new Map();
    for (const [k, v] of this.xo.seen) all.set(k, v);
    for (const [k, v] of this.pve.seen) all.set(k, v);
    return all;
  }

  /**
   * Which kind a held key is, for words that name it: `proxmox` for a
   * Proxmox VE cluster's, `xo` for anything else.
   * @param {string} key
   */
  kindOf(key) {
    if (this.sandbox.held.has(key)) return SANDBOX_KIND;
    return this.pve.held.has(key) ? 'proxmox' : 'xo';
  }

  /** @param {any[]} accounts */
  adopt(accounts) {
    // The sandbox driver first, which takes every `sandbox:` item out: a
    // provider's key is its whole account, and the hub files what it is
    // handed. Then Proxmox, which keeps its records and strips nothing; then
    // Xen Orchestra's, which strips every `hypervisor:` item before the hub.
    return this.xo.adopt(this.pve.adopt(this.sandbox.adopt(accounts)));
  }

  report() {
    return [...this.xo.report(), ...this.pve.report(), ...this.sandbox.report()];
  }

  async refresh() {
    await Promise.all([this.xo.refresh(), this.pve.refresh(), this.sandbox.refresh()]);
  }

  /** @param {Parameters<XoPools['make']>[0]} ask */
  make(ask) {
    if (this.sandbox.hasImage(ask.owner, ask.template)) return this.sandbox.make(ask);
    return this.pve.hasImage(ask.owner, ask.template) ? this.pve.make(ask) : this.xo.make(ask);
  }

  /**
   * The hypervisors' answer, unless they could not say the machine is
   * theirs and this box holds a sandbox provider of the person's too. A
   * hypervisor that could not be reached has not said whose the machine is,
   * so the provider is still asked: a sandbox must be endable while a pool
   * is down. `unreachable` from a hypervisor is kept over the provider's
   * "not there", for the reason it is between the two hypervisors.
   *
   * @template {{ ok: boolean, notHere?: boolean, unreachable?: boolean }} R
   * @param {string} owner @param {() => Promise<R>} hypervisors @param {() => Promise<R>} sandbox
   * @returns {Promise<R>}
   */
  async #orSandbox(owner, hypervisors, sandbox) {
    if (!this.sandbox.holdsFor(owner)) return hypervisors();
    const a = await hypervisors();
    if (a.ok || !(a.notHere || a.unreachable)) return a;
    const b = await sandbox();
    return b.ok || !b.notHere || !a.unreachable ? b : a;
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
    return this.#orSandbox(ask.owner, () => this.#either(ask.owner, () => this.xo.handLogin(ask), () => this.pve.handLogin(ask)), () => /** @type {any} */ (this.sandbox.handLogin(ask)));
  }

  /** @param {Parameters<XoPools['control']>[0]} ask */
  control(ask) {
    return this.#orSandbox(ask.owner, () => this.#either(ask.owner, () => this.xo.control(ask), () => this.pve.control(ask)), () => /** @type {any} */ (this.sandbox.control(ask)));
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

  /** Where a pool's or a cluster's edge routers are, by its own hypervisor. @param {string} key */
  edgeAddresses(key) {
    return this.pve.held.has(key) ? this.pve.edgeAddresses(key) : this.xo.edgeAddresses(key);
  }
}
