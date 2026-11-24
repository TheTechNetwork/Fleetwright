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
//
// AND A FOURTH, for machines on this box itself (own-pools.js): a container
// the box's hub runs, with nothing held at all. It is asked FIRST for a
// machine by name, because it is the one driver that can say at once and
// for certain whether a machine is its own: the hub is on this box, and a
// hypervisor that is down would otherwise be waited out before a machine
// here could be ended. Off unless the operator named `own`.

import { XoPools } from './xo-pools.js';
import { PvePools } from './pve-pools.js';
import { SandboxPools, SANDBOX_KIND } from './sandbox-pools.js';
import { OwnPools } from './own-pools.js';

export class Pools {
  /** @param {{ xo?: XoPools, pve?: PvePools, sandbox?: SandboxPools, own?: OwnPools }} [drivers] */
  constructor({ xo = new XoPools({}), pve = new PvePools({}), sandbox = new SandboxPools({}), own = new OwnPools({}) } = {}) {
    this.xo = xo;
    this.pve = pve;
    this.sandbox = sandbox;
    this.own = own;
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
    return this.xo.held.size > 0 || this.pve.held.size > 0 || this.sandbox.held.size > 0 || this.own.held.size > 0;
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
    if (this.sandbox.held.has(key) || this.own.held.has(key)) return SANDBOX_KIND;
    return this.pve.held.has(key) ? 'proxmox' : 'xo';
  }

  /** @param {any[]} accounts */
  adopt(accounts) {
    // The sandbox driver first, which takes every `sandbox:` item out: a
    // provider's key is its whole account, and the hub files what it is
    // handed. Then Proxmox, which keeps its records and strips nothing; then
    // Xen Orchestra's, which strips every `hypervisor:` item before the hub.
    // This box's own driver takes nothing out: it notes who the box is
    // approved for, which is everybody in the answer.
    return this.xo.adopt(this.pve.adopt(this.sandbox.adopt(this.own.adopt(accounts))));
  }

  report() {
    return [...this.xo.report(), ...this.pve.report(), ...this.sandbox.report(), ...this.own.report()];
  }

  async refresh() {
    await Promise.all([this.xo.refresh(), this.pve.refresh(), this.sandbox.refresh(), this.own.refresh()]);
  }

  /** @param {Parameters<XoPools['make']>[0]} ask */
  make(ask) {
    if (this.own.hasImage(ask.owner, ask.template)) return this.own.make(ask);
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

  /**
   * This box's own answer, unless it says the machine is not one of its
   * containers (or its hub could not be asked) and there is anything else
   * to ask. If nothing else has the machine either, a hub that could not be
   * asked is the answer kept: "not there" from the rest does not make it so.
   *
   * @template {{ ok: boolean, notHere?: boolean, unreachable?: boolean }} R
   * @param {string} owner @param {() => Promise<R>} own @param {() => Promise<R>} rest
   * @returns {Promise<R>}
   */
  async #ownFirst(owner, own, rest) {
    if (!this.own.holdsFor(owner)) return rest();
    const a = await own();
    if (a.ok || !(a.notHere || a.unreachable)) return a;
    const who = String(owner || '').toLowerCase();
    const more = this.sandbox.holdsFor(who) || this.pve.holdsFor(who) || [...this.xo.held.values()].some((h) => h.owner === who);
    if (!more) return a;
    const b = await rest();
    return b.ok || !b.notHere || !a.unreachable ? b : a;
  }

  /** @param {Parameters<XoPools['handLogin']>[0]} ask */
  handLogin(ask) {
    return this.#ownFirst(
      ask.owner,
      () => /** @type {any} */ (this.own.handLogin(ask)),
      () => this.#orSandbox(ask.owner, () => this.#either(ask.owner, () => this.xo.handLogin(ask), () => this.pve.handLogin(ask)), () => /** @type {any} */ (this.sandbox.handLogin(ask))),
    );
  }

  /** @param {Parameters<XoPools['control']>[0]} ask */
  control(ask) {
    return this.#ownFirst(
      ask.owner,
      () => /** @type {any} */ (this.own.control(ask)),
      () => this.#orSandbox(ask.owner, () => this.#either(ask.owner, () => this.xo.control(ask), () => this.pve.control(ask)), () => /** @type {any} */ (this.sandbox.control(ask))),
    );
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
