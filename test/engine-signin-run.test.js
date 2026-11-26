// The runner's sign-in mode (sandbox/engine.mjs, `--signin` and `--signout`;
// docs/engines.md, "Signing in on the machine"), against stand-ins for the
// two processes it speaks to.
//
// NO REAL ENGINE IS RUN HERE, no device code is asked of OpenAI or GitHub,
// and no account is signed in. The stand-ins answer as each engine's source
// reads at the version the session image pins:
//
//   codex app-server 0.171.0   account/login/start with chatgptDeviceCode,
//     account/login/completed, account/login/cancel, account/read,
//     account/logout (codex-rs/app-server-protocol v2;
//     app-server/src/request_processors/account_processor.rs;
//     login/src/device_code_auth.rs for the sentences)
//   opencode serve 1.19.6      POST /provider/github-copilot/oauth/authorize
//     and /callback, DELETE /auth/github-copilot, behind
//     OPENCODE_SERVER_PASSWORD (packages/opencode/src/provider/auth.ts,
//     server/routes/instance/httpapi, plugin/github-copilot/copilot.ts)
//
// The box's side, through a stand-in Podman, is test/engine-signin-hub.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { signin, signedInAt, homePaths, SIGNIN_MINUTES } from '../sandbox/engine.mjs';

/** A token as an engine would write it into its sign-in file: found anywhere else, it leaked. */
const TOKEN = 'rt-LEAKCANARY-0123456789abcdef';

/** An engine home, as the box mounts one. */
function engineHome(/** @type {import('node:test').TestContext} */ t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'engine-home-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** What the runner printed, as the lines of JSON a box reads. */
function printed() {
  /** @type {string[]} */
  const raw = [];
  return { out: (/** @type {string} */ s) => void raw.push(s), raw, lines: () => raw.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

/** Wait until `said()` is true, or say what never happened. */
async function until(/** @type {() => boolean} */ said, /** @type {string} */ what, ms = 3000) {
  const by = Date.now() + ms;
  while (!said()) {
    if (Date.now() > by) assert.fail(`waited ${ms} ms and never saw: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── Codex's app server ──────────────────────────────────────────────────────

const LOGIN_ID = '0b9d4a51-7f0e-4c7a-9a3c-5f6d2e1b8c90';
const NOT_ENABLED = 'device code login is not enabled for this Codex server. Use the browser login or verify the server URL.';

/**
 * `codex app-server` on a pipe, as far as signing in goes. It keeps what it
 * was started with, so a test can see which home it was told to use, and
 * `complete` is the notice it sends when OpenAI answers.
 *
 * @param {{ start?: 'code'|'off', account?: any }} [opts]
 */
function codexLogin({ start = 'code', account = { type: 'chatgpt', email: 'debbie@example.com', planType: 'plus', workspaceName: null } } = {}) {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  /** @type {any[]} */
  const seen = [];
  /** @type {{ cmd?: string, argv?: string[], env?: Record<string, string> }} */
  const started = {};
  const send = (/** @type {any} */ m) => void fromServer.write(`${JSON.stringify(m)}\n`);
  const child = { stdin: toServer, stdout: fromServer, exitCode: /** @type {number|null} */ (null), kill() { this.exitCode = 0; fromServer.end(); }, on() {} };
  const authFile = () => path.join(String(started.env?.CODEX_HOME), 'auth.json');
  createInterface({ input: toServer }).on('line', (text) => {
    const m = JSON.parse(text);
    seen.push(m);
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'codex/0.171.0', codexHome: started.env?.CODEX_HOME, platformFamily: 'unix', platformOs: 'linux' } });
    else if (m.method === 'account/login/start') {
      // A 404 from the issuer is an invalid request, in these words.
      if (start === 'off') send({ id: m.id, error: { code: -32600, message: NOT_ENABLED } });
      else send({ id: m.id, result: { type: 'chatgptDeviceCode', loginId: LOGIN_ID, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' } });
    } else if (m.method === 'account/login/cancel') {
      send({ id: m.id, result: { status: m.params?.loginId === LOGIN_ID ? 'canceled' : 'notFound' } });
      if (m.params?.loginId === LOGIN_ID) send({ method: 'account/login/completed', params: { loginId: LOGIN_ID, success: false, error: 'Login was not completed', onboardingEntrypoint: null } });
    } else if (m.method === 'account/read') {
      send({ id: m.id, result: { account: existsSync(authFile()) ? account : null, userId: null, requiresOpenaiAuth: true } });
    } else if (m.method === 'account/logout') {
      rmSync(authFile(), { force: true });
      send({ id: m.id, result: {} });
    }
  });
  return {
    child, seen, started, send, authFile,
    spawn: (/** @type {string} */ cmd, /** @type {string[]} */ argv, /** @type {any} */ opts) => {
      Object.assign(started, { cmd, argv, env: opts.env });
      return child;
    },
    methods: () => seen.filter((m) => m.method).map((m) => m.method),
    /** OpenAI said yes: Codex writes its file, then says so. */
    approve() {
      mkdirSync(path.dirname(authFile()), { recursive: true });
      writeFileSync(authFile(), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'id-LEAKCANARY-0123456789', access_token: 'at-LEAKCANARY-0123456789', refresh_token: TOKEN, account_id: 'acct-1' }, last_refresh: '2026-11-25T10:00:00Z' }, null, 2), { mode: 0o600 });
      send({ method: 'account/login/completed', params: { loginId: LOGIN_ID, success: true, error: null, onboardingEntrypoint: null } });
    },
    fail: (/** @type {string} */ error, loginId = LOGIN_ID) => send({ method: 'account/login/completed', params: { loginId, success: false, error, onboardingEntrypoint: null } }),
  };
}

test('Codex: a start prints the page and the code as one line, and an approved sign-in a second line saying who, with no token in either', async (t) => {
  const home = engineHome(t);
  const server = codexLogin();
  const p = printed();
  const done = signin({ engine: 'codex' }, { env: { FLEETWRIGHT_ENGINE_HOME: home }, out: p.out, spawnEngine: server.spawn });
  await until(() => p.lines().length === 1, 'the page and the code');
  assert.deepEqual(p.lines()[0], { engine: 'codex', signin: 'code', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH', expiresInMinutes: SIGNIN_MINUTES });
  // The process a session's turns go through, reading and writing the member's engine home.
  assert.deepEqual([server.started.cmd, server.started.argv, server.started.env?.CODEX_HOME], ['codex', ['app-server'], path.join(home, 'codex')]);
  assert.deepEqual(server.seen.find((m) => m.method === 'account/login/start').params, { type: 'chatgptDeviceCode' });
  // Somebody else's sign-in ending is not this one's.
  server.fail('device auth failed with status 403 Forbidden', 'another-login-id');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p.lines().length, 1);
  server.approve();
  assert.equal(await done, 0);
  assert.deepEqual(p.lines()[1], { engine: 'codex', signin: 'done', state: 'signed_in', who: { email: 'debbie@example.com', plan: 'plus' } });
  assert.deepEqual(server.methods(), ['initialize', 'initialized', 'account/login/start', 'account/read']);
  // The sign-in is where the engine wrote it, and nowhere in what the runner said.
  assert.equal(signedInAt('codex', home)?.file, path.join(home, 'codex', 'auth.json'));
  assert.ok(!p.raw.join('').includes('LEAKCANARY'), 'a token was printed');
  assert.ok(server.child.exitCode !== null, 'the engine is ended with the sign-in');
});

test('Codex: a sign-in that fails says so in Codex’s own sentence, with anything from a sign-in already there taken out', async (t) => {
  const home = engineHome(t);
  // Signed in before, as another account: the file a new attempt would replace.
  mkdirSync(path.join(home, 'codex'), { recursive: true });
  writeFileSync(path.join(home, 'codex', 'auth.json'), JSON.stringify({ tokens: { refresh_token: TOKEN } }));
  const server = codexLogin();
  const p = printed();
  const done = signin({ engine: 'codex' }, { env: { FLEETWRIGHT_ENGINE_HOME: home }, out: p.out, spawnEngine: server.spawn });
  await until(() => p.lines().length === 1, 'the page and the code');
  server.fail(`device code exchange failed: token ${TOKEN} is not for this workspace`);
  assert.equal(await done, 0);
  assert.deepEqual(p.lines()[1], { engine: 'codex', signin: 'done', state: 'failed', detail: 'device code exchange failed: token [withheld] is not for this workspace' });
  // The sign-in that was there is still there: a failed attempt replaces nothing.
  assert.ok(signedInAt('codex', home));
});

test('Codex: the 15 minutes running out is expired, whether Codex says it first or this runner’s own clock does', async (t) => {
  // Codex gives up by itself, in these words (poll_for_token).
  const own = codexLogin();
  const p1 = printed();
  const first = signin({ engine: 'codex' }, { env: { FLEETWRIGHT_ENGINE_HOME: engineHome(t) }, out: p1.out, spawnEngine: own.spawn });
  await until(() => p1.lines().length === 1, 'the page and the code');
  own.fail('device auth timed out after 15 minutes');
  await first;
  assert.deepEqual(p1.lines()[1], { engine: 'codex', signin: 'done', state: 'expired' });
  // And a Codex that never says anything is not waited on for ever.
  const silent = codexLogin();
  const p2 = printed();
  assert.equal(await signin({ engine: 'codex' }, { env: { FLEETWRIGHT_ENGINE_HOME: engineHome(t) }, out: p2.out, spawnEngine: silent.spawn, capMs: 40 }), 0);
  assert.deepEqual(p2.lines().map((l) => l.state ?? l.signin), ['code', 'expired']);
  assert.deepEqual(silent.seen.find((m) => m.method === 'account/login/cancel')?.params, { loginId: LOGIN_ID }, 'Codex is told to stop asking');
});

test('Codex: an account with device code turned off gets no code, and Codex’s words for it', async (t) => {
  const server = codexLogin({ start: 'off' });
  const p = printed();
  assert.equal(await signin({ engine: 'codex' }, { env: { FLEETWRIGHT_ENGINE_HOME: engineHome(t) }, out: p.out, spawnEngine: server.spawn }), 0);
  assert.deepEqual(p.lines(), [{ engine: 'codex', signin: 'done', state: 'failed', detail: NOT_ENABLED, why: 'device_code_off' }]);
});

test('Codex: a cancel from the box tells Codex, and ends as cancelled', async (t) => {
  const home = engineHome(t);
  const server = codexLogin();
  const signals = new EventEmitter();
  const p = printed();
  const done = signin({ engine: 'codex' }, { env: { FLEETWRIGHT_ENGINE_HOME: home }, out: p.out, spawnEngine: server.spawn, signals });
  await until(() => p.lines().length === 1, 'the page and the code');
  signals.emit('SIGTERM');
  assert.equal(await done, 0);
  assert.deepEqual(p.lines()[1], { engine: 'codex', signin: 'done', state: 'cancelled' });
  assert.ok(server.methods().includes('account/login/cancel'));
  assert.equal(signedInAt('codex', home), null);
});

test('Codex: a sign out is Codex’s own, and removes what it kept', async (t) => {
  const home = engineHome(t);
  mkdirSync(path.join(home, 'codex'), { recursive: true });
  writeFileSync(path.join(home, 'codex', 'auth.json'), JSON.stringify({ tokens: { refresh_token: TOKEN } }));
  const server = codexLogin();
  const p = printed();
  assert.equal(await signin({ engine: 'codex', out: true }, { env: { FLEETWRIGHT_ENGINE_HOME: home }, out: p.out, spawnEngine: server.spawn }), 0);
  assert.deepEqual(p.lines(), [{ engine: 'codex', signin: 'done', state: 'signed_out' }]);
  assert.deepEqual(server.methods(), ['initialize', 'initialized', 'account/logout']);
  assert.equal(signedInAt('codex', home), null);
});

// ── OpenCode's server ───────────────────────────────────────────────────────

/**
 * `opencode serve` on loopback, as far as signing in to Copilot goes: one
 * process holding what is pending, behind the password it was started with.
 * `github` is how GitHub answers the code OpenCode is asking about.
 */
async function openCodeServe(/** @type {import('node:test').TestContext} */ t, { keepAliveSeconds = 5 } = {}) {
  /** @type {{ cmd?: string, argv?: string[], env?: Record<string, string> }} */
  const started = {};
  /** @type {Array<{ method: string, url: string, body: any }>} */
  const seen = [];
  /** What GitHub says of the code, once it does. @type {(answer: 'approved'|'failed') => void} */
  let github = () => {};
  /** @type {Promise<'approved'|'failed'>} */
  const answered = new Promise((r) => (github = r));
  let pending = false;
  const authFile = () => path.join(String(started.env?.XDG_DATA_HOME), 'opencode', 'auth.json');
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', async () => {
      const json = (/** @type {number} */ status, /** @type {unknown} */ body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const body = text ? JSON.parse(text) : undefined;
      seen.push({ method: String(req.method), url: String(req.url), body });
      // server/auth.ts: the user is `opencode`, the password the variable it was started with.
      const want = `Basic ${Buffer.from(`opencode:${started.env?.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`;
      if (!started.env?.OPENCODE_SERVER_PASSWORD || req.headers.authorization !== want) return json(401, { name: 'Unauthorized' });
      if (req.method === 'POST' && req.url === '/provider/github-copilot/oauth/authorize') {
        pending = true;
        return json(200, { url: 'https://github.com/login/device', method: 'auto', instructions: 'Enter code: WXYZ-1234' });
      }
      if (req.method === 'POST' && req.url === '/provider/github-copilot/oauth/callback') {
        if (!pending) return json(400, { name: 'ProviderAuthOauthMissing', data: { providerID: 'github-copilot' } });
        if ((await answered) === 'failed') return json(400, { name: 'ProviderAuthOauthCallbackFailed', data: {} });
        mkdirSync(path.dirname(authFile()), { recursive: true });
        writeFileSync(authFile(), `${JSON.stringify({ 'github-copilot': { type: 'oauth', refresh: TOKEN, access: TOKEN, expires: 0 } })}\n`, { mode: 0o600 });
        return json(200, true);
      }
      if (req.method === 'DELETE' && req.url === '/auth/github-copilot') {
        const held = existsSync(authFile()) ? JSON.parse(readFileSync(authFile(), 'utf8')) : {};
        delete held['github-copilot'];
        writeFileSync(authFile(), JSON.stringify(held));
        return json(200, true);
      }
      return json(404, { name: 'NotFound' });
    });
  });
  // WHAT THE REAL SERVER SAYS OF A CONNECTION IT KEEPS: `Connection:
  // keep-alive` and `Keep-Alive: timeout=5` on every answer (seen from
  // `opencode serve` 1.19.6). Node's client takes a second off that and cuts
  // a kept connection that sits idle for the rest, which is what a held
  // request looks like.
  server.keepAliveTimeout = keepAliveSeconds * 1000;
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, exitCode: /** @type {number|null} */ (null), kill() { this.exitCode = 0; } });
  return {
    started, seen, authFile, child,
    github: (/** @type {'approved'|'failed'} */ answer) => github(answer),
    spawn: (/** @type {string} */ cmd, /** @type {string[]} */ argv, /** @type {any} */ opts) => {
      Object.assign(started, { cmd, argv, env: opts.env });
      // What `opencode serve` prints as it comes up (cli/cmd/serve.ts).
      setImmediate(() => stdout.write(`opencode server listening on http://127.0.0.1:${port}\n`));
      return child;
    },
  };
}

test('OpenCode: its own server is asked for a code and held until GitHub answers, and what it writes is its own', async (t) => {
  const home = engineHome(t);
  const server = await openCodeServe(t);
  const p = printed();
  const done = signin({ engine: 'opencode' }, { env: { FLEETWRIGHT_ENGINE_HOME: home }, out: p.out, spawnEngine: server.spawn });
  await until(() => p.lines().length === 1, 'the page and the code');
  // The code is read out of OpenCode's sentence; the page is as it gave it.
  assert.deepEqual(p.lines()[0], { engine: 'opencode', signin: 'code', url: 'https://github.com/login/device', code: 'WXYZ-1234', expiresInMinutes: SIGNIN_MINUTES });
  // On loopback, on a port of its choosing, with its data in the member's engine home and a password for this run.
  assert.deepEqual([server.started.cmd, server.started.argv, server.started.env?.XDG_DATA_HOME], ['opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], home]);
  assert.match(String(server.started.env?.OPENCODE_SERVER_PASSWORD), /^[0-9a-f]{48}$/);
  await until(() => server.seen.length === 2, 'the callback held open');
  assert.deepEqual(server.seen, [
    { method: 'POST', url: '/provider/github-copilot/oauth/authorize', body: { method: 0, inputs: { deploymentType: 'github.com' } } },
    { method: 'POST', url: '/provider/github-copilot/oauth/callback', body: { method: 0 } },
  ]);
  server.github('approved');
  assert.equal(await done, 0);
  // Who is not known: OpenCode keeps a token and no name.
  assert.deepEqual(p.lines()[1], { engine: 'opencode', signin: 'done', state: 'signed_in', who: null });
  assert.equal(signedInAt('opencode', home)?.file, path.join(home, 'opencode', 'auth.json'));
  assert.equal(statSync(server.authFile()).mode & 0o777, 0o600);
  const said = p.raw.join('');
  assert.ok(!said.includes('LEAKCANARY') && !said.includes(String(server.started.env?.OPENCODE_SERVER_PASSWORD)), 'a token or the server’s password was printed');
});

test('OpenCode: an approval that comes after a kept connection would have been cut still signs in', async (t) => {
  const home = engineHome(t);
  // `timeout=2` is one idle second to Node's client, so this takes a second and a half and not five.
  const server = await openCodeServe(t, { keepAliveSeconds: 2 });
  const p = printed();
  const done = signin({ engine: 'opencode' }, { env: { FLEETWRIGHT_ENGINE_HOME: home }, out: p.out, spawnEngine: server.spawn });
  await until(() => p.lines().length === 1 && server.seen.length === 2, 'the code out and the callback held');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(p.lines().length, 1, 'the sign-in ended while GitHub had not answered');
  server.github('approved');
  assert.equal(await done, 0);
  assert.deepEqual(p.lines()[1], { engine: 'opencode', signin: 'done', state: 'signed_in', who: null });
});

test('OpenCode: a callback that fails is failed in OpenCode’s word for it, which does not say why', async (t) => {
  const server = await openCodeServe(t);
  const p = printed();
  const done = signin({ engine: 'opencode' }, { env: { FLEETWRIGHT_ENGINE_HOME: engineHome(t) }, out: p.out, spawnEngine: server.spawn });
  await until(() => p.lines().length === 1, 'the page and the code');
  server.github('failed');
  assert.equal(await done, 0);
  assert.deepEqual(p.lines()[1], {
    engine: 'opencode', signin: 'done', state: 'failed',
    detail: "OpenCode did not complete the sign-in (ProviderAuthOauthCallbackFailed). It does not pass on GitHub's reason: the code may have run out, or the request was declined",
  });
});

test('OpenCode: the runner’s own 15 minutes is expired, a cancel is cancelled, and neither leaves a sign-in', async (t) => {
  for (const [how, state] of /** @type {const} */ ([['cap', 'expired'], ['signal', 'cancelled']])) {
    const home = engineHome(t);
    const server = await openCodeServe(t);
    const signals = new EventEmitter();
    const p = printed();
    const done = signin({ engine: 'opencode' }, { env: { FLEETWRIGHT_ENGINE_HOME: home }, out: p.out, spawnEngine: server.spawn, signals, ...(how === 'cap' ? { capMs: 150 } : {}) });
    await until(() => p.lines().length === 1 && server.seen.length === 2, 'the code out and the callback held');
    if (how === 'signal') signals.emit('SIGTERM');
    assert.equal(await done, 0);
    assert.deepEqual(p.lines()[1], { engine: 'opencode', signin: 'done', state });
    assert.equal(signedInAt('opencode', home), null);
    server.github('failed');
  }
});

test('OpenCode: a sign out removes its Copilot entry through its own server, and leaves a key beside it', async (t) => {
  const home = engineHome(t);
  mkdirSync(path.join(home, 'opencode'), { recursive: true });
  writeFileSync(path.join(home, 'opencode', 'auth.json'), JSON.stringify({ 'github-copilot': { type: 'oauth', refresh: TOKEN, access: TOKEN, expires: 0 }, openrouter: { type: 'api', key: 'sk-or-kept' } }));
  const server = await openCodeServe(t);
  const p = printed();
  assert.equal(await signin({ engine: 'opencode', out: true }, { env: { FLEETWRIGHT_ENGINE_HOME: home }, out: p.out, spawnEngine: server.spawn }), 0);
  assert.deepEqual(p.lines(), [{ engine: 'opencode', signin: 'done', state: 'signed_out' }]);
  assert.deepEqual(server.seen.map((r) => [r.method, r.url]), [['DELETE', '/auth/github-copilot']]);
  assert.equal(signedInAt('opencode', home), null);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'opencode', 'auth.json'), 'utf8')), { openrouter: { type: 'api', key: 'sk-or-kept' } });
});

// ── What it refuses to start ────────────────────────────────────────────────

test('with no engine home, or an engine it does not sign in, nothing is started and the one line says why', async () => {
  let spawned = 0;
  const spawnEngine = () => void (spawned += 1);
  const none = printed();
  assert.equal(await signin({ engine: 'codex' }, { env: {}, out: none.out, spawnEngine }), 0);
  assert.deepEqual(none.lines(), [{ engine: 'codex', signin: 'done', state: 'failed', detail: 'this container was given no engine home to keep a sign-in in' }]);
  const other = printed();
  assert.equal(await signin({ engine: 'claude-code' }, { env: { FLEETWRIGHT_ENGINE_HOME: '/engine-home' }, out: other.out, spawnEngine }), 0);
  assert.deepEqual(other.lines(), [{ engine: 'claude-code', signin: 'done', state: 'failed', detail: 'claude-code is not an engine this runner signs in' }]);
  assert.equal(spawned, 0);
});

test('an engine that is not in the image is said as that, not as a sign-in that failed at the provider', async (t) => {
  const p = printed();
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill() {} });
  const done = signin({ engine: 'codex' }, {
    env: { FLEETWRIGHT_ENGINE_HOME: engineHome(t) }, out: p.out,
    spawnEngine: () => {
      // What node says of a command that is not there, and then the pipe closes.
      setImmediate(() => {
        child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
        child.stdout.end();
      });
      return child;
    },
  });
  assert.equal(await done, 0);
  assert.deepEqual(p.lines(), [{ engine: 'codex', signin: 'done', state: 'failed', detail: "codex is not installed in this machine's session image" }]);
});

test('where each engine keeps its sign-in in an engine home, and what counts as one', (t) => {
  const home = engineHome(t);
  assert.deepEqual(homePaths('codex', home), { dir: path.join(home, 'codex'), file: path.join(home, 'codex', 'auth.json'), env: { CODEX_HOME: path.join(home, 'codex') } });
  assert.deepEqual(homePaths('opencode', home), { dir: path.join(home, 'opencode'), file: path.join(home, 'opencode', 'auth.json'), env: { XDG_DATA_HOME: home } });
  assert.equal(homePaths('claude-code', home), null);
  // Nothing there, an empty file, a file that does not read, and a key alone are none.
  assert.equal(signedInAt('codex', home), null);
  for (const dir of ['codex', 'opencode']) mkdirSync(path.join(home, dir));
  for (const [engine, text] of [['codex', ''], ['codex', '{"tokens":'], ['codex', '{"OPENAI_API_KEY":"sk-x","tokens":null}'], ['opencode', '{"openrouter":{"type":"api","key":"sk-or"}}']]) {
    writeFileSync(path.join(home, engine, 'auth.json'), text);
    assert.equal(signedInAt(engine, home), null, `${engine}: ${text}`);
  }
});
