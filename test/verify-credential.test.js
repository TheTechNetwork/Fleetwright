// Testing a credential that is already stored.
//
// "Connected" is a fact about storage, not about the token. It can be revoked,
// expire, or have its permissions narrowed at the provider long after it was
// stored — and nothing here would know until a session failed four hours in.
//
// Asked for as: "a test credential button which would test and check if it has
// recommended scopes or whatever with view detail buttons for which scope it
// has."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connections, PROVIDERS } from '../src/core/connectors.js';
import { HOST_ROW } from '../src/core/accounts.js';
import { validateIntent, PROTOCOL_VERSION, isMutating } from '../src/fleet/protocol/intents.js';
import { toCommandLine } from '../src/fleet/host/sidecar.js';

const dir = () => mkdtempSync(join(tmpdir(), 'verify-'));
const intent = (params) => ({
  v: PROTOCOL_VERSION, kind: 'intent', id: 'abcd1234', verb: 'verify', params, issuedAt: Date.now(),
});

test('checking is read-only, so asking twice asks twice', () => {
  // Not mutating: an idempotency key would make a second "Test" return the
  // first answer, which is the opposite of what a test button means.
  assert.equal(isMutating('verify'), false);
  assert.equal(validateIntent(intent({ provider: 'github' })).ok, true);
  assert.equal(validateIntent(intent({})).ok, false);
  assert.equal(toCommandLine({ verb: 'verify', params: { provider: 'github' } }), '/verify github');
});

test('it checks the STORED token, not one somebody just typed', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });

  const store = new Connections(dir());
  // Nothing stored is its own answer, and not an error about the provider.
  assert.match((await store.check(HOST_ROW, 'github')).message, /No GitHub token is stored/);

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ login: 'octocat' }), {
      status: 200,
      headers: { 'x-oauth-scopes': 'repo, workflow' },
    });
  store.save(HOST_ROW, 'github', 'ghp_x', 'octocat', ['repo', 'workflow']);

  const r = await store.check(HOST_ROW, 'github');
  assert.equal(r.ok, true);
  assert.equal(r.account, 'octocat');
  assert.deepEqual(r.granted, ['repo', 'workflow'], 'what it HAS, for the detail view');
  assert.deepEqual(r.wants, PROVIDERS.github.wants, 'and what is asked for, to compare against');
  assert.deepEqual(r.missing, ['read:org', 'gist', 'read:packages', 'admin:repo_hook']);
});

test('a revoked token reports as revoked, not as missing scopes', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const store = new Connections(dir());
  store.save(HOST_ROW, 'github', 'ghp_x', 'octocat', ['repo']);

  globalThis.fetch = async () => new Response('{}', { status: 401 });
  const r = await store.check(HOST_ROW, 'github');
  assert.equal(r.ok, false);
  assert.match(r.message, /rejected that token/);
  // The whole point: this is the state that used to be invisible until a
  // session failed.
});

test('“cannot tell” survives the round trip', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const store = new Connections(dir());
  store.save(HOST_ROW, 'cloudflare', 'cf_x', null);

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: true, result: { status: 'active', id: 'abcdef12' } }), { status: 200 });
  const r = await store.check(HOST_ROW, 'cloudflare');
  assert.equal(r.ok, true);
  // Cloudflare will not say what a token was granted with the permissions this
  // asks for, so `granted` is null — which the apps must render as "does not
  // report", never as "no scopes".
  assert.equal(r.granted, null);
  assert.equal(r.missing, null);
});

test('both apps offer the test and can show the detail', () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  for (const [name, view] of [
    ['iOS', 'apps/ios/Fleetwright/Credentials.swift'],
    ['Android', 'apps/android/app/src/main/java/network/thetech/fleetwright/CredentialsSheet.kt'],
  ]) {
    const src = read(view);
    assert.match(src, /"Test"/, `${name} has no test button`);
    assert.match(src, /Has: /, `${name} cannot show which scopes it has`);
    assert.match(src, /Asked for and not granted/, `${name} does not name what is absent`);
    // And the third state, which is neither of the other two.
    assert.match(src, /does not report what a token was granted/, `${name} renders "cannot tell" as something else`);
  }
});
