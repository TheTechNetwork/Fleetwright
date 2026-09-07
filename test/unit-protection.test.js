// Which of the three reasons /etc is read-only, asked of systemd.
//
// `etcMount` proves it is OURS. It cannot say WHICH, so the first version of
// that advice ended with two `systemctl show` lines and a trip to the box — on
// a product whose premise is that nothing should need one. It was asked for
// twice before anybody thought to have the service ask for itself.
//
// `systemctl show` needs no privileges, so the process that noticed the problem
// is the process that can answer it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unitProtection, adviseOnFailure } from '../src/core/upgrades.js';

/**
 * A fake systemctl that prints canned properties. The real spawn path is
 * exercised on purpose: a stub of spawnSync would not catch an argument this
 * builds wrongly, and the argument list is half of what this function is.
 */
function fakeSystemctl(lines, { status = 0, stderr = '' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'systemctl-'));
  const bin = path.join(dir, 'systemctl');
  writeFileSync(
    bin,
    `#!/bin/sh\n${stderr ? `echo ${JSON.stringify(stderr)} >&2\n` : ''}` +
      lines.map((l) => `echo ${JSON.stringify(l)}`).join('\n') +
      `\nexit ${status}\n`,
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  return { systemctlBin: bin };
}

const RO_ETC = ['25 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw', '36 25 8:1 /etc /etc ro,relatime - ext4 /dev/sda1 ro'];
const said = "unable to create '/etc/debian_version.dpkg-new': Read-only file system";

function mounts(lines) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mountinfo-'));
  const file = path.join(dir, 'mountinfo');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

test('an unset property is an empty value, not a missing line', () => {
  // `ReadWritePaths=` with nothing after it IS the answer for a unit that does
  // not set it, and `split('=')` on a value containing one would truncate a path.
  const u = unitProtection(fakeSystemctl([
    'ProtectSystem=full',
    'ReadWritePaths=',
    'DropInPaths=',
    'FragmentPath=/etc/systemd/system/agent-hub.service',
    'NeedDaemonReload=no',
  ]));
  assert.equal(u.ok, true);
  assert.equal(u.readWritePaths, '');
  assert.equal(u.protectSystem, 'full');
});

test('a value containing = survives, because the FIRST = is the separator', () => {
  // `=` is legal in a path, and `split('=')` truncates the value at the first
  // one — so a drop-in under a directory with an `=` in its name would be
  // reported half-named, in the one message whose job is to name the file.
  const odd = '/etc/systemd/system/agent-hub.service.d/10-ProtectSystem=off.conf';
  const lines = [
    'ProtectSystem=no', 'ReadWritePaths=', `DropInPaths=${odd}`,
    'FragmentPath=/etc/systemd/system/agent-hub.service', 'NeedDaemonReload=no',
  ];
  assert.equal(unitProtection(fakeSystemctl(lines)).dropIns, odd);
  assert.match(adviseOnFailure(said, mounts(RO_ETC), fakeSystemctl(lines)), /10-ProtectSystem=off\.conf/);
});

test('the path in the error is the path measured, not /etc', () => {
  // THE BUG THIS ROUND, AND THE FOURTH TIME SOMETHING WAS MEASURED NEXT TO THE
  // QUESTION RATHER THAN AT IT.
  //
  // `ProtectSystem=full` failed on /etc. Loosening it to `true` made the very
  // next dpkg run fail on /usr/bin/locale-check — and the advice measured /etc,
  // found it read-WRITE, and reported "ProtectSystem is NOT what stopped dpkg
  // and re-running the installer will not change anything" while ProtectSystem
  // was stopping it, one directory over.
  //
  // Testing pathFromDpkg on its own does not catch that: the parse was right
  // and it was not wired in. This asserts the whole path.
  const usrFailure =
    "unable to create '/usr/bin/locale-check.dpkg-new' " +
    "(while processing './usr/bin/locale-check'): Read-only file system";
  const etcWritableUsrNot = [
    '25 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
    '36 25 8:1 /usr /usr ro,relatime - ext4 /dev/sda1 rw',
  ];
  const cfg = fakeSystemctl([
    'ProtectSystem=true', 'ReadWritePaths=', 'DropInPaths=',
    'FragmentPath=/etc/systemd/system/agent-hub.service', 'NeedDaemonReload=no',
  ]);
  const advice = adviseOnFailure(usrFailure, mounts(etcWritableUsrNot), cfg);
  assert.match(advice, /READ-ONLY/, 'it measured somewhere the failure was not');
  assert.match(advice, /\/usr\/bin/, 'it does not name the path that actually failed');
  assert.doesNotMatch(advice, /READ-WRITE/);
  assert.doesNotMatch(advice, /will not change anything/, 'it told them the fix would not help, while it would');
});

test('any ProtectSystem at all is itself the diagnosis now', () => {
  // The unit shipped `full` + ReadWritePaths=/etc to carve /etc back out, and
  // that was MEASURED on a real box and did not work: systemd reported the unit
  // loaded, ReadWritePaths=/etc, no drop-ins, and left /etc read-only anyway.
  // So `full` means "this box is on the older unit", with or without the carve.
  // `full` blocked /etc; `full` + ReadWritePaths=/etc was loaded by systemd and
  // left /etc read-only anyway; `true` blocked /usr/bin. Each fix addressed the
  // path in the last error and uncovered the next, because the sudoers grant is
  // `apt-get -y upgrade` and rewriting /usr, /etc and /boot is what it IS.
  for (const [ps, rwp] of [['full', 'ReadWritePaths='], ['full', 'ReadWritePaths=/etc'], ['true', 'ReadWritePaths='], ['strict', 'ReadWritePaths=']]) {
    const cfg = fakeSystemctl([
      `ProtectSystem=${ps}`, rwp, 'DropInPaths=',
      'FragmentPath=/etc/systemd/system/agent-hub.service', 'NeedDaemonReload=no',
    ]);
    const advice = adviseOnFailure(said, mounts(RO_ETC), cfg);
    assert.match(advice, /READ-ONLY/);
    assert.match(advice, /no setting of it that lets an upgrade work/, `${ps} ${rwp} was not recognised as an old unit`);
    assert.match(advice, /ProtectSystem=no/);
    assert.match(advice, /curl -fsSL/);
  }
});

test('a current unit is NOT told to re-run the installer', () => {
  // THE BUG THAT SHIPPED INSIDE THE FIX. The conclusion used to be keyed on
  // ReadWritePaths being ABSENT, because the fixed unit was `full` +
  // ReadWritePaths=/etc. Removing that pair made an absent ReadWritePaths what
  // a CORRECT unit looks like, and this branch went on reading it as broken —
  // telling a box on the current unit to re-run the installer, which is the
  // exact wrong answer this whole function was rewritten to stop giving.
  const cfg = fakeSystemctl([
    'ProtectSystem=no', 'ReadWritePaths=', 'DropInPaths=',
    'FragmentPath=/etc/systemd/system/agent-hub.service', 'NeedDaemonReload=no',
  ]);
  const advice = adviseOnFailure(said, mounts(RO_ETC), cfg);
  assert.match(advice, /This unit is current/);
  assert.doesNotMatch(advice, /curl -fsSL/, 'it tells them to re-run the installer they already ran');
  assert.match(advice, /dmesg/, 'it does not say where to look instead');
});

test('a unit with the carve-out is NOT read as correctly configured', () => {
  // THE TRAP IN THE OBVIOUS ORDER. Checking ReadWritePaths before ProtectSystem
  // reads `full` + `/etc` as "asks for it, so it must be a drop-in" — and with
  // DropInPaths empty that becomes "report a bug", sending somebody to look for
  // a file that does not exist. This is the exact state the box reported.
  const cfg = fakeSystemctl([
    'ProtectSystem=full', 'ReadWritePaths=/etc', 'DropInPaths=',
    'FragmentPath=/etc/systemd/system/agent-hub.service', 'NeedDaemonReload=no',
  ]);
  const advice = adviseOnFailure(said, mounts(RO_ETC), cfg);
  assert.doesNotMatch(advice, /This unit is current/);
  assert.match(advice, /curl -fsSL/);
});

test('a drop-in over a current unit is named, not guessed at', () => {
  const cfg = fakeSystemctl([
    'ProtectSystem=no', 'ReadWritePaths=',
    'DropInPaths=/etc/systemd/system/agent-hub.service.d/override.conf',
    'FragmentPath=/etc/systemd/system/agent-hub.service', 'NeedDaemonReload=no',
  ]);
  const advice = adviseOnFailure(said, mounts(RO_ETC), cfg);
  assert.match(advice, /This unit is current/);
  assert.match(advice, /drop-ins on top of it/);
  assert.doesNotMatch(advice, /curl -fsSL/, 'it tells them to do the thing that already failed');
  // AND IT NAMES THE FILE, because "a drop-in is overriding it" without saying
  // which one is another trip to the box.
  assert.match(advice, /override\.conf/);
});

test('a unit that asks for it with no drop-in is reported as a disagreement', () => {
  const cfg = fakeSystemctl([
    'ProtectSystem=no', 'ReadWritePaths=', 'DropInPaths=',
    'FragmentPath=/etc/systemd/system/agent-hub.service', 'NeedDaemonReload=no',
  ]);
  const advice = adviseOnFailure(said, mounts(RO_ETC), cfg);
  assert.match(advice, /neither the\nunit nor this service/);
  assert.doesNotMatch(advice, /curl -fsSL/);
});

test('a service still running the old unit is told to reload, not reinstall', () => {
  // THE ONE THAT LOOKS LIKE EVERY OTHER ONE. The file on disk is right and the
  // running service is the old one, so reading the unit says the fix is applied
  // while the namespace says it is not.
  // AND IT IS CHECKED FIRST, before ProtectSystem. `yes` means every other
  // property describes the file as it USED to be, so a box whose unit had just
  // been fixed would otherwise be told to re-run the installer it just ran.
  const cfg = fakeSystemctl([
    'ProtectSystem=full', 'ReadWritePaths=', 'DropInPaths=',
    'FragmentPath=/etc/systemd/system/agent-hub.service', 'NeedDaemonReload=yes',
  ]);
  const advice = adviseOnFailure(said, mounts(RO_ETC), cfg);
  assert.match(advice, /daemon-reload/);
  assert.match(advice, /still running the OLD one/);
  assert.doesNotMatch(advice, /curl -fsSL/);
});

test('a unit systemd has never heard of is not read as an old unit', () => {
  // `systemctl show` EXITS 0 for a unit that does not exist and prints every
  // property at its default — so `ProtectSystem=no, ReadWritePaths=` comes back
  // for a box with no such unit, which is indistinguishable from an old one
  // unless FragmentPath is consulted. Reading it as old sends somebody to
  // re-run an installer over a service that is not what is confining them.
  const cfg = fakeSystemctl([
    'ProtectSystem=no', 'ReadWritePaths=', 'DropInPaths=', 'FragmentPath=', 'NeedDaemonReload=no',
  ]);
  const advice = adviseOnFailure(said, mounts(RO_ETC), cfg);
  assert.match(advice, /no unit called agent-hub loaded/);
  assert.doesNotMatch(advice, /curl -fsSL/);
});

test('a box with no systemd says so instead of guessing', () => {
  const cfg = fakeSystemctl([], { status: 1, stderr: 'System has not been booted with systemd' });
  const u = unitProtection(cfg);
  assert.equal(u.ok, false);
  assert.match(u.why, /not been booted with systemd/);
  const advice = adviseOnFailure(said, mounts(RO_ETC), cfg);
  assert.match(advice, /could not ask systemd why/);
  // Falls back to naming the commands, which is the honest answer when the
  // service genuinely cannot find out.
  assert.match(advice, /systemctl show agent-hub/);
});

test('a systemctl that is not there does not throw out of the advice', () => {
  // An upgrade that already failed must not fail a second time, differently,
  // while trying to explain itself.
  const advice = adviseOnFailure(said, mounts(RO_ETC), { systemctlBin: '/nope/systemctl' });
  assert.match(advice, /could not ask systemd why/);
});

test('a multi-entry ReadWritePaths survives whole', () => {
  // `/etcetera` starts with `/etc` and is not it. A substring test would report
  // the fix as applied on a box that never asked for it.
  const cfg = fakeSystemctl([
    'ProtectSystem=no', 'ReadWritePaths=/etcetera /var/tmp', 'DropInPaths=',
    'FragmentPath=/etc/systemd/system/agent-hub.service', 'NeedDaemonReload=no',
  ]);
  assert.equal(unitProtection(cfg).readWritePaths, '/etcetera /var/tmp');
});
