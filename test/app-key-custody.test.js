// Where the GitHub App's private key may go in CI, and when.
//
//   node --test test/app-key-custody.test.js
//
// The key mints installation tokens for EVERY installation of an App anybody
// can install, so a repository secret read by the job that deploys on every
// push to main is one workflow edit away from a log line. This holds the rule
// worker.yml's minter-key job states: the key is an ENVIRONMENT secret of
// `github-app-key`, read by one job, which runs only when a person starts the
// workflow by hand and asks for it, and which the environment's required
// reviewer then has to approve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';

const WORKFLOW = /** @type {any} */ (load(readFileSync(new URL('../.github/workflows/worker.yml', import.meta.url), 'utf8')));
// The App key, and the key Claude logins are deposited to: each opens
// something for everybody in the fleet, so each is held to the same rule.
const KEYS = ['FLEETWRIGHT_GITHUB_APP_KEY', 'FLEETWRIGHT_MINTER_DEPOSIT_KEY'];

test('one job reads each minter key, and it is not the job that deploys on every push', () => {
  for (const key of KEYS) {
    const readers = Object.entries(WORKFLOW.jobs)
      .filter(([, job]) => JSON.stringify(job).includes(`secrets.${key}`))
      .map(([name]) => name);
    assert.deepEqual(readers, ['minter-key'], key);
  }
});

test('that job waits for a person: a manual run, the box ticked, on main, behind its own environment', () => {
  const job = WORKFLOW.jobs['minter-key'];
  // Its own environment, so its secret is not the deploy job's and its
  // reviewer gates this job alone rather than every coordinator deploy.
  assert.equal(job.environment, 'github-app-key');
  assert.notEqual(WORKFLOW.jobs.deploy.environment, 'github-app-key');
  for (const condition of ["github.ref == 'refs/heads/main'", "github.event_name == 'workflow_dispatch'", 'inputs.sync_app_key']) {
    assert.ok(String(job.if).includes(condition), `minter-key runs without: ${condition}`);
  }
  // Off unless ticked: a manual run is otherwise an ordinary deploy.
  assert.equal(WORKFLOW.on.workflow_dispatch.inputs.sync_app_key.default, false);
});

test('the keys go to the minting Worker and to nothing else', () => {
  const job = WORKFLOW.jobs['minter-key'];
  const run = job.steps.map((/** @type {any} */ s) => s.run || '').join('\n');
  // Every `secret put` in the job names the minter's config, and the names it
  // puts are exactly the keys this job was given.
  const puts = [...run.matchAll(/wrangler secret put (\S+)([^\n]*)/g)];
  assert.ok(puts.length > 0);
  for (const put of puts) assert.match(put[2], /--config wrangler\.minter\.toml/);
  const given = job.steps.flatMap((/** @type {any} */ s) => Object.keys(s.env || {})).filter((k) => KEYS.includes(k));
  assert.deepEqual(given.sort(), [...KEYS].sort());
});
