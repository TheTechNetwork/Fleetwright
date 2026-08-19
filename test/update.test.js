// /update, against real git repositories.
//
//   node --test test/
//
// Every case here is a state a deployment genuinely gets into — behind, up to
// date, dirty, diverged, not a checkout at all — and the interesting question
// for each is what it REFUSES to do. Mocking git would test the mock.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runUpdate, updateStatus, canSelfRestart } from '../src/core/update.js';

/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

/**
 * An upstream repo and a clone of it, the way a deployment actually sits.
 * @param {import('node:test').TestContext} t
 */
function deployment(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const origin = path.join(root, 'origin');
  mkdirSync(origin);
  git(origin, ['init', '-q', '-b', 'main']);
  git(origin, ['config', 'user.email', 'test@example.com']);
  git(origin, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(origin, 'README.md'), 'one\n');
  git(origin, ['add', '-A']);
  git(origin, ['commit', '-qm', 'first commit']);

  const clone = path.join(root, 'deploy');
  git(root, ['clone', '-q', origin, clone]);
  git(clone, ['config', 'user.email', 'test@example.com']);
  git(clone, ['config', 'user.name', 'Test']);

  /** @param {string} message */
  const pushUpstream = (message) => {
    writeFileSync(path.join(origin, 'README.md'), `${message}\n`);
    git(origin, ['add', '-A']);
    git(origin, ['commit', '-qm', message]);
  };

  return { root, origin, clone, pushUpstream, cfg: /** @type {any} */ ({ installDir: clone }) };
}

// --- reading the state ------------------------------------------------------

test('a checkout reports its branch and head', (t) => {
  const { cfg, clone } = deployment(t);
  const s = updateStatus(cfg);

  assert.equal(s.ok, true);
  assert.equal(s.dir, clone);
  assert.equal(s.branch, 'main');
  assert.match(String(s.head), /^[0-9a-f]{7,}$/);
  assert.deepEqual(s.dirty, []);
});

test('somewhere that is not a checkout says so, rather than failing at git', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'notrepo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const s = updateStatus(/** @type {any} */ ({ installDir: dir }));

  assert.equal(s.ok, false);
  assert.match(String(s.message), /not a git checkout/);
});

// --- pulling ----------------------------------------------------------------

test('a deployment that is behind is fast-forwarded, and says what arrived', (t) => {
  const { cfg, pushUpstream } = deployment(t);
  pushUpstream('the fix everyone is waiting for');

  const r = runUpdate(cfg);

  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.match(r.message, /the fix everyone is waiting for/);
  assert.match(r.message, /[0-9a-f]{7} → [0-9a-f]{7}/);
});

test('an up-to-date deployment changes nothing and says nothing happened', (t) => {
  const { cfg } = deployment(t);
  const r = runUpdate(cfg);

  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.match(r.message, /Already up to date/);
});

test('several new commits are summarised, not dumped', (t) => {
  const { cfg, pushUpstream } = deployment(t);
  for (let i = 1; i <= 14; i++) pushUpstream(`commit number ${i}`);

  const r = runUpdate(cfg);

  assert.equal(r.changed, true);
  assert.match(r.message, /…and 4 more/, 'a chat message is not a place for an unbounded log');
  assert.equal(r.message.split('\n').filter((l) => /^ {2}[0-9a-f]{7} /.test(l)).length, 10);
});

// --- what it refuses to do --------------------------------------------------

test('a dirty tree is refused, with the files listed', (t) => {
  // Someone is editing the box directly: mid-debug or mid-hotfix. Discarding
  // that from a chat message is not a recoverable mistake.
  const { cfg, clone, pushUpstream } = deployment(t);
  pushUpstream('upstream moved on');
  writeFileSync(path.join(clone, 'README.md'), 'edited by hand on the box\n');

  const r = runUpdate(cfg);

  assert.equal(r.ok, false);
  assert.equal(r.changed, false);
  assert.match(r.message, /uncommitted changes/);
  assert.match(r.message, /README\.md/);
  assert.match(r.message, /Commit or discard on the box first/);

  // And nothing was pulled.
  assert.equal(git(clone, ['log', '--oneline']).stdout.split('\n').filter(Boolean).length, 1);
});

test('a diverged deployment fails loudly rather than merging', (t) => {
  // --ff-only. A merge commit nobody reviewed, created from a chat message, is
  // how a deployment's history stops matching anything anyone can reason about.
  const { cfg, clone, pushUpstream } = deployment(t);
  pushUpstream('upstream work');
  writeFileSync(path.join(clone, 'local.txt'), 'a hotfix applied on the box\n');
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-qm', 'local hotfix']);

  const r = runUpdate(cfg);

  assert.equal(r.ok, false);
  assert.match(r.message, /local commits that are not upstream/);
  assert.ok(!git(clone, ['log', '--oneline']).stdout.includes('Merge'), 'must not have merged');
});

test('an unreachable remote is reported, not swallowed', (t) => {
  const { cfg, clone } = deployment(t);
  git(clone, ['remote', 'set-url', 'origin', '/definitely/not/a/repo']);

  const r = runUpdate(cfg);

  assert.equal(r.ok, false);
  assert.match(r.message, /git pull failed/);
});

// --- restarting -------------------------------------------------------------

test('an update that changed nothing does not restart on its own', (t) => {
  const { cfg } = deployment(t);
  let exited = false;

  const r = runUpdate(cfg, { exit: () => (exited = true) });

  assert.equal(r.restarting, false);
  assert.equal(exited, false, 'restarting to apply nothing is pure downtime');
});

test('an explicit restart still restarts when the pull found nothing', (t) => {
  // This reverses an earlier decision, on purpose. "Restarting to apply
  // nothing is pure downtime" is true in the abstract and wrong for the path
  // the button actually drives: /update pulls and offers "Restart to apply",
  // the button runs /update --restart, and THAT pull finds nothing because the
  // first one already fetched it. Refusing then meant the button answered
  // "Already up to date" and never restarted — new code on disk, old process
  // serving it, and the UI reporting success.
  //
  // `changed` answers "did this invocation pull anything", which is not the
  // question a restart request is asking.
  const { cfg } = deployment(t);
  let exited = false;
  const previous = process.env.INVOCATION_ID;
  process.env.INVOCATION_ID = 'test-systemd-run';
  t.after(() => {
    if (previous === undefined) delete process.env.INVOCATION_ID;
    else process.env.INVOCATION_ID = previous;
  });

  const r = runUpdate(cfg, { restart: true, exit: () => (exited = true) });

  assert.equal(r.ok, true);
  assert.equal(r.restarting, true, 'somebody asked for a restart');
  assert.match(r.message, /already fetched/, 'and it says why there was nothing to pull');
});

test('--restart exits so systemd brings the new code back', (t) => {
  // Exiting rather than `systemctl restart`: Restart=always brings us back and
  // it needs no privilege the service user does not already have.
  const { cfg, pushUpstream } = deployment(t);
  pushUpstream('something worth applying');
  const previous = process.env.INVOCATION_ID;
  process.env.INVOCATION_ID = 'test-systemd-run';
  t.after(() => {
    if (previous === undefined) delete process.env.INVOCATION_ID;
    else process.env.INVOCATION_ID = previous;
  });

  /** @type {number|null} */
  let code = null;
  const r = runUpdate(cfg, { restart: true, exit: (c) => (code = c) });

  assert.equal(r.ok, true);
  assert.equal(r.restarting, true);
  assert.match(r.message, /Sessions are left running/);
  assert.equal(code, null, 'the reply must go out before the process does');

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(code, 0);
      resolve(undefined);
    }, 2000);
  });
});

test('without systemd it says so instead of exiting into nothing', (t) => {
  const { cfg, pushUpstream } = deployment(t);
  pushUpstream('a change');
  const previous = process.env.INVOCATION_ID;
  delete process.env.INVOCATION_ID;
  t.after(() => {
    if (previous !== undefined) process.env.INVOCATION_ID = previous;
  });

  let exited = false;
  const r = runUpdate(cfg, { restart: true, exit: () => (exited = true) });

  assert.equal(canSelfRestart(), false);
  assert.equal(r.restarting, false);
  assert.equal(exited, false, 'exiting without a supervisor is just stopping');
  assert.match(r.message, /cannot restart itself/);
});

test('an update without --restart says the running process is still the old one', (t) => {
  const { cfg, pushUpstream } = deployment(t);
  pushUpstream('a change');

  const r = runUpdate(cfg);

  assert.equal(r.changed, true);
  assert.equal(r.restarting, false);
  assert.match(r.message, /still the old one|Restart the service/);
});
