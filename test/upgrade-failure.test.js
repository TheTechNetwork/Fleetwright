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
