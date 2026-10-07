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
  for (const [name, args] of /** @type {Array<[string, string[]]>} */ ([
    ['runnerrepo', ['eli/runners']],
    ['provision', ['linux']],
    // The linked-repository check is asked the same way (#346).
    ['linkrepo', ['archive', 'eli/work']],
  ])) {
    const r = await /** @type {any} */ (COMMANDS)[name].run(ctx, args);
    assert.equal(r.ok, false, name);
    assert.equal(r.needsConnection, 'github', name);
  }
});

// --- the coordinator: whose repository, which box, and the session after -----

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { RunnerRepos } from '../src/fleet/coordinator/runner-repos.js';

/**
 * A core with permanent boxes speaking the given protocol versions, and a
 * transport that records what each box was sent and answers from `reply`.
 * @param {Array<[string, number]>} boxes
 * @param {(hostId: string, spec: any) => any} [reply]
 */
function fleet(boxes, reply = () => ({ ok: true, text: 'Asked GitHub.' })) {
  const core = new CoordinatorCore({ runnerRepo: 'fleet/runners' });
  for (const [hostId, protocol] of boxes) {
    core.registry.connect(hostId, () => {});
    core.registry.recordHealth(hostId, { hub: { reachable: true }, protocol, maxSessions: 5, running: 0, free: 5, labels: [] });
  }
  /** @type {Array<{ hostId: string, spec: any }>} */
  const sent = [];
  core.send = /** @type {any} */ (async (/** @type {any} */ host, /** @type {any} */ spec) => {
    sent.push({ hostId: host.hostId, spec });
    return reply(host.hostId, spec);
  });
  return { core, sent };
}

const eli = { email: 'eli@example.com', admin: false };
const sam = { email: 'sam@example.com', admin: false };
const provision = (/** @type {any} */ requester, /** @type {any} */ extra = {}) => ({
  verb: 'provision',
  params: { platform: 'linux' },
  actor: requester.email,
  requester,
  ...extra,
});

test('a dispatch goes to the asker’s own repository, and a caller cannot name one', async () => {
  const { core, sent } = fleet([['deb14', 6]]);
  core.runnerRepos.set(eli.email, 'Eli/Runners');

  await core.dispatch(provision(eli));
  assert.equal(sent[0].spec.params.repo, 'Eli/Runners');
  // The ticket is bound to it, so only a job from there can spend it.
  assert.equal((await core.runnerTickets.peek(sent[0].spec.params.ticket))?.repository, 'Eli/Runners');

  // Somebody with no repository of their own gets the fleet's — and a repo
  // they put in the params is removed, not honoured.
  await core.dispatch({ ...provision(sam), params: { platform: 'linux', repo: 'mallory/runners' } });
  assert.equal('repo' in sent[1].spec.params, false);
  assert.equal((await core.runnerTickets.peek(sent[1].spec.params.ticket))?.repository, 'fleet/runners');
});

test('a box too old to carry somebody’s repository is refused, not sent', async () => {
  // buildIntent would drop `repo` for a v5 box, and the dispatch would go to
  // the fleet's repository while the reply said it worked.
  const { core, sent } = fleet([['deb14', 5]]);
  core.runnerRepos.set(eli.email, 'eli/runners');
  const r = await core.dispatch(provision(eli));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'host_outdated');
  assert.deepEqual(sent, []);

  // Without a repository of their own there is nothing to lose, and it goes.
  assert.equal((await core.dispatch(provision(sam))).ok, true);
});

test('with several boxes, each is asked in turn until one holds the asker’s GitHub', async () => {
  // The scheduler cannot see who connected what where and refuses to guess;
  // a box that answers "not connected for you" dispatched nothing, so asking
  // the next one is safe. The first real answer ends it — two boxes answering
  // one request would start two machines.
  const { core, sent } = fleet([['deb16', 6], ['deb14', 6], ['deb15', 6]], (hostId) =>
    hostId === 'deb14' ? { ok: false, needsConnection: 'github', text: 'GitHub is not connected for you on this box' } : { ok: true, text: 'Asked GitHub.' },
  );
  const r = await core.dispatch(provision(sam));
  assert.equal(r.ok, true);
  assert.equal(r.hostId, 'deb15');
  assert.deepEqual(sent.map((x) => x.hostId), ['deb14', 'deb15']);

  const none = fleet([['deb14', 6], ['deb15', 6]], () => ({ ok: false, needsConnection: 'github', text: 'no' }));
  const refused = await none.core.dispatch(provision(sam));
  assert.equal(refused.ok, false);
  assert.equal(refused.needsConnection, 'github');
  assert.match(refused.text, /deb14 \(GitHub not connected for you\), deb15/);
});

test('a runner repository is saved only once it passes, as GitHub spells it', async () => {
  const check = { repo: 'Eli/Runners', public: true, installed: true, actionsWrite: true, platforms: ['linux'], missing: [], ok: true, message: 'fine' };
  const passing = fleet([['deb14', 6]], () => ({ ok: true, text: 'fine', runnerRepo: check }));
  const saved = await passing.core.setRunnerRepo(eli, 'eli/runners');
  assert.equal(saved.ok, true);
  assert.equal(passing.core.runnerRepos.get(eli.email), 'Eli/Runners');
  assert.equal(passing.sent[0].spec.verb, 'runnerrepo');
  // The snapshot says which is in effect, and whose.
  assert.deepEqual(passing.core.snapshot(eli).runners, { repo: 'Eli/Runners', own: true });
  assert.deepEqual(passing.core.snapshot(sam).runners, { repo: 'fleet/runners', own: false });

  const failing = fleet([['deb14', 6]], () => ({ ok: false, text: 'eli/runners is private.', runnerRepo: { ...check, public: false, ok: false } }));
  const refused = await failing.core.setRunnerRepo(eli, 'eli/runners');
  assert.equal(refused.ok, false);
  assert.equal(refused.runnerRepo?.public, false);
  assert.match(refused.text, /private\. Nothing was saved/);
  assert.equal(failing.core.runnerRepos.get(eli.email), null);

  assert.equal((await passing.core.setRunnerRepo({ email: null }, 'eli/runners')).error?.code, 'not_signed_in');
  assert.match(passing.core.clearRunnerRepo(eli).text, /fleet's repository, fleet\/runners/);
  assert.equal(passing.core.runnerRepos.get(eli.email), null);
});

test('the session asked for with a machine starts on it once, as its owner', async () => {
  const { core, sent } = fleet([['deb14', 6]], (_h, spec) =>
    spec.verb === 'start' ? { ok: true, text: 'Started.', sessions: [] } : { ok: true, text: 'Asked GitHub.' });

  // Checked by `start`'s own rules before anything is minted.
  const bad = await core.dispatch(provision(eli, { startAfter: { mode: 'yolo' } }));
  assert.equal(bad.ok, false);
  assert.equal(core.runnerTickets.serialise().length, 0);

  const task = 'Build the macOS app in ./app.\nRun its tests and say which failed.';
  await core.dispatch(provision(eli, { startAfter: { title: 'Build the Mac app', profile: 'deploy', task } }));
  const ticket = await core.runnerTickets.redeem(sent[0].spec.params.ticket);
  // A runner has no profiles, so a profile is not carried. Its task is: the
  // words are how a machine minutes old is given its job, newlines and all.
  assert.deepEqual(ticket?.start, { title: 'Build the Mac app', task });

  core.noteRunnerEnrolled('gha-eli-1', ticket);
  core.registry.connect('gha-eli-1', () => {}, { ephemeral: true, owner: eli.email });
  const frame = { kind: 'health', health: { hub: { reachable: true }, protocol: 7, maxSessions: 1, running: 0, free: 1, labels: [] } };
  await core.onHostMessage('gha-eli-1', frame);
  await core.onHostMessage('gha-eli-1', frame);
  await new Promise((r) => setImmediate(r));

  const starts = sent.filter((x) => x.spec.verb === 'start');
  assert.equal(starts.length, 1, 'a second frame must not start a second session');
  assert.equal(starts[0].hostId, 'gha-eli-1');
  assert.equal(starts[0].spec.actor, eli.email);
  assert.equal(starts[0].spec.params.title, 'Build the Mac app');
  assert.equal(starts[0].spec.params.task, task);
  assert.ok(core.events.some((e) => e.event === 'runner.started'));
});

test('a task goes to a host that can take one, and a host that cannot says so rather than starting idle', async () => {
  // Dropped the way an optional param too new for a host is, the task would
  // leave the session idle — the thing it exists to end — with a reply saying
  // it started.
  const { core, sent } = fleet([['deb6', 6], ['deb7', 7]], () => ({ ok: true, text: 'Started.', sessions: [] }));
  const start = (/** @type {string} */ host, /** @type {any} */ params) =>
    core.dispatch({ verb: 'start', params, actor: eli.email, requester: eli, preferHost: host });

  const old = await start('deb6', { task: 'Run the tests.' });
  assert.equal(old.ok, false);
  assert.equal(old.error?.code, 'host_outdated');
  assert.match(String(old.text), /deb6 is too old to be handed a task .* needs 7/);
  assert.deepEqual(sent, []);

  // Without a task there is nothing to lose, and it goes.
  assert.equal((await start('deb6', { title: 'Look around' })).ok, true);

  assert.equal((await start('deb7', { task: 'Run the tests.' })).ok, true);
  assert.equal(sent.at(-1)?.hostId, 'deb7');
  assert.equal(sent.at(-1)?.spec.params.task, 'Run the tests.');
});

test('stored runner state that does not look right is dropped, not trusted', () => {
  // Admission and the waiting sessions are read back from storage, so a
  // malformed entry is one that would be believed.
  const repos = new RunnerRepos();
  repos.restore([['Eli@Example.com', { repo: 'eli/runners', setAt: 1 }], ['x', { repo: '../evil' }], 'junk', ['y', null]]);
  assert.deepEqual(repos.serialise().map(([k, v]) => [k, v.repo]), [['eli@example.com', 'eli/runners']]);

  const core = new CoordinatorCore({ now: () => 1_000 });
  core.restoreRunnerStarts([
    ['live', { owner: 'eli@example.com', start: { title: 'x' }, until: 2_000 }],
    ['gone', { owner: 'eli@example.com', start: { title: 'x' }, until: 500 }],
    ['nobody', { start: { title: 'x' }, until: 2_000 }],
  ]);
  assert.deepEqual([...core.runnerStarts.keys()], ['live']);
  assert.deepEqual(core.serialiseRunnerStarts().map(([k]) => k), ['live']);
});
