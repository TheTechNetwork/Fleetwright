#!/usr/bin/env node
// Pins the cloud images the machine images are made of to the builds named in
// src/fleet/host/vm-image.js, which is the half Renovate cannot write.
//
//   node scripts/pin-images.mjs
//
// Renovate moves each image's `build` from its vendor's directory listing
// (renovate.json, customDatasources). The address, digest and both sizes
// follow from the build, and no datasource can give them, so this writes
// them: the address by putting the new build where the old one was, the
// digest from the vendor's own SHA256SUMS or SHA512SUMS beside it, the size
// from the download's own length, and the disk's size from its qcow2 header,
// read by a ranged request of 64 bytes. Nothing else in the file is touched.
//
// THE SOAK IS KEPT HERE. renovate.json holds every update for three days so a
// compromised release is found by somebody else first; these listings carry
// no release dates, so Renovate proposes them as soon as they appear, and this
// refuses a build whose checksum file is younger than three days, saying when
// it can be pinned. Until it has run, the build and the address disagree and
// test/pin-images.test.js fails, naming this command.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SOURCE = new URL('../src/fleet/host/vm-image.js', import.meta.url);

/** The same three days renovate.json soaks everything else for. */
export const SOAK_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Each image this pins: the constant in vm-image.js, what a build looks like
 * in its address, and the checksum file beside it.
 */
export const PINNED = Object.freeze([
  { name: 'DEBIAN_IMAGE', build: /\d{8}-\d+/g, sums: 'SHA512SUMS', field: 'sha512' },
  { name: 'UBUNTU_2404_IMAGE', build: /release-\d{8}(?:\.\d+)?/g, sums: 'SHA256SUMS', field: 'sha256' },
  { name: 'UBUNTU_2604_IMAGE', build: /release-\d{8}(?:\.\d+)?/g, sums: 'SHA256SUMS', field: 'sha256' },
]);

/**
 * The address for a build: the old one with each build it names replaced by
 * the new. Refuses an address that names no build, rather than pin the old
 * one again under the new name.
 *
 * @param {string} url @param {RegExp} pattern @param {string} build
 */
export function addressFor(url, pattern, build) {
  if (!new RegExp(pattern.source).test(url)) throw new Error(`${url} names no build to replace`);
  return url.replace(new RegExp(pattern.source, 'g'), build);
}

/**
 * The digest a SHA256SUMS or SHA512SUMS file gives one file, or an error:
 * `<hex>  <name>` or `<hex> *<name>`, as both vendors write them.
 *
 * @param {string} sums @param {string} file @param {64|128} length
 */
export function digestFor(sums, file, length) {
  for (const line of sums.split('\n')) {
    const m = /^([0-9a-f]+)\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m && m[2] === file && m[1].length === length) return m[1];
  }
  throw new Error(`the checksum file lists no ${length * 4}-bit digest for ${file}`);
}

/**
 * The size of the disk inside a qcow2, from the first bytes of its header:
 * the magic, then the virtual size at offset 24.
 *
 * @param {Buffer} head
 */
export function qcow2VirtualSize(head) {
  if (head.length < 32 || head.readUInt32BE(0) !== 0x514649fb) throw new Error('it does not start with a qcow2 header');
  const size = Number(head.readBigUInt64BE(24));
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('its qcow2 header gives no size');
  return size;
}

/**
 * How long until a file published at `published` has soaked, in
 * milliseconds; zero once it has.
 *
 * @param {Date} published @param {number} now
 */
export function soakLeft(published, now) {
  return Math.max(0, published.getTime() + SOAK_MS - now);
}

/**
 * The source with one image's address, digest and sizes written, and nothing
 * else changed. Refuses a source it cannot find each field in, inside that
 * image's own block, rather than write somewhere else.
 *
 * @param {string} source @param {string} name
 * @param {{ url: string, field: string, digest: string, compressedSize: number, rawSize: number }} pin
 */
export function writeImagePin(source, name, { url, field, digest, compressedSize, rawSize }) {
  const start = source.indexOf(`export const ${name} = Object.freeze({`);
  const end = start < 0 ? -1 : source.indexOf('\n});', start);
  if (start < 0 || end < 0) throw new Error(`${name} is not where this script expects it in vm-image.js`);
  let block = source.slice(start, end);
  const set = (/** @type {RegExp} */ re, /** @type {string} */ value) => {
    if (!re.test(block)) throw new Error(`${name} has no ${re.source.split(':')[0].trim()} line`);
    block = block.replace(re, value);
  };
  set(/\n {2}url: '[^']*',/, `\n  url: '${url}',`);
  set(new RegExp(`\\n {2}${field}: '[0-9a-f]*',`), `\n  ${field}: '${digest}',`);
  set(/\n {2}compressedSize: \d+,/, `\n  compressedSize: ${compressedSize},`);
  set(/\n {2}rawSize: \d+,/, `\n  rawSize: ${rawSize},`);
  return source.slice(0, start) + block + source.slice(end);
}

/** @param {string} url @param {RequestInit} [init] */
async function get(url, init) {
  const res = await fetch(url, { redirect: 'follow', ...init });
  if (!res.ok && res.status !== 206) throw new Error(`${url} answered ${res.status}`);
  return res;
}

/** The first `n` bytes of a file, asked for as a range and read no further. @param {string} url @param {number} n */
async function head(url, n) {
  const res = await get(url, { headers: { range: `bytes=0-${n - 1}` } });
  const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (res.body?.getReader());
  /** @type {Buffer[]} */
  const chunks = [];
  let got = 0;
  while (got < n) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    got += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, n);
}

async function main() {
  const images = await import('../src/fleet/host/vm-image.js');
  let source = readFileSync(SOURCE, 'utf8');
  const now = Date.now();
  let wrote = 0;
  for (const p of PINNED) {
    const spec = /** @type {any} */ (images)[p.name];
    if (spec.url.includes(spec.build)) {
      console.log(`${spec.os} ${spec.build}: already pinned`);
      continue;
    }
    const url = addressFor(spec.url, p.build, spec.build);
    const file = url.slice(url.lastIndexOf('/') + 1);
    const sumsUrl = url.slice(0, url.lastIndexOf('/') + 1) + p.sums;
    const sums = await get(sumsUrl);
    const published = new Date(sums.headers.get('last-modified') || '');
    if (Number.isNaN(published.getTime())) throw new Error(`${sumsUrl} gives no date, so its soak cannot be told; pin it by hand once three days have passed`);
    const left = soakLeft(published, now);
    if (left > 0) {
      throw new Error(`${spec.os} ${spec.build} was published ${published.toUTCString()}, and is held for three days like everything else: run this again after ${new Date(published.getTime() + SOAK_MS).toUTCString()}`);
    }
    const digest = digestFor(await sums.text(), file, p.field === 'sha512' ? 128 : 64);
    const length = Number((await get(url, { method: 'HEAD' })).headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error(`${url} gives no length`);
    const rawSize = qcow2VirtualSize(await head(url, 64));
    source = writeImagePin(source, p.name, { url, field: p.field, digest, compressedSize: length, rawSize });
    wrote++;
    console.log(`${spec.os} ${spec.build}: ${length} bytes, ${p.field} ${digest.slice(0, 16)}…, a ${rawSize}-byte disk\n  ${url}`);
  }
  if (wrote) writeFileSync(SOURCE, source);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(`pin-images: ${e.message}`);
    process.exit(1);
  });
}
