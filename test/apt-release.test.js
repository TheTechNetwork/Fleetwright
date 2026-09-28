// A box installed from the deb is updated by apt, and only by apt.
//
// The failure these guard against is two updaters on one box: a manifest check
// that offers a release apt has not been given yet, installs it, and is then
// undone by the next apt upgrade. Every answer about releases on such a box has
// to come from apt — including "nothing waiting", which is a claim and needs
// apt behind it (C-5).

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseAptPolicy, checkAptRelease } from '../src/core/apt-release.js';
import { checkRelease } from '../src/core/release-check.js';
import { dispatch } from '../src/adapters/commands.js';

const POLICY = (installed, candidate) =>
  `fleetwright:\n  Installed: ${installed}\n  Candidate: ${candidate}\n  Version table:\n *** ${installed} 500\n`;

const ok = (stdout) => () => ({ status: 0, stdout, stderr: '' });

test('apt-cache policy: both versions, and (none) is not a version', () => {
  assert.deepEqual(parseAptPolicy(POLICY('0.2.3', '0.2.4')), { installed: '0.2.3', candidate: '0.2.4' });
  assert.deepEqual(parseAptPolicy(POLICY('(none)', '0.2.4')), { installed: null, candidate: '0.2.4' });
  assert.deepEqual(parseAptPolicy(''), { installed: null, candidate: null });
});

test('a newer candidate is waiting, and says it installs with the system updates', () => {
  const r = checkAptRelease({ exec: ok(POLICY('0.2.3', '0.2.4')) });
  assert.equal(r.available, '0.2.4');
  assert.equal(r.ok, true);
  assert.equal(r.configured, true);
  assert.match(r.message, /\/upgrade/);
});

test('installed is the candidate: up to date, and says as of when', () => {
  const r = checkAptRelease({ exec: ok(POLICY('0.2.4', '0.2.4')) });
  assert.equal(r.available, null);
  // ok: true — apt WAS asked and answered. This is the one case that may read
  // as "nothing waiting".
  assert.equal(r.ok, true);
  assert.match(r.message, /package lists/);
});

test('apt could not be asked: cannot tell, never up to date', () => {
  const r = checkAptRelease({ exec: () => ({ status: 100, stdout: '', stderr: 'E: lock held' }) });
  assert.equal(r.ok, false);
  assert.equal(r.available, null);
  assert.match(r.message, /lock held/);
});

test('the package is not installed on a box that says apt owns it: cannot tell', () => {
  const r = checkAptRelease({ exec: ok(POLICY('(none)', '0.2.4')) });
  assert.equal(r.ok, false, 'a package that is not there is not up to date');
  assert.match(r.message, /not installed/);
});

test('checkRelease asks apt, and never the manifest, on an apt box', async () => {
  let fetched = false;
  const r = await checkRelease(
    /** @type {any} */ ({ releaseSource: 'apt', releaseManifest: 'https://example.invalid/manifest.json' }),
    {
      fetch: /** @type {any} */ (async () => { fetched = true; throw new Error('should not fetch'); }),
      apt: () => ({ available: '9.9.9', configured: true, ok: true, reason: 'apt', message: 'from apt' }),
    },
  );
  assert.equal(fetched, false, 'a manifest was fetched on a box apt owns');
  assert.equal(r.available, '9.9.9');
});

/** A packaged install dir, and an apt-cache on PATH that answers `policy`. */
function aptBox(policy) {
  const dir = mkdtempSync(path.join(tmpdir(), 'apt-box-'));
  mkdirSync(path.join(dir, 'lib'));
  writeFileSync(path.join(dir, 'lib', 'agent-hub.mjs'), '');
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'apt-cache'), `#!/bin/sh\ncat <<'EOF'\n${policy}EOF\n`);
  chmodSync(path.join(bin, 'apt-cache'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  return {
    dir,
    done() {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('/update on an apt box reports apt, and offers /upgrade only when it may run it', async () => {
  const box = aptBox(POLICY('0.2.3', '0.2.4'));
  try {
    const base = { installDir: box.dir, releaseSource: 'apt', releaseManifest: '' };
    const granted = await dispatch(/** @type {any} */ ({ cfg: { ...base, systemUpgrade: true } }), '/update --check');
    assert.match(granted.text, /installed from apt/);
    assert.match(granted.text, /0\.2\.4 is waiting/);
    assert.deepEqual(granted.buttons?.map((b) => b.command), ['/upgrade']);

    // C-2: no button for an action this box has not been allowed to take.
    const refused = await dispatch(/** @type {any} */ ({ cfg: { ...base, systemUpgrade: false } }), '/update --check');
    assert.equal(refused.buttons, undefined);
  } finally {
    box.done();
  }
});

test('/channel on an apt box: stable, pinned, and rolling refused with the way to get it', async () => {
  const cfg = /** @type {any} */ ({ releaseSource: 'apt' });
  const asked = await dispatch({ cfg }, '/channel');
  assert.equal(asked.channel, 'stable');
  assert.equal(asked.channelPinned, true);

  const rolling = await dispatch({ cfg }, '/channel rolling');
  assert.equal(rolling.ok, false);
  assert.match(rolling.text, /one-line installer/);
});
