// The Worker calls Workers AI from exactly one place (fleet-do.js #decide).
//
// Every wall on the decision model's spend is in front of that one call
// (core.js #onHostDecide). A second caller, anywhere in what the Worker
// bundles, would be a way to spend that passes none of them. Read from the
// bundle esbuild actually makes, the same invocation verify.sh's worker line
// uses, so a call site in an imported module is seen as well as one in
// worker/src.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('../worker/', import.meta.url));
const ESBUILD = `${WORKER}node_modules/.bin/esbuild`;

test('exactly one call reaches the AI binding in the Worker bundle', { skip: !existsSync(ESBUILD) && 'worker/node_modules is not installed' }, () => {
  const run = spawnSync(ESBUILD, ['src/worker.js', '--bundle', '--format=esm', '--platform=neutral', '--external:node:*', '--external:cloudflare:*'], {
    cwd: WORKER,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  const sites = [...run.stdout.matchAll(/\bAI\)?\s*\.\s*run\s*\(/g)];
  assert.equal(sites.length, 1, `${sites.length} calls to the AI binding in the bundle; every one but #decide skips the budget`);
});
