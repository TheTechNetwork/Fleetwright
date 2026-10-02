// A person's Claude login on their own runner, instead of the runner
// repository's API key.
//
//   node --test test/claude-login.test.js
//
// Driven through the real pieces — the deposit tool, the coordinator core, the
// minting Worker with its storage object, a runner's sidecar, and the session
// staging on the runner — with only GitHub and the hub's HTTP standing in. The
// contract under test is what docs/runner-central.md claims: the login goes to
// the runner its owner started and to nothing else, and the coordinator that
// relays it both ways cannot read it, redirect it or re-aim it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Sidecar } from '../src/fleet/host/sidecar.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken } from '../src/core/api-token.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { forgetJwks } from '../src/fleet/coordinator/oidc.js';
import { newDepositKey } from '../src/fleet/seal.js';
import { depositClaudeLogin, MINTER_KEY_PATH } from '../src/fleet/claude-deposit.js';
import { saveRunnerLogin, runnerTokenFile } from '../src/core/runner-login.js';
import { ensureDirectConfig } from '../src/core/direct-config.js';
import { buildCommand } from '../src/core/claude.js';
import { Accounts } from '../src/core/accounts.js';
import minterWorker, { ClaudeLogins } from '../worker/src/minter.js';
import { actionsIssuer } from './helpers/actions-issuer.js';

const OWNER = 'eli@example.com';
const TOKEN = 'sk-ant-oat01-eli-subscription-0123456789abcdef';
const json = (/** @type {number} */ status, /** @type {any} */ body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A runner job the owner started in their own runner repository, as GitHub would describe it. */
const RUNNER_JOB = {
  repository: 'eli/runners',
  repository_owner: 'eli',
  repository_owner_id: 42,
  job_workflow_ref: 'eli/runners/.github/workflows/runner-linux.yml@refs/heads/main',
  event_name: 'workflow_dispatch',
  actor: 'eli',
  actor_id: 42,
};

/** The same job in the fleet's own runner repository, whose account the minter mints for. */
const FLEET_REPO = {
  repository: 'acme/runners',
  repository_owner: 'acme',
  repository_owner_id: 5,
  job_workflow_ref: 'acme/runners/.github/workflows/runner-macos.yml@refs/heads/main',
};

/**
 * The whole path, wired: a person's computer → coordinator → minting Worker,
 * and a runner's sidecar → coordinator → minting Worker → back.
 *
 * @param {{ tamper?: { up?: (frame: any) => any, down?: (frame: any) => any, key?: string }, noRoute?: boolean }} [opts]
 *   `noRoute`: the fleet's deploy gave the minter no path of its own, so the
 *   key lookup reaches the coordinator, which has none
 */
async function fleet(opts = {}) {
  forgetJwks();
  const issuer = await actionsIssuer();
  const deposit = await newDepositKey();

  // GitHub, as the minter asks it with a person's token: whose is this.
  const users = /** @type {Record<string, { id: number, login: string }>} */ ({
    gho_eli: { id: 42, login: 'eli' },
    gho_mallory: { id: 7, login: 'mallory' },
  });
  const beneath = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    const u = new URL(String(url));
    if (u.hostname !== 'api.github.com') return beneath(url, init);
    const who = users[String(init.headers?.authorization || '').replace(/^Bearer /, '')];
    return u.pathname === '/user' && who ? json(200, who) : json(401, {});
  });

  // The minting Worker's own storage object, with an in-memory storage under it.
  const rows = new Map();
  const logins = new ClaudeLogins({ storage: { get: async (k) => rows.get(k), put: async (k, v) => { rows.set(k, v); } } });
  const env = {
    FLEETWRIGHT_MINTER_DEPOSIT_KEY: deposit.secret,
    FLEETWRIGHT_GITHUB_MINT_OWNERS: 'acme',
    LOGINS: { idFromName: () => 'logins', get: () => ({ fetch: (/** @type {string} */ u, /** @type {any} */ i) => logins.fetch(new Request(u, i)) }) },
  };
  /** Every body the minter was sent, as it arrived. @type {any[]} */
  const toMinter = [];
  const core = new CoordinatorCore({
    minter: {
      mint: async () => ({ ok: false, text: 'not this test' }),
      claude: async (route, ask) => {
        toMinter.push(ask);
        const r = await (await minterWorker.fetch(new Request(`https://minter.internal/claude/${route}`, { method: 'POST', body: JSON.stringify(ask) }), env)).json();
        // A coordinator offering a key of its own choosing, in place of the minter's.
        return route === 'key' && opts.tamper?.key ? { ...r, key: opts.tamper.key } : r;
      },
    },
  });

  /**
   * The coordinator's two routes, as the deposit tool reaches them.
   * @param {string} person
   */
  const coordinatorFor = (person) => /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    // The minter's own path on the fleet's address, answered by the minter
    // because the deploy routes it there, past the coordinator.
    if (new URL(url).pathname === MINTER_KEY_PATH) {
      return opts.noRoute ? json(404, { ok: false }) : minterWorker.fetch(new Request(url), env);
    }
    assert.equal(new URL(url).pathname, '/api/claude-login');
    if ((init.method || 'GET') === 'GET') return json(200, await core.claudeLoginKey());
    return json(200, await core.depositClaudeLogin({ email: person }, JSON.parse(init.body)));
  });
  /** @param {{ github?: string, claude?: string|null, pin?: string|null, now?: () => number, person?: string }} [d] */
  const depositAs = (d = {}) =>
    depositClaudeLogin({
      coordinator: 'https://fleet.test',
      credential: 'fwk_test',
      pin: d.pin === undefined ? deposit.publicKey : d.pin,
      claude: d.claude === undefined ? TOKEN : d.claude,
      github: d.github ?? 'gho_eli',
      fetchImpl: coordinatorFor(d.person ?? OWNER),
      ...(d.now ? { now: d.now } : {}),
    });

  /**
   * A runner joining, started by whoever `job` says; resolves with what its
   * sidecar told the hub, and every frame it was sent.
   * @param {Record<string, unknown>} [job]
   * @param {{ jobToken?: (aud: string) => Promise<string>, send?: (frame: any) => any, mintTimeoutMs?: number }} [how]
   *   what goes wrong on the runner's side, when something does
   */
  const runnerJoins = async (job = {}, how = {}) => {
    /** @type {any[]} */
    const down = [];
    // The runner's own fleetwright, over its real loopback API.
    const stateDir = mkdtempSync(join(tmpdir(), 'fw-claude-hub-'));
    const cfg = /** @type {any} */ ({ stateDir, bind: '127.0.0.1', port: 0, token: '', hostname: 'gha', workdir: join(stateDir, 'work'), maxSessions: 1, sandbox: false });
    const hubToken = ensureApiToken(cfg);
    const adapter = new HttpAdapter(cfg, { sessions: /** @type {any} */ ({ list: () => [], running: () => [] }), login: /** @type {any} */ ({}), token: hubToken });
    await adapter.start();
    const port = /** @type {any} */ (adapter.server).address().port;
    const hostId = `gha-runners-${Math.random().toString(36).slice(2, 8)}-1`;
    const runner = new Sidecar({
      hub: new HubClient({ baseUrl: `http://127.0.0.1:${port}`, token: hubToken }),
      transport: /** @type {any} */ ({
        origin: 'https://fleet.test',
        onMessage() {},
        start: async () => true,
        stop: async () => {},
        send: how.send ?? ((/** @type {any} */ frame) => {
          void core.onHostMessage(hostId, opts.tamper?.up ? opts.tamper.up(frame) : frame);
          return true;
        }),
      }),
      hostId,
      watch: false,
      healthIntervalMs: 0,
      renewIntervalMs: 0,
      jobToken: how.jobToken ?? (async (audience) => issuer.sign({ ...RUNNER_JOB, ...job, aud: audience })),
      ...(how.mintTimeoutMs ? { mintTimeoutMs: how.mintTimeoutMs } : {}),
    });
    core.registry.connect(
      hostId,
      (/** @type {any} */ frame) => {
        const f = opts.tamper?.down ? opts.tamper.down(frame) : frame;
        down.push(f);
        void runner.handle(f);
      },
      { ephemeral: true, owner: OWNER },
    );
    await runner.start();
    await runner.claudeLoginReady;
    await runner.stop();
    adapter.server?.close();
    // What the hub now holds: whose runner, which account's login, and the token.
    const record = JSON.parse(readFileSync(join(stateDir, 'runner-login.json'), 'utf8'));
    const told = { email: record.email, login: record.login, token: record.token ? readFileSync(runnerTokenFile(cfg), 'utf8') : null };
    rmSync(stateDir, { recursive: true, force: true });
    return { told, down };
  };

  const restore = () => {
    globalThis.fetch = beneath;
    issuer.restore();
  };
  return { core, rows, toMinter, depositAs, runnerJoins, depositKey: deposit.publicKey, restore };
}

test('a deposited login reaches the runner its owner started, and nothing between can read it', async (t) => {
  const f = await fleet();
  t.after(f.restore);

  const kept = await f.depositAs();
  assert.equal(kept.ok, true, kept.text);
  assert.equal(kept.login, 'eli');

  const { told, down } = await f.runnerJoins();
  assert.deepEqual(told, { email: OWNER, login: 'eli', token: TOKEN });
  // Their own runner repository, or the fleet's: the two places one is.
  assert.equal((await f.runnerJoins(FLEET_REPO)).told.token, TOKEN);

  // THE TOKEN NEVER CROSSES IN THE CLEAR: not in what the coordinator relayed
  // to the minter, not in what the minter keeps, not in what came back down.
  // Nor does the GitHub token that proved whose it is.
  for (const [where, bytes] of [['to the minter', f.toMinter], ['at rest', [...f.rows.values()]], ['to the runner', down]]) {
    assert.ok(!JSON.stringify(bytes).includes(TOKEN), `the Claude token is readable ${where}`);
    assert.ok(!JSON.stringify(bytes).includes('gho_eli'), `the GitHub token is readable ${where}`);
  }
  assert.ok(f.core.events.some((e) => e.event === 'claude.deposited' && e.actor === OWNER));
  assert.match(String(f.core.events.find((e) => e.event === 'runner.claude')?.text), /eli@example\.com.s runner .* was given eli Claude login/);
});

test('a runner is told to use its API key whenever the login is not its owner’s to have', async (t) => {
  const theirs = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const theirKey = Buffer.from(await crypto.subtle.exportKey('raw', theirs.publicKey)).toString('base64url');
  // The last is caught by the runner itself: the minter answered, and what
  // arrived does not open, so the coordinator's record says it was given one.
  /** @type {Array<[string, Parameters<typeof fleet>[0], Record<string, unknown>, RegExp|null]>} */
  const cases = [
    ['a runner somebody else started', {}, { ...FLEET_REPO, actor: 'mallory', actor_id: 7 }, /mallory has not deposited/],
    ['a runner in somebody else’s repository', {}, { repository: 'stranger/runners', repository_owner: 'stranger', repository_owner_id: 99,
      job_workflow_ref: 'stranger/runners/.github/workflows/runner-linux.yml@refs/heads/main' }, /neither eli.s own nor one this fleet mints for/],
    ['a workflow that is not a runner', {}, { job_workflow_ref: 'eli/runners/.github/workflows/ci.yml@refs/heads/main' }, /not one of the runner workflows/],
    ['a coordinator that asks with its own key', { tamper: { up: (fr) => (fr.kind === 'claude-login' ? { ...fr, key: theirKey } : fr) } }, {}, /did not verify/],
    // ALWAYS A DIFFERENT FIRST CHARACTER. This wrote `A` over it, which is no
    // change at all for the one ciphertext in 64 that already starts with
    // one, so the login opened and the case failed about that often.
    ['a coordinator that changes the answer', { tamper: { down: (fr) => (fr.sealed ? { ...fr, sealed: { ...fr.sealed, ct: `${fr.sealed.ct[0] === 'A' ? 'B' : 'A'}${fr.sealed.ct.slice(1)}` } } : fr) } }, {}, null],
  ];
  for (const [name, opts, job, expected] of cases) {
    const f = await fleet(opts);
    assert.equal((await f.depositAs()).ok, true, name);
    const { told } = await f.runnerJoins(job);
    f.restore();
    // "None, use the API key" is still an answer the hub is given — that is
    // what lets the session start at all — and the owner is still named.
    assert.deepEqual(told, { email: OWNER, login: null, token: null }, name);
    const refused = f.core.events.find((e) => e.event === 'runner.claude-refused');
    if (expected) assert.match(String(refused?.text), expected, name);
    else assert.ok(f.core.events.some((e) => e.event === 'runner.claude'), name);
  }
});

test('a deposit goes only to the key the minter gives, only fresh, and forgetting it sticks', async (t) => {
  // NO PIN NEEDED: the minter answers for its key at the fleet's address, and
  // that is the key the login is sealed to.
  {
    const f = await fleet();
    const r = await f.depositAs({ pin: null });
    f.restore();
    assert.equal(r.ok, true, r.text);
    assert.equal(f.rows.size, 1);
  }
  // NO ROUTE AND NO PIN: nothing but the coordinator says what the key is, so
  // its claim is shown for checking and nothing is sent.
  {
    const f = await fleet({ noRoute: true });
    const r = await f.depositAs({ pin: null });
    f.restore();
    assert.equal(r.code, 'no_pin');
    assert.equal(r.key, f.depositKey);
    assert.equal(f.rows.size, 0);
  }
  // A COORDINATOR OFFERING ITS OWN KEY while the minter answers with the real
  // one: refused with no pin set, before anything is sealed.
  {
    const theirs = await newDepositKey();
    const f = await fleet({ tamper: { key: theirs.publicKey } });
    const r = await f.depositAs({ pin: null });
    f.restore();
    assert.equal(r.code, 'key_mismatch');
    assert.match(r.text, /not the one its minter gives/);
    assert.equal(f.toMinter.filter((a) => a.sealed).length, 0);
  }
  // A KEY THAT IS NOT THE PIN, which is what a coordinator reading deposits
  // would have to offer. Refused before sealing, so it receives nothing.
  {
    const theirs = await newDepositKey();
    const f = await fleet({ tamper: { key: theirs.publicKey } });
    const r = await f.depositAs();
    f.restore();
    assert.equal(r.code, 'key_mismatch');
    assert.equal(f.toMinter.filter((a) => a.sealed).length, 0);
  }
  // STALE, AND REPLAYED: an envelope made eleven minutes ago, and one older
  // than the deposit already held, are both refused and change nothing.
  {
    const f = await fleet();
    t.after(f.restore);
    assert.equal((await f.depositAs({ now: () => Date.now() - 11 * 60_000 })).code, 'stale');
    assert.equal((await f.depositAs({ github: 'gho_nobody' })).code, 'not_github');
    assert.equal((await f.depositAs({ claude: 'not a token, a sentence' })).code, 'bad_token');
    assert.equal((await f.depositAs()).ok, true);
    assert.equal((await f.depositAs({ now: () => Date.now() - 60_000 })).code, 'stale');

    // FORGOTTEN, and an older deposit replayed afterwards does not bring it back.
    const gone = await f.depositAs({ claude: null });
    assert.equal(gone.ok, true, gone.text);
    assert.equal((await f.depositAs({ now: () => Date.now() - 30_000 })).code, 'stale');
    assert.equal((await f.runnerJoins()).told.token, null);
  }
});

test('on a runner the owner’s sessions run on their login and everybody else’s on the key; a permanent box still refuses', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-runner-login-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A claude that says what it was started with.
  const bin = join(dir, 'claude');
  writeFileSync(bin, '#!/bin/sh\necho "key=${ANTHROPIC_API_KEY:-none} token=${CLAUDE_CODE_OAUTH_TOKEN:-none}"\n');
  chmodSync(bin, 0o755);
  const KEY = 'sk-ant-api03-runner-repository-key-000000000000';
  const cfg = /** @type {any} */ ({ stateDir: join(dir, 'state'), hostname: 'gha-1', sandbox: false, claudeBin: bin, remoteControl: false, skipPermissions: false });
  const env = { ...process.env, ANTHROPIC_API_KEY: KEY };
  /** @param {string} actor */
  const run = (actor) => {
    const name = actor.replace(/\W/g, '');
    const staged = ensureDirectConfig(cfg, name, actor, { cwd: join(dir, 'work') });
    if (!staged.ok) return { refused: staged.message };
    const command = buildCommand(cfg, { name, configDir: staged.dir, runnerAuth: staged.auth });
    return { said: execFileSync('/bin/sh', ['-c', command], { env, encoding: 'utf8' }).trim(), command, dir: staged.dir };
  };

  // A PERMANENT BOX: nobody said this is a runner, so an API key in the
  // environment is still no reason to run a guest's session on it.
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = KEY;
  t.after(() => { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; });
  assert.match(String(run(`fleet:${OWNER}`).refused), /No Claude account to give this session/);

  // A RUNNER WITH THE OWNER'S LOGIN. Theirs runs on it, with the key unset so
  // the CLI cannot prefer it; the token is read at exec time, never written
  // into the command. Anybody else placed here runs on the key.
  assert.equal(saveRunnerLogin(cfg, { email: OWNER, login: 'eli', token: TOKEN }).ok, true);
  const owner = run(`fleet:${OWNER}`);
  assert.equal(owner.said, `key=none token=${TOKEN}`);
  assert.ok(!String(owner.command).includes(TOKEN));
  const other = run('fleet:bob@example.com');
  assert.equal(other.said, `key=${KEY} token=none`);
  // …and the CLI's "use this API key?" is answered in THAT session's own
  // config, which is the one it reads, by the key's last twenty characters.
  const state = JSON.parse(readFileSync(join(String(other.dir), '.claude.json'), 'utf8'));
  assert.deepEqual(state.customApiKeyResponses?.approved, [KEY.slice(-20)]);
  // …and the "running in Bypass Permissions mode" warning, which a real CLI
  // draws with "No, exit" focused before anything else. A permanent box gets
  // this from install.sh's settings; a runner never runs install.sh.
  for (const staged of [owner, other]) {
    const settings = JSON.parse(readFileSync(join(String(staged.dir), 'settings.json'), 'utf8'));
    assert.equal(settings.skipDangerousModePermissionPrompt, true);
  }

  // A RUNNER WHOSE OWNER HAS NONE: the key, for them too.
  saveRunnerLogin(cfg, { email: OWNER, login: null, token: null });
  assert.equal(run(`fleet:${OWNER}`).said, `key=${KEY} token=none`);

  // SOMEBODY WHO LINKED AN ACCOUNT, on a runner: their staged login is the
  // credential, and the repository's key is unset so the CLI cannot rank it
  // above that login and bill the repository instead.
  new Accounts(cfg.stateDir).save('carol@example.com', JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-carol' } }));
  const carol = run('fleet:carol@example.com');
  assert.equal(carol.said, 'key=none token=none');
  assert.ok(existsSync(join(String(carol.dir), '.credentials.json')), 'her login is the staged file');
  // …and on a permanent box the same linked account is left alone: an
  // operator who set ANTHROPIC_API_KEY there meant it.
  rmSync(join(cfg.stateDir, 'runner-login.json'));
  const boxCfg = { ...cfg };
  const staged = ensureDirectConfig(boxCfg, 'carolbox', 'fleet:carol@example.com', { cwd: join(dir, 'work') });
  assert.equal(staged.ok, true);
  assert.equal(/** @type {any} */ (staged).auth, undefined);
});

test('the coordinator answers every ask it will not relay, and never with silence', async () => {
  // A runner that waits on a frame nobody answers holds its first session for
  // the whole timeout; each of these is a refusal it hears at once instead.
  const job = 'eyJhbGciOiJSUzI1NiJ9.eyJhIjoxfQ.c2ln';
  const key = Buffer.alloc(65, 4).toString('base64url');
  /** @param {any} minter @param {{ ephemeral?: boolean, owner?: string|null }} host @param {any} frame */
  const ask = async (minter, host, frame) => {
    const core = new CoordinatorCore({ minter });
    /** @type {any[]} */
    const sent = [];
    core.registry.connect('h', (/** @type {any} */ f) => sent.push(f), /** @type {any} */ (host));
    await core.onHostMessage('h', { kind: 'claude-login', id: 'claude-0001', job, key, ...frame });
    return { core, sent };
  };
  const runner = { ephemeral: true, owner: OWNER };
  const down = { claude: async () => { throw new Error('connection refused'); } };
  /** @type {Array<[string, any, any, any, string]>} */
  const cases = [
    ['a permanent box', null, { ephemeral: false, owner: OWNER }, {}, 'not_a_runner'],
    ['a malformed ask', null, runner, { key: 'short' }, 'bad_params'],
    ['a fleet with no minter that keeps logins', null, runner, {}, 'no_minter'],
    ['a minter that is not there', down, runner, {}, 'minter_unreachable'],
  ];
  for (const [name, minter, host, frame, code] of cases) {
    const { sent } = await ask(minter, host, frame);
    assert.equal(sent.length, 1, name);
    assert.equal(sent[0].kind, 'minted', name);
    assert.equal(sent[0].id, 'claude-0001', name);
    assert.equal(sent[0].error?.code, code, name);
  }

  // A RUNNER ASKING OVER AND OVER is asking for something other than a login.
  const core = new CoordinatorCore({ minter: { mint: async () => ({}), claude: async () => ({ ok: false, error: { code: 'no_claude_login' }, text: 'none' }) } });
  /** @type {any[]} */
  const sent = [];
  core.registry.connect('h', (/** @type {any} */ f) => sent.push(f), /** @type {any} */ (runner));
  for (let i = 0; i < 6; i++) await core.onHostMessage('h', { kind: 'claude-login', id: `claude-000${i}`, job, key });
  assert.deepEqual(sent.map((f) => f.error?.code), ['no_claude_login', 'no_claude_login', 'no_claude_login', 'no_claude_login', 'no_claude_login', 'too_many']);

  // And the deposit routes say the same when there is nothing behind them.
  const bare = new CoordinatorCore({});
  assert.equal((await bare.claudeLoginKey()).error?.code, 'no_minter');
  assert.equal((await bare.depositClaudeLogin({ email: OWNER }, { sealed: 'not an object' })).error?.code, 'bad_params');
});

test('a minter given the wrong kind of deposit key says what it wanted', async () => {
  // The operator pastes the secret by hand; the likely mistakes are the pin
  // instead of the key, or some other key entirely.
  for (const [secret, expected] of [['BCg-the-pin-not-the-key', /not JSON/], ['{"kty":"RSA","n":"x","e":"AQAB","d":"y"}', /not a P-256 private key/]]) {
    const r = await (await minterWorker.fetch(new Request('https://minter.internal/claude/key', { method: 'POST', body: '{}' }), { FLEETWRIGHT_MINTER_DEPOSIT_KEY: secret, LOGINS: { idFromName: () => 'logins', get: () => ({}) } })).json();
    assert.equal(r.error?.code, 'bad_deposit_key');
    assert.match(r.text, expected);
  }
});

test('a runner that cannot ask still tells its hub it is a runner, and does not wait to', async (t) => {
  // Each leaves the runner's sessions on the API key rather than refused, and
  // the first session is not held for a question that cannot be answered.
  const f = await fleet();
  t.after(f.restore);
  /** @type {Array<[string, Parameters<typeof f.runnerJoins>[1], number]>} */
  const cases = [
    ['a workflow without id-token: write', { jobToken: async () => { throw new Error('no ACTIONS_ID_TOKEN_REQUEST_URL'); } }, 1000],
    ['a connection that is down', { send: () => false }, 1000],
    ['a coordinator from before Claude logins, which drops the frame', { send: () => true, mintTimeoutMs: 50 }, 1000],
  ];
  for (const [name, how, within] of cases) {
    const started = Date.now();
    const { told } = await f.runnerJoins({}, how);
    assert.deepEqual(told, { email: null, login: null, token: null }, name);
    assert.ok(Date.now() - started < within, `${name}: took ${Date.now() - started}ms`);
  }
});

