// The named-secret store and its decision, tested apart from the socket.
//
// Two things must hold and are easy to get wrong: the store read cannot escape
// its directory, and the DECISION is made by the grant rather than the ask — a
// session may read exactly what `start --secret` gave it and cannot use the
// request to discover what else exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readNamedSecret, answerSecretRequest, listSecretNames } from '../src/core/secret-store.js';

function store() {
  const dir = mkdtempSync(path.join(tmpdir(), 'secrets-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('readNamedSecret returns the value and strips one trailing newline', (t) => {
  const s = store();
  t.after(s.cleanup);
  writeFileSync(path.join(s.dir, 'echoed'), 'ghp_token\n');
  writeFileSync(path.join(s.dir, 'printfed'), 'ghp_token');
  writeFileSync(path.join(s.dir, 'multiline'), 'line1\nline2\n');

  assert.equal(readNamedSecret(s.dir, 'echoed'), 'ghp_token', 'echo > file and printf > file store the same secret');
  assert.equal(readNamedSecret(s.dir, 'printfed'), 'ghp_token');
  assert.equal(readNamedSecret(s.dir, 'multiline'), 'line1\nline2', 'only the last newline is stripped');
});

test('readNamedSecret is null for a missing secret and cannot escape the store', (t) => {
  const s = store();
  t.after(s.cleanup);
  writeFileSync(path.join(s.dir, 'real'), 'v');
  // A secret file planted one level up must be unreachable by name.
  writeFileSync(path.join(s.dir, '..', 'outside'), 'do-not-read');
  t.after(() => rmSync(path.join(s.dir, '..', 'outside'), { force: true }));

  assert.equal(readNamedSecret(s.dir, 'absent'), null, 'missing is null, not a throw');
  for (const bad of ['../outside', '../../etc/passwd', 'a/b', '.', '..', 'has space', '']) {
    assert.equal(readNamedSecret(s.dir, bad), null, `${JSON.stringify(bad)} must not resolve to a value`);
  }
});

test('a directory in the store reads as absent, not as a value', (t) => {
  const s = store();
  t.after(s.cleanup);
  mkdirSync(path.join(s.dir, 'adir'));
  assert.equal(readNamedSecret(s.dir, 'adir'), null);
});

test('answerSecretRequest: the grant decides, not the ask', () => {
  const read = (n) => (n === 'github-deploy' ? 'the-value' : null);

  // Granted and present: served.
  assert.deepEqual(
    answerSecretRequest({ requested: 'github-deploy', granted: 'github-deploy', read }),
    { ok: true, name: 'github-deploy', value: 'the-value' },
  );

  // Not started with --secret at all.
  assert.deepEqual(
    answerSecretRequest({ requested: 'github-deploy', granted: null, read }),
    { ok: false, error: 'not_granted' },
  );

  // Started with a DIFFERENT secret — the ask cannot widen the grant, and the
  // store is never even consulted, so a session cannot probe what exists.
  let reads = 0;
  const counting = (n) => { reads++; return read(n); };
  assert.deepEqual(
    answerSecretRequest({ requested: 'github-deploy', granted: 'npm-publish', read: counting }),
    { ok: false, error: 'not_granted' },
  );
  assert.equal(reads, 0, 'a name it was not granted never touches the store');

  // Granted but this box does not hold it — a distinct, actionable fact.
  assert.deepEqual(
    answerSecretRequest({ requested: 'npm-publish', granted: 'npm-publish', read }),
    { ok: false, error: 'no_secret' },
  );

  // No name asked for.
  assert.deepEqual(answerSecretRequest({ requested: '', granted: 'x', read }), { ok: false, error: 'no_name' });
});

test('answerSecretRequest accepts a grant of several names, for later', () => {
  const read = (n) => ({ a: '1', b: '2' })[n] ?? null;
  assert.deepEqual(answerSecretRequest({ requested: 'b', granted: ['a', 'b'], read }), { ok: true, name: 'b', value: '2' });
  assert.deepEqual(answerSecretRequest({ requested: 'c', granted: ['a', 'b'], read }), { ok: false, error: 'not_granted' });
});

test('listSecretNames returns names only, sorted, files only', (t) => {
  const s = store();
  t.after(s.cleanup);
  writeFileSync(path.join(s.dir, 'npm-publish'), 'v1');
  writeFileSync(path.join(s.dir, 'github-deploy'), 'v2');
  writeFileSync(path.join(s.dir, 'README.md'), 'a note'); // dotted → not a name
  writeFileSync(path.join(s.dir, '.hidden'), 'x'); // dotfile → not a name
  mkdirSync(path.join(s.dir, 'adir')); // a directory is not a secret

  assert.deepEqual(listSecretNames(s.dir), ['github-deploy', 'npm-publish']);
});

test('listSecretNames on a box with no store is empty, not an error', () => {
  assert.deepEqual(listSecretNames('/does/not/exist/anywhere'), []);
});
