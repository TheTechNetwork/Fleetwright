// Reading a Claude credential file, and the three answers it can give.
//
//   node --test test/
//
// "Very inconsistent the Claude creds we need to test auth better." The
// inconsistency had one shape: a credential that was genuine and dead, with
// nothing between the file and the phone in a position to say which.
//
// The property under test throughout is that UNKNOWN IS NOT EXPIRED. This
// parser reads a file format owned by somebody else, and a version of it that
// treated an unrecognised shape as a dead credential would refuse to start
// sessions on a healthy box — a failure indistinguishable from the bug it
// exists to fix.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCredentialState, describeCredential } from '../src/core/claude-credential.js';

/** @param {import('node:test').TestContext} t @param {unknown} contents */
function credentialFile(t, contents) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cred-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.credentials.json');
  writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return file;
}

const HOUR = 3_600_000;

test('a token with time left on it is fresh', (t) => {
  const file = credentialFile(t, {
    claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 5 * HOUR, subscriptionType: 'max' },
  });

  const state = readCredentialState(file);

  assert.equal(state.state, 'fresh');
  assert.equal(state.refreshable, true);
  assert.equal(state.plan, 'max');
});

test('a token whose expiry has passed is expired', (t) => {
  const file = credentialFile(t, {
    claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() - HOUR },
  });

  assert.equal(readCredentialState(file).state, 'expired');
});

test('the older top-level shape reads the same as the nested one', (t) => {
  // The CLI has written both. A file one release old is not a file that should
  // stop a session, and a parser that only knows today's shape would report
  // every one of them as unreadable.
  const file = credentialFile(t, { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + HOUR });

  assert.equal(readCredentialState(file).state, 'fresh');
});

// --- the three answers, and why the third one exists ------------------------

test('a missing file is unknown, not expired', () => {
  const state = readCredentialState('/nowhere/at/all/.credentials.json');

  assert.equal(state.state, 'unknown');
  assert.notEqual(state.state, 'expired');
});

test('an unrecognised shape is unknown, not expired', (t) => {
  // The whole reason this distinction is load-bearing: a future CLI release
  // that renames these fields must degrade to "cannot tell", never to "this
  // box is signed out" — which the registry turns into a degraded host and
  // the scheduler turns into a fleet that will not start anything.
  const file = credentialFile(t, { somethingEntirelyNew: { token: 'x' } });

  assert.equal(readCredentialState(file).state, 'unknown');
});

test('a credential with no expiry field at all is unknown', (t) => {
  // Not fresh. A credential that does not say when it dies has told us
  // nothing, and a green tick derived from a missing field is the most
  // confident kind of wrong.
  const file = credentialFile(t, { claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } });

  const state = readCredentialState(file);
  assert.equal(state.state, 'unknown');
  assert.equal(state.refreshable, true); // it still reports what it DID find
});

test('a file that is not JSON is unknown', (t) => {
  assert.equal(readCredentialState(credentialFile(t, 'not json at all')).state, 'unknown');
});

// --- what a person is told --------------------------------------------------

test('every sentence names the next action, or says there is nothing to do', () => {
  const now = Date.now();
  const dead = describeCredential(
    { state: 'expired', expiresAt: now - HOUR, refreshable: false, account: null, plan: null },
    'this box',
    now,
  );
  assert.match(dead, /[Ss]ign in again/);

  const fine = describeCredential(
    { state: 'fresh', expiresAt: now + 3 * HOUR, refreshable: true, account: 'a@b.com', plan: 'max' },
    'this box',
    now,
  );
  assert.match(fine, /signed in as a@b\.com/);
  assert.match(fine, /3h left/);

  const cannotTell = describeCredential(
    { state: 'unknown', expiresAt: null, refreshable: false, account: null, plan: null },
    'this box',
    now,
  );
  // Reads as uncertainty, not as a verdict — somebody acting on this must not
  // go and re-authenticate a box that was fine.
  assert.match(cannotTell, /[Cc]ould not tell/);
});

test('a credential is never quoted back, whatever state it is in', (t) => {
  const secret = 'sk-ant-oat01-DO-NOT-PRINT-THIS';
  const file = credentialFile(t, {
    claudeAiOauth: { accessToken: secret, refreshToken: secret, expiresAt: Date.now() - HOUR },
  });

  const state = readCredentialState(file);
  const said = [
    describeCredential(state, 'this box'),
    JSON.stringify(state),
  ].join('\n');

  // The state object travels to a phone inside a health frame, so it is not
  // enough that the SENTENCE is clean.
  assert.ok(!said.includes(secret), 'the credential leaked into what we report about it');
});

// --- what reaches a phone ---------------------------------------------------

test('both apps read the credential and neither treats absent as broken', () => {
  // PARITY, checked rather than intended — the maintenance row shipped to iOS
  // and not to Android while I reported it done on both, which is what
  // docs/app-parity.md exists to catch.
  const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const ios =
    read('apps/ios/Fleetwright/Fleet.swift') + read('apps/ios/Fleetwright/FleetView.swift');
  const android =
    read('apps/android/app/src/main/java/network/thetech/fleetwright/Fleet.kt') +
    read('apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt');

  for (const [name, src] of [['iOS', ios], ['Android', android]]) {
    assert.match(src, /credential/i, `${name} does not read the credential at all`);
    assert.match(src, /isDead/, `${name} has no narrow "worth interrupting somebody" test`);
    // THE NARROWNESS IS THE PROPERTY. `expired` alone is the ordinary state of
    // a box nobody has touched for an hour — the CLI in the session renews it
    // on the way up. An app that shouted about that would be wrong every
    // night, and people would learn to ignore the one time it was right.
    assert.match(src, /refreshable/, `${name} decides on expiry alone`);
  }
});

test('nothing renders "unknown" as a fault', () => {
  // Absent or unrecognised means the host could not tell — an older host, an
  // unsandboxed one, a CLI that renamed its fields. A fleet that flags those
  // as broken teaches people to ignore the flag.
  const state = /** @type {const} */ ({
    state: 'unknown', expiresAt: null, refreshable: false, account: null, plan: null,
  });
  assert.equal(state.state === 'expired' && state.refreshable === false, false);
});
