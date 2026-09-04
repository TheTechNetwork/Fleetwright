// The matcher behind the Worker's deploy-filter check.
//
// scripts/check-worker-filter.mjs runs esbuild before it can answer anything,
// so the deciding half lives in scripts/worker-filter.mjs and is driven here.
// The check exists because a hand-maintained list fell out of step with an
// import graph twice; a checker for that with no test of its own would be the
// same bet one level up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { matchesPattern, uncovered, prefixes } from '../scripts/worker-filter.mjs';

test('dir/** covers everything beneath it, and nothing beside it', () => {
  assert.equal(matchesPattern('src/mcp/**', 'src/mcp/http.js'), true);
  assert.equal(matchesPattern('src/mcp/**', 'src/mcp/deep/er/file.js'), true);
  assert.equal(matchesPattern('src/mcp/**', 'src/mcpx/http.js'), false, 'a prefix is not a directory');
  assert.equal(matchesPattern('src/mcp/**', 'src/core/text.js'), false);
});

test('worker/** and src/** are told apart, which is the whole point of normalising', () => {
  // esbuild writes its inputs relative to worker/, so `src/worker.js` and
  // `../src/mcp/http.js` are two different trees that both start `src/`. Get
  // this wrong and the check certifies a filter that names neither.
  assert.equal(matchesPattern('worker/**', 'worker/src/worker.js'), true);
  assert.equal(matchesPattern('src/mcp/**', 'worker/src/worker.js'), false);
  assert.equal(matchesPattern('worker/**', 'src/mcp/http.js'), false);
});

test('a bare filename is an exact match, not a prefix', () => {
  assert.equal(matchesPattern('package.json', 'package.json'), true);
  assert.equal(matchesPattern('package.json', 'worker/package.json'), false);
  assert.equal(matchesPattern('package.json', 'package.json.bak'), false);
});

test('a pattern shape it cannot reason about throws instead of guessing', () => {
  // A matcher that quietly disagrees with GitHub lets a deploy through and
  // says nothing, which is the exact failure this whole check is about.
  assert.throws(() => matchesPattern('src/*.js', 'src/a.js'), /cannot reason about/);
  assert.throws(() => matchesPattern('!**/*.md', 'a.md'), /negations/);
});

test('the real bug: src/mcp in the bundle and not in the filter', () => {
  // The filter exactly as main carries it, and the six files that are compiled
  // into the deployed Worker regardless.
  const asMainHasIt = [
    'worker/**',
    'src/fleet/**',
    'src/core/**',
    'package.json',
    'package-lock.json',
    '.github/workflows/worker.yml',
    '!**/*.md',
  ];
  const bundled = ['worker/src/worker.js', 'src/core/text.js', 'src/mcp/http.js', 'src/mcp/oauth.js'];
  assert.deepEqual(uncovered(asMainHasIt, bundled), ['src/mcp/http.js', 'src/mcp/oauth.js']);

  // And with the fix, nothing is uncovered.
  assert.deepEqual(uncovered([...asMainHasIt, 'src/mcp/**'], bundled), []);
});

test('the markdown negation is honoured rather than assumed away', () => {
  // `!**/*.md` is real: a markdown file inside a named directory is excluded,
  // so counting it as uncovered would fail a correct filter forever.
  const patterns = ['worker/**', '!**/*.md'];
  assert.deepEqual(uncovered(patterns, ['worker/README.md']), []);
  assert.deepEqual(uncovered(patterns, ['worker/src/worker.js']), []);
  assert.deepEqual(uncovered(patterns, ['src/mcp/http.js']), ['src/mcp/http.js']);
});

test('a negation it does not understand throws rather than being ignored', () => {
  // Ignoring an unknown negation would over-report; treating it as a match
  // would under-report. Neither is an answer, so it refuses.
  assert.throws(() => uncovered(['worker/**', '!worker/vendor/**'], ['worker/a.js']), /does not understand/);
});

test('prefixes are what the changes job is searched for, with no trailing slash', () => {
  assert.deepEqual(prefixes(['worker/**', 'src/mcp/**', 'package.json', '!**/*.md']), [
    'worker',
    'src/mcp',
  ]);
});

test('the workflow on disk passes its own rules', () => {
  // A cheap tripwire on the thing the whole check is about, without paying for
  // an esbuild run in the suite: every directory the trigger names has to
  // appear in the changes job, and src/mcp has to be named at all.
  const wf = readFileSync('.github/workflows/worker.yml', 'utf8');
  assert.match(wf, /- 'src\/mcp\/\*\*'/, 'the deploy filter must name src/mcp — six of its files are in the bundle');
  assert.match(wf, /src\/mcp\/\*/, 'the changes job must gate on it too');
});
