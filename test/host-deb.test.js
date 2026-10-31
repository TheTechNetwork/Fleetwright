// The deb: a courier for the host release, with the Node that runs it.
//
// What has to stay true, each for a reason that cost something once:
//   - the Node inside is the one SHASUMS256.txt vouches for, or there is no deb
//   - two builds are the same bytes, like the tarball inside
//   - the maintainer scripts are POSIX sh, because dpkg runs them with /bin/sh
//     and that is dash on Debian — the same trap bootstrap.sh documents
//   - the postinst never runs apt-get: dpkg holds the lock it would wait on

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  debVersion, shasumFor, pinnedNodeVersion, buildDeb,
  neededLibraries, undeclaredLibraries, dependsPackages,
} from '../tools/build-host-deb.mjs';

const DEB = new URL('../install/deb/', import.meta.url);
const read = (f) => readFileSync(new URL(f, DEB), 'utf8');
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

test('a release tag becomes a version dpkg orders the way semver does', () => {
  assert.equal(debVersion('v0.2.3'), '0.2.3');
  assert.equal(debVersion('0.3.0-rc1'), '0.3.0~rc1');
  // `~` sorts before the release, so an rc can never outrank what it precedes.
  if (has('dpkg')) {
    assert.equal(spawnSync('dpkg', ['--compare-versions', '0.3.0~rc1', 'lt', '0.3.0']).status, 0);
  }
  // A build of main — what the deb job sees on every push — is a prerelease of
  // the next release: above the one it follows, below the one it names. Both
  // orderings are what the channel script's pin direction depends on
  // (install/fleetwright-apt-channel), and a minor bump still outranks it.
  assert.equal(debVersion('main-41', '0.4.11'), '0.4.12~main.41');
  assert.equal(debVersion('main-41', '0.4.9'), '0.4.10~main.41', 'the patch is a number, not a digit');
  assert.match(debVersion('main-41'), /^\d+\.\d+\.\d+~main\.41$/, 'the default base is package.json');
  if (has('dpkg')) {
    assert.equal(spawnSync('dpkg', ['--compare-versions', '0.4.12~main.41', 'gt', '0.4.11']).status, 0);
    assert.equal(spawnSync('dpkg', ['--compare-versions', '0.4.12~main.41', 'lt', '0.4.12']).status, 0);
    assert.equal(spawnSync('dpkg', ['--compare-versions', '0.4.12~main.41', 'lt', '0.5.0']).status, 0);
    assert.equal(spawnSync('dpkg', ['--compare-versions', '0.4.12~main.42', 'gt', '0.4.12~main.41']).status, 0);
  }
  assert.throws(() => debVersion('main-41', 'v0.4.11'), /x\.y\.z/);
  assert.throws(() => debVersion('nightly'), /start with a digit/);
});

test('the pinned Node is read from node.env, and Renovate can see it', () => {
  assert.match(pinnedNodeVersion(), /^\d+\.\d+\.\d+$/);
  const env = read('node.env');
  assert.match(env, /# renovate: datasource=node-version depName=node versioning=node\nNODE_VERSION=/);
  // And renovate.json has a manager that reads that annotation, or the pin
  // above is a comment nobody acts on.
  const renovate = JSON.parse(readFileSync(new URL('../renovate.json', import.meta.url), 'utf8'));
  const managers = renovate.customManagers.filter((m) => m.managerFilePatterns.some((p) => p.includes('node\\.env')));
  assert.equal(managers.length, 1, 'renovate.json does not read install/deb/node.env');
  const re = new RegExp(managers[0].matchStrings[0]);
  const m = re.exec(env);
  assert.ok(m, 'the renovate regex does not match node.env');
  assert.equal(m.groups.currentValue, pinnedNodeVersion());
});

// THE NODE THAT RUNS THIS TEST IS NODE'S OWN BUILD TOO, so what it links is
// what the deb will carry on the lane of the same major. Node 25 began linking
// libatomic, which a stock Debian 13 does not have; the deb named no libatomic1
// and the first box to take Node 26 would have had a node that could not
// start. The control template has to cover every soname, on every lane.
test('every library the bundled Node links is one the deb depends on', () => {
  const needed = neededLibraries(readFileSync(process.execPath));
  assert.ok(needed.includes('libc.so.6'), `the ELF reader found ${JSON.stringify(needed)} and not libc`);
  assert.deepEqual(undeclaredLibraries(read('control.in'), needed), [], 'control.in Depends does not cover what node links');
  // The table is what makes a missing library a refusal with a package name
  // in it, and a library nobody has named a refusal too.
  assert.deepEqual(
    undeclaredLibraries('Depends: tmux, libc6', ['libc.so.6', 'libatomic.so.1', 'libfoo.so.9']),
    [{ soname: 'libatomic.so.1', package: 'libatomic1' }, { soname: 'libfoo.so.9', package: null }],
  );
  assert.deepEqual(dependsPackages('Depends: debconf (>= 0.5) | debconf-2.0, tmux,\n  libc6'), ['debconf', 'debconf-2.0', 'tmux']);
});

test('SHASUMS256.txt is read by file name, and only a real digest counts', () => {
  const sums = `${'a'.repeat(64)}  node-v1.2.3-linux-x64.tar.xz\nnot-a-sum  node-v1.2.3-linux-arm64.tar.xz\n`;
  assert.equal(shasumFor(sums, 'node-v1.2.3-linux-x64.tar.xz'), 'a'.repeat(64));
  assert.equal(shasumFor(sums, 'node-v1.2.3-linux-arm64.tar.xz'), null);
  assert.equal(shasumFor(sums, 'missing'), null);
});

test('maintainer scripts are POSIX sh, and dash agrees', () => {
  for (const f of ['config', 'postinst', 'prerm', 'postrm']) {
    const file = new URL(f, DEB).pathname;
    assert.equal(spawnSync('sh', ['-n', file]).status, 0, `${f} does not parse`);
    if (has('dash')) assert.equal(spawnSync('dash', ['-n', file]).status, 0, `${f} does not parse under dash`);
  }
});

test('postinst: no apt-get, debconf released before anything prints, the pin not kept', () => {
  const s = read('postinst');
  const code = s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /apt-get|apt install/, 'dpkg holds the lock — apt-get here waits for ever');
  assert.match(code, /FLEETWRIGHT_NO_INSTALL_DEPS=1/);
  assert.match(code, /FLEETWRIGHT_ASK_NONE=1/);
  assert.match(code, /FLEETWRIGHT_RELEASE_SOURCE=apt/);
  assert.ok(code.indexOf('db_stop') < code.indexOf('install.sh'), 'the installer prints into debconf\'s protocol');
  assert.match(code, /db_set fleetwright\/pin ""/);
  // The digest the release pipeline proved, checked before anything unpacks.
  assert.ok(code.indexOf('sha256sum') < code.indexOf('tar -xzf'));
});

test('an upgrade is never asked the fleet questions again', () => {
  const s = read('config');
  assert.match(s, /\[ -z "\$\{2:-\}" \] \|\| exit 0/);
});

/** A Node distribution that is not Node, and the sums file that names it. */
function fakeNodeDist(dir, version, arch, { corrupt = false } = {}) {
  const top = `node-v${version}-linux-${arch}`;
  const tree = path.join(dir, 'tree');
  mkdirSync(path.join(tree, top, 'bin'), { recursive: true });
  writeFileSync(path.join(tree, top, 'bin', 'node'), '#!/bin/sh\necho v0.0.0-fake\n');
  chmodSync(path.join(tree, top, 'bin', 'node'), 0o755);
  writeFileSync(path.join(tree, top, 'LICENSE'), 'fake');
  mkdirSync(path.join(tree, top, 'lib', 'node_modules', 'npm'), { recursive: true });
  writeFileSync(path.join(tree, top, 'lib', 'node_modules', 'npm', 'x'), 'npm is not shipped');
  const tar = path.join(dir, `${top}.tar.xz`);
  execFileSync('tar', ['-cJf', tar, '-C', tree, top]);
  const sum = corrupt ? '0'.repeat(64) : createHash('sha256').update(readFileSync(tar)).digest('hex');
  writeFileSync(path.join(dir, 'SHASUMS256.txt'), `${sum}  ${top}.tar.xz\n`);
}

test('the deb carries the release and bin/node, and nothing of npm', { skip: !has('dpkg-deb') && 'no dpkg-deb' }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), 'host-deb-'));
  const prev = process.env.DEB_NODE_DIST;
  try {
    const nodeDist = path.join(work, 'node');
    mkdirSync(nodeDist);
    fakeNodeDist(nodeDist, '24.0.0', 'x64');
    process.env.DEB_NODE_DIST = nodeDist;

    const tarball = path.join(work, 'fleetwright-host-v1.2.3.tar.gz');
    writeFileSync(tarball, 'not really a tarball');
    const manifest = { version: 'v1.2.3', file: path.basename(tarball), sha256: 'x' };
    const epoch = Date.UTC(2020, 0, 1) / 1000;

    const out1 = path.join(work, 'a');
    const out2 = path.join(work, 'b');
    mkdirSync(out1);
    mkdirSync(out2);
    const deb = await buildDeb({ arch: 'amd64', manifest, tarball, nodeVersion: '24.0.0', epoch, out: out1 });
    const again = await buildDeb({ arch: 'amd64', manifest, tarball, nodeVersion: '24.0.0', epoch, out: out2 });
    assert.equal(path.basename(deb), 'fleetwright_1.2.3_amd64.deb');
    assert.equal(
      createHash('sha256').update(readFileSync(deb)).digest('hex'),
      createHash('sha256').update(readFileSync(again)).digest('hex'),
      'two builds of one release are different bytes',
    );

    const files = execFileSync('dpkg-deb', ['-c', deb], { encoding: 'utf8' });
    assert.match(files, /\.\/usr\/lib\/fleetwright\/node\/bin\/node/);
    assert.match(files, /\.\/usr\/lib\/fleetwright\/release\/fleetwright-host-v1\.2\.3\.tar\.gz/);
    assert.match(files, /\.\/usr\/lib\/fleetwright\/release\/manifest\.json/);
    assert.doesNotMatch(files, /npm/);
    assert.doesNotMatch(files, /\.\/opt\//, 'dpkg must not own the tree that `current` swaps');

    const control = execFileSync('dpkg-deb', ['-f', deb], { encoding: 'utf8' });
    assert.match(control, /^Package: fleetwright$/m);
    assert.match(control, /^Version: 1\.2\.3$/m);
    assert.match(control, /^Architecture: amd64$/m);
    assert.doesNotMatch(control, /@[A-Z]+@/, 'a placeholder survived into control');
  } finally {
    if (prev === undefined) delete process.env.DEB_NODE_DIST;
    else process.env.DEB_NODE_DIST = prev;
    rmSync(work, { recursive: true, force: true });
  }
});

test('a Node that does not match SHASUMS256.txt is not shipped', { skip: !has('dpkg-deb') && 'no dpkg-deb' }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), 'host-deb-bad-'));
  const prev = process.env.DEB_NODE_DIST;
  try {
    const nodeDist = path.join(work, 'node');
    mkdirSync(nodeDist);
    fakeNodeDist(nodeDist, '24.0.0', 'arm64', { corrupt: true });
    process.env.DEB_NODE_DIST = nodeDist;
    const tarball = path.join(work, 't.tar.gz');
    writeFileSync(tarball, 'x');
    await assert.rejects(
      buildDeb({ arch: 'arm64', manifest: { version: '1.0.0' }, tarball, nodeVersion: '24.0.0', epoch: 0, out: work }),
      /refusing to ship it/,
    );
  } finally {
    if (prev === undefined) delete process.env.DEB_NODE_DIST;
    else process.env.DEB_NODE_DIST = prev;
    rmSync(work, { recursive: true, force: true });
  }
});
