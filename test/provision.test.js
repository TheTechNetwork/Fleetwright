// Asking for a machine that does not exist yet.
//
//   node --test test/
//
// The loop under test is: an agent asks the fleet for a runner, the coordinator
// decides whose it will be and mints a single-use ticket, a permanent host
// dispatches a workflow with THAT PERSON'S GitHub token, and the job presents
// the ticket when it enrols. Each of those steps is somewhere the ownership can
// quietly be lost, which is what most of these tests are about.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunnerTickets, TICKET_PREFIX } from '../src/fleet/coordinator/runner-tickets.js';
import { dispatchRunner, RUNNER_WORKFLOWS, MAX_MINUTES } from '../src/core/runners.js';
import { toCommandLine, commandMeta } from '../src/fleet/host/sidecar.js';
import { checkParams, VERBS } from '../src/fleet/protocol/intents.js';
import { readConfigFrame, buildConfigFrame, CONFIG_KEYS } from '../src/fleet/protocol/config-frame.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { HostRegistry } from '../src/fleet/coordinator/registry.js';
import { place } from '../src/fleet/coordinator/scheduler.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { verifyActionsToken, ACTIONS_ISSUER, forgetJwks } from '../src/fleet/coordinator/oidc.js';
import { Coordinator } from '../src/fleet/coordinator/server.js';
import { generateKeyPair } from '../src/fleet/crypto.js';

// --- the ticket ------------------------------------------------------------

test('a ticket is spent once and never again', async () => {
  // The single property that matters. A reusable value in a workflow input of a
  // public repository is a value anybody who can read the run can spend; a
  // single-use one is worth an attribution to whoever gets there first, once.
  const tickets = new RunnerTickets();
  const { token } = await tickets.mint({ owner: 'ELI@example.com', platform: 'macos' });

  const first = await tickets.redeem(token);
  assert.equal(first?.owner, 'eli@example.com', 'the owner is normalised, so two spellings are one person');
  assert.equal(await tickets.redeem(token), null);
});

test('a ticket expires, and an expired one is indistinguishable from a wrong one', async () => {
  let now = 1_000_000;
  const tickets = new RunnerTickets({ now: () => now, ttlMs: 60_000 });
  const { token } = await tickets.mint({ owner: 'eli@example.com', platform: 'linux' });
  now += 60_001;
  assert.equal(await tickets.redeem(token), null);
  // Both return null rather than a reason: a job cannot act on the difference,
  // and whoever is guessing should not be told which it was.
  assert.equal(await tickets.redeem(`${TICKET_PREFIX}_deadbeef_nonsense`), null);
});

test('a value with the wrong shape is refused without touching the store', async () => {
  const tickets = new RunnerTickets();
  const { token } = await tickets.mint({ owner: 'eli@example.com', platform: 'linux' });
  for (const bad of ['', 'fwr_something_else', `${TICKET_PREFIX}_only-two`, null, 42, {}]) {
    assert.equal(await tickets.redeem(/** @type {any} */ (bad)), null, JSON.stringify(bad));
  }
  // And the real one still works: a bad guess must not burn somebody's ticket.
  assert.ok(await tickets.redeem(token));
});

test('a runner token cannot be mistaken for a ticket', () => {
  // Separate stores, separate prefixes. The whole reason the enrolment route
  // asks the prefix first is so that one credential can never be accepted in
  // place of the other by a check somebody forgot.
  assert.equal(RunnerTickets.looksLikeTicket('fwr_abc_def'), false);
  assert.equal(RunnerTickets.looksLikeTicket('fwk_abc_def'), false);
  assert.equal(RunnerTickets.looksLikeTicket(`${TICKET_PREFIX}_abc_def`), true);
});

test('tickets survive a restart, and spent ones do not come back', async () => {
  // A dispatch and the job that spends it are minutes apart — long enough to
  // contain a coordinator restart or a Durable Object eviction.
  const tickets = new RunnerTickets();
  const { token } = await tickets.mint({ owner: 'eli@example.com', platform: 'linux' });
  const revived = new RunnerTickets();
  revived.restore(JSON.parse(JSON.stringify(tickets.serialise())));
  assert.ok(await revived.redeem(token));

  const after = new RunnerTickets();
  after.restore(revived.serialise());
  assert.equal(await after.redeem(token), null);
});

test('the stored ticket is not the ticket', async () => {
  // A store that can hand a ticket back is a store that can be made to.
  const tickets = new RunnerTickets();
  const { token } = await tickets.mint({ owner: 'eli@example.com', platform: 'macos' });
  assert.equal(JSON.stringify(tickets.serialise()).includes(token.split('_')[2]), false);
});

// --- the verb --------------------------------------------------------------

test('provision names a platform and cannot name anything else', () => {
  // No repository, no workflow, no ref, no inputs. A compromised coordinator can
  // ask for a Mac; it cannot ask somebody's GitHub token to run something of its
  // choosing somewhere of its choosing.
  assert.deepEqual(Object.keys(VERBS.provision.params).sort(), ['minutes', 'platform', 'ticket']);
  assert.equal(checkParams('provision', { platform: 'macos' }).ok, true);
  assert.equal(checkParams('provision', { platform: 'freebsd' }).ok, false);
  assert.equal(checkParams('provision', { repo: 'me/mine', platform: 'macos' }).ok, false);
  assert.equal(checkParams('provision', {}).ok, false);
});

test('minutes stop below the length GitHub kills a job at', () => {
  // A killed job never closes its socket, and the coordinator then waits on a
  // heartbeat from a machine that has already gone.
  assert.equal(checkParams('provision', { platform: 'linux', minutes: 350 }).ok, true);
  assert.equal(checkParams('provision', { platform: 'linux', minutes: 360 }).ok, false);
  assert.equal(checkParams('provision', { platform: 'linux', minutes: 1 }).ok, false);
});

test('the platform list and the workflow map agree', () => {
  // Two lists that must not drift: the protocol refuses anything that is not
  // one of four words, and this map is what those words mean in a repository.
  assert.deepEqual(
    [...(VERBS.provision.params.platform.values || [])].sort(),
    Object.keys(RUNNER_WORKFLOWS).sort(),
  );
});

// --- the command line ------------------------------------------------------

test('the ticket travels beside the command, never on it', () => {
  // A credential on a command line is a credential in the journal of every
  // surface that logs one — which is the whole argument src/core/redact.js is
  // built around.
  const intent = { verb: 'provision', params: { platform: 'macos', minutes: 30, ticket: 'fwt_a_b' }, actor: 'eli@example.com' };
  const line = toCommandLine(intent);
  assert.equal(line, '/provision macos 30');
  assert.equal(line.includes('fwt_a_b'), false);
  assert.equal(commandMeta('provision', intent.params, 'fleet:eli@example.com').ticket, 'fwt_a_b');
});

test('nothing else picks the ticket up', () => {
  // The field is carried for one verb. A meta field that leaks onto another
  // verb is a credential travelling somewhere nobody looked.
  assert.equal(commandMeta('start', { ticket: 'fwt_a_b' }, 'fleet:eli@example.com').ticket, undefined);
});

// --- the config frame ------------------------------------------------------

test('the runner repository arrives on the config frame, shaped', () => {
  const frame = (values) => readConfigFrame({ v: PROTOCOL_VERSION, kind: 'config', values });
  assert.equal(frame({ runnerRepo: 'me/runners' }).values.runnerRepo, 'me/runners');
  // It goes into an API path, so "printable ASCII" is not enough: it has to be
  // a repository.
  for (const bad of ['../../etc/passwd', 'a/b/c', 'no-slash', '/leading', 'trailing/']) {
    assert.deepEqual(frame({ runnerRepo: bad }).values, {}, bad);
  }
});

test('the config frame is still a fixed list', () => {
  // It should grow slowly and never become a map — asserted here rather than
  // left as an intention, because the way it stops being true is somebody
  // adding a key that seemed harmless in isolation.
  assert.deepEqual(Object.keys(CONFIG_KEYS).sort(), ['githubClientSecret', 'runnerRepo']);
  assert.equal(buildConfigFrame({ runnerRepo: 'me/runners', sandboxImage: 'evil' })?.values.sandboxImage, undefined);
});

// --- placement -------------------------------------------------------------

/** @param {Array<[string, boolean]>} spec hostId and whether it is ephemeral */
function fleetOf(spec) {
  const r = new HostRegistry();
  for (const [id, ephemeral] of spec) {
    r.connect(id, () => {}, { ephemeral });
    r.recordHealth(id, { hub: { reachable: true }, maxSessions: 5, running: 0, free: 5, labels: [] });
  }
  return r;
}

const asking = { verb: 'provision', params: { platform: 'macos' } };

test('a runner is never asked to start a runner', () => {
  // A temporary host has no connections and minutes to live. Asking one would
  // fail with a message about GitHub not being connected, which sends somebody
  // looking in the wrong place.
  const p = place(fleetOf([['deb14', false], ['gha-mac-1-1', true]]), asking, {});
  assert.equal(p.kind, 'host');
  assert.equal(p.host?.hostId, 'deb14');
});

test('with no permanent host it refuses and says why', () => {
  const p = place(fleetOf([['gha-mac-1-1', true]]), asking, {});
  assert.equal(p.kind, 'refused');
  assert.equal(p.code, 'no_hosts');
  assert.match(p.reason || '', /dispatched BY a permanent host/);
});

test('several boxes is a question, not a guess', () => {
  // Picking one would pick whichever the iterator reached first, and "GitHub is
  // not connected" would then be the answer for a person who connected it on
  // the other machine.
  const p = place(fleetOf([['deb14', false], ['deb15', false]]), asking, {});
  assert.equal(p.kind, 'refused');
  assert.equal(p.code, 'ambiguous_host');
  assert.match(p.reason || '', /deb14, deb15/);

  const chosen = place(fleetOf([['deb14', false], ['deb15', false]]), asking, { preferHost: 'deb15' });
  assert.equal(chosen.host?.hostId, 'deb15');
});

test('naming a host that cannot ask is refused by name', () => {
  // Including a runner, which is filtered out above rather than refused — so
  // naming one has to say something true about why it is not a choice, and
  // "these are" is the sentence that makes the second attempt work.
  const fleet = fleetOf([['deb14', false], ['gha-mac-1-1', true]]);
  for (const named of ['nowhere', 'gha-mac-1-1']) {
    const p = place(fleet, asking, { preferHost: named });
    assert.equal(p.kind, 'refused', named);
    assert.equal(p.code, 'host_unavailable');
    assert.match(p.reason || '', /deb14/);
  }
});

// --- the coordinator -------------------------------------------------------

/** A core with one reachable host, and whatever runner repository the test wants. */
function coreWith({ runnerRepo = 'me/runners' } = {}) {
  const core = new CoordinatorCore({ runnerRepo });
  core.hostIds.enrol = async () => ({ ok: true, host: { hostId: 'deb14', fingerprint: 'x' } });
  core.registry.connect('deb14', () => {});
  core.registry.recordHealth('deb14', { hub: { reachable: true }, maxSessions: 5, running: 0, free: 5, labels: [] });
  return core;
}

test('an unattributed caller cannot ask for a runner', async () => {
  // A runner exists because one person asked for it and costs them money while
  // it lives. The break-glass token arrives with no requester at all — it is
  // what you hold when identity is broken, and identity is what this needs.
  const core = coreWith();
  const r = await core.dispatch({ verb: 'provision', params: { platform: 'macos' }, requester: null });
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'not_signed_in');
});

test('a fleet with no runner repository says so instead of failing at GitHub', async () => {
  const core = coreWith({ runnerRepo: null });
  const r = await core.dispatch({
    verb: 'provision',
    params: { platform: 'macos' },
    requester: { email: 'eli@example.com', admin: false },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'not_configured');
  assert.match(r.text || '', /AGENT_FLEET_RUNNER_REPO/);
});

test('the coordinator mints the ticket and overwrites whatever the caller sent', async () => {
  // The whole ownership design: the fleet dispatches, so it knows who asked
  // before the job exists. A caller supplying a ticket buys nothing.
  const core = coreWith();
  /** @type {any} */
  let sent = null;
  core.send = async (_host, spec) => {
    sent = spec;
    return { ok: true, text: 'dispatched' };
  };
  const r = await core.dispatch({
    verb: 'provision',
    params: { platform: 'macos', ticket: 'fwt_mine_ownvalue' },
    requester: { email: 'Eli@example.com', admin: false },
    actor: 'eli@example.com',
  });
  assert.equal(r.ok, true);
  assert.notEqual(sent.params.ticket, 'fwt_mine_ownvalue');
  assert.match(sent.params.ticket, /^fwt_/);

  // And it is spendable exactly once, for the person who asked, lower-cased.
  const spent = await core.runnerTickets.redeem(sent.params.ticket);
  assert.equal(spent?.owner, 'eli@example.com');
});

test('the ticket never reaches the event ring', async () => {
  // The ring is read by every device this fleet has issued a credential to.
  const core = coreWith();
  core.send = async () => ({ ok: true });
  /** @type {any} */
  let ticket = null;
  const original = core.send;
  core.send = async (host, spec) => {
    ticket = spec.params.ticket;
    return original(host, spec);
  };
  await core.dispatch({
    verb: 'provision',
    params: { platform: 'linux' },
    requester: { email: 'eli@example.com', admin: false },
    actor: 'eli@example.com',
  });
  assert.equal(JSON.stringify(core.events).includes(String(ticket)), false);
  assert.match(JSON.stringify(core.events), /asked for a linux runner/);
});

// --- the dispatch ----------------------------------------------------------

/** A fetch that answers the two calls dispatchRunner makes, and records them. */
function githubStub({ repoStatus = 200, dispatchStatus = 204, defaultBranch = 'trunk' } = {}) {
  /** @type {any[]} */
  const calls = [];
  /** @type {any} */
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/dispatches')) {
      return new Response(null, { status: dispatchStatus });
    }
    return new Response(JSON.stringify({ default_branch: defaultBranch }), {
      status: repoStatus,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, calls };
}

test('a dispatch names the file the platform means, on the default branch', async () => {
  const { impl, calls } = githubStub();
  const r = await dispatchRunner({
    repo: 'me/runners',
    platform: 'android',
    minutes: 30,
    ticket: 'fwt_a_b',
    coordinator: 'https://fleet.example',
    token: 'ghu_secret',
    fetchImpl: impl,
  });
  assert.equal(r.ok, true);
  assert.equal(calls[1].url, 'https://api.github.com/repos/me/runners/actions/workflows/runner-android.yml/dispatches');

  const body = JSON.parse(calls[1].init.body);
  // NOT `main`. Asking for the repository first is what stops this assuming a
  // branch name that is wrong for older repositories and for anybody who
  // renamed theirs.
  assert.equal(body.ref, 'trunk');
  assert.deepEqual(body.inputs, { minutes: '30', ticket: 'fwt_a_b', coordinator: 'https://fleet.example' });
  // Every input is a string: GitHub types workflow_dispatch inputs as strings,
  // and a number is a 422 that reads as the workflow being wrong.
  for (const v of Object.values(body.inputs)) assert.equal(typeof v, 'string');
});

test('the token authenticates the call and is not handed to the workflow', async () => {
  // The runner authenticates to the fleet with its own key and to Claude with
  // the repository's API key. Somebody's GitHub token has no business on the
  // machine, and a public repository's run log even less.
  const { impl, calls } = githubStub();
  await dispatchRunner({
    repo: 'me/runners',
    platform: 'linux',
    ticket: 'fwt_a_b',
    coordinator: 'https://fleet.example',
    token: 'ghu_secret',
    fetchImpl: impl,
  });
  for (const call of calls) assert.equal(call.init.headers.authorization, 'Bearer ghu_secret');
  assert.equal(JSON.parse(calls[1].init.body).inputs.ticket, 'fwt_a_b');
  assert.equal(calls[1].init.body.includes('ghu_secret'), false);
});

test('minutes are clamped rather than sent as nonsense', async () => {
  const { impl, calls } = githubStub();
  await dispatchRunner({
    repo: 'me/runners',
    platform: 'linux',
    minutes: 10_000,
    ticket: 'fwt_a_b',
    coordinator: 'https://fleet.example',
    token: 't',
    fetchImpl: impl,
  });
  assert.equal(JSON.parse(calls[1].init.body).inputs.minutes, String(MAX_MINUTES));
});

test('a platform with no workflow is refused before anything is called', async () => {
  let called = false;
  const r = await dispatchRunner({
    repo: 'me/runners',
    platform: 'plan9',
    ticket: 'fwt_a_b',
    coordinator: 'https://fleet.example',
    token: 't',
    fetchImpl: /** @type {any} */ (async () => { called = true; return new Response(null, { status: 204 }); }),
  });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('a repository that is not owner/repo never reaches a URL', async () => {
  // A repository name goes into an API path, and a value validated only by its
  // caller is validated only until there are two callers.
  for (const bad of ['../../evil', 'me/runners/../..', '', 'me runners']) {
    const r = await dispatchRunner({
      repo: bad,
      platform: 'linux',
      ticket: 'fwt_a_b',
      coordinator: 'https://fleet.example',
      token: 't',
      fetchImpl: /** @type {any} */ (async () => { throw new Error('should not be called'); }),
    });
    assert.equal(r.ok, false, bad);
  }
});

test('every GitHub refusal names something a person can go and fix', async () => {
  // The three that actually happen, and they send somebody to three different
  // places: reconnect, check the permission, check the installation.
  const cases = [
    [401, /expired or been revoked/],
    [403, /Actions write/],
    [404, /picked when it was installed/],
  ];
  for (const [status, expected] of cases) {
    const { impl } = githubStub({ repoStatus: /** @type {number} */ (status) });
    const r = await dispatchRunner({
      repo: 'me/runners',
      platform: 'linux',
      ticket: 'fwt_a_b',
      coordinator: 'https://fleet.example',
      token: 't',
      fetchImpl: impl,
    });
    assert.equal(r.ok, false);
    assert.match(/** @type {any} */ (r).message, /** @type {RegExp} */ (expected), String(status));
  }
});

test('a runner repository whose workflow is out of date says which inputs it needs', async () => {
  // 422 is GitHub's "understood and wrong", and here it is almost always a copy
  // of the workflow that predates a change to what the fleet sends.
  const { impl } = githubStub({ dispatchStatus: 422 });
  const r = await dispatchRunner({
    repo: 'me/runners',
    platform: 'linux',
    ticket: 'fwt_a_b',
    coordinator: 'https://fleet.example',
    token: 't',
    fetchImpl: impl,
  });
  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).message, /minutes.*ticket.*coordinator/s);
});

test('a provider that never answers is a sentence, not a stack trace', async () => {
  const r = await dispatchRunner({
    repo: 'me/runners',
    platform: 'linux',
    ticket: 'fwt_a_b',
    coordinator: 'https://fleet.example',
    token: 't',
    fetchImpl: /** @type {any} */ (async () => { throw new Error('connect ETIMEDOUT'); }),
  });
  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).message, /Could not reach GitHub/);
});

// --- the command on the box ------------------------------------------------

test('the command refuses each missing piece separately', async () => {
  // Three refusals rather than one, because they send somebody to three
  // different places: an operator setting, the way the request was made, and a
  // connection screen in the app.
  const { COMMANDS } = await import('../src/adapters/commands.js');
  const cfg = { stateDir: mkdtempSync(join(tmpdir(), 'provision-')) };
  const run = (ctx, args) => COMMANDS.provision.run({ cfg, actor: 'fleet:eli@example.com', ...ctx }, args);

  assert.match((await run({}, ['sparc'])).text, /Usage/);
  assert.match((await run({}, ['linux', '3'])).text, /between 5 and/);
  assert.match((await run({}, ['linux'])).text, /AGENT_FLEET_RUNNER_REPO/);
  assert.match((await run({ runnerRepo: 'me/runners' }, ['linux'])).text, /minted by\nthe coordinator|minted by the coordinator/);
  assert.match(
    (await run({ runnerRepo: 'me/runners', ticket: 'fwt_a_b' }, ['linux'])).text,
    /does not know its own coordinator/,
  );
});

test('the box\u2019s own row is refused rather than used as a fallback', async () => {
  // A runner belongs to a person; the shared row belongs to the machine. Falling
  // back would attribute a machine to whoever happened to connect GitHub for the
  // box — and bill them for it.
  const { COMMANDS } = await import('../src/adapters/commands.js');
  const r = await COMMANDS.provision.run(
    {
      cfg: { stateDir: mkdtempSync(join(tmpdir(), 'provision-')) },
      // No `fleet:` prefix is the box itself — see src/core/accounts.js.
      actor: 'telegram:12345',
      runnerRepo: 'me/runners',
      ticket: 'fwt_a_b',
      coordinator: 'https://fleet.example',
    },
    ['linux'],
  );
  assert.equal(r.ok, false);
  assert.match(r.text, /Could not tell whose GitHub connection/);
});

test('with no GitHub connected it says so and nothing is started', async () => {
  const { COMMANDS } = await import('../src/adapters/commands.js');
  const r = await COMMANDS.provision.run(
    {
      cfg: { stateDir: mkdtempSync(join(tmpdir(), 'provision-')) },
      actor: 'fleet:eli@example.com',
      runnerRepo: 'me/runners',
      ticket: 'fwt_a_b',
      coordinator: 'https://fleet.example',
    },
    ['linux'],
  );
  assert.equal(r.ok, false);
  assert.match(r.text, /GitHub is not connected for you/);
});

test('a stored token is what dispatches, and the reply says the machine is not here yet', async (t) => {
  // The reply comes back long before the runner does — GitHub has to find
  // hardware, boot it and install tmux and the CLI — so a reply that said
  // "started" would be read as "ready" by the agent that asked.
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });

  const { COMMANDS } = await import('../src/adapters/commands.js');
  const { Connections } = await import('../src/core/connectors.js');
  const stateDir = mkdtempSync(join(tmpdir(), 'provision-'));
  new Connections(stateDir).save('eli@example.com', 'github', 'ghu_stored');

  /** @type {string[]} */
  const seen = [];
  globalThis.fetch = /** @type {any} */ (async (url, init = {}) => {
    seen.push(`${String(url)} ${String(init.headers?.authorization || '')}`);
    if (String(url).endsWith('/dispatches')) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ default_branch: 'main' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const r = await COMMANDS.provision.run(
    {
      cfg: { stateDir },
      actor: 'fleet:eli@example.com',
      runnerRepo: 'me/runners',
      ticket: 'fwt_a_b',
      coordinator: 'https://fleet.example',
    },
    ['macos', '90'],
  );
  assert.equal(r.ok, true);
  assert.ok(seen.every((s) => s.includes('Bearer ghu_stored')), seen.join('\n'));
  assert.match(r.text, /runner-macos\.yml/);
  assert.match(r.text, /not here yet/);
});

// --- what admits the machine -----------------------------------------------
//
// The ticket says whose runner it is; GitHub's own job token is what admits it.
// That check had no tests at all, which mattered more once the workflow pin
// became a LIST: pinning one file when a runner repository has four means three
// of them cannot admit a host, and pinning none means any workflow there can —
// including one a pull request adds.

/** An issuer that signs like GitHub's Actions provider does. */
async function actionsIssuer() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const keys = [{ ...jwk, kid: 'gha', alg: 'RS256', use: 'sig' }];
  const real = globalThis.fetch;
  // ONLY THE JWKS. Everything else goes to the real fetch, because the
  // enrolment test below calls a coordinator over HTTP in this same process —
  // a blanket stub would answer that call with a key set.
  //
  // THE HOST, PARSED, NOT A SUBSTRING OF THE URL. `includes()` was the first
  // spelling and CodeQL was right to refuse it: the issuer's name can appear
  // anywhere in a URL — a path, a query parameter, a subdomain of somebody
  // else's — so the check would answer a key set to a request that was never
  // going to GitHub. It is a test stub, and the habit is the point: the same
  // line in src/ would be the whole of an SSRF.
  const isIssuer = (/** @type {unknown} */ url) => {
    try {
      return new URL(String(url)).hostname === 'token.actions.githubusercontent.com';
    } catch {
      return false;
    }
  };
  globalThis.fetch = /** @type {any} */ (async (url, init) =>
    isIssuer(url)
      ? new Response(JSON.stringify({ keys }), { status: 200, headers: { 'content-type': 'application/json' } })
      : real(url, init));

  const b64 = (/** @type {any} */ o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = async (/** @type {any} */ claims) => {
    const h = b64({ alg: 'RS256', kid: 'gha', typ: 'JWT' });
    const c = b64({
      iss: ACTIONS_ISSUER,
      aud: 'fleetwright',
      exp: Math.floor(Date.now() / 1000) + 600,
      run_id: '99',
      run_attempt: '1',
      ...claims,
    });
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${c}`));
    return `${h}.${c}.${Buffer.from(sig).toString('base64url')}`;
  };
  return { sign, restore: () => { globalThis.fetch = real; } };
}

const PINS = [
  'me/runners/.github/workflows/runner-macos.yml@',
  'me/runners/.github/workflows/runner-linux.yml@',
];

test('any of the pinned workflows may admit a host', async (t) => {
  forgetJwks();
  const { sign, restore } = await actionsIssuer();
  t.after(restore);
  for (const file of ['runner-macos.yml', 'runner-linux.yml']) {
    const job = await verifyActionsToken(
      await sign({
        repository: 'me/runners',
        job_workflow_ref: `me/runners/.github/workflows/${file}@refs/heads/main`,
      }),
      { audiences: ['fleetwright'], repositories: ['me/runners'], workflowRef: PINS },
    );
    assert.equal(job.repository, 'me/runners');
    assert.equal(job.runId, '99');
  }
});

test('a workflow that is not pinned cannot admit one', async (t) => {
  // The case the pin exists for: a file somebody added to the runner repository,
  // in a pull request or otherwise, must not be able to put a machine in a fleet.
  forgetJwks();
  const { sign, restore } = await actionsIssuer();
  t.after(restore);
  const token = await sign({
    repository: 'me/runners',
    job_workflow_ref: 'me/runners/.github/workflows/mine.yml@refs/heads/main',
  });
  await assert.rejects(
    () => verifyActionsToken(token, { audiences: ['fleetwright'], repositories: ['me/runners'], workflowRef: PINS }),
    /mine\.yml/,
  );
});

test('a single pin still works, and means a list of one', async (t) => {
  // Deployments configured before the list existed must not change underneath
  // them — this is the compatible direction of the same change.
  forgetJwks();
  const { sign, restore } = await actionsIssuer();
  t.after(restore);
  const opts = (workflowRef) => ({ audiences: ['fleetwright'], repositories: ['me/runners'], workflowRef });
  const ok = await sign({
    repository: 'me/runners',
    job_workflow_ref: 'me/runners/.github/workflows/runner-macos.yml@refs/heads/main',
  });
  assert.ok(await verifyActionsToken(ok, opts('me/runners/.github/workflows/runner-macos.yml@')));
  await assert.rejects(
    () => verifyActionsToken(ok, opts('me/runners/.github/workflows/other.yml@')),
    /other\.yml/,
  );
  // And no pin at all is still allowed — an older deployment that never set one.
  assert.ok(await verifyActionsToken(ok, opts(null)));
});

test('a repository nobody allowed cannot admit a host however it is pinned', async (t) => {
  forgetJwks();
  const { sign, restore } = await actionsIssuer();
  t.after(restore);
  const token = await sign({
    repository: 'someone/else',
    job_workflow_ref: 'me/runners/.github/workflows/runner-macos.yml@refs/heads/main',
  });
  await assert.rejects(
    () => verifyActionsToken(token, { audiences: ['fleetwright'], repositories: ['me/runners'], workflowRef: PINS }),
    /is not allowed to enrol runners/,
  );
  // Empty means nobody, deliberately: a deployment that has not said which
  // repositories may admit machines has not opted in.
  await assert.rejects(
    () => verifyActionsToken(token, { audiences: ['fleetwright'], repositories: [] }),
    /no repositories are configured/,
  );
});

test('a job that presents a ticket enrols as that person’s runner, once', async (t) => {
  // THE JOIN BETWEEN THE TWO HALVES, end to end: GitHub's token admits the
  // machine, the coordinator's own ticket says whose it is, and the entry it
  // creates is ephemeral and owned.
  forgetJwks();
  const { sign, restore } = await actionsIssuer();
  t.after(restore);
  const repos = process.env.AGENT_FLEET_ACTIONS_REPOS;
  process.env.AGENT_FLEET_ACTIONS_REPOS = 'me/runners';
  t.after(() => {
    if (repos === undefined) delete process.env.AGENT_FLEET_ACTIONS_REPOS;
    else process.env.AGENT_FLEET_ACTIONS_REPOS = repos;
  });

  const c = new Coordinator({});
  const port = await c.listen(0, '127.0.0.1');
  t.after(() => c.close());

  const { token } = await c.core.runnerTickets.mint({ owner: 'eli@example.com', platform: 'linux' });
  const key = await generateKeyPair();
  const idToken = await sign({
    repository: 'me/runners',
    job_workflow_ref: 'me/runners/.github/workflows/runner-linux.yml@refs/heads/main',
  });
  const enrol = () =>
    fetch(`http://127.0.0.1:${port}/api/enroll/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: idToken, claim: token, publicJwk: key.publicJwk }),
    });

  const first = await (await enrol()).json();
  assert.equal(first.ok, true);
  assert.equal(first.ephemeral, true);
  // DERIVED FROM THE RUN, never accepted from the job: a job that could choose
  // its own name could choose a permanent host's, and re-enrolment replaces a
  // key.
  assert.equal(first.hostId, 'gha-me-runners-99-1');
  assert.equal(c.core.hostIds.get('gha-me-runners-99-1')?.owner, 'eli@example.com');

  // And the ticket is spent. A second job presenting it — a re-run, or somebody
  // who read it out of a public run log — is refused.
  const second = await (await enrol()).json();
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'unclaimed');
  assert.match(second.text, /already been spent or expired/);
});

// --- the sidecar's half ----------------------------------------------------

test('the sidecar adds what the host knows and the intent could not carry', async (t) => {
  // Three values, three origins, and that is the design rather than an
  // accident: the platform came from the caller, the repository from the
  // coordinator's config frame, and the coordinator origin from THIS BOX's own
  // configuration — so a runner is told to join the fleet the machine is
  // actually in rather than one a coordinator names for itself.
  const { Sidecar } = await import('../src/fleet/host/sidecar.js');
  const { HubClient } = await import('../src/fleet/host/hub-client.js');
  const { startStubHub } = await import('./helpers/stub-hub.js');

  const stub = await startStubHub({});
  t.after(() => stub.close());
  const sidecar = new Sidecar({
    hub: new HubClient({ baseUrl: stub.baseUrl, readTimeoutMs: 2000 }),
    // A trailing slash is ordinary in an operator's configuration and would be
    // a different string to anything comparing origins on the runner.
    transport: /** @type {any} */ ({ origin: 'https://coord.example/', onMessage() {}, send() {}, start: async () => true, stop: async () => true }),
    hostId: 'deb14',
    healthIntervalMs: 0,
    watch: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  sidecar.config.set('runnerRepo', 'me/runners');

  await sidecar.handle({
    v: PROTOCOL_VERSION,
    kind: 'intent',
    id: 'idem-0000001',
    verb: 'provision',
    params: { platform: 'macos', minutes: 45, ticket: 'fwt_a_b' },
    issuedAt: Date.now(),
    actor: 'eli@example.com',
  });

  assert.deepEqual(stub.commands, ['/provision macos 45']);
  const body = stub.bodies.at(-1);
  assert.equal(body.ticket, 'fwt_a_b');
  assert.equal(body.runnerRepo, 'me/runners');
  assert.equal(body.coordinator, 'https://coord.example');
  assert.equal(String(body.command).includes('fwt_a_b'), false);
});

// --- the hub's door --------------------------------------------------------

test('the hub validates the fields the sidecar sends rather than trusting them', async (t) => {
  // /api/command is reachable by anything holding the hub token, not only by
  // the sidecar that already validated — so a value checked only by its usual
  // caller is checked only until there are two.
  const { HttpAdapter } = await import('../src/adapters/http.js');
  const { ensureApiToken } = await import('../src/core/api-token.js');
  const stateDir = mkdtempSync(join(tmpdir(), 'provision-http-'));
  const cfg = /** @type {any} */ ({
    stateDir,
    bind: '127.0.0.1',
    port: 0,
    token: '',
    hostname: 'testbox',
    workdir: join(stateDir, 'work'),
    maxSessions: 5,
    loginEnabled: true,
    sandbox: false,
    sandboxCredentialsFile: '',
  });
  const adapter = new HttpAdapter(cfg, {
    sessions: /** @type {any} */ ({ list: () => [], running: () => [], binned: () => [] }),
    login: /** @type {any} */ ({ status: () => ({ loggedIn: true }), isPending: () => false, pending: null }),
    token: ensureApiToken(cfg),
  });
  await adapter.start();
  const port = /** @type {any} */ (adapter.server).address().port;
  t.after(() => adapter.server?.close());

  const post = (body) =>
    fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ensureApiToken(cfg)}` },
      body: JSON.stringify({ command: '/provision linux', ...body }),
    });

  // Well formed: the command runs and refuses for its own reasons, which is the
  // door doing its job rather than the command succeeding.
  const good = await post({ ticket: 'fwt_a_b', runnerRepo: 'me/runners', coordinator: 'https://fleet.example' });
  assert.equal(good.status, 200);

  for (const bad of [
    { ticket: 'has space' },
    { runnerRepo: '../../etc/passwd' },
    // A URL with a path is not an origin, and this one becomes a machine's idea
    // of which fleet it is in.
    { coordinator: 'https://fleet.example/somewhere' },
    { coordinator: 'not-a-url' },
  ]) {
    const res = await post(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    const text = (await res.json()).text;
    // The refusal never quotes the value back — one of these is a credential.
    assert.equal(text.includes(Object.values(bad)[0]), false, text);
  }
});

test('the Worker coordinator does the same, and writes the spent ticket down', async (t) => {
  // The two coordinators duplicate their ROUTING by necessity, and duplicated
  // logic is logic that will eventually be two logics — the apps talk to the
  // Worker, so a divergence here is invisible until somebody is holding a
  // phone. A Durable Object is evicted between messages as a matter of course,
  // which is why the spent ticket has to reach storage rather than only memory.
  forgetJwks();
  const { sign, restore } = await actionsIssuer();
  t.after(restore);
  const { Fleet } = await import('../worker/src/fleet-do.js');

  /** @type {Map<string, any>} */
  const storage = new Map();
  const state = /** @type {any} */ ({
    storage: {
      get: async (/** @type {string} */ k) => storage.get(k),
      put: async (/** @type {string} */ k, /** @type {any} */ v) => { storage.set(k, JSON.parse(JSON.stringify(v))); },
    },
    blockConcurrencyWhile: (/** @type {() => Promise<any>} */ fn) => fn(),
    getWebSockets: () => [],
    setAlarm: () => {},
  });
  const fleet = new Fleet(state, { AGENT_FLEET_ACTIONS_REPOS: 'me/runners' });

  const { token } = await fleet.core.runnerTickets.mint({ owner: 'eli@example.com', platform: 'macos' });
  const key = await generateKeyPair();
  const idToken = await sign({
    repository: 'me/runners',
    job_workflow_ref: 'me/runners/.github/workflows/runner-macos.yml@refs/heads/main',
  });
  const enrol = () =>
    fleet.fetch(
      new Request('https://fleet.example/api/enroll/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: idToken, claim: token, publicJwk: key.publicJwk }),
      }),
    );

  const first = await (await enrol()).json();
  assert.equal(first.ok, true);
  assert.equal(first.ephemeral, true);
  assert.equal(fleet.core.hostIds.get(first.hostId)?.owner, 'eli@example.com');
  // Written down, not merely forgotten in memory.
  assert.deepEqual(storage.get('runnerTickets'), []);

  const second = await (await enrol()).json();
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'unclaimed');
});
