// THE EDGE ROUTER ON PROXMOX VE (docs/proxmox.md, "The edge router"), as the
// setup script makes it: the same image a Xen Orchestra pool's edge is built
// from, the same configuration built from the boxes' own code, and the same
// edits that move it into the image, each held to the JavaScript here.
//
//   node --test test/pve-edge.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, writeFileSync, writeSync, ftruncateSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EDGE_IMAGE, EDGE_FILTER, PVE_EDGE, edgeConfig, pveEdgeConfig } from '../src/fleet/host/edge-router.js';
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
  // The same router a Xen Orchestra pool has, but for the interface names and the guest agent.
  const xen = edgeConfig({}).toString('utf8').replace(/xn0/g, 'vtnet0').replace(/xn1/g, 'vtnet1').replace('os-xen', 'os-qemu-guest-agent');
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
  assert.match(SCRIPT, /pveum acl modify "\/vms\/\$eid" --users "\$USER_ID" --roles FleetwrightHolder/);
  assert.match(SCRIPT, /--net0 "virtio,bridge=\$BRIDGE" --net1 "virtio,bridge=fwedge"/);
  assert.equal(spawnSync('bash', ['-n', new URL('../install/fleetwright-pve-setup', import.meta.url).pathname]).status, 0);
});
