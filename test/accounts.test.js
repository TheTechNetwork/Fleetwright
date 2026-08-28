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

import { createRequire } from 'node:module';

import { Accounts, normaliseEmail, emailFromActor, extractOauthAccount } from '../src/core/accounts.js';
import { pickCredentialSource, sharedAccountMetaFile } from '../src/core/podman.js';

const require = createRequire(import.meta.url);

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

test('the identity travels with the credential', () => {
  const stateDir = dir();
  const a = new Accounts(stateDir);
  a.save('client@example.com', JSON.stringify({ token: 'x' }), JSON.stringify({ emailAddress: 'client@example.com' }));
  assert.ok(a.accountMetaPathFor('client@example.com'), 'the account fragment is stored beside the credential');

  const picked = pickCredentialSource({ stateDir, sandboxCredentialsFile: '/shared/.credentials.json' }, 'fleet:client@example.com');
  assert.match(picked.accountMeta, /client@example\.com\.account\.json$/);

  a.remove('client@example.com');
  assert.equal(a.accountMetaPathFor('client@example.com'), null, 'unlink removes both files');
  assert.deepEqual(a.list(), []);
});

test('extractOauthAccount takes the block and nothing else', () => {
  assert.equal(JSON.parse(extractOauthAccount(JSON.stringify({ oauthAccount: { a: 1 }, junk: 2 }))).a, 1);
  for (const bad of ['not json', '{}', JSON.stringify({ oauthAccount: null }), JSON.stringify({ oauthAccount: [1] })]) {
    assert.equal(extractOauthAccount(bad), null, bad.slice(0, 20));
  }
});

test('the shared identity is derived from the shared credential\'s home', () => {
  // ~/.claude/.credentials.json implies ~/.claude.json one directory up.
  // Absent, unreadable, or missing the block all degrade to seeding without
  // it — exactly the old behaviour, never an error.
  const home = dir();
  const { mkdirSync, writeFileSync } = require('node:fs');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const cfg = { stateDir: dir(), sandboxCredentialsFile: join(home, '.claude', '.credentials.json') };

  assert.equal(sharedAccountMetaFile(cfg), null, 'no state file yet');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'org@example.com' } }));
  const file = sharedAccountMetaFile(cfg);
  assert.ok(file, 'extracted once the state file exists');
  const { readFileSync } = require('node:fs');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).emailAddress, 'org@example.com');
});
