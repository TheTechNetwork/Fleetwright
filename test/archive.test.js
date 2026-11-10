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

import { pushArchive, workspacePatch, archiveFiles, archiveSession, branchFor, MAX_PATCH_BYTES, PIECE_BYTES, piecesOf, gitBlobId,
  splitBase, TRANSCRIPT_SCRIPT, ArchivePacer, updateIndex, indexLine } from '../src/core/archive.js';
import { symlinkSync, mkdirSync } from 'node:fs';
import { Registry } from '../src/core/registry.js';
import { Connections } from '../src/core/connectors.js';
import { HOST_ROW } from '../src/core/accounts.js';
import { applyVault } from '../src/core/vault-store.js';
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
  /** @type {Record<string, any[]>} */ const trees = {};
  /** @type {Array<{ method: string, path: string, body: any }>} */ const calls = [];
  let isEmpty = empty;
  const impl = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    const p = new URL(url).pathname.replace(/^\/repos\/eli\/work/, '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: p, body });
    if (method === 'GET' && p === '') return json(200, { full_name: 'eli/work', private: priv });
    if (method === 'PUT' && p === '/contents/README.md') { isEmpty = false; return json(201, {}); }
    if (method === 'POST' && p === '/git/blobs') return isEmpty ? json(409, { message: 'Git Repository is empty.' }) : json(201, { sha: gitBlobId(Buffer.from(body.content, 'base64')) });
    if (method === 'POST' && p === '/git/trees') {
      const t = sha(JSON.stringify(body.tree));
      trees[t] = body.tree;
      return json(201, { sha: t });
    }
    if (method === 'GET' && p.startsWith('/git/trees/')) {
      const t = trees[p.split('/').pop() || ''];
      return t ? json(200, { tree: t.map((/** @type {any} */ e) => ({ ...e })), truncated: false }) : json(404, {});
    }
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

  // AND IT SAYS WHAT IT APPLIES TO, off the patch itself.
  assert.ok(r.ok && r.base);
  assert.equal(r.ok && r.base?.commit, git(ws, ['rev-parse', 'HEAD']).stdout.trim());
  assert.equal(r.ok && r.base?.branch, 'main');
  assert.equal(r.ok && r.base?.remote, null);
  const json = JSON.parse(archiveFiles({
    rec: /** @type {any} */ ({ name: 'job', status: 'running', createdAt: 0 }),
    host: 'deb14', reason: 'stop', at: 0, pane: 'p', transcript: { ok: false, why: 'x' }, patch: r,
  })['session.json'].toString());
  assert.deepEqual(json.workspace, r.ok ? r.base : null);
});

test('the base line is taken off the patch, and a token in the remote never reaches a commit', () => {
  const out = Buffer.from(`fleetwright-base\t${'a'.repeat(40)}\tfix/thing\thttps://x-access-token:ghs_SECRET@github.com/eli/app.git\ndiff --git a/x b/x\n`);
  const { base, rest } = splitBase(out);
  assert.deepEqual(base, { commit: 'a'.repeat(40), branch: 'fix/thing', remote: 'https://github.com/eli/app.git' });
  assert.equal(rest.toString(), 'diff --git a/x b/x\n');
  assert.deepEqual(splitBase(Buffer.from('fleetwright-base\t-\t-\t-\n')).base, { commit: null, branch: null, remote: null });
  // A patch from before the header is a patch, whole.
  assert.equal(splitBase(Buffer.from('diff --git a/x b/x\n')).rest.toString(), 'diff --git a/x b/x\n');
  const readme = archiveFiles({
    rec: /** @type {any} */ ({ name: 'job', status: 'running', createdAt: 0 }), host: 'deb14', reason: 'stop', at: 0, pane: 'p',
    transcript: { ok: false, why: 'x' },
    patch: { ok: true, patch: Buffer.from('diff'), tooBig: false, base: { commit: 'a'.repeat(40), branch: 'main', remote: 'https://github.com/eli/app.git' } },
  })['README.md'].toString();
  assert.match(readme, new RegExp(`git checkout ${'a'.repeat(40)}\` in a clone of https://github.com/eli/app.git`));
});

test('a sandboxed session’s transcript is the one file named for its uuid, and never a link', () => {
  const vol = scratch('archive-vol-');
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  mkdirSync(path.join(vol, 'projects', '-work'), { recursive: true });
  writeFileSync(path.join(vol, '.credentials.json'), '{"secret":true}');
  writeFileSync(path.join(vol, 'projects', '-work', `${uuid}.jsonl`), '{"type":"user"}\n');
  const run = (/** @type {string} */ u, max = 1000) => spawnSync('sh', ['-c', TRANSCRIPT_SCRIPT, 'sh', u, String(max), vol], { encoding: 'utf8' });
  const r = run(uuid);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '{"type":"user"}\n');
  // Over the limit: one byte past it, so the caller can say "too big".
  assert.equal(run(uuid, 4).stdout.length, 5);
  // A link where the transcript should be is not followed to what it names.
  const other = '11111111-2222-4333-8444-555555555555';
  symlinkSync(path.join(vol, '.credentials.json'), path.join(vol, 'projects', '-work', `${other}.jsonl`));
  const linked = run(other);
  assert.notEqual(linked.status, 0);
  assert.doesNotMatch(linked.stdout, /secret/);
});

test('coming back to its prompt pushes at most once a minute, and the last turn in the gap is not lost', () => {
  let t = 0;
  /** @type {string[]} */ const pushed = [];
  /** @type {Array<{ fn: () => void, at: number }>} */ const timers = [];
  const pacer = new ArchivePacer({ push: (n) => pushed.push(`${n}@${t}`), gapMs: 60_000, now: () => t, later: (fn, ms) => timers.push({ fn, at: t + ms }) });
  pacer.poke('job');
  assert.deepEqual(pushed, ['job@0']);
  t = 10_000; pacer.poke('job');
  t = 20_000; pacer.poke('job');
  assert.equal(timers.length, 1, 'turns inside the gap wait together');
  assert.equal(timers[0].at, 60_000);
  t = 60_000; timers[0].fn();
  assert.deepEqual(pushed, ['job@0', 'job@60000']);
  t = 200_000; pacer.poke('job');
  assert.deepEqual(pushed, ['job@0', 'job@60000', 'job@200000']);
  // Another session is paced on its own.
  pacer.poke('other');
  assert.equal(pushed.at(-1), 'other@200000');
});

test('INDEX.md gets one line per session, newest first, replaced when it ends again, and retried on a race', async () => {
  /** @type {{ content: string, sha: string }|null} */ let file = null;
  let conflicts = 1;
  const impl = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    assert.match(url, /\/repos\/eli\/work\/contents\/INDEX\.md$/);
    if ((init.method || 'GET') === 'GET') return file ? json(200, { content: Buffer.from(file.content).toString('base64'), sha: file.sha }) : json(404, {});
    const body = JSON.parse(init.body);
    if (conflicts-- > 0) return json(409, {});
    assert.equal(body.sha, file?.sha);
    file = { content: Buffer.from(body.content, 'base64').toString(), sha: sha(body.content) };
    return json(200, {});
  });
  const rec = (/** @type {string} */ name, /** @type {string} */ title, /** @type {number} */ at) => /** @type {any} */ ({ name, title, createdAt: at });
  const a = branchFor('deb14', rec('a', 'x', 0));
  const b = branchFor('deb14', rec('b', 'y', 60_000));
  assert.equal((await updateIndex({ repo: 'eli/work', token: 't', branch: a, line: indexLine(rec('a', 'First [job](http://x)', 0), 'deb14', 0, a), fetchImpl: impl })).ok, true);
  assert.equal((await updateIndex({ repo: 'eli/work', token: 't', branch: b, line: indexLine(rec('b', 'Second', 60_000), 'deb14', 0, b), fetchImpl: impl })).ok, true);
  assert.equal((await updateIndex({ repo: 'eli/work', token: 't', branch: a, line: indexLine(rec('a', 'First again', 0), 'deb14', 0, a), fetchImpl: impl })).ok, true);
  const lines = String(file && /** @type {any} */ (file).content).split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /First again/);
  assert.match(lines[1], /Second/);
  assert.match(lines[1], /\[b\]\(\.\.\/\.\.\/tree\/fleetwright\/deb14\/b-19700101T000100Z\)$/);
  // A title cannot make a link of its own.
  assert.doesNotMatch(indexLine(rec('a', 'First [job](http://x)', 0), 'deb14', 0, a), /\]\(http/);
});

test('a workspace that is not a checkout is archived whole, and one too big is left out rather than cut', { skip: !HAVE_GIT && 'no git' }, async () => {
  const dir = scratch('archive-plain-');
  writeFileSync(path.join(dir, 'out.txt'), 'result\n');
  const r = await workspacePatch(unsandboxed, /** @type {any} */ ({ name: 'job', cwd: dir }));
  assert.ok(r.ok && !r.tooBig);
  assert.match(r.ok ? r.patch.toString() : '', /\+result/);

  writeFileSync(path.join(dir, 'huge.bin'), Buffer.alloc(MAX_PATCH_BYTES, 7));
  const big = await workspacePatch(unsandboxed, /** @type {any} */ ({ name: 'job', cwd: dir }));
  assert.ok(big.ok && big.tooBig);
  const readme = archiveFiles({
    rec: /** @type {any} */ ({ name: 'job', status: 'running', createdAt: 0 }),
    host: 'deb14', reason: 'stop', at: 0, pane: 'p',
    transcript: { ok: false, why: 'this box cannot read it' },
    patch: big,
  })['README.md'].toString();
  assert.match(readme, /## Not in it, and why[\s\S]*the workspace: its changes are over the 50MB an archive carries/);
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
  assert.match(none.text, /^Not archived to eli\/work: its owner’s vault gives this box no GitHub sign-in/);
  assert.equal(gh.calls.length, 0);
  assert.equal(registry.get('job')?.archiveOk, false, 'the outcome is on the record, for the phones');

  // The box's own row is never the one a session is pushed as.
  new Connections(dir).save('', 'github', 'ghu_box');
  assert.match((await archiveSession({ cfg, registry, name: 'boxjob', reason: 'stop', fetchImpl: gh.impl, broker: '' })).text, /nobody signed in started it/);

  // LINKED ON THE BOX IS NOT THEIRS: a fleet person is pushed as what their
  // vault gives this box, and nothing else.
  new Connections(dir).save('eli@example.com', 'github', 'ghu_linked_here');
  assert.match((await archiveSession({ cfg, registry, name: 'job', reason: 'stop', fetchImpl: gh.impl, broker: '' })).text, /vault gives this box no GitHub sign-in/);
  applyVault({ stateDir: dir }, { accounts: [{ email: 'eli@example.com', items: [{ name: 'github', value: 'ghu_eli', expiresAt: Date.now() + 3_600_000 }] }] });
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

test('on a vault box a session started on the box itself is pushed as its operator, from their vault', async () => {
  // Its operator is a named person who approved the box (accounts.js,
  // operatorAccount), so there is somebody to push as, and never the box's
  // own row. Where nobody can be named, the reason why is the refusal.
  const dir = scratch('archive-vault-box-');
  const cfg = /** @type {any} */ ({ stateDir: dir, hostname: 'deb14', sandbox: false, stateFile: path.join(dir, 'state.json'), spoolFile: path.join(dir, 'spool') });
  const registry = new Registry({ stateFile: cfg.stateFile, spoolFile: cfg.spoolFile });
  registry.upsert('boxjob', { status: 'stopped', cwd: scratch('archive-cwd-'), archive: 'eli/work', createdBy: 'cli' });
  registry.upsert('boxjob', { createdAt: Date.UTC(2026, 9, 7, 12) });
  new Connections(dir).save(HOST_ROW, 'github', 'ghu_box');
  const gh = github();

  applyVault({ stateDir: dir }, { accounts: [{ email: 'eli@example.com', items: [{ name: 'github', value: 'ghu_eli', expiresAt: Date.now() + 3_600_000 }] }] });
  /** @type {string[]} */
  const auth = [];
  const seen = /** @type {any} */ (async (/** @type {string} */ u, /** @type {any} */ init) => { auth.push(init?.headers?.authorization); return gh.impl(u, init); });
  // One approver is not the operator until FLEETWRIGHT_OPERATOR names them.
  const unnamed = await archiveSession({ cfg, registry, name: 'boxjob', reason: 'stop', fetchImpl: seen, broker: '' });
  assert.equal(unnamed.ok, false);
  assert.match(unnamed.text, /FLEETWRIGHT_OPERATOR is not set/);
  assert.equal(auth.length, 0, 'nothing asked of GitHub');
  const done = await archiveSession({ cfg: { ...cfg, operator: 'eli@example.com' }, registry, name: 'boxjob', reason: 'stop', fetchImpl: seen, broker: '' });
  assert.equal(done.ok, true, done.text);
  assert.ok(auth.length && auth.every((a) => a === 'Bearer ghu_eli'), 'pushed with something other than the operator’s vault');

  applyVault({ stateDir: dir }, { accounts: [
    { email: 'eli@example.com', items: [{ name: 'github', value: 'ghu_eli', expiresAt: Date.now() + 3_600_000 }] },
    { email: 'ann@example.com', items: [{ name: 'github', value: 'ghu_ann', expiresAt: Date.now() + 3_600_000 }] },
  ] });
  const calls = gh.calls.length;
  const two = await archiveSession({ cfg, registry, name: 'boxjob', reason: 'stop', fetchImpl: gh.impl, broker: '' });
  assert.equal(two.ok, false);
  assert.match(two.text, /2 people’s vaults give this box something, so set FLEETWRIGHT_OPERATOR/);
  assert.equal(gh.calls.length, calls, 'nothing asked of GitHub');
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

test('a turn ending is what tells the archive, and only a turn ending', async (t) => {
  const { SessionManager } = await import('../src/core/sessions.js');
  const dir = scratch('archive-sm-');
  const cfg = /** @type {any} */ ({ stateDir: dir, profileDir: path.join(dir, 'profiles'), workdir: dir, stateFile: path.join(dir, 'state.json'), spoolFile: path.join(dir, 'spool') });
  const sm = new SessionManager(cfg, new Registry({ stateFile: cfg.stateFile, spoolFile: cfg.spoolFile }), null);
  sm.reconcile = () => false;
  /** @type {string[]} */ const paused = [];
  sm.onPause = (name) => paused.push(name);
  sm.recordEvent({ name: 'job', event: 'Stop' });
  assert.deepEqual(paused, [], 'at its prompt without having worked is not a turn');
  sm.recordEvent({ name: 'job', event: 'UserPromptSubmit' });
  sm.recordEvent({ name: 'job', event: 'PostToolUse', detail: 'Bash' });
  sm.recordEvent({ name: 'job', event: 'Stop' });
  assert.deepEqual(paused, ['job']);
  sm.recordEvent({ name: 'job', event: 'Notification', detail: 'idle_prompt' });
  assert.deepEqual(paused, ['job'], 'a second word from the prompt is not another turn');
  sm.recordEvent({ name: 'job', event: 'PostToolUse', detail: 'Edit' });
  sm.recordEvent({ name: 'job', event: 'PermissionRequest' });
  assert.deepEqual(paused, ['job', 'job'], 'waiting on a person is a pause too');
  // A handler that throws does not take the hook down with it.
  sm.onPause = () => { throw new Error('boom'); };
  sm.recordEvent({ name: 'job', event: 'UserPromptSubmit' });
  assert.equal(sm.recordEvent({ name: 'job', event: 'Stop' }).ok, true);
});

// --- big files ---------------------------------------------------------------

test('a file is cut into pieces that join back, a transcript only between its lines', () => {
  const bytes = Buffer.from('aaaa\nbb\ncccccc\nd\n');
  const lines = piecesOf(bytes, 8, { atLines: true });
  assert.deepEqual(lines.map(String), ['aaaa\nbb\n', 'cccccc\n', 'd\n']);
  assert.equal(Buffer.concat(lines).toString(), bytes.toString());
  // A line longer than a piece is a piece of its own, never split.
  assert.deepEqual(piecesOf(Buffer.from('x\n' + 'y'.repeat(20) + '\nz\n'), 8, { atLines: true }).map(String), ['x\n', `${'y'.repeat(20)}\n`, 'z\n']);
  // A patch is cut anywhere.
  assert.deepEqual(piecesOf(Buffer.from('0123456789'), 4).map(String), ['0123', '4567', '89']);
  assert.deepEqual(piecesOf(Buffer.alloc(0), 4), []);
  // Growing at the end changes only the last piece, which is what lets a push skip the rest.
  const before = piecesOf(Buffer.from('aaaa\nbb\ncccccc\n'), 8, { atLines: true });
  const after = piecesOf(Buffer.from('aaaa\nbb\ncccccc\nmore\n'), 8, { atLines: true });
  assert.deepEqual(after.slice(0, before.length - 1).map(String), before.slice(0, -1).map(String));
});

test('a long conversation and a big patch are archived in pieces, and the README says how to join them', () => {
  const line = `${JSON.stringify({ type: 'assistant', text: 'x'.repeat(1000) })}\n`;
  const transcript = Buffer.from(line.repeat(Math.ceil((PIECE_BYTES * 2.5) / line.length)));
  const patch = Buffer.alloc(PIECE_BYTES + 10, 'p');
  const files = archiveFiles({
    rec: /** @type {any} */ ({ name: 'job', status: 'running', createdAt: 0 }), host: 'deb14', reason: 'stop', at: 0, pane: 'p',
    transcript: { ok: true, bytes: transcript },
    patch: { ok: true, patch, tooBig: false, base: { commit: 'a'.repeat(40), branch: 'main', remote: null } },
  });
  const pieces = Object.keys(files).filter((n) => n.startsWith('transcript/')).sort();
  assert.deepEqual(pieces, ['transcript/000.jsonl', 'transcript/001.jsonl', 'transcript/002.jsonl']);
  assert.ok(pieces.every((n) => files[n].length <= PIECE_BYTES));
  assert.ok(pieces.every((n) => files[n].toString().endsWith('\n')), 'every piece ends on a line');
  assert.equal(Buffer.concat(pieces.map((n) => files[n])).equals(transcript), true);
  assert.deepEqual(Object.keys(files).filter((n) => n.startsWith('workspace.patch')).sort(), ['workspace.patch.000', 'workspace.patch.001']);
  assert.equal(Buffer.concat([files['workspace.patch.000'], files['workspace.patch.001']]).equals(patch), true);
  const readme = files['README.md'].toString();
  assert.match(readme, /in 3 pieces cut between lines; `cat transcript\/\*\.jsonl` is the whole of it/);
  assert.match(readme, /`cat workspace\.patch\.\* > workspace\.patch` \(2 pieces\), then `git checkout a{40}`/);
  // A small patch is still the one file it always was.
  const small = archiveFiles({
    rec: /** @type {any} */ ({ name: 'job', status: 'running', createdAt: 0 }), host: 'deb14', reason: 'stop', at: 0, pane: 'p',
    transcript: { ok: true, bytes: Buffer.from(line) },
    patch: { ok: true, patch: Buffer.from('diff\n'), tooBig: false, base: null },
  });
  assert.ok(small['workspace.patch'] && small['transcript/000.jsonl']);
});

test('a push sends only the pieces the branch does not already hold', async () => {
  const gh = github();
  const piece = (/** @type {string} */ c) => Buffer.from(`${c.repeat(100)}\n`);
  const first = { 'transcript/000.jsonl': piece('a'), 'transcript/001.jsonl': piece('b'), 'README.md': Buffer.from('# job\n') };
  assert.equal((await pushArchive({ repo: 'eli/work', branch: BRANCH, files: first, message: 'm', token: 't', fetchImpl: gh.impl })).ok, true);
  const uploads = () => gh.calls.filter((c) => c.method === 'POST' && c.path === '/git/blobs').length;
  assert.equal(uploads(), 3);
  // The conversation grew: one new last piece, everything else held.
  const second = { ...first, 'transcript/001.jsonl': piece('c'), 'transcript/002.jsonl': piece('d') };
  const r = await pushArchive({ repo: 'eli/work', branch: BRANCH, files: second, message: 'm', token: 't', fetchImpl: gh.impl });
  assert.ok(r.ok && !r.unchanged);
  assert.equal(uploads(), 5, 'only the two new pieces were sent');
  // Nothing new: nothing sent, and no commit.
  const third = await pushArchive({ repo: 'eli/work', branch: BRANCH, files: second, message: 'm', token: 't', fetchImpl: gh.impl });
  assert.ok(third.ok && third.unchanged);
  assert.equal(uploads(), 5);
});
