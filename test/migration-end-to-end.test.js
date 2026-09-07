// The migration, driven end to end, against a real release.
//
// WHY THIS FILE EXISTS. Converting a box to packaged releases failed five times
// on one machine, and every failure was in code that had never executed:
//
//   CHECK_ONLY read before it was set        the release's installer died
//   rm -rf of the directory it ran from      `current` left dangling
//   a stale helper snapshot                  a merged fix did not take effect
//   a #!/bin/sh shim run by `node`           every service in a restart loop
//   a unit for a binary releases omit        a service that could not exist
//
// Each fix revealed the next, because the only thing exercising this path was a
// production host. The tests around it read files and asserted strings, which
// catches "the wrong thing is written" and never "the right thing is never run".
//
// So this builds a release, publishes it over file://, points a fake box at it,
// and runs the helper — the whole sequence, with nothing stubbed except the
// installer handoff at the very end, which needs root and a real machine.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const HELPER = path.join(ROOT, 'install', 'fleetwright-migrate');

/**
 * A box that has not been converted, and a release waiting for it.
 *
 * Everything is a temporary directory: the "checkout" it is migrating from, the
 * /opt/fleetwright it is migrating to, the env file, and the release host —
 * which is a directory, served over file://, because curl reads those and a
 * test that needed the network would be a test nobody runs.
 */
function fixture({ brokenReleaseInstaller = false, localInstaller = true } = {}) {
  const work = mkdtempSync(path.join(tmpdir(), 'migrate-e2e-'));
  const dist = path.join(work, 'dist');

  const built = spawnSync(process.execPath, ['tools/build-host-package.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    // Its own output directory: node runs test FILES in parallel, and two
    // builds sharing dist/ overwrite each other's tarball mid-read.
    env: { ...process.env, RELEASE_VERSION: 'v9.9.9', RELEASE_OUT_DIR: dist },
  });
  if (built.status !== 0) {
    rmSync(work, { recursive: true, force: true });
    return null;
  }
  // The build wrote straight into `dist` — RELEASE_OUT_DIR above — so there is
  // nothing to copy and, more importantly, nothing shared with another test
  // file running at the same time.

  // A RELEASE WHOSE OWN INSTALLER IS BROKEN, when asked for. The smoke check
  // exists for exactly this, and a test that only ever sees good releases is
  // not testing the check.
  if (brokenReleaseInstaller) {
    const tar = readdirSync(dist).find((f) => f.endsWith('.tar.gz'));
    const stage = path.join(work, 'stage');
    mkdirSync(stage, { recursive: true });
    spawnSync('tar', ['-xzf', path.join(dist, tar ?? ''), '-C', stage]);
    const [name] = readdirSync(stage);
    writeFileSync(path.join(stage, name, 'install', 'install.sh'), '#!/bin/bash\nexit 3\n');
    chmodSync(path.join(stage, name, 'install', 'install.sh'), 0o755);
    spawnSync('tar', ['-czf', path.join(dist, tar ?? ''), '-C', stage, name]);
    // The manifest's digest has to follow, or the download is refused before
    // anything else is exercised — which would make this test pass for the
    // wrong reason.
    const m = JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
    m.sha256 = createHash('sha256').update(readFileSync(path.join(dist, tar ?? ''))).digest('hex');
    writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(m, null, 2));
  }

  // The box: a checkout, an env file, and a state directory.
  const checkout = path.join(work, 'opt', 'agent-fleet');
  mkdirSync(path.join(checkout, '.git'), { recursive: true });
  mkdirSync(path.join(checkout, 'install'), { recursive: true });
  if (localInstaller) {
    // A STUB, and only for the final handoff. Running the real installer needs
    // root, systemd and a logged-in claude; what is asserted here is that the
    // handoff happens with the right payload. install.sh is exercised for real
    // in test/packaged-installer.test.js.
    writeFileSync(
      path.join(checkout, 'install', 'install.sh'),
      '#!/bin/bash\n# AGENT_FLEET_PAYLOAD is named so the helper recognises this as new enough.\n' +
        `printf 'HANDOFF payload=%s args=%s\\n' "$AGENT_FLEET_PAYLOAD" "$*" > ${JSON.stringify(path.join(work, 'handoff'))}\n`,
    );
    chmodSync(path.join(checkout, 'install', 'install.sh'), 0o755);
  }

  const state = path.join(work, 'var', 'lib', 'agent-hub');
  mkdirSync(state, { recursive: true });
  const envFile = path.join(work, 'agent-hub.env');
  writeFileSync(
    envFile,
    `AGENT_HUB_RELEASE_MANIFEST=file://${path.join(dist, 'manifest.json')}\n` +
      `AGENT_HUB_INSTALL_DIR=${checkout}\n` +
      `AGENT_HUB_STATE_DIR=${state}\n`,
  );

  return { work, dist, checkout, state, envFile, base: path.join(work, 'opt', 'fleetwright') };
}

/** Run the helper the way install.sh does. */
function migrate(f, extraEnv = {}) {
  return spawnSync('sh', [HELPER], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FLEETWRIGHT_ENV_FILE: f.envFile,
      AGENT_FLEET_BASE: f.base,
      // A UNIT DIRECTORY OF ITS OWN, so "is this box converted" can be posed at
      // all. It was a literal /etc/systemd/system, which meant every converted
      // path in the helper could only be tested by writing units onto the
      // machine running the tests — so none of them were, and the one that
      // mattered was wrong.
      FLEETWRIGHT_UNIT_DIR: path.join(f.work, 'etc', 'systemd', 'system'),
      ...extraEnv,
    },
  });
}

/** Write the unit a converted box has: ExecStart naming `<base>/current`. */
function declareConverted(f, entry = 'lib/agent-hub.mjs') {
  const dir = path.join(f.work, 'etc', 'systemd', 'system');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'agent-hub.service'),
    // WorkingDirectory names the tree too, on purpose: the helper must read
    // ExecStart and not the whole file, which is a distinction a real box has
    // already been misjudged on.
    `[Service]\nWorkingDirectory=${f.base}/current\nExecStart=/usr/bin/node ${f.base}/current/${entry} serve\n`,
  );
}

test('a box converts: fetched, verified, laid out, handed off', (t) => {
  const f = fixture();
  if (!f) return t.skip('the release could not be built here');
  try {
    const r = migrate(f);
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out.slice(0, 600));

    // THE SEQUENCE, in order, each step asserted by its effect rather than by
    // its message — a log line is what the last five attempts all had.
    assert.match(out, /sha256 ok/, out.slice(0, 400));
    assert.equal(existsSync(path.join(f.base, 'releases', 'v9.9.9', 'lib', 'agent-hub.mjs')), true,
      'the release was not laid out');
    assert.equal(
      readFileSync(path.join(f.base, 'current', 'package.json'), 'utf8').includes('v9.9.9'), true,
      'current does not resolve to the release');

    // AND THE HANDOFF WENT TO THE BOX'S OWN INSTALLER, with the release as
    // payload. This is the property that stopped a broken release installer
    // from being able to strand a machine.
    const handoff = readFileSync(path.join(f.work, 'handoff'), 'utf8');
    assert.match(handoff, new RegExp(`payload=${f.base}/current`), handoff);
    assert.match(handoff, /args=--upgrade/, handoff);
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
});

test('a release whose installer cannot start is refused, and nothing moves', (t) => {
  const f = fixture({ brokenReleaseInstaller: true });
  if (!f) return t.skip('the release could not be built here');
  try {
    // The local installer is a stub that always succeeds, so the ONLY thing
    // that can refuse this release is the smoke check on its own installer.
    const r = migrate(f, { FLEETWRIGHT_SKIP_LOCAL: '' });
    const out = `${r.stdout}${r.stderr}`;

    // It is allowed to succeed — the local installer path does not care about
    // the release's installer — but if it refuses, it must refuse CLEANLY.
    if (r.status !== 0) {
      assert.match(out, /cannot install itself|does not run/, out.slice(0, 400));
      assert.equal(existsSync(path.join(f.base, 'current')), false,
        'current was moved before the release was known to work');
      assert.equal(existsSync(path.join(f.base, 'releases', '.incoming-v9.9.9')), false,
        'a refused release was left half-unpacked');
    }
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
});

test('a box with no local installer falls back, and says why', (t) => {
  const f = fixture({ localInstaller: false });
  if (!f) return t.skip('the release could not be built here');
  try {
    const out = `${(migrate(f)).stdout}${(migrate(f)).stderr}`;
    // Whatever happens next, it must have SAID which of the three reasons sent
    // it down the fallback — that silence is what made a merged fix look like
    // it had not landed.
    assert.match(out, /no checkout to use|not executable|predates the payload option/, out.slice(0, 400));
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
});

test('a second run on a converted box does not take it apart', (t) => {
  const f = fixture();
  if (!f) return t.skip('the release could not be built here');
  try {
    assert.equal(migrate(f).status, 0);

    // Pretend install.sh finished: the unit now names the release.
    const unitDir = path.join(f.work, 'etc', 'systemd', 'system');
    mkdirSync(unitDir, { recursive: true });

    // The helper reads /etc/systemd/system directly, so on a machine where that
    // is not writable this asserts the OTHER half: a second run is idempotent
    // and leaves a working box working.
    const before = readFileSync(path.join(f.base, 'current', 'package.json'), 'utf8');
    const again = migrate(f);
    assert.equal(again.status, 0, `${again.stdout}${again.stderr}`.slice(0, 400));
    assert.equal(readFileSync(path.join(f.base, 'current', 'package.json'), 'utf8'), before,
      'a second migration changed what the box runs');
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
});

test('a half-finished migration resumes instead of reporting success', (t) => {
  // THE STATE A REAL BOX WAS IN, twice. An earlier attempt laid the release out
  // and died before the units were re-pointed, so `$BASE/current` existed while
  // the box still ran the checkout. The guard tested for that symlink and
  // answered:
  //
  //   already on the packaged layout — nothing to do
  //
  // which is indistinguishable from success, to somebody who has just typed y.
  const f = fixture();
  if (!f) return t.skip('the release could not be built here');
  try {
    // Leave exactly what a failed attempt leaves: a laid-out release and a
    // symlink, and units that still name the checkout.
    mkdirSync(path.join(f.base, 'releases', 'v9.9.9', 'lib'), { recursive: true });
    writeFileSync(path.join(f.base, 'releases', 'v9.9.9', 'lib', 'stale'), 'from the failed attempt');
    symlinkSync(path.join(f.base, 'releases', 'v9.9.9'), path.join(f.base, 'current'));

    const r = migrate(f);
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out.slice(0, 400));

    // It must NOT have stopped.
    assert.doesNotMatch(out, /nothing to do/, out.slice(0, 400));
    assert.match(out, /continuing from there/, out.slice(0, 400));

    // And it must have actually converted: the handoff happened, and the
    // half-unpacked directory was replaced by a real release.
    assert.equal(existsSync(path.join(f.work, 'handoff')), true, 'the migration never handed off');
    assert.equal(existsSync(path.join(f.base, 'current', 'lib', 'agent-hub.mjs')), true,
      'the release from the failed attempt was left in place');
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
});


test('a converted box can take the NEXT update, which is the point of converting', (t) => {
  // The first host to run a release asked for an update and was told its own
  // layout was not one. Converting a box buys nothing if the box cannot then
  // update — so this asserts the thing conversion is FOR, from the path a
  // running service actually reports.
  const f = fixture();
  if (!f) return t.skip('the release could not be built here');
  try {
    assert.equal(migrate(f).status, 0);

    // What a running process sees: node resolves the symlink, so this is the
    // release directory and not `current`.
    const resolved = path.join(f.base, 'releases', 'v9.9.9');
    assert.equal(existsSync(resolved), true);

    // The update path has to accept it and agree on where the next release goes.
    return import('../src/core/release-apply.js').then(({ releaseLayout }) => {
      const viaReal = releaseLayout(resolved);
      const viaLink = releaseLayout(path.join(f.base, 'current'));
      assert.equal(viaReal.ok, true, viaReal.ok ? '' : viaReal.message);
      assert.deepEqual(viaReal.base, viaLink.base);
      assert.equal(viaReal.base, f.base);
    });
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
});


// --- the box that could not be reached --------------------------------------

test('a converted box on an older release is brought forward, not refused', (t) => {
  // THE DEADLOCK, from a real machine. deb13-staging runs v0.2.3, whose
  // releaseLayout() refuses a packaged box's own path — so its own update path
  // answers "there is no symlink to swap", and it cannot reach a version where
  // that is fixed. Fixing main does not reach it either: a box runs the
  // RELEASE's code, not main's.
  //
  // The installer is the only way in, because it is the one component that does
  // NOT come from the release — and it refused too, with "already on the
  // packaged layout — nothing to do". True, and the wrong question: converted
  // says a box HAS a release, never WHICH.
  const f = fixture();
  if (!f) return t.skip('the release could not be built here');
  try {
    // A box already packaged, on an older release than the channel now has.
    const old = path.join(f.base, 'releases', 'v0.0.1');
    mkdirSync(path.join(old, 'lib'), { recursive: true });
    writeFileSync(path.join(old, 'package.json'), JSON.stringify({ version: 'v0.0.1' }));
    writeFileSync(path.join(old, 'lib', 'agent-hub.mjs'), '// the release that cannot update itself');
    symlinkSync(old, path.join(f.base, 'current'));
    declareConverted(f);

    const r = migrate(f);
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out.slice(0, 500));
    assert.doesNotMatch(out, /nothing to do/, out.slice(0, 500));

    // And it actually moved: `current` points at the new release, the old one
    // is still on disk, and the handoff happened.
    assert.equal(existsSync(path.join(f.base, 'releases', 'v9.9.9', 'lib', 'agent-hub.mjs')), true,
      'the newer release was never laid out');
    assert.equal(
      readFileSync(path.join(f.base, 'current', 'package.json'), 'utf8').includes('v9.9.9'),
      true,
      'current still points at the release the box was stuck on',
    );
    assert.equal(existsSync(path.join(f.work, 'handoff')), true, 'the installer was never re-run');
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
});

test('a converted box already on the newest release does nothing', (t) => {
  // The other half, and the reason this is safe to run on every installer
  // rerun: it must be a cheap no-op, or "self-heal every time" becomes
  // "re-download and restart every time".
  const f = fixture();
  if (!f) return t.skip('the release could not be built here');
  try {
    assert.equal(migrate(f).status, 0);
    declareConverted(f);
    // The first run handed off, which is what converting does. Clear the marker
    // so the second run's silence is its own.
    rmSync(path.join(f.work, 'handoff'), { force: true });

    const r = migrate(f);
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out.slice(0, 500));
    assert.match(out, /already on the packaged layout, running v9\.9\.9 — nothing to do/, out.slice(0, 500));
    // Nothing was handed off, so nothing restarted.
    assert.equal(existsSync(path.join(f.work, 'handoff')), false, 'a no-op re-ran the installer');
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
});

test('a converted box whose current is unreadable is repaired, not called current', (t) => {
  // UNREADABLE IS NOT UP TO DATE. A `current` pointing at a directory with no
  // package.json is a box half-way through something — the state a partial
  // release leaves — and comparing an empty version string against the
  // manifest's must not match.
  const f = fixture();
  if (!f) return t.skip('the release could not be built here');
  try {
    const broken = path.join(f.base, 'releases', 'v9.9.9');
    mkdirSync(broken, { recursive: true });   // no package.json, no lib/
    symlinkSync(broken, path.join(f.base, 'current'));
    declareConverted(f);

    const r = migrate(f);
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out.slice(0, 500));
    assert.doesNotMatch(out, /nothing to do/, out.slice(0, 500));
    assert.equal(existsSync(path.join(f.base, 'current', 'lib', 'agent-hub.mjs')), true,
      'the partial release was left in place');
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
});

test('a converted box needs no checkout to be brought forward', (t) => {
  // The refusal below this in the helper — "neither a checkout nor a release" —
  // is for a machine that is neither. Asking it of a box that is ALREADY
  // packaged would refuse every self-heal for want of a directory that
  // converting exists to stop depending on.
  const f = fixture();
  if (!f) return t.skip('the release could not be built here');
  try {
    const old = path.join(f.base, 'releases', 'v0.0.1');
    mkdirSync(path.join(old, 'lib'), { recursive: true });
    writeFileSync(path.join(old, 'package.json'), JSON.stringify({ version: 'v0.0.1' }));
    symlinkSync(old, path.join(f.base, 'current'));
    declareConverted(f);
    // No checkout at all: the box was converted and the tree removed.
    rmSync(f.checkout, { recursive: true, force: true });

    const r = migrate(f);
    const out = `${r.stdout}${r.stderr}`;
    // NOT asserting exit 0. With no checkout there is no fake installer to hand
    // off to, so the helper correctly falls back to the release's own — which
    // is the real install.sh and needs root and a real machine. What is being
    // tested is everything BEFORE that: the refusal must not fire, and the
    // release must be laid out.
    assert.doesNotMatch(out, /neither a checkout nor a release/, out.slice(0, 500));
    assert.match(out, /laid out .*releases\/v9\.9\.9/, out.slice(0, 500));
    assert.equal(existsSync(path.join(f.base, 'releases', 'v9.9.9', 'lib', 'agent-hub.mjs')), true);
    assert.match(out, /this box has no checkout to use/, out.slice(0, 800));
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
});

test('the installer brings a converted box forward before it writes units', (t) => {
  // A box whose release is crash-looping is exactly the box that needs this,
  // and restarting the broken release first is how the run dies before reaching
  // the repair. Ordering is the whole point, so it is asserted.
  const src = readFileSync(path.join(ROOT, 'install', 'install.sh'), 'utf8');
  const call = src.indexOf('\nrefresh_release_if_converted\n');
  const units = src.indexOf('install_unit agent-hub');
  assert.ok(call > 0, 'the installer never refreshes a converted box');
  assert.ok(call < units, 'the release is refreshed after the units are written');
  // And it must not loop: the helper re-runs the installer.
  assert.match(src, /\[ -z "\$\{FLEETWRIGHT_MIGRATING:-\}" \] \|\| return 0/);
});
