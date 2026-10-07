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
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { ConfigPatch, EDGE, EDGE_FILTER, LAB, NOT_FROM_LABS, OPNSENSE_IMAGE, edgeConfig, ensureEdge, ensureGroups, ensureLabs, ensureUplink, fetchImage, fleetHosts, imagePatches, isDefaultConfig } from '../src/fleet/host/edge-router.js';
import { REQUIRED_HOSTS } from '../src/core/egress.js';
import { checkPolicy } from '../src/fleet/host/xo-setup.js';

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

test('the edge configuration fits exactly where the default was, and says what the edge is', () => {
  const config = edgeConfig();
  assert.equal(config.length, OPNSENSE_IMAGE.config.length, 'not the length of the file it replaces');
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
  const replacement = edgeConfig();
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
  const replacement = edgeConfig();
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

const GiB = 1024 ** 3;
const SRS = [
  { id: 'sr-small', $pool: 'p1', size: 4 * GiB, physical_usage: 2 * GiB },
  { id: 'sr-big', $pool: 'p1', size: 500 * GiB, physical_usage: 100 * GiB },
  { id: 'sr-other-pool', $pool: 'p2', size: 900 * GiB, physical_usage: 0 },
];
const TEMPLATE = { id: 'tpl-other', $pool: 'p1', name_label: 'Other install media' };

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
  assert.equal(block.length, OPNSENSE_IMAGE.config.length, 'blocking no longer fits the file it replaces');
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

// --- labs on the edge ---------------------------------------------------------
//
// docs/hypervisors.md, "Labs". The rules below were read back with `pfctl -sr`
// from this configuration booted in QEMU, four labs, two closed, blocking: one
// pf rule per interface of each, in this order.

/** Each rule as [sequence, action, interfaces, destination, port, divert, log]. @param {string} xml */
const rulesOf = (xml) =>
  [...xml.matchAll(/<rule>.*?<\/rule>/g)].map((m) => {
    const r = m[0];
    const get = (/** @type {string} */ tag) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(r)?.[1] ?? null;
    return [Number(get('sequence')), get('action'), get('interface'), get('destination_net'), get('destination_port'), r.includes('<divert-to>'), get('log') === '1'];
  });

test('each lab is an interface of its own on the edge, with its address, its DHCP and Suricata watching it', () => {
  const xml = edgeConfig({ labs: [true, false], fleet: fleetHosts('https://fleet.example.network/x') }).toString('utf8');
  assert.equal(Buffer.byteLength(xml), OPNSENSE_IMAGE.room, 'not the room the file’s own blocks give it');
  assert.ok(balanced(xml.trimEnd()));
  assert.ok(xml.includes('<opt1><enable>1</enable><if>xn2</if><descr>LAB1</descr><ipaddr>10.250.1.1</ipaddr><subnet>24</subnet></opt1>'));
  assert.ok(xml.includes('<opt2><enable>1</enable><if>xn3</if><descr>LAB2</descr><ipaddr>10.250.2.1</ipaddr><subnet>24</subnet></opt2>'));
  assert.ok(!xml.includes('<opt3>'));
  assert.match(xml, /<dnsmasq><enable>1<\/enable><port>53053<\/port><interface>lan,opt1,opt2<\/interface>/);
  assert.ok(xml.includes('<dhcp_ranges><interface>opt2</interface><start_addr>10.250.2.100</start_addr><end_addr>10.250.2.250</end_addr></dhcp_ranges>'));
  assert.match(xml, /<interfaces>lan,opt1,opt2<\/interfaces><homenet>10\.254\.0\.0\/24,10\.250\.1\.0\/24,10\.250\.2\.0\/24<\/homenet>/);
  // Every lab between 1 and the most there is room for fits, either kind, either mode.
  for (const block of [false, true]) for (const kinds of [[true, true, true, true], [false, false, false, false], [true, false, true, false]]) {
    assert.equal(edgeConfig({ block, labs: kinds, fleet: fleetHosts('https://fleet.example.network') }).length, OPNSENSE_IMAGE.room);
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

test('an edge with labs grows its configuration into the file’s own blocks, after checking both the size and the slack', async () => {
  const { config, room, sizeField } = OPNSENSE_IMAGE;
  const replacement = edgeConfig({ labs: [true] });
  const patches = imagePatches(replacement);
  assert.deepEqual(patches.map((p) => [p.offset, p.replacement.length]), [[sizeField.offset, 8], [config.offset, room]]);
  // A small image with both regions where the real one has them, scaled down.
  const total = 40_000;
  const at = { size: 1_000, config: 10_000 };
  const regions = patches.map((p, i) => ({ ...p, offset: i === 0 ? at.size : at.config }));
  const img = (/** @type {number} */ size, /** @type {number} */ slackByte) => {
    const buf = Buffer.alloc(total, 7);
    buf.writeBigUInt64LE(BigInt(size), at.size);
    DEFAULT.copy(buf, at.config);
    buf.fill(slackByte, at.config + config.length, at.config + room);
    return buf;
  };
  const out = await patch(img(sizeField.was, 0), 333, { regions, total });
  assert.ok(Buffer.isBuffer(out), String(out));
  assert.equal(out.readBigUInt64LE(at.size), BigInt(room), 'the inode does not say the file is the room’s length');
  assert.ok(out.subarray(at.config, at.config + room).equals(replacement));
  assert.ok(out.subarray(0, at.size).equals(img(sizeField.was, 0).subarray(0, at.size)), 'a byte outside the two regions changed');
  assert.match(String(await patch(img(4096, 0), 333, { regions, total })), /does not have the configuration’s size where it should/);
  assert.match(String(await patch(img(sizeField.was, 1), 333, { regions, total })), /does not have the default configuration where it should/);
  assert.throws(() => imagePatches(Buffer.alloc(6000)), /5234 or 8192 bytes/);
});

test('an edge is built with an interface on each lab, in order, and tagged with them; one with other labs is rebuilt, filtering as it did', async () => {
  const fleet = fleetHosts('https://fleet.example.network');
  const labs = [{ id: 'net-lab-1', open: true }, { id: 'net-lab-2', open: false }];
  const fresh = xo({ VM: [], 'VM-template': [TEMPLATE], VIF: [] }, { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => 'vm-1' });
  /** @type {any} */
  let body = null;
  const done = await ensureEdge(edgeArgs(fresh, { labs, fleet, upload: async (/** @type {any} */ u) => ((body = u.body), 'vdi-1') }).args);
  const made = Object.fromEntries(fresh.calls)['vm.create'];
  assert.deepEqual(made.VIFs, [{ network: 'net-wan' }, { network: 'net-up' }, { network: 'net-lab-1' }, { network: 'net-lab-2' }]);
  assert.deepEqual(made.tags, [EDGE.tag, `${LAB.edgeTag}oc`]);
  assert.equal(body.regions.length, 2, 'the file was not grown to hold the labs');
  assert.match(done, /It has one open lab and one closed lab of their own/);

  // There with the same labs: nothing done. Asked nothing of labs: nothing done.
  const old = { id: 'vm-old', $pool: 'p1', tags: [EDGE.tag, EDGE.blocksTag, `${LAB.edgeTag}oc`], power_state: 'Running' };
  const onLabs = [{ id: 'v2', $VM: 'vm-old', device: '2', $network: 'net-lab-1' }, { id: 'v3', $VM: 'vm-old', device: '3', $network: 'net-lab-2' }];
  for (const ask of [labs, null]) {
    const same = xo({ VM: [old], VIF: onLabs });
    const said = await ensureEdge(edgeArgs(same, { labs: ask, fleet }).args);
    assert.deepEqual(same.calls.map(([m]) => m).filter((m) => m !== 'xo.getAllObjects'), []);
    assert.match(said, /already there[\s\S]*with one open lab and one closed lab/);
  }
  // Other labs: rebuilt, still dropping, as nobody asked to change that.
  const rebuilt = xo({ VM: [old], 'VM-template': [TEMPLATE], VIF: [] }, { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => 'vm-new' });
  const { args, said } = edgeArgs(rebuilt, { labs: [{ id: 'net-lab-1', open: true }], fleet });
  await ensureEdge(args);
  const params = Object.fromEntries(rebuilt.calls);
  assert.deepEqual(params['vm.create'].tags, [EDGE.tag, EDGE.blocksTag, `${LAB.edgeTag}o`]);
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
  const methods = admin.calls.map(([m]) => m).filter((m) => m !== 'xo.getAllObjects');
  assert.deepEqual(methods, ['disk.import', 'vm.create', 'vm.attachDisk', 'vif.set', 'vif.set', 'vm.start']);
  const params = Object.fromEntries(admin.calls);
  // On the chosen storage in this pool with the most room.
  assert.equal(params['disk.import'].sr, 'sr-big');
  assert.equal(params['disk.import'].type, 'iso');
  const made = params['vm.create'];
  assert.equal(made.template, 'tpl-other');
  assert.deepEqual(made.VIFs, [{ network: 'net-wan' }, { network: 'net-up' }]);
  assert.deepEqual(made.VDIs, []);
  assert.deepEqual(made.tags, [EDGE.tag]);
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
    VM: [{ id: 'vm-old', $pool: 'p1', tags: [EDGE.tag], power_state: 'Halted' }],
    VIF: [{ id: 'vif-w', $VM: 'vm-old', device: '0', $network: 'net-before' }],
  });
  const { args } = edgeArgs(admin);
  const done = await ensureEdge(args);
  const methods = admin.calls.map(([m]) => m).filter((m) => m !== 'xo.getAllObjects');
  assert.deepEqual(methods, ['vif.set', 'vm.start']);
  assert.deepEqual(admin.calls.find(([m]) => m === 'vif.set')?.[1], { id: 'vif-w', network: 'net-wan' });
  assert.match(done, /already there[\s\S]*WAN moved to eth0\.10[\s\S]*was started/);
});

test('an edge built the other way is rebuilt: the old one stopped, the new one built and tagged, and only then the old one removed', async () => {
  const old = { id: 'vm-old', $pool: 'p1', tags: [EDGE.tag], power_state: 'Running' };
  const admin = xo(
    { VM: [old], 'VM-template': [TEMPLATE], VIF: [] },
    { 'disk.import': () => ({ $sendTo: '/import/abc' }), 'vm.create': () => 'vm-new' },
  );
  let told = 0;
  const { args } = edgeArgs(admin, { block: true, rebuilding: () => told++ });
  const done = await ensureEdge(args);
  assert.equal(told, 1, 'the job is not told it is rebuilding');
  const methods = admin.calls.map(([m]) => m).filter((m) => m !== 'xo.getAllObjects' && m !== 'vif.set');
  assert.deepEqual(methods, ['vm.stop', 'disk.import', 'vm.create', 'vm.attachDisk', 'vm.start', 'vm.delete']);
  const params = Object.fromEntries(admin.calls);
  assert.deepEqual(params['vm.stop'], { id: 'vm-old', force: true });
  assert.deepEqual(params['vm.create'].tags, [EDGE.tag, EDGE.blocksTag]);
  assert.deepEqual(params['vm.delete'], { id: 'vm-old', deleteDisks: true });
  assert.match(done, /dropped[\s\S]*replaced the one that was there/);
});

test('a rebuild that fails leaves the old edge running as it was, and an edge asked nothing of is left alone', async () => {
  const old = { id: 'vm-old', $pool: 'p1', tags: [EDGE.tag, EDGE.blocksTag], power_state: 'Running' };
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
    assert.deepEqual(there.calls.map(([m]) => m).filter((m) => m !== 'xo.getAllObjects'), [], String(block));
    assert.match(said, /already there[\s\S]*dropping what its threat rules match/);
  }
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
  await assert.rejects(ensureEdge(edgeArgs(bare).args), /no "Other install media" template/);
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
  assert.ok(!existsSync('/nowhere'));
});
