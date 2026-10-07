// A session pushed to its owner's private archive before it goes (#346, #314).
//
//   node --test test/archive.test.js
//
// Three things are worth holding still. The PUSH: only to a repository GitHub
// says is private right now, one commit per push following the last, never
// forced, nothing committed when nothing changed. The PATCH: what the
// workspace became, as something `git apply` puts back — made with real git,
// because mocking git would test the mock — and made without writing into the
// session's own repository. And WHOSE credential: the person who started the
// session, never the box.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pushArchive, workspacePatch, archiveFiles, archiveSession, branchFor, MAX_FILE_BYTES } from '../src/core/archive.js';
import { Registry } from '../src/core/registry.js';
import { Connections } from '../src/core/connectors.js';
import { toCommandLine } from '../src/fleet/host/sidecar.js';

const json = (/** @type {number} */ status, /** @type {any} */ body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sha = (/** @type {string} */ s) => createHash('sha1').update(s).digest('hex');

/**
 * GitHub's Git Data API, for one repository, in memory: blobs and trees are
 * addressed by their content, so the same files make the same tree, which is
 * what a real one does and what "unchanged" depends on.
 * @param {{ private?: boolean, empty?: boolean }} [opts]
 */
function github({ private: priv = true, empty = false } = {}) {
  /** @type {Record<string, string>} */ const refs = {};
  /** @type {Record<string, { tree: string, parents: string[] }>} */ const commits = {};
  /** @type {Array<{ method: string, path: string, body: any }>} */ const calls = [];
  let isEmpty = empty;
  const impl = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    const p = new URL(url).pathname.replace(/^\/repos\/eli\/work/, '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: p, body });
    if (method === 'GET' && p === '') return json(200, { full_name: 'eli/work', private: priv });
    if (method === 'PUT' && p === '/contents/README.md') { isEmpty = false; return json(201, {}); }
    if (method === 'POST' && p === '/git/blobs') return isEmpty ? json(409, { message: 'Git Repository is empty.' }) : json(201, { sha: sha(body.content) });
    if (method === 'POST' && p === '/git/trees') return json(201, { sha: sha(JSON.stringify(body.tree)) });
    if (method === 'POST' && p === '/git/commits') {
      const c = sha(JSON.stringify(body));
      commits[c] = { tree: body.tree, parents: body.parents };
      return json(201, { sha: c });
    }
    const ref = decodeURIComponent(p.replace(/^\/git\/refs?\/heads\//, ''));
    if (method === 'GET' && p.startsWith('/git/ref/heads/')) return refs[ref] ? json(200, { object: { sha: refs[ref] } }) : json(404, {});
    if (method === 'GET' && p.startsWith('/git/commits/')) return json(200, { tree: { sha: commits[p.split('/').pop() || '']?.tree } });
    if (method === 'POST' && p === '/git/refs') { refs[body.ref.replace('refs/heads/', '')] = body.sha; return json(201, {}); }
    if (method === 'PATCH' && p.startsWith('/git/refs/heads/')) { refs[ref] = body.sha; return json(200, {}); }
    return json(404, {});
  });
  return { impl, calls, refs, commits };
}

const BRANCH = 'fleetwright/deb14/job-20261007T120000Z';
const files = (/** @type {string} */ pane) => ({ 'pane.txt': Buffer.from(pane), 'README.md': Buffer.from('# job\n') });

test('a push follows the last one on the session’s own branch, never forced, and skips what has not changed', async () => {
  const gh = github();
  const push = (/** @type {string} */ pane) =>
    pushArchive({ repo: 'eli/work', branch: BRANCH, files: files(pane), message: 'job', token: 'ghu_eli', fetchImpl: gh.impl });

  const first = await push('building…');
  assert.equal(first.ok, true, first.text);
  assert.deepEqual(gh.commits[gh.refs[BRANCH]].parents, [], 'the first push starts the branch');

  const second = await push('built, 12 tests passed');
  assert.equal(second.ok, true, second.text);
  assert.deepEqual(gh.commits[gh.refs[BRANCH]].parents, [first.ok ? first.commit : ''], 'it follows the last push');
  const moved = gh.calls.find((c) => c.method === 'PATCH');
  assert.equal(moved?.body.force, false, 'a branch is never forced');

  const commitsBefore = Object.keys(gh.commits).length;
  const third = await push('built, 12 tests passed');
  assert.equal(third.ok && third.unchanged, true);
  assert.equal(Object.keys(gh.commits).length, commitsBefore, 'an unchanged checkpoint made a commit');
});

test('a repository that is not private is not written to, whatever the link said', async () => {
  // The name came from the coordinator; this is the check the host makes for
  // itself, with the owner's own credential, at the moment of the push.
  const gh = github({ private: false });
  const r = await pushArchive({ repo: 'eli/work', branch: BRANCH, files: files('x'), message: 'm', token: 't', fetchImpl: gh.impl });
  assert.equal(r.ok, false);
  assert.match(r.text, /eli\/work is not private, so nothing was pushed/);
  assert.deepEqual(gh.calls.map((c) => c.method), ['GET'], 'something was written to a public repository');
});

test('an empty repository gets a first commit, because GitHub’s API cannot write into one without', async () => {
  const gh = github({ empty: true });
  const r = await pushArchive({ repo: 'eli/work', branch: BRANCH, files: files('x'), message: 'm', token: 't', fetchImpl: gh.impl });
  assert.equal(r.ok, true, r.text);
  assert.ok(gh.calls.some((c) => c.method === 'PUT' && c.path === '/contents/README.md'));
  assert.ok(gh.refs[BRANCH]);
});

// --- the workspace, with real git --------------------------------------------

/** Every directory these tests make, removed when they are done: one of them
 * holds a file the size of the archive's limit, on every run. */
const made = /** @type {string[]} */ ([]);
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
/** @param {string} prefix */
function scratch(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const HAVE_GIT = spawnSync('git', ['--version']).status === 0;

/** A checkout with one commit. */
function checkout() {
  const dir = scratch('archive-ws-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(dir, 'app.js'), 'console.log(1);\n');
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'first']);
  return dir;
}

const unsandboxed = /** @type {any} */ ({ sandbox: false });

test('the workspace patch puts back what the session changed, and writes nothing into its repository', { skip: !HAVE_GIT && 'no git' }, async () => {
  const ws = checkout();
  writeFileSync(path.join(ws, 'app.js'), 'console.log(2);\n');
  writeFileSync(path.join(ws, 'notes.md'), 'new file\n');
  writeFileSync(path.join(ws, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0xff]));
  spawnSync('mkdir', ['-p', path.join(ws, 'node_modules')]);
  writeFileSync(path.join(ws, 'node_modules', 'big.js'), 'ignored\n');
  const status = git(ws, ['status', '--porcelain']).stdout;
  // THE SAME BYTES, A NEW MTIME: an entry a diff would refresh in the index it
  // reads, which is exactly the write the patch must not make.
  const ignore = path.join(ws, '.gitignore');
  utimesSync(ignore, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
  const index = statSync(path.join(ws, '.git', 'index')).mtimeMs;

  const r = await workspacePatch(unsandboxed, /** @type {any} */ ({ name: 'job', cwd: ws }));
  assert.equal(r.ok, true);
  assert.ok(r.ok && !r.tooBig);

  // Nothing in the session's own repository moved. The index first: `status`
  // itself may refresh it, which would be this test writing, not the patch.
  assert.equal(statSync(path.join(ws, '.git', 'index')).mtimeMs, index);
  assert.equal(git(ws, ['status', '--porcelain']).stdout, status);

  // A fresh checkout of the same commit, with the patch applied, is the workspace.
  const back = scratch('archive-back-');
  git(back, ['clone', '-q', ws, '.']);
  const patch = path.join(scratch('archive-patch-'), 'workspace.patch');
  writeFileSync(patch, r.ok ? r.patch : '');
  const applied = git(back, ['apply', '--binary', patch]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(readFileSync(path.join(back, 'app.js'), 'utf8'), 'console.log(2);\n');
  assert.equal(readFileSync(path.join(back, 'notes.md'), 'utf8'), 'new file\n');
  assert.deepEqual([...readFileSync(path.join(back, 'logo.png'))], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0xff]);
  assert.equal(existsSync(path.join(back, 'node_modules', 'big.js')), false, 'an ignored file was archived');
});

test('a workspace that is not a checkout is archived whole, and one too big is left out rather than cut', { skip: !HAVE_GIT && 'no git' }, async () => {
  const dir = scratch('archive-plain-');
  writeFileSync(path.join(dir, 'out.txt'), 'result\n');
  const r = await workspacePatch(unsandboxed, /** @type {any} */ ({ name: 'job', cwd: dir }));
  assert.ok(r.ok && !r.tooBig);
  assert.match(r.ok ? r.patch.toString() : '', /\+result/);

  writeFileSync(path.join(dir, 'huge.bin'), Buffer.alloc(MAX_FILE_BYTES, 7));
  const big = await workspacePatch(unsandboxed, /** @type {any} */ ({ name: 'job', cwd: dir }));
  assert.ok(big.ok && big.tooBig);
  const readme = archiveFiles({
    rec: /** @type {any} */ ({ name: 'job', status: 'running', createdAt: 0 }),
    host: 'deb14', reason: 'stop', at: 0, pane: 'p',
    transcript: { ok: false, why: 'this box cannot read it' },
    patch: big,
  })['README.md'].toString();
  assert.match(readme, /## Not in it, and why[\s\S]*the workspace: its changes are over the 6MB an archive carries/);
  assert.match(readme, /the transcript: this box cannot read it/);
});

// --- whose credential --------------------------------------------------------

test('a session is pushed as the person who started it, and as nobody else', async () => {
  const dir = scratch('archive-hub-');
  const cfg = /** @type {any} */ ({ stateDir: dir, hostname: 'deb14', sandbox: false, stateFile: path.join(dir, 'state.json'), spoolFile: path.join(dir, 'spool') });
  const registry = new Registry({ stateFile: cfg.stateFile, spoolFile: cfg.spoolFile });
  const ws = scratch('archive-cwd-');
  registry.upsert('job', { status: 'stopped', cwd: ws, archive: 'eli/work', createdBy: 'fleet:eli@example.com' });
  registry.upsert('job', { createdAt: Date.UTC(2026, 9, 7, 12) });
  registry.upsert('boxjob', { status: 'stopped', cwd: ws, archive: 'eli/work', createdBy: 'web' });

  // No connection for its owner: said, and nothing asked of GitHub.
  const gh = github();
  const none = await archiveSession({ cfg, registry, name: 'job', reason: 'stop', fetchImpl: gh.impl, broker: '' });
  assert.equal(none.ok, false);
  assert.match(none.text, /^Not archived to eli\/work: GitHub is not connected for its owner on this box/);
  assert.equal(gh.calls.length, 0);
  assert.equal(registry.get('job')?.archiveOk, false, 'the outcome is on the record, for the phones');

  // The box's own row is never the one a session is pushed as.
  new Connections(dir).save('', 'github', 'ghu_box');
  assert.match((await archiveSession({ cfg, registry, name: 'boxjob', reason: 'stop', fetchImpl: gh.impl, broker: '' })).text, /nobody signed in started it/);

  new Connections(dir).save('eli@example.com', 'github', 'ghu_eli');
  /** @type {string[]} */
  const auth = [];
  const seen = /** @type {any} */ (async (/** @type {string} */ u, /** @type {any} */ init) => { auth.push(init?.headers?.authorization); return gh.impl(u, init); });
  const done = await archiveSession({ cfg, registry, name: 'job', reason: 'stop', fetchImpl: seen, broker: '' });
  assert.equal(done.ok, true, done.text);
  assert.ok(auth.length && auth.every((a) => a === 'Bearer ghu_eli'), 'pushed with something other than the owner’s connection');
  const rec = registry.get('job');
  assert.equal(rec?.archiveBranch, 'fleetwright/deb14/job-20261007T120000Z');
  assert.equal(rec?.archiveOk, true);
  assert.equal(gh.refs[branchFor('deb14', /** @type {any} */ (rec))], rec?.archiveCommit);
});

test('the fleet’s archive reaches the hub as one token, and nothing else does', () => {
  assert.equal(
    toCommandLine({ verb: 'start', params: { name: 'job', archive: 'Eli/Work' } }),
    '/new job --archive=Eli/Work',
  );
  assert.throws(() => toCommandLine({ verb: 'start', params: { name: 'job', archive: 'eli/work --dangerous' } }));
  assert.equal(toCommandLine({ verb: 'linkrepo', params: { role: 'archive', repo: 'eli/work' } }), '/linkrepo archive eli/work');
  assert.throws(() => toCommandLine({ verb: 'linkrepo', params: { role: 'scratch', repo: 'eli/work' } }));
});
