// The VHD the edge router's rebuild writes into a copy of its kept disk
// (src/fleet/host/vhd.js), read back two ways that are not the writer: by
// the specification, field by field, here; and by qemu-img, when it is
// installed, as the raw disk it holds.
//
//   node --test test/vhd.test.js
//
// What is guarded is what XAPI's vhd-tool refuses or gets wrong: a cookie,
// a version or a checksum it checks, a table entry pointing anywhere but the
// block, a bitmap that leaves a sector out, and a block that is not in the
// table being written anyway. On the router's disk any of those is a router
// that does not boot.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { VHD_BLOCK, sparseVhd, vhdGeometry } from '../src/fleet/host/vhd.js';
import { readVhd } from './helpers/vhd-read.js';

/** A block of recognisable bytes, different for each `seed`. */
function pattern(/** @type {number} */ seed) {
  const b = Buffer.alloc(VHD_BLOCK);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + seed * 7) & 0xff;
  return b;
}

test('the VHD reads back as the disk it holds: listed blocks at their place, the rest absent, every checksum right', () => {
  const size = 8 * VHD_BLOCK;
  const given = new Map([[6, pattern(6)], [0, pattern(0)], [3, pattern(3)]]);
  const file = sparseVhd({ size, blocks: given, now: Date.UTC(2026, 9, 17) });
  const got = readVhd(file);
  assert.equal(got.size, size);
  assert.equal(got.blockSize, VHD_BLOCK);
  assert.deepEqual([...got.blocks.keys()].sort(), [0, 3, 6], 'a block not given is in the table, or one given is not');
  for (const [i, data] of given) assert.ok(got.blocks.get(i)?.equals(data), `block ${i} reads back different`);
  // The file is the blocks and their bookkeeping, nothing of the disk's size.
  assert.equal(file.length, 512 + 1024 + 512 + 3 * (512 + VHD_BLOCK) + 512);
  // Seconds from 2000-01-01, as the format counts them.
  assert.equal(got.footer.readUInt32BE(24), (Date.UTC(2026, 9, 17) - Date.UTC(2000, 0, 1)) / 1000);
  const { cylinders, heads, sectors } = vhdGeometry(size);
  assert.deepEqual([got.footer.readUInt16BE(56), got.footer[58], got.footer[59]], [cylinders, heads, sectors]);
});

test('the geometry is the specification’s, and the edge router’s disk has the table it needs', () => {
  // Worked by hand from the specification's algorithm: 3 GiB is 6,291,456
  // sectors, past 17 and 31 sectors a track, so 63 and 16 heads.
  assert.deepEqual(vhdGeometry(3 * 1024 ** 3), { cylinders: 6241, heads: 16, sectors: 63 });
  // 16 MiB is 32,768 sectors: 1,927 tracks of 17, which want two heads,
  // raised to the four the algorithm never goes below.
  assert.deepEqual(vhdGeometry(8 * VHD_BLOCK), { cylinders: 481, heads: 4, sectors: 17 });
  const empty = readVhd(sparseVhd({ size: 3 * 1024 ** 3, blocks: new Map() }));
  assert.equal(empty.blocks.size, 0);
  assert.throws(() => sparseVhd({ size: VHD_BLOCK + 512, blocks: new Map() }), /whole number of 2 MiB blocks/);
  assert.throws(() => sparseVhd({ size: VHD_BLOCK, blocks: new Map([[1, pattern(1)]]) }), /block 1 is not in a disk of 1 blocks/);
  assert.throws(() => sparseVhd({ size: VHD_BLOCK, blocks: new Map([[0, Buffer.alloc(10)]]) }), /block 0 is 10 bytes/);
});

const qemu = spawnSync('qemu-img', ['--version']).status === 0;

test('qemu-img reads the same disk out of it', { skip: !qemu && 'needs qemu-img' }, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fw-vhd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const size = 8 * VHD_BLOCK;
  const given = new Map([[1, pattern(1)], [7, pattern(7)]]);
  const vhd = path.join(dir, 'blocks.vhd');
  const raw = path.join(dir, 'blocks.raw');
  writeFileSync(vhd, sparseVhd({ size, blocks: given }));
  // Its size from the footer, as XAPI takes it: qemu reads an unknown
  // creator's size from the geometry unless told otherwise.
  const r = spawnSync('qemu-img', ['convert', '-O', 'raw', '--image-opts', `driver=vpc,force_size_calc=current_size,file.filename=${vhd}`, raw], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const disk = readFileSync(raw);
  assert.equal(disk.length, size);
  for (let i = 0; i < 8; i++) {
    const want = given.get(i) ?? Buffer.alloc(VHD_BLOCK);
    assert.ok(disk.subarray(i * VHD_BLOCK, (i + 1) * VHD_BLOCK).equals(want), `qemu-img reads block ${i} different`);
  }
});
