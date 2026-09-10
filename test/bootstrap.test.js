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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, readdirSync } from 'node:fs';
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
  // readFileSync, not `cat`. Beyond being simpler: spawnSync returns undefined
  // stdout when the binary is missing or the spawn fails, so every assertion
  // over the text would have passed vacuously against undefined rather than
  // failing. A test that cannot fail is worse than no test.
  return readFileSync(BOOTSTRAP, 'utf8');
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

// --- a release, not a checkout ------------------------------------------------
//
// THE SHAPE A FRESH BOX GETS NOW. The one-liner used to clone the repository,
// so every documented install produced a git working tree that the installer
// then offered to convert into the packaged layout it could have started in.
// Now it fetches the manifest, the tarball the manifest names, checks the
// sha256, unpacks somewhere temporary and hands over to the install.sh inside
// — which lays the release out exactly as it does for a migration.
//
// Served over file://, which curl speaks, so nothing here needs a network and
// the manifest is a file the test wrote a moment ago.

import { createHash } from 'node:crypto';

/**
 * A published release: a tarball beside a manifest that names it, built the
 * way tools/build-host-package.mjs lays one out — one top-level directory.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ sha?: string, file?: string, stub?: string }} [opts]
 */
function release(t, { sha, file = 'fleetwright-host-v9.tar.gz', stub } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bootstrap-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const tree = path.join(root, 'tree', 'fleetwright-host-v9');
  mkdirSync(path.join(tree, 'install'), { recursive: true });
  // The stub prints its arguments and the one thing the hand-over has to carry:
  // where releases come from, which a box with no git remote cannot work out.
  writeFileSync(
    path.join(tree, 'install', 'install.sh'),
    stub ?? '#!/usr/bin/env bash\nprintf "INSTALLER RAN [%s] from %s\\n" "$*" "${AGENT_HUB_RELEASE_MANIFEST:-nowhere}"\n',
  );
  chmodSync(path.join(tree, 'install', 'install.sh'), 0o755);
  writeFileSync(path.join(tree, 'package.json'), '{ "version": "v9" }\n');

  const dist = path.join(root, 'dist');
  mkdirSync(dist);
  spawnSync('tar', ['-czf', path.join(dist, file), '-C', path.join(root, 'tree'), 'fleetwright-host-v9']);
  const digest = createHash('sha256').update(readFileSync(path.join(dist, file))).digest('hex');
  writeFileSync(
    path.join(dist, 'manifest.json'),
    JSON.stringify({ version: 'v9', file, sha256: sha ?? digest, protocol: 3 }, null, 2),
  );
  return {
    root,
    dist,
    manifest: `file://${path.join(dist, 'manifest.json')}`,
    base: path.join(root, 'base'),
    target: path.join(root, 'target'),
  };
}

/**
 * A PATH on which `git` exists and fails, so a route that reaches for it is
 * caught rather than quietly working because the runner happens to have git.
 * @param {import('node:test').TestContext} t
 */
function noGit(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'no-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'git'), '#!/bin/sh\necho "git was called: $*" >&2\nexit 127\n');
  chmodSync(path.join(dir, 'git'), 0o755);
  return `${dir}:${process.env.PATH}`;
}

test('a bare box fetches the release, checks it, and hands over — without git', (t) => {
  const rel = release(t);
  const r = pipeIntoSh(
    { repo: 'https://github.com/example/fleet', target: rel.target },
    ['--check'],
    { FLEETWRIGHT_MANIFEST: rel.manifest, AGENT_FLEET_BASE: rel.base, PATH: noGit(t), TMPDIR: rel.root },
  );

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /v9, sha256 ok/, 'the version and the check are both said');
  // The installer ran, with its arguments, and was told where releases come
  // from — the address the tarball was just verified against.
  assert.match(r.stdout, new RegExp(`INSTALLER RAN \\[--check\\] from ${rel.manifest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(existsSync(path.join(rel.target, '.git')), false, 'no checkout on the box');
  assert.doesNotMatch(r.stderr, /git was called/, 'the release route never reaches for git');
  // And nothing of the fetch is left behind: the release lives where the
  // installer put it, not in /tmp.
  const leftovers = readdirSyncSafe(rel.root).filter((f) => f.startsWith('fleetwright-install.'));
  assert.deepEqual(leftovers, [], `unpacked releases left in ${rel.root}`);
});

test('a release that does not match its manifest is refused before it is unpacked', (t) => {
  const rel = release(t, { sha: 'f'.repeat(64) });
  const r = pipeIntoSh(
    { repo: 'https://github.com/example/fleet', target: rel.target },
    [],
    { FLEETWRIGHT_MANIFEST: rel.manifest, AGENT_FLEET_BASE: rel.base, TMPDIR: rel.root },
  );

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not match its manifest/);
  assert.match(r.stderr, /Nothing was installed/);
  assert.doesNotMatch(r.stdout, /INSTALLER RAN/, 'a tarball that failed its check must never run');
  // And the download it refused is gone too: a refusal that leaves the thing
  // it refused on disk has half-installed it.
  assert.deepEqual(readdirSyncSafe(rel.root).filter((f) => f.startsWith('fleetwright-install.')), []);
});

test('a manifest whose file is a path is refused, because where to write is not its to choose', (t) => {
  const rel = release(t);
  writeFileSync(
    path.join(rel.dist, 'manifest.json'),
    JSON.stringify({ version: 'v9', file: '../elsewhere.tar.gz', sha256: 'a'.repeat(64) }),
  );
  const r = pipeIntoSh(
    { repo: 'https://github.com/example/fleet', target: rel.target },
    [],
    { FLEETWRIGHT_MANIFEST: rel.manifest, AGENT_FLEET_BASE: rel.base },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a file beside it/);
});

test('--from-source still gets a checkout, and a box that has one keeps it', (t) => {
  // Two boxes that must stay on the clone route with a manifest in reach: the
  // one somebody edits, and the one that already has a checkout — laying a
  // release beside a checkout the units still point at would be two installs
  // arguing about one box.
  const rel = release(t);
  const where = origin(t);
  const asked = pipeIntoSh(where, ['--from-source'], { FLEETWRIGHT_MANIFEST: rel.manifest, AGENT_FLEET_BASE: rel.base });
  assert.equal(asked.status, 0, asked.stderr);
  assert.match(asked.stdout, /INSTALLER RAN \[--from-source\]/);
  assert.equal(existsSync(path.join(where.target, '.git')), true, '--from-source is a checkout');

  const again = pipeIntoSh(where, [], { FLEETWRIGHT_MANIFEST: rel.manifest, AGENT_FLEET_BASE: rel.base });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Updating/, 'a box with a checkout is updated, not re-laid as a release');
  assert.doesNotMatch(again.stdout, /Fetching the release/);
});

test('a repository that is not on GitHub has no release address, and says so before cloning', (t) => {
  // Every earlier test in this file runs against a local repository and gets
  // a clone — this pins that it is a decision the script announces, not a
  // guess that happened to work. A release path invented inside somebody
  // else's server is a 404 blamed on the installer.
  const where = origin(t);
  const r = pipeIntoSh(where);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No release address for .* fetching the repository instead/);
});

test('the release address is derived from the repository, stable unless asked for rolling', () => {
  // Text, because the derivation only runs against github.com and the tests
  // above deliberately never reach it. The two channels are the two tags CI
  // publishes: `latest` is the newest GitHub release, `rolling` every merge.
  const sh = readBootstrap();
  assert.match(sh, /releases\/latest\/download\/manifest\.json/);
  assert.match(sh, /releases\/download\/rolling\/manifest\.json/);
  assert.match(sh, /FLEETWRIGHT_CHANNEL/);
  assert.match(sh, /FLEETWRIGHT_MANIFEST/, 'a fork or a mirror can name its own');
  // Verified before it is unpacked, in the script's own order.
  assert.ok(sh.indexOf('sha256_of "$WORK/$FILE"') < sh.indexOf('tar -xzf "$WORK/$FILE"'), 'unpacked before it was checked');
});

/** @param {string} dir */
function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

test('the release this repository actually builds installs itself through the one-liner', (t) => {
  // Not a stub. The package builder makes the tarball and the manifest the way
  // CI publishes them, and the bootstrap fetches, checks and hands over to the
  // real install.sh inside — with --check, which changes nothing, so the only
  // thing that can fail here is the hand-over itself.
  const root = mkdtempSync(path.join(os.tmpdir(), 'bootstrap-real-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist');
  const built = spawnSync(process.execPath, ['tools/build-host-package.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    env: { ...process.env, RELEASE_VERSION: 'v-test', RELEASE_OUT_DIR: dist },
  });
  if (built.status !== 0) return t.skip('the release could not be built here');

  const base = path.join(root, 'base');
  const r = pipeIntoSh(
    { repo: 'https://github.com/example/fleet', target: path.join(root, 'target') },
    ['--check'],
    { FLEETWRIGHT_MANIFEST: `file://${path.join(dist, 'manifest.json')}`, AGENT_FLEET_BASE: base, TMPDIR: root, PATH: noGit(t) },
  );
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /v-test, sha256 ok/);
  assert.match(out, /Running the installer/);
  assert.doesNotMatch(out, /unbound variable/, out.split('\n').slice(0, 5).join('\n'));
  assert.doesNotMatch(out, /git was called/);
  // --check promises to change nothing, and the exit code is deliberately not
  // asserted: it reports on prerequisites this runner has no reason to have.
  assert.equal(existsSync(base), false, `--check created ${base}`);
  assert.deepEqual(readdirSyncSafe(root).filter((f) => f.startsWith('fleetwright-install.')), []);
});
