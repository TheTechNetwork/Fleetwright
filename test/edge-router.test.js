// The edge router: the configuration written into OPNsense's image, the patch
// that writes it, and the calls that make the uplink and the VM.
//
//   node --test test/edge-router.test.js
//
// What is guarded is what a pool depends on: the configuration fits exactly
// where the default was and says what the edge must be (no login, labs kept
// off everything private); a wrong offset or a damaged image is refused
// before a disk is written; a download that is not the published image is
// never used; the VM is made in the order that boots (WAN first, the disk
// attached and bootable, checksum offload off) and nothing half-made is left
// when a step fails. The image itself is 3 GiB and is not fetched here: its
// default configuration is the fixture, taken from the published 26.7 image,
// and the patched image was booted in QEMU when this was written.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { ConfigPatch, DNSMASQ_PORT, EDGE, EDGE_FILTER, EDGE_HA, EDGE_UPDATES, LAB, NOT_FROM_LABS, OPNSENSE_IMAGE, edgeConfig, ensureEdge, ensureGroups, ensureLabs, ensureUplink, fetchImage, fleetHosts, imagePatches, isDefaultConfig, labsEachOf, writeIntoDisk } from '../src/fleet/host/edge-router.js';
import { REQUIRED_HOSTS } from '../src/core/egress.js';
import { checkPolicy } from '../src/fleet/host/xo-setup.js';
import { EDGE_WATCH, newWatch, watchOf } from '../src/fleet/host/edge-credentials.js';
import { VM_IMAGE } from '../src/fleet/host/vm-image.js';
import { xenStoreAsXo } from './helpers/xo-stand-in.js';
import { readVhd } from './helpers/vhd-read.js';

const DEFAULT = readFileSync(new URL('./fixtures/opnsense-26.7-config.xml', import.meta.url));

/** Every opening tag is closed in order: enough to catch a typo that would leave OPNsense with no configuration. */
function balanced(/** @type {string} */ xml) {
  const stack = [];
  for (const m of xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z_][\w.-]*)([^>]*?)(\/?)>/g)) {
    const [, close, name, , selfClosing] = m;
    if (selfClosing) continue;
    if (close) {
      if (stack.pop() !== name) return false;
    } else stack.push(name);
  }
  return stack.length === 0;
}

test('the edge configuration fills the block the build gives it, and says what the edge is', () => {
  // The block (OPNSENSE_IMAGE.grow), not the 5,234 bytes the default fills:
  // the file is moved to a whole block of its own, and padded to it.
  const config = edgeConfig();
  assert.equal(config.length, OPNSENSE_IMAGE.grow.room, 'not the block the build gives the file');
  const xml = config.toString('utf8');
  // The padding is trailing whitespace only, which XML allows after the root.
  assert.match(xml, /<\/opnsense>\n *$/);
  assert.ok(balanced(xml.trimEnd()), 'the XML does not close what it opens');
  // Xen's interfaces, in the order the VM's are made; none left to assign at a console.
  assert.match(xml, /<wan><enable>1<\/enable><if>xn0<\/if>[\s\S]*?<ipaddr>dhcp<\/ipaddr><blockpriv>0<\/blockpriv><blockbogons>0<\/blockbogons><\/wan>/);
  assert.ok(xml.includes(`<lan><enable>1</enable><if>xn1</if><descr>LAN</descr><ipaddr>${EDGE.lan.address}</ipaddr><subnet>${EDGE.lan.prefix}</subnet></lan>`), 'the LAN is not on xn1 at the edge address');
  assert.ok(!xml.includes('mismatch'), 'an interface is left for somebody to assign');
  assert.ok(!xml.includes('trigger_initial_wizard'));
  // No login anywhere, and no rule that lets a lab at the web interface.
  assert.match(xml, /<user><name>root<\/name>[\s\S]*?<password>\*<\/password>/);
  assert.match(xml, /<noantilockout>1<\/noantilockout>/);
  // Labs: DNS from the edge, no other resolver, nothing private, then the
  // internet, in that order.
  const rules = [...xml.matchAll(/<rule>[\s\S]*?<sequence>(\d+)<\/sequence><action>(\w+)<\/action>[\s\S]*?<destination_net>([^<]+)<\/destination_net>(?:<destination_port>([^<]+)<\/destination_port>)?/g)]
    .map((m) => [Number(m[1]), m[2], m[3], m[4] ?? null]);
  assert.deepEqual(rules, [
    [1, 'pass', 'lanip', '53'],
    [2, 'block', 'any', 'fleetwright_dns'],
    [3, 'block', 'fleetwright_private', null],
    [4, 'pass', 'any', null],
  ]);
  assert.match(xml, /<name>fleetwright_dns<\/name><type>port<\/type><content>53\n853<\/content>/, 'plain DNS and DNS over TLS');
  const alias = /<name>fleetwright_private<\/name><type>network<\/type><content>([^<]*)<\/content>/.exec(xml);
  assert.ok(alias, 'no alias for what labs may not reach');
  assert.deepEqual(alias[1].split('\n'), [...NOT_FROM_LABS]);
  for (const range of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16']) assert.ok(NOT_FROM_LABS.includes(range), range);
});

test('the edge filters names against threat blocklists and watches the LAN, and fetches both on a cron since nothing does at boot', () => {
  const xml = edgeConfig().toString('utf8');
  // Each model one version below 26.7's, so only its newest migration runs
  // and the model is saved with its defaults (booted: stamped at the current
  // version, Unbound's templates failed on a missing node). Unbound's legacy
  // section is gone, so no older migration folds it in.
  assert.ok(!xml.includes('<unbound>'), 'the legacy section would be migrated over the new one');
  assert.match(xml, /<unboundplus version="1\.0\.14"><general><enabled>1<\/enabled><\/general>/);
  const bl = /<blocklist uuid="[0-9a-f-]{36}"><enabled>1<\/enabled><type>([^<]+)<\/type><description>[^<]+<\/description><\/blocklist>/.exec(xml);
  assert.ok(bl, 'no blocklist, or one without the description OPNsense requires');
  assert.deepEqual(bl[1].split(','), [...EDGE_FILTER.blocklists]);
  // Suricata on the LAN, so what it logs carries each machine's own address.
  assert.match(xml, /<IDS version="1\.1\.1"><general><enabled>1<\/enabled><interfaces>lan<\/interfaces><homenet>10\.254\.0\.0\/24<\/homenet>/);
  const files = [...xml.matchAll(/<file uuid="[0-9a-f-]{36}"><filename>([^<]+)<\/filename><enabled>1<\/enabled><\/file>/g)].map((m) => m[1]);
  assert.deepEqual(files, [...EDGE_FILTER.rules]);
  // The cron jobs, and the IDS pointing at its own by id.
  // Enabled in so many words: cron's template reads it as written, and a
  // job without it never reached the crontab when booted.
  assert.match(xml, /<cron version="1\.0\.3">/);
  const jobs = [...xml.matchAll(/<job uuid="([0-9a-f-]{36})">(?:<origin>(\w+)<\/origin>)?<enabled>1<\/enabled><command>([^<]+)<\/command><minutes>([^<]+)<\/minutes><hours>\*<\/hours>/g)]
    .map((m) => ({ id: m[1], command: m[3], minutes: m[4] }));
  assert.deepEqual(jobs.map((j) => [j.command, j.minutes]), [['unbound dnsbl', EDGE_FILTER.every], ['ids update', EDGE_FILTER.every]]);
  assert.ok(xml.includes(`<UpdateCron>${jobs[1].id}</UpdateCron>`), 'the IDS names a cron job that is not its update');
  // Every uuid once: two items with one id would be one item to OPNsense.
  const ids = [...xml.matchAll(/uuid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('a configuration that does not fit is refused rather than truncated', () => {
  assert.throws(() => edgeConfig({ length: 1000 }), /is \d+ bytes and the file it replaces is 1000/);
});

test('the default configuration pinned for the image is the one the image has', () => {
  assert.equal(DEFAULT.length, OPNSENSE_IMAGE.config.length);
  assert.equal(isDefaultConfig(DEFAULT), true);
  const changed = Buffer.from(DEFAULT);
  changed[100] ^= 1;
  assert.equal(isDefaultConfig(changed), false);
});

/** A small image: the default configuration at `offset` inside `total` bytes of a pattern. */
function image(/** @type {number} */ offset, /** @type {number} */ total, region = DEFAULT) {
  const buf = Buffer.alloc(total);
  for (let i = 0; i < total; i++) buf[i] = i % 251;
  region.copy(buf, offset);
  return buf;
}

/** Stream `buf` through a ConfigPatch in chunks of `size`, collecting the output or the error. */
async function patch(/** @type {Buffer} */ buf, /** @type {number} */ size, /** @type {any} */ opts) {
  const chunks = [];
  for (let i = 0; i < buf.length; i += size) chunks.push(buf.subarray(i, i + size));
  const out = [];
  const p = new ConfigPatch(opts);
  try {
    for await (const c of Readable.from(chunks).pipe(p)) out.push(c);
    return Buffer.concat(out);
  } catch (e) {
    return /** @type {Error} */ (e);
  }
}

test('the patch replaces exactly the configuration, however the image arrives in pieces', async () => {
  const offset = 300_001;
  const total = 400_000;
  const replacement = edgeConfig({ length: OPNSENSE_IMAGE.config.length });
  const want = image(offset, total);
  replacement.copy(want, offset);
  for (const size of [1, 7, 4096, 5234, 65536, total]) {
    const got = await patch(image(offset, total), size, { offset, replacement, total });
    assert.ok(Buffer.isBuffer(got), `chunks of ${size}: ${got}`);
    assert.ok(got.equals(want), `chunks of ${size} came out different`);
  }
});

test('an image without the default configuration at the offset, or of the wrong size, is not written', async () => {
  const offset = 4096;
  const replacement = edgeConfig({ length: OPNSENSE_IMAGE.config.length });
  const wrong = Buffer.from(DEFAULT);
  wrong[0] = 0x20;
  const moved = await patch(image(offset, 20_000, wrong), 1000, { offset, replacement, total: 20_000 });
  assert.match(String(moved), /does not have the default configuration where it should/);
  const short = await patch(image(offset, 20_000), 1000, { offset, replacement, total: 30_000 });
  assert.match(String(short), /unpacked to 20000 bytes, not 30000/);
  const cut = await patch(image(offset, 20_000).subarray(0, offset + 100), 1000, { offset, replacement, total: offset + 100 });
  assert.match(String(cut), /ended inside its configuration/);
});

test('a download that is not the published image is never used, and nothing is left behind', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fw-edge-'));
  const fetchImpl = /** @type {any} */ (async () => new Response('not the image'));
  await assert.rejects(fetchImage({ dir, fetchImpl }), /not the published/);
  assert.deepEqual(readdirSync(dir), []);
  const refused = /** @type {any} */ (async () => new Response('gone', { status: 404 }));
  await assert.rejects(fetchImage({ dir, fetchImpl: refused }), /answered 404/);
});

/** A stand-in for Xen Orchestra's admin connection: answers from `objects`, records every call. */
function xo(/** @type {Record<string, any[]>} */ objects, /** @type {Record<string, (p: any) => any>} */ answers = {}) {
  /** @type {[string, any][]} */
  const calls = [];
  return {
    calls,
    async call(/** @type {string} */ method, /** @type {any} */ params) {
      calls.push([method, params]);
      if (answers[method]) return answers[method](params);
      if (method === 'xo.getAllObjects') {
        const { type, ...match } = params.filter;
        return Object.fromEntries(
          (objects[type] || []).filter((o) => Object.entries(match).every(([k, v]) => o[k] === v)).map((o) => [o.id, o]),
        );
      }
      return null;
    },
  };
}

/** What only reads, left out where the order of what is done is the point. */
const READS = ['xo.getAllObjects', 'resourceSet.getAll'];

const GiB = 1024 ** 3;
const SRS = [
  { id: 'sr-small', $pool: 'p1', size: 4 * GiB, physical_usage: 2 * GiB },
  { id: 'sr-big', $pool: 'p1', size: 500 * GiB, physical_usage: 100 * GiB },
  { id: 'sr-other-pool', $pool: 'p2', size: 900 * GiB, physical_usage: 0 },
];
/** XCP-ng's own "Other install media": marked as a default template, with no disks of its own. */
const TEMPLATE = { id: 'tpl-other', $pool: 'p1', name_label: 'Other install media', isDefaultTemplate: true, $VBDs: [] };

/** Everything ensureEdge needs, with the download, unpack and upload stood in for. */
function edgeArgs(/** @type {any} */ admin, /** @type {any} */ extra = {}) {
  /** @type {string[]} */
  const said = [];
  /** @type {any[]} */
  const parts = [];
  return {
    said,
    parts,
    args: {
      admin,
      pool: 'p1',
      egress: { id: 'net-wan', name: 'eth0.10' },
      uplink: 'net-up',
      srs: SRS,
      fleetSrs: SRS.map((s) => s.id),
      address: 'xo.lan',
      pin: 'a'.repeat(64),
      plain: false,
      imageDir: '/nowhere',
      say: (/** @type {string} */ t, /** @type {any} */ part) => {
        said.push(t);
        if (part) parts.push(part);
      },
      getImage: async () => '/nowhere/image.bz2',
      unpackImpl: () => new PassThrough(),
      upload: async (/** @type {any} */ u) => {
        assert.equal(u.size, OPNSENSE_IMAGE.rawSize);
        assert.equal(u.sendTo, '/import/abc');
        assert.ok(u.body instanceof ConfigPatch, 'the disk is not written through the patch');
        return 'vdi-1';
      },
      ...extra,
    },
  };
}

test('an edge that blocks hands what leaves to Suricata and drops what the four rule files match; one that watches does neither', () => {
  // The regression this guards: a blocking edge that only logs, because the
  // way out never reached Suricata or no policy turned an alert into a drop.
  const block = edgeConfig({ block: true }).toString('utf8');
  const watch = edgeConfig().toString('utf8');
  assert.equal(block.length, OPNSENSE_IMAGE.grow.room, 'blocking no longer fits the room');
  assert.ok(balanced(block.trimEnd()));
  // Only the rule that lets labs out is diverted: DNS and private space are
  // decided before Suricata would see them.
  const rules = [...block.matchAll(/<rule>.*?<\/rule>/g)].map((m) => m[0]);
  assert.deepEqual(rules.map((r) => r.includes(`<divert-to>${EDGE_FILTER.divertPort}</divert-to>`)), [false, false, false, true]);
  assert.match(rules[3], /<action>pass<\/action>[\s\S]*Labs reach the internet/);
  assert.match(block, /<IDS version="1\.1\.1"><general><enabled>1<\/enabled><mode>divert<\/mode>/);
  // One policy, from alert to drop, over exactly the rule files it loads.
  const fileIds = [...block.matchAll(/<file uuid="([0-9a-f-]{36})">/g)].map((m) => m[1]);
  const policy = /<policy uuid="[0-9a-f-]{36}"><enabled>1<\/enabled><action>alert<\/action><rulesets>([^<]+)<\/rulesets><new_action>drop<\/new_action><\/policy>/.exec(block);
  assert.ok(policy, 'no policy that turns an alert into a drop');
  assert.deepEqual(policy[1].split(','), fileIds);
  assert.equal(fileIds.length, EDGE_FILTER.rules.length);
  const ids = [...block.matchAll(/uuid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  // Watching: no divert, no mode, no policy.
  for (const part of ['<divert-to>', '<mode>divert', '<policies>']) assert.ok(!watch.includes(part), `a watching edge has ${part}`);
});

test('every edge asks for the Xen guest agent and updates itself once a day, however it is built', () => {
  // ASKED FOR: the guest agent everywhere, so Xen Orchestra shows the edge's
  // address. OPNsense installs a plugin named in system.firmware.plugins only
  // from its firmware update, so the two come together (EDGE_UPDATES). A
  // job that is missing, or at another hour, is a router that never gets the
  // agent or restarts in the working day.
  const long = `https://${'f'.repeat(63)}.${'e'.repeat(20)}.workers.dev`;
  for (const opts of [{}, { block: true }, { block: true, labs: [false, false, false, false], fleet: fleetHosts(long) }]) {
    const xml = edgeConfig(opts).toString('utf8');
    const system = xml.slice(xml.indexOf('<system>'), xml.indexOf('</system>'));
    assert.ok(system.includes('<firmware><plugins>os-xen</plugins></firmware>'), JSON.stringify(opts));
    const jobs = [...xml.matchAll(/<job[ >].*?<\/job>/g)].map((m) => m[0]);
    const update = jobs.filter((j) => j.includes('<command>firmware auto-update</command>'));
    assert.equal(update.length, 1, JSON.stringify(opts));
    assert.match(update[0], /<hours>10<\/hours>/);
    assert.match(update[0], /^<job><enabled>1<\/enabled>/, 'on, and at minute 0 (Cron.xml’s default)');
  }
  assert.equal(EDGE_UPDATES.plugin, 'os-xen');
});

test('two edges share each gateway address by CARP, each with its own beside it, its half of DHCP and its own hour to update', () => {
  // ASKED FOR: HA, "will allow maintenance": one edge carries the labs while
  // the other restarts. Booted in QEMU as a pair (docs/hypervisors.md).
  const fleet = fleetHosts('https://fleet.example.network');
  const password = '0123456789abcdef';
  const [a, b] = /** @type {const} */ ([0, 1]).map((node) => edgeConfig({ block: true, labs: [true, false], fleet, ha: { node, password } }).toString('utf8'));
  for (const [x, node] of /** @type {Array<[string, 0|1]>} */ ([[a, 0], [b, 1]])) {
    assert.ok(balanced(x.trimEnd()));
    const mine = 2 + node;
    assert.ok(x.includes(`<lan><enable>1</enable><if>xn1</if><descr>LAN</descr><ipaddr>10.254.0.${mine}</ipaddr>`), 'its own LAN address, not the shared one');
    assert.ok(x.includes(`<descr>LAB2</descr><ipaddr>10.250.2.${mine}</ipaddr>`));
    const vips = [...x.matchAll(/<vip>.*?<\/vip>/g)].map((m) => m[0]);
    assert.deepEqual(vips.map((v) => /<subnet>([^<]+)<\/subnet>/.exec(v)?.[1]), ['10.254.0.1', '10.250.1.1', '10.250.2.1'], 'each gateway shared');
    assert.deepEqual(vips.map((v) => /<vhid>(\d+)<\/vhid>/.exec(v)?.[1]), ['1', '2', '3']);
    assert.ok(vips.every((v) => v.includes('<mode>carp</mode>') && v.includes(`<password>${password}</password>`) && v.includes(`<advskew>${node * 100}</advskew>`)), 'the same password, the first preferred');
    const [lo, hi] = node ? [175, 250] : [100, 174];
    assert.ok(x.includes(`<dhcp_ranges><interface>lan</interface><start_addr>10.254.0.${lo}</start_addr><end_addr>10.254.0.${hi}</end_addr></dhcp_ranges>`), 'its half of the range, so no two leases collide');
    for (const [iface, gw] of [['lan', '10.254.0.1'], ['opt2', '10.250.2.1']]) {
      for (const o of [3, 6]) assert.ok(x.includes(`<option>${o}</option><interface>${iface}</interface><value>${gw}</value>`), `${iface} ${o}: the shared address, which outlives either router`);
    }
    assert.match(x, new RegExp(`<command>firmware auto-update</command><hours>${10 + node}</hours>`), 'never both restarting at once');
    assert.ok(x.includes(`<hostname>${node ? 'fleetwright-edge-b' : 'fleetwright-edge'}</hostname>`));
  }
  // Without labs, names are asked of (self), which includes the shared address.
  assert.match(edgeConfig({ ha: { node: 0, password } }).toString('utf8'), /<destination_net>\(self\)<\/destination_net><destination_port>53<\/destination_port>/);
  assert.match(edgeConfig().toString('utf8'), /<destination_net>lanip<\/destination_net><destination_port>53<\/destination_port>/, 'a single edge as before');
  assert.ok(!edgeConfig().toString('utf8').includes('<virtualip>'));
  // The most a pair holds fits.
  const long = `https://${'f'.repeat(63)}.${'e'.repeat(20)}.workers.dev`;
  assert.equal(edgeConfig({ block: true, labs: [false, false, false, false], fleet: fleetHosts(long), ha: { node: 1, password: 'f'.repeat(64) } }).length, OPNSENSE_IMAGE.grow.room);
  for (const ha of [{ node: 2, password }, { node: 0, password: 'short' }, { node: 0, password: "x'<y" }]) {
    assert.throws(() => edgeConfig({ ha: /** @type {any} */ (ha) }), /which one this is and their shared password/);
  }
  assert.equal(EDGE_HA.second, 'fleetwright-edge-b');
});

// --- labs on the edge ---------------------------------------------------------
//
// docs/hypervisors.md, "Labs". The rules below were read back with `pfctl -sr`
// from this configuration booted in QEMU, four labs, two closed, blocking: one
// pf rule per interface of each, in this order.

/** Each filter rule as [sequence, action, interfaces, destination, port, divert, log]. @param {string} xml */
const rulesOf = (xml) =>
  [...xml.slice(xml.indexOf('<Filter>')).matchAll(/<rule>.*?<\/rule>/g)].map((m) => {
    const r = m[0];
    const get = (/** @type {string} */ tag) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(r)?.[1] ?? null;
    return [Number(get('sequence')), get('action'), get('interface'), get('destination_net'), get('destination_port'), r.includes('<divert-to>'), get('log') === '1'];
  });

test('each lab is an interface of its own on the edge, with its address, its DHCP and Suricata watching it', () => {
  const xml = edgeConfig({ labs: [true, false], fleet: fleetHosts('https://fleet.example.network/x') }).toString('utf8');
  assert.equal(Buffer.byteLength(xml), OPNSENSE_IMAGE.grow.room, 'not the block the build gives the file');
  assert.ok(balanced(xml.trimEnd()));
  assert.ok(xml.includes('<opt1><enable>1</enable><if>xn2</if><descr>LAB1</descr><ipaddr>10.250.1.1</ipaddr><subnet>24</subnet></opt1>'));
  assert.ok(xml.includes('<opt2><enable>1</enable><if>xn3</if><descr>LAB2</descr><ipaddr>10.250.2.1</ipaddr><subnet>24</subnet></opt2>'));
  assert.ok(!xml.includes('<opt3>'));
  assert.match(xml, /<dnsmasq><enable>1<\/enable><port>53053<\/port><interface>lan,opt1,opt2<\/interface>/);
  assert.ok(xml.includes('<dhcp_ranges><interface>opt2</interface><start_addr>10.250.2.100</start_addr><end_addr>10.250.2.250</end_addr></dhcp_ranges>'));
  assert.match(xml, /<interfaces>lan,opt1,opt2<\/interfaces><homenet>10\.254\.0\.0\/24,10\.250\.1\.0\/24,10\.250\.2\.0\/24<\/homenet>/);
  // Every lab between 1 and the most there is room for fits, either kind,
  // either mode, with a coordinator whose name is long: it is written twice
  // for a closed lab, in the alias and as a name it may resolve.
  const long = `https://${'f'.repeat(63)}.${'e'.repeat(20)}.workers.dev`;
  for (const block of [false, true]) for (const kinds of [[true, true, true, true], [false, false, false, false], [true, false, true, false]]) {
    for (const url of ['https://fleet.example.network', long]) assert.equal(edgeConfig({ block, labs: kinds, fleet: fleetHosts(url) }).length, OPNSENSE_IMAGE.grow.room, url);
  }
  assert.throws(() => edgeConfig({ labs: [true, true, true, true, true] }), /room for 4 labs/);
  assert.throws(() => edgeConfig({ labs: [false] }), /closed lab needs the fleet/);
});

test('a lab reaches nothing private and asks only the edge for names; an open one the internet, a closed one only the fleet and Claude', () => {
  const xml = edgeConfig({ block: true, labs: [true, true, false, false], fleet: fleetHosts('https://fleet.example.network') }).toString('utf8');
  assert.deepEqual(rulesOf(xml), [
    [1, 'pass', 'lan,opt1,opt2,opt3,opt4', '(self)', '53', false, false],
    [2, 'block', 'lan,opt1,opt2,opt3,opt4', 'any', 'fleetwright_dns', false, false],
    [3, 'block', 'lan,opt1,opt2,opt3,opt4', 'fleetwright_private', null, false, false],
    [4, 'pass', 'lan,opt1,opt2', 'any', null, true, false],
    [9, 'pass', 'opt3,opt4', 'fleetwright_fleet', '443', true, false],
    [10, 'block', 'opt3,opt4', 'any', null, false, true],
  ]);
  // What a closed lab may reach: the coordinator, and Claude's required hosts, the sandbox's own list.
  const alias = /<name>fleetwright_fleet<\/name><type>host<\/type><content>([^<]*)<\/content>/.exec(xml);
  assert.ok(alias, 'no alias of the fleet’s hosts');
  assert.deepEqual(alias[1].split('\n'), ['fleet.example.network', ...REQUIRED_HOSTS]);
  // Without labs, the uplink's rules are exactly what was booted before labs.
  assert.deepEqual(rulesOf(edgeConfig().toString('utf8')).map((r) => r.slice(0, 4)), [
    [1, 'pass', 'lan', 'lanip'],
    [2, 'block', 'lan', 'any'],
    [3, 'block', 'lan', 'fleetwright_private'],
    [4, 'pass', 'lan', 'any'],
  ]);
  // Only open labs: no alias, no closed rules.
  const open = edgeConfig({ labs: [true] }).toString('utf8');
  assert.ok(!open.includes('fleetwright_fleet'));
  assert.deepEqual(rulesOf(open).map((r) => r[0]), [1, 2, 3, 4]);
});

test('a closed lab resolves only the fleet’s own hosts and the names under them, and is refused the rest; open labs and the uplink ask Unbound as before', () => {
  const fleet = fleetHosts('https://fleet.example.network');
  const xml = edgeConfig({ block: true, labs: [true, true, false, false], fleet }).toString('utf8');
  // ITS PORT 53 GOES TO DNSMASQ, before any filter rule, from the closed labs alone.
  const rdr = /<nat><outbound><mode>automatic<\/mode><\/outbound>(<rule>.*?<\/rule>)<\/nat>/.exec(xml)?.[1] ?? '';
  const get = (/** @type {string} */ tag) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(rdr)?.[1] ?? null;
  assert.deepEqual(
    [get('interface'), get('protocol'), /<destination>.*?<port>([^<]*)<\/port>/.exec(rdr)?.[1], get('target'), get('local-port'), get('pass')],
    ['opt3,opt4', 'TCP/UDP', '53', '127.0.0.1', String(DNSMASQ_PORT), 'pass'],
    'a closed lab’s questions reach Unbound, which answers any name',
  );
  // WHICH HAS NO RESOLVER OF ITS OWN, so a name it was not given is REFUSED,
  const dnsmasq = /<dnsmasq>.*?<\/dnsmasq>/.exec(xml)?.[0] ?? '';
  assert.ok(dnsmasq.includes('<no_resolv>1</no_resolv>'), 'dnsmasq would ask the edge’s resolv.conf, which is Unbound, for every other name');
  // AND IS GIVEN THE FIREWALL'S LIST: every host a closed lab may reach is
  // answered, by Unbound on the edge itself, and nothing else is.
  const answered = [...dnsmasq.matchAll(/<domainoverrides><sequence>\d+<\/sequence><domain>([^<]+)<\/domain><ip>([^<]+)<\/ip><\/domainoverrides>/g)].map((m) => [m[1], m[2]]);
  assert.ok(answered.length, 'no names at all');
  assert.ok(answered.every(([, ip]) => ip === '127.0.0.1'));
  const covers = (/** @type {string} */ zone, /** @type {string} */ host) => host === zone || host.endsWith(`.${zone}`);
  for (const host of fleet) assert.ok(answered.some(([zone]) => covers(zone, host)), `${host} may be reached and not resolved`);
  for (const [zone] of answered) assert.ok(fleet.includes(zone), `${zone} is not one of the hosts a closed lab may reach`);

  // ONLY FOR CLOSED LABS: none, or only open ones, is the edge as it was.
  for (const other of [edgeConfig(), edgeConfig({ block: true }), edgeConfig({ labs: [true, true] })]) {
    const x = other.toString('utf8');
    assert.ok(x.includes('<nat><outbound><mode>automatic</mode></outbound></nat>'));
    assert.ok(!x.includes('no_resolv') && !x.includes('domainoverrides'));
  }
});

test('the configuration moves to a free block, and every byte of the file system that records it is checked before it is replaced', async () => {
  // OPNSENSE_IMAGE.grow, planned from the real image by
  // scripts/opnsense-room.mjs (src/fleet/host/ufs-room.js checks the plan as
  // fsck would). Here: that the build replaces exactly those bytes, in order,
  // and refuses an image where any of them is not what the plan says.
  const { grow } = OPNSENSE_IMAGE;
  const replacement = edgeConfig({ labs: [true] });
  const patches = imagePatches(replacement);
  assert.deepEqual(patches.map((p) => p.offset), [...grow.edits.map((e) => e.offset), grow.data.offset]);
  assert.ok(patches.every((p, i) => i === 0 || p.offset > patches[i - 1].offset), 'out of the order the image streams in');
  // The same regions in a small image, each where the next is, scaled down.
  const at = patches.map((_, i) => 1_000 + i * 100);
  at[at.length - 1] = 4_000;
  const total = at.at(-1) + grow.room + 500;
  const regions = patches.map((p, i) => ({ ...p, offset: at[i] }));
  const img = (/** @type {number} */ wrong = -1, dirty = false) => {
    const buf = Buffer.alloc(total, 7);
    grow.edits.forEach((e, i) => {
      const was = Buffer.from(e.was, 'hex');
      if (i === wrong) was[0] ^= 1;
      was.copy(buf, at[i]);
    });
    buf.fill(dirty ? 1 : 0, at.at(-1), at.at(-1) + grow.room);
    return buf;
  };
  const out = await patch(img(), 333, { regions, total });
  assert.ok(Buffer.isBuffer(out), String(out));
  grow.edits.forEach((e, i) => assert.equal(out.subarray(at[i], at[i] + e.becomes.length / 2).toString('hex'), e.becomes, e.what));
  assert.ok(out.subarray(at.at(-1), at.at(-1) + grow.room).equals(replacement));
  assert.equal(out[at[0] - 1], 7, 'a byte outside the regions changed');
  assert.match(String(await patch(img(3), 333, { regions, total })), /inode 6523: first block/);
  assert.match(String(await patch(img(-1, true), 333, { regions, total })), /the free block the configuration moves to/);
  assert.throws(() => imagePatches(Buffer.alloc(6000)), /is 32768 bytes, not 6000/);
  // The plan moves the inode's first block to where the configuration goes.
  const first = grow.edits.find((e) => e.what.endsWith('first block'));
  assert.equal(Number(Buffer.from(/** @type {any} */ (first).becomes, 'hex').readBigInt64LE()) * 4096, grow.data.offset);
});

test('an edge is built with an interface on each lab, in order, and tagged with them; one with other labs is rebuilt, filtering as it did', async () => {
  const fleet = fleetHosts('https://fleet.example.network');
  const labs = [{ id: 'net-lab-1', open: true }, { id: 'net-lab-2', open: false }];
  const fresh = xo({ VM: [], 'VM-template': [TEMPLATE], VIF: [] }, { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => 'vm-1' });
  /** @type {any} */
  let body = null;
  const done = await ensureEdge(edgeArgs(fresh, { labs, fleet, upload: async (/** @type {any} */ u) => ((body = u.body), 'vdi-1') }).args);
  const made = Object.fromEntries(fresh.calls)['vm.create'];
  assert.deepEqual(made.VIFs.map((/** @type {any} */ v) => v.network), ['net-wan', 'net-up', 'net-lab-1', 'net-lab-2']);
  assert.deepEqual(made.tags, [EDGE.tag, EDGE.updatesTag, `${LAB.edgeTag}oc`]);
  assert.equal(body.regions.length, OPNSENSE_IMAGE.grow.edits.length + 1, 'the file was not given its block');
  assert.match(done, /It has one open lab and one closed lab of their own/);

  // There with the same labs: nothing done. Asked nothing of labs: nothing done.
  const old = { id: 'vm-old', $pool: 'p1', tags: [EDGE.tag, EDGE.updatesTag, EDGE.blocksTag, `${LAB.edgeTag}oc`], power_state: 'Running' };
  const onLabs = [{ id: 'v2', $VM: 'vm-old', device: '2', $network: 'net-lab-1' }, { id: 'v3', $VM: 'vm-old', device: '3', $network: 'net-lab-2' }];
  for (const ask of [labs, null]) {
    const same = xo({ VM: [old], VIF: onLabs });
    const said = await ensureEdge(edgeArgs(same, { labs: ask, fleet }).args);
    assert.deepEqual(same.calls.map(([m]) => m).filter((m) => !READS.includes(m)), []);
    assert.match(said, /already there[\s\S]*with one open lab and one closed lab/);
  }
  // Other labs: rebuilt, still dropping, as nobody asked to change that.
  const rebuilt = xo({ VM: [old], 'VM-template': [TEMPLATE], VIF: [] }, { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => 'vm-new' });
  const { args, said } = edgeArgs(rebuilt, { labs: [{ id: 'net-lab-1', open: true }], fleet });
  await ensureEdge(args);
  const params = Object.fromEntries(rebuilt.calls);
  assert.deepEqual(params['vm.create'].tags, [EDGE.tag, EDGE.updatesTag, EDGE.blocksTag, `${LAB.edgeTag}o`]);
  assert.deepEqual(params['vm.delete'], { id: 'vm-old', deleteDisks: true });
  assert.ok(said.includes('Rebuilding the edge router with one open lab. Machines behind it have no way out until it is up.'), said.join('\n'));
  // The same kinds on a lab network made again: the old edge is not on it.
  const moved = xo({ VM: [old], 'VM-template': [TEMPLATE], VIF: onLabs }, { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => 'vm-new' });
  await ensureEdge(edgeArgs(moved, { labs: [labs[0], { id: 'net-lab-2b', open: false }], fleet }).args);
  assert.deepEqual(Object.fromEntries(moved.calls)['vm.create'].VIFs.at(-1), { network: 'net-lab-2b' });
});

test('lab networks are made up to the number asked, tagged open or closed, kept in the set, and one no longer asked for loses its kind', async () => {
  let n = 0;
  const admin = xo({}, { 'network.create': () => `net-l${++n}` });
  const there = [
    { id: 'net-l0', name_label: 'fleetwright-lab-1', $pool: 'p1', tags: [LAB.closedTag] },
    { id: 'net-l9', name_label: 'fleetwright-lab-3', $pool: 'p1', tags: [LAB.openTag] },
  ];
  const r = await ensureLabs({ admin, pool: 'p1', networks: there, setId: 'rs-1', inSet: ['net-l0'], open: 1, closed: 1 });
  assert.deepEqual(r.labs, [{ id: 'net-l0', name: 'fleetwright-lab-1', open: true }, { id: 'net-l1', name: 'fleetwright-lab-2', open: false }]);
  assert.deepEqual(r.made, ['fleetwright-lab-2']);
  assert.deepEqual(admin.calls.map(([m, p]) => [m, p.id ?? p.name, p.tag ?? p.object ?? null]), [
    ['tag.remove', 'net-l0', LAB.closedTag],
    ['tag.add', 'net-l0', LAB.openTag],
    ['network.create', 'fleetwright-lab-2', null],
    ['tag.add', 'net-l1', LAB.closedTag],
    ['resourceSet.addObject', 'rs-1', 'net-l1'],
    ['tag.remove', 'net-l9', LAB.openTag],
  ]);
  assert.ok(!admin.calls.some(([m]) => m === 'network.delete'), 'a lab network was removed, though a machine may be on it');

  // LABS PER PERSON on each lab: set, changed, taken off, and left alone by a
  // phone that predates it; and gone from one no longer a lab.
  const each = async (/** @type {number|null|undefined} */ perPerson, /** @type {string[]} */ tags) => {
    const a = xo({});
    const nets = [
      { id: 'net-a', name_label: 'fleetwright-lab-1', $pool: 'p1', tags: [LAB.openTag, ...tags] },
      { id: 'net-z', name_label: 'fleetwright-lab-2', $pool: 'p1', tags: [LAB.openTag, `${LAB.eachTag}3`] },
    ];
    await ensureLabs({ admin: a, pool: 'p1', networks: nets, setId: 'rs-1', inSet: ['net-a', 'net-z'], open: 1, closed: 0, perPerson });
    return a.calls.filter(([, p]) => String(p.tag).startsWith(LAB.eachTag)).map(([m, p]) => [m, p.id, p.tag]);
  };
  assert.deepEqual(await each(2, []), [['tag.add', 'net-a', `${LAB.eachTag}2`], ['tag.remove', 'net-z', `${LAB.eachTag}3`]]);
  assert.deepEqual(await each(2, [`${LAB.eachTag}3`]), [['tag.remove', 'net-a', `${LAB.eachTag}3`], ['tag.add', 'net-a', `${LAB.eachTag}2`], ['tag.remove', 'net-z', `${LAB.eachTag}3`]]);
  assert.deepEqual(await each(null, [`${LAB.eachTag}3`]), [['tag.remove', 'net-a', `${LAB.eachTag}3`], ['tag.remove', 'net-z', `${LAB.eachTag}3`]]);
  assert.deepEqual(await each(undefined, [`${LAB.eachTag}3`]), [['tag.remove', 'net-z', `${LAB.eachTag}3`]], 'a phone that says nothing changed the limit');
  // And read back as the box reads it: no tag, or none that is a number, is no limit.
  assert.equal(labsEachOf([{ name_label: 'fleetwright-lab-1', $pool: 'p1', tags: [LAB.openTag, `${LAB.eachTag}2`] }, { name_label: 'fleetwright-lab-2', $pool: 'p1', tags: [LAB.closedTag, `${LAB.eachTag}1`] }], 'p1'), 1);
  for (const tags of [[LAB.openTag], [LAB.openTag, `${LAB.eachTag}0`], [LAB.openTag, `${LAB.eachTag}x`], [`${LAB.eachTag}2`]]) {
    assert.equal(labsEachOf([{ name_label: 'fleetwright-lab-1', $pool: 'p1', tags }], 'p1'), null, JSON.stringify(tags));
  }
  const most = await ensureLabs({ admin: xo({}, { 'network.create': () => `net-m${++n}` }), pool: 'p1', networks: [], setId: 'rs-1', inSet: [], open: 3, closed: 3 });
  assert.equal(most.labs.length, LAB.max);
});

test('the edge router is made in the order that boots: disk in, WAN first, checksum offload off, started', async () => {
  const admin = xo(
    { VM: [], 'VM-template': [TEMPLATE], VIF: [{ id: 'vif-a', $VM: 'vm-1', device: '0' }, { id: 'vif-b', $VM: 'vm-1', device: '1' }] },
    { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => 'vm-1' },
  );
  const { args, said } = edgeArgs(admin);
  const done = await ensureEdge(args);
  const methods = admin.calls.map(([m]) => m).filter((m) => !READS.includes(m));
  // Asked first whether it can write into a disk that is there: this stand-in
  // makes none, so the whole disk is sent.
  assert.deepEqual(methods, ['disk.create', 'disk.import', 'vm.create', 'vm.attachDisk', 'vif.set', 'vif.set', 'vm.start']);
  const params = Object.fromEntries(admin.calls);
  // On the chosen storage in this pool with the most room.
  assert.equal(params['disk.import'].sr, 'sr-big');
  assert.equal(params['disk.import'].type, 'iso');
  const made = params['vm.create'];
  assert.equal(made.template, 'tpl-other');
  assert.deepEqual(made.VIFs.map((/** @type {any} */ v) => v.network), ['net-wan', 'net-up']);
  assert.deepEqual(made.VDIs, []);
  assert.deepEqual(made.tags, [EDGE.tag, EDGE.updatesTag]);
  assert.ok(!made.tags.includes('fleetwright'), "the fleet's token could manage its own way out");
  assert.deepEqual(params['vm.attachDisk'], { vm: 'vm-1', vdi: 'vdi-1', bootable: true, position: '0' });
  assert.deepEqual(admin.calls.filter(([m]) => m === 'vif.set').map(([, p]) => p), [
    { id: 'vif-a', txChecksumming: false },
    { id: 'vif-b', txChecksumming: false },
  ]);
  assert.deepEqual(params['vm.start'], { id: 'vm-1' });
  assert.match(done, /The edge router is up: OPNsense 26\.7, its WAN on eth0\.10 and its LAN on fleetwright-uplink at 10\.254\.0\.1\/24/);
  assert.ok(said.some((t) => t.startsWith('Downloading OPNsense')), 'the person is not told about the download');
});

test('the disk goes where the person chose, and the build says where and how far, stage by stage', async () => {
  // ASKED FOR: "this needs proper progress, also which disk did it put it
  // on?" The bar was the step, and the storage was never named.
  const LOCAL = { id: 'sr-local', name_label: 'Local storage', $pool: 'p1', size: 100 * GiB, physical_usage: 10 * GiB };
  const admin = xo(
    { VM: [], 'VM-template': [TEMPLATE], VIF: [] },
    { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => 'vm-1' },
  );
  const { args, said, parts } = edgeArgs(admin, {
    srs: [...SRS, LOCAL],
    fleetSrs: ['sr-big'],
    sr: 'sr-local',
    getImage: async (/** @type {any} */ g) => {
      g.onProgress(OPNSENSE_IMAGE.compressedSize / 2, OPNSENSE_IMAGE.compressedSize);
      return '/nowhere/image.bz2';
    },
    upload: async (/** @type {any} */ u) => {
      u.onProgress(OPNSENSE_IMAGE.rawSize / 2, OPNSENSE_IMAGE.rawSize);
      return 'vdi-1';
    },
  });
  const done = await ensureEdge(args);
  assert.equal(Object.fromEntries(admin.calls)['disk.import'].sr, 'sr-local', 'not on the storage chosen, though the fleet may not use it');
  assert.ok(said.includes('Writing the edge router’s disk to Local storage: 1536 of 3072 MB.'), said.join('\n'));
  assert.match(done, /its disk on Local storage\./);
  // Three stages, in order, and a bar that only moves forward and ends full
  // but for starting the VM.
  assert.deepEqual([...new Set(parts.map((p) => p.stage))], [1, 2, 3]);
  assert.ok(parts.every((p) => p.stages === 3));
  for (let i = 1; i < parts.length; i++) assert.ok(parts[i].fill >= parts[i - 1].fill, `the bar went back at ${i}`);
  assert.ok(parts.at(-1).fill >= 980 && parts.at(-1).fill <= 1000);
  assert.ok(parts.some((p) => p.fill > 0 && p.fill < 500), 'the download moved the bar');
});

test('cancel stops the build where it is and removes the partial disk, and only that one', async () => {
  const controller = new AbortController();
  const admin = xo(
    {
      VM: [],
      'VM-template': [TEMPLATE],
      VIF: [],
      VDI: [
        { id: 'vdi-partial', name_label: EDGE.vm, $SR: 'sr-big', $VBDs: [] },
        { id: 'vdi-in-use', name_label: EDGE.vm, $SR: 'sr-big', $VBDs: ['vbd-1'] },
      ],
    },
    { 'disk.import': () => ({ $sendTo: '/import/abc' }) },
  );
  const { args } = edgeArgs(admin, {
    signal: controller.signal,
    upload: async (/** @type {any} */ u) => {
      assert.equal(u.signal, controller.signal, 'the upload is not told to stop');
      controller.abort();
      throw new Error('cancelled');
    },
  });
  await assert.rejects(ensureEdge(args), /cancelled/);
  assert.deepEqual(admin.calls.filter(([m]) => m === 'vdi.delete').map(([, p]) => p), [{ id: 'vdi-partial' }]);
  assert.ok(!admin.calls.some(([m]) => m === 'vm.create'));
});

test('an edge router already there is not built again: its WAN follows the way out, and it is started', async () => {
  const admin = xo({
    VM: [{ id: 'vm-old', $pool: 'p1', tags: [EDGE.tag, EDGE.updatesTag], power_state: 'Halted', addresses: { '1/ipv4/0': '10.254.0.1', '0/ipv4/0': '10.10.10.237' } }],
    VIF: [{ id: 'vif-w', $VM: 'vm-old', device: '0', $network: 'net-before' }],
  });
  const { args } = edgeArgs(admin);
  const done = await ensureEdge(args);
  const methods = admin.calls.map(([m]) => m).filter((m) => !READS.includes(m));
  assert.deepEqual(methods, ['vif.set', 'vm.start']);
  assert.deepEqual(admin.calls.find(([m]) => m === 'vif.set')?.[1], { id: 'vif-w', network: 'net-wan' });
  assert.match(done, /already there, on eth0\.10 at 10\.10\.10\.237,[\s\S]*WAN moved to eth0\.10[\s\S]*was started/, 'its WAN address, not its LAN one');
  assert.ok(!done.includes('does not know'));
});

test('an edge from before it updated itself is rebuilt once to get that and the guest agent, and one whose address nobody knows says so', async () => {
  const old = { id: 'vm-old', $pool: 'p1', tags: [EDGE.tag], power_state: 'Running' };
  const admin = xo(
    { VM: [old], 'VM-template': [TEMPLATE], VIF: [] },
    { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => 'vm-new' },
  );
  /** @type {string[]} */
  const said = [];
  const done = await ensureEdge(edgeArgs(admin, { say: (/** @type {string} */ t) => said.push(t) }).args);
  assert.ok(said.includes('Rebuilding the edge router so it keeps itself up to date and gets the Xen guest agent. Machines behind it have no way out until it is up.'));
  assert.deepEqual(Object.fromEntries(admin.calls)['vm.create'].tags, [EDGE.tag, EDGE.updatesTag], 'logging, as it was');
  assert.match(done, /updates itself every day after 10:00 UTC, restarting when OPNsense needs it to, and gets the Xen guest agent with its first update\./);
  // Current, and Xen Orchestra knows no address: cannot tell, not "none".
  const quiet = xo({ VM: [{ ...old, tags: [EDGE.tag, EDGE.updatesTag] }], VIF: [] });
  assert.match(await ensureEdge(edgeArgs(quiet).args), /already there, on eth0\.10, logging[\s\S]*Xen Orchestra does not know its WAN address: it has none, or its guest agent has not arrived yet/);
});

test('an edge built the other way is rebuilt: the old one stopped, the new one built and tagged, and only then the old one removed', async () => {
  const old = { id: 'vm-old', $pool: 'p1', tags: [EDGE.tag, EDGE.updatesTag], power_state: 'Running' };
  const admin = xo(
    { VM: [old], 'VM-template': [TEMPLATE], VIF: [] },
    { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => 'vm-new' },
  );
  let told = 0;
  const { args } = edgeArgs(admin, { block: true, rebuilding: () => told++ });
  const done = await ensureEdge(args);
  assert.equal(told, 1, 'the job is not told it is rebuilding');
  const methods = admin.calls.map(([m]) => m).filter((m) => !READS.includes(m) && m !== 'vif.set');
  assert.deepEqual(methods, ['vm.stop', 'disk.create', 'disk.import', 'vm.create', 'vm.attachDisk', 'vm.start', 'vm.delete']);
  const params = Object.fromEntries(admin.calls);
  assert.deepEqual(params['vm.stop'], { id: 'vm-old', force: true });
  assert.deepEqual(params['vm.create'].tags, [EDGE.tag, EDGE.updatesTag, EDGE.blocksTag]);
  assert.deepEqual(params['vm.delete'], { id: 'vm-old', deleteDisks: true });
  assert.match(done, /dropped[\s\S]*replaced the one that was there/);
});

test('a rebuild that fails leaves the old edge running as it was, and an edge asked nothing of is left alone', async () => {
  const old = { id: 'vm-old', $pool: 'p1', tags: [EDGE.tag, EDGE.updatesTag, EDGE.blocksTag], power_state: 'Running' };
  const admin = xo(
    { VM: [old], 'VM-template': [TEMPLATE], VIF: [] },
    { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => { throw new Error('no memory left on the host'); } },
  );
  await assert.rejects(ensureEdge(edgeArgs(admin, { block: false }).args), /no memory left on the host\. The edge router it was replacing was started again/);
  assert.deepEqual(admin.calls.filter(([m]) => m === 'vm.start').map(([, p]) => p), [{ id: 'vm-old' }]);
  assert.ok(!admin.calls.some(([m, p]) => m === 'vm.delete' && p.id === 'vm-old'), 'the old edge was removed though nothing replaced it');
  // A phone that predates the choice sends none: the edge is not touched,
  // whichever way it was built; nor is one already built the way asked.
  for (const block of [null, true]) {
    const there = xo({ VM: [old], VIF: [] });
    const said = await ensureEdge(edgeArgs(there, { block }).args);
    assert.deepEqual(there.calls.map(([m]) => m).filter((m) => !READS.includes(m)), [], String(block));
    assert.match(said, /already there[\s\S]*dropping what its threat rules match/);
  }
});

// --- two edges (HA) -----------------------------------------------------------
//
// ASKED FOR: "do ha will allow maintenance". A pair shares each gateway
// address by CARP; booted in QEMU as a pair (docs/hypervisors.md).

/** An admin stand-in that hands out VM ids in order and records xenStoreData. */
function pairXo(/** @type {any[]} */ vms) {
  let n = 0;
  return xo({ VM: vms, 'VM-template': [TEMPLATE], VIF: [] }, { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => `vm-new-${++n}` });
}
const methodsOf = (/** @type {any} */ admin) => admin.calls.map((/** @type {any} */ c) => c[0]).filter((/** @type {string} */ m) => !READS.includes(m) && m !== 'vif.set');
const created = (/** @type {any} */ admin) => admin.calls.filter((/** @type {any} */ c) => c[0] === 'vm.create').map((/** @type {any} */ c) => c[1]);
const passwords = (/** @type {any} */ admin) => admin.calls.filter((/** @type {any} */ c) => c[0] === 'vm.set' && c[1].xenStoreData).map((/** @type {any} */ c) => c[1].xenStoreData[EDGE_HA.passwordKey]);

test('a pair asked for where there is none is two edges, each tagged with which it is and given the same password', async () => {
  const admin = pairXo([]);
  const done = await ensureEdge(edgeArgs(admin, { ha: true }).args);
  assert.deepEqual(created(admin).map((c) => [c.name_label, c.tags.filter((/** @type {string} */ x) => x.startsWith(EDGE_HA.nodeTag))]), [[EDGE.vm, [`${EDGE_HA.nodeTag}0`]], [EDGE_HA.second, [`${EDGE_HA.nodeTag}1`]]]);
  const [p0, p1] = passwords(admin);
  assert.match(p0, /^[0-9a-f]{32}$/);
  assert.equal(p1, p0, 'two passwords, and neither would hear the other');
  assert.equal(admin.calls.filter((/** @type {any} */ c) => c[0] === 'vm.start').length, 2);
  assert.match(done, /two edge routers, sharing 10\.254\.0\.1: when one restarts, the other carries the machines behind them/);
});

test('one edge becomes a pair with the way out gone only while the second starts: made first, then the old one stops, then the first is rebuilt', async () => {
  const old = { id: 'vm-old', $pool: 'p1', tags: [EDGE.tag, EDGE.updatesTag], power_state: 'Running' };
  const admin = pairXo([old]);
  const { args, said } = edgeArgs(admin, { ha: true });
  const done = await ensureEdge(args);
  // The second made but not started while the old one still has 10.254.0.1.
  assert.deepEqual(methodsOf(admin), ['disk.create', 'disk.import', 'vm.create', 'vm.set', 'vm.attachDisk', 'vm.stop', 'vm.start', 'disk.create', 'disk.import', 'vm.create', 'vm.set', 'vm.attachDisk', 'vm.start', 'vm.delete']);
  const starts = admin.calls.filter((/** @type {any} */ c) => c[0] === 'vm.start').map((/** @type {any} */ c) => c[1].id);
  assert.deepEqual(starts, ['vm-new-1', 'vm-new-2'], 'the second, then the new first');
  assert.deepEqual(admin.calls.find((/** @type {any} */ c) => c[0] === 'vm.stop')?.[1], { id: 'vm-old', force: true });
  assert.deepEqual(admin.calls.find((/** @type {any} */ c) => c[0] === 'vm.delete')?.[1], { id: 'vm-old', deleteDisks: true });
  assert.equal(new Set(passwords(admin)).size, 1);
  assert.ok(said.some((s) => /no way out while the second starts/.test(s)), 'the outage is said before it happens');
  assert.match(done, /There are two edge routers now/);
});

test('a pair is rebuilt one at a time with the password it has, and the second goes first', async () => {
  const password = 'ab'.repeat(16);
  const a = { id: 'vm-a', name_label: EDGE.vm, $pool: 'p1', tags: [EDGE.tag, EDGE.updatesTag, `${EDGE_HA.nodeTag}0`], power_state: 'Running', xenStoreData: xenStoreAsXo({ [EDGE_HA.passwordKey]: password }) };
  const b = { id: 'vm-b', name_label: EDGE_HA.second, $pool: 'p1', tags: [EDGE.tag, EDGE.updatesTag, `${EDGE_HA.nodeTag}1`], power_state: 'Running', xenStoreData: xenStoreAsXo({ [EDGE_HA.passwordKey]: password }) };
  const admin = pairXo([a, b]);
  const { args, said } = edgeArgs(admin, { block: true });
  const done = await ensureEdge(args);
  const stops = admin.calls.filter((/** @type {any} */ c) => c[0] === 'vm.stop' || c[0] === 'vm.delete').map((/** @type {any} */ c) => `${c[0]} ${c[1].id}`);
  assert.deepEqual(stops, ['vm.stop vm-b', 'vm.delete vm-b', 'vm.stop vm-a', 'vm.delete vm-a'], 'never both down at once');
  assert.deepEqual(created(admin).map((c) => c.name_label), [EDGE_HA.second, EDGE.vm]);
  assert.ok(created(admin).every((c) => c.tags.includes(EDGE.blocksTag)));
  assert.deepEqual(passwords(admin), [password, password], 'a new password would leave the new one and the old one deaf to each other');
  assert.ok(said.some((s) => /keep their way out/.test(s)));
  assert.match(done, /rebuilt, one at a time, dropping/);
  // A pair asked nothing new is left alone, and says where each is.
  const still = pairXo([{ ...a, addresses: { '0/ipv4/0': '10.10.10.237' } }, b]);
  const left = await ensureEdge(edgeArgs(still).args);
  assert.deepEqual(methodsOf(still), []);
  assert.match(left, /a pair on eth0\.10 sharing 10\.254\.0\.1, logging[\s\S]*fleetwright-edge at 10\.10\.10\.237, fleetwright-edge-b at an address Xen Orchestra does not know yet/);
});

test('a rebuild of one of the pair that fails starts the old one again, and the other was never touched', async () => {
  const password = 'cd'.repeat(16);
  const a = { id: 'vm-a', name_label: EDGE.vm, $pool: 'p1', tags: [EDGE.tag, EDGE.updatesTag, `${EDGE_HA.nodeTag}0`], power_state: 'Running', xenStoreData: xenStoreAsXo({ [EDGE_HA.passwordKey]: password }) };
  const b = { id: 'vm-b', name_label: EDGE_HA.second, $pool: 'p1', tags: [EDGE.tag, EDGE.updatesTag, `${EDGE_HA.nodeTag}1`], power_state: 'Running', xenStoreData: xenStoreAsXo({ [EDGE_HA.passwordKey]: password }) };
  const admin = xo({ VM: [a, b], 'VM-template': [TEMPLATE], VIF: [] }, { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => { throw new Error('no memory left on the host'); } });
  await assert.rejects(ensureEdge(edgeArgs(admin, { block: true }).args), /no memory left on the host\. fleetwright-edge-b, which it was replacing, was started again/);
  assert.ok(!admin.calls.some((/** @type {any} */ c) => (c[0] === 'vm.stop' || c[0] === 'vm.delete') && c[1].id === 'vm-a'), 'the first carried the machines throughout');
});

test('going back to one removes the second and rebuilds the first on its own', async () => {
  const password = 'ef'.repeat(16);
  const a = { id: 'vm-a', name_label: EDGE.vm, $pool: 'p1', tags: [EDGE.tag, EDGE.updatesTag, `${EDGE_HA.nodeTag}0`], power_state: 'Running', xenStoreData: xenStoreAsXo({ [EDGE_HA.passwordKey]: password }) };
  const b = { id: 'vm-b', name_label: EDGE_HA.second, $pool: 'p1', tags: [EDGE.tag, EDGE.updatesTag, `${EDGE_HA.nodeTag}1`], power_state: 'Running', xenStoreData: xenStoreAsXo({ [EDGE_HA.passwordKey]: password }) };
  const admin = pairXo([a, b]);
  const done = await ensureEdge(edgeArgs(admin, { ha: false }).args);
  const order = admin.calls.filter((/** @type {any} */ c) => ['vm.stop', 'vm.delete', 'vm.create'].includes(c[0])).map((/** @type {any} */ c) => `${c[0]} ${c[1].id ?? c[1].name_label}`);
  assert.deepEqual(order, ['vm.stop vm-b', 'vm.delete vm-b', 'vm.stop vm-a', `vm.create ${EDGE.vm}`, 'vm.delete vm-a']);
  assert.ok(!created(admin)[0].tags.some((/** @type {string} */ x) => x.startsWith(EDGE_HA.nodeTag)), 'one edge, not one of a pair');
  assert.deepEqual(passwords(admin), []);
  assert.match(done, /The edge router is up/);
});

test('a build that fails leaves nothing half-made behind', async () => {
  const admin = xo(
    { VM: [], 'VM-template': [TEMPLATE], VIF: [] },
    {
      'disk.import': () => ({ $sendTo: '/import/abc' }),
      'vm.create': () => {
        throw new Error('no memory left on the host');
      },
    },
  );
  const { args } = edgeArgs(admin);
  await assert.rejects(ensureEdge(args), /no memory left/);
  assert.deepEqual(admin.calls.find(([m]) => m === 'vdi.delete')?.[1], { id: 'vdi-1' });
  // Made, then failing to start: the VM goes, with its disk.
  const later = xo(
    { VM: [], 'VM-template': [TEMPLATE], VIF: [] },
    {
      'disk.import': () => ({ $sendTo: '/import/abc' }),
      'vm.create': () => 'vm-2',
      'vm.start': () => {
        throw new Error('HOST_NOT_ENOUGH_FREE_MEMORY');
      },
    },
  );
  await assert.rejects(ensureEdge(edgeArgs(later).args), /HOST_NOT_ENOUGH_FREE_MEMORY/);
  assert.deepEqual(later.calls.find(([m]) => m === 'vm.delete')?.[1], { id: 'vm-2', deleteDisks: true });
});

test('nothing is downloaded or made without room for the disk or a template to make it from', async () => {
  const full = xo({ VM: [], 'VM-template': [TEMPLATE] });
  const tight = SRS.map((s) => ({ ...s, physical_usage: s.size }));
  await assert.rejects(ensureEdge(edgeArgs(full, { srs: tight }).args), /has 3 GiB free[\s\S]*Choose where its disk goes/);
  // Storage the person chose is held to the way out's pool and to room.
  await assert.rejects(ensureEdge(edgeArgs(full, { sr: 'sr-other-pool' }).args), /not in the way out’s pool/);
  await assert.rejects(ensureEdge(edgeArgs(full, { sr: 'sr-small' }).args), /sr-small has no 3 GiB free/);
  const bare = xo({ VM: [], 'VM-template': [] });
  await assert.rejects(ensureEdge(edgeArgs(bare).args), /no built-in "Other install media" template/);
  for (const admin of [full, bare]) {
    assert.ok(!admin.calls.some(([m]) => m === 'disk.import' || m === 'vm.create'));
  }
});

test('the uplink is made once per pool and the fleet may use it', async () => {
  const fresh = xo({}, { 'network.create': () => 'net-up' });
  const id = await ensureUplink({ admin: fresh, pool: 'p1', networks: [{ id: 'n-x', name_label: 'fleetwright-uplink', $pool: 'p2' }], setId: 'rs-1', inSet: [] });
  assert.equal(id, 'net-up');
  assert.deepEqual(fresh.calls.map(([m, p]) => [m, p.pool ?? p.id, p.name ?? p.object]), [
    ['network.create', 'p1', 'fleetwright-uplink'],
    ['resourceSet.addObject', 'rs-1', 'net-up'],
  ]);
  const there = xo({});
  const again = await ensureUplink({ admin: there, pool: 'p1', networks: [{ id: 'net-up', name_label: 'fleetwright-uplink', $pool: 'p1' }], setId: 'rs-1', inSet: ['net-up'] });
  assert.equal(again, 'net-up');
  assert.deepEqual(there.calls, []);
});

test('group networks are made up to the number asked, once each, never removed, and the fleet may use them', async () => {
  let n = 0;
  const admin = xo({}, { 'network.create': () => `net-g${++n}` });
  const there = [{ id: 'net-g0', name_label: 'fleetwright-group-1', $pool: 'p1' }, { id: 'net-far', name_label: 'fleetwright-group-2', $pool: 'p2' }];
  const made = await ensureGroups({ admin, pool: 'p1', networks: there, setId: 'rs-1', inSet: ['net-g0'], count: 9 });
  assert.deepEqual(made, ['fleetwright-group-2', 'fleetwright-group-3', 'fleetwright-group-4'], 'at most four, and one in another pool is not this pool’s');
  assert.deepEqual(admin.calls.map(([m, p]) => [m, p.name ?? p.object]), [
    ['network.create', 'fleetwright-group-2'],
    ['resourceSet.addObject', 'net-g1'],
    ['network.create', 'fleetwright-group-3'],
    ['resourceSet.addObject', 'net-g2'],
    ['network.create', 'fleetwright-group-4'],
    ['resourceSet.addObject', 'net-g3'],
  ]);
  const fewer = xo({});
  assert.deepEqual(await ensureGroups({ admin: fewer, pool: 'p1', networks: there, setId: 'rs-1', inSet: ['net-g0'], count: 0 }), []);
  assert.deepEqual(fewer.calls, [], 'asking for fewer removes nothing: a machine may be on one');
});

test('the edge router is asked for only with a way out for its WAN', () => {
  const choices = { srs: new Map([['sr1', 100 * GiB]]), networks: new Set(['n1', 'n2']), capacity: { cpus: 8, memory: 32 * GiB } };
  const base = { v: 1, srs: ['sr1'], networks: ['n1', 'n2'], limits: { cpus: 2, memory: 4 * GiB, disk: 20 * GiB } };
  const none = checkPolicy({ ...base, egress: null, edge: true }, choices);
  assert.equal(none.ok, false);
  assert.match(/** @type {any} */ (none).text, /needs a way out/);
  const asked = checkPolicy({ ...base, egress: 'n2', edge: true }, choices);
  assert.equal(asked.ok && asked.policy.edge, true);
  // Anything but `true` is no: an older phone sends nothing and builds nothing.
  const old = checkPolicy({ ...base, egress: 'n2' }, choices);
  assert.equal(old.ok && old.policy.edge, false);
  // Where its disk goes: storage the pool listed, or nothing said.
  const placed = checkPolicy({ ...base, egress: 'n2', edge: true, edgeSr: 'sr1' }, choices);
  assert.equal(placed.ok && placed.policy.edgeSr, 'sr1');
  assert.equal(asked.ok && asked.policy.edgeSr, null);
  const nowhere = checkPolicy({ ...base, egress: 'n2', edge: true, edgeSr: 'sr-x' }, choices);
  assert.equal(nowhere.ok, false);
  assert.match(/** @type {any} */ (nowhere).text, /storage this pool listed/);
  // Block or watch: yes, no, or not said, which leaves an edge that is there
  // as it is; and nothing at all without an edge to say it of.
  for (const [edgeBlock, want] of /** @type {Array<[any, any]>} */ ([[true, true], [false, false], [undefined, null]])) {
    const r = checkPolicy({ ...base, egress: 'n2', edge: true, edgeBlock }, choices);
    assert.equal(r.ok && r.policy.edgeBlock, want, String(edgeBlock));
  }
  const noEdge = checkPolicy({ ...base, egress: 'n2', edgeBlock: true }, choices);
  assert.equal(noEdge.ok && noEdge.policy.edgeBlock, null);
  assert.match(/** @type {any} */ (checkPolicy({ ...base, egress: 'n2', edge: true, edgeBlock: 'yes' }, choices)).text, /yes or no/);
  // Two routers or one, the same way: absent from an older phone, the edge
  // stays as many as it is.
  for (const [edgeHa, want] of /** @type {Array<[any, any]>} */ ([[true, true], [false, false], [undefined, null]])) {
    const r = checkPolicy({ ...base, egress: 'n2', edge: true, edgeHa }, choices);
    assert.equal(r.ok && r.policy.edgeHa, want, String(edgeHa));
  }
  assert.equal(/** @type {any} */ (checkPolicy({ ...base, egress: 'n2', edgeHa: true }, choices)).policy.edgeHa, null, 'not without an edge');
  assert.match(/** @type {any} */ (checkPolicy({ ...base, egress: 'n2', edge: true, edgeHa: 2 }, choices)).text, /is a pair is yes or no/);
  assert.ok(!existsSync('/nowhere'));
});

// WATCHING THE ROUTERS: docs/hypervisors.md, "Watching the edge routers".
// Asked for: "Why is there no live info of opnsense in the app to help
// trouble shoot this?" edge-credentials.test.js holds the parts themselves.

test('a watched router has the key’s user beside root, its certificate at the top, the API on its WAN from private addresses only, and syslog out', () => {
  const w = newWatch();
  const plain = edgeConfig({ labs: [true, false], fleet: fleetHosts('https://fleet.example.network') }).toString('utf8');
  const xml = edgeConfig({ labs: [true, false], fleet: fleetHosts('https://fleet.example.network'), watch: w, syslog: ['192.168.1.20'] }).toString('utf8').trimEnd();
  assert.ok(balanced(xml), 'the file no longer parses');
  assert.ok(!/fleetwright-watch|ssl-certref|<cert |<Syslog/.test(plain), 'a router built without a key has none of it');
  assert.ok(xml.indexOf(`<name>${EDGE_WATCH.user}</name>`) > xml.indexOf('<name>root</name>') && xml.indexOf(`<name>${EDGE_WATCH.user}</name>`) < xml.indexOf('</system>'), 'the user is a system user, after root');
  assert.match(xml, new RegExp(`<webgui><protocol>https</protocol><ssl-certref>${w.refid}</ssl-certref>`));
  assert.ok(xml.indexOf('<cert uuid=') > xml.indexOf('</system>') && xml.indexOf('<cert uuid=') < xml.indexOf('<interfaces>'), 'the certificate is a top-level <cert>');
  assert.ok(xml.indexOf('<Syslog version=') > xml.indexOf('</cron>') && xml.indexOf('<Syslog version=') < xml.indexOf('</OPNsense>'));
  // The one way in, after the inside rules, on the WAN and nowhere else.
  const wan = rulesOf(xml).filter((r) => r[2] === 'wan');
  assert.deepEqual(wan, [[20, 'pass', 'wan', 'wanip', '443', false, false]]);
  assert.match(xml, /<source_net>fleetwright_private<\/source_net><destination_net>wanip<\/destination_net>/);
  // The biggest router there can be still fits the block, watched.
  const long = `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}`;
  assert.equal(edgeConfig({ block: true, labs: [false, false, false, false], fleet: fleetHosts(long), ha: { node: 1, password: 'f'.repeat(64) }, watch: w, syslog: ['10.0.0.1', '10.0.0.2'] }).length, OPNSENSE_IMAGE.grow.room);
});

test('a router without the key the job brings is rebuilt once, keeping its WAN MAC; one with it is left as it is', async () => {
  const w = newWatch();
  const old = { id: 'vm-old', $pool: 'p1', tags: [EDGE.tag, EDGE.updatesTag], power_state: 'Running' };
  const wanVif = { id: 'vif-w', $VM: 'vm-old', device: '0', $network: 'net-wan', MAC: '02:AA:BB:CC:DD:EE' };
  const admin = xo({ VM: [old], 'VM-template': [TEMPLATE], VIF: [wanVif] }, { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => 'vm-new' });
  const { args, said } = edgeArgs(admin, { watch: w, syslog: ['192.168.1.20'] });
  await ensureEdge(args);
  const params = Object.fromEntries(admin.calls);
  assert.ok(said.includes('Rebuilding the edge router so your machines can read how it is: whether it answers names, has its way out, and what it logs. Machines behind it have no way out until it is up.'), said.join('\n'));
  assert.deepEqual(params['vm.create'].VIFs[0], { network: 'net-wan', mac: '02:aa:bb:cc:dd:ee' }, 'the new router is not where the old one was on the way out');
  assert.ok(params['vm.create'].tags.includes(EDGE_WATCH.tag));
  assert.deepEqual(watchOf({ xenStoreData: xenStoreAsXo(params['vm.set'].xenStoreData) }), w, 'the key is not kept where the next rebuild finds it');
  assert.deepEqual(params['vm.delete'], { id: 'vm-old', deleteDisks: true });

  // Built with this key: nothing done. With another (a lost one, a tag and no key): rebuilt.
  const watched = { ...old, tags: [...old.tags, EDGE_WATCH.tag], xenStoreData: xenStoreAsXo({ [EDGE_WATCH.key]: JSON.stringify(w) }) };
  const same = xo({ VM: [watched], VIF: [wanVif] });
  await ensureEdge(edgeArgs(same, { watch: w }).args);
  assert.deepEqual(same.calls.map(([m]) => m).filter((m) => !READS.includes(m)), []);
  const other = xo({ VM: [{ ...watched, xenStoreData: {} }], 'VM-template': [TEMPLATE], VIF: [wanVif] }, { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => 'vm-new' });
  await ensureEdge(edgeArgs(other, { watch: w }).args);
  assert.ok(other.calls.some(([m]) => m === 'vm.create'), 'a router whose key is gone keeps a key the phone was never given');

  // A new router: a MAC of its own, the same for the same pool every time.
  const macOf = async () => {
    const a = xo({ VM: [], 'VM-template': [TEMPLATE], VIF: [] }, { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => 'vm-1' });
    await ensureEdge(edgeArgs(a, { watch: w }).args);
    return Object.fromEntries(a.calls)['vm.create'].VIFs[0].mac;
  };
  const first = await macOf();
  assert.match(first, /^02(:[0-9a-f]{2}){5}$/, 'locally administered and unicast');
  assert.equal(await macOf(), first);
});

// THE TEMPLATE IT IS MADE FROM is the pool's own, by XCP-ng's mark, and
// nothing that only shares its name: a VM inherits its template's disks.
test('the edge router is made from XCP-ng’s own template, never one that only shares its name, and none or two of them is a stop', async () => {
  const named = { id: 'tpl-named', $pool: 'p1', name_label: 'Other install media', isDefaultTemplate: false, $VBDs: [] };
  const withDisk = { id: 'tpl-with-disk', $pool: 'p1', name_label: 'Other install media', isDefaultTemplate: true, $VBDs: ['vbd-planted'] };
  const made = xo({ VM: [], 'VM-template': [named, withDisk, TEMPLATE], VIF: [] }, { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => 'vm-1' });
  await ensureEdge(edgeArgs(made).args);
  assert.deepEqual(called(made, 'vm.create').map((p) => p.template), ['tpl-other'], 'made from a template that only has the name, or brings a disk');

  for (const [templates, said] of /** @type {Array<[any[], RegExp]>} */ ([
    [[named, withDisk], /no built-in "Other install media" template, XCP-ng’s own with no disks, to make the edge router from\. Nothing was built/],
    [[TEMPLATE, { ...TEMPLATE, id: 'tpl-second' }], /2 built-in "Other install media" templates where XCP-ng ships one/],
  ])) {
    const admin = xo({ VM: [], 'VM-template': templates, VIF: [] });
    let downloaded = false;
    await assert.rejects(ensureEdge(edgeArgs(admin, { getImage: async () => ((downloaded = true), '/nowhere/image.bz2') }).args), said);
    assert.equal(downloaded, false, 'downloaded before it knew there was nothing to make the router from');
    assert.deepEqual(called(admin, 'vm.create'), []);
  }
});

// THE KEPT DISK (edge-router.js, buildEdge): the image as published kept on
// the pool, and a rebuild that copies it and writes only the blocks the
// configuration changes. The image here is made up, block by block, with the
// bytes the plan (OPNSENSE_IMAGE.grow) must find where it must find them.

const BLOCK = 2 * 1024 * 1024;
const MiB = 1024 ** 2;
/** The blocks the plan changes: its edits and the block the configuration moves to. */
const TOUCHED = [...new Set([...OPNSENSE_IMAGE.grow.edits.map((e) => e.offset), OPNSENSE_IMAGE.grow.data.offset].map((o) => Math.floor(o / BLOCK)))].sort((a, b) => a - b);
const FILLER = Buffer.alloc(BLOCK, 0x11);

/** Block `i` of the published image, as far as the plan can tell: its own bytes, with what the plan expects where it expects it. */
function pristine(/** @type {number} */ i) {
  const b = Buffer.alloc(BLOCK, (i * 37) & 0xff);
  for (const e of OPNSENSE_IMAGE.grow.edits) if (Math.floor(e.offset / BLOCK) === i) Buffer.from(e.was, 'hex').copy(b, e.offset - i * BLOCK);
  const { data } = OPNSENSE_IMAGE.grow;
  if (Math.floor(data.offset / BLOCK) === i) b.fill(0, data.offset - i * BLOCK, data.offset - i * BLOCK + data.length);
  return b;
}

/** The same block once the edge's configuration is written: each edit's bytes, and the configuration in its block. */
function configured(/** @type {number} */ i, /** @type {Buffer} */ config) {
  const b = pristine(i);
  for (const e of OPNSENSE_IMAGE.grow.edits) if (Math.floor(e.offset / BLOCK) === i) Buffer.from(e.becomes, 'hex').copy(b, e.offset - i * BLOCK);
  const { data } = OPNSENSE_IMAGE.grow;
  if (Math.floor(data.offset / BLOCK) === i) config.copy(b, data.offset - i * BLOCK);
  return b;
}

/** The unpacked image, a block at a time; `wrong` spoils one byte the plan checks. */
function madeUpImage(wrong = false) {
  return Readable.from((function* () {
    for (let i = 0; i < OPNSENSE_IMAGE.rawSize / BLOCK; i++) {
      if (!TOUCHED.includes(i)) {
        yield FILLER;
        continue;
      }
      const b = pristine(i);
      if (wrong && i === TOUCHED.at(-1)) b[OPNSENSE_IMAGE.grow.data.offset - i * BLOCK] = 1;
      yield b;
    }
  })());
}

const BASE_TAG = `${EDGE.baseTag}:${EDGE.baseKey}:${OPNSENSE_IMAGE.release}`;
const BASE_NAME = `OPNsense ${OPNSENSE_IMAGE.release} (as published)`;

/**
 * A stand-in Xen Orchestra that keeps what it is asked to make, as the real
 * one does: VMs and templates with their disks, a VM made from a template
 * getting a copy of each of its disks on the same storage, so a disk kept by
 * one build is there for the next; and its resource sets, the fleet's and
 * the list of what the policy job made (xo-made.js). `kept` starts it with
 * the kept disk on sr-big, on that list; `answers` overrides any call.
 */
function keptXo({ kept = false, answers = /** @type {Record<string, (p: any) => any>} */ ({}), writeInto = async (/** @type {any} */ _w) => {} } = {}) {
  /** @type {Record<string, any[]>} */
  const objects = { VM: [], 'VM-template': [TEMPLATE], VBD: [], VDI: [], VIF: [] };
  /** @type {Array<{ id: string, name: string, objects: string[] }>} */
  const sets = [{ id: 'rs-fleet', name: 'fleetwright', objects: [] }, ...(kept ? [{ id: 'rs-made', name: 'fleetwright-made', objects: ['tpl-kept'] }] : [])];
  let n = 0;
  const next = (/** @type {string} */ p) => `${p}-${++n}`;
  const attach = (/** @type {string} */ vm, /** @type {string} */ vdi) => objects.VBD.push({ id: next('vbd'), VM: vm, VDI: vdi, is_cd_drive: false });
  if (kept) {
    objects['VM-template'].push({ id: 'tpl-kept', $pool: 'p1', name_label: `Fleetwright base: OPNsense ${OPNSENSE_IMAGE.release}`, tags: [EDGE.baseTag, BASE_TAG] });
    objects.VDI.push({ id: 'vdi-kept', $SR: 'sr-big', name_label: BASE_NAME, $VBDs: ['vbd-kept'] });
    attach('tpl-kept', 'vdi-kept');
  }
  /** @type {any} */
  let importing = null;
  const drop = (/** @type {string} */ type, /** @type {string} */ id) => {
    objects[type] = objects[type].filter((o) => o.id !== id);
  };
  const admin = xo(objects, {
    'disk.create': (p) => {
      const id = next('vdi-asked');
      objects.VDI.push({ id, $SR: p.sr, name_label: p.name, $VBDs: [] });
      return id;
    },
    'disk.importContent': (p) => ({ $sendTo: `/content/${p.id}` }),
    'disk.import': (p) => {
      importing = p;
      return { $sendTo: '/import/abc' };
    },
    'vm.create': (p) => {
      const id = next('vm');
      objects.VM.push({ id, $pool: 'p1', name_label: p.name_label, tags: p.tags, power_state: 'Halted' });
      for (const vbd of objects.VBD.filter((b) => b.VM === p.template)) {
        const copy = { ...objects.VDI.find((d) => d.id === vbd.VDI), id: next('vdi-copy') };
        objects.VDI.push(copy);
        attach(id, copy.id);
      }
      return id;
    },
    'vm.attachDisk': (p) => void attach(p.vm, p.vdi),
    'vm.convertToTemplate': (p) => {
      objects['VM-template'].push(...objects.VM.filter((v) => v.id === p.id));
      drop('VM', p.id);
    },
    'vm.delete': (p) => {
      for (const vbd of objects.VBD.filter((b) => b.VM === p.id)) {
        if (p.deleteDisks) drop('VDI', vbd.VDI);
        drop('VBD', vbd.id);
      }
      drop('VM', p.id);
      drop('VM-template', p.id);
    },
    'vdi.delete': (p) => void drop('VDI', p.id),
    'vm.start': (p) => {
      for (const v of objects.VM) if (v.id === p.id) v.power_state = 'Running';
    },
    'resourceSet.getAll': () => sets.map((x) => ({ ...x, objects: [...x.objects] })),
    'resourceSet.create': (p) => void sets.push({ id: next('rs'), name: p.name, objects: [...p.objects] }),
    'resourceSet.addObject': (p) => void sets.find((x) => x.id === p.id)?.objects.push(p.object),
    'resourceSet.removeObject': (p) => {
      const set = sets.find((x) => x.id === p.id);
      if (set) set.objects = set.objects.filter((o) => o !== p.object);
    },
    ...answers,
  });
  /** @type {Array<{ sendTo: string, body: Buffer }>} */
  const writes = [];
  /** @type {any[]} */
  const uploads = [];
  return {
    admin,
    objects,
    sets,
    writes,
    uploads,
    extra: {
      unpackImpl: () => madeUpImage(),
      upload: async (/** @type {any} */ u) => {
        uploads.push({ ...importing, body: u.body });
        const id = next('vdi-up');
        objects.VDI.push({ id, $SR: importing.sr, name_label: importing.name, $VBDs: [] });
        return id;
      },
      writeInto: async (/** @type {any} */ w) => {
        writes.push({ sendTo: w.sendTo, body: w.body });
        await writeInto(w);
      },
    },
  };
}

const called = (/** @type {any} */ admin, /** @type {string} */ m) => admin.calls.filter((/** @type {any} */ c) => c[0] === m).map((/** @type {any} */ c) => c[1]);

test('with the disk kept on the pool, the router is a copy of it with only the blocks its configuration changes written, each whole and checked', async () => {
  const k = keptXo({ kept: true });
  const { args, said, parts } = edgeArgs(k.admin, k.extra);
  const done = await ensureEdge(args);
  assert.deepEqual(called(k.admin, 'disk.import'), [], 'the whole disk was sent');
  assert.deepEqual(called(k.admin, 'disk.create'), [], 'a kept disk that is there was asked about again');
  const [made] = called(k.admin, 'vm.create');
  assert.equal(made.template, 'tpl-kept', 'not made from the kept disk');
  assert.equal(made.VDIs, undefined, 'the kept disk’s copy was not left to come with the VM');
  assert.deepEqual(made.VIFs.map((/** @type {any} */ v) => v.network), ['net-wan', 'net-up']);
  assert.deepEqual(made.tags, [EDGE.tag, EDGE.updatesTag]);
  const copy = k.objects.VBD.find((b) => b.VM === 'vm-2')?.VDI;
  assert.deepEqual(called(k.admin, 'disk.importContent'), [{ id: copy, format: 'vhd' }]);
  assert.deepEqual(k.writes.map((w) => w.sendTo), [`/content/${copy}`]);
  // FIVE BLOCKS, each the published bytes with the change made, and nothing
  // else in the table: what is not listed is left as the copy has it.
  const sent = readVhd(k.writes[0].body);
  assert.equal(sent.size, OPNSENSE_IMAGE.rawSize);
  assert.deepEqual([...sent.blocks.keys()], TOUCHED);
  const config = edgeConfig();
  for (const i of TOUCHED) assert.ok(sent.blocks.get(i)?.equals(configured(i, config)), `block ${i} is not the published one with the configuration written`);
  assert.ok(k.writes[0].body.length < 11 * MiB, `${k.writes[0].body.length} bytes sent`);
  // Named as an uploaded disk is, so the phone can say where it is; never
  // attached again, since it came with the VM.
  assert.deepEqual(called(k.admin, 'vdi.set'), [{ id: copy, name_label: EDGE.vm, name_description: `OPNsense ${OPNSENSE_IMAGE.release}, configured by Fleetwright as the edge router` }]);
  assert.deepEqual(called(k.admin, 'vm.attachDisk'), []);
  assert.deepEqual(called(k.admin, 'vm.start'), [{ id: 'vm-2' }]);
  assert.match(done, /The edge router is up: OPNsense 26\.7, its WAN on eth0\.10[\s\S]*its disk on sr-big\./);
  assert.ok(said.some((t) => /already on sr-big, kept from an earlier build/.test(t)), said.join('\n'));
  assert.ok(said.includes('Copying the disk kept on sr-big and writing the configuration: 10 MB.'), said.join('\n'));
  assert.deepEqual([...new Set(parts.map((p) => p.stage))], [1, 2, 3]);
  for (let i = 1; i < parts.length; i++) assert.ok(parts[i].fill >= parts[i - 1].fill, `the bar went back at ${i}`);
});

test('a copy of the kept disk that comes with two disks has nothing written into either, and the whole disk is sent instead', async () => {
  const k = keptXo({ kept: true });
  // The router is the first VM this build makes; a second disk comes with it.
  k.objects.VDI.push({ id: 'vdi-second', $SR: 'sr-big', name_label: 'second', $VBDs: ['vbd-second'] });
  k.objects.VBD.push({ id: 'vbd-second', VM: 'vm-2', VDI: 'vdi-second', is_cd_drive: false });
  const { args, said } = edgeArgs(k.admin, k.extra);
  assert.match(await ensureEdge(args), /The edge router is up/);
  assert.deepEqual(called(k.admin, 'disk.importContent'), [], 'the configuration was written into one of two disks');
  assert.deepEqual(k.writes, []);
  assert.ok(called(k.admin, 'vm.delete').some((p) => p.id === 'vm-2' && p.deleteDisks), 'the copy with two disks was left');
  assert.deepEqual(k.uploads.map((u) => u.name), [EDGE.vm], 'the whole disk was not sent in its place');
  assert.ok(said.some((t) => /came with 2 disks where it has one/.test(t)), said.join('\n'));
});

test('the first build keeps the image as published, never booted and out of the fleet’s reach, and the next build is a copy of it', async () => {
  const k = keptXo();
  // An older release's, which the new one replaces.
  k.objects['VM-template'].push({ id: 'tpl-older', $pool: 'p1', tags: [EDGE.baseTag, `${EDGE.baseTag}:${EDGE.baseKey}:26.1`] });
  k.sets.push({ id: 'rs-made', name: 'fleetwright-made', objects: ['tpl-older'] });
  const first = edgeArgs(k.admin, k.extra);
  await ensureEdge(first.args);
  // Asked first, on a disk made for the question and removed after.
  const [asked] = called(k.admin, 'disk.create');
  assert.deepEqual(asked, { name: `${EDGE.vm} (checking)`, size: BLOCK, sr: 'sr-big' });
  assert.equal(k.writes[0].sendTo, '/content/vdi-asked-1');
  assert.deepEqual(readVhd(k.writes[0].body).blocks.size, 1);
  assert.ok(called(k.admin, 'vdi.delete').some((p) => p.id === 'vdi-asked-1'), 'the disk the question was asked on was left');
  // THE KEPT DISK: the image unchanged, a template with no network, tagged as
  // a kept disk and not as an image, never started, never in the set.
  assert.deepEqual(k.uploads.map((u) => [u.name, u.body.regions.length]), [[BASE_NAME, 0]]);
  const [kept, router] = called(k.admin, 'vm.create');
  assert.deepEqual(kept.tags, [VM_IMAGE.baseTag, BASE_TAG]);
  assert.ok(!kept.tags.includes(VM_IMAGE.tag), 'a box would offer the kept disk for sessions');
  assert.deepEqual(kept.VIFs, []);
  assert.deepEqual(called(k.admin, 'vm.convertToTemplate'), [{ id: 'vm-3' }]);
  assert.ok(!called(k.admin, 'vm.start').some((p) => p.id === 'vm-3'), 'the kept disk was booted');
  assert.deepEqual(k.sets.find((x) => x.name === 'fleetwright')?.objects, [], 'the fleet’s token could clone the kept disk');
  assert.deepEqual(k.sets.find((x) => x.name === 'fleetwright-made')?.objects, ['vm-3'], 'the kept disk is not on the list of what the job made');
  assert.ok(called(k.admin, 'vm.delete').some((p) => p.id === 'tpl-older' && p.deleteDisks), 'the older release’s kept disk was left');
  // And the router itself, a copy of it with its blocks written.
  assert.equal(router.template, 'vm-3');
  assert.deepEqual([...readVhd(k.writes[1].body).blocks.keys()], TOUCHED);

  // THE NEXT BUILD, a rebuild to block: nothing asked, nothing uploaded.
  const before = k.admin.calls.length;
  const again = edgeArgs(k.admin, { ...k.extra, block: true });
  const done = await ensureEdge(again.args);
  const later = k.admin.calls.slice(before).map((c) => c[0]).filter((m) => !['xo.getAllObjects', 'resourceSet.getAll', 'vif.set'].includes(m));
  assert.deepEqual(later, ['vm.stop', 'vm.create', 'disk.importContent', 'vdi.set', 'vm.start', 'vm.delete']);
  assert.equal(called(k.admin, 'vm.create').at(-1).template, 'vm-3');
  assert.deepEqual(k.uploads.length, 1, 'the second build sent the disk again');
  assert.match(done, /dropped[\s\S]*replaced the one that was there/);
});

// FOUND BY ITS ID (edge-router.js, THE KEPT DISK): a kept disk skips the
// download's digest, so a template that only carries its tag is not one.
test('a kept disk is used only when the job’s own list says it made it, and anything else is passed over for the checked download and left alone', async () => {
  for (const [what, spoil] of /** @type {Array<[string, (k: ReturnType<typeof keptXo>) => void]>} */ ([
    ['carrying the tag and on no list', (k) => void k.sets.splice(1)],
    ['in the fleet’s own set, where its token reaches it', (k) => void k.sets[0].objects.push('tpl-kept')],
    ['made in a resource set, as the fleet’s user makes its VMs', (k) => void (k.objects['VM-template'].find((t) => t.id === 'tpl-kept').resourceSet = 'rs-fleet')],
  ])) {
    const k = keptXo({ kept: true });
    spoil(k);
    // An older release's that is not on the list either: not the build's to remove.
    k.objects['VM-template'].push({ id: 'tpl-older', $pool: 'p1', tags: [EDGE.baseTag, `${EDGE.baseTag}:${EDGE.baseKey}:26.1`] });
    await ensureEdge(edgeArgs(k.admin, k.extra).args);
    const [keptNow, router] = called(k.admin, 'vm.create');
    assert.notEqual(router?.template, 'tpl-kept', `${what}: the router was made from it`);
    assert.deepEqual(k.uploads.map((u) => u.name), [BASE_NAME], `${what}: the published image was not downloaded and kept in its place`);
    assert.deepEqual(keptNow.tags, [EDGE.baseTag, BASE_TAG], what);
    assert.equal(router.template, k.sets.find((x) => x.name === 'fleetwright-made')?.objects.at(-1), `${what}: the router is not made from the disk the job kept and listed`);
    assert.ok(!called(k.admin, 'vm.delete').some((p) => p.id === 'tpl-kept' || p.id === 'tpl-older'), `${what}: removed something the job did not make`);
  }
});

test('where Xen Orchestra cannot write into a disk that is there, the whole disk is sent as before, nothing extra is kept, and the person is told why', async () => {
  const refuse = async () => {
    throw new Error('Xen Orchestra did not write into the disk: undefined == undefined');
  };
  for (const [what, kept, k] of /** @type {Array<[string, boolean, ReturnType<typeof keptXo>]>} */ ([
    ['a copy of the kept disk refused', true, keptXo({ kept: true, writeInto: refuse })],
    ['no disk.importContent at all', true, keptXo({ kept: true, answers: { 'disk.importContent': () => { throw new Error('no such method disk.importContent'); } } })],
    ['the question refused, with nothing kept yet', false, keptXo({ writeInto: refuse })],
  ])) {
    const { args, said } = edgeArgs(k.admin, k.extra);
    const done = await ensureEdge(args);
    assert.match(done, /The edge router is up/, what);
    // The copy, or the disk the question was asked on, removed with its disk.
    const routerVms = k.objects.VM.filter((v) => v.tags?.includes(EDGE.tag));
    assert.equal(routerVms.length, 1, `${what}: ${routerVms.length} edges left for the next run`);
    assert.equal(k.objects.VDI.filter((d) => /^vdi-(copy|asked)/.test(d.id)).length, 0, `${what}: a disk was left behind`);
    // The whole disk, through the patch, as before.
    assert.deepEqual(k.uploads.map((u) => [u.name, u.body.regions.length]), [[EDGE.vm, imagePatches(edgeConfig()).length]], what);
    assert.deepEqual(called(k.admin, 'vm.convertToTemplate'), [], `${what}: kept a disk this Xen Orchestra cannot use`);
    // A kept disk that is there stays, for the Xen Orchestra that is updated.
    assert.equal(k.objects['VM-template'].some((t) => t.id === 'tpl-kept'), kept, `${what}: the kept disk was removed`);
    const told = said.find((t) => t.startsWith('This Xen Orchestra cannot write into a disk'));
    assert.match(String(told), /whole disk is sent[\s\S]*lacks the fix[\s\S]*fleet’s installer/, what);
  }
});

test('a build from the kept disk that fails or is cancelled leaves nothing half-made, and keeps a kept disk that was finished', async () => {
  // Started and failing: the copy goes with its disk; the kept disk stays.
  const start = keptXo({ kept: true, answers: { 'vm.start': () => { throw new Error('HOST_NOT_ENOUGH_FREE_MEMORY'); } } });
  await assert.rejects(ensureEdge(edgeArgs(start.admin, start.extra).args), /HOST_NOT_ENOUGH_FREE_MEMORY/);
  assert.deepEqual(start.objects.VM, []);
  assert.deepEqual(start.objects.VDI.map((d) => d.id), ['vdi-kept']);

  // The kept disk failing to become a template: it goes, and no router is made.
  const convert = keptXo({ answers: { 'vm.convertToTemplate': () => { throw new Error('VM_BAD_POWER_STATE'); } } });
  await assert.rejects(ensureEdge(edgeArgs(convert.admin, convert.extra).args), /VM_BAD_POWER_STATE/);
  assert.deepEqual(convert.objects.VM, []);
  assert.deepEqual(convert.objects.VDI, []);
  assert.equal(called(convert.admin, 'vm.create').length, 1);

  // Cancelled while the kept disk is sent: the part Xen Orchestra kept goes,
  // and nothing falls back to sending the whole disk.
  const controller = new AbortController();
  const cut = keptXo();
  cut.objects.VDI.push({ id: 'vdi-partial', $SR: 'sr-big', name_label: BASE_NAME, $VBDs: [] });
  await assert.rejects(
    ensureEdge(edgeArgs(cut.admin, {
      ...cut.extra,
      signal: controller.signal,
      upload: async () => {
        controller.abort();
        throw new Error('cancelled');
      },
    }).args),
    /cancelled/,
  );
  assert.ok(called(cut.admin, 'vdi.delete').some((p) => p.id === 'vdi-partial'), 'the partial kept disk was left');
  assert.equal(called(cut.admin, 'disk.import').length, 1);

  // Cancelled while the blocks are written: no fallback, the copy goes.
  const late = new AbortController();
  const writing = keptXo({ kept: true, writeInto: async () => { late.abort(); throw new Error('cancelled'); } });
  await assert.rejects(ensureEdge(edgeArgs(writing.admin, { ...writing.extra, signal: late.signal }).args), /abort|cancel/i);
  assert.deepEqual(called(writing.admin, 'disk.import'), []);
  assert.deepEqual(writing.objects.VM, []);

  // An image without the bytes the plan expects: refused before anything on
  // the pool is made.
  const wrong = keptXo({ kept: true });
  await assert.rejects(ensureEdge(edgeArgs(wrong.admin, { ...wrong.extra, unpackImpl: () => madeUpImage(true) }).args), /does not have the free block the configuration moves to where it should/);
  assert.deepEqual(called(wrong.admin, 'vm.create'), []);
});

test('the blocks go to Xen Orchestra as the request body itself, with their length, and only its answer of true counts as written', async (t) => {
  /** @type {Array<{ method: string, url: string, length: string|undefined, body: Buffer }>} */
  const got = [];
  let answer = { status: 200, body: '{"jsonrpc":"2.0","id":0,"result":true}' };
  const server = http.createServer((req, res) => {
    const chunks = /** @type {Buffer[]} */ ([]);
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ method: String(req.method), url: String(req.url), length: req.headers['content-length'], body: Buffer.concat(chunks) });
      res.writeHead(answer.status).end(answer.body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => server.close());
  const address = `127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  const body = Buffer.from('a VHD, as far as this test cares');
  await writeIntoDisk({ address, pin: null, plain: true, sendTo: '/api/abc', body });
  assert.deepEqual(got, [{ method: 'POST', url: '/api/abc', length: String(body.length), body }]);
  // XAPI's refusal, as Xen Orchestra without the fix passes it on.
  answer = { status: 500, body: '{"jsonrpc":"2.0","id":0,"error":{"code":-32000,"message":"undefined == undefined"}}' };
  await assert.rejects(writeIntoDisk({ address, pin: null, plain: true, sendTo: '/api/abc', body }), /did not write into the disk: undefined == undefined/);
  // Anything but true is not written, whatever the status.
  answer = { status: 200, body: '{"jsonrpc":"2.0","id":0,"result":"vdi-1"}' };
  await assert.rejects(writeIntoDisk({ address, pin: null, plain: true, sendTo: '/api/abc', body }), /did not write into the disk: HTTP 200/);
});
