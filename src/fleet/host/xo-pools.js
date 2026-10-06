// The hypervisors this box can make machines on, for the people who approved
// it. docs/hypervisors.md, "Machines from your pool".
//
// WHERE THE TOKEN COMES FROM. Onboarding seals the limited user's token to
// the phone, which keeps it in the person's vault as `hypervisor:<address>`
// (src/fleet/minter/vault.js). The vault hands it, with everything else that
// person keeps, to every box they approved, on each sidecar pass. So the
// fleet holds the pool's key, a box that can reach the pool can use it, and
// none of the boxes is the only thing that can.
//
// IN MEMORY ONLY. Everything else the vault gives a box is written under the
// hub's state directory, because sessions read it there. Nothing on this box
// but this process ever needs a pool's token, so it is taken out of the
// bundle before the hub sees it, kept here, and gone when the process is. The
// next vault pass, within ten minutes of a restart, brings it back.
//
// WHAT IT DOES WITH IT, on each pass and when asked:
//   look    which pools the token reaches, and which Fleetwright machine
//           images (templates tagged `fleetwright-image`) each has, for the
//           health frame: that is how the coordinator knows this box can make
//           a machine, and how a phone is offered one.
//   sweep   machines that are done: stopped, or past the time they were made
//           to be gone by, are removed with their disks. A machine powers
//           itself off at its end, so stopped is the ordinary case.
//   make    a machine from an image, for the person whose pool it is, booted
//           with a ticket to enrol itself and a Claude login to run on.
//
// WHAT THE LIMITED USER MAY DO is what its resource set allows: clone images
// that are in the set onto storage and networks that are in the set, inside
// its limits. Xen Orchestra enforces that, which is the bound that holds when
// everything on our side has failed.

import { connectXo, connectXoPlain } from './xo-ws.js';
import { EDGE } from './edge-router.js';
import { VM_IMAGE } from './vm-image.js';

/** The prefix a pool's item carries in a vault answer. */
export const HYPERVISOR_ITEM = 'hypervisor:';
/** A Claude token's shape, as the vault keeps one. */
const CLAUDE_RE = /^[A-Za-z0-9._~+/=-]{20,2048}$/;
/** A dispatch ticket's shape (src/fleet/coordinator/runner-tickets.js). */
const TICKET_RE = /^fwt_([0-9a-f]{12})_[0-9a-f]{48}$/;
/** How long a machine lives when nobody said: the same default a runner has. */
const DEFAULT_MINUTES = 60;
/** How long past its end a machine may still be running before it is removed. */
const GRACE_MS = 15 * 60_000;

/**
 * @typedef {{ v?: number, address: string, pin: string|null, plain?: boolean, token: string, resourceSet?: string|null, user?: string }} PoolRecord
 * @typedef {{ id: string, name: string, pool: string|null, poolName: string|null }} Image
 * @typedef {{ address: string, owner: string, reachable: boolean|null, pools: Array<{ id: string, name: string }>, images: Image[], problem?: string }} Seen
 */

/**
 * A record as the vault handed it, or null for anything that is not one for
 * the address it was filed under.
 *
 * @param {string} name @param {unknown} value
 * @returns {PoolRecord|null}
 */
export function poolRecord(name, value) {
  if (!name.startsWith(HYPERVISOR_ITEM) || typeof value !== 'string') return null;
  /** @type {any} */
  let r;
  try {
    r = JSON.parse(value);
  } catch {
    return null;
  }
  const address = name.slice(HYPERVISOR_ITEM.length);
  if (!r || typeof r !== 'object' || r.address !== address || typeof r.token !== 'string' || !r.token) return null;
  const plain = r.plain === true;
  const pin = typeof r.pin === 'string' && /^[0-9a-f]{64}$/.test(r.pin) ? r.pin : null;
  // A pinned connection needs its pin; only a person's acceptance of plain
  // HTTP, recorded at setup, goes without one.
  if (!plain && !pin) return null;
  return { address, pin, plain, token: r.token, resourceSet: typeof r.resourceSet === 'string' ? r.resourceSet : null, user: typeof r.user === 'string' ? r.user : undefined };
}

export class XoPools {
  /**
   * @param {{
   *   connect?: typeof connectXo,
   *   connectPlain?: typeof connectXoPlain,
   *   now?: () => number,
   *   log?: { info: (m: string) => void, warn: (m: string) => void },
   * }} [opts]
   */
  constructor({ connect = connectXo, connectPlain = connectXoPlain, now = () => Date.now(), log } = {}) {
    this.connect = connect;
    this.connectPlain = connectPlain;
    this.now = now;
    this.log = log || { info() {}, warn() {} };
    /** @type {Map<string, { owner: string, record: PoolRecord }>} keyed `owner address` */
    this.held = new Map();
    /** @type {Map<string, string>} owner → their Claude token, for the machines made for them */
    this.claude = new Map();
    /** @type {Map<string, Seen>} what the last look found, keyed as `held` */
    this.seen = new Map();
  }

  /**
   * Take the pools out of a vault answer and keep them here; hand back the
   * answer without them, for the hub. Each person's Claude token is noted as
   * well (it stays in the answer: the hub's sessions read it there), so a
   * machine made for them can run on it.
   *
   * @param {Array<{ email: string, items?: Array<{ name: string, value?: string }> }>} accounts
   * @returns {any[]}
   */
  adopt(accounts) {
    /** @type {Map<string, { owner: string, record: PoolRecord }>} */
    const held = new Map();
    /** @type {Map<string, string>} */
    const claude = new Map();
    const stripped = (Array.isArray(accounts) ? accounts : []).map((a) => {
      const owner = String(a?.email || '').toLowerCase();
      const items = Array.isArray(a?.items) ? a.items : [];
      for (const i of items) {
        if (i?.name === 'claude' && typeof i.value === 'string' && CLAUDE_RE.test(i.value) && owner) claude.set(owner, i.value);
        const record = owner ? poolRecord(String(i?.name || ''), i?.value) : null;
        if (record) held.set(`${owner} ${record.address}`, { owner, record });
      }
      return { ...a, items: items.filter((i) => !String(i?.name || '').startsWith(HYPERVISOR_ITEM)) };
    });
    // FORGOTTEN IS GONE: a pool missing from this answer is no longer held,
    // and what was seen of it goes with it.
    for (const k of [...this.seen.keys()]) if (!held.has(k)) this.seen.delete(k);
    const added = [...held.keys()].filter((k) => !this.held.has(k));
    this.held = held;
    this.claude = claude;
    if (added.length) this.log.info(`sidecar: holding the token for ${added.map((k) => k.split(' ')[1]).join(', ')}`);
    return stripped;
  }

  /** For the health frame: what each held pool was last seen to have. Empty is "holds none". @returns {Seen[]} */
  report() {
    return [...this.held.keys()].map(
      (k) => this.seen.get(k) ?? { address: /** @type {any} */ (this.held.get(k)).record.address, owner: /** @type {any} */ (this.held.get(k)).owner, reachable: null, pools: [], images: [] },
    );
  }

  /** @param {PoolRecord} record */
  async #signIn(record) {
    const rpc = record.plain ? await this.connectPlain({ address: record.address }) : await this.connect({ address: record.address, pin: /** @type {string} */ (record.pin) });
    try {
      await rpc.call('session.signIn', { token: record.token });
    } catch (e) {
      rpc.close();
      throw e;
    }
    return rpc;
  }

  /**
   * Look at every held pool, and sweep what is done there. Never throws: a
   * pool that cannot be reached is reported as such.
   */
  async refresh() {
    for (const [k, { owner, record }] of this.held) {
      /** @type {any} */
      let rpc = null;
      try {
        rpc = await this.#signIn(record);
        const pools = /** @type {any[]} */ (Object.values((await rpc.call('xo.getAllObjects', { filter: { type: 'pool' } })) || {}));
        const names = new Map(pools.map((p) => [p.id, String(p.name_label || p.id).slice(0, 80)]));
        const templates = /** @type {any[]} */ (Object.values((await rpc.call('xo.getAllObjects', { filter: { type: 'VM-template' } })) || {}));
        const images = templates
          .filter((t) => t?.tags?.includes?.(VM_IMAGE.tag) && typeof t.id === 'string')
          .map((t) => ({ id: String(t.id), name: String(t.name_label || VM_IMAGE.name).slice(0, 80), pool: t.$pool ?? null, poolName: names.get(t.$pool) ?? null }));
        await this.#sweep(rpc);
        this.seen.set(k, { address: record.address, owner, reachable: true, pools: pools.map((p) => ({ id: String(p.id), name: names.get(p.id) || '' })), images });
      } catch (e) {
        this.seen.set(k, { address: record.address, owner, reachable: false, pools: [], images: [], problem: String(/** @type {Error} */ (e).message).slice(0, 200) });
      } finally {
        try {
          rpc?.close();
        } catch {
          /* closing */
        }
      }
    }
  }

  /**
   * Machines that are done, removed with their disks: stopped (a machine
   * powers itself off at its end), or still running well past the end it was
   * given. Only machines this fleet made, by their tag; nothing else on the
   * pool is touched.
   *
   * @param {any} rpc
   */
  async #sweep(rpc) {
    const vms = /** @type {any[]} */ (Object.values((await rpc.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {}));
    for (const vm of vms) {
      const tags = Array.isArray(vm?.tags) ? vm.tags : [];
      if (!tags.includes(VM_IMAGE.sessionTag)) continue;
      const until = Number(tags.find((/** @type {string} */ t) => t.startsWith(VM_IMAGE.untilPrefix))?.slice(VM_IMAGE.untilPrefix.length)) * 1000;
      const overdue = Number.isFinite(until) && this.now() > until + GRACE_MS;
      if (vm.power_state !== 'Halted' && !overdue) continue;
      try {
        if (vm.power_state !== 'Halted') await rpc.call('vm.stop', { id: vm.id, force: true });
        await rpc.call('vm.delete', { id: vm.id, deleteDisks: true });
        this.log.info(`sidecar: removed ${vm.name_label || vm.id}, which had ${overdue && vm.power_state !== 'Halted' ? 'run past its end' : 'stopped'}`);
      } catch (e) {
        this.log.warn(`sidecar: could not remove ${vm.name_label || vm.id}: ${/** @type {Error} */ (e).message}`);
      }
    }
  }

  /**
   * Make a machine from an image, for the person whose pool it is. Answers
   * the reply the coordinator relays: `unreachable` when the pool could not
   * be reached, which is the one refusal another box might not have.
   *
   * @param {{ owner: string, template: string, ticket: string, minutes?: number|null, coordinatorUrl: string }} ask
   * @returns {Promise<{ ok: boolean, text: string, unreachable?: boolean, vm?: string }>}
   */
  async make({ owner, template, ticket, minutes = null, coordinatorUrl }) {
    const who = String(owner || '').toLowerCase();
    const m = TICKET_RE.exec(String(ticket || ''));
    if (!m) return { ok: false, text: 'That machine came without the ticket it enrols with, so it was not made.' };
    const name = `vm-${m[1]}`;
    // THE PERSON'S OWN POOL. The image must be one this box saw under a
    // token that person kept; the coordinator chose this box by the same
    // report, and is the party this project assumes may be lying.
    const found = [...this.held.entries()].find(([k, h]) => h.owner === who && this.seen.get(k)?.images.some((i) => i.id === template));
    if (!found) return { ok: false, text: 'This box holds no pool of yours with that machine image.' };
    const [k, { record }] = found;
    const image = /** @type {Image} */ (this.seen.get(k)?.images.find((i) => i.id === template));
    const life = Math.max(5, Math.min(350, Number(minutes) || DEFAULT_MINUTES));
    const until = Math.floor((this.now() + life * 60_000) / 1000);
    const claude = this.claude.get(who) ?? null;
    /** @type {any} */
    let rpc = null;
    try {
      try {
        rpc = await this.#signIn(record);
      } catch (e) {
        return { ok: false, unreachable: true, text: `${record.address} could not be reached from here: ${/** @type {Error} */ (e).message}` };
      }
      // THE UPLINK, behind the edge router, where the image was built: a
      // machine reaches the internet and nothing private. Named explicitly so
      // the clone gets an interface of its own rather than a copy.
      const networks = /** @type {any[]} */ (Object.values((await rpc.call('xo.getAllObjects', { filter: { type: 'network' } })) || {}));
      const uplink = networks.find((n) => n?.name_label === EDGE.uplink && (!image.pool || n.$pool === image.pool));
      const vm = await rpc.call('vm.create', {
        template,
        name_label: name,
        name_description: `A temporary machine for ${who}, made by Fleetwright. It powers off by itself at its end and is then removed.`,
        ...(record.resourceSet ? { resourceSet: record.resourceSet } : {}),
        ...(uplink ? { VIFs: [{ network: uplink.id }] } : {}),
        tags: [VM_IMAGE.sessionTag, `${VM_IMAGE.untilPrefix}${until}`],
        cloudConfig: machineCloudConfig({ name, coordinatorUrl, ticket, owner: who, claude, minutes: life }),
        // The drive holds the ticket and the Claude login: gone once the
        // machine has booted, and wiped from inside before that (the join
        // script), whichever comes first.
        destroyCloudConfigVdiAfterBoot: true,
        bootAfterCreate: true,
      });
      this.log.info(`sidecar: made ${name} from ${image.name} on ${record.address} for ${who}`);
      return {
        ok: true,
        vm: String(vm),
        text:
          `Making ${name} from ${image.name}${image.poolName ? ` on ${image.poolName}` : ''}. It joins the fleet as your temporary machine ` +
          `in a minute or two, for ${life} minutes${claude ? '' : ', and has no Claude login of yours to run on: keep one in your vault'}.`,
      };
    } catch (e) {
      // FROM THE POOL ITSELF: no room in the limits, an image taken out of
      // the set. Another box would be told the same.
      return { ok: false, text: `${record.address} would not make the machine: ${/** @type {Error} */ (e).message}` };
    } finally {
      try {
        rpc?.close();
      } catch {
        /* closing */
      }
    }
  }
}

/**
 * The cloud-init a machine boots with: one file the join script reads, and
 * the join script, which enrols the machine with the ticket, hands its
 * owner's Claude login to the hub, starts the services, and powers the
 * machine off at its end. See install/fleetwright-vm-join.
 *
 * @param {{ name: string, coordinatorUrl: string, ticket: string, owner: string, claude: string|null, minutes: number }} opts
 */
export function machineCloudConfig({ name, coordinatorUrl, ticket, owner, claude, minutes }) {
  const join = JSON.stringify({ v: 1, coordinator: new URL(coordinatorUrl).origin, ticket, owner, claude, minutes });
  return [
    '#cloud-config',
    `hostname: ${name}`,
    'write_files:',
    '  - path: /run/fleetwright/join.json',
    "    permissions: '0600'",
    '    owner: root:root',
    '    content: |',
    `      ${join}`,
    'runcmd:',
    '  - [/opt/fleetwright/current/install/fleetwright-vm-join, /run/fleetwright/join.json]',
    '',
  ].join('\n');
}
