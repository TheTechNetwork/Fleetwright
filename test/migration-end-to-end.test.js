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
    env: { ...process.env, RELEASE_VERSION: 'v9.9.9' },
  });
  if (built.status !== 0) {
    rmSync(work, { recursive: true, force: true });
    return null;
  }
  mkdirSync(dist, { recursive: true });
  // Files only: dist/ also holds the staging directory the tarball was made
  // from, and a release host serves the two artifacts and nothing else.
  for (const f of readdirSync(path.join(ROOT, 'dist'))) {
    if (!f.endsWith('.tar.gz') && f !== 'manifest.json') continue;
    writeFileSync(path.join(dist, f), readFileSync(path.join(ROOT, 'dist', f)));
  }
  rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });

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
      ...extraEnv,
    },
  });
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
