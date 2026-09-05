// Where a release lives, seen from the two places it can be seen from.
//
// FROM THE FIRST HOST EVER TO RUN A RELEASE, asked for an update:
//
//   Fleetwright: /opt/fleetwright/releases/main-55 is not a release layout,
//   so there is no symlink to swap.
//
// about a box laid out exactly as intended. The check required
// `basename === 'current'`, which a RUNNING box can never satisfy: INSTALL_ROOT
// is derived from import.meta.url and node resolves symlinks, so a service
// started as `<base>/current/lib/agent-hub.mjs` reports its root as
// `<base>/releases/<version>`.
//
// The check was written about the path the units name. The code reads the path
// node resolved. Which means updating by manifest — the entire point of
// packaging — could never have worked on any box, and nothing noticed because
// no box had ever got far enough to ask.

import test from 'node:test';
import assert from 'node:assert/strict';

import { releaseLayout } from '../src/core/release-apply.js';

test('both names for the same directory resolve to the same base', () => {
  // The symlink, which is what the systemd unit names.
  assert.deepEqual(releaseLayout('/opt/fleetwright/current'), { ok: true, base: '/opt/fleetwright' });

  // And where it resolves to, which is what a running process reports. This is
  // the one that failed.
  assert.deepEqual(releaseLayout('/opt/fleetwright/releases/main-55'), { ok: true, base: '/opt/fleetwright' });
  assert.deepEqual(releaseLayout('/opt/fleetwright/releases/v0.2.3'), { ok: true, base: '/opt/fleetwright' });

  // Same base from both, because it IS the same layout — and the base is what
  // decides where the next release is unpacked and which symlink is swapped.
});

test('a checkout is still refused, and says what to do', () => {
  // The refusal has to survive, or a git box would be told to swap a symlink
  // it does not have. It is the message that sends somebody to the installer.
  const r = releaseLayout('/opt/agent-fleet');
  assert.equal(r.ok, false);
  assert.match(r.message, /not a release layout/);
  assert.match(r.message, /<base>\/current -> releases\/<version>/);
});

test('a directory that merely looks similar is not a layout', () => {
  // `releases` itself, and a release-shaped path with nothing above it. Being
  // generous here would mean unpacking the next release somewhere invented.
  for (const dir of ['/tmp/x/releases', '/releases/v1', '/current', '/']) {
    assert.equal(releaseLayout(dir).ok, false, `${dir} was accepted as a layout`);
  }
});

test('the two shapes agree about where the next release goes', async () => {
  // THE PROPERTY THAT MATTERS, rather than the string. Whichever way a box
  // names itself, the update it takes must land in the same place and swap the
  // same symlink — otherwise a host would install into one tree and keep
  // running from another.
  const { releasePaths } = await import('../src/core/release.js');
  const viaLink = releaseLayout('/opt/fleetwright/current');
  const viaReal = releaseLayout('/opt/fleetwright/releases/main-55');
  assert.ok(viaLink.ok && viaReal.ok);
  assert.deepEqual(releasePaths(viaLink.base, 'v9'), releasePaths(viaReal.base, 'v9'));
});
