// /update refreshes the sandbox image.
//
// ensureSandboxImage returned on its first line for the entire life of a box
// -- `if (sandboxImageExists) return` -- because the image was written as a
// one-time install. It is a moving dependency: the session entrypoint, the
// credential seeding and the trust flags all live inside it. So a fix shipped
// there reached nobody until somebody ran `podman pull` by hand, and the
// account-identity fix sat undelivered on every box that had already pulled
// once.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { refreshSandboxImage } from '../src/core/podman.js';

/** A cfg whose podman is a script we control. */
function fakePodman(responses) {
  const calls = [];
  return {
    calls,
    cfg: {
      sandbox: true,
      sandboxImage: 'ghcr.io/example/session:latest',
      podmanBin: 'true', // never actually run; podman() is stubbed by injection below
    },
    responses,
  };
}

test('a refresh reports changed only when the digest actually moves', async (t) => {
  // podman() is module-private, so drive the real function through a fake
  // binary: a tiny shell script that answers inspect/pull from a file.
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'podman-'));
  const state = join(dir, 'digest');
  const bin = join(dir, 'podman');
  writeFileSync(state, 'sha256:aaa');
  writeFileSync(bin, [
    '#!/bin/sh',
    'case "$1" in',
    '  image) cat ' + state + ' ;;',
    '  pull) echo "sha256:bbb" > ' + state + '; echo pulled ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n'));
  chmodSync(bin, 0o755);

  const cfg = { podmanBin: bin, sandboxImage: 'ghcr.io/example/session:latest' };
  const moved = refreshSandboxImage(cfg);
  assert.equal(moved.ok, true);
  assert.equal(moved.changed, true, 'aaa -> bbb is a change');

  // Second pull: the script now writes the same digest it reads.
  writeFileSync(bin, [
    '#!/bin/sh',
    'case "$1" in',
    '  image) cat ' + state + ' ;;',
    '  pull) echo pulled ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n'));
  chmodSync(bin, 0o755);
  const same = refreshSandboxImage(cfg);
  assert.equal(same.ok, true);
  assert.equal(same.changed, false, 'an unchanged digest is not a change');
});

test('a failed pull is reported, not thrown', async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'podman-fail-'));
  const bin = join(dir, 'podman');
  writeFileSync(bin, '#!/bin/sh\necho "no route to host" >&2\nexit 1\n');
  chmodSync(bin, 0o755);

  // A registry that is down must not fail the update: the box has a working
  // image and the network is what broke.
  const r = refreshSandboxImage({ podmanBin: bin, sandboxImage: 'ghcr.io/example/session:latest' });
  assert.equal(r.ok, false);
  assert.equal(r.changed, false);
  assert.match(r.message, /no route to host/);
});
