// A session start checks for a newer sandbox image -- cheaply, and never in
// the way.
//
// /update refreshing the image fixes it for people who run /update. A session
// that starts on a stale image still gets stale behaviour, and the whole class
// of bug this chases (a fix shipped in the image reaching nobody) is one
// somebody discovers by using the product, not by updating it.
//
// The constraints are the feature: stamped, bounded, never fatal, and only
// when a NEW volume is about to be seeded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { refreshSandboxImageIfStale } from '../src/core/podman.js';

/** A podman that records every call and answers a fixed digest. */
function scriptedPodman(digestAfterPull = 'sha256:bbb') {
  const dir = mkdtempSync(join(tmpdir(), 'stale-'));
  const log = join(dir, 'calls');
  const state = join(dir, 'digest');
  const bin = join(dir, 'podman');
  writeFileSync(state, 'sha256:aaa');
  writeFileSync(log, '');
  writeFileSync(bin, [
    '#!/bin/sh',
    'echo "$1" >> ' + log,
    'case "$1" in',
    '  image) cat ' + state + ' ;;',
    '  pull) echo "' + digestAfterPull + '" > ' + state + ' ;;',
    'esac',
  ].join('\n'));
  chmodSync(bin, 0o755);
  return {
    dir,
    cfg: {
      podmanBin: bin,
      sandboxImage: 'ghcr.io/example/session:latest',
      stateDir: dir,
      sandboxRefreshMs: 6 * 60 * 60 * 1000,
    },
    pulls: () => readFileSync(log, 'utf8').split('\n').filter((l) => l === 'pull').length,
  };
}

test('the first start since install checks, and notices a change', () => {
  const p = scriptedPodman();
  const r = refreshSandboxImageIfStale(p.cfg);
  assert.equal(r.changed, true);
  assert.equal(p.pulls(), 1);
  assert.ok(existsSync(join(p.dir, '.sandbox-image-checked')), 'the check is stamped');
});

test('a second start inside the window does not touch the registry', () => {
  // A pull per start would put a registry between a person and their session.
  const p = scriptedPodman();
  refreshSandboxImageIfStale(p.cfg);
  const after = p.pulls();
  refreshSandboxImageIfStale(p.cfg);
  refreshSandboxImageIfStale(p.cfg);
  assert.equal(p.pulls(), after, 'no further pulls inside the window');
});

test('once the window passes, it checks again', () => {
  const p = scriptedPodman();
  refreshSandboxImageIfStale(p.cfg);
  const stamp = join(p.dir, '.sandbox-image-checked');
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  utimesSync(stamp, old, old);
  refreshSandboxImageIfStale(p.cfg);
  assert.equal(p.pulls(), 2);
});

test('a failed check is stamped too, so an offline box does not retry every start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-'));
  const bin = join(dir, 'podman');
  writeFileSync(bin, '#!/bin/sh\necho "no route to host" >&2\nexit 1\n');
  chmodSync(bin, 0o755);
  const cfg = { podmanBin: bin, sandboxImage: 'ghcr.io/x/y:latest', stateDir: dir, sandboxRefreshMs: 60_000 };

  const r = refreshSandboxImageIfStale(cfg);
  assert.equal(r.changed, false, 'a failure is not a change');
  assert.ok(existsSync(join(dir, '.sandbox-image-checked')), 'stamped anyway');
});

test('a locally built image is never chased', () => {
  const p = scriptedPodman();
  const r = refreshSandboxImageIfStale({ ...p.cfg, sandboxImage: 'localhost/agent-session:latest' });
  assert.equal(r.changed, false);
  assert.equal(p.pulls(), 0, 'a box that builds its own image is saying it wants that one');
});

test('zero disables the check entirely', () => {
  const p = scriptedPodman();
  refreshSandboxImageIfStale({ ...p.cfg, sandboxRefreshMs: 0 });
  assert.equal(p.pulls(), 0);
});
