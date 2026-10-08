// A qcow2 disk read out as the raw disk it holds, as a stream, by this
// process alone.
//
// WHY THIS EXISTS. Debian and Ubuntu publish their cloud images as qcow2 with
// compressed clusters, and the pool cannot take one: Xen Orchestra 6.5 reads
// qcow2, but XCP-ng's own `qcow-stream-tool` refused the first real upload
// with `Qcow_stream.Compressed_unsupported`. A raw disk is what the pool
// takes (the first build on a real pool uploaded one without trouble), so
// the box expands the qcow2 to raw as it uploads, cluster by cluster, with
// Node's own zlib: no `qemu-img` to install, no `tar` or `xz`, and nothing
// written to this machine's disk but the download.
//
// WHAT IT READS, from the format's own specification (qemu's
// docs/interop/qcow2.rst): the header, the active L1 table, each L2 table it
// points to, and each cluster an L2 entry points to. A standard cluster is
// copied; a compressed one is inflated, zlib (raw deflate) or zstd as the
// header says; one that is unallocated or marked all zeros is zeros. Nothing
// else in the file is needed to read the disk as it is now: refcounts and
// snapshots describe how the file is kept, not what the disk holds.
//
// WHAT IT REFUSES, by name rather than by producing a wrong disk: a backing
// file (the disk is not all in this file), encryption, an external data file,
// extended L2 entries, and a header marked corrupt. None of these is in a
// distribution's cloud image; a file that has one is not the file pinned.
//
// Checked against Debian 13's genericcloud qcow2: the raw disk read out of it
// has the SHA-512 Debian publishes for the same build's `.raw`.

import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

const MAGIC = 0x514649fb;
/** Bits 9 to 55 of an L1 or L2 entry: the offset of what it points to. */
const OFFSET_MASK = 0x00fffffffffffe00n;
const COMPRESSED = 1n << 62n;
/** In a standard L2 entry: the cluster reads as zeros (version 3). */
const ZERO_FLAG = 1n;

/**
 * The header's facts, read and checked.
 *
 * @param {import('node:fs/promises').FileHandle} fh
 * @returns {Promise<{ size: number, clusterBits: number, clusterSize: number, l1Size: number, l1Offset: number, zstd: boolean }>}
 */
async function readHeader(fh) {
  const h = Buffer.alloc(112);
  const { bytesRead } = await fh.read(h, 0, h.length, 0);
  if (bytesRead < 72 || h.readUInt32BE(0) !== MAGIC) throw new Error('the image is not a qcow2 disk');
  const version = h.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`the image is qcow2 version ${version}, which this cannot read`);
  if (h.readBigUInt64BE(8) !== 0n) throw new Error('the image has a backing file, so the disk is not all in it');
  const clusterBits = h.readUInt32BE(20);
  if (clusterBits < 9 || clusterBits > 21) throw new Error(`the image has clusters of 2^${clusterBits} bytes, which is not a qcow2 cluster size`);
  if (h.readUInt32BE(32) !== 0) throw new Error('the image is encrypted');
  let zstd = false;
  if (version === 3) {
    const incompatible = h.readBigUInt64BE(72);
    if (incompatible & 2n) throw new Error('the image is marked corrupt');
    if (incompatible & 4n) throw new Error('the image keeps its data in a separate file');
    if (incompatible & 16n) throw new Error('the image uses extended L2 entries, which this does not read');
    if (incompatible & ~0x1fn) throw new Error('the image uses a qcow2 feature this does not know');
    const headerLength = h.readUInt32BE(100);
    if (incompatible & 8n) {
      if (headerLength <= 104) throw new Error('the image says it names its compression and does not');
      const type = h.readUInt8(104);
      if (type > 1) throw new Error(`the image is compressed with type ${type}, which this does not know`);
      zstd = type === 1;
    }
  }
  return {
    size: Number(h.readBigUInt64BE(24)),
    clusterBits,
    clusterSize: 2 ** clusterBits,
    l1Size: h.readUInt32BE(36),
    l1Offset: Number(h.readBigUInt64BE(40)),
    zstd,
  };
}

/**
 * The size of the disk a qcow2 holds, from its header.
 *
 * @param {string} file @returns {Promise<number>}
 */
export async function qcow2Size(file) {
  const fh = await open(file, 'r');
  try {
    return (await readHeader(fh)).size;
  } finally {
    await fh.close();
  }
}

/**
 * Exactly `length` bytes of the file from `position`, or an error naming the
 * place it ran out.
 *
 * @param {import('node:fs/promises').FileHandle} fh @param {number} position @param {number} length
 */
async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got === length ? buf : buf.subarray(0, got);
}

/**
 * The raw disk a qcow2 file holds, cluster by cluster, as a stream that
 * stops reading when the reader stops taking.
 *
 * @param {string} file
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {import('node:stream').Readable}
 */
export function qcow2Raw(file, { signal } = {}) {
  async function* clusters() {
    const fh = await open(file, 'r');
    try {
      const { size, clusterBits, clusterSize, l1Size, l1Offset, zstd } = await readHeader(fh);
      const fileSize = (await fh.stat()).size;
      const perL2 = clusterSize / 8;
      const total = Math.ceil(size / clusterSize);
      if (Math.ceil(total / perL2) > l1Size) throw new Error('the image’s L1 table is too short for its size');
      const l1 = await readAt(fh, l1Offset, l1Size * 8);
      if (l1.length < l1Size * 8) throw new Error('the image ends inside its L1 table');
      const zeros = Buffer.alloc(clusterSize);
      // Compressed entries split their 62 low bits at x: the offset below it,
      // the count of further 512-byte sectors above it.
      const x = BigInt(62 - (clusterBits - 8));
      const offsetBits = (1n << x) - 1n;
      const sectorBits = (1n << BigInt(clusterBits - 8)) - 1n;
      let emitted = 0;
      for (let i = 0; i < Math.ceil(total / perL2); i++) {
        const l2Offset = Number(l1.readBigUInt64BE(i * 8) & OFFSET_MASK);
        const l2 = l2Offset ? await readAt(fh, l2Offset, clusterSize) : null;
        if (l2 && l2.length < clusterSize) throw new Error('the image ends inside an L2 table');
        for (let j = 0; j < perL2 && emitted < total; j++, emitted++) {
          signal?.throwIfAborted();
          const want = Math.min(clusterSize, size - emitted * clusterSize);
          const entry = l2 ? l2.readBigUInt64BE(j * 8) : 0n;
          /** @type {Buffer} */
          let cluster;
          if (entry & COMPRESSED) {
            const at = Number(entry & offsetBits);
            const length = Math.min(Number((entry >> x) & sectorBits) * 512 + 512 - (at % 512), fileSize - at);
            const packed = await readAt(fh, at, length);
            // The read runs to the end of its last sector, past where the
            // compressed stream stops, so neither may insist on ending there:
            // Z_SYNC_FLUSH for deflate, ZSTD_e_flush for zstd (Node 26 calls
            // a zstd frame with bytes after it an "unexpected end of file").
            cluster = zstd
              ? zlib.zstdDecompressSync(packed, { finishFlush: zlib.constants.ZSTD_e_flush })
              : zlib.inflateRawSync(packed, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
            if (cluster.length < want) throw new Error(`a compressed cluster at ${at} of the image inflates to ${cluster.length} bytes, not ${clusterSize}`);
          } else {
            const at = Number(entry & OFFSET_MASK);
            if (!at || entry & ZERO_FLAG) cluster = zeros;
            else {
              cluster = await readAt(fh, at, clusterSize);
              if (cluster.length < want) throw new Error(`the image ends inside the cluster at ${at}`);
            }
          }
          yield cluster.length === want ? cluster : cluster.subarray(0, want);
        }
      }
    } finally {
      await fh.close();
    }
  }
  return Readable.from(clusters(), { objectMode: false });
}
