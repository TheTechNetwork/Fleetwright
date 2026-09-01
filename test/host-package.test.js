import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Building is slow and needs esbuild, so this is one build shared by the whole
// file rather than one per test.
let dir = null;
function release() {
  if (dir) return dir;
  execFileSync(process.execPath, [path.join(ROOT, 'tools/build-host-package.mjs')], {
    cwd: ROOT,
    env: { ...process.env, RELEASE_VERSION: 'test-1' },
    stdio: 'pipe',
  });
  dir = path.join(ROOT, 'dist', 'fleetwright-host-test-1');
  return dir;
}

test('the release carries every file the code reaches for at runtime', () => {
  const r = release();
  // Each of these is read by name at runtime, and each was found by a path
  // computed with `..` from a source file — which is a statement about depth in
  // the source tree, not about the install. See core/resources.js.
  for (const f of [
    'package.json',        // also how resources.js FINDS the root
    'openapi.json',        // served at /openapi.json by the coordinator
    'src/web/index.html',  // the local web UI
    'install/install.sh',  // so a release can install and migrate itself
    'sandbox/entrypoint.sh',
    'lib/agent-hub.mjs',
    'lib/agent-fleet-sidecar.mjs',
    'lib/agent-fleet-mcp.mjs',
    'bin/agent-hub',
  ]) {
    assert.equal(existsSync(path.join(r, f)), true, `release is missing ${f}`);
  }
});

test('whole directories ship whole', () => {
  // Named files go stale: sandbox/ has grown a credential client and a tool
  // shim since this was written, and a test listing filenames would have
  // shipped the release without them while staying green. What matters is that
  // the directory arrives complete.
  const r = release();
  for (const d of ['sandbox', 'install', 'src/web']) {
    const inRepo = readdirSync(path.join(ROOT, d)).sort();
    const inRelease = readdirSync(path.join(r, d)).sort();
    assert.deepEqual(inRelease, inRepo, `${d}/ differs between the repo and the release`);
  }
});

test('there is no node_modules and nothing declares a dependency', () => {
  // The point of the release, not a side effect. npm runs lifecycle scripts
  // from every package in the tree; a release is unpacked and runs none.
  const r = release();
  assert.equal(existsSync(path.join(r, 'node_modules')), false);
  const pkg = JSON.parse(readFileSync(path.join(r, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  // jose is the one runtime dependency, so it has to be INSIDE the bundle —
  // absent from both places would mean it was simply dropped.
  const bundle = readFileSync(path.join(r, 'lib/agent-fleet-sidecar.mjs'), 'utf8');
  assert.equal(/from ["']jose["']/.test(bundle), false, 'jose is still an external import');
});

test('the bundle runs with no dependencies present, from an unrelated cwd', () => {
  // The failure this catches is a bundle that only works when its own source
  // tree happens to be next to it.
  const r = release();
  const elsewhere = mkdtempSync(path.join(tmpdir(), 'cwd-'));
  try {
    const out = execFileSync(process.execPath, [path.join(r, 'lib/agent-hub.mjs'), '--help'], {
      cwd: elsewhere,
      encoding: 'utf8',
    });
    assert.match(out, /agent-hub/);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('the manifest says what a host needs before it commits to the update', () => {
  release();
  const m = JSON.parse(readFileSync(path.join(ROOT, 'dist/manifest.json'), 'utf8'));
  assert.equal(m.version, 'test-1');
  assert.match(m.sha256, /^[0-9a-f]{64}$/);
  // THE FLAG DAY, VISIBLE BEFORE IT HAPPENS. Without this a host discovers a
  // protocol mismatch after updating, when it can no longer say so.
  assert.equal(typeof m.protocol, 'number');
});

test('two builds of one commit are byte-identical', () => {
  // Otherwise the digest is a statement about a build machine rather than
  // about the code, and "has this host been tampered with" has no answer.
  const first = release();
  const a = execFileSync('sha256sum', [path.join(ROOT, 'dist/fleetwright-host-test-1.tar.gz')], { encoding: 'utf8' });
  dir = null;
  release();
  const b = execFileSync('sha256sum', [path.join(ROOT, 'dist/fleetwright-host-test-1.tar.gz')], { encoding: 'utf8' });
  assert.equal(a.split(' ')[0], b.split(' ')[0]);
  assert.equal(first, dir);
});
