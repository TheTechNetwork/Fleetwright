// The one-liner, run as a one-liner.
//
// install/bootstrap.sh is the only file in this repository that gets executed
// by strangers sight-unseen, out of a pipe, by whatever /bin/sh happens to be.
// That is worth more than a syntax check: every case below is a state a real
// box is in, and the interesting ones are the two where it must REFUSE.
//
// Nothing here touches the machine running it. Each test gets its own source
// repository and its own target directory, and the "installer" it ends up
// running is a stub that prints its arguments.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOOTSTRAP = fileURLToPath(new URL('../install/bootstrap.sh', import.meta.url));

/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

/**
 * A repository that looks enough like this one to be cloned and handed over to.
 * @param {import('node:test').TestContext} t
 */
function origin(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bootstrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const repo = path.join(root, 'source');
  mkdirSync(path.join(repo, 'install'), { recursive: true });
  // The stub installer. Printing its arguments is how the test sees that the
  // hand-over happened AND that `-s --` reached the far end intact.
  writeFileSync(
    path.join(repo, 'install', 'install.sh'),
    '#!/usr/bin/env bash\nprintf "INSTALLER RAN [%s]\\n" "$*"\n',
  );
  chmodSync(path.join(repo, 'install', 'install.sh'), 0o755);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'first']);

  return { root, repo, target: path.join(root, 'target') };
}

/**
 * Run it the way the documentation says to: piped into sh, arguments after
 * `-s --`. NOT `sh bootstrap.sh` — that would test a different thing and skip
 * the whole reason this file exists.
 *
 * @param {{ repo: string, target: string }} where
 * @param {string[]} [args]
 */
function pipeIntoSh(where, args = [], env = {}) {
  return spawnSync(
    'sh',
    ['-s', '--', ...args],
    {
      input: readBootstrap(),
      encoding: 'utf8',
      env: {
        ...process.env,
        FLEETWRIGHT_REPO: where.repo,
        FLEETWRIGHT_REF: 'main',
        FLEETWRIGHT_DIR: where.target,
        ...env,
      },
    },
  );
}

function readBootstrap() {
  return spawnSync('cat', [BOOTSTRAP], { encoding: 'utf8' }).stdout;
}

test('it is POSIX sh, because that is what it will be run by', () => {
  // `curl | sh` runs under /bin/sh — dash on Debian — and the real installer is
  // bash. A bashism that creeps in here fails on a stranger's box with "Bad
  // substitution" and no clue as to why.
  const r = spawnSync('sh', ['-n', BOOTSTRAP], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('a bare box: it clones and hands over', (t) => {
  const where = origin(t);
  const r = pipeIntoSh(where);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /INSTALLER RAN/);
  assert.equal(existsSync(path.join(where.target, '.git')), true, 'the checkout is what ends up on the box');
});

test('arguments survive the pipe', (t) => {
  const where = origin(t);
  const r = pipeIntoSh(where, ['--check', '--no-wizard']);
  // `sh -s --` is the part people get wrong, so this is really a test of the
  // documented command rather than of the script.
  assert.match(r.stdout, /INSTALLER RAN \[--check --no-wizard\]/);
});

test('running it again updates the checkout instead of failing', (t) => {
  const where = origin(t);
  assert.equal(pipeIntoSh(where).status, 0);

  writeFileSync(path.join(where.repo, 'NEW'), 'later\n');
  git(where.repo, ['add', '-A']);
  git(where.repo, ['commit', '-qm', 'second']);

  const again = pipeIntoSh(where);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Updating/);
  assert.equal(existsSync(path.join(where.target, 'NEW')), true, 'and it really pulled');
});

test('it refuses a directory that is not ours', (t) => {
  const where = origin(t);
  mkdirSync(where.target, { recursive: true });
  writeFileSync(path.join(where.target, 'somebody-elses-file'), 'do not delete me\n');

  const r = pipeIntoSh(where);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is not a checkout, and is not empty/);
  // The property that matters: a command somebody pasted did not delete
  // anything.
  assert.equal(existsSync(path.join(where.target, 'somebody-elses-file')), true);
});

test('it refuses somewhere it cannot write, and names both ways out', (t) => {
  const where = origin(t);
  const readonly = path.join(where.root, 'readonly');
  mkdirSync(readonly);
  chmodSync(readonly, 0o500);

  let r;
  try {
    r = pipeIntoSh(where, [], { FLEETWRIGHT_DIR: path.join(readonly, 'fleet') });
  } finally {
    // Restored HERE rather than in a t.after: the hook that removes the whole
    // scratch tree was registered first and runs first, so an after() would
    // chmod a directory that is already gone.
    chmodSync(readonly, 0o700);
  }
  // Skipped rather than asserted when the test runs as root, which can write
  // anywhere and would make this pass for the wrong reason.
  if (process.getuid?.() === 0) {
    assert.equal(r.status, 0, 'root can write it, so there is nothing to refuse');
    return;
  }
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /sudo sh/);
  assert.match(r.stderr, /FLEETWRIGHT_DIR/, 'and the answer for somebody who does not want sudo');
});
