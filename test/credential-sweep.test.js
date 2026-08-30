// Clearing out credential material this box will never use again.
//
//   node --test test/
//
// CODE THAT STOPS READING A FIELD DOES NOT REMOVE THE FIELD. The release that
// moved the GitHub client secret onto the config frame left a copy of the
// FLEET-WIDE secret in `<row>.renewal.json` on every box that had ever
// connected GitHub, once per member. Nothing reads it now, which does not make
// it harmless: a credential nobody reads is a credential nobody is watching,
// and it is still valid, still fleet-wide, and in every backup taken since.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connections } from '../src/core/connectors.js';
import { HOST_ROW } from '../src/core/accounts.js';

const GH = 'ghu_accesstoken00000000000000000000';
const REFRESH = 'ghr_refresh0000000000000000000000';
const SECRET = 'clientsecret000000000000000000000000';
const CLIENT_ID = 'Iv23liTEST';

/** @param {import('node:test').TestContext} t */
function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new Connections(dir) };
}

/** A renewal file in the shape the previous release wrote. @param {Connections} s */
function legacyRenewal(s, extra = {}) {
  const file = /** @type {string} */ (s.renewalPathFor(HOST_ROW));
  writeFileSync(file, JSON.stringify({
    github: { clientId: CLIENT_ID, refresh: REFRESH, client: SECRET, updatedAt: Date.now(), ...extra },
  }, null, 2), { mode: 0o600 });
  return file;
}

test('the stranded client secret is removed and the record still works', (t) => {
  const s = store(t);
  s.store.save(HOST_ROW, 'github', GH, 'octocat', null);
  const file = legacyRenewal(s.store);

  const swept = s.store.sweep();

  assert.equal(swept.scrubbed.length, 1);
  const raw = readFileSync(file, 'utf8');
  assert.equal(raw.includes(SECRET), false, 'the fleet-wide secret is still on disk');
  assert.ok(raw.includes(REFRESH), 'and the refresh token, which is useless alone, was kept');
  // Still renewable — scrubbing a field nothing reads must not cost the
  // connection.
  assert.deepEqual(s.store.readRenewal(HOST_ROW, 'github'), { clientId: CLIENT_ID, refresh: REFRESH });
  assert.deepEqual(swept.reconnect, [], 'nothing to tell anybody about');
});

test('a record that cannot renew anything is dropped, and the person is told', (t) => {
  // The case that matters to a human. The token still WORKS — for up to eight
  // hours — and then stops. "It worked yesterday" with nothing on any screen is
  // the worst version of this, so the flag is set while it is still working.
  const s = store(t);
  s.store.save(HOST_ROW, 'github', GH, 'octocat', null);
  const file = /** @type {string} */ (s.store.renewalPathFor(HOST_ROW));
  writeFileSync(file, JSON.stringify({ github: { client: SECRET, updatedAt: Date.now() } }), { mode: 0o600 });

  const swept = s.store.sweep();

  assert.equal(swept.dropped.length, 1);
  assert.equal(swept.reconnect.length, 1);
  assert.equal(s.store.list(HOST_ROW).find((c) => c.provider === 'github')?.needsReconnect, true);
  assert.equal(existsSync(file), false, 'an empty renewal file is removed rather than left as litter');
});

test('reconnecting clears the warning', (t) => {
  // A warning that outlives its cause is one people learn to ignore.
  const s = store(t);
  s.store.save(HOST_ROW, 'github', GH, 'octocat', null);
  writeFileSync(/** @type {string} */ (s.store.renewalPathFor(HOST_ROW)),
    JSON.stringify({ github: { client: SECRET } }), { mode: 0o600 });
  s.store.sweep();
  assert.equal(s.store.list(HOST_ROW)[0].needsReconnect, true);

  s.store.save(HOST_ROW, 'github', 'ghu_fresh000000000000000000000000', 'octocat', null);

  assert.equal(s.store.list(HOST_ROW)[0].needsReconnect, false);
});

test('nothing connected means nothing to warn about', (t) => {
  // A renewal record with no matching connection is litter, not a problem
  // somebody has to act on — telling them to reconnect something they do not
  // have is the kind of alarm that teaches people to ignore alarms.
  const s = store(t);
  mkdirSync(join(s.dir, 'accounts'), { recursive: true, mode: 0o700 });
  writeFileSync(/** @type {string} */ (s.store.renewalPathFor(HOST_ROW)),
    JSON.stringify({ github: { client: SECRET } }), { mode: 0o600 });

  const swept = s.store.sweep();

  assert.equal(swept.dropped.length, 1);
  assert.deepEqual(swept.reconnect, []);
});

test('a sweep of a clean box changes nothing and says nothing', (t) => {
  const s = store(t);
  s.store.save(HOST_ROW, 'github', GH, 'octocat', null);
  s.store.saveRenewal(HOST_ROW, 'github', { clientId: CLIENT_ID, refresh: REFRESH });

  const swept = s.store.sweep();

  assert.deepEqual(swept, { scrubbed: [], dropped: [], reconnect: [] });
  assert.deepEqual(s.store.readRenewal(HOST_ROW, 'github'), { clientId: CLIENT_ID, refresh: REFRESH });
});

test('a box with no credentials at all sweeps cleanly', (t) => {
  assert.deepEqual(store(t).store.sweep(), { scrubbed: [], dropped: [], reconnect: [] });
});

test('both apps say what to do about it, not what we deleted', () => {
  // Somebody reading this has a connection that works right now and stops
  // within the day. The sentence has to be about them.
  const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  for (const [name, src] of [
    ['iOS', read('apps/ios/Fleetwright/Credentials.swift')],
    ['Android', read('apps/android/app/src/main/java/network/thetech/fleetwright/CredentialsSheet.kt')],
  ]) {
    assert.match(src, /needsReconnect/, `${name} does not read the flag`);
    assert.match(src, /still works/, `${name} does not say the token still works, which is why it is confusing`);
    assert.match(src, /eight hours/, `${name} does not say when it stops`);
    assert.match(src, /nothing to copy or paste/i, `${name} does not say how small the fix is`);
  }
});
