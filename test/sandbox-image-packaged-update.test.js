// A RELEASE-INSTALLED BOX REFRESHES ITS SESSION IMAGE TOO.
//
// The image step lived inline in update.js's STEPS, and only the git path walks
// those: `runUpdate` returns at `updateStatus` on a packaged box ("is a
// release, not a checkout, so there is nothing to pull"), and the packaged
// branch in commands.js called applyRelease and stopped. So on every
// release-installed host the step was unreachable.
//
// It matters because the image is NOT part of the release. It is published by
// its own workflow to a moving `:latest` tag, so a box can sit on the current
// release and run session bytes from weeks earlier. That is not hypothetical:
// the image was rebuilt with a newer Claude Code, both hosts stayed on the old
// one, and `/update` answered "already on main-137" without ever looking.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { refreshSandboxImageStep } from '../src/core/update.js';

/**
 * A podman whose digest moves on pull, so "did it change" is answerable.
 * @param {{ moves: boolean }} opts
 */
function fakePodman({ moves }) {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-img-'));
  const state = join(dir, 'digest');
  const calls = join(dir, 'calls');
  const bin = join(dir, 'podman');
  writeFileSync(state, 'sha256:aaa\n');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `echo "$@" >> ${calls}`,
      'case "$1" in',
      `  image) cat ${state} ;;`,
      `  pull) ${moves ? `echo "sha256:bbb" > ${state};` : ''} echo pulled ;;`,
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return { bin, calls, dir };
}

test('the step pulls, and says so, when the image moved', async () => {
  const { bin, calls } = fakePodman({ moves: true });
  const r = await refreshSandboxImageStep({
    sandbox: true,
    sandboxImage: 'ghcr.io/example/session:latest',
    podmanBin: bin,
  });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true, 'a moved digest is a change');
  assert.match(r.text ?? '', /updated/);
  assert.match(readFileSync(calls, 'utf8'), /pull ghcr\.io\/example\/session:latest/);
});

test('an unchanged image is reported as up to date, not as a change', async () => {
  const { bin } = fakePodman({ moves: false });
  const r = await refreshSandboxImageStep({
    sandbox: true,
    sandboxImage: 'ghcr.io/example/session:latest',
    podmanBin: bin,
  });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.match(r.text ?? '', /up to date/);
});

test('a locally built image is left alone — there is nothing to pull', async () => {
  const { bin, calls } = fakePodman({ moves: true });
  const r = await refreshSandboxImageStep({
    sandbox: true,
    sandboxImage: 'localhost/fleetwright-session:latest',
    podmanBin: bin,
  });
  assert.equal(r.changed, false);
  assert.match(r.text ?? '', /built locally/);
  let ran = '';
  try {
    ran = readFileSync(calls, 'utf8');
  } catch {
    /* never invoked at all, which is the point */
  }
  assert.doesNotMatch(ran, /pull/, 'a localhost image must never be pulled');
});

test('a registry that refuses does not fail the update', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-img-fail-'));
  const bin = join(dir, 'podman');
  writeFileSync(
    bin,
    ['#!/bin/sh', 'case "$1" in', '  image) echo "sha256:aaa" ;;', '  pull) echo "no route to host" >&2; exit 125 ;;', 'esac'].join('\n'),
  );
  chmodSync(bin, 0o755);
  const r = await refreshSandboxImageStep({
    sandbox: true,
    sandboxImage: 'ghcr.io/example/session:latest',
    podmanBin: bin,
  });
  // The box has a working image; the registry is what went wrong.
  assert.equal(r.ok, true, 'a network hiccup is not an update failure');
  assert.equal(r.changed, false);
  assert.match(r.text ?? '', /Could not refresh/);
});

test('the packaged update path calls the step', async () => {
  // The regression itself: commands.js must reach the step on a packaged box,
  // not only inside update.js's STEPS. Asserted against the source because the
  // packaged branch needs a release manifest, an install dir and a network.
  const src = readFileSync(new URL('../src/adapters/commands.js', import.meta.url), 'utf8');
  const packaged = src.slice(src.indexOf('if (status.packaged)'), src.indexOf('A CHECKOUT THAT COULD STOP BEING ONE'));
  assert.match(packaged, /refreshSandboxImageStep\(ctx\.cfg\)/, 'the packaged branch must refresh the image');
  assert.match(packaged, /flags\.has\('check'\)\s*\?\s*null/, '--check must not pull');
});
