// The workspace of a session that runs directly on the box — a Mac, a runner,
// any box without the sandbox. These answered "This host has no podman" for
// every session until a macOS runner made it the only way to get a session's
// output back, so what is tested here is that they now answer, and that what
// they answer from stays inside the session's own directory.
//
// Real directories, real symlinks: the check that matters is realpath, and a
// mocked filesystem would be testing the mock.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { listFiles, readFile, writeFile, copyFile, deleteFile } from '../src/core/files.js';

function box({ stateInside = false, stateUnder = null } = {}) {
  const top = mkdtempSync(path.join(tmpdir(), 'fw-direct-'));
  const work = path.join(top, 'work');
  const stateDir = stateUnder ? path.join(work, stateUnder) : stateInside ? path.join(work, '.fleetwright-state') : path.join(top, 'state');
  mkdirSync(work, { recursive: true });
  mkdirSync(path.join(stateDir, 'direct', 'someone-else'), { recursive: true });
  writeFileSync(path.join(stateDir, 'direct', 'someone-else', '.credentials.json'), '{"secret":"theirs"}');
  const outside = path.join(top, 'outside.txt');
  writeFileSync(outside, 'not yours');
  const cfg = /** @type {any} */ ({ sandbox: false, podmanBin: '/nonexistent/podman', stateDir, secretsDir: path.join(stateDir, 'secrets') });
  return { top, work, stateDir, outside, cfg, session: { cwd: work } };
}

test('a direct session’s files are listed and read from its own directory, directories first', () => {
  const { work, cfg, session } = box();
  mkdirSync(path.join(work, 'shots'));
  writeFileSync(path.join(work, 'report.md'), '# DuoNotes\nbuilt clean\n');
  writeFileSync(path.join(work, 'Alpha.txt'), 'a');

  const list = listFiles(cfg, 'cc-one', '.', session);
  assert.equal(list.ok, true, list.text);
  assert.deepEqual(list.entries?.map((e) => [e.kind, e.name]), [['dir', 'shots'], ['file', 'Alpha.txt'], ['file', 'report.md']]);

  const read = readFile(cfg, 'cc-one', 'report.md', session);
  assert.deepEqual(read, { ok: true, text: '# DuoNotes\nbuilt clean\n' });
});

test('without a session record it still says there is no workspace to browse, not a path', () => {
  const { cfg } = box();
  const r = listFiles(cfg, 'cc-one', '.', null);
  assert.equal(r.ok, false);
  assert.match(r.text, /no podman/);
});

test('a symlink out of the workspace is refused, for a read and for a write beneath it', () => {
  const { top, work, outside, cfg, session } = box();
  symlinkSync(outside, path.join(work, 'link.txt'));
  symlinkSync(top, path.join(work, 'up'));

  const read = readFile(cfg, 'cc-one', 'link.txt', session);
  assert.equal(read.ok, false);
  assert.match(read.text, /leaves the workspace/);

  const write = writeFile(cfg, 'cc-one', 'up/planted.txt', 'x', session);
  assert.equal(write.ok, false);
  assert.match(write.text, /leaves the workspace/);
  assert.equal(existsSync(path.join(top, 'planted.txt')), false);
});

test('fleetwright’s own state is out of reach even when the working directory holds it', () => {
  const { work, stateDir, cfg, session } = box({ stateInside: true });
  writeFileSync(path.join(work, 'notes.txt'), 'mine');
  const rel = path.relative(work, stateDir);

  const list = listFiles(cfg, 'cc-one', '.', session);
  assert.deepEqual(list.entries?.map((e) => e.name), ['notes.txt'], 'the state folder is left out, not offered and refused');

  for (const r of [
    readFile(cfg, 'cc-one', `${rel}/direct/someone-else/.credentials.json`, session),
    listFiles(cfg, 'cc-one', rel, session),
    copyFile(cfg, 'cc-one', rel, 'loot', session),
    deleteFile(cfg, 'cc-one', rel, session),
  ]) {
    assert.equal(r.ok, false);
    assert.match(r.text, /fleetwright's own state/);
  }
  assert.equal(readFileSync(path.join(stateDir, 'direct', 'someone-else', '.credentials.json'), 'utf8'), '{"secret":"theirs"}');
});

test('a folder that holds the state cannot be copied or deleted wholesale', () => {
  const { work, stateDir, cfg, session } = box({ stateUnder: 'home/.local/state/fleetwright' });
  for (const r of [deleteFile(cfg, 'cc-one', 'home', session), copyFile(cfg, 'cc-one', 'home', 'loot', session)]) {
    assert.equal(r.ok, false);
    assert.match(r.text, /fleetwright's own state/);
  }
  assert.equal(existsSync(path.join(stateDir, 'direct', 'someone-else', '.credentials.json')), true);
  assert.equal(existsSync(path.join(work, 'loot')), false);
});

test('writes, copies and deletes land in the workspace, and the workspace itself is not deletable', () => {
  const { work, cfg, session } = box();
  assert.equal(writeFile(cfg, 'cc-one', 'a/b/new.txt', 'hello', session).ok, true);
  assert.equal(readFileSync(path.join(work, 'a/b/new.txt'), 'utf8'), 'hello');

  assert.equal(copyFile(cfg, 'cc-one', 'a', 'a-copy', session).ok, true);
  assert.equal(readFileSync(path.join(work, 'a-copy/b/new.txt'), 'utf8'), 'hello');

  assert.equal(deleteFile(cfg, 'cc-one', 'a-copy', session).ok, true);
  assert.equal(existsSync(path.join(work, 'a-copy')), false);

  const root = deleteFile(cfg, 'cc-one', '.', session);
  assert.equal(root.ok, false);
  assert.match(root.text, /forget/);
  assert.equal(existsSync(work), true);
});

test('a binary or oversized file is refused rather than dumped', () => {
  const { work, cfg, session } = box();
  writeFileSync(path.join(work, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  writeFileSync(path.join(work, 'big.log'), 'x'.repeat(256 * 1024 + 1));
  assert.match(readFile(cfg, 'cc-one', 'shot.png', session).text, /not text/);
  assert.match(readFile(cfg, 'cc-one', 'big.log', session).text, /at most/);
});
