// Unset means everybody, and it meant nobody in every release ever published.
//
// The manifest for v0.2.3, fetched from the address every host polls:
//
//   { "version": "v0.2.3", "protocol": 3, "prerelease": false, "rollout": 0 }
//
// `rollout: 0` is what decideRelease reads as "this release is for nobody". So
// the release that exists to fix the installer could not be installed by the
// update path, and neither could v0.2.2, and neither could any rolling build.
//
// The cause is one of the oldest shapes there is. The builder had:
//
//   Number(process.env.RELEASE_ROLLOUT ?? 1) || 0
//
// `?? 1` handles an ABSENT variable. The workflow passes
// `${{ vars.RELEASE_ROLLOUT }}`, and an unset repository variable expands to
// the EMPTY STRING — present, so `??` never fires; `Number('')` is 0; `|| 0`
// keeps it. Absent and empty are not the same thing, and only one of them was
// thought about.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { rolloutFraction } from '../tools/rollout.mjs';
import { decideRelease } from '../src/core/release.js';

test('every way of saying nothing means everybody', () => {
  // THE BUG, as three inputs. An unset variable in a shell is undefined; the
  // same variable through GitHub Actions is ''; and a human might leave a
  // space. All three are "nobody configured a rollout".
  assert.equal(rolloutFraction(undefined), 1);
  assert.equal(rolloutFraction(''), 1);
  assert.equal(rolloutFraction('   '), 1);
});

test('a real fraction survives, and is clamped to what it can mean', () => {
  assert.equal(rolloutFraction('0.25'), 0.25);
  assert.equal(rolloutFraction('1'), 1);
  // Zero is a legitimate answer — "built, published, nobody takes it yet" — and
  // has to stay reachable, because the fix is not "0 is impossible", it is
  // "empty is not 0".
  assert.equal(rolloutFraction('0'), 0);
  assert.equal(rolloutFraction('9'), 1);
  assert.equal(rolloutFraction('-2'), 0);
});

test('a typo fails open', () => {
  // DELIBERATE DIRECTION. The failure this replaces was silent and total: a
  // fleet that stops updating and answers "not in that group yet", which reads
  // as a rollout somebody chose. A mistyped repository variable must not be
  // able to do that again.
  assert.equal(rolloutFraction('abc'), 1);
  assert.equal(rolloutFraction('NaN'), 1);
});

test('the manifest a default build writes reaches a host', () => {
  // END TO END, against the function that actually decides. This is the
  // assertion that would have failed the day the builder shipped: a release
  // built with nothing configured must be installable by a host that wants it.
  const manifest = {
    version: 'v0.2.4',
    file: 'fleetwright-host-v0.2.4.tar.gz',
    sha256: 'a'.repeat(64),
    protocol: 3,
    prerelease: false,
    rollout: rolloutFraction(process.env.NOTHING_IS_SET_HERE),
  };
  const r = decideRelease({ manifest, installed: 'v0.2.3', protocol: 3, hostKey: 'vnic-runner-oci' });
  assert.equal(r.act, true, r.act === false ? r.message : '');

  // And the shape that was published: still refused, because that is correct
  // behaviour for a release somebody deliberately sent to nobody.
  const none = decideRelease({
    manifest: { ...manifest, rollout: 0 },
    installed: 'v0.2.3',
    protocol: 3,
    hostKey: 'vnic-runner-oci',
  });
  assert.equal(none.act, false);
  assert.equal(none.reason, 'rollout');
});

test('the builder reads the rule from one place', () => {
  // A second copy of this arithmetic inside build-host-package.mjs is how the
  // tested version and the shipped version stop being the same one.
  const build = readFileSync(new URL('../tools/build-host-package.mjs', import.meta.url), 'utf8');
  assert.match(build, /rollout: rolloutFraction\(process\.env\.RELEASE_ROLLOUT\)/);
  assert.doesNotMatch(build, /Number\(process\.env\.RELEASE_ROLLOUT/);
});
