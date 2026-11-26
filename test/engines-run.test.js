// The engine runner and its two adapters (sandbox/engine.mjs, docs/engines.md),
// each against a stand-in server that speaks the engine's published
// protocol on a pipe: Codex's app server (the 0.171.0 bindings) and an
// Agent Client Protocol agent (schema v1).
//
// NO REAL ENGINE IS RUN HERE and none is asked anything. The stand-ins say
// what the real servers were seen or documented to say, including the one
// behaviour this exists for: an agent that falls back to another model and
// does not mention it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codexSignIn } from './helpers/engine-files.js';
import { Peer, codexAdapter, acpAdapter, run, parseArgs, stage, ended, another, PASTED, providerOf, acpModel, reasonFromCodexError, codexResetsAt, ERROR_LINE_MAX, OPENCODE_ASKS } from '../sandbox/engine.mjs';

/** Wait until `said()` is true, or say what never happened. */
async function until(/** @type {() => boolean} */ said, /** @type {string} */ what, ms = 3000) {
  const by = Date.now() + ms;
  while (!said()) {
    if (Date.now() > by) assert.fail(`waited ${ms} ms and never saw: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A server on a pipe. `answer(message, send)` is called for each line the
 * client writes; `send` writes one back.
 */
function standIn(/** @type {(m: any, send: (m: any) => void) => void} */ answer) {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  /** @type {any[]} */
  const seen = [];
  const send = (/** @type {any} */ m) => void fromServer.write(`${JSON.stringify(m)}\n`);
  createInterface({ input: toServer }).on('line', (text) => {
    const m = JSON.parse(text);
    seen.push(m);
    answer(m, send);
  });
  const child = { stdin: toServer, stdout: fromServer, exitCode: /** @type {number|null} */ (null), kill() { this.exitCode = 0; fromServer.end(); }, on() {} };
  return { child, seen, send, methods: () => seen.filter((m) => m.method).map((m) => m.method) };
}

/** Codex's app server, signed in, on the model given, answering a turn as `turn` says. */
function codexServer({ account = { type: 'chatgpt', email: 'a@example.com', planType: 'plus' }, model = 'gpt-5.1-codex', turn = /** @type {(send: (m: any) => void, m: any) => void} */ (() => {}) } = {}) {
  return standIn((m, send) => {
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'codex/0.171.0', codexHome: '/h/.codex', platformFamily: 'unix', platformOs: 'linux' } });
    else if (m.method === 'account/read') send({ id: m.id, result: { account, userId: null, requiresOpenaiAuth: true } });
    else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'th-1' }, model, modelProvider: 'openai' } });
    else if (m.method === 'turn/start') {
      send({ id: m.id, result: { turn: { id: 'tu-1', status: 'inProgress', error: null } } });
      turn(send, m);
    } else if (m.method === 'turn/interrupt') {
      send({ id: m.id, result: {} });
      send({ method: 'turn/completed', params: { threadId: 'th-1', turn: { id: 'tu-1', status: 'interrupted', error: null } } });
    }
  });
}
const completed = (/** @type {any} */ send, /** @type {any} */ turn) => send({ method: 'turn/completed', params: { threadId: 'th-1', turn: { id: 'tu-1', ...turn } } });
/** An adapter on a stand-in, with what it printed. */
function codexOn(/** @type {ReturnType<typeof standIn>} */ server, /** @type {any} */ opts = {}) {
  /** @type {string[]} */
  const said = [];
  /** @type {string[]} */
  const notes = [];
  const adapter = codexAdapter(new Peer(server.child, { version: null }), { model: 'gpt-5.1-codex', cwd: '/work', mode: 'safe', say: (s) => said.push(s), note: (s) => notes.push(s), ...opts });
  return { adapter, said, notes };
}

test('Codex: not signed in is found by asking, before any thread or turn exists', async () => {
  const server = codexServer({ account: /** @type {any} */ (null) });
  const { adapter } = codexOn(server);
  assert.deepEqual(await adapter.open(), { engine: 'codex', reason: 'auth', detail: 'Codex is not signed in on this machine', model: null, usage: null, resetsAt: null });
  assert.deepEqual(server.methods(), ['initialize', 'initialized', 'account/read']);
  // Codex's app server speaks without a `jsonrpc` field, and is spoken to the same way.
  assert.ok(server.seen.every((m) => !('jsonrpc' in m)));
});

test('Codex: a thread on another model than was asked for is not given a turn', async () => {
  const server = codexServer({ model: 'gpt-5-mini' });
  const { adapter } = codexOn(server);
  const failed = await adapter.open();
  assert.deepEqual([failed?.reason, failed?.model, failed?.detail], ['model', 'gpt-5-mini', 'asked for gpt-5.1-codex']);
  assert.ok(!server.methods().includes('turn/start'));
  // With no model asked for, the thread's own choice is the one, and is reported as such.
  const any = codexServer({ model: 'gpt-5-mini', turn: (send) => completed(send, { status: 'completed', error: null }) });
  const free = codexOn(any, { model: null });
  assert.equal(await free.adapter.open(), null);
  assert.equal((await free.adapter.turn('hi')).model, 'gpt-5-mini');
});

test('Codex: a turn that completes prints what the agent said and reports its tokens', async () => {
  const server = codexServer({
    turn: (send) => {
      send({ method: 'item/agentMessage/delta', params: { threadId: 'th-1', turnId: 'tu-1', itemId: 'i', delta: 'Fixed the ' } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'th-1', turnId: 'tu-1', itemId: 'i', delta: 'redirect.' } });
      send({ method: 'item/completed', params: { item: { type: 'agentMessage' } } });
      send({ method: 'thread/tokenUsage/updated', params: { threadId: 'th-1', turnId: 'tu-1', tokenUsage: { total: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 } } } });
      completed(send, { status: 'completed', error: null });
    },
  });
  const { adapter, said } = codexOn(server, { mode: 'dangerous' });
  assert.equal(await adapter.open(), null);
  const started = server.seen.find((m) => m.method === 'thread/start').params;
  assert.deepEqual([started.model, started.cwd, started.approvalPolicy, started.sandbox], ['gpt-5.1-codex', '/work', 'never', 'danger-full-access']);
  assert.deepEqual(await adapter.turn('Fix the login redirect.'), { engine: 'codex', reason: 'done', detail: null, model: 'gpt-5.1-codex', usage: { input: 1200, output: 340 }, resetsAt: null });
  assert.equal(said.join(''), 'Fixed the redirect.\n');
  assert.deepEqual(server.seen.find((m) => m.method === 'turn/start').params, { threadId: 'th-1', input: [{ type: 'text', text: 'Fix the login redirect.', text_elements: [] }] });
});

test('Codex: a usage limit is a limit, with when the app server says it lifts', async () => {
  const server = codexServer({
    turn: (send) => {
      send({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_795_500_000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1_795_900_000 } } } });
      completed(send, { status: 'failed', error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' } });
    },
  });
  const { adapter } = codexOn(server);
  await adapter.open();
  assert.deepEqual(await adapter.turn('go'), { engine: 'codex', reason: 'limit', detail: 'You have hit your usage limit.', model: 'gpt-5.1-codex', usage: null, resetsAt: 1_795_500_000_000 });
});

test('Codex: each of the app server’s named errors is the reason it means', () => {
  const reason = (/** @type {any} */ info, message = '') => reasonFromCodexError({ message, codexErrorInfo: info });
  assert.equal(reason('usageLimitExceeded'), 'limit');
  assert.equal(reason('rateLimitExceeded'), 'limit');
  assert.equal(reason('unauthorized'), 'auth');
  assert.equal(reason('modelNotFound'), 'model');
  assert.equal(reason('cyberPolicy'), 'refused');
  assert.equal(reason('contextWindowExceeded'), 'cut');
  // The provider's bad minute is not this account's limit: nothing is handed on for it.
  assert.equal(reason('serverOverloaded'), 'error');
  assert.equal(reason({ httpConnectionFailed: { httpStatusCode: 502 } }), 'error');
  // An error the app server has no name for is held to its words.
  assert.equal(reason(null, 'HTTP 429 Too Many Requests'), 'limit');
  assert.equal(reason(null, 'something else'), 'error');
  // Only a window that is full says when a limit lifts, and it says seconds.
  assert.equal(codexResetsAt({ primary: { usedPercent: 40, resetsAt: 100 }, secondary: null }), null);
  assert.equal(codexResetsAt({ primary: { usedPercent: 100, resetsAt: 100 }, secondary: { usedPercent: 100, resetsAt: 900 } }), 900_000);
});

/**
 * Codex's five sentences for a sign-in it could not renew, as its source has
 * them at the version the image pins (codex-rs/login/src/auth/manager.rs,
 * rust-v0.171.0: REFRESH_TOKEN_EXPIRED_MESSAGE, _REUSED_, _INVALIDATED_,
 * _UNKNOWN_ and _ACCOUNT_MISMATCH_). `account/read` answers with one as a
 * plain error, with no name beside it, so the words are all the runner has.
 */
const COULD_NOT_RENEW = [
  'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
  'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
  'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
  'Your access token could not be refreshed. Please log out and sign in again.',
  'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.',
];
/** Codex's app server answering `account/read` with an error, as it does for a ChatGPT sign-in it cannot vouch for. */
const codexRefusing = (/** @type {string} */ message) => standIn((m, send) => {
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'codex/0.171.0' } });
  else if (m.method === 'account/read') send({ id: m.id, error: { code: -32603, message } });
});

test('Codex: every sentence it has for a sign-in it could not renew is the sign-in ending, so the session is handed on and the person is sent to sign in', async () => {
  for (const said of COULD_NOT_RENEW) assert.equal(reasonFromCodexError({ message: said }), 'auth', said);
  // And as it arrives: the answer to the question asked before any thread.
  const server = codexRefusing(COULD_NOT_RENEW[1]);
  const failed = await codexOn(server).adapter.open();
  assert.deepEqual([failed?.reason, failed?.detail], ['auth', COULD_NOT_RENEW[1]]);
  assert.deepEqual(server.methods(), ['initialize', 'initialized', 'account/read']);
});

test('Codex: a sign-in it could not check because chatgpt.com is out of reach is no ended sign-in, and the detail names the host', async () => {
  const failed = await codexOn(codexRefusing('workspace routing discovery failed')).adapter.open();
  assert.deepEqual([failed?.reason, failed?.detail], ['error', 'Codex could not reach chatgpt.com to check its sign-in (workspace routing discovery failed). This machine must be able to reach chatgpt.com']);
});

test('Codex: a turn the app server moves to another model is stopped, and ends as the wrong model', async () => {
  const server = codexServer({ turn: (send) => send({ method: 'model/rerouted', params: { threadId: 'th-1', turnId: 'tu-1', fromModel: 'gpt-5.1-codex', toModel: 'gpt-5-mini', reason: 'capacity' } }) });
  const { adapter } = codexOn(server);
  await adapter.open();
  const turn = await adapter.turn('go');
  assert.deepEqual([turn.reason, turn.model], ['model', 'gpt-5-mini']);
  assert.deepEqual(server.seen.find((m) => m.method === 'turn/interrupt').params, { threadId: 'th-1', turnId: 'tu-1' });
});

test('Codex: what it asks to do is declined in a session that asks first and said so, allowed in one that does not, and anything else is not a method', async () => {
  for (const [mode, decision] of /** @type {const} */ ([['safe', 'decline'], ['dangerous', 'accept']])) {
    const server = codexServer({
      turn: (send) => {
        send({ id: 901, method: 'item/commandExecution/requestApproval', params: { command: 'rm -rf build' } });
        send({ id: 902, method: 'item/tool/requestUserInput', params: {} });
        setTimeout(() => completed(send, { status: 'completed', error: null }), 20);
      },
    });
    const { adapter, notes } = codexOn(server, { mode });
    await adapter.open();
    await adapter.turn('go');
    assert.deepEqual(server.seen.find((m) => m.id === 901 && !m.method).result, { decision }, mode);
    assert.equal(server.seen.find((m) => m.id === 902 && !m.method).error.code, -32601, mode);
    assert.equal(notes.length, mode === 'safe' ? 1 : 0);
    if (mode === 'safe') assert.match(notes[0], /Declined something Codex asked to do: this session asks before it runs commands/);
  }
});

// ── An ACP agent ────────────────────────────────────────────────────────────

const modelOption = (/** @type {string} */ now) => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: now, options: [] }];
/**
 * What OpenCode 1.19.6 answers when it is set to a model: its options on
 * that model when one of its providers has it, and otherwise invalid params,
 * "model not found: <id>", with the provider and the model as data
 * (packages/opencode/src/acp/error.ts, ACPInvalidModelError). `has` is what
 * the account's providers list.
 */
const openCodeSet = (/** @type {string[]} */ has) => (/** @type {any} */ m) => {
  const asked = String(m.params.value ?? m.params.modelId);
  return has.includes(asked)
    ? { result: { configOptions: modelOption(asked) } }
    : { error: { code: -32602, message: `Invalid params: model not found: ${asked}`, data: { providerId: asked.split('/')[0], modelId: asked } } };
};
/** How OpenCode's ACP server answers a prompt its provider failed: an internal error with the provider's words and the error's name (acp/service.ts). */
const openCodeFailed = (/** @type {string} */ words, errorName = 'APIError') => ({ error: { code: -32603, message: `Internal error: ${words}`, data: { service: 'session', errorName } } });

/**
 * An ACP agent. `session` is what session/new answers; `set` what setting the
 * model answers, which unless a test says otherwise is OpenCode's own answer
 * for an account with no model but its free one; `prompt` how a turn goes.
 */
function acpServer({ session = /** @type {any} */ ({}), set = /** @type {(m: any) => any} */ (openCodeSet(['opencode/big-pickle'])), prompt = /** @type {(send: (m: any) => void, m: any) => void} */ ((send, m) => send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })) } = {}) {
  return standIn((m, send) => {
    const reply = (/** @type {any} */ body) => send({ jsonrpc: '2.0', id: m.id, ...body });
    if (m.method === 'initialize') reply({ result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    else if (m.method === 'session/new') reply(session.error ? { error: session.error } : { result: { sessionId: 's-1', ...session } });
    else if (m.method === 'session/set_config_option' || m.method === 'session/set_model') reply(set(m));
    else if (m.method === 'session/prompt') prompt(send, m);
  });
}
const ASKED = 'github-copilot/claude-sonnet-5.5';
function acpOn(/** @type {ReturnType<typeof standIn>} */ server, /** @type {any} */ opts = {}) {
  /** @type {string[]} */
  const said = [];
  /** @type {string[]} */
  const notes = [];
  const adapter = acpAdapter(new Peer(server.child), { engine: 'opencode', model: ASKED, cwd: '/work', mode: 'safe', say: (s) => said.push(s), note: (s) => notes.push(s), ...opts });
  return { adapter, said, notes };
}

test('ACP: OpenCode’s own answer to a model the account does not have is the wrong model, said with the one it is on, and asked nothing', async () => {
  // The account's Copilot plan does not list the model, or Copilot is not
  // signed in at all: either way OpenCode has no such model to set. This
  // ended as `error`, which hands nothing on, so the member's next engine
  // never started for a model name that was simply not on the list.
  const server = acpServer({ session: { configOptions: modelOption('opencode/big-pickle') } });
  const { adapter } = acpOn(server);
  assert.deepEqual(await adapter.open(), { engine: 'opencode', reason: 'model', detail: `Invalid params: model not found: ${ASKED}`, model: 'opencode/big-pickle', usage: null, resetsAt: null });
  assert.ok(!server.methods().includes('session/prompt'), 'no prompt reached a model nobody asked for');
  // The older way of setting a model is refused the same way, by an agent that lists the model and then has none.
  const older = acpServer({ session: { models: { currentModelId: 'opencode/big-pickle', availableModels: [{ modelId: ASKED }] } } });
  assert.equal((await acpOn(older).adapter.open())?.reason, 'model');
  // An account that has it is set to it, and says so.
  const has = acpServer({ session: { configOptions: modelOption('opencode/big-pickle') }, set: openCodeSet([ASKED]) });
  assert.equal(await acpOn(has).adapter.open(), null);
});

test('ACP: an agent that takes the request and stays on another model is caught by its own report, and asked nothing', async () => {
  // Not what OpenCode's ACP server does (above). The guard is for an agent
  // that falls back without a word, which is what the step 1 probe saw.
  const server = acpServer({ session: { configOptions: modelOption('opencode/big-pickle') }, set: () => ({ result: { configOptions: modelOption('opencode/big-pickle') } }) });
  const { adapter } = acpOn(server);
  const failed = await adapter.open();
  assert.deepEqual([failed?.reason, failed?.model, failed?.detail], ['model', 'opencode/big-pickle', `asked for ${ASKED}`]);
  assert.deepEqual(server.seen.find((m) => m.method === 'session/set_config_option').params, { sessionId: 's-1', configId: 'model', value: ASKED });
  assert.ok(!server.methods().includes('session/prompt'), 'no prompt reached a model nobody asked for');
});

test('ACP: an agent that does not say which model it is on is cannot-tell, which is not a match', async () => {
  const server = acpServer({ session: {} });
  const failed = await acpOn(server).adapter.open();
  assert.deepEqual([failed?.reason, failed?.model], ['model', null]);
  assert.match(String(failed?.detail), /the agent does not say which model it is on/);
  assert.ok(!server.methods().includes('session/prompt'));
});

test('ACP: the model is set and read back, in either of the two shapes an agent speaks', async () => {
  // The config-option shape: set, and the answer says where it is now.
  const now = acpServer({ session: { configOptions: modelOption('opencode/big-pickle') }, set: () => ({ result: { configOptions: modelOption(ASKED) } }) });
  assert.equal(await acpOn(now).adapter.open(), null);
  // Already on it: nothing is set.
  const already = acpServer({ session: { configOptions: modelOption(ASKED) } });
  assert.equal(await acpOn(already).adapter.open(), null);
  assert.ok(!already.methods().includes('session/set_config_option'));
  // The older shape: the agent lists the model as one it has, and takes the request.
  const older = acpServer({ session: { models: { currentModelId: 'opencode/big-pickle', availableModels: [{ modelId: ASKED }, { modelId: 'opencode/big-pickle' }] } }, set: () => ({ result: {} }) });
  assert.equal(await acpOn(older).adapter.open(), null);
  assert.deepEqual(older.seen.find((m) => m.method === 'session/set_model').params, { sessionId: 's-1', modelId: ASKED });
  // A model the agent does not list is not asked for, and is not what it is on.
  const unlisted = acpServer({ session: { models: { currentModelId: 'opencode/big-pickle', availableModels: [{ modelId: 'opencode/big-pickle' }] } } });
  assert.equal((await acpOn(unlisted).adapter.open())?.reason, 'model');
  assert.ok(!unlisted.methods().includes('session/set_model'));
  assert.deepEqual(acpModel({ configOptions: modelOption('x'), models: { currentModelId: 'y' } })?.now, 'x', 'the newer shape wins where an agent speaks both');
});

test('ACP: Authentication required is the sign-in, found before any prompt', async () => {
  const server = acpServer({ session: { error: { code: -32000, message: 'Authentication required' } } });
  const failed = await acpOn(server).adapter.open();
  assert.deepEqual([failed?.reason, failed?.detail], ['auth', 'Authentication required']);
  assert.ok(server.seen.every((m) => m.jsonrpc === '2.0'), 'an ACP agent is spoken to in JSON-RPC 2.0');
  const declared = server.seen.find((m) => m.method === 'initialize').params;
  assert.deepEqual(declared.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
});

test('ACP: a turn prints the agent’s words and ends as the reason its stop means', async () => {
  const session = { configOptions: modelOption(ASKED) };
  const withStop = async (/** @type {any} */ answer) => {
    const server = acpServer({
      session,
      prompt: (send, m) => {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking at auth.js. ' } } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'someone-else', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NOT THIS SESSION' } } } });
        send({ jsonrpc: '2.0', id: m.id, ...answer });
      },
    });
    const { adapter, said } = acpOn(server);
    assert.equal(await adapter.open(), null);
    return { turn: await adapter.turn('Fix it.'), said: said.join(''), server };
  };
  const done = await withStop({ result: { stopReason: 'end_turn', usage: { inputTokens: 900, outputTokens: 120, totalTokens: 1020 } } });
  assert.deepEqual(done.turn, { engine: 'opencode', reason: 'done', detail: null, model: ASKED, usage: { input: 900, output: 120 }, resetsAt: null });
  assert.equal(done.said, 'Looking at auth.js. \n');
  assert.deepEqual(done.server.seen.find((m) => m.method === 'session/prompt').params, { sessionId: 's-1', prompt: [{ type: 'text', text: 'Fix it.' }] });
  assert.equal((await withStop({ result: { stopReason: 'refusal' } })).turn.reason, 'refused');
  assert.equal((await withStop({ result: { stopReason: 'max_tokens' } })).turn.reason, 'cut');
  assert.equal((await withStop({ result: { stopReason: 'cancelled' } })).turn.reason, 'cancelled');
  // No field for a limit: it is read off the error's words, and anything unread is an error.
  assert.equal((await withStop({ error: { code: -32603, message: 'Provider returned 429: rate limit exceeded' } })).turn.reason, 'limit');
  assert.equal((await withStop({ error: { code: -32603, message: 'quota exhausted for this billing period' } })).turn.reason, 'limit');
  assert.equal((await withStop({ error: { code: -32603, message: 'stream closed unexpectedly' } })).turn.reason, 'error');
});

test('ACP: a provider out of money is a limit, in each provider’s own words, as OpenCode passes them on', async () => {
  const session = { configOptions: modelOption(ASKED) };
  const reason = async (/** @type {any} */ answer) => {
    const { adapter } = acpOn(acpServer({ session, prompt: (send, m) => send({ jsonrpc: '2.0', id: m.id, ...answer }) }));
    await adapter.open();
    return (await adapter.turn('go')).reason;
  };
  // THE ORDINARY WAY A METERED KEY STOPS, and each of these was an `error`:
  // nothing was handed on when the money ran out.
  for (const words of [
    // OpenRouter's 402, as its error reference words it, and its two other wordings.
    'Your account or API key has insufficient credits. Add more credits and retry the request.',
    'Insufficient credits. Add more using https://openrouter.ai/settings/credits',
    'This request requires more credits, or fewer max_tokens.',
    'Provider returned error: 402 Payment Required',
    // A gateway, and Copilot's allowance.
    'Insufficient funds. Please add credits to your account to continue using AI services.',
    'You have exceeded your premium request allowance.',
    'Key limit exceeded',
  ]) assert.equal(await reason(openCodeFailed(words)), 'limit', words);
  // WHAT IS NOT ONE. A key the provider does not know is the sign-in; a
  // provider's bad minute and a request it will not take are errors, and
  // hand nothing on.
  assert.equal(await reason(openCodeFailed('Invalid API key')), 'auth');
  assert.equal(await reason(openCodeFailed('Provider is overloaded')), 'error');
  assert.equal(await reason(openCodeFailed('User not found.')), 'error');
  // The error's name, where OpenCode gives one that says more than the words.
  assert.equal(await reason(openCodeFailed('prompt is too long', 'ContextOverflowError')), 'cut');
  assert.equal(await reason({ error: { code: -32000, message: 'provider authentication required', data: { providerId: 'openrouter' } } }), 'auth');
});

test('ACP: a permission request is answered with the agent’s own option, to reject in a session that asks first and to allow in one that does not', async () => {
  const options = [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }, { optionId: 'r', name: 'Reject', kind: 'reject_once' }];
  for (const [mode, optionId] of /** @type {const} */ ([['safe', 'r'], ['dangerous', 'a']])) {
    const server = acpServer({
      session: { configOptions: modelOption(ASKED) },
      prompt: (send, m) => {
        send({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: { sessionId: 's-1', toolCall: {}, options } });
        setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } }), 20);
      },
    });
    const { adapter, notes } = acpOn(server, { mode });
    await adapter.open();
    await adapter.turn('go');
    assert.deepEqual(server.seen.find((m) => m.id === 77 && !m.method).result, { outcome: { outcome: 'selected', optionId } }, mode);
    assert.equal(notes.length, mode === 'safe' ? 1 : 0);
  }
});

// ── The runner ──────────────────────────────────────────────────────────────

/** A session's own socket: hands over a sign-in, and keeps what is posted to it. */
async function sessionSocket(/** @type {import('node:test').TestContext} */ t, /** @type {(kind: string) => any} */ credential) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'engine-run-'));
  /** @type {Array<{ path: string, body: any }>} */
  const posts = [];
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      const body = JSON.parse(text || '{}');
      posts.push({ path: String(req.url), body });
      const answer = req.url === '/internal/engine-credential' ? (typeof body.value === 'string' ? { ok: true, kind: body.kind } : credential(body.kind)) : { ok: true };
      res.writeHead(answer.ok ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  const socket = path.join(dir, 'hub.sock');
  await new Promise((r) => server.listen(socket, () => r(null)));
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  // `systemDir` stands for /etc/opencode, where a session that asks first has OpenCode told to ask.
  return { socket, home: path.join(dir, 'home'), systemDir: path.join(dir, 'etc-opencode'), posts };
}
/** A pane's keyboard: the lines given, then closed. */
const typed = (/** @type {string[]} */ lines = []) => {
  const stdin = new PassThrough();
  for (const l of lines) stdin.write(`${l}\n`);
  stdin.end();
  return stdin;
};

test('the runner asks the socket for its member’s sign-in, puts it where Codex reads it, reports the turn, and hands a renewed file back', async (t) => {
  const first = JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r-1' } });
  const renewed = JSON.stringify({ tokens: { access_token: 'b', refresh_token: 'r-2' } });
  const { socket, home, posts } = await sessionSocket(t, (kind) => (kind === 'codex' ? { ok: true, kind, value: first } : { ok: false, error: 'not_granted' }));
  const file = path.join(home, '.codex', 'auth.json');
  /** @type {any[]} */
  const spawned = [];
  const server = codexServer({
    turn: (send) => {
      // Codex renews its tokens into its own file while it runs.
      writeFileSync(file, renewed);
      send({ method: 'item/agentMessage/delta', params: { delta: 'Done.' } });
      completed(send, { status: 'completed', error: null });
    },
  });
  /** @type {string[]} */
  const out = [];
  const code = await run({ engine: 'codex', model: 'gpt-5.1-codex', mode: 'safe', prompt: 'Fix the redirect.' }, {
    socket, home, cwd: '/work', env: {}, out: (s) => out.push(s), stdin: typed(),
    spawnEngine: (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
      spawned.push([cmd, ...args]);
      // By the time the engine starts, its sign-in is where it reads it, private.
      assert.equal(readFileSync(file, 'utf8'), first);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      return server.child;
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(spawned, [['codex', 'app-server']]);
  assert.deepEqual(posts.map((p) => [p.path, p.body.event ?? p.body.kind, typeof p.body.value]), [
    ['/internal/session-event', 'UserPromptSubmit', 'undefined'],
    ['/internal/engine-credential', 'codex', 'undefined'],
    ['/internal/engine-credential', 'codex', 'string'],
    ['/internal/session-event', 'TurnEnded', 'undefined'],
  ]);
  assert.equal(posts[2].body.value, renewed, 'the file Codex rewrote goes back to the box that holds the sign-in');
  assert.deepEqual(posts[3].body.turn, { engine: 'codex', reason: 'done', detail: null, model: 'gpt-5.1-codex', usage: null, resetsAt: null });
  assert.match(out.join(''), /Done\./);
});

test('the runner starts no engine without a sign-in, says so in the pane, and reports it as the sign-in', async (t) => {
  const { socket, home, posts } = await sessionSocket(t, () => ({ ok: false, error: 'not_held', message: 'this machine holds no codex sign-in for this member' }));
  let spawned = 0;
  /** @type {string[]} */
  const out = [];
  await run({ engine: 'codex', model: null, mode: 'safe', prompt: 'go' }, { socket, home, env: {}, out: (s) => out.push(s), stdin: typed(), spawnEngine: () => void (spawned += 1) });
  assert.equal(spawned, 0);
  // The machine's words, and then where a sign-in is made: on a machine, from the member's Credentials.
  assert.deepEqual(posts.at(-1)?.body.turn, { engine: 'codex', reason: 'auth', detail: "this machine holds no codex sign-in for this member. To sign it in: this member's Credentials in the Fleetwright app, Sign in on a machine.", model: null, usage: null, resetsAt: null });
  assert.match(out.join(''), /\[fleetwright\] codex did not start a turn: auth \(this machine holds no codex sign-in for this member\)\./);
});

test('a line typed in the pane is the next turn, on the same thread, and an idle start asks nothing', async (t) => {
  const { socket, home, posts } = await sessionSocket(t, (kind) => ({ ok: true, kind, value: JSON.stringify({ tokens: { refresh_token: 'r' } }) }));
  const server = codexServer({ turn: (send) => completed(send, { status: 'completed', error: null }) });
  await run({ engine: 'codex', model: 'gpt-5.1-codex', mode: 'safe', prompt: '' }, { socket, home, env: {}, out: () => {}, stdin: typed(['first', 'second']), spawnEngine: () => server.child });
  const turns = server.seen.filter((m) => m.method === 'turn/start').map((m) => m.params.input[0].text);
  assert.deepEqual(turns, ['first', 'second']);
  assert.equal(server.methods().filter((m) => m === 'thread/start').length, 1);
  assert.equal(posts.filter((p) => p.body.event === 'TurnEnded').length, 2);
});

test('an OpenCode sign-in is staged as its Copilot provider’s, and the runner’s arguments keep the prompt whole', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'engine-stage-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(stage('opencode', ' gho_token\n', home), { ok: true, file: null });
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, '.local', 'share', 'opencode', 'auth.json'), 'utf8')), { 'github-copilot': { type: 'oauth', refresh: 'gho_token', access: '', expires: 0 } });
  assert.equal(stage('gemini', 'x', home).ok, false);
  assert.deepEqual(parseArgs(['--engine', 'opencode', '--model', 'github-copilot/gpt-5', '--mode', 'dangerous', '--', '--not-a-flag: fix it\nplease']), { engine: 'opencode', model: 'github-copilot/gpt-5', mode: 'dangerous', prompt: '--not-a-flag: fix it\nplease' });
  assert.equal(parseArgs(['--engine', 'codex', '--mode', 'anything-else']).mode, 'safe', 'only the word dangerous is dangerous');
});

test('a sign-in that cannot be written is said with its apostrophe, as every sentence in a turn’s detail is', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'engine-stage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A home that is a file: nothing can be made inside it.
  const home = path.join(dir, 'home');
  writeFileSync(home, '');
  const staged = stage('codex', '{}', home);
  assert.equal(staged.ok, false);
  // It read "could not write codexs sign-in": a detail keeps printable characters only, and the apostrophe was not one.
  assert.match(String(ended('codex', 'error', { detail: /** @type {any} */ (staged).text }).detail), /^could not write codex's sign-in: /);
});

test('an engine this runner does not speak to is said, and nothing is asked of the socket', async (t) => {
  const { socket, home, posts } = await sessionSocket(t, () => ({ ok: true }));
  /** @type {string[]} */
  const out = [];
  assert.equal(await run({ engine: 'gemini', model: null, mode: 'safe', prompt: 'go' }, { socket, home, env: {}, out: (s) => out.push(s), stdin: typed() }), 2);
  assert.match(out.join(''), /gemini is not an engine this runner speaks to/);
  assert.deepEqual(posts, []);
});

// ── An engine on an API key (docs/api-engines.md) ───────────────────────────

test('an OpenCode model on an API provider asks the socket for that provider’s key, files it under OpenCode’s name for the provider, and gives the engine its variable', async (t) => {
  const model = 'openrouter/anthropic/claude-sonnet-5.5';
  const { socket, home, systemDir, posts } = await sessionSocket(t, (kind) => (kind === 'apikey:openrouter' ? { ok: true, kind, value: ' sk-or-v1-0123456789abcdef\n' } : { ok: false, error: 'not_granted', message: 'This session’s member names no engine that runs on that sign-in.' }));
  const server = acpServer({ session: { configOptions: modelOption('opencode/big-pickle') }, set: (m) => ({ result: { configOptions: modelOption(m.params.value) } }) });
  /** @type {any[]} */
  const spawned = [];
  const code = await run({ engine: 'opencode', model, mode: 'safe', prompt: 'Fix the redirect.' }, {
    socket, home, systemDir, cwd: '/work', env: { PATH: '/usr/bin', OPENROUTER_API_KEY: 'somebody-elses' }, out: () => {}, stdin: typed(),
    spawnEngine: (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
      spawned.push({ argv: [cmd, ...args], env: opts.env });
      // By the time the engine starts, the key is where it reads keys, private, and nothing else is in the file.
      const file = path.join(home, '.local', 'share', 'opencode', 'auth.json');
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { openrouter: { type: 'api', key: 'sk-or-v1-0123456789abcdef' } });
      assert.equal(statSync(file).mode & 0o777, 0o600);
      return server.child;
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(spawned[0].argv, ['opencode', 'acp']);
  assert.deepEqual(spawned[0].env, { PATH: '/usr/bin', OPENROUTER_API_KEY: 'sk-or-v1-0123456789abcdef' }, 'the member’s key, whatever the session’s environment held');
  // It asked for the key and for nothing else, and never handed one back.
  assert.deepEqual(posts.filter((p) => p.path === '/internal/engine-credential').map((p) => [p.body.kind, typeof p.body.value]), [['apikey:openrouter', 'undefined']]);
  assert.deepEqual(posts.at(-1).body.turn, { engine: 'opencode', reason: 'done', detail: null, model, usage: null, resetsAt: null });
});

test('a provider that quotes the key back in its refusal does not put the key in the turn’s detail', async (t) => {
  // The detail goes to the coordinator, a notification and a screen.
  const KEY = 'sk-or-v1-fedcba9876543210';
  const { socket, home, systemDir, posts } = await sessionSocket(t, (kind) => ({ ok: true, kind, value: KEY }));
  const server = acpServer({ session: { error: { code: -32000, message: `401 from the provider: key ${KEY} is not valid` } } });
  /** @type {string[]} */
  const printed = [];
  await run({ engine: 'opencode', model: 'openrouter/anthropic/claude-sonnet-5.5', mode: 'safe', prompt: 'Go.' }, {
    socket, home, systemDir, cwd: '/work', env: { PATH: '/usr/bin' }, out: (/** @type {string} */ s) => printed.push(s), stdin: typed(), spawnEngine: () => server.child,
  });
  const turn = posts.at(-1).body.turn;
  assert.equal(turn.detail, '401 from the provider: key [withheld] is not valid');
  assert.ok(!JSON.stringify(posts).includes(KEY), 'nothing this runner sent names the key');
  assert.ok(!printed.join('').includes(KEY), 'and nothing it printed in the pane');
});

test('an engine that prints the key, in its answer or on its error output, does not put it in the pane a handoff note is cut from', async (t) => {
  const KEY = 'sk-or-v1-0011223344556677';
  const model = 'openrouter/anthropic/claude-sonnet-5.5';
  const { socket, home, systemDir } = await sessionSocket(t, (kind) => ({ ok: true, kind, value: KEY }));
  const server = acpServer({
    session: { configOptions: modelOption(model) },
    set: (m) => ({ result: { configOptions: modelOption(m.params.value) } }),
    prompt: (send, m) => {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Using key ${KEY} to call the provider.` } } } });
      send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
    },
  });
  const { PassThrough } = await import('node:stream');
  const stderr = new PassThrough();
  /** @type {any} */ (server.child).stderr = stderr;
  /** @type {string[]} */
  const pane = [];
  /** @type {string[]} */
  const errors = [];
  const done = run({ engine: 'opencode', model, mode: 'safe', prompt: 'Go.' }, {
    socket, home, systemDir, cwd: '/work', env: { PATH: '/usr/bin' }, out: (/** @type {string} */ s) => pane.push(s), err: (/** @type {string} */ s) => errors.push(s), stdin: typed(), spawnEngine: () => server.child,
  });
  stderr.write(`WARN provider rejected Authorization: Bearer ${KEY}\nsecond `);
  stderr.end('half');
  await done;
  assert.match(pane.join(''), /Using key \[withheld\] to call the provider\./);
  assert.ok(!pane.join('').includes(KEY));
  assert.equal(errors.join(''), 'WARN provider rejected Authorization: Bearer [withheld]\nsecond half');
});

test('a provider OpenCode’s documentation names no variable for is filed in its key file alone, and a Copilot model is still Copilot’s', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'engine-stage-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.local', 'share', 'opencode', 'auth.json');
  assert.deepEqual(stage('opencode', 'vck_0123456789abcdef', home, providerOf('opencode', 'vercel/anthropic/claude-sonnet-5.5')), { ok: true, file: null });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { vercel: { type: 'api', key: 'vck_0123456789abcdef' } });
  assert.equal(providerOf('opencode', 'github-copilot/gpt-5'), null);
  assert.equal(providerOf('codex', 'openrouter/x'), null, 'only OpenCode speaks to these');
});

test('with no key on the machine for its member, no engine is started and the turn ends as the sign-in', async (t) => {
  const { socket, home, posts } = await sessionSocket(t, () => ({ ok: false, error: 'not_granted', message: 'The operator of this machine has not turned that API provider on.' }));
  let started = false;
  const code = await run({ engine: 'opencode', model: 'openrouter/anthropic/claude-sonnet-5.5', mode: 'safe', prompt: 'Go.' }, {
    socket, home, cwd: '/work', env: {}, out: () => {}, stdin: typed(),
    spawnEngine: () => { started = true; throw new Error('must not start'); },
  });
  assert.equal(started, false);
  assert.equal(code, 0, 'the pane stays for whoever looks at it; the turn is what failed');
  assert.deepEqual([posts.at(-1).body.turn.reason, posts.at(-1).body.turn.detail], ['auth', 'The operator of this machine has not turned that API provider on.']);
});

// ── A session that asks first (docs/engines.md, "Where an engine runs") ─────

/**
 * What OpenCode does with a tool, from its machine's settings, by the rules
 * its permissions page gives: the tool's own rule, else `*`, else allow,
 * which is its default for nearly everything.
 */
function openCodeWould(/** @type {string} */ systemDir, /** @type {string} */ tool) {
  /** @type {any} */
  let permission = {};
  try {
    permission = JSON.parse(readFileSync(path.join(systemDir, 'opencode.json'), 'utf8')).permission ?? {};
  } catch { /* no settings: its defaults */ }
  if (typeof permission === 'string') return permission;
  const rule = permission[tool] ?? permission['*'] ?? 'allow';
  return typeof rule === 'string' ? rule : (rule['*'] ?? 'allow');
}

/** OpenCode's ACP agent on a turn that reads a file, edits one and runs a command, asking where its settings say to. */
function openCodeActing(/** @type {string} */ systemDir) {
  /** @type {string[]} */
  const did = [];
  /** @type {Map<number, string>} */
  const asking = new Map();
  let turn = 0;
  // The three options OpenCode offers with every question (packages/opencode/src/acp/permission.ts).
  const options = [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }];
  const server = standIn((m, send) => {
    const reply = (/** @type {any} */ body) => send({ jsonrpc: '2.0', id: m.id, ...body });
    const finish = () => send({ jsonrpc: '2.0', id: turn, result: { stopReason: 'end_turn' } });
    if (m.method === 'initialize') reply({ result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    else if (m.method === 'session/new') reply({ result: { sessionId: 's-1', configOptions: modelOption(ASKED) } });
    else if (m.method === 'session/prompt') {
      turn = m.id;
      for (const [i, tool] of ['read', 'edit', 'bash'].entries()) {
        const would = openCodeWould(systemDir, tool);
        if (would === 'allow') did.push(tool);
        else if (would === 'ask') {
          asking.set(900 + i, tool);
          send({ jsonrpc: '2.0', id: 900 + i, method: 'session/request_permission', params: { sessionId: 's-1', toolCall: { toolCallId: `c${i}`, title: tool }, options } });
        }
      }
      if (!asking.size) finish();
    } else if (!m.method && asking.has(m.id)) {
      const tool = String(asking.get(m.id));
      asking.delete(m.id);
      if (m.result?.outcome?.outcome === 'selected' && ['once', 'always'].includes(m.result.outcome.optionId)) did.push(tool);
      if (!asking.size) finish();
    }
  });
  return { server, did };
}

test('a session that asks first has OpenCode told to ask, so the runner’s no is reached: it looks, and neither edits nor runs anything', async (t) => {
  const { socket, home, systemDir, posts } = await sessionSocket(t, (kind) => ({ ok: true, kind, value: 'gho_0123456789abcdef' }));
  const going = async (/** @type {string} */ mode, /** @type {string} */ dir) => {
    const { server, did } = openCodeActing(dir);
    /** @type {string[]} */
    const out = [];
    await run({ engine: 'opencode', model: ASKED, mode, prompt: 'Fix the redirect.' }, { socket, home, systemDir: dir, cwd: '/work', env: {}, out: (s) => out.push(s), stdin: typed(), spawnEngine: () => server.child });
    return { did, said: out.join('') };
  };

  // OPENCODE ALLOWS UNLESS IT IS TOLD OTHERWISE, and was told nothing: a
  // session that asks first edited and ran with nobody asked.
  const safe = await going('safe', systemDir);
  assert.deepEqual(safe.did, ['read'], 'it read; the edit and the command were asked about and declined');
  assert.equal(safe.said.split('Declined something opencode asked to do').length - 1, 2);
  assert.equal(posts.at(-1)?.body.turn.reason, 'done');
  // In the machine's own settings, which a project's opencode.json does not override.
  assert.deepEqual(JSON.parse(readFileSync(path.join(systemDir, 'opencode.json'), 'utf8')), OPENCODE_ASKS);
  assert.deepEqual([OPENCODE_ASKS.permission['*'], OPENCODE_ASKS.permission.read['*.env']], ['ask', 'deny']);

  // A session that does not ask first is told nothing, and OpenCode goes on as it does.
  const free = path.join(home, 'etc-none');
  assert.deepEqual((await going('dangerous', free)).did, ['read', 'edit', 'bash']);
  assert.equal(existsSync(path.join(free, 'opencode.json')), false);
});

test('a session that asks first does not start an OpenCode it could not tell to ask', async (t) => {
  const { socket, home, posts } = await sessionSocket(t, (kind) => ({ ok: true, kind, value: 'gho_0123456789abcdef' }));
  let started = 0;
  // Its settings directory cannot be made: the path runs through a socket.
  await run({ engine: 'opencode', model: ASKED, mode: 'safe', prompt: 'Go.' }, { socket, home, systemDir: path.join(socket, 'etc'), cwd: '/work', env: {}, out: () => {}, stdin: typed(), spawnEngine: () => void (started += 1) });
  assert.equal(started, 0);
  const turn = posts.at(-1)?.body.turn;
  assert.equal(turn.reason, 'error');
  assert.match(turn.detail, /^could not tell OpenCode to ask before it acts, so it was not started: /);
});

// ── A Codex sign-in that renews while the session runs ──────────────────────

test('a Codex sign-in renewed in the middle of a turn goes back to the box when it changes, and again as the session is stopped', async (t) => {
  const signIn = (/** @type {string} */ refresh, /** @type {string} */ at) => JSON.stringify({ tokens: { access_token: `at-${refresh}-0123456789`, refresh_token: `rt-${refresh}-0123456789` }, last_refresh: at });
  const first = signIn('one', '2026-11-24T10:00:00Z');
  const renewed = signIn('two', '2026-11-24T12:00:00Z');
  const again = signIn('three', '2026-11-24T12:30:00Z');
  for (const watchMs of [20, 60_000]) {
    const { socket, home, posts } = await sessionSocket(t, (kind) => ({ ok: true, kind, value: first }));
    const file = path.join(home, '.codex', 'auth.json');
    const signals = new EventEmitter();
    /** @type {() => void} */
    let inTurn = () => {};
    const turning = new Promise((r) => (inTurn = () => r(null)));
    // A turn that renews the sign-in and is still going when the session is stopped.
    const server = codexServer({ turn: () => { writeFileSync(file, renewed); inTurn(); } });
    const done = run({ engine: 'codex', model: 'gpt-5.1-codex', mode: 'safe', prompt: 'Fix the redirect.' }, { socket, home, cwd: '/work', env: {}, out: () => {}, stdin: new PassThrough(), spawnEngine: () => server.child, signals, watchMs });
    // If it never ends, end it, so a failure here is a failure and not a test that hangs.
    t.after(() => server.child.kill());
    await turning;
    const handedBack = () => posts.filter((p) => p.path === '/internal/engine-credential' && typeof p.body.value === 'string').map((p) => p.body.value);
    if (watchMs < 1000) {
      // WHEN IT CHANGES. It used to wait for the turn to end, and a turn can be an hour.
      await until(() => handedBack().includes(renewed), 'the renewed sign-in handed back while the turn is still going');
    }
    // AS IT IS STOPPED, which is tmux closing the pane mid-turn. It used to exit holding the only good copy.
    writeFileSync(file, again);
    signals.emit('SIGTERM');
    assert.equal(await Promise.race([done, new Promise((r) => setTimeout(() => r('still running'), 3000))]), 0);
    assert.equal(handedBack().at(-1), again, `stopped mid-turn, looking every ${watchMs} ms`);
    assert.ok(server.child.exitCode !== null, 'and the engine is ended with it');
    assert.deepEqual(posts.filter((p) => p.body.event === 'TurnEnded'), [], 'a stop is not a turn’s end');
  }
});

test('the tokens inside a Codex sign-in are never said, in the pane or in a turn’s detail, and its date still is', async (t) => {
  // As Codex leaves it: a file with line breaks in it, which was not withheld at all.
  const file = codexSignIn({ signature: 'idtok-aaaaaaaaaaaaaaaa', access: 'acctok-bbbbbbbbbbbbbbbb', refresh: 'reftok-cccccccccccccccc', lastRefresh: '2026-11-24T10:00:00.000000Z' });
  const { socket, home, posts } = await sessionSocket(t, (kind) => ({ ok: true, kind, value: file }));
  const server = codexServer({
    turn: (send) => {
      send({ method: 'item/agentMessage/delta', params: { delta: 'auth.json has "refresh_token": "reftok-cccccccccccccccc", last renewed 2026-11-24T10:00:00.000000Z, issued by https://auth.openai.com' } });
      completed(send, { status: 'failed', error: { message: 'token acctok-bbbbbbbbbbbbbbbb was rejected' } });
    },
  });
  /** @type {string[]} */
  const out = [];
  await run({ engine: 'codex', model: 'gpt-5.1-codex', mode: 'safe', prompt: 'Go.' }, { socket, home, cwd: '/work', env: {}, out: (s) => out.push(s), stdin: typed(), spawnEngine: () => server.child });
  const pane = out.join('');
  // Its date and the issuer it names are in the file too, and are nobody's secret.
  assert.match(pane, /auth\.json has "refresh_token": "\[withheld\]", last renewed 2026-11-24T10:00:00\.000000Z, issued by https:\/\/auth\.openai\.com/);
  for (const token of ['idtok-aaaaaaaaaaaaaaaa', 'acctok-bbbbbbbbbbbbbbbb', 'reftok-cccccccccccccccc']) assert.ok(!pane.includes(token), token);
  assert.equal(posts.at(-1)?.body.turn.detail, 'token [withheld] was rejected');
  assert.ok(!JSON.stringify(posts.filter((p) => p.path === '/internal/session-event')).includes('tok-'), 'nothing reported names a token');
});

// ── A sign-in made on the machine ───────────────────────────────────────────

test('a sign-in in the member’s engine home is used first: the box is asked for nothing, handed nothing back, and what the engine renews there is kept as quiet', async (t) => {
  const { socket, home, posts } = await sessionSocket(t, () => assert.fail('the box was asked for a sign-in the machine already holds'));
  const engineHome = path.join(home, 'engine-home');
  const file = path.join(engineHome, 'codex', 'auth.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, codexSignIn({ access: 'at-home-0123456789', refresh: 'rt-home-0123456789' }));
  /** @type {any} */
  let startedWith = null;
  const server = codexServer({
    turn: (send) => {
      // Codex renews in place, and then says both tokens out loud.
      writeFileSync(file, codexSignIn({ access: 'at-next-0123456789', refresh: 'rt-next-0123456789', lastRefresh: '2026-11-26T10:00:00Z' }));
      setTimeout(() => {
        send({ method: 'item/agentMessage/delta', params: { delta: 'was rt-home-0123456789, now rt-next-0123456789' } });
        completed(send, { status: 'completed', error: null });
      }, 80);
    },
  });
  /** @type {string[]} */
  const out = [];
  await run({ engine: 'codex', model: 'gpt-5.1-codex', mode: 'safe', prompt: 'Go.' }, {
    socket, home, cwd: '/work', env: { FLEETWRIGHT_ENGINE_HOME: engineHome }, out: (s) => out.push(s), stdin: typed(), watchMs: 10,
    spawnEngine: (/** @type {string} */ _cmd, /** @type {string[]} */ _args, /** @type {any} */ opts) => {
      startedWith = opts.env;
      return server.child;
    },
  });
  // The engine reads and renews the home, and nothing else of the session is pointed there.
  assert.equal(startedWith.CODEX_HOME, path.join(engineHome, 'codex'));
  assert.equal(startedWith.XDG_DATA_HOME, undefined);
  assert.deepEqual(posts.filter((p) => p.path === '/internal/engine-credential'), [], 'nothing asked, nothing handed back');
  assert.equal(posts.at(-1)?.body.turn.reason, 'done');
  assert.match(out.join(''), /was \[withheld\], now \[withheld\]/);
});

test('with no sign-in in the engine home the pasted item is asked for and written there, so the member’s next session on the machine finds it', async (t) => {
  const pasted = codexSignIn({ access: 'at-pasted-0123456789', refresh: 'rt-pasted-0123456789' });
  const { socket, home, posts } = await sessionSocket(t, (kind) => ({ ok: true, kind, value: pasted }));
  const engineHome = path.join(home, 'engine-home');
  const go = () => {
    const server = codexServer({ turn: (send) => completed(send, { status: 'completed', error: null }) });
    return run({ engine: 'codex', model: 'gpt-5.1-codex', mode: 'safe', prompt: 'Go.' }, { socket, home, cwd: '/work', env: { FLEETWRIGHT_ENGINE_HOME: engineHome }, out: () => {}, stdin: typed(), spawnEngine: () => server.child });
  };
  await go();
  assert.equal(readFileSync(path.join(engineHome, 'codex', 'auth.json'), 'utf8'), pasted);
  assert.equal(existsSync(path.join(home, '.codex')), false, 'one place, not two');
  const asked = () => posts.filter((p) => p.path === '/internal/engine-credential' && p.body.value === undefined).length;
  assert.equal(asked(), 1);
  await go();
  assert.equal(asked(), 1, 'the second session asked for nothing');
});

test('in an engine home a pasted Copilot token is added to OpenCode’s file beside what is there, and a key is not written there at all', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'engine-stage-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const engineHome = path.join(home, 'engine-home');
  const file = path.join(engineHome, 'opencode', 'auth.json');
  const signedIn = { type: 'oauth', refresh: 'gho_made_on_the_machine', access: 'gho_made_on_the_machine', expires: 0 };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ 'github-copilot': signedIn }));
  // The key is OpenCode's for this one process: in the variable it reads in place of its file, and the one its documentation names.
  assert.deepEqual(stage('opencode', ' sk-or-key\n', home, { opencode: 'openrouter', env: 'OPENROUTER_API_KEY' }, engineHome), {
    ok: true, file: null, env: { OPENCODE_AUTH_CONTENT: '{"openrouter":{"type":"api","key":"sk-or-key"}}', OPENROUTER_API_KEY: 'sk-or-key' },
  });
  assert.deepEqual(stage('opencode', 'vck-key', home, { opencode: 'vercel', env: null }, engineHome), { ok: true, file: null, env: { OPENCODE_AUTH_CONTENT: '{"vercel":{"type":"api","key":"vck-key"}}' } });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'github-copilot': signedIn }, 'the home’s file is as it was');
  // A pasted Copilot token is the fallback, and is added to whatever the file holds.
  writeFileSync(file, JSON.stringify({ gitlab: { type: 'api', key: 'glpat-somebody-put-here' } }));
  assert.equal(stage('opencode', 'gho_pasted', home, null, engineHome).ok, true);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { gitlab: { type: 'api', key: 'glpat-somebody-put-here' }, 'github-copilot': { type: 'oauth', refresh: 'gho_pasted', access: '', expires: 0 } });
  assert.equal(existsSync(path.join(home, '.local')), false);
});

test('a metered key reaches OpenCode for the session and is gone with it: nothing of it is in the member’s engine home, and one an earlier session left is taken out', async (t) => {
  const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
  const { socket, home, posts } = await sessionSocket(t, (kind) => (kind === 'apikey:openrouter' ? { ok: true, kind, value: KEY } : { ok: false }));
  const engineHome = path.join(home, 'engine-home');
  const file = path.join(engineHome, 'opencode', 'auth.json');
  // As a session before this left the home: a Copilot sign-in, and the key it was handed.
  const copilot = { type: 'oauth', refresh: 'gho_made_on_the_machine', access: 'gho_made_on_the_machine', expires: 0 };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ 'github-copilot': copilot, openrouter: { type: 'api', key: 'sk-or-v1-left-by-an-earlier-session' } }));
  const agent = acpServer({ session: { configOptions: modelOption('openrouter/some-model') } });
  /** @type {any} */
  let startedWith = null;
  await run({ engine: 'opencode', model: 'openrouter/some-model', mode: 'dangerous', prompt: 'Go.' }, {
    socket, home, cwd: '/work', env: { FLEETWRIGHT_ENGINE_HOME: engineHome }, out: () => {}, err: () => {}, stdin: typed(),
    spawnEngine: (/** @type {string} */ _cmd, /** @type {string[]} */ _args, /** @type {any} */ opts) => {
      startedWith = opts.env;
      return agent.child;
    },
  });
  assert.equal(posts.filter((p) => p.body.event === 'TurnEnded').at(-1)?.body.turn.reason, 'done');
  // OpenCode had the key, in its own process's environment.
  assert.deepEqual([JSON.parse(startedWith.OPENCODE_AUTH_CONTENT), startedWith.OPENROUTER_API_KEY], [{ openrouter: { type: 'api', key: KEY } }, KEY]);
  // And the volume that outlives the session holds no key, this one or the older one. The sign-in beside it is untouched.
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'github-copilot': copilot });
  const left = (/** @type {string} */ dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(path.join(e.parentPath, e.name), 'utf8')).join('\n');
  assert.ok(!left(engineHome).includes('sk-or-v1-'), 'a key is in the engine home');
});

// ── A pasted sign-in, and a home whose sign-in has ended ─────────────────────

/** Codex's app server in a session, started on whatever home the runner names: a turn works only while that home's file holds `good`. */
function codexOnHome(/** @type {string} */ good, /** @type {(file: string) => void} */ duringTurn = () => {}) {
  /** @type {string[]} */
  const turns = [];
  return {
    turns,
    spawn: (/** @type {string} */ _cmd, /** @type {string[]} */ _args, /** @type {any} */ opts) => {
      const file = path.join(String(opts.env.CODEX_HOME), 'auth.json');
      return codexServer({
        turn: (send) => {
          const works = readFileSync(file, 'utf8').includes(good);
          turns.push(works ? 'worked' : 'refused');
          if (works) duringTurn(file);
          // As the real one says of a sign-in that is over: by name, and in one of its five sentences.
          completed(send, works ? { status: 'completed', error: null } : { status: 'failed', error: { message: COULD_NOT_RENEW[2], codexErrorInfo: 'unauthorized' } });
        },
      }).child;
    },
  };
}

test('a sign-in in the home that has ended does not shadow the member’s pasted one: the box is asked once, a later one is put in its place, and the prompt runs', async (t) => {
  const dead = codexSignIn({ refresh: 'rt-DEAD-0123456789abcdef', lastRefresh: '2026-11-01T10:00:00Z' });
  const fresh = codexSignIn({ refresh: 'rt-FRESH-0123456789abcdef', lastRefresh: '2026-11-26T09:00:00Z' });
  const { socket, home, posts } = await sessionSocket(t, (kind) => ({ ok: true, kind, value: fresh }));
  const engineHome = path.join(home, 'engine-home');
  const file = path.join(engineHome, 'codex', 'auth.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, dead);
  const asked = () => posts.filter((p) => p.path === '/internal/engine-credential' && p.body.value === undefined).length;
  const server = codexOnHome('rt-FRESH');
  await run({ engine: 'codex', model: 'gpt-5.1-codex', mode: 'safe', prompt: 'Go.' }, { socket, home, cwd: '/work', env: { FLEETWRIGHT_ENGINE_HOME: engineHome }, out: () => {}, stdin: typed(), spawnEngine: server.spawn });
  // One ending is reported, and it is the turn that ran.
  assert.deepEqual(posts.filter((p) => p.body.event === 'TurnEnded').map((p) => p.body.turn.reason), ['done']);
  assert.deepEqual(server.turns, ['refused', 'worked']);
  assert.equal(asked(), 1);
  assert.equal(readFileSync(file, 'utf8'), fresh);
  assert.ok(existsSync(path.join(engineHome, 'codex', PASTED)), 'what is in the home now is the box’s copy, and is marked as that');
});

test('when the box holds no other sign-in than the one that ended, the session ends auth as before, having asked once', async (t) => {
  const dead = codexSignIn({ refresh: 'rt-DEAD-0123456789abcdef', lastRefresh: '2026-11-01T10:00:00Z' });
  // The same file the home holds, an older one, and none: none of them is another sign-in to try.
  for (const pasted of [dead, codexSignIn({ refresh: 'rt-OLDER-0123456789abcdef', lastRefresh: '2026-10-01T10:00:00Z' }), null]) {
    const { socket, home, posts } = await sessionSocket(t, (kind) => (pasted ? { ok: true, kind, value: pasted } : { ok: false, error: 'not_held' }));
    const engineHome = path.join(home, 'engine-home');
    const file = path.join(engineHome, 'codex', 'auth.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, dead);
    const server = codexOnHome('rt-FRESH');
    await run({ engine: 'codex', model: 'gpt-5.1-codex', mode: 'safe', prompt: 'first' }, { socket, home, cwd: '/work', env: { FLEETWRIGHT_ENGINE_HOME: engineHome }, out: () => {}, stdin: typed(['second']), spawnEngine: server.spawn });
    const turns = posts.filter((p) => p.body.event === 'TurnEnded').map((p) => p.body.turn);
    assert.deepEqual(turns.map((turn) => turn.reason), ['auth', 'auth']);
    assert.match(turns[0].detail, /Sign in on a machine\.$/);
    assert.equal(posts.filter((p) => p.path === '/internal/engine-credential').length, 1, 'asked once a session, not once a turn');
    assert.equal(readFileSync(file, 'utf8'), dead);
  }
  // What "another" is: for Codex a file renewed later by its own date, for OpenCode another token.
  const at = (/** @type {string} */ when) => codexSignIn({ lastRefresh: when });
  assert.equal(another('codex', at('2026-11-26T09:00:00Z'), at('2026-11-01T10:00:00Z')), true);
  assert.equal(another('codex', at('2026-11-01T10:00:00Z'), at('2026-11-01T10:00:00Z')), false);
  assert.equal(another('codex', 'not a file', at('2026-11-01T10:00:00Z')), false);
  assert.equal(another('opencode', 'gho_new', '{"github-copilot":{"type":"oauth","refresh":"gho_old","access":"","expires":0}}'), true);
  assert.equal(another('opencode', 'gho_old\n', '{"github-copilot":{"type":"oauth","refresh":"gho_old","access":"","expires":0}}'), false);
});

test('a pasted sign-in is handed back by every session that renews it, not only the one that was handed it', async (t) => {
  const pasted = codexSignIn({ refresh: 'rt-pasted-0123456789abcdef', lastRefresh: '2026-11-25T10:00:00Z' });
  const renewed = codexSignIn({ refresh: 'rt-renewed-0123456789abcdef', lastRefresh: '2026-11-26T10:00:00Z' });
  const { socket, home, posts } = await sessionSocket(t, (kind) => ({ ok: true, kind, value: pasted }));
  const engineHome = path.join(home, 'engine-home');
  const handedBack = () => posts.filter((p) => p.path === '/internal/engine-credential' && typeof p.body.value === 'string').map((p) => p.body.value);
  const session = (/** @type {(file: string) => void} */ duringTurn = () => {}) => run({ engine: 'codex', model: 'gpt-5.1-codex', mode: 'safe', prompt: 'Go.' }, {
    socket, home, cwd: '/work', env: { FLEETWRIGHT_ENGINE_HOME: engineHome }, out: () => {}, stdin: typed(), spawnEngine: codexOnHome('rt-', duringTurn).spawn,
  });
  // The first session is handed the box's copy and puts it in the home.
  await session();
  assert.deepEqual(handedBack(), []);
  // A later one finds it there, asks for nothing, and Codex renews it in that session.
  await session((file) => writeFileSync(file, renewed));
  assert.equal(posts.filter((p) => p.path === '/internal/engine-credential' && p.body.value === undefined).length, 1);
  assert.deepEqual(handedBack(), [renewed], 'the box’s copy is now a sign-in that has been used up');
});

// ── What an engine sends is bounded ─────────────────────────────────────────

test('a message longer than the runner reads ends the conversation and says so, and an error line is cut at its bound', async (t) => {
  // It was held until its newline came, however long that took.
  const server = standIn(() => {});
  const peer = new Peer(server.child, { version: null, maxMessage: 1000 });
  const asked = peer.request('thread/start', {}, 0);
  server.child.stdout.write('x'.repeat(5000));
  const failed = await Promise.race([asked.then(() => 'answered', (e) => e), new Promise((r) => setTimeout(() => r('still waiting'), 1000))]);
  assert.match(String(/** @type {any} */ (failed)?.message ?? failed), /^the engine sent one message longer than 1 KiB, which is more than this runner reads$/);
  assert.equal(peer.closed, true);
  // The rest of that line, and what follows, moves nothing.
  server.child.stdout.write(`${'x'.repeat(5000)}\n{"id":1,"result":{}}\n`);

  const { socket, home, systemDir } = await sessionSocket(t, (kind) => ({ ok: true, kind, value: 'gho_0123456789abcdef' }));
  const agent = acpServer({ session: { configOptions: modelOption(ASKED) } });
  const stderr = new PassThrough();
  /** @type {any} */ (agent.child).stderr = stderr;
  /** @type {string[]} */
  const errors = [];
  const done = run({ engine: 'opencode', model: ASKED, mode: 'safe', prompt: 'Go.' }, { socket, home, systemDir, cwd: '/work', env: {}, out: () => {}, err: (s) => errors.push(s), stdin: typed(), spawnEngine: () => agent.child });
  for (let i = 0; i < 8; i++) stderr.write('e'.repeat(ERROR_LINE_MAX / 2));
  stderr.end('\nthe next line\n');
  await done;
  const said = errors.join('');
  assert.ok(said.length < ERROR_LINE_MAX + 200, `${said.length} characters of one line were passed on`);
  assert.match(said, /e \[the rest of this line was not kept\]\nthe next line\n$/);
});
