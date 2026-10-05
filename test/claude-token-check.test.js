// `verify claude` tests the login a session with nothing linked would run on.
//
//   node --test test/claude-token-check.test.js
//
// SEEN ON A RUNNER: every session answered "API Error: 401 OAuth access token is
// invalid" at its first message, and `verify claude` on the same machine said
// only that nobody had linked an account. The kept `claude setup-token` was the
// thing sessions ran on, and nothing checked it. The API is a stand-in here:
// what is pinned is what this sends and what it says about each answer, not
// Anthropic's servers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkClaudeAuth, describeTokenCheck, MESSAGES_URL } from '../src/core/claude-token-check.js';
import { saveRunnerLogin } from '../src/core/runner-login.js';
import { dispatch } from '../src/adapters/commands.js';

const TOKEN = `sk-ant-oat01-${'Q'.repeat(60)}`;

/**
 * An API that answers with `status` and records what it was asked.
 * @param {number} status @param {any} [body]
 */
function api(status, body = {}) {
  /** @type {Array<{ url: string, init: any }>} */
  const asked = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    asked.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, asked };
}

/** A runner whose owner kept a Claude login. */
function runner(/** @type {import('node:test').TestContext} */ t) {
  const dir = mkdtempSync(join(tmpdir(), 'fw-token-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = /** @type {any} */ ({ stateDir: join(dir, 'state'), hostname: 'gha-1' });
  assert.equal(saveRunnerLogin(cfg, { email: 'eli@example.com', login: 'eli', token: TOKEN }).ok, true);
  return cfg;
}

test('a kept token is tried the way a session uses it, and only its verdict comes back', async (t) => {
  const cfg = runner(t);
  const { runnerAuthFor } = await import('../src/core/runner-login.js');
  const auth = /** @type {any} */ (runnerAuthFor(cfg, 'eli@example.com'));
  assert.equal(auth.kind, 'token');

  const ok = api(200, { content: [{ type: 'text', text: 'o' }] });
  const r = await checkClaudeAuth(auth, { fetchImpl: ok.fetchImpl });
  assert.deepEqual(r, { state: 'accepted', status: 200, why: null });
  const [{ url, init }] = ok.asked;
  assert.equal(url, MESSAGES_URL);
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers['anthropic-beta'], 'oauth-2025-04-20');
  const sent = JSON.parse(init.body);
  assert.equal(sent.max_tokens, 1, 'one token, not a conversation');
  assert.match(sent.system, /Claude Code/);
  assert.ok(!init.headers['x-api-key']);

  const revoked = await checkClaudeAuth(auth, { fetchImpl: api(401, { error: { message: 'OAuth access token is invalid' } }).fetchImpl });
  assert.deepEqual(revoked, { state: 'rejected', status: 401, why: 'OAuth access token is invalid' });
  assert.match(describeTokenCheck(auth, revoked), /rejected just now \(401: OAuth access token is invalid\)/);

  // Busy is not broken: it knew who was asking.
  assert.equal((await checkClaudeAuth(auth, { fetchImpl: api(429).fetchImpl })).state, 'accepted');
  // Anything else, and no answer at all, is cannot tell — never a verdict.
  assert.equal((await checkClaudeAuth(auth, { fetchImpl: api(500).fetchImpl })).state, 'unknown');
  const down = await checkClaudeAuth(auth, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(down.state, 'unknown');
  assert.match(describeTokenCheck(auth, down), /cannot be told from here/);
  for (const words of [describeTokenCheck(auth, r), describeTokenCheck(auth, revoked), describeTokenCheck(auth, down)]) {
    assert.ok(!words.includes(TOKEN), 'the token is in what it said');
  }
});

test('a runner repository key is tried with the key header, and said as the key', async () => {
  const key = { kind: /** @type {const} */ ('key'), key: 'sk-ant-api03-x' };
  const ok = api(200);
  assert.equal((await checkClaudeAuth(key, { fetchImpl: ok.fetchImpl })).state, 'accepted');
  assert.equal(ok.asked[0].init.headers['x-api-key'], 'sk-ant-api03-x');
  assert.ok(!ok.asked[0].init.headers.authorization);
  assert.match(describeTokenCheck(key, { state: 'rejected', status: 401, why: null }), /API key was rejected[\s\S]*ANTHROPIC_API_KEY/);
});

test('verify claude on a runner says what sessions run on and whether it still works', async (t) => {
  const cfg = runner(t);
  const login = { status: () => ({ loggedIn: false }), isPending: () => false };
  const ask = (/** @type {number} */ status, /** @type {any} */ body) =>
    dispatch(/** @type {any} */ ({ cfg, login, actor: 'fleet:eli@example.com', fetchImpl: api(status, body).fetchImpl }), '/verify claude');

  const fine = await ask(200, {});
  assert.equal(fine.ok, true);
  assert.match(fine.text, /runs on the Claude login eli keeps for runners/);
  assert.match(fine.text, /accepted just now/);
  assert.doesNotMatch(fine.text, /would not get a Claude account/);

  const dead = await ask(401, { error: { message: 'OAuth access token is invalid' } });
  assert.match(dead.text, /rejected just now \(401: OAuth access token is invalid\), so every session here would stop at its first message/);
  assert.match(dead.text, /Make it on a machine/);
});
