// What a killed child leaves of its coverage (test/helpers/child-coverage.js):
// the whole of it or none, and never the half that fails a run in which every
// test passed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { allGone, coverageAside, gatherCoverage } from './helpers/child-coverage.js';

test('a whole coverage file is handed on, and one that was cut short is not', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fw-childcov-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const aside = path.join(dir, 'v8');
  const read = path.join(dir, 'read');
  mkdirSync(aside);
  mkdirSync(read);
  const whole = JSON.stringify({ result: [{ scriptId: '1', url: 'file:///a.js', functions: [] }] });
  writeFileSync(path.join(aside, 'coverage-1-1700000000000-0.json'), whole);
  // As a kill leaves one: stopped part way through a string.
  writeFileSync(path.join(aside, 'coverage-2-1700000000000-0.json'), whole.slice(0, 31));

  assert.equal(gatherCoverage(aside, read), 1);
  assert.deepEqual(readdirSync(read), ['coverage-1-1700000000000-0.json']);
  assert.equal(readFileSync(path.join(read, 'coverage-1-1700000000000-0.json'), 'utf8'), whole);
  // A run that measures nothing has nowhere to hand them, and is not an error.
  assert.equal(gatherCoverage(aside, ''), 0);
  assert.equal(gatherCoverage(path.join(dir, 'never-made'), read), 0);
});

test('a stand-in sends its child’s coverage aside only in a run that measures any', () => {
  // All of what the shell did, so that a failure here says which part of it failed.
  const says = (/** @type {Record<string, string>} */ env) => {
    const r = spawnSync('sh', ['-c', `${coverageAside('"$D/v8"')}\nprintf '%s' "\${NODE_V8_COVERAGE:-none}"`], { env: { PATH: process.env.PATH ?? '', D: '/box', ...env }, encoding: 'utf8' });
    return { said: r.stdout, complained: r.stderr, status: r.status, signal: r.signal, error: r.error?.message ?? null };
  };
  const quietly = { complained: '', status: 0, signal: null, error: null };
  assert.deepEqual(says({ NODE_V8_COVERAGE: '/where/the/runner/reads' }), { said: '/box/v8', ...quietly });
  // Empty, and not left out: Node hands its own NODE_V8_COVERAGE to a child
  // whose environment does not name one, so in a run for coverage "left out"
  // is the first case again.
  assert.deepEqual(says({ NODE_V8_COVERAGE: '' }), { said: 'none', ...quietly });
});

test('waiting for a child to be gone ends when it is, and gives up on one that stays', async (t) => {
  const stays = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => stays.kill('SIGKILL'));
  const leaves = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 150)'], { stdio: 'ignore' });
  assert.equal(await allGone([Number(leaves.pid)], 5000), true);
  assert.equal(await allGone([Number(stays.pid)], 100), false);
  assert.equal(await allGone([]), true);
});
