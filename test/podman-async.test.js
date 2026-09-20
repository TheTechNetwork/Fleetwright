// The long podman calls run off the event loop.
//
//   node --test test/
//
// docs/recommendations-review.md §8: an image build held the event loop for
// minutes, so `/api/state` did not answer and the sidecar's health frame did
// not go out — the coordinator marked the host degraded for the length of a
// build. The old comment said the build "blocks the session that asked for
// it"; it blocked the box. What is pinned here is that it no longer does, and
// that the async runner keeps the properties the synchronous one had: a
// timeout that kills, a missing binary that answers rather than throws, and
// stdin as the way content travels.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { podmanAsync, ensureSandboxImage } from '../src/core/podman.js';

/**
 * A podman whose `build` takes a while, so the test can watch what else
 * happens meanwhile.
 * @param {import('node:test').TestContext} t
 * @param {{ buildSeconds?: number }} [opts]
 */
function slowPodman(t, { buildSeconds = 0.4 } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'podman-async-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'podman');
  const stdinLog = path.join(dir, 'stdin.txt');
  writeFileSync(
    bin,
    `#!/bin/sh
case "$1" in
  build) sleep ${buildSeconds}; exit 0 ;;
  "image") exit 1 ;;
  sleep) sleep "$2"; exit 0 ;;
  echo-stdin) cat > ${stdinLog}; exit 0 ;;
  fail) echo "nope" >&2; exit 3 ;;
esac
exit 0
`,
  );
  chmodSync(bin, 0o755);
  mkdirSync(path.join(dir, 'sandbox'));
  const containerfile = path.join(dir, 'sandbox', 'Containerfile');
  writeFileSync(containerfile, 'FROM debian:13-slim\n');
  return {
    dir,
    stdin: () => (existsSync(stdinLog) ? readFileSync(stdinLog, 'utf8') : ''),
    /** @param {Partial<any>} patch @returns {any} */
    cfg: (patch = {}) => ({
      podmanBin: bin,
      sandboxImage: 'localhost/agent-session:latest',
      sandboxAutoBuild: true,
      sandboxContainerfile: containerfile,
      stateDir: dir,
      ...patch,
    }),
  };
}

test('an image build no longer holds the event loop', async (t) => {
  // A timer that fires every 20ms is the health frame in miniature. Under the
  // old spawnSync it fired ZERO times during a build; now it keeps time.
  const s = slowPodman(t, { buildSeconds: 0.4 });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  t.after(() => clearInterval(timer));

  const r = await ensureSandboxImage(s.cfg());

  clearInterval(timer);
  assert.equal(r.ok, true);
  assert.equal(r.built, true);
  assert.ok(ticks >= 5, `the loop kept turning during the build (${ticks} ticks)`);
});

test('podmanAsync returns the same shape as podman()', async (t) => {
  const s = slowPodman(t);
  const ok = await podmanAsync(s.cfg(), ['--version']);
  assert.deepEqual(ok, { status: 0, stdout: '', stderr: '' });

  const failed = await podmanAsync(s.cfg(), ['fail']);
  assert.equal(failed.status, 3);
  assert.match(failed.stderr, /nope/);
});

test('a timeout kills the child rather than abandoning it', async (t) => {
  // A build left running after its caller gave up would still be eating the
  // box, and would race the next attempt for the same tag.
  const s = slowPodman(t);
  const started = Date.now();
  const r = await podmanAsync(s.cfg(), ['sleep', '5'], { timeout: 150 });
  assert.ok(Date.now() - started < 2000, 'it did not wait the five seconds');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /timed out after/);
});

test('a missing binary is an answer, not an exception', async () => {
  const r = await podmanAsync(/** @type {any} */ ({ podmanBin: '/nonexistent/podman' }), ['--version']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ENOENT/);
});

test('input reaches the child on stdin, never the argument list', async (t) => {
  const s = slowPodman(t);
  const r = await podmanAsync(s.cfg(), ['echo-stdin'], { input: 'secret bytes\n' });
  assert.equal(r.status, 0);
  assert.equal(s.stdin(), 'secret bytes\n');
});
