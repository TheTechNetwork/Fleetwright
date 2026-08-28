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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runUpdate, updateStatus, canSelfRestart, looksLikeOwnershipProblem, updateAvailable } from '../src/core/update.js';

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

  /**
   * A commit that REACHES A HOST — it touches bin/, which is in HOST_PATHS.
   *
   * It used to write README.md, which stopped representing a host update the
   * moment "behind" became path-scoped: a docs commit is exactly the thing a
   * host should now ignore. The fixture said "the upstream moved"; what these
   * tests mean is "the upstream moved in a way this box runs".
   *
   * @param {string} message
   */
  const pushUpstream = (message) => {
    mkdirSync(path.join(origin, 'bin'), { recursive: true });
    writeFileSync(path.join(origin, 'bin', 'agent-hub'), `#!/usr/bin/env node\n// ${message}\n`);
    git(origin, ['add', '-A']);
    git(origin, ['commit', '-qm', message]);
  };

  /** A commit that does NOT: docs only. @param {string} message */
  const pushDocsOnly = (message) => {
    mkdirSync(path.join(origin, 'docs'), { recursive: true });
    writeFileSync(path.join(origin, 'docs', 'notes.md'), `${message}\n`);
    git(origin, ['add', '-A']);
    git(origin, ['commit', '-qm', message]);
  };

  return { root, origin, clone, pushUpstream, pushDocsOnly, cfg: /** @type {any} */ ({ installDir: clone }) };
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

test("git's \"insufficient permission\" counts as the ownership problem", () => {
  // The exact porcelain from a box where somebody ran `sudo git pull` once.
  // Git does NOT say "permission denied" here — matching only that phrase
  // left this branch dead for the failure it was written for, and the
  // operator got raw git output instead of the fix.
  assert.equal(
    looksLikeOwnershipProblem(
      'error: insufficient permission for adding an object to repository database .git/objects\n' +
        'fatal: failed to write object\nfatal: unpack-objects failed',
    ),
    true,
  );

  // The other shapes this takes, all seen on real boxes.
  for (const output of [
    "fatal: detected dubious ownership in repository at '/opt/agent-fleet'",
    'error: could not lock config file .git/config: Permission denied',
    'fatal: could not create work tree dir: Read-only file system',
  ]) {
    assert.equal(looksLikeOwnershipProblem(output), true, output);
  }

  // And what must NOT be swallowed by it: a real merge problem needs its own
  // advice, not "fix the permissions".
  for (const output of [
    'fatal: Not possible to fast-forward, aborting.',
    'fatal: unable to access https://github.com/x/y: Could not resolve host',
  ]) {
    assert.equal(looksLikeOwnershipProblem(output), false, output);
  }
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

// --- dependencies -----------------------------------------------------------
//
// A pull can change what the code needs. Until this step existed it did not
// change what is installed, and the shape of that failure is the worst one
// available: /update reports success, the service restarts, and the coordinator
// dies naming a package nobody has heard of — after the operator was told it
// worked.

test('a deployment with no package.json is left alone', (t) => {
  // Which is what every other test in this file is, and what a deployment of
  // something that is not an npm project would be. Running npm there is how a
  // perfectly good update reports a failure.
  const { cfg, pushUpstream } = deployment(t);
  pushUpstream('two');

  const r = runUpdate(cfg);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(/npm|packages/i.test(r.message), false, 'and says nothing about packages');
});

test('a pull that changes dependencies installs them', (t) => {
  const { cfg, origin, clone, pushUpstream } = deployment(t);
  // A real package.json with a real lockfile, and no dependencies — so this
  // exercises the whole path, npm included, without a network.
  // Committed ONCE, in the origin, and pulled down.
  //
  // It used to be written and committed independently in BOTH repos, which is
  // only the same history when the two commits land in the same second — a
  // commit hash covers its own timestamp. A slow machine gave the clone a
  // divergent commit, and /update then refused to fast-forward, correctly. So
  // the test passed on anything quick and failed on CI, which is the worst way
  // for a test to be wrong: it accuses the code of a bug the test invented.
  //
  // Mirrors the real deployment: node_modules is gitignored. Without that it
  // shows up as untracked, /update calls the tree dirty and refuses to pull —
  // which is exactly what would happen on a box if it were ever un-ignored.
  writeFileSync(path.join(origin, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(origin, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', private: true }));
  writeFileSync(
    path.join(origin, 'package-lock.json'),
    JSON.stringify({ name: 'x', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'x', version: '1.0.0' } } }),
  );
  git(origin, ['add', '-A']);
  git(origin, ['commit', '-qm', 'add a manifest']);
  // fetch + hard reset, not a second commit and a pull: identical history by
  // construction, with no commit of its own to have a timestamp.
  git(clone, ['fetch', '-q', 'origin']);
  git(clone, ['reset', '-q', '--hard', 'origin/main']);
  pushUpstream('later');

  // `npm ci` empties node_modules before installing, so a file left in there is
  // proof that npm actually ran rather than that the step reported success.
  mkdirSync(path.join(clone, 'node_modules'), { recursive: true });
  writeFileSync(path.join(clone, 'node_modules', 'stale.txt'), 'from the old dependencies');

  const r = runUpdate(cfg);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /Packages are up to date/);
  assert.equal(existsSync(path.join(clone, 'node_modules', 'stale.txt')), false, 'npm ci actually ran');
});

test('nothing pulled and packages present is not worth running npm for', (t) => {
  const { cfg, clone } = deployment(t);
  writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', private: true }));
  mkdirSync(path.join(clone, 'node_modules'), { recursive: true });
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-qm', 'manifest']);
  git(clone, ['reset', '-q', '--hard', 'HEAD~1']);
  git(clone, ['clean', '-qfd', '--', '.']);

  const started = Date.now();
  const r = runUpdate(cfg);
  assert.equal(r.ok, true, r.message);
  // Not a timing assertion so much as a shape one: turning a five-second
  // command into a thirty-second one on every /update is its own bug.
  assert.ok(Date.now() - started < 10_000);
});


// --- what actually reaches a host -------------------------------------------

test('a docs-only commit does not make a host say it is behind', (t) => {
  // The repository is a monorepo; a host runs a fraction of it. Unscoped, a
  // README edit made every box report "1 commit behind" — and somebody who
  // believes that number restarts three services to deliver a paragraph.
  const { cfg, pushDocsOnly } = deployment(t);
  pushDocsOnly('write some documentation');
  const r = updateAvailable(cfg, { force: true });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.behind, 0, 'docs are not something this box runs');
});

test('a commit touching host code does', (t) => {
  const { cfg, pushUpstream } = deployment(t);
  pushUpstream('change the hub');
  const r = updateAvailable(cfg, { force: true });
  assert.equal(r.behind, 1);
});

test('mixed history counts only the host commits', (t) => {
  const { cfg, pushDocsOnly, pushUpstream } = deployment(t);
  pushDocsOnly('docs one');
  pushUpstream('host one');
  pushDocsOnly('docs two');
  const r = updateAvailable(cfg, { force: true });
  assert.equal(r.behind, 1, 'three commits upstream, one of them for this box');
});

test('pulling docs-only changes updates the checkout but does not restart', (t) => {
  // The checkout must still move — a box whose tree drifts from its upstream
  // is a box whose next real update has to reconcile two things at once. What
  // changes is that nothing is restarted for it.
  const { cfg, clone, pushDocsOnly } = deployment(t);
  pushDocsOnly('more documentation');
  const r = runUpdate(cfg);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.changed, false, 'nothing that runs on this box changed');
  assert.match(r.message, /Nothing in that runs on this box/);
  assert.ok(
    existsSync(path.join(clone, 'docs', 'notes.md')),
    'the checkout still fast-forwarded — only the restart was skipped',
  );
});
