// The workspace, against a real container engine.
//
// test/files.test.js checks the half that decides whether a container starts.
// This checks what happens inside one — which is where the confinement actually
// lives, and which was asserted by reading the source because CI had no engine.
//
// IT HAS ONE. CI has Docker, and `AGENT_HUB_PODMAN_BIN` has always been
// configurable; the only thing in the way was three podman-only subcommands
// (`volume exists`, `image exists`, `container exists`). Those are `inspect`
// now, which both engines have and both answer the same way. So this runs
// unchanged under either.
//
// THIS DOES NOT MOVE THE FLEET TO DOCKER. docs/hardening.md is built on rootless
// podman — NoNewPrivileges against setuid newuidmap, ProtectHome against
// ~/.local/share/containers, a refusal list including --userns=host. Docker's
// default is a root daemon, where "escaped the container" and "root on the box"
// are the same sentence. This is a test running somewhere else, not a change of
// engine.
//
// Skipped when no engine is present, and the skip is LOUD in the output rather
// than a silent pass — a test that quietly does nothing is the manufactured
// confidence this repository keeps finding.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { listFiles, readFile, writeFile, copyFile, deleteFile } from '../src/core/files.js';

const BIN = process.env.AGENT_HUB_PODMAN_BIN || 'podman';
const HAVE_ENGINE = spawnSync(BIN, ['--version'], { encoding: 'utf8' }).status === 0;
// debian:13-slim is what sandbox/Containerfile is built from, and the scripts
// use GNU find's -printf and realpath. Any image with coreutils will do; this
// one is small and is what production runs.
const IMAGE = process.env.AGENT_HUB_SANDBOX_IMAGE || 'debian:13-slim';

const skip = HAVE_ENGINE ? false : `no container engine (${BIN} not runnable) — set AGENT_HUB_PODMAN_BIN`;

/** A session name unique to this run, so a rerun never inherits a volume. */
const NAME = `filetest-${process.pid}`;
const VOLUME = `work-${NAME}`;
const cfg = /** @type {any} */ ({ podmanBin: BIN, sandboxImage: IMAGE });

/** @param {string[]} args */
const engine = (args) => spawnSync(BIN, args, { encoding: 'utf8' });

test('the workspace, inside a real container', { skip }, async (t) => {
  engine(['volume', 'create', VOLUME]);
  t.after(() => engine(['volume', 'rm', '-f', VOLUME]));

  // Seed a tree, including the two things the confinement is about: a file
  // outside the workspace to reach for, and a symlink pointing at it.
  const seed = `
mkdir -p /work/src /work/empty
printf 'hello\\nworld\\n' > /work/src/a.txt
printf 'top\\n' > /work/README.md
# A DETERMINISTIC BINARY, not 300 bytes of /dev/urandom.
# Random bytes contain no NUL about 31% of the time -- (255/256)^300 -- so the
# "refuses binary" test passed here and failed in CI, which is a flaky test
# dressed as an engine difference. This is a PNG header: NULs by construction.
printf 'PNG\\r\\n\\032\\n\\000\\000\\000\\rIHDR\\000\\000\\001\\000' > /work/blob.bin
ln -s /etc/passwd /work/escape
ln -s /etc /work/etcdir
`;
  const seeded = engine(['run', '--rm', '-v', `${VOLUME}:/work`, IMAGE, 'sh', '-c', seed]);
  assert.equal(seeded.status, 0, `seeding failed: ${seeded.stderr}`);

  await t.test('lists one directory, not a tree', () => {
    const r = listFiles(cfg, NAME, '.');
    assert.equal(r.ok, true, r.text);
    const names = r.entries.map((e) => e.name).sort();
    // "(empty)" used to answer "no files", "no workspace" and "failed" alike.
    assert.equal(/^\(empty\)$/.test(r.text), false, 'the ambiguous shrug is back');
    assert.deepEqual(names, ['README.md', 'blob.bin', 'empty', 'escape', 'etcdir', 'src']);
    // src is a directory and README.md is not, and the caller can tell.
    assert.equal(r.entries.find((e) => e.name === 'src').kind, 'dir');
    assert.equal(r.entries.find((e) => e.name === 'README.md').kind, 'file');
    // One level: a.txt is inside src and must not appear here.
    assert.equal(names.includes('a.txt'), false);
  });

  await t.test('reads a text file exactly', () => {
    const r = readFile(cfg, NAME, 'src/a.txt');
    assert.equal(r.ok, true, r.text);
    assert.equal(r.text, 'hello\nworld\n');
  });

  await t.test('refuses a binary file rather than dumping it', () => {
    const r = readFile(cfg, NAME, 'blob.bin');
    assert.equal(r.ok, false);
    assert.match(r.text, /not text/);
  });

  // --- the part this test exists for ---------------------------------------

  await t.test('a symlink out of the workspace is refused', () => {
    // THE CASE TEXTUAL VALIDATION CANNOT SEE. `escape` has no ".." in it and is
    // not absolute, so checkPath accepts it; realpath inside the container is
    // what notices it lands on /etc/passwd.
    const r = readFile(cfg, NAME, 'escape');
    assert.equal(r.ok, false);
    assert.equal(/root:x:0:0/.test(r.text), false, 'it read /etc/passwd');
    assert.match(r.text, /leaves the workspace/);
  });

  await t.test('a directory symlink cannot be listed either', () => {
    const r = listFiles(cfg, NAME, 'etcdir');
    assert.equal(r.ok, false);
    assert.equal(/passwd/.test(r.text), false);
  });

  await t.test('traversal is refused even when it would resolve', () => {
    for (const bad of ['../etc/passwd', 'src/../../etc/passwd', '/etc/passwd']) {
      const r = readFile(cfg, NAME, bad);
      assert.equal(r.ok, false, `${bad} was read`);
      assert.equal(/root:x:0:0/.test(r.text), false, `${bad} returned /etc/passwd`);
    }
  });

  // --- writing --------------------------------------------------------------

  await t.test('writes a file verbatim, creating directories', () => {
    const body = 'def f():\n\n    return 1\n';
    const w = writeFile(cfg, NAME, 'deep/new/f.py', body);
    assert.equal(w.ok, true, w.text);
    // Read it back through the read path: indentation and blank line intact.
    const r = readFile(cfg, NAME, 'deep/new/f.py');
    assert.equal(r.text, body);
  });

  await t.test('a filename that looks like a command is a filename', () => {
    // The path is an argument, never interpolated. If it were, this would run.
    const name = 'weird; touch PWNED.txt';
    const w = writeFile(cfg, NAME, name, 'harmless');
    assert.equal(w.ok, true, w.text);
    const listed = listFiles(cfg, NAME, '.').entries.map((e) => e.name);
    assert.equal(listed.includes('PWNED.txt'), false, 'the path was executed as shell');
    assert.ok(listed.includes(name), 'the file was not created under its real name');
  });

  await t.test('a write cannot land outside the workspace', () => {
    const w = writeFile(cfg, NAME, '../escaped.txt', 'nope');
    assert.equal(w.ok, false);
  });

  await t.test('copies within the workspace and refuses to copy out', () => {
    assert.equal(copyFile(cfg, NAME, 'README.md', 'src/README.copy').ok, true);
    assert.equal(readFile(cfg, NAME, 'src/README.copy').text, 'top\n');
    assert.equal(copyFile(cfg, NAME, 'README.md', '../out.md').ok, false);
  });

  await t.test('deletes, but never the workspace itself', () => {
    assert.equal(deleteFile(cfg, NAME, 'src/README.copy').ok, true);
    assert.equal(readFile(cfg, NAME, 'src/README.copy').ok, false);

    // `forget` is the recoverable one and takes the whole workspace; this is
    // not recoverable at all, so it refuses the root.
    const root = deleteFile(cfg, NAME, '.');
    assert.equal(root.ok, false);
    assert.match(root.text, /forget/);
    // And the workspace is still there.
    assert.equal(listFiles(cfg, NAME, '.').ok, true);
  });

  await t.test('an empty directory says it is empty, not just "(empty)"', () => {
    const r = listFiles(cfg, NAME, 'empty');
    assert.equal(r.ok, true, r.text);
    assert.match(r.text, /exists and has nothing in it/);
    // And that is a different sentence from the one a missing workspace gets,
    // which is the whole point — three situations, three answers.
    const missing = listFiles(cfg, `${NAME}-nonexistent`, '.');
    assert.equal(missing.ok, false);
    assert.notEqual(missing.text, r.text);
  });

  await t.test('a missing session says so rather than inventing a path', () => {
    const r = listFiles(cfg, `${NAME}-nonexistent`, '.');
    assert.equal(r.ok, false);
    assert.match(r.text, /workspace|no such/i);
  });
});
