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

import nodeTest, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { signin as runnerSignin, signedIn, signedInAt, stage, homePaths, PASTED, SIGNIN_MINUTES, SIGNIN_PAGES } from '../sandbox/engine.mjs';
import { codexSignIn, copilotEntry, fakeJwt } from './helpers/engine-files.js';

/** A token as an engine would write it into its sign-in file: found anywhere else, it leaked. */
const TOKEN = 'rt-LEAKCANARY-0123456789abcdef';

// ── A test here fails by its name, in seconds ───────────────────────────────
//
// A SIGN-IN THAT IS NOT WHAT A TEST EXPECTED IS STILL A SIGN-IN THAT IS
// WAITING, on a clock of fifteen minutes. With a fix taken out (the engine
// started on the member's home again, a page that is not the provider's own
// let through, the page cut out of the first line), no test here failed. The
// file sat until whoever ran it gave up, a minute or two later, and named
// nothing. Two things end that:
//
//   - every test has a bound of its own, far above what any of them takes,
//     so one that waits on a sign-in that never ends fails as itself;
//   - every sign-in a test began is told to stop when the test is over, as a
//     box cancels one (SIGTERM), and its engine is given seconds to answer
//     and not thirty. So nothing a failed test left behind keeps the file
//     from ending, and the tests after it still run.
//
// And where a sign-in must end with nothing more said to it, a test waits on
// it through `ends`, which fails in three seconds and says what it waited for.

/** Far above the slowest test here, which takes under two seconds. */
const TEST_MS = 15_000;
/** How long a stand-in engine is given to answer: it is in this process, and answers at once. */
const START_MS = 5_000;
/** The sign-ins the test that is running began. @type {EventEmitter[]} */
const begun = [];

/** @param {string} name @param {(t: import('node:test').TestContext) => unknown} fn */
const test = (name, fn) => nodeTest(name, { timeout: TEST_MS }, fn);
afterEach(() => {
  for (const signals of begun.splice(0)) signals.emit('SIGTERM');
});

/**
 * How a sign-in ended that should end by itself, or a failure that says it
 * did not: a code was given and is being waited on.
 *
 * @param {Promise<number>} done @param {string} what
 */
async function ends(done, what) {
  /** @type {any} */
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve('late'), 3000);
  });
  const how = await Promise.race([done, late]);
  clearTimeout(timer);
  if (how === 'late') assert.fail(`the sign-in was still waiting after 3000 ms: ${what}`);
  return how;
}

/**
 * The runner's `signin`, with this file's bounds on it. A test's own
 * `signals`, `startMs` and `capMs` are used where it gives them.
 *
 * @param {Parameters<typeof runnerSignin>[0]} args @param {NonNullable<Parameters<typeof runnerSignin>[1]>} [io]
 */
function signin(args, io = {}) {
  const signals = /** @type {EventEmitter} */ (io.signals ?? new EventEmitter());
  begun.push(signals);
  return runnerSignin(args, { startMs: START_MS, ...io, signals });
}

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
 * was started with and what its home held then, so a test can see which
 * home it was told to use and what was in it, and `approve` is OpenAI
 * saying yes.
 *
 * @param {{ start?: 'code'|'off', account?: any, page?: string }} [opts]  `page` is the page it names, when not its own
 */
function codexLogin({ start = 'code', account = { type: 'chatgpt', email: 'debbie@example.com', planType: 'plus', workspaceName: null }, page = 'https://auth.openai.com/codex/device' } = {}) {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  /** @type {any[]} */
  const seen = [];
  /** @type {{ cmd?: string, argv?: string[], env?: Record<string, string>, cwd?: string, held?: Record<string, string> }} */
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
      else send({ id: m.id, result: { type: 'chatgptDeviceCode', loginId: LOGIN_ID, verificationUrl: page, userCode: 'ABCD-EFGH' } });
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
      // What its home holds as it starts: every file there, by name.
      const dir = String(opts.env.CODEX_HOME);
      Object.assign(started, { cmd, argv, env: opts.env, cwd: opts.cwd, held: Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(path.join(dir, name), 'utf8')])) });
      return child;
    },
    methods: () => seen.filter((m) => m.method).map((m) => m.method),
    /**
     * OpenAI said yes: Codex writes its file, then says how it ended. With
     * `then`, as the real one does when the question it asks chatgpt.com
     * next fails: the file is written, and the sign-in is called failed in
     * those words (account_processor.rs, `send_account_login_notifications`).
     *
     * @param {{ then?: string }} [how]
     */
    approve({ then } = {}) {
      mkdirSync(path.dirname(authFile()), { recursive: true });
      writeFileSync(authFile(), codexSignIn({ refresh: TOKEN, access: 'at-LEAKCANARY-0123456789', signature: 'sig-LEAKCANARY-0123456789' }), { mode: 0o600 });
      send({ method: 'account/login/completed', params: { loginId: LOGIN_ID, success: !then, error: then ?? null, onboardingEntrypoint: null } });
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
  // The process a session's turns go through, on a home of this run's own with nothing in it.
  assert.deepEqual([server.started.cmd, server.started.argv, server.started.held], ['codex', ['app-server'], {}]);
  const own = String(server.started.env?.CODEX_HOME);
  assert.ok(!own.startsWith(home) && !String(server.started.cwd).startsWith(home), 'Codex was started on the member’s home');
  assert.deepEqual(server.seen.find((m) => m.method === 'account/login/start').params, { type: 'chatgptDeviceCode' });
  // Somebody else's sign-in ending is not this one's.
  server.fail('device auth failed with status 403 Forbidden', 'another-login-id');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p.lines().length, 1);
  server.approve();
  assert.equal(await done, 0);
  assert.deepEqual(p.lines()[1], { engine: 'codex', signin: 'done', state: 'signed_in', who: { email: 'debbie@example.com', plan: 'plus' } });
  assert.deepEqual(server.methods(), ['initialize', 'initialized', 'account/login/start', 'account/read']);
  // The sign-in is in the member's home as the engine wrote it, private, and nowhere in what the runner said.
  assert.equal(signedInAt('codex', home)?.file, path.join(home, 'codex', 'auth.json'));
  assert.ok(readFileSync(path.join(home, 'codex', 'auth.json'), 'utf8').includes(TOKEN));
  assert.equal(statSync(path.join(home, 'codex', 'auth.json')).mode & 0o777, 0o600);
  assert.ok(!p.raw.join('').includes('LEAKCANARY'), 'a token was printed');
  assert.ok(server.child.exitCode !== null, 'the engine is ended with the sign-in');
  assert.equal(existsSync(path.dirname(own)), false, 'the run’s own home is gone with the run');
});

test('Codex: nothing a session left in the member’s home reaches the sign-in, and a page that is not OpenAI’s own gets no code', async (t) => {
  const home = engineHome(t);
  // What a session of the member can write: Codex's settings, which name where a new token is first sent and what else to start.
  mkdirSync(path.join(home, 'codex'), { recursive: true });
  writeFileSync(path.join(home, 'codex', 'config.toml'), 'chatgpt_base_url = "https://chatgpt.com.example/backend-api/"\n');
  const server = codexLogin();
  const signals = new EventEmitter();
  const p = printed();
  const done = signin({ engine: 'codex' }, { env: { FLEETWRIGHT_ENGINE_HOME: home }, out: p.out, spawnEngine: server.spawn, signals });
  await until(() => p.lines().length === 1, 'the page and the code');
  assert.deepEqual(server.started.held, {}, 'Codex was started where it could read the home’s settings');
  signals.emit('SIGTERM');
  await done;
  // And whatever a Codex names, for whatever reason, only its own page is ever printed.
  for (const page of ['https://auth.openai.com.example/codex/device', 'https://auth.openai.com/codex/device?next=https://example.com', 'http://auth.openai.com/codex/device']) {
    const other = codexLogin({ page });
    const said = printed();
    assert.equal(await ends(signin({ engine: 'codex' }, { env: { FLEETWRIGHT_ENGINE_HOME: engineHome(t) }, out: said.out, spawnEngine: other.spawn }), `a code was given for ${page}`), 0);
    assert.deepEqual(said.lines(), [{ engine: 'codex', signin: 'done', state: 'failed', detail: "it named a page that is not OpenAI's own sign-in page, so no code is shown" }], page);
  }
  assert.equal(SIGNIN_PAGES.codex, 'https://auth.openai.com/codex/device');
});

test('Codex: a sign-in it wrote and then called failed is not kept, is signed out, and says what to do, and a sign-in that was there is untouched', async (t) => {
  for (const before of [null, codexSignIn({ refresh: 'rt-the-one-before-0123456789' })]) {
    const home = engineHome(t);
    if (before) {
      mkdirSync(path.join(home, 'codex'), { recursive: true });
      writeFileSync(path.join(home, 'codex', 'auth.json'), before);
    }
    const server = codexLogin();
    const p = printed();
    const done = signin({ engine: 'codex' }, { env: { FLEETWRIGHT_ENGINE_HOME: home }, out: p.out, spawnEngine: server.spawn });
    await until(() => p.lines().length === 1, 'the page and the code');
    // OpenAI approves, Codex writes its file, and chatgpt.com cannot be reached for the question that follows.
    server.approve({ then: 'workspace routing discovery failed' });
    assert.equal(await done, 0);
    assert.deepEqual(p.lines()[1], {
      engine: 'codex', signin: 'done', state: 'failed',
      detail: 'OpenAI approved the code, but Codex could not reach chatgpt.com to finish, so no sign-in was kept. Let this machine reach chatgpt.com, then sign in again',
    });
    // What the box will record as failed is not on the machine for the next session to run on.
    assert.equal(existsSync(path.join(home, 'codex', 'auth.json')) ? readFileSync(path.join(home, 'codex', 'auth.json'), 'utf8') : null, before);
    assert.ok(server.methods().includes('account/logout'), 'Codex was not asked to sign the attempt out');
    assert.equal(existsSync(server.authFile()), false);
    assert.ok(!p.raw.join('').includes('LEAKCANARY'));
  }
  // Any other reason is said in Codex's words, inside the same sentence.
  const server = codexLogin();
  const p = printed();
  const done = signin({ engine: 'codex' }, { env: { FLEETWRIGHT_ENGINE_HOME: engineHome(t) }, out: p.out, spawnEngine: server.spawn });
  await until(() => p.lines().length === 1, 'the page and the code');
  server.approve({ then: 'selected workspace missing from routing discovery' });
  await done;
  assert.equal(p.lines()[1].detail, 'OpenAI approved the code, but Codex did not finish (selected workspace missing from routing discovery), so no sign-in was kept. Sign in again');
});

test('Codex: a sign-in that fails says so in Codex’s own sentence, with anything from a sign-in already there taken out', async (t) => {
  const home = engineHome(t);
  // Signed in before, as another account: the file a new attempt would replace.
  mkdirSync(path.join(home, 'codex'), { recursive: true });
  writeFileSync(path.join(home, 'codex', 'auth.json'), codexSignIn({ refresh: TOKEN }));
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

test('Codex: a home that already holds a sign-in still gets its page: the issuer Codex keeps beside its tokens is no secret', async (t) => {
  const home = engineHome(t);
  mkdirSync(path.join(home, 'codex'), { recursive: true });
  // As Codex 0.171.0 wrote it, `tokens.oauth_provenance.issuer` and all.
  writeFileSync(path.join(home, 'codex', 'auth.json'), codexSignIn({ refresh: TOKEN }));
  const server = codexLogin();
  const p = printed();
  const done = signin({ engine: 'codex' }, { env: { FLEETWRIGHT_ENGINE_HOME: home }, out: p.out, spawnEngine: server.spawn });
  await until(() => p.lines().length === 1, 'the page and the code');
  assert.deepEqual([p.lines()[0].url, p.lines()[0].code], ['https://auth.openai.com/codex/device', 'ABCD-EFGH']);
  // And what is a secret in that file is still kept quiet.
  server.fail(`the token ${TOKEN} from https://auth.openai.com was refused`);
  await done;
  assert.equal(p.lines()[1].detail, 'the token [withheld] from https://auth.openai.com was refused');
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

test('Codex: a sign out is Codex’s own, on a copy of the sign-in and nothing else of the home, and removes what the home kept', async (t) => {
  const home = engineHome(t);
  const signedIn = codexSignIn({ refresh: TOKEN });
  mkdirSync(path.join(home, 'codex'), { recursive: true });
  writeFileSync(path.join(home, 'codex', 'auth.json'), signedIn);
  writeFileSync(path.join(home, 'codex', 'config.toml'), 'chatgpt_base_url = "https://chatgpt.com.example/backend-api/"\n');
  const server = codexLogin();
  const p = printed();
  assert.equal(await signin({ engine: 'codex', out: true }, { env: { FLEETWRIGHT_ENGINE_HOME: home }, out: p.out, spawnEngine: server.spawn }), 0);
  assert.deepEqual(p.lines(), [{ engine: 'codex', signin: 'done', state: 'signed_out' }]);
  assert.deepEqual(server.methods(), ['initialize', 'initialized', 'account/logout']);
  // Codex had the tokens to tell OpenAI about, and not the settings a session could have left beside them.
  assert.deepEqual(server.started.held, { 'auth.json': signedIn });
  assert.equal(signedInAt('codex', home), null);
  assert.equal(existsSync(path.join(home, 'codex', 'auth.json')), false);
});

// ── OpenCode's server ───────────────────────────────────────────────────────

/**
 * `opencode serve` on loopback, as far as signing in to Copilot goes: one
 * process holding what is pending, behind the password it was started with.
 * `github` is how GitHub answers the code OpenCode is asking about.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ keepAliveSeconds?: number, page?: string, github?: 'reached'|'unreachable' }} [opts]
 *   `page` is the page it names, when not GitHub's own; `github: 'unreachable'` is OpenCode with no way to GitHub
 */
async function openCodeServe(t, { keepAliveSeconds = 5, page = 'https://github.com/login/device', github: reach = 'reached' } = {}) {
  /** @type {{ cmd?: string, argv?: string[], env?: Record<string, string>, cwd?: string }} */
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
        // What the real server answers when its call to GitHub fails, in 17 ms and with nothing in its log.
        if (reach === 'unreachable') return json(500, { name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_16d4d39b' } });
        pending = true;
        return json(200, { url: page, method: 'auto', instructions: 'Enter code: WXYZ-1234' });
      }
      if (req.method === 'POST' && req.url === '/provider/github-copilot/oauth/callback') {
        if (!pending) return json(400, { name: 'ProviderAuthOauthMissing', data: { providerID: 'github-copilot' } });
        if ((await answered) === 'failed') return json(400, { name: 'ProviderAuthOauthCallbackFailed', data: {} });
        mkdirSync(path.dirname(authFile()), { recursive: true });
        // Its own entry, and one more beside it that nobody asked for.
        writeFileSync(authFile(), `${JSON.stringify({ 'github-copilot': copilotEntry(TOKEN), 'https://example.com': { type: 'wellknown', key: 'SOME_TOKEN', token: 'left-by-the-engine' } })}\n`, { mode: 0o600 });
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
      Object.assign(started, { cmd, argv, env: opts.env, cwd: opts.cwd });
      // What `opencode serve` prints as it comes up (cli/cmd/serve.ts).
      setImmediate(() => stdout.write(`opencode server listening on http://127.0.0.1:${port}\n`));
      return child;
    },
  };
}

test('OpenCode: its own server is asked for a code and held until GitHub answers, on a home of the run’s own, and only its Copilot entry reaches the member’s', async (t) => {
  const home = engineHome(t);
  // What the member's home holds already, some of it a session's doing: a key from before, and an entry that names a server to fetch settings from.
  const there = { openrouter: { type: 'api', key: 'sk-or-there-before' }, 'https://settings.example': { type: 'wellknown', key: 'SOME_TOKEN', token: 'left-by-a-session' } };
  mkdirSync(path.join(home, 'opencode'), { recursive: true });
  writeFileSync(path.join(home, 'opencode', 'auth.json'), JSON.stringify(there));
  const server = await openCodeServe(t);
  const p = printed();
  const done = signin({ engine: 'opencode' }, { env: { FLEETWRIGHT_ENGINE_HOME: home }, out: p.out, spawnEngine: server.spawn });
  await until(() => p.lines().length === 1, 'the page and the code');
  // The code is read out of OpenCode's sentence; the page is as it gave it.
  assert.deepEqual(p.lines()[0], { engine: 'opencode', signin: 'code', url: 'https://github.com/login/device', code: 'WXYZ-1234', expiresInMinutes: SIGNIN_MINUTES });
  // On loopback, on a port of its choosing, with a password for this run. And nowhere it reads from is the member's home:
  // its data, where the entry a session left would have been read, its settings, its state, its cache, its home and where it starts.
  assert.deepEqual([server.started.cmd, server.started.argv], ['opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0']]);
  const reads = [...['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'HOME'].map((name) => String(server.started.env?.[name])), String(server.started.cwd)];
  const own = path.dirname(reads[0]);
  for (const dir of reads) assert.ok(dir.startsWith(own + path.sep) && !dir.startsWith(home), `OpenCode was started reading ${dir}`);
  assert.equal(existsSync(path.join(reads[0], 'opencode', 'auth.json')), false, 'nothing of the home was put where OpenCode reads');
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
  // The home gains the one entry: what was there stays, and what else the engine wrote does not come with it.
  const file = path.join(home, 'opencode', 'auth.json');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...there, 'github-copilot': { type: 'oauth', refresh: TOKEN, access: TOKEN, expires: 0 } });
  assert.equal(signedInAt('opencode', home)?.file, file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(existsSync(own), false, 'the run’s own home is gone with the run');
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

test('OpenCode: a page that is not GitHub’s own gets no code, and an OpenCode that cannot reach GitHub says which host', async (t) => {
  // Whatever answers the request for a code, a plugin a session left included: only GitHub's own page is ever printed.
  for (const page of ['https://github.com.login-device.example/login/device', 'https://github.com/login/device?next=https://example.com', 'http://github.com/login/device']) {
    const server = await openCodeServe(t, { page });
    const p = printed();
    assert.equal(await ends(signin({ engine: 'opencode' }, { env: { FLEETWRIGHT_ENGINE_HOME: engineHome(t) }, out: p.out, spawnEngine: server.spawn }), `a code was given for ${page}`), 0);
    assert.deepEqual(p.lines(), [{ engine: 'opencode', signin: 'done', state: 'failed', detail: "it named a page that is not GitHub's own sign-in page, so no code is shown" }], page);
  }
  assert.equal(SIGNIN_PAGES.opencode, 'https://github.com/login/device');
  // "UnknownError" was the whole of it.
  const server = await openCodeServe(t, { github: 'unreachable' });
  const p = printed();
  assert.equal(await signin({ engine: 'opencode' }, { env: { FLEETWRIGHT_ENGINE_HOME: engineHome(t) }, out: p.out, spawnEngine: server.spawn }), 0);
  assert.deepEqual(p.lines(), [{ engine: 'opencode', signin: 'done', state: 'failed', detail: 'it could not ask GitHub for a code, and gave no reason. This machine must be able to reach github.com' }]);
});

test('OpenCode: a server that never comes up is said in words that read after the engine’s name', async (t) => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill() {} });
  const p = printed();
  assert.equal(await signin({ engine: 'opencode' }, { env: { FLEETWRIGHT_ENGINE_HOME: engineHome(t) }, out: p.out, spawnEngine: () => child, startMs: 30 }), 0);
  // It read "OpenCodes server did not start": the apostrophe was not one a line keeps.
  assert.deepEqual(p.lines(), [{ engine: 'opencode', signin: 'done', state: 'failed', detail: 'its server did not start' }]);
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
    // A clause, for the two places that put the engine's name in front of it: "OpenCode did not sign in: ".
    detail: 'GitHub declined the code or it ran out, and OpenCode does not say which (ProviderAuthOauthCallbackFailed)',
  });
});

test('OpenCode: a failure that comes as the code’s life ends is the code running out, and one that comes before is not', async (t) => {
  // OpenCode passes on a code that ran out exactly as it passes on one that was declined.
  // A code with four seconds to live is in its last poll from the start; one with fifteen minutes is not.
  for (const [capMs, state] of /** @type {const} */ ([[4000, 'expired'], [SIGNIN_MINUTES * 60_000, 'failed']])) {
    const home = engineHome(t);
    const server = await openCodeServe(t);
    const p = printed();
    const done = signin({ engine: 'opencode' }, { env: { FLEETWRIGHT_ENGINE_HOME: home }, out: p.out, spawnEngine: server.spawn, capMs });
    await until(() => p.lines().length === 1 && server.seen.length === 2, 'the code out and the callback held');
    server.github('failed');
    assert.equal(await done, 0);
    assert.equal(p.lines()[1].state, state, `a code that lasts ${capMs} ms`);
    assert.equal(signedInAt('opencode', home), null);
  }
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

test('OpenCode: a sign out takes its Copilot entry out of the home’s file, starts no engine to do it, and leaves a key beside it', async (t) => {
  const home = engineHome(t);
  const file = path.join(home, 'opencode', 'auth.json');
  let spawned = 0;
  const out = () => {
    const p = printed();
    return signin({ engine: 'opencode', out: true }, { env: { FLEETWRIGHT_ENGINE_HOME: home }, out: p.out, spawnEngine: () => void (spawned += 1) }).then(() => p.lines());
  };
  // Nothing there is signed out already.
  assert.deepEqual(await out(), [{ engine: 'opencode', signin: 'done', state: 'signed_out' }]);
  assert.equal(existsSync(file), false);
  mkdirSync(path.join(home, 'opencode'), { recursive: true });
  writeFileSync(file, JSON.stringify({ 'github-copilot': copilotEntry(TOKEN), openrouter: { type: 'api', key: 'sk-or-kept' } }));
  assert.deepEqual(await out(), [{ engine: 'opencode', signin: 'done', state: 'signed_out' }]);
  assert.equal(signedInAt('opencode', home), null);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { openrouter: { type: 'api', key: 'sk-or-kept' } });
  // A file that does not read holds no entry OpenCode would use, and is left as OpenCode's own sign out leaves one: empty.
  writeFileSync(file, `{"github-copilot":{"type":"oauth","refresh":"${TOKEN}"`);
  assert.deepEqual(await out(), [{ engine: 'opencode', signin: 'done', state: 'signed_out' }]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
  // OpenCode's own sign out is this and no more (auth/index.ts, `remove`), so it is not started on a home a session writes.
  assert.equal(spawned, 0);
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

test('where each engine keeps its sign-in in an engine home, and what counts as one is what the engine itself would start on', (t) => {
  const home = engineHome(t);
  assert.deepEqual(homePaths('codex', home), { dir: path.join(home, 'codex'), file: path.join(home, 'codex', 'auth.json'), env: { CODEX_HOME: path.join(home, 'codex') } });
  assert.deepEqual(homePaths('opencode', home), { dir: path.join(home, 'opencode'), file: path.join(home, 'opencode', 'auth.json'), env: { XDG_DATA_HOME: home } });
  assert.equal(homePaths('claude-code', home), null);
  assert.equal(signedInAt('codex', home), null, 'nothing there');
  for (const dir of ['codex', 'opencode']) mkdirSync(path.join(home, dir));
  // EACH ROW IS WHAT THE REAL ENGINE SAID OF THAT FILE, asked with no network:
  // Codex 0.171.0 through `account/read`, OpenCode 1.19.6 through the
  // providers its server lists as connected.
  const id = fakeJwt({ email: 'debbie@example.com' });
  const rows = /** @type {Array<[string, boolean, string, string]>} */ ([
    ['codex', true, 'the file Codex writes', codexSignIn()],
    ['codex', true, 'its three tokens and nothing else', JSON.stringify({ tokens: { id_token: id, access_token: 'at-not-a-signed-token', refresh_token: 'rt-0123456789' } })],
    ['codex', true, 'an API key: `{ "type": "apiKey" }` to Codex', '{"OPENAI_API_KEY":"sk-made-up-0123456789","tokens":null}'],
    ['codex', false, 'a refresh token alone: `account: null` to Codex', '{"tokens":{"refresh_token":"rt-0123456789"}}'],
    ['codex', false, 'an id token that is no signed token’s shape', JSON.stringify({ tokens: { id_token: 'id-0123456789', access_token: 'at-0123456789', refresh_token: 'rt-0123456789' } })],
    ['codex', false, 'no access token', JSON.stringify({ tokens: { id_token: id, refresh_token: 'rt-0123456789' } })],
    ['codex', false, 'an empty file', ''],
    ['codex', false, 'a file that does not read', '{"tokens":'],
    ['opencode', true, 'the entry OpenCode writes', JSON.stringify({ 'github-copilot': copilotEntry('gho_made_up_0123456789') })],
    ['opencode', true, 'the entry this runner writes for a pasted token', '{"github-copilot":{"type":"oauth","refresh":"gho_made_up_0123456789","access":"","expires":0}}'],
    ['opencode', false, 'an entry that is not whole, which OpenCode drops', '{"github-copilot":{"type":"oauth","refresh":"gho_made_up_0123456789"}}'],
    ['opencode', false, 'another provider’s key alone', '{"openrouter":{"type":"api","key":"sk-or"}}'],
  ]);
  for (const [engine, counts, what, text] of rows) {
    writeFileSync(path.join(home, engine, 'auth.json'), text);
    assert.equal(Boolean(signedInAt(engine, home)), counts, `${engine}: ${what}`);
  }
});

// ── Whether a home holds a sign-in made on the machine ──────────────────────

test('asked whether a home holds a sign-in, the runner says so in one line from the file alone: made here or pasted, and when it was written, with no token and no engine', (t) => {
  // What a box asks when it did not hear how a sign-in ended (src/core/engine-signin.js, #ask).
  const home = engineHome(t);
  const ask = (/** @type {string} */ engine, env = { FLEETWRIGHT_ENGINE_HOME: home }) => {
    /** @type {string[]} */
    const raw = [];
    assert.equal(signedIn({ engine }, { env, out: (s) => void raw.push(s) }), 0);
    const said = raw.join('');
    assert.ok(said.endsWith('\n') && said.trim().split('\n').length === 1, 'not one line');
    assert.ok(!/rt-made-up|gho_made_up|eyJ/.test(said), `something of the file is in the line: ${said}`);
    return JSON.parse(said);
  };
  // NOTHING THERE.
  assert.deepEqual(ask('codex'), { engine: 'codex', signin: 'is', signedIn: false, pasted: false, writtenAt: null });
  assert.deepEqual(ask('opencode'), { engine: 'opencode', signin: 'is', signedIn: false, pasted: false, writtenAt: null });
  // A SIGN-IN CODEX WROTE, as a sign-in on this machine leaves it: there, not pasted, and when.
  const before = Date.now() - 2000;
  mkdirSync(path.join(home, 'codex'), { recursive: true });
  writeFileSync(path.join(home, 'codex', 'auth.json'), codexSignIn());
  const made = ask('codex');
  assert.deepEqual({ ...made, writtenAt: 0 }, { engine: 'codex', signin: 'is', signedIn: true, pasted: false, writtenAt: 0 });
  assert.ok(made.writtenAt >= before && made.writtenAt <= Date.now() + 2000, `not when the file was written: ${made.writtenAt}`);
  // THE BOX'S COPY OF A PASTED ONE, as `stage` leaves it: there, and not a sign-in made here.
  assert.equal(stage('codex', codexSignIn(), home, null, home).ok, true);
  assert.equal(existsSync(path.join(home, 'codex', PASTED)), true);
  assert.deepEqual([ask('codex').signedIn, ask('codex').pasted], [true, true]);
  // A file Codex would not start on is no sign-in, whatever is beside it.
  writeFileSync(path.join(home, 'codex', 'auth.json'), '{"tokens":{"refresh_token":"rt-made-up-0123456789"}}');
  assert.deepEqual([ask('codex').signedIn, ask('codex').pasted, ask('codex').writtenAt], [false, false, null]);
  // OPENCODE: the entry its own sign-in writes, and the one `stage` writes for a pasted token.
  mkdirSync(path.join(home, 'opencode'), { recursive: true });
  writeFileSync(path.join(home, 'opencode', 'auth.json'), JSON.stringify({ 'github-copilot': copilotEntry('gho_made_up_0123456789') }));
  assert.deepEqual([ask('opencode').signedIn, ask('opencode').pasted], [true, false]);
  rmSync(path.join(home, 'opencode', 'auth.json'));
  assert.equal(stage('opencode', 'gho_made_up_0123456789', home, null, home).ok, true);
  assert.deepEqual([ask('opencode').signedIn, ask('opencode').pasted], [true, true]);
  // NOT ASKED IS NOT "NO": no home to look in, or an engine this runner does not sign in, is null.
  assert.equal(ask('codex', {}).signedIn, null);
  assert.equal(ask('claude-code').signedIn, null);
});
