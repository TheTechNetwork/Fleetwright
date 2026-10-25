// Both phones offer the runner images the protocol takes, in its order, with
// the same words, and send one only when somebody chose it.
//
//   node --test test/runner-image-in-apps.test.js
//
// A read of the sources, not a run: the Swift and the Kotlin compile only in
// CI. What a run there cannot check is that a phone offers an image the
// coordinator refuses, or leaves out the one a person came for (xcode-27,
// the only macOS image with the iPhone Duo simulator), or that the two
// phones disagree on the order and so on which is the default.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RUNNER_IMAGES } from '../src/fleet/protocol/intents.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const IOS = read('apps/ios/Fleetwright/StartSheet.swift');
const ANDROID = read('apps/android/app/src/main/java/network/thetech/fleetwright/StartSheet.kt');

/**
 * One platform's list as a phone spells it, image and label, in order: from
 * its key to the next platform's key.
 * @param {string} source @param {RegExp} entry @param {string} platform
 */
function offered(source, entry, platform) {
  const key = (/** @type {string} */ p) => new RegExp(`"${p}"\\s*(?::|to)\\s*(?:\\[|listOf\\()`);
  const at = source.search(key(platform));
  assert.notEqual(at, -1, `no image list for ${platform}`);
  const rest = source.slice(at + 1);
  const next = Math.min(...Object.keys(RUNNER_IMAGES).map((p) => rest.search(key(p))).filter((i) => i > 0), 600);
  return [...rest.slice(0, next).matchAll(entry)].map((m) => ({ image: m[1], label: m[2] }));
}

test('both phones offer exactly the protocol’s images, newest first, in the same words', () => {
  for (const [platform, images] of Object.entries(RUNNER_IMAGES)) {
    const ios = offered(IOS, /RunnerImageChoice\(image: "([^"]+)", label: "([^"]+)"\)/g, platform);
    const android = offered(ANDROID, /RunnerImageChoice\("([^"]+)", "([^"]+)"\)/g, platform);
    assert.deepEqual(ios.map((c) => c.image), [...images], `iOS, ${platform}`);
    assert.deepEqual(android, ios, `Android and iOS disagree on ${platform}`);
  }
  // And the first is called the newest on both, which is what it is.
  assert.match(IOS, /\(newest\)/);
  assert.match(ANDROID, /\(newest\)/);
});
