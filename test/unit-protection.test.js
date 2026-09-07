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
  const u = unitProtection(fakeSystemctl([
    'ProtectSystem=full', 'ReadWritePaths=/etc', `DropInPaths=${odd}`,
    'FragmentPath=/etc/systemd/system/agent-hub.service', 'NeedDaemonReload=no',
  ]));
  assert.equal(u.dropIns, odd);
  assert.match(adviseOnFailure(said, mounts(RO_ETC), fakeSystemctl([
    'ProtectSystem=full', 'ReadWritePaths=/etc', `DropInPaths=${odd}`,
    'FragmentPath=/etc/systemd/system/agent-hub.service', 'NeedDaemonReload=no',
  ])), /10-ProtectSystem=off\.conf/);
});

test('a unit that predates the fix is told to re-run the installer', () => {
  const cfg = fakeSystemctl([
    'ProtectSystem=full', 'ReadWritePaths=', 'DropInPaths=',
    'FragmentPath=/etc/systemd/system/agent-hub.service', 'NeedDaemonReload=no',
  ]);
  const advice = adviseOnFailure(said, mounts(RO_ETC), cfg);
  assert.match(advice, /READ-ONLY/);
  assert.match(advice, /predates the fix/);
  assert.match(advice, /curl -fsSL/);
  assert.match(advice, /agent-hub\.service/);
});

test('a unit that already asks for it is NOT told to re-run the installer', () => {
  // THE CASE THIS WHOLE FILE EXISTS FOR. Somebody re-ran the installer, as
  // instructed, and failed identically — because the release carrying the
  // advice was the release carrying the fix. Repeating the instruction is the
  // one thing this must never do.
  const cfg = fakeSystemctl([
    'ProtectSystem=full', 'ReadWritePaths=/etc',
    'DropInPaths=/etc/systemd/system/agent-hub.service.d/override.conf',
    'FragmentPath=/etc/systemd/system/agent-hub.service', 'NeedDaemonReload=no',
  ]);
  const advice = adviseOnFailure(said, mounts(RO_ETC), cfg);
  assert.match(advice, /already asks for it/);
  assert.match(advice, /will NOT help/);
  assert.doesNotMatch(advice, /curl -fsSL/, 'it tells them to do the thing that already failed');
  // AND IT NAMES THE FILE, because "a drop-in is overriding it" without saying
  // which one is another trip to the box.
  assert.match(advice, /override\.conf/);
});

test('a unit that asks for it with no drop-in is reported as a disagreement', () => {
  const cfg = fakeSystemctl([
    'ProtectSystem=full', 'ReadWritePaths=/etc', 'DropInPaths=',
    'FragmentPath=/etc/systemd/system/agent-hub.service', 'NeedDaemonReload=no',
  ]);
  const advice = adviseOnFailure(said, mounts(RO_ETC), cfg);
  assert.match(advice, /worth reporting as a bug/);
  assert.doesNotMatch(advice, /curl -fsSL/);
});

test('a service still running the old unit is told to reload, not reinstall', () => {
  // THE ONE THAT LOOKS LIKE EVERY OTHER ONE. The file on disk is right and the
  // running service is the old one, so reading the unit says the fix is applied
  // while the namespace says it is not.
  const cfg = fakeSystemctl([
    'ProtectSystem=full', 'ReadWritePaths=/etc', 'DropInPaths=',
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

test('/etc is matched as a whole path in the list', () => {
  // `/etcetera` starts with `/etc` and is not it. A substring test would report
  // the fix as applied on a box that never asked for it.
  const cfg = fakeSystemctl([
    'ProtectSystem=full', 'ReadWritePaths=/etcetera /var/tmp', 'DropInPaths=',
    'FragmentPath=/etc/systemd/system/agent-hub.service', 'NeedDaemonReload=no',
  ]);
  assert.match(adviseOnFailure(said, mounts(RO_ETC), cfg), /predates the fix/);
});
