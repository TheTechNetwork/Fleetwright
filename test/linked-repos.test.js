// Linked repositories: three roles, one linking flow (#346).
//
//   node --test test/linked-repos.test.js
//
// What each role refuses is the point, because the same repository can be
// exactly right as one role and dangerous as another: an archive holds
// somebody's work and must be private, a templates repository may be either
// and only has to be readable, and `runners` is the runner check with a role
// on it. Then the coordinator half: which checker answers (the App, only
// inside the accounts it mints into, else a box with the person's own
// connection), what is saved, and that a session's archive comes from the
// person who started it and from nobody else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import { checkLinkedRepo } from '../src/core/linked-repo-check.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { LinkedRepos } from '../src/fleet/coordinator/linked-repos.js';
import { HostRegistry } from '../src/fleet/coordinator/registry.js';
import { place } from '../src/fleet/coordinator/scheduler.js';
import minterWorker from '../worker/src/minter.js';

const json = (/** @type {number} */ status, /** @type {any} */ body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * GitHub as the person's connection sees it. Exact paths, lowercased; a path
 * nobody configured is a 404, which is what GitHub says too.
 * @param {Record<string, () => Response>} routes
 */
function github(routes) {
  return /** @type {any} */ (async (/** @type {string} */ url) => {
    const path = new URL(String(url)).pathname.toLowerCase();
    return routes[path] ? routes[path]() : json(404, { message: 'Not Found' });
  });
}

const repo = (/** @type {boolean} */ priv, push = true) => () =>
  json(200, { full_name: 'Eli/Work', private: priv, permissions: { push, pull: true } });
const installed = (/** @type {string} */ contents) => () =>
  json(200, { installations: [{ id: 7, account: { login: 'eli' }, repository_selection: 'all', permissions: { contents } }] });

test('each role refuses what would make it dangerous, and passes what it needs', async () => {
  /** @type {Array<[string, string, Record<string, () => Response>, boolean, RegExp, Record<string, any>]>} */
  const cases = [
    // An archive holds a session's work; world-readable is the one thing it cannot be.
    ['a public archive', 'archive', { '/repos/eli/work': repo(false), '/user/installations': installed('write') }, false, /is public\. An archive/, { public: true }],
    ['a private, writable archive', 'archive', { '/repos/eli/work': repo(true), '/user/installations': installed('write') }, true, /private and can be written to/, { public: false, installed: true, contents: 'write', push: true }],
    ['an archive the App only reads', 'archive', { '/repos/eli/work': repo(true), '/user/installations': installed('read') }, false, /without Contents write/, { contents: 'read' }],
    ['an archive the person cannot push to', 'archive', { '/repos/eli/work': repo(true, false), '/user/installations': installed('write') }, false, /You cannot push to Eli\/Work/, { push: false }],
    ['an archive whose visibility GitHub did not say', 'archive', { '/repos/eli/work': () => json(200, { full_name: 'Eli/Work' }), '/user/installations': installed('write') }, false, /did not say whether Eli\/Work is private/, { public: null }],
    // Templates may be either, and say what they carry.
    [
      'a public templates repository',
      'templates',
      {
        '/repos/eli/work': repo(false),
        '/user/installations': installed('read'),
        '/repos/eli/work/contents': () => json(200, [{ name: '.claude' }, { name: 'default.json' }, { name: 'README.md' }]),
      },
      true,
      /public, so anyone can read it.*carries \.claude, default\.json\. Nothing in it is run/,
      { carries: ['.claude', 'default.json'] },
    ],
    ['a private templates repository with none of the shapes', 'templates', { '/repos/eli/work': repo(true), '/user/installations': installed('read') }, true, /private and readable\. It has none of/, { carries: [] }],
    ['templates the App cannot read', 'templates', { '/repos/eli/work': repo(true), '/user/installations': installed('') }, false, /without Contents read/, { contents: 'none' }],
    ['an account the App is not installed on', 'archive', { '/repos/eli/work': repo(true), '/user/installations': () => json(200, { installations: [] }) }, false, /not installed on Eli/, { installed: false }],
  ];
  for (const [name, role, routes, ok, message, fields] of cases) {
    const r = await checkLinkedRepo({ role, repo: 'eli/work', token: 'ghu_x', fetchImpl: github(routes) });
    assert.equal(r.ok, ok, `${name}: ${r.message}`);
    assert.equal(r.role, role, name);
    assert.match(r.message, message, name);
    for (const [k, v] of Object.entries(fields)) assert.deepEqual(/** @type {any} */ (r)[k], v, `${name}: ${k}`);
    if (ok) assert.equal(r.repo, 'Eli/Work', `${name}: saved as GitHub spells it`);
  }
});

test('a personal token cannot see installations, so the person’s own push decides, and that is said', async () => {
  const routes = {
    '/repos/eli/work': repo(true),
    '/user/installations': () => json(403, { message: 'You must authenticate with an access token authorized to a GitHub App' }),
  };
  const r = await checkLinkedRepo({ role: 'archive', repo: 'eli/work', token: 'ghp_x', fetchImpl: github(routes) });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.installed, null, 'cannot tell, not no');
  assert.equal(r.contents, 'write');

  const readOnly = await checkLinkedRepo({ role: 'archive', repo: 'eli/work', token: 'ghp_x', fetchImpl: github({ ...routes, '/repos/eli/work': repo(true, false) }) });
  assert.equal(readOnly.ok, false);
  assert.match(readOnly.message, /cannot push to Eli\/Work/);
});

test('runners is the runner check with a role on it, and nothing malformed reaches GitHub', async () => {
  const r = await checkLinkedRepo({
    role: 'runners',
    repo: 'eli/work',
    token: 't',
    fetchImpl: github({ '/repos/eli/work': repo(true) }),
  });
  assert.equal(r.role, 'runners');
  assert.equal(r.ok, false);
  assert.match(r.message, /A runner repository has to be public/);
  assert.equal(r.runnerRepo?.public, false);

  let asked = 0;
  const counting = /** @type {any} */ (async () => { asked++; return json(404, {}); });
  for (const [role, name] of [['archive', '../x'], ['archive', 'eli'], ['scratch', 'eli/work'], ['', 'eli/work']]) {
    const bad = await checkLinkedRepo({ role, repo: name, token: 't', fetchImpl: counting });
    assert.equal(bad.ok, false, `${role} ${name}`);
  }
  assert.equal(asked, 0, 'a malformed role or name reached a URL');
});

// --- the coordinator ---------------------------------------------------------

const eli = { email: 'eli@example.com', admin: false };
const sam = { email: 'sam@example.com', admin: false };

/**
 * A core with permanent boxes at the given protocol versions and a transport
 * that records what each was sent.
 * @param {Array<[string, number]>} boxes
 * @param {(hostId: string, spec: any) => any} [reply]
 * @param {any} [opts]
 */
function fleet(boxes, reply = () => ({ ok: true, text: 'Started.', sessions: [] }), opts = {}) {
  const core = new CoordinatorCore(opts);
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

test('a session is archived where its starter linked, and a caller cannot name somewhere else', async () => {
  const { core, sent } = fleet([['deb14', 11]]);
  core.linkedRepos.set(eli.email, 'archive', 'Eli/Work');
  const start = (/** @type {any} */ requester, /** @type {any} */ params = {}) =>
    core.dispatch({ verb: 'start', params, actor: requester?.email ?? null, requester, preferHost: 'deb14' });

  await start(eli, { title: 'build', archive: 'mallory/drop' });
  assert.equal(sent[0].spec.params.archive, 'Eli/Work', 'the caller’s archive was honoured');

  // Somebody with no archive of their own gets none, and theirs is removed too.
  await start(sam, { archive: 'mallory/drop' });
  assert.equal('archive' in sent[1].spec.params, false);

  // The break-glass token names nobody, so nobody's archive.
  await start(null, {});
  assert.equal('archive' in sent[2].spec.params, false);
});

test('a host too old to archive still starts the session, and the reply says it will not be archived', async () => {
  // Refusing would cost the session for the sake of a copy of it; saying
  // nothing would let somebody believe a push will happen that will not.
  const { core, sent } = fleet([['deb10', 10], ['deb11', 11]]);
  core.linkedRepos.set(eli.email, 'archive', 'Eli/Work');
  const old = await core.dispatch({ verb: 'start', params: {}, actor: eli.email, requester: eli, preferHost: 'deb10' });
  assert.equal(old.ok, true);
  assert.equal(old.archived, false);
  assert.match(String(old.text), /^Started\. deb10 is too old to archive a session, so this one will not be pushed to Eli\/Work/);
  assert.equal(sent.length, 1, 'the session was started');

  const current = await core.dispatch({ verb: 'start', params: {}, actor: eli.email, requester: eli, preferHost: 'deb11' });
  assert.equal(current.text, 'Started.');
  assert.equal('archived' in current, false);
});

test('a link is saved only once its check passes, listed with the others, and unlinked', async () => {
  const check = { role: 'archive', repo: 'Eli/Work', public: false, installed: true, contents: 'write', push: true, carries: null, ok: true, message: 'fine' };
  const { core, sent } = fleet([['deb14', 11]], (_h, spec) =>
    spec.verb === 'linkrepo' ? { ok: true, text: 'fine', linkedRepo: { ...check, role: spec.params.role } } : { ok: true, text: 'ok' },
  { runnerRepo: 'fleet/runners' });
  core.runnerRepos.set(eli.email, 'Eli/Runners');

  const saved = await core.setLinkedRepo(eli, 'archive', 'eli/work');
  assert.equal(saved.ok, true, String(saved.text));
  assert.equal(sent[0].spec.verb, 'linkrepo');
  assert.deepEqual(sent[0].spec.params, { role: 'archive', repo: 'eli/work' });
  assert.deepEqual(
    core.linkedReposFor(eli).links.map((/** @type {any} */ l) => [l.role, l.repo]),
    [['archive', 'Eli/Work'], ['runners', 'Eli/Runners']],
  );
  assert.deepEqual(core.linkedReposFor(eli).fleet, { runners: 'fleet/runners' });
  assert.deepEqual(core.linkedReposFor(sam).links, [], 'one person’s links are not another’s');

  // A check answering for a different role than was asked is not a pass.
  const confused = fleet([['deb14', 11]], () => ({ ok: true, text: 'fine', linkedRepo: { ...check, role: 'templates' } }));
  assert.equal((await confused.core.setLinkedRepo(eli, 'archive', 'eli/work')).ok, false);
  assert.equal(confused.core.linkedRepos.get(eli.email, 'archive'), null);

  const failing = fleet([['deb14', 11]], () => ({ ok: false, text: 'Eli/Work is public.', linkedRepo: { ...check, public: true, ok: false } }));
  const refused = await failing.core.setLinkedRepo(eli, 'archive', 'eli/work');
  assert.equal(refused.ok, false);
  assert.match(refused.text, /is public\. Nothing was linked/);
  assert.equal(failing.core.linkedRepos.get(eli.email, 'archive'), null);

  assert.equal((await core.setLinkedRepo(eli, 'scratch', 'eli/work')).error?.code, 'bad_params');
  assert.equal((await core.setLinkedRepo({ email: null }, 'archive', 'eli/work')).error?.code, 'not_signed_in');

  assert.match(core.clearLinkedRepo(eli, 'archive').text, /ones already running keep the archive they started with/);
  assert.equal(core.linkedRepos.get(eli.email, 'archive'), null);
  assert.match(core.clearLinkedRepo(eli, 'archive').text, /had no archive repository linked/);
  // `runners` unlinks the runner repository, which is where it is kept.
  core.clearLinkedRepo(eli, 'runners');
  assert.equal(core.runnerRepos.get(eli.email), null);
});

test('a linked-repository check is asked of a permanent box, never of a runner', () => {
  const registry = new HostRegistry();
  for (const [hostId, ephemeral] of /** @type {Array<[string, boolean]>} */ ([['deb14', false], ['gha-linux-1-1', true]])) {
    registry.connect(hostId, () => {}, { ephemeral });
    registry.recordHealth(hostId, { hub: { reachable: true }, maxSessions: 5, running: 0, free: 5, labels: [] });
  }
  const p = place(registry, { verb: 'linkrepo', params: { role: 'archive', repo: 'eli/work' } }, {});
  assert.equal(p.kind, 'host');
  assert.equal(p.host?.hostId, 'deb14');
});

// --- the minting Worker, as the App ------------------------------------------

/** Swap the global fetch for GitHub's stand-in for one test. @param {(url: URL, init: any) => Response} answer */
function githubIs(answer) {
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    const u = new URL(String(url));
    return u.hostname === 'api.github.com' ? answer(u, init) : real(url, init);
  });
  return () => { globalThis.fetch = real; };
}

test('the App checks a private role only inside the accounts it mints into, and a box answers the rest', async (t) => {
  const app = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = {
    FLEETWRIGHT_GITHUB_APP_KEY: app.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    FLEETWRIGHT_GITHUB_CLIENT_ID: 'Iv23liTEST',
    FLEETWRIGHT_GITHUB_MINT_OWNERS: 'eli',
  };
  /** @type {string[]} */
  const asked = [];
  t.after(githubIs((u, init) => {
    const path = u.pathname.toLowerCase();
    asked.push(path);
    if (path === '/repos/eli/work/installation') return json(200, { id: 9, permissions: { contents: 'write', metadata: 'read' } });
    if (path === '/app/installations/9/access_tokens') {
      const body = JSON.parse(init.body);
      return json(201, { token: 'ghs_read', expires_at: new Date(Date.now() + 3600e3).toISOString(), permissions: body.permissions, repositories: [{ full_name: 'Eli/Work' }] });
    }
    if (String(init.headers?.authorization) !== 'Bearer ghs_read') return json(401, {});
    if (path === '/repos/eli/work') return json(200, { full_name: 'Eli/Work', private: true });
    return json(404, {});
  }));
  const minter = {
    linkedRepo: async (/** @type {any} */ ask) =>
      (await minterWorker.fetch(new Request('https://minter.internal/linked-repo', { method: 'POST', body: JSON.stringify(ask) }), env)).json(),
  };

  // No box is connected: the App's answer is the only one there is.
  const core = new CoordinatorCore({ minter });
  const saved = await core.setLinkedRepo(eli, 'archive', 'eli/work');
  assert.equal(saved.ok, true, String(saved.text));
  assert.equal(core.linkedRepos.get(eli.email, 'archive')?.repo, 'Eli/Work');
  // The App cannot see the person, and says so rather than claiming they can push.
  assert.equal(saved.linkedRepo?.push, null);
  assert.match(String(saved.text), /answered by GitHub the first time a session of yours is archived/);
  assert.ok(!JSON.stringify(saved).includes('ghs_read'), 'the read token stayed in the minter');

  // OUTSIDE THE OWNERS LIST the App says nothing about a private repository —
  // not even whether it exists — and the question goes to a box, which asks
  // with the person's own connection.
  asked.length = 0;
  const { core: boxed, sent } = fleet([['deb14', 11]], () => ({ ok: false, needsConnection: 'github', text: 'GitHub is not connected for you on this box.' }), { minter });
  const fell = await boxed.setLinkedRepo(eli, 'archive', 'acme/secret');
  assert.deepEqual(asked, [], 'the App asked GitHub about an account it does not mint into');
  assert.equal(sent[0]?.spec.verb, 'linkrepo');
  assert.equal(fell.ok, false);
  assert.equal(fell.needsConnection, 'github');
});

test('stored links that do not look right are dropped, not trusted', () => {
  // An archive read back from storage is where somebody's work is pushed.
  const links = new LinkedRepos();
  links.restore([
    ['Eli@Example.com', { archive: { repo: 'Eli/Work', setAt: 1 }, templates: { repo: '../evil' } }],
    ['sam@example.com', { runners: { repo: 'sam/runners' } }],
    ['x', null],
    'junk',
  ]);
  assert.deepEqual(links.serialise(), [['eli@example.com', { archive: { repo: 'Eli/Work', setAt: 1 } }]]);
  assert.equal(links.set('eli@example.com', 'runners', 'eli/runners').ok, false, 'runners is the runner store’s');
});
