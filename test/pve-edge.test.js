// THE EDGE ROUTER ON PROXMOX VE (docs/proxmox.md, "The edge router"), as the
// setup script makes it: the same image a Xen Orchestra pool's edge is built
// from, the same configuration built from the boxes' own code, and the same
// edits that move it into the image, each held to the JavaScript here.
//
//   node --test test/pve-edge.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, statSync, writeFileSync, writeSync, ftruncateSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EDGE_IMAGE, EDGE_FILTER, PVE_EDGE, PVE_WATCH_MARKS, edgeConfig, pveEdgeConfig } from '../src/fleet/host/edge-router.js';
import { newWatch } from '../src/fleet/host/edge-credentials.js';
import { PvePools, edgeKeyOf, pveRecord } from '../src/fleet/host/pve-pools.js';
import { Pools } from '../src/fleet/host/pools.js';
import { EdgeWatch } from '../src/fleet/host/edge-watch.js';
import * as pveSetup from '../src/fleet/host/pve-setup.js';

const SCRIPT = readFileSync(new URL('../install/fleetwright-pve-setup', import.meta.url), 'utf8');
const pin = (/** @type {string} */ name) => new RegExp(`^${name}="?([^"\\n]*)"?$`, 'm').exec(SCRIPT)?.[1];
const sha = (/** @type {Buffer} */ b) => createHash('sha256').update(b).digest('hex');

test('the configurations beside the script are the boxes’ own, for virtio, and pinned by the script', () => {
  for (const [file, block, name] of /** @type {Array<[string, boolean, string]>} */ ([['fleetwright-pve-edge.xml', false, 'EDGE_CONFIG_SHA'], ['fleetwright-pve-edge-block.xml', true, 'EDGE_CONFIG_BLOCK_SHA']])) {
    const kept = readFileSync(new URL(`../install/${file}`, import.meta.url));
    assert.ok(kept.equals(pveEdgeConfig(block)), `${file} is not what scripts/build-pve-edge.mjs builds: run it`);
    assert.equal(pin(name), sha(kept), `the script pins another ${file}`);
    assert.equal(kept.length, EDGE_IMAGE.grow.room);
    const xml = kept.toString('utf8');
    assert.match(xml, new RegExp(`<if>${PVE_EDGE.wanIf}</if>`));
    assert.match(xml, new RegExp(`<if>${PVE_EDGE.lanIf}</if>`));
    assert.match(xml, /<plugins>os-qemu-guest-agent<\/plugins>/);
    assert.equal(xml.includes(`<divert-to>${EDGE_FILTER.divertPort}</divert-to>`), block, 'drops only when asked to');
  }
  // The same router a Xen Orchestra pool has, but for the interface names,
  // the guest agent, and the watch's parts as marks the node fills in.
  const xen = edgeConfig({ marks: PVE_WATCH_MARKS }).toString('utf8').replace(/xn0/g, 'vtnet0').replace(/xn1/g, 'vtnet1').replace('os-xen', 'os-qemu-guest-agent');
  assert.equal(pveEdgeConfig(false).toString('utf8').trimEnd(), xen.trimEnd());
});

test('the script pins the image the boxes do, and moves the configuration in with the same edits', () => {
  assert.equal(pin('EDGE_URL'), EDGE_IMAGE.url);
  assert.equal(pin('EDGE_SUM'), EDGE_IMAGE.sha256);
  assert.equal(Number(pin('EDGE_PACKED')), EDGE_IMAGE.compressedSize);
  assert.equal(Number(pin('EDGE_RAW')), EDGE_IMAGE.rawSize);
  assert.equal(Number(pin('EDGE_ROOM')), EDGE_IMAGE.grow.room);
  assert.equal(Number(pin('EDGE_DATA')), EDGE_IMAGE.grow.data.offset);
  assert.equal(pin('EDGE_EDITS'), EDGE_IMAGE.grow.edits.map((e) => `${e.offset}:${e.was}:${e.becomes}`).join(' '));
});

test('the script’s writer, run on a stand-in image, writes what the boxes write and refuses an image that is not the one', () => {
  const perl = /EDGE_EDITS="\$EDGE_EDITS" ROOM="\$EDGE_ROOM" DATA="\$EDGE_DATA" perl -e '([\s\S]*?)' "\$work\/edge\.raw"/.exec(SCRIPT)?.[1];
  assert.ok(perl, 'the script has no writer');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pve-edge-'));
  const img = path.join(dir, 'edge.raw');
  const cfg = path.join(dir, 'config.xml');
  const end = EDGE_IMAGE.grow.data.offset + EDGE_IMAGE.grow.room + 4096;
  const stage = () => {
    const fd = openSync(img, 'w');
    ftruncateSync(fd, Math.max(end, ...EDGE_IMAGE.grow.edits.map((e) => e.offset + 64)));
    for (const e of EDGE_IMAGE.grow.edits) writeSync(fd, Buffer.from(e.was, 'hex'), 0, e.was.length / 2, e.offset);
    closeSync(fd);
  };
  stage();
  writeFileSync(cfg, pveEdgeConfig(true));
  const env = { ...process.env, EDGE_EDITS: pin('EDGE_EDITS'), ROOM: String(EDGE_IMAGE.grow.room), DATA: String(EDGE_IMAGE.grow.data.offset) };
  const ran = spawnSync('perl', ['-e', perl, img, cfg], { env, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  const fd = openSync(img, 'r');
  const at = (/** @type {number} */ offset, /** @type {number} */ n) => {
    const b = Buffer.alloc(n);
    readSync(fd, b, 0, n, offset);
    return b;
  };
  for (const e of EDGE_IMAGE.grow.edits) assert.equal(at(e.offset, e.becomes.length / 2).toString('hex'), e.becomes, e.what);
  assert.ok(at(EDGE_IMAGE.grow.data.offset, EDGE_IMAGE.grow.room).equals(pveEdgeConfig(true)));
  closeSync(fd);
  // RUN AGAIN on what it wrote, it refuses: the bytes are no longer the image's.
  assert.notEqual(spawnSync('perl', ['-e', perl, img, cfg], { env, encoding: 'utf8' }).status, 0);
  // AND A CONFIGURATION OF ANOTHER LENGTH is refused before anything is written.
  stage();
  writeFileSync(cfg, 'short');
  const short = spawnSync('perl', ['-e', perl, img, cfg], { env, encoding: 'utf8' });
  assert.notEqual(short.status, 0);
  assert.match(short.stderr, /not 32768 bytes/);
});

test('the edge options become the script’s flags, and the script reads every one', () => {
  assert.deepEqual(pveSetup.pveOptionsOf({ edge: true, edgeBlock: true, edgeAgain: true }).options, { edge: true, edgeBlock: true, edgeAgain: true });
  assert.match(pveSetup.pveOptionsOf({ edgeBlock: true }).problem ?? '', /only while it is asked for/);
  assert.equal(pveSetup.optionArgs({ edge: true }), ' --edge');
  assert.equal(pveSetup.optionArgs({ edge: true, edgeBlock: true, edgeAgain: true }), ' --edge-block --edge-again');
  for (const flag of ['--edge', '--edge-block', '--edge-again']) assert.ok(SCRIPT.includes(`    ${flag})`), `the script does not read ${flag}`);
  assert.match(SCRIPT, /^step edge$/m);
  // AN EDGE THAT CANNOT BE BUILT costs the cluster its edge, not its setup:
  // every failure in the build is said and returns, and the token's line
  // still comes at the end.
  const build = /^build_edge\(\) \{\n([\s\S]*?)\n\}$/m.exec(SCRIPT)?.[1] ?? '';
  assert.ok(build, 'the script has no build_edge');
  assert.doesNotMatch(build.replace(/perl -e '[\s\S]*?' "\$work/, ''), /\bdie "/, 'a failed edge build ends the whole setup');
  assert.match(SCRIPT, /^    build_edge \|\| true$/m);
  // Outside the pool, seen by the token on it alone, its LAN the network machines go on.
  assert.match(SCRIPT, /vnet fwedge fwedge "fleetwright-edge-uplink"/);
  // Seen, and where its guest agent says it is, on it alone.
  assert.match(SCRIPT, /role FleetwrightEdge "VM\.Audit VM\.GuestAgent\.Audit"/);
  assert.match(SCRIPT, /pveum acl modify "\/vms\/\$eid" --users "\$USER_ID" --roles FleetwrightEdge/);
  assert.match(SCRIPT, /--net0 "virtio,bridge=\$BRIDGE" --net1 "virtio,bridge=fwedge"/);
  assert.equal(spawnSync('bash', ['-n', new URL('../install/fleetwright-pve-setup', import.meta.url).pathname]).status, 0);
});

/** One of the script's functions, by name, as bash defines it. @param {string} name */
const fn = (name) => {
  const body = new RegExp(`^${name}\\(\\) \\{[^\\n]*\\n([\\s\\S]*?)\\n\\}$`, 'm').exec(SCRIPT)?.[0];
  assert.ok(body, `the script has no ${name}`);
  return body;
};

test('the node fills in the watch where its marks are, as the boxes write it, byte for byte', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pve-watch-'));
  const watch = newWatch();
  const file = path.join(dir, 'watch.json');
  writeFileSync(file, JSON.stringify(watch));
  for (const [block, ip] of /** @type {Array<[boolean, string]>} */ ([[false, '192.168.1.40'], [true, '10.69.10.51'], [false, '']])) {
    const cfg = path.join(dir, 'config.xml');
    writeFileSync(cfg, pveEdgeConfig(block));
    const ran = spawnSync('bash', ['-c', `set -euo pipefail\nEDGE_ROOM=${EDGE_IMAGE.grow.room}\n${fn('edge_fill')}\nedge_fill "$1" "$2" "$3"`, 'fill', cfg, file, ip], { encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    const want = edgeConfig({ ...PVE_EDGE, block, watch, syslog: ip ? [ip] : [] });
    const got = readFileSync(cfg);
    assert.equal(got.length, EDGE_IMAGE.grow.room);
    assert.equal(got.toString('utf8'), want.toString('utf8'), `the node's ${block ? 'dropping' : 'filtering'} router ${ip ? `sending its logs to ${ip}` : 'with nowhere to log'} is not the boxes'`);
  }
  // A configuration without its marks is refused, never written half-way.
  const plain = path.join(dir, 'plain.xml');
  writeFileSync(plain, edgeConfig({ ...PVE_EDGE }));
  const refused = spawnSync('bash', ['-c', `set -euo pipefail\nEDGE_ROOM=${EDGE_IMAGE.grow.room}\n${fn('edge_fill')}\nedge_fill "$1" "$2" ""`, 'fill', plain, file], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /does not have its mark once/);
});

test('the node makes the key once, in the shape the boxes take, and keeps it', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pve-keep-'));
  const file = path.join(dir, 'watch.json');
  const keep = () => spawnSync('bash', ['-c', `set -euo pipefail\nEDGE_WATCH_FILE="$1"\n${fn('watch_keep')}\nwatch_keep`, 'keep', file], { encoding: 'utf8' });
  const ran = keep();
  assert.equal(ran.status, 0, ran.stderr);
  const w = JSON.parse(readFileSync(file, 'utf8'));
  // What the line carries is a key a box takes.
  assert.deepEqual(edgeKeyOf({ key: w.key, secret: w.secret, pin: w.pin }), { key: w.key, secret: w.secret, pin: w.pin });
  assert.notEqual(w.key, w.secret);
  assert.match(w.salt, /^[./0-9A-Za-z]{16}$/);
  assert.match(w.refid, /^[0-9a-f]{13}$/);
  assert.match(w.prv, /^-----BEGIN PRIVATE KEY-----\n/);
  // The pin is the certificate's, which is what the box holds the router to.
  const x509 = new X509Certificate(w.crt);
  assert.equal(w.pin, createHash('sha256').update(x509.raw).digest('hex'));
  assert.match(x509.subject, /CN=fleetwright-edge/);
  assert.equal(x509.publicKey.asymmetricKeyDetails?.namedCurve, 'prime256v1');
  // ONLY ROOT READS IT, and running again keeps it: a router made again has the same key.
  assert.equal(statSync(file).mode & 0o077, 0);
  assert.equal(keep().status, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), w);
});

test('an edge without the key is made again once, and the line carries the key of one with it', () => {
  assert.match(SCRIPT, /\[ "\$ewatched" = 1 \]; then/);
  assert.match(SCRIPT, /etags="\$EDGE_TAG;\$EDGE_WATCH_TAG"/);
  assert.match(SCRIPT, /\$r\{edge\} = \{ key => \$j->\{key\}, secret => \$j->\{secret\}, pin => \$j->\{pin\} \};/);
  // The cluster's own machine first, so the router knows where to send its logs.
  assert.ok(SCRIPT.indexOf('\nstep holder\n') < SCRIPT.indexOf('\nstep edge\n'));
});

const RECORD = { kind: 'proxmox', address: '10.69.10.10:8006', token: 'fleetwright@pve!fleet=12345678-1234-1234-1234-123456789abc', pool: 'fleetwright', ca: `-----BEGIN CERTIFICATE-----\n${'A'.repeat(64)}\n${'A'.repeat(64)}\n-----END CERTIFICATE-----\n` };

test('the record keeps the router’s key the line carried, and passes over one that is not one', () => {
  const edge = { key: 'k'.repeat(78) + '+/', secret: 's'.repeat(80), pin: 'a'.repeat(64) };
  assert.deepEqual(pveRecord(`hypervisor:${RECORD.address}`, JSON.stringify({ ...RECORD, edge }))?.edge, edge);
  // A key that is not one costs the router its watch, never the cluster.
  for (const bad of [{ ...edge, key: 'short' }, { ...edge, secret: `${'s'.repeat(79)}|` }, { ...edge, pin: 'A'.repeat(64) }, 'edge', null]) {
    const r = pveRecord(`hypervisor:${RECORD.address}`, JSON.stringify({ ...RECORD, edge: bad }));
    assert.ok(r, 'a bad key cost the cluster');
    assert.equal(r.edge, undefined);
  }
});

test('a box finds the router where its guest agent says, on its WAN, through the cluster’s API', async () => {
  const asked = /** @type {string[]} */ ([]);
  let resources = [
    { type: 'qemu', vmid: 120, node: 'pve1', status: 'running', pool: '', tags: 'fleetwright-edge;fleetwright-edge-watch' },
    { type: 'qemu', vmid: 130, node: 'pve1', status: 'running', pool: 'fleetwright', tags: 'fleetwright-edge' },
  ];
  const api = {
    async get(/** @type {string} */ p) {
      asked.push(p);
      if (p === '/cluster/resources') return resources;
      if (p === '/nodes/pve1/qemu/120/config') return { net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0', net1: 'virtio=BC:24:11:00:00:02,bridge=fwedge' };
      if (p === '/nodes/pve1/qemu/120/agent/network-get-interfaces')
        return {
          result: [
            { name: 'vtnet1', 'hardware-address': 'bc:24:11:00:00:02', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '10.254.0.1' }] },
            { name: 'vtnet0', 'hardware-address': 'bc:24:11:00:00:01', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '10.69.10.61' }] },
          ],
        };
      throw new Error(`unexpected ${p}`);
    },
  };
  const pve = new PvePools({ api: () => api });
  const key = `me@example.com ${RECORD.address}`;
  pve.held.set(key, { owner: 'me@example.com', record: /** @type {any} */ (pveRecord(`hypervisor:${RECORD.address}`, JSON.stringify(RECORD))) });
  const pools = new Pools({ pve });
  assert.equal(pools.kindOf(key), 'proxmox');
  assert.equal(pools.kindOf('me@example.com xo.lan'), 'xo');
  // The WAN's, not the LAN's, and never one inside the fleet's pool.
  assert.deepEqual([...(/** @type {Map<string, string>} */ (await pools.edgeAddresses(key)))], [['fleetwright-edge', '10.69.10.61']]);
  assert.ok(!asked.some((p) => p.includes('/130/')));
  // Stopped is none yet; unasked is null, said apart.
  resources = [{ ...resources[0], status: 'stopped' }];
  assert.equal((await pools.edgeAddresses(key))?.size, 0);
  api.get = async () => {
    throw new Error('down');
  };
  assert.equal(await pools.edgeAddresses(key), null);
  // What the box saw of a cluster is read for whether it reached it.
  pve.seen.set(key, { reachable: true });
  assert.equal(pools.seen.get(key)?.reachable, true);
});

test('a router the box cannot read says so in Proxmox VE’s words, never Xen Orchestra’s', async () => {
  const key = `me@example.com ${RECORD.address}`;
  const record = { ...RECORD, edge: { key: 'k'.repeat(80), secret: 's'.repeat(80), pin: 'a'.repeat(64) } };
  const said = (/** @type {boolean|null} */ reachable, /** @type {Map<string, string>|null} */ where) =>
    new EdgeWatch({
      pools: { held: new Map([[key, { owner: 'me@example.com', record }]]), seen: new Map([[key, { reachable }]]), kindOf: () => 'proxmox', edgeAddresses: async () => where },
      createSocket: () => /** @type {any} */ ({ on() {}, bind() {}, close() {} }),
      connect: async () => {
        throw new Error('refused');
      },
    });
  for (const [reachable, where, words] of /** @type {Array<[boolean|null, Map<string, string>|null, RegExp]>} */ ([
    [false, null, /cannot reach the cluster’s Proxmox VE/],
    [null, null, /has not reached the cluster’s Proxmox VE/],
    [true, new Map(), /Proxmox VE has no address for it yet/],
    [true, null, /Proxmox VE could not be asked where it is/],
  ])) {
    const w = said(reachable, where);
    await w.poll();
    // Its one router, by the name its syslog and the setup give it.
    const r = w.reportFor('me@example.com', RECORD.address)?.routers ?? [];
    assert.deepEqual(r.map((x) => x.name), ['fleetwright-edge']);
    assert.equal(r[0].reached, null, 'cannot tell, never down');
    assert.match(String(r[0].problem), words);
    assert.doesNotMatch(String(r[0].problem), /Xen Orchestra/);
    w.stop();
  }
  // Read when it is there: the key goes only to the router's pinned certificate.
  const pins = /** @type {string[]} */ ([]);
  const w = new EdgeWatch({
    pools: { held: new Map([[key, { owner: 'me@example.com', record }]]), seen: new Map([[key, { reachable: true }]]), kindOf: () => 'proxmox', edgeAddresses: async () => new Map([['fleetwright-edge', '10.69.10.61']]) },
    createSocket: () => /** @type {any} */ ({ on() {}, bind() {}, close() {} }),
    connect: async (/** @type {any} */ o) => {
      pins.push(`${o.host} ${o.pin}`);
      throw new Error('certificate did not match');
    },
  });
  await w.poll();
  assert.deepEqual(pins, [`10.69.10.61 ${'a'.repeat(64)}`]);
  assert.equal(w.reportFor('me@example.com', RECORD.address)?.routers[0].reached, false);
  w.stop();
});
