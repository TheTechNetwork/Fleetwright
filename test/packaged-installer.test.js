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

test('a release that cannot install itself is refused before current moves', () => {
  // TWO REAL ATTEMPTS ON ONE MACHINE got as far as moving the `current` symlink
  // and then died running the installer out of the release. The sha256 above
  // proves the tarball is the one the manifest names; it says nothing about
  // whether what is inside it RUNS — and the migration's last act is to run the
  // installer out of it.
  //
  // A release carrying a broken installer therefore strands the box, and cannot
  // be fixed by fixing main: the installer that runs is the one in the release.
  // v0.2.2 was exactly that.
  const mig = readFileSync(new URL('../install/fleetwright-migrate', import.meta.url), 'utf8');

  const smoke = mig.indexOf('install.sh" --help');
  const move = mig.indexOf('mv "$BASE/releases/.incoming-$VERSION"');
  const link = mig.indexOf('ln -sfn');
  assert.ok(smoke > 0, 'the release installer is never tried before being adopted');
  assert.ok(smoke < move && smoke < link, 'the release is adopted before anything checks that it runs');

  // And a refusal leaves NOTHING behind: no half-adopted version directory, and
  // above all no moved symlink.
  const block = mig.slice(smoke - 400, move);
  assert.match(block, /rm -rf "\$BASE\/releases\/\.incoming-\$VERSION"/);
  assert.match(block, /Nothing was changed/);
});

test('a release installing itself does not delete itself', () => {
  // FROM A REAL BOX, on the first migration that got this far:
  //
  //   running the installer from the release
  //   cp: cannot stat '/opt/fleetwright/current/.': No such file or directory
  //
  // fleetwright-migrate lays the release out, points `current` at it, and runs
  // the installer from $FLEET_BASE/current. So $DIR is the SYMLINK and
  // $RELEASE_DIR is what it points at — the same directory by two names — and
  // the block compared them as strings, decided they differed, and began with
  // `rm -rf "$RELEASE_DIR"`. It deleted the directory it was running out of.
  //
  // The block was written for a release unpacked somewhere else, a tarball in
  // /tmp. Nothing ran it from `current` until the migration existed.
  //
  // RUN IN ISOLATION, not by running the installer: a real run writes
  // /etc/systemd units and a state directory, which is not a thing a test may
  // do to the machine it is running on. The block is lifted out and given a
  // fixture, the same way scripts/coverage-verdict.mjs is tested apart from the
  // suite it judges.
  const sh = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');
  const start = sh.indexOf('if [ "$PACKAGED" = 1 ]; then');
  const block = sh.slice(start, sh.indexOf('\nfi\n', start) + 4);
  assert.match(block, /pwd -P/, 'the block no longer resolves $DIR');

  const work = mkdtempSync(path.join(tmpdir(), 'selfinstall-'));
  try {
    const release = path.join(work, 'releases', 'v9.9.9');
    spawnSync('mkdir', ['-p', release]);
    spawnSync('bash', ['-c', `printf '{"version":"v9.9.9"}' > ${release}/package.json`]);
    spawnSync('bash', ['-c', `printf 'canary' > ${release}/marker`]);
    spawnSync('ln', ['-sfn', release, path.join(work, 'current')]);

    const r = spawnSync('bash', ['-euo', 'pipefail', '-c',
      `PACKAGED=1 CHECK_ONLY=0 FLEET_BASE=${work} DIR=${work}/current\n${block}\necho "DIR=$DIR"`,
    ], { encoding: 'utf8' });

    const out = `${r.stdout}${r.stderr}`;
    assert.doesNotMatch(out, /cannot stat/, out.slice(0, 300));

    // THE THREE THINGS THAT MUST SURVIVE. The release, its contents, and the
    // symlink — because what broke was all three at once.
    assert.equal(existsSync(path.join(release, 'marker')), true, 'the release deleted itself');
    assert.equal(existsSync(path.join(work, 'current', 'marker')), true, 'current dangles');
    // And DIR ends up as the symlink, which is what makes the next release a
    // symlink swap rather than an installer run.
    assert.match(out, new RegExp(`DIR=${work}/current`));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('a migration uses the installer the box already has', () => {
  // WHY THIS MATTERS MORE THAN THE BUGS IT PREVENTS. The migration used to run
  // the installer INSIDE the release, which made a release's installer
  // load-bearing for its own adoption: a broken one could not be migrated to
  // and could only be SUPERSEDED. One afternoon produced three releases that
  // way, each fixing a bug the previous had hidden, on code that had never run.
  //
  // The box's own installer is updated by `curl … | sudo sh`, which costs
  // nothing and needs no release. So an installer fix reaches a machine as soon
  // as somebody re-runs the one-liner, and a release only has to be a correct
  // PAYLOAD rather than a correct installer.
  const mig = readFileSync(new URL('../install/fleetwright-migrate', import.meta.url), 'utf8');
  const sh = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');

  assert.match(sh, /DIR="\$\{AGENT_FLEET_PAYLOAD:-/, 'install.sh cannot be pointed at a payload');
  assert.match(mig, /AGENT_FLEET_PAYLOAD="\$BASE\/current" exec bash "\$LOCAL_INSTALLER"/);

  // THE LOCAL ONE IS TRIED FIRST. A fallback that runs first is not a fallback.
  const local = mig.indexOf('LOCAL_INSTALLER="$INSTALL_DIR/install/install.sh"');
  const fallback = mig.indexOf('running the installer from the release');
  assert.ok(local > 0 && local < fallback, 'the release installer is still preferred');

  // And it is only used when it UNDERSTANDS the payload option — an older
  // box's installer would ignore it and cheerfully reinstall the checkout,
  // which is the one outcome worse than using the release's.
  assert.match(mig, /grep -q 'AGENT_FLEET_PAYLOAD' "\$LOCAL_INSTALLER"/);

  // The fallback stays, because a box installed from a tarball by hand has no
  // local installer at all.
  assert.match(mig, /the release has no install\/install\.sh in it/);
});

test('a release whose own installer is broken can still be migrated to', () => {
  // THE PROPERTY, END TO END. Built, laid out the way the migration does it,
  // with the release's installer replaced by one that exits 3 — and the box's
  // installer takes it from there.
  //
  // This is the assertion that would have saved three releases.
  const rel = unpackedRelease();
  if (!rel) return;
  const base = path.join(rel.dir, 'base');
  try {
    spawnSync('mkdir', ['-p', path.join(base, 'releases')]);
    spawnSync('mv', [rel.root, path.join(base, 'releases', 'v9.9.9')]);
    spawnSync('ln', ['-sfn', path.join(base, 'releases', 'v9.9.9'), path.join(base, 'current')]);
    spawnSync('bash', ['-c',
      `printf '#!/bin/bash\\nexit 3\\n' > ${path.join(base, 'releases', 'v9.9.9', 'install', 'install.sh')}`]);

    const r = spawnSync('bash', [path.join(ROOT, 'install', 'install.sh'), '--check'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_FLEET_PAYLOAD: path.join(base, 'current'),
        AGENT_FLEET_BASE: base,
      },
    });
    const out = `${r.stdout}${r.stderr}`;
    // It read the payload, not its own tree.
    assert.match(out, new RegExp(`source\\s*:\\s*${base}/current`), out.slice(0, 300));
    assert.doesNotMatch(out, /unbound variable|cannot stat/);
  } finally {
    rmSync(rel.dir, { recursive: true, force: true });
  }
});

test('the installer runs the helper from its own tree, not the installed copy', () => {
  // A STALENESS CLASS, and it cost a real migration. /usr/local/sbin/fleetwright-migrate
  // is a snapshot taken by whichever install ran last. install.sh runs as root
  // out of a checkout it has just updated — so running the snapshot means a fix
  // to the helper takes effect on the run AFTER the one that installed it.
  //
  // That is exactly what happened: a box re-ran the one-liner with the fix in
  // its tree and migrated using the previous helper, printing the fallback
  // message the fix exists to avoid.
  //
  // /usr/local/sbin remains the APP's path, where there is no checkout and the
  // narrow sudoers rule is the whole point.
  const sh = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');
  const block = sh.slice(sh.indexOf('# --- 9. and then it stops being a checkout'));
  assert.match(block, /HELPER="\$DIR\/install\/fleetwright-migrate"/, 'the installer still runs the installed snapshot');
  assert.match(block, /\[ -x "\$DIR\/install\/fleetwright-migrate" \]/);
  // The snapshot stays as the fallback, for a tree that somehow has no helper.
  assert.match(block, /HELPER=\/usr\/local\/sbin\/fleetwright-migrate/);
});

test('a fallback to the release installer says which of three reasons it was', () => {
  // Falling back silently is how somebody reads "running the installer from the
  // release", knows a fix landed that should have prevented it, and cannot tell
  // which of three things went wrong. Each has a different answer and only one
  // of them is "wait for a release".
  const mig = readFileSync(new URL('../install/fleetwright-migrate', import.meta.url), 'utf8');
  assert.match(mig, /this box has no checkout to use/);
  assert.match(mig, /is not executable, so it cannot be used/);
  assert.match(mig, /predates the payload option — re-run the one-liner to update it/);
});

test('the entry points a unit names run under node, not just as scripts', async (t) => {
  // THIS TOOK A HOST DOWN. The shims were `#!/bin/sh` with `exec node …`
  // inside, which works when something RUNS the file — and the systemd unit
  // does not run it:
  //
  //     ExecStart=__NODE__ __DIR__/bin/agent-hub serve
  //
  // node strips the `#!` line, meets the `#` on line 2, and every packaged
  // service died at startup in a restart loop:
  //
  //     SyntaxError: Invalid or unexpected token
  //
  // A checkout's bin/agent-hub is JavaScript with a node shebang, so both forms
  // work there. The packaged shim was the only artifact where they differed,
  // and it is the one systemd invokes.
  const rel = unpackedRelease();
  if (!rel) return t.skip('the release could not be built here');
  try {
    const unit = readFileSync(new URL('../install/agent-hub.service', import.meta.url), 'utf8');
    assert.match(unit, /ExecStart=__NODE__ __DIR__\/bin\/agent-hub/, 'the unit no longer names bin/');

    // The coordinator is deliberately NOT here: it moved to a Cloudflare
    // Worker, so a release ships none — and the installer must not write a unit
    // for it either, which the next test asserts.
    for (const entry of ['agent-hub', 'agent-fleet-sidecar', 'agent-fleet-mcp']) {
      const file = path.join(rel.root, 'bin', entry);
      assert.equal(existsSync(file), true, `no bin/${entry} in the release`);

      // WHAT IS ASSERTED IS THAT IT STARTS, not that it succeeds. Exit codes
      // belong to each tool: agent-fleet-mcp refuses without a coordinator URL
      // and a credential, and is right to. A shim that node cannot parse dies
      // before any of that, which is the failure this test is for.
      for (const [how, r] of [
        // The way systemd does it. This is the assertion that was missing.
        ['node', spawnSync(process.execPath, [file, '--help'], { encoding: 'utf8' })],
        // And the way a person does it, because the shim exists for that too.
        ['direct', spawnSync(file, ['--help'], { encoding: 'utf8' })],
      ]) {
        const out = `${r.stdout}${r.stderr}`;
        assert.doesNotMatch(out, /SyntaxError|Invalid or unexpected token/, `${how} bin/${entry}: ${out.slice(0, 200)}`);
        assert.doesNotMatch(out, /Cannot find module|ERR_MODULE_NOT_FOUND/, `${how} bin/${entry}: ${out.slice(0, 200)}`);
        assert.ok(out.trim().length > 0, `${how} bin/${entry} produced nothing at all`);
      }
    }
  } finally {
    rmSync(rel.dir, { recursive: true, force: true });
  }
});


test('no unit is written for an entry point the payload does not have', () => {
  // The coordinator moved to a Cloudflare Worker, so a release ships no
  // bin/agent-fleet-coordinator — deliberately. install.sh wrote the unit
  // anyway, so converting a box that ran its own coordinator produced a service
  // pointing at a file that was never in the tarball. It fails at every start,
  // and reads as a broken box rather than as a component that is not supposed
  // to be there.
  const sh = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');
  assert.match(sh, /if \[ -f "\$DIR\/bin\/agent-fleet-coordinator" \]; then\n\s+install_unit agent-fleet-coordinator/);
  assert.match(sh, /it runs as a Worker, so no unit is written/);

  // And a checkout still gets one, because a box running its own coordinator is
  // a thing --from-source keeps possible on purpose.
  assert.equal(existsSync(new URL('../bin/agent-fleet-coordinator', import.meta.url).pathname), true);
});
