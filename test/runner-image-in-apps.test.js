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

import { RUNNER_IMAGES, isLargerRunnerImage } from '../src/fleet/protocol/intents.js';

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

test('both phones offer a larger machine only when the fleet would take one, and say the same about it', () => {
  const YOU_IOS = read('apps/ios/Fleetwright/TemporaryMachinesView.swift');
  const YOU_ANDROID = read('apps/android/app/src/main/java/network/thetech/fleetwright/YouScreen.kt');
  const FLEET_IOS = read('apps/ios/Fleetwright/Fleet.swift');
  const FLEET_ANDROID = read('apps/android/app/src/main/java/network/thetech/fleetwright/Fleet.kt');

  // WHICH ARE LARGER: the protocol's rule, spelt the same on both phones, and
  // it picks out exactly the images the protocol calls larger.
  const larger = Object.values(RUNNER_IMAGES).flat().filter(isLargerRunnerImage);
  assert.deepEqual(larger, ['xcode-27-xlarge', 'macos-26-xlarge']);
  assert.match(IOS, /image\.hasSuffix\("-xlarge"\) \|\| image\.hasSuffix\("-large"\)/);
  assert.match(ANDROID, /image\.endsWith\("-xlarge"\) \|\| image\.endsWith\("-large"\)/);

  // OFFERED ONLY WHEN TAKEN (C-2): the image list drops them unless the
  // snapshot says a larger machine would be taken now, and that is read from
  // `runners.large`, nowhere else.
  assert.match(IOS, /largeRunners \|\| !isLargerRunnerImage\(\$0\.image\)/);
  assert.match(ANDROID, /largeRunners \|\| !isLargerRunnerImage\(it\.image\)/);
  assert.match(IOS, /largeRunners = runnersNow\?\.large == true/);
  assert.match(ANDROID, /largeRunners = runnersNow\?\.large == true/);
  assert.match(FLEET_ANDROID, /optBoolean\("large", false\)/);

  // THE SETTING, said where it is kept, through the route that keeps it.
  assert.match(FLEET_IOS, /send\("PUT", "\/api\/runner-repo\/large", body: \["allow": allow\]\)/);
  assert.match(FLEET_ANDROID, /send\("PUT", "\/api\/runner-repo\/large", JSONObject\(\)\.put\("allow", allow\)\)/);
  for (const [name, src] of [['iOS', YOU_IOS], ['Android', YOU_ANDROID]]) {
    assert.match(src, /"Larger machines"/, name);
    assert.match(src, /"Allow larger machines"/, name);
  }
  // The same sentences on both, the switch's and the fleet's.
  const sentence = /GitHub's larger macOS machines, 5 cores and 14 GB instead of 3 and 7, are billed by the minute to [^"]+'s owner on every plan\. (?:" \+\s*")?Off, New session does not offer them and the fleet refuses one\./;
  assert.match(YOU_IOS, sentence);
  assert.match(YOU_ANDROID, sentence);
  for (const words of ["may be GitHub's larger ones, which its operator allowed.", 'are standard ones. Its operator decides about larger ones, since the fleet pays for them.']) {
    assert.ok(YOU_IOS.includes(words) && YOU_ANDROID.includes(words), words);
  }
});
