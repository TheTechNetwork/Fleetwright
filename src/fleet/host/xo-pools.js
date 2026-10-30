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
//           with a ticket to enrol itself; or the same machine in a lab, alone
//           on one of the pool's lab networks (edge-router.js, LAB), whose
//           rules are the edge's.
//   login   the Claude login a machine made here runs on, handed to it once
//           it has enrolled, sealed to its key (`handLogin`): never on its
//           cloud-init drive, which every box holding the pool's token may
//           export through Xen Orchestra (docs/security.md, G14).
//
// WHAT THE LIMITED USER MAY DO is what its resource set allows: clone images
// that are in the set onto storage and networks that are in the set, inside
// its limits. Xen Orchestra enforces that, which is the bound that holds when
// everything on our side has failed. Not quite all of it, measured on 5.211.0
// (docs/hypervisors.md, "What Xen Orchestra lets whom do"): it may also
// snapshot the machines it made and copy a snapshot to a template, which
// vm.copyToTemplate counts against no limit and leaves it unable to delete;
// and it sees every object on the pool, not only the set's (fleetSetOf).

import { readFileSync } from 'node:fs';
import { resource } from '../../core/resources.js';
import { connectXo, connectXoPlain } from './xo-ws.js';
import { EDGE, EDGE_HA, GROUP_PREFIX, LAB, labsEachOf, wanAddressOf } from './edge-router.js';
import { JOIN_RUNCMD, VM_IMAGE } from './vm-image.js';
import { HOLDER } from './xo-holder.js';
import { seal, xolookAad, claudeBindingFor } from '../seal.js';
import { xoActionArgs } from '../protocol/intents.js';
import { machineGrantsOf } from '../../core/grants.js';

/** The prefix a pool's item carries in a vault answer. */
export const HYPERVISOR_ITEM = 'hypervisor:';
/** A Claude token's shape, as the vault keeps one. */
const CLAUDE_RE = /^[A-Za-z0-9._~+/=-]{20,2048}$/;
/** A dispatch ticket's shape (src/fleet/coordinator/runner-tickets.js). */
const TICKET_RE = /^fwt_([0-9a-f]{12})_[0-9a-f]{48}$/;
/** How long a machine lives when nobody said: the same default a runner has. */
const DEFAULT_MINUTES = 60;
/** The longest a machine lives, extensions included, from when it was made. */
export const MAX_MINUTES = 350;
/**
 * The power-off a machine schedules for itself, past the longest it can be
 * given: the end is the box's to keep (it stops a machine at its `until`),
 * and this is only there for a pool no box reaches any more.
 */
const BACKSTOP_MINUTES = MAX_MINUTES + 30;
/** How long past its end a machine may still be running before it is removed. */
const GRACE_MS = 60_000;
/** How long a machine made here is remembered for its login, and how many at most (XoPools#made). */
const MADE_FORGET_MS = 24 * 60 * 60_000;
const MAX_MADE = 64;
/**
 * A machine being resized is stopped on purpose, and the sweep leaves it be:
 * `fleetwright-busy:<seconds since the epoch>`, honoured for BUSY_MS from the
 * time in it. It used to be the bare tag, which a sidecar that died between
 * marking and unmarking (#work) left on for good, and the machine with it:
 * stopped, never swept, never started. A bare one found now (BUSY_TAG, from a
 * box older than this) is given the time it was first seen at, so that it
 * runs out like the rest and the sweep does not take a machine from under a
 * resize still going on an older box.
 */
const BUSY_TAG = 'fleetwright-busy';
const BUSY_PREFIX = 'fleetwright-busy:';
const BUSY_MS = 30 * 60_000;
/**
 * How long after it was made a stopped machine may still be booting rather
 * than done: vm.create clones and tags it before it is started, and any box
 * that looked in that window took it for a stopped machine and removed it,
 * disk and all, before it had booted once (#sweep).
 */
const YOUNG_MS = 5 * 60_000;
/** The sweep started this machine again once, found stopped before its end (#sweep). */
const RESTARTED_PREFIX = 'fleetwright-restarted:';
/** When a machine was made, its image and its network, as tags beside its end. */
const MADE_PREFIX = 'fleetwright-made:';
const FROM_PREFIX = VM_IMAGE.fromPrefix;
const ON_PREFIX = 'fleetwright-on:';
/**
 * Whose machine it is. Two people can keep tokens for the same Xen
 * Orchestra; a machine is worked only for the person it was made for.
 */
const FOR_PREFIX = 'fleetwright-for:';
/** The group network a machine is also on, and its address there. */
const GROUP_TAG = 'fleetwright-grp:';
/** The lab a machine is in, by its network's name. */
const LAB_TAG = 'fleetwright-in-lab:';
const GROUP_IP_TAG = 'fleetwright-gip:';
/**
 * The uplink's range, which every session machine on it shares. Only the
 * router may open a connection from it to a machine (install/fleetwright-net).
 */
export const UPLINK_SUBNET = `${EDGE.lan.address.split('.').slice(0, 3).join('.')}.0/${EDGE.lan.prefix}`;
/** The range machines take on a group network: no DHCP there, so each is given one. */
export const GROUP_RANGE = '10.200.0.0/16';
/** @type {string|null} */
let netScript = null;
/**
 * The boot-time script that fences a machine on the uplink and puts it on its
 * group network. Carried on the cloud-init drive rather than taken from the
 * image, so a machine cloned from an image built before it has it too. Found
 * from the install's root, not from this file, which a release bundles
 * somewhere else (core/resources.js).
 */
const NET_SCRIPT = () => (netScript ??= readFileSync(resource('install', 'fleetwright-net'), 'utf8'));
/** Runs it at every boot, before anything on the machine listens. */
const NET_UNIT = [
  '[Unit]',
  'Description=Fleetwright: fence this machine on the uplink, join its group network',
  'Wants=network-online.target',
  'After=network-online.target',
  'Before=fleetwright.service fleetwright-sidecar.service ssh.service',
  '',
  '[Service]',
  'Type=oneshot',
  'RemainAfterExit=yes',
  'ExecStart=/usr/local/sbin/fleetwright-net /etc/fleetwright-net.json',
  '',
  '[Install]',
  'WantedBy=multi-user.target',
  '',
].join('\n');
/** The vault item a person's SSH public keys are kept in, one per line. */
export const SSH_KEYS_ITEM = 'secret:SSH_AUTHORIZED_KEYS';
const SSH_KEY_RE = /^(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]{16,8192}(?: [^\n]{0,200})?$/;

/**
 * @typedef {{ key: string, secret: string, pin: string, routers: Array<{ name: string, address: string|null }> }} EdgeKey
 * @typedef {{ v?: number, address: string, pin: string|null, plain?: boolean, token: string, resourceSet?: string|null, user?: string, edge?: EdgeKey, grants?: { upgrades?: boolean, reboot?: boolean } }} PoolRecord
 * @typedef {{ id: string, name: string, pool: string|null, poolName: string|null }} Image
 * @typedef {{ id: string, name: string, pool: string|null, group: boolean, lab?: 'open'|'closed', taken?: boolean|null, perPerson?: number }} Network
 * @typedef {{ interval: number, end: number, rx: Array<number|null>, tx: Array<number|null> }} Traffic
 * @typedef {{ name: string, vm: string, state: string|null, ip: string|null, until: number|null, madeAt: number|null, cpus: number|null, memory: number|null, image: string|null, network: string|null, group: string|null, groupIp: string|null, lab: { name: string, open: boolean }|null, net: Traffic|null }} Machine
 * @typedef {{ address: string, owner: string, reachable: boolean|null, pools: Array<{ id: string, name: string }>, images: Image[], networks: Network[], machines: Machine[], problem?: string, holder?: boolean, missing?: Array<{ id: string, name: string }>, missingFor?: number }} Seen
 * @typedef {{ name: string, seenAt: number, missingSince: number|null }} Had
 */

/**
 * How long a pool the token no longer sees is still said to be missing, from
 * the last time it was seen: a day. A pool somebody removed from Xen
 * Orchestra on purpose stops being news, and a box that held the token
 * before it was set up again does not report a pool for ever.
 */
export const MISSING_FORGET_MS = 24 * 60 * 60_000;

/**
 * A person's SSH public keys, from the item they keep them in, each one
 * checked to be a public key and nothing else.
 *
 * @param {unknown} value @returns {string[]}
 */
export function sshKeys(value) {
  if (typeof value !== 'string') return [];
  return value
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => SSH_KEY_RE.test(l))
    .slice(0, 20);
}

/** A tag's value by its prefix, or null. @param {any} vm @param {string} prefix */
const tagValue = (vm, prefix) => {
  const t = (Array.isArray(vm?.tags) ? vm.tags : []).find((/** @type {string} */ x) => x.startsWith(prefix));
  return t ? t.slice(prefix.length) : null;
};

/**
 * Which kind of lab a network is, by the tag the policy job gave it, or null
 * for a network that is not a lab (or no longer is: a lab the policy took
 * away loses its tag, and is offered no more).
 *
 * @param {any} n @returns {'open'|'closed'|null}
 */
function labKind(n) {
  if (!String(n?.name_label || '').startsWith(LAB.prefix) || !Array.isArray(n?.tags)) return null;
  if (n.tags.includes(LAB.openTag)) return 'open';
  if (n.tags.includes(LAB.closedTag)) return 'closed';
  return null;
}

/**
 * WHAT THE FLEET'S RESOURCE SET HOLDS, as the limited user reads it: the sets
 * it is a subject of, which is all resourceSet.getAll answers a user who is
 * not an admin, and what is in them.
 *
 * THE SET AND NOT WHAT THE TOKEN SEES, AND NOT THE TAGS. Xen Orchestra shows
 * a user who is not an admin every object there is, its own or not
 * (xo.getAllObjects checks only that somebody is signed in), and a tag is
 * something anybody given administrate on one VM can add to it, to a clone of
 * it, and to a snapshot of it that it then copies to a template: all measured
 * on 5.211.0 (docs/hypervisors.md, "What Xen Orchestra lets whom do"). So a
 * VM somebody else named `vm-…` and tagged as one of ours was reported as a
 * person's machine, counted against their labs, and swept; a template tagged
 * as an image was offered on the phones; and every network on the pool was
 * offered, of which only those in the set can carry a machine. What is in the
 * set only an admin of Xen Orchestra can change, and a VM is made in it only
 * by a subject of the set (vm.create checks both).
 *
 * @param {any} rpc  signed in with the fleet's token
 * @returns {Promise<{ ids: Set<string>, objects: Set<string> }>}
 */
async function fleetSetOf(rpc) {
  const answer = await rpc.call('resourceSet.getAll');
  const sets = /** @type {any[]} */ (Array.isArray(answer) ? answer : []);
  return {
    ids: new Set(sets.map((s) => String(s?.id))),
    objects: new Set(sets.flatMap((s) => (Array.isArray(s?.objects) ? s.objects.map(String) : []))),
  };
}

/** A VM made in the fleet's set. @param {any} v @param {{ ids: Set<string> }} set */
const inFleetSet = (v, set) => typeof v?.resourceSet === 'string' && set.ids.has(v.resourceSet);

/**
 * How many of the fleet's own machines have an interface on each network, by
 * network id, from Xen Orchestra's interfaces; null when it would not say,
 * which makes every lab cannot tell rather than free.
 *
 * @param {any} rpc @param {any[]} vms
 * @returns {Promise<Map<string, string[]>|null>} network id → the machines' ids on it
 */
async function machinesOnNetworks(rpc, vms) {
  try {
    const vifs = /** @type {any[]} */ (Object.values((await rpc.call('xo.getAllObjects', { filter: { type: 'VIF' } })) || {}));
    const fleets = new Set(vms.filter((v) => Array.isArray(v?.tags) && v.tags.includes(VM_IMAGE.sessionTag)).map((v) => v.id));
    /** @type {Map<string, string[]>} */
    const on = new Map();
    for (const f of vifs) {
      if (!fleets.has(f?.$VM) || typeof f?.$network !== 'string') continue;
      on.set(f.$network, [...(on.get(f.$network) ?? []), String(f.$VM)]);
    }
    return on;
  } catch {
    return null;
  }
}

/** The object types a pool's page reads, in the phones' order (Manage.objectTypes). */
export const PAGE_TYPES = Object.freeze(['pool', 'host', 'VM', 'SR', 'VBD', 'VDI']);

/** The most a pool's page may be before sealing: under the fleet's one-megabyte message once sealed and framed. */
export const MAX_PAGE_BYTES = 512 * 1024;

/**
 * WHAT THE PAGE SHOWS OF EACH OBJECT, and nothing else of it: the fields the
 * phones decode (Manage.component, attachment and disk in both apps). A
 * VM's record in Xen Orchestra carries its boot order, its other config and
 * every tag; none of that is drawn, so none of it travels, but one: the tag
 * that marks the pool's own machine, which the page draws as made with the
 * admin sign-in and offers nothing for (docs/manage.md). A nested field
 * keeps only the keys named.
 */
const PAGE_FIELDS = Object.freeze({
  common: ['id', 'type', 'name_label', '$pool', '$container', 'power_state', 'enabled'],
  VM: ['mainIpAddress', 'managementAgentDetected', 'pvDriversDetected'],
  host: ['productBrand', 'version', 'address'],
  SR: ['size', 'physical_usage', 'SR_type', 'shared'],
  VBD: ['VM', 'VDI', 'is_cd_drive', 'position'],
  VDI: ['size', '$SR'],
});

/**
 * One object as the page needs it, or null for one that is not a page's.
 *
 * @param {any} o
 * @returns {Record<string, any>|null}
 */
export function pageObject(o) {
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !PAGE_TYPES.includes(o.type)) return null;
  /** @type {Record<string, any>} */
  const out = {};
  const scalar = (/** @type {unknown} */ v) => (typeof v === 'string' ? v.slice(0, 200) : typeof v === 'number' || typeof v === 'boolean' ? v : undefined);
  for (const k of [...PAGE_FIELDS.common, ...(/** @type {Record<string, string[]>} */ (PAGE_FIELDS)[o.type] || [])]) {
    const v = scalar(o[k]);
    if (v !== undefined) out[k] = v;
  }
  /** @param {unknown} v @param {string[]} keys */
  const nested = (v, keys) => {
    if (!v || typeof v !== 'object') return undefined;
    /** @type {Record<string, number>} */
    const kept = {};
    for (const k of keys) if (typeof (/** @type {any} */ (v)[k]) === 'number') kept[k] = /** @type {any} */ (v)[k];
    return Object.keys(kept).length ? kept : undefined;
  };
  if (o.type === 'VM') {
    const cpus = nested(o.CPUs, ['number']);
    if (cpus) out.CPUs = cpus;
    if (Array.isArray(o.tags) && o.tags.includes(HOLDER.tag)) out.tags = [HOLDER.tag];
    // The guest's addresses, by Xen Orchestra's own keys ("0/ipv4/0"), a few.
    if (o.addresses && typeof o.addresses === 'object') {
      const pairs = Object.entries(o.addresses).filter(([, v]) => typeof v === 'string').slice(0, 16);
      if (pairs.length) out.addresses = Object.fromEntries(pairs.map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 45)]));
    }
  }
  if (o.type === 'host') {
    const cpus = nested(o.cpus, ['cores']);
    if (cpus) out.cpus = cpus;
  }
  if (o.type === 'VM' || o.type === 'host') {
    const memory = nested(o.memory, o.type === 'host' ? ['size', 'usage'] : ['size']);
    if (memory) out.memory = memory;
  }
  return out;
}

/**
 * The address Xen Orchestra's guest tools reported: its own pick
 * (`mainIpAddress`), else the first IPv4 one, or null.
 * @param {any} vm
 */
function ipOf(vm) {
  if (typeof vm?.mainIpAddress === 'string' && vm.mainIpAddress) return vm.mainIpAddress.slice(0, 45);
  const addresses = vm?.addresses && typeof vm.addresses === 'object' ? vm.addresses : {};
  const keys = Object.keys(addresses).sort();
  const v4 = keys.find((k) => /ipv4/.test(k)) ?? keys[0];
  return v4 ? String(addresses[v4]).slice(0, 45) : null;
}

/**
 * How many of the pool's one-minute samples of a machine's traffic are kept:
 * the last half hour. Within the coordinator's bound (MAX_NET_POINTS).
 */
export const NET_POINTS = 30;

/**
 * WHAT A MACHINE SENT AND RECEIVED, from Xen Orchestra's `vm.stats`: the
 * hypervisor's own counters for its network interfaces, which nothing inside
 * the machine can change. Bytes a second, every interface added together,
 * oldest first, the last NET_POINTS of them. A sample no interface counted is
 * null, never 0; anything that is not a reading is null for the whole.
 *
 * @param {any} stats what `vm.stats` answered
 * @returns {Traffic|null}
 */
export function trafficFrom(stats) {
  const interval = Number(stats?.interval);
  const end = Number(stats?.endTimestamp);
  const vifs = stats?.stats?.vifs;
  if (!(interval > 0) || !(end > 0) || !vifs || typeof vifs !== 'object') return null;
  // Keyed by interface ("0", "1") on the Xen Orchestra of today, an array of
  // them on older ones: either way, a list of series.
  /** @param {any} by */
  const total = (by) => {
    const lines = by && typeof by === 'object' ? Object.values(by).filter(Array.isArray) : [];
    if (!lines.length) return null;
    const length = Math.max(...lines.map((l) => l.length));
    return Array.from({ length }, (_, i) => {
      const counted = lines.map((l) => l[i]).filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
      return counted.length ? Math.round(counted.reduce((a, b) => a + b, 0)) : null;
    }).slice(-NET_POINTS);
  };
  const rx = total(vifs.rx);
  const tx = total(vifs.tx);
  if (!rx || !tx || rx.length !== tx.length) return null;
  return { interval, end: end * 1000, rx, tx };
}

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
  const edge = edgeKey(r.edge);
  const grants = machineGrantsOf(r.grants);
  return { address, pin, plain, token: r.token, resourceSet: typeof r.resourceSet === 'string' ? r.resourceSet : null, user: typeof r.user === 'string' ? r.user : undefined, ...(edge ? { edge } : {}), ...(grants ? { grants } : {}) };
}

/**
 * THE KEY TO THE POOL'S EDGE ROUTERS, as the phone keeps it beside the token
 * after a policy job (edge-credentials.js): the key and secret, the routers'
 * certificate, and where Xen Orchestra last saw each router. Anything that
 * is not all of that is no key, and the pool is held without one.
 *
 * @param {any} e @returns {EdgeKey|null}
 */
export function edgeKey(e) {
  const b64 = /^[A-Za-z0-9+/]{80}$/;
  if (!e || typeof e !== 'object' || !b64.test(e.key) || !b64.test(e.secret) || !/^[0-9a-f]{64}$/.test(e.pin)) return null;
  const routers = (Array.isArray(e.routers) ? e.routers : [])
    .filter((/** @type {any} */ r) => r?.name === 'fleetwright-edge' || r?.name === 'fleetwright-edge-b')
    .slice(0, 2)
    .map((/** @type {any} */ r) => ({ name: String(r.name), address: typeof r.address === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(r.address) ? r.address : null }));
  return { key: e.key, secret: e.secret, pin: e.pin, routers };
}

export class XoPools {
  /**
   * @param {{
   *   connect?: typeof connectXo,
   *   connectPlain?: typeof connectXoPlain,
   *   now?: () => number,
   *   log?: { info: (m: string) => void, warn: (m: string) => void },
   *   holderFor?: string,
   * }} [opts]
   */
  constructor({ connect = connectXo, connectPlain = connectXoPlain, now = () => Date.now(), log, holderFor = '' } = {}) {
    /**
     * THE XEN ORCHESTRA THIS BOX WAS MADE TO HOLD, when it is a pool's own
     * machine (xo-holder.js), from FLEETWRIGHT_HOLDER_FOR. Its pool entry says
     * `holder`, and the coordinator asks it first. Empty everywhere else.
     */
    this.holderFor = String(holderFor || '');
    this.connect = connect;
    this.connectPlain = connectPlain;
    this.now = now;
    this.log = log || { info() {}, warn() {} };
    /** @type {Map<string, { owner: string, record: PoolRecord }>} keyed `owner address` */
    this.held = new Map();
    /** @type {Map<string, string>} owner → their Claude token, for the machines made for them */
    this.claude = new Map();
    /** @type {Map<string, string[]>} owner → their SSH public keys, for the machines made for them */
    this.ssh = new Map();
    /**
     * MACHINES THIS BOX MADE and has not yet handed a Claude login, by name:
     * the VM's id Xen Orchestra answered vm.create with, and whose it is. The
     * id is what tells the machine this box made from another VM somebody
     * gave the same name and tags, which any box holding the fleet's token can
     * make in its set. In memory, like the rest: a box that restarts before
     * its machine asks has nothing to hand it, and says so (`handLogin`).
     * @type {Map<string, { vm: string, owner: string, at: number }>}
     */
    this.made = new Map();
    /** @type {Map<string, Seen>} what the last look found, keyed as `held` */
    this.seen = new Map();
    /**
     * THE POOLS EACH TOKEN HAS SEEN, keyed as `held`, then by pool id: its
     * name, when it was last seen, and since when a look that reached Xen
     * Orchestra has not seen it. What makes "shows none of its pools" a fact
     * this box can report rather than a guess: Xen Orchestra answering with
     * an empty list is only news when the list used to have something in it.
     * In memory, like everything else here; a restart forgets it, and the
     * looks after it learn the pools again.
     * @type {Map<string, Map<string, Had>>}
     */
    this.had = new Map();
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
    /** @type {Map<string, string[]>} */
    const ssh = new Map();
    const stripped = (Array.isArray(accounts) ? accounts : []).map((a) => {
      const owner = String(a?.email || '').toLowerCase();
      const items = Array.isArray(a?.items) ? a.items : [];
      for (const i of items) {
        if (i?.name === 'claude' && typeof i.value === 'string' && CLAUDE_RE.test(i.value) && owner) claude.set(owner, i.value);
        if (i?.name === SSH_KEYS_ITEM && owner) ssh.set(owner, sshKeys(i.value));
        const record = owner ? poolRecord(String(i?.name || ''), i?.value) : null;
        if (record) held.set(`${owner} ${record.address}`, { owner, record });
      }
      return { ...a, items: items.filter((i) => !String(i?.name || '').startsWith(HYPERVISOR_ITEM)) };
    });
    // FORGOTTEN IS GONE: a pool missing from this answer is no longer held,
    // and what was seen of it goes with it.
    for (const k of [...this.seen.keys()]) if (!held.has(k)) this.seen.delete(k);
    for (const k of [...this.had.keys()]) if (!held.has(k)) this.had.delete(k);
    const added = [...held.keys()].filter((k) => !this.held.has(k));
    this.held = held;
    this.claude = claude;
    this.ssh = ssh;
    if (added.length) this.log.info(`sidecar: holding the token for ${added.map((k) => k.split(' ')[1]).join(', ')}`);
    return stripped;
  }

  /** For the health frame: what each held pool was last seen to have. Empty is "holds none". @returns {Seen[]} */
  report() {
    return [...this.held.keys()].map((k) => {
      const seen = this.seen.get(k) ?? { address: /** @type {any} */ (this.held.get(k)).record.address, owner: /** @type {any} */ (this.held.get(k)).owner, reachable: null, pools: [], images: [], networks: [], machines: [] };
      return this.holderFor && seen.address === this.holderFor ? { ...seen, holder: true } : seen;
    });
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
        // ONLY WHAT IS IN THE FLEET'S SET, of everything the token sees
        // (fleetSetOf): images, networks and machines alike.
        const set = await fleetSetOf(rpc);
        const images = templates
          .filter((t) => t?.tags?.includes?.(VM_IMAGE.tag) && typeof t.id === 'string' && set.objects.has(t.id))
          .map((t) => ({ id: String(t.id), name: String(t.name_label || VM_IMAGE.name).slice(0, 80), pool: t.$pool ?? null, poolName: names.get(t.$pool) ?? null }));
        await this.#sweep(rpc, set);
        // THE NETWORKS A MACHINE CAN GO ON besides the uplink: the pool's that
        // the fleet may use (what is in its set), for a machine that
        // should be reachable from the person's own network; and the group
        // networks, marked, which a machine joins as well as its own.
        const nets = /** @type {any[]} */ (Object.values((await rpc.call('xo.getAllObjects', { filter: { type: 'network' } })) || {}));
        // AND THE LABS, each with its kind and whether one of the fleet's
        // machines is on it: a lab holds one machine at a time.
        const vms = /** @type {any[]} */ (Object.values((await rpc.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {}));
        const labKinds = new Map(nets.filter((n) => labKind(n)).map((n) => [String(n.name_label), labKind(n)]));
        const occupied = labKinds.size ? await machinesOnNetworks(rpc, vms) : new Map();
        /** @type {Network[]} */
        const networks = nets
          .filter((n) => typeof n?.id === 'string' && n.name_label !== EDGE.uplink && set.objects.has(n.id))
          .map((n) => {
            const lab = labKind(n);
            const perPerson = lab ? labsEachOf([n], null) : null;
            return {
              id: String(n.id),
              name: String(n.name_label || n.id).slice(0, 80),
              pool: n.$pool ?? null,
              group: String(n.name_label || '').startsWith(GROUP_PREFIX),
              ...(lab ? { lab, taken: occupied ? (occupied.get(String(n.id))?.length ?? 0) > 0 : null } : {}),
              // And how many labs one person may hold on its pool, when the
              // policy set a number. Absent is no limit, never 0.
              ...(perPerson !== null ? { perPerson } : {}),
            };
          });
        // AND THE MACHINES MADE THERE, what each is and where it is, for the
        // phone's page of it. Read after the sweep, so a removed one is gone.
        const imageNames = new Map(templates.map((t) => [t.id, String(t.name_label || '').slice(0, 80)]));
        const machines = vms
          .filter((v) => Array.isArray(v?.tags) && v.tags.includes(VM_IMAGE.sessionTag) && /^vm-[0-9a-f]{12}$/.test(String(v.name_label)) && inFleetSet(v, set))
          .map((v) => {
            const until = Number(tagValue(v, VM_IMAGE.untilPrefix));
            const made = Number(tagValue(v, MADE_PREFIX));
            const from = tagValue(v, FROM_PREFIX);
            return {
              name: String(v.name_label),
              vm: String(v.id),
              state: typeof v.power_state === 'string' ? v.power_state : null,
              ip: ipOf(v),
              until: Number.isFinite(until) && until > 0 ? until * 1000 : null,
              madeAt: Number.isFinite(made) && made > 0 ? made * 1000 : null,
              cpus: Number.isInteger(v?.CPUs?.number) ? v.CPUs.number : null,
              memory: Number.isFinite(Number(v?.memory?.size)) ? Number(v.memory.size) : null,
              image: from ? imageNames.get(from) ?? null : null,
              network: tagValue(v, ON_PREFIX),
              group: tagValue(v, GROUP_TAG),
              groupIp: tagValue(v, GROUP_IP_TAG),
              // In a lab: which, and whether it is open, by that network's tag.
              lab: (() => {
                const inLab = tagValue(v, LAB_TAG);
                const kind = inLab ? labKinds.get(inLab) : null;
                return inLab && kind ? { name: inLab, open: kind === 'open' } : null;
              })(),
              net: /** @type {Traffic|null} */ (null),
            };
          });
        // AND WHAT EACH RUNNING ONE DID ON THE NETWORK, one at a time. A pool
        // that will not say is cannot tell for that machine, not a reason to
        // report nothing for the rest.
        for (const m of machines) {
          if (m.state !== 'Running') continue;
          m.net = trafficFrom(await rpc.call('vm.stats', { id: m.vm, granularity: 'minutes' }).catch(() => null));
        }
        const listed = pools.map((p) => ({ id: String(p.id), name: names.get(p.id) || '' }));
        const gone = this.#missing(k, listed);
        this.seen.set(k, { address: record.address, owner, reachable: true, pools: listed, images, networks, machines, ...gone });
      } catch (e) {
        // NOT SEEN IS NOT MISSING. A look that did not reach Xen Orchestra
        // says nothing about its pools, so the clocks on the ones already
        // missing stop: the next look that reaches it starts them again,
        // rather than count an outage of this box's as time a pool was gone.
        for (const h of this.had.get(k)?.values() ?? []) h.missingSince = null;
        this.seen.set(k, { address: record.address, owner, reachable: false, pools: [], images: [], networks: [], machines: [], problem: String(/** @type {Error} */ (e).message).slice(0, 200) });
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
   * What a look that reached Xen Orchestra says of the pools this token saw
   * before: each one listed now is remembered as seen; each one not listed
   * is missing from this look on, and forgotten a day after it was last seen
   * (MISSING_FORGET_MS). For the health frame, `missing` names them and
   * `missingFor` is how long the longest has been missing, as a duration so
   * the coordinator's clock need not agree with this one; both are left out
   * when nothing is missing, and Xen Orchestra showing no pools with none
   * remembered is `pools: []` and nothing else.
   *
   * @param {string} k  as `held` is keyed
   * @param {Array<{ id: string, name: string }>} listed  what this look saw
   * @returns {{ missing?: Array<{ id: string, name: string }>, missingFor?: number }}
   */
  #missing(k, listed) {
    const now = this.now();
    const had = this.had.get(k) ?? new Map();
    for (const p of listed) had.set(p.id, { name: p.name, seenAt: now, missingSince: null });
    const here = new Set(listed.map((p) => p.id));
    for (const [id, h] of had) {
      if (here.has(id)) continue;
      if (now - h.seenAt >= MISSING_FORGET_MS) had.delete(id);
      else h.missingSince ??= now;
    }
    this.had.set(k, had);
    const gone = [...had].filter(([, h]) => h.missingSince !== null);
    if (!gone.length) return {};
    return {
      missing: gone.map(([id, h]) => ({ id, name: h.name })),
      missingFor: Math.max(...gone.map(([, h]) => now - /** @type {number} */ (h.missingSince))),
    };
  }

  /**
   * Machines that are done, removed with their disks: stopped past their end
   * (a machine powers itself off at its end), or still running well past the
   * end it was given. Only machines this fleet made, by their tag and made in
   * its set (fleetSetOf: the tag alone is anybody's); nothing else on the
   * pool is touched.
   *
   * STOPPED IS NOT DONE UNTIL ITS END HAS COME. It used to be: every stopped
   * machine went, and with it two that were not done. One just made, which
   * vm.create clones and tags before it boots, so a box looking in that
   * window removed it before it ran once; and one a host reboot or an
   * evacuation stopped mid-session, with its disk and the session's work on
   * it. Now a stopped machine goes only when it is older than YOUNG_MS and
   * past its end. Younger, it is left to boot. Older but before its end, it
   * is started again, once (RESTARTED_PREFIX says it was): stopped again
   * after that, somebody meant it, and it waits for its end. A machine
   * without an end in its tags was never given one to wait for, and goes as
   * it did; this box makes none like that. The running case is as it was.
   *
   * @param {any} rpc @param {{ ids: Set<string> }} set
   */
  async #sweep(rpc, set) {
    const vms = /** @type {any[]} */ (Object.values((await rpc.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {}));
    const now = this.now();
    for (const vm of vms) {
      const tags = Array.isArray(vm?.tags) ? vm.tags : [];
      if (!tags.includes(VM_IMAGE.sessionTag) || !inFleetSet(vm, set)) continue;
      if (await this.#busy(rpc, vm, tags, now)) continue;
      const name = vm.name_label || vm.id;
      const untilTag = tagValue(vm, VM_IMAGE.untilPrefix);
      const until = untilTag === null ? NaN : Number(untilTag) * 1000;
      const overdue = Number.isFinite(until) && now > until + GRACE_MS;
      if (vm.power_state !== 'Halted' && !overdue) continue;
      if (vm.power_state === 'Halted') {
        const made = Number(tagValue(vm, MADE_PREFIX)) * 1000;
        if (made > 0 && now - made < YOUNG_MS) continue;
        if (Number.isFinite(until) && now <= until) {
          if (tagValue(vm, RESTARTED_PREFIX) !== null) continue;
          try {
            await rpc.call('tag.add', { id: vm.id, tag: `${RESTARTED_PREFIX}${Math.floor(now / 1000)}` });
            await rpc.call('vm.start', { id: vm.id });
            this.log.info(`sidecar: started ${name} again, which was stopped ${Math.round((until - now) / 60_000)} minutes before its end`);
          } catch (e) {
            this.log.warn(`sidecar: could not start ${name} again, stopped before its end: ${/** @type {Error} */ (e).message}`);
          }
          continue;
        }
      }
      try {
        if (vm.power_state !== 'Halted') await rpc.call('vm.stop', { id: vm.id, force: true });
        await rpc.call('vm.delete', { id: vm.id, deleteDisks: true });
        this.log.info(`sidecar: removed ${name}, which had ${overdue && vm.power_state !== 'Halted' ? 'run past its end' : 'stopped'}`);
      } catch (e) {
        this.log.warn(`sidecar: could not remove ${name}: ${/** @type {Error} */ (e).message}`);
      }
    }
  }

  /**
   * Whether the sweep leaves this machine be because a resize has it: marked
   * busy less than BUSY_MS ago (BUSY_PREFIX). A mark older than that is a
   * resize that never finished, from a sidecar that died in the middle, and
   * is taken off so the machine is swept by the rules again. A bare mark
   * from an older box is dated from now and honoured, this once.
   *
   * @param {any} rpc @param {any} vm @param {string[]} tags @param {number} now
   * @returns {Promise<boolean>}
   */
  async #busy(rpc, vm, tags, now) {
    let stamp = tagValue(vm, BUSY_PREFIX);
    if (tags.includes(BUSY_TAG)) {
      if (stamp === null) {
        stamp = String(Math.floor(now / 1000));
        await rpc.call('tag.add', { id: vm.id, tag: `${BUSY_PREFIX}${stamp}` }).catch(() => {});
      }
      await rpc.call('tag.remove', { id: vm.id, tag: BUSY_TAG }).catch(() => {});
    }
    if (stamp === null) return false;
    const since = Number(stamp) * 1000;
    if (since > 0 && now - since < BUSY_MS) return true;
    await rpc.call('tag.remove', { id: vm.id, tag: `${BUSY_PREFIX}${stamp}` }).catch(() => {});
    this.log.warn(`sidecar: ${vm.name_label || vm.id} was marked busy ${since > 0 ? `${Math.round((now - since) / 60_000)} minutes ago` : 'at no time it could say'}, longer than a resize takes, so the mark is taken off`);
    return false;
  }

  /**
   * Make a machine from an image, for the person whose pool it is. Answers
   * the reply the coordinator relays: `unreachable` when the pool could not
   * be reached, which is the one refusal another box might not have.
   *
   * IN A LAB (`lab`), `network` names one of the pool's lab networks, which
   * must be one this box saw and saw empty, and the machine goes on it alone:
   * no uplink, no fence (nothing else is on a lab's network) and no group. It
   * is then checked to be the only machine there, because another box may
   * have put one on the same lab at the same moment; the later one is removed.
   *
   * @param {{ owner: string, template: string, ticket: string, minutes?: number|null, network?: string|null, group?: string|null, lab?: boolean, coordinatorUrl: string }} ask
   * @returns {Promise<{ ok: boolean, text: string, unreachable?: boolean, vm?: string }>}
   */
  async make({ owner, template, ticket, minutes = null, network = null, group = null, lab = false, coordinatorUrl }) {
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
    // A NETWORK OF THE PERSON'S CHOOSING, only one this box saw for that pool.
    const samePool = (/** @type {Network} */ n) => !image.pool || !n.pool || n.pool === image.pool;
    // A LAB, only one of the pool's lab networks, and only one seen empty.
    const labNet = lab ? this.seen.get(k)?.networks.find((n) => n.id === network && n.lab && samePool(n)) : null;
    if (lab && !labNet) return { ok: false, text: 'That is not a lab this box saw on your pool, so the machine was not made.' };
    if (lab && group) return { ok: false, text: 'A machine in a lab is on the lab’s network alone, so it joins no group. It was not made.' };
    if (labNet && labNet.taken !== false) {
      return { ok: false, text: `${labNet.name} ${labNet.taken ? 'has a machine on it' : 'could not be seen to be empty'}, so the machine was not made. Choose another lab.` };
    }
    const chosenNet = network && !lab ? this.seen.get(k)?.networks.find((n) => n.id === network && !n.group && !n.lab && samePool(n)) : null;
    if (network && !lab && !chosenNet) return { ok: false, text: 'That network is not one this box saw on your pool, so the machine was not made.' };
    // A GROUP NETWORK, as well as its own: only one of the pool's group networks.
    const groupNet = group ? this.seen.get(k)?.networks.find((n) => n.id === group && n.group && samePool(n)) : null;
    if (group && !groupNet) return { ok: false, text: 'That is not a group network this box saw on your pool, so the machine was not made.' };
    const life = Math.max(5, Math.min(MAX_MINUTES, Number(minutes) || DEFAULT_MINUTES));
    const made = Math.floor(this.now() / 1000);
    const until = made + life * 60;
    const claude = this.claude.get(who) ?? null;
    const keys = this.ssh.get(who) ?? [];
    // NOT the Claude login: that is handed over once the machine has joined
    // (handLogin), so the drive holds nothing of the person's but their
    // public keys, and a ticket that is spent as the machine boots.
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
      const on = labNet ? { id: labNet.id, name: labNet.name } : chosenNet ?? (uplink ? { id: String(uplink.id), name: EDGE.uplink } : null);
      // ITS PLACE ON THE GROUP NETWORK: a MAC and an address from its ticket's
      // id, the address moved along past any a machine in that group has.
      /** @type {{ mac: string, address: string }|null} */
      let joined = null;
      if (groupNet) {
        const vms = /** @type {any[]} */ (Object.values((await rpc.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {}));
        const taken = new Set(vms.filter((v) => tagValue(v, GROUP_TAG) === groupNet.name).map((v) => tagValue(v, GROUP_IP_TAG)));
        joined = groupPlace(m[1], taken);
      }
      const vm = await rpc.call('vm.create', {
        template,
        name_label: name,
        name_description: `A temporary machine for ${who}${labNet ? `, in ${labNet.name}` : ''}, made by Fleetwright. It powers off by itself at its end and is then removed.`,
        ...(record.resourceSet ? { resourceSet: record.resourceSet } : {}),
        ...(on || joined ? { VIFs: [...(on ? [{ network: on.id }] : []), ...(joined && groupNet ? [{ network: groupNet.id, mac: joined.mac }] : [])] } : {}),
        tags: [
          VM_IMAGE.sessionTag,
          `${VM_IMAGE.untilPrefix}${until}`,
          `${MADE_PREFIX}${made}`,
          `${FROM_PREFIX}${template}`,
          `${FOR_PREFIX}${who}`,
          ...(on ? [`${ON_PREFIX}${on.name}`] : []),
          ...(joined && groupNet ? [`${GROUP_TAG}${groupNet.name}`, `${GROUP_IP_TAG}${joined.address}`] : []),
          ...(labNet ? [`${LAB_TAG}${labNet.name}`] : []),
        ],
        cloudConfig: machineCloudConfig({
          name,
          coordinatorUrl,
          ticket,
          owner: who,
          minutes: BACKSTOP_MINUTES,
          sshKeys: keys,
          // ON THE UPLINK, fenced from the machines beside it; on a network
          // of the person's choosing, or alone in a lab, left as it is.
          isolate: !chosenNet && !labNet && on ? { subnet: UPLINK_SUBNET, gateway: EDGE.lan.address } : null,
          group: joined ? { mac: joined.mac, address: `${joined.address}/16` } : null,
          // WHAT IT MAY DO FROM CHAT, as its owner chose on the pool's
          // policy and kept in the pool's record (src/core/grants.js).
          grants: record.grants ?? null,
        }),
        // The drive holds the ticket: wiped from inside as the machine's
        // first act (the join script), before it spends it, and destroyed by
        // Xen Orchestra five minutes after the machine has booted (5.211.0's
        // vdiDelayBeforeRemovingCloudConfigDrive).
        destroyCloudConfigVdiAfterBoot: true,
        bootAfterCreate: true,
      });
      // ALONE IN ITS LAB: another box may have put a machine on the same lab
      // in the same moment. The one made second goes.
      if (labNet) {
        const all = /** @type {any[]} */ (Object.values((await rpc.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {}));
        const on = await machinesOnNetworks(rpc, all);
        const there = (on?.get(labNet.id) ?? []).filter((id) => id !== String(vm));
        const first = there.some((id) => {
          const other = all.find((v) => v?.id === id);
          const at = Number(tagValue(other, MADE_PREFIX));
          return !(at > made) && !(at === made && String(other?.name_label) > name);
        });
        if (on === null || first) {
          await rpc.call('vm.stop', { id: vm, force: true }).catch(() => {});
          await rpc.call('vm.delete', { id: vm, deleteDisks: true }).catch(() => {});
          return { ok: false, text: `${labNet.name} ${on === null ? 'could not be seen to be yours alone' : 'was taken a moment ago by another machine'}, so the machine was removed again. Choose another lab.` };
        }
      }
      this.#noteMade(name, { vm: String(vm), owner: who, at: this.now() });
      this.log.info(`sidecar: made ${name} from ${image.name} on ${record.address} for ${who}${labNet ? ` in ${labNet.name}` : ''}`);
      return {
        ok: true,
        vm: String(vm),
        text:
          `Making ${name} from ${image.name}${image.poolName ? ` on ${image.poolName}` : ''}${chosenNet ? `, on ${chosenNet.name}` : ''}` +
          `${labNet ? `, in ${labNet.name}: ${labNet.lab === 'open' ? 'it reaches the internet and nothing private' : 'it reaches the fleet and Claude and nothing else'}` : ''}` +
          `${joined && groupNet ? `, with the others on ${groupNet.name} at ${joined.address}` : ''}. ` +
          `It joins the fleet as your temporary machine in a minute or two, for ${life} minutes` +
          `${claude ? '' : ', and has no Claude login of yours to run on: keep one in your vault'}.`,
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

  /**
   * Remember a machine this box made, for its login (handLogin). Bounded:
   * a machine that never asks is forgotten after a day, and the oldest goes
   * first past the cap.
   *
   * @param {string} name @param {{ vm: string, owner: string, at: number }} made
   */
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
   * THE CLAUDE LOGIN for a machine this box made, once the machine has
   * enrolled and asked over its own socket (the coordinator relays it as
   * `vmlogin`). Sealed to `key`, which only that machine holds, so the
   * coordinator carries what it cannot read.
   *
   * ONLY A MACHINE MADE HERE, FOR THAT PERSON, STILL RUNNING, ONCE. Made
   * here is the VM's id this box noted at vm.create, not its name or tags:
   * any box holding the fleet's token can make a VM in the set with both. It
   * must still carry that name and be running, so a machine somebody
   * stopped, paused or replaced is handed nothing; and it is handed once, so
   * a second ask, which would be the coordinator's or a copy's, is refused.
   * `notHere` when this box did not make it, so the coordinator asks the
   * next; after a restart this box made nothing, as far as it knows.
   *
   * @param {{ owner: string, name: string, key: string }} ask
   * @returns {Promise<{ ok: boolean, text: string, sealed?: any, notHere?: boolean, unreachable?: boolean }>}
   */
  async handLogin({ owner, name, key }) {
    const who = String(owner || '').toLowerCase();
    const made = this.made.get(String(name));
    if (!made || made.owner !== who) return { ok: false, notHere: true, text: `${name} was not made by this box for ${who}, as far as it knows.` };
    const token = this.claude.get(who);
    if (!token) return { ok: false, text: `This box holds no Claude login of ${who}\u2019s to hand ${name}. Keep one in your vault (claude setup-token), then ask for the machine again.` };
    const mine = [...this.held.values()].filter((h) => h.owner === who);
    /** @type {string[]} */
    const unreachable = [];
    for (const { record } of mine) {
      /** @type {any} */
      let rpc = null;
      try {
        try {
          rpc = await this.#signIn(record);
        } catch (e) {
          unreachable.push(`${record.address}: ${/** @type {Error} */ (e).message}`);
          continue;
        }
        const vms = /** @type {any[]} */ (Object.values((await rpc.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {}));
        const vm = vms.find((v) => String(v?.id) === made.vm);
        if (!vm) continue;
        const set = await fleetSetOf(rpc);
        if (vm.name_label !== name || tagValue(vm, FOR_PREFIX) !== who || !inFleetSet(vm, set)) {
          this.made.delete(String(name));
          return { ok: false, text: `${name} is not the machine this box made any more, so it is handed nothing.` };
        }
        if (vm.power_state !== 'Running') return { ok: false, text: `${name} is ${String(vm.power_state || 'not running').toLowerCase()}, so it is handed nothing.` };
        this.made.delete(String(name));
        const sealed = await seal({ to: key, aad: await claudeBindingFor(key), payload: { token } });
        this.log.info(`sidecar: handed ${name} ${who}\u2019s Claude login`);
        return { ok: true, text: `Handed ${name} your Claude login.`, sealed };
      } catch (e) {
        return { ok: false, text: `${record.address} would not say whether ${name} is the machine made here: ${/** @type {Error} */ (e).message}` };
      } finally {
        try {
          rpc?.close();
        } catch {
          /* closing */
        }
      }
    }
    if (mine.length && unreachable.length === mine.length) return { ok: false, unreachable: true, text: `Your pools could not be reached from here: ${unreachable.join('; ')}` };
    this.made.delete(String(name));
    return { ok: false, text: `${name} is not on any of your pools any more, so it is handed nothing.` };
  }

  /**
   * Work a machine already made: restart it, give it longer, change its size,
   * or end it now. For the person it was made for, on one of their pools.
   *
   * Answers `notHere` when none of this person's pools this box holds has it,
   * and `unreachable` when none of them could be reached: either way the
   * coordinator asks the next box holding their pools.
   *
   * @param {{ owner: string, name: string, action: 'reboot'|'extend'|'resize'|'stop', minutes?: number|null, cpus?: number|null, memory?: number|null }} ask
   *   memory in GiB
   * @returns {Promise<{ ok: boolean, text: string, notHere?: boolean, unreachable?: boolean, until?: number }>}
   */
  async control({ owner, name, action, minutes = null, cpus = null, memory = null }) {
    const who = String(owner || '').toLowerCase();
    if (!/^vm-[0-9a-f]{12}$/.test(String(name))) return { ok: false, text: 'That is not the name of a machine this fleet made.' };
    // The pool it was last seen on first, then the rest of this person's.
    const mine = [...this.held.entries()].filter(([, h]) => h.owner === who);
    mine.sort(([a], [b]) => Number(this.#saw(b, name)) - Number(this.#saw(a, name)));
    if (!mine.length) return { ok: false, notHere: true, text: 'This box holds none of your pools.' };
    /** @type {string[]} */
    const unreachable = [];
    for (const [k, { record }] of mine) {
      /** @type {any} */
      let rpc = null;
      try {
        try {
          rpc = await this.#signIn(record);
        } catch (e) {
          unreachable.push(`${record.address}: ${/** @type {Error} */ (e).message}`);
          continue;
        }
        const vms = /** @type {any[]} */ (Object.values((await rpc.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {}));
        // Made in the fleet's set, or it is somebody else's VM by that name.
        const set = await fleetSetOf(rpc);
        const vm = vms.find((v) => v?.name_label === name && Array.isArray(v.tags) && v.tags.includes(VM_IMAGE.sessionTag) && inFleetSet(v, set));
        if (!vm) continue;
        // MADE FOR SOMEBODY ELSE on the same Xen Orchestra is not there, as
        // far as this person is concerned.
        if (tagValue(vm, FOR_PREFIX) !== who) continue;
        const r = await this.#work(rpc, vm, { action, minutes, cpus, memory });
        if (r.ok) void this.refresh().catch(() => {});
        return r;
      } catch (e) {
        return { ok: false, text: `${record.address} would not do that: ${/** @type {Error} */ (e).message}` };
      } finally {
        try {
          rpc?.close();
        } catch {
          /* closing */
        }
      }
    }
    if (unreachable.length === mine.length) return { ok: false, unreachable: true, text: `Your pools could not be reached from here: ${unreachable.join('; ')}` };
    return { ok: false, notHere: true, text: `${name} is not on any of your pools this box holds.` };
  }

  /**
   * WHERE THE POOL'S EDGE ROUTERS ARE NOW, as Xen Orchestra has them from
   * their guest agent, read with the person's own token: router name to WAN
   * address, for the box watching them (edge-watch.js).
   *
   * Asked for because the addresses the policy job handed on were the ones
   * Xen Orchestra knew then, and a router's guest agent arrives with its first
   * daily update, after the job: every router built that way stayed "did not
   * know its address" for good, though Xen Orchestra had known it for days.
   *
   * BY TAG, WHICH ANYBODY CAN ADD, and that is all right here: the address is
   * only where the watcher knocks, and it sends the key only to the routers'
   * own certificate (edge-watch.js #call). A running router is taken before
   * one that is stopped. Null is could not ask, never "has none".
   *
   * @param {string} key  `owner address`, as `held` keeps it
   * @returns {Promise<Map<string, string>|null>}
   */
  async edgeAddresses(key) {
    const held = this.held.get(key);
    if (!held) return null;
    /** @type {any} */
    let rpc = null;
    try {
      rpc = await this.#signIn(held.record);
      const vms = /** @type {any[]} */ (Object.values((await rpc.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {}));
      const edges = vms
        .filter((v) => Array.isArray(v?.tags) && v.tags.includes(EDGE.tag))
        .sort((a, b) => Number(b?.power_state === 'Running') - Number(a?.power_state === 'Running'));
      /** @type {Map<string, string>} */
      const out = new Map();
      for (const v of edges) {
        const name = v.tags.includes(`${EDGE_HA.nodeTag}1`) ? EDGE_HA.second : EDGE.vm;
        const ip = wanAddressOf(v);
        if (ip && !out.has(name)) out.set(name, ip);
      }
      return out;
    } catch {
      return null;
    } finally {
      try {
        rpc?.close();
      } catch {
        /* closing */
      }
    }
  }

  /**
   * A POOL'S PAGE, read here for a phone that cannot reach the pool from
   * where it is (`xolook`; docs/manage.md, "From away"). The same reads the
   * phone makes on the pool's own network, under the same person's token:
   * the methods it may call, then each object type the page draws, cut to
   * the fields the page shows (PAGE_FIELDS), sealed to the key the phone
   * made for this look.
   *
   * Answers `notHere` when this box holds no token of theirs for that
   * address, and `unreachable` when it could not sign in there: either way
   * the coordinator asks the next box that holds one.
   *
   * @param {{ owner: string, address: string, reply: string }} ask
   * @returns {Promise<{ ok: boolean, text: string, notHere?: boolean, unreachable?: boolean, sealed?: { epk: string, iv: string, ct: string } }>}
   */
  async look({ owner, address, reply }) {
    const held = this.held.get(`${String(owner || '').toLowerCase()} ${address}`);
    if (!held) return { ok: false, notHere: true, text: `This box holds no token of yours for ${address}.` };
    /** @type {any} */
    let rpc = null;
    try {
      try {
        rpc = await this.#signIn(held.record);
      } catch (e) {
        return { ok: false, unreachable: true, text: `${address} could not be reached from here: ${/** @type {Error} */ (e).message}` };
      }
      // ALL AT ONCE, on the one connection: the method list and each object
      // type are asked together and answered by id, where one after another
      // was seven round trips to Xen Orchestra before the phone saw anything.
      const [listedR, ...gotR] = await Promise.allSettled([
        rpc.call('system.getMethodsInfo'),
        ...PAGE_TYPES.map((type) => rpc.call('xo.getAllObjects', { filter: { type } })),
      ]);
      // A LIST THAT COULD NOT BE READ IS NOT AN EMPTY ONE, here as on the
      // phone: null offers no action, an empty list would say there are none.
      /** @type {string[]|null} */
      let methods = null;
      const listed = listedR.status === 'fulfilled' ? listedR.value : null;
      if (listed && typeof listed === 'object') methods = Object.keys(listed).slice(0, 2000);
      /** @type {Record<string, any>[]} */
      const objects = [];
      if (!methods || methods.includes('xo.getAllObjects')) {
        for (const got of gotR) {
          if (got.status === 'rejected') throw got.reason;
          for (const o of Object.values(got.value || {})) {
            const kept = pageObject(o);
            if (kept) objects.push(kept);
          }
        }
      }
      const page = { v: 1, methods, objects };
      // WHAT THE FLEET CARRIES IN ONE MESSAGE is a megabyte, and a sealed
      // answer is a third larger than what it seals. A pool this size is
      // said to be one, rather than cut short and shown as if it were whole.
      const bytes = new TextEncoder().encode(JSON.stringify(page)).length;
      if (bytes > MAX_PAGE_BYTES) {
        return { ok: false, text: `${address}\u2019s page is ${Math.round(bytes / 1024)} KB, more than the fleet carries in one answer (${MAX_PAGE_BYTES / 1024} KB). Open it from the pool\u2019s own network.` };
      }
      const sealed = await seal({ to: reply, aad: xolookAad(address), payload: page });
      return { ok: true, text: `Read ${address} through this machine.`, sealed };
    } catch (e) {
      return { ok: false, text: `${address} would not show its page: ${/** @type {Error} */ (e).message}` };
    } finally {
      try {
        rpc?.close();
      } catch {
        /* closing */
      }
    }
  }

  /**
   * One of the page's actions, done here for a phone away from the pool
   * (`xoact`). The method and its arguments are held to the shape the page
   * sends (XO_ACTION_ARGS) again, whatever the coordinator checked, and
   * called under the person's own token, so Xen Orchestra decides what that
   * token may do, as it would for the phone.
   *
   * @param {{ owner: string, address: string, method: string, args: unknown }} ask
   * @returns {Promise<{ ok: boolean, text: string, notHere?: boolean, unreachable?: boolean }>}
   */
  async act({ owner, address, method, args }) {
    const checked = xoActionArgs(method, args);
    if (!checked.ok) return { ok: false, text: checked.error };
    const held = this.held.get(`${String(owner || '').toLowerCase()} ${address}`);
    if (!held) return { ok: false, notHere: true, text: `This box holds no token of yours for ${address}.` };
    /** @type {any} */
    let rpc = null;
    try {
      try {
        rpc = await this.#signIn(held.record);
      } catch (e) {
        return { ok: false, unreachable: true, text: `${address} could not be reached from here: ${/** @type {Error} */ (e).message}` };
      }
      await rpc.call(method, checked.args);
      this.log.info(`sidecar: ${method} on ${address} for ${held.owner}, from away`);
      return { ok: true, text: `${address} did it.` };
    } catch (e) {
      // AN ANSWER THAT DID NOT COME IN TIME is not a no. A clean shutdown can
      // take longer than the minute a call waits, and Xen Orchestra goes on
      // with it either way, so this says so rather than that it failed.
      const why = /** @type {Error} */ (e).message;
      if (/did not answer .* in time/.test(why)) {
        return { ok: false, text: `${address} had not finished within a minute. It may still be doing it; the page shows it when it has.` };
      }
      return { ok: false, text: `${address} refused it: ${why}` };
    } finally {
      try {
        rpc?.close();
      } catch {
        /* closing */
      }
    }
  }

  /**
   * A clean restart or stop where the machine can take one, a hard one
   * otherwise. CLEAN NEEDS THE GUEST AGENT: Xen Orchestra's own API says so
   * (`clean_reboot`: "Requires guest tools to be installed"), and the image
   * installs it only where the distribution has it. A machine that never
   * said it has the agent, or refuses the clean one, gets the hard one: it
   * is disposable, and the session on it ends either way.
   *
   * @param {any} rpc @param {'vm.restart'|'vm.stop'} method @param {any} vm
   */
  async #cleanOrHard(rpc, method, vm) {
    const agent = vm?.managementAgentDetected === true || vm?.pvDriversDetected === true;
    if (agent) {
      try {
        return await rpc.call(method, { id: vm.id, force: false });
      } catch (e) {
        this.log.warn(`sidecar: ${vm.name_label} refused a clean ${method === 'vm.stop' ? 'stop' : 'restart'} (${/** @type {Error} */ (e).message}), so a hard one`);
      }
    }
    return rpc.call(method, { id: vm.id, force: true });
  }

  /** Whether the last look saw that machine on that pool. @param {string} k @param {string} name */
  #saw(k, name) {
    return Boolean(this.seen.get(k)?.machines?.some((m) => m.name === name));
  }

  /**
   * @param {any} rpc @param {any} vm
   * @param {{ action: string, minutes?: number|null, cpus?: number|null, memory?: number|null }} ask
   * @returns {Promise<{ ok: boolean, text: string, until?: number }>}
   */
  async #work(rpc, vm, { action, minutes, cpus, memory }) {
    const name = String(vm.name_label);
    if (action === 'reboot') {
      if (vm.power_state !== 'Running') return { ok: false, text: `${name} is not running, so there is nothing to restart.` };
      await this.#cleanOrHard(rpc, 'vm.restart', vm);
      this.log.info(`sidecar: restarted ${name}`);
      return { ok: true, text: `Restarting ${name}. A session that was running on it ends with the restart; the machine is back in the fleet in a minute or so.` };
    }
    if (action === 'stop') {
      if (vm.power_state !== 'Halted') await rpc.call('vm.stop', { id: vm.id, force: true });
      await rpc.call('vm.delete', { id: vm.id, deleteDisks: true });
      this.log.info(`sidecar: ended ${name} when asked`);
      return { ok: true, text: `${name} is stopped and removed with its disk.` };
    }
    if (action === 'extend') {
      // FROM WHEN IT WAS MADE, NOT FROM NOW: a machine's longest life is
      // fixed, so asking again and again does not keep one alive for ever.
      const made = Number(tagValue(vm, MADE_PREFIX));
      const until = Number(tagValue(vm, VM_IMAGE.untilPrefix));
      if (!Number.isFinite(made) || made <= 0 || !Number.isFinite(until) || until <= 0) {
        return { ok: false, text: `${name} does not say when it was made, so it cannot be given longer.` };
      }
      const cap = made + MAX_MINUTES * 60;
      const from = Math.max(until, Math.floor(this.now() / 1000));
      const next = Math.min(cap, from + Math.max(1, Number(minutes) || 0) * 60);
      if (next <= until) return { ok: false, text: `${name} already runs to the longest a machine can, ${MAX_MINUTES} minutes from when it was made.` };
      await rpc.call('tag.add', { id: vm.id, tag: `${VM_IMAGE.untilPrefix}${next}` });
      await rpc.call('tag.remove', { id: vm.id, tag: `${VM_IMAGE.untilPrefix}${until}` });
      this.log.info(`sidecar: ${name} now runs until ${new Date(next * 1000).toISOString()}`);
      const capped = next === cap ? `, the longest a machine can run` : '';
      return { ok: true, until: next * 1000, text: `${name} now runs until ${new Date(next * 1000).toISOString().slice(11, 16)} UTC${capped}.` };
    }
    if (action === 'resize') {
      /** @type {Record<string, number>} */
      const size = {};
      if (cpus != null) size.CPUs = Math.max(1, Math.min(64, Math.floor(Number(cpus))));
      if (memory != null) size.memory = Math.max(1, Math.min(512, Number(memory))) * 1024 ** 3;
      if (!Object.keys(size).length) return { ok: false, text: 'Say how many vCPUs, or how much memory.' };
      const said = [size.CPUs ? `${size.CPUs} vCPU${size.CPUs === 1 ? '' : 's'}` : null, size.memory ? `${size.memory / 1024 ** 3} GiB` : null].filter(Boolean).join(' and ');
      // STOPPED ON PURPOSE, which the sweep would otherwise take for done:
      // marked busy first, with the time (BUSY_PREFIX), and started again
      // whatever the change did.
      const busy = `${BUSY_PREFIX}${Math.floor(this.now() / 1000)}`;
      await rpc.call('tag.add', { id: vm.id, tag: busy });
      // What it had, of what is being changed, for when the change takes and
      // the machine will not start with it.
      /** @type {Record<string, number>} */
      const old = {
        ...(size.CPUs && Number.isInteger(vm?.CPUs?.number) ? { CPUs: vm.CPUs.number } : {}),
        ...(size.memory && Number.isFinite(Number(vm?.memory?.size)) && Number(vm.memory.size) > 0 ? { memory: Number(vm.memory.size) } : {}),
      };
      /** @type {Error|null} */
      let refused = null;
      let stuck = false;
      try {
        if (vm.power_state !== 'Halted') await this.#cleanOrHard(rpc, 'vm.stop', vm);
        try {
          await rpc.call('vm.set', { id: vm.id, ...size });
        } catch (e) {
          refused = /** @type {Error} */ (e);
        }
        try {
          await rpc.call('vm.start', { id: vm.id });
        } catch (e) {
          // WOULD NOT START WITH THE NEW SIZE (no host has that much memory
          // free: HOST_NOT_ENOUGH_FREE_MEMORY): the old size back, and started
          // again. This used to fall through to the sweep, which took the
          // stop for done and removed the machine with its disk. If it will
          // not start at its old size either, it is left stopped and marked
          // busy, so the sweep leaves it for BUSY_MS and then applies its
          // rules (started once more before its end, removed after it), and
          // the person is told what state it is in.
          const first = /** @type {Error} */ (e);
          const back = !refused && Object.keys(old).length > 0;
          if (back) await rpc.call('vm.set', { id: vm.id, ...old }).catch(() => {});
          try {
            await rpc.call('vm.start', { id: vm.id });
          } catch (again) {
            stuck = true;
            const why = refused
              ? `the pool would not give it ${said} (${refused.message}), and it would not start (${first.message}; then ${/** @type {Error} */ (again).message})`
              : `it would not start with ${said} (${first.message}), nor ${back ? 'at its old size' : 'on a second try'} (${/** @type {Error} */ (again).message})`;
            this.log.warn(`sidecar: ${name} is stopped after a resize: ${why}`);
            return {
              ok: false,
              text: `${name} is stopped: ${why}. It was not removed. It is left as it is for ${BUSY_MS / 60_000} minutes; after that the sweep starts it once more if its end has not come, and removes it when it has. Resize it again to try now, or end it.`,
            };
          }
          // Started on the second try: at its old size when that was put
          // back, which is a refusal of the new one; else at the new size,
          // which is what was asked for.
          if (back) refused ??= first;
        }
      } finally {
        if (!stuck) await rpc.call('tag.remove', { id: vm.id, tag: busy }).catch(() => {});
      }
      if (refused) return { ok: false, text: `${name} was restarted at its old size: the pool would not give it ${said} (${refused.message}).` };
      this.log.info(`sidecar: ${name} resized to ${said}`);
      return { ok: true, text: `${name} restarted with ${said}. A session that was running on it ended with the restart.` };
    }
    return { ok: false, text: `${action} is not something a machine can be asked to do.` };
  }
}

/**
 * A machine's place on a group network, from its ticket's id: a locally
 * administered MAC from the first five bytes, and an address in GROUP_RANGE
 * from the last two, moved along past any in `taken`. The id is random, so
 * two machines rarely start at the same address; when they do, the second
 * moves on.
 *
 * @param {string} id 12 hex characters @param {Set<string|null>} taken
 * @returns {{ mac: string, address: string }}
 */
export function groupPlace(id, taken) {
  const mac = ['02', ...(id.slice(0, 10).match(/../g) || [])].join(':');
  const slots = 256 * 254;
  const start = parseInt(id.slice(8, 12), 16) % slots;
  for (let n = 0; n < slots; n++) {
    const i = (start + n) % slots;
    const address = `10.200.${Math.floor(i / 254)}.${(i % 254) + 1}`;
    if (!taken.has(address)) return { mac, address };
  }
  throw new Error('that group network has no address left');
}

/**
 * The cloud-init a machine boots with: one file the join script reads, and
 * the join script, which enrols the machine with the ticket, starts the
 * services, and powers the machine off at its end. See
 * install/fleetwright-vm-join.
 *
 * NO CLAUDE LOGIN. Xen Orchestra lets every box holding the pool's token
 * export this drive until it is destroyed after boot (docs/security.md, G14),
 * so the login is asked for once the machine has enrolled, from the box that
 * made it (XoPools#handLogin), and only the ticket travels here.
 *
 * SSH, WHEN THE PERSON KEEPS KEYS: their public keys on the `fleetwright`
 * account, which may then use sudo. The machine is the sandbox, is theirs
 * alone and exists for one job (docs/hypervisors.md, "Inside the VM"); a
 * person who keeps no keys gets the account as the image made it.
 *
 * ITS NETWORK, when it is on the uplink or in a group: install/fleetwright-net
 * and the file it reads, run at every boot by a unit of its own and first at
 * this one, before the join script starts anything that listens.
 *
 * WHAT IT MAY DO FROM CHAT, when its owner chose on the pool's policy: the
 * join script runs `fleetwright grant` with each answer before the services
 * start (src/core/grants.js). Left out, it keeps the machine image's.
 *
 * @param {{
 *   name: string, coordinatorUrl: string, ticket: string, owner: string, minutes: number, sshKeys?: string[],
 *   isolate?: { subnet: string, gateway: string }|null, group?: { mac: string, address: string }|null,
 *   grants?: { upgrades?: boolean, reboot?: boolean }|null,
 * }} opts
 */
export function machineCloudConfig({ name, coordinatorUrl, ticket, owner, minutes, sshKeys: keys = [], isolate = null, group = null, grants = null }) {
  const allowed = machineGrantsOf(grants);
  const join = JSON.stringify({ v: 1, coordinator: new URL(coordinatorUrl).origin, ticket, owner, minutes, ...(allowed ? { grants: allowed } : {}) });
  const net = isolate || group ? JSON.stringify({ v: 1, ...(isolate ? { isolate } : {}), ...(group ? { group } : {}) }) : null;
  const block = (/** @type {string} */ text) => text.replace(/\n$/, '').split('\n').map((l) => (l ? `      ${l}` : ''));
  return [
    '#cloud-config',
    `hostname: ${name}`,
    ...(keys.length
      ? [
          'users:',
          '  - name: fleetwright',
          '    shell: /bin/bash',
          "    sudo: 'ALL=(ALL) NOPASSWD:ALL'",
          '    ssh_authorized_keys:',
          ...keys.map((key) => `      - ${JSON.stringify(key)}`),
        ]
      : []),
    'write_files:',
    '  - path: /run/fleetwright/join.json',
    "    permissions: '0600'",
    '    owner: root:root',
    '    content: |',
    `      ${join}`,
    ...(net
      ? [
          '  - path: /etc/fleetwright-net.json',
          "    permissions: '0644'",
          '    owner: root:root',
          '    content: |',
          `      ${net}`,
          '  - path: /usr/local/sbin/fleetwright-net',
          "    permissions: '0755'",
          '    owner: root:root',
          '    content: |',
          ...block(NET_SCRIPT()),
          '  - path: /etc/systemd/system/fleetwright-net.service',
          "    permissions: '0644'",
          '    owner: root:root',
          '    content: |',
          ...block(NET_UNIT),
        ]
      : []),
    'runcmd:',
    ...(net ? ['  - [systemctl, daemon-reload]', '  - [systemctl, enable, --now, fleetwright-net.service]'] : []),
    JOIN_RUNCMD,
    '',
  ].join('\n');
}
