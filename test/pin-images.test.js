// The images the fleet downloads, kept current by Renovate in two halves:
// Renovate moves each cloud image's `build` and OPNsense's `release` from
// their vendors' directory listings, and the rest of each pin follows, by
// scripts/pin-images.mjs for the cloud images and by a person for OPNsense
// (renovate.json says why each).
//
//   node --test test/pin-images.test.js
//
// ASKED FOR: "Ensure anything we download is in renovate following our
// renovate policies. Debian images or anything".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEBIAN_IMAGE, UBUNTU_2404_IMAGE, UBUNTU_2604_IMAGE } from '../src/fleet/host/vm-image.js';
import { OPNSENSE_IMAGE } from '../src/fleet/host/edge-router.js';
import { PINNED, SOAK_MS, addressFor, digestFor, qcow2VirtualSize, soakLeft, writeImagePin } from '../scripts/pin-images.mjs';

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
  assert.deepEqual(found('src/fleet/host/edge-router.js').map((g) => [g.datasource, g.depName, g.currentValue]), [
    ['custom.opnsense', 'opnsense', OPNSENSE_IMAGE.release],
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
  assert.equal(OPNSENSE_IMAGE.checked, OPNSENSE_IMAGE.release, `OPNSENSE_IMAGE's configuration offsets and grow were worked out for ${OPNSENSE_IMAGE.checked}, not ${OPNSENSE_IMAGE.release}: scripts/opnsense-room.mjs, then set checked last`);
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
