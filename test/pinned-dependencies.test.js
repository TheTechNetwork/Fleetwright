// Every dependency names an exact version.
//
// A caret is not a smaller pin — it is a different thing entirely. It moves
// the decision out of package.json and into whatever the lock file happened to
// resolve, and the manifest keeps claiming the old number:
//
//     worker/package.json   "wrangler": "^4.0.0"
//     worker/package-lock   wrangler 4.127.1
//
// A hundred and twenty-seven minor versions, none of which appeared in a PR
// title, in a file that still said 4.0.0. That is the failure this guards, and
// it is the same shape as everything else in this repo: TRUE WHERE IT WAS
// WRITTEN, QUIETLY FALSE ONE FILE OVER.
//
// It also removes a real class of "works on my machine": with a range,
// `npm ci` and `npm install` can install different trees from the same commit.
// With a pin they cannot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

/** Every manifest in the repo. Two today; the test finds them by name, not by count. */
const MANIFESTS = [
  ['package.json', 'package-lock.json'],
  ['worker/package.json', 'worker/package-lock.json'],
];

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

// An exact semver version and nothing else: no ^, no ~, no >=, no *, no range
// with a space in it, no `latest`. Prerelease and build metadata are allowed —
// they are still exactly one version.
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

test('no dependency is declared as a range', () => {
  for (const [manifest] of MANIFESTS) {
    const pkg = read(manifest);
    for (const section of SECTIONS) {
      for (const [name, declared] of Object.entries(pkg[section] ?? {})) {
        assert.match(
          declared,
          EXACT,
          `${manifest} declares ${name} as "${declared}" — pin it to one version`,
        );
      }
    }
  }
});

test('what the manifest claims is what the lock installs', () => {
  // The two halves of the same promise. A pin in package.json that the lock
  // resolves differently is worse than a range, because it reads as certainty.
  for (const [manifest, lockfile] of MANIFESTS) {
    const pkg = read(manifest);
    const lock = read(lockfile);
    for (const section of SECTIONS) {
      for (const [name, declared] of Object.entries(pkg[section] ?? {})) {
        const installed = lock.packages[`node_modules/${name}`];
        assert.ok(installed, `${lockfile} has no entry for ${name}`);
        assert.equal(
          installed.version,
          declared,
          `${manifest} says ${name} ${declared}, ${lockfile} installs ${installed.version}`,
        );
      }
    }
  }
});

test('the lock repeats the manifest exactly, so npm ci cannot refuse', () => {
  // This assertion is the reason the file exists in this form. The obvious way
  // to check it is `npm ci --dry-run`, which DELETES node_modules before it
  // runs — `--dry-run` does not stop that — so the command that looks like a
  // question is an action, and the answer arrives with the toolchain gone.
  // Reading the JSON costs nothing and removes nothing. See docs/dependencies.md.
  // package-lock.json carries its own copy of the root package's declarations.
  // If the two drift, `npm ci` exits rather than installing — which is correct
  // of it, and is a CI failure that reads as an npm problem rather than as a
  // hand-edited manifest.
  for (const [manifest, lockfile] of MANIFESTS) {
    const pkg = read(manifest);
    const root = read(lockfile).packages[''];
    for (const section of SECTIONS) {
      assert.deepEqual(
        root[section] ?? {},
        pkg[section] ?? {},
        `${lockfile} root ${section} disagrees with ${manifest}`,
      );
    }
  }
});

test('renovate is told to pin, so the next bot PR edits the manifest too', () => {
  // Without this, a bump that lands inside a range touches only the lock file
  // and the manifest silently goes stale — which is how ^4.0.0 outlived a
  // hundred releases. With it, every update is a two-file diff that says which
  // version this project now claims.
  const renovate = read('renovate.json');
  assert.equal(renovate.rangeStrategy, 'pin');
});
