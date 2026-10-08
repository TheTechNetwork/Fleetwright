// The raw disk read out of a qcow2, against qemu-img's own reading of the
// same files. The fixtures were made by qemu-img 8 from one 263,144-byte
// disk (text, noise, zeros, and a last cluster cut short): compressed with
// zlib, compressed with zstd, and not compressed. EXPECTED is the SHA-256 of
// `qemu-img convert -O raw` of each, which is the same for all three; the
// disk is rounded up to whole 512-byte sectors, as qcow2 keeps it.
//
// The full-size check is in src/fleet/host/qcow2.js's header: Debian 13's
// genericcloud qcow2 reads out to the SHA-512 Debian publishes for its .raw.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { qcow2Raw, qcow2Size } from '../src/fleet/host/qcow2.js';

const FIXTURES = new URL('./fixtures/qcow2/', import.meta.url);
const EXPECTED = '6e6cb97d4a311209778794ef3611d7ce245e9df9a6745038d4375214c0ac003f';
const SIZE = 263168;

/** @param {string} file */
async function read(file) {
  const h = createHash('sha256');
  let n = 0;
  for await (const c of qcow2Raw(file)) {
    h.update(c);
    n += c.length;
  }
  return { n, sha: h.digest('hex') };
}

for (const kind of ['zlib', 'zstd', 'plain']) {
  test(`a ${kind} qcow2 reads out as the raw disk qemu-img reads out of it`, async () => {
    const file = new URL(`${kind}.qcow2`, FIXTURES).pathname;
    assert.equal(await qcow2Size(file), SIZE);
    assert.deepEqual(await read(file), { n: SIZE, sha: EXPECTED });
  });
}

test('a qcow2 whose disk is not all in it, or is locked or broken, is refused by name', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-qcow2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = readFileSync(new URL('zlib.qcow2', FIXTURES));
  /** @param {(b: Buffer) => void} change */
  const changed = (change) => {
    const b = Buffer.from(good);
    change(b);
    const f = join(dir, `${Math.random()}.qcow2`);
    writeFileSync(f, b);
    return f;
  };
  const cases = [
    [changed((b) => b.writeBigUInt64BE(4096n, 8)), /backing file/],
    [changed((b) => b.writeUInt32BE(1, 32)), /encrypted/],
    [changed((b) => b.writeUInt8(b.readUInt8(79) | 2, 79)), /marked corrupt/],
    [changed((b) => b.writeUInt8(b.readUInt8(79) | 4, 79)), /separate file/],
    [changed((b) => b.writeUInt32BE(0x12345678, 0)), /not a qcow2/],
  ];
  for (const [file, why] of cases) await assert.rejects(read(/** @type {string} */ (file)), /** @type {RegExp} */ (why));
});

test('a damaged compressed cluster stops the disk instead of sending a wrong one', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-qcow2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const b = Buffer.from(readFileSync(new URL('zlib.qcow2', FIXTURES)));
  // The first clusters' deflate data, which the fixture keeps from byte
  // 20,480 (its first L2 entries point there).
  b.fill(0xff, 20480, 20480 + 200);
  const f = join(dir, 'damaged.qcow2');
  writeFileSync(f, b);
  await assert.rejects(read(f));
});
