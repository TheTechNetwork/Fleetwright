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
//   script made (`fleetwright-fence`), on the bridge, where nothing inside
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
import { PveApi, PVE_PORT } from './pve-api.js';
import { splitAddress } from './xo-ws.js';
import { seal, claudeBindingFor } from '../seal.js';
import { machineGrantsOf } from '../../core/grants.js';
import { lookup } from 'node:dns/promises';
import { HYPERVISOR_ITEM, MAX_MINUTES, isSshKeysItem, sshKeys, sshTarget, groupPlace } from './xo-pools.js';
import { fleetHosts } from './edge-router.js';
import { IMAGES, JOIN_RUNCMD } from './vm-image.js';

/** What a Proxmox record says it is, beside Xen Orchestra's, which says nothing. */
export const PVE_KIND = 'proxmox';
/** The tag on a Fleetwright machine image, and on a machine made from one. */
export const PVE_IMAGE_TAG = 'fleetwright-image';
/** Beside it, which image it is: `fleetwright-os-<key>`, a key of vm-image.js's IMAGES. */
export const PVE_OS_TAG = 'fleetwright-os-';

/**
 * WHICH IMAGE A TEMPLATE IS, as the setup script tags it (`templates_of`):
 * its `fleetwright-os-<key>` tag, or Debian 13 for one built before there
 * was a choice, which carried no such tag. Null for a key the catalogue does
 * not have, which is said as "could not tell", never as Debian.
 *
 * @param {string[]} tags @returns {string|null}
 */
export function pveImageKeyOf(tags) {
  const os = tags.find((t) => t.startsWith(PVE_OS_TAG));
  if (!os) return 'debian-13';
  const key = os.slice(PVE_OS_TAG.length);
  return Object.hasOwn(IMAGES, key) ? key : null;
}
export const PVE_SESSION_TAG = 'fleetwright-session';
/** The cluster security group the setup script makes and every machine is put behind. */
/** No longer than 18 characters, Proxmox's limit on a security group's name (the setup script says so too). */
export const PVE_FENCE_GROUP = 'fleetwright-fence';
/**
 * THE NETWORKS THE SETUP MAKES for labs and groups (install/fleetwright-pve-setup),
 * as SDN zones of their own: a group network is a VNet in `fwgrp`, a lab a
 * VNet in `fwlab` whose alias says its kind. Only the root setup can make an
 * SDN network, which is the same reason Xen Orchestra's policy job made them
 * with the admin sign-in: the fleet's token may use one, never make one.
 */
export const PVE_GROUP_ZONE = 'fwgrp';
export const PVE_LAB_ZONE = 'fwlab';
/**
 * THE EDGE ROUTER'S LAN, a network of its own the setup makes when asked for
 * one (install/fleetwright-pve-setup, step `edge`): a machine put on it
 * reaches the world only through the router, which filters what it does.
 */
export const PVE_EDGE_ZONE = 'fwedge';
/** The tag the setup gives the edge router, outside the pool, and the one beside it on a router that drops what the threat rules match. */
export const PVE_EDGE_TAG = 'fleetwright-edge';
/** The names the setup gives one router and the second of a pair, which are the names their syslog says. */
export const PVE_EDGE_NAMES = Object.freeze(['fleetwright-edge', 'fleetwright-edge-b']);
export const PVE_EDGE_BLOCKS_TAG = 'fleetwright-edge-blocks';
export const PVE_LAB_ALIAS = 'fleetwright-lab:';
/** The per-machine ipset a closed lab's HTTPS may go to. */
export const PVE_ALLOW_SET = 'fwallow';
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
  // THE ADDRESS ITS GUEST AGENT REPORTS, for "No address yet" to end and
  // SSH to be offered: `agent/network-get-interfaces`, which Proxmox VE 9
  // allows with this and nothing wider (it replaced VM.Monitor). Read only.
  'VM.GuestAgent.Audit',
  // A MACHINE'S SCREEN IN THE APP: `vncproxy` and `vncwebsocket`, which the
  // phone calls with the token it keeps, on a machine in the pool alone.
  'VM.Console',
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
/**
 * THE OLDEST PROXMOX THIS SPEAKS TO: 9. One API and one set of privilege
 * names, the ones the roles and the stand-in use; an older cluster is
 * reported and refused rather than half worked (docs/proxmox.md, "Which
 * Proxmox").
 */
export const PVE_MIN_MAJOR = 9;
/** How many machines a look reads the notes of: a pool is a fleet's, not a datacenter's. */
const MAX_MACHINES = 200;

/**
 * @typedef {{ address: string, token: string, pool: string, ca: string|null, trust: 'ca'|'public', name?: string, grants?: any, vmids?: { from: number, to: number }, edge?: { key: string, secret: string, pin: string } }} PveRecord
 * @typedef {{ id: string, name: string, key: string|null, os: string|null, node: string, vmid: number, pool: string|null, poolName: string|null, bridge: string|null }} PveImage
 * @typedef {{ id: string, name: string, pool: string|null, group: boolean, zone: string, lab?: 'open'|'closed', gateway?: string|null, taken?: boolean|null, edge?: boolean }} PveNetwork
 */

const TOKEN_RE = /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9._-]{1,64}![A-Za-z0-9._-]{1,64}=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POOL_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** A DNS name, as a certificate names a host: labels of letters, digits and hyphens, at least two. */
const HOST_NAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** One certificate block, where it sits in a file; its body is base64 alone, so a match never runs into the next. */
const PEM_BLOCK_RE = /-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]{100,8000}?)\r?\n-----END CERTIFICATE-----/g;
/** As many certificates as a CA file, or a leaf with its chain and root, holds. */
const MAX_CERTS = 8;

/**
 * THE CERTIFICATES IN A PEM FILE, and nothing else of it: each block, with
 * plain line ends, one after another. Null when it holds none, or more than
 * a chain does.
 *
 * Text around the blocks is left out rather than refused. A certificate a
 * person put on the web interface is often a file some tool wrote, with
 * Windows line ends or `subject=`/`Bag Attributes` lines between the blocks.
 * OpenSSL reads those files, the script's own check passes, and the phone
 * kept the line. Then every box refused it without a word, because this
 * required the field to be bare blocks. That is what the first real node
 * did: its cluster never appeared anywhere.
 *
 * @param {unknown} text @returns {string|null}
 */
export function certsOf(text) {
  if (typeof text !== 'string' || text.length > 64_000) return null;
  const blocks = [...text.matchAll(PEM_BLOCK_RE)].map((m) => `-----BEGIN CERTIFICATE-----\n${m[1].replace(/\r/g, '')}\n-----END CERTIFICATE-----\n`);
  return blocks.length && blocks.length <= MAX_CERTS ? blocks.join('') : null;
}

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

/**
 * Why a vault item that says it is a Proxmox VE record is not one this box
 * can use, or null when it is one, or is not a Proxmox record at all (a Xen
 * Orchestra pool's, which xo-pools.js reads). For the journal: a record the
 * box passed over in silence is how a set-up cluster stayed out of sight.
 *
 * @param {string} name @param {unknown} value @returns {string|null}
 */
export function pveProblem(name, value) {
  if (!name.startsWith(HYPERVISOR_ITEM) || typeof value !== 'string') return null;
  /** @type {any} */
  let r;
  try {
    r = JSON.parse(value);
  } catch {
    return null;
  }
  if (r?.kind !== PVE_KIND) return null;
  return checked(r, name.slice(HYPERVISOR_ITEM.length)).problem;
}

/** @param {any} r @param {string|null} address  null takes the record's own @returns {PveRecord|null} */
function recordOf(r, address) {
  return checked(r, address).record;
}

/**
 * The record, or what is wrong with it in words a person can act on. Never
 * the token itself: the words go to a phone and into a journal.
 *
 * @param {any} r @param {string|null} address
 * @returns {{ record: PveRecord, problem: null }|{ record: null, problem: string }}
 */
function checked(r, address) {
  const no = (/** @type {string} */ problem) => ({ record: null, problem });
  if (!r || typeof r !== 'object' || r.kind !== PVE_KIND) return no('it is not a Proxmox VE record');
  if (typeof r.address !== 'string' || !r.address) return no('it names no address');
  if (address !== null && r.address !== address) return no(`it names ${String(r.address).slice(0, 80)}, not ${address}`);
  if (typeof r.token !== 'string' || !TOKEN_RE.test(r.token)) return no('its token is not in the shape Proxmox VE makes one, user@realm!name=secret');
  if (typeof r.pool !== 'string' || !POOL_RE.test(r.pool)) return no('its pool name is not one Proxmox VE takes');
  // A RECORD SAYS HOW TO TRUST THE SERVER, and one that cannot is no record:
  // there is no plain HTTP here, because Proxmox has none, and no pin to a
  // certificate with the chain check turned off (pve-api.js).
  const ca = certsOf(r.ca);
  if (typeof r.ca === 'string' && r.ca && !ca) return no(`the certificate it carries holds no certificate block, or more than ${MAX_CERTS}`);
  /** @type {'ca'|'public'|null} */
  const trust = ca ? 'ca' : r.trust === 'public' ? 'public' : null;
  if (!trust) return no('it says neither which certificate to trust nor that the web interface has a publicly trusted one');
  // THE NAME A PUBLIC CERTIFICATE IS HELD TO, when the address is an IP
  // (pve-api.js). Only for public trust: a cluster's own CA is checked
  // without a name, and a name there would mean nothing.
  if (r.name !== undefined && r.name !== null && (typeof r.name !== 'string' || !HOST_NAME_RE.test(r.name))) return no('the host name its certificate is checked as is not a host name');
  const name = trust === 'public' && typeof r.name === 'string' ? r.name.toLowerCase() : null;
  const grants = machineGrantsOf(r.grants);
  const vmids = vmidsOf(r.vmids);
  const edge = edgeKeyOf(r.edge);
  return { record: { address: r.address, token: r.token, pool: r.pool, ca, trust, ...(name ? { name } : {}), ...(grants ? { grants } : {}), ...(vmids ? { vmids } : {}), ...(edge ? { edge } : {}) }, problem: null };
}

/**
 * THE EDGE ROUTER'S KEY, as the setup script made it and the line carried it
 * (install/fleetwright-pve-setup, `watch_keep`): the key and secret in the
 * shape OpenSSL's base64 of sixty bytes is, which holds neither `|` nor `:`,
 * and the SHA-256 of the router's certificate, which edge-watch.js holds the
 * connection to before the key is sent. Anything else is no key, and the
 * cluster is still held: its router is then not read, which the phone says.
 *
 * @param {any} e @returns {{ key: string, secret: string, pin: string }|null}
 */
export function edgeKeyOf(e) {
  const b64 = /^[A-Za-z0-9+/]{80}$/;
  if (!e || typeof e !== 'object' || !b64.test(String(e.key)) || !b64.test(String(e.secret)) || !/^[0-9a-f]{64}$/.test(String(e.pin))) return null;
  return { key: e.key, secret: e.secret, pin: e.pin };
}

/**
 * THE NUMBERS THE FLEET'S MACHINES TAKE, when the person gave a range at
 * setup (`--vmids`): from 100, as Proxmox numbers machines, the first no
 * larger than the last. Anything else is no range, and the cluster's next
 * free number is taken, as before there was one.
 *
 * @param {any} v @returns {{ from: number, to: number }|null}
 */
export function vmidsOf(v) {
  const from = Number(v?.from);
  const to = Number(v?.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 100 || to > 999_999_999 || from > to) return null;
  return { from, to };
}

/** How many numbers in a range one make looks at before it says the range is full. */
const VMID_LOOKS = 64;

/**
 * The line the setup script prints, as the record it carries. What the phone
 * does with a pasted line, and the one place its shape is defined; the app
 * keeps the record as `hypervisor:<address>`.
 *
 * @param {string} line @returns {PveRecord|null}
 */
export function parseConnection(line) {
  return connectionOf(line).record;
}

/**
 * The same, with what is wrong with a line that is not one: for the words
 * that say why a setup's hand-over stopped, which said only "not one the
 * fleet reads" and left nobody able to tell which part.
 *
 * @param {string} line
 * @returns {{ record: PveRecord, problem: null }|{ record: null, problem: string }}
 */
export function connectionOf(line) {
  const s = String(line || '').trim();
  if (!s) return { record: null, problem: 'the node left an empty line' };
  if (!s.startsWith(CONNECTION_PREFIX)) return { record: null, problem: `it does not start ${CONNECTION_PREFIX}` };
  /** @type {any} */
  let r;
  try {
    r = JSON.parse(Buffer.from(s.slice(CONNECTION_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    return { record: null, problem: `what follows ${CONNECTION_PREFIX} does not decode, so the line was cut or changed on the way` };
  }
  return checked(r, null);
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
 * @returns {{ for: string, until: number, made: number, from: string|null, on: string|null, busy: number|null, grp: string|null, gip: string|null, lab: string|null }|null}
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
    grp: typeof m.grp === 'string' ? m.grp : null,
    gip: typeof m.gip === 'string' ? m.gip : null,
    lab: typeof m.lab === 'string' ? m.lab : null,
  };
}

/** @param {{ for: string, until: number, made: number, from?: string|null, on?: string|null, busy?: number|null, grp?: string|null, gip?: string|null, lab?: string|null }} m */
export function markText(m) {
  const line = JSON.stringify({ v: 1, for: m.for, until: m.until, made: m.made, ...(m.from ? { from: m.from } : {}), ...(m.on ? { on: m.on } : {}), ...(m.busy ? { busy: m.busy } : {}), ...(m.grp ? { grp: m.grp } : {}), ...(m.gip ? { gip: m.gip } : {}), ...(m.lab ? { lab: m.lab } : {}) });
  return `A temporary machine for ${m.for}, made by Fleetwright. It powers off by itself at its end and is then removed.\n${MARK}${line}`;
}

/** The tag the setup gives the cluster's own machine, outside the pool (install/fleetwright-pve-setup). */
export const PVE_HOLDER_TAG = 'fleetwright-holder';

/** Proxmox's tags, which it keeps as one string split on `;` (and `,` and spaces on older versions). */
const tagsOf = (/** @type {any} */ v) => String(v?.tags || '').split(/[;,\s]+/).filter(Boolean);

/**
 * THE POOL'S MACHINES WITH THEIR TAGS, from `/cluster/resources`. Not from
 * `/pools/{id}`: Proxmox builds a pool's members from the run-time stats
 * alone (pve-manager, PVE/API2/Pool.pm, extract_vm_stats), which carry a
 * template flag but no tags, so every tag test on them failed. The first real
 * node showed it: its image was never seen, by this box or by the setup
 * script, which built another one on the next run. `/cluster/resources` adds
 * `tags` and `pool` to the same stats for every guest the token may audit.
 *
 * @param {any} api @param {string} pool
 * @returns {Promise<any[]>}
 */
async function poolVms(api, pool) {
  const all = await api.get('/cluster/resources', { type: 'vm' });
  return (Array.isArray(all) ? all : []).filter((m) => m?.type === 'qemu' && m.pool === pool);
}

/**
 * THE EDGE ROUTER, as the setup made it (install/fleetwright-pve-setup, step
 * `edge`), found as the cluster's own machine is: outside the pool, tagged,
 * and seen only by the VM.Audit the setup gave on it.
 *
 * @param {any} api @param {string} pool
 * @returns {Promise<Array<{ name: string, running: boolean, blocks: boolean }>>}
 */
async function edgeVms(api, pool) {
  const all = await api.get('/cluster/resources', { type: 'vm' }).catch(() => []);
  return (Array.isArray(all) ? all : [])
    .filter((m) => m?.type === 'qemu' && (m.pool ?? '') !== pool && Number(m.template) !== 1 && tagsOf(m).includes(PVE_EDGE_TAG))
    .map((m) => ({ name: String(m.name || '').slice(0, 80), running: m.status === 'running', blocks: tagsOf(m).includes(PVE_EDGE_BLOCKS_TAG) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * THE CLUSTER'S OWN MACHINE, as the setup made it (install/fleetwright-pve-setup,
 * step `holder`): outside the pool, so the token can do nothing to it, and
 * tagged. The token sees it only because the setup gave it VM.Audit on that
 * machine alone; a VM in the pool with the tag is anybody's who may tag the
 * pool's, so it is never taken for one.
 *
 * @param {any} api @param {string} pool
 * @returns {Promise<Array<{ name: string, running: boolean, vmid: number, node: string }>>}
 */
async function holderVms(api, pool) {
  const all = await api.get('/cluster/resources', { type: 'vm' }).catch(() => []);
  return (Array.isArray(all) ? all : [])
    .filter((m) => m?.type === 'qemu' && (m.pool ?? '') !== pool && Number(m.template) !== 1 && tagsOf(m).includes(PVE_HOLDER_TAG))
    .map((m) => ({ name: String(m.name || '').slice(0, 80), running: m.status === 'running', vmid: Number(m.vmid), node: String(m.node || '') }))
    .sort((a, b) => a.vmid - b.vmid);
}

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
 * grants it SDN.Use on, by zone. With none, a machine goes on its image's own
 * bridge, and nothing else is offered. A VNet in the group zone is a group
 * network; one in the lab zone is a lab when its alias names its kind, and
 * is not offered at all when it does not, since a lab whose kind is not known
 * cannot be promised to reach what it says.
 *
 * @param {Record<string, Record<string, number>>} perms @param {string} address
 * @param {Array<{ vnet?: string, zone?: string, alias?: string }>} [vnets]  /cluster/sdn/vnets
 * @param {Map<string, string>} [gateways]  lab VNet to its gateway
 * @returns {PveNetwork[]}
 */
export function networksOf(perms, address, vnets = [], gateways = new Map()) {
  /** @type {PveNetwork[]} */
  const out = [];
  const alias = new Map((Array.isArray(vnets) ? vnets : []).map((v) => [`${v?.zone}/${v?.vnet}`, String(v?.alias || '')]));
  for (const [path, privs] of Object.entries(perms || {})) {
    const m = /^\/sdn\/zones\/([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9_.-]{1,40})$/.exec(path);
    if (!m || !privs?.['SDN.Use']) continue;
    const [, zone, name] = m;
    const base = { id: pveIdOf(address, 'net', `${zone}/${name}`), name, pool: null, group: zone === PVE_GROUP_ZONE, zone, ...(zone === PVE_EDGE_ZONE ? { edge: true } : {}) };
    if (zone === PVE_LAB_ZONE) {
      const kind = alias.get(`${zone}/${name}`)?.startsWith(PVE_LAB_ALIAS) ? alias.get(`${zone}/${name}`)?.slice(PVE_LAB_ALIAS.length) : null;
      if (kind !== 'open' && kind !== 'closed') continue;
      out.push({ ...base, lab: kind, gateway: gateways.get(name) ?? null });
      continue;
    }
    out.push(base);
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
   *   api?: (opts: { address: string, token: string, trust: { ca?: string|null, trust?: 'ca'|'public', name?: string|null } }) => any,
   *   now?: () => number,
   *   log?: { info: (m: string) => void, warn: (m: string) => void },
   *   sleep?: (ms: number) => Promise<void>,
   *   holderFor?: string,
   *   resolve?: (host: string) => Promise<string[]>,
   * }} [opts]
   */
  constructor({ api = (o) => new PveApi(o), now = () => Date.now(), log, sleep, holderFor = '', resolve = async (h) => (await lookup(h, { all: true, family: 4 })).map((a) => a.address) } = {}) {
    this.api = api;
    /**
     * The cluster this box holds as its own machine (the setup's `holder`
     * step), from FLEETWRIGHT_HOLDER_FOR, as Xen Orchestra's (xo-pools.js):
     * its entry says `holder`, and the coordinator asks it first.
     */
    this.holderFor = String(holderFor || '');
    /** IPv4 addresses for a name, for a closed lab's allow list. */
    this.resolve = resolve;
    /** The coordinator a machine was last made for, which a closed lab's list is kept to. */
    this.coordinatorUrl = '';
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
    /** Records passed over, and why, so each is said once. @type {Map<string, string>} */
    this.refused = new Map();
    /** Whose each machine is, `<address> <name>` to the person it was made for. @type {Map<string, string>} */
    this.machineOwners = new Map();
  }

  /** @param {PveRecord} record */
  #client(record) {
    return this.api({ address: record.address, token: record.token, trust: { ca: record.ca, trust: record.trust, name: record.name ?? null } });
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
    /** @type {Map<string, string>} */
    const refused = new Map();
    for (const a of Array.isArray(accounts) ? accounts : []) {
      const owner = String(a?.email || '').toLowerCase();
      if (!owner) continue;
      for (const i of Array.isArray(a?.items) ? a.items : []) {
        if (i?.name === 'claude' && typeof i.value === 'string' && CLAUDE_RE.test(i.value)) claude.set(owner, i.value);
        if (isSshKeysItem(i?.name)) ssh.set(owner, [...(ssh.get(owner) ?? []), ...sshKeys(i.value)].slice(0, 20));
        const record = pveRecord(String(i?.name || ''), i?.value);
        if (record) held.set(`${owner} ${record.address}`, { owner, record });
        const problem = record ? null : pveProblem(String(i?.name || ''), i?.value);
        if (problem) refused.set(`${owner} ${String(i.name).slice(HYPERVISOR_ITEM.length)}`, problem);
      }
    }
    // SAID ONCE, while it stays wrong: every ten minutes would bury the rest.
    for (const [k, why] of refused) if (this.refused.get(k) !== why) this.log.warn(`sidecar: not using the Proxmox record for ${k.split(' ')[1]} in ${k.split(' ')[0]}'s vault: ${why}. Running the setup again from the app makes a new one.`);
    this.refused = refused;
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

  /**
   * WHERE A CONSOLE FROM AWAY DIALS, for a cluster this box holds for THIS
   * person (console-tunnel.js): the node's address and port, and nothing for
   * any other address or person, so a tunnel is never a way into this box's
   * network to anywhere else. The phone opens TLS itself through the bytes,
   * held to the cluster's CA, and signs in with the token it keeps; this box
   * carries ciphertext. docs/proxmox.md, "A machine's page".
   *
   * @param {string} owner @param {string} address
   * @returns {{ host: string, port: number }|null}
   */
  consoleAddress(owner, address) {
    const held = this.held.get(`${String(owner || '').toLowerCase()} ${address}`);
    if (!held) return null;
    const { host, port } = splitAddress(String(held.record.address), PVE_PORT);
    return Number.isInteger(port) && port > 0 && port < 65536 ? { host, port } : null;
  }

  /**
   * WHERE SSH FROM AWAY DIALS: a running machine made for THIS person on a
   * cluster this box holds for them, at the address its guest agent said,
   * port 22. The same rule as Xen Orchestra's (xo-pools.js, sshTarget).
   *
   * @param {string} owner @param {string} address @param {string} name
   */
  sshAddress(owner, address, name) {
    const held = this.held.get(`${String(owner || '').toLowerCase()} ${address}`);
    return held ? sshTarget(this.seen, this.machineOwners, owner, address, name) : null;
  }

  /**
   * WHERE THE CLUSTER'S EDGE ROUTER IS, for edge-watch.js: the WAN address
   * its guest agent reports (the router's own os-qemu-guest-agent), on the
   * interface whose MAC is net0's, which the setup put on the bridge. The
   * setup gave the token VM.Audit and VM.GuestAgent.Audit on that machine
   * alone. One router, or two (`--edge-pair`), each under the name its syslog
   * says, which is the name the setup gave it: `fleetwright-edge` and
   * `fleetwright-edge-b`. A router whose agent has no address yet is there
   * with an empty one, so it is shown as not read rather than not at all;
   * null is could not ask.
   *
   * @param {string} key  `owner address`
   * @returns {Promise<Map<string, string>|null>}
   */
  async edgeAddresses(key) {
    const held = this.held.get(key);
    if (!held) return null;
    try {
      const api = this.#client(held.record);
      const all = await api.get('/cluster/resources', { type: 'vm' });
      const edges = (Array.isArray(all) ? all : [])
        .filter((m) => m?.type === 'qemu' && (m.pool ?? '') !== held.record.pool && Number(m.template) !== 1 && tagsOf(m).includes(PVE_EDGE_TAG) && PVE_EDGE_NAMES.includes(String(m.name)))
        .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || Number(a.vmid) - Number(b.vmid));
      /** @type {Map<string, string>} */
      const out = new Map();
      for (const edge of edges) {
        const name = String(edge.name);
        if (out.has(name)) continue;
        if (edge.status !== 'running') {
          out.set(name, '');
          continue;
        }
        const base = `/nodes/${encodeURIComponent(String(edge.node))}/qemu/${Number(edge.vmid)}`;
        const cfg = await api.get(`${base}/config`);
        out.set(name, agentAddress(await api.get(`${base}/agent/network-get-interfaces`).catch(() => null), cfg?.net0) ?? '');
      }
      return out;
    } catch {
      return null;
    }
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
    const members = (await poolVms(api, record.pool)).filter((m) => Number.isInteger(Number(m.vmid)) && typeof m.node === 'string');
    const version = await api.get('/version').catch(() => null);
    const major = Number(/^(\d+)\./.exec(String(version?.version ?? ''))?.[1]);
    // NULL IS "COULD NOT TELL", never "supported" (C-5).
    const supported = Number.isFinite(major) ? major >= PVE_MIN_MAJOR : null;
    const poolEntry = { id: pveIdOf(record.address, 'pool', record.pool), name: record.pool };
    // THE IMAGES: templates in the fleet's pool, tagged as the script tags them.
    /** @type {PveImage[]} */
    const images = [];
    for (const t of members.filter((m) => Number(m.template) === 1 && tagsOf(m).includes(PVE_IMAGE_TAG))) {
      const cfg = (await api.get(`/nodes/${encodeURIComponent(t.node)}/qemu/${Number(t.vmid)}/config`)) || {};
      const ctime = /(?:^|,)ctime=(\d+)/.exec(String(cfg.meta || ''))?.[1] ?? '0';
      const key = pveImageKeyOf(tagsOf(t));
      // NAMED AS XEN ORCHESTRA'S ARE ("Fleetwright Ubuntu 24.04"), so New
      // session › Where says which system a machine runs, whichever kind of
      // pool it comes from; the template's own name when it cannot tell.
      images.push({ id: pveIdOf(record.address, 'image', `${t.vmid}:${ctime}`), name: key ? IMAGES[key].name : String(t.name || cfg.name || `template ${t.vmid}`).slice(0, 80), key, os: key ? IMAGES[key].os : null, node: String(t.node), vmid: Number(t.vmid), pool: poolEntry.id, poolName: record.pool, bridge: bridgeOf(cfg.net0) });
    }
    // THE FENCE, as Proxmox says it is, and null when it will not say.
    const fw = await api.get('/cluster/firewall/options').catch(() => null);
    const groups = await api.get('/cluster/firewall/groups').catch(() => null);
    const fenced = fw === null || groups === null ? null : Number(fw?.enable) === 1 && (Array.isArray(groups) ? groups : []).some((g) => g?.group === PVE_FENCE_GROUP);
    // THE LAB AND GROUP NETWORKS, as the setup made them, and each lab's
    // gateway, which its machine's names and addresses come from.
    const vnets = await api.get('/cluster/sdn/vnets').catch(() => []);
    /** @type {Map<string, string>} */
    const gateways = new Map();
    for (const v of Array.isArray(vnets) ? vnets : []) {
      if (v?.zone !== PVE_LAB_ZONE || typeof v.vnet !== 'string') continue;
      const subs = await api.get(`/cluster/sdn/vnets/${encodeURIComponent(v.vnet)}/subnets`).catch(() => []);
      const gw = (Array.isArray(subs) ? subs : []).map((x) => String(x?.gateway || '')).find((g) => /^\d{1,3}(\.\d{1,3}){3}$/.test(g));
      if (gw) gateways.set(v.vnet, gw);
    }
    const nets = networksOf(perms, record.address, vnets, gateways);
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
      // WHOSE IT IS, kept here alone: SSH from away reaches only a machine
      // made for the person asking (sshAddress).
      this.machineOwners.set(`${record.address} ${v.name}`, String(mark.for || '').toLowerCase());
      machines.push({
        name: String(v.name),
        vm: pveIdOf(record.address, 'vm', `${v.vmid}:${mark.made}`),
        state: stopped ? 'Halted' : v.status === 'running' ? 'Running' : String(v.status || '') || null,
        // ITS ADDRESS, as its guest agent says, on the interface the fleet
        // gave it: null while it boots, where the agent does not answer, or
        // where the token predates the privilege (the setup run again adds it).
        ip: stopped ? null : agentAddress(await api.get(`${base}/agent/network-get-interfaces`).catch(() => null), cfg.net0),
        until: mark.until * 1000,
        madeAt: mark.made * 1000,
        cpus: Number.isInteger(Number(cfg.cores)) ? Number(cfg.cores) * (Number(cfg.sockets) || 1) : null,
        memory: Number.isFinite(Number(cfg.memory)) ? Number(cfg.memory) * 1024 * 1024 : null,
        image: images.find((i) => i.id === mark.from)?.name ?? null,
        network: mark.on ?? bridgeOf(cfg.net0),
        group: mark.grp,
        groupIp: mark.gip,
        lab: mark.lab ? { name: mark.lab, open: nets.find((n) => n.name === mark.lab)?.lab === 'open' } : null,
        net: null,
        node: String(v.node),
        vmid: Number(v.vmid),
      });
    }
    // A CLOSED LAB'S LIST KEPT CURRENT: the names it may reach resolve to
    // other addresses over time, and an address added is never one the
    // machine chose. Only added to, never taken from, so a look that
    // resolved less than last time cuts off nothing in use.
    if (this.coordinatorUrl) {
      for (const x of machines.filter((y) => y.state === 'Running' && y.lab && !y.lab.open)) {
        await this.#allow(api, `/nodes/${encodeURIComponent(x.node)}/qemu/${x.vmid}`, this.coordinatorUrl).catch(() => {});
      }
    }
    return {
      address: record.address,
      owner,
      kind: PVE_KIND,
      reachable: true,
      version: typeof version?.version === 'string' ? version.version.slice(0, 20) : null,
      pools: [poolEntry],
      images,
      // A LAB IS TAKEN while a machine of the fleet's is on it, as this look
      // saw: a lab holds one machine at a time.
      networks: nets.map((n) => ({ ...n, pool: poolEntry.id, ...(n.lab ? { taken: machines.some((x) => x.lab?.name === n.name) } : {}) })),
      machines,
      // THE CLUSTER'S OWN MACHINE, by name and whether it is up, for the
      // phone to say it is there; and whether this box is it.
      holders: (await holderVms(api, record.pool)).map(({ name, running }) => ({ pool: poolEntry.id, name, running })),
      // THE EDGE ROUTER (docs/proxmox.md, "The edge router"): whether it is
      // up, and whether it drops what the threat rules match.
      edges: (await edgeVms(api, record.pool)).map((e) => ({ pool: poolEntry.id, ...e })),
      ...(this.holderFor && this.holderFor === record.address ? { holder: true } : {}),
      fenced,
      supported,
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
    if (lab && group) return { ok: false, text: 'A machine in a lab is on the lab’s network alone, so it joins no group. It was not made.' };
    const name = `vm-${m[1]}`;
    const found = [...this.held.entries()].find(([k, h]) => h.owner === who && this.seen.get(k)?.images?.some((/** @type {any} */ i) => i.id === template));
    if (!found) return { ok: false, text: 'This machine manages no pool of yours with that machine image.' };
    const [k, { record }] = found;
    const seen = this.seen.get(k);
    const image = /** @type {PveImage} */ (seen.images.find((/** @type {any} */ i) => i.id === template));
    if (seen.supported !== true) {
      return {
        ok: false,
        text: seen.supported === false
          ? `${record.address} runs Proxmox VE ${seen.version}, and machines are made on ${PVE_MIN_MAJOR} or newer only. Upgrade the cluster, then try again.`
          : `${record.address} would not say which Proxmox VE it runs, so the machine was not made.`,
      };
    }
    // A LAB, only one of the cluster's lab networks, and only one seen empty.
    const labNet = lab ? seen.networks.find((/** @type {any} */ n) => n.id === network && n.lab) : null;
    if (lab && !labNet) return { ok: false, text: 'That is not a lab this box saw on your cluster, so the machine was not made.' };
    if (labNet && labNet.taken !== false) return { ok: false, text: `${labNet.name} ${labNet.taken ? 'has a machine on it' : 'could not be seen to be empty'}, so the machine was not made. Choose another lab.` };
    if (labNet && !labNet.gateway) return { ok: false, text: `${labNet.name} has no gateway this box could read, so a machine there would have no names. It was not made; run the setup again.` };
    const chosen = network && !lab ? seen.networks.find((/** @type {any} */ n) => n.id === network && !n.group && !n.lab) : null;
    if (network && !lab && !chosen) return { ok: false, text: 'That network is not one this box saw on your cluster, so the machine was not made.' };
    // BEHIND THE EDGE ROUTER by default, while one is up: its LAN is the way
    // out, so what the machine does is filtered for threats. Still behind
    // the cluster's firewall too, which holds it to the internet.
    const uplink = !chosen && !labNet && (seen.edges ?? []).some((/** @type {any} */ e) => e.running) ? seen.networks.find((/** @type {any} */ n) => n.edge) ?? null : null;
    // A GROUP NETWORK, as well as its own: only one of the cluster's.
    const groupNet = group ? seen.networks.find((/** @type {any} */ n) => n.id === group && n.group) : null;
    if (group && !groupNet) return { ok: false, text: 'That is not a group network this box saw on your cluster, so the machine was not made.' };
    // NOT FENCED IS NOT MADE QUIETLY: a machine on the image's bridge with the
    // datacenter's firewall off reaches everything that bridge does. Made on a
    // network the person chose, it reaches what they chose; made by default,
    // it would reach their network without their having said so.
    // Behind the edge router it reaches nothing private either way: the
    // router's own rules hold it to the internet (docs/hypervisors.md).
    if (!chosen && !uplink && seen.fenced !== true) {
      return {
        ok: false,
        text: seen.fenced === false
          ? `${record.address}’s datacenter firewall is off, so a machine there would reach your network and not only the internet. It was not made. Turn the firewall on (Datacenter › Firewall › Options), or choose a network for it in New session › Where.`
          : `${record.address} would not say whether its firewall is on, so the machine was not made. Choose a network for it in New session › Where, or let the token read /cluster/firewall (run the setup again).`,
      };
    }
    // A CLOSED LAB'S WAY OUT, resolved before anything is made: with no
    // address for the fleet, the machine could not enrol, and would sit there.
    const closed = labNet?.lab === 'closed';
    if (closed) {
      this.coordinatorUrl = coordinatorUrl;
      const any = (await Promise.all(fleetHosts(coordinatorUrl).map((h) => this.resolve(h).catch(() => [])))).flat();
      if (!any.length) return { ok: false, text: 'None of the fleet’s or Claude’s names resolved from this box, so a machine in a closed lab could reach nothing it needs. It was not made.' };
    }
    // ITS PLACE ON THE GROUP NETWORK: a MAC and an address from its ticket's
    // id, moved past any a machine in that group has, as on Xen Orchestra.
    const joined = groupNet
      ? groupPlace(m[1], new Set(seen.machines.filter((/** @type {any} */ x) => x.group === groupNet.name && x.groupIp).map((/** @type {any} */ x) => x.groupIp)))
      : null;
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
      // IN THE PERSON'S RANGE when they gave one: the first number in it
      // the cluster says is free, asked one at a time from the bottom.
      let lastError = null;
      let from = record.vmids?.from ?? 0;
      for (let attempt = 0; attempt < 3 && vmid === null; attempt++) {
        let next;
        try {
          if (record.vmids) {
            next = await this.#freeIn(api, from, record.vmids.to);
            if (next === null) return { ok: false, text: `Every number from ${record.vmids.from} to ${record.vmids.to} on ${record.address} is taken, which is the range this cluster's machines were given. End a machine there, or set the cluster up again with a wider range.` };
            from = next + 1;
          } else {
            next = Number(await api.get('/cluster/nextid'));
          }
        } catch (e) {
          return { ok: false, unreachable: true, text: `${record.address} could not be reached from here: ${/** @type {Error} */ (e).message}` };
        }
        try {
          await api.waitTask(await api.post(`${src}/clone`, { newid: next, name, pool: record.pool, description: markText({ for: who, until, made, from: image.id, on: labNet?.name ?? chosen?.name ?? uplink?.name ?? image.bridge, grp: groupNet?.name ?? null, gip: joined?.address ?? null, lab: labNet?.name ?? null }) }), { sleep: this.sleep });
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
        net0: net0On(cfg.net0, labNet?.name ?? chosen?.name ?? uplink?.name ?? null),
        // ON THE GROUP NETWORK TOO, at its own address: Proxmox's cloud-init
        // writes it, so it is set before anything inside listens.
        ...(joined && groupNet ? { net1: `virtio=${joined.mac},bridge=${groupNet.name},firewall=1`, ipconfig1: `ip=${joined.address}/16` } : {}),
      });
      // BEHIND THE FENCE, unless the person chose the network: the cluster's
      // group, on the bridge, out of the guest's reach.
      if (!chosen) await this.#fence(api, dst, { lab: labNet, group: Boolean(joined), coordinatorUrl });
      await api.waitTask(await api.post(`${dst}/status/start`, {}), { sleep: this.sleep });
      // ALONE IN ITS LAB: another box may have put a machine on the same lab
      // in the same moment. The one made second goes, as on Xen Orchestra.
      if (labNet) {
        const others = await this.#onLab(api, record.pool, labNet.name, vmid);
        if (others === null || others.some((o) => o.made < made || (o.made === made && o.name < name))) {
          throw new Error(`${labNet.name} ${others === null ? 'could not be seen to be yours alone' : 'was taken a moment ago by another machine'}. Choose another lab`);
        }
      }
      this.#noteMade(name, { vmid, node: image.node, owner: who, at: this.now() });
      this.log.info(`sidecar: made ${name} from ${image.name} on ${record.address} for ${who}`);
      const claude = this.claude.get(who) ?? null;
      return {
        ok: true,
        vm: pveIdOf(record.address, 'vm', `${vmid}:${made}`),
        text:
          `Making ${name} from ${image.name} on ${record.address}` +
          (labNet
            ? `, in ${labNet.name}: ${closed ? 'it reaches the fleet and Claude and nothing else' : 'it reaches the internet and nothing private'}`
            : chosen ? `, on ${chosen.name}` : uplink ? ', behind the edge router: it reaches the internet and nothing private, and what it does is filtered for threats' : ', behind the cluster’s firewall: it reaches the internet and nothing private') +
          `${joined && groupNet ? `, with the others on ${groupNet.name} at ${joined.address}` : ''}. ` +
          `It joins the fleet as your temporary machine in a minute or two, for ${life} minutes${claude ? '' : ', and has no Claude login of yours to run on: keep one in your vault'}.`,
      };
    } catch (e) {
      // HALF MADE IS UNMADE: a clone that could not be set up or started
      // would otherwise wait for the sweep with a ticket in it.
      if (vmid !== null) {
        const dst = `/nodes/${encodeURIComponent(image.node)}/qemu/${vmid}`;
        // The stop is a task; a delete sent before it has ended is refused
        // for a VM still running, and the half-made machine would stay.
        await api.post(`${dst}/status/stop`, {}).then((/** @type {string} */ upid) => api.waitTask(upid, { sleep: this.sleep, timeoutMs: 60_000 })).catch(() => {});
        await api.del(dst, { purge: 1, 'destroy-unreferenced-disks': 1 }).catch(() => {});
      }
      return { ok: false, text: `${record.address} would not make the machine: ${/** @type {Error} */ (e).message}` };
    }
  }

  /**
   * THE FIREWALL A MACHINE IS MADE BEHIND, on the bridge, out of its reach.
   * Rules are placed by position, in the order they are matched.
   *
   *   default   the cluster's fence group: SSH in, the internet out and nothing
   *             private; and, in a group, everything on the group network
   *             both ways, before the fence, since 10.200/16 is private.
   *   open lab  names from the lab's gateway alone, then the fence.
   *   closed    names from the gateway alone (which answers only the
   *             fleet's and Claude's), HTTPS to their addresses alone (a set
   *             on the machine, kept current by every look), and nothing
   *             else in or out. docs/proxmox.md, "Labs".
   *
   * @param {any} api @param {string} dst
   * @param {{ lab: any, group: boolean, coordinatorUrl: string }} how
   */
  async #fence(api, dst, { lab, group, coordinatorUrl }) {
    const closed = lab?.lab === 'closed';
    await api.put(`${dst}/firewall/options`, { enable: 1, policy_in: 'DROP', policy_out: closed ? 'DROP' : 'ACCEPT' });
    /** @type {Array<Record<string, unknown>>} */
    const rules = [];
    if (group) rules.push({ type: 'in', action: 'ACCEPT', iface: 'net1' }, { type: 'out', action: 'ACCEPT', iface: 'net1' });
    if (lab) {
      if (closed) rules.push({ type: 'out', action: 'ACCEPT', proto: 'udp', dport: '67:68' });
      rules.push(
        { type: 'out', action: 'ACCEPT', proto: 'udp', dport: '53', dest: lab.gateway },
        { type: 'out', action: 'ACCEPT', proto: 'tcp', dport: '53', dest: lab.gateway },
      );
      if (closed) {
        await api.post(`${dst}/firewall/ipset`, { name: PVE_ALLOW_SET, comment: 'Fleetwright: the fleet and Claude' });
        await this.#allow(api, dst, coordinatorUrl);
        rules.push({ type: 'out', action: 'ACCEPT', proto: 'tcp', dport: '443', dest: `+guest/${PVE_ALLOW_SET}` });
      } else {
        rules.push({ type: 'out', action: 'DROP', proto: 'udp', dport: '53' }, { type: 'out', action: 'DROP', proto: 'tcp', dport: '53' });
      }
    }
    if (!closed) rules.push({ type: 'group', action: PVE_FENCE_GROUP });
    for (const [pos, r] of rules.entries()) await api.post(`${dst}/firewall/rules`, { ...r, pos, enable: 1 });
  }

  /**
   * A closed lab machine's allow list: the addresses the fleet's and Claude's
   * names resolve to now, added to what it has.
   *
   * @param {any} api @param {string} dst @param {string} coordinatorUrl
   */
  async #allow(api, dst, coordinatorUrl) {
    const have = new Set((await api.get(`${dst}/firewall/ipset/${PVE_ALLOW_SET}`).catch(() => []) ?? []).map((/** @type {any} */ e) => String(e?.cidr || '').replace(/\/32$/, '')));
    const want = [...new Set((await Promise.all(fleetHosts(coordinatorUrl).map((h) => this.resolve(h).catch(() => [])))).flat())];
    for (const ip of want) if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !have.has(ip)) await api.post(`${dst}/firewall/ipset/${PVE_ALLOW_SET}`, { cidr: ip });
  }

  /**
   * The other machines of the fleet's on a lab, by name and when each was
   * made, or null when the pool would not say.
   *
   * @param {any} api @param {string} pool @param {string} labName @param {number} self
   * @returns {Promise<Array<{ name: string, made: number }>|null>}
   */
  async #onLab(api, pool, labName, self) {
    const vms = await poolVms(api, pool).catch(() => null);
    if (!vms) return null;
    /** @type {Array<{ name: string, made: number }>} */
    const out = [];
    for (const v of vms.filter((/** @type {any} */ x) => Number(x.vmid) !== self && Number(x.template) !== 1 && tagsOf(x).includes(PVE_SESSION_TAG))) {
      const cfg = await api.get(`/nodes/${encodeURIComponent(v.node)}/qemu/${Number(v.vmid)}/config`).catch(() => null);
      const mk = markOf(cfg?.description);
      if (mk?.lab === labName) out.push({ name: String(v.name), made: mk.made });
    }
    return out;
  }

  /**
   * The first number from `from` to `to` the cluster says is free, or null
   * when none is within VMID_LOOKS of the bottom. A number in use answers
   * with an error; one that cannot be reached throws as any call does.
   *
   * @param {any} api @param {number} from @param {number} to @returns {Promise<number|null>}
   */
  async #freeIn(api, from, to) {
    for (let n = from, looked = 0; n <= to && looked < VMID_LOOKS; n++, looked++) {
      try {
        return Number(await api.get('/cluster/nextid', { vmid: n }));
      } catch (e) {
        // TAKEN is a parameter error ("vmid: VM 101 already exists");
        // anything else is the cluster not answering, said as that.
        if (/** @type {any} */ (e)?.status !== 400 && !/already exists/i.test(String(/** @type {Error} */ (e).message))) throw e;
      }
    }
    return null;
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
      let vms;
      try {
        vms = await poolVms(api, record.pool);
      } catch (e) {
        unreachable.push(`${record.address}: ${/** @type {Error} */ (e).message}`);
        continue;
      }
      const v = vms.find((/** @type {any} */ m) => m.name === name && Number(m.template) !== 1 && tagsOf(m).includes(PVE_SESSION_TAG));
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
    if (this.handed.has(id)) return { ok: false, text: `${name} was handed its login by this machine already, so this ask is handed nothing.` };
    const token = this.claude.get(who);
    if (!token) return { ok: false, notHere: true, text: `This machine has no Claude login of ${who}’s to hand ${name}.` };
    if (!this.holdsFor(who)) return { ok: false, notHere: true, text: `This machine manages none of ${who}’s clusters, so it cannot see ${name}.` };
    this.handing.add(id);
    try {
      const { found, unreachable } = await this.#find(who, id);
      if (!found) {
        return unreachable.length
          ? { ok: false, unreachable: true, text: `${name} is not on the clusters of yours that answered, and the rest could not be reached from here: ${unreachable.join('; ')}` }
          : { ok: false, notHere: true, text: `${name} is not on any of ${who}’s clusters this machine manages.` };
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
    if (!this.holdsFor(who)) return { ok: false, notHere: true, text: 'This machine manages none of your clusters.' };
    const { found, unreachable, held } = await this.#find(who, String(name));
    if (!found) {
      return unreachable.length
        ? { ok: false, unreachable: true, text: unreachable.length === held ? `Your clusters could not be reached from here: ${unreachable.join('; ')}` : `${name} is not on the clusters of yours that answered, and the rest could not be reached from here: ${unreachable.join('; ')}` }
        : { ok: false, notHere: true, text: `${name} is not on any of your clusters this machine manages.` };
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
        // FROM WHEN IT WAS MADE, NOT FROM NOW, as xo-pools.js says: asking
        // again and again does not keep a machine alive for ever, and asking
        // past the cap is refused rather than answered as done.
        if (to <= mark.until) return { ok: false, text: `${name} already runs to the longest a machine can, ${MAX_MINUTES} minutes from when it was made.` };
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
 * A MACHINE'S ADDRESS from its guest agent's answer to
 * `agent/network-get-interfaces`: the IPv4 address on the interface whose
 * hardware address is net0's, the one the fleet put it on, so a second
 * interface on a group network is never offered for SSH as if it were the
 * machine's own. Loopback and link-local are never an address to reach. Null
 * is cannot tell (C-5): no answer, no such interface, or no address on it.
 *
 * ONE CALL PER RUNNING MACHINE A LOOK, which the look already makes for its
 * config: the budget is MAX_MACHINES of each, every refresh.
 *
 * @param {any} answer @param {unknown} net0 @returns {string|null}
 */
export function agentAddress(answer, net0) {
  const list = Array.isArray(answer?.result) ? answer.result : Array.isArray(answer) ? answer : null;
  if (!list) return null;
  const mac = /(?:^|,)[a-z0-9]+=([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/.exec(String(net0 || ''))?.[1]?.toLowerCase();
  if (!mac) return null;
  const nic = list.find((/** @type {any} */ i) => String(i?.['hardware-address'] || '').toLowerCase() === mac);
  for (const a of Array.isArray(nic?.['ip-addresses']) ? nic['ip-addresses'] : []) {
    const ip = String(a?.['ip-address'] || '');
    if (a?.['ip-address-type'] !== 'ipv4' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue;
    if (ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
    return ip;
  }
  return null;
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
 * THE RUN USER IS MADE HERE, as the Xen Orchestra image makes it
 * (vm-image.js): the package is preseeded to run as `fleetwright`, and its
 * installer will not run the node it ships as root for a user that does not
 * exist, so without the account its postinst stopped with "could not read a
 * version from .../node", cloud-init's final stage failed, and the first real
 * build never finished.
 *
 * Each stage writes `fleetwright-build: <stage>` to the serial console (up,
 * fleetwright, off, or `failed` when the install stops), which the script
 * reads to say how far the build is, and to stop waiting on one that failed.
 */
export function pveBuildConfig() {
  return [
    '#cloud-config',
    '# Fleetwright: builds the machine image (install/fleetwright-pve-setup).',
    '# Powers off when it is done. Still running means it failed.',
    '# The account Fleetwright runs as, which the package is told to use.',
    'users:',
    '  - default',
    '  - name: fleetwright',
    '    shell: /bin/bash',
    '    lock_passwd: true',
    '# Each stage is said on the serial console, where the setup reads it.',
    'bootcmd:',
    "  - [sh, -c, 'echo fleetwright-build: up >/dev/ttyS0 || true']",
    'package_update: true',
    'packages: [curl, ca-certificates, openssh-server, qemu-guest-agent, avahi-daemon, libnss-mdns]',
    'runcmd:',
    '  - |',
    '    set -eu',
    `    trap 'rc=$?; [ "$rc" = 0 ] || echo "fleetwright-build: failed $rc" >/dev/ttyS0' EXIT`,
    '    echo fleetwright-build: fleetwright >/dev/ttyS0 || true',
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
    '    echo fleetwright-build: off >/dev/ttyS0 || true',
    '    poweroff',
    '',
  ].join('\n');
}
