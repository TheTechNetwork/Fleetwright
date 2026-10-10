// Room for the edge router's configuration, made by the file system's own
// rules (src/fleet/host/ufs-room.js), against a UFS2 image small enough to
// build here and laid out the way makefs leaves OPNsense's: the file's group
// packed full, free whole blocks only further on. The real image's plan is
// pinned in OPNSENSE_IMAGE.grow; scripts/opnsense-room.mjs made it, and
// test/edge-router.test.js holds the build to it.
//
//   node --test test/ufs-room.test.js
//
// ASKED FOR: two edge routers sharing addresses (HA), whose rules did not fit
// the 8 KiB the configuration's own fragments held.

import test from 'node:test';
import assert from 'node:assert/strict';

import { planRoom, checkRoom, SBLOCK_UFS2 } from '../src/fleet/host/ufs-room.js';

/** A tiny UFS2: 512-byte fragments, 8 to a block, 32 blocks a group, three groups. */
const G = { fsize: 512, frag: 8, fpg: 256, ncg: 3, ipg: 16, sblkno: 128, cblkno: 136, iblkno: 144, csaddr: 152, contigsumsize: 2 };
const CGH = { freeoff: 200, clustersumoff: 240, clusteroff: 260, nclusterblks: 32 };
const INODE = 5;
const FILE_FRAG = 200; // two fragments in group 0, in a block whose others are used

/**
 * The image: group 0 full, group 1 with blocks 10 to 12 free, group 2 with
 * block 5 free; every summary written as fsck would work it out.
 *
 * @param {{ flags?: number, wrongCount?: boolean }} [o]
 */
function image({ flags = 0, wrongCount = false } = {}) {
  const buf = Buffer.alloc(G.ncg * G.fpg * G.fsize);
  const sb = SBLOCK_UFS2;
  buf.writeInt32LE(G.sblkno, sb + 8);
  buf.writeInt32LE(G.cblkno, sb + 12);
  buf.writeInt32LE(G.iblkno, sb + 16);
  buf.writeUInt32LE(G.ncg, sb + 44);
  buf.writeInt32LE(G.fsize * G.frag, sb + 48);
  buf.writeInt32LE(G.fsize, sb + 52);
  buf.writeInt32LE(G.frag, sb + 56);
  buf.writeUInt32LE(G.ipg, sb + 184);
  buf.writeInt32LE(G.fpg, sb + 188);
  buf.writeBigInt64LE(BigInt(G.csaddr), sb + 1096);
  buf.writeUInt32LE(flags, sb + 1312);
  buf.writeInt32LE(G.contigsumsize, sb + 1316);
  buf.writeUInt32LE(0x19540119, sb + 1372);
  const free = [[], [10, 11, 12], [5]];
  let totNb = 0;
  free.forEach((blocks, cg) => {
    const h = (cg * G.fpg + G.cblkno) * G.fsize;
    buf.writeUInt32LE(0x090255, h + 4);
    buf.writeUInt32LE(cg, h + 12);
    buf.writeUInt32LE(G.fpg, h + 20);
    buf.writeUInt32LE(CGH.freeoff, h + 96);
    buf.writeUInt32LE(CGH.clustersumoff, h + 104);
    buf.writeUInt32LE(CGH.clusteroff, h + 108);
    buf.writeUInt32LE(CGH.nclusterblks, h + 112);
    for (const b of blocks) {
      buf[h + CGH.freeoff + b] = 0xff;
      buf[h + CGH.clusteroff + (b >> 3)] |= 1 << (b & 7);
    }
    const nb = blocks.length - (wrongCount && cg === 2 ? 1 : 0);
    buf.writeInt32LE(nb, h + 24 + 4);
    // Free clusters by length, the last counting longer ones.
    const clsum = cg === 1 ? [0, 0, 1] : cg === 2 ? [0, 1, 0] : [0, 0, 0];
    clsum.forEach((n, k) => k && buf.writeInt32LE(n, h + CGH.clustersumoff + 4 * k));
    buf.writeInt32LE(nb, G.csaddr * G.fsize + 16 * cg + 4);
    totNb += nb;
  });
  buf.writeBigInt64LE(BigInt(totNb), sb + 1008 + 8);
  // The file: a regular file of 700 bytes in two fragments, 8 sectors.
  const di = G.iblkno * G.fsize + INODE * 256;
  buf.writeUInt16LE(0o100644, di);
  buf.writeBigInt64LE(700n, di + 16);
  buf.writeBigInt64LE(2n, di + 24);
  buf.writeBigInt64LE(BigInt(FILE_FRAG), di + 112);
  return buf;
}

const reader = (/** @type {Buffer} */ buf) => (/** @type {number} */ offset, /** @type {number} */ length) => buf.subarray(offset, offset + length);
const apply = (/** @type {Buffer} */ buf, /** @type {ReturnType<typeof planRoom>} */ plan) => {
  const out = Buffer.from(buf);
  for (const e of plan.edits) Buffer.from(e.becomes, 'hex').copy(out, e.offset);
  return out;
};

test('the file moves to the first whole free block, gives its fragments back, and every count follows', () => {
  const buf = image();
  const plan = planRoom(reader(buf), { inode: INODE, room: 4096 });
  assert.equal(plan.data.offset, (G.fpg + 10 * G.frag) * G.fsize, 'block 10 of group 1');
  assert.ok(checkRoom(reader(buf), plan));
  const out = apply(buf, plan);
  const di = G.iblkno * G.fsize + INODE * 256;
  assert.equal(out.readBigInt64LE(di + 16), 4096n, 'the file is the block long');
  assert.equal(out.readBigInt64LE(di + 24), 8n, 'eight 512-byte sectors');
  assert.equal(out.readBigInt64LE(di + 112), BigInt(G.fpg + 80));
  const h0 = G.cblkno * G.fsize;
  const h1 = (G.fpg + G.cblkno) * G.fsize;
  // Given back: two free fragments in group 0, one run of two.
  assert.equal(out[h0 + CGH.freeoff + FILE_FRAG / 8], 0b11);
  assert.equal(out.readInt32LE(h0 + 24 + 12), 2);
  assert.equal(out.readInt32LE(h0 + 52 + 8), 1);
  // Taken: block 10 of group 1, in its bitmap and its cluster map; two free
  // blocks left there, still one cluster of two or more.
  assert.equal(out[h1 + CGH.freeoff + 10], 0);
  assert.equal((out[h1 + CGH.clusteroff + 1] >> 2) & 1, 0);
  assert.equal(out.readInt32LE(h1 + 24 + 4), 2);
  assert.equal(out.readInt32LE(h1 + CGH.clustersumoff + 8), 1);
  // And the superblock's totals and the per-group array agree.
  assert.equal(out.readBigInt64LE(SBLOCK_UFS2 + 1008 + 8), 3n);
  assert.equal(out.readBigInt64LE(SBLOCK_UFS2 + 1008 + 24), 2n);
  assert.equal(out.readInt32LE(G.csaddr * G.fsize + 16 + 4), 2);
  assert.equal(out.readInt32LE(G.csaddr * G.fsize + 12), 2);
  // Nothing outside the plan's edits changed.
  const touched = new Set(plan.edits.flatMap((e) => Array.from({ length: e.was.length / 2 }, (_, i) => e.offset + i)));
  for (let i = 0; i < buf.length; i++) if (!touched.has(i)) assert.equal(out[i], buf[i], `byte ${i}`);
});

test('a plan is refused against bytes that are not what it says, and an image that is already inconsistent is not planned for', () => {
  const buf = image();
  const plan = planRoom(reader(buf), { inode: INODE, room: 4096 });
  const changed = Buffer.from(buf);
  changed[plan.edits[0].offset] ^= 1;
  assert.throws(() => checkRoom(reader(changed), plan), /superblock: free blocks: the bytes at \d+ are not what the plan says/);
  // A plan whose counts are off would leave fsck disagreeing; it is refused.
  const off = structuredClone(plan);
  const sbEdit = off.edits.find((e) => e.what === 'superblock: free blocks');
  /** @type {any} */ (sbEdit).becomes = Buffer.from('0400000000000000', 'hex').toString('hex');
  assert.throws(() => checkRoom(reader(buf), off), /superblock’s totals would disagree/);
  assert.throws(() => planRoom(reader(image({ wrongCount: true })), { inode: INODE, room: 4096 }), /group 2’s summaries disagree with its bitmaps already/);
  assert.throws(() => planRoom(reader(image({ flags: 2 })), { inode: INODE, room: 4096 }), /flags set/);
  assert.throws(() => planRoom(reader(buf), { inode: INODE, room: 8192 }), /room is one block here, 4096 bytes/);
});
