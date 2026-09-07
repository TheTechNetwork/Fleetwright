// What is out of date on this box.
//
// The check path is what matters here: it runs on every health report, so it
// has to be cheap, and it must never throw a working host out of the fleet
// because git could not reach a remote.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describeSystemUpdates, refreshPackageLists, runUpgrade } from '../src/core/upgrades.js';

test('a box with nothing waiting says nothing at all', () => {
  // Null, not "0 updates available". This goes into a health report that
  // something else decides whether to surface, and a quiet box should be quiet
  // rather than reassuring.
  assert.equal(describeSystemUpdates({ supported: true, count: 0, security: 0, rebootRequired: false, packages: [] }), null);
  assert.equal(describeSystemUpdates({ supported: false, count: 0, security: 0, rebootRequired: false, packages: [] }), null);
});

test('a summary leads with the count and calls out security and reboots', () => {
  assert.equal(
    describeSystemUpdates({ supported: true, count: 12, security: 3, rebootRequired: true, packages: [] }),
    '12 packages can be upgraded · 3 security · reboot pending',
  );
  assert.equal(
    describeSystemUpdates({ supported: true, count: 1, security: 0, rebootRequired: false, packages: [] }),
    '1 package can be upgraded',
  );
  // A reboot with nothing to install is still worth saying: it means an
  // upgrade already happened and the box is running the old kernel.
  assert.equal(
    describeSystemUpdates({ supported: true, count: 0, security: 0, rebootRequired: true, packages: [] }),
    'reboot pending',
  );
});

test('with upgrades off, the refusal is the instructions', () => {
  // A "not permitted" that does not say how to permit it is a dead end, and
  // this one is a scoped sudoers line most people would accept if they could
  // see it.
  const r = runUpgrade(/** @type {any} */ ({ systemUpgrade: false, runUser: 'agent' }));
  assert.equal(r.ok, false);
  assert.match(r.text, /agent ALL=\(root\) NOPASSWD: \/usr\/bin\/apt-get update, \/usr\/bin\/apt-get -y upgrade/);
  assert.match(r.text, /AGENT_HUB_SYSTEM_UPGRADE=1/);
  assert.match(r.text, /cannot install, remove or run anything else/);
  assert.match(r.text, /apt-get update/, 'the refresh is in the rule, because this box never does it itself');
});

test('stale package lists are reported, because "no updates" would be a lie', () => {
  // The box this was written for does not refresh its lists on its own: a
  // minimal Debian only does that once unattended-upgrades has written the
  // periodic config. So `apt list --upgradable` answers against whatever was
  // current on install day and reports nothing while the machine falls months
  // behind — which is worse than reporting nothing at all.
  const quiet = { supported: true, count: 0, security: 0, rebootRequired: false, packages: [] };
  assert.equal(describeSystemUpdates({ ...quiet, listsAgeHours: 3 }), null, 'fresh and empty stays quiet');
  assert.equal(describeSystemUpdates({ ...quiet, listsAgeHours: 24 * 30 }), 'package lists 30d old');
  assert.equal(
    describeSystemUpdates({ ...quiet, count: 4, security: 1, listsAgeHours: 24 * 9 }),
    '4 packages can be upgraded · 1 security · package lists 9d old',
  );
});

test('refreshing is refused rather than attempted when it is not permitted', () => {
  // sudo -n would fail in a second anyway, but a refusal that says why beats a
  // log line about a password prompt nobody can answer.
  const r = refreshPackageLists(/** @type {any} */ ({ systemUpgrade: false }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not permitted');
});

test('the advice matches the failure, or says nothing clever', async () => {
  // REPORTED FROM A BOX WHOSE ROOT IS READ-ONLY:
  //
  //   unable to create '/etc/debian_version.dpkg-new': Read-only file system
  //
  // and the answer offered was "On the box: sudo apt-get -y upgrade" plus a
  // note about systemctl status. Running that command there fails identically,
  // and no service failed to start — so somebody is sent to a machine to type
  // two things that cannot help.
  //
  // A CONFIDENT REMEDY FOR A DIAGNOSIS NOBODY MADE costs more than no remedy:
  // it spends a trip to the box, and it teaches people the advice is
  // decoration.
  const { adviseOnFailure } = await import('../src/core/upgrades.js');

  //
  // AND I GOT THIS WRONG ONCE ALREADY, which is why the assertion is what it
  // is. The first version blamed the image and said nothing typed on the box
  // would help — told to somebody whose filesystem was perfectly writable.
  //
  // It is agent-hub.service's own `ProtectSystem=full`, which makes /etc
  // read-only for the service AND every child of it. `sudo` does not escape a
  // mount namespace, so the sanctioned apt-get inherited it. The box was fine;
  // we were the read-only part.
  // AND THEN IT WAS WRONG A SECOND TIME, which is why it now MEASURES.
  //
  // That fix and this advice shipped in the SAME release, so every box the
  // message could reach already had ReadWritePaths=/etc — and one of them
  // re-ran the installer, as instructed, and failed identically. Twice this
  // function produced a confident remedy for a diagnosis nobody made.
  //
  // The process running dpkg is the process whose namespace dpkg inherits, so
  // it reads its own mounts instead of reasoning about a unit file. A unit file
  // says what was ASKED FOR; mountinfo says what the kernel DID.
  //
  // THE FIXTURES ARE THE POINT OF THIS ASSERTION. Measuring the machine running
  // the suite would make this test agree with whatever that box has mounted,
  // and the two answers below are the two it has to tell apart.
  const said = "unable to create '/etc/debian_version.dpkg-new': Read-only file system";
  const fixture = (lines) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'advice-'));
    const file = path.join(dir, 'mountinfo');
    writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  };
  const RW = '25 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw';

  // A SYSTEMD FIXTURE TOO, for the same reason as the mountinfo one: the
  // read-only branch now ASKS systemd which of the three reasons it is, so
  // asserting against the machine running the suite would make this test agree
  // with whatever units that box happens to have. test/unit-protection.test.js
  // covers the three answers; this one only needs the shape.
  const systemd = (lines) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'systemctl-'));
    const bin = path.join(dir, 'systemctl');
    writeFileSync(bin, `#!/bin/sh\n${lines.map((l) => `echo ${JSON.stringify(l)}`).join('\n')}\n`, { mode: 0o755 });
    return { systemctlBin: bin };
  };
  const OLD_UNIT = systemd([
    'ProtectSystem=full', 'ReadWritePaths=', 'DropInPaths=',
    'FragmentPath=/etc/systemd/system/agent-hub.service', 'NeedDaemonReload=no',
  ]);

  // OURS: a read-only layer stacked over a perfectly good disk.
  const ours = adviseOnFailure(said, fixture([RW, '36 25 8:1 /etc /etc ro,relatime - ext4 /dev/sda1 ro']), OLD_UNIT);
  assert.match(ours, /READ-ONLY/, 'it does not say what it measured');
  assert.match(ours, /sudo does not/i);
  assert.match(ours, /measured NOT to work/, 'it does not say how to fix it');
  assert.doesNotMatch(ours, /update the image/i, 'it blames the image again');

  // NOT OURS: /etc is writable in this namespace, so ProtectSystem did not do
  // it and the installer will not fix it. This is the answer the shipped
  // version could not express, and the one a person is standing in when they
  // say "it still fails".
  const notOurs = adviseOnFailure(said, fixture([RW]), OLD_UNIT);
  assert.match(notOurs, /READ-WRITE/);
  assert.match(notOurs, /re-running the installer will not change anything/);
  assert.match(notOurs, /findmnt/, 'it does not say where to look instead');

  // CANNOT TELL is its own answer, and rounding it to either of the two above
  // is how both earlier versions went wrong.
  const unmeasurable = adviseOnFailure(said, '/definitely/not/here', OLD_UNIT);
  assert.match(unmeasurable, /could not read its own mounts/);
  assert.match(unmeasurable, /findmnt/);
  assert.match(unmeasurable, /ReadWritePaths/);

  // Each of the rest has a different fix, which is the whole reason to tell
  // them apart.
  assert.match(adviseOnFailure('E: dpkg was interrupted, you must manually run'), /dpkg --configure -a/);
  assert.match(adviseOnFailure('E: Could not get lock /var/lib/dpkg/lock-frontend'), /try again in a few minutes/);
  assert.match(adviseOnFailure('No space left on device'), /apt-get clean/);
  assert.match(adviseOnFailure('Temporary failure resolving deb.debian.org'), /network or DNS/);
  assert.match(adviseOnFailure('a password is required'), /sudoers/);

  // AND THE GENERIC SENTENCE SURVIVES, for the case where it is honest: nothing
  // recognised the failure, so name the command and stop guessing.
  const unknown = adviseOnFailure('E: something nobody has seen before');
  assert.match(unknown, /sudo apt-get -y upgrade/);
  assert.match(unknown, /systemctl status/);
});

test('the unit lets dpkg write the one directory it must', () => {
  // `ProtectSystem=full` makes /usr, /boot AND /etc read-only for the service
  // and every child of it. A mount namespace is not something `sudo` escapes,
  // so `/upgrade` could not have worked on any box with the old unit, for any
  // package carrying a conffile — which is most of them.
  //
  // The unit's own comment said "Nothing here writes to /etc". True of
  // agent-hub's code, false of the thing agent-hub exists to launch.
  //
  // AND THE FIRST FIX FOR IT DID NOT WORK, which is why the assertion changed.
  // `full` plus `ReadWritePaths=/etc` was measured on the box that reported it,
  // after installing: systemd loaded the unit, reported ReadWritePaths=/etc and
  // no drop-ins, and left /etc read-only in the namespace regardless.
  //
  // Asking for `full` AND carving /etc back out is a contradiction — protect
  // /etc, do not protect /etc — and which way a given systemd resolves it is a
  // detail of that version. `true` has no contradiction to resolve.
  const unit = readFileSync(new URL('../install/agent-hub.service', import.meta.url), 'utf8');
  assert.match(unit, /^ProtectSystem=true$/m, 'the contradiction is back, or the hardening was dropped entirely');
  assert.doesNotMatch(unit, /^ProtectSystem=full$/m);
  // NOTHING TO CARVE OUT ANY MORE. A ReadWritePaths=/etc beside `true` would be
  // a line that does nothing, left behind to look like it is helping.
  assert.doesNotMatch(unit, /^ReadWritePaths=\/etc$/m, 'a redundant line dressed up as a fix');

  // WHAT IS STILL PROTECTED, said out loud, because "we turned the hardening
  // down" needs to name what survived: /usr and /boot stay read-only, and /etc
  // goes back to ordinary file permissions — which already stop an
  // unprivileged service, and were doing the real work all along.
  assert.match(unit, /UNPRIVILEGED USER, so those already/);
  assert.match(unit, /\/usr, \/boot and \/efi stay/);
  assert.doesNotMatch(unit, /Nothing here writes to \/etc —/, 'the comment that was false is back');
});
