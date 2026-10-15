// The Xen Orchestra installer's pin, kept current by Renovate in two halves:
// Renovate moves INSTALLER.commit to the fork's master (git-refs), and
// scripts/pin-xo-installer.mjs writes `base` and each file's SHA-256 at it
// (renovate.json's custom manager says why it cannot).
//
//   node --test test/pin-xo-installer.test.js
//
// ASKED FOR: "Ensure anything we download is in renovate following our
// renovate policies".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { INSTALLER } from '../src/fleet/host/xo-deploy.js';
import { baseFor, writeInstallerPin, MAX_FILE } from '../scripts/pin-xo-installer.mjs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SOURCE = read('src/fleet/host/xo-deploy.js');
const config = JSON.parse(read('renovate.json'));

test('Renovate can see the installer’s commit, and it is the one the deploy fetches', () => {
  const managers = config.customManagers.filter((/** @type {any} */ m) => m.managerFilePatterns.some((/** @type {string} */ p) => p.includes('xo-deploy')));
  assert.equal(managers.length, 1, 'renovate.json does not read src/fleet/host/xo-deploy.js');
  const m = new RegExp(managers[0].matchStrings[0]).exec(SOURCE);
  assert.ok(m?.groups, 'the custom manager matches nothing in xo-deploy.js');
  assert.deepEqual([m.groups.datasource, m.groups.packageName, m.groups.currentValue], ['git-refs', `https://github.com/${INSTALLER.repository}`, 'master']);
  // Renovate writes the name into its commit subject. Named by its URL it was
  // 92 characters, and commitlint (header-max-length, 80) failed every bump.
  const subject = `chore(deps): update ${m.groups.depName} digest to ${INSTALLER.commit.slice(0, 7)}`;
  assert.ok(subject.length <= 80, `Renovate's subject for the installer would be ${subject.length} characters: ${subject}`);
  assert.equal(m.groups.currentDigest, INSTALLER.commit, 'Renovate would move a commit the deploy does not read');
  // Proposed without a date, which git-refs never has; the script keeps the soak.
  const rule = config.packageRules.find((/** @type {any} */ r) => r.matchDepNames?.includes(m.groups?.depName));
  assert.equal(rule?.minimumReleaseAgeBehaviour, 'timestamp-optional');
  assert.match(rule.prBodyNotes.join('\n'), /node scripts\/pin-xo-installer\.mjs/);
  // The fork has no releases, so Renovate finds no notes: the diff is linked
  // instead, and it is what has to be read before a root script is pinned.
  assert.ok(rule.prBodyNotes.join('\n').includes(`https://github.com/${INSTALLER.repository}/compare/{{{currentDigest}}}...{{{newDigest}}}`), 'the installer\u2019s pull request does not link what changed upstream');
});

test('the pinned files are the named commit’s', () => {
  // What a Renovate pull request fails on until the script has run.
  assert.equal(INSTALLER.base, baseFor(INSTALLER.repository, INSTALLER.commit), `INSTALLER names ${INSTALLER.commit.slice(0, 7)} and its files are another commit's: run \`node scripts/pin-xo-installer.mjs\` and commit what it writes`);
  for (const [name, sha] of Object.entries(INSTALLER.files)) assert.match(sha, /^[0-9a-f]{64}$/, name);
  assert.equal(MAX_FILE, 2 * 1024 * 1024, 'the script holds files to what the deploy takes (MAX_FILE in xo-deploy.js)');
  assert.match(SOURCE, /const MAX_FILE = 2 \* 1024 \* 1024;/);
});

test('the script writes the base and every file’s digest, and nothing else', () => {
  const base = baseFor(INSTALLER.repository, 'f'.repeat(40));
  const files = Object.fromEntries(Object.keys(INSTALLER.files).map((name, i) => [name, String(i).repeat(64)]));
  const out = writeInstallerPin(SOURCE, base, files);
  const before = SOURCE.split('\n');
  const changed = out.split('\n').filter((line, i) => line !== before[i]);
  assert.deepEqual(changed, [`  base: '${base}',`, ...Object.entries(files).map(([name, sha]) => `    '${name}': '${sha}',`)]);
  assert.throws(() => writeInstallerPin(SOURCE, base, { 'xo-install.sh': 'a'.repeat(64) }), /not the ones INSTALLER lists/, 'a file dropped is a deploy that fetches what nothing checks');
  assert.throws(() => writeInstallerPin('const nothing = 1;', base, files), /not where this script expects it/);
});
