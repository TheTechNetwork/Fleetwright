// What a failed apt upgrade actually says, on a phone.
//
// REPORTED FROM A REAL FLEET. `Apply upgrade` on deb132 came back with:
//
//   apt-get upgrade failed:
//   debconf: unable to initialize frontend: Teletype
//   debconf: (This frontend requires a controlling tty.)
//   debconf: falling back to frontend: Noninteractive
//   E: Sub-process /usr/bin/dpkg returned an error code (1)
//
//   Run it on the box to see the whole output.
//
// Every line of that is noise except the last, which says only that dpkg
// failed. The package that broke was never shown — and then the message sent
// somebody to a shell for something the coordinator already had in hand.
//
// TWO MISTAKES, BOTH DISCARDING THE ANSWER. `(r.stderr || r.stdout)` reads
// stderr whenever it is non-empty, and debconf makes it non-empty on virtually
// every unattended run — so the stream carrying dpkg's actual error was never
// looked at. And a four-line tail is exactly filled by the debconf noise.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { upgradeFailureDetail } from '../src/core/upgrades.js';

/** The real shape: cause on stdout, debconf and the summary on stderr. */
const REAL = {
  stdout: [
    'Setting up docker-ce (5:27.3.1) ...',
    'job for docker.service failed because the control process exited',
    'dpkg: error processing package docker-ce (--configure):',
    ' installed docker-ce package post-installation script subprocess returned error exit status 1',
    'Errors were encountered while processing:',
    ' docker-ce',
  ].join('\n'),
  stderr: [
    'debconf: unable to initialize frontend: Teletype',
    'debconf: (This frontend requires a controlling tty.)',
    'debconf: falling back to frontend: Noninteractive',
    'E: Sub-process /usr/bin/dpkg returned an error code (1)',
  ].join('\n'),
};

test('the package that failed is in what reaches the phone', () => {
  const detail = upgradeFailureDetail(REAL);
  assert.match(detail, /docker-ce/, 'the failing package is still invisible');
  assert.match(detail, /post-installation script/, 'the reason is still invisible');
});

test('debconf saying it recovered is not the error', () => {
  // Dropped because these three lines are not about this run: debconf says it
  // cannot use a teletype, then says it fell back successfully. Keeping them
  // costs the space the real error needs.
  const detail = upgradeFailureDetail(REAL);
  assert.equal(/unable to initialize frontend/.test(detail), false);
  assert.equal(/requires a controlling tty/.test(detail), false);
  assert.equal(/falling back to frontend/.test(detail), false);

  // The dpkg summary survives — it is terse, but it is a real error line.
  assert.match(detail, /Sub-process \/usr\/bin\/dpkg returned an error code/);
});

test('both streams are read, not whichever is non-empty first', () => {
  // The cause is on stdout and the summary on stderr, and choosing one loses
  // half of every failure.
  const stdoutOnly = upgradeFailureDetail({ stdout: 'dpkg: error processing package foo', stderr: '' });
  assert.match(stdoutOnly, /foo/);

  const stderrOnly = upgradeFailureDetail({ stdout: '', stderr: 'E: Could not get lock /var/lib/dpkg/lock-frontend' });
  assert.match(stderrOnly, /Could not get lock/);
});

test('apt saying nothing is said, rather than shown as blank', () => {
  // A killed or timed-out run produces neither stream, and an empty detail
  // reads as the message having been truncated.
  assert.match(upgradeFailureDetail({ stdout: '', stderr: '' }), /apt said nothing about why/);
  // Including when the only output was noise.
  assert.match(
    upgradeFailureDetail({ stdout: '', stderr: 'debconf: falling back to frontend: Noninteractive' }),
    /apt said nothing about why/,
  );
});

test('the advice names a command instead of naming the box', () => {
  // "Run it on the box to see the whole output" is the shape this project keeps
  // finding: a product surface telling somebody to go and get a shell, without
  // saying what to type when they have one.
  const src = readFileSync(new URL('../src/core/upgrades.js', import.meta.url), 'utf8');
  assert.match(src, /sudo apt-get -y upgrade/);
  assert.match(src, /systemctl status/);
  // The code, not the comment recording what it used to say.
  assert.equal(/Run it on the box to see the whole output/.test(src.replace(/^\s*\*.*$/gm, '')), false);
});

// --- and the reason those debconf lines were there at all --------------------

test('the upgrade runs noninteractively, with conffile prompts answered', async () => {
  // The debconf complaint was a real signal, not just noise: without a frontend
  // and without conffile options, a package that ships a changed config file
  // stops to ask which version to keep — on a box with no terminal. debconf
  // falls back to Noninteractive, dpkg gets no answer, and the upgrade fails.
  //
  // Both flags are the CONSERVATIVE choice. An upgrade run by a machine must
  // not replace a file somebody edited.
  const src = readFileSync(new URL('../src/core/upgrades.js', import.meta.url), 'utf8');
  assert.match(src, /--force-confold/);
  assert.match(src, /--force-confdef/);
  assert.match(src, /DEBIAN_FRONTEND: 'noninteractive'/);
});

test('a box on the old sudoers rule still upgrades', () => {
  // sudo matches the WHOLE command line, so the extra options are a refusal on
  // a rule that predates them — not an unknown flag. Refusing to upgrade at all
  // would be worse than upgrading the way it always has, so it falls back and
  // says which one it took.
  const src = readFileSync(new URL('../src/core/upgrades.js', import.meta.url), 'utf8');
  assert.match(src, /APT_PLAIN/);
  assert.match(src, /APT_SAFE/);
  assert.match(src, /not allowed to execute\|sorry, user/);
  // NAMES --repair RATHER THAN A REINSTALL. The only remedy used to be running
  // the whole installer on a machine whose only fault was being older than a
  // commit — and on a box mid-flag-day, a full reinstall is the thing that
  // needs a bound pin afterwards.
  assert.match(src, /install\.sh --repair/, 'the fallback is silent about how to stop needing it');
});

test('the rule printed by hand is the rule the installer writes', () => {
  // Somebody who pastes the message and somebody who re-runs the installer must
  // end up with the same permissions, or one gets an upgrade that stalls on a
  // conffile prompt and the other does not.
  const src = readFileSync(new URL('../src/core/upgrades.js', import.meta.url), 'utf8');
  const sh = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');

  for (const piece of ['env_keep += "DEBIAN_FRONTEND"', 'force-confold', 'force-confdef']) {
    assert.ok(src.includes(piece), `the printed rule is missing ${piece}`);
    assert.ok(sh.includes(piece), `the installer's rule is missing ${piece}`);
  }

  // ESCAPED IN BOTH. `:` and `=` are sudoers metacharacters — they separate the
  // host, runas and command sections — and visudo rejects the line without the
  // backslashes. Found by running visudo on it rather than by reading the
  // grammar, and the installer validates with visudo before installing.
  // Both files carry `Dpkg\\:\\:Options` as source text — a shell printf and a
  // JS string literal each needing one level of escaping to emit one backslash.
  for (const [name, text] of [['upgrades.js', src], ['install.sh', sh]]) {
    assert.ok(text.includes('Dpkg\\\\:\\\\:Options'), `${name} does not escape the sudoers metacharacters`);
  }
  assert.match(sh, /visudo -cf/);
});
