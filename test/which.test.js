// Resolving `claude` to an absolute path.
//
// WHY THIS FILE DID NOT EXIST UNTIL NOW, which is the interesting part. This
// module had no test. It measured 95% anyway — every spawned CLI calls
// resolveBin through config.js, and the machine recording the floor had claude
// installed, so the "found it" branch ran as a side effect.
//
// On CI, which has no claude, the same unchanged code measures 84.85% and the
// ratchet reports a regression that never happened. Accidental coverage is
// coverage of whatever the machine happens to be, and it reads exactly like the
// real thing until the machine changes.
//
// So the branches are exercised deliberately, and CI now reaches the ones it
// could not reach before — which is the point of the gate being there.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveBin } from '../src/core/which.js';

/** Run `fn` with PATH and HOME pointing at a directory of our own. */
function withEnv({ PATH: p, HOME: h }, fn) {
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  if (p !== undefined) process.env.PATH = p;
  if (h !== undefined) process.env.HOME = h;
  try {
    return fn();
  } finally {
    process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
}

function exe(dir, name) {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
}

test('an explicit path always wins, and is not searched for', () => {
  // AGENT_HUB_CLAUDE_BIN is somebody's own arrangement. A name with a slash in
  // it is already an answer, and going looking would be this module overruling
  // the operator.
  assert.equal(resolveBin('/opt/weird/claude'), '/opt/weird/claude');
  assert.equal(resolveBin('./claude'), './claude');
  // Nothing to resolve.
  assert.equal(resolveBin(''), '');
});

test('a binary on PATH resolves to its absolute path', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'which-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const full = exe(bin, 'claude');

  // HOME somewhere empty, so a real ~/.local/bin cannot answer instead and make
  // this pass on one machine for a reason that is not being tested.
  assert.equal(withEnv({ PATH: bin, HOME: dir }, () => resolveBin('claude')), full);
});

test('and in ~/.local/bin, which is where the official installer puts it', (t) => {
  // THE TRAP THIS MODULE EXISTS FOR: Claude Code installs to ~/.local/bin and
  // adds it to ~/.bashrc, which Debian's stock bashrc skips for a
  // non-interactive shell — so the binary works when you type it and is absent
  // from every session the hub launches.
  const home = mkdtempSync(path.join(tmpdir(), 'which-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const full = exe(path.join(home, '.local', 'bin'), 'claude');

  // Deliberately NOT on PATH: that is the whole situation.
  assert.equal(withEnv({ PATH: path.join(home, 'empty'), HOME: home }, () => resolveBin('claude')), full);
});

test('PATH is searched before the fallback directories', (t) => {
  // An operator who put one on PATH meant that one.
  const work = mkdtempSync(path.join(tmpdir(), 'which-order-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const onPath = exe(path.join(work, 'bin'), 'claude');
  exe(path.join(work, '.local', 'bin'), 'claude');

  assert.equal(
    withEnv({ PATH: path.join(work, 'bin'), HOME: work }, () => resolveBin('claude')),
    onPath,
  );
});

test('a file that is not executable is not the binary', (t) => {
  const work = mkdtempSync(path.join(tmpdir(), 'which-noexec-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const bin = path.join(work, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'claude'), 'not executable');
  chmodSync(path.join(bin, 'claude'), 0o644);

  // THE BARE NAME COMES BACK, on purpose. The caller's own error — "is claude
  // on PATH?" — is more useful than a synthetic one from here, and a made-up
  // absolute path would send somebody looking at a file that is not the problem.
  assert.equal(withEnv({ PATH: bin, HOME: work }, () => resolveBin('claude')), 'claude');
});

test('a DIRECTORY called claude is not the binary either', (t) => {
  const work = mkdtempSync(path.join(tmpdir(), 'which-dir-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const bin = path.join(work, 'bin');
  // existsSync says yes and it has execute bits, because directories do. Only
  // isFile() tells them apart, which is why that check is there.
  mkdirSync(path.join(bin, 'claude'), { recursive: true });

  assert.equal(withEnv({ PATH: bin, HOME: work }, () => resolveBin('claude')), 'claude');
});

test('nothing found anywhere gives the name back unchanged', (t) => {
  const work = mkdtempSync(path.join(tmpdir(), 'which-none-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  assert.equal(
    withEnv({ PATH: path.join(work, 'nowhere'), HOME: work }, () => resolveBin('definitely-not-installed-xyz')),
    'definitely-not-installed-xyz',
  );
});

test('an empty PATH does not throw', (t) => {
  // `(process.env.PATH || '').split(...)` with .filter(Boolean) — an empty
  // string splits to [''] and path.join(dir, name) on '' is a relative path
  // that could match something in the working directory.
  const work = mkdtempSync(path.join(tmpdir(), 'which-empty-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  assert.equal(
    withEnv({ PATH: '', HOME: work }, () => resolveBin('definitely-not-installed-xyz')),
    'definitely-not-installed-xyz',
  );
});
