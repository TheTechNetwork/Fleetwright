// The labelling rules, held to the tree they describe.
//
// A rule file like .github/labeler.yml rots in one direction only: a file is
// added somewhere no rule names, and the pull request that adds it arrives
// without a label, which reads as "nobody looked". So every tracked file has
// to match a `platform/*` rule, and every glob in the file has to match
// something that exists — a rule for a path that was renamed away is a rule
// that quietly stopped labelling.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The repository's own label set, the day this was written. */
const LABELS = new Set([
  'platform/ios', 'platform/android', 'platform/coordinator', 'platform/host', 'platform/cli', 'platform/docs',
  'area/ci', 'area/credentials', 'area/install', 'area/notifications', 'area/onboarding', 'area/protocol',
  'area/security', 'area/sessions',
]);

/** @type {Record<string, Array<{ 'changed-files': Array<{ 'any-glob-to-any-file': string | string[] }> }>>} */
const rules = load(readFileSync(path.join(ROOT, '.github/labeler.yml'), 'utf8'));

/** Every glob under one label, flattened. */
function globsOf(label) {
  return rules[label].flatMap((r) => r['changed-files'].flatMap((c) => [c['any-glob-to-any-file']].flat()));
}

const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

/** Tracked files one glob matches, the way the action's matcher would. */
function matches(glob) {
  // A bare `*.md` in labeler is root-only; globSync agrees. `**` is deep.
  const hits = new Set(globSync(glob, { cwd: ROOT }).map((p) => p.split(path.sep).join('/')));
  return tracked.filter((f) => hits.has(f) || [...hits].some((d) => f.startsWith(`${d}/`)));
}

test('every label the rules name exists in the repository', () => {
  for (const label of Object.keys(rules)) assert.ok(LABELS.has(label), `${label} is not a label this repository has`);
});

test('every glob matches something tracked, so no rule is quietly dead', () => {
  for (const label of Object.keys(rules)) {
    for (const glob of globsOf(label)) {
      assert.ok(matches(glob).length > 0, `${label}: '${glob}' matches nothing in the tree`);
    }
  }
});

test('every tracked file lands on a platform or on the tooling, so no pull request arrives unlabelled', () => {
  // The tooling — workflows, scripts, tests, the package files — is not a
  // platform; area/ci is where a change to it lands.
  const covered = new Set();
  for (const label of Object.keys(rules).filter((l) => l.startsWith('platform/') || l === 'area/ci')) {
    for (const glob of globsOf(label)) for (const f of matches(glob)) covered.add(f);
  }
  const missed = tracked.filter((f) => !covered.has(f));
  assert.deepEqual(missed, [], 'files no platform rule names — add them to .github/labeler.yml');
});

test('the workflow runs the rule file with sync on, and checks nothing out', () => {
  /** @type {any} */
  const wf = load(readFileSync(path.join(ROOT, '.github/workflows/label.yml'), 'utf8'));
  // pull_request_target with no checkout is the safe shape; a checkout of the
  // head under that token would run a fork's code with write on the PR.
  assert.ok(wf.on['pull_request_target']);
  assert.ok(wf.on['pull_request_target'].types.includes('synchronize'), 'labels would not follow the diff');
  const steps = wf.jobs.label.steps;
  assert.equal(steps.some((s) => /actions\/checkout/.test(s.uses || '')), false, 'a checkout under pull_request_target');
  const labeler = steps.find((s) => /^actions\/labeler@/.test(s.uses || ''));
  assert.ok(labeler);
  assert.equal(labeler.with['configuration-path'], '.github/labeler.yml');
  assert.equal(labeler.with['sync-labels'], true);
  assert.equal(wf.permissions['pull-requests'], 'write');
  assert.equal(wf.permissions.contents, 'read');
});
