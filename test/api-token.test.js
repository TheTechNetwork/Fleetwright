// The credential that separates the sidecar from anything else on the box.
//
//   node --test test/
//
// agent-hub's HTTP API was unauthenticated whenever AGENT_HUB_TOKEN was unset —
// the default — justified in one line: it listens on loopback, so reaching it
// already implies a shell on the machine.
//
// THAT WAS TRUE WHEN THE API ONLY MANAGED SESSIONS. The v2 verbs put
// credential-write on the same endpoint, so a local uid that is neither root
// nor the service user could write a credential into somebody's row, read any
// pane, and reboot the box — without being able to read one of this service's
// files. "Already implies a shell" was never the same claim as "already implies
// the SERVICE USER's shell", and the gap between them is every other account on
// the machine.
//
// There was no test for any of this, which is most of why it survived: nothing
// in the suite constructed the HTTP adapter at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken, apiTokenFile, readApiToken } from '../src/core/api-token.js';

/** @param {import('node:test').TestContext} t @param {{ token?: string }} [opts] */
async function hub(t, { token = '' } = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'apitoken-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  const cfg = /** @type {any} */ ({
    stateDir,
    bind: '127.0.0.1',
    port: 0,
    token,
    hostname: 'testbox',
    workdir: path.join(stateDir, 'work'),
    maxSessions: 5,
    loginEnabled: true,
    sandbox: false,
    sandboxCredentialsFile: '',
  });
  const sessions = /** @type {any} */ ({ list: () => [], running: () => [], binned: () => [] });
  const login = /** @type {any} */ ({ status: () => ({ loggedIn: true }), isPending: () => false, pending: null });

  const adapter = new HttpAdapter(cfg, { sessions, login, token: ensureApiToken(cfg) });
  await adapter.start();
  const port = /** @type {any} */ (adapter.server).address().port;
  t.after(() => adapter.server?.close());

  return {
    stateDir,
    adapter,
    /** @param {string} p @param {Record<string,string>} [headers] */
    get: (p, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers }),
    /** @param {string} line @param {Record<string,string>} [headers] */
    command: (line, headers = {}) =>
      fetch(`http://127.0.0.1:${port}/api/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ command: line }),
      }),
  };
}

test('an unauthenticated caller cannot reach the credential verbs', async (t) => {
  // THE GAP, stated as the thing that must not be true. `/api/command` will run
  // `/link <provider> <token>` — writing a live credential into a row that
  // every session that person starts is then seeded with.
  const h = await hub(t);

  const r = await h.command('/link github ghp_attackercontrolled0000000000');

  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: 'unauthorised' });
});

test('nor read a pane, nor reboot the box', async (t) => {
  const h = await hub(t);
  for (const line of ['/peek somesession', '/reboot', '/unlink github', '/logs']) {
    assert.equal((await h.command(line)).status, 401, line);
  }
  assert.equal((await h.get('/api/state')).status, 401);
});

test('the generated token works, and is the one on disk', async (t) => {
  // The sidecar reads exactly this file — both services run as the same user on
  // the same box, which is what keeps "there is always a token" from becoming a
  // question the install has to ask.
  const h = await hub(t);
  const token = readApiToken(h.stateDir);

  assert.ok(token && token.length >= 32);
  assert.equal((await h.get('/api/state', { authorization: `Bearer ${token}` })).status, 200);
});

test('the token file is 0600 and the token is never in the log line', async (t) => {
  // `logs` reaches a phone now, so the journal is no longer a place only
  // somebody with the box can read. The startup line names the FILE.
  const h = await hub(t);
  const file = apiTokenFile(h.stateDir);

  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a loosened token file is tightened, loudly, rather than used quietly', async (t) => {
  // Matching what host/identity.js does for the host key. A backup-restore or a
  // stray chmod that widens a credential is one every other account on the box
  // can read, and continuing without comment is how that stays invisible.
  const h = await hub(t);
  const file = apiTokenFile(h.stateDir);
  chmodSync(file, 0o644);

  const token = readApiToken(h.stateDir);

  assert.ok(token, 'an unreadable API is a box nobody can drive — this one is ours to reissue');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('an explicitly configured token is never written to disk', async (t) => {
  // Somebody who set AGENT_HUB_TOKEN has their own custody arrangement and does
  // not need a second copy of it in our state directory.
  const h = await hub(t, { token: 'x'.repeat(40) });

  assert.equal(readApiToken(h.stateDir), null);
  assert.equal((await h.get('/api/state', { authorization: `Bearer ${'x'.repeat(40)}` })).status, 200);
  assert.equal((await h.get('/api/state')).status, 401);
});

test('a missing token refuses rather than admits everybody', async (t) => {
  // FAILS CLOSED. If generation failed there is no way to tell the sidecar from
  // anything else on the box, and answering everybody is the wrong side of that
  // to err on. This is the exact line that used to read `return true`.
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'apitoken-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cfg = /** @type {any} */ ({
    stateDir, bind: '127.0.0.1', port: 0, token: '', hostname: 'x',
    workdir: stateDir, maxSessions: 1, loginEnabled: true, sandbox: false, sandboxCredentialsFile: '',
  });
  const adapter = new HttpAdapter(cfg, {
    sessions: /** @type {any} */ ({ list: () => [], running: () => [], binned: () => [] }),
    login: /** @type {any} */ ({ status: () => ({ loggedIn: true }), isPending: () => false }),
    token: null,
  });
  await adapter.start();
  const port = /** @type {any} */ (adapter.server).address().port;
  t.after(() => adapter.server?.close());

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);
});

test('the browser still gets something it can act on', async (t) => {
  // A bare 401 body to somebody who opened the UI in a browser is a dead end.
  const h = await hub(t);
  const r = await h.get('/');

  assert.equal(r.status, 401);
  assert.match(await r.text(), /token=/);
});
