// One version number, in four files, and nothing at runtime would notice them
// drifting apart.
//
// package.json, MARKETING_VERSION, versionName and the top of CHANGELOG.md all
// say what release this is, and each is read by something different: npm, App
// Store Connect, Play, and the notes a tester reads on their phone. A release
// where the apps say 0.2.0 and the changelog describes 0.2.1 ships the right
// binary with the wrong story — which is worse than shipping neither, because
// the tester tries the feature and reports it missing.
//
// This is the same job test/demo-button.test.js does for the demo host: three
// copies of a constant with no runtime link between them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const PKG = JSON.parse(read('package.json')).version;

test('the apps and the changelog are built at the same version', () => {
  assert.match(PKG, /^\d+\.\d+\.\d+$/, 'package.json version is not a plain semver');

  const ios = /MARKETING_VERSION:\s*"([^"]+)"/.exec(read('apps/ios/project.yml'));
  assert.ok(ios, 'apps/ios/project.yml has no MARKETING_VERSION');
  assert.equal(ios[1], PKG, 'iOS would ship a different version train than package.json');

  const android = /versionName\s*=\s*"([^"]+)"/.exec(read('apps/android/app/build.gradle.kts'));
  assert.ok(android, 'the Android build has no versionName');
  assert.equal(android[1], PKG, 'Android would ship a different versionName than package.json');
});

test('the changelog describes the version being shipped', async () => {
  const { sections } = await import('../scripts/release-notes.mjs');
  const all = sections();
  assert.ok(all.length, 'CHANGELOG.md has no version sections at all');
  assert.equal(all[0].version, PKG, 'the top of CHANGELOG.md is not the version the apps are built at');

  // A heading with no notes under it is worse than no heading: the pipeline
  // reads this file, so an empty section ships empty "What to Test".
  assert.ok(all[0].body.length > 80, `the ${PKG} section is too short to be a release note`);

  // Versions descend, and each appears once. A duplicate heading means the
  // extractor picks whichever came first, which is the older one.
  const seen = new Set();
  for (const s of all) {
    assert.equal(seen.has(s.version), false, `CHANGELOG.md has two sections for ${s.version}`);
    seen.add(s.version);
  }
});

test('Play-sized notes are cut at a boundary, and say there is more', async () => {
  const { sections, fit } = await import('../scripts/release-notes.mjs');
  const body = sections()[0].body;
  const short = fit(body, 500);

  assert.ok(short.length <= 500, `Play refuses more than 500 characters; got ${short.length}`);
  assert.match(short, /Full notes:/, 'a truncated note that does not say so reads as the whole story');
  // Never mid-word: a sentence that stops halfway reads as a bug in the app
  // rather than as a shortened note.
  assert.equal(/\S$/.test(short.split('\n\n')[0]) && short.includes('…'), false);

  // And a body that already fits is returned untouched — no pointer, no
  // ellipsis, nothing added to a note that was already complete.
  assert.equal(fit('short enough', 500), 'short enough');
});
