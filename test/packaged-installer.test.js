// The installer, RUN from a real release rather than read.
//
// WHY THIS FILE EXISTS, and it is the whole of the reason: the packaged path
// had never been executed. docs/packaging.md said so out loud — "Nothing
// consumes them yet; they can be wrong without hurting anybody" — and the other
// tests around it read install.sh as text, which cannot notice a variable used
// before it is set.
//
// The first box ever to convert itself printed:
//
//   /opt/fleetwright/current/install/install.sh: line 62: CHECK_ONLY: unbound variable
//
// The lay-out block ran BEFORE the argument loop, so it read $CHECK_ONLY twenty
// lines before anything assigned it. Under `set -u` that is fatal, and it could
// only ever evaluate on a packaged box — so no amount of running the installer
// from a checkout would have found it. Building the package and running it
// would have, in seconds.
//
// So that is what this does. It is the cheapest possible answer to "does the
// thing we ship actually start".

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Build a release and unpack it, the way a host does.
 *
 * @returns {{ dir: string, root: string }|null} null when the build could not
 *   run at all, which is a different failure and belongs to another test.
 */
function unpackedRelease() {
  const work = mkdtempSync(path.join(tmpdir(), 'pkg-install-'));
  const built = spawnSync(process.execPath, ['tools/build-host-package.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, RELEASE_VERSION: 'v-test' },
  });
  if (built.status !== 0) {
    rmSync(work, { recursive: true, force: true });
    return null;
  }
  const dist = path.join(ROOT, 'dist');
  const tarball = readdirSync(dist).find((f) => f.endsWith('.tar.gz'));
  spawnSync('tar', ['-xzf', path.join(dist, tarball ?? ''), '-C', work], { encoding: 'utf8' });
  rmSync(dist, { recursive: true, force: true });
  const [name] = readdirSync(work);
  return { dir: work, root: path.join(work, name) };
}

test('the installer in a release starts at all', (t) => {
  const rel = unpackedRelease();
  if (!rel) return t.skip('the release could not be built here');
  try {
    // `--help` and not `--check`: it needs no node, no tmux, no claude, and it
    // exits before touching anything — so on any machine, the only thing it can
    // fail on is the script itself. Which is exactly what failed.
    //
    // It is also the sharpest possible version of this test. --help is parsed
    // in the argument loop, so a block that runs BEFORE that loop and dies
    // takes --help down with it. Printing usage proves nothing runs too early.
    const r = spawnSync('bash', [path.join(rel.root, 'install', 'install.sh'), '--help'], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_FLEET_BASE: path.join(rel.dir, 'base') },
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.doesNotMatch(out, /unbound variable/, out.split('\n').slice(0, 3).join('\n'));
    assert.equal(r.status, 0, out.slice(0, 400));
    assert.match(out, /usage: install\.sh/);
  } finally {
    rmSync(rel.dir, { recursive: true, force: true });
  }
});

test('--check from a release changes nothing, including the release layout', (t) => {
  const rel = unpackedRelease();
  if (!rel) return t.skip('the release could not be built here');
  const base = path.join(rel.dir, 'base');
  try {
    const r = spawnSync('bash', [path.join(rel.root, 'install', 'install.sh'), '--check'], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_FLEET_BASE: base },
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.doesNotMatch(out, /unbound variable/, out.split('\n').slice(0, 3).join('\n'));

    // THE SECOND HALF OF THE SAME ORDERING BUG. Even with the variable
    // defaulted, a lay-out that runs before the argument loop would copy a
    // release into place and only then read the flag promising to change
    // nothing. --check says "verify prerequisites and change nothing"; this is
    // the assertion that it means it.
    assert.equal(existsSync(base), false, `--check created ${base}`);

    // Its exit code is deliberately NOT asserted. --check reports on
    // prerequisites, and a machine running this suite has no reason to have
    // tmux or a logged-in claude — failing on that would be asserting the
    // runner's shape rather than the installer's.
  } finally {
    rmSync(rel.dir, { recursive: true, force: true });
  }
});

// --- the migration helper's idea of "already done" ---------------------------

test('a half-finished migration is resumed, not declared complete', () => {
  // REPORTED FROM A BOX, on the second attempt after the first one crashed:
  //
  //   This box is already running. Convert it now? [y/N] [no]: y
  //   already on the packaged layout — nothing to do
  //
  // It was not on the packaged layout. The first attempt had laid the release
  // out and then died, so `$BASE/current` existed while the systemd units still
  // pointed at the checkout — and the guard tested for the symlink.
  //
  // Answering "nothing to do" to somebody who just said yes is the worst
  // available reply: it is indistinguishable from success and leaves the box
  // exactly as it was.
  const mig = readFileSync(new URL('../install/fleetwright-migrate', import.meta.url), 'utf8');

  // THE UNIT IS THE ANSWER. What a box runs is what systemd starts.
  assert.match(mig, /UNIT=\/etc\/systemd\/system\/agent-hub\.service/);
  assert.match(mig, /grep -q "\$BASE\/current" "\$UNIT"/);

  // And neither of the two wrong questions decides it any more. The symlink is
  // now a reason to CONTINUE; the env-file install dir is gone from the test
  // entirely, because nothing ever writes AGENT_HUB_INSTALL_DIR.
  const guard = mig.slice(mig.indexOf('ALREADY DONE IS NOT A FAILURE'), mig.indexOf('CHANNEL='));
  assert.doesNotMatch(guard, /\|\| \[ -L "\$BASE\/current" \]/, 'a leftover symlink still means "done"');
  assert.match(guard, /continuing from there/);
});

test('nothing writes the variable the helper used to trust', () => {
  // The quieter half of the same bug, and the reason the symlink was reached
  // for at all: `env_get AGENT_HUB_INSTALL_DIR` always returns empty, so the
  // check it fed was a hardcoded path wearing a variable's clothes — false even
  // after a migration that worked.
  //
  // If somebody teaches the installer to record it, this test fails and the
  // guard above can be reconsidered on purpose rather than by accident.
  const sh = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(sh, /set_env[^\n]*AGENT_HUB_INSTALL_DIR/);
});
