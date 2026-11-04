// The Proxmox VE clusters this box can make machines on, for the people who
// approved it. docs/proxmox.md.
//
// THE SAME CONTRACT AS XEN ORCHESTRA'S (xo-pools.js), so the rest of the fleet
// cannot tell them apart: the token comes from the person's vault and is held
// in this process's memory only; `refresh` looks and sweeps; `report` is the
// health frame's `xo[]` entry; `make`, `handLogin` and `control` are the same
// three verbs with the same answers, `notHere` and `unreachable` included, so
// the coordinator asks the next box exactly as it does for a pool. A pool and
// a cluster sit side by side in `pools.js`.
//
// WHAT IS DIFFERENT, and why each difference is the point (docs/proxmox.md,
// "What XCP-ng taught"):
//
//   NO ADMIN CREDENTIAL EVER CROSSES THE FLEET. The user, its role, the pool,
//   the token and the machine image are made by a script run as root on the
//   node (install/fleetwright-pve-setup), which prints one line the phone
//   keeps. Xen Orchestra's setup took the admin password, sealed, to a box;
//   and its policy, reconnect and remake took it again each time.
//
//   THE BOUND IS PROXMOX'S OWN AND IT IS CHECKED, NOT ASSUMED. The token's
//   privileges are what Proxmox's ACLs grant, and every look reads them back
//   (`/access/permissions`) and reports any that is wider than the fleet
//   needs (`wide`), by path and privilege. Xen Orchestra's resource set was
//   measured to leak in several ways (docs/hypervisors.md, "What Xen
//   Orchestra lets whom do"); here a leak is something the box can see.
//
//   WHAT THE FLEET MAY USE IS WHAT PROXMOX LETS THE TOKEN USE. Storage it may
//   allocate on, bridges it may use (SDN.Use), templates in its pool. There is
//   no policy form in the app to keep in step with it: change it in Proxmox,
//   or run the script again, and the next look says so.
//
//   THE FENCE IS OUTSIDE THE GUEST. A machine is held to "the internet and
//   nothing private" by Proxmox's firewall, a cluster security group the
//   script made (`fleetwright-isolate`), on the bridge, where nothing inside
//   the VM can reach it. Xen Orchestra's machines fenced themselves with
//   nftables from inside, which root in the guest can undo. And when the
//   datacenter's firewall is off, the look says so (`fenced: false`): the
//   group exists and holds nothing, and a page that said "isolated" then
//   would be a claim with nothing behind it (C-5).
//
//   ONE MARK, NOT A DOZEN TAGS. What a machine is, whose, and until when, is
//   one JSON line in its notes (`MARK`), beside one tag that lets a person
//   find the fleet's machines in Proxmox's own tree.
//
// WHAT IS THE SAME, and has to be: anybody holding the token may write a
// machine's notes, as anybody holding Xen Orchestra's may tag. So the mark is
// believed only of a machine in the fleet's pool, named as the fleet names
// them, and the Claude login is handed only to one that is running, the same
// checks xo-pools.js makes. The ticket a machine joins with travels in its
// SMBIOS serial (`smbios1`), readable by the token's holders until the
// machine is gone, as Xen Orchestra's cloud-init drive was until it was
// destroyed; single use, fifteen minutes, and refused and said when spent
// twice (docs/hypervisors.md, "How a clone joins").

import { createHash } from 'node:crypto';
import { PveApi } from './pve-api.js';
import { seal, claudeBindingFor } from '../seal.js';
import { machineGrantsOf } from '../../core/grants.js';
import { HYPERVISOR_ITEM, MAX_MINUTES, SSH_KEYS_ITEM, sshKeys } from './xo-pools.js';
import { JOIN_RUNCMD } from './vm-image.js';

/** What a Proxmox record says it is, beside Xen Orchestra's, which says nothing. */
export const PVE_KIND = 'proxmox';
/** The tag on a Fleetwright machine image, and on a machine made from one. */
export const PVE_IMAGE_TAG = 'fleetwright-image';
export const PVE_SESSION_TAG = 'fleetwright-session';
/** The cluster security group the setup script makes and every machine is put behind. */
export const PVE_FENCE_GROUP = 'fleetwright-isolate';
/** The line in a machine's notes that says what it is. */
export const MARK = 'fleetwright:';
/** The line a setup script prints, and the phone keeps. */
export const CONNECTION_PREFIX = 'fleetwright-pve:1:';

/**
 * EVERY PRIVILEGE THE FLEET NEEDS, and where. Anything a look finds beyond
 * these is reported as `wide`. Kept beside the script's own list, which
 * test/pve-pools.test.js holds to this one.
 */
export const PVE_ROLE_PRIVS = Object.freeze([
  'VM.Allocate', 'VM.Clone', 'VM.Audit', 'VM.PowerMgmt',
  'VM.Config.CPU', 'VM.Config.Memory', 'VM.Config.Network', 'VM.Config.Options', 'VM.Config.HWType', 'VM.Config.Cloudinit',
  'Pool.Audit',
]);
export const PVE_STORAGE_PRIVS = Object.freeze(['Datastore.AllocateSpace', 'Datastore.Audit']);
export const PVE_NET_PRIVS = Object.freeze(['SDN.Use', 'SDN.Audit']);
/** On `/` alone, not propagated: reading whether the datacenter's firewall is on. */
export const PVE_ROOT_PRIVS = Object.freeze(['Sys.Audit']);

const CLAUDE_RE = /^[A-Za-z0-9._~+/=-]{20,2048}$/;
const TICKET_RE = /^fwt_([0-9a-f]{12})_[0-9a-f]{48}$/;
const NAME_RE = /^vm-[0-9a-f]{12}$/;
const DEFAULT_MINUTES = 60;
const BACKSTOP_MINUTES = MAX_MINUTES + 30;
const GRACE_MS = 60_000;
const YOUNG_MS = 5 * 60_000;
const BUSY_MS = 30 * 60_000;
const MADE_FORGET_MS = 24 * 60 * 60_000;
const MAX_MADE = 64;
const HANDED_REMEMBERED = 1000;
/** Proxmox keeps `smbios1` under 512 characters; the join must fit with the VM's own uuid. */
const SMBIOS_MAX = 500;
/** How many machines a look reads the notes of: a pool is a fleet's, not a datacenter's. */
const MAX_MACHINES = 200;

/**
 * @typedef {{ address: string, token: string, pool: string, ca: string|null, pin: string|null, trust: 'ca'|'pin'|'public', grants?: any }} PveRecord
 * @typedef {{ id: string, name: string, node: string, vmid: number, pool: string|null, poolName: string|null, bridge: string|null }} PveImage
 * @typedef {{ id: string, name: string, pool: string|null, group: boolean, zone: string }} PveNetwork
 */

const TOKEN_RE = /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9._-]{1,64}![A-Za-z0-9._-]{1,64}=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POOL_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PEM_RE = /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]{100,8000}\n-----END CERTIFICATE-----\n?$/;

/**
 * A Proxmox record as the vault handed it, or null for anything that is not
 * one for the address it was filed under. Xen Orchestra's records carry no
 * `kind`, and xo-pools.js passes over any that says `proxmox`.
 *
 * @param {string} name @param {unknown} value @returns {PveRecord|null}
 */
export function pveRecord(name, value) {
  if (!name.startsWith(HYPERVISOR_ITEM) || typeof value !== 'string') return null;
  /** @type {any} */
  let r;
  try {
    r = JSON.parse(value);
  } catch {
    return null;
  }
  return recordOf(r, name.slice(HYPERVISOR_ITEM.length));
}

/** @param {any} r @param {string|null} address  null takes the record's own @returns {PveRecord|null} */
function recordOf(r, address) {
  if (!r || typeof r !== 'object' || r.kind !== PVE_KIND) return null;
  if (typeof r.address !== 'string' || (address !== null && r.address !== address)) return null;
  if (typeof r.token !== 'string' || !TOKEN_RE.test(r.token)) return null;
  if (typeof r.pool !== 'string' || !POOL_RE.test(r.pool)) return null;
  const ca = typeof r.ca === 'string' && PEM_RE.test(r.ca) ? r.ca : null;
  const pin = typeof r.pin === 'string' && /^[0-9a-f]{64}$/.test(r.pin) ? r.pin : null;
  // A RECORD SAYS HOW TO TRUST THE SERVER, and one that cannot is no record:
  // there is no plain HTTP here, because Proxmox has none.
  /** @type {'ca'|'pin'|'public'|null} */
  const trust = ca ? 'ca' : pin ? 'pin' : r.trust === 'public' ? 'public' : null;
  if (!trust) return null;
  const grants = machineGrantsOf(r.grants);
  return { address: r.address, token: r.token, pool: r.pool, ca, pin, trust, ...(grants ? { grants } : {}) };
}

/**
 * The line the setup script prints, as the record it carries. What the phone
 * does with a pasted line, and the one place its shape is defined; the app
 * keeps the record as `hypervisor:<address>`.
 *
 * @param {string} line @returns {PveRecord|null}
 */
export function parseConnection(line) {
  const s = String(line || '').trim();
  if (!s.startsWith(CONNECTION_PREFIX)) return null;
  try {
    return recordOf(JSON.parse(Buffer.from(s.slice(CONNECTION_PREFIX.length), 'base64url').toString('utf8')), null);
  } catch {
    return null;
  }
}

/**
 * AN ID IN THE SHAPE THE PROTOCOL TAKES, for a thing Proxmox numbers.
 * `provision` names an image and a network by a UUID (intents.js,
 * XO_UUID_RE), and Proxmox numbers its VMs and names its bridges, so this box
 * gives each a UUID of its own, from the address, what it is, and what makes
 * it that one: a template's number and when it was made (`meta: ctime`), so
 * one made again under the same number is another image; a bridge's zone and
 * name. The coordinator never turns one back into a number; only a box that
 * saw it does, by looking it up in what it saw (`make`).
 *
 * @param {string} address @param {string} kind @param {string} key
 */
export function pveIdOf(address, kind, key) {
  const h = createHash('sha256').update(`pve\0${address}\0${kind}\0${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The mark in a machine's notes, or null. Only the first line that starts
 * with MARK is read, and only its known fields are kept.
 *
 * @param {unknown} description
 * @returns {{ for: string, until: number, made: number, from: string|null, on: string|null, busy: number|null }|null}
 */
export function markOf(description) {
  const line = String(description || '').split('\n').find((l) => l.startsWith(MARK));
  if (!line) return null;
  /** @type {any} */
  let m;
  try {
    m = JSON.parse(line.slice(MARK.length));
  } catch {
    return null;
  }
  if (!m || m.v !== 1 || typeof m.for !== 'string' || !Number.isFinite(m.until) || !Number.isFinite(m.made)) return null;
  return {
    for: m.for.toLowerCase(),
    until: Number(m.until),
    made: Number(m.made),
    from: typeof m.from === 'string' ? m.from : null,
    on: typeof m.on === 'string' ? m.on : null,
    busy: Number.isFinite(m.busy) ? Number(m.busy) : null,
  };
}

/** @param {{ for: string, until: number, made: number, from?: string|null, on?: string|null, busy?: number|null }} m */
export function markText(m) {
  const line = JSON.stringify({ v: 1, for: m.for, until: m.until, made: m.made, ...(m.from ? { from: m.from } : {}), ...(m.on ? { on: m.on } : {}), ...(m.busy ? { busy: m.busy } : {}) });
  return `A temporary machine for ${m.for}, made by Fleetwright. It powers off by itself at its end and is then removed.\n${MARK}${line}`;
}

/** Proxmox's tags, which it keeps as one string split on `;` (and `,` and spaces on older versions). */
const tagsOf = (/** @type {any} */ v) => String(v?.tags || '').split(/[;,\s]+/).filter(Boolean);

/**
 * WHAT THE TOKEN MAY DO BEYOND WHAT THE FLEET NEEDS, from Proxmox's own
 * answer to `/access/permissions`: each path, and each privilege there that
 * no part of the setup grants for it. Empty is exactly as designed.
 *
 * @param {Record<string, Record<string, number>>} perms @param {string} pool
 * @returns {Array<{ path: string, privs: string[] }>}
 */
export function wideOf(perms, pool) {
  /** @type {Array<{ path: string, privs: string[] }>} */
  const wide = [];
  for (const [path, privs] of Object.entries(perms || {})) {
    const have = Object.keys(privs || {}).filter((p) => privs[p]);
    const allowed = new Set(
      path === `/pool/${pool}` || path.startsWith('/vms/')
        ? PVE_ROLE_PRIVS
        : path.startsWith('/storage/')
          ? PVE_STORAGE_PRIVS
          : path.startsWith('/sdn/')
            ? PVE_NET_PRIVS
            : path === '/'
              ? PVE_ROOT_PRIVS
              : [],
    );
    const extra = have.filter((p) => !allowed.has(p));
    if (extra.length) wide.push({ path, privs: extra.sort() });
  }
  return wide.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The networks the token may put a machine on: every bridge or VNet Proxmox
 * grants it SDN.Use on, by zone. A Proxmox older than 8 has no such path, and
 * then a machine goes on its image's own bridge, and nothing else is offered.
 *
 * @param {Record<string, Record<string, number>>} perms @param {string} address
 * @returns {PveNetwork[]}
 */
export function networksOf(perms, address) {
  /** @type {PveNetwork[]} */
  const out = [];
  for (const [path, privs] of Object.entries(perms || {})) {
    const m = /^\/sdn\/zones\/([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9_.-]{1,40})$/.exec(path);
    if (!m || !privs?.['SDN.Use']) continue;
    out.push({ id: pveIdOf(address, 'net', `${m[1]}/${m[2]}`), name: m[2], pool: null, group: false, zone: m[1] });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The bridge a VM's first interface is on, from its `net0`.
 * @param {unknown} net0
 */
export const bridgeOf = (net0) => /(?:^|,)bridge=([A-Za-z0-9_.-]{1,40})(?:,|$)/.exec(String(net0 || ''))?.[1] ?? null;

/**
 * `net0` moved to another bridge, everything else about the interface (its
 * model and address, its MAC as the clone was given) kept, and the firewall
 * on, because that is where the fence is.
 *
 * @param {unknown} net0 @param {string|null} bridge
 */
export function net0On(net0, bridge) {
  // NO BRIDGE CHOSEN IS THE IMAGE'S OWN, kept: an interface with none is
  // connected to nothing, and Proxmox starts it that way without a word.
  const on = bridge ?? bridgeOf(net0);
  const parts = String(net0 || 'virtio').split(',').filter((p) => p && !/^(bridge|firewall)=/.test(p));
  return [...parts, ...(on ? [`bridge=${on}`] : []), 'firewall=1'].join(',');
}

/**
 * The SMBIOS a clone boots with: its own uuid kept (the clone was given one,
 * and an `smbios1` set without it would take it away), and the join in its
 * serial, which a machine made from the image reads as root on its first
 * boot (install/fleetwright-pve-setup, the vendor snippet).
 *
 * @param {unknown} current  the clone's `smbios1` @param {object} join
 */
export function smbiosWith(current, join) {
  const uuid = /(?:^|,)uuid=([0-9a-fA-F-]{36})(?:,|$)/.exec(String(current || ''))?.[1];
  const serial = Buffer.from(JSON.stringify(join), 'utf8').toString('base64');
  return [...(uuid ? [`uuid=${uuid}`] : []), 'base64=1', `serial=${serial}`].join(',');
}

export class PvePools {
  /**
   * @param {{
   *   api?: (opts: { address: string, token: string, trust: { ca?: string|null, pin?: string|null, trust?: 'ca'|'pin'|'public' } }) => any,
   *   now?: () => number,
   *   log?: { info: (m: string) => void, warn: (m: string) => void },
   *   sleep?: (ms: number) => Promise<void>,
   * }} [opts]
   */
  constructor({ api = (o) => new PveApi(o), now = () => Date.now(), log, sleep } = {}) {
    this.api = api;
    this.now = now;
    this.sleep = sleep;
    this.log = log || { info() {}, warn() {} };
    /** @type {Map<string, { owner: string, record: PveRecord }>} keyed `owner address` */
    this.held = new Map();
    /** @type {Map<string, string>} */
    this.claude = new Map();
    /** @type {Map<string, string[]>} */
    this.ssh = new Map();
    /** @type {Map<string, any>} what the last look found, keyed as `held` */
    this.seen = new Map();
    /** @type {Map<string, { vmid: number, node: string, owner: string, at: number }>} by name, as xo-pools.js keeps `made` */
    this.made = new Map();
    /** @type {Set<string>} */
    this.handed = new Set();
    /** @type {Set<string>} */
    this.handing = new Set();
  }

  /** @param {PveRecord} record */
  #client(record) {
    return this.api({ address: record.address, token: record.token, trust: { ca: record.ca, pin: record.pin, trust: record.trust } });
  }

  /**
   * Keep the Proxmox records in a vault answer. The answer itself is passed
   * back unchanged: xo-pools.js, which runs after this (pools.js), takes every
   * `hypervisor:` item out of it before the hub sees it.
   *
   * @param {Array<{ email: string, items?: Array<{ name: string, value?: string }> }>} accounts
   */
  adopt(accounts) {
    /** @type {Map<string, { owner: string, record: PveRecord }>} */
    const held = new Map();
    /** @type {Map<string, string>} */
    const claude = new Map();
    /** @type {Map<string, string[]>} */
    const ssh = new Map();
    for (const a of Array.isArray(accounts) ? accounts : []) {
      const owner = String(a?.email || '').toLowerCase();
      if (!owner) continue;
      for (const i of Array.isArray(a?.items) ? a.items : []) {
        if (i?.name === 'claude' && typeof i.value === 'string' && CLAUDE_RE.test(i.value)) claude.set(owner, i.value);
        if (i?.name === SSH_KEYS_ITEM) ssh.set(owner, sshKeys(i.value));
        const record = pveRecord(String(i?.name || ''), i?.value);
        if (record) held.set(`${owner} ${record.address}`, { owner, record });
      }
    }
    for (const k of [...this.seen.keys()]) if (!held.has(k)) this.seen.delete(k);
    const added = [...held.keys()].filter((k) => !this.held.has(k));
    this.held = held;
    this.claude = claude;
    this.ssh = ssh;
    if (added.length) this.log.info(`sidecar: holding the Proxmox token for ${added.map((k) => k.split(' ')[1]).join(', ')}`);
    return accounts;
  }

  /** For the health frame, in the shape xo-pools.js reports, with `kind`. */
  report() {
    return [...this.held.entries()].map(([k, h]) => this.seen.get(k) ?? { address: h.record.address, owner: h.owner, kind: PVE_KIND, reachable: null, pools: [], images: [], networks: [], machines: [] });
  }

  /** Whether this box saw the image on a cluster of this person's. @param {string} owner @param {string} template */
  hasImage(owner, template) {
    const who = String(owner || '').toLowerCase();
    return [...this.held.entries()].some(([k, h]) => h.owner === who && this.seen.get(k)?.images?.some((/** @type {any} */ i) => i.id === template));
  }

  /** Whether this box holds a cluster of this person's at all. @param {string} owner */
  holdsFor(owner) {
    const who = String(owner || '').toLowerCase();
    return [...this.held.values()].some((h) => h.owner === who);
  }

  /**
   * Look at every cluster held, sweep what is done, and remember what was
   * seen for the health frame.
   */
  async refresh() {
    for (const [k, { owner, record }] of this.held) {
      try {
        this.seen.set(k, await this.#look(record, owner));
      } catch (e) {
        this.seen.set(k, { address: record.address, owner, kind: PVE_KIND, reachable: false, pools: [], images: [], networks: [], machines: [], problem: String(/** @type {Error} */ (e).message).slice(0, 200) });
      }
    }
  }

  /** @param {PveRecord} record @param {string} owner */
  async #look(record, owner) {
    const api = this.#client(record);
    const perms = (await api.get('/access/permissions')) || {};
    const pool = (await api.get(`/pools/${encodeURIComponent(record.pool)}`)) || {};
    const members = /** @type {any[]} */ (Array.isArray(pool.members) ? pool.members : []).filter((m) => m?.type === 'qemu' && Number.isInteger(Number(m.vmid)) && typeof m.node === 'string');
    const version = await api.get('/version').catch(() => null);
    const poolEntry = { id: pveIdOf(record.address, 'pool', record.pool), name: record.pool };
    // THE IMAGES: templates in the fleet's pool, tagged as the script tags them.
    /** @type {PveImage[]} */
    const images = [];
    for (const t of members.filter((m) => Number(m.template) === 1 && tagsOf(m).includes(PVE_IMAGE_TAG))) {
      const cfg = (await api.get(`/nodes/${encodeURIComponent(t.node)}/qemu/${Number(t.vmid)}/config`)) || {};
      const ctime = /(?:^|,)ctime=(\d+)/.exec(String(cfg.meta || ''))?.[1] ?? '0';
      images.push({ id: pveIdOf(record.address, 'image', `${t.vmid}:${ctime}`), name: String(t.name || cfg.name || `template ${t.vmid}`).slice(0, 80), node: String(t.node), vmid: Number(t.vmid), pool: poolEntry.id, poolName: record.pool, bridge: bridgeOf(cfg.net0) });
    }
    // THE FENCE, as Proxmox says it is, and null when it will not say.
    const fw = await api.get('/cluster/firewall/options').catch(() => null);
    const groups = await api.get('/cluster/firewall/groups').catch(() => null);
    const fenced = fw === null || groups === null ? null : Number(fw?.enable) === 1 && (Array.isArray(groups) ? groups : []).some((g) => g?.group === PVE_FENCE_GROUP);
    // THE MACHINES: in the pool, tagged, named as the fleet names them, and
    // marked; the sweep first, then what is left, for the phone's page.
    /** @type {any[]} */
    const machines = [];
    const now = this.now();
    for (const v of members.filter((m) => Number(m.template) !== 1 && tagsOf(m).includes(PVE_SESSION_TAG) && NAME_RE.test(String(m.name))).slice(0, MAX_MACHINES)) {
      const base = `/nodes/${encodeURIComponent(v.node)}/qemu/${Number(v.vmid)}`;
      const cfg = (await api.get(`${base}/config`)) || {};
      const mark = markOf(cfg.description);
      if (!mark) continue;
      const stopped = v.status === 'stopped';
      const busy = mark.busy !== null && now - mark.busy * 1000 < BUSY_MS;
      const over = now > mark.until * 1000 + GRACE_MS;
      const young = now - mark.made * 1000 < YOUNG_MS;
      if (!busy && ((stopped && !young) || over)) {
        try {
          // CLEANLY, so the sidecar inside closes its socket with a goodbye and
          // the coordinator retires it at once; a hard stop read as a runner's
          // drop and left it "not reporting" for ten minutes (#1532). Proxmox
          // forces it off itself if the guest has not gone in a minute.
          if (!stopped) await api.waitTask(await api.post(`${base}/status/shutdown`, { forceStop: 1, timeout: 60 }), { sleep: this.sleep });
          await api.waitTask(await api.del(base, { purge: 1, 'destroy-unreferenced-disks': 1 }), { sleep: this.sleep });
          this.log.info(`sidecar: removed ${v.name} from ${record.address}, ${over ? 'past its end' : 'stopped'}`);
          continue;
        } catch (e) {
          this.log.warn(`sidecar: could not remove ${v.name} from ${record.address}: ${/** @type {Error} */ (e).message}`);
        }
      }
      machines.push({
        name: String(v.name),
        vm: pveIdOf(record.address, 'vm', `${v.vmid}:${mark.made}`),
        state: stopped ? 'Halted' : v.status === 'running' ? 'Running' : String(v.status || '') || null,
        ip: null,
        until: mark.until * 1000,
        madeAt: mark.made * 1000,
        cpus: Number.isInteger(Number(cfg.cores)) ? Number(cfg.cores) * (Number(cfg.sockets) || 1) : null,
        memory: Number.isFinite(Number(cfg.memory)) ? Number(cfg.memory) * 1024 * 1024 : null,
        image: images.find((i) => i.id === mark.from)?.name ?? null,
        network: mark.on ?? bridgeOf(cfg.net0),
        group: null,
        groupIp: null,
        lab: null,
        net: null,
        node: String(v.node),
        vmid: Number(v.vmid),
      });
    }
    return {
      address: record.address,
      owner,
      kind: PVE_KIND,
      reachable: true,
      version: typeof version?.version === 'string' ? version.version.slice(0, 20) : null,
      pools: [poolEntry],
      images,
      networks: networksOf(perms, record.address).map((n) => ({ ...n, pool: poolEntry.id })),
      machines,
      fenced,
      wide: wideOf(perms, record.pool),
    };
  }

  /**
   * Make a machine from an image, for the person whose cluster it is, booted
   * with a ticket to enrol itself. The answers are xo-pools.js's.
   *
   * @param {{ owner: string, template: string, ticket: string, minutes?: number|null, network?: string|null, group?: string|null, lab?: boolean, coordinatorUrl: string }} ask
   */
  async make({ owner, template, ticket, minutes = null, network = null, group = null, lab = false, coordinatorUrl }) {
    const who = String(owner || '').toLowerCase();
    const m = TICKET_RE.exec(String(ticket || ''));
    if (!m) return { ok: false, text: 'That machine came without the ticket it enrols with, so it was not made.' };
    if (lab) return { ok: false, text: 'Labs are not built on Proxmox yet, so the machine was not made. Start it on one of the cluster’s networks instead.' };
    if (group) return { ok: false, text: 'Machines that work together are not built on Proxmox yet, so the machine was not made.' };
    const name = `vm-${m[1]}`;
    const found = [...this.held.entries()].find(([k, h]) => h.owner === who && this.seen.get(k)?.images?.some((/** @type {any} */ i) => i.id === template));
    if (!found) return { ok: false, text: 'This box holds no pool of yours with that machine image.' };
    const [k, { record }] = found;
    const seen = this.seen.get(k);
    const image = /** @type {PveImage} */ (seen.images.find((/** @type {any} */ i) => i.id === template));
    const chosen = network ? seen.networks.find((/** @type {any} */ n) => n.id === network) : null;
    if (network && !chosen) return { ok: false, text: 'That network is not one this box saw on your cluster, so the machine was not made.' };
    // NOT FENCED IS NOT MADE QUIETLY: a machine on the image's bridge with the
    // datacenter's firewall off reaches everything that bridge does. Made on a
    // network the person chose, it reaches what they chose; made by default,
    // it would reach their network without their having said so.
    if (!chosen && seen.fenced !== true) {
      return {
        ok: false,
        text: seen.fenced === false
          ? `${record.address}’s datacenter firewall is off, so a machine there would reach your network and not only the internet. It was not made. Turn the firewall on (Datacenter › Firewall › Options), or choose a network for it in New session › Where.`
          : `${record.address} would not say whether its firewall is on, so the machine was not made. Choose a network for it in New session › Where, or let the token read /cluster/firewall (run the setup again).`,
      };
    }
    const life = Math.max(5, Math.min(MAX_MINUTES, Number(minutes) || DEFAULT_MINUTES));
    const made = Math.floor(this.now() / 1000);
    const until = made + life * 60;
    const grants = machineGrantsOf(record.grants);
    const join = { v: 1, coordinator: new URL(coordinatorUrl).origin, ticket, owner: who, minutes: BACKSTOP_MINUTES, ...(grants ? { grants } : {}) };
    const api = this.#client(record);
    const src = `/nodes/${encodeURIComponent(image.node)}/qemu/${image.vmid}`;
    /** @type {number|null} */
    let vmid = null;
    try {
      // A NUMBER OF ITS OWN: another box may take the same one in the same
      // moment, and Proxmox refuses the second clone; ask again.
      let lastError = null;
      for (let attempt = 0; attempt < 3 && vmid === null; attempt++) {
        let next;
        try {
          next = Number(await api.get('/cluster/nextid'));
        } catch (e) {
          return { ok: false, unreachable: true, text: `${record.address} could not be reached from here: ${/** @type {Error} */ (e).message}` };
        }
        try {
          await api.waitTask(await api.post(`${src}/clone`, { newid: next, name, pool: record.pool, description: markText({ for: who, until, made, from: image.id, on: chosen?.name ?? image.bridge }) }), { sleep: this.sleep });
          vmid = next;
        } catch (e) {
          lastError = e;
          if (!/already exists|config file .* exists|in use/i.test(String(/** @type {Error} */ (e).message))) throw e;
        }
      }
      if (vmid === null) throw lastError ?? new Error('no number was free');
      const dst = `/nodes/${encodeURIComponent(image.node)}/qemu/${vmid}`;
      const cfg = (await api.get(`${dst}/config`)) || {};
      const smbios1 = smbiosWith(cfg.smbios1, join);
      if (smbios1.length > SMBIOS_MAX) throw new Error('the join would not fit in the machine’s SMBIOS');
      const keys = this.ssh.get(who) ?? [];
      // PUT, WHICH ANSWERS WHEN IT IS DONE. POST on the same path is the
      // asynchronous form: 200 and a task, whatever then became of it, so a
      // join that did not take would have started a machine that could never
      // enrol. Measured on a live Proxmox VE 9 node (docs/proxmox.md, "What a
      // live cluster taught"). The clone is off, so nothing goes to `pending`.
      await api.put(`${dst}/config`, {
        tags: PVE_SESSION_TAG,
        smbios1,
        ciuser: 'fleetwright',
        ...(keys.length ? { sshkeys: encodeURIComponent(keys.join('\n')) } : {}),
        net0: net0On(cfg.net0, chosen?.name ?? null),
      });
      // BEHIND THE FENCE, unless the person chose the network: the cluster's
      // group, on the bridge, out of the guest's reach.
      if (!chosen) {
        await api.put(`${dst}/firewall/options`, { enable: 1, policy_in: 'DROP', policy_out: 'ACCEPT' });
        await api.post(`${dst}/firewall/rules`, { type: 'group', action: PVE_FENCE_GROUP, enable: 1 });
      }
      await api.waitTask(await api.post(`${dst}/status/start`, {}), { sleep: this.sleep });
      this.#noteMade(name, { vmid, node: image.node, owner: who, at: this.now() });
      this.log.info(`sidecar: made ${name} from ${image.name} on ${record.address} for ${who}`);
      const claude = this.claude.get(who) ?? null;
      return {
        ok: true,
        vm: pveIdOf(record.address, 'vm', `${vmid}:${made}`),
        text:
          `Making ${name} from ${image.name} on ${record.address}${chosen ? `, on ${chosen.name}` : ', behind the cluster’s firewall: it reaches the internet and nothing private'}. ` +
          `It joins the fleet as your temporary machine in a minute or two, for ${life} minutes${claude ? '' : ', and has no Claude login of yours to run on: keep one in your vault'}.`,
      };
    } catch (e) {
      // HALF MADE IS UNMADE: a clone that could not be set up or started
      // would otherwise wait for the sweep with a ticket in it.
      if (vmid !== null) {
        const dst = `/nodes/${encodeURIComponent(image.node)}/qemu/${vmid}`;
        await api.post(`${dst}/status/stop`, {}).catch(() => {});
        await api.del(dst, { purge: 1, 'destroy-unreferenced-disks': 1 }).catch(() => {});
      }
      return { ok: false, text: `${record.address} would not make the machine: ${/** @type {Error} */ (e).message}` };
    }
  }

  /** @param {string} name @param {{ vmid: number, node: string, owner: string, at: number }} made */
  #noteMade(name, made) {
    for (const [n, m] of this.made) if (this.now() - m.at > MADE_FORGET_MS) this.made.delete(n);
    while (this.made.size >= MAX_MADE) {
      const oldest = this.made.keys().next().value;
      if (oldest === undefined) break;
      this.made.delete(oldest);
    }
    this.made.set(name, made);
  }

  /**
   * Find a machine of this person's by name on their clusters, as the
   * cluster says it is. Null when it is on none that answered; `unreachable`
   * names the ones that did not.
   *
   * @param {string} who @param {string} name
   */
  async #find(who, name) {
    /** @type {string[]} */
    const unreachable = [];
    const held = [...this.held.values()].filter((h) => h.owner === who);
    for (const { record } of held) {
      const api = this.#client(record);
      let pool;
      try {
        pool = (await api.get(`/pools/${encodeURIComponent(record.pool)}`)) || {};
      } catch (e) {
        unreachable.push(`${record.address}: ${/** @type {Error} */ (e).message}`);
        continue;
      }
      const v = (Array.isArray(pool.members) ? pool.members : []).find((/** @type {any} */ m) => m?.type === 'qemu' && m.name === name && Number(m.template) !== 1 && tagsOf(m).includes(PVE_SESSION_TAG));
      if (!v) continue;
      const base = `/nodes/${encodeURIComponent(v.node)}/qemu/${Number(v.vmid)}`;
      const cfg = (await api.get(`${base}/config`)) || {};
      const mark = markOf(cfg.description);
      if (!mark || mark.for !== who) continue;
      return { found: { api, record, v, base, cfg, mark }, unreachable, held: held.length };
    }
    return { found: null, unreachable, held: held.length };
  }

  /**
   * A machine made for `owner` asks for their Claude login: handed sealed to
   * the key it sent, once, and only to one running on their cluster, in the
   * fleet's pool, marked as theirs (xo-pools.js, handLogin, says why a box
   * that did not make it may hand it too).
   *
   * @param {{ owner: string, name: string, key: string }} ask
   */
  async handLogin({ owner, name, key }) {
    const who = String(owner || '').toLowerCase();
    const id = String(name);
    if (this.handing.has(id)) return { ok: false, text: `${name} is being handed its login already, so this ask is handed nothing.` };
    if (this.handed.has(id)) return { ok: false, text: `${name} was handed its login by this box already, so this ask is handed nothing.` };
    const token = this.claude.get(who);
    if (!token) return { ok: false, notHere: true, text: `This box holds no Claude login of ${who}’s to hand ${name}.` };
    if (!this.holdsFor(who)) return { ok: false, notHere: true, text: `This box holds none of ${who}’s clusters, so it cannot see ${name}.` };
    this.handing.add(id);
    try {
      const { found, unreachable } = await this.#find(who, id);
      if (!found) {
        return unreachable.length
          ? { ok: false, unreachable: true, text: `${name} is not on the clusters of yours that answered, and the rest could not be reached from here: ${unreachable.join('; ')}` }
          : { ok: false, notHere: true, text: `${name} is not on any of ${who}’s clusters this box holds.` };
      }
      // THE MAKER KNOWS THE NUMBER it cloned to; a name somebody gave another VM is not it.
      const made = this.made.get(id);
      if (made && made.owner === who && Number(found.v.vmid) !== made.vmid) return { ok: false, text: `${name} is not the machine this box made any more, so it is handed nothing.` };
      if (found.v.status !== 'running') return { ok: false, text: `${name} is ${String(found.v.status || 'not running')}, so it is handed nothing.` };
      const sealed = await seal({ to: key, aad: await claudeBindingFor(key), payload: { token } });
      this.made.delete(id);
      if (this.handed.size >= HANDED_REMEMBERED) this.handed.delete(/** @type {string} */ (this.handed.values().next().value));
      this.handed.add(id);
      this.log.info(`sidecar: handed ${name} ${who}’s Claude login`);
      return { ok: true, text: `Handed ${name} your Claude login.`, sealed };
    } catch (e) {
      return { ok: false, text: `The cluster would not say whether ${name} is a machine made for ${who}: ${/** @type {Error} */ (e).message}` };
    } finally {
      this.handing.delete(id);
    }
  }

  /**
   * Restart a machine, give it longer, change its size, or end it now.
   *
   * @param {{ owner: string, name: string, action: 'reboot'|'extend'|'resize'|'stop', minutes?: number|null, cpus?: number|null, memory?: number|null }} ask
   */
  async control({ owner, name, action, minutes = null, cpus = null, memory = null }) {
    const who = String(owner || '').toLowerCase();
    if (!NAME_RE.test(String(name))) return { ok: false, text: 'That is not the name of a machine this fleet made.' };
    if (!this.holdsFor(who)) return { ok: false, notHere: true, text: 'This box holds none of your clusters.' };
    const { found, unreachable, held } = await this.#find(who, String(name));
    if (!found) {
      return unreachable.length
        ? { ok: false, unreachable: true, text: unreachable.length === held ? `Your clusters could not be reached from here: ${unreachable.join('; ')}` : `${name} is not on the clusters of yours that answered, and the rest could not be reached from here: ${unreachable.join('; ')}` }
        : { ok: false, notHere: true, text: `${name} is not on any of your clusters this box holds.` };
    }
    const { api, base, mark, record } = found;
    const wait = async (/** @type {Promise<any>} */ p) => api.waitTask(await p, { sleep: this.sleep });
    try {
      if (action === 'reboot') {
        await wait(api.post(`${base}/status/reboot`, {}));
        return { ok: true, text: `Restarting ${name}.` };
      }
      if (action === 'stop') {
        await wait(api.post(`${base}/status/shutdown`, { forceStop: 1, timeout: 60 }));
        void this.refresh().catch(() => {});
        return { ok: true, text: `${name} is off, and is removed with its disk on the next look.` };
      }
      if (action === 'extend') {
        const most = mark.made + MAX_MINUTES * 60;
        const to = Math.min(most, Math.max(mark.until, Math.floor(this.now() / 1000)) + Math.max(5, Math.min(MAX_MINUTES, Number(minutes) || 60)) * 60);
        await api.put(`${base}/config`, { description: markText({ ...mark, until: to }) });
        return { ok: true, until: to * 1000, text: to === most ? `${name} runs until ${MAX_MINUTES} minutes from when it was made, which is as long as a machine is given.` : `${name} runs ${Math.round((to - mark.until) / 60)} minutes longer.` };
      }
      if (action === 'resize') {
        const c = Number(cpus);
        const g = Number(memory);
        if (!(Number.isInteger(c) && c >= 1 && c <= 64) || !(Number.isFinite(g) && g >= 1 && g <= 512)) return { ok: false, text: 'A size is 1 to 64 vCPUs and 1 to 512 GiB.' };
        // MARKED BUSY while it is off on purpose, so no box's sweep takes it.
        await api.put(`${base}/config`, { description: markText({ ...mark, busy: Math.floor(this.now() / 1000) }) });
        await wait(api.post(`${base}/status/shutdown`, { forceStop: 1, timeout: 120 }));
        await api.put(`${base}/config`, { cores: c, sockets: 1, memory: Math.round(g * 1024), description: markText({ ...mark, busy: null }) });
        await wait(api.post(`${base}/status/start`, {}));
        return { ok: true, text: `${name} restarted with ${c} vCPUs and ${g} GiB.` };
      }
      return { ok: false, text: `${action} is not something a machine can be asked to do.` };
    } catch (e) {
      return { ok: false, text: `${record.address} would not do that: ${/** @type {Error} */ (e).message}` };
    }
  }
}

/**
 * THE VENDOR SNIPPET every machine cloned from the image boots with, which the
 * setup script writes to the cluster's snippets storage and names on the
 * template (`cicustom: vendor=`). It holds nothing of anybody's: the join is
 * in the clone's SMBIOS serial (`smbiosWith`), which only root in the guest
 * reads, and this copies it where fleetwright-vm-join takes it from. The
 * same join script Xen Orchestra's machines run, unchanged.
 *
 * Kept here and embedded in install/fleetwright-pve-setup, which has no
 * Fleetwright to import it from; test/pve-pools.test.js holds the two equal.
 */
export function pveVendorConfig() {
  return [
    '#cloud-config',
    '# Fleetwright: a machine cloned from this template joins the fleet by itself',
    '# (docs/proxmox.md). The join is in its SMBIOS serial, put there by the box',
    '# that cloned it; this reads it as root on the first boot.',
    'runcmd:',
    "  - [sh, -c, 'umask 077; mkdir -p /run/fleetwright && cat /sys/class/dmi/id/product_serial >/run/fleetwright/join.json']",
    JOIN_RUNCMD,
    '',
  ].join('\n');
}

/**
 * THE BUILD SNIPPET the image's one boot runs: Fleetwright from apt, left
 * unjoined, nothing that makes two clones one machine, and powered off. A
 * build that fails stays running, which the script reports with the command
 * that shows its console. `@CHANNEL@` is the apt suite, put in by the script.
 */
export function pveBuildConfig() {
  return [
    '#cloud-config',
    '# Fleetwright: builds the machine image (install/fleetwright-pve-setup).',
    '# Powers off when it is done. Still running means it failed.',
    'package_update: true',
    'packages: [curl, ca-certificates, openssh-server, qemu-guest-agent]',
    'runcmd:',
    '  - |',
    '    set -eu',
    '    curl -fsSL https://fleet-apt.thetech.network/fleetwright.gpg -o /usr/share/keyrings/fleetwright.gpg',
    '    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/fleetwright.gpg] https://fleet-apt.thetech.network @CHANNEL@ main" >/etc/apt/sources.list.d/fleetwright.list',
    "    echo 'fleetwright fleetwright/user string fleetwright' | debconf-set-selections",
    '    apt-get update',
    '    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends fleetwright',
    '    test -x /opt/fleetwright/current/install/fleetwright-vm-join',
    '    systemctl enable qemu-guest-agent || true',
    '    systemctl disable --now fleetwright-sidecar fleetwright 2>/dev/null || true',
    '    rm -f /var/lib/fleetwright-sidecar/host-key.json /var/lib/fleetwright-sidecar/host-key.json.*',
    '    truncate -s 0 /etc/machine-id',
    '    rm -f /var/lib/dbus/machine-id /etc/ssh/ssh_host_*',
    '    cloud-init clean --logs',
    '    poweroff',
    '',
  ].join('\n');
}
