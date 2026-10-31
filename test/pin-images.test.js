// The images the fleet downloads, kept current by Renovate in two halves:
// Renovate moves each cloud image's `build` from its vendor's directory
// listing, the edge router image's `build` from this repository's releases
// and OPNsense's `release` from its mirror listing, and the rest of each pin
// follows, by scripts/pin-images.mjs for the cloud images,
// scripts/pin-edge-image.mjs for the edge image and a person for OPNsense
// (renovate.json says why each).
//
//   node --test test/pin-images.test.js
//
// ASKED FOR: "Ensure anything we download is in renovate following our
// renovate policies. Debian images or anything".

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { DEBIAN_IMAGE, UBUNTU_2404_IMAGE, UBUNTU_2604_IMAGE } from '../src/fleet/host/vm-image.js';
import { EDGE_IMAGE, OPNSENSE_IMAGE } from '../src/fleet/host/edge-router.js';
import { PINNED, SOAK_MS, addressFor, digestFor, qcow2VirtualSize, soakLeft, writeImagePin } from '../scripts/pin-images.mjs';
import { RELEASES, checkManifestDigest, pinFrom, renderEdgeImage, tagFor, writeEdgeImagePin } from '../scripts/pin-edge-image.mjs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const config = JSON.parse(read('renovate.json'));

/** What Renovate's custom managers find in one file: each match's groups. @param {string} file */
function found(file) {
  const source = read(file);
  return config.customManagers
    .filter((/** @type {any} */ m) => m.managerFilePatterns.some((/** @type {string} */ p) => new RegExp(p.slice(1, -1)).test(file)))
    .flatMap((/** @type {any} */ m) => m.matchStrings.flatMap((/** @type {string} */ r) => [...source.matchAll(new RegExp(r, 'g'))].map((x) => x.groups)));
}

test('Renovate can see every image the fleet downloads, and moves the name the build reads', () => {
  // Silent both ways otherwise: a regex that stops matching quietly stops the
  // pin moving, and one that matches the wrong line moves a name nothing reads.
  const images = found('src/fleet/host/vm-image.js').filter((g) => g.datasource.startsWith('custom.'));
  assert.deepEqual(images.map((g) => [g.datasource, g.depName, g.currentValue]), [
    ['custom.debian-cloud', 'trixie', DEBIAN_IMAGE.build],
    ['custom.ubuntu-cloud', 'noble', UBUNTU_2404_IMAGE.build],
    ['custom.ubuntu-cloud', 'resolute', UBUNTU_2604_IMAGE.build],
  ]);
  assert.deepEqual(found('src/fleet/host/edge-router.js').map((g) => [g.datasource, g.depName, g.packageName, g.currentValue]), [
    ['custom.opnsense', 'opnsense', undefined, OPNSENSE_IMAGE.release],
    ['github-releases', 'edge-image', 'TheTechNetwork/Fleetwright', EDGE_IMAGE.build],
  ]);
  // Each datasource exists, reads a listing, and has a pattern for its builds
  // that the name the file holds fits; a pattern that did not fit would make
  // the file's own build unreadable to Renovate, which proposes nothing.
  for (const [name, current] of [['debian-cloud', `${DEBIAN_IMAGE.build}/`], ['ubuntu-cloud', `${UBUNTU_2404_IMAGE.build}/`], ['opnsense', `OPNsense-${OPNSENSE_IMAGE.release}-nano-amd64.img.bz2`]]) {
    assert.equal(config.customDatasources[name]?.format, 'html', name);
    const rule = config.packageRules.find((/** @type {any} */ r) => r.extractVersion && r.matchDatasources?.includes(`custom.${name}`));
    assert.ok(rule, `custom.${name} has no extractVersion`);
    assert.match(current, new RegExp(rule.extractVersion), `custom.${name} would not read its own current build`);
  }
});

test('the soak is kept for them: every image carries its date in its name, and the pin waits three days', () => {
  // Renovate 42 and later never propose an update with no release date while
  // minimumReleaseAge is set, and a listing has none. A cloud image's build is
  // named for its day and an OPNsense release for its month, so each datasource
  // reads the date from the name and the ordinary soak applies. None is marked
  // timestamp-optional: that proposed a build the moment it appeared, red, and
  // Renovate reported it as a repository problem on every run.
  for (const rule of config.packageRules.filter((/** @type {any} */ r) => r.minimumReleaseAgeBehaviour === 'timestamp-optional')) {
    assert.ok(!rule.matchDatasources?.some((/** @type {string} */ d) => d.startsWith('custom.')), 'timestamp-optional reaches a listing whose names carry a date');
  }
  for (const [name, current] of [['debian-cloud', `${DEBIAN_IMAGE.build}/`], ['ubuntu-cloud', `${UBUNTU_2404_IMAGE.build}/`], ['ubuntu-cloud', `${UBUNTU_2604_IMAGE.build}/`], ['opnsense', `OPNsense-${OPNSENSE_IMAGE.release}-nano-amd64.img.bz2`]]) {
    const transform = config.customDatasources[name].transformTemplates?.[0] ?? '';
    assert.match(transform, /"releaseTimestamp":/, `custom.${name} gives Renovate no date, so it would never propose a build`);
    // The transform keeps only the links that are builds; one that did not keep
    // the file's own build would make it invisible to Renovate.
    const keeps = new RegExp(/\$contains\(version, \/(.+?)\/\)/.exec(transform)?.[1] ?? '(?!)');
    assert.match(current, keeps, `custom.${name} would drop its own current build`);
  }
  assert.equal(config.minimumReleaseAge, '3 days');
  assert.equal(SOAK_MS, 3 * 24 * 60 * 60 * 1000, 'the pin soaks for the same three days as everything else');
  const at = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(soakLeft(new Date(at), at + SOAK_MS), 0);
  assert.equal(soakLeft(new Date(at), at + SOAK_MS - 1000), 1000);
});

test('each cloud image is pinned to the build it names', () => {
  // What a Renovate pull request fails on until the script has run.
  for (const spec of [DEBIAN_IMAGE, UBUNTU_2404_IMAGE, UBUNTU_2604_IMAGE]) {
    assert.ok(spec.url.includes(`/${spec.build}/`), `${spec.os} names ${spec.build} and its address is another build's: run \`node scripts/pin-images.mjs\` and commit what it writes`);
    const digest = spec.algorithm === 'sha512' ? /** @type {any} */ (spec).sha512 : /** @type {any} */ (spec).sha256;
    assert.match(digest, spec.algorithm === 'sha512' ? /^[0-9a-f]{128}$/ : /^[0-9a-f]{64}$/);
    assert.ok(spec.compressedSize > 0 && spec.rawSize > spec.compressedSize);
  }
  assert.deepEqual(PINNED.map((p) => p.name), ['DEBIAN_IMAGE', 'UBUNTU_2404_IMAGE', 'UBUNTU_2604_IMAGE'], 'an image the script does not pin');
});

test('the OPNsense image is pinned, and checked, for the release it names', () => {
  // A person's work, and the test is what keeps a half-done one red: the
  // address alone moved would download the new release into the old one's
  // offsets, and the build would refuse it.
  assert.ok(OPNSENSE_IMAGE.url.includes(`/OPNsense-${OPNSENSE_IMAGE.release}-nano-amd64.img.bz2`), `OPNSENSE_IMAGE names ${OPNSENSE_IMAGE.release} and downloads another release: the renovate.json note for custom.opnsense says what to pin`);
  assert.equal(OPNSENSE_IMAGE.checked, OPNSENSE_IMAGE.release, `OPNSENSE_IMAGE's configuration offset was found in ${OPNSENSE_IMAGE.checked}, not ${OPNSENSE_IMAGE.release}: find it again, then set checked last`);
});

test('Renovate reads the edge image from this repository’s releases, as builds in order of their day and run, and nothing else there', () => {
  const rule = config.packageRules.find((/** @type {any} */ r) => r.matchDatasources?.includes('github-releases') && r.matchDepNames?.includes('edge-image'));
  assert.ok(rule, 'no rule reads the edge image’s releases');
  const extract = new RegExp(rule.extractVersion);
  assert.equal(extract.exec(tagFor(EDGE_IMAGE.build))?.groups?.version, EDGE_IMAGE.build, 'would not read its own current release');
  assert.equal(extract.exec('v1.2.3'), null, 'a host release would be offered as an edge image');
  assert.match(rule.versioning, /^regex:/);
  const versioning = new RegExp(rule.versioning.slice('regex:'.length));
  assert.ok(versioning.test(EDGE_IMAGE.build), 'the versioning does not read its own current build');
  // Renovate compares each named part as a number, so every one must be
  // purely numeric: the day as `build` and the run as `revision`, after the
  // OPNsense version, so a rebuild of the same version on a later day is
  // newer and the `_n` of a package revision is not a part at all.
  const parts = { ...versioning.exec('26.7.10_2-20261201-3')?.groups };
  assert.deepEqual(parts, { major: '26', minor: '7', patch: '10', build: '20261201', revision: '3' });
  assert.deepEqual({ ...versioning.exec('27.1-20270201-1')?.groups }, { major: '27', minor: '1', patch: undefined, build: '20270201', revision: '1' }, 'a release’s first build, before any point release');
  for (const [k, v] of Object.entries(parts)) if (v !== undefined) assert.match(v, /^\d+$/, k);
  assert.ok(rule.prBodyNotes?.some((/** @type {string} */ n) => n.includes('scripts/pin-edge-image.mjs')), 'the pull request does not say what pins it');
});

test('the edge image is pinned to the build it names, from the OPNsense release pinned for it, and laid out as the script writes it', () => {
  // What a Renovate pull request fails on until scripts/pin-edge-image.mjs has run.
  assert.ok(EDGE_IMAGE.url.startsWith(RELEASES) && EDGE_IMAGE.url.includes(`/${tagFor(EDGE_IMAGE.build)}/`), `EDGE_IMAGE names ${EDGE_IMAGE.build} and downloads another release: run \`node scripts/pin-edge-image.mjs\` and commit what it writes`);
  assert.equal(EDGE_IMAGE.checked, EDGE_IMAGE.build, `EDGE_IMAGE's offsets and room plan were copied from ${EDGE_IMAGE.checked}, not ${EDGE_IMAGE.build}: run \`node scripts/pin-edge-image.mjs\``);
  assert.equal(EDGE_IMAGE.release, OPNSENSE_IMAGE.release, 'the edge image was built from another OPNsense release than the one the edge is configured for');
  assert.match(EDGE_IMAGE.sha256, /^[0-9a-f]{64}$/);
  assert.ok(EDGE_IMAGE.compressedSize > 0 && EDGE_IMAGE.rawSize > EDGE_IMAGE.compressedSize);
  assert.equal(EDGE_IMAGE.grow.data.length, EDGE_IMAGE.grow.room);
  // The whole block is the script's to write, so a hand edit that the script
  // would not make is caught here rather than overwritten on the next pin.
  assert.ok(read('src/fleet/host/edge-router.js').includes(renderEdgeImage(EDGE_IMAGE)), 'EDGE_IMAGE is not laid out as scripts/pin-edge-image.mjs writes it: let the script write it, or change renderEdgeImage with it');
});

/** A release's manifest, small and made up, and the SHA256SUMS that vouches for it. */
const MANIFEST = {
  schema: 1,
  opnsense_release: '26.7',
  opnsense_version: '26.7.9',
  compressed: { name: 'fleetwright-edge-26.7-26.7.9-amd64.img.zst', sha256: 'a'.repeat(64), size: 100, format: 'zstd' },
  raw_size: 10_000,
  config: { offset: 5000, length: 50, sha256: 'b'.repeat(64) },
  grow: { room: 64, inode: 7, data: { offset: 8192, length: 64 }, edits: [{ offset: 10, was: '00', becomes: '01', what: 'a count' }, { offset: 20, was: 'ff', becomes: 'fe', what: "the inode's first block" }] },
};
const MANIFEST_BYTES = Buffer.from(JSON.stringify(MANIFEST));
const SUMS = `${'a'.repeat(64)}  fleetwright-edge-26.7-26.7.9-amd64.img.zst\n${createHash('sha256').update(MANIFEST_BYTES).digest('hex')}  manifest.json\n`;

test('the script takes the pin from the manifest the release’s checksums vouch for, and refuses one that does not add up', () => {
  checkManifestDigest(SUMS, MANIFEST_BYTES);
  assert.throws(() => checkManifestDigest(SUMS, Buffer.from('{}')), /manifest\.json hashes to .* and the release's SHA256SUMS lists/);
  const want = { build: '26.7.9-20261201-3', release: '26.7' };
  const pin = pinFrom(MANIFEST, SUMS, want);
  assert.deepEqual(pin, {
    build: '26.7.9-20261201-3',
    release: '26.7',
    version: '26.7.9',
    url: `${RELEASES}edge-image/26.7.9-20261201-3/fleetwright-edge-26.7-26.7.9-amd64.img.zst`,
    sha256: 'a'.repeat(64),
    compressedSize: 100,
    rawSize: 10_000,
    config: { offset: 5000, length: 50, sha256: 'b'.repeat(64) },
    grow: MANIFEST.grow,
  });
  const vary = (/** @type {(m: any) => void} */ change) => {
    const m = structuredClone(MANIFEST);
    change(m);
    return m;
  };
  assert.throws(() => pinFrom(vary((m) => (m.opnsense_release = '27.1')), SUMS, want), /built from OPNsense 27\.1, and the edge is built for 26\.7/);
  assert.throws(() => pinFrom(vary((m) => (m.compressed.sha256 = 'c'.repeat(64))), SUMS, want), /SHA256SUMS says a{16}/);
  assert.throws(() => pinFrom(MANIFEST, SUMS.replace('a'.repeat(64), 'c'.repeat(64)), want), /SHA256SUMS says c{16}/);
  assert.throws(() => pinFrom(vary((m) => (m.compressed.format = 'bzip2')), SUMS, want), /compressed as bzip2, and the host unpacks zstd/);
  assert.throws(() => pinFrom(vary((m) => (m.schema = 2)), SUMS, want), /schema 2/);
  assert.throws(() => pinFrom(vary((m) => (m.grow.data.length = 32)), SUMS, want), /no room plan/);
  assert.throws(() => pinFrom(vary((m) => (m.grow.edits[1].becomes = 'f')), SUMS, want), /an edit it does not describe \(2 of 2\)/);
  assert.throws(() => pinFrom(vary((m) => (m.grow.edits[1].offset = 5)), SUMS, want), /out of the order/);
  assert.throws(() => pinFrom(vary((m) => (m.config.offset = 9_990)), SUMS, want), /past the end of the disk/);
});

test('the script writes the whole EDGE_IMAGE block, and nothing else', () => {
  const source = read('src/fleet/host/edge-router.js');
  const pin = pinFrom(MANIFEST, SUMS, { build: '26.7.9-20261201-3', release: '26.7' });
  const out = writeEdgeImagePin(source, pin);
  const [before, after] = source.split(renderEdgeImage(EDGE_IMAGE));
  assert.equal(out, before + renderEdgeImage(pin) + after);
  assert.ok(out.includes("what: 'the inode\\'s first block'"), 'a quote in what the manifest says is not escaped');
  assert.ok(out.includes(`url: '${OPNSENSE_IMAGE.url}'`), 'the OPNsense pin is left as it was');
  assert.throws(() => writeEdgeImagePin('nothing here', pin), /not where this script expects it/);
});

test('the script puts the new build where the old one was, and refuses an address that names none', () => {
  const debian = /** @type {RegExp} */ (PINNED[0].build);
  assert.equal(
    addressFor('https://cloud.debian.org/images/cloud/trixie/20261001-2618/debian-13-genericcloud-amd64-20261001-2618.qcow2', debian, '20261015-2630'),
    'https://cloud.debian.org/images/cloud/trixie/20261015-2630/debian-13-genericcloud-amd64-20261015-2630.qcow2',
  );
  const ubuntu = /** @type {RegExp} */ (PINNED[1].build);
  assert.equal(
    addressFor('https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-amd64.img', ubuntu, 'release-20261010.1'),
    'https://cloud-images.ubuntu.com/releases/noble/release-20261010.1/ubuntu-24.04-server-cloudimg-amd64.img',
  );
  assert.throws(() => addressFor('https://example.invalid/latest/disk.img', ubuntu, 'release-20261010'), /names no build/);
});

test('the script reads the digest the vendor published, for that file and that length only', () => {
  const sha256 = 'a'.repeat(64);
  const sums = `${'b'.repeat(64)} *ubuntu-24.04-server-cloudimg-arm64.img\n${sha256} *ubuntu-24.04-server-cloudimg-amd64.img\n`;
  assert.equal(digestFor(sums, 'ubuntu-24.04-server-cloudimg-amd64.img', 64), sha256);
  assert.equal(digestFor(`${'c'.repeat(128)}  debian-13-genericcloud-amd64-x.qcow2\n`, 'debian-13-genericcloud-amd64-x.qcow2', 128), 'c'.repeat(128));
  assert.throws(() => digestFor(sums, 'ubuntu-24.04-server-cloudimg-amd64.img', 128), /no 512-bit digest/);
  assert.throws(() => digestFor(sums, 'other.img', 64), /no 256-bit digest for other\.img/);
});

test('the script reads the disk size from a qcow2 header, and refuses what is not one', () => {
  const head = Buffer.alloc(64);
  head.writeUInt32BE(0x514649fb, 0);
  head.writeBigUInt64BE(3221225472n, 24);
  assert.equal(qcow2VirtualSize(head), 3221225472);
  assert.throws(() => qcow2VirtualSize(Buffer.from('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">'.padEnd(64))), /not start with a qcow2 header/);
});

test('the script writes one image’s address, digest and sizes, and nothing else', () => {
  const source = read('src/fleet/host/vm-image.js');
  const pin = { url: 'https://cloud-images.ubuntu.com/releases/noble/release-20261010/ubuntu-24.04-server-cloudimg-amd64.img', field: 'sha256', digest: 'd'.repeat(64), compressedSize: 1, rawSize: 2 };
  const out = writeImagePin(source, 'UBUNTU_2404_IMAGE', pin);
  const changed = out.split('\n').filter((line, i) => line !== source.split('\n')[i]);
  assert.deepEqual(changed, [`  url: '${pin.url}',`, `  sha256: '${pin.digest}',`, '  compressedSize: 1,', '  rawSize: 2,']);
  assert.ok(out.includes(`url: '${UBUNTU_2604_IMAGE.url}'`), 'the other Ubuntu image is left as it was');
  assert.throws(() => writeImagePin(source, 'NOT_AN_IMAGE', pin), /not where this script expects it/);
});
