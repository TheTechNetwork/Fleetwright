#!/usr/bin/env node
// Pins the edge router's image, EDGE_IMAGE in src/fleet/host/edge-router.js,
// to the release named there, which is the half Renovate cannot write.
//
//   node scripts/pin-edge-image.mjs
//
// Renovate moves `build` from this repository's own releases, the
// `edge-image/<build>` tags .github/workflows/edge-image.yml publishes
// (renovate.json, the github-releases rule). Everything else in the pin is
// in that release's manifest.json, measured from the image it was published
// with: the asset's name, digest and sizes, where /usr/local/etc/config.xml
// is in its file system, and the room plan that moves it. This copies them
// here, after checking the manifest against the release's SHA256SUMS and the
// asset's length against the manifest, and writes the whole EDGE_IMAGE block
// as renderEdgeImage lays it out, so what is committed is always what this
// would write (test/pin-images.test.js holds the file to that). Nothing else
// in the file is touched.
//
// THE SOAK IS RENOVATE'S HERE. The cloud images' pin (pin-images.mjs) checks
// the three days twice because their listings carry no dates and their
// datasources read a day out of each build's name. A GitHub release carries
// its own date, so Renovate's minimumReleaseAge waits on the real one and
// the pull request does not exist until it has passed.
//
// IT REFUSES A RELEASE BUILT FROM ANOTHER OPNSENSE RELEASE than
// OPNSENSE_IMAGE names. The image is built from that pin, and the edge's
// filter names (EDGE_FILTER) are read from that release's models; a build
// made by hand from a newer one, with the workflow's `release` input, is not
// to be pinned until the upstream pin has moved to it too.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { digestFor } from './pin-images.mjs';

const SOURCE = new URL('../src/fleet/host/edge-router.js', import.meta.url);

/** Where a release's assets are, before `<tag>/<name>`. */
export const RELEASES = 'https://github.com/TheTechNetwork/Fleetwright/releases/download/';

/** The release tag for a build. @param {string} build */
export const tagFor = (build) => `edge-image/${build}`;

/** @typedef {{ offset: number, was: string, becomes: string, what: string }} Edit */
/** @typedef {{ build: string, release: string, version: string, url: string, sha256: string, compressedSize: number, rawSize: number, config: { offset: number, length: number, sha256: string }, grow: { room: number, inode: number, data: { offset: number, length: number }, edits: ReadonlyArray<Edit> } }} EdgeImagePin */

/**
 * The manifest's own digest is the one SHA256SUMS lists for it, or an error:
 * the manifest is read for everything else, so it is checked first, by its
 * bytes as published.
 *
 * @param {string} sums @param {Buffer} manifest
 */
export function checkManifestDigest(sums, manifest) {
  const listed = digestFor(sums, 'manifest.json', 64);
  const seen = createHash('sha256').update(manifest).digest('hex');
  if (seen !== listed) throw new Error(`manifest.json hashes to ${seen.slice(0, 16)}… and the release's SHA256SUMS lists ${listed.slice(0, 16)}… for it, so neither was used`);
}

const whole = (/** @type {unknown} */ n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;
const hex = (/** @type {unknown} */ s, /** @type {number} */ [min, max] = [2, 1024]) => typeof s === 'string' && s.length >= min && s.length <= max && s.length % 2 === 0 && /^[0-9a-f]+$/.test(s);

/**
 * The pin a release's manifest gives, checked against its SHA256SUMS and
 * against what the edge is built for; an error naming the first thing that
 * is not as it should be, rather than a pin with a hole in it.
 *
 * @param {any} manifest @param {string} sums @param {{ build: string, release: string }} want
 * @returns {EdgeImagePin}
 */
export function pinFrom(manifest, sums, { build, release }) {
  const tag = tagFor(build);
  const bad = (/** @type {string} */ what) => new Error(`${tag}'s manifest ${what}, so it was not pinned`);
  if (manifest?.schema !== 1) throw bad(`is schema ${manifest?.schema}, and this reads schema 1`);
  if (manifest.opnsense_release !== release) {
    throw new Error(`${tag} was built from OPNsense ${manifest.opnsense_release}, and the edge is built for ${release} (OPNSENSE_IMAGE, whose release EDGE_FILTER's names are read from): move that pin to ${manifest.opnsense_release} first, or build the image for ${release}`);
  }
  if (typeof manifest.opnsense_version !== 'string' || !manifest.opnsense_version) throw bad('names no OPNsense version');
  const c = manifest.compressed;
  if (c?.format !== 'zstd') throw bad(`says the image is compressed as ${c?.format}, and the host unpacks zstd`);
  if (typeof c.name !== 'string' || !/^[A-Za-z0-9._-]+\.img\.zst$/.test(c.name)) throw bad(`names the asset ${c.name}`);
  if (!hex(c.sha256, [64, 64])) throw bad('gives the asset no SHA-256');
  const listed = digestFor(sums, c.name, 64);
  if (listed !== c.sha256) throw bad(`says ${c.name} is ${c.sha256.slice(0, 16)}… and the release's SHA256SUMS says ${listed.slice(0, 16)}…`);
  if (!whole(c.size) || c.size <= 0) throw bad('gives the asset no size');
  if (!whole(manifest.raw_size) || manifest.raw_size <= c.size) throw bad('gives the disk no size');
  const config = manifest.config;
  if (!whole(config?.offset) || !whole(config?.length) || config.length <= 0 || !hex(config.sha256, [64, 64])) throw bad('does not say where the configuration is');
  if (config.offset + config.length > manifest.raw_size) throw bad('puts the configuration past the end of the disk');
  const grow = manifest.grow;
  if (!whole(grow?.room) || grow.room <= 0 || !whole(grow?.inode) || !whole(grow?.data?.offset) || grow.data?.length !== grow.room) throw bad('has no room plan');
  if (grow.data.offset + grow.room > manifest.raw_size) throw bad('puts the room past the end of the disk');
  if (!Array.isArray(grow.edits) || !grow.edits.length) throw bad('has a room plan that changes nothing');
  /** @type {Edit[]} */
  const edits = grow.edits.map((/** @type {any} */ e, /** @type {number} */ i) => {
    if (!whole(e?.offset) || !hex(e.was) || !hex(e.becomes) || e.was.length !== e.becomes.length || typeof e.what !== 'string' || !e.what) throw bad(`has an edit it does not describe (${i + 1} of ${grow.edits.length})`);
    if (i && e.offset <= grow.edits[i - 1].offset) throw bad('lists its edits out of the order the image streams in');
    return { offset: e.offset, was: e.was, becomes: e.becomes, what: e.what };
  });
  return {
    build,
    release,
    version: manifest.opnsense_version,
    url: `${RELEASES}${tag}/${c.name}`,
    sha256: c.sha256,
    compressedSize: c.size,
    rawSize: manifest.raw_size,
    config: { offset: config.offset, length: config.length, sha256: config.sha256 },
    grow: { room: grow.room, inode: grow.inode, data: { offset: grow.data.offset, length: grow.data.length }, edits },
  };
}

/** A string as the source writes one. @param {string} s */
const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * The EDGE_IMAGE block, as it stands in edge-router.js: the one layout, so a
 * pin written here and one read back render the same bytes.
 *
 * @param {EdgeImagePin} pin
 */
export function renderEdgeImage({ build, release, version, url, sha256, compressedSize, rawSize, config, grow }) {
  const edits = grow.edits.map((e) => `      { offset: ${e.offset}, was: ${q(e.was)}, becomes: ${q(e.becomes)}, what: ${q(e.what)} },`).join('\n');
  return `export const EDGE_IMAGE = Object.freeze({
  // renovate: datasource=github-releases depName=edge-image packageName=TheTechNetwork/Fleetwright
  build: ${q(build)},
  /** The build everything below was copied from. */
  checked: ${q(build)},
  /** The OPNsense release it is, and the version of its core package it was updated to. */
  release: ${q(release)},
  version: ${q(version)},
  url: ${q(url)},
  /** As the release's SHA256SUMS lists it, and as downloaded. */
  sha256: ${q(sha256)},
  compressedSize: ${compressedSize},
  rawSize: ${rawSize},
  /** /usr/local/etc/config.xml, as the image carries it, and its SHA-256. */
  config: Object.freeze({ offset: ${config.offset}, length: ${config.length}, sha256: ${q(config.sha256)} }),
  /** The room plan for it (imagePatches): the free block it moves to, and each byte of the file system that records the move. */
  grow: Object.freeze({
    room: ${grow.room},
    inode: ${grow.inode},
    data: Object.freeze({ offset: ${grow.data.offset}, length: ${grow.data.length} }),
    edits: Object.freeze([
${edits}
    ]),
  }),
});`;
}

/**
 * The source with EDGE_IMAGE written for `pin` and nothing else changed.
 * Refuses a source it cannot find the block in, rather than write somewhere
 * else.
 *
 * @param {string} source @param {EdgeImagePin} pin
 */
export function writeEdgeImagePin(source, pin) {
  const start = source.indexOf('export const EDGE_IMAGE = Object.freeze({');
  const end = start < 0 ? -1 : source.indexOf('\n});', start);
  if (start < 0 || end < 0) throw new Error('EDGE_IMAGE is not where this script expects it in edge-router.js');
  return source.slice(0, start) + renderEdgeImage(pin) + source.slice(end + '\n});'.length);
}

/** @param {string} url @param {RequestInit} [init] */
async function get(url, init) {
  const res = await fetch(url, { redirect: 'follow', ...init });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res;
}

async function main() {
  const { EDGE_IMAGE, OPNSENSE_IMAGE } = await import('../src/fleet/host/edge-router.js');
  const { build } = EDGE_IMAGE;
  if (EDGE_IMAGE.checked === build && EDGE_IMAGE.url.includes(`/${tagFor(build)}/`)) {
    console.log(`${tagFor(build)}: already pinned`);
    return;
  }
  const at = `${RELEASES}${tagFor(build)}/`;
  const sums = await (await get(`${at}SHA256SUMS`)).text();
  const manifest = Buffer.from(await (await get(`${at}manifest.json`)).arrayBuffer());
  checkManifestDigest(sums, manifest);
  const pin = pinFrom(JSON.parse(manifest.toString('utf8')), sums, { build, release: OPNSENSE_IMAGE.release });
  const length = Number((await get(pin.url, { method: 'HEAD' })).headers.get('content-length'));
  if (length !== pin.compressedSize) throw new Error(`${pin.url} is ${length || 'of no stated'} bytes and the manifest says ${pin.compressedSize}, so it was not pinned`);
  writeFileSync(SOURCE, writeEdgeImagePin(readFileSync(SOURCE, 'utf8'), pin));
  console.log(`${tagFor(build)}: OPNsense ${pin.version}, ${pin.compressedSize} bytes, sha256 ${pin.sha256.slice(0, 16)}…, a ${pin.rawSize}-byte disk, the configuration at ${pin.config.offset} and its room at ${pin.grow.data.offset} (${pin.grow.edits.length} edits)\n  ${pin.url}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(`pin-edge-image: ${e.message}`);
    process.exit(1);
  });
}
