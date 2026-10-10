// Room for a file in a UFS2 image, made by the file system's own rules: one
// whole free block taken for it, the fragments it had given back, and every
// count that records either brought along. For the edge router's
// configuration (edge-router.js, OPNSENSE_IMAGE.grow), whose 8 KiB were not
// room enough for two routers' worth of rules.
//
// WHY NOT GROW IT IN PLACE, as the 8 KiB was: `makefs` packed the cylinder
// group the file is in, so there is not one free fragment beside it. The only
// free blocks in OPNsense 26.7's nano image are in groups 4 to 6.
//
// WHAT CHANGES, and nothing else (FreeBSD's sys/ufs/ffs/fs.h and
// ufs/ufs/dinode.h, offsets read from the headers by a compiler):
//   - the inode: its size, its count of 512-byte sectors, its first block;
//   - the group it leaves: the fragments marked free in its bitmap, its
//     count of free fragments and its count of free runs of that length;
//   - the group it moves to: the block marked used in its fragment bitmap
//     and its cluster map, its count of free blocks, and its counts of free
//     clusters by length;
//   - the superblock's totals and the per-group summary array.
// The file system keeps no check-hashes (`fs_metackhash` 0) and no soft
// updates or journal (`fs_flags` 0), so nothing else records any of it.
//
// PLANNED HERE, PINNED THERE. `planRoom` reads an image and says each byte
// it would change and what is there now; `checkRoom` applies a plan to what
// it reads and recomputes every summary from the bitmaps, as fsck does, and
// refuses a plan that leaves them disagreeing. scripts/opnsense-room.mjs runs
// both against a downloaded image and prints the plan, and the build carries
// it as data and checks every byte it replaces before replacing it, the way
// it always has: nothing is worked out at build time.

/** UFS2's superblock, where the kernel looks for it. */
export const SBLOCK_UFS2 = 65536;
const FS_UFS2_MAGIC = 0x19540119;
const CG_MAGIC = 0x090255;

/** Byte offsets in `struct fs`, `struct cg` and `struct ufs2_dinode`. */
const FS = { sblkno: 8, cblkno: 12, iblkno: 16, ncg: 44, bsize: 48, fsize: 52, frag: 56, ipg: 184, fpg: 188, cstotal: 1008, csaddr: 1096, flags: 1312, metackhash: 1308, contigsumsize: 1316, magic: 1372 };
const CG = { magic: 4, cgx: 12, ndblk: 20, cs: 24, frsum: 52, freeoff: 96, clustersumoff: 104, clusteroff: 108, nclusterblks: 112 };
const DI = { mode: 0, size: 16, blocks: 24, db: 112, ib: 208, size_of: 256 };
/** `struct csum`: ndir, nbfree, nifree, nffree, each 32 bits. */
const CS = { nbfree: 4, nffree: 12 };
/** `struct csum_total`: the same four, each 64 bits. */
const CST = { nbfree: 8, nffree: 24 };

/** @typedef {(offset: number, length: number) => Buffer} Read */
/** @typedef {{ offset: number, was: string, becomes: string, what: string }} Edit */
/** @typedef {{ room: number, data: { offset: number, length: number }, edits: Edit[] }} Plan */

/** @param {Read} read */
function geometry(read) {
  const sb = read(SBLOCK_UFS2, 1376);
  const i32 = (/** @type {number} */ o) => sb.readInt32LE(o);
  if (sb.readUInt32LE(FS.magic) !== FS_UFS2_MAGIC) throw new Error('there is no UFS2 superblock where the kernel looks for one');
  if (sb.readUInt32LE(FS.flags) !== 0) throw new Error('the file system has flags set (soft updates, a journal or another feature), which this does not account for');
  if (sb.readUInt32LE(FS.metackhash) !== 0) throw new Error('the file system keeps check-hashes, which this does not compute');
  const fs = { sblkno: i32(FS.sblkno), cblkno: i32(FS.cblkno), iblkno: i32(FS.iblkno), ncg: sb.readUInt32LE(FS.ncg), bsize: i32(FS.bsize), fsize: i32(FS.fsize), frag: i32(FS.frag), ipg: sb.readUInt32LE(FS.ipg), fpg: i32(FS.fpg), csaddr: Number(sb.readBigInt64LE(FS.csaddr)), contigsumsize: i32(FS.contigsumsize) };
  if (fs.bsize !== fs.fsize * fs.frag) throw new Error('the file system’s block is not its fragment times its fragments per block');
  return fs;
}

/** @param {ReturnType<typeof geometry>} fs @param {number} cg */
const cgOffset = (fs, cg) => (cg * fs.fpg + fs.cblkno) * fs.fsize;

/** @param {ReturnType<typeof geometry>} fs @param {Buffer} cgb @param {number} cg */
function cgHeader(fs, cgb, cg) {
  if (cgb.readUInt32LE(CG.magic) !== CG_MAGIC || cgb.readUInt32LE(CG.cgx) !== cg) throw new Error(`cylinder group ${cg} is not where the superblock says`);
  return { ndblk: cgb.readUInt32LE(CG.ndblk), freeoff: cgb.readUInt32LE(CG.freeoff), clusteroff: cgb.readUInt32LE(CG.clusteroff), clustersumoff: cgb.readUInt32LE(CG.clustersumoff), nclusterblks: cgb.readUInt32LE(CG.nclusterblks) };
}

const bitOf = (/** @type {Buffer} */ b, /** @type {number} */ base, /** @type {number} */ k) => (b[base + (k >> 3)] >> (k & 7)) & 1;

/**
 * A group's summaries as fsck works them out from its bitmaps: free whole
 * blocks, free fragments outside them, free runs of fragments by length, and
 * free clusters of blocks by length (the last counting every longer one).
 *
 * @param {ReturnType<typeof geometry>} fs @param {Buffer} cgb @param {ReturnType<typeof cgHeader>} h
 */
export function summarize(fs, cgb, h) {
  let nbfree = 0;
  let nffree = 0;
  const frsum = new Array(fs.frag).fill(0);
  /** @type {number[]} */
  const blocks = [];
  const runs = (/** @type {number[]} */ bits) => {
    let run = 0;
    for (const x of [...bits, 0]) {
      if (x) run++;
      else if (run) {
        frsum[run]++;
        nffree += run;
        run = 0;
      }
    }
  };
  for (let b = 0; b * fs.frag < h.ndblk; b++) {
    const n = Math.min(fs.frag, h.ndblk - b * fs.frag);
    const bits = Array.from({ length: n }, (_, j) => bitOf(cgb, h.freeoff, b * fs.frag + j));
    if (n === fs.frag && bits.every(Boolean)) {
      nbfree++;
      blocks.push(1);
    } else {
      blocks.push(0);
      runs(bits);
    }
  }
  const clsum = new Array(fs.contigsumsize + 1).fill(0);
  let run = 0;
  for (const x of [...blocks.slice(0, h.nclusterblks), 0]) {
    if (x) run++;
    else if (run) {
      clsum[Math.min(run, fs.contigsumsize)]++;
      run = 0;
    }
  }
  const cluster = Array.from({ length: h.nclusterblks }, (_, k) => bitOf(cgb, h.clusteroff, k));
  return { nbfree, nffree, frsum, clsum, clusterAgrees: cluster.every((x, k) => x === blocks[k]) };
}

/** What a group's header says, in the same shape. @param {ReturnType<typeof geometry>} fs @param {Buffer} cgb @param {ReturnType<typeof cgHeader>} h */
function stored(fs, cgb, h) {
  return {
    nbfree: cgb.readInt32LE(CG.cs + CS.nbfree),
    nffree: cgb.readInt32LE(CG.cs + CS.nffree),
    frsum: Array.from({ length: fs.frag }, (_, k) => (k ? cgb.readInt32LE(CG.frsum + 4 * k) : 0)),
    clsum: Array.from({ length: fs.contigsumsize + 1 }, (_, k) => (k ? cgb.readInt32LE(h.clustersumoff + 4 * k) : 0)),
  };
}

/** @param {ReturnType<typeof summarize>} a @param {ReturnType<typeof stored>} b */
const agrees = (a, b) => a.clusterAgrees && a.nbfree === b.nbfree && a.nffree === b.nffree && a.frsum.join() === b.frsum.join() && a.clsum.join() === b.clsum.join();

/**
 * Where a file goes to have `room` bytes in one whole block, and every byte
 * that has to change for it, with what is there now. The file must now be
 * smaller than a block, in fragments of its first direct block, and the
 * block it moves to is the first wholly free one in the lowest group that
 * has one.
 *
 * @param {Read} read @param {{ inode: number, room: number }} want
 * @returns {Plan}
 */
export function planRoom(read, { inode, room }) {
  const fs = geometry(read);
  if (room !== fs.bsize) throw new Error(`room is one block here, ${fs.bsize} bytes, not ${room}`);
  for (let cg = 0; cg < fs.ncg; cg++) {
    const cgb = read(cgOffset(fs, cg), fs.bsize);
    const h = cgHeader(fs, cgb, cg);
    if (!agrees(summarize(fs, cgb, h), stored(fs, cgb, h))) throw new Error(`cylinder group ${cg}’s summaries disagree with its bitmaps already, so nothing is changed`);
  }
  const iOff = (Math.floor(inode / fs.ipg) * fs.fpg + fs.iblkno) * fs.fsize + (inode % fs.ipg) * DI.size_of;
  const di = read(iOff, DI.size_of);
  const size = Number(di.readBigInt64LE(DI.size));
  const sectors = Number(di.readBigInt64LE(DI.blocks));
  const db = Array.from({ length: 12 }, (_, k) => Number(di.readBigInt64LE(DI.db + 8 * k)));
  const ib = Array.from({ length: 3 }, (_, k) => Number(di.readBigInt64LE(DI.ib + 8 * k)));
  if ((di.readUInt16LE(DI.mode) & 0o170000) !== 0o100000) throw new Error(`inode ${inode} is not a regular file`);
  if (size >= fs.bsize || db.slice(1).some(Boolean) || ib.some(Boolean)) throw new Error(`inode ${inode} is not a file smaller than a block`);
  const nfrags = Math.ceil(size / fs.fsize);
  if (sectors !== (nfrags * fs.fsize) / 512) throw new Error(`inode ${inode} counts ${sectors} sectors for ${nfrags} fragments`);
  const fromFrag = db[0];
  const fromCg = Math.floor(fromFrag / fs.fpg);

  // The first wholly free block, lowest group first.
  let toFrag = -1;
  let toCg = -1;
  for (let cg = 0; cg < fs.ncg && toFrag < 0; cg++) {
    const cgb = read(cgOffset(fs, cg), fs.bsize);
    const h = cgHeader(fs, cgb, cg);
    for (let b = 0; (b + 1) * fs.frag <= h.ndblk; b++) {
      if (Array.from({ length: fs.frag }, (_, j) => bitOf(cgb, h.freeoff, b * fs.frag + j)).every(Boolean)) {
        toFrag = cg * fs.fpg + b * fs.frag;
        toCg = cg;
        break;
      }
    }
  }
  if (toFrag < 0) throw new Error('the file system has no wholly free block');
  if (toCg === fromCg) throw new Error('the free block is in the file’s own group, which this does not plan for');

  /** @type {Edit[]} */
  const edits = [];
  const edit = (/** @type {number} */ offset, /** @type {Buffer} */ was, /** @type {Buffer} */ becomes, /** @type {string} */ what) => {
    if (!was.equals(becomes)) edits.push({ offset, was: was.toString('hex'), becomes: becomes.toString('hex'), what });
  };
  const i64 = (/** @type {number} */ n) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(n));
    return b;
  };
  const i32 = (/** @type {number} */ n) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(n);
    return b;
  };

  // The superblock's totals.
  const sb = read(SBLOCK_UFS2, 1376);
  const totNb = Number(sb.readBigInt64LE(FS.cstotal + CST.nbfree));
  const totNf = Number(sb.readBigInt64LE(FS.cstotal + CST.nffree));
  edit(SBLOCK_UFS2 + FS.cstotal + CST.nbfree, i64(totNb), i64(totNb - 1), 'superblock: free blocks');
  edit(SBLOCK_UFS2 + FS.cstotal + CST.nffree, i64(totNf), i64(totNf + nfrags), 'superblock: free fragments');

  // The inode.
  edit(iOff + DI.size, di.subarray(DI.size, DI.size + 16), Buffer.concat([i64(room), i64(fs.bsize / 512)]), `inode ${inode}: size and sectors`);
  edit(iOff + DI.db, di.subarray(DI.db, DI.db + 8), i64(toFrag), `inode ${inode}: first block`);

  // Each group: its bitmaps changed, then its summaries recomputed from them.
  /** @type {Array<{ cg: number, change: (cgb: Buffer, h: ReturnType<typeof cgHeader>) => void }>} */
  const groups = [
    {
      cg: fromCg,
      change: (/** @type {Buffer} */ cgb, /** @type {ReturnType<typeof cgHeader>} */ h) => {
        for (let j = 0; j < nfrags; j++) {
          const k = fromFrag - fromCg * fs.fpg + j;
          if (bitOf(cgb, h.freeoff, k)) throw new Error('the file’s fragments are already marked free');
          cgb[h.freeoff + (k >> 3)] |= 1 << (k & 7);
        }
      },
    },
    {
      cg: toCg,
      change: (/** @type {Buffer} */ cgb, /** @type {ReturnType<typeof cgHeader>} */ h) => {
        const first = toFrag - toCg * fs.fpg;
        for (let j = 0; j < fs.frag; j++) cgb[h.freeoff + ((first + j) >> 3)] &= ~(1 << ((first + j) & 7));
        const blk = first / fs.frag;
        if (blk < h.nclusterblks) cgb[h.clusteroff + (blk >> 3)] &= ~(1 << (blk & 7));
      },
    },
  ].sort((a, b) => a.cg - b.cg);
  const csa = read(fs.csaddr * fs.fsize, 16 * fs.ncg);
  /** @type {Edit[]} */
  const csEdits = [];
  /** @type {Edit[]} */
  const cgEdits = [];
  for (const { cg, change } of groups) {
    const off = cgOffset(fs, cg);
    const was = read(off, fs.bsize);
    const h = cgHeader(fs, was, cg);
    const now = Buffer.from(was);
    change(now, h);
    const s = summarize(fs, now, h);
    now.writeInt32LE(s.nbfree, CG.cs + CS.nbfree);
    now.writeInt32LE(s.nffree, CG.cs + CS.nffree);
    for (let k = 1; k < fs.frag; k++) now.writeInt32LE(s.frsum[k], CG.frsum + 4 * k);
    for (let k = 1; k <= fs.contigsumsize; k++) now.writeInt32LE(s.clsum[k], h.clustersumoff + 4 * k);
    // Each changed run of bytes in the header, as its own edit.
    for (let i = 0; i < now.length; ) {
      if (now[i] === was[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < now.length && now[j] !== was[j]) j++;
      cgEdits.push({ offset: off + i, was: was.subarray(i, j).toString('hex'), becomes: now.subarray(i, j).toString('hex'), what: `cylinder group ${cg}` });
      i = j;
    }
    const csOff = fs.csaddr * fs.fsize + 16 * cg;
    const before = csa.subarray(16 * cg, 16 * cg + 16);
    const after = Buffer.from(before);
    after.writeInt32LE(s.nbfree, CS.nbfree);
    after.writeInt32LE(s.nffree, CS.nffree);
    if (!before.equals(after)) csEdits.push({ offset: csOff, was: before.toString('hex'), becomes: after.toString('hex'), what: `summary of cylinder group ${cg}` });
  }
  edits.push(...csEdits, ...cgEdits);
  edits.sort((a, b) => a.offset - b.offset);
  return { room, data: { offset: toFrag * fs.fsize, length: fs.bsize }, edits };
}

/**
 * The plan applied to what `read` gives, and every summary recomputed from
 * the bitmaps it leaves: each group's, the per-group array, and the
 * superblock's totals. Throws on the first that disagrees, or on a byte
 * that is not what the plan says it was.
 *
 * @param {Read} read @param {Plan} plan
 */
export function checkRoom(read, plan) {
  /** @type {Map<number, Buffer>} */
  const patched = new Map();
  for (const e of plan.edits) {
    const was = Buffer.from(e.was, 'hex');
    if (!read(e.offset, was.length).equals(was)) throw new Error(`${e.what}: the bytes at ${e.offset} are not what the plan says they were`);
    patched.set(e.offset, Buffer.from(e.becomes, 'hex'));
  }
  /** @type {Read} */
  const after = (offset, length) => {
    const b = Buffer.from(read(offset, length));
    for (const [at, bytes] of patched) {
      const from = Math.max(at, offset);
      const to = Math.min(at + bytes.length, offset + length);
      if (from < to) bytes.copy(b, from - offset, from - at, to - at);
    }
    return b;
  };
  const fs = geometry(after);
  const csa = after(fs.csaddr * fs.fsize, 16 * fs.ncg);
  let nb = 0;
  let nf = 0;
  for (let cg = 0; cg < fs.ncg; cg++) {
    const cgb = after(cgOffset(fs, cg), fs.bsize);
    const h = cgHeader(fs, cgb, cg);
    const s = summarize(fs, cgb, h);
    if (!agrees(s, stored(fs, cgb, h))) throw new Error(`cylinder group ${cg}’s summaries would disagree with its bitmaps`);
    if (csa.readInt32LE(16 * cg + CS.nbfree) !== s.nbfree || csa.readInt32LE(16 * cg + CS.nffree) !== s.nffree) throw new Error(`the summary of cylinder group ${cg} would disagree with the group`);
    nb += s.nbfree;
    nf += s.nffree;
  }
  const sb = after(SBLOCK_UFS2, 1376);
  if (Number(sb.readBigInt64LE(FS.cstotal + CST.nbfree)) !== nb || Number(sb.readBigInt64LE(FS.cstotal + CST.nffree)) !== nf) throw new Error('the superblock’s totals would disagree with the groups');
  if (!read(plan.data.offset, plan.data.length).equals(Buffer.alloc(plan.data.length))) throw new Error('the block the file moves to is not zeros');
  return true;
}
