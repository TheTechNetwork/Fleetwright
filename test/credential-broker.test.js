import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';

import { answerCredentialRequest, answerGitCredential, CREDENTIAL_PATH } from '../src/core/credential-broker.js';
import { HookSocketServer } from '../src/core/hook-socket.js';

// --- the decision ------------------------------------------------------------

test('a connected provider is served', () => {
  const r = answerCredentialRequest({ provider: 'github', secrets: { GH_TOKEN: 'ghp_x', OTHER: 'no' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.env, { GH_TOKEN: 'ghp_x' });
  // Only that provider's keys. A session asking for github must not receive the
  // Cloudflare token because it happened to be in the same file.
  assert.equal('CLOUDFLARE_API_TOKEN' in r.env, false);
});

test('"no row" and "nothing connected" are different answers', () => {
  // NULL IS NOT EMPTY. No row means the asker could not be identified — the
  // case that used to resolve to the box's shared row. An empty row means the
  // person simply has not connected anything, which is their own doing and
  // fixable from the app. One message for both would send half of the people
  // who see it to the wrong place.
  const noRow = answerCredentialRequest({ provider: 'github', secrets: null });
  const empty = answerCredentialRequest({ provider: 'github', secrets: {} });

  assert.equal(noRow.ok, false);
  assert.equal(empty.ok, false);
  assert.notEqual(noRow.error, empty.error);
  assert.match(empty.message, /nothing needs restarting/);
});

test('an unknown provider is named, not shrugged at', () => {
  const r = answerCredentialRequest({ provider: 'githib', secrets: { GH_TOKEN: 'x' } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown_provider');
  assert.match(r.message, /githib/);
});

test('an empty stored value is not a credential', () => {
  // An unlinked provider can leave the key present and blank. Serving "" reads
  // to gh as "authenticated with nothing" and produces a 401 nobody can trace.
  const r = answerCredentialRequest({ provider: 'github', secrets: { GH_TOKEN: '' } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_connected');
});

// --- the git helper ----------------------------------------------------------

const yes = () => ({ ok: /** @type {const} */ (true), env: { GH_TOKEN: 'ghp_x' } });

test('git gets a token for github over https, and nothing otherwise', () => {
  assert.deepEqual(answerGitCredential({ protocol: 'https', host: 'github.com' }, yes), {
    username: 'x-access-token',
    password: 'ghp_x',
  });
  // A HOST WE HAVE NO TOKEN FOR GETS NOTHING. git hands a helper whatever
  // hostname it is cloning from, and a helper that answers for all of them
  // sends a GitHub token wherever a session was told to look.
  assert.equal(answerGitCredential({ protocol: 'https', host: 'evil.example' }, yes), null);
  // Cleartext gets nothing either — SEC-NET-1, one layer down.
  assert.equal(answerGitCredential({ protocol: 'http', host: 'github.com' }, yes), null);
  assert.equal(answerGitCredential({}, yes), null);
});

// --- over a real socket ------------------------------------------------------

/** @param {string} sock @param {object} body */
function post(sock, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = request(
      { socketPath: sock, path: CREDENTIAL_PATH, method: 'POST', headers: { 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      },
    );
    req.end(payload);
  });
}

test('the socket is the identity, and the read happens per request', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'broker-'));
  // Mutable, so the test can rotate a token WITHOUT restarting anything — which
  // is the entire reason the broker exists.
  const rows = { alpha: { GH_TOKEN: 'first' }, beta: { GH_TOKEN: 'beta-token' } };
  const server = new HookSocketServer({
    dir,
    onSessionStart: () => ({ ok: true }),
    secretsFor: (name) => rows[name] ?? null,
  });
  try {
    const a = await server.open('alpha');
    const b = await server.open('beta');

    const first = await post(a, { provider: 'github' });
    assert.equal(first.body.env.GH_TOKEN, 'first');

    // Two sessions, two sockets, two answers. Nothing in the request said which
    // one was asking.
    const other = await post(b, { provider: 'github' });
    assert.equal(other.body.env.GH_TOKEN, 'beta-token');

    // ROTATION REACHES A RUNNING SESSION. Same socket, same process, new value.
    rows.alpha.GH_TOKEN = 'rotated';
    const second = await post(a, { provider: 'github' });
    assert.equal(second.body.env.GH_TOKEN, 'rotated');
  } finally {
    await server.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the route is absent when no reader was supplied', async () => {
  // An older host, or one running without the sandbox. It must 404 rather than
  // answering with nothing, because "no such route" and "no credential" are
  // different facts and the client prints them differently.
  const dir = mkdtempSync(path.join(tmpdir(), 'broker-off-'));
  const server = new HookSocketServer({ dir, onSessionStart: () => ({ ok: true }) });
  try {
    const sock = await server.open('alpha');
    const r = await post(sock, { provider: 'github' });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not found');
  } finally {
    await server.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- an expired token is not a credential -----------------------------------

test('a token past its expiry is refused, not served', () => {
  // A beta tester's session was handed a `ghu_` token that GitHub answered 401
  // to on every call — API, git push, everything — and the only way to find out
  // was to try. They read the helper, the socket protocol and the token prefix
  // to reach "most likely expired". That diagnosis was available on the box.
  //
  // A GitHub App user-to-server token lives about eight hours. keepalive renews
  // it; when renewal cannot happen — no client secret deposited, a spent
  // refresh token, a box that was asleep — the stored token quietly dies and
  // the broker went on serving it.
  const answer = answerCredentialRequest({
    provider: 'github',
    secrets: { GH_TOKEN: 'ghu_dead', GITHUB_TOKEN: 'ghu_dead' },
    expiredAt: Date.now() - 3 * 3600_000,
  });
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'expired');
  // Names the age and the fix, because "401 Bad credentials" names neither.
  assert.match(answer.message, /3 hours ago/);
  assert.match(answer.message, /reconnect it in the app|keepalive/);
  // And never the token, expired or not.
  assert.equal(/ghu_dead/.test(JSON.stringify(answer)), false);
});

test('a live token is served, and an unknown expiry does not refuse one', () => {
  const live = answerCredentialRequest({
    provider: 'github',
    secrets: { GH_TOKEN: 'ghu_live' },
    expiredAt: Date.now() + 3600_000,
  });
  assert.equal(live.ok, true);

  // NULL IS CANNOT TELL, and guessing in this direction would refuse working
  // credentials on every host that does not record renewal metadata.
  const unknown = answerCredentialRequest({ provider: 'github', secrets: { GH_TOKEN: 'ghu_live' }, expiredAt: null });
  assert.equal(unknown.ok, true);
});
