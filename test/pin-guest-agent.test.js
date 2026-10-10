// The Xen guest agent's pin, kept current by Renovate in two halves: Renovate
// moves GUEST_AGENT.release, and scripts/pin-guest-agent.mjs writes the file
// that release ships (renovate.json's custom manager says why it cannot).
//
//   node --test test/pin-guest-agent.test.js
//
// ASKED FOR: "Get the pinned version to be renovate managed".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GUEST_AGENT } from '../src/fleet/host/vm-image.js';
import { linuxAsset, checkBinary, writePin, OLDEST_GLIBC } from '../scripts/pin-guest-agent.mjs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SOURCE = read('src/fleet/host/vm-image.js');

test('Renovate can see the guest agent’s release, and it is the one the build uses', () => {
  // Silent both ways otherwise: the regex stops matching and the pin quietly
  // stops moving, or it matches a line the build does not read.
  const config = JSON.parse(read('renovate.json'));
  const managers = config.customManagers.filter((/** @type {any} */ m) => m.managerFilePatterns.some((/** @type {string} */ p) => p.includes('vm-image')));
  assert.equal(managers.length, 1, 'renovate.json does not read src/fleet/host/vm-image.js');
  const m = new RegExp(managers[0].matchStrings[0]).exec(SOURCE);
  assert.ok(m?.groups, 'the custom manager matches nothing in vm-image.js');
  assert.equal(m.groups.datasource, 'gitlab-releases');
  assert.equal(m.groups.depName, 'xen-project/xen-guest-agent');
  assert.equal(m.groups.currentValue, GUEST_AGENT.release, 'Renovate would move a version the build does not read');
});

test('the pinned file is the named release’s', () => {
  // What a Renovate pull request fails on until the script has run.
  assert.equal(GUEST_AGENT.file.release, GUEST_AGENT.release, `GUEST_AGENT names ${GUEST_AGENT.release} and its file is ${GUEST_AGENT.file.release}'s: run \`node scripts/pin-guest-agent.mjs\` and commit what it writes`);
  assert.match(GUEST_AGENT.file.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(GUEST_AGENT.file.size) && GUEST_AGENT.file.size > 0);
  assert.match(GUEST_AGENT.file.url, /^https:\/\/gitlab\.com\/xen-project\/xen-guest-agent\//);
});

test('the script takes the Linux x86-64 build under either name upstream has used, and only one', () => {
  const links = (/** @type {string[]} */ ...names) => ({ assets: { links: names.map((name) => ({ name, url: `https://x/${name}` })) } });
  assert.equal(linuxAsset(links('FreeBSD 13+ executable', 'Linux x86 64bit executable', 'Source package')), 'https://x/Linux x86 64bit executable');
  assert.equal(linuxAsset(links('Linux x86 64bit binary')), 'https://x/Linux x86 64bit binary');
  assert.throws(() => linuxAsset(links('FreeBSD 13+ executable')), /0 Linux x86-64 builds/);
  assert.throws(() => linuxAsset(links('Linux x86 64bit binary', 'Linux x86_64 static')), /2 Linux x86-64 builds/);
});

test('the script refuses a file an image here could not run', () => {
  /** An ELF header for this class, byte order and machine, then the strings a binary carries. */
  const elf = (/** @type {number} */ machine, /** @type {string} */ strings, cls = 2) => {
    const b = Buffer.alloc(64);
    b.write('\x7fELF', 0, 'latin1');
    b[4] = cls;
    b[5] = 1;
    b.writeUInt16LE(machine, 18);
    return Buffer.concat([b, Buffer.from(strings, 'latin1')]);
  };
  const [a, c] = OLDEST_GLIBC;
  assert.equal(checkBinary(elf(62, '\0GLIBC_2.2.5\0GLIBC_2.28\0GLIBC_2.17\0')), '2.28');
  assert.equal(checkBinary(elf(62, `\0GLIBC_${a}.${c}\0`)), `${a}.${c}`);
  assert.throws(() => checkBinary(elf(62, `\0GLIBC_${a}.${c + 1}\0`)), new RegExp(`needs glibc ${a}\\.${c + 1}, and the oldest image here has ${a}\\.${c}`));
  assert.throws(() => checkBinary(elf(183, '')), /not a 64-bit x86-64/, 'aarch64');
  assert.throws(() => checkBinary(elf(62, '', 1)), /not a 64-bit x86-64/, '32-bit');
  assert.throws(() => checkBinary(Buffer.from('#!/bin/sh\necho hello\n')), /not an ELF/);
});

test('the script rewrites the file and nothing else, and Renovate still reads the result', () => {
  assert.equal(writePin(SOURCE, GUEST_AGENT.file), SOURCE, 'writing what is there changes nothing');
  const next = { release: '9.9.9', url: 'https://gitlab.com/xen-project/xen-guest-agent/-/jobs/1/artifacts/raw/x', size: 42, sha256: 'b'.repeat(64) };
  const out = writePin(SOURCE.replace(`release: '${GUEST_AGENT.release}',\n  /**`, `release: '9.9.9',\n  /**`), next);
  const block = /\n  file: Object\.freeze\(\{\n([\s\S]*?)\n  \}\),/.exec(out)?.[1];
  assert.equal(block, [`    release: '9.9.9',`, `    url: '${next.url}',`, '    size: 42,', `    sha256: '${'b'.repeat(64)}',`].join('\n'));
  const before = SOURCE.split('\n');
  const after = out.split('\n');
  assert.equal(after.length, before.length);
  const changed = after.flatMap((l, i) => (l === before[i] ? [] : [i]));
  assert.equal(changed.length, 5, 'the release Renovate moved and the four lines of the file');
  const matcher = JSON.parse(read('renovate.json')).customManagers.find((/** @type {any} */ m) => m.managerFilePatterns.some((/** @type {string} */ p) => p.includes('vm-image'))).matchStrings[0];
  assert.equal(new RegExp(matcher).exec(out)?.groups?.currentValue, '9.9.9');
  assert.throws(() => writePin('export const NOTHING = 1;\n', next), /not where this script expects it/);
});
