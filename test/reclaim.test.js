// Reclaiming the release directories prune could not remove.
//
// Two halves, tested apart: the POSIX-shell helper that runs as root and does
// the removal, and reclaim.js that decides whether to call it. The helper is the
// security-load-bearing part — it must remove ONLY `.stale-` quarantine and
// nothing else, even when handed a tree full of live releases — so it is driven
// against a real directory layout, the way the confirm watchdog is.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reclaimStale, staleReleases, RECLAIM_BIN } from '../src/core/reclaim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, 'install', 'fleetwright-reclaim');

/** A box laid out the way install.sh lays one out, plus some quarantine. */
function makeBox() {
  const base = mkdtempSync(path.join(tmpdir(), 'reclaim-'));
  mkdirSync(path.join(base, 'releases', 'v1'), { recursive: true });
  writeFileSync(path.join(base, 'releases', 'v1', 'keep'), 'x');
  symlinkSync(path.join(base, 'releases', 'v1'), path.join(base, 'current'));
  return base;
}

test('the helper removes only the quarantine, and nothing else', () => {
  const base = makeBox();
  // Two quarantined releases, with contents, and one live release beside them.
  for (const stale of ['.stale-old-0', '.stale-old-1']) {
    mkdirSync(path.join(base, 'releases', stale, 'lib'), { recursive: true });
    writeFileSync(path.join(base, 'releases', stale, 'lib', 'bundle'), 'x');
  }
  execFileSync('sh', [HELPER], { env: { ...process.env, AGENT_FLEET_BASE: base }, stdio: 'pipe' });

  // The quarantine is gone.
  assert.equal(existsSync(path.join(base, 'releases', '.stale-old-0')), false);
  assert.equal(existsSync(path.join(base, 'releases', '.stale-old-1')), false);
  // The live release and the symlink are untouched — this removes quarantine,
  // not releases.
  assert.equal(existsSync(path.join(base, 'releases', 'v1', 'keep')), true);
  assert.equal(existsSync(path.join(base, 'current')), true);
  rmSync(base, { recursive: true, force: true });
});

test('the helper is a clean no-op when there is no quarantine', () => {
  const base = makeBox();
  // No `.stale-` at all — the glob matches nothing and nothing is removed or
  // errored. The literal-glob trap (`rm` on `.stale-*` as a path) is what this
  // guards against.
  const out = execFileSync('sh', [HELPER], { env: { ...process.env, AGENT_FLEET_BASE: base }, encoding: 'utf8' });
  assert.match(out, /no quarantined releases to reclaim/);
  assert.equal(existsSync(path.join(base, 'releases', 'v1', 'keep')), true);
  rmSync(base, { recursive: true, force: true });
});

test('a name that only looks like quarantine, one level down, is not reached', () => {
  // The glob lists direct children of releases/ only. A `.stale-` nested inside a
  // real release is that release's business, not this helper's.
  const base = makeBox();
  mkdirSync(path.join(base, 'releases', 'v1', '.stale-decoy'), { recursive: true });
  execFileSync('sh', [HELPER], { env: { ...process.env, AGENT_FLEET_BASE: base }, stdio: 'pipe' });
  assert.equal(existsSync(path.join(base, 'releases', 'v1', '.stale-decoy')), true, 'reached past a direct child');
  rmSync(base, { recursive: true, force: true });
});

test('staleReleases lists exactly the quarantine', () => {
  const base = makeBox();
  mkdirSync(path.join(base, 'releases', '.stale-old-0'), { recursive: true });
  mkdirSync(path.join(base, 'releases', '.incoming-v3'), { recursive: true });
  const found = staleReleases(base).sort();
  assert.deepEqual(found, ['.stale-old-0']);
  rmSync(base, { recursive: true, force: true });
});

test('reclaimStale shells out only when there is quarantine AND a helper', () => {
  const base = makeBox();
  const cfg = /** @type {any} */ ({ installDir: path.join(base, 'current') });

  // Nothing quarantined: never calls sudo.
  let calls = 0;
  const countingRun = () => { calls++; return { status: 0, stdout: '', stderr: '' }; };
  assert.equal(reclaimStale(cfg, { run: countingRun, exists: () => true }).reason, 'none');
  assert.equal(calls, 0, 'shelled out with nothing to reclaim');

  // Quarantine present but the helper is not installed yet: reported, not run.
  mkdirSync(path.join(base, 'releases', '.stale-old-0'), { recursive: true });
  const noHelper = reclaimStale(cfg, { run: countingRun, exists: () => false });
  assert.equal(noHelper.reason, 'no_helper');
  assert.equal(calls, 0, 'tried to run a helper it had already found missing');

  // Quarantine present and the helper installed: runs `sudo -n <bin>`.
  /** @type {any[]} */
  let seen = [];
  const spy = (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
    seen = [cmd, args];
    return { status: 0, stdout: '', stderr: '' };
  };
  const swept = reclaimStale(cfg, { run: spy, exists: () => true });
  assert.equal(swept.swept, true);
  assert.deepEqual(seen, ['sudo', ['-n', RECLAIM_BIN]]);
  rmSync(base, { recursive: true, force: true });
});

test('reclaimStale never throws, and a refused sudo is a report', () => {
  const base = makeBox();
  mkdirSync(path.join(base, 'releases', '.stale-old-0'), { recursive: true });
  const cfg = /** @type {any} */ ({ installDir: path.join(base, 'current') });
  // sudo -n with no rule exits non-zero — this is a state to report, not throw.
  const denied = reclaimStale(cfg, {
    run: () => ({ status: 1, stdout: '', stderr: 'sudo: a password is required' }),
    exists: () => true,
  });
  assert.equal(denied.swept, false);
  assert.equal(denied.reason, 'failed');
  assert.match(String(denied.message), /password is required/);
  rmSync(base, { recursive: true, force: true });
});

test('an unpackaged box has nothing to reclaim', () => {
  const cfg = /** @type {any} */ ({ installDir: '/opt/agent-fleet' });
  assert.equal(reclaimStale(cfg, { run: () => ({ status: 0 }), exists: () => true }).reason, 'unpackaged');
});

test('staleReleases is empty, not a throw, when there is no releases dir', () => {
  // A box with no releases/ (a checkout, a half-set-up box) is a clean empty
  // answer — reading a directory that is not there must not take the caller down.
  assert.deepEqual(staleReleases('/no/such/base'), []);
});

test('a helper that cannot even be spawned is a report, not a throw', () => {
  const base = makeBox();
  mkdirSync(path.join(base, 'releases', '.stale-old-0'), { recursive: true });
  const cfg = /** @type {any} */ ({ installDir: path.join(base, 'current') });
  // spawnSync itself throwing (no sudo on PATH, say) is the same kind of event
  // as a non-zero exit: logged and reported, never thrown out of housekeeping.
  const r = reclaimStale(cfg, {
    run: () => { throw new Error('spawnSync sudo ENOENT'); },
    exists: () => true,
  });
  assert.equal(r.swept, false);
  assert.equal(r.reason, 'failed');
  assert.match(String(r.message), /ENOENT/);
  rmSync(base, { recursive: true, force: true });
});
