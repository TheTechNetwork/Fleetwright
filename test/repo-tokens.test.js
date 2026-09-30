// A runner reaching private code: git credentials for one repository, for an
// hour, minted by a permanent box and sealed to the runner that asked.
//
//   node --test test/repo-tokens.test.js
//
// Driven end to end through the real pieces — the runner's sidecar, the
// coordinator core, the minting box's sidecar — with only GitHub and the hub
// standing in. The contract under test is what docs/runner-central.md claims:
// the token cannot exceed the person or the repository, and the coordinator in
// the middle relays it without being able to read, redirect or re-aim it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jwtVerify } from 'jose';

import { Sidecar } from '../src/fleet/host/sidecar.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { ACTIONS_ISSUER, forgetJwks } from '../src/fleet/coordinator/oidc.js';
import { loadMinter } from '../src/core/repo-tokens.js';
import { serveRunnerBroker } from '../src/fleet/host/runner-broker.js';

const OWNER = 'eli@example.com';
const CLIENT_ID = 'Iv23liTEST';
const json = (/** @type {number} */ status, /** @type {any} */ body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** GitHub's Actions issuer: a key set for jose, and a signer for job tokens. */
async function actionsIssuer() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const keys = [{ ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'gha', alg: 'RS256', use: 'sig' }];
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    let host = '';
    try { host = new URL(String(url)).hostname; } catch { /* not a URL */ }
    return host === 'token.actions.githubusercontent.com' ? json(200, { keys }) : real(url, init);
  });
  const b64 = (/** @type {any} */ o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = async (/** @type {any} */ claims) => {
    const h = b64({ alg: 'RS256', kid: 'gha', typ: 'JWT' });
    const c = b64({ iss: ACTIONS_ISSUER, exp: Math.floor(Date.now() / 1000) + 600, run_id: '99', run_attempt: '1', ...claims });
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${c}`));
    return `${h}.${c}.${Buffer.from(sig).toString('base64url')}`;
  };
  return { sign, restore: () => { globalThis.fetch = real; } };
}

/** A runner job the owner started, as GitHub would describe it. */
const RUNNER_JOB = {
  repository: 'eli/runners',
  job_workflow_ref: 'eli/runners/.github/workflows/runner-linux.yml@refs/heads/main',
  event_name: 'workflow_dispatch',
  actor: 'eli',
  actor_id: 42,
};

/**
 * The whole path, wired: runner sidecar → coordinator → minting box → back.
 *
 * @param {{ job?: Record<string, unknown>, access?: any, owners?: string[], minter?: boolean,
 *   tamper?: { up?: (frame: any) => any, down?: (frame: any) => any } }} [opts]
 */
async function fleet(opts = {}) {
  forgetJwks();
  const issuer = await actionsIssuer();
  const app = generateKeyPairSync('rsa', { modulusLength: 2048 });
  /** What GitHub was asked with the App's credential. @type {Array<{ path: string, body: any, jwt: string }>} */
  const appCalls = [];
  const githubApp = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    const path = String(url).replace('https://api.github.com', '');
    appCalls.push({ path, body: init.body ? JSON.parse(init.body) : null, jwt: String(init.headers?.authorization || '').replace(/^Bearer /, '') });
    if (path === '/repos/Acme/App/installation') return json(200, { id: 9 });
    if (path === '/app/installations/9/access_tokens') {
      const body = JSON.parse(init.body);
      return json(201, {
        token: 'ghs_minted_secret',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: body.permissions,
        repositories: [{ full_name: 'Acme/App' }],
      });
    }
    return json(404, {});
  });
  /** What the minting box asked its hub. @type {Array<{ line: string, meta: any }>} */
  const hubAsks = [];
  const hub = /** @type {any} */ ({
    command: async (/** @type {string} */ line, /** @type {any} */ meta) => {
      hubAsks.push({ line, meta });
      const access = opts.access ?? { userId: '42', login: 'eli', repo: 'Acme/App', pull: true, push: true };
      return access === 'not connected'
        ? { ok: false, text: 'GitHub is not connected for you on this box.', needsConnection: 'github' }
        : { ok: true, text: 'ok', githubAccess: access };
    },
  });

  const core = new CoordinatorCore({});
  const box = new Sidecar({
    hub,
    transport: /** @type {any} */ ({ origin: 'https://fleet.test' }),
    hostId: 'box',
    watch: false,
    fetchImpl: githubApp,
    minter: opts.minter === false ? null : { key: app.privateKey, clientId: CLIENT_ID, owners: opts.owners ?? ['acme'] },
  });
  core.registry.connect('box', (/** @type {any} */ intent) => {
    void box.handle(intent).then((reply) => core.onHostMessage('box', reply));
  });

  /** Every frame the runner was sent, as it arrived. @type {any[]} */
  const down = [];
  const runner = new Sidecar({
    hub: /** @type {any} */ ({}),
    transport: /** @type {any} */ ({
      origin: 'https://fleet.test',
      send: (/** @type {any} */ frame) => core.onHostMessage('gha-runners-99-1', opts.tamper?.up ? opts.tamper.up(frame) : frame),
    }),
    hostId: 'gha-runners-99-1',
    watch: false,
    jobToken: async (audience) => issuer.sign({ ...RUNNER_JOB, ...(opts.job || {}), aud: audience }),
  });
  core.registry.connect(
    'gha-runners-99-1',
    (/** @type {any} */ frame) => {
      const f = opts.tamper?.down ? opts.tamper.down(frame) : frame;
      down.push(f);
      void runner.handle(f);
    },
    { ephemeral: true, owner: OWNER },
  );
  return { core, runner, appCalls, hubAsks, down, publicKey: createPublicKey(app.privateKey), restore: issuer.restore };
}

test('a runner gets a token for the one repository it asked for, and the coordinator carries only ciphertext', async (t) => {
  const f = await fleet();
  t.after(f.restore);

  const got = await f.runner.repoCredential({ provider: 'github', repo: 'acme/app' });
  assert.equal(got.ok, true, got.ok ? '' : got.message);
  assert.equal(got.ok && got.env.GH_TOKEN, 'ghs_minted_secret');

  // THE PERSON'S HALF was asked of the hub as that person, and the line names
  // the repository and nothing else.
  assert.deepEqual(f.hubAsks.map((a) => a.line), ['/githubaccess acme/app']);
  assert.equal(f.hubAsks[0].meta.actor, `fleet:${OWNER}`);

  // THE APP'S HALF: one repository by name, write because the person can push,
  // under a JWT the App's own key signed with the client id as issuer.
  const mint = f.appCalls.find((c) => c.path.endsWith('/access_tokens'));
  assert.deepEqual(mint?.body, { repositories: ['App'], permissions: { contents: 'write', pull_requests: 'write' } });
  const { payload } = await jwtVerify(String(mint?.jwt), f.publicKey, { issuer: CLIENT_ID });
  assert.ok(Number(payload.exp) - Number(payload.iat) <= 600, 'GitHub refuses an App JWT longer than ten minutes');

  // What crossed the coordinator is sealed: the token is nowhere in it.
  assert.equal(f.down.length, 1);
  assert.ok(!JSON.stringify(f.down).includes('ghs_minted_secret'));
  const event = f.core.events.find((e) => e.event === 'runner.token');
  assert.match(String(event?.text), /eli@example\.com.s runner gha-runners-99-1 was given a token for Acme\/App by box/);

  // Held for the hour: a second fetch in the same repository mints nothing.
  const again = await f.runner.repoCredential({ provider: 'github', repo: 'Acme/App' });
  assert.equal(again.ok && again.env.GH_TOKEN, 'ghs_minted_secret');
  assert.equal(f.appCalls.filter((c) => c.path.endsWith('/access_tokens')).length, 1);
});

test('the token never exceeds the person, the repository, or the runner that asked', async (t) => {
  /** @type {Array<[string, Parameters<typeof fleet>[0], string, RegExp]>} */
  const cases = [
    ['a runner somebody else started', { job: { actor: 'mallory', actor_id: 7 } }, 'acme/app', /started by mallory.*connection here is eli/],
    ['a workflow that is not a runner', { job: { job_workflow_ref: 'eli/runners/.github/workflows/ci.yml@refs/heads/main' } }, 'acme/app', /not one of the runner workflows/],
    ['a job not started by a dispatch', { job: { event_name: 'push' } }, 'acme/app', /not by a dispatch/],
    ['an account this box does not mint into', {}, 'guest/app', /only for acme, and guest is not one/],
    ['a repository the person cannot read', { access: { userId: '42', login: 'eli', repo: 'Acme/App', pull: false, push: false } }, 'acme/app', /cannot read Acme\/App/],
    ['a person with no GitHub connection on any box', { access: 'not connected' }, 'acme/app', /box \(GitHub not connected for you\)/],
    ['a fleet with no box holding the key', { minter: false }, 'acme/app', /box \(holds no GitHub App key\)/],
  ];
  for (const [name, opts, repo, expected] of cases) {
    const f = await fleet(opts);
    const got = await f.runner.repoCredential({ provider: 'github', repo });
    f.restore();
    assert.equal(got.ok, false, name);
    assert.match(got.ok ? '' : got.message, expected, name);
    assert.equal(f.appCalls.filter((c) => c.path.endsWith('/access_tokens')).length, 0, `${name}: nothing was minted`);
    assert.ok(f.core.events.some((e) => e.event === 'runner.token-refused'), `${name}: the refusal is on the record`);
  }
});

test('read access mints a read-only token', async (t) => {
  const f = await fleet({ access: { userId: '42', login: 'eli', repo: 'Acme/App', pull: true, push: false } });
  t.after(f.restore);
  const got = await f.runner.repoCredential({ provider: 'github', repo: 'acme/app' });
  assert.equal(got.ok, true);
  assert.deepEqual(f.appCalls.find((c) => c.path.endsWith('/access_tokens'))?.body.permissions, { contents: 'read' });
});

test('a coordinator that re-aims the request or reads the answer gets nothing it can use', async (t) => {
  // Each is something a compromised coordinator could try on the frame it
  // relays. GitHub signed the binding of repository and key, so changing either
  // on the way up is refused by the box; changing the answer on the way down
  // does not open.
  const theirs = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const theirKey = Buffer.from(await crypto.subtle.exportKey('raw', theirs.publicKey)).toString('base64url');
  /** @type {Array<[string, Parameters<typeof fleet>[0], RegExp]>} */
  const cases = [
    ['another repository', { tamper: { up: (fr) => ({ ...fr, repo: 'acme/secrets' }) } }, /did not verify/],
    ['its own key to seal to', { tamper: { up: (fr) => ({ ...fr, key: theirKey }) } }, /did not verify/],
    [
      'a changed answer',
      { tamper: { down: (fr) => (fr.sealed ? { ...fr, sealed: { ...fr.sealed, ct: `A${fr.sealed.ct.slice(1)}` } } : fr) } },
      /did not open/,
    ],
  ];
  for (const [name, opts, expected] of cases) {
    const f = await fleet(opts);
    const got = await f.runner.repoCredential({ provider: 'github', repo: 'acme/app' });
    f.restore();
    assert.equal(got.ok, false, name);
    assert.match(got.ok ? '' : got.message, expected, name);
  }
});

test('nobody can call mint, and a permanent box cannot ask for one', async (t) => {
  const f = await fleet();
  t.after(f.restore);
  const called = await f.core.dispatch({
    verb: 'mint',
    params: { repo: 'acme/app', job: 'a.b.c', key: 'A'.repeat(87) },
    actor: OWNER,
    requester: { email: OWNER, admin: false },
  });
  assert.equal(called.error?.code, 'coordinator_only');

  /** @type {any[]} */
  const toBox = [];
  f.core.registry.connect('box', (/** @type {any} */ frame) => toBox.push(frame));
  await f.core.onHostMessage('box', { kind: 'mint', id: 'mint-00000001', repo: 'acme/app', job: 'a.b.c', key: 'A'.repeat(87) });
  assert.equal(toBox[0]?.kind, 'minted');
  assert.equal(toBox[0]?.error?.code, 'not_a_runner');
});

test('a box half-configured as a minter says which half, and an empty owner list mints for nobody', () => {
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const read = () => pem;
  assert.deepEqual(loadMinter({}, read), { minter: null, problem: null });
  assert.match(String(loadMinter({ keyFile: '/k', clientId: 'Iv' }, read).problem), /MINT_OWNERS is empty/);
  assert.match(String(loadMinter({ keyFile: '/k', owners: ['acme'] }, read).problem), /CLIENT_ID is not set/);
  const ok = loadMinter({ credentialsDirectory: '/run/creds', clientId: 'Iv', owners: ['acme', 'Other'] }, read);
  assert.deepEqual(ok.minter?.owners, ['acme', 'Other']);
});

test('git on a runner asks the runner broker for the repository it is fetching', async (t) => {
  // The real seam: git's credential protocol, the helper every session uses,
  // and the runner's socket — with the sidecar's answer standing in.
  const dir = mkdtempSync(join(tmpdir(), 'runner-broker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socket = join(dir, 'broker.sock');
  /** @type {any[]} */
  const asked = [];
  const server = await serveRunnerBroker({
    path: socket,
    answer: async (ask) => {
      asked.push(ask);
      return { ok: true, provider: 'github', env: { GH_TOKEN: 'ghs_for_app' } };
    },
  });
  t.after(() => server.close());

  const helper = spawn(process.execPath, [new URL('../sandbox/credential.mjs', import.meta.url).pathname, 'get'], {
    env: { ...process.env, FLEETWRIGHT_RUNNER_BROKER: socket },
  });
  let out = '';
  helper.stdout.on('data', (c) => (out += c));
  helper.stdin.end('protocol=https\nhost=github.com\npath=acme/app.git\n\n');
  await new Promise((resolve) => helper.on('close', resolve));

  assert.deepEqual(asked, [{ provider: 'github', repo: 'acme/app' }]);
  assert.equal(out, 'username=x-access-token\npassword=ghs_for_app\n');
});
