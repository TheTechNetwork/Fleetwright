// Checking the repository somebody's runners will come from.
//
//   node --test test/runner-repo.test.js
//
// The check is asked with the person's own GitHub connection and answers four
// things a dispatch depends on: is the repository public, does the Fleetwright
// GitHub App reach it, with Actions write, and which runner workflows does it
// carry. Each refusal sends somebody to a different place, so each is its own
// row below, and "cannot tell" is kept apart from "no" throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkRunnerRepo } from '../src/core/runners.js';
import { checkParams } from '../src/fleet/protocol/intents.js';
import { HostRegistry } from '../src/fleet/coordinator/registry.js';
import { place } from '../src/fleet/coordinator/scheduler.js';

const json = (/** @type {number} */ status, /** @type {any} */ body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * GitHub, as far as the check asks it. Every answer is overridable per case,
 * and a path nobody configured is a 404 — which is what GitHub says too.
 * @param {Record<string, () => Response>} routes
 */
function github(routes) {
  /** @type {string[]} */
  const asked = [];
  const impl = /** @type {any} */ (async (/** @type {string} */ url) => {
    const path = String(url).replace('https://api.github.com', '');
    asked.push(path);
    const hit = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
    return hit ? hit[1]() : json(404, { message: 'Not Found' });
  });
  return { impl, asked };
}

const repoPublic = () => json(200, { full_name: 'Eli/Runners', private: false, permissions: { push: true } });
const installedAll = () =>
  json(200, { installations: [{ id: 7, account: { login: 'eli' }, repository_selection: 'all', permissions: { actions: 'write' } }] });
const twoWorkflows = () => json(200, [{ name: 'runner-linux.yml' }, { name: 'runner-macos.yml' }, { name: 'ci.yml' }]);

test('a repository that can start machines says which, spelled as GitHub spells it', async () => {
  const { impl } = github({
    '/repos/eli/runners/': () => json(404, {}),
    '/repos/eli/runners': repoPublic,
    '/user/installations': installedAll,
    '/repos/Eli/Runners/contents/.github/workflows': twoWorkflows,
  });
  const r = await checkRunnerRepo({ repo: 'eli/runners', token: 'ghu_x', fetchImpl: impl });
  assert.equal(r.ok, true, r.message);
  // The canonical name is the one worth saving: two spellings of one
  // repository are two strings to anything that compares them later.
  assert.equal(r.repo, 'Eli/Runners');
  assert.deepEqual(r.platforms, ['macos', 'linux']);
  assert.deepEqual(r.missing, ['windows', 'android']);
  assert.equal(r.public, true);
  assert.equal(r.installed, true);
  assert.equal(r.actionsWrite, true);
  assert.match(r.message, /no workflow for windows, android/);
});

test('each thing that would stop a dispatch is its own refusal, naming the fix', async () => {
  /** @type {Array<[string, Record<string, () => Response>, RegExp, Partial<Record<string, any>>]>} */
  const cases = [
    ['private', { '/repos/eli/runners': () => json(200, { full_name: 'eli/runners', private: true }) }, /is private/, { public: false }],
    ['unseen', {}, /picked when it was installed/, { public: null }],
    [
      'not installed',
      { '/repos/eli/runners': repoPublic, '/user/installations': () => json(200, { installations: [] }) },
      /not installed on Eli/,
      { installed: false },
    ],
    [
      'installed, repository not picked',
      {
        '/repos/eli/runners': repoPublic,
        '/user/installations/7/repositories': () => json(200, { repositories: [{ full_name: 'eli/other' }] }),
        '/user/installations': () =>
          json(200, { installations: [{ id: 7, account: { login: 'ELI' }, repository_selection: 'selected', permissions: { actions: 'write' } }] }),
      },
      /not one of the repositories it was given/,
      { installed: false },
    ],
    [
      'no Actions write',
      {
        '/repos/eli/runners': repoPublic,
        '/user/installations': () =>
          json(200, { installations: [{ id: 7, account: { login: 'eli' }, repository_selection: 'all', permissions: { actions: 'read' } }] }),
      },
      /without Actions write/,
      { installed: true, actionsWrite: false },
    ],
    [
      'no workflows',
      { '/repos/eli/runners': repoPublic, '/user/installations': installedAll },
      /none of the runner workflows/,
      { platforms: [] },
    ],
  ];
  for (const [name, routes, expected, fields] of cases) {
    const r = await checkRunnerRepo({ repo: 'eli/runners', token: 't', fetchImpl: github(routes).impl });
    assert.equal(r.ok, false, name);
    assert.match(r.message, expected, name);
    for (const [k, v] of Object.entries(fields)) assert.deepEqual(/** @type {any} */ (r)[k], v, `${name}: ${k}`);
  }
});

test('a personal token cannot see installations, and that is "cannot tell", not "no"', async () => {
  // GitHub refuses the installation list to anything but a GitHub App token.
  // Reporting "not installed" to somebody who installed it would send them to
  // reinstall something that was never the problem; their own push access is
  // what a personal token dispatches with, so that is what decides.
  const routes = {
    '/repos/eli/runners': repoPublic,
    '/user/installations': () => json(403, { message: 'You must authenticate with an access token authorized to a GitHub App' }),
    '/repos/Eli/Runners/contents/.github/workflows': twoWorkflows,
  };
  const r = await checkRunnerRepo({ repo: 'eli/runners', token: 'ghp_x', fetchImpl: github(routes).impl });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.installed, null);
  assert.equal(r.actionsWrite, true);
  assert.match(r.message, /personal token/);

  const readOnly = {
    ...routes,
    '/repos/eli/runners': () => json(200, { full_name: 'eli/runners', private: false, permissions: { push: false, admin: false } }),
  };
  const denied = await checkRunnerRepo({ repo: 'eli/runners', token: 'ghp_x', fetchImpl: github(readOnly).impl });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /needs push access/);
});

test('an expired connection and an unreachable GitHub are sentences, and nothing malformed is asked', async () => {
  const expired = await checkRunnerRepo({
    repo: 'eli/runners',
    token: 't',
    fetchImpl: github({ '/repos/eli/runners': repoPublic, '/user/installations': () => json(401, {}) }).impl,
  });
  assert.match(expired.message, /expired or been revoked/);

  const down = await checkRunnerRepo({
    repo: 'eli/runners',
    token: 't',
    fetchImpl: /** @type {any} */ (async () => { throw new Error('getaddrinfo ENOTFOUND'); }),
  });
  assert.match(down.message, /Could not reach GitHub/);

  for (const bad of ['../../evil', '../x', 'eli/..', 'eli', 'eli/runners/extra', '']) {
    const { impl, asked } = github({});
    const r = await checkRunnerRepo({ repo: bad, token: 't', fetchImpl: impl });
    assert.equal(r.ok, false, bad);
    assert.deepEqual(asked, [], `${bad} reached a URL`);
  }
});

test('a repository name is refused by the protocol before any end has to use it', () => {
  // The coordinator runs checkParams before anything is placed, so a URL or a
  // path pasted into the field is refused there, with the shape named.
  assert.equal(checkParams('runnerrepo', { repo: 'eli/runners' }).ok, true);
  // `../x` and `x/..` are the two that matched the old, looser shape: both are
  // path segments the moment they are put into an API URL.
  for (const bad of ['https://github.com/eli/runners', 'eli', '../x/y', 'eli/runners --flag', '../x', 'eli/..', '-eli/x']) {
    const r = checkParams('runnerrepo', { repo: bad });
    assert.equal(r.ok, false, bad);
    assert.match(/** @type {any} */ (r).error, /owner\/repo/, bad);
  }
  assert.equal(checkParams('provision', { platform: 'linux', repo: '../x' }).ok, false);
});

test('a check is asked of a permanent box, never of a runner', () => {
  // A runner has no connections: asking one would answer "GitHub is not
  // connected", which is true of the runner and useless to the person.
  const registry = new HostRegistry();
  for (const [hostId, ephemeral] of /** @type {Array<[string, boolean]>} */ ([['deb14', false], ['gha-linux-1-1', true]])) {
    registry.connect(hostId, () => {}, { ephemeral });
    registry.recordHealth(hostId, { hub: { reachable: true }, maxSessions: 5, running: 0, free: 5, labels: [] });
  }
  const p = place(registry, { verb: 'runnerrepo', params: { repo: 'eli/runners' } }, {});
  assert.equal(p.kind, 'host');
  assert.equal(p.host?.hostId, 'deb14');
});

test('with no GitHub connected on this box it says so, and says so as data', async () => {
  // As data so a coordinator with several boxes can ask the next one rather
  // than read "not connected" out of a sentence.
  const { COMMANDS } = await import('../src/adapters/commands.js');
  const ctx = {
    cfg: { stateDir: mkdtempSync(join(tmpdir(), 'runner-repo-')) },
    actor: 'fleet:eli@example.com',
    runnerRepo: 'me/runners',
    ticket: 'fwt_a_b',
    coordinator: 'https://fleet.example',
  };
  for (const [name, args] of /** @type {Array<[string, string[]]>} */ ([['runnerrepo', ['eli/runners']], ['provision', ['linux']]])) {
    const r = await /** @type {any} */ (COMMANDS)[name].run(ctx, args);
    assert.equal(r.ok, false, name);
    assert.equal(r.needsConnection, 'github', name);
  }
});
