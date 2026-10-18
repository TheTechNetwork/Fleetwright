// A box installed from the deb is updated by apt, and only by apt.
//
// The failure these guard against is two updaters on one box: a manifest check
// that offers a release apt has not been given yet, installs it, and is then
// undone by the next apt upgrade. Every answer about releases on such a box has
// to come from apt — including "nothing waiting", which is a claim and needs
// apt behind it (C-5).

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAptPolicy, checkAptRelease } from '../src/core/apt-release.js';
import { checkRelease } from '../src/core/release-check.js';
import { dispatch } from '../src/adapters/commands.js';
import { aptBox, POLICY } from './helpers/apt-box.js';
import { readChannel } from '../src/core/channel.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ok = (stdout) => () => ({ status: 0, stdout, stderr: '' });

test('apt-cache policy: both versions, and (none) is not a version', () => {
  assert.deepEqual(parseAptPolicy(POLICY('0.2.3', '0.2.4')), { installed: '0.2.3', candidate: '0.2.4' });
  assert.deepEqual(parseAptPolicy(POLICY('(none)', '0.2.4')), { installed: null, candidate: '0.2.4' });
  assert.deepEqual(parseAptPolicy(''), { installed: null, candidate: null });
});

test('a newer candidate is waiting, and says Apply update installs the package alone', () => {
  const r = checkAptRelease({ exec: ok(POLICY('0.2.3', '0.2.4')) });
  assert.equal(r.available, '0.2.4');
  assert.equal(r.ok, true);
  assert.equal(r.configured, true);
  // NOT /upgrade: that is the operating system, and it took the kernel along
  // to move this one package.
  assert.match(r.message, /\/update --apply/);
  assert.doesNotMatch(r.message, /\/upgrade/);
});

test('an older candidate, which the way back to stable pins, is not waiting and offers nothing to apply', () => {
  // apt 2.8's own output on a box moved back from rolling: the pin makes the
  // last release the candidate, below the build of main installed. The package
  // unit's `apt-get -y install --only-upgrade` answers that with "Packages were
  // downgraded and -y was used without --allow-downgrades" and installs
  // nothing, so "waiting" and "Apply update installs" were both untrue.
  const policy =
    'fleetwright:\n  Installed: 0.4.13~main.5\n  Candidate: 0.4.12\n  Version table:\n' +
    ' *** 0.4.13~main.5 100\n        100 /var/lib/dpkg/status\n' +
    '     0.4.12 1001\n        500 https://apt.fleetwright.example stable/main all Packages\n';
  const r = checkAptRelease({ exec: ok(policy) });
  assert.equal(r.available, null, 'nothing Apply update would install');
  assert.equal(r.ok, true);
  assert.match(r.message, /0\.4\.13~main\.5 is a build of main, newer than 0\.4\.12/);
  assert.match(r.message, /stays on it until a newer release is published/);
  assert.doesNotMatch(r.message, /waiting|--apply/);
  // And the same two versions the other way up are an ordinary upgrade.
  const up = 'fleetwright:\n  Installed: 0.4.12\n  Candidate: 0.4.13\n  Version table:\n     0.4.13 500\n        500 https://apt.fleetwright.example stable/main all Packages\n *** 0.4.12 100\n        100 /var/lib/dpkg/status\n';
  assert.equal(checkAptRelease({ exec: ok(up) }).available, '0.4.13');
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

test('/update on an apt box reports apt, and offers the package install only when it may run it', async () => {
  const box = aptBox(POLICY('0.2.3', '0.2.4'));
  try {
    const base = { installDir: box.dir, releaseSource: 'apt', releaseManifest: '', runUser: 'agent' };
    const granted = await dispatch(/** @type {any} */ ({ cfg: { ...base, systemUpgrade: true } }), '/update --check');
    assert.match(granted.text, /installed from apt/);
    assert.match(granted.text, /0\.2\.4 is waiting/);
    // THE PACKAGE'S OWN DOOR, named by version, not the system upgrade.
    assert.deepEqual(granted.buttons?.map((b) => [b.label, b.command]), [['Install 0.2.4', '/update --apply']]);
    // ASKED APT AFTER APT FETCHED. The candidate is only as new as the
    // package lists, and a person typing /update is asking now: the lists
    // refresh (the unit, through sudo) is spawned before apt-cache is read,
    // whatever the lists' age. The afternoon this was wrong, a box on 0.4.0
    // answered "0.4.0 is the newest in apt" for hours after 0.4.1 was
    // published, because its lists were younger than the six-hour gate.
    const calls = box.calls();
    const fetched = calls.findIndex((c) => /^sudo .*systemctl start fleetwright-apt-update\.service$/.test(c));
    const asked = calls.findIndex((c) => c.startsWith('apt-cache policy'));
    assert.ok(fetched >= 0, `the lists were not refreshed:\n${calls.join('\n')}`);
    assert.ok(asked > fetched, `apt was asked before its lists were fetched:\n${calls.join('\n')}`);

    // C-2: no button for an action this box has not been allowed to take —
    // and asked anyway, the apply explains the grant rather than doing nothing.
    const refused = await dispatch(/** @type {any} */ ({ cfg: { ...base, systemUpgrade: false } }), '/update --check');
    assert.equal(refused.buttons, undefined);
    const applied = await dispatch(/** @type {any} */ ({ cfg: { ...base, systemUpgrade: false } }), '/update --apply');
    assert.equal(applied.ok, false);
    assert.match(applied.text, /installed from apt/);
    assert.match(applied.text, /System upgrades are off/);
    assert.match(applied.text, /fleetwright-package-upgrade\.service/);
  } finally {
    box.done();
  }
});

test('/channel on an apt box without the upgrade grant: stable, pinned, and rolling refused with the way to get it', async () => {
  // Moving the suite is a unit the upgrade grant lets the hub start
  // (test/apt-channel.test.js); without the grant there is no way from here,
  // and the answer says which command gives it rather than offering a picker
  // that would be refused.
  const cfg = /** @type {any} */ ({ releaseSource: 'apt' });
  const asked = await dispatch({ cfg }, '/channel');
  assert.equal(asked.channel, 'stable');
  assert.equal(asked.channelPinned, true);
  assert.match(asked.text, /grant upgrades on/);

  const rolling = await dispatch({ cfg }, '/channel rolling');
  assert.equal(rolling.ok, false);
  assert.match(rolling.text, /grant upgrades on/);
});

test('/channel on a machine made from an image built from main: rolling, read from its apt line, pinned without the grant', async () => {
  // The machine image writes the suite into the apt line every clone keeps
  // (vm-image.js), so that line is what the next upgrade installs from and the
  // one place the answer cannot drift from it.
  const dir = mkdtempSync(path.join(tmpdir(), 'fw-apt-'));
  try {
    const list = path.join(dir, 'fleetwright.list');
    writeFileSync(list, 'deb [arch=amd64 signed-by=/usr/share/keyrings/fleetwright.gpg] https://fleet-apt.thetech.network rolling main\n');
    const cfg = /** @type {any} */ ({ releaseSource: 'apt', aptSources: list });
    const asked = await dispatch({ cfg }, '/channel');
    assert.equal(asked.channel, 'rolling');
    assert.equal(asked.channelPinned, true);
    assert.match(asked.text, /rolling suite: the newest build of main/);
    assert.equal(readChannel(cfg), 'rolling', 'health says what /channel says');
    const back = await dispatch({ cfg }, '/channel stable');
    assert.equal(back.ok, false);
    assert.match(back.text, /grant upgrades on/);
    // An unreadable line is stable, the only suite the package itself writes.
    assert.equal(readChannel(/** @type {any} */ ({ releaseSource: 'apt', aptSources: path.join(dir, 'missing') })), 'stable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
