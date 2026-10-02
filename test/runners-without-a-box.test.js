// Starting a runner with no permanent box anywhere in the fleet.
//
//   node --test test/runners-without-a-box.test.js
//
// The three things a box used to be needed for, each now done without one:
// the dispatch (the person's own device makes it, with a ticket the
// coordinator mints), the runner-repository check (the minting Worker makes
// it, as the GitHub App), and the GitHub sign-in the device dispatches with
// (the device runs GitHub's page itself, and the minting Worker finishes the
// exchange with the client secret that stays there). Driven through the real
// coordinator core and the real minting Worker entry, with GitHub stood in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { callbackPage } from '../src/fleet/coordinator/oauth.js';
import { RunnerTickets } from '../src/fleet/coordinator/runner-tickets.js';
import { newDepositKey, newSealKey, seal, open, GITHUB_REQUEST_AAD, GITHUB_REPLY_AAD } from '../src/fleet/seal.js';
import minterWorker from '../worker/src/minter.js';

const OWNER = 'eli@example.com';
// GitHub's refresh tokens are `ghr_` and some seventy characters; these are that shape.
const FIRST_REFRESH = `ghr_first${'0'.repeat(60)}`;
const SECOND_REFRESH = `ghr_second${'0'.repeat(60)}`;
const ORIGIN = 'https://fleet.test';
const json = (/** @type {number} */ status, /** @type {any} */ body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Swap the global fetch for GitHub's stand-in for one test. @param {(url: URL, init: any) => Response|Promise<Response>} github */
function githubIs(github) {
  const real = globalThis.fetch;
  /** @type {Array<{ url: string, init: any }>} */
  const calls = [];
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.href, init });
    if (u.hostname === 'github.com' || u.hostname === 'api.github.com') return github(u, init);
    return real(url, init);
  });
  return { calls, restore: () => { globalThis.fetch = real; } };
}

/** The minting Worker, bound to a core as fleet-do.js binds it. @param {Record<string, string>} env */
function minterFor(env) {
  /** @param {string} path @param {unknown} ask */
  const call = async (path, ask) =>
    (await minterWorker.fetch(new Request(`https://minter.internal${path}`, { method: 'POST', body: JSON.stringify(ask) }), env)).json();
  return {
    mint: (/** @type {any} */ ask) => call('/mint', ask),
    claude: (/** @type {string} */ route, /** @type {any} */ ask) => call(`/claude/${route}`, ask),
    runnerRepo: (/** @type {any} */ ask) => call('/runner-repo', ask),
    github: (/** @type {any} */ ask) => call('/github/token', ask),
  };
}

test('a device is given everything it needs to start a runner itself, and no box is asked', async () => {
  const core = new CoordinatorCore({ runnerRepo: 'acme/runners' });
  const r = await core.prepareRunnerDispatch({ email: OWNER }, { platform: 'macos', minutes: 90, start: { title: 'build the app' } }, ORIGIN);
  assert.equal(r.ok, true, r.text);
  assert.equal(r.repo, 'acme/runners');
  assert.equal(r.workflow, 'runner-macos.yml');
  assert.deepEqual(Object.keys(r.inputs).sort(), ['coordinator', 'minutes', 'ticket']);
  assert.equal(r.inputs.minutes, '90');
  assert.equal(r.inputs.coordinator, ORIGIN);

  // THE SAME TICKET `provision` MINTS: it admits a job from that repository's
  // runner workflow, it is the person's, and it carries the session to start.
  assert.ok(RunnerTickets.looksLikeTicket(r.inputs.ticket));
  const admitted = await core.runnerAdmission(r.inputs.ticket, { repositories: [], workflowRef: [] });
  assert.deepEqual(admitted, { repositories: ['acme/runners'], workflowRef: ['acme/runners/.github/workflows/runner-macos.yml@'] });
  const spent = await core.runnerTickets.redeem(r.inputs.ticket);
  assert.equal(spent?.owner, OWNER);
  assert.equal(spent?.platform, 'macos');
  assert.deepEqual(spent?.start, { title: 'build the app' });
  assert.ok(!JSON.stringify(core.events).includes(r.inputs.ticket), 'the ticket is never in the event ring');

  // And the refusals say why, as provision's do.
  assert.equal((await core.prepareRunnerDispatch(null, { platform: 'macos' }, ORIGIN)).error?.code, 'not_signed_in');
  assert.equal((await core.prepareRunnerDispatch({ email: OWNER }, { platform: 'amiga' }, ORIGIN)).error?.code, 'bad_params');
  const nowhere = new CoordinatorCore({});
  assert.equal((await nowhere.prepareRunnerDispatch({ email: OWNER }, { platform: 'linux' }, ORIGIN)).error?.code, 'not_configured');
});

test('the minting Worker checks a runner repository as the App, and the coordinator saves it with no box', async (t) => {
  const app = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = {
    FLEETWRIGHT_GITHUB_APP_KEY: app.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    FLEETWRIGHT_GITHUB_CLIENT_ID: 'Iv23liTEST',
  };
  /** @type {Record<string, any>} */
  let world = {};
  const gh = githubIs((u, init) => {
    const path = u.pathname.toLowerCase();
    if (path === '/repos/eli/runners/installation') {
      return world.installed === false ? json(404, {}) : json(200, { id: 9, permissions: { actions: world.actions ?? 'write', contents: 'write', metadata: 'read' } });
    }
    if (path === '/app/installations/9/access_tokens') {
      const body = JSON.parse(init.body);
      world.minted = body;
      return json(201, { token: 'ghs_read', expires_at: new Date(Date.now() + 3600e3).toISOString(), permissions: body.permissions, repositories: [{ full_name: 'Eli/Runners' }] });
    }
    if (String(init.headers?.authorization) !== 'Bearer ghs_read') return json(401, {});
    if (path === '/repos/eli/runners') return json(200, { full_name: 'Eli/Runners', private: world.private ?? false });
    if (path === '/repos/eli/runners/contents/.github/workflows') {
      return json(200, (world.workflows ?? ['runner-linux.yml', 'runner-macos.yml', 'ci.yml']).map((name) => ({ name })));
    }
    return json(404, {});
  });
  t.after(gh.restore);

  const core = new CoordinatorCore({ minter: minterFor(env) });
  // No box is connected at all: a box would have been the only way before.
  const saved = await core.setRunnerRepo({ email: OWNER }, 'eli/runners');
  assert.equal(saved.ok, true, String(saved.text));
  assert.equal(saved.repo, 'Eli/Runners', 'saved as GitHub spells it');
  assert.deepEqual(saved.runnerRepo?.platforms, ['macos', 'linux']);
  // The token the minter used could read and nothing more, and stayed there.
  assert.deepEqual(world.minted, { repositories: ['runners'], permissions: { metadata: 'read', contents: 'read' } });
  assert.ok(!JSON.stringify(saved).includes('ghs_read'));

  /** @type {Array<[string, Record<string, any>, RegExp]>} */
  const cases = [
    ['an account the App is not installed on', { installed: false }, /not installed on eli\/runners/],
    ['an installation without Actions write', { actions: 'read' }, /without Actions write/],
    ['a private repository', { private: true }, /is private/],
    ['no runner workflows', { workflows: ['ci.yml'] }, /none of the runner workflows/],
  ];
  for (const [name, w, expected] of cases) {
    world = w;
    const r = await new CoordinatorCore({ minter: minterFor(env) }).setRunnerRepo({ email: OWNER }, 'eli/runners');
    assert.equal(r.ok, false, name);
    assert.match(String(r.text), expected, name);
  }

  // A MINTER WITH NO APP KEY sends the question back to a box, which is the
  // old path, still there for a fleet that keeps the key on a box.
  const keyless = new CoordinatorCore({ minter: minterFor({}) });
  const fellBack = await keyless.setRunnerRepo({ email: OWNER }, 'eli/runners');
  assert.equal(fellBack.ok, false);
  assert.match(String(fellBack.text), /permanent|box|host/i, 'with no box either, it says so');
});

test('a phone signs in to GitHub itself, and neither the coordinator nor the page sees the token', async (t) => {
  const deposit = await newDepositKey();
  const env = {
    FLEETWRIGHT_MINTER_DEPOSIT_KEY: deposit.secret,
    FLEETWRIGHT_GITHUB_CLIENT_ID: 'Iv23liTEST',
    FLEETWRIGHT_GITHUB_CLIENT_SECRET: 'the-client-secret',
  };
  /** @type {any[]} */
  const exchanges = [];
  const gh = githubIs((u, init) => {
    if (u.hostname === 'github.com' && u.pathname === '/login/oauth/access_token') {
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      exchanges.push(form);
      if (form.client_secret !== 'the-client-secret') return json(200, { error: 'incorrect_client_credentials' });
      if (form.grant_type === 'refresh_token') {
        return form.refresh_token === FIRST_REFRESH
          ? json(200, { access_token: 'ghu_second', expires_in: 28800, refresh_token: SECOND_REFRESH, refresh_token_expires_in: 15897600 })
          : json(200, { error: 'bad_refresh_token' });
      }
      return form.code === 'goodcode123' && form.code_verifier === 'v'.repeat(64)
        ? json(200, { access_token: 'ghu_first', expires_in: 28800, refresh_token: FIRST_REFRESH, refresh_token_expires_in: 15897600 })
        : json(200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired' });
    }
    if (u.pathname === '/user') return json(200, { id: 42, login: 'eli' });
    return json(404, {});
  });
  t.after(gh.restore);

  const core = new CoordinatorCore({ githubApp: { clientId: 'Iv23liTEST', clientSecret: 'the-client-secret' }, minter: minterFor(env) });

  // 1. WHAT THE DEVICE IS GIVEN TO OPEN GITHUB'S PAGE: a public client id and
  // the callback, and not the secret.
  const start = core.githubDeviceStart(ORIGIN);
  assert.deepEqual(start, { ok: true, clientId: 'Iv23liTEST', redirectUri: `${ORIGIN}/oauth/github/callback`, statePrefix: 'd.' });

  // 2. GITHUB SENDS THE BROWSER BACK; the coordinator hands the code to the
  // app by its scheme and exchanges nothing.
  const state = `d.${'s'.repeat(32)}`;
  const back = await core.finishGithubAuthorization({ code: 'goodcode123', state, origin: ORIGIN });
  assert.equal(back.ok, true);
  assert.equal(back.device, `fleetwright://github?code=goodcode123&state=${state}`);
  assert.match(callbackPage(back), /location\.replace\("fleetwright:\/\/github\?code=goodcode123&state=d\.s+"\)/);
  assert.equal(exchanges.length, 0, 'the coordinator made no exchange');
  // A state that is not a device's shape is not passed on, and nothing from
  // the request can steer where the page goes.
  assert.equal((await core.finishGithubAuthorization({ code: 'x"><script>', state, origin: ORIGIN })).ok, false);

  // 3. THE DEVICE FINISHES IT through the minter, sealed both ways.
  const phone = await newSealKey();
  /** @param {Record<string, unknown>} body */
  const ask = async (body) => {
    const sealed = await seal({ to: deposit.publicKey, aad: GITHUB_REQUEST_AAD, payload: { v: 1, reply: phone.publicKey, at: Date.now(), ...body } });
    return core.githubDeviceToken({ email: OWNER }, { sealed });
  };
  const done = await ask({ grant: 'code', code: 'goodcode123', verifier: 'v'.repeat(64), redirectUri: start.redirectUri });
  assert.equal(done.ok, true, String(done.text));
  assert.ok(!JSON.stringify(done).includes('ghu_first'), 'the coordinator relays ciphertext only');
  const token = await open({ privateKey: phone.privateKey, publicKey: phone.publicKey, aad: GITHUB_REPLY_AAD, sealed: /** @type {any} */ (done.sealed) });
  assert.equal(token.accessToken, 'ghu_first');
  assert.equal(token.refreshToken, FIRST_REFRESH);
  assert.equal(token.login, 'eli');
  assert.ok(token.expiresAt > Date.now());
  // The exchange carried the verifier and the client secret, which only the
  // minter had.
  assert.equal(exchanges[0].code_verifier, 'v'.repeat(64));
  assert.equal(exchanges[0].client_secret, 'the-client-secret');

  // 4. RENEWAL, the same way.
  const renewed = await ask({ grant: 'refresh', refreshToken: FIRST_REFRESH });
  assert.equal(renewed.ok, true, String(renewed.text));
  const second = await open({ privateKey: phone.privateKey, publicKey: phone.publicKey, aad: GITHUB_REPLY_AAD, sealed: /** @type {any} */ (renewed.sealed) });
  assert.equal(second.accessToken, 'ghu_second');

  // 5. AND WHAT IS REFUSED: a code without its verifier, an old request, a
  // request sealed to another key, and a fleet with no secret in the minter.
  assert.match(String((await ask({ grant: 'code', code: 'goodcode123', verifier: 'w'.repeat(64), redirectUri: start.redirectUri })).text), /incorrect or expired/);
  const stale = await seal({ to: deposit.publicKey, aad: GITHUB_REQUEST_AAD, payload: { v: 1, reply: phone.publicKey, at: Date.now() - 11 * 60_000, grant: 'refresh', refreshToken: FIRST_REFRESH } });
  assert.equal((await core.githubDeviceToken({ email: OWNER }, { sealed: stale })).error?.code, 'stale');
  const other = await newDepositKey();
  const elsewhere = await seal({ to: other.publicKey, aad: GITHUB_REQUEST_AAD, payload: { v: 1, reply: phone.publicKey, at: Date.now(), grant: 'refresh', refreshToken: FIRST_REFRESH } });
  assert.equal((await core.githubDeviceToken({ email: OWNER }, { sealed: elsewhere })).error?.code, 'unsealed');
  const secretless = new CoordinatorCore({ githubApp: { clientId: 'Iv23liTEST' }, minter: minterFor({ ...env, FLEETWRIGHT_GITHUB_CLIENT_SECRET: '' }) });
  const sealedOk = await seal({ to: deposit.publicKey, aad: GITHUB_REQUEST_AAD, payload: { v: 1, reply: phone.publicKey, at: Date.now(), grant: 'refresh', refreshToken: FIRST_REFRESH } });
  assert.equal((await secretless.githubDeviceToken({ email: OWNER }, { sealed: sealedOk })).error?.code, 'not_configured');
});

test('the MCP server on a person\'s own computer starts a runner itself, and asks a box only when it cannot', async () => {
  /** @type {Array<{ url: string, body: any, auth: string }>} */
  const sent = [];
  /** @type {Record<string, any>} */
  let fleet = { dispatchRoute: true };
  /** @param {any} url @param {any} init */
  const fakeFetch = async (url, init = {}) => {
    const u = new URL(String(url));
    sent.push({ url: u.href, body: init.body ? JSON.parse(String(init.body)) : null, auth: String(init.headers?.authorization || '') });
    if (u.pathname === '/api/runners/dispatch') {
      if (!fleet.dispatchRoute) return json(404, {});
      return json(200, { ok: true, repo: 'eli/runners', workflow: 'runner-linux.yml', inputs: { minutes: '30', ticket: 'frt_x', coordinator: 'https://fleet.example' } });
    }
    if (u.pathname === '/api/intent') return json(200, { ok: true, text: 'a box dispatched it' });
    if (u.href === 'https://api.github.com/repos/eli/runners') return json(200, { default_branch: 'trunk' });
    if (u.pathname.endsWith('/dispatches')) return new Response(null, { status: 204 });
    return json(404, {});
  };
  const { McpServer } = await import('../src/mcp/server.js');
  /** @param {any} githubToken */
  const call = async (githubToken) => {
    /** @type {any[]} */
    const written = [];
    const server = new McpServer({
      coordinator: 'https://fleet.example', credential: 'fwk_test', fetch: /** @type {any} */ (fakeFetch), watchMs: 0, githubToken,
      write: (line) => written.push(JSON.parse(line)),
    });
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fleet_provision', arguments: { platform: 'linux', minutes: 30 } } }));
    return String(written[0]?.result?.content?.[0]?.text);
  };

  // WITH A TOKEN HERE: the coordinator mints and says where, and GitHub is
  // asked from this computer with the person's token, which the fleet never sees.
  const text = await call(() => 'gho_mine');
  assert.match(text, /from this computer/);
  const dispatch = sent.find((s) => s.url.endsWith('/dispatches'));
  assert.equal(dispatch?.auth, 'Bearer gho_mine');
  assert.deepEqual(dispatch?.body, { ref: 'trunk', inputs: { minutes: '30', ticket: 'frt_x', coordinator: 'https://fleet.example' } });
  for (const s of sent.filter((x) => new URL(x.url).hostname === 'fleet.example')) {
    assert.ok(!JSON.stringify(s).includes('gho_mine'), 'the GitHub token never goes to the fleet');
  }
  assert.ok(!sent.some((s) => s.url.endsWith('/api/intent')), 'no box was asked');

  // WITHOUT ONE, or against a coordinator too old for the route, a box does
  // it, as before.
  sent.length = 0;
  assert.equal(await call(() => null), 'a box dispatched it');
  assert.ok(sent.some((s) => s.url.endsWith('/api/intent')));
  fleet = { dispatchRoute: false };
  sent.length = 0;
  assert.equal(await call(() => 'gho_mine'), 'a box dispatched it');
  assert.ok(!sent.some((s) => new URL(s.url).hostname === 'api.github.com'), 'nothing was dispatched twice');
  // A token lookup that throws is no token, not a failed tool call.
  assert.equal(await call(() => { throw new Error('gh exploded'); }), 'a box dispatched it');
});

test('every way the MCP server\'s own dispatch can be refused says so, and none falls back to a second dispatch', async () => {
  const { McpServer } = await import('../src/mcp/server.js');
  /** @param {(url: URL) => Response|Promise<Response>} answer */
  const call = async (answer) => {
    /** @type {any[]} */
    const written = [];
    /** @type {string[]} */
    const urls = [];
    const server = new McpServer({
      coordinator: 'https://fleet.example', credential: 'fwk_test', watchMs: 0, githubToken: () => 'gho_mine',
      fetch: /** @type {any} */ (async (/** @type {any} */ url) => { urls.push(String(url)); return answer(new URL(String(url))); }),
      write: (line) => written.push(JSON.parse(line)),
    });
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fleet_provision', arguments: { platform: 'linux' } } }));
    const r = written[0]?.result;
    return { text: String(r?.content?.[0]?.text), isError: r?.isError === true, urls };
  };
  const plan = json(200, { ok: true, repo: 'eli/runners', workflow: 'runner-linux.yml', inputs: { minutes: '30', ticket: 'frt_x', coordinator: 'https://fleet.example' } });

  const revoked = await call(() => json(401, {}));
  assert.equal(revoked.isError, true);
  assert.match(revoked.text, /credential was refused/);

  const unreachable = await call(() => { throw new Error('ECONNREFUSED'); });
  assert.equal(unreachable.isError, true);
  assert.match(unreachable.text, /ECONNREFUSED/);

  const notYours = await call(() => json(200, { ok: false, text: 'Set a runner repository first.' }));
  assert.equal(notYours.isError, true);
  assert.equal(notYours.text, 'Set a runner repository first.');

  const githubSaysNo = await call((u) => (u.pathname === '/api/runners/dispatch' ? plan.clone() : json(403, {})));
  assert.equal(githubSaysNo.isError, true);
  assert.match(githubSaysNo.text, /403/);
  assert.ok(!githubSaysNo.urls.some((u) => u.endsWith('/api/intent')), 'a refused dispatch is not tried again through a box');
});

test('the token on a person\'s computer is GH_TOKEN, then GITHUB_TOKEN, then gh\'s own, and none is an answer', async () => {
  const { localGithubToken } = await import('../src/mcp/local-github.js');
  const never = () => { throw new Error('gh should not have been asked'); };
  assert.equal(localGithubToken({ env: { GH_TOKEN: ' gho_a \n', GITHUB_TOKEN: 'gho_b' }, exec: never }), 'gho_a');
  assert.equal(localGithubToken({ env: { GITHUB_TOKEN: 'gho_b' }, exec: never }), 'gho_b');
  /** @type {any[]} */
  const asked = [];
  assert.equal(localGithubToken({ env: {}, exec: (cmd, args) => { asked.push([cmd, ...args]); return 'gho_c\n'; } }), 'gho_c');
  assert.deepEqual(asked, [['gh', 'auth', 'token']]);
  assert.equal(localGithubToken({ env: {}, exec: () => { throw new Error('gh: not logged in'); } }), null);
  assert.equal(localGithubToken({ env: {}, exec: () => '' }), null);
});

test('the minter refuses a phone sign-in it cannot finish, each for its own reason', async () => {
  const { answerGithubToken } = await import('../src/fleet/minter/github.js');
  const { importDepositKey } = await import('../src/fleet/seal.js');
  const deposit = await newDepositKey();
  const phone = await newSealKey();
  const config = (/** @type {Partial<import('../src/fleet/minter/github.js').GithubConfig>} */ over = {}) => ({
    depositKey: () => importDepositKey(deposit.secret),
    clientId: 'Iv23liTEST',
    clientSecret: 'the-client-secret',
    fetchImpl: /** @type {any} */ (async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); }),
    ...over,
  });
  /** @param {Record<string, unknown>} body */
  const sealedWith = async (body) => ({ sealed: await seal({ to: deposit.publicKey, aad: GITHUB_REQUEST_AAD, payload: { v: 1, reply: phone.publicKey, at: Date.now(), ...body } }) });
  /** @param {unknown} ask @param {any} [over] */
  const code = async (ask, over) => /** @type {any} */ (await answerGithubToken(ask, config(over))).error?.code;

  assert.equal(await code(await sealedWith({ grant: 'refresh', refreshToken: FIRST_REFRESH }), { depositKey: async () => { throw new Error('not a JWK'); } }), 'bad_deposit_key');
  assert.equal(await code({ sealed: null }), 'bad_params');
  assert.equal(await code(await sealedWith({ v: 2, grant: 'refresh', refreshToken: FIRST_REFRESH })), 'bad_params');
  assert.equal(await code(await sealedWith({ grant: 'refresh', refreshToken: 'short' })), 'bad_params');
  assert.equal(await code(await sealedWith({ grant: 'password' })), 'bad_params');
  // A redirect anywhere but a fleet's own callback is refused before GitHub is asked.
  assert.equal(await code(await sealedWith({ grant: 'code', code: 'goodcode123', verifier: 'v'.repeat(64), redirectUri: 'https://evil.example/elsewhere' })), 'bad_params');
  assert.equal(await code(await sealedWith({ grant: 'refresh', refreshToken: FIRST_REFRESH })), 'github_unreachable');
  assert.equal(await code(await sealedWith({ grant: 'refresh', refreshToken: FIRST_REFRESH }), { fetchImpl: async () => json(500, {}) }), 'github_refused');
});
