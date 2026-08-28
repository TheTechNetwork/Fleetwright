// Whose Claude account a session runs on.
//
// docs/accounts.md: the shared org credential is the default; a person who has
// linked their own gets theirs. The selection is the feature and podman is
// not, which is why pickCredentialSource is exported.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Accounts, normaliseEmail, emailFromActor } from '../src/core/accounts.js';
import { pickCredentialSource } from '../src/core/podman.js';

const dir = () => mkdtempSync(join(tmpdir(), 'accounts-'));

test('emails normalise, and non-emails are refused', () => {
  assert.equal(normaliseEmail('  Client@Example.COM '), 'client@example.com');
  for (const bad of ['', 'not-an-email', 'a@b', 'telegram:123', null, 42, 'a b@c.com']) {
    assert.equal(normaliseEmail(bad), null, JSON.stringify(bad));
  }
});

test('only fleet actors carry an identity', () => {
  assert.equal(emailFromActor('fleet:client@example.com'), 'client@example.com');
  assert.equal(emailFromActor('fleet:Client@Example.com'), 'client@example.com');
  for (const other of ['telegram:12345', 'web', 'cli', null, '', 'fleet:', 'fleet:notanemail']) {
    assert.equal(emailFromActor(other), null, JSON.stringify(other));
  }
});

test('save, list, read, remove', () => {
  const a = new Accounts(dir());
  const saved = a.save('Client@Example.com', JSON.stringify({ token: 'x' }));
  assert.equal(saved.ok, true);
  assert.deepEqual(a.list(), ['client@example.com']);
  assert.equal(JSON.parse(a.read('client@example.com')).token, 'x');
  assert.equal(a.remove('client@example.com'), true);
  assert.deepEqual(a.list(), []);
});

test('garbage is refused before it becomes a credential file', () => {
  const a = new Accounts(dir());
  assert.equal(a.save('x@example.com', 'not json').ok, false);
  assert.equal(a.save('x@example.com', '[]').ok, false);
  assert.equal(a.save('x@example.com', '{}').ok, false);
  assert.equal(a.save('not-an-email', '{"t":1}').ok, false);
  assert.deepEqual(a.list(), []);
});

test('a linked person gets their account, everyone else the shared one', () => {
  const stateDir = dir();
  const a = new Accounts(stateDir);
  a.save('client@example.com', JSON.stringify({ token: 'theirs' }));
  const cfg = { stateDir, sandboxCredentialsFile: '/shared/.credentials.json' };

  const linked = pickCredentialSource(cfg, 'fleet:client@example.com');
  assert.equal(linked.account, 'client@example.com');
  assert.match(linked.source, /client@example\.com\.json$/);

  for (const actor of ['fleet:owner@example.com', 'telegram:12345', 'web', null]) {
    const picked = pickCredentialSource(cfg, actor);
    assert.equal(picked.account, 'shared', String(actor));
    assert.equal(picked.source, '/shared/.credentials.json');
  }
});

test('no shared credential configured means none seeded, exactly as before', () => {
  const picked = pickCredentialSource({ stateDir: dir(), sandboxCredentialsFile: '' }, 'telegram:1');
  assert.equal(picked.source, null);
});
