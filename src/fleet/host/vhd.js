// A VHD that holds a few blocks of a disk and nothing else: what the edge
// router's rebuild writes into a copy of its kept disk (edge-router.js, "THE
// KEPT DISK"), a few MiB where the whole disk is 3 GiB.
//
// WHY A VHD, AND NOT THE BYTES THEMSELVES. Xen Orchestra's `disk.importContent`
// writes into a disk that is already there, through XAPI's import_raw_vdi, and
// takes the body in one of two formats. Raw is the whole disk, every byte of
// it. VHD is handed to vhd-tool (`serve_vhd_to_raw`, in xen-api's
// ocaml/vhd-tool/src/impl.ml, read for this), which writes each sector a
// block's bitmap marks present at that sector's place in the disk and nothing
// else: a block the table does not list is not written at all, so the disk
// keeps what it had there. That is how an incremental backup is restored onto
// a copy of its base, and it is what lets the build send only the blocks its
// configuration changes.
//
// WHAT IT WRITES, from Microsoft's "Virtual Hard Disk Image Format
// Specification" (version 1.0): a dynamic disk, all big-endian, in 512-byte
// sectors. A copy of the footer, the dynamic disk header, the block allocation
// table (one 32-bit sector offset per 2 MiB block, 0xFFFFFFFF for a block that
// is not in the file), then each block that is, in order: its sector bitmap,
// every bit set, and its 2 MiB. The footer again, last. Each checksum is the
// ones' complement of the sum of its structure's bytes with the checksum
// field taken as zero. vhd-tool checks both, and the cookies and versions, and
// refuses a file that gets any of them wrong.
//
// WHOLE BLOCKS, EVERY BIT SET, on purpose. A partly set bitmap is valid VHD
// and vhd-tool would write only those sectors, but a block given whole is the
// same disk whichever way a reader takes the bits it does not set; what goes
// in each block is the disk's own bytes with the change made, so writing all
// of it is writing what is there already, and the change.
//
// CHECKED AGAINST TWO READERS that are not this file: test/vhd.test.js parses
// it back by the specification, field by field, and has qemu-img read it out
// as a raw disk when qemu-img is installed.

import { randomBytes } from 'node:crypto';

/** The block size every VHD this writes uses, and the default the format suggests. */
export const VHD_BLOCK = 2 * 1024 * 1024;
const SECTOR = 512;
/** 2000-01-01T00:00:00Z, which a VHD's timestamps count from. */
const EPOCH_2000 = Date.UTC(2000, 0, 1) / 1000;
/** No offset: the header's data offset, and a table entry for a block not in the file. */
const NONE = 0xffffffff;

/**
 * The cylinders, heads and sectors a disk of `size` bytes is described as,
 * by the specification's own algorithm (Appendix: CHS calculation).
 *
 * @param {number} size @returns {{ cylinders: number, heads: number, sectors: number }}
 */
export function vhdGeometry(size) {
  let total = Math.min(Math.floor(size / SECTOR), 65535 * 16 * 255);
  let sectors;
  let heads;
  let cylinderTimesHeads;
  if (total >= 65535 * 16 * 63) {
    sectors = 255;
    heads = 16;
    cylinderTimesHeads = Math.floor(total / sectors);
  } else {
    sectors = 17;
    cylinderTimesHeads = Math.floor(total / sectors);
    heads = Math.max(4, Math.floor((cylinderTimesHeads + 1023) / 1024));
    if (cylinderTimesHeads >= heads * 1024 || heads > 16) {
      sectors = 31;
      heads = 16;
      cylinderTimesHeads = Math.floor(total / sectors);
    }
    if (cylinderTimesHeads >= heads * 1024) {
      sectors = 63;
      heads = 16;
      cylinderTimesHeads = Math.floor(total / sectors);
    }
  }
  return { cylinders: Math.floor(cylinderTimesHeads / heads), heads, sectors };
}

/** The ones' complement of the sum of `buf`'s bytes. @param {Buffer} buf */
function checksum(buf) {
  let sum = 0;
  for (const b of buf) sum += b;
  return ~sum >>> 0;
}

/**
 * A dynamic VHD of a disk `size` bytes long holding only `blocks`, each the
 * whole 2 MiB of the disk at that block, everything else absent.
 *
 * @param {{ size: number, blocks: Map<number, Buffer>, now?: number }} opts  `now` in milliseconds, for the footer's timestamp
 * @returns {Buffer}
 */
export function sparseVhd({ size, blocks, now = Date.now() }) {
  if (!Number.isSafeInteger(size) || size <= 0 || size % VHD_BLOCK) throw new Error(`a VHD here is a whole number of 2 MiB blocks, not ${size} bytes`);
  const entries = size / VHD_BLOCK;
  const order = [...blocks.keys()].sort((a, b) => a - b);
  for (const i of order) {
    if (!Number.isInteger(i) || i < 0 || i >= entries) throw new Error(`block ${i} is not in a disk of ${entries} blocks`);
    if (blocks.get(i)?.length !== VHD_BLOCK) throw new Error(`block ${i} is ${blocks.get(i)?.length} bytes, not a whole block`);
  }
  const bitmap = Math.ceil(VHD_BLOCK / SECTOR / 8 / SECTOR) * SECTOR;
  const tableAt = SECTOR + 1024;
  const tableBytes = Math.ceil((entries * 4) / SECTOR) * SECTOR;
  const firstBlock = tableAt + tableBytes;

  const footer = Buffer.alloc(SECTOR);
  footer.write('conectix', 0, 'latin1');
  footer.writeUInt32BE(0x00000002, 8); // features: the one reserved bit the format says is always set
  footer.writeUInt32BE(0x00010000, 12); // file format version 1.0
  footer.writeBigUInt64BE(BigInt(SECTOR), 16); // where the dynamic disk header is
  footer.writeUInt32BE(Math.max(0, Math.floor(now / 1000) - EPOCH_2000) >>> 0, 24);
  footer.write('fwrt', 28, 'latin1'); // creator application: Fleetwright
  footer.writeUInt32BE(0x00010000, 32);
  footer.write('Wi2k', 36, 'latin1'); // creator host OS: one of the two the format names, as qemu writes
  footer.writeBigUInt64BE(BigInt(size), 40); // original size
  footer.writeBigUInt64BE(BigInt(size), 48); // current size
  const { cylinders, heads, sectors } = vhdGeometry(size);
  footer.writeUInt16BE(cylinders, 56);
  footer.writeUInt8(heads, 58);
  footer.writeUInt8(sectors, 59);
  footer.writeUInt32BE(3, 60); // disk type: dynamic
  randomBytes(16).copy(footer, 68); // unique id
  footer.writeUInt32BE(checksum(footer), 64);

  const header = Buffer.alloc(1024);
  header.write('cxsparse', 0, 'latin1');
  header.writeUInt32BE(NONE, 8); // data offset: unused, all ones
  header.writeUInt32BE(NONE, 12);
  header.writeBigUInt64BE(BigInt(tableAt), 16);
  header.writeUInt32BE(0x00010000, 24); // header version 1.0
  header.writeUInt32BE(entries, 28);
  header.writeUInt32BE(VHD_BLOCK, 32);
  // No parent: its id, timestamp, name and locators stay zeros.
  header.writeUInt32BE(checksum(header), 36);

  const table = Buffer.alloc(tableBytes, 0xff);
  /** @type {Buffer[]} */
  const parts = [footer, header, table];
  let at = firstBlock;
  for (const i of order) {
    table.writeUInt32BE(at / SECTOR, i * 4);
    parts.push(Buffer.alloc(bitmap, 0xff), /** @type {Buffer} */ (blocks.get(i)));
    at += bitmap + VHD_BLOCK;
  }
  parts.push(footer);
  return Buffer.concat(parts);
}
