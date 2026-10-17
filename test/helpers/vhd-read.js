// A dynamic VHD read by Microsoft's specification, field by field, for the
// tests of the VHD the edge router's rebuild writes (src/fleet/host/vhd.js):
// test/vhd.test.js reads the writer's output with it, and
// test/edge-router.test.js reads what a rebuild sent Xen Orchestra. Written
// from the specification and not from the writer, so the two can disagree.

import assert from 'node:assert/strict';

/** The ones' complement of the byte sum of `buf` with the four bytes at `at` taken as zero. */
function sum(/** @type {Buffer} */ buf, /** @type {number} */ at) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) if (i < at || i >= at + 4) s += buf[i];
  return ~s >>> 0;
}

/**
 * A dynamic VHD read by the specification: the footer at the end and its copy
 * at the start, the header where the footer says, the table where the header
 * says, and each listed block's bitmap and data. Throws on anything the
 * format does not allow.
 */
export function readVhd(/** @type {Buffer} */ file) {
  assert.equal(file.length % 512, 0, 'not whole sectors');
  const footer = file.subarray(file.length - 512);
  assert.ok(file.subarray(0, 512).equals(footer), 'the copy of the footer differs from the footer');
  assert.equal(footer.toString('latin1', 0, 8), 'conectix');
  assert.equal(footer.readUInt32BE(8) & 2, 2, 'the reserved feature bit is not set');
  assert.equal(footer.readUInt32BE(12), 0x00010000);
  assert.equal(footer.readUInt32BE(60), 3, 'not a dynamic disk');
  assert.equal(footer.readUInt32BE(64), sum(footer, 64), 'the footer checksum is wrong');
  const size = Number(footer.readBigUInt64BE(48));
  const headerAt = Number(footer.readBigUInt64BE(16));
  const header = file.subarray(headerAt, headerAt + 1024);
  assert.equal(header.toString('latin1', 0, 8), 'cxsparse');
  assert.equal(header.readBigUInt64BE(8), 0xffffffffffffffffn);
  assert.equal(header.readUInt32BE(24), 0x00010000);
  assert.equal(header.readUInt32BE(36), sum(header, 36), 'the header checksum is wrong');
  const tableAt = Number(header.readBigUInt64BE(16));
  const entries = header.readUInt32BE(28);
  const blockSize = header.readUInt32BE(32);
  assert.equal(entries, Math.ceil(size / blockSize));
  const bitmapBytes = Math.ceil(blockSize / 512 / 8 / 512) * 512;
  /** @type {Map<number, Buffer>} */
  const blocks = new Map();
  for (let i = 0; i < entries; i++) {
    const sector = file.readUInt32BE(tableAt + i * 4);
    if (sector === 0xffffffff) continue;
    const at = sector * 512;
    const bitmap = file.subarray(at, at + bitmapBytes);
    assert.ok(bitmap.subarray(0, blockSize / 512 / 8).every((b) => b === 0xff), `block ${i} leaves sectors out of its bitmap`);
    assert.ok(at + bitmapBytes + blockSize <= file.length - 512, `block ${i} runs into the footer`);
    blocks.set(i, file.subarray(at + bitmapBytes, at + bitmapBytes + blockSize));
  }
  return { size, blockSize, footer, blocks };
}

