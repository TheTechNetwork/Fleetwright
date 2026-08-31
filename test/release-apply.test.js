import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, existsSync, rmSync, symlinkSync, renameSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyRelease, releaseLayout, installedVersion } from '../src/core/release-apply.js';

/** A release tarball with a real bundle in it, built by hand — no CI needed. */
function makeRelease(version, { entry = 'process.stdout.write("agent-hub help\\n");' } = {}) {
  const work = mkdtempSync(path.join(tmpdir(), 'mk-'));
  const stage = path.join(work, `fleetwright-host-${version}`);
  mkdirSync(path.join(stage, 'lib'), { recursive: true });
  writeFileSync(path.join(stage, 'lib', 'agent-hub.mjs'), entry);
  writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'agent-fleet', version }));
  execFileSync('tar', ['-czf', path.join(work, 'r.tar.gz'), '-C', work, `fleetwright-host-${version}`]);
  const bytes = readFileSync(path.join(work, 'r.tar.gz'));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), work };
}

/** A box laid out the way install.sh lays one out. */
function makeBox(version) {
  const base = mkdtempSync(path.join(tmpdir(), 'box-'));
  const dir = path.join(base, 'releases', version);
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
  writeFileSync(path.join(dir, 'lib', 'agent-hub.mjs'), '');
  symlinkSync(dir, path.join(base, 'current'));
  return { base, current: path.join(base, 'current') };
}

/** @param {{bytes: Uint8Array, sha256: string}} rel */
function serve(rel, manifest) {
  return async (url) => {
    if (String(url).endsWith('manifest.json')) {
      return { ok: true, status: 200, json: async () => manifest };
    }
    return { ok: true, status: 200, arrayBuffer: async () => rel.bytes.buffer.slice(rel.bytes.byteOffset, rel.bytes.byteOffset + rel.bytes.byteLength) };
  };
}

const URL_ = 'https://releases.example/fleet/manifest.json';

test('a newer release is fetched, verified, unpacked and pointed at', async () => {
  const box = makeBox('old-1');
  const rel = makeRelease('new-2');
  const r = await applyRelease({
    installDir: box.current,
    manifestUrl: URL_,
    protocol: 2,
    fetch: serve(rel, { version: 'new-2', file: 'r.tar.gz', sha256: rel.sha256, protocol: 2 }),
  });

  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(path.basename(readlinkSync(box.current)), 'new-2');
  assert.equal(installedVersion(box.current), 'new-2');
  // It says the running process is still the old one. A message that implied
  // otherwise would be the "Restart to apply" bug in a new place.
  assert.match(r.message, /still the old one/);
  rmSync(box.base, { recursive: true, force: true });
});

test('a bad digest changes nothing at all', async () => {
  // The property to preserve: every step before the symlink move is reversible
  // by doing nothing.
  const box = makeBox('old-1');
  const rel = makeRelease('new-2');
  const r = await applyRelease({
    installDir: box.current,
    manifestUrl: URL_,
    protocol: 2,
    fetch: serve(rel, { version: 'new-2', file: 'r.tar.gz', sha256: 'b'.repeat(64), protocol: 2 }),
  });

  assert.equal(r.ok, false);
  assert.match(r.message, /digest mismatch/);
  assert.equal(path.basename(readlinkSync(box.current)), 'old-1');
  assert.equal(existsSync(path.join(box.base, 'releases', 'new-2')), false);
  rmSync(box.base, { recursive: true, force: true });
});

test('a release that cannot run is refused before anything points at it', async () => {
  // The last moment where finding this out is free. After the swap, systemd
  // restarts the corpse every three seconds.
  const box = makeBox('old-1');
  const rel = makeRelease('broken-2', { entry: 'throw new Error("boom");' });
  const r = await applyRelease({
    installDir: box.current,
    manifestUrl: URL_,
    protocol: 2,
    fetch: serve(rel, { version: 'broken-2', file: 'r.tar.gz', sha256: rel.sha256, protocol: 2 }),
  });

  assert.equal(r.ok, false);
  assert.match(r.message, /does not run on this box/);
  assert.equal(path.basename(readlinkSync(box.current)), 'old-1');
  // And no debris left behind for the next attempt to trip over.
  assert.deepEqual(readdirSync(path.join(box.base, 'releases')), ['old-1']);
  rmSync(box.base, { recursive: true, force: true });
});

test('a protocol mismatch never downloads anything', async () => {
  const box = makeBox('old-1');
  let fetched = 0;
  const r = await applyRelease({
    installDir: box.current,
    manifestUrl: URL_,
    protocol: 2,
    fetch: async (url) => {
      fetched++;
      return { ok: true, status: 200, json: async () => ({ version: 'new-2', file: 'r.tar.gz', sha256: 'a'.repeat(64), protocol: 3 }) };
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /Update the coordinator first/);
  assert.equal(fetched, 1, 'only the manifest should have been fetched');
  rmSync(box.base, { recursive: true, force: true });
});

test('the release before last is kept, and older ones are not', async () => {
  // A rollback target that was tidied away is not a rollback target.
  const box = makeBox('v1');
  mkdirSync(path.join(box.base, 'releases', 'v0'), { recursive: true });
  const rel = makeRelease('v2');
  await applyRelease({
    installDir: box.current,
    manifestUrl: URL_,
    protocol: 2,
    fetch: serve(rel, { version: 'v2', file: 'r.tar.gz', sha256: rel.sha256, protocol: 2 }),
  });
  const left = readdirSync(path.join(box.base, 'releases')).sort();
  assert.deepEqual(left, ['v1', 'v2']);
  rmSync(box.base, { recursive: true, force: true });
});

test('a box that is not laid out for releases is told which it is', async () => {
  const r = releaseLayout('/opt/agent-fleet');
  assert.equal(r.ok, false);
  assert.match(r.message, /Re-run install\.sh/);
  assert.equal(releaseLayout('/opt/fleetwright/current').ok, true);
});

test('a traversing version never reaches the filesystem', async () => {
  // The end-to-end half of the release.js test: proving the refusal happens
  // BEFORE anything is created, not merely that the decision says no.
  const box = makeBox('old-1');
  const outside = path.join(path.dirname(box.base), 'escaped-' + path.basename(box.base));
  const rel = makeRelease('x');
  const r = await applyRelease({
    installDir: box.current,
    manifestUrl: URL_,
    protocol: 2,
    fetch: serve(rel, { version: `../../${path.basename(outside)}`, file: 'r.tar.gz', sha256: rel.sha256, protocol: 2 }),
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /not a plain name/);
  assert.equal(existsSync(outside), false, 'a directory was created outside the release base');
  assert.equal(path.basename(readlinkSync(box.current)), 'old-1');
  rmSync(box.base, { recursive: true, force: true });
});

test('an unreachable manifest is a message, not a crash', async () => {
  const box = makeBox('old-1');
  const r = await applyRelease({
    installDir: box.current,
    manifestUrl: URL_,
    protocol: 2,
    fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /could not reach the release manifest/);
  assert.equal(path.basename(readlinkSync(box.current)), 'old-1');
  rmSync(box.base, { recursive: true, force: true });
});
