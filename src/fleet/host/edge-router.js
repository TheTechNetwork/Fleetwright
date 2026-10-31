// The edge router: one OPNsense VM per pool, the only way out of every lab.
// docs/hypervisors.md, "The uplink" and "The edge router".
//
// WHAT IT IS. A private network inside the pool, `fleetwright-uplink`, that
// the fleet's machines are on, and one OPNsense VM, `fleetwright-edge`, with
// its WAN on the network the person chose as the way out, its LAN on the
// uplink, and an interface on each lab the policy asked for (LAB, below).
// Its rules are written once, here, and nothing in the fleet can change
// them: machines reach the internet, and nothing private, link-local or
// multicast, so none can reach the person's LAN, the pool's API or a lab; a
// lab reaches the same, or, closed, only the fleet and Claude. It has no
// login at all (root's password is `*`), because the one thing that could
// log into it is a machine on one of its inside networks.
//
// HOW IT IS BUILT WITHOUT ANYBODY AT A CONSOLE, which is the part that was
// open. OPNsense takes no cloud-init, and its configuration importer waits for
// a key press at the console, so neither a config drive nor a second disk is
// read unattended. What first boot does read is /usr/local/etc/config.xml:
// with no /conf/config.xml yet, the importer's boot mode times out and copies
// that file into place (opnsense-importer, bootstrap_and_exit). The nano image
// is a plain UFS2 file system written by makefs, and that file is 5,234
// contiguous bytes at a fixed offset in it (found by reading the published
// 26.7 image; the whole image is pinned by its SHA-256 below, so nothing can
// drift under us). The build gives the file a whole free block of its own,
// by the file system's rules (OPNSENSE_IMAGE.grow), and streams the image
// from the download to Xen Orchestra with that block holding this file's
// configuration, padded to its length, and the few bytes of the file system
// that record the move changed. XML allows the trailing whitespace the
// padding is made of. Before a byte is replaced, the original is checked
// against what must be there, so a wrong offset fails instead of corrupting
// the disk.
//
// WHAT RUNS WHERE. The machine running the policy job downloads the image
// (once, kept in its state directory, checked before every use), unpacks it
// with bzip2 and uploads it through Xen Orchestra's own disk import, over the
// same pinned connection as everything else. Xen Orchestra makes the VDI;
// the VM is made from the pool's built-in "Other install media" template with
// no disks of its own, the imported disk attached, TX checksum offload turned
// off on both interfaces (XCP-ng's advice for FreeBSD guests, which otherwise
// drop forwarded traffic), and started.
//
// AND WHAT IS NOT SENT AGAIN. The image as published is kept on the pool, a
// template that never boots, and a rebuild is a copy of it with only the
// blocks the configuration changes written into the copy: a few MiB through
// Xen Orchestra where the whole disk is 3 GiB (buildEdge, THE KEPT DISK).

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { REQUIRED_HOSTS } from '../../core/egress.js';
import { connectPinnedTls, splitAddress } from './xo-ws.js';
import { EDGE_KEPT, EDGE_WATCH, clearExposed, exposedOn, keepFor, keptFor, keptOn, markCarp, watchConfig } from './edge-credentials.js';
import { VHD_BLOCK, sparseVhd } from './vhd.js';
import { forgetMade, outsideSets, recordMade, setsOf } from './xo-made.js';

/**
 * The image, pinned. A new OPNsense release is a new entry here, with the
 * offset found again in its image: nothing is worked out at run time that
 * could disagree with what was checked.
 *
 * RENOVATE NAMES THE RELEASE; A PERSON DOES THE REST. Renovate moves
 * `release` from OPNsense's mirror listing (renovate.json). A new release is
 * a new file system, so the address, digest and sizes, the configuration's
 * offset, length and digest, and `grow` are all found again in its image
 * (scripts/opnsense-room.mjs), and EDGE_FILTER's names are read again from its
 * models. `checked` is the release that was done for, written last; until the
 * address and `checked` both name `release`, test/pin-images.test.js fails.
 */
export const OPNSENSE_IMAGE = Object.freeze({
  // renovate: datasource=custom.opnsense depName=opnsense
  release: '26.7',
  /** The release everything below was worked out against. */
  checked: '26.7',
  url: 'https://pkg.opnsense.org/releases/mirror/OPNsense-26.7-nano-amd64.img.bz2',
  /** As published in OPNsense-26.7-checksums-amd64.sha256, and as downloaded. */
  sha256: '28d5e2f37e40d87468a924e3006ef10e2ddc6de485b85333d9e3958c84d0cb9d',
  compressedSize: 490849116,
  rawSize: 3221225472,
  /** /usr/local/etc/config.xml, as the nano build left it, and its SHA-256. */
  config: Object.freeze({ offset: 712876032, length: 5234, sha256: '1e81cde6bebe59e0aa769bd6b187f2247bd1155cddb52253ca1f2a17c51fe2e5' }),
  /**
   * ROOM: A WHOLE BLOCK FOR THE CONFIGURATION, 32 KiB, made by the file
   * system's own rules (src/fleet/host/ufs-room.js). The default file is two
   * 4 KiB fragments in cylinder group 1, which `makefs` packed full, so it
   * cannot grow where it is: it moves to the first wholly free block (in
   * group 4), its fragments are marked free, and every count that records
   * either (the inode's size, sectors and first block; both groups' bitmaps,
   * free counts and run sums; group 4's cluster map; the per-group summary
   * array; the superblock's totals) is changed with it. Planned and checked
   * as fsck would by scripts/opnsense-room.mjs against the 26.7 image pinned
   * above, and carried here as each byte it changes and what must be there
   * before it is: the build checks every one, and that the block is zeros,
   * before writing anything. 8 KiB, the file's own fragments, was the room
   * until two routers' rules (HA) needed more.
   */
  grow: Object.freeze({
    room: 32768,
    inode: 6523,
    data: Object.freeze({ offset: 2345304064, length: 32768 }),
    edits: Object.freeze([
      { offset: 66552, was: 'eb60000000000000', becomes: 'ea60000000000000', what: 'superblock: free blocks' },
      { offset: 66568, was: '0000000000000000', becomes: '0200000000000000', what: 'superblock: free fragments' },
      { offset: 1833744, was: '72140000000000001000000000000000', becomes: '00800000000000004000000000000000', what: 'inode 6523: size and sectors' },
      { offset: 1833840, was: 'daa7020000000000', becomes: 'a8bc080000000000', what: 'inode 6523: first block' },
      { offset: 31555600, was: '000000000000000000df010000000000', becomes: '000000000000000000df010002000000', what: 'summary of cylinder group 1' },
      { offset: 31555648, was: '00000000cb13000000df010000000000', becomes: '00000000ca13000000df010000000000', what: 'summary of cylinder group 4' },
      { offset: 502399012, was: '00', becomes: '02', what: 'cylinder group 1' },
      { offset: 502399036, was: '00', becomes: '01', what: 'cylinder group 1' },
      { offset: 502420899, was: '00', becomes: '0c', what: 'cylinder group 1' },
      { offset: 2009202716, was: 'cb', becomes: 'ca', what: 'cylinder group 4' },
      { offset: 2009228445, was: 'ff', becomes: '00', what: 'cylinder group 4' },
      { offset: 2009234802, was: 'e0', becomes: 'c0', what: 'cylinder group 4' },
    ]),
  }),
});

/**
 * Names in Xen Orchestra. The edge is not tagged `fleetwright` and is outside
 * the fleet's resource set, so the fleet's token cannot change or clone it. It
 * can see it, with every field Xen Orchestra keeps on it: `xo.getAllObjects`
 * shows every signed-in user every object (measured on 5.211.0), which is why
 * nothing secret is kept on it (edge-credentials.js, EDGE_KEPT).
 */
export const EDGE = Object.freeze({
  vm: 'fleetwright-edge',
  tag: 'fleetwright-edge',
  /** On an edge built to drop what its threat rules match, so a policy can tell what it has without logging in, which it cannot. */
  blocksTag: 'fleetwright-edge-blocks',
  /** On an edge that updates itself and carries the Xen guest agent (EDGE_UPDATES); one without it is rebuilt to get both. */
  updatesTag: 'fleetwright-edge-updates',
  uplink: 'fleetwright-uplink',
  template: 'Other install media',
  /** The edge's LAN, which is the uplink: a range a home or office LAN rarely uses. */
  lan: Object.freeze({ address: '10.254.0.1', prefix: 24, from: '10.254.0.100', to: '10.254.0.250' }),
  cpus: 2,
  memory: 2 * 1024 ** 3,
  /**
   * On the kept disk's template (buildEdge, THE KEPT DISK), and as
   * `fleetwright-base:opnsense:<release>` beside it, saying which pinned image
   * it holds. The same tag as the machine image's kept disks (VM_IMAGE.baseTag
   * in vm-image.js), written here rather than imported because vm-image.js
   * imports from this file.
   */
  baseTag: 'fleetwright-base',
  baseKey: 'opnsense',
});

/**
 * What the edge filters for every machine behind it (docs/hypervisors.md,
 * "What the edge filters"). Names in OPNsense 26.7's own models, read from
 * its source: Unbound's built-in blocklists by key, Suricata's ET Open rule
 * files by name. Threat feeds only: nothing a session doing ordinary work
 * would trip over.
 */
export const EDGE_FILTER = Object.freeze({
  /** abuse.ch ThreatFox's indicators and Hagezi's threat intelligence feeds: malware, phishing, command and control. */
  blocklists: Object.freeze(['atf', 'hgz011']),
  /** Malware traffic, known botnet controllers, known-bad hosts, Cobalt Strike servers. Logged, and dropped when the policy says block. */
  rules: Object.freeze(['emerging-malware.rules', 'botcc.rules', 'compromised.rules', 'threatview_CS_c2.rules']),
  /** Neither is downloaded at boot (OPNsense fetches them on an apply or from cron), and /var is in memory, so both are fetched on a cron, every half hour. */
  every: '*/30',
  /**
   * Where Suricata takes traffic when it blocks: OPNsense's one divert
   * socket (scripts/filter/list_divert_sockets.php). Divert, not netmap,
   * because divert needs nothing of the network driver, and netmap's support
   * for Xen's netfront is the thing nobody could promise.
   */
  divertPort: 8000,
});

/**
 * HOW THE EDGE KEEPS ITSELF UP TO DATE, and how it gets the Xen guest agent,
 * which are the same thing. Nobody can log in to it and the build can only
 * write its configuration, so the one way to put a package on it is
 * OPNsense's own: a plugin named in `system.firmware.plugins` is installed by
 * the firmware update when it is missing (scripts/firmware/sync.subr.sh,
 * from update.sh `sync`), and that update is the cron action "Automatic
 * firmware update" (`firmware auto-update`, rc.firmware with up to 25
 * minutes' random delay). Plugin install itself has no cron action.
 *
 * WHAT THAT COSTS, chosen with the person: the update takes OPNsense's
 * stable updates within its release and reboots when the kernel or base
 * system changed, so every machine behind it loses its way out for those
 * minutes. Once a day at 10:00 UTC, which is 04:00 in Mountain time, where
 * the first pool is. The agent is `os-xen`, so Xen Orchestra shows the
 * edge's addresses from its first update on.
 */
export const EDGE_UPDATES = Object.freeze({ plugin: 'os-xen', hours: '10' });

/**
 * TWO EDGES (`ha` in edgeConfig): the CARP group of the uplink, each lab's
 * the next, and the second router's name in Xen Orchestra.
 */
export const EDGE_HA = Object.freeze({ vhid: 1, second: 'fleetwright-edge-b', nodeTag: 'fleetwright-edge-node:' });

/**
 * HOW LONG A ROUTER JUST STARTED IS WATCHED before the one it replaces is
 * removed (settled): two minutes, Xen Orchestra asked every five seconds.
 * Long enough for OPNsense's boot, which is where a disk that does not
 * boot or a configuration it refuses shows as the VM stopping again; short
 * enough that a pair's rebuild, which does this twice, stays well inside the
 * policy job's ten minutes (xo-setup.js, POLICY_WAIT_MS).
 */
export const EDGE_SETTLE = Object.freeze({ ms: 120_000, every: 5_000 });

/**
 * What a rebuild costs the machines behind one router, said before it
 * starts: the new one is built while the old one runs (replaceRouter), so
 * the way out is gone for one boot. It was gone for the whole build, and the
 * sentence said so.
 */
const ONE_BOOT = 'Machines behind it keep their way out while the new one is built, and have none while it starts.';

/** The rule files' ids, less their last digit, which is each one's place in EDGE_FILTER.rules. */
const RULE_FILE_UUID = '5c0e8a3e-6f1d-4b8a-9d2e-1a7b3c4d5e1';

/** What a lab may not reach: private, shared, link-local and multicast space. */
export const NOT_FROM_LABS = Object.freeze(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '224.0.0.0/4']);

/**
 * LABS: networks of their own on the edge (docs/hypervisors.md, "Labs").
 * Each is a private network in the pool with no interface of its own, made by
 * the policy job, attached to the edge as one more interface (xn2 for the
 * first), with the edge's address on it and its DHCP. Machines in a lab are
 * on that network only, so they reach each other directly and everything else
 * through the edge, by the lab's rules: names from the edge, nothing private
 * (not another lab, not the uplink, not the person's LAN), and then either
 * the internet (an open lab) or the fleet's own paths and nothing else (a
 * closed lab). Up to four: Xen gives an HVM guest seven interfaces, and the
 * edge has two of its own.
 */
export const LAB = Object.freeze({
  max: 4,
  /** The network's name in Xen Orchestra, numbered from 1, and the tag that says which kind it is. */
  prefix: 'fleetwright-lab-',
  openTag: 'fleetwright-lab:open',
  closedTag: 'fleetwright-lab:closed',
  /**
   * On each lab network, how many labs one person may hold at once on its
   * pool, when the policy sets a number ("Labs per person"); no tag is no
   * limit. On the network and not the edge because the box reads it with the
   * fleet's own token, which can see the lab networks and not the edge.
   */
  eachTag: 'fleetwright-lab-each:',
  /** On the edge, which labs it was built with, in order: `o` open, `c` closed. */
  edgeTag: 'fleetwright-edge-labs:',
  /** Lab n is 10.250.n.0/24, the edge at .1, machines given .100 to .250. */
  address: (/** @type {number} */ n) => `10.250.${n}.1`,
  cidr: 24,
});

/**
 * Which labs an edge was built with, from its tag: `o` and `c` in order, ''
 * for none (an edge built before labs has no tag, and has none).
 *
 * @param {any} vm @returns {string}
 */
export function edgeLabsOf(vm) {
  const t = (Array.isArray(vm?.tags) ? vm.tags : []).find((/** @type {string} */ x) => x.startsWith(LAB.edgeTag));
  return t && /^[oc]{0,4}$/.test(t.slice(LAB.edgeTag.length)) ? t.slice(LAB.edgeTag.length) : '';
}

/**
 * How many labs one person may hold on a pool, from its lab networks' tags
 * (LAB.eachTag): a whole number from 1, or null for no limit, which is also
 * what a pool whose policy predates the setting has. Networks that somehow
 * disagree are read as the smaller.
 *
 * @param {any[]} networks as Xen Orchestra lists them @param {string|null} pool
 * @returns {number|null}
 */
export function labsEachOf(networks, pool) {
  /** @type {number|null} */
  let each = null;
  for (const n of networks) {
    if (!String(n?.name_label || '').startsWith(LAB.prefix) || (pool && n?.$pool !== pool)) continue;
    if (!(Array.isArray(n?.tags) && (n.tags.includes(LAB.openTag) || n.tags.includes(LAB.closedTag)))) continue;
    const t = n.tags.find((/** @type {string} */ x) => x.startsWith(LAB.eachTag));
    const v = t && /^[1-9]\d{0,2}$/.test(t.slice(LAB.eachTag.length)) ? Number(t.slice(LAB.eachTag.length)) : null;
    if (v !== null) each = each === null ? v : Math.min(each, v);
  }
  return each;
}

/**
 * Where dnsmasq answers on the edge. It hands out every inside network's
 * addresses and answers names for nobody but the closed labs (fleetHosts),
 * since Unbound has port 53 and the rules send nothing else here.
 */
export const DNSMASQ_PORT = 53053;

/**
 * Where a closed lab may still go: the fleet's coordinator, so its machine
 * can enrol and its sidecar stay connected, and the hosts Claude cannot work
 * without, which are the sandbox's own required list (src/core/egress.js)
 * rather than a second one. HTTPS only, by name: an OPNsense host alias,
 * which the edge resolves with its own Unbound and keeps resolved.
 *
 * AND THE ONLY NAMES IT RESOLVES, from the same list, so a session on it
 * cannot carry data out in the names it looks up, which the edge's own
 * resolver would otherwise ask about anywhere on the internet for it. Each
 * name and the names under it (`claude.ai`, `api.claude.ai`), which is what
 * a service behind one of them may ask for; everything else is REFUSED.
 * Written as dnsmasq and not as Unbound, because OPNsense 26.7's Unbound
 * has nothing in config.xml that answers one network differently from
 * another: its access lists allow or refuse a network's every question,
 * and its blocklists match only addresses (A, AAAA, CNAME, HTTPS) and
 * never the whole tree, so a TXT question would still go out. So a closed
 * lab's port 53 is sent to dnsmasq (`rdr pass`, before any rule), which has
 * no resolver of its own (`no_resolv`) and one domain override per name,
 * each asking Unbound on the edge itself, which still filters the answer.
 *
 * @param {string|null} coordinatorUrl
 * @returns {string[]}
 */
export function fleetHosts(coordinatorUrl) {
  const host = coordinatorUrl ? new URL(coordinatorUrl).hostname.toLowerCase() : null;
  return [...new Set([...(host ? [host] : []), ...REQUIRED_HOSTS])];
}

/**
 * The edge's whole configuration, padded with spaces to exactly the length
 * of the file it replaces. Interfaces are Xen's netfront names in the order
 * the VM's interfaces are made: xn0 the WAN, xn1 the LAN.
 *
 * What is kept from the default: the nano image's memory file systems and
 * serial console, outbound NAT left automatic, Unbound answering DNS and
 * dnsmasq handing out addresses. What changes: the interfaces, no IPv6, the
 * WAN allowed to sit on a private LAN (it does: it is the person's), no
 * anti-lockout rule and no login, the offloads XCP-ng asks to be off, and
 * four LAN rules in order: DNS to the edge itself, no DNS anywhere else (so
 * the filtering below cannot be stepped around by naming another resolver),
 * nothing private, then anything else.
 *
 * WHAT IT FILTERS (EDGE_FILTER): Unbound answers 0.0.0.0 for anything on its
 * threat blocklists, and Suricata watches the LAN for known-bad traffic and
 * logs it, by the machine's own address.
 *
 * WHEN IT BLOCKS (`block`), Suricata runs inline: the rule that lets labs out
 * hands their traffic to its divert socket first, and one policy turns every
 * alert in the four rule files into a drop. FAIL CLOSED, on purpose: with
 * Suricata stopped, a divert socket with nobody reading it passes nothing, so
 * an edge that blocks and cannot inspect lets nothing out rather than
 * everything. The DNS and private rules above it are not diverted: they
 * decide before Suricata would see the packet.
 *
 * ROOM. It has to fit in the block the build gives the file
 * (OPNSENSE_IMAGE.grow, 32 KiB). It once had to fit in the 5,234 bytes the
 * default fills, then the 8,192 of its own fragments, and what was cut for
 * those is what OPNsense does anyway: the web interface's theme (nobody can
 * log in to see it), pf's
 * `normal` optimization (its default when unset), sticky load balancing (it
 * does nothing without source tracking, which is off), and the policy's
 * `prio` and description, which OPNsense reads as 0 and none when absent.
 * NOT its `enabled`: booted without it, the policy came up disabled and an
 * alert installed as an alert, though IDS.xml's default for it is 1; why is
 * not known, so every `enabled` is written. Cut since, for the updates job
 * (EDGE_UPDATES): the aliases' descriptions, which OPNsense does not
 * require, and the private rule's is shorter. A test keeps every mode inside
 * the room.
 *
 * VERSIONS STAMPED ONE BELOW CURRENT, on purpose. OPNsense's templates read
 * the configuration as written, not the model with its defaults, and the
 * defaults are written in only when a migration runs and saves the model.
 * Stamped at the current version, nothing runs, and the edge booted with
 * Unbound's templates failing on a missing `acls`. Stamped one below, only
 * the newest migration runs (each harmless here, read from 26.7's source),
 * then the whole model is saved: never the older ones, which would read
 * these sections as an older format. That is also why Unbound's legacy
 * `<unbound>` section is gone: it is what an older migration would fold in.
 *
 * WITH LABS (`labs`, one entry a lab, true for open), each lab is interface
 * `opt<n>` on `xn<n+1>`, in the order the VM's interfaces are made, with the
 * edge at LAB.address(n) and DHCP there. Their rules, after the uplink's and
 * written once over every lab interface (OPNsense makes one pf rule per
 * interface of a rule that names several): names from the edge, no other
 * resolver, nothing private, then an open lab's way out (diverted like the
 * uplink's when the edge blocks), a closed lab's HTTPS to the fleet's hosts
 * (`fleet`, fleetHosts), and everything else a closed lab sends blocked and
 * logged. A closed lab's names are the same list's and no more: its port 53
 * goes to dnsmasq, which asks the edge's Unbound for those and refuses the
 * rest (fleetHosts says why not Unbound itself). The uplink and open labs
 * ask Unbound as before. Suricata watches the labs as it watches the uplink.
 * Every configuration is the block the build gives the file
 * (OPNSENSE_IMAGE.grow), which holds four closed labs and blocking with a
 * coordinator name as long as DNS allows, written twice for a closed lab; a
 * configuration that did not fit would be refused here, before anything is
 * downloaded.
 * BOOTED IN QEMU that way, four labs, two of them closed, blocking: the file
 * was read whole, each lab's interface came up at its address with its DHCP
 * range, Suricata watched all five inside networks, and `pfctl -sr` showed
 * the rules above, one per interface, in this order. The fleet's alias was
 * there and empty: this sandbox has no outbound DNS to resolve it with.
 * A CLOSED LAB'S NAMES were not booted: they came after, and the image no
 * longer fit on this sandbox's disk. dnsmasq's lines were rendered from this
 * configuration with OPNsense 26.7's own template and its own config reader,
 * and run in dnsmasq 2.91 on Linux against a stand-in resolver: the fleet's
 * names and the names under them were asked of it, and every other name, of
 * any type, was REFUSED and never asked. The rdr rule is not yet seen in pf.
 *
 * TWO OF THEM (`ha`, EDGE_HA): each inside network's gateway address (the
 * uplink's 10.254.0.1, each lab's .1) is a CARP address the two share, the
 * one that is master answering it; each router has its own beside it, .2
 * for the first and .3 for the second. Each hands out its own half of the
 * DHCP range, naming the shared address as gateway and resolver, so a
 * machine's lease outlives the router that gave it. Names are asked of
 * `(self)`, which in pf includes the CARP addresses. OPNsense passes CARP's
 * own advertisements before any rule here ("CARP defaults", filter.lib.inc),
 * so the private-ranges rule does not stop them; they carry an HMAC of a
 * password made for the pair, so a machine on the uplink cannot claim the
 * gateway. The second updates an hour after the first, so the two never
 * restart together.
 *
 * WATCHED (`watch`, edge-credentials.js): a user with one API key and only
 * the status pages, a certificate of the fleet's making for the web
 * interface and API, one WAN rule passing HTTPS from private addresses, and
 * syslog to the boxes in `syslog`. docs/hypervisors.md, "Watching the edge
 * routers".
 *
 * @param {{ length?: number, wanIf?: string, lanIf?: string, block?: boolean, labs?: boolean[], fleet?: string[], ha?: { node: 0|1, password: string }|null, watch?: import('./edge-credentials.js').Watch|null, syslog?: string[] }} [opts]
 * @returns {Buffer}
 */
export function edgeConfig({ wanIf = 'xn0', lanIf = 'xn1', block = false, labs = [], fleet = [], ha = null, watch = null, syslog = [], length = OPNSENSE_IMAGE.grow.room } = {}) {
  const watched = watch ? watchConfig(watch, syslog) : null;
  const { address, prefix } = EDGE.lan;
  if (ha && !((ha.node === 0 || ha.node === 1) && /^[0-9a-f]{16,64}$/.test(ha.password))) throw new Error('a pair of edges needs which one this is and their shared password');
  /** This router's own address on a network whose gateway is `gw` (x.y.z.1). @param {string} gw */
  const own = (gw) => (ha ? gw.replace(/\.1$/, `.${2 + ha.node}`) : gw);
  /** This router's share of a network's DHCP range. @param {string} gw */
  const range = (gw) => {
    const [lo, hi] = ha ? (ha.node === 0 ? [100, 174] : [175, 250]) : [100, 250];
    return [gw.replace(/\.1$/, `.${lo}`), gw.replace(/\.1$/, `.${hi}`)];
  };
  const [from, to] = range(address);
  if (labs.length > LAB.max) throw new Error(`an edge has room for ${LAB.max} labs, not ${labs.length}`);
  if (labs.includes(false) && !fleet.length) throw new Error('a closed lab needs the fleet’s hosts to let through');
  const labIf = labs.map((_, i) => `opt${i + 1}`);
  const openIf = labIf.filter((_, i) => labs[i]);
  const closedIf = labIf.filter((_, i) => !labs[i]);
  /** @param {number} seq @param {string} action @param {string} body @param {string} descr @param {string} [on] */
  const rule = (seq, action, body, descr, on = 'lan') =>
    `<rule><enabled>1</enabled><sequence>${seq}</sequence><action>${action}</action><quick>1</quick><interface>${on}</interface>` +
    `<direction>in</direction><ipprotocol>inet</ipprotocol>${body}<description>${descr}</description></rule>`;
  const divert = block ? `<divert-to>${EDGE_FILTER.divertPort}</divert-to>` : '';
  // THE SAME FIRST THREE RULES FOR EVERY INSIDE INTERFACE. Without labs they
  // are the uplink's alone, exactly as booted before labs existed; with them,
  // each rule names the uplink and every lab, from anything on them, and
  // names come from the edge's own address on whichever it arrived on.
  const inside = ['lan', ...labIf].join(',');
  const src = labs.length ? 'any' : 'lan';
  const self = labs.length || ha ? '(self)' : 'lanip';
  const out = ['lan', ...openIf].join(',');
  const closed = closedIf.join(',');
  const labRules = closedIf.length
    ? rule(9, 'pass', `<protocol>TCP</protocol><source_net>any</source_net><destination_net>fleetwright_fleet</destination_net><destination_port>443</destination_port>${divert}`, 'Closed labs reach the fleet and Claude', closed) +
      '\n' +
      rule(10, 'block', '<protocol>any</protocol><source_net>any</source_net><destination_net>any</destination_net><log>1</log>', 'Nothing else leaves a closed lab', closed) +
      '\n'
    : '';
  const labNets = labs.map((_, i) => `${LAB.address(i + 1).replace(/\.1$/, '.0')}/${LAB.cidr}`);
  // A CLOSED LAB'S NAMES (fleetHosts): its port 53 goes to dnsmasq, which
  // has no resolver of its own and answers only the fleet's names, each by
  // asking Unbound, and refuses the rest.
  // A name under another one on the list is already answered with it.
  const names = fleet.filter((h) => /^[a-z0-9.-]+$/i.test(h) && /[a-z]/i.test(h));
  const closedNames = closedIf.length
    ? names
        .filter((h) => !names.some((o) => h.endsWith(`.${o}`)))
        // Each with its place: dnsmasq's template sorts them by it.
        .map((h, i) => `<domainoverrides><sequence>${i + 1}</sequence><domain>${h}</domain><ip>127.0.0.1</ip></domainoverrides>`)
        .join('')
    : '';
  const closedDns = closedIf.length
    ? `<rule><interface>${closed}</interface><ipprotocol>inet</ipprotocol><protocol>TCP/UDP</protocol>` +
      `<destination><network>any</network><port>53</port></destination><target>127.0.0.1</target><local-port>${DNSMASQ_PORT}</local-port><pass>pass</pass></rule>`
    : '';
  const xml =
    '<?xml version="1.0"?>\n<opnsense>\n<system>\n' +
    '<use_mfs_tmp/><use_mfs_var/><serialspeed>115200</serialspeed><primaryconsole>serial</primaryconsole><secondaryconsole>video</secondaryconsole>\n' +
    `<hostname>fleetwright-edge${ha?.node ? '-b' : ''}</hostname><domain>internal</domain>\n` +
    '<group><name>admins</name><description>System Administrators</description><scope>system</scope><gid>1999</gid><member>0</member><priv>page-all</priv></group>\n' +
    // `*` is a locked account to FreeBSD and a hash PHP never verifies: no
    // login on the console, over SSH or in the web interface.
    '<user><name>root</name><descr>System Administrator</descr><scope>system</scope><groupname>admins</groupname><password>*</password><uid>0</uid></user>\n' +
    (watched ? watched.user : '') +
    '<timezone>Etc/UTC</timezone><timeservers>0.opnsense.pool.ntp.org 1.opnsense.pool.ntp.org</timeservers>\n' +
    `<webgui><protocol>https</protocol>${watched ? watched.certref : ''}<noantilockout>1</noantilockout></webgui>\n` +
    '<disablenatreflection>yes</disablenatreflection><usevirtualterminal>1</usevirtualterminal><disableconsolemenu/>\n' +
    '<disablechecksumoffloading>1</disablechecksumoffloading><disablesegmentationoffloading>1</disablesegmentationoffloading><disablelargereceiveoffloading>1</disablelargereceiveoffloading>\n' +
    `<pf_share_forward>1</pf_share_forward><firmware><plugins>${EDGE_UPDATES.plugin}</plugins></firmware>\n` +
    '</system>\n' +
    (watched ? watched.cert : '') +
    '<interfaces>\n' +
    `<wan><enable>1</enable><if>${wanIf}</if><descr>WAN</descr><ipaddr>dhcp</ipaddr><blockpriv>0</blockpriv><blockbogons>0</blockbogons></wan>\n` +
    `<lan><enable>1</enable><if>${lanIf}</if><descr>LAN</descr><ipaddr>${own(address)}</ipaddr><subnet>${prefix}</subnet></lan>\n` +
    labs.map((_, i) => `<opt${i + 1}><enable>1</enable><if>xn${i + 2}</if><descr>LAB${i + 1}</descr><ipaddr>${own(LAB.address(i + 1))}</ipaddr><subnet>${LAB.cidr}</subnet></opt${i + 1}>\n`).join('') +
    '</interfaces>\n' +
    (ha
      ? '<virtualip>' +
        [address, ...labs.map((_, i) => LAB.address(i + 1))]
          .map((gw, i) => `<vip><interface>${['lan', ...labIf][i]}</interface><mode>carp</mode><subnet>${gw}</subnet><subnet_bits>${i ? LAB.cidr : prefix}</subnet_bits><password>${ha.password}</password><vhid>${EDGE_HA.vhid + i}</vhid><advbase>1</advbase><advskew>${ha.node * 100}</advskew></vip>`)
          .join('') +
        '</virtualip>\n'
      : '') +
    `<dnsmasq><enable>1</enable><port>${DNSMASQ_PORT}</port><interface>${['lan', ...labIf].join(',')}</interface>${closedIf.length ? '<no_resolv>1</no_resolv>' : ''}<dhcp_ranges><interface>lan</interface><start_addr>${from}</start_addr><end_addr>${to}</end_addr></dhcp_ranges>` +
    labIf.map((on, i) => `<dhcp_ranges><interface>${on}</interface><start_addr>${range(LAB.address(i + 1))[0]}</start_addr><end_addr>${range(LAB.address(i + 1))[1]}</end_addr></dhcp_ranges>`).join('') +
    // The shared address as gateway (3) and resolver (6), not this router's.
    (ha
      ? [address, ...labs.map((_, i) => LAB.address(i + 1))]
          .flatMap((gw, i) => [3, 6].map((o) => `<dhcp_options><type>set</type><option>${o}</option><interface>${['lan', ...labIf][i]}</interface><value>${gw}</value></dhcp_options>`))
          .join('')
      : '') +
    closedNames +
    '</dnsmasq>\n' +
    `<nat><outbound><mode>automatic</mode></outbound>${closedDns}</nat>\n<filter/>\n` +
    '<OPNsense><Firewall>\n' +
    '<Alias><aliases><alias><enabled>1</enabled><name>fleetwright_private</name><type>network</type>' +
    `<content>${NOT_FROM_LABS.join('\n')}</content></alias>` +
    '<alias><enabled>1</enabled><name>fleetwright_dns</name><type>port</type><content>53\n853</content></alias>' +
    (closedIf.length ? `<alias><enabled>1</enabled><name>fleetwright_fleet</name><type>host</type><content>${fleet.join('\n')}</content></alias>` : '') +
    '</aliases></Alias>\n' +
    '<Filter><rules>\n' +
    rule(1, 'pass', `<protocol>TCP/UDP</protocol><source_net>${src}</source_net><destination_net>${self}</destination_net><destination_port>53</destination_port>`, 'Labs ask the edge for names', inside) +
    '\n' +
    rule(2, 'block', `<protocol>TCP/UDP</protocol><source_net>${src}</source_net><destination_net>any</destination_net><destination_port>fleetwright_dns</destination_port>`, 'No other resolver', inside) +
    '\n' +
    rule(3, 'block', `<protocol>any</protocol><source_net>${src}</source_net><destination_net>fleetwright_private</destination_net>`, 'Nothing private', inside) +
    '\n' +
    rule(4, 'pass', `<protocol>any</protocol><source_net>${src}</source_net><destination_net>any</destination_net>${divert}`, 'Labs reach the internet', out) +
    '\n' +
    labRules +
    // THE ONE WAY IN, for the box that reads how the router is: HTTPS to its
    // WAN address from a private one. Inside, every network already blocks
    // private destinations, the router's own addresses among them.
    (watched
      ? rule(20, 'pass', '<protocol>TCP</protocol><source_net>fleetwright_private</source_net><destination_net>wanip</destination_net><destination_port>443</destination_port>', 'Fleetwright reads how it is', 'wan') + '\n'
      : '') +
    '</rules><snatrules/><npt/><onetoone/></Filter>\n</Firewall>\n' +
    // Fixed ids, so the same edge is the same bytes, and the IDS can name its cron job.
    '<unboundplus version="1.0.14"><general><enabled>1</enabled></general><dnsbl><blocklist uuid="5c0e8a3e-6f1d-4b8a-9d2e-1a7b3c4d5e01">' +
    `<enabled>1</enabled><type>${EDGE_FILTER.blocklists.join(',')}</type><description>Threats</description></blocklist></dnsbl></unboundplus>\n` +
    `<IDS version="1.1.1"><general><enabled>1</enabled>${block ? '<mode>divert</mode>' : ''}<interfaces>${['lan', ...labIf].join(',')}</interfaces><homenet>${[`${EDGE.lan.address.replace(/\.\d+$/, '.0')}/${prefix}`, ...labNets].join(',')}</homenet>` +
    '<UpdateCron>5c0e8a3e-6f1d-4b8a-9d2e-1a7b3c4d5e03</UpdateCron></general><files>' +
    EDGE_FILTER.rules.map((f, i) => `<file uuid="${RULE_FILE_UUID}${i}"><filename>${f}</filename><enabled>1</enabled></file>`).join('') +
    '</files>' +
    // Every rule in those files whose action is alert becomes drop: OPNsense
    // applies it as it installs each download (installRules.py).
    (block
      ? '<policies><policy uuid="5c0e8a3e-6f1d-4b8a-9d2e-1a7b3c4d5e04"><enabled>1</enabled><action>alert</action>' +
        `<rulesets>${EDGE_FILTER.rules.map((_, i) => `${RULE_FILE_UUID}${i}`).join(',')}</rulesets><new_action>drop</new_action></policy></policies>`
      : '') +
    '</IDS>\n<cron version="1.0.3"><jobs>' +
    `<job uuid="5c0e8a3e-6f1d-4b8a-9d2e-1a7b3c4d5e02"><enabled>1</enabled><command>unbound dnsbl</command><minutes>${EDGE_FILTER.every}</minutes><hours>*</hours><description>Blocklists</description></job>` +
    `<job uuid="5c0e8a3e-6f1d-4b8a-9d2e-1a7b3c4d5e03"><origin>IDS</origin><enabled>1</enabled><command>ids update</command><minutes>${EDGE_FILTER.every}</minutes><hours>*</hours><description>Rules</description></job>` +
    // No id (nothing names this job; OPNsense gives it one) and no minutes:
    // Cron.xml's default is 0, and the saved model writes it in, as it wrote
    // the days, months and weekdays the jobs above leave out (crontab read
    // back from the booted edge). `enabled` stays, as the IDS policy's does
    // (ROOM, in this function's comment).
    `<job><enabled>1</enabled><command>firmware auto-update</command><hours>${Number(EDGE_UPDATES.hours) + (ha?.node ?? 0)}</hours><description>Updates</description></job>` +
    '</jobs></cron>\n' +
    (watched ? watched.syslog : '') +
    '</OPNsense>\n</opnsense>\n';
  const body = Buffer.from(xml, 'utf8');
  if (body.length > length) {
    throw new Error(`the edge configuration is ${body.length} bytes and the file it replaces is ${length}`);
  }
  return Buffer.concat([body, Buffer.alloc(length - body.length, 0x20)]);
}

/**
 * Is this the default configuration the nano image ships, byte for byte?
 * Checked on the bytes about to be replaced, so an offset that is wrong for
 * the image fails the build before the disk is written.
 *
 * @param {Buffer} original
 */
export function isDefaultConfig(original) {
  return createHash('sha256').update(original).digest('hex') === OPNSENSE_IMAGE.config.sha256;
}

/**
 * What the build writes into the image: the configuration in the free block
 * it moves to, and each byte of the file system that records the move
 * (OPNSENSE_IMAGE.grow), every one checked against what must be there before
 * it is replaced, and the block checked to be zeros.
 *
 * @param {Buffer} replacement  edgeConfig's answer
 * @returns {Array<{ offset: number, replacement: Buffer, check: (original: Buffer) => boolean, what: string }>}
 */
export function imagePatches(replacement) {
  const { grow } = OPNSENSE_IMAGE;
  if (replacement.length !== grow.room) throw new Error(`a configuration is ${grow.room} bytes, not ${replacement.length}`);
  return [
    ...grow.edits.map((e) => {
      const was = Buffer.from(e.was, 'hex');
      return { offset: e.offset, replacement: Buffer.from(e.becomes, 'hex'), check: (/** @type {Buffer} */ b) => b.equals(was), what: e.what };
    }),
    { offset: grow.data.offset, replacement, check: (/** @type {Buffer} */ b) => b.every((x) => x === 0), what: 'the free block the configuration moves to' },
  ];
}

/**
 * The image as it streams by, with the configuration's bytes replaced and
 * every other byte passed through untouched. Each replaced region is held
 * until it has all arrived and been checked, then let go in one piece; the
 * total is checked at the end, so a short or long image is an error rather
 * than a disk that is quietly wrong. Several regions, in order, when the file
 * is grown as well (imagePatches); one, given as `offset` and `replacement`,
 * otherwise.
 */
export class ConfigPatch extends Transform {
  /**
   * @param {{ offset?: number, replacement?: Buffer, total: number, check?: (original: Buffer) => boolean,
   *   regions?: Array<{ offset: number, replacement: Buffer, check: (original: Buffer) => boolean, what?: string }> }} opts
   */
  constructor({ offset = 0, replacement = Buffer.alloc(0), total, check = isDefaultConfig, regions }) {
    super();
    this.regions = [...(regions ?? [{ offset, replacement, check, what: 'the default configuration' }])].sort((a, b) => a.offset - b.offset);
    this.total = total;
    this.at = 0;
    /** @type {Buffer[]} */
    this.held = [];
  }

  /** @param {Buffer} chunk @param {BufferEncoding} _enc @param {(e?: Error|null) => void} done */
  _transform(chunk, _enc, done) {
    let pos = this.at;
    this.at += chunk.length;
    let rest = chunk;
    while (rest.length) {
      const region = this.regions[0];
      if (!region) {
        this.push(rest);
        break;
      }
      const end = region.offset + region.replacement.length;
      // Before the next region: let it go now.
      if (pos < region.offset) {
        const n = Math.min(rest.length, region.offset - pos);
        this.push(rest.subarray(0, n));
        rest = rest.subarray(n);
        pos += n;
        continue;
      }
      // Inside it: held until all of it is in.
      const n = Math.min(rest.length, end - pos);
      this.held.push(rest.subarray(0, n));
      rest = rest.subarray(n);
      pos += n;
      if (pos < end) break;
      const original = Buffer.concat(this.held);
      this.held = [];
      if (!region.check(original)) {
        return done(new Error(`the OPNsense image does not have ${region.what || 'the default configuration'} where it should, so it was not written`));
      }
      this.push(Buffer.from(region.replacement));
      this.regions.shift();
    }
    done();
  }

  /** @param {(e?: Error|null) => void} done */
  _flush(done) {
    if (this.held.length) return done(new Error('the OPNsense image ended inside its configuration'));
    if (this.at !== this.total) return done(new Error(`the OPNsense image unpacked to ${this.at} bytes, not ${this.total}`));
    done();
  }
}

/**
 * The image, downloaded once into `dir` and checked against its pinned
 * SHA-256 every time it is used, so a file damaged on disk is downloaded
 * again rather than built from.
 *
 * @param {{ dir: string, fetchImpl?: typeof fetch, onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} opts
 * @returns {Promise<string>} the path of the checked file
 */
export function fetchImage({ dir, fetchImpl = fetch, onProgress = () => {}, signal }) {
  return fetchPinned({
    dir,
    url: OPNSENSE_IMAGE.url,
    size: OPNSENSE_IMAGE.compressedSize,
    algorithm: 'sha256',
    digest: OPNSENSE_IMAGE.sha256,
    label: 'OPNsense',
    fetchImpl,
    onProgress,
    signal,
  });
}

/**
 * A pinned download: kept in `dir` under its own name, used again only while
 * its size and digest still match, and fetched again otherwise. Shared by the
 * edge router's image and the machine image's (vm-image.js), which differ
 * only in what they pin.
 *
 * @param {{ dir: string, url: string, size: number, algorithm: 'sha256'|'sha512', digest: string, label: string, fetchImpl?: typeof fetch, onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} opts
 * @returns {Promise<string>} the path of the checked file
 */
export async function fetchPinned({ dir, url, size, algorithm, digest, label, fetchImpl = fetch, onProgress = () => {}, signal }) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(new URL(url).pathname));
  if (existsSync(file) && statSync(file).size === size && (await digestOf(file, algorithm)) === digest) {
    return file;
  }
  const part = `${file}.part`;
  rmSync(part, { force: true });
  const res = await fetchImpl(url, signal ? { signal } : undefined);
  if (!res.ok || !res.body) throw new Error(`${label}'s mirror answered ${res.status} for the image`);
  const hash = createHash(algorithm);
  let got = 0;
  let told = 0;
  const count = new Transform({
    transform(chunk, _e, cb) {
      hash.update(chunk);
      got += chunk.length;
      if (got - told >= 16 * 1024 * 1024) {
        told = got;
        onProgress(got, size);
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(/** @type {any} */ (res.body), count, createWriteStream(part), signal ? { signal } : {});
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  const seen = hash.digest('hex');
  if (seen !== digest) {
    rmSync(part, { force: true });
    const name = algorithm === 'sha512' ? 'SHA-512' : 'SHA-256';
    throw new Error(`the ${label} image downloaded with ${name} ${seen.slice(0, 16)}…, not the published ${digest.slice(0, 16)}…, so it was not used`);
  }
  renameSync(part, file);
  return file;
}

/** @param {string} file @param {'sha256'|'sha512'} algorithm */
async function digestOf(file, algorithm) {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * The raw disk, unpacked by bzip2 as it is read. Node has no bzip2 of its
 * own; a machine without the tool is told which package to install.
 *
 * @param {string} file
 * @param {{ spawnImpl?: typeof spawn, signal?: AbortSignal }} [opts]
 */
export function unpack(file, { spawnImpl = spawn, signal } = {}) {
  const child = spawnImpl('bzip2', ['-dc', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  signal?.addEventListener('abort', () => child.kill(), { once: true });
  let said = '';
  child.stderr?.on('data', (d) => {
    said = (said + d).slice(-400);
  });
  child.on('error', (/** @type {any} */ e) => {
    child.stdout?.destroy(
      e?.code === 'ENOENT'
        ? new Error('this machine has no bzip2 to unpack the OPNsense image with. Install it (apt install bzip2) and apply again')
        : e,
    );
  });
  child.on('close', (code) => {
    if (code) child.stdout?.destroy(new Error(`bzip2 could not unpack the OPNsense image: ${said.trim() || `exit ${code}`}`));
  });
  return /** @type {import('node:stream').Readable} */ (child.stdout);
}

/**
 * Upload a raw disk to the URL `disk.import` answered with, as the one file
 * part Xen Orchestra's handler expects, over a connection held to the same
 * pin as the API (or plain HTTP when the person accepted that). Answers the
 * new VDI's id.
 *
 * @param {{ address: string, pin: string|null, plain: boolean, sendTo: string, body: import('node:stream').Readable, size: number, filename?: string, onProgress?: (done: number, total: number) => void, connectTls?: typeof connectPinnedTls, signal?: AbortSignal }} opts
 * @returns {Promise<string>}
 */
export async function uploadDisk({ address, pin, plain, sendTo, body, size, filename = 'opnsense.img', onProgress = () => {}, connectTls = connectPinnedTls, signal }) {
  const { host, port } = splitAddress(address, plain ? 80 : 443);
  const socket = plain ? await connectPlain(host, port) : await connectTls({ host, port, pin: /** @type {string} */ (pin) });
  const boundary = `fleetwright${Date.now().toString(36)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const hostHeader = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
  return await new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST',
      path: sendTo,
      headers: {
        Host: hostHeader,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(head.length + size + tail.length),
      },
      createConnection: () => /** @type {any} */ (socket),
    });
    req.on('error', reject);
    // CANCEL STOPS THE BYTES, not only the steps after them: the request is
    // torn down and the body with it, and ensureEdge clears up after.
    signal?.addEventListener(
      'abort',
      () => {
        const e = new Error('cancelled');
        body.destroy();
        req.destroy(e);
        reject(e);
      },
      { once: true },
    );
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        text = (text + d).slice(0, 64 * 1024);
      });
      res.on('end', () => {
        /** @type {any} */
        let answer = null;
        try {
          answer = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        if (res.statusCode === 200 && typeof answer?.result === 'string') return resolve(answer.result);
        reject(new Error(`Xen Orchestra did not take the disk: ${answer?.error?.message ?? `HTTP ${res.statusCode}`}`));
      });
    });
    let sent = 0;
    let told = 0;
    req.write(head);
    body.on('data', (chunk) => {
      sent += chunk.length;
      if (sent - told >= 64 * 1024 * 1024) {
        told = sent;
        onProgress(sent, size);
      }
      if (!req.write(chunk)) body.pause();
    });
    req.on('drain', () => body.resume());
    body.on('error', (e) => {
      req.destroy(e);
      reject(e);
    });
    body.on('end', () => {
      if (sent !== size) {
        req.destroy();
        return reject(new Error(`the disk was ${sent} bytes, not the ${size} announced`));
      }
      req.end(tail);
    });
  });
}

/**
 * Write `body`, a VHD of the blocks to change (vhd.js), into a disk that is
 * already there, at the URL `disk.importContent` answered with. Its handler
 * reads the request itself rather than a form, as disk.import's does, and
 * answers `true` (xo-server's api/disk.mjs, handleImportContent), so the body
 * goes as it is, with its length, over the same pinned connection.
 *
 * @param {{ address: string, pin: string|null, plain: boolean, sendTo: string, body: Buffer, connectTls?: typeof connectPinnedTls, signal?: AbortSignal }} opts
 * @returns {Promise<void>}
 */
export async function writeIntoDisk({ address, pin, plain, sendTo, body, connectTls = connectPinnedTls, signal }) {
  const { host, port } = splitAddress(address, plain ? 80 : 443);
  const socket = plain ? await connectPlain(host, port) : await connectTls({ host, port, pin: /** @type {string} */ (pin) });
  const hostHeader = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
  await new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST',
      path: sendTo,
      headers: { Host: hostHeader, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) },
      createConnection: () => /** @type {any} */ (socket),
    });
    req.on('error', reject);
    signal?.addEventListener(
      'abort',
      () => {
        const e = new Error('cancelled');
        req.destroy(e);
        reject(e);
      },
      { once: true },
    );
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        text = (text + d).slice(0, 64 * 1024);
      });
      res.on('end', () => {
        /** @type {any} */
        let answer = null;
        try {
          answer = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        if (res.statusCode === 200 && answer?.result === true) return resolve(undefined);
        reject(new Error(`Xen Orchestra did not write into the disk: ${answer?.error?.message ?? `HTTP ${res.statusCode}`}`));
      });
    });
    req.end(body);
  });
}

/** @param {string} host @param {number} port @returns {Promise<net.Socket>} */
function connectPlain(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

/** @param {number} n */
const mb = (n) => Math.round(n / 1024 ** 2);

/**
 * Make the uplink if the pool has none, and let the fleet use it. Answers
 * its id.
 *
 * @param {{ admin: any, pool: string, networks: any[], setId: string, inSet: string[] }} opts
 */
export async function ensureUplink({ admin, pool, networks, setId, inSet }) {
  let uplink = networks.find((n) => n?.name_label === EDGE.uplink && n?.$pool === pool)?.id;
  if (!uplink) {
    uplink = await admin.call('network.create', {
      pool,
      name: EDGE.uplink,
      description: 'The network labs leave through, behind the edge router. Made by Fleetwright.',
    });
  }
  if (!inSet.includes(uplink)) await admin.call('resourceSet.addObject', { id: setId, object: uplink });
  return /** @type {string} */ (uplink);
}

/** What a group network is called in Xen Orchestra, numbered from 1. */
export const GROUP_PREFIX = 'fleetwright-group-';
/** The most group networks a policy makes on one pool. */
export const MAX_GROUPS = 4;

/**
 * Group networks: private networks in the pool with no physical interface,
 * so nothing reaches them but the machines on them. A machine joins one as
 * well as its own network to reach the others in its group (docs/
 * hypervisors.md, "Machines that work together"). Made by the policy job,
 * which holds the admin sign-in, because the fleet's limited user cannot
 * make networks; then put in the resource set, so it can use them. Never
 * removed here: a machine may be on one.
 *
 * @param {{ admin: any, pool: string, networks: any[], setId: string, inSet: string[], count: number }} opts
 * @returns {Promise<string[]>} the names made now
 */
export async function ensureGroups({ admin, pool, networks, setId, inSet, count }) {
  /** @type {string[]} */
  const made = [];
  for (let i = 1; i <= Math.min(count, MAX_GROUPS); i++) {
    const name = `${GROUP_PREFIX}${i}`;
    let id = networks.find((n) => n?.name_label === name && n?.$pool === pool)?.id;
    if (!id) {
      id = await admin.call('network.create', {
        pool,
        name,
        description: 'Machines in a group reach each other here, and nothing else does. Made by Fleetwright.',
      });
      made.push(name);
    }
    if (!inSet.includes(id)) await admin.call('resourceSet.addObject', { id: setId, object: id });
  }
  return made;
}

/**
 * LAB NETWORKS, for the labs on the edge (LAB): private networks in the pool
 * with no interface of their own, `fleetwright-lab-1` on, as many as asked,
 * each tagged open or closed, and put in the resource set so the fleet's
 * machines can go on them. Made by the policy job, which holds the admin
 * sign-in, because the fleet's limited user cannot make networks or tag one.
 *
 * NEVER REMOVED, like a group network: a machine may be on one. One past the
 * number asked loses its kind's tag, and with it the box stops offering it
 * (xo-pools.js reads the tag), and the edge built without it has no
 * interface there, so a machine left on it reaches nothing.
 *
 * LABS PER PERSON (`perPerson`) goes on each lab as LAB.eachTag: a number is
 * written, null takes it off (no limit), and undefined, from a phone that
 * predates the setting, leaves each lab's as it is.
 *
 * @param {{ admin: any, pool: string, networks: any[], setId: string, inSet: string[], open: number, closed: number, perPerson?: number|null }} opts
 * @returns {Promise<{ labs: Array<{ id: string, name: string, open: boolean }>, made: string[] }>}
 */
export async function ensureLabs({ admin, pool, networks, setId, inSet, open, closed, perPerson }) {
  const count = Math.min(LAB.max, open + closed);
  /** @type {Array<{ id: string, name: string, open: boolean }>} */
  const labs = [];
  /** @type {string[]} */
  const made = [];
  const there = (/** @type {string} */ name) => networks.find((n) => n?.name_label === name && n?.$pool === pool);
  for (let i = 1; i <= count; i++) {
    const name = `${LAB.prefix}${i}`;
    const isOpen = i <= open;
    const found = there(name);
    let id = found?.id;
    if (!id) {
      id = await admin.call('network.create', {
        pool,
        name,
        description: 'A lab: machines on it reach each other, and the rest only through the edge router, by the lab’s rules. Made by Fleetwright.',
      });
      made.push(name);
    }
    const tags = Array.isArray(found?.tags) ? found.tags : [];
    const want = isOpen ? LAB.openTag : LAB.closedTag;
    const other = isOpen ? LAB.closedTag : LAB.openTag;
    if (tags.includes(other)) await admin.call('tag.remove', { id, tag: other });
    if (!tags.includes(want)) await admin.call('tag.add', { id, tag: want });
    if (perPerson !== undefined) {
      const each = perPerson === null ? null : `${LAB.eachTag}${perPerson}`;
      for (const t of tags) if (t.startsWith(LAB.eachTag) && t !== each) await admin.call('tag.remove', { id, tag: t });
      if (each && !tags.includes(each)) await admin.call('tag.add', { id, tag: each });
    }
    if (!inSet.includes(id)) await admin.call('resourceSet.addObject', { id: setId, object: id });
    labs.push({ id: String(id), name, open: isOpen });
  }
  // ONE NO LONGER ASKED FOR is no longer a lab: its kind goes, and its limit.
  for (const n of networks) {
    const m = new RegExp(`^${LAB.prefix}(\\d+)$`).exec(String(n?.name_label || ''));
    if (!m || n?.$pool !== pool || Number(m[1]) <= count) continue;
    for (const tag of Array.isArray(n.tags) ? n.tags : []) {
      if (tag === LAB.openTag || tag === LAB.closedTag || tag.startsWith(LAB.eachTag)) await admin.call('tag.remove', { id: n.id, tag });
    }
  }
  return { labs, made };
}

/**
 * Where the router's disk goes: the storage the person chose for it, or,
 * when they chose none (a phone that predates the choice), the storage the
 * fleet may use in this pool with the most room. Either must be in the pool
 * and have room for the whole raw disk.
 *
 * @param {{ pool: string, srs: any[], fleetSrs: string[], sr?: string|null }} opts
 */
export function edgeStorage({ pool, srs, fleetSrs, sr = null }) {
  const room = (/** @type {any} */ s) => (Number(s?.size) || 0) - (Number(s?.physical_usage) || 0);
  const fits = (/** @type {any} */ s) => s?.$pool === pool && room(s) > OPNSENSE_IMAGE.rawSize;
  if (sr) {
    const chosen = srs.find((s) => s?.id === sr);
    if (!chosen || chosen.$pool !== pool) throw new Error('the storage chosen for the edge router is not in the way out’s pool. Nothing was built');
    if (!fits(chosen)) throw new Error(`${srName(chosen)} has no 3 GiB free for the edge router. Nothing was built`);
    return chosen;
  }
  const best = srs.filter((s) => fleetSrs.includes(s?.id) && fits(s)).sort((a, b) => room(b) - room(a))[0];
  if (!best) throw new Error('none of the storage the fleet may use in this pool has 3 GiB free for the edge router. Choose where its disk goes. Nothing was built');
  return best;
}

/** A storage repository as a person knows it. @param {any} sr */
export const srName = (sr) => String(sr?.name_label || sr?.id || 'the storage').slice(0, 80);

/**
 * How far a build has got, for the bar: which of its stages is running, and
 * how far through the whole build that is, in thousandths. Weighted by the
 * bytes each stage moves (the download, then the disk), because those are
 * nearly all of the time; making and starting the VM is the last fiftieth.
 *
 * WHAT THE BYTES ARE DOING, beside the part, while they move: a key from
 * XOBUILD_DOING and the megabytes done and in all. The sentence beside it
 * says the same with the release and the storage named, and only the key
 * and the numbers reach a Lock Screen (xo-setup.js, #report).
 *
 * @typedef {{ stage: number, stages: number, fill: number, doing?: string, done?: number, total?: number }} BuildPart
 */
export const BUILD_STAGES = 3;
const MAKING = 980;
/** @param {number} downloaded @param {number} written */
export function buildFill(downloaded, written) {
  const bytes = OPNSENSE_IMAGE.compressedSize + OPNSENSE_IMAGE.rawSize;
  return Math.min(MAKING, Math.floor((MAKING * (Math.min(downloaded, OPNSENSE_IMAGE.compressedSize) + Math.min(written, OPNSENSE_IMAGE.rawSize))) / bytes));
}

/**
 * The edge router on this pool: left as it is when it is there (its WAN moved
 * to the way out if that changed, and started if it was stopped), built when
 * it is not. Answers the sentence the job finishes with.
 *
 * WHAT THE PERSON IS TOLD, AS IT GOES: which stage of three, how far through
 * the whole build in thousandths (`say`'s second argument), and in the words,
 * the megabytes and the storage the disk is going on. Asked for: "this needs
 * proper progress, also which disk did it put it on?" The first version held
 * the bar at the step and never named the storage.
 *
 * CANCEL STOPS IT. `signal` aborts the download, the unpack and the upload
 * where they are, and what was made is removed: the VM with its disk, the
 * disk on its own, or a partial disk Xen Orchestra kept from an upload that
 * was cut off (unattached, named for the router, on the storage it was going
 * to). The first version's Cancel waited for the build to finish.
 *
 * BLOCK OR WATCH (`block`): true builds an edge that drops what its threat
 * rules match, false one that only logs it, and null leaves an edge that is
 * there as it is (a phone that predates the choice sends nothing, and must
 * not cost anybody their edge). The edge cannot be changed in place, since
 * it has no login, so an edge built the other way is REBUILT (replaceRouter):
 * a new one built beside it while it runs, then the old one stopped and the
 * new one started and watched for a while (settled), and only then the old
 * one removed. If the build fails the old one was never touched; if the new
 * one cannot start, or stops again while it is watched, it is removed and
 * the old one started again, so the pool is never left with neither. What
 * the machines behind it notice is the way out gone while the new one
 * boots. It was gone for as long as the build took, the old one stopped
 * before the download. `rebuilding` is told first, so the job can say
 * "rebuilding" rather than "building" if it is cancelled.
 *
 * LABS (`labs`): the lab networks the edge is to have an interface on, in
 * order, each open or closed (ensureLabs makes them), and `fleet`, the hosts
 * a closed lab may still reach (fleetHosts). Null leaves an edge that is
 * there with whatever labs it has, as `block` does. An edge built with other
 * labs is rebuilt the same way, keeping how it filters unless `block` says
 * otherwise: an interface cannot be given to a VM with no login and have
 * rules written for it, so the configuration is built again with it.
 *
 * WATCHED (`watch`, `syslog`): the key and certificate a box reads the
 * routers with (edge-credentials.js), and the boxes their logs go to. A
 * router built without a key is rebuilt once to have one, the way an edge
 * from before it updated itself was; one built with it keeps it, and the
 * syslog targets are not a reason to rebuild, since they follow whichever
 * machine ran the job last. Null builds as before.
 *
 * @param {{
 *   admin: any,
 *   pool: string,
 *   egress: { id: string, name: string },
 *   uplink: string,
 *   srs: any[],
 *   fleetSrs: string[],
 *   sr?: string|null,
 *   block?: boolean|null,
 *   labs?: Array<{ id: string, open: boolean }>|null,
 *   ha?: boolean|null,
 *   fleet?: string[],
 *   watch?: import('./edge-credentials.js').Watch|null,
 *   syslog?: string[],
 *   rebuilding?: () => void,
 *   address: string, pin: string|null, plain: boolean,
 *   imageDir: string,
 *   say: (text: string, part?: BuildPart) => void,
 *   signal?: AbortSignal,
 *   sleep?: (ms: number) => Promise<void>,
 *   settle?: { ms: number, every: number },
 *   getImage?: typeof fetchImage,
 *   unpackImpl?: typeof unpack,
 *   upload?: typeof uploadDisk,
 *   writeInto?: typeof writeIntoDisk,
 * }} opts
 */
export async function ensureEdge(opts) {
  const { admin, pool, egress, labs = null, ha = null, rebuilding, say } = opts;
  const vms = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {}));
  const ours = vms.filter((v) => v?.$pool === pool && v?.tags?.includes?.(EDGE.tag));
  const second = ours.find((v) => v.tags.includes(`${EDGE_HA.nodeTag}1`)) ?? null;
  const edge = ours.find((v) => v !== second) ?? null;
  // WHAT XEN ORCHESTRA SHOWED EVERYBODY: routers built before the pair's
  // password and the key were kept where only an admin reads them carry both
  // in the clear (edge-credentials.js, EDGE_KEPT). Taken off first, and never
  // trusted again: nothing is kept for them, so a pair is made again with a
  // new password and each router with a new key, and the person's phone is
  // handed the new key at the end of the job.
  const exposed = ours.some(exposedOn);
  await clearExposed(admin, ours);
  const wantPair = ha ?? Boolean(second);
  if (!wantPair && !second) return ensureOne(opts, edge);

  // BACK TO ONE: the second goes, and the first is rebuilt on its own, since
  // its configuration gives the gateway address to CARP rather than to it.
  if (!wantPair && second) {
    rebuilding?.();
    say(`Going back to one edge router: the second is removed, and the first is rebuilt on its own while it still carries the machines. ${ONE_BOOT}`);
    if (second.power_state !== 'Halted') await admin.call('vm.stop', { id: second.id, force: true });
    await admin.call('vm.delete', { id: second.id, deleteDisks: true });
    return ensureOne(opts, edge, true);
  }

  const now = edge ? await edgeState(admin, edge, opts) : null;
  const secondState = second ? await edgeState(admin, second, opts) : null;
  // HALF A PAIR: a router beside the second that does not carry the first's
  // node tag is not the pair's first. It is the single router from before
  // "two" was applied, left stopped when the first failed to build (FROM ONE
  // TO TWO, below), with 10.254.0.1 as its own address and the whole DHCP
  // range; or there is no router beside the second at all, the first deleted
  // by hand. The first version read the stopped one as the pair's first,
  // found nothing to change, and started it beside the second, which holds
  // that address by CARP and hands out half of that range: two routers
  // answering for each other, which is what "applying again finishes the
  // pair" delivered. With no router beside the second it built a second
  // second, with a new password, beside the old one. Either is the pair
  // unfinished (FINISHING THE PAIR, below): the first is built fresh beside
  // the second, with the password the second carries the mark of, and the
  // old single router is removed without ever being started.
  const halfPair = Boolean(second) && !(edge && edge.tags.includes(`${EDGE_HA.nodeTag}0`));
  /** Whether a router differs from what the policy asks of it. @param {Awaited<ReturnType<typeof edgeState>>|null} st */
  const differs = (st) => Boolean(st && (st.filterChanged || st.wantLabs !== st.hasLabs || !st.onLabs || !st.updates || st.unwatched));
  // EITHER OF THEM. Only the first was asked, so a pair whose second differs
  // (finished in two runs that were answered differently) stayed so for good.
  const changed = differs(now) || differs(secondState) || exposed;
  const keep = opts.block ?? (halfPair ? secondState?.blocks : now?.blocks) ?? false;
  const both = [edge, second].filter(Boolean);

  // A PAIR THAT IS THERE AND WANTS NOTHING NEW: its WANs follow the way out
  // and a stopped one is started, as one edge's would be.
  if (edge && second && now && !halfPair && !changed) {
    /** @type {string[]} */
    const said = [];
    for (const v of both) {
      const vifs = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VIF', $VM: v.id } })) || {}));
      const wan = vifs.find((x) => String(x?.device) === '0');
      if (wan && wan.$network !== egress.id) {
        await admin.call('vif.set', { id: wan.id, network: egress.id });
        said.push(`${v.name_label}’s WAN moved to ${egress.name}.`);
      }
      if (v.power_state !== 'Running') {
        await admin.call('vm.start', { id: v.id });
        said.push(`${v.name_label} was stopped, and was started.`);
      }
    }
    const at = both.map((v) => `${v.name_label} ${wanAddressOf(v) ? `at ${wanAddressOf(v)}` : 'at an address Xen Orchestra does not know yet'}`);
    return [
      `The edge routers were already there, a pair on ${egress.name} sharing ${EDGE.lan.address}, ${now.blocks ? 'dropping' : 'logging'} what their threat rules match${now.hasLabs ? `, with ${labsSaid(now.hasLabs)}` : ''}: ${at.join(', ')}.`,
      ...said,
    ].join(' ');
  }

  rebuilding?.();
  // THE LABS A REBUILD CARRIES: the ones asked for, or, when the policy asks
  // nothing of labs (null: a phone from before them, a box that offers none,
  // the one-time rebuilds for the key or the daily update), the ones the
  // routers have, read from the tag and the interfaces (labsOf); the second's
  // when the first is not the pair's. This was `labs ?? []`, so a rebuild
  // for any other reason took every lab off the edge.
  const carried = labs ?? labsOf(halfPair ? secondState : now);
  /** @param {0|1} node @param {string} password @param {string} wanMac */
  const build = (node, password, wanMac, start = true) => buildEdge({ ...opts, block: keep, labs: carried, ha: { node, password }, wanMac, start });
  const replacing = { admin, say, signal: opts.signal, sleep: opts.sleep, settle: opts.settle };
  const nameOf = (/** @type {0|1} */ node) => (node ? EDGE_HA.second : EDGE.vm);
  const labsIn = carried.length ? `, with ${labsSaid(labsKey(carried))}` : '';

  // ONE AT A TIME, when both are there: the second is replaced while the
  // first carries the machines, then the first while the second does, with
  // the password the pair has, so the new one and the old one agree. Each
  // the way replaceRouter does it: built while the old one runs, and watched
  // after it starts before the old one goes.
  const kept = await keptFor(admin, pool);
  // KNOWN only when a router carries its mark: what was kept for a build that
  // never finished is not what the routers have.
  const known = kept.carp && [edge, second].some((v) => keptOn(v, EDGE_KEPT.carpMark) === markCarp(/** @type {string} */ (kept.carp))) ? kept.carp : null;
  /** @param {Array<[0|1, any]>} list @param {string} password */
  const oneAtATime = async (list, password) => {
    /** @type {string[]} */
    const watched = [];
    for (const [node, old] of list) {
      const mac = await wanMacFor(admin, old, pool, node);
      const { up } = await replaceRouter(replacing, { old, name: nameOf(node), was: `${old.name_label || nameOf(node)}, which it was replacing,`, build: (start) => build(node, password, mac, start) });
      await admin.call('vm.delete', { id: old.id, deleteDisks: true });
      watched.push(settledSaid(nameOf(node), up));
    }
    return watched.join(' ');
  };
  if (edge && second && known && !halfPair) {
    say('Rebuilding the edge routers one at a time. Machines behind them keep their way out, apart from a moment as each hands over.');
    const watched = await oneAtATime([[1, second], [0, edge]], known);
    return `Both edge routers were rebuilt, one at a time, ${keep ? 'dropping' : 'logging'} what their threat rules match${labsIn}. They share ${EDGE.lan.address}, and each updates itself an hour apart from the other, from ${EDGE_UPDATES.hours}:00 UTC. ${watched}`;
  }

  // FINISHING THE PAIR (HALF A PAIR, above), with the password the second
  // carries the mark of: the first is built beside the running second and
  // watched, then the old single router, which was never started, is
  // removed. Should the second differ from what is asked as well, it is
  // then replaced beside the new first, one at a time as above.
  if (second && known && halfPair) {
    if (edge) {
      say(`Finishing the pair: ${EDGE.vm} is built beside ${EDGE_HA.second}, which carries the machines meanwhile, and the edge router from before the pair, left stopped since it would clash with ${EDGE_HA.second}, is then removed.`);
      // Running beside the second, by hand or by the first version of this:
      // the two answer for each other, so that ends before anything else.
      if (edge.power_state !== 'Halted') await admin.call('vm.stop', { id: edge.id, force: true });
    } else {
      say(`${EDGE_HA.second} is on its own: ${EDGE.vm} is built beside it, with the password the pair has.`);
    }
    const mac = await wanMacFor(admin, edge, pool, 0);
    const { up } = await replaceRouter(replacing, { old: null, name: EDGE.vm, alone: alone(Boolean(edge)), build: (start) => build(0, known, mac, start) });
    if (edge) await admin.call('vm.delete', { id: edge.id, deleteDisks: true });
    const more = differs(secondState) ? ` ${EDGE_HA.second} was then rebuilt beside it, since it too differed from what is asked. ${await oneAtATime([[1, second]], known)}` : '';
    return `The pair is complete: ${EDGE.vm} was built beside ${EDGE_HA.second}, sharing ${EDGE.lan.address}${edge ? ', and the edge router from before the pair was removed' : ''}. ${settledSaid(EDGE.vm, up)}${more}`;
  }

  // FROM ONE TO TWO, or a pair whose password is lost: the new second is
  // made but not started while the old router runs, because the old one has
  // the gateway address as its own; then the old one stops, the second
  // starts and takes the address, and the first is rebuilt beside it. The
  // machines behind it have no way out only while the second starts.
  const password = randomBytes(16).toString('hex');
  if (exposed) say('The edge routers’ shared password and the key your machines read them with were readable by everybody signed in to Xen Orchestra, so both routers are made again with new ones.');
  if (edge) {
    say('Making the second edge router, then handing over to it while the first is rebuilt. Machines behind it have no way out while the second starts.');
    // Each WAN MAC read before its router goes, so the new one is where it was.
    const macs = [await wanMacFor(admin, edge, pool, 0), await wanMacFor(admin, second, pool, 1)];
    for (const v of second ? [second] : []) {
      if (v.power_state !== 'Halted') await admin.call('vm.stop', { id: v.id, force: true });
      await admin.call('vm.delete', { id: v.id, deleteDisks: true });
    }
    const { up: upB } = await replaceRouter(replacing, { old: edge, name: EDGE_HA.second, was: 'the edge router that was there', build: (start) => build(1, password, macs[1], start) });
    // The old one is not started again if this fails: it has the gateway
    // address as its own, which the second now holds (HALF A PAIR).
    const { up: upA } = await replaceRouter(replacing, { old: null, name: EDGE.vm, alone: alone(true), build: (start) => build(0, password, macs[0], start) });
    await admin.call('vm.delete', { id: edge.id, deleteDisks: true });
    return `There are two edge routers now, sharing ${EDGE.lan.address}: when one restarts, the other carries the machines behind them. Each updates itself an hour apart from the other, from ${EDGE_UPDATES.hours}:00 UTC. The one that was there was replaced. ${settledSaid(EDGE_HA.second, upB)} ${settledSaid(EDGE.vm, upA)}`;
  }
  // A SECOND ON ITS OWN WHOSE PASSWORD IS KEPT NOWHERE (HALF A PAIR): a new
  // first with a new password cannot run beside it, since the two would not
  // hear each other and both would claim the gateway address. So the first
  // replaces it, as one router replaces another, and the second is built
  // again beside the new first.
  if (second) {
    say(`${EDGE_HA.second} is on its own and the pair’s password is kept nowhere, so both routers are made again with a new one. Machines behind it have no way out while the first starts.`);
    const mac = await wanMacFor(admin, null, pool, 0);
    const { up } = await replaceRouter(replacing, { old: second, name: EDGE.vm, was: `${EDGE_HA.second}, which it was replacing,`, build: (start) => build(0, password, mac, start) });
    await admin.call('vm.delete', { id: second.id, deleteDisks: true });
    await build(1, password, await wanMacFor(admin, null, pool, 1));
    return `There are two edge routers again, sharing ${EDGE.lan.address}: when one restarts, the other carries the machines behind them, and each updates itself an hour apart from the other, from ${EDGE_UPDATES.hours}:00 UTC. The second that was on its own was replaced. ${settledSaid(EDGE.vm, up)}`;
  }
  const a = await build(0, password, await wanMacFor(admin, null, pool, 0));
  await build(1, password, await wanMacFor(admin, null, pool, 1));
  return `${a.text} There are two edge routers, sharing ${EDGE.lan.address}: when one restarts, the other carries the machines behind them, and each updates itself an hour apart from the other, from ${EDGE_UPDATES.hours}:00 UTC.`;
}

/**
 * What is said when the first of a pair fails beside a second that carries
 * the machines: the next apply finishes the pair (FINISHING THE PAIR).
 *
 * @param {boolean} withOld whether the single router from before the pair is still there, stopped
 */
const alone = (withOld) => `${EDGE_HA.second} carries the machines on its own${withOld ? '; the old edge router is left stopped, since it would clash with it,' : ','} and applying again finishes the pair`;

/**
 * What an edge router has and what the policy asks of it.
 *
 * @param {any} admin @param {any} edge @param {{ block?: boolean|null, labs?: Array<{ id: string, open: boolean }>|null, watch?: unknown }} opts
 */
async function edgeState(admin, edge, { block = null, labs = null, watch = null }) {
  const blocks = edge?.tags?.includes?.(EDGE.blocksTag) === true;
  const hasLabs = edgeLabsOf(edge);
  const wantLabs = labs === null ? hasLabs : labsKey(labs);
  // ON THE LABS' OWN NETWORKS, not only as many of each kind: a lab network
  // made again in Xen Orchestra is a new network the old edge is not on.
  const vifs = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VIF', $VM: edge.id } })) || {}));
  return {
    blocks,
    hasLabs,
    wantLabs,
    vifs,
    filterChanged: block !== null && block !== blocks,
    // AN EDGE FROM BEFORE IT UPDATED ITSELF (EDGE_UPDATES) is rebuilt once:
    // its configuration is fixed at build, so that is the only way it gets it.
    updates: edge?.tags?.includes?.(EDGE.updatesTag) === true,
    // AN EDGE WITHOUT THE KEY THE JOB BRINGS (edge-credentials.js), from
    // before it could be watched or with its key lost, is rebuilt once, the
    // same way: the key the phone is handed must be the one the router has.
    unwatched: watch !== null && keptOn(edge, EDGE_KEPT.watchPin) !== /** @type {{ pin: string }} */ (watch).pin,
    // CARRYING THE PAIR'S PASSWORD OR THE KEY IN THE CLEAR (ensureEdge): built
    // again with new ones.
    exposed: exposedOn(edge),
    onLabs: labs === null || labs.every((l, i) => vifs.some((v) => String(v?.device) === String(i + 2) && v?.$network === l.id)),
  };
}

/**
 * One edge router, as there has always been: built, rebuilt when what it
 * filters or its labs change (or `force`), or left as it is.
 *
 * @param {Parameters<typeof ensureEdge>[0]} opts @param {any} edge @param {boolean} [force]
 */
async function ensureOne(opts, edge, force = false) {
  const { admin, egress, block = null, labs = null, rebuilding, say } = opts;
  const st = edge ? await edgeState(admin, edge, opts) : null;
  if (edge && st && (force || st.filterChanged || st.wantLabs !== st.hasLabs || !st.onLabs || !st.updates || st.unwatched || st.exposed)) {
    const keep = block ?? st.blocks;
    rebuilding?.();
    if (!force) {
      say(
        st.exposed
          ? `Rebuilding the edge router with a new key: the one it had was readable by everybody signed in to Xen Orchestra. ${ONE_BOOT}`
          : st.filterChanged
            ? keep
              ? `Rebuilding the edge router to drop what its threat rules match. ${ONE_BOOT}`
              : `Rebuilding the edge router to log what its threat rules match and drop nothing. ${ONE_BOOT}`
            : st.wantLabs !== st.hasLabs || !st.onLabs
              ? `Rebuilding the edge router with ${labsSaid(st.wantLabs)}. ${ONE_BOOT}`
              : !st.updates
                ? `Rebuilding the edge router so it keeps itself up to date and gets the Xen guest agent. ${ONE_BOOT}`
                : `Rebuilding the edge router so your machines can read how it is: whether it answers names, has its way out, and what it logs. ${ONE_BOOT}`,
      );
    }
    // Built while the old one runs, started once the old one has stopped,
    // and watched before the old one goes (replaceRouter). With the labs it
    // has when nobody asked for others (labsOf): `labs ?? []` here took them
    // all off on a rebuild for the key, the update or what it filters.
    const mac = await wanMacFor(admin, edge, opts.pool, 0);
    const { text, up } = await replaceRouter(opts, { old: edge, name: EDGE.vm, was: 'the edge router it was replacing', build: (start) => buildEdge({ ...opts, ha: null, block: keep, labs: labs ?? labsOf(st), wanMac: mac, start }) });
    await admin.call('vm.delete', { id: edge.id, deleteDisks: true });
    return `${text} It replaced the one that was there, which was removed. ${settledSaid(EDGE.vm, up)}`;
  }
  if (edge && st) {
    const wan = st.vifs.find((v) => String(v?.device) === '0');
    const said = [];
    if (wan && wan.$network !== egress.id) {
      await admin.call('vif.set', { id: wan.id, network: egress.id });
      said.push(`Its WAN moved to ${egress.name}.`);
    }
    if (edge.power_state !== 'Running') {
      await admin.call('vm.start', { id: edge.id });
      said.push('It was stopped, and was started.');
    }
    const at = wanAddressOf(edge);
    return [
      `The edge router was already there, on ${egress.name}${at ? ` at ${at}` : ''}, ${st.blocks ? 'dropping' : 'logging'} what its threat rules match${st.hasLabs ? `, with ${labsSaid(st.hasLabs)}` : ''}.`,
      ...said,
      ...(at ? [] : [`Xen Orchestra does not know its WAN address: it has none, or its guest agent has not arrived yet, which comes with its first update after ${EDGE_UPDATES.hours}:00 UTC.`]),
    ].join(' ');
  }
  return (await buildEdge({ ...opts, ha: null, block: block === true, labs: labs ?? [], wanMac: await wanMacFor(admin, null, opts.pool, 0) })).text;
}

/**
 * The edge's WAN address as Xen Orchestra has it from the guest agent
 * (EDGE_UPDATES): interface 0's first IPv4 address, or null when it does not
 * know, which is not the same as the edge having none.
 *
 * @param {any} edge @returns {string|null}
 */
export function wanAddressOf(edge) {
  const a = edge?.addresses && typeof edge.addresses === 'object' ? edge.addresses : {};
  const ip = [a['0/ipv4/0'], a['0/ip']].find((x) => typeof x === 'string' && net.isIPv4(x));
  return ip ?? null;
}

/** Labs as the edge's tag keeps them: `o` open, `c` closed, in order. @param {Array<{ open: boolean }>} labs */
const labsKey = (labs) => labs.map((l) => (l.open ? 'o' : 'c')).join('');

/**
 * THE WAN MAC A ROUTER KEEPS across rebuilds, so the DHCP server on the way
 * out hands the new router the address the old one had, and a box that
 * reads it (edge-watch.js) finds it where it was. The old router's own, when
 * there is one; otherwise one made from the pool and which router it is,
 * locally administered (the 02 bit) and unicast, the same every time.
 *
 * @param {any} admin @param {any} old the router being replaced, or null
 * @param {string} pool @param {0|1} node
 */
async function wanMacFor(admin, old, pool, node) {
  if (old?.id) {
    const vifs = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VIF', $VM: old.id } })) || {}));
    const mac = String(vifs.find((v) => String(v?.device) === '0')?.MAC || '').toLowerCase();
    if (/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac)) return mac;
  }
  const h = createHash('sha256').update(`fleetwright-edge-wan:${pool}:${node}`).digest();
  return ['02', ...[...h.subarray(0, 5)].map((b) => b.toString(16).padStart(2, '0'))].join(':');
}

/**
 * THE LABS AN EDGE HAS, as a rebuild is given them: each from its tag
 * (edgeLabsOf), open or closed, with the network its interface is on, in
 * order (device 2 and up, as buildEdge makes them). A lab the tag names that
 * no interface is on is left out: there is no network to put the new router
 * on, and edgeState's `onLabs` is what notices that.
 *
 * @param {Awaited<ReturnType<typeof edgeState>>|null} st
 * @returns {Array<{ id: string, open: boolean }>}
 */
function labsOf(st) {
  if (!st) return [];
  /** @type {Array<{ id: string, open: boolean }>} */
  const labs = [];
  [...st.hasLabs].forEach((c, i) => {
    const id = st.vifs.find((v) => String(v?.device) === String(i + 2))?.$network;
    if (typeof id === 'string' && id) labs.push({ id, open: c === 'o' });
  });
  return labs;
}

/** A span of time as a person says it: whole minutes from one, seconds below. @param {number} ms */
const span = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? '' : 's'}` : `${Math.round(ms / 1000)} seconds`);

/**
 * WHAT CAN BE TOLD OF A ROUTER JUST STARTED, which is what Xen Orchestra
 * shows of it and nothing more: the job cannot log in to it, and it has no
 * guest agent until its first update (EDGE_UPDATES), since a rebuild is a
 * copy of the published image. So for a new router Xen Orchestra knows
 * whether it is running, and not whether it answers; nothing here says it
 * does. What the watch catches is a router that stops again on its own, a
 * disk that does not boot or a configuration OPNsense refuses, before the
 * router it replaces is removed; before this, the old one was removed as
 * soon as `vm.start` returned. A router that does carry the agent would
 * show an address, which ends the watch early and is said as its agent
 * answering, which is all an address proves.
 *
 * `halted`: Xen Orchestra showed it stopped. `answers`: it showed an address
 * from the guest agent. `running`: the whole watch passed with it running,
 * which is as much as can be told, and the rebuild goes on; holding the old
 * router for an answer that cannot come for a day would mean no rebuild
 * ever finishes.
 *
 * @param {{ admin: any, vm: string, name: string, say: (text: string) => void, signal?: AbortSignal, sleep?: (ms: number) => Promise<void>, settle?: { ms: number, every: number } }} opts
 * @returns {Promise<{ state: 'halted'|'answers'|'running', address: string|null, after: number }>}
 */
async function settled({ admin, vm, name, say, signal, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), settle = EDGE_SETTLE }) {
  say(`${name} is started. Xen Orchestra is watched for ${span(settle.ms)} for it stopping again; whether it answers cannot be told from here until its guest agent arrives with its first update.`);
  for (let waited = 0; ; waited += settle.every) {
    signal?.throwIfAborted();
    const vms = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM', id: vm } })) || {}));
    // By its id and not the filter's word: a Xen Orchestra answers the filter it understands.
    const seen = vms.find((v) => v?.id === vm);
    if (seen?.power_state === 'Halted') return { state: 'halted', address: null, after: waited };
    const address = wanAddressOf(seen);
    if (address) return { state: 'answers', address, after: waited };
    if (waited >= settle.ms) return { state: 'running', address: null, after: waited };
    await sleep(settle.every);
  }
}

/**
 * What the watch could tell, for the sentence the job ends with: an address
 * is the agent answering and no more; running for the whole watch is not
 * knowing, and said as such (CLAUDE.md, C-5).
 *
 * @param {string} name @param {Awaited<ReturnType<typeof settled>>} up
 */
function settledSaid(name, up) {
  if (up.state === 'answers') return `${name}’s guest agent answers: Xen Orchestra has its WAN address, ${up.address}.`;
  return `Xen Orchestra reported ${name} running for the ${span(up.after)} it was watched; whether it answers cannot be told from here until its guest agent arrives with its first update, after ${EDGE_UPDATES.hours}:00 UTC.`;
}

/**
 * ONE ROUTER REPLACED BY ANOTHER, with the way out gone for one boot and not
 * for the whole build. The new one is built first, which is the slow part
 * (a download of up to 490 MB, then a disk of up to 3 GiB through Xen
 * Orchestra), while the old one runs; only then is the old one stopped and
 * the new one started. Stopped before, not after: one router has 10.254.0.1
 * as its own address and one of a pair its .2 or .3, and two routers with
 * the same address on the uplink answer for each other. The new one is then
 * watched (settled) before the caller removes the old. Before this the old
 * one was stopped first and the machines behind it waited out the download.
 *
 * WHEN IT GOES WRONG, which is the point. If the build fails, the old one
 * was never touched and is left running (or started, if it was stopped: the
 * pool keeps a way out). If the new one cannot start, or stops again while
 * watched, it is removed and the old one started again. `old` null is a
 * router built beside a pair's other half (FINISHING THE PAIR), where there
 * is nothing to stop and nothing to start again: `alone` says what carries
 * the machines then. Cancel, while watching, is the same as a failure.
 *
 * @param {{ admin: any, say: (text: string) => void, signal?: AbortSignal, sleep?: (ms: number) => Promise<void>, settle?: { ms: number, every: number } }} opts
 * @param {{ old: any, name: string, was?: string, alone?: string, build: (start: boolean) => Promise<{ vm: string|null, text: string }> }} what
 *   `was`: the old router as the sentence names it ("the edge router it was replacing"); `alone`: what is said instead when there is no old one.
 * @returns {Promise<{ vm: string, text: string, up: Awaited<ReturnType<typeof settled>> }>}
 */
async function replaceRouter({ admin, say, signal, sleep, settle }, { old, name, was = 'the edge router it was replacing', alone = '', build }) {
  let stopped = false;
  /** The old one back, when that is right, and what was done said. */
  const back = async () => {
    if (!old) return alone;
    if (stopped || old.power_state !== 'Running') {
      await admin.call('vm.start', { id: old.id }).catch(() => {});
      return `${was} was started again, as it was`;
    }
    return `${was} was left running, as it was`;
  };
  // A sentence of its own, so "the edge router" takes a capital; a router's name does not.
  const cap = (/** @type {string} */ s) => (s.startsWith('the ') ? `T${s.slice(1)}` : s);
  let made;
  try {
    made = await build(false);
  } catch (e) {
    /** @type {Error} */ (e).message = `${/** @type {Error} */ (e).message}. ${cap(await back())}`;
    throw e;
  }
  // Made, so it has its id: buildEdge's `vm` is null only until the VM is created.
  const vm = /** @type {string} */ (made.vm);
  if (old && old.power_state !== 'Halted') {
    await admin.call('vm.stop', { id: old.id, force: true });
    stopped = true;
  }
  try {
    await admin.call('vm.start', { id: vm });
    const up = await settled({ admin, vm, name, say, signal, sleep, settle });
    if (up.state === 'halted') throw new Error(`${name} stopped again ${up.after ? `within ${span(up.after)} of starting` : 'as soon as it was started'}, which a router that boots does not do`);
    return { vm, text: made.text, up };
  } catch (e) {
    await admin.call('vm.delete', { id: vm, deleteDisks: true }).catch(() => {});
    // "The new", since in a pair the old one has the same name.
    /** @type {Error} */ (e).message = `${/** @type {Error} */ (e).message}. The new ${name} was removed, and ${await back()}`;
    throw e;
  }
}

/** How many labs of each kind, as a person says it. @param {string} key */
function labsSaid(key) {
  const open = [...key].filter((c) => c === 'o').length;
  const closed = key.length - open;
  if (!key) return 'no labs';
  const n = (/** @type {number} */ x, /** @type {string} */ kind) => `${x === 1 ? 'one' : x} ${kind} lab${x === 1 ? '' : 's'}`;
  return [open ? n(open, 'open') : null, closed ? n(closed, 'closed') : null].filter(Boolean).join(' and ');
}

/**
 * THE KEPT DISK. Asked for, of the machine image first: "Rebuilding machines
 * why don't we have cached copies?" The download was kept; what every build
 * did again was write the whole disk, 3 GiB, from the machine running the job
 * through Xen Orchestra to the pool's storage, and the edge router is rebuilt
 * for every change of what it filters, its labs or its pair. So the image as
 * published is kept on the pool, as the machine image's is (vm-image.js,
 * baseOf): a template that has never booted, `Fleetwright base: OPNsense
 * <release>`, tagged EDGE.baseTag and `fleetwright-base:opnsense:<release>`,
 * one per release and storage, since a copy is fast only on the storage the
 * template's disk is on. Not tagged `fleetwright-image` and never put in the
 * resource set, so no box offers it and the fleet's token cannot clone it.
 *
 * FOUND BY ITS ID, NOT BY ITS TAG. A kept disk is taken for the published
 * image without the download's digest being checked again, so a template
 * that only carries the tag is not one: any that somebody else made and
 * tagged would have become the router's disk. The id of each one this makes
 * is written into the list of what the policy job made (xo-made.js, which
 * says why there and not in a tag), and a kept disk is used only when its id
 * is on that list, it is not in the fleet's resource set, and it was made in
 * no resource set. Anything else is passed over and the published image
 * downloaded and checked as though nothing were kept. A kept disk from before
 * the list is passed over the same way, once, and left where it is: this
 * removes only what the list says it made.
 *
 * A REBUILD COPIES IT AND WRITES ONLY THE CONFIGURATION. The router's VM is
 * made from that template, which copies its disk (a copy-on-write clone on
 * the storage XCP-ng keeps as VHD files: seconds, the way a session's machine
 * is made from the image). Then the blocks imagePatches changes, five of them,
 * 2 MiB each, are written into the copy by `disk.importContent` as a VHD that
 * holds those blocks and nothing else (vhd.js says why that leaves the rest
 * as it is). What goes in each block is the published image's own bytes with
 * the change made, read from the download on this machine and unpacked only
 * as far as the last of them, through the same ConfigPatch the whole disk
 * goes through, so every byte replaced is checked first, before anything on
 * the pool is made. About 10 MiB is sent where the whole disk is 3 GiB.
 *
 * WHEN XEN ORCHESTRA CANNOT, the whole disk is sent, as before, and the
 * person is told why. `disk.importContent` as Xen Orchestra ships it never
 * passes on its format, and XAPI refuses an import without one; the Xen
 * Orchestra the fleet deploys carries the fix (xo-deploy.js, INSTALLER), one
 * installed any other way does not. Storage that cannot be written sparsely
 * (thick LVM, where XAPI must zero a disk it writes) refuses it too.
 *
 * WHEN THE KEPT DISK IS MADE, which is the choice that costs. The first build
 * on a storage would send the published image to keep it and then its few
 * MiB, which is today's 3 GiB; but where Xen Orchestra cannot write into a
 * disk, it would then send the whole configured disk as well, 6 GiB, to keep
 * a disk nothing can use. So before the kept disk is sent, the build asks:
 * Xen Orchestra is given a 2 MiB disk made for the question (writesInto),
 * and one block written into it the way the rebuild will write. Only when that
 * works is the image kept. When it does not, the router is built as before
 * and nothing is kept, and the next build asks again, so updating Xen
 * Orchestra is all it takes. A kept disk that is there is not asked about: it
 * was kept because the question was answered, and a copy that then cannot be
 * written into is removed and the whole disk sent. The kept disk stays, for
 * the Xen Orchestra that is updated.
 *
 * ONE RELEASE AT A TIME. A newer pinned release's kept disk replaces the
 * older one's on every storage once it is made. A router made from the older
 * one keeps working, because XCP-ng keeps a clone's parent disk while
 * anything still reads from it, as the machine image's do.
 *
 * NOT YET RUN AGAINST A REAL POOL. The calls are Xen Orchestra's own, read in
 * its source (disk.create, disk.importContent, disk.import, vm.create from a
 * template, vm.attachDisk, vm.convertToTemplate, vdi.set, vdi.delete,
 * vm.delete); the VHD is checked by qemu-img and by a reader of its own
 * (test/vhd.test.js); what XAPI does with it is read from vhd-tool's source.
 */

/** The kept disk's tag for a release. @param {string} [release] */
const baseTagFor = (release = OPNSENSE_IMAGE.release) => `${EDGE.baseTag}:${EDGE.baseKey}:${release}`;

/**
 * A VM's or template's disks: every one that is not a CD drive. The same
 * calls the machine image reads its kept disk with (vm-image.js, disksOf).
 * All of them and not the first, because the first is a guess: a copy that
 * came with two would have had its configuration written into whichever the
 * pool listed first, and booted from the other.
 *
 * @param {any} admin @param {string} vm @returns {Promise<any[]>}
 */
async function disksOf(admin, vm) {
  const vbds = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VBD', VM: vm } })) || {}));
  const disks = [];
  for (const vbd of vbds) {
    if (!vbd?.VDI || vbd.is_cd_drive) continue;
    const vdi = /** @type {any} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VDI', id: vbd.VDI } })) || {})[0]);
    if (vdi) disks.push(vdi);
  }
  return disks;
}

/**
 * THE POOL'S OWN TEMPLATE, by XCP-ng's say and not by its name. A VM made
 * from a template inherits its disks and settings, so the edge router and the
 * machine image are made from the built-in one with no disks of its own, and
 * nothing else will do: `name_label` is a string anybody who can make a
 * template can give theirs, and the first template called "Other install
 * media" used to be the one taken, whoever made it. `isDefaultTemplate` is
 * Xen Orchestra's reading of XAPI's own mark on the templates it ships
 * (is_default_template, or other_config's default_template), which nothing
 * below a pool's admin sets; `$VBDs` empty is a template that brings no disk.
 *
 * AND MADE IN NO RESOURCE SET (xo-made.js, outsideSets). XCP-ng's own never
 * is, and a copy made inside one — by the fleet's own user, or anybody else
 * who works in a set — is somebody else's however it is marked: the mark is
 * other_config, which a template made from a VM, or imported, can carry.
 * Without this, one such copy was enough to stop every edge and image build
 * on the pool with "2 built-in templates".
 *
 * MORE THAN ONE IS STILL A STOP, and says which, so an admin can delete the
 * one that is not XCP-ng's. Preferring one was weighed and not done: what
 * Xen Orchestra shows of a template gives nothing that tells XAPI's own from
 * a copy made outside every set, and building the router from the wrong one
 * hands it that template's settings. A copy outside every set takes
 * somebody with rights over the pool's objects beyond the fleet's own user;
 * a build that stops and names it costs that person's admin one deletion.
 *
 * Shared with the machine image (vm-image.js, ensureImage).
 *
 * @param {any[]} templates  every VM-template, as xo.getAllObjects gave them
 * @param {string} pool @param {string} name @param {string} what  what is made from it, for the sentence
 */
export function builtInTemplate(templates, pool, name, what) {
  const found = templates.filter((t) => t?.$pool === pool && t?.name_label === name && t.isDefaultTemplate === true && Array.isArray(t.$VBDs) && t.$VBDs.length === 0 && outsideSets(t));
  if (found.length === 1) return found[0];
  if (!found.length) throw new Error(`this pool has no built-in "${name}" template, XCP-ng’s own with no disks, to make ${what} from. Nothing was built`);
  const ids = found.map((t) => String(t.id).slice(0, 36)).slice(0, 4).join(', ');
  throw new Error(`this pool has ${found.length} built-in "${name}" templates where XCP-ng ships one (${ids}), so which to make ${what} from cannot be told. Delete the one that is not XCP-ng’s in Xen Orchestra and try again. Nothing was built`);
}

/**
 * Whether a template is a kept disk the policy job made: on its list, not in
 * the fleet's set, and made in no set (THE KEPT DISK, FOUND BY ITS ID).
 *
 * @param {any} t @param {{ fleet: Set<string>, made: Set<string> }} sets
 */
const keptByUs = (t, sets) => sets.made.has(String(t?.id)) && !sets.fleet.has(String(t?.id)) && outsideSets(t);

/**
 * The kept disk for this release on storage `sr`, or null: one the policy job
 * made, with exactly one disk, on that storage.
 *
 * @param {any} admin @param {any[]} templates @param {string} pool @param {string} sr
 * @param {{ fleet: Set<string>, made: Set<string> }} sets
 */
async function keptBaseOn(admin, templates, pool, sr, sets) {
  for (const t of templates.filter((x) => x?.$pool === pool && x?.tags?.includes?.(baseTagFor()) && keptByUs(x, sets))) {
    const disks = await disksOf(admin, t.id);
    if (disks.length === 1 && disks[0].$SR === sr) return t;
  }
  return null;
}

/** The 2 MiB blocks of the disk the regions fall in, in order. @param {Array<{ offset: number, replacement: Buffer }>} regions */
function blocksOf(regions) {
  const blocks = new Set();
  for (const r of regions) {
    for (let b = Math.floor(r.offset / VHD_BLOCK); b <= Math.floor((r.offset + r.replacement.length - 1) / VHD_BLOCK); b++) blocks.add(b);
  }
  return [...blocks].sort((a, b) => a - b);
}

/**
 * The blocks the configuration changes, each whole and with the change made:
 * the download unpacked as far as the last of them and no further, through
 * ConfigPatch, so a byte that is not what the plan says is there fails here,
 * before the pool is touched.
 *
 * @param {{ file: string, regions: ReturnType<typeof imagePatches>, unpackImpl: typeof unpack, signal?: AbortSignal, onProgress: (done: number, total: number) => void }} opts
 * @returns {Promise<Map<number, Buffer>>}
 */
async function patchedBlocks({ file, regions, unpackImpl, signal, onProgress }) {
  const wanted = blocksOf(regions);
  const end = (/** @type {number} */ (wanted.at(-1)) + 1) * VHD_BLOCK;
  const blocks = new Map(wanted.map((b) => [b, Buffer.alloc(VHD_BLOCK)]));
  // STOPPED ONCE IT HAS THEM: bzip2 is killed rather than left to unpack the
  // rest of the disk for nobody.
  const stop = new AbortController();
  const source = unpackImpl(file, { signal: signal ? AbortSignal.any([signal, stop.signal]) : stop.signal });
  const patched = new ConfigPatch({ regions, total: OPNSENSE_IMAGE.rawSize });
  source.on('error', (e) => patched.destroy(e));
  source.pipe(patched);
  let at = 0;
  let told = 0;
  try {
    for await (const chunk of patched) {
      const until = at + chunk.length;
      for (let b = Math.floor(at / VHD_BLOCK); b <= Math.floor((until - 1) / VHD_BLOCK); b++) {
        const into = blocks.get(b);
        if (!into) continue;
        const from = Math.max(at, b * VHD_BLOCK);
        chunk.copy(into, from - b * VHD_BLOCK, from - at, Math.min(until, (b + 1) * VHD_BLOCK) - at);
      }
      at = until;
      if (at - told >= 64 * 1024 * 1024) {
        told = at;
        onProgress(Math.min(at, end), end);
      }
      if (at >= end) break;
    }
  } catch (e) {
    signal?.throwIfAborted();
    throw e;
  } finally {
    stop.abort();
    source.destroy();
    patched.destroy();
  }
  return blocks;
}

/** What went wrong, short enough to say. @param {unknown} e */
const why = (e) => String(/** @type {any} */ (e)?.message || e).slice(0, 160);

/**
 * WHETHER THIS XEN ORCHESTRA CAN WRITE INTO A DISK THAT IS THERE, on this
 * storage (THE KEPT DISK says why it is asked): a 2 MiB disk made for the
 * question, one block of zeros written into it the way a rebuild writes its
 * configuration, and the disk removed whatever the answer. Null when it can;
 * otherwise what it said.
 *
 * @param {{ admin: any, sr: string, send: (sendTo: string, body: Buffer) => Promise<void>, signal?: AbortSignal }} opts
 * @returns {Promise<string|null>}
 */
async function writesInto({ admin, sr, send, signal }) {
  /** @type {unknown} */
  let disk = null;
  try {
    disk = await admin.call('disk.create', { name: `${EDGE.vm} (checking)`, size: VHD_BLOCK, sr });
    if (typeof disk !== 'string') return 'it made no disk to try it on';
    const sendTo = (await admin.call('disk.importContent', { id: disk, format: 'vhd' }))?.$sendTo;
    if (typeof sendTo !== 'string') return 'it gave nowhere to send the blocks';
    await send(sendTo, sparseVhd({ size: VHD_BLOCK, blocks: new Map([[0, Buffer.alloc(VHD_BLOCK)]]) }));
    return null;
  } catch (e) {
    signal?.throwIfAborted();
    return why(e);
  } finally {
    if (typeof disk === 'string') await admin.call('vdi.delete', { id: disk }).catch(() => {});
  }
}

/**
 * A new edge router, built, tagged with how it filters, and started: from a
 * copy of the disk kept on the pool when Xen Orchestra can write into one,
 * and from the whole image otherwise (THE KEPT DISK, above).
 *
 * @param {Omit<Parameters<typeof ensureEdge>[0], 'ha'> & { block: boolean, labs: Array<{ id: string, open: boolean }>, ha?: { node: 0|1, password: string }|null, wanMac?: string|null, start?: boolean }} opts
 */
async function buildEdge({ admin, pool, egress, uplink, srs, fleetSrs, sr: chosenSr = null, block, labs, fleet = [], ha = null, watch = null, syslog = [], wanMac = null, start = true, address, pin, plain, imageDir, say, signal, getImage = fetchImage, unpackImpl = unpack, upload = uploadDisk, writeInto = writeIntoDisk }) {
  // Checked before anything is downloaded: a closed lab with nowhere to let
  // the fleet through would be a machine that never joins.
  const config = edgeConfig({ block, labs: labs.map((l) => l.open), fleet, ha, watch, syslog });
  const name = ha?.node ? EDGE_HA.second : EDGE.vm;
  const sr = edgeStorage({ pool, srs, fleetSrs, sr: chosenSr });
  const on = srName(sr);
  const { release, rawSize, compressedSize } = OPNSENSE_IMAGE;

  const templates = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM-template' } })) || {}));
  const template = builtInTemplate(templates, pool, EDGE.template, 'the edge router');
  // KEPT BEFORE ANYTHING IS MADE, where only an admin of Xen Orchestra reads
  // them (edge-credentials.js, EDGE_KEPT): a router never has a password or a
  // key the next job cannot find.
  if (ha || watch) await keepFor(admin, pool, { carp: ha?.password ?? null, watch });

  const stage = (/** @type {number} */ n, /** @type {number} */ fill) => ({ stage: n, stages: BUILD_STAGES, fill });
  /** The part with its bytes: what they are doing, and how many of how many, in MB. */
  const moving = (/** @type {BuildPart} */ part, /** @type {string} */ doing, /** @type {number} */ d, /** @type {number} */ t) => ({ ...part, doing, done: mb(d), total: mb(t) });
  say(`Downloading OPNsense ${release}.`, stage(1, 0));
  let downloaded = 0;
  const file = await getImage({
    dir: imageDir,
    signal,
    onProgress: (d, t) => {
      downloaded = d;
      say(`Downloading OPNsense ${release}: ${mb(d)} of ${mb(t)} MB.`, moving(stage(1, buildFill(d, 0)), 'download', d, t));
    },
  });
  signal?.throwIfAborted();
  if (!downloaded) say(`OPNsense ${release} was already downloaded and checked.`, stage(1, buildFill(compressedSize, 0)));

  const regions = imagePatches(config);
  const send = (/** @type {string} */ sendTo, /** @type {Buffer} */ body) => writeInto({ address, pin, plain, sendTo, body, signal });
  /** @type {any} */
  const sets = await setsOf(admin);
  let base = await keptBaseOn(admin, templates, pool, sr.id, sets);
  /** Why a copy of the kept disk cannot be written into here, once that is known. */
  let refused = base ? null : await writesInto({ admin, sr: sr.id, send, signal });
  const baseName = `OPNsense ${release} (as published)`;
  const description = `OPNsense ${release}, configured by Fleetwright as the edge router`;
  const vmParams = {
    name_label: name,
    name_description: 'The only way out of every lab. Made by Fleetwright; its rules are fixed and it has no login.',
    // WAN, uplink, then each lab, in order: xn0, xn1, xn2 and on, as the
    // configuration names them.
    VIFs: [{ network: egress.id, ...(wanMac ? { mac: wanMac } : {}) }, { network: uplink }, ...labs.map((l) => ({ network: l.id }))],
    CPUs: EDGE.cpus,
    memory: EDGE.memory,
    tags: [EDGE.tag, EDGE.updatesTag, ...(watch ? [EDGE_WATCH.tag] : []), ...(block ? [EDGE.blocksTag] : []), ...(labs.length ? [`${LAB.edgeTag}${labsKey(labs)}`] : []), ...(ha ? [`${EDGE_HA.nodeTag}${ha.node}`] : [])],
    bootAfterCreate: false,
  };

  /** @type {string|null} */
  let vdi = null;
  /** @type {string|null} */
  let vm = null;
  // The kept disk while it is being made: its upload, its disk, its template.
  let keeping = false;
  /** @type {string|null} */
  let keptVdi = null;
  /** @type {string|null} */
  let making = null;
  try {
    if (!refused) {
      // THE BAR, by bytes as buildFill weighs them: the image read as far as
      // the last block, the image kept when it is not yet, and the blocks.
      const read = (/** @type {number} */ (blocksOf(regions).at(-1)) + 1) * VHD_BLOCK;
      const work = read + (base ? 0 : rawSize) + blocksOf(regions).length * VHD_BLOCK;
      const from = buildFill(compressedSize, 0);
      const bar = (/** @type {number} */ done) => stage(2, from + Math.floor(((MAKING - from) * Math.min(done, work)) / work));
      say(
        base
          ? `OPNsense ${release} is already on ${on}, kept from an earlier build, so the edge router starts from a copy of it and only its configuration is written.`
          : `Reading the blocks the edge router’s configuration goes in from OPNsense ${release}.`,
        bar(0),
      );
      const blocks = await patchedBlocks({
        file,
        regions,
        unpackImpl,
        signal,
        onProgress: (d, t) => say(`Reading the blocks the configuration goes in from OPNsense ${release}: ${mb(d)} of ${mb(t)} MB.`, moving(bar(d), 'read', d, t)),
      });
      const vhd = sparseVhd({ size: rawSize, blocks });

      if (!base) {
        say(`Writing OPNsense ${release} as published to ${on}, where it is kept so a rebuild writes only the configuration.`, bar(read));
        keeping = true;
        const { $sendTo } = await admin.call('disk.import', {
          sr: sr.id,
          type: 'iso',
          name: baseName,
          description: `OPNsense ${release}'s nano image as published, kept by Fleetwright so the edge router is built from a copy of it`,
        });
        keptVdi = await upload({
          address,
          pin,
          plain,
          sendTo: $sendTo,
          // Unchanged, and still held to its length.
          body: unpackImpl(file, { signal }).pipe(new ConfigPatch({ regions: [], total: rawSize })),
          size: rawSize,
          signal,
          onProgress: (d, t) => say(`Writing OPNsense ${release} as published to ${on}: ${mb(d)} of ${mb(t)} MB.`, moving(bar(read + d), 'keep', d, t)),
        });
        signal?.throwIfAborted();
        making = await admin.call('vm.create', {
          template: template.id,
          name_label: `Fleetwright base: OPNsense ${release}`,
          name_description: `OPNsense ${release}'s nano image as published, never booted. Fleetwright builds the edge router from a copy of it, so a rebuild writes only its configuration; it is not offered for sessions.`,
          VIFs: [],
          VDIs: [],
          CPUs: EDGE.cpus,
          memory: EDGE.memory,
          tags: [EDGE.baseTag, baseTagFor()],
          bootAfterCreate: false,
        });
        await admin.call('vm.attachDisk', { vm: making, vdi: keptVdi, bootable: true, position: '0' });
        keptVdi = null; // the template's now, and deleted with it
        await admin.call('vm.convertToTemplate', { id: making });
        // ON THE LIST before anything uses it, or it is removed with the
        // rest of what this build made: a kept disk nobody can find by its id
        // would be passed over by every build after this one.
        await recordMade(admin, /** @type {string} */ (making));
        base = { id: making };
        making = null; // kept from here, whatever happens to this build
        keeping = false;
        for (const old of templates.filter((t) => t?.$pool === pool && keptByUs(t, sets) && (t?.tags || []).some((/** @type {string} */ x) => x.startsWith(`${EDGE.baseTag}:${EDGE.baseKey}:`)) && !t.tags.includes(baseTagFor()))) {
          await admin.call('vm.delete', { id: old.id, deleteDisks: true }).then(() => forgetMade(admin, old.id), () => {});
        }
      }

      say(`Copying the disk kept on ${on} and writing the configuration: ${mb(vhd.length)} MB.`, bar(work - blocks.size * VHD_BLOCK));
      // A COPY OF THE KEPT DISK comes with the VM, as a session's machine
      // gets a copy of the image's.
      vm = await admin.call('vm.create', { template: base.id, ...vmParams });
      try {
        // ONE DISK OR NONE IS WRITTEN: the blocks go into the disk it boots
        // from, and with two there is no telling which that is.
        const disks = await disksOf(admin, /** @type {string} */ (vm));
        if (disks.length !== 1) throw new Error(disks.length ? `the copy of the kept disk came with ${disks.length} disks where it has one` : 'the copy of the kept disk came without a disk');
        const [disk] = disks;
        const sendTo = (await admin.call('disk.importContent', { id: disk.id, format: 'vhd' }))?.$sendTo;
        if (typeof sendTo !== 'string') throw new Error('it gave nowhere to send the blocks');
        await send(sendTo, vhd);
        // Named as an uploaded one is, which is how the phone finds which
        // storage the router is on (xo-setup.js, edgeDisks).
        await admin.call('vdi.set', { id: disk.id, name_label: name, name_description: description }).catch(() => {});
      } catch (e) {
        signal?.throwIfAborted();
        refused = why(e);
        // Gone before anything else is made: two VMs tagged as the edge
        // would be two edges to the next run. A copy that cannot be removed
        // fails the build, and the catch below tries again.
        await admin.call('vm.delete', { id: vm, deleteDisks: true });
        vm = null;
      }
    }

    if (refused) {
      say(
        `This Xen Orchestra cannot write into a disk that is already there, so the edge router’s whole disk is sent, as before (${refused}). ` +
          'One installed other than by the fleet lacks the fix for that; updated with the fleet’s installer, a rebuild is a copy of the disk kept on the pool and a few MB.',
        stage(2, buildFill(compressedSize, 0)),
      );
      say(`Writing the edge router’s disk to ${on}.`, stage(2, buildFill(compressedSize, 0)));
      const { $sendTo } = await admin.call('disk.import', { sr: sr.id, type: 'iso', name, description });
      const body = unpackImpl(file, { signal }).pipe(new ConfigPatch({ regions, total: rawSize }));
      vdi = await upload({
        address,
        pin,
        plain,
        sendTo: $sendTo,
        body,
        size: rawSize,
        signal,
        onProgress: (d, t) => say(`Writing the edge router’s disk to ${on}: ${mb(d)} of ${mb(t)} MB.`, moving(stage(2, buildFill(compressedSize, d)), 'write', d, t)),
      });
      signal?.throwIfAborted();
    }

    say(`Making the edge router, its disk on ${on}${start ? ', and starting it' : ''}.`, stage(3, MAKING));
    if (!vm) {
      vm = await admin.call('vm.create', { template: template.id, ...vmParams, VDIs: [] });
    }
    // WHICH PASSWORD AND WHICH KEY IT HAS, as marks and not the values:
    // anybody signed in to Xen Orchestra reads this VM's xenStoreData. The
    // values themselves were kept above, where only an admin reads them.
    if (ha || watch) {
      await admin.call('vm.set', {
        id: vm,
        xenStoreData: { ...(ha ? { [EDGE_KEPT.carpMark]: markCarp(ha.password) } : {}), ...(watch ? { [EDGE_KEPT.watchPin]: watch.pin } : {}) },
      });
    }
    if (vdi) await admin.call('vm.attachDisk', { vm, vdi, bootable: true, position: '0' });
    const vifs = Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VIF', $VM: vm } })) || {});
    for (const v of vifs) await admin.call('vif.set', { id: /** @type {any} */ (v).id, txChecksumming: false });
    signal?.throwIfAborted();
    if (start) await admin.call('vm.start', { id: vm });
  } catch (e) {
    // Nothing half-made is left for the next run to trip over: not the
    // router, not its disk, and not a kept disk that was never finished.
    if (vm) await admin.call('vm.delete', { id: vm, deleteDisks: true }).catch(() => {});
    else if (vdi) await admin.call('vdi.delete', { id: vdi }).catch(() => {});
    else await removePartialDisk(admin, sr.id, name);
    if (making) await admin.call('vm.delete', { id: making, deleteDisks: true }).catch(() => {});
    else if (keptVdi) await admin.call('vdi.delete', { id: keptVdi }).catch(() => {});
    else if (keeping) await removePartialDisk(admin, sr.id, baseName);
    throw e;
  }
  const { address: lan, prefix } = EDGE.lan;
  if (ha) return { vm, text: `${name} is ${start ? 'up' : 'made'}: OPNsense ${OPNSENSE_IMAGE.release}, at 10.254.0.${2 + ha.node} on ${EDGE.uplink} and sharing ${lan} with the other, its disk on ${on}.` };
  return {
    vm,
    text:
    `The edge router is up: OPNsense ${OPNSENSE_IMAGE.release}, its WAN on ${egress.name} and its LAN on ${EDGE.uplink} at ${lan}/${prefix}, its disk on ${on}. ` +
    `Labs on the uplink reach the internet and nothing private, and what its threat rules match is ${block ? 'dropped' : 'logged'}.${labs.length ? ` It has ${labsSaid(labsKey(labs))} of their own.` : ''} It has no login; its rules are fixed. ` +
    `It updates itself every day after ${EDGE_UPDATES.hours}:00 UTC, restarting when OPNsense needs it to, and gets the Xen guest agent with its first update.`,
  };
}

/**
 * A disk an upload left behind when it was cut off: named for the router, on
 * the storage it was going to, and attached to nothing. Only those, so the
 * disk of a router that is there is never touched.
 *
 * @param {any} admin @param {string} sr @param {string} [name]
 */
async function removePartialDisk(admin, sr, name = EDGE.vm) {
  try {
    const vdis = Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VDI', name_label: name, $SR: sr } })) || {});
    for (const d of /** @type {any[]} */ (vdis)) {
      if (!Array.isArray(d?.$VBDs) || d.$VBDs.length === 0) await admin.call('vdi.delete', { id: d.id }).catch(() => {});
    }
  } catch {
    /* clearing up is best effort; the error that brought us here is the one said */
  }
}
