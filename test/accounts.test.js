// Whose Claude account a session runs on.
//
// docs/one-account-per-person.md: THE BOX HAS NO CLAUDE ACCOUNT. A session runs
// on the account of whoever started it, and a local surface — Telegram, the
// CLI, the web UI — runs as the operator, which is a named person rather than
// the machine. The selection is the feature and podman is not, which is why
// pickCredentialSource is exported.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRequire } from 'node:module';

import { Accounts, normaliseEmail, emailFromActor, extractOauthAccount, adoptBoxAccount } from '../src/core/accounts.js';
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

test('a linked person gets their account, and nobody gets the box\'s', () => {
  // THE BOX HAS NO CLAUDE ACCOUNT ANY MORE — docs/one-account-per-person.md.
  // This used to fall back to the machine's own credential for anyone who had
  // not linked, which quietly shared one person's Claude subscription with
  // everybody who could reach the fleet. True of an org and false of a guest,
  // and the standing rule for guests is that they bring their own everything.
  const stateDir = dir();
  const a = new Accounts(stateDir);
  a.save('client@example.com', JSON.stringify({ token: 'theirs' }));
  const cfg = { stateDir, sandboxCredentialsFile: '/shared/.credentials.json' };

  const linked = pickCredentialSource(cfg, 'fleet:client@example.com');
  assert.equal(linked.account, 'client@example.com');
  assert.match(linked.source, /client@example\.com\.json$/);

  // Somebody who has NOT linked gets a refusal with their name in it, rather
  // than somebody else's subscription.
  const stranger = pickCredentialSource(cfg, 'fleet:owner@example.com');
  assert.equal(stranger.source, null);
  assert.match(String(stranger.why), /has not linked/);

  // A local surface runs as THE OPERATOR — here unambiguous, because exactly
  // one person has linked an account on this box.
  for (const actor of ['telegram:12345', 'web', null]) {
    const picked = pickCredentialSource(cfg, actor);
    assert.equal(picked.account, 'client@example.com', String(actor));
  }
});

test('a box where nobody has linked refuses, and says how to fix it', () => {
  // Not silence, and not the machine's account. Every version of this refusal
  // is something one person can fix in one step.
  const picked = pickCredentialSource({ stateDir: dir(), sandboxCredentialsFile: '' }, 'telegram:1');
  assert.equal(picked.source, null);
  assert.match(String(picked.why), /nobody has linked/);
});

test('two linked accounts is a question, not a guess', () => {
  const stateDir = dir();
  const a = new Accounts(stateDir);
  a.save('one@example.com', JSON.stringify({ token: '1' }));
  a.save('two@example.com', JSON.stringify({ token: '2' }));

  const picked = pickCredentialSource({ stateDir, sandboxCredentialsFile: '' }, 'cli');
  assert.equal(picked.source, null);
  assert.match(String(picked.why), /AGENT_HUB_OPERATOR/);

  // And naming one settles it.
  const named = pickCredentialSource({ stateDir, operator: 'two@example.com', sandboxCredentialsFile: '' }, 'cli');
  assert.equal(named.account, 'two@example.com');
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

test("the box's own account is adopted by the person it belongs to", (t) => {
  // MIGRATION, AND IT HAS TO BE SILENT. A host running today has a working
  // ~/.claude/.credentials.json and may have no linked accounts at all.
  // Removing the fallback without this breaks it on update, which is the worst
  // version of a simplification.
  //
  // The credential does not move and does not change — it acquires an owner.
  const stateDir = dir();
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  const cred = join(home, '.claude', '.credentials.json');
  writeFileSync(cred, JSON.stringify({ claudeAiOauth: { accessToken: 'theboxs' } }));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'Owner@Example.com', organizationName: 'Example' },
  }));
  const cfg = /** @type {any} */ ({ stateDir, sandboxCredentialsFile: cred });

  const first = adoptBoxAccount(cfg);

  assert.equal(first.adopted, 'owner@example.com', 'normalised, like every other email here');
  assert.deepEqual(new Accounts(stateDir).list(), ['owner@example.com']);
  // The identity travels with it, which is the pair a sandbox needs — a
  // credential without its oauthAccount is a login that fails while every file
  // involved is genuine.
  assert.ok(existsSync(new Accounts(stateDir).accountMetaPathFor('owner@example.com')));
  // And a session started by anybody on this box now resolves to that person.
  assert.equal(pickCredentialSource(cfg, 'telegram:1').account, 'owner@example.com');
});

test('adoption never overwrites an account somebody already linked', (t) => {
  // The box's copy is by then the OLDER one. Adopting it again would hand a
  // session a credential its owner has already replaced — and would do it
  // silently, on every restart.
  const stateDir = dir();
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  const cred = join(home, '.claude', '.credentials.json');
  writeFileSync(cred, JSON.stringify({ claudeAiOauth: { accessToken: 'stale' } }));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'owner@example.com' } }));
  new Accounts(stateDir).save('owner@example.com', JSON.stringify({ claudeAiOauth: { accessToken: 'current' } }));

  const again = adoptBoxAccount(/** @type {any} */ ({ stateDir, sandboxCredentialsFile: cred }));

  assert.equal(again.adopted, null);
  assert.match(again.why, /already has a linked account/);
  assert.match(new Accounts(stateDir).read('owner@example.com') || '', /current/);
});

test('a box with no credential of its own adopts nothing and says so', () => {
  const r = adoptBoxAccount(/** @type {any} */ ({ stateDir: dir(), sandboxCredentialsFile: '/nowhere' }));
  assert.equal(r.adopted, null);
  assert.match(r.why, /no Claude credential of its own/);
});

test('no message still promises a shared account to fall back to', () => {
  // THE PROSE OUTLIVED THE MODEL, reported from a phone as a sequence:
  // unlinking said "sessions they start now use the shared account", a healthy
  // host showed "NOT signed in — sessions will not start" in red, and `/verify`
  // said "Run /login to authenticate this box". Three sentences describing a
  // box account that no longer exists, on three different screens.
  //
  // Every one of them was true when written. That is the whole difficulty: a
  // model change does not fail a test, it just leaves the words behind.
  const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const code = (/** @type {string} */ src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const surfaces = {
    'the unlink reply': 'src/adapters/commands.js',
    'the auth summary': 'src/core/login.js',
    'the iOS fleet list': 'apps/ios/Fleetwright/FleetView.swift',
    'the Android fleet list': 'apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt',
  };
  for (const [what, file] of Object.entries(surfaces)) {
    const src = code(read(file));
    assert.ok(!/use the shared account/.test(src), `${what} still promises a shared account`);
    assert.ok(!/authenticate this box/.test(src), `${what} still tells somebody to log the box in`);
    assert.ok(!/NOT signed in/.test(src), `${what} still reports a box as signed out`);
  }
});

test('a host reports how many people can start a session on it', () => {
  // The number that replaced the boolean. Both apps read it, and both treat
  // absent as an older host rather than as a fault — the distinction this
  // codebase keeps having to restate.
  const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  for (const [name, file] of [
    ['iOS', 'apps/ios/Fleetwright/FleetView.swift'],
    ['Android', 'apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt'],
  ]) {
    const src = read(file);
    assert.match(src, /claudeAccounts/, `${name} does not read the count`);
    assert.match(src, /Nobody has connected a Claude account here/, `${name} does not name the real fault`);
  }
});

test('a refusal names the machine, because Claude is linked per machine', () => {
  // GUEST ONBOARDING, and the smallest piece of it. "Connect one under Your
  // credentials in the app" is an instruction somebody can follow completely
  // and still be stuck: they connect on whichever host they happened to open,
  // and the scheduler puts the next session on the other one.
  //
  // It also named a screen that could not do it — iOS filtered Claude out of
  // that view, and Android has no such view at all. A remedy pointing at a
  // surface that cannot perform it is worse than one that only says what is
  // needed.
  const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  for (const file of ['src/core/podman.js', 'src/adapters/commands.js']) {
    const src = read(file);
    assert.ok(!/under Your credentials/.test(src), `${file} still names a screen`);
    assert.match(src, /cfg\.hostname|ctx\.cfg\.hostname/, `${file} does not name the machine`);
  }
});
