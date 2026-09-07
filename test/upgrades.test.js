// What is out of date on this box.
//
// The check path is what matters here: it runs on every health report, so it
// has to be cheap, and it must never throw a working host out of the fleet
// because git could not reach a remote.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
  const readOnly = adviseOnFailure("unable to create '/etc/debian_version.dpkg-new': Read-only file system");
  assert.match(readOnly, /ProtectSystem=full/, 'it does not name the thing that actually did it');
  assert.match(readOnly, /sudo does not escape a mount namespace/i);
  assert.match(readOnly, /re-running the installer/, 'it does not say how to fix it');
  // A WAY TO TELL THE TWO APART, because a genuinely read-only disk exists too
  // and this advice must not send that person in circles.
  assert.match(readOnly, /systemctl show agent-hub/);
  assert.doesNotMatch(readOnly, /update the image/i, 'it blames the image again');

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
  const unit = readFileSync(new URL('../install/agent-hub.service', import.meta.url), 'utf8');
  assert.match(unit, /^ProtectSystem=full$/m, 'the hardening was dropped rather than narrowed');
  assert.match(unit, /^ReadWritePaths=\/etc$/m, 'dpkg still cannot write /etc');

  // NOT A WEAKENING, and the reason is worth keeping next to it: the service
  // runs unprivileged, so ordinary file permissions already stop it writing
  // /etc. The namespace was redundant for everything except the one operation
  // that legitimately has root through a sudoers rule naming its command line.
  assert.match(unit, /unprivileged user, so ordinary file permissions/);
  assert.doesNotMatch(unit, /Nothing here writes to \/etc —/, 'the comment that was false is back');
});
