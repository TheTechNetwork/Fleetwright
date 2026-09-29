// The upgrade runs in a unit of its own, and the hub may only start it.
//
//   node --test test/
//
// docs/recommendations-review.md §7: fleetwright.service could not keep
// ProtectSystem while its grant was `apt-get -y upgrade`, because sudo does
// not escape the hub's mount namespace and an upgrade cannot live inside one.
// The way out the unit named — a oneshot with no sandboxing, and a grant to
// start it and nothing else — is what these tests pin: the units are ones
// systemd accepts, the grant is one visudo accepts, and upgrades.js tries the
// unit first and still works on a box whose grant predates it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runUpgrade, runPackageUpgrade, refreshPackageLists, plannedUpgrades, parseUpgradable, UPGRADE_UNIT, APT_UPDATE_UNIT, PACKAGE_UPGRADE_UNIT } from '../src/core/upgrades.js';

const here = (/** @type {string} */ p) => new URL(`../${p}`, import.meta.url).pathname;
const has = (/** @type {string} */ bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0;

const UNITS = ['install/fleetwright-upgrade.service', 'install/fleetwright-apt-update.service', 'install/fleetwright-package-upgrade.service'];

test('all three units are ones systemd will load, and none takes an argument', (t) => {
  for (const unit of UNITS) {
    const text = readFileSync(here(unit), 'utf8');
    assert.match(text, /^Type=oneshot$/m, unit);
    assert.match(text, /^User=root$/m, unit);
    assert.match(text, /^ExecStart=\/usr\/bin\/apt-get /m, unit);
    // No sandboxing directive at all: rewriting /usr, /etc and /boot is what
    // an upgrade IS, and the unit exists so the hub's own protections do not
    // apply to it.
    assert.doesNotMatch(text, /^Protect|^Private|^NoNewPrivileges|^Restrict/m, `${unit} sandboxes the thing that must not be sandboxed`);
    // The noninteractive flags live here now, not in a sudoers env_keep.
    if (unit.includes('-upgrade')) {
      assert.match(text, /--force-confold/);
      assert.match(text, /--force-confdef/);
      assert.match(text, /^Environment=DEBIAN_FRONTEND=noninteractive$/m);
    }
  }
  // THE PACKAGE'S OWN DOOR names fleetwright and nothing the hub could widen.
  const pkg = readFileSync(here('install/fleetwright-package-upgrade.service'), 'utf8');
  assert.match(pkg, /^ExecStart=\/usr\/bin\/apt-get .* install --only-upgrade fleetwright$/m);
  // AND THE SYSTEM DOOR HOLDS IT for the run, letting go afterwards whether
  // apt-get succeeded or not, and keeping a hold the operator set themselves.
  const sys = readFileSync(here('install/fleetwright-upgrade.service'), 'utf8');
  assert.match(sys, /^ExecStartPre=-\/bin\/sh -c '.*apt-mark hold fleetwright/m);
  assert.match(sys, /^ExecStartPre=-.*apt-mark showhold .*touch \/run\/fleetwright-upgrade\.held/m);
  assert.match(sys, /^ExecStopPost=-\/bin\/sh -c '.*apt-mark unhold fleetwright/m);
  assert.match(sys, /^ExecStopPost=-.*fleetwright-upgrade\.held .*rm -f/m, 'a hold the operator set is kept');
  assert.match(sys, /^ExecStart=\/usr\/bin\/apt-get .* upgrade$/m);
  if (!has('systemd-analyze')) return t.skip('no systemd-analyze on this box');
  const r = spawnSync('systemd-analyze', ['verify', ...UNITS.map(here)], { encoding: 'utf8' });
  assert.equal(r.status, 0, `systemd-analyze verify: ${r.stderr}${r.stdout}`);
});

test('the grant the installer writes is one visudo accepts, and names only the three units', (t) => {
  const installer = readFileSync(here('install/install.sh'), 'utf8');
  const fn = /write_upgrade_sudoers\(\) \{[\s\S]*?\n\}/.exec(installer)?.[0] ?? '';
  assert.ok(fn, 'write_upgrade_sudoers is gone');
  assert.match(fn, /systemctl start fleetwright-upgrade\.service/);
  assert.match(fn, /systemctl start fleetwright-apt-update\.service/);
  // --no-block IS PART OF THE GRANT: the package unit restarts the hub that
  // starts it, and sudo matches the whole argv, so the waiting form is not
  // permitted at all.
  assert.match(fn, /systemctl start --no-block fleetwright-package-upgrade\.service/);
  assert.match(installer, /install_unit fleetwright-package-upgrade/, 'the grant names a unit the installer does not install');
  assert.doesNotMatch(fn, /printf '[^']*apt-get/, 'an apt-get line is back in the grant');
  assert.doesNotMatch(fn, /env_keep/, 'DEBIAN_FRONTEND rides in the unit now, not through sudo');

  if (!has('visudo')) return t.skip('no visudo on this box');
  // The exact line the installer prints, with a real user name substituted.
  const dir = mkdtempSync(path.join(tmpdir(), 'sudoers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fleetwright-upgrade');
  writeFileSync(
    file,
    `agent ALL=(root) NOPASSWD: /usr/bin/systemctl start ${UPGRADE_UNIT}, /usr/bin/systemctl start ${APT_UPDATE_UNIT}, /usr/bin/systemctl start --no-block ${PACKAGE_UPGRADE_UNIT}\n`,
  );
  const r = spawnSync('visudo', ['-cf', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, `visudo: ${r.stderr}${r.stdout}`);
});

/**
 * A stand-in for spawning: answers each argv from a script and records it.
 * @param {Array<{ match: RegExp, status: number, stdout?: string, stderr?: string }>} script
 */
function fakeExec(script) {
  /** @type {string[]} */
  const calls = [];
  const exec = (/** @type {string[]} */ argv) => {
    const line = argv.join(' ');
    calls.push(line);
    const hit = script.find((s) => s.match.test(line));
    if (!hit) return { status: 0, stdout: '', stderr: '' };
    return { status: hit.status, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' };
  };
  return { exec, calls };
}

const cfg = /** @type {any} */ ({ systemUpgrade: true, runUser: 'agent' });
const waiting = () => ({ supported: true, count: 2, security: 1, rebootRequired: false, packages: ['a', 'b'] });
const done = () => ({ supported: true, count: 0, security: 0, rebootRequired: false, packages: [] });

test('the upgrade starts the unit, and nothing else, when the grant allows it', () => {
  const { exec, calls } = fakeExec([]);
  let n = 0;
  const r = runUpgrade(cfg, { exec, updates: () => (n++ === 0 ? waiting() : done()) });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(calls, [`sudo -n /usr/bin/systemctl start ${UPGRADE_UNIT}`]);
  assert.match(r.text, /2 packages|Applied|a, b/i);
});

test('a box whose grant predates the unit falls back to the apt-get lines it is still permitted', () => {
  // sudo matches the whole command line, so a refusal of the unit start is
  // a clean signal that this box has the old rule — and refusing to upgrade
  // at all would be worse than upgrading the way it always has.
  const { exec, calls } = fakeExec([
    { match: /systemctl start/, status: 1, stderr: 'Sorry, user agent is not allowed to execute \'/usr/bin/systemctl start fleetwright-upgrade.service\' as root' },
    { match: /force-confold/, status: 1, stderr: 'Sorry, user agent is not allowed to execute' },
  ]);
  let n = 0;
  const r = runUpgrade(cfg, { exec, updates: () => (n++ === 0 ? waiting() : done()) });
  assert.equal(r.ok, true, r.text);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /systemctl start fleetwright-upgrade\.service$/);
  assert.match(calls[1], /apt-get -y -o Dpkg::Options::=--force-confold/);
  assert.equal(calls[2], 'sudo -n /usr/bin/apt-get -y upgrade');
});

test('a failed unit reports what apt said, read from the journal', () => {
  const { exec, calls } = fakeExec([
    { match: /systemctl start/, status: 1, stderr: 'Job for fleetwright-upgrade.service failed because the control process exited with error code.' },
    { match: /^journalctl/, status: 0, stdout: "dpkg: error processing archive\nunable to create '/etc/debian_version.dpkg-new': Read-only file system" },
  ]);
  const r = runUpgrade(cfg, { exec, updates: waiting });
  assert.equal(r.ok, false);
  assert.match(r.text, /Read-only file system/, 'the dpkg line, not only "job failed"');
  const journal = calls.find((c) => c.startsWith('journalctl'));
  assert.ok(journal, 'the journal was consulted');
  assert.match(journal, new RegExp(`-u ${UPGRADE_UNIT} --since -\\d+s --no-pager -o cat`));
  assert.equal(calls.some((c) => c.includes('apt-get')), false, 'a real failure is not a reason to try the old grant');
});

test('the package-list refresh takes the same shape: the unit first, the old line on refusal', () => {
  // listsAge is stubbed: the real one stats /var/lib/apt on the box running
  // the tests, and this test went red the moment `apt-get update` had run
  // there within six hours. A box's package state is not a fixture.
  const first = fakeExec([]);
  refreshPackageLists(cfg, { exec: first.exec, now: () => 1_000_000_000_000, listsAge: () => null });
  assert.deepEqual(first.calls, [`sudo -n /usr/bin/systemctl start ${APT_UPDATE_UNIT}`]);

  const second = fakeExec([{ match: /systemctl start/, status: 1, stderr: 'Sorry, user agent is not allowed to execute' }]);
  refreshPackageLists(cfg, { exec: second.exec, now: () => 2_000_000_000_000, listsAge: () => null });
  assert.deepEqual(second.calls, [
    `sudo -n /usr/bin/systemctl start ${APT_UPDATE_UNIT}`,
    'sudo -n /usr/bin/apt-get update',
  ]);
});

test('the package upgrade starts its unit without waiting, and says the box will come back', () => {
  const { exec, calls } = fakeExec([]);
  const r = runPackageUpgrade(cfg, { exec, version: '0.4.0', actor: 'fleet:eli' });
  assert.equal(r.ok, true, r.text);
  // --no-block: the package's postinst restarts the hub, so the hub must not
  // wait on the unit it just started.
  assert.deepEqual(calls, [`sudo -n /usr/bin/systemctl start --no-block ${PACKAGE_UPGRADE_UNIT}`]);
  assert.match(r.text, /Installing fleetwright 0\.4\.0 from apt/);
  assert.match(r.text, /restart themselves/);
});

test('a box whose grant predates the package unit is told the two ways out, and nothing else is tried', () => {
  const { exec, calls } = fakeExec([
    { match: /systemctl start --no-block/, status: 1, stderr: "Sorry, user agent is not allowed to execute '/usr/bin/systemctl start --no-block fleetwright-package-upgrade.service' as root" },
  ]);
  const r = runPackageUpgrade({ ...cfg, installDir: '/opt/fleetwright/current' }, { exec, version: '0.4.0' });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1, 'no apt-get fallback: there never was a grant for this one');
  assert.match(r.text, /install\.sh --repair/);
  assert.match(r.text, /apt install fleetwright/);
});

test('a package unit that fails to start reports what systemd said', () => {
  const { exec } = fakeExec([{ match: /systemctl start --no-block/, status: 1, stderr: 'Failed to start fleetwright-package-upgrade.service: Unit not found.' }]);
  const r = runPackageUpgrade(cfg, { exec });
  assert.equal(r.ok, false);
  assert.match(r.text, /Unit not found/);
  assert.match(r.text, /Installing fleetwright from apt|could not start/);
});

test('with upgrades off, the package upgrade gives the same instructions as the system one', () => {
  const off = /** @type {any} */ ({ systemUpgrade: false, runUser: 'agent' });
  const a = runPackageUpgrade(off, { exec: fakeExec([]).exec }).text;
  const b = runUpgrade(off, { exec: fakeExec([]).exec }).text;
  assert.equal(a, b);
  assert.match(a, new RegExp(`systemctl start --no-block ${PACKAGE_UPGRADE_UNIT}`));
  assert.match(a, /install\/fleetwright-package-upgrade\.service/);
});

test('the fleetwright package is not an operating-system update', () => {
  // On a box apt owns it sits in `apt list --upgradable` like any other, and
  // counting it made one release show up twice on a phone.
  const listing = [
    'Listing... Done',
    'fleetwright/stable 0.4.0 arm64 [upgradable from: 0.3.2]',
    'rpd-common/stable 1.31 arm64 [upgradable from: 1.18]',
    'libssl3/stable-security 3.0.2 arm64 [upgradable from: 3.0.1]',
  ].join('\n');
  assert.deepEqual(parseUpgradable(listing), { count: 2, security: 1, packages: ['rpd-common', 'libssl3'] });
  assert.deepEqual(parseUpgradable('Listing... Done\nfleetwright/stable 0.4.0 arm64 [upgradable from: 0.3.2]\n'), { count: 0, security: 0, packages: [] });
  // And the simulate the apply reply is built from leaves it out too: the
  // unit holds it, so it will not move, and the reply must not say it did.
  const plan = plannedUpgrades({
    hasAptGet: () => true,
    exec: () => ({ status: 0, stdout: 'Inst fleetwright [0.3.2] (0.4.0 Fleetwright:stable [arm64])\nInst curl [8.5.0-1] (8.6.0-2 Debian:13/stable [amd64])', stderr: '' }),
  });
  assert.deepEqual(plan.packages.map((p) => p.name), ['curl']);
});
